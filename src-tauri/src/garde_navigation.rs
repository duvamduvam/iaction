//! Garde de navigation (T-184) : une fenêtre d'IAction ne quitte JAMAIS l'application.
//!
//! Le filet côté UI (`ui/src/liensExternes.ts`) ne voit que les clics. Le menu contextuel
//! natif de la webview (« Ouvrir le lien », clic droit) navigue sans passer par le
//! JavaScript : l'application était remplacée par le site, sans retour possible (constat du
//! 2026-10-26). Ici, toute navigation vers une adresse web extérieure est refusée et
//! confiée au navigateur par défaut du système (`open_external` sans commande).
//!
//! Posée par un plugin (`on_navigation`) plutôt que fenêtre par fenêtre : la fenêtre `main`
//! est déclarée dans `tauri.conf.json`, pas construite en code, et un plugin couvre aussi
//! les fenêtres secondaires (`fenetres.rs`) sans câblage à oublier.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Url, Wry};

use crate::open_external::open_external;
use crate::sidecar;

/// Hôte qui EST l'application : l'origine `http(s)://tauri.localhost` qui remplace
/// `tauri://` sous Windows.
const HOTE_APPLICATION: &str = "tauri.localhost";

/// La navigation reste-t-elle dans l'application ? Oui pour tout schéma qui n'est pas web
/// ni fichier (`tauri:`, `about:`, `data:`, `blob:`…), pour `tauri.localhost` et pour
/// l'origine EXACTE du serveur de dev (`dev_url`, schéma + hôte + port). Non pour un site
/// web, un `mailto:`, un `file:` — ni pour un autre port de `localhost` : les aperçus que
/// servent les agents (`http://localhost:8099/…`) passaient pour l'application et la
/// remplaçaient (rechute T-184 du 2026-11-03).
pub fn est_navigation_interne(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        "http" | "https" => {
            url.host_str() == Some(HOTE_APPLICATION)
                || dev_url.is_some_and(|dev| dev.origin() == url.origin())
        }
        "mailto" | "file" => false,
        _ => true,
    }
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("garde-navigation")
        .on_navigation(|webview, url| {
            let app = webview.app_handle().clone();
            // Le serveur de dev n'est l'application qu'en dev : un binaire publié n'a
            // aucune raison d'afficher `localhost:1420`.
            let dev_url = if tauri::is_dev() { app.config().build.dev_url.clone() } else { None };
            if est_navigation_interne(url, dev_url.as_ref()) {
                return true;
            }
            // Jamais l'adresse entière au journal : elle peut porter des paramètres
            // personnels. L'hôte suffit à reconnaître la panne.
            let hote = url.host_str().unwrap_or("").to_string();
            match open_external(url.to_string(), None) {
                Ok(()) => sidecar::log_app(
                    &app,
                    "info",
                    "navigation extérieure renvoyée au navigateur système".to_string(),
                    serde_json::json!({ "hote": hote }),
                ),
                Err(erreur) => sidecar::log_app(
                    &app,
                    "warn",
                    "navigation extérieure refusée, navigateur système non lancé".to_string(),
                    serde_json::json!({ "hote": hote, "erreur": erreur }),
                ),
            }
            false
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).expect("adresse de test valide")
    }

    fn dev() -> Url {
        url("http://localhost:1420")
    }

    #[test]
    fn un_site_web_sort_de_l_application() {
        let d = dev();
        assert!(!est_navigation_interne(&url("https://www.123elec.com/produit.html"), Some(&d))); // audit-publication:ok
        assert!(!est_navigation_interne(&url("http://example.org/"), Some(&d)));
        assert!(!est_navigation_interne(&url("mailto:quelqu-un@example.org"), Some(&d)));
        assert!(!est_navigation_interne(&url("file:///tmp/maquette.html"), Some(&d)));
    }

    #[test]
    fn un_apercu_local_d_agent_sort_de_l_application() {
        let d = dev();
        assert!(!est_navigation_interne(&url("http://localhost:8099/proposition.html"), Some(&d)));
        assert!(!est_navigation_interne(&url("http://127.0.0.1:8766/lettre.html"), Some(&d)));
        // Hors dev, même le port 1420 n'est pas l'application.
        assert!(!est_navigation_interne(&url("http://localhost:1420/"), None));
    }

    #[test]
    fn l_application_reste_dans_sa_fenetre() {
        let d = dev();
        assert!(est_navigation_interne(&url("tauri://localhost/index.html"), None));
        assert!(est_navigation_interne(&url("http://localhost:1420/"), Some(&d)));
        assert!(est_navigation_interne(&url("http://localhost:1420/agent?x=1"), Some(&d)));
        assert!(est_navigation_interne(&url("http://tauri.localhost/index.html"), None));
        assert!(est_navigation_interne(&url("about:blank"), None));
    }
}
