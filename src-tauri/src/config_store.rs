//! Commandes Tauri pour le store de config non-secrète, hors relais sidecar.
//!
//! Voir `docs/protocol.md`, section « Commandes Tauri hors relais (Lot 1) ». Le fichier
//! `config.json` (dans le répertoire de config de l'app) contient tout ce qui n'est pas
//! secret (liste des fournisseurs, etc.) — jamais de clé API dedans, celles-ci vivent
//! dans le trousseau OS (voir `secrets.rs`). Le Rust ne comprend pas le contenu : il se
//! contente de lire/écrire du JSON de façon atomique.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Nom du fichier de config dans le répertoire de config de l'app.
const CONFIG_FILE_NAME: &str = "config.json";

fn config_file_path(dir: &Path) -> PathBuf {
    dir.join(CONFIG_FILE_NAME)
}

/// Lit `config.json` dans `dir`. Fichier absent → `{}` (pas une erreur, cf. protocole).
fn read_config_from(dir: &Path) -> Result<Value, String> {
    let path = config_file_path(dir);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|err| format!("config.json invalide ({} ) : {err}", path.display())),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(err) => Err(format!(
            "échec de la lecture de {} : {err}",
            path.display()
        )),
    }
}

/// Écrit `value` dans `config.json` sous `dir`, de façon atomique : sérialisation en
/// JSON lisible (pretty) dans un fichier temporaire du même répertoire, puis `rename`
/// par-dessus le fichier final. Crée `dir` s'il n'existe pas encore.
fn write_config_to(dir: &Path, value: &Value) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|err| format!("échec de la création de {} : {err}", dir.display()))?;

    let pretty = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("échec de la sérialisation de la config : {err}"))?;

    let final_path = config_file_path(dir);
    let tmp_path = dir.join(format!(
        "{CONFIG_FILE_NAME}.tmp-{}-{}",
        std::process::id(),
        nanos_suffix()
    ));

    fs::write(&tmp_path, &pretty).map_err(|err| {
        format!(
            "échec de l'écriture du fichier temporaire {} : {err}",
            tmp_path.display()
        )
    })?;

    fs::rename(&tmp_path, &final_path).map_err(|err| {
        // Best effort : on ne laisse pas traîner le fichier temporaire en cas d'échec du rename.
        let _ = fs::remove_file(&tmp_path);
        format!(
            "échec du remplacement atomique de {} : {err}",
            final_path.display()
        )
    })
}

/// Suffixe (quasi-)unique pour le nom du fichier temporaire, afin d'éviter toute
/// collision entre écritures concurrentes au sein du même process.
fn nanos_suffix() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

fn app_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|err| format!("impossible de déterminer le répertoire de configuration : {err}"))
}

/// Commande Tauri : lit `{app_config_dir}/config.json` (`{}` si absent).
#[tauri::command]
pub fn config_read(app: AppHandle) -> Result<Value, String> {
    read_config_from(&app_config_dir(&app)?)
}

/// Commande Tauri : écrit `value` dans `{app_config_dir}/config.json` (atomique).
#[tauri::command]
pub fn config_write(app: AppHandle, value: Value) -> Result<(), String> {
    write_config_to(&app_config_dir(&app)?, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Crée un répertoire temporaire dédié au test sous le répertoire temp du système,
    /// nettoyé à la fin via le `Drop` de `TempDir`.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "iaction-config-store-test-{label}-{}-{}",
                std::process::id(),
                nanos_suffix()
            ));
            fs::create_dir_all(&dir).expect("création du répertoire temporaire de test");
            TempDir(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lecture_fichier_absent_renvoie_objet_vide() {
        let dir = TempDir::new("absent");
        let value = read_config_from(dir.path()).expect("lecture");
        assert_eq!(value, json!({}));
    }

    #[test]
    fn ecriture_puis_lecture_round_trip() {
        let dir = TempDir::new("roundtrip");
        let payload = json!({"providers": [{"id": "ollama", "label": "Ollama local"}]});

        write_config_to(dir.path(), &payload).expect("écriture");
        let read_back = read_config_from(dir.path()).expect("lecture");

        assert_eq!(read_back, payload);
    }

    #[test]
    fn ecriture_cree_le_repertoire_si_absent() {
        let parent = TempDir::new("mkdir-parent");
        let nested = parent.path().join("nested").join("config-dir");
        assert!(!nested.exists());

        write_config_to(&nested, &json!({"a": 1})).expect("écriture");

        assert!(nested.is_dir());
        assert_eq!(read_config_from(&nested).expect("lecture"), json!({"a": 1}));
    }

    #[test]
    fn ecriture_ne_laisse_pas_de_fichier_temporaire() {
        let dir = TempDir::new("no-leftover-tmp");
        write_config_to(dir.path(), &json!({"x": true})).expect("écriture");

        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("lecture du répertoire")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .contains(&format!("{CONFIG_FILE_NAME}.tmp-"))
            })
            .collect();

        assert!(leftovers.is_empty(), "fichier(s) temporaire(s) oublié(s) : {leftovers:?}");
    }

    #[test]
    fn reecriture_remplace_le_contenu_precedent() {
        let dir = TempDir::new("overwrite");
        write_config_to(dir.path(), &json!({"v": 1})).expect("première écriture");
        write_config_to(dir.path(), &json!({"v": 2})).expect("seconde écriture");

        assert_eq!(read_config_from(dir.path()).expect("lecture"), json!({"v": 2}));
    }
}
