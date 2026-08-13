//! Journal de secours de la coquille, et de quoi raconter la MORT d'un sidecar.
//!
//! Deux ingrédients, réunis ici parce qu'ils ne servent qu'ensemble :
//!
//! 1. `journal_coquille` — l'écriture directe sur disque, seul canal qui
//!    survive à la mort du sidecar (voir `docs/protocol.md`, § « Journal de
//!    secours de la coquille ») ;
//! 2. `TamponStderr` + `cause_de_fin` — la mémoire courte de la stderr du
//!    process surveillé et la mise en mots de sa fin.
//!
//! Le second existe à cause d'un constat du 2026-08-09 : `coquille.jsonl` ne
//! contenait qu'une ligne, `démarrage de la supervision du sidecar`, répétée
//! huit fois dans la journée — jamais un code de sortie, jamais un signal,
//! jamais une ligne de stderr. Une supervision qui note la naissance sans
//! jamais noter la mort ne supervise pas : elle compte (ticket T-017).
//!
//! Tout ce qui est calcul pur (formatage de la cause, tampon circulaire) vit
//! ici et y est testé : la boucle de supervision, elle, ne s'instancie pas
//! sans un vrai `AppHandle` et un vrai process.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Taille au-delà de laquelle le journal de la coquille est archivé en `.1`.
/// Ces lignes sont rares par nature ; le plafond ne protège que du cas
/// pathologique — une boucle d'échec qui journalise sans fin.
const COQUILLE_MAX_OCTETS: u64 = 1_000_000;

/// Nombre de lignes de stderr conservées par process surveillé. Trente
/// suffisent à porter une trace de pile Node et le message qui la précède ;
/// c'est surtout une BORNE DURE sur la mémoire : le tampon d'un sidecar
/// bavard ne doit jamais grossir avec lui.
const MAX_LIGNES_STDERR: usize = 30;

/// Longueur maximale conservée pour UNE ligne de stderr.
const MAX_CARS_LIGNE: usize = 300;

/// Longueur maximale du résumé de stderr écrit dans le journal : une entrée
/// de journal reste une ligne qu'on lit, pas un fichier de trace.
const MAX_CARS_RESUME: usize = 2_000;

/// Écrit une ligne de journal DIRECTEMENT sur le disque, sans passer par le
/// sidecar.
///
/// Fichier séparé (`logs/coquille.jsonl`) et non `app.jsonl` : le contrat du
/// protocole réserve ce dernier à un écrivain unique (le sidecar, via
/// `log.append`), et deux processus qui ajoutent au même fichier finiraient par
/// s'entrelacer. Même format de ligne, pour qu'un seul lecteur suffise.
///
/// Best-effort d'un bout à l'autre : si l'écriture échoue, on se tait. On ne
/// journalise pas l'échec du journal, et surtout on n'empêche pas
/// l'application de démarrer pour si peu.
pub fn journal_coquille(app: &AppHandle, level: &str, msg: &str, fields: &Value) {
    let Ok(base) = app.path().app_config_dir() else {
        return;
    };
    let dossier = base.join("logs");
    if std::fs::create_dir_all(&dossier).is_err() {
        return;
    }
    let fichier = dossier.join("coquille.jsonl");

    if let Ok(meta) = std::fs::metadata(&fichier) {
        if meta.len() > COQUILLE_MAX_OCTETS {
            let _ = std::fs::rename(&fichier, dossier.join("coquille.jsonl.1"));
        }
    }

    let ligne = serde_json::json!({
        "ts": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "level": level,
        "scope": "rust",
        "msg": msg,
        "fields": fields,
    });

    use std::io::Write as _;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&fichier) {
        let _ = writeln!(f, "{ligne}");
    }
}

/// Mémoire courte de la stderr d'UN process sidecar : les `MAX_LIGNES_STDERR`
/// dernières lignes, rien de plus.
///
/// Partagée entre le thread qui lit la stderr et celui qui supervise le
/// process, d'où l'`Arc<Mutex<…>>`. Le clone est bon marché et désigne le
/// MÊME tampon — un tampon par process, jamais un tampon global : mélanger
/// les dernières paroles de deux sidecars successifs, c'est fabriquer un faux
/// témoignage.
#[derive(Clone)]
pub struct TamponStderr(Arc<Mutex<VecDeque<String>>>);

