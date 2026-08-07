//! Supervision du sidecar Node et relais du protocole JSON Lines vers l'UI.
//!
//! Voir `docs/protocol.md`, section « Côté Rust (supervision + relais) ». Ce module ne
//! comprend pas le contenu métier des messages : il spawn/supervise le process Node,
//! relaie ses lignes stdout/stderr vers l'UI via des events Tauri, et expose deux
//! commandes (`sidecar_request`, `sidecar_status`) pour que l'UI puisse lui parler.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};

/// Backoff initial avant la première tentative de redémarrage.
const INITIAL_BACKOFF_MS: u64 = 500;
/// Plafond du backoff exponentiel.
const MAX_BACKOFF_MS: u64 = 8_000;
/// Nombre d'échecs consécutifs (process mort avant `STABLE_UPTIME`) au-delà duquel
/// le sidecar passe en état `dead` définitif.
const MAX_ATTEMPTS: u32 = 5;
/// Durée de vie au-delà de laquelle un process est considéré comme stable : sa mort
/// remet le compteur d'échecs consécutifs à zéro.
const STABLE_UPTIME: Duration = Duration::from_secs(30);
/// Intervalle de sondage (`try_wait`) pendant qu'un process est supervisé.
const POLL_INTERVAL: Duration = Duration::from_millis(150);
/// Granularité du sommeil pendant le backoff, pour rester réactif à un arrêt demandé.
const SHUTDOWN_CHECK_STEP: Duration = Duration::from_millis(100);

/// État de cycle de vie du sidecar, tel que défini par le protocole.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SidecarLifecycle {
    Starting,
    Running,
    Restarting,
    Dead,
}

impl SidecarLifecycle {
    fn as_str(self) -> &'static str {
        match self {
            SidecarLifecycle::Starting => "starting",
            SidecarLifecycle::Running => "running",
            SidecarLifecycle::Restarting => "restarting",
            SidecarLifecycle::Dead => "dead",
        }
    }
}

/// Payload publié sur l'event Tauri `sidecar:status` et renvoyé par la commande
/// `sidecar_status`. Forme identique dans les deux cas (cf. protocole).
#[derive(Serialize, Clone, Debug)]
pub struct StatusPayload {
    pub state: String,
    pub pid: Option<u32>,
    pub attempts: u32,
}

/// État partagé du sidecar, protégé par un `Mutex` et géré par Tauri via `.manage()`.
pub struct SidecarState {
    pub state: SidecarLifecycle,
    pub pid: Option<u32>,
    pub attempts: u32,
    /// stdin du child courant, utilisé par `sidecar_request` pour lui écrire des requêtes.
    pub stdin: Option<ChildStdin>,
    /// Handle du child courant (sans stdin, déjà extrait ci-dessus), gardé pour pouvoir
    /// le sonder (`try_wait`) et le tuer proprement à la fermeture de l'app.
    child: Option<Child>,
    /// Positionné à `true` pour indiquer à la boucle de supervision de s'arrêter sans
    /// redémarrer le sidecar (fermeture de l'application en cours).
    shutdown: bool,
    /// Vrai tant qu'une boucle de supervision tourne. Sert à `sidecar_restart` :
    /// sans lui, relancer un sidecar `dead` créerait une SECONDE boucle, et
    /// deux superviseurs pour un même process, c'est deux sidecars concurrents
    /// écrivant les mêmes fichiers d'état.
    supervising: bool,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            state: SidecarLifecycle::Starting,
            pid: None,
            attempts: 0,
            stdin: None,
            child: None,
            shutdown: false,
            supervising: false,
        }
    }
}

impl SidecarState {
    fn status_payload(&self) -> StatusPayload {
        StatusPayload {
            state: self.state.as_str().to_string(),
            pid: self.pid,
            attempts: self.attempts,
        }
    }
}

/// Type de l'état managé par Tauri (`app.manage(...)` / `State<'_, SharedState>`).
pub type SharedState = Mutex<SidecarState>;

/// Construit la valeur à passer à `Builder::manage`.
pub fn managed_state() -> SharedState {
    Mutex::new(SidecarState::default())
}

