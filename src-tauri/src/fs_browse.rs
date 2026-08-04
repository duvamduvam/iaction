//! Commandes Tauri pour parcourir/lire/écrire des fichiers, hors relais sidecar.
//!
//! Voir `docs/protocol.md`, section « Commandes Tauri fichiers (mini-tranche du Lot 4) ».
//! Utilisé par l'arborescence + éditeur de la page Agent. Le Rust reste mince : aucune
//! dépendance runtime supplémentaire (l'encodeur base64 ci-dessous est local — la crate
//! `base64` n'est présente que de façon transitive dans l'arbre de deps, cf. `cargo tree`,
//! et n'est donc pas utilisable sans être déclarée dans `Cargo.toml`).

use std::collections::VecDeque;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Taille max par défaut lue pour un fichier texte/binaire (2 Mo).
const DEFAULT_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Taille max autorisée pour une image encodée en base64 (10 Mo).
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"];

/// Dossiers ignorés par `fs_find_by_name` (voir docs/protocol.md, section
/// « Commandes Tauri fichiers »).
const FIND_IGNORED_DIRS: &[&str] =
    &["node_modules", "target", "dist", ".git", ".venv", "venv", "__pycache__"];
/// Profondeur maximale explorée par `fs_find_by_name` (racine = profondeur 0).
const FIND_MAX_DEPTH: u32 = 8;
/// `maxResults` par défaut de `fs_find_by_name`.
const FIND_DEFAULT_MAX_RESULTS: u32 = 8;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub kind: String,
    pub text: Option<String>,
    pub base64: Option<String>,
    pub size: u64,
    pub truncated: bool,
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

fn describe_dir_error(path: &Path, err: std::io::Error) -> String {
    match err.kind() {
        ErrorKind::NotFound => format!("dossier introuvable : {}", path.display()),
        ErrorKind::PermissionDenied => format!("permission refusée : {}", path.display()),
        _ => format!("échec de la lecture de {} : {err}", path.display()),
    }
}

fn describe_file_error(path: &Path, err: std::io::Error) -> String {
    match err.kind() {
        ErrorKind::NotFound => format!("fichier introuvable : {}", path.display()),
        ErrorKind::PermissionDenied => format!("permission refusée : {}", path.display()),
        _ => format!("échec de la lecture de {} : {err}", path.display()),
    }
}

fn describe_mkdir_error(path: &Path, err: std::io::Error) -> String {
    match err.kind() {
        ErrorKind::PermissionDenied => format!("permission refusée : {}", path.display()),
        _ => format!("échec de la création de {} : {err}", path.display()),
    }
}

fn is_image_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Encodeur base64 minimal (alphabet standard RFC 4648, avec padding `=`). Volontairement
/// local plutôt que via une crate : voir la note en tête de fichier.
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);

        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(b2 & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Commande Tauri : liste le contenu de `path`. Dossiers d'abord, puis tri alphabétique
/// insensible à la casse dans chaque groupe.
#[tauri::command]
pub fn fs_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir_path = Path::new(&path);
    let read_dir = fs::read_dir(dir_path).map_err(|err| describe_dir_error(dir_path, err))?;

    let mut entries = Vec::new();
    for item in read_dir {
        let item = item.map_err(|err| describe_dir_error(dir_path, err))?;
        let entry_path = item.path();
        let name = item.file_name().to_string_lossy().into_owned();

        // `fs::metadata` suit les liens symboliques (comportement standard, cf. protocole :
        // l'UI filtre si besoin). Si la cible est inaccessible (lien mort…), on retombe sur
        // le type de l'entrée du répertoire (qui ne suit pas les liens) plutôt que d'échouer
        // toute la liste pour une seule entrée problématique.
        let (is_dir, size) = match fs::metadata(&entry_path) {
            Ok(meta) => (meta.is_dir(), if meta.is_dir() { 0 } else { meta.len() }),
            Err(_) => match item.file_type() {
                Ok(file_type) => (file_type.is_dir(), 0),
                Err(_) => (false, 0),
            },
        };

        entries.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            size,
        });
    }

    entries.sort_by(|a, b| {
        (!a.is_dir, a.name.to_lowercase()).cmp(&(!b.is_dir, b.name.to_lowercase()))
    });

    Ok(entries)
}

