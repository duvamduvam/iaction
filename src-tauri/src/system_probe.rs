//! Commandes Tauri « poste de travail » : lancement d'un terminal dans un
//! répertoire, et sonde minimale CPU/RAM/GPU pour l'encart de l'en-tête.
//!
//! Voir `docs/protocol.md`, section « Commandes Tauri poste de travail ».
//! Même philosophie que le reste du Rust : mince, zéro dépendance ajoutée
//! (lecture /proc pour CPU/RAM, `nvidia-smi` optionnel pour le GPU).

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;

use crate::open_external::{hide_console_window, prepare_detached};

/// Émulateurs de terminal essayés dans l'ordre. Le répertoire de travail est
/// donné via `current_dir` (portable : aucun flag spécifique nécessaire).
const TERMINAL_CANDIDATES: &[&str] = &[
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "kitty",
    "alacritty",
    "x-terminal-emulator",
    "xterm",
];

/// Résout le répertoire de travail du terminal : `path` s'il désigne un
/// répertoire, sinon repli sur le home. Pur (testable sans spawn).
fn resolve_terminal_dir(path: Option<String>) -> Result<String, String> {
    path.filter(|p| !p.trim().is_empty() && std::path::Path::new(p).is_dir())
        .or_else(|| std::env::var("HOME").ok())
        .ok_or_else(|| "aucun répertoire valide (path absent et HOME non défini)".to_string())
}

/// Commande Tauri : ouvre un terminal système dans `path` (répertoire) ; repli
/// sur le home si `path` est absent ou n'est pas un répertoire. Spawn détaché,
/// environnement nettoyé de la pollution Snap (voir open_external.rs).
#[tauri::command]
pub fn open_terminal(path: Option<String>) -> Result<String, String> {
    let dir = resolve_terminal_dir(path)?;

    let mut last_error = String::new();
    for program in TERMINAL_CANDIDATES {
        let mut cmd = Command::new(program);
        cmd.current_dir(&dir);
        prepare_detached(&mut cmd);
        match cmd.spawn() {
            Ok(_child) => return Ok(dir),
            Err(err) => last_error = format!("{program} : {err}"),
        }
    }
    Err(format!(
        "aucun émulateur de terminal trouvé ({}) — dernier échec : {last_error}",
        TERMINAL_CANDIDATES.join(", ")
    ))
}

/* ---------- Sonde CPU / RAM / GPU ---------- */

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// % CPU global depuis l'appel précédent (None au premier appel : la
    /// mesure est un delta entre deux lectures de /proc/stat).
    pub cpu_pct: Option<f64>,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    /// GPU NVIDIA via `nvidia-smi` — None si absent/en échec (pas d'erreur).
    pub gpu_pct: Option<f64>,
    pub gpu_mem_used_mb: Option<u64>,
    pub gpu_mem_total_mb: Option<u64>,
    /// Température du GPU en °C — même source que les autres champs GPU
    /// (`nvidia-smi`), donc `None` dès qu'il est absent ou muet.
    pub gpu_temp_c: Option<f64>,
    /// Température du paquet processeur en °C, lue dans /sys/class/hwmon —
    /// None si aucun capteur exploitable (autre OS, machine virtuelle…).
    pub cpu_temp_c: Option<f64>,
    /// Température des barrettes de mémoire en °C — None si aucun capteur.
    /// C'est le cas courant : voir `ram_temp()`.
    pub ram_temp_c: Option<f64>,
}

/// Échantillon précédent de /proc/stat (idle cumulé, total cumulé), partagé
/// entre appels pour calculer le delta.
static PREV_CPU: Mutex<Option<(u64, u64)>> = Mutex::new(None);

fn read_cpu_sample() -> Option<(u64, u64)> {
    let stat = fs::read_to_string("/proc/stat").ok()?;
    let line = stat.lines().next()?; // "cpu  user nice system idle iowait irq softirq steal ..."
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse().ok())
        .collect();
    if values.len() < 5 {
        return None;
    }
    let idle = values[3] + values[4]; // idle + iowait
    let total: u64 = values.iter().sum();
    Some((idle, total))
}