/// Verrouille l'état partagé, en récupérant la donnée même si le mutex a été empoisonné
/// par un panic précédent (on ne veut jamais paniquer sur un chemin d'exécution normal).
fn lock_state(mutex: &SharedState) -> MutexGuard<'_, SidecarState> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Détermine le chemin de l'entrypoint du sidecar Node, par ordre de priorité :
///
/// 1. `IACTION_SIDECAR` — échappatoire explicite (tests, one-shot, dépannage) ;
/// 2. la RESSOURCE embarquée `sidecar/index.js` — cas d'une application
///    installée (AppImage, .deb, installeur Windows) ;
/// 3. le sidecar compilé du dépôt source — cas du développement.
///
/// L'ordre compte : en développement la ressource n'existe pas et l'on retombe
/// sur le dépôt, en installation le dépôt n'existe pas et la ressource répond.
/// Aucun des deux ne devine : chacun est vérifié sur le disque avant d'être
/// retenu, et l'échec final reste explicite (le spawn journalise en `fatal`).
fn sidecar_entry(app: &AppHandle) -> String {
    if let Ok(custom) = std::env::var("IACTION_SIDECAR") {
        return custom;
    }
    if let Ok(resource) = app.path().resolve("sidecar/index.js", BaseDirectory::Resource) {
        if resource.exists() {
            return sans_prefixe_verbatim(&resource);
        }
    }
    concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/dist/index.js").to_string()
}

/// Rend un chemin Windows consommable par un programme TIERS, en retirant le
/// préfixe « verbatim » `\\?\`.
///
/// Tauri résout ses ressources sous cette forme (`\\?\C:\…`), qui lève la
/// limite de 260 caractères et que les API Windows acceptent parfaitement.
/// Node, lui, ne la comprend pas : son résolveur de module remonte les
/// composants du chemin, prend `C:` pour la racine et échoue sur
/// `EISDIR: illegal operation on a directory, lstat 'C:'`. L'application
/// démarrait donc avec un sidecar mort-né sous Windows — diagnostiqué sur un
/// vrai poste le 2026-08-07, l'erreur étant reproductible à l'identique en
/// passant un chemin verbatim à `node` à la main.
///
/// Sans effet ailleurs qu'une conversion en `String` : aucun chemin Unix ne
/// commence par ce préfixe.
fn sans_prefixe_verbatim(chemin: &std::path::Path) -> String {
    let brut = chemin.to_string_lossy();
    // Partage réseau : `\\?\UNC\serveur\partage` désigne `\\serveur\partage`.
    if let Some(reste) = brut.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{reste}");
    }
    if let Some(reste) = brut.strip_prefix(r"\\?\") {
        return reste.to_string();
    }
    brut.into_owned()
}

/// Détermine le runtime Node qui exécutera le sidecar, par ordre de priorité :
///
/// 1. `IACTION_NODE` — échappatoire explicite ;
/// 2. le `node` LIVRÉ à côté de l'exécutable (binaire externe Tauri) — c'est
///    lui qui rend l'application autonome : l'utilisateur n'a pas à installer
///    Node, ni à disposer de droits d'administration pour le faire ;
/// 3. le `node` du PATH — cas du développement, et repli si le binaire livré
///    manquait.
fn node_program(_app: &AppHandle) -> String {
    if let Ok(custom) = std::env::var("IACTION_NODE") {
        return custom;
    }
    let nom = if cfg!(windows) { "node.exe" } else { "node" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dossier) = exe.parent() {
            let livre = dossier.join(nom);
            if livre.exists() {
                // Même précaution que pour l'entrypoint : on ne sait pas sous
                // quelle forme l'OS a rendu `current_exe`.
                return sans_prefixe_verbatim(&livre);
            }
        }
    }
    "node".to_string()
}