/// Commande Tauri : lit `path`. Extension image connue → base64 (cap 10 Mo). Sinon,
/// tentative UTF-8 sur au plus `max_bytes` octets (défaut 2 Mo) : préfixe entièrement
/// valide → texte (tronqué proprement au dernier caractère complet si on a coupé avant
/// la fin réelle du fichier) ; sinon → binaire, sans contenu.
#[tauri::command]
pub fn fs_read_file(path: String, max_bytes: Option<u64>) -> Result<FileContent, String> {
    let file_path = Path::new(&path);
    let metadata = fs::metadata(file_path).map_err(|err| describe_file_error(file_path, err))?;
    if metadata.is_dir() {
        return Err(format!(
            "{} est un dossier, pas un fichier",
            file_path.display()
        ));
    }
    let size = metadata.len();

    if is_image_extension(file_path) {
        if size > MAX_IMAGE_BYTES {
            return Err(format!(
                "image trop volumineuse ({size} octets, max {MAX_IMAGE_BYTES} octets) : {}",
                file_path.display()
            ));
        }
        let bytes = fs::read(file_path).map_err(|err| describe_file_error(file_path, err))?;
        return Ok(FileContent {
            kind: "image".to_string(),
            text: None,
            base64: Some(base64_encode(&bytes)),
            size,
            truncated: false,
        });
    }

    let cap = max_bytes.unwrap_or(DEFAULT_MAX_BYTES);
    let read_len = cap.min(size);

    let file = fs::File::open(file_path).map_err(|err| describe_file_error(file_path, err))?;
    let mut buffer = Vec::with_capacity(read_len as usize);
    file.take(read_len)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("échec de la lecture de {} : {err}", file_path.display()))?;

    // Vrai si on s'est arrêté avant la fin réelle du fichier (à cause de `cap`), et non
    // parce que le fichier fait cette taille-là.
    let was_capped = (buffer.len() as u64) < size;

    match std::str::from_utf8(&buffer) {
        Ok(text) => Ok(FileContent {
            kind: "text".to_string(),
            text: Some(text.to_string()),
            base64: None,
            size,
            truncated: was_capped,
        }),
        // `error_len() == None` signifie que l'octet invalide n'existe pas encore : la
        // séquence multi-octets en fin de buffer est simplement coupée par notre `cap`,
        // pas invalide dans le fichier réel. On tronque proprement au dernier caractère
        // complet (pas de `String::from_utf8_lossy`, qui remplacerait par des '�').
        Err(err) if was_capped && err.error_len().is_none() => {
            let valid_up_to = err.valid_up_to();
            match std::str::from_utf8(&buffer[..valid_up_to]) {
                Ok(text) => Ok(FileContent {
                    kind: "text".to_string(),
                    text: Some(text.to_string()),
                    base64: None,
                    size,
                    truncated: true,
                }),
                Err(_) => Ok(FileContent {
                    kind: "binary".to_string(),
                    text: None,
                    base64: None,
                    size,
                    truncated: was_capped,
                }),
            }
        }
        Err(_) => Ok(FileContent {
            kind: "binary".to_string(),
            text: None,
            base64: None,
            size,
            truncated: was_capped,
        }),
    }
}

/// Commande Tauri : écrit `content` dans `path` de façon atomique (fichier temporaire dans
/// le même répertoire, puis `rename`). Refuse si le dossier parent n'existe pas.
#[tauri::command]
pub fn fs_write_file(path: String, content: String) -> Result<(), String> {
    let file_path = Path::new(&path);
    let parent = match file_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };

    if !parent.is_dir() {
        return Err(format!(
            "le dossier parent n'existe pas : {}",
            parent.display()
        ));
    }

    let file_name = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "fichier".to_string());
    let tmp_path = parent.join(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        nanos_suffix()
    ));

    fs::write(&tmp_path, content.as_bytes()).map_err(|err| {
        format!(
            "échec de l'écriture du fichier temporaire {} : {err}",
            tmp_path.display()
        )
    })?;

    fs::rename(&tmp_path, file_path).map_err(|err| {
        // Best effort : on ne laisse pas traîner le fichier temporaire en cas d'échec du rename.
        let _ = fs::remove_file(&tmp_path);
        format!(
            "échec du remplacement atomique de {} : {err}",
            file_path.display()
        )
    })
}

