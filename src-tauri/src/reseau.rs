//! Réglages réseau d'entreprise appliqués au sidecar (T-045).
//!
//! ── Pourquoi la coquille, et pas le sidecar ─────────────────────────────
//! `--use-env-proxy` (T-043) est lu par Node **au démarrage du process** : un
//! proxy saisi dans l'application ne peut donc pas s'appliquer au sidecar déjà
//! lancé. C'est la coquille qui compose l'environnement de l'enfant, donc c'est
//! ici que les réglages entrent — et c'est pourquoi « Relancer le moteur » est
//! le geste qui les applique.
//!
//! ── Les trois trous que T-043 laissait ─────────────────────────────────
//! 1. Rien à saisir dans l'application : sous Windows les variables vivent
//!    souvent dans le profil du terminal, pas dans la session graphique, et il
//!    fallait passer par `setx` — ce qu'aucune documentation ne disait.
//! 2. Le PAC (`AutoConfigURL` du registre) reste ignoré : un poste qui n'a QUE
//!    le PAC doit saisir son proxy à la main ici. Nous ne l'interprétons pas,
//!    et il vaut mieux le dire que de laisser croire le contraire.
//! 3. Derrière un proxy qui inspecte le TLS, Node ne lit pas le magasin de
//!    certificats du système : `--use-system-ca` et `NODE_EXTRA_CA_CERTS`
//!    existent pour ça, ils n'étaient pas posés.
//!
//! Discipline commune à tout ce fichier : **un réglage absent ne change rien**.
//! Sans clé `reseau`, l'environnement de l'enfant est celui d'avant, à l'octet
//! près — celui d'un poste qui posait déjà ses variables lui-même.

use serde_json::Value;
use tauri::AppHandle;

/// Réglages réseau lus de la configuration non secrète (clé `reseau`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reseau {
    /// Proxy explicite, appliqué à HTTP et HTTPS (`http://hote:port`).
    pub proxy: Option<String>,
    /// Hôtes à joindre en direct (`NO_PROXY`), tels que saisis.
    pub sans_proxy: Option<String>,
    /// Autorité de certification supplémentaire : chemin d'un fichier PEM.
    pub autorite: Option<String>,
    /// Lire aussi le magasin de certificats du système (`--use-system-ca`).
    pub ca_systeme: bool,
}

fn texte(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// Lit la clé `reseau` de la configuration. Tolérante par construction : une
/// clé absente, d'un mauvais type, ou vide, vaut « pas de réglage » — jamais
/// une erreur. Un réglage réseau illisible ne doit pas empêcher l'application
/// de démarrer, il doit seulement ne rien changer.
pub fn lire(config: &Value) -> Reseau {
    let r = match config.get("reseau") {
        Some(v) if v.is_object() => v,
        _ => return Reseau::default(),
    };
    Reseau {
        proxy: texte(r.get("proxy")),
        sans_proxy: texte(r.get("sansProxy")),
        autorite: texte(r.get("autorite")),
        ca_systeme: r.get("caSysteme").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// Réglages réseau du poste, relus À CHAQUE (re)démarrage du sidecar : c'est ce
/// qui fait de « Relancer le moteur » le geste qui applique un proxy
/// fraîchement saisi. Configuration illisible = aucun réglage, jamais un refus
/// de démarrer.
pub fn lire_pour(app: &AppHandle) -> Reseau {
    crate::config_store::app_config_dir(app)
        .and_then(|dir| crate::config_store::read_config_from(&dir))
        .map(|cfg| lire(&cfg))
        .unwrap_or_default()
}

/// Variables d'environnement à poser sur le sidecar.
///
/// Les deux casses de `HTTP(S)_PROXY` sont écrites : Node lit les minuscules,
/// beaucoup d'outils la majuscule, et le poste peut déjà avoir l'une des deux.
/// Écrire les deux évite un désaccord silencieux entre nous et l'outil suivant.
pub fn variables(r: &Reseau) -> Vec<(String, String)> {
    let mut vars = Vec::new();
    if let Some(proxy) = &r.proxy {
        for cle in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
            vars.push((cle.to_string(), proxy.clone()));
        }
    }
    if let Some(sans) = &r.sans_proxy {
        for cle in ["NO_PROXY", "no_proxy"] {
            vars.push((cle.to_string(), sans.clone()));
        }
    }
    if let Some(autorite) = &r.autorite {
        vars.push(("NODE_EXTRA_CA_CERTS".to_string(), autorite.clone()));
    }
    vars
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn config_vide_ne_change_rien() {
        // L'invariant du fichier : sans réglage, l'environnement de l'enfant
        // est celui d'avant, à l'octet près.
        assert_eq!(lire(&json!({})), Reseau::default());
        assert!(variables(&lire(&json!({}))).is_empty());
    }

    #[test]
    fn cle_reseau_dun_mauvais_type_est_ignoree() {
        assert_eq!(lire(&json!({ "reseau": "http://proxy:3128" })), Reseau::default());
        assert_eq!(lire(&json!({ "reseau": [] })), Reseau::default());
    }

    #[test]
    fn champs_vides_ou_blancs_valent_absents() {
        let r = lire(&json!({ "reseau": { "proxy": "   ", "sansProxy": "", "autorite": " " } }));
        assert_eq!(r, Reseau::default());
    }

    #[test]
    fn proxy_est_ecrit_dans_les_deux_casses() {
        let r = lire(&json!({ "reseau": { "proxy": "  http://proxy:3128  " } }));
        assert_eq!(r.proxy.as_deref(), Some("http://proxy:3128"), "espaces rognés");
        let vars = variables(&r);
        for cle in ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"] {
            assert!(
                vars.iter().any(|(k, v)| k == cle && v == "http://proxy:3128"),
                "{cle} manquante : Node lit les minuscules, d'autres outils la majuscule"
            );
        }
    }

    #[test]
    fn autorite_et_sans_proxy() {
        let r = lire(&json!({
            "reseau": { "sansProxy": "localhost,127.0.0.1", "autorite": "/etc/ssl/entreprise.pem" }
        }));
        let vars = variables(&r);
        assert!(vars.iter().any(|(k, v)| k == "NO_PROXY" && v == "localhost,127.0.0.1"));
        assert!(vars.iter().any(|(k, _)| k == "no_proxy"));
        assert!(vars
            .iter()
            .any(|(k, v)| k == "NODE_EXTRA_CA_CERTS" && v == "/etc/ssl/entreprise.pem"));
    }

    #[test]
    fn ca_systeme_est_un_drapeau_pas_une_variable() {
        // `--use-system-ca` est un argument de Node, pas une variable : il ne
        // doit jamais apparaître dans l'environnement.
        let r = lire(&json!({ "reseau": { "caSysteme": true } }));
        assert!(r.ca_systeme);
        assert!(variables(&r).is_empty());
        assert!(!lire(&json!({ "reseau": { "caSysteme": "oui" } })).ca_systeme);
    }
}
