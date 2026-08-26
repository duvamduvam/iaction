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

/// Empêche Windows d'ouvrir une console pour le process enfant. No-op ailleurs.
///
/// Un programme CONSOLE (`node.exe`, `nvidia-smi.exe`…) lancé depuis une application graphique
/// reçoit d'office une fenêtre de terminal. Pour le sidecar, elle restait affichée toute la
/// session ; pour la sonde GPU, relancée toutes les 5 s, elle CLIGNOTAIT en permanence —
/// signalé le 2026-08-26 sur Windows 11 : sur 20 s de traçage, cinq `nvidia-smi.exe` ayant tous
/// `iaction.exe` pour parent, et autant de `conhost.exe` créés dans la foulée. C'est ce conhost
/// qui était la fenêtre noire visible.
///
/// Rien n'est perdu côté observabilité : stdout et stderr restent capturés par l'appelant.
/// Seule la fenêtre disparaît.
pub(crate) fn hide_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        /// `CREATE_NO_WINDOW` (winbase.h) : le process enfant n'obtient pas de console. Valeur
        /// codée en dur plutôt que tirer une dépendance Windows entière pour une constante.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
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

/// Ouverture « avec l'application par défaut du système », quand l'appelant n'a pas
/// nommé de programme.
///
/// **Surtout pas `cmd /C start`.** C'était l'implémentation initiale, et c'était
/// une faille : `cmd.exe` RE-PARSE sa ligne de commande, alors que le quoting de
/// Rust n'ajoute des guillemets que si l'argument contient une espace. Un
/// fichier nommé `notes&plan.md` produisait donc
/// `start "" C:\proj\notes&plan.md` → `cmd` coupe sur `&` et exécute `plan.md`
/// **comme une commande**. Même chose pour `%VAR%`, développé au passage. Et le
/// chemin n'est pas maîtrisé : il vient d'un nom de fichier du projet, ou pire
/// du `href` d'un lien Markdown affiché dans une réponse de LLM ou une
/// transcription.
///
/// `rundll32 url.dll,FileProtocolHandler` fait le même travail — ouvrir avec
/// l'application associée — mais reçoit son argument via `CreateProcess`, sans
/// interpréteur de commandes au milieu : plus rien à échapper, donc plus rien à
/// oublier d'échapper.
#[cfg(target_os = "windows")]
fn build_default_command(path: &str) -> (String, Command) {
    let mut cmd = Command::new("rundll32.exe");
    cmd.arg("url.dll,FileProtocolHandler").arg(path);
    prepare_detached(&mut cmd);
    ("rundll32 url.dll,FileProtocolHandler".to_string(), cmd)
}

#[cfg(target_os = "macos")]
fn build_default_command(path: &str) -> (String, Command) {
    ("open".to_string(), build_command(path, "open"))
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn build_default_command(path: &str) -> (String, Command) {
    ("xdg-open".to_string(), build_command(path, "xdg-open"))
}

/// Commande Tauri : ouvre `path` avec `command` (ex. `"kicad"`) ou, à défaut, avec
/// l'ouvreur par défaut du système (`xdg-open`, `open`, `rundll32`).
/// Spawn détaché, ne bloque jamais l'UI et ne suit pas la fin du process lancé.
/// Erreur lisible si le binaire est introuvable ou si le spawn échoue pour une autre raison.
#[tauri::command]
pub fn open_external(path: String, command: Option<String>) -> Result<(), String> {
    let (program, mut cmd) = match command {
        Some(program) => {
            let cmd = build_command(&path, &program);
            (program, cmd)
        }
        None => build_default_command(&path),
    };
    cmd.spawn()
        .map(|_child| ())
        .map_err(|err| describe_spawn_error(&program, err))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Programme trivialement présent sur la plateforme de test, quelle qu'elle
    /// soit. `true` (coreutils) n'existe QUE sous Unix : l'utiliser sans garde
    /// faisait échouer ce test sur le runner Windows dès que la CI s'est mise à
    /// exécuter `cargo test` — un test qui ne testait plus le code, seulement le
    /// système d'exploitation qui l'exécute.
    #[cfg(windows)]
    const PROGRAMME_TOUJOURS_PRESENT: &str = "cmd.exe";
    #[cfg(not(windows))]
    const PROGRAMME_TOUJOURS_PRESENT: &str = "true";

    #[test]
    fn spawn_binaire_existant_reussit() {
        let result = open_external(".".to_string(), Some(PROGRAMME_TOUJOURS_PRESENT.to_string()));
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

    /// Nom de l'ouvreur par défaut ATTENDU dans le message d'erreur, par
    /// plateforme. Windows n'utilise plus `cmd /C start` (injection de commande,
    /// voir `build_default_command`) mais `rundll32` : l'attente du test devait
    /// suivre, sans quoi il échouait pour la seule raison qu'il datait.
    #[cfg(windows)]
    const OUVREUR_PAR_DEFAUT: &str = "rundll32";
    #[cfg(target_os = "macos")]
    const OUVREUR_PAR_DEFAUT: &str = "open";
    #[cfg(not(any(windows, target_os = "macos")))]
    const OUVREUR_PAR_DEFAUT: &str = "xdg-open";

    #[test]
    fn repli_xdg_open_si_command_absent() {
        // On ne peut pas garantir que l'ouvreur existe dans l'environnement de test (CI headless),
        // donc on vérifie seulement que le programme choisi est le bon, via le message d'erreur
        // en cas d'échec (NotFound) ou le succès si le binaire est présent.
        let result = open_external("/tmp/quelque-chose".to_string(), None);
        if let Err(err) = result {
            assert!(
                err.contains(OUVREUR_PAR_DEFAUT),
                "le message devrait référencer {OUVREUR_PAR_DEFAUT} : {err}"
            );
        }
    }
}