/// Commande Tauri : crée `path` (et ses parents manquants) de façon récursive. Idempotent :
/// si le dossier existe déjà, renvoie `Ok(())` (comportement de `create_dir_all`).
#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("chemin vide".to_string());
    }

    let dir_path = Path::new(&path);
    fs::create_dir_all(dir_path).map_err(|err| describe_mkdir_error(dir_path, err))
}

/// Commande Tauri : renomme `path` en `new_name` DANS son répertoire parent (pas un
/// déplacement arbitraire : `new_name` doit être un nom simple, sans séparateur). Refuse
/// d'écraser une cible existante. Renvoie le nouveau chemin absolu.
#[tauri::command]
pub fn fs_rename(path: String, new_name: String) -> Result<String, String> {
    let source = Path::new(&path);
    if !source.exists() {
        return Err(format!("introuvable : {}", source.display()));
    }

    let name = new_name.trim();
    if name.is_empty() {
        return Err("nouveau nom vide".to_string());
    }
    if name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(format!("nom invalide : {name}"));
    }

    let parent = source
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("impossible de renommer la racine : {}", source.display()))?;
    let target = parent.join(name);

    if target == source {
        return Ok(target.to_string_lossy().into_owned());
    }
    if target.exists() {
        return Err(format!("existe déjà : {}", target.display()));
    }

    fs::rename(source, &target)
        .map_err(|err| format!("échec du renommage de {} : {err}", source.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Commande Tauri : supprime `path` — fichier (`remove_file`) ou dossier ENTIER
/// (`remove_dir_all`). Suppression définitive (pas de corbeille) : la confirmation
/// appartient à l'UI. Garde-fou : refuse un chemin sans parent (racine du système).
#[tauri::command]
pub fn fs_delete(path: String) -> Result<(), String> {
    let target = Path::new(&path);
    if target.parent().filter(|p| !p.as_os_str().is_empty()).is_none() {
        return Err(format!(
            "suppression refusée (chemin racine) : {}",
            target.display()
        ));
    }

    let metadata = match fs::symlink_metadata(target) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Err(format!("introuvable : {}", target.display()))
        }
        Err(err) => return Err(format!("échec de la lecture de {} : {err}", target.display())),
    };

    // `symlink_metadata` ne suit pas les liens : un lien symbolique (même vers un
    // dossier) est supprimé comme un fichier, sans toucher sa cible.
    let result = if metadata.is_dir() {
        fs::remove_dir_all(target)
    } else {
        fs::remove_file(target)
    };
    result.map_err(|err| format!("échec de la suppression de {} : {err}", target.display()))
}