/// Émet une ligne de journal applicatif vers l'UI via l'event Tauri `app:log`
/// (voir `docs/protocol.md`, section « Event Tauri `app:log` », et
/// `docs/etude-logs.md` § 2.3). L'UI la relaie vers `log.append`, seul écrivain
/// du fichier `app.jsonl` — c'est ce qui rend les pannes de la coquille Rust
/// visibles en build packagé, où stderr n'a aucune destination.
///
/// Best-effort et jamais bloquant : si l'`emit` échoue, on se contente d'un
/// `eprintln!` et on continue (surtout pas de nouvel `app:log`, qui bouclerait,
/// ni de panique — cette fonction est appelée depuis la boucle de supervision).
/// Les `eprintln!` des appelants sont CONSERVÉS : ils restent le canal utile au
/// terminal en développement.
///
/// À NE PAS appeler depuis le relais du stderr sidecar (`spawn_stderr_reader`) :
/// ces lignes partent déjà sur `sidecar:log`, et les dupliquer ici créerait la
/// boucle sidecar → stderr → `sidecar:log` → `log.append` → sidecar que le
/// contrat interdit explicitement.
pub fn log_app(app: &AppHandle, level: &str, msg: String, fields: Value) {
    let payload = serde_json::json!({
        "level": level,
        "scope": "rust",
        "msg": msg,
        "fields": fields,
    });
    if let Err(err) = app.emit("app:log", payload) {
        eprintln!("[sidecar] échec de l'émission de app:log : {err}");
    }
}

fn emit_status(app: &AppHandle, state: &SidecarState) {
    let payload = state.status_payload();
    if let Err(err) = app.emit("sidecar:status", payload) {
        eprintln!("[sidecar] échec de l'émission de sidecar:status : {err}");
        // Dégradation acceptée : l'UI ne verra pas ce changement d'état, mais
        // l'application continue. Pas de récursion possible — `log_app` ne
        // rappelle jamais `emit_status`.
        log_app(
            app,
            "warn",
            "échec de l'émission de sidecar:status".to_string(),
            serde_json::json!({ "erreur": err.to_string() }),
        );
    }
}

/// Démarre la supervision du sidecar dans un thread dédié. À appeler une fois, depuis
/// `setup()`.
pub fn spawn_supervisor(app: AppHandle) {
    {
        let shared = app.state::<SharedState>();
        let mut guard = lock_state(&shared);
        guard.supervising = true;
    }
    thread::spawn(move || supervise(app));
}

/// Commande Tauri : RELANCE un sidecar mort.
///
/// L'état `dead` (cinq échecs rapprochés) était une impasse : plus aucun
/// redémarrage n'était tenté et il fallait quitter l'application entière pour
/// retrouver un sidecar — donc perdre la fenêtre, les onglets et la session en
/// cours pour une panne souvent passagère. C'est arrivé trois fois dans la
/// seule journée du 2026-08-07, chaque fois parce que le sidecar avait été
/// recompilé pendant que l'application tournait : le superviseur ne trouvait
/// qu'un `index.js` à demi réécrit.
///
/// La relance remet le compteur d'échecs à zéro et repart d'un état `starting`.
/// Deux cas :
/// - la boucle de supervision vit encore (état `restarting`, backoff en cours) :
///   il suffit de tuer l'enfant courant, elle enchaînera ;
/// - elle s'est arrêtée (état `dead`) : on en relance une.
#[tauri::command]
pub fn sidecar_restart(app: AppHandle) -> Result<(), String> {
    let relancer_boucle = {
        let shared = app.state::<SharedState>();
        let mut guard = lock_state(&shared);

        if guard.shutdown {
            return Err("fermeture de l'application en cours".to_string());
        }

        guard.attempts = 0;
        if let Some(child) = guard.child.as_mut() {
            // Best-effort : si le kill échoue, le `try_wait` de la boucle
            // constatera de toute façon la mort ou la survie du process.
            let _ = child.kill();
        }
        guard.child = None;
        guard.stdin = None;
        guard.pid = None;
        guard.state = SidecarLifecycle::Starting;
        emit_status(&app, &guard);
        !guard.supervising
    };

    log_app(
        &app,
        "info",
        "relance du sidecar demandée".to_string(),
        serde_json::json!({ "nouvelleBoucle": relancer_boucle }),
    );

    if relancer_boucle {
        spawn_supervisor(app);
    }
    Ok(())
}

/// Garde qui remet `supervising` à faux à la sortie de la boucle, par quelque
/// chemin qu'elle sorte (mort définitive, arrêt demandé, retour anticipé).
struct FinDeSupervision {
    app: AppHandle,
}

impl Drop for FinDeSupervision {
    fn drop(&mut self) {
        let shared = self.app.state::<SharedState>();
        let mut guard = lock_state(&shared);
        guard.supervising = false;
    }
}