fn cpu_pct() -> Option<f64> {
    let current = read_cpu_sample()?;
    let mut prev = PREV_CPU.lock().ok()?;
    let result = prev.and_then(|(prev_idle, prev_total)| {
        let d_total = current.1.saturating_sub(prev_total);
        let d_idle = current.0.saturating_sub(prev_idle);
        if d_total == 0 {
            return None;
        }
        Some(100.0 * (1.0 - (d_idle as f64) / (d_total as f64)))
    });
    *prev = Some(current);
    result
}

fn mem_mb() -> (u64, u64) {
    let Ok(meminfo) = fs::read_to_string("/proc/meminfo") else {
        return (0, 0);
    };
    let read_kb = |key: &str| -> u64 {
        meminfo
            .lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    };
    let total = read_kb("MemTotal:") / 1024;
    let available = read_kb("MemAvailable:") / 1024;
    (total.saturating_sub(available), total)
}

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

fn gpu_stats() -> (Option<f64>, Option<u64>, Option<u64>, Option<f64>) {
    if NVIDIA_SMI_INTROUVABLE.load(Ordering::Relaxed) {
        return (None, None, None, None);
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
            }
            return (None, None, None, None);
        }
    };
    if !output.status.success() {
        return (None, None, None, None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // Première ligne = premier GPU (multi-GPU : hors périmètre v1).
    let Some(line) = text.lines().next() else {
        return (None, None, None, None);
    };
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    // Le garde reste à 3, PAS à 4 : la température est lue seulement si la
    // colonne est là. Un pilote qui ne connaîtrait pas `temperature.gpu` ne
    // doit pas faire perdre l'utilisation et la mémoire, qui, elles,
    // marchaient déjà.
    if parts.len() < 3 {
        return (None, None, None, None);
    }
    let temp = parts
        .get(3)
        .and_then(|v| v.parse::<f64>().ok())
        .and_then(temperature_plausible);
    (
        parts[0].parse().ok(),
        parts[1].parse().ok(),
        parts[2].parse().ok(),
        temp,
    )
}

/* ---------- Températures (lecture /sys/class/hwmon) ---------- */

/// Racine des puces de surveillance matérielle exposées par le noyau Linux.
/// Absente ailleurs : toutes les sondes ci-dessous rendent alors None.
const HWMON_ROOT: &str = "/sys/class/hwmon";

/// Puces candidates pour la température processeur, PAR ORDRE DE PRÉFÉRENCE :
/// les capteurs intégrés au processeur d'abord (Intel, puis AMD), et
/// `acpitz` — zone thermique ACPI, souvent grossière et parfois éloignée du
/// die — seulement en dernier recours.
const CPU_HWMON_NAMES: &[&str] = &["coretemp", "k10temp", "zenpower", "acpitz"];

/// Étiquettes désignant la température du PAQUET (et non d'un cœur isolé) :
/// « Package id 0 » chez Intel, « Tctl » chez AMD.
const CPU_TEMP_LABELS: &[&str] = &["Package id 0", "Tctl"];

/// Puces exposant la température des barrettes de mémoire : capteur thermique
/// des SPD DDR5 (`spd5118`) ou son ancêtre JEDEC sur DDR4 (`jc42`).
const RAM_HWMON_NAMES: &[&str] = &["spd5118", "jc42"];

/// Bornes de plausibilité en °C. Hors de ]0, 150[, la lecture est rejetée :
/// un 0 pile trahit un capteur muet, et au-delà de 150 l'unité n'est pas
/// celle qu'on croit — mieux vaut ne rien afficher qu'un chiffre faux.
fn temperature_plausible(celsius: f64) -> Option<f64> {
    (celsius > 0.0 && celsius < 150.0).then_some(celsius)
}

/// Inventaire des puces hwmon : (contenu de `name`, répertoire). Liste vide
/// si /sys est absent ou illisible — aucune erreur remontée.
fn hwmon_chips() -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(HWMON_ROOT) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let dir = entry.path();
            let name = fs::read_to_string(dir.join("name")).ok()?;
            Some((name.trim().to_string(), dir))
        })
        .collect()
}

