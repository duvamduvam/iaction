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

/// Noms d'état existants commençant par `prefix`, triés, sans l'extension (T-061).
///
/// C'est la primitive qui permet l'état ÉCLATÉ (un fichier par projet, par
/// conversation) : sans elle, l'interface devrait tenir un index — c'est-à-dire
/// recréer un fichier partagé, exactement ce que l'éclatement supprime.
fn list_state_from(app_data_dir: &Path, prefix: &str) -> Result<Vec<String>, String> {
    validate_state_name(prefix)?;
    let dir = state_dir(app_data_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        // Répertoire absent : aucun état n'a jamais été écrit — liste vide.
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("échec de la lecture de {} : {err}", dir.display())),
    };
    let mut noms: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter_map(|f| f.strip_suffix(".json").map(str::to_string))
        // Un fichier au nom invalide (déposé à la main, temporaire) n'est pas
        // un état : on l'ignore au lieu de le laisser casser un appelant.
        .filter(|n| n.starts_with(prefix) && validate_state_name(n).is_ok())
        .collect();
    noms.sort();
    Ok(noms)
}

/// Renomme un état (T-061 : mise de côté du monolithe migré, retrait non
/// destructif d'un projet). REFUSE d'écraser une cible existante : renommer
/// n'est jamais un moyen détourné de détruire un historique.
fn rename_state_in(app_data_dir: &Path, name: &str, new_name: &str) -> Result<(), String> {
    validate_state_name(name)?;
    validate_state_name(new_name)?;
    let from = state_file_path(app_data_dir, name);
    let to = state_file_path(app_data_dir, new_name);
    if to.exists() {
        return Err(format!("cible déjà existante : {}", to.display()));
    }
    fs::rename(&from, &to)
        .map_err(|err| format!("échec du renommage de {} : {err}", from.display()))
}

/// Commande Tauri : lit `{app_data_dir}/state/{name}.json` (`{}` si absent). `name` doit
/// respecter `[a-z0-9-]{1,64}`.
#[tauri::command]
pub fn state_read(app: AppHandle, name: String) -> Result<Value, String> {
    read_state_from(&app_data_dir(&app)?, &name)
}

/// Commande Tauri : noms d'état commençant par `prefix`, triés (T-061).
#[tauri::command]
pub fn state_list(app: AppHandle, prefix: String) -> Result<Vec<String>, String> {
    list_state_from(&app_data_dir(&app)?, &prefix)
}

/// Commande Tauri : renomme un état, sans jamais écraser la cible (T-061).
#[tauri::command]
pub fn state_rename(app: AppHandle, name: String, new_name: String) -> Result<(), String> {
    rename_state_in(&app_data_dir(&app)?, &name, &new_name)
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

    // ── T-061 : listage et renommage, les primitives de l'état éclaté ──────

    #[test]
    fn lister_un_repertoire_absent_rend_une_liste_vide() {
        let tmp = TempDir::new("list-absent");
        assert_eq!(list_state_from(tmp.path(), "projet-").expect("liste"), Vec::<String>::new());
    }

    #[test]
    fn lister_filtre_par_prefixe_trie_et_ignore_les_intrus() {
        let tmp = TempDir::new("list");
        write_state_to(tmp.path(), "projet-beta", &json!({"b": 1})).expect("écriture");
        write_state_to(tmp.path(), "projet-alpha", &json!({"a": 1})).expect("écriture");
        write_state_to(tmp.path(), "chat-index", &json!({})).expect("écriture");
        // Un fichier au nom hors charte (déposé à la main) ne doit pas apparaître.
        fs::write(tmp.path().join("state").join("Projet-MAJ.json"), b"{}").expect("intrus");
        // Un fichier non-JSON non plus.
        fs::write(tmp.path().join("state").join("projet-note.txt"), b"x").expect("intrus");

        let noms = list_state_from(tmp.path(), "projet-").expect("liste");
        assert_eq!(noms, vec!["projet-alpha".to_string(), "projet-beta".to_string()]);
    }

    #[test]
    fn renommer_deplace_sans_jamais_ecraser() {
        let tmp = TempDir::new("rename");
        write_state_to(tmp.path(), "project-conversations", &json!({"p": 1})).expect("écriture");

        rename_state_in(tmp.path(), "project-conversations", "project-conversations-avant-eclatement")
            .expect("renommage");
        assert_eq!(
            read_state_from(tmp.path(), "project-conversations-avant-eclatement").expect("lecture")["p"],
            json!(1)
        );
        // L'original n'existe plus : une relecture rend le défaut `{}`.
        assert_eq!(read_state_from(tmp.path(), "project-conversations").expect("lecture"), json!({}));

        // Refus d'écraser : renommer n'est pas un moyen détourné de détruire.
        write_state_to(tmp.path(), "project-conversations", &json!({"neuf": true})).expect("écriture");
        let err = rename_state_in(tmp.path(), "project-conversations", "project-conversations-avant-eclatement")
            .expect_err("doit refuser");
        assert!(err.contains("existante"), "message inattendu : {err}");
    }

    #[test]
    fn renommer_une_source_absente_echoue_lisiblement() {
        let tmp = TempDir::new("rename-absent");
        let err = rename_state_in(tmp.path(), "absent", "ailleurs").expect_err("doit échouer");
        assert!(err.contains("renommage"), "message inattendu : {err}");
    }
}
