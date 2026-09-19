//! Sonde GPU (`nvidia-smi`) et sa logique de repli en cas d'échec — extrait de
//! `system_probe.rs` (qui dépassait la limite de taille du cliquet, T-129).
//!
//! Trois défauts corrigés ici par rapport à la version d'origine :
//! 1. un `nvidia-smi` présent mais en échec (code de retour non nul) était
//!    relancé à CHAQUE tick de 5 s, indéfiniment, sans jamais journaliser la
//!    cause — échec muet, cf. T-129 et la doctrine d'observabilité ;
//! 2. rien ne remontait jusqu'à l'UI, qui voyait juste le groupe GPU
//!    disparaître sans explication ;
//! 3. il manquait une position intermédiaire entre « on réessaie à chaque
//!    tick » et le verrou `NVIDIA_SMI_INTROUVABLE` (abandon définitif,
//!    réservé au binaire ABSENT).
//!
//! La décision — faut-il rejouer `nvidia-smi` ce tick, faut-il journaliser —
//! est de la logique PURE (`EtatEchecGpu`, aucun I/O, aucun `AppHandle`) :
//! c'est ce qui la rend testable par `#[test]` sans mock de l'environnement
//! Tauri. Seul `gpu_stats()` fait le spawn réel ; l'écriture de la ligne de
//! journal (qui a besoin de l'`AppHandle`) reste à charge de l'appelant —
//! voir `system_probe::system_stats`.

use std::io::ErrorKind;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::open_external::hide_console_window;
use crate::system_probe::temperature_plausible;

/// `nvidia-smi` est-il introuvable sur ce poste ? Verrouillé au premier échec de
/// SPAWN, et plus jamais relâché de la session.
///
/// Sans cette mémoire, une machine sans carte NVIDIA — le cas de la majorité des
/// postes — tentait de lancer un binaire absent toutes les 5 secondes, pour le
/// même verdict à chaque fois. C'est du bruit pur : le pilote n'apparaîtra pas en
/// cours de session.
///
/// Ne verrouille QUE sur `NotFound`. Un `nvidia-smi` présent mais en échec (code
/// de retour non nul, sortie muette) reste réinterrogé : ce peut être un pilote
/// qui se recharge ou une carte momentanément occupée, et la sonde doit se
/// rétablir toute seule.
static NVIDIA_SMI_INTROUVABLE: AtomicBool = AtomicBool::new(false);

/// Espacement initial du repli : un tick de la sonde (voir
/// `SYSTEM_STATS_INTERVAL_MS` côté UI, 5 s) — un échec isolé retente donc à
/// la cadence normale, sans attente supplémentaire.
const GPU_BACKOFF_INITIAL: Duration = Duration::from_secs(5);
/// Plafond du repli : au-delà, espacer davantage ne changerait rien — la
/// panne qui motive ce ticket (mismatch NVML après mise à jour du pilote)
/// ne se résout QUE par un redémarrage du poste, jamais par l'attente.
const GPU_BACKOFF_MAX: Duration = Duration::from_secs(300);

/// État de repli propre aux échecs "actifs" de `nvidia-smi` : le binaire
/// EXISTE mais échoue (code de retour non nul, ou spawn en échec pour une
/// raison autre que `NotFound`) — voir T-129.
///
/// C'est la position intermédiaire qui manquait entre `NVIDIA_SMI_INTROUVABLE`
/// (abandon définitif de la session, réservé au binaire absent) et un
/// réessai à chaque tick de 5 s qui martèle un pilote qui ne reviendra pas
/// sans redémarrage — tout en gardant l'intention d'origine : un succès
/// referme la fenêtre d'échec et rétablit la cadence nominale toute seule.
#[derive(Debug)]
struct EtatEchecGpu {
    /// Cause du DERNIER échec journalisé — ne réécrire dans le journal
    /// QU'AU CHANGEMENT de cette valeur, jamais à chaque tick (sinon on
    /// refait T-057).
    dernier_message: Option<String>,
    /// Échecs consécutifs de ce type ; remis à zéro par un succès.
    echecs_consecutifs: u32,
    /// Instant à partir duquel un nouveau spawn réel est autorisé ; `None`
    /// tant qu'aucun échec n'a eu lieu (cadence nominale).
    prochain_essai: Option<Instant>,
}

impl EtatEchecGpu {
    const fn new() -> Self {
        Self {
            dernier_message: None,
            echecs_consecutifs: 0,
            prochain_essai: None,
        }
    }

    /// Un nouveau spawn de `nvidia-smi` est-il autorisé MAINTENANT ? Toujours
    /// vrai avant le premier échec ; ensuite, seulement une fois le repli
    /// écoulé.
    fn doit_tenter(&self, maintenant: Instant) -> bool {
        match self.prochain_essai {
            None => true,
            Some(t) => maintenant >= t,
        }
    }