impl TamponStderr {
    pub fn neuf() -> Self {
        TamponStderr(Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LIGNES_STDERR))))
    }

    /// Ajoute une ligne, en évinçant la plus ancienne au-delà de la capacité.
    /// La ligne est tronquée à l'entrée : le plafond mémoire est le produit de
    /// DEUX bornes, sinon une seule ligne de 10 Mo suffirait à le crever.
    pub fn pousser(&self, ligne: &str) {
        let Ok(mut file) = self.0.lock() else {
            // Mutex empoisonné par un panic : on renonce à la ligne plutôt que
            // de paniquer à notre tour dans un thread de relais.
            return;
        };
        if file.len() >= MAX_LIGNES_STDERR {
            file.pop_front();
        }
        file.push_back(tronquer(ligne, MAX_CARS_LIGNE));
    }

    /// Copie des lignes retenues, de la plus ancienne à la plus récente.
    pub fn dernieres(&self) -> Vec<String> {
        match self.0.lock() {
            Ok(file) => file.iter().cloned().collect(),
            Err(poisoned) => poisoned.into_inner().iter().cloned().collect(),
        }
    }
}

impl Default for TamponStderr {
    fn default() -> Self {
        Self::neuf()
    }
}

/// Tronque sur une frontière de CARACTÈRE (jamais d'octet : une troncature au
/// milieu d'un accent produirait une chaîne invalide) et signale la coupe.
fn tronquer(texte: &str, max_cars: usize) -> String {
    match texte.char_indices().nth(max_cars) {
        Some((octet, _)) => format!("{}…", &texte[..octet]),
        None => texte.to_string(),
    }
}

/// Met en mots la fin d'un process, à partir du code de sortie et du signal
/// rapportés par l'OS.
///
/// Fonction PURE, et c'est délibéré : c'est la seule partie du récit de mort
/// qu'on peut vérifier par un test sans un vrai process à tuer.
pub fn cause_de_fin(code: Option<i32>, signal: Option<i32>) -> String {
    if let Some(sig) = signal {
        return match nom_signal(sig) {
            Some(nom) => format!("tué par le signal {sig} ({nom})"),
            None => format!("tué par le signal {sig}"),
        };
    }
    match code {
        Some(0) => "sortie normale (code 0)".to_string(),
        Some(c) => format!("code de sortie {c}"),
        None => "fin sans code ni signal (cause inconnue)".to_string(),
    }
}

/// Noms des signaux qu'on rencontre réellement ici. La liste est courte
/// exprès : un numéro inconnu s'affiche tel quel, ce qui reste diagnosticable,
/// plutôt que d'embarquer une table complète et dépendante de la plateforme.
fn nom_signal(signal: i32) -> Option<&'static str> {
    match signal {
        1 => Some("SIGHUP"),
        2 => Some("SIGINT"),
        6 => Some("SIGABRT"),
        9 => Some("SIGKILL"),
        11 => Some("SIGSEGV"),
        13 => Some("SIGPIPE"),
        15 => Some("SIGTERM"),
        _ => None,
    }
}

/// Assemble les dernières lignes de stderr en UNE valeur de champ de journal.
///
/// Une entrée de journal est une ligne (`docs/protocol.md`, « Forme d'une
/// entrée ») : les sauts de ligne deviennent un séparateur visible, et le tout
/// est borné. On garde la FIN plutôt que le début — la cause d'une mort est
/// dans les derniers mots, pas dans les premiers.
fn resume_stderr(lignes: &[String]) -> String {
    let joint = lignes.join(" ⏎ ");
    let cars = joint.chars().count();
    if cars <= MAX_CARS_RESUME {
        return joint;
    }
    let debut: usize = joint
        .char_indices()
        .nth(cars - MAX_CARS_RESUME)
        .map(|(octet, _)| octet)
        .unwrap_or(0);
    format!("…{}", &joint[debut..])
}

/// Extrait `(cause, code, signal)` d'un état de sortie de process.
///
/// Le signal n'existe que sur Unix ; ailleurs il vaut toujours `None` et la
/// cause se lit dans le code de sortie.
fn decrire_fin(fin: Option<std::process::ExitStatus>) -> (String, Option<i32>, Option<i32>) {
    let Some(status) = fin else {
        return (cause_de_fin(None, None), None, None);
    };
    let code = status.code();
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt as _;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal: Option<i32> = None;
    (cause_de_fin(code, signal), code, signal)
}

