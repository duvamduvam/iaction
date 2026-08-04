//! Commandes Tauri pour l'état applicatif UI (Lot 3), hors relais sidecar.
//!
//! Voir `docs/protocol.md`, section « Commandes Tauri état applicatif (Lot 3) ». Persistance
//! d'état UI par clé (conversations par projet, etc.) dans `{app_data_dir}/state/<name>.json`
//! — séparé de la config (`config_store.rs`), qui reste éditable à la main. Le Rust ne
//! comprend pas le contenu : il se contente de lire/écrire du JSON de façon atomique, comme
//! `config_store.rs`.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Sous-répertoire (dans le répertoire de données de l'app) où vivent les fichiers d'état.
const STATE_DIR_NAME: &str = "state";
/// Longueur max du nom d'état (avant l'extension `.json`).
const MAX_NAME_LEN: usize = 64;

/// Valide `name` selon l'équivalent de la regex `[a-z0-9-]{1,64}` (écrit à la main : pas de
/// crate regex dans ce périmètre). Anti-traversée : seuls les caractères listés sont
/// autorisés, donc ni `/`, ni `..`, ni majuscule.
fn validate_state_name(name: &str) -> Result<(), String> {
    let len = name.chars().count();
    let valid = len >= 1
        && len <= MAX_NAME_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');

    if valid {
        Ok(())
    } else {
        Err(format!(
            "nom d'état invalide : {name:?} (attendu : [a-z0-9-]{{1,{MAX_NAME_LEN}}})"
        ))
    }
}

fn state_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(STATE_DIR_NAME)
}

fn state_file_path(app_data_dir: &Path, name: &str) -> PathBuf {
    state_dir(app_data_dir).join(format!("{name}.json"))
}

/// Suffixe (quasi-)unique pour les noms de fichiers temporaires, afin d'éviter toute
/// collision entre écritures concurrentes au sein du même process.
fn nanos_suffix() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default()
}

/// Lit `{app_data_dir}/state/{name}.json`. Fichier absent → `{}` (pas une erreur, cf.
/// protocole).
fn read_state_from(app_data_dir: &Path, name: &str) -> Result<Value, String> {
    validate_state_name(name)?;

    let path = state_file_path(app_data_dir, name);
    match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|err| format!("état {name:?} invalide ({}) : {err}", path.display())),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(err) => Err(format!(
            "échec de la lecture de {} : {err}",
            path.display()
        )),
    }
}

/// Écrit `value` dans `{app_data_dir}/state/{name}.json`, de façon atomique : sérialisation
/// en JSON lisible (pretty) dans un fichier temporaire du même répertoire, puis `rename`
/// par-dessus le fichier final. Crée le répertoire `state/` s'il n'existe pas encore.
fn write_state_to(app_data_dir: &Path, name: &str, value: &Value) -> Result<(), String> {
    validate_state_name(name)?;

    let dir = state_dir(app_data_dir);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("échec de la création de {} : {err}", dir.display()))?;

    let pretty = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("échec de la sérialisation de l'état {name:?} : {err}"))?;

    let final_path = state_file_path(app_data_dir, name);
    let tmp_path = dir.join(format!(
        "{name}.json.tmp-{}-{}",
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

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|err| format!("impossible de déterminer le répertoire de données : {err}"))
}

/// Commande Tauri : lit `{app_data_dir}/state/{name}.json` (`{}` si absent). `name` doit
/// respecter `[a-z0-9-]{1,64}`.
#[tauri::command]
pub fn state_read(app: AppHandle, name: String) -> Result<Value, String> {
    read_state_from(&app_data_dir(&app)?, &name)
}

/// Commande Tauri : écrit `value` dans `{app_data_dir}/state/{name}.json` (atomique,
/// création récursive du répertoire au besoin). `name` doit respecter `[a-z0-9-]{1,64}`.
#[tauri::command]
pub fn state_write(app: AppHandle, name: String, value: Value) -> Result<(), String> {
    write_state_to(&app_data_dir(&app)?, &name, &value)
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
                "iaction-state-store-test-{label}-{}-{}",
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
    fn validation_accepte_noms_conformes() {
        assert!(validate_state_name("conversations-abc12").is_ok());
        assert!(validate_state_name("a").is_ok());
        assert!(validate_state_name("0-9-a-z").is_ok());
        assert!(validate_state_name(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn validation_rejette_traversee_de_chemin() {
        let err = validate_state_name("../x").unwrap_err();
        assert!(err.contains("nom d'état invalide"), "message inattendu : {err}");
    }

    #[test]
    fn validation_rejette_majuscules() {
        assert!(validate_state_name("A").is_err());
        assert!(validate_state_name("Conversations").is_err());
    }

    #[test]
    fn validation_rejette_chaine_vide() {
        assert!(validate_state_name("").is_err());
    }

    #[test]
    fn validation_rejette_plus_de_64_caracteres() {
        let trop_long = "a".repeat(65);
        assert!(validate_state_name(&trop_long).is_err());
    }

    #[test]
    fn lecture_absente_renvoie_objet_vide() {
        let dir = TempDir::new("absent");
        let value = read_state_from(dir.path(), "conversations").expect("lecture");
        assert_eq!(value, json!({}));
    }

    #[test]
    fn ecriture_puis_lecture_round_trip() {
        let dir = TempDir::new("roundtrip");
        let payload = json!({"projects": [{"id": "p1", "title": "Projet 1"}]});

        write_state_to(dir.path(), "conversations-abc12", &payload).expect("écriture");
        let read_back = read_state_from(dir.path(), "conversations-abc12").expect("lecture");

        assert_eq!(read_back, payload);
    }

    #[test]
    fn ecriture_cree_le_repertoire_state_au_besoin() {
        let dir = TempDir::new("mkdir");
        let state_path = state_dir(dir.path());
        assert!(!state_path.exists());

        write_state_to(dir.path(), "notes", &json!({"a": 1})).expect("écriture");

        assert!(state_path.is_dir());
        assert_eq!(
            read_state_from(dir.path(), "notes").expect("lecture"),
            json!({"a": 1})
        );
    }

    #[test]
    fn ecriture_ne_laisse_pas_de_fichier_temporaire() {
        let dir = TempDir::new("no-leftover-tmp");
        write_state_to(dir.path(), "notes", &json!({"x": true})).expect("écriture");

        let leftovers: Vec<_> = fs::read_dir(state_dir(dir.path()))
            .expect("lecture du répertoire")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();

        assert!(leftovers.is_empty(), "fichier(s) temporaire(s) oublié(s) : {leftovers:?}");
    }

    #[test]
    fn lecture_nom_invalide_erreur() {
        let dir = TempDir::new("invalid-read");
        let err = read_state_from(dir.path(), "../etc-passwd").unwrap_err();
        assert!(err.contains("nom d'état invalide"), "message inattendu : {err}");
    }

    #[test]
    fn ecriture_nom_invalide_erreur() {
        let dir = TempDir::new("invalid-write");
        let err = write_state_to(dir.path(), "Invalide!", &json!({})).unwrap_err();
        assert!(err.contains("nom d'état invalide"), "message inattendu : {err}");
    }
}
