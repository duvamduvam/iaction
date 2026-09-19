//! Mort du process de CONTENU de la webview — la journaliser, et le dire à
//! l'écran (T-030).
//!
//! ── Le défaut ───────────────────────────────────────────────────────────
//! Le 2026-08-12 à 17 h 25, l'application est apparue « complètement bloquée au
//! lancement ». La coquille allait bien, le sidecar aussi : c'est le process de
//! contenu WebKit qui était mort, et la fenêtre affichait sa dernière image
//! pour toujours. `journalctl` portait un `segfault … in libgstpipewire.so`
//! trois secondes après la première image — un plantage dans une bibliothèque
//! du SYSTÈME (greffon PipeWire de GStreamer, que WebKit charge pour son
//! moniteur de périphériques média), pas dans notre code. Même signature trois
//! fois auparavant, et un autre couple de segfauts le 2026-08-11 dans
//! `libwebkit2gtk` puis `libnvidia-eglcore` : le mode de panne « la webview
//! meurt » n'est pas propre à un greffon.
//!
//! Le défaut qui NOUS appartient n'est pas le plantage : c'est qu'`app.jsonl`
//! n'en portait pas une ligne, que l'utilisateur n'avait aucun message, et
//! qu'une fenêtre figée est indiscernable d'une fenêtre lente. La coquille sait
//! journaliser la mort du sidecar (T-017) ; elle doit savoir journaliser celle
//! de sa webview.
//!
//! ── Pourquoi la trace ne passe PAS par le chemin habituel ───────────────
//! `log_app` route vers l'UI (`app:log`), qui appelle `log.append`. Or ici,
//! l'UI est précisément ce qui vient de mourir : la ligne serait perdue au
//! moment exact où elle compte le plus. On écrit donc aux DEUX journaux sans
//! elle — `coquille.jsonl` directement (c'est le Rust qui tient la plume) et
//! `app.jsonl` en parlant au sidecar, qui, lui, est toujours vivant.

use serde_json::json;
use tauri::{AppHandle, Manager, WebviewWindow};

use crate::journal_coquille::journal_coquille;
use crate::sidecar;

/// Raison de l'arrêt, en français et sans jargon de binding.
#[cfg(target_os = "linux")]
fn nommer_raison(raison: webkit2gtk::WebProcessTerminationReason) -> &'static str {
    use webkit2gtk::WebProcessTerminationReason;
    match raison {
        WebProcessTerminationReason::Crashed => "plantage",
        WebProcessTerminationReason::ExceededMemoryLimit => "dépassement de mémoire",
        WebProcessTerminationReason::TerminatedByApi => "arrêt demandé par l'application",
        _ => "raison inconnue",
    }
}

/// Page affichée à la place de l'image morte.
///
/// Autonome par construction : WebKit relance un process de contenu pour
/// l'afficher, mais celui-ci ne porte plus NI l'application, NI le pont IPC de
/// Tauri. Donc aucun `invoke`, aucun script — le bouton se contente de renvoyer
/// le navigateur à l'adresse de l'application, ce qui la recharge entièrement.
/// Ce qui n'était pas enregistré est de toute façon déjà perdu : c'est la mort
/// du process qui l'a emporté, pas ce rechargement.
pub fn page_interruption(raison: &str, adresse: Option<&str>) -> String {
    let bouton = match adresse {
        Some(url) => format!(
            "<a class=\"b\" href=\"{}\">Recharger l'application</a>",
            echapper(url)
        ),
        // Sans adresse connue, promettre un rechargement serait mentir : on dit
        // quoi faire à la place.
        None => "<p class=\"n\">Adresse de l'application inconnue : fermez et relancez iaction.</p>"
            .to_string(),
    };
    format!(
        "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\">\
<title>Affichage interrompu</title><style>\
body{{font:15px/1.6 system-ui,sans-serif;background:#1a1a1a;color:#eee;margin:0;\
display:flex;align-items:center;justify-content:center;height:100vh}}\
main{{max-width:34rem;padding:2rem}}h1{{font-size:1.25rem;margin:0 0 .75rem}}\
p{{color:#bbb;margin:.5rem 0}}.n{{color:#e5a}}\
.b{{display:inline-block;margin-top:1.25rem;padding:.55rem 1.1rem;background:#3a6df0;\
color:#fff;border-radius:6px;text-decoration:none}}</style></head><body><main>\
<h1>L'affichage s'est interrompu</h1>\
<p>Le moteur d'affichage s'est arrêté ({raison}). L'application et son moteur de \
tâches, eux, tournent toujours — seule la fenêtre a perdu son contenu.</p>\
<p>L'incident est écrit dans le journal (page Système, une fois rechargé).</p>\
{bouton}</main></body></html>"
    )
}

