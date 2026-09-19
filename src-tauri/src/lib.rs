mod clipboard;
mod config_store;
pub mod demarrage;
mod fenetres;
mod fs_browse;
mod gpu_probe;
mod journal_coquille;
mod open_external;
mod reseau;
mod secrets;
mod session_vie;
mod sidecar;
mod state_store;
mod system_probe;
mod webview_vie;

use tauri::{Manager, RunEvent, WebviewWindow, WindowEvent};

/// Autorise la capture du micro (`getUserMedia`) dans la webview WebKitGTK de
/// `fenetre`.
///
/// T-062 : prend la fenêtre en paramètre plutôt que de la chercher par son
/// nom (`"main"`) — appelée au `setup()` pour la fenêtre principale, et dans
/// `fenetres::fenetre_ouvrir` pour chaque fenêtre secondaire, sinon celles-ci
/// s'ouvriraient sourdes à la dictée vocale.
///
/// Tout est en best-effort : si l'accès à la webview échoue, on se contente
/// d'un message sur stderr et l'application démarre normalement — seule la
/// dictée vocale serait alors indisponible.
///
/// Chaque message part AUSSI sur l'event Tauri `app:log` (journal applicatif,
/// voir `docs/protocol.md`) — best-effort : ces réglages se jouent au `setup()`,
/// avant que l'UI n'ait eu le temps de s'abonner, donc la ligne peut être
/// perdue ; le `eprintln!` reste le canal fiable au terminal.
#[cfg(target_os = "linux")]
fn autoriser_micro_webkit(fenetre: &WebviewWindow) {
    // La closure de `with_webview` doit être `Send + 'static` : on lui confie
    // un clone du handle plutôt qu'un emprunt.
    let app_journal = fenetre.app_handle().clone();
    let resultat = fenetre.with_webview(move |webview| {
        use webkit2gtk::glib::prelude::{Cast, ObjectExt};
        use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, WebViewExt};

        // `inner()` expose le `webkit2gtk::WebView` sous-jacent de Tauri.
        let webview = webview.inner();

        // 1) Réglage moteur : sans `enable-media-stream`, WebKitGTK n'expose
        //    même pas la capture et `getUserMedia` échoue d'emblée.
        match webview.settings() {
            Some(reglages) => {
                reglages.set_enable_media_stream(true);

                // 1 bis) `enable-media-recorder` : WebKitGTK expose ce réglage,
                //    mais la crate `webkit2gtk` 2.0.2 n'en fournit AUCUN binding
                //    (pas de `set_enable_media_recorder` dans `auto/settings.rs`).
                //    `WebKitSettings` étant un GObject, on pose la propriété
                //    dynamiquement via glib. Prudence toutefois : `set_property`
                //    PANIQUE si la propriété n'existe pas (build WebKit trop
                //    ancien, ou compilé sans MediaRecorder). On vérifie donc
                //    d'abord son existence sur la classe de l'objet, et on
                //    n'écrit que si elle est bien là — best-effort, jamais de
                //    panique.
                //    Honnêtement : l'application n'utilise plus `MediaRecorder`
                //    (la capture micro passe désormais par Web Audio, justement
                //    parce que MediaRecorder est indisponible sur ce moteur).
                //    Activer le réglage quand il existe est une ceinture de
                //    sécurité : si du code futur y revient, il ne retombera pas
                //    dans le même piège.
                const PROPRIETE_MEDIA_RECORDER: &str = "enable-media-recorder";
                if reglages.find_property(PROPRIETE_MEDIA_RECORDER).is_some() {
                    reglages.set_property(PROPRIETE_MEDIA_RECORDER, true);
                } else {
                    eprintln!(
                        "iaction : réglage WebKit « {PROPRIETE_MEDIA_RECORDER} » absent de ce moteur, ignoré (sans effet : la capture micro passe par Web Audio)"
                    );
                    // `info` : purement informatif — rien n'est dégradé, la
                    // capture micro ne passe plus par MediaRecorder.
                    sidecar::log_app(
                        &app_journal,
                        "info",
                        "réglage WebKit absent de ce moteur, ignoré (sans effet)".to_string(),
                        serde_json::json!({ "propriete": PROPRIETE_MEDIA_RECORDER }),
                    );
                }

                // 1 ter) Web Audio : toute la capture micro repose maintenant
                //    dessus (AudioContext + AudioWorklet/ScriptProcessor pour
                //    lire les échantillons PCM). C'est activé par défaut sur la
                //    plupart des builds, mais on ne veut pas dépendre du défaut
                //    du moteur : on l'affirme explicitement.
                reglages.set_enable_webaudio(true);
            }
            None => {
                eprintln!(
                    "iaction : réglages WebKit inaccessibles, la dictée vocale (micro) sera indisponible"
                );
                sidecar::log_app(
                    &app_journal,
                    "warn",
                    "réglages WebKit inaccessibles, dictée vocale indisponible".to_string(),
                    serde_json::json!({}),
                );
            }
        }

        // 2) Demande de permission : même réglage activé, WebKitGTK émet une
        //    `UserMediaPermissionRequest` qu'il faut explicitement accepter,
        //    sinon la promesse `getUserMedia` est rejetée. Le micro étant
        //    nécessaire à la dictée, on l'autorise — mais UNIQUEMENT le
        //    media-stream : toute autre demande (géolocalisation,
        //    notifications…) est laissée au comportement par défaut (refus).
        webview.connect_permission_request(|_, demande| {
            if let Some(demande_media) = demande.downcast_ref::<UserMediaPermissionRequest>() {
                demande_media.allow();
                true // demande traitée, WebKit n'a plus rien à décider
            } else {
                false // laisser WebKit appliquer son comportement par défaut
            }
        });
    });
    if let Err(erreur) = resultat {
        eprintln!(
            "iaction : accès à la webview impossible ({erreur}), la dictée vocale (micro) sera indisponible"
        );
        sidecar::log_app(
            fenetre.app_handle(),
            "warn",
            "accès à la webview impossible, dictée vocale indisponible".to_string(),
            serde_json::json!({ "erreur": erreur.to_string() }),
        );
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(sidecar::managed_state())
        .manage(fenetres::managed_state())
        .setup(|app| {
            // Premier jalon : il clôt tout ce qui précède le code applicatif
            // (chargement des bibliothèques, init Tauri/GTK) — le segment qui
            // n'avait jusqu'ici aucune trace. Voir `demarrage.rs`.
            demarrage::jalon(app.handle(), "rust:setup");
            // T-112 — pose le témoin de cette session, et signale au passage
            // toute session précédente arrêtée sans avoir pu le retirer. On ne
            // peut pas journaliser sa propre mort subite ; on peut constater
            // sa propre résurrection.
            session_vie::ouvrir(app.handle());
            sidecar::spawn_supervisor(app.handle().clone(), sidecar::ORIGINE_PREMIER_DEMARRAGE);
            // Micro et surveillance de la webview : câblés par fenêtre depuis
            // T-062 (deux fenêtres, un seul sidecar). La fenêtre `main` est
            // déclarée dans `tauri.conf.json` et existe donc déjà à ce stade ;
            // le cas « introuvable » (best-effort, comme avant) reste géré
            // ICI plutôt que dans les deux fonctions, qui prennent maintenant
            // une fenêtre déjà résolue en paramètre — voir `fenetres::fenetre_ouvrir`
            // pour le même câblage sur les fenêtres secondaires.
            match app.get_webview_window("main") {
                Some(fenetre_principale) => {
                    // Micro pour la dictée vocale (speech-to-text côté UI).
                    // Sous Linux, WebKitGTK rejette `getUserMedia` par défaut :
                    // il faut à la fois activer le réglage `enable-media-stream`
                    // et répondre « autoriser » à la demande de permission émise
                    // par le moteur.
                    #[cfg(target_os = "linux")]
                    autoriser_micro_webkit(&fenetre_principale);
                    // Mort du process de contenu WebKit : une fenêtre figée doit
                    // cesser d'être indiscernable d'une fenêtre lente (T-030).
                    // Linux seulement — le signal est propre à WebKitGTK ;
                    // WebView2 et WKWebView ont leurs propres mécanismes, à
                    // traiter le jour où la panne s'y voit.
                    #[cfg(target_os = "linux")]
                    webview_vie::surveiller(&fenetre_principale);
                    // Sur macOS (WKWebView) et Windows (WebView2), rien à faire
                    // ici : la permission media y est gérée autrement
                    // (mécanismes natifs du moteur webview de l'OS), sans
                    // réglage côté Rust.
                }
                None => {
                    eprintln!(
                        "iaction : fenêtre principale introuvable, dictée vocale et surveillance de la webview indisponibles"
                    );
                    sidecar::log_app(
                        app.handle(),
                        "warn",
                        "fenêtre principale introuvable au démarrage, dictée vocale et surveillance de la webview indisponibles".to_string(),
                        serde_json::json!({}),
                    );
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let app = window.app_handle();
                let etiquette = window.label().to_string();

                // Le registre projet→fenêtre ne doit jamais garder une entrée
                // après la fermeture de sa fenêtre : une entrée périmée est
                // rattrapée par `vivante()` (T-062), mais autant ne pas la
                // laisser traîner jusqu'à la prochaine revendication.
                fenetres::fenetre_projet_liberer(app.clone(), etiquette.clone());

                // Fermer une fenêtre SECONDAIRE ne doit PAS couper le sidecar
                // en plein tour d'une AUTRE fenêtre (T-062, blocant 6). Au
                // moment de `CloseRequested`, la fenêtre qui se ferme est
                // encore comptée dans `webview_windows()` : « dernière » =
                // il n'en reste qu'une, elle.
                if app.webview_windows().len() <= 1 {
                    sidecar::request_shutdown(app);
                } else {
                    sidecar::log_app(
                        app,
                        "info",
                        "fenêtre secondaire fermée, le moteur continue".to_string(),
                        serde_json::json!({ "fenetre": etiquette }),
                    );
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            sidecar::sidecar_request,
            sidecar::sidecar_status,
            sidecar::sidecar_restart,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            config_store::config_read,
            config_store::config_write,
            fs_browse::fs_list_dir,
            fs_browse::fs_read_file,
            fs_browse::fs_write_file,
            fs_browse::fs_mkdir,
            fs_browse::fs_rename,
            fs_browse::fs_delete,
            fs_browse::fs_find_by_name,
            open_external::open_external,
            clipboard::clipboard_read_image,
            state_store::state_read,
            state_store::state_write,
            state_store::state_list,
            state_store::state_rename,
            system_probe::open_terminal,
            system_probe::system_stats,
            demarrage::demarrage_jalon,
            fenetres::fenetre_ouvrir,
            fenetres::fenetre_projet_revendiquer,
            fenetres::fenetre_projet_liberer,
            fenetres::fenetres_projets_ouverts
        ])
        .build(tauri::generate_context!())
        .expect("échec de la construction de l'application Tauri")
        .run(|app_handle, event| {
            match event {
                // La boucle d'événements tourne : l'application est construite
                // et la fenêtre existe. Ce jalon isole le coût de Tauri lui-même
                // de celui du moteur web, qui commence tout juste à charger l'UI.
                RunEvent::Ready => demarrage::jalon(app_handle, "rust:boucle-evenements"),
                // Filet de sécurité : quoi qu'il arrive à la sortie de la
                // boucle d'événements, le sidecar ne doit jamais rester
                // orphelin.
                // Deux gestes, dans cet ordre : dire que la session se ferme
                // PROPREMENT (sans quoi le démarrage suivant l'accuserait d'un
                // arrêt brutal — T-112), puis ne jamais laisser le sidecar
                // orphelin.
                RunEvent::Exit => {
                    session_vie::fermer(app_handle);
                    sidecar::request_shutdown(app_handle);
                }
                _ => {}
            }
        });
}
