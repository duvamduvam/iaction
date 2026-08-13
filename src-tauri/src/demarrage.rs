//! Budget de démarrage : combien de temps l'application met à devenir
//! utilisable, MESURÉ plutôt que supposé.
//!
//! ── Pourquoi ────────────────────────────────────────────────────────────
//! Le 2026-08-11, question simple : « pourquoi le démarrage est-il si long ? ».
//! Tout ce qui était instrumenté a répondu tout de suite — sidecar prêt en
//! 0,25 s, `cargo build` à blanc en 0,23 s, 6 Mo de conversations relus en
//! 32 ms, quatre requêtes de démarrage servies en 150 ms. Mais le premier
//! horodatage de la session était déjà celui de `setup()` : tout ce qui
//! précède — le chargement des 124 bibliothèques partagées par `ld.so`, l'init
//! GTK/WebKitGTK — n'avait AUCUNE trace, et le temps que met la webview à
//! afficher quelque chose non plus. Le plus gros suspect était précisément le
//! seul segment non mesuré.
//!
//! Ce module pose donc quatre jalons sur le chemin du démarrage, écrits dans
//! `logs/coquille.jsonl` (le journal de secours, qui ne dépend pas du sidecar
//! — voir `docs/protocol.md`, § « Jalons de démarrage ») :
//!
//! | jalon                    | ce qu'il clôt                                   |
//! |--------------------------|-------------------------------------------------|
//! | `rust:setup`             | ld.so + init Tauri/GTK, jusqu'au `setup()`      |
//! | `rust:boucle-evenements` | construction de l'app et de la fenêtre          |
//! | `ui:script`              | webview + chargement/parse du JS de l'interface |
//! | `ui:premier-rendu`       | premier dessin effectif de React                |
//!
//! ── Deux origines, pas une ──────────────────────────────────────────────
//! `depuisMainMs` part de la première ligne de `main()`. `avantMainMs` mesure
//! ce qui s'est passé AVANT elle (chargement dynamique des bibliothèques) : un
//! `Instant` ne peut pas le voir, puisqu'il ne peut naître qu'une fois le
//! programme lancé. On le lit dans `/proc` — donc Linux seulement, et le champ
//! vaut `null` ailleurs plutôt que d'inventer un zéro rassurant. `totalMs` est
//! la somme des deux : le seul chiffre qui se compare à un chronomètre.
//!
//! ── Coût ────────────────────────────────────────────────────────────────
//! Quatre lignes par session, deux `read_to_string` dans `/proc` une seule
//! fois, et rien dans les chemins chauds. La mesure ne finance pas son propre
//! ralentissement.

use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use tauri::AppHandle;

use crate::journal_coquille::journal_coquille;

/// Jalons que la WEBVIEW a le droit de poser. Liste fermée : la commande est
/// exposée au JS, et un journal de démarrage ne doit pas pouvoir devenir un
/// canal d'écriture libre sur le disque (ni un déversoir de bruit).
const JALONS_UI: [&str; 2] = ["ui:script", "ui:premier-rendu"];

/// USER_HZ — l'unité des temps de `/proc/[pid]/stat`. Constante de l'ABI
/// Linux, à 100 sur tous les noyaux courants ; la lire proprement
/// (`sysconf(_SC_CLK_TCK)`) demanderait la crate `libc` pour ce seul appel.
/// Une erreur ici ne fausserait qu'un chiffre de diagnostic, jamais le
/// comportement du produit.
#[cfg(target_os = "linux")]
const TICKS_PAR_SECONDE: u64 = 100;

/// Origine des mesures, posée une fois pour toutes au tout début de `main()`.
struct Depart {
    instant: Instant,
    /// Âge du process à cet instant, en ms — `None` hors Linux.
    avant_main_ms: Option<u64>,
}

static DEPART: OnceLock<Depart> = OnceLock::new();

/// Jalons déjà écrits : un jalon ne s'écrit QU'UNE FOIS par session.
///
/// Indispensable côté UI : le `StrictMode` de React monte deux fois en
/// développement, et un rechargement à chaud rejoue `main.tsx` — sans cette
/// garde, `ui:script` réapparaîtrait à chaque HMR avec un `totalMs` qui n'a
/// plus rien à voir avec un démarrage.
static DEJA_POSES: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();

/// À appeler comme PREMIÈRE instruction de `main()`. Idempotent.
pub fn marquer_debut() {
    let _ = DEPART.set(Depart {
        instant: Instant::now(),
        avant_main_ms: age_process_ms(),
    });
}

/// Écrit un jalon dans le journal de la coquille. Best-effort de bout en bout :
/// sans origine posée (cas d'un binaire qui n'appellerait pas `marquer_debut`),
/// on ne journalise rien plutôt qu'un chiffre faux.
///
/// `page_ms` n'existe que pour les jalons de la webview : c'est l'âge de la
/// PAGE, seule mesure capable de dire si le temps est parti dans le démarrage
/// du moteur web ou dans le chargement de l'interface.
pub fn jalon(app: &AppHandle, etape: &str) {
    jalon_avec_page(app, etape, None)
}