/// Échappement HTML minimal de l'adresse insérée dans le `href`.
///
/// Elle vient du moteur, pas de l'utilisateur — mais elle entre dans du HTML
/// construit à la main, et c'est exactement le genre d'endroit où l'on finit par
/// découvrir qu'une URL contenait un guillemet.
fn echapper(texte: &str) -> String {
    texte
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Écrit la ligne dans `app.jsonl` SANS passer par l'interface, en s'adressant
/// directement au sidecar. Best-effort : s'il est mort lui aussi, il reste
/// `coquille.jsonl`, que la coquille écrit de sa propre main.
#[cfg(target_os = "linux")]
fn journaliser_dans_app_jsonl(app: &AppHandle, raison: &str) {
    let requete = json!({
        "id": "coquille-webview-morte",
        "method": "log.append",
        "params": {
            "level": "fatal",
            "scope": "rust",
            "msg": "le process de contenu de la webview s'est arrêté",
            "fields": { "raison": raison },
        },
    });
    if let Err(err) = sidecar::sidecar_request(requete, app.state()) {
        eprintln!("iaction : mort de la webview non journalisée dans app.jsonl ({err})");
    }
}

/// Branche la surveillance sur `fenetre` (T-062 : chaque fenêtre reçoit son
/// propre câblage, plutôt que de chercher `"main"` par son nom — sinon les
/// fenêtres secondaires ouvriraient sans surveillance, et la mort de leur
/// process de contenu passerait sans une ligne de journal). Best-effort de
/// bout en bout : sans elle, l'application démarre exactement comme avant —
/// elle redevient simplement muette sur cette panne-là pour cette fenêtre.
#[cfg(target_os = "linux")]
pub fn surveiller(fenetre: &WebviewWindow) {
    let app_signal = fenetre.app_handle().clone();
    let resultat = fenetre.with_webview(move |webview| {
        use webkit2gtk::WebViewExt;
        let vue = webview.inner();
        vue.connect_web_process_terminated(move |vue, raison| {
            let raison = nommer_raison(raison);
            // 1. Les deux journaux, sans l'interface (voir l'en-tête).
            journal_coquille(
                &app_signal,
                "fatal",
                "webview : process de contenu arrêté",
                &json!({ "raison": raison }),
            );
            journaliser_dans_app_jsonl(&app_signal, raison);
            eprintln!("iaction : le process de contenu de la webview s'est arrêté ({raison})");

            // 2. Un état franc à l'écran. L'adresse est lue AVANT de charger la
            //    page d'interruption, sinon on ne saurait plus où revenir.
            let adresse = vue.uri().map(|u| u.to_string());
            vue.load_html(&page_interruption(raison, adresse.as_deref()), None);
        });
    });
    if let Err(erreur) = resultat {
        eprintln!(
            "iaction : accès à la webview impossible ({erreur}), mort de la webview non surveillée"
        );
        sidecar::log_app(
            fenetre.app_handle(),
            "warn",
            "accès à la webview impossible, mort de la webview non surveillée".to_string(),
            json!({ "erreur": erreur.to_string() }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_page_propose_de_revenir_a_l_application() {
        let page = page_interruption("plantage", Some("http://localhost:1420/"));
        assert!(page.contains("href=\"http://localhost:1420/\""));
        assert!(page.contains("plantage"));
        // Le bouton doit rester un lien SIMPLE : la page n'a plus de pont IPC,
        // tout ce qui ressemblerait à un `invoke` y serait mort-né.
        assert!(!page.contains("invoke"));
    }

    #[test]
    fn sans_adresse_la_page_ne_promet_pas_un_rechargement() {
        let page = page_interruption("dépassement de mémoire", None);
        assert!(!page.contains("<a class=\"b\""));
        assert!(page.contains("relancez iaction"));
    }

    #[test]
    fn l_adresse_est_echappee() {
        // Une URL contenant un guillemet ne doit pas pouvoir refermer l'attribut.
        let page = page_interruption("plantage", Some("http://x/\"><script>a()</script>"));
        assert!(!page.contains("\"><script>"));
        assert!(page.contains("&quot;"));
    }
}