    /// Enregistre un échec de cause `message` (verbatim stderr + code de
    /// sortie) : incrémente le compteur, recalcule le délai avant le
    /// prochain essai (repli exponentiel plafonné à `GPU_BACKOFF_MAX`), et
    /// rend `true` si CE message doit être journalisé — au premier échec de
    /// la série, ou si la cause a changé depuis le dernier message
    /// journalisé.
    fn enregistrer_echec(&mut self, message: String, maintenant: Instant) -> bool {
        let dois_journaliser = self.dernier_message.as_deref() != Some(message.as_str());
        self.echecs_consecutifs = self.echecs_consecutifs.saturating_add(1);
        // Exponent borné à 10 : 2^10 * 5 s dépasse déjà largement le plafond
        // de 300 s, inutile d'aller plus loin — et ça écarte tout risque de
        // dépassement dans le calcul de la puissance.
        let exponent = self.echecs_consecutifs.saturating_sub(1).min(10);
        let delai = GPU_BACKOFF_INITIAL
            .saturating_mul(2u32.saturating_pow(exponent))
            .min(GPU_BACKOFF_MAX);
        self.prochain_essai = Some(maintenant + delai);
        self.dernier_message = Some(message);
        dois_journaliser
    }

    /// Un succès referme la fenêtre d'échec : compteur à zéro, prochain
    /// essai autorisé immédiatement (cadence nominale rétablie), plus de
    /// cause à afficher. C'est ce qui garde l'intention d'origine : la sonde
    /// se rétablit toute seule dès que `nvidia-smi` répond de nouveau.
    fn enregistrer_succes(&mut self) {
        self.echecs_consecutifs = 0;
        self.prochain_essai = None;
        self.dernier_message = None;
    }
}

static ECHEC_GPU: Mutex<EtatEchecGpu> = Mutex::new(EtatEchecGpu::new());

/// Ce qu'il y a à journaliser pour ce tick — calculé par la logique pure
/// ci-dessus. À charge de l'appelant, qui détient l'`AppHandle`, d'écrire
/// réellement la ligne (voir `system_probe::system_stats`).
pub(crate) enum JournalGpu {
    /// Rien à journaliser : cadence nominale, ou repli en cours pour une
    /// cause déjà connue.
    Rien,
    /// Nouvelle cause d'échec (première de la série, ou différente de la
    /// précédente).
    Echec(String),
    /// La sonde vient de se rétablir après au moins un échec.
    Retablie,
}

/// Résultat d'un instantané GPU : les mesures (None si absentes) et la
/// décision de journalisation pour ce tick.
pub(crate) struct SondeGpu {
    pub(crate) pct: Option<f64>,
    pub(crate) mem_used_mb: Option<u64>,
    pub(crate) mem_total_mb: Option<u64>,
    pub(crate) temp_c: Option<f64>,
    /// Cause du dernier échec connu, à remonter jusqu'à l'UI — voir
    /// `SystemStats::gpu_indisponible`.
    pub(crate) indisponible: Option<String>,
    pub(crate) journal: JournalGpu,
}

impl SondeGpu {
    fn vide() -> Self {
        Self {
            pct: None,
            mem_used_mb: None,
            mem_total_mb: None,
            temp_c: None,
            indisponible: None,
            journal: JournalGpu::Rien,
        }
    }
}

/// Construit le message de cause à partir du stderr de `nvidia-smi` et de
/// son code de sortie — pur, testable sans spawn. Le message porte la cause
/// VERBATIM (aucune reformulation) et le code de sortie, pour qu'un
/// rapprochement avec une commande manuelle au terminal soit immédiat.
fn message_echec_nvidia_smi(stderr: &[u8], code: Option<i32>) -> String {
    let stderr = String::from_utf8_lossy(stderr);
    let stderr = stderr.trim();
    let code = code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "inconnu (signal)".to_string());
    if stderr.is_empty() {
        format!("nvidia-smi a échoué sans message sur stderr (code de sortie {code})")
    } else {
        format!("{stderr} (code de sortie {code})")
    }
}