/// Commande Tauri : cherche, sous `root`, les FICHIERS nommés exactement `name` (comparaison
/// sensible à la casse). Parcours en largeur (BFS) afin de privilégier les correspondances les
/// plus proches de la racine, profondeur bornée à `FIND_MAX_DEPTH`, dossiers `FIND_IGNORED_DIRS`
/// jamais descendus. S'arrête dès que `max_results` (défaut `FIND_DEFAULT_MAX_RESULTS`) chemins
/// ont été trouvés. Un dossier illisible en cours de route (permissions…) est simplement ignoré
/// (best effort), pas une erreur globale — seule une racine inexistante l'est.
///
/// Usage (voir docs/protocol.md) : résolution des références de fichiers cliquables dans les
/// transcriptions de la page Agent.
#[tauri::command]
pub fn fs_find_by_name(root: String, name: String, max_results: Option<u32>) -> Result<Vec<String>, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("dossier racine introuvable : {}", root_path.display()));
    }

    let limit = max_results.unwrap_or(FIND_DEFAULT_MAX_RESULTS).max(1) as usize;
    let mut results: Vec<String> = Vec::new();
    let mut queue: VecDeque<(PathBuf, u32)> = VecDeque::new();
    queue.push_back((root_path.to_path_buf(), 0));

    while let Some((dir, depth)) = queue.pop_front() {
        if results.len() >= limit {
            break;
        }
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };

        // Tri par nom pour un ordre déterministe (le parcours de `read_dir` n'est pas garanti).
        let mut entries: Vec<_> = read_dir.filter_map(|item| item.ok()).collect();
        entries.sort_by_key(|item| item.file_name());

        for entry in entries {
            if results.len() >= limit {
                break;
            }
            let entry_name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

            if is_dir {
                if depth < FIND_MAX_DEPTH && !FIND_IGNORED_DIRS.contains(&entry_name.as_str()) {
                    queue.push_back((entry.path(), depth + 1));
                }
            } else if entry_name == name {
                results.push(entry.path().to_string_lossy().into_owned());
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Crée un répertoire temporaire dédié au test sous le répertoire temp du système,
    /// nettoyé à la fin via le `Drop` de `TempDir`.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "iaction-fs-browse-test-{label}-{}-{}",
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
    fn base64_encode_vecteurs_rfc4648() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn list_dir_tri_dossiers_puis_alphabetique_insensible_casse() {
        let dir = TempDir::new("list-tri");
        fs::create_dir(dir.path().join("zeta_dir")).expect("mkdir zeta_dir");
        fs::create_dir(dir.path().join("Adir")).expect("mkdir Adir");
        fs::write(dir.path().join("banana.txt"), b"b").expect("write banana");
        fs::write(dir.path().join("Apple.txt"), b"a").expect("write Apple");

        let entries = fs_list_dir(dir.path().to_string_lossy().into_owned()).expect("list_dir");
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();

        assert_eq!(names, vec!["Adir", "zeta_dir", "Apple.txt", "banana.txt"]);
        assert!(entries[0].is_dir);
        assert!(entries[1].is_dir);
        assert!(!entries[2].is_dir);
        assert!(!entries[3].is_dir);
    }

    #[test]
    fn list_dir_dossier_inexistant_erreur_lisible() {
        let dir = TempDir::new("list-absent-parent");
        let missing = dir.path().join("n-existe-pas");
        let err = fs_list_dir(missing.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("introuvable"), "message inattendu : {err}");
    }

    #[test]
    fn read_file_texte_sans_troncature() {
        let dir = TempDir::new("read-text-full");
        let file = dir.path().join("hello.txt");
        fs::write(&file, "bonjour le monde").expect("write");

        let content = fs_read_file(file.to_string_lossy().into_owned(), None).expect("read");
        assert_eq!(content.kind, "text");
        assert_eq!(content.text.as_deref(), Some("bonjour le monde"));
        assert!(!content.truncated);
        assert_eq!(content.size, "bonjour le monde".len() as u64);
    }

    #[test]
    fn read_file_texte_troncature_propre_multi_octet() {
        let dir = TempDir::new("read-text-truncate");
        let file = dir.path().join("accents.txt");
        // "é" = 2 octets UTF-8 (0xC3 0xA9). 5 répétitions = 10 octets.
        let contenu = "é".repeat(5);
        fs::write(&file, &contenu).expect("write");

        // max_bytes=3 coupe après le premier "é" (2 octets) + le premier octet du second
        // "é" (0xC3 seul) : une séquence multi-octets incomplète en fin de buffer.
        let content =
            fs_read_file(file.to_string_lossy().into_owned(), Some(3)).expect("read tronqué");

        assert_eq!(content.kind, "text");
        assert_eq!(content.text.as_deref(), Some("é"));
        assert!(content.truncated);
        assert_eq!(content.size, contenu.len() as u64);
    }

    #[test]
    fn read_file_binaire_sans_contenu() {
        let dir = TempDir::new("read-binary");
        let file = dir.path().join("data.bin");
        fs::write(&file, [0xff, 0xfe, 0x00, 0xff, 0xfe, 0x00]).expect("write");

        let content = fs_read_file(file.to_string_lossy().into_owned(), None).expect("read");
        assert_eq!(content.kind, "binary");
        assert!(content.text.is_none());
        assert!(content.base64.is_none());
    }

    #[test]
    fn read_file_image_base64() {
        let dir = TempDir::new("read-image");
        let file = dir.path().join("logo.png");
        let bytes: Vec<u8> = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02];
        fs::write(&file, &bytes).expect("write");

        let content = fs_read_file(file.to_string_lossy().into_owned(), None).expect("read");
        assert_eq!(content.kind, "image");
        assert_eq!(content.base64.as_deref(), Some(base64_encode(&bytes).as_str()));
        assert!(content.text.is_none());
        assert!(!content.truncated);
        assert_eq!(content.size, bytes.len() as u64);
    }

    #[test]
    fn read_file_image_trop_volumineuse_erreur() {
        let dir = TempDir::new("read-image-too-big");
        let file = dir.path().join("big.png");
        // Fichier "creux" au-delà de la limite, sans écrire réellement 10 Mo+1 sur disque.
        let f = fs::File::create(&file).expect("create");
        f.set_len(MAX_IMAGE_BYTES + 1).expect("set_len");

        let err = fs_read_file(file.to_string_lossy().into_owned(), None).unwrap_err();
        assert!(err.contains("volumineuse"), "message inattendu : {err}");
    }

    #[test]
    fn read_file_inexistant_erreur_lisible() {
        let dir = TempDir::new("read-absent");
        let missing = dir.path().join("n-existe-pas.txt");
        let err = fs_read_file(missing.to_string_lossy().into_owned(), None).unwrap_err();
        assert!(err.contains("introuvable"), "message inattendu : {err}");
    }

    #[test]
    fn write_file_atomique_puis_relecture() {
        let dir = TempDir::new("write-roundtrip");
        let file = dir.path().join("out.txt");

        fs_write_file(file.to_string_lossy().into_owned(), "contenu initial".to_string())
            .expect("écriture");
        assert_eq!(fs::read_to_string(&file).expect("relecture"), "contenu initial");

        fs_write_file(file.to_string_lossy().into_owned(), "contenu remplacé".to_string())
            .expect("réécriture");
        assert_eq!(fs::read_to_string(&file).expect("relecture 2"), "contenu remplacé");

        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("lecture du répertoire")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "fichier(s) temporaire(s) oublié(s) : {leftovers:?}");
    }

    #[test]
    fn write_file_refuse_si_parent_absent() {
        let dir = TempDir::new("write-missing-parent");
        let file = dir.path().join("nested").join("out.txt");

        let err = fs_write_file(file.to_string_lossy().into_owned(), "x".to_string()).unwrap_err();
        assert!(err.contains("dossier parent"), "message inattendu : {err}");
        assert!(!file.exists());
    }

    #[test]
    fn mkdir_cree_recursivement() {
        let dir = TempDir::new("mkdir-recursive");
        let nested = dir.path().join("a").join("b").join("c");
        assert!(!nested.exists());

        fs_mkdir(nested.to_string_lossy().into_owned()).expect("mkdir");

        assert!(nested.is_dir());
    }

    #[test]
    fn mkdir_idempotent_si_existe_deja() {
        let dir = TempDir::new("mkdir-idempotent");
        let nested = dir.path().join("deja-la");
        fs::create_dir_all(&nested).expect("préparation");

        fs_mkdir(nested.to_string_lossy().into_owned()).expect("mkdir sur dossier existant");

        assert!(nested.is_dir());
    }

    #[test]
    fn mkdir_chemin_vide_erreur_lisible() {
        let err = fs_mkdir(String::new()).unwrap_err();
        assert!(err.contains("chemin vide"), "message inattendu : {err}");
    }

    #[test]
    fn rename_fichier_dans_le_meme_dossier() {
        let dir = TempDir::new("rename-simple");
        let file = dir.path().join("avant.txt");
        fs::write(&file, "contenu").expect("write");

        let new_path =
            fs_rename(file.to_string_lossy().into_owned(), "après.txt".to_string())
                .expect("rename");

        assert!(!file.exists());
        assert_eq!(new_path, dir.path().join("après.txt").to_string_lossy());
        assert_eq!(fs::read_to_string(dir.path().join("après.txt")).unwrap(), "contenu");
    }

    #[test]
    fn rename_refuse_ecrasement_et_noms_invalides() {
        let dir = TempDir::new("rename-invalide");
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        fs::write(&a, "a").expect("write a");
        fs::write(&b, "b").expect("write b");

        let err = fs_rename(a.to_string_lossy().into_owned(), "b.txt".to_string()).unwrap_err();
        assert!(err.contains("existe déjà"), "message inattendu : {err}");

        for nom in ["", "  ", "..", "x/y", "x\\y"] {
            let err =
                fs_rename(a.to_string_lossy().into_owned(), nom.to_string()).unwrap_err();
            assert!(
                err.contains("invalide") || err.contains("vide"),
                "nom {nom:?} : message inattendu : {err}"
            );
        }
        assert_eq!(fs::read_to_string(&b).unwrap(), "b", "cible écrasée à tort");
    }

    #[test]
    fn delete_fichier_et_dossier_recursif() {
        let dir = TempDir::new("delete");
        let file = dir.path().join("f.txt");
        fs::write(&file, "x").expect("write");
        let sub = dir.path().join("sous").join("profond");
        fs::create_dir_all(&sub).expect("mkdir");
        fs::write(sub.join("g.txt"), "y").expect("write g");

        fs_delete(file.to_string_lossy().into_owned()).expect("delete fichier");
        assert!(!file.exists());

        fs_delete(dir.path().join("sous").to_string_lossy().into_owned())
            .expect("delete dossier");
        assert!(!dir.path().join("sous").exists());
    }

    #[test]
    fn delete_inexistant_et_racine_erreurs_lisibles() {
        let dir = TempDir::new("delete-erreurs");
        let missing = dir.path().join("absent");
        let err = fs_delete(missing.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("introuvable"), "message inattendu : {err}");

        let err = fs_delete("/".to_string()).unwrap_err();
        assert!(err.contains("racine"), "message inattendu : {err}");
    }

    #[test]
    fn find_by_name_trouve_a_deux_niveaux() {
        let dir = TempDir::new("find-two-levels");
        let nested = dir.path().join("a").join("b");
        fs::create_dir_all(&nested).expect("mkdir a/b");
        let target = nested.join("cible.md");
        fs::write(&target, "contenu").expect("write cible");

        let results = fs_find_by_name(dir.path().to_string_lossy().into_owned(), "cible.md".to_string(), None)
            .expect("find_by_name");

        assert_eq!(results, vec![target.to_string_lossy().into_owned()]);
    }

    #[test]
    fn find_by_name_ignore_node_modules() {
        let dir = TempDir::new("find-ignore-node-modules");
        let nm = dir.path().join("node_modules").join("paquet");
        fs::create_dir_all(&nm).expect("mkdir node_modules/paquet");
        fs::write(nm.join("cible.js"), "x").expect("write dans node_modules");
        // Une copie hors du dossier ignoré doit, elle, être trouvée.
        let visible = dir.path().join("src");
        fs::create_dir_all(&visible).expect("mkdir src");
        fs::write(visible.join("cible.js"), "y").expect("write visible");

        let results =
            fs_find_by_name(dir.path().to_string_lossy().into_owned(), "cible.js".to_string(), None)
                .expect("find_by_name");

        assert_eq!(results, vec![visible.join("cible.js").to_string_lossy().into_owned()]);
    }

    #[test]
    fn find_by_name_respecte_le_quota() {
        let dir = TempDir::new("find-quota");
        for i in 0..5 {
            let sub = dir.path().join(format!("dossier{i}"));
            fs::create_dir_all(&sub).expect("mkdir sous-dossier");
            fs::write(sub.join("cible.txt"), "x").expect("write cible");
        }

        let results =
            fs_find_by_name(dir.path().to_string_lossy().into_owned(), "cible.txt".to_string(), Some(3))
                .expect("find_by_name");

        assert_eq!(results.len(), 3);
    }

    #[test]
    fn find_by_name_racine_inexistante_erreur() {
        let dir = TempDir::new("find-missing-root");
        let missing = dir.path().join("n-existe-pas");

        let err = fs_find_by_name(missing.to_string_lossy().into_owned(), "cible.txt".to_string(), None)
            .unwrap_err();
        assert!(err.contains("introuvable"), "message inattendu : {err}");
    }
}