fn jalon_avec_page(app: &AppHandle, etape: &str, page_ms: Option<u64>) {
    let Some(depart) = DEPART.get() else {
        return;
    };

    let verrou = DEJA_POSES.get_or_init(|| Mutex::new(BTreeSet::new()));
    {
        let mut poses = match verrou.lock() {
            Ok(poses) => poses,
            Err(empoisonne) => empoisonne.into_inner(),
        };
        if !poses.insert(etape.to_string()) {
            return;
        }
    }

    let depuis_main_ms = depart.instant.elapsed().as_millis() as u64;
    let total_ms = depart
        .avant_main_ms
        .map(|avant| avant + depuis_main_ms)
        .unwrap_or(depuis_main_ms);

    journal_coquille(
        app,
        "info",
        "jalon de démarrage",
        &serde_json::json!({
            "etape": etape,
            "avantMainMs": depart.avant_main_ms,
            "depuisMainMs": depuis_main_ms,
            "totalMs": total_ms,
            "pageMs": page_ms,
        }),
    );
}

/// Commande Tauri : la webview pose son propre jalon. C'est le seul moyen de
/// mesurer le segment qui appartient au moteur web — le Rust ne sait pas quand
/// le JS a fini de se charger, encore moins quand React a dessiné.
#[tauri::command]
pub fn demarrage_jalon(app: AppHandle, etape: String, page_ms: Option<u64>) -> Result<(), String> {
    if !JALONS_UI.contains(&etape.as_str()) {
        return Err(format!("jalon de démarrage inconnu : {etape:?}"));
    }
    jalon_avec_page(&app, &etape, page_ms);
    Ok(())
}

/// Âge du process, en millisecondes, au moment de l'appel — soit tout ce qui
/// s'est déroulé avant la première ligne de `main()`.
#[cfg(target_os = "linux")]
fn age_process_ms() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let uptime = std::fs::read_to_string("/proc/uptime").ok()?;
    let naissance_ms = ticks_de_depart(&stat)? * (1_000 / TICKS_PAR_SECONDE);
    // `checked_sub` plutôt qu'une soustraction : les deux lectures ne sont pas
    // atomiques, et un âge négatif produirait une valeur absurde par débordement.
    uptime_ms(&uptime)?.checked_sub(naissance_ms)
}

/// Hors Linux, l'information n'est pas lisible aussi simplement : on le DIT
/// (champ `null`) au lieu de laisser croire à un démarrage instantané.
#[cfg(not(target_os = "linux"))]
fn age_process_ms() -> Option<u64> {
    None
}

/// Extrait le champ 22 (`starttime`, en ticks depuis le boot) d'une ligne
/// `/proc/[pid]/stat`.
///
/// Le découpage part de la DERNIÈRE parenthèse fermante : le champ 2 est le nom
/// de l'exécutable, entre parenthèses, et il peut contenir des espaces comme
/// des parenthèses. Découper sur les espaces depuis le début décale alors tous
/// les champs suivants — c'est le piège classique de ce fichier.
#[cfg(target_os = "linux")]
fn ticks_de_depart(stat: &str) -> Option<u64> {
    let apres_nom = &stat[stat.rfind(')')? + 1..];
    // `apres_nom` commence au champ 3 (`state`) : `starttime` est donc le 20e.
    apres_nom.split_whitespace().nth(22 - 3)?.parse().ok()
}

/// Convertit le contenu de `/proc/uptime` (secondes décimales, puis temps
/// oisif) en millisecondes.
#[cfg(target_os = "linux")]
fn uptime_ms(contenu: &str) -> Option<u64> {
    let secondes: f64 = contenu.split_whitespace().next()?.parse().ok()?;
    Some((secondes * 1_000.0) as u64)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::{ticks_de_depart, uptime_ms};

    /// Ligne réelle, tronquée après le champ `starttime` (le 22e).
    const STAT: &str =
        "395337 (iaction) S 395102 395337 395102 0 -1 4194304 62533 0 0 0 118 41 0 0 20 0 41 0 8127403";

    #[test]
    fn lit_le_ticks_de_depart_dune_ligne_stat() {
        assert_eq!(ticks_de_depart(STAT), Some(8_127_403));
    }

    #[test]
    fn ne_se_laisse_pas_decaler_par_un_nom_dexecutable_pieges() {
        // Espaces ET parenthèses dans le nom : le découpage naïf se décale ici.
        let piege = STAT.replacen("(iaction)", "(ia action (dev))", 1);
        assert_eq!(ticks_de_depart(&piege), Some(8_127_403));
    }

    #[test]
    fn refuse_une_ligne_qui_na_pas_la_forme_attendue() {
        assert_eq!(ticks_de_depart("pas du tout un stat"), None);
        assert_eq!(ticks_de_depart("123 (court) S 1"), None);
    }

    #[test]
    fn convertit_luptime_en_millisecondes() {
        assert_eq!(uptime_ms("81274.03 620000.00\n"), Some(81_274_030));
        assert_eq!(uptime_ms(""), None);
        assert_eq!(uptime_ms("bavardage 1"), None);
    }
}