/// Journalise la MORT du process surveillé : cause (code de sortie ou signal),
/// durée de vie, et les dernières lignes de sa stderr.
///
/// Niveau `error`, donc écrit AUSSI sur le disque par `log_app` — c'est tout
/// l'enjeu : au moment où cette ligne part, le sidecar est mort, la porte
/// `app:log` → `log.append` ne mène plus nulle part, et `coquille.jsonl` est
/// le seul journal qui reste. Sans elle, `coquille.jsonl` ne contenait que des
/// naissances (T-017).
///
/// C'est le SEUL `log_app` autorisé à porter du stderr sidecar, et le
/// raisonnement mérite d'être redit : le relais ligne à ligne
/// (`spawn_stderr_reader`) doit s'en abstenir absolument, parce que chaque
/// `app:log` repart en `log.append`, que le sidecar écrit… sur sa stderr —
/// boucle sans fin, interdite par le contrat. Ici l'événement est UNIQUE par
/// process, et il part alors que le process est DÉJÀ MORT : aucune ligne de
/// stderr ne peut en naître. Le tampon est borné (30 lignes de 300 caractères),
/// donc la taille de la ligne de journal l'est aussi.
pub fn journaliser_mort(
    app: &AppHandle,
    pid: u32,
    fin: Option<std::process::ExitStatus>,
    uptime: std::time::Duration,
    tampon: &TamponStderr,
) {
    let (cause, code, signal) = decrire_fin(fin);
    let lignes = tampon.dernieres();
    eprintln!(
        "[sidecar] process {pid} terminé : {cause} après {} ms",
        uptime.as_millis()
    );
    crate::sidecar::log_app(
        app,
        "error",
        "sidecar terminé".to_string(),
        serde_json::json!({
            "pid": pid,
            "cause": cause,
            "code": code,
            "signal": signal,
            "uptimeMs": uptime.as_millis() as u64,
            "stderrLignes": lignes.len(),
            "stderr": resume_stderr(&lignes),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::{cause_de_fin, resume_stderr, TamponStderr, MAX_LIGNES_STDERR};

    #[test]
    fn la_cause_nomme_le_signal_quand_il_y_en_a_un() {
        assert_eq!(cause_de_fin(None, Some(9)), "tué par le signal 9 (SIGKILL)");
        // Signal hors table : le numéro seul reste diagnosticable.
        assert_eq!(cause_de_fin(None, Some(64)), "tué par le signal 64");
        // Un signal prime sur un éventuel code : c'est lui la cause.
        assert_eq!(cause_de_fin(Some(0), Some(15)), "tué par le signal 15 (SIGTERM)");
    }

    #[test]
    fn la_cause_distingue_la_sortie_normale_de_lechec() {
        assert_eq!(cause_de_fin(Some(0), None), "sortie normale (code 0)");
        assert_eq!(cause_de_fin(Some(1), None), "code de sortie 1");
    }

    #[test]
    fn une_fin_sans_code_ni_signal_le_dit_au_lieu_de_se_taire() {
        assert_eq!(
            cause_de_fin(None, None),
            "fin sans code ni signal (cause inconnue)"
        );
    }

    #[test]
    fn le_tampon_ne_garde_que_les_dernieres_lignes() {
        let tampon = TamponStderr::neuf();
        for i in 0..(MAX_LIGNES_STDERR + 12) {
            tampon.pousser(&format!("ligne {i}"));
        }
        let lignes = tampon.dernieres();
        assert_eq!(lignes.len(), MAX_LIGNES_STDERR);
        // La plus RÉCENTE est la dernière : c'est elle qui porte la cause.
        assert_eq!(lignes.last().unwrap(), &format!("ligne {}", MAX_LIGNES_STDERR + 11));
        assert_eq!(lignes.first().unwrap(), &format!("ligne {}", 12));
    }

    #[test]
    fn le_tampon_tronque_une_ligne_demesuree_sans_couper_un_caractere() {
        let tampon = TamponStderr::neuf();
        tampon.pousser(&"é".repeat(5_000));
        let lignes = tampon.dernieres();
        assert_eq!(lignes.len(), 1);
        // 300 caractères + le marqueur de coupe, et surtout une chaîne valide.
        assert_eq!(lignes[0].chars().count(), 301);
        assert!(lignes[0].ends_with('…'));
    }

    #[test]
    fn le_resume_tient_sur_une_ligne_et_garde_la_fin() {
        let lignes = vec!["premier".to_string(), "dernier".to_string()];
        assert_eq!(resume_stderr(&lignes), "premier ⏎ dernier");

        let longues: Vec<String> = (0..MAX_LIGNES_STDERR).map(|_| "x".repeat(300)).collect();
        let resume = resume_stderr(&longues);
        assert!(resume.starts_with('…'));
        assert!(resume.chars().count() <= 2_001);
        assert!(resume.ends_with('x'));
    }

    #[test]
    fn un_tampon_vide_ne_produit_pas_de_bruit() {
        assert_eq!(resume_stderr(&[]), "");
        assert_eq!(TamponStderr::neuf().dernieres().len(), 0);
    }
}
