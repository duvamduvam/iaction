//! Ouverture et fermeture de session : l'application ne doit jamais
//! disparaître sans laisser une ligne (T-112).
//!
//! ── Le défaut ───────────────────────────────────────────────────────────
//! Le 2026-08-30, l'application a cessé d'exister — les cinq processus
//! compris — pendant qu'une vérification tournait. Les DEUX journaux se sont
//! arrêtés net sur les jalons de démarrage : ni `app.jsonl`, ni
//! `coquille.jsonl` ne portaient la moindre trace d'arrêt. Impossible de dire
//! si la vérification l'avait tuée ou si l'utilisateur l'avait fermée — à deux
//! mètres du clavier, dans la minute.
//!
//! C'est l'échec muet maximal : il ne reste littéralement rien à lire. Et la
//! doctrine du projet tient en une phrase — *aucun échec muet*.
//!
//! ── Pourquoi un TÉMOIN sur disque, et pas seulement une ligne à l'arrêt ─
//! Une ligne écrite à l'arrêt ne couvre que les arrêts qui laissent le temps
//! de l'écrire. `RunEvent::Exit` ne survient ni sur `SIGKILL`, ni sur une
//! coupure de courant, ni si la coquille elle-même plante — c'est-à-dire
//! précisément les cas où l'on a besoin de savoir.
//!
//! D'où l'inversion : chaque session pose un témoin à son ouverture et le
//! retire à sa fermeture propre. Un témoin qui SURVIT est donc la preuve d'un
//! arrêt brutal, et il est trouvé au démarrage suivant — sans qu'aucun code
//! n'ait eu à s'exécuter au moment de la mort. On ne peut pas journaliser sa
//! propre mort subite ; on peut constater sa propre résurrection.
//!
//! ── Un témoin PAR PROCESSUS ─────────────────────────────────────────────
//! `session-<pid>.json`, et non un fichier unique : deux instances peuvent
//! coexister (constaté le même jour). Avec un fichier unique, la seconde
//! écraserait le témoin de la première, dont la fermeture propre effacerait
//! ensuite celui de la seconde — et le démarrage suivant accuserait un arrêt
//! brutal qui n'a pas eu lieu. Un journal qui accuse à tort est pire qu'un
//! journal muet : on cesse de le croire.
//!
//! Un témoin dont le processus est ENCORE VIVANT n'est pas un arrêt brutal
//! non plus : c'est une autre session en cours. On le laisse tranquille.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::journal_coquille::journal_coquille;

/// Préfixe des témoins de session, dans le dossier des journaux.
const PREFIXE: &str = "session-";
const SUFFIXE: &str = ".json";

/// Nom du témoin d'un processus donné.
pub fn nom_temoin(pid: u32) -> String {
    format!("{PREFIXE}{pid}{SUFFIXE}")
}

/// PID porté par un nom de fichier de témoin, s'il en est un.
///
/// Rendu `None` pour tout ce qui n'est pas exactement un témoin : le dossier
/// des journaux contient aussi `app.jsonl`, `coquille.jsonl` et ses rotations,
/// qu'il ne faut évidemment pas prendre pour des sessions mortes.
pub fn pid_du_nom(nom: &str) -> Option<u32> {
    let reste = nom.strip_prefix(PREFIXE)?.strip_suffix(SUFFIXE)?;
    reste.parse::<u32>().ok()
}

/// Contenu d'un témoin. Volontairement minimal : ce qu'il faut pour nommer la
/// session morte au démarrage suivant, rien de plus.
pub fn contenu_temoin(pid: u32, ouverte_a: &str) -> Value {
    json!({ "pid": pid, "ouverte_a": ouverte_a })
}

/// Le processus existe-t-il encore ?
///
/// Sous Linux, `/proc/<pid>` est la réponse la plus simple et la plus sûre :
/// pas de signal envoyé, donc aucun effet de bord sur un processus qui ne nous
/// appartient pas. Ailleurs, on répond « mort » — le pire cas est une ligne de
/// journal en trop, jamais une ligne manquante.
#[cfg(target_os = "linux")]
fn processus_vivant(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}
#[cfg(not(target_os = "linux"))]
fn processus_vivant(_pid: u32) -> bool {
    false
}

fn dossier_journaux(app: &AppHandle) -> Option<PathBuf> {
    let base = app.path().app_config_dir().ok()?;
    let dossier = base.join("logs");
    std::fs::create_dir_all(&dossier).ok()?;
    Some(dossier)
}

