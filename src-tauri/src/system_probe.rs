//! Commandes Tauri « poste de travail » : lancement d'un terminal dans un
//! répertoire, et sonde minimale CPU/RAM/GPU pour l'encart de l'en-tête.
//!
//! Voir `docs/protocol.md`, section « Commandes Tauri poste de travail ».
//! Même philosophie que le reste du Rust : mince, zéro dépendance ajoutée
//! (lecture /proc pour CPU/RAM, `nvidia-smi` optionnel pour le GPU).

use std::fs;
use std::process::Command;
use std::sync::Mutex;

use serde::Serialize;

use crate::open_external::prepare_detached;

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

fn gpu_stats() -> (Option<f64>, Option<u64>, Option<u64>) {
    let mut cmd = Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=utilization.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
    ]);
    // Pas de prepare_detached : on VEUT la sortie (process court, non interactif).
    let Ok(output) = cmd.output() else {
        return (None, None, None);
    };
    if !output.status.success() {
        return (None, None, None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // Première ligne = premier GPU (multi-GPU : hors périmètre v1).
    let Some(line) = text.lines().next() else {
        return (None, None, None);
    };
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    if parts.len() < 3 {
        return (None, None, None);
    }
    (
        parts[0].parse().ok(),
        parts[1].parse().ok(),
        parts[2].parse().ok(),
    )
}

/// Commande Tauri : instantané CPU/RAM/GPU. Jamais d'erreur pour une sonde
/// partielle (champ à None/0) — l'encart affiche ce qu'il peut.
#[tauri::command]
pub fn system_stats() -> SystemStats {
    let (mem_used_mb, mem_total_mb) = mem_mb();
    let (gpu_pct, gpu_mem_used_mb, gpu_mem_total_mb) = gpu_stats();
    SystemStats {
        cpu_pct: cpu_pct(),
        mem_used_mb,
        mem_total_mb,
        gpu_pct,
        gpu_mem_used_mb,
        gpu_mem_total_mb,
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

    #[test]
    fn stats_ne_paniquent_jamais() {
        let stats = system_stats();
        assert!(stats.mem_total_mb >= stats.mem_used_mb);
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