/// Lit un fichier `tempN_input` : le noyau y écrit des MILLIDEGRÉS, d'où la
/// division par 1000. None si le fichier manque, n'est pas un nombre, ou
/// donne une valeur invraisemblable.
fn read_temp_input(path: &Path) -> Option<f64> {
    let raw = fs::read_to_string(path).ok()?;
    let millidegrees: f64 = raw.trim().parse().ok()?;
    temperature_plausible(millidegrees / 1000.0)
}

/// Dans `dir`, cherche la première entrée `tempN_label` dont l'étiquette
/// satisfait `accepte`, et rend le `tempN_input` correspondant. Les puces
/// exposent souvent des dizaines d'entrées (un cœur chacune) : l'étiquette
/// est le seul moyen fiable de désigner celle qu'on veut.
fn temp_par_etiquette(dir: &Path, accepte: impl Fn(&str) -> bool) -> Option<f64> {
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.filter_map(|entry| entry.ok()) {
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        let Some(index) = file_name
            .strip_prefix("temp")
            .and_then(|reste| reste.strip_suffix("_label"))
        else {
            continue;
        };
        let Ok(label) = fs::read_to_string(entry.path()) else {
            continue;
        };
        if !accepte(label.trim()) {
            continue;
        }
        if let Some(celsius) = read_temp_input(&dir.join(format!("temp{index}_input"))) {
            return Some(celsius);
        }
    }
    None
}

/// Température du processeur en °C, ou None si la machine n'expose rien
/// d'exploitable. Parcourt les puces dans l'ordre de `CPU_HWMON_NAMES` et,
/// dans la puce retenue, préfère l'entrée étiquetée « paquet » ; à défaut,
/// `temp1_input` (les puces sans étiquette n'en exposent qu'une).
fn cpu_temp() -> Option<f64> {
    let chips = hwmon_chips();
    for souhaitee in CPU_HWMON_NAMES {
        for (_, dir) in chips.iter().filter(|(name, _)| name == souhaitee) {
            if let Some(celsius) = temp_par_etiquette(dir, |l| CPU_TEMP_LABELS.contains(&l)) {
                return Some(celsius);
            }
            if let Some(celsius) = read_temp_input(&dir.join("temp1_input")) {
                return Some(celsius);
            }
        }
    }
    None
}

/// Température de la mémoire vive en °C, ou None.
///
/// ATTENTION, cas nominal : la plupart des machines — dont le poste de
/// développement de référence — n'ont AUCUN capteur de barrette. Ni
/// `spd5118`, ni `jc42`, ni étiquette « DIMM » : la fonction rend alors None
/// et l'indicateur correspondant n'est simplement pas affiché. Ce n'est pas
/// une panne à corriger, c'est l'absence de matériel de mesure.
fn ram_temp() -> Option<f64> {
    let chips = hwmon_chips();
    for (name, dir) in &chips {
        if RAM_HWMON_NAMES.contains(&name.as_str()) {
            if let Some(celsius) = read_temp_input(&dir.join("temp1_input")) {
                return Some(celsius);
            }
        }
    }
    // Repli : une puce quelconque (carte mère) peut étiqueter « DIMM ».
    for (_, dir) in &chips {
        if let Some(celsius) =
            temp_par_etiquette(dir, |l| l.to_ascii_uppercase().contains("DIMM"))
        {
            return Some(celsius);
        }
    }
    None
}