pub(crate) fn gpu_stats() -> SondeGpu {
    if NVIDIA_SMI_INTROUVABLE.load(Ordering::Relaxed) {
        return SondeGpu::vide();
    }

    let maintenant = Instant::now();
    {
        let etat = ECHEC_GPU.lock().unwrap();
        if !etat.doit_tenter(maintenant) {
            // Repli en cours : on NE relance PAS nvidia-smi ce tick — c'est
            // tout l'objet du repli — mais la cause déjà connue reste
            // affichée, plutôt que de retomber à None sans explication.
            return SondeGpu {
                indisponible: etat.dernier_message.clone(),
                ..SondeGpu::vide()
            };
        }
    }

    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
        "--format=csv,noheader,nounits",
    ]);
    // Pas de prepare_detached : on VEUT la sortie (process court, non interactif).
    // Mais pas de fenêtre pour autant : `nvidia-smi.exe` est un programme console,
    // et sans ce masquage Windows lui ouvrait un conhost à CHAQUE tick de la sonde
    // — une fenêtre noire qui clignotait toutes les 5 secondes tant que l'app
    // tournait (signalé le 2026-08-26). La sortie reste capturée par `output()`.
    hide_console_window(&mut cmd);
    let output = match cmd.output() {
        Ok(output) => output,
        Err(err) => {
            if err.kind() == ErrorKind::NotFound {
                NVIDIA_SMI_INTROUVABLE.store(true, Ordering::Relaxed);
                return SondeGpu::vide();
            }
            let message = format!("échec du lancement de nvidia-smi : {err}");
            let dois_journaliser = ECHEC_GPU
                .lock()
                .unwrap()
                .enregistrer_echec(message.clone(), maintenant);
            return SondeGpu {
                indisponible: Some(message.clone()),
                journal: if dois_journaliser {
                    JournalGpu::Echec(message)
                } else {
                    JournalGpu::Rien
                },
                ..SondeGpu::vide()
            };
        }
    };
    if !output.status.success() {
        let message = message_echec_nvidia_smi(&output.stderr, output.status.code());
        let dois_journaliser = ECHEC_GPU
            .lock()
            .unwrap()
            .enregistrer_echec(message.clone(), maintenant);
        return SondeGpu {
            indisponible: Some(message.clone()),
            journal: if dois_journaliser {
                JournalGpu::Echec(message)
            } else {
                JournalGpu::Rien
            },
            ..SondeGpu::vide()
        };
    }

    // Succès : referme la fenêtre d'échec. `etait_en_echec` dit s'il y a une
    // guérison à journaliser (pas de ligne « rétablie » si la sonde n'avait
    // jamais échoué).
    let etait_en_echec = {
        let mut etat = ECHEC_GPU.lock().unwrap();
        let etait_en_echec = etat.echecs_consecutifs > 0;
        etat.enregistrer_succes();
        etait_en_echec
    };

    let text = String::from_utf8_lossy(&output.stdout);
    // Première ligne = premier GPU (multi-GPU : hors périmètre v1).
    let Some(line) = text.lines().next() else {
        return SondeGpu::vide();
    };
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    // Le garde reste à 3, PAS à 4 : la température est lue seulement si la
    // colonne est là. Un pilote qui ne connaîtrait pas `temperature.gpu` ne
    // doit pas faire perdre l'utilisation et la mémoire, qui, elles,
    // marchaient déjà.
    if parts.len() < 3 {
        return SondeGpu::vide();
    }
    let temp = parts
        .get(3)
        .and_then(|v| v.parse::<f64>().ok())
        .and_then(temperature_plausible);
    SondeGpu {
        pct: parts[0].parse().ok(),
        mem_used_mb: parts[1].parse().ok(),
        mem_total_mb: parts[2].parse().ok(),
        temp_c: temp,
        indisponible: None,
        journal: if etait_en_echec {
            JournalGpu::Retablie
        } else {
            JournalGpu::Rien
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// La sonde GPU doit rendre le MÊME verdict de présence d'un appel à
    /// l'autre : GPU là = toujours des mesures, GPU absent (runners de CI,
    /// machines sans NVIDIA) = toujours None. On compare la présence et non les
    /// valeurs, qui varient légitimement entre deux instants.
    ///
    /// C'est ce qui garde honnête le verrou `NVIDIA_SMI_INTROUVABLE` : s'il se
    /// déclenchait à tort sur un poste équipé, le second appel deviendrait muet
    /// alors que le premier avait mesuré.
    #[test]
    fn gpu_verdict_stable_entre_deux_appels() {
        let sonde = gpu_stats();
        let sonde2 = gpu_stats();
        assert_eq!(sonde.pct.is_some(), sonde2.pct.is_some());
        assert_eq!(sonde.mem_used_mb.is_some(), sonde2.mem_used_mb.is_some());
        assert_eq!(sonde.mem_total_mb.is_some(), sonde2.mem_total_mb.is_some());
    }

    /// Deux échecs consécutifs de LA MÊME cause ne doivent produire qu'UNE
    /// SEULE journalisation — sinon on refait T-057 (le journal noyé de
    /// lignes répétées). Le premier échec journalise toujours (il n'y avait
    /// rien à comparer).
    #[test]
    fn deux_echecs_meme_cause_une_seule_journalisation() {
        let mut etat = EtatEchecGpu::new();
        let t0 = Instant::now();
        assert!(etat.enregistrer_echec("panne X".to_string(), t0));
        assert!(!etat.enregistrer_echec("panne X".to_string(), t0));
    }

    /// Une cause qui CHANGE redéclenche la journalisation, même si le repli
    /// n'a pas eu le temps de s'écouler : l'utilisateur doit savoir que
    /// l'erreur a changé de nature, pas seulement qu'elle persiste.
    #[test]
    fn changement_de_cause_reclenche_la_journalisation() {
        let mut etat = EtatEchecGpu::new();
        let t0 = Instant::now();
        assert!(etat.enregistrer_echec("panne X".to_string(), t0));
        assert!(etat.enregistrer_echec("panne Y".to_string(), t0));
    }

    /// N échecs consécutifs de même cause font grandir l'intervalle avant le
    /// prochain essai autorisé — repli exponentiel, PAS un martèlement à 5 s
    /// indéfiniment.
    #[test]
    fn echecs_repetes_agrandissent_lintervalle() {
        let mut etat = EtatEchecGpu::new();
        let t0 = Instant::now();
        etat.enregistrer_echec("panne X".to_string(), t0);
        let premier_delai = etat.prochain_essai.unwrap() - t0;
        etat.enregistrer_echec("panne X".to_string(), t0);
        let second_delai = etat.prochain_essai.unwrap() - t0;
        assert!(
            second_delai > premier_delai,
            "l'intervalle n'a pas grandi : {premier_delai:?} puis {second_delai:?}"
        );
    }

    /// Le repli est PLAFONNÉ : même après un grand nombre d'échecs, on ne
    /// dépasse jamais `GPU_BACKOFF_MAX` — sinon la sonde finirait par ne
    /// plus jamais réessayer.
    #[test]
    fn le_repli_ne_depasse_jamais_le_plafond() {
        let mut etat = EtatEchecGpu::new();
        let t0 = Instant::now();
        for _ in 0..50 {
            etat.enregistrer_echec("panne X".to_string(), t0);
        }
        let delai = etat.prochain_essai.unwrap() - t0;
        assert!(
            delai <= GPU_BACKOFF_MAX,
            "repli au-delà du plafond : {delai:?}"
        );
    }

    /// Un succès referme la fenêtre d'échec : la cadence nominale (essai
    /// autorisé immédiatement) est rétablie, et la prochaine panne — même de
    /// la même cause — journalise de nouveau, comme un premier échec.
    #[test]
    fn un_succes_retablit_la_cadence_nominale() {
        let mut etat = EtatEchecGpu::new();
        let t0 = Instant::now();
        etat.enregistrer_echec("panne X".to_string(), t0);
        etat.enregistrer_echec("panne X".to_string(), t0);
        etat.enregistrer_succes();
        assert!(etat.doit_tenter(t0), "cadence nominale non rétablie");
        assert!(
            etat.enregistrer_echec("panne X".to_string(), t0),
            "après succès, la même cause devrait de nouveau journaliser"
        );
    }

    /// Pendant le repli, aucun nouvel essai n'est autorisé ; une fois le
    /// délai écoulé, il l'est de nouveau.
    #[test]
    fn doit_tenter_respecte_le_delai_de_repli() {
        let mut etat = EtatEchecGpu::new();
        let t0 = Instant::now();
        etat.enregistrer_echec("panne X".to_string(), t0);
        let echeance = etat.prochain_essai.unwrap();
        assert!(!etat.doit_tenter(t0), "un nouvel essai est autorisé trop tôt");
        assert!(etat.doit_tenter(echeance), "le délai écoulé devrait autoriser un essai");
    }

    /// Le message de cause porte le stderr VERBATIM (pas de reformulation)
    /// et le code de sortie — c'est ce qui permet à l'utilisateur de
    /// rapprocher la ligne de journal d'une commande manuelle au terminal.
    #[test]
    fn message_echec_porte_la_cause_verbatim_et_le_code() {
        let message = message_echec_nvidia_smi(
            b"Failed to initialize NVML: Driver/library version mismatch\n",
            Some(18),
        );
        assert!(message.contains("Driver/library version mismatch"));
        assert!(message.contains("18"));
    }

    /// stderr vide (process mort sans un mot) ne doit pas produire un
    /// message vide et muet : le code de sortie doit rester lisible.
    #[test]
    fn message_echec_sans_stderr_reste_lisible() {
        let message = message_echec_nvidia_smi(b"", Some(1));
        assert!(message.contains('1'));
        assert!(!message.is_empty());
    }
}