/// Boucle de supervision : spawn, attend la mort du process, gère le backoff et les
/// redémarrages, jusqu'à état `dead` ou demande d'arrêt.
fn supervise(app: AppHandle) {
    // Quoi qu'il arrive, la fin de cette fonction doit lever `supervising` :
    // c'est ce drapeau qui autorise `sidecar_restart` à repartir d'une boucle
    // neuve. Le garde ci-dessous le fait même en cas de retour anticipé.
    let _fin = FinDeSupervision { app: app.clone() };
    let entry = sidecar_entry(&app);
    let node = node_program(&app);

    // Publie l'état initial "starting" avant la première tentative de spawn.
    {
        let shared = app.state::<SharedState>();
        let guard = lock_state(&shared);
        emit_status(&app, &guard);
    }

    loop {
        {
            let shared = app.state::<SharedState>();
            let guard = lock_state(&shared);
            if guard.shutdown {
                return;
            }
        }

        let spawned = Command::new(&node)
            .arg(&entry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();

        let mut child = match spawned {
            Ok(child) => child,
            Err(err) => {
                eprintln!("[sidecar] échec du spawn ({node} {entry}) : {err}");
                // `fatal` : sans sidecar, toute la partie métier de l'app est
                // hors service (c'est la panne « node introuvable »).
                log_app(
                    &app,
                    "fatal",
                    "échec du spawn du sidecar (node)".to_string(),
                    serde_json::json!({ "node": node, "entry": entry, "erreur": err.to_string() }),
                );
                if register_failure(&app, Duration::ZERO) {
                    continue;
                } else {
                    return;
                }
            }
        };

        let pid = child.id();
        spawn_stdout_reader(app.clone(), child.stdout.take());
        spawn_stderr_reader(app.clone(), child.stderr.take());
        let stdin = child.stdin.take();

        let started_at = Instant::now();
        {
            let shared = app.state::<SharedState>();
            let mut guard = lock_state(&shared);
            guard.state = SidecarLifecycle::Running;
            guard.pid = Some(pid);
            guard.stdin = stdin;
            guard.child = Some(child);
            emit_status(&app, &guard);
        }

        // Sonde régulièrement le process jusqu'à sa mort ou une demande d'arrêt.
        loop {
            thread::sleep(POLL_INTERVAL);
            let shared = app.state::<SharedState>();
            let mut guard = lock_state(&shared);

            if guard.shutdown {
                if let Some(child) = guard.child.as_mut() {
                    if let Err(err) = child.kill() {
                        eprintln!("[sidecar] échec du kill à la fermeture : {err}");
                        // Fermeture en cours : l'UI ne recevra probablement
                        // plus rien, mais la ligne reste utile si la fenêtre
                        // est encore vivante.
                        log_app(
                            &app,
                            "warn",
                            "échec du kill du sidecar à la fermeture".to_string(),
                            serde_json::json!({ "erreur": err.to_string() }),
                        );
                    }
                    let _ = child.wait();
                }
                guard.child = None;
                guard.stdin = None;
                return;
            }

            let died = match guard.child.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(_status)) => true,
                    Ok(None) => false,
                    Err(err) => {
                        eprintln!("[sidecar] échec de try_wait : {err}");
                        // On considère le process mort : la supervision
                        // enchaîne sur le backoff, l'app n'est pas bloquée.
                        log_app(
                            &app,
                            "warn",
                            "échec de try_wait sur le sidecar, process considéré mort".to_string(),
                            serde_json::json!({ "erreur": err.to_string() }),
                        );
                        true
                    }
                },
                None => true,
            };

            if died {
                guard.child = None;
                guard.stdin = None;
                guard.pid = None;
                break;
            }
        }

        let uptime = started_at.elapsed();
        if register_failure(&app, uptime) {
            continue;
        } else {
            return;
        }
    }
}