/// Commande Tauri : instantané CPU/RAM/GPU. Jamais d'erreur pour une sonde
/// partielle (champ à None/0) — l'encart affiche ce qu'il peut.
#[tauri::command]
pub fn system_stats() -> SystemStats {
    let (mem_used_mb, mem_total_mb) = mem_mb();
    let (gpu_pct, gpu_mem_used_mb, gpu_mem_total_mb, gpu_temp_c) = gpu_stats();
    SystemStats {
        cpu_pct: cpu_pct(),
        mem_used_mb,
        mem_total_mb,
        gpu_pct,
        gpu_mem_used_mb,
        gpu_mem_total_mb,
        gpu_temp_c,
        cpu_temp_c: cpu_temp(),
        ram_temp_c: ram_temp(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_deux_lectures_donnent_un_pourcentage_borne() {
        // Premier appel : amorce (None attendu, sauf si un autre test est passé avant —
        // l'état est partagé, on ne l'assert donc pas). Deuxième : delta calculable.
        let _ = cpu_pct();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let second = cpu_pct();
        if let Some(pct) = second {
            assert!((0.0..=100.0).contains(&pct), "pct hors bornes : {pct}");
        }
    }

    /// La sonde mémoire lit `/proc/meminfo` : elle n'a de sens QUE sous Linux.
    /// Ailleurs, `mem_mb()` rend `(0, 0)` — dégradation volontaire, vérifiée par
    /// `stats_ne_paniquent_jamais` qui, lui, tourne partout. Sans cette garde,
    /// le test échouait sur le runner Windows en affirmant « MemTotal
    /// illisible » : il ne testait plus le code, seulement l'absence de `/proc`.
    #[cfg(target_os = "linux")]
    #[test]
    fn mem_totale_plausible() {
        let (used, total) = mem_mb();
        assert!(total > 0, "MemTotal illisible");
        assert!(used <= total, "used {used} > total {total}");
    }

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
        let (pct, mem_used, mem_total, _) = gpu_stats();
        let (pct2, mem_used2, mem_total2, _) = gpu_stats();
        assert_eq!(pct.is_some(), pct2.is_some());
        assert_eq!(mem_used.is_some(), mem_used2.is_some());
        assert_eq!(mem_total.is_some(), mem_total2.is_some());
    }

    #[test]
    fn stats_ne_paniquent_jamais() {
        let stats = system_stats();
        assert!(stats.mem_total_mb >= stats.mem_used_mb);
        // Les températures sont facultatives (aucun capteur = None) : on
        // n'exige que leur plausibilité quand elles sont là.
        for (quoi, mesure) in [("CPU", stats.cpu_temp_c), ("RAM", stats.ram_temp_c)] {
            if let Some(celsius) = mesure {
                assert!(
                    celsius > 0.0 && celsius < 150.0,
                    "température {quoi} invraisemblable : {celsius}"
                );
            }
        }
    }

    /// Les températures se lisent dans `/sys/class/hwmon` : hors Linux, ce
    /// répertoire n'existe pas et `cpu_temp()` rend None par construction —
    /// même garde que `mem_totale_plausible`, pour ne pas tester l'OS.
    ///
    /// Même sous Linux on n'exige PAS `Some` : une machine virtuelle ou un
    /// runner de CI peut n'exposer aucune puce reconnue. Le test vérifie donc
    /// l'absence de panique et, si une mesure existe, sa plausibilité.
    #[cfg(target_os = "linux")]
    #[test]
    fn cpu_temp_absente_ou_plausible() {
        if let Some(celsius) = cpu_temp() {
            assert!(
                celsius > 0.0 && celsius < 150.0,
                "température processeur invraisemblable : {celsius}"
            );
        }
    }

    /// Résolution du répertoire de travail du terminal.
    ///
    /// Écrit sur des chemins et une variable d'environnement propres à Unix
    /// (`/tmp`, `$HOME`) : sous Windows, `/tmp` n'existe pas et `HOME` n'est
    /// pas la variable du profil — le test rendait `C:\Users\runneradmin` là
    /// où il attendait `/tmp`. Plutôt que de le rendre acrobatique, on le
    /// réserve à la plateforme dont il décrit le comportement. Le jour où le
    /// terminal sera vraiment porté, ce test aura son jumeau Windows.
    #[cfg(unix)]
    #[test]
    fn terminal_resolution_du_repertoire() {
        // Pas de spawn réel dans les tests (ouvrirait une fenêtre) : on ne
        // teste que la résolution pure du répertoire de travail.
        assert_eq!(
            resolve_terminal_dir(Some("/tmp".to_string())).unwrap(),
            "/tmp"
        );
        let home = std::env::var("HOME").ok();
        assert_eq!(
            resolve_terminal_dir(Some("/chemin/qui/nexiste/pas".to_string())).ok(),
            home
        );
        assert_eq!(resolve_terminal_dir(None).ok(), std::env::var("HOME").ok());
    }
}
