//! Commande Tauri pour ouvrir un fichier avec une application externe (Lot 5).
//!
//! Voir `docs/protocol.md`, section « Commande Tauri apps externes (Lot 5) ». Spawn
//! **détaché** : l'app ne suit pas le cycle de vie du process lancé (pas de wait, pas de
//! stdout/stderr capturés), et l'environnement transmis est nettoyé des variables injectées
//! par le wrapper Snap de VSCode — même piège, mêmes variables que `scripts/dev.sh` (sans ce
//! nettoyage, une appli GTK/Qt lancée depuis le terminal VSCode snap crashe au démarrage).

use std::io::ErrorKind;
use std::process::{Command, Stdio};

/// Variables injectées par le wrapper snap de VSCode qui cassent GTK/WebKit chez le process
/// enfant. Identique à la liste nettoyée par `scripts/dev.sh`.
const SNAP_POLLUTED_VARS: &[&str] = &[
    "LD_LIBRARY_PATH",
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GIO_MODULE_DIR",
    "GSETTINGS_SCHEMA_DIR",
    "LOCPATH",
];

/// Variables dont VSCode snap sauvegarde la valeur d'origine sous `<VAR>_VSCODE_SNAP_ORIG`,
/// à restaurer si présentes plutôt que de les laisser simplement nettoyées.
const SNAP_RESTORABLE_VARS: &[&str] = &["XDG_DATA_DIRS", "XDG_CONFIG_DIRS"];

fn describe_spawn_error(program: &str, err: std::io::Error) -> String {
    match err.kind() {
        ErrorKind::NotFound => format!("application introuvable : {program}"),
        ErrorKind::PermissionDenied => format!("permission refusée pour lancer : {program}"),
        _ => format!("échec du lancement de {program} : {err}"),
    }
}

/// Nettoie l'environnement de la pollution Snap et détache le process (spawn « app externe » :
/// pas de stdio hérité, survit à la fermeture d'iaction). Partagé avec `system_probe.rs`
/// (lancement de terminal) — même piège Snap, même détachement.
pub(crate) fn prepare_detached(cmd: &mut Command) {
    for var in SNAP_POLLUTED_VARS {
        cmd.env_remove(var);
    }
    for var in SNAP_RESTORABLE_VARS {
        if let Ok(orig) = std::env::var(format!("{var}_VSCODE_SNAP_ORIG")) {
            cmd.env(var, orig);
        }
    }

    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    // Détache le process enfant de notre groupe de process (équivalent `setsid`) : il ne
    // reçoit ni SIGHUP ni Ctrl+C destiné à iaction, et survit à la fermeture de l'app.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
}

/// Construit la commande à spawn : programme nettoyé de la pollution Snap, `path` en unique
/// argument. Extrait de `open_external` pour être testable sans dépendre du système de fichiers
/// réel (le spawn effectif reste testé séparément).
fn build_command(path: &str, program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.arg(path);
    prepare_detached(&mut cmd);
    cmd
}

/// Commande Tauri : ouvre `path` avec `command` (ex. `"kicad"`) ou, à défaut, `xdg-open`
/// (Linux). Spawn détaché, ne bloque jamais l'UI et ne suit pas la fin du process lancé.
/// Erreur lisible si le binaire est introuvable ou si le spawn échoue pour une autre raison.
#[tauri::command]
pub fn open_external(path: String, command: Option<String>) -> Result<(), String> {
    let program = command.unwrap_or_else(|| "xdg-open".to_string());
    build_command(&path, &program)
        .spawn()
        .map(|_child| ())
        .map_err(|err| describe_spawn_error(&program, err))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_binaire_existant_reussit() {
        // `true` est présent sur toute machine Unix courante (coreutils) : sortie
        // immédiate avec un code 0, sans argument requis.
        let result = open_external(".".to_string(), Some("true".to_string()));
        assert!(result.is_ok(), "échec inattendu : {result:?}");
    }

    #[test]
    fn spawn_binaire_inexistant_erreur_lisible() {
        let err = open_external(
            "/tmp/quelque-chose".to_string(),
            Some("iaction-binaire-inexistant-xyz".to_string()),
        )
        .unwrap_err();
        assert!(err.contains("introuvable"), "message inattendu : {err}");
    }

    #[test]
    fn repli_xdg_open_si_command_absent() {
        // On ne peut pas garantir que `xdg-open` existe dans l'environnement de test (CI headless),
        // donc on vérifie seulement que le programme choisi est le bon, via le message d'erreur
        // en cas d'échec (NotFound) ou le succès si le binaire est présent.
        let result = open_external("/tmp/quelque-chose".to_string(), None);
        if let Err(err) = result {
            assert!(
                err.contains("xdg-open"),
                "le message devrait référencer xdg-open : {err}"
            );
        }
    }
}