/// À appeler juste après la mort (ou l'échec de spawn) du sidecar. Met à jour le
/// compteur d'échecs consécutifs et l'état, puis attend le backoff avant un nouveau
/// spawn. Retourne `false` si la supervision doit s'arrêter définitivement (état `dead`
/// atteint, ou arrêt demandé pendant l'attente) ; `true` s'il faut retenter un spawn.
fn register_failure(app: &AppHandle, uptime: Duration) -> bool {
    let delay_ms = {
        let shared = app.state::<SharedState>();
        let mut guard = lock_state(&shared);

        if guard.shutdown {
            return false;
        }

        if uptime >= STABLE_UPTIME {
            guard.attempts = 0;
        }
        guard.attempts += 1;

        if guard.attempts >= MAX_ATTEMPTS {
            guard.state = SidecarLifecycle::Dead;
            guard.pid = None;
            emit_status(app, &guard);
            eprintln!(
                "[sidecar] mort définitive après {} tentatives, plus de redémarrage",
                guard.attempts
            );
            // `fatal` : le sous-système est hors service définitivement, plus
            // aucun redémarrage ne sera tenté.
            log_app(
                app,
                "fatal",
                "sidecar mort définitivement après backoff".to_string(),
                serde_json::json!({ "attempts": guard.attempts }),
            );
            return false;
        }

        guard.state = SidecarLifecycle::Restarting;
        guard.pid = None;
        emit_status(app, &guard);

        let exponent = guard.attempts.saturating_sub(1);
        let delai = INITIAL_BACKOFF_MS
            .saturating_mul(2u64.saturating_pow(exponent))
            .min(MAX_BACKOFF_MS);
        // `warn` : dégradation acceptée, l'app continue et le sidecar va être
        // relancé. C'est la trace qui manquait pour comprendre après coup
        // qu'une session a redémarré N fois.
        log_app(
            app,
            "warn",
            "sidecar mort, redémarrage programmé".to_string(),
            serde_json::json!({
                "attempts": guard.attempts,
                "delayMs": delai,
                "uptimeMs": uptime.as_millis() as u64,
            }),
        );
        delai
    };

    sleep_with_shutdown_check(app, Duration::from_millis(delay_ms))
}

/// Dort par petits paliers pour rester réactif à une demande d'arrêt survenant pendant
/// le backoff. Retourne `false` si l'arrêt a été demandé pendant l'attente.
fn sleep_with_shutdown_check(app: &AppHandle, total: Duration) -> bool {
    let mut waited = Duration::ZERO;
    while waited < total {
        let chunk = SHUTDOWN_CHECK_STEP.min(total - waited);
        thread::sleep(chunk);
        waited += chunk;

        let shared = app.state::<SharedState>();
        let guard = lock_state(&shared);
        if guard.shutdown {
            return false;
        }
    }
    true
}

/// Lit la stdout du sidecar ligne par ligne : chaque ligne JSON valide est relayée telle
/// quelle à l'UI via l'event `sidecar:event`. Une ligne non parsable est loguée et ignorée.
fn spawn_stdout_reader(app: AppHandle, stdout: Option<ChildStdout>) {
    let Some(stdout) = stdout else {
        return;
    };
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(err) => {
                    eprintln!("[sidecar] erreur de lecture stdout : {err}");
                    // Plus aucune réponse du sidecar ne parviendra à l'UI : le
                    // process est de fait inutilisable (la supervision le verra
                    // mourir et enchaînera sur le backoff).
                    log_app(
                        &app,
                        "warn",
                        "erreur de lecture de la stdout du sidecar, relais interrompu".to_string(),
                        serde_json::json!({ "erreur": err.to_string() }),
                    );
                    break;
                }
            };
            match serde_json::from_str::<Value>(&line) {
                Ok(value) => {
                    if let Err(err) = app.emit("sidecar:event", value) {
                        eprintln!("[sidecar] échec de l'émission de sidecar:event : {err}");
                        log_app(
                            &app,
                            "warn",
                            "échec de l'émission de sidecar:event".to_string(),
                            serde_json::json!({ "erreur": err.to_string() }),
                        );
                    }
                }
                Err(err) => {
                    eprintln!("[sidecar] ligne stdout non-JSON ignorée ({err}) : {line}");
                    // La ligne elle-même n'est PAS journalisée : elle peut
                    // porter de la donnée utilisateur (réponse de modèle), que
                    // le contrat interdit d'écrire dans le journal.
                    log_app(
                        &app,
                        "warn",
                        "ligne stdout non-JSON ignorée".to_string(),
                        serde_json::json!({ "erreur": err.to_string(), "octets": line.len() }),
                    );
                }
            }
        }
    });
}

