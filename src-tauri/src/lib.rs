mod clipboard;
mod config_store;
mod fs_browse;
mod open_external;
mod secrets;
mod sidecar;
mod state_store;
mod system_probe;

use tauri::{Manager, RunEvent, WindowEvent};

/// Autorise la capture du micro (`getUserMedia`) dans la webview WebKitGTK.
///
/// Tout est en best-effort : si la fenêtre principale est introuvable ou que
/// l'accès à la webview échoue, on se contente d'un message sur stderr et
/// l'application démarre normalement — seule la dictée vocale serait alors
/// indisponible.
///
/// Chaque message part AUSSI sur l'event Tauri `app:log` (journal applicatif,
/// voir `docs/protocol.md`) — best-effort : ces réglages se jouent au `setup()`,
/// avant que l'UI n'ait eu le temps de s'abonner, donc la ligne peut être
/// perdue ; le `eprintln!` reste le canal fiable au terminal.
#[cfg(target_os = "linux")]
fn autoriser_micro_webkit(app: &tauri::AppHandle) {
    let Some(fenetre) = app.get_webview_window("main") else {
        eprintln!(
            "iaction : fenêtre principale introuvable, la dictée vocale (micro) sera indisponible"
        );
        // `warn` : dégradation acceptée (l'app démarre, la dictée non).
        sidecar::log_app(
            app,
            "warn",
            "fenêtre principale introuvable, dictée vocale indisponible".to_string(),
            serde_json::json!({}),
        );
        return;
    };
    // La closure de `with_webview` doit être `Send + 'static` : on lui confie
    // un clone du handle plutôt qu'un emprunt.
    let app_journal = app.clone();
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
            app,
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
        .setup(|app| {
            sidecar::spawn_supervisor(app.handle().clone());
            // Micro pour la dictée vocale (speech-to-text côté UI). Sous Linux,
            // WebKitGTK rejette `getUserMedia` par défaut : il faut à la fois
            // activer le réglage `enable-media-stream` et répondre « autoriser »
            // à la demande de permission émise par le moteur.
            #[cfg(target_os = "linux")]
            autoriser_micro_webkit(app.handle());
            // Sur macOS (WKWebView) et Windows (WebView2), rien à faire ici :
            // la permission media y est gérée autrement (mécanismes natifs du
            // moteur webview de l'OS), sans réglage côté Rust.
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                sidecar::request_shutdown(window.app_handle());
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
            system_probe::open_terminal,
            system_probe::system_stats
        ])
        .build(tauri::generate_context!())
        .expect("échec de la construction de l'application Tauri")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                sidecar::request_shutdown(app_handle);
            }
        });
}