/// Signale au journal toute session précédente arrêtée sans trace, puis pose
/// le témoin de celle qui démarre.
///
/// Best-effort d'un bout à l'autre, comme `journal_coquille` : une trace qui
/// empêcherait l'application de démarrer serait un remède pire que le mal.
pub fn ouvrir(app: &AppHandle) {
    let pid = std::process::id();
    let maintenant = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    if let Some(dossier) = dossier_journaux(app) {
        if let Ok(entrees) = std::fs::read_dir(&dossier) {
            for entree in entrees.flatten() {
                let nom = entree.file_name().to_string_lossy().to_string();
                let Some(pid_mort) = pid_du_nom(&nom) else {
                    continue;
                };
                // Une session encore vivante n'est pas un cadavre : c'est une
                // seconde instance, et son témoin ne nous appartient pas.
                if pid_mort == pid || processus_vivant(pid_mort) {
                    continue;
                }
                let ouverte_a = std::fs::read_to_string(entree.path())
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .and_then(|v| v.get("ouverte_a").and_then(Value::as_str).map(String::from));
                journal_coquille(
                    app,
                    "warn",
                    "session précédente arrêtée sans trace",
                    &json!({ "pid": pid_mort, "ouverte_a": ouverte_a }),
                );
                let _ = std::fs::remove_file(entree.path());
            }
        }
        let _ = std::fs::write(
            dossier.join(nom_temoin(pid)),
            contenu_temoin(pid, &maintenant).to_string(),
        );
    }

    journal_coquille(app, "info", "session ouverte", &json!({ "pid": pid }));
}

/// Retire le témoin et écrit la ligne d'arrêt. Appelée sur `RunEvent::Exit`,
/// donc uniquement pour les arrêts qui laissent le temps de parler — les
/// autres sont rattrapés au démarrage suivant par `ouvrir`.
pub fn fermer(app: &AppHandle) {
    let pid = std::process::id();
    journal_coquille(app, "info", "session fermée", &json!({ "pid": pid }));
    if let Some(dossier) = dossier_journaux(app) {
        let _ = std::fs::remove_file(dossier.join(nom_temoin(pid)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_temoin_se_reconnait_a_son_nom() {
        assert_eq!(pid_du_nom("session-12345.json"), Some(12345));
        assert_eq!(nom_temoin(12345), "session-12345.json");
    }

    #[test]
    fn les_autres_fichiers_du_dossier_ne_sont_pas_des_temoins() {
        // Le dossier contient aussi les journaux : les prendre pour des
        // sessions mortes produirait une accusation par démarrage.
        assert_eq!(pid_du_nom("app.jsonl"), None);
        assert_eq!(pid_du_nom("coquille.jsonl"), None);
        assert_eq!(pid_du_nom("coquille.jsonl.1"), None);
        assert_eq!(pid_du_nom("session-.json"), None);
        assert_eq!(pid_du_nom("session-abc.json"), None);
        assert_eq!(pid_du_nom("session-12345.json.bak"), None);
    }

    #[test]
    fn le_temoin_porte_de_quoi_nommer_la_session_morte() {
        let v = contenu_temoin(42, "2026-08-30T15:07:31.000Z");
        assert_eq!(v.get("pid").and_then(Value::as_u64), Some(42));
        assert_eq!(
            v.get("ouverte_a").and_then(Value::as_str),
            Some("2026-08-30T15:07:31.000Z")
        );
    }

    /// T-138 — restreint à Linux, et ce n'est pas un contournement : hors
    /// Linux, `processus_vivant` répond « mort » **par conception** (voir sa
    /// documentation — aucun `/proc` à interroger, et on préfère une ligne de
    /// journal en trop à une ligne manquante). Affirmer ici que le processus
    /// courant est vivant contredirait donc le comportement voulu, et c'est ce
    /// qui a fait tomber la construction Windows de la 0.6.0. Même traitement
    /// que `mem_totale_plausible` (system_probe.rs), pour la même raison.
    #[cfg(target_os = "linux")]
    #[test]
    fn le_processus_courant_est_vivant() {
        // Garde-fou de la détection elle-même : si elle répondait « mort »
        // pour tout le monde, chaque démarrage accuserait la session d'à côté.
        assert!(processus_vivant(std::process::id()));
    }

    /// Le pendant du précédent : hors Linux, le verdict « mort » est ATTENDU.
    /// Sans ce test, la dégradation documentée serait invérifiable, et on ne
    /// saurait pas si un futur portage Windows a bien été branché.
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn hors_linux_la_detection_est_volontairement_aveugle() {
        assert!(!processus_vivant(std::process::id()));
    }
}