/// Lit la stderr du sidecar ligne par ligne : chaque ligne est loguée côté Rust et
/// relayée à l'UI via l'event `sidecar:log`.
fn spawn_stderr_reader(app: AppHandle, stderr: Option<ChildStderr>) {
    let Some(stderr) = stderr else {
        return;
    };
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let line = match line {
                Ok(line) => line,
                Err(err) => {
                    eprintln!("[sidecar] erreur de lecture stderr : {err}");
                    // Seul `app:log` de ce lecteur : événement UNIQUE (suivi
                    // d'un `break`), donc sans risque d'amplification.
                    log_app(
                        &app,
                        "warn",
                        "erreur de lecture de la stderr du sidecar, relais interrompu".to_string(),
                        serde_json::json!({ "erreur": err.to_string() }),
                    );
                    break;
                }
            };
            eprintln!("[sidecar:stderr] {line}");
            // PAS d'`app:log` ici ni dans la branche d'échec ci-dessous : ces
            // lignes partent déjà sur `sidecar:log`, et le sidecar écrit chaque
            // entrée de journal sur sa propre stderr. En journaliser une de
            // plus par ligne créerait la boucle stderr → `app:log` →
            // `log.append` → stderr interdite par le contrat.
            if let Err(err) = app.emit("sidecar:log", line) {
                eprintln!("[sidecar] échec de l'émission de sidecar:log : {err}");
            }
        }
    });
}

/// Demande l'arrêt de la supervision (plus de redémarrage) et tue immédiatement le
/// child courant s'il existe. Idempotent : peut être appelée plusieurs fois (fermeture
/// de fenêtre puis sortie de l'event loop) sans effet de bord.
pub fn request_shutdown(app: &AppHandle) {
    let shared = app.state::<SharedState>();
    let mut guard = lock_state(&shared);
    guard.shutdown = true;
    if let Some(child) = guard.child.as_mut() {
        if let Err(err) = child.kill() {
            eprintln!("[sidecar] échec du kill à la fermeture : {err}");
            log_app(
                app,
                "warn",
                "échec du kill du sidecar à la fermeture".to_string(),
                serde_json::json!({ "erreur": err.to_string() }),
            );
        }
        let _ = child.wait();
    }
    guard.child = None;
    guard.stdin = None;
}

/// Commande Tauri : sérialise `request` en une ligne JSON et l'écrit sur stdin du
/// sidecar. Refuse si le sidecar n'est pas en état `running`.
#[tauri::command]
pub fn sidecar_request(request: Value, sidecar: State<'_, SharedState>) -> Result<(), String> {
    let mut guard = lock_state(&sidecar);

    if guard.state != SidecarLifecycle::Running {
        return Err(format!(
            "sidecar indisponible (état actuel : {})",
            guard.state.as_str()
        ));
    }

    let stdin = guard
        .stdin
        .as_mut()
        .ok_or_else(|| "sidecar indisponible : stdin absent".to_string())?;

    let mut line = serde_json::to_string(&request).map_err(|err| err.to_string())?;
    line.push('\n');

    stdin
        .write_all(line.as_bytes())
        .map_err(|err| err.to_string())?;
    stdin.flush().map_err(|err| err.to_string())?;

    Ok(())
}

/// Commande Tauri : renvoie le dernier état connu du sidecar.
#[tauri::command]
pub fn sidecar_status(sidecar: State<'_, SharedState>) -> StatusPayload {
    let guard = lock_state(&sidecar);
    guard.status_payload()
}

#[cfg(test)]
mod tests_chemins {
    use super::sans_prefixe_verbatim;
    use std::path::Path;

    #[test]
    fn retire_le_prefixe_verbatim_dun_disque() {
        assert_eq!(
            sans_prefixe_verbatim(Path::new(r"\\?\C:\Users\x\IAction\sidecar\index.js")),
            r"C:\Users\x\IAction\sidecar\index.js",
        );
    }

    #[test]
    fn retablit_la_forme_unc_dun_partage() {
        assert_eq!(
            sans_prefixe_verbatim(Path::new(r"\\?\UNC\serveur\partage\app\index.js")),
            r"\\serveur\partage\app\index.js",
        );
    }

    #[test]
    fn laisse_intact_un_chemin_ordinaire() {
        assert_eq!(sans_prefixe_verbatim(Path::new("/usr/lib/IAction/sidecar/index.js")), "/usr/lib/IAction/sidecar/index.js");
        assert_eq!(sans_prefixe_verbatim(Path::new(r"C:\deja\simple.js")), r"C:\deja\simple.js");
    }
}
