/**
 * Timers systemd des tâches — Lot T2 : génère et pilote les unités systemd
 * user d'une tâche (le sidecar ne planifie rien lui-même, voir
 * docs/etude-taches.md § 3.2). Voir docs/protocol.md, section « Méthodes T2 —
 * timers systemd des tâches ».
 *
 * Réutilise `handleTachesList`/`handleTachesRead` (taches.ts) comme briques
 * internes via un émetteur de capture, à la manière dont `orchestrator.ts`
 * réutilise `handleClaudeStart`/`handleNeutralStart` pour `orch.run` — pas de
 * duplication de la validation du manifeste. Les petits utilitaires
 * (validation de `name`, écriture atomique, messages d'erreur) sont en
 * revanche dupliqués depuis taches.ts, qui ne les exporte pas — même
 * convention que taches.ts vis-à-vis d'orchestrator.ts.
 */

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errMessage, isNonEmptyString } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import { handleTachesList, handleTachesRead, type TacheNormalized } from "./taches.js";

// ---------------------------------------------------------------------------
// Utilitaires (dupliqués depuis taches.ts — non exportés là-bas)
// ---------------------------------------------------------------------------


/** Écriture atomique : fichier temporaire dans le même répertoire, puis rename. Crée les parents. */
async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, absPath);
}

const NAME_RE = /^[a-z0-9-]{1,64}$/;

// ---------------------------------------------------------------------------
// Émetteur de capture : réutilise handleTachesList/handleTachesRead en
// interne sans dupliquer leur logique de validation.
// ---------------------------------------------------------------------------

type CaptureResult = { ok: true; data: unknown } | { ok: false; message: string };

function createCaptureEmitter(): { emitter: EngineEmitter; wait: () => Promise<CaptureResult> } {
  let settle!: (r: CaptureResult) => void;
  const promise = new Promise<CaptureResult>((resolve) => {
    settle = resolve;
  });
  const emitter: EngineEmitter = {
    chunk: () => {
      // pas de chunk attendu de taches.list/taches.read
    },
    done: (_id, data) => settle({ ok: true, data }),
    error: (_id, message) => settle({ ok: false, message }),
  };
  return { emitter, wait: () => promise };
}

/** Noms de toutes les tâches déclarées (réutilise `taches.list`). */
async function loadAllTacheNames(): Promise<{ ok: true; names: string[] } | { ok: false; message: string }> {
  const { emitter, wait } = createCaptureEmitter();
  await handleTachesList("internal:taches.timerStatus:list", {}, emitter);
  const result = await wait();
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  const data = result.data as { taches: Array<{ name: string }> };
  return { ok: true, names: data.taches.map((t) => t.name) };
}

/** Manifeste normalisé + dossier de la tâche (réutilise `taches.read`, mêmes règles de validation). */
async function loadTache(
  name: string,
): Promise<{ ok: true; tache: TacheNormalized; dir: string } | { ok: false; message: string }> {
  const { emitter, wait } = createCaptureEmitter();
  await handleTachesRead("internal:taches.timerApply:read", { name }, emitter);
  const result = await wait();
  if (!result.ok) {
    return { ok: false, message: result.message };
  }
  const data = result.data as { tache: TacheNormalized; raw: string; path: string };
  return { ok: true, tache: data.tache, dir: data.path };
}

// ---------------------------------------------------------------------------
// Unités systemd user — chemins et noms
// ---------------------------------------------------------------------------

/**
 * Répertoire des unités systemd user : TOUJOURS `~/.config/systemd/user`,
 * indépendamment de `XDG_CONFIG_HOME` du process sidecar. C'est le manager
 * `systemd --user` de la session de connexion de l'utilisateur qui résout ce
 * chemin, avec SON PROPRE environnement — potentiellement différent de celui
 * du process sidecar (lancé depuis l'app Tauri, qui peut hériter d'un
 * `XDG_CONFIG_HOME` différent, ex. sandbox/snap). Dériver ce répertoire de
 * `process.env.XDG_CONFIG_HOME` risquerait donc d'écrire des unités que le
 * manager systemd de l'utilisateur n'ira jamais chercher.
 */
function systemdUserDir(): string {
  return path.join(os.homedir(), ".config", "systemd", "user");
}

function unitBaseName(name: string): string {
  return `iaction-tache-${name}`;
}

function unitFileName(name: string, kind: "service" | "timer"): string {
  return `${unitBaseName(name)}.${kind}`;
}

/** Résout `scripts/orch-run-headless.mjs` relativement au module courant (voir docs/protocol.md § T2). */
function resolveRunnerPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "..", "scripts", "orch-run-headless.mjs");
}

/**
 * Quote un argument pour une ligne `ExecStart=` (syntaxe de citation des
 * fichiers unit systemd, voir systemd.syntax(7) « Quoting ») : entre
 * guillemets doubles si l'argument contient un espace ou un caractère
 * spécial, avec antislashs/guillemets internes échappés. Aucune substitution
 * shell n'a lieu ici — les gabarits `{{today}}` sont des caractères ordinaires
 * pour systemd, résolus plus tard par le runner headless.
 */
function quoteExecArg(arg: string): string {
  if (arg.length > 0 && !/[\s"\\]/.test(arg)) {
    return arg;
  }
  const escaped = arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Contenu du fichier `.service` (Type=oneshot), voir docs/protocol.md § T2. */
function buildServiceUnit(name: string, tache: TacheNormalized, tacheDir: string, runnerPath: string): string {
  // `cwd` du runner : le projet déclaré par la tâche (résolution des
  // orchestrations DU PROJET, `<cwd>/.iaction/orchestrations/`), sinon le
  // dossier de la tâche (historique : orchestrations globales seulement).
  const args = [process.execPath, runnerPath, tache.cwd ?? tacheDir, tache.orchestration];
  for (const [key, value] of Object.entries(tache.inputs)) {
    args.push("--input", `${key}=${value}`);
  }
  if (tache.report) {
    args.push("--save-output", path.join(tacheDir, tache.report));
  }
  const execStart = args.map(quoteExecArg).join(" ");
  const journalPath = path.join(tacheDir, "rapports", "journal.log");

  return [
    "[Unit]",
    `Description=IAction — tâche ${name}`,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${execStart}`,
    // Sortie ET erreur dans le journal de la tâche : une tâche tourne sans
    // humain devant, ses échecs sont ce qu'on veut le plus retrouver. Avec
    // `StandardError=inherit`, ils partaient dans le journal systemd, séparés
    // de la trace du run (voir docs/etude-logs.md § 1.2 et § 3).
    `StandardOutput=append:${journalPath}`,
    `StandardError=append:${journalPath}`,
    "",
  ].join("\n");
}

/** Contenu du fichier `.timer`, voir docs/protocol.md § T2. */
function buildTimerUnit(name: string, schedule: string): string {
  return [
    "[Unit]",
    `Description=IAction — tâche ${name}`,
    "",
    "[Timer]",
    `OnCalendar=${schedule}`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// systemctl --user — spawn sans shell, timeout court
// ---------------------------------------------------------------------------

interface SystemctlResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  failed: boolean;
}

const SYSTEMCTL_TIMEOUT_MS = 5000;

/**
 * La planification LOCALE repose sur les timers systemd user : elle n'existe
 * donc que sous Linux. Ailleurs (Windows, macOS), on refuse tout de suite avec
 * un message qui dit où va la planification, plutôt que de laisser remonter un
 * « systemctl : commande introuvable » qui n'apprend rien.
 *
 * Ce n'est pas une limitation subie mais la conception retenue
 * (docs/etude-remote.md §9) : les tâches récurrentes vivent sur le serveur
 * — champ `lieu: serveur` du manifeste —, ce qui les rend indépendantes du
 * poste et de son extinction. Aucun équivalent Planificateur de tâches Windows
 * n'est prévu.
 */
export function planificationLocaleDisponible(): boolean {
  return process.platform === "linux";
}

/** Message unique de l'indisponibilité, pour ne pas le reformuler à dix endroits. */
export function messagePlanificationIndisponible(): string {
  return (
    `La planification locale n'est disponible que sous Linux (timers systemd) ; ` +
    `ce poste tourne sous ${process.platform}. Donnez à la tâche le lieu « serveur » ` +
    `pour qu'elle s'exécute sur le runner, indépendamment de ce poste.`
  );
}

function runSystemctl(args: string[], timeoutMs = SYSTEMCTL_TIMEOUT_MS): Promise<SystemctlResult> {
  if (!planificationLocaleDisponible()) {
    return Promise.resolve({
      code: null,
      stdout: "",
      stderr: messagePlanificationIndisponible(),
      timedOut: false,
      failed: true,
    });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("systemctl", ["--user", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: errMessage(err), timedOut: false, failed: true });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || errMessage(err), timedOut, failed: true });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, failed: timedOut || code !== 0 });
    });
  });
}

function systemctlErrorMessage(action: string, result: SystemctlResult): string {
  if (result.timedOut) {
    return `${action}: systemctl --user ne répond pas (timeout ${SYSTEMCTL_TIMEOUT_MS}ms)`;
  }
  const detail = result.stderr.trim() || `code de sortie ${result.code}`;
  return `${action}: ${detail}`;
}

// ---------------------------------------------------------------------------
// taches.timerStatus
// ---------------------------------------------------------------------------

interface TimerStatusEntry {
  unit: string;
  exists: boolean;
  enabled: boolean;
  active: boolean;
  nextMs: number | null;
  lastMs: number | null;
}

/** `"0"`, `"n/a"` ou vide → null ; sinon µs epoch → ms epoch (arrondi). */
function usecToMsOrNull(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "0" || trimmed === "n/a") {
    return null;
  }
  const usec = Number(trimmed);
  if (!Number.isFinite(usec)) {
    return null;
  }
  return Math.round(usec / 1000);
}

/** Parse la sortie `clef=valeur` (une par ligne) de `systemctl show`. */
function parseSystemctlShow(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key.length === 0) {
      continue;
    }
    props[key] = line.slice(eq + 1).trim();
  }
  return props;
}

function buildTimerStatusEntry(unit: string, props: Record<string, string>): TimerStatusEntry {
  if ((props.LoadState ?? "") === "not-found") {
    return { unit, exists: false, enabled: false, active: false, nextMs: null, lastMs: null };
  }
  return {
    unit,
    exists: true,
    enabled: props.UnitFileState === "enabled",
    active: props.ActiveState === "active",
    nextMs: usecToMsOrNull(props.NextElapseUSecRealtime),
    lastMs: usecToMsOrNull(props.LastTriggerUSec),
  };
}

export async function handleTachesTimerStatus(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const namesParam = params.names;

  let names: string[];
  if (namesParam === undefined || namesParam === null) {
    const listResult = await loadAllTacheNames();
    if (!listResult.ok) {
      emitter.error(id, listResult.message);
      return;
    }
    names = listResult.names;
  } else {
    if (!Array.isArray(namesParam) || !namesParam.every(isNonEmptyString)) {
      emitter.error(id, "params.names doit être un tableau de chaînes non vides");
      return;
    }
    for (const n of namesParam) {
      if (!NAME_RE.test(n)) {
        emitter.error(id, `params.names contient un nom invalide (attendu [a-z0-9-]{1,64}): ${JSON.stringify(n)}`);
        return;
      }
    }
    names = namesParam;
  }

  const timers: Record<string, TimerStatusEntry> = {};
  for (const name of names) {
    const unit = unitFileName(name, "timer");
    const result = await runSystemctl([
      "show",
      unit,
      "--property=LoadState,UnitFileState,ActiveState,NextElapseUSecRealtime,LastTriggerUSec",
    ]);
    if (result.failed) {
      emitter.error(id, systemctlErrorMessage(`systemctl indisponible (statut de '${unit}')`, result));
      return;
    }
    timers[name] = buildTimerStatusEntry(unit, parseSystemctlShow(result.stdout));
  }

  emitter.done(id, { timers });
}

// ---------------------------------------------------------------------------
// taches.timerApply
// ---------------------------------------------------------------------------

export async function handleTachesTimerApply(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const nameParam = params.name;
  if (!isNonEmptyString(nameParam) || !NAME_RE.test(nameParam)) {
    emitter.error(id, `params.name invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(nameParam)}`);
    return;
  }

  const loaded = await loadTache(nameParam);
  if (!loaded.ok) {
    emitter.error(id, loaded.message);
    return;
  }
  const { tache, dir: tacheDir } = loaded;

  if (!isNonEmptyString(tache.schedule)) {
    emitter.error(id, `champ 'schedule' requis pour armer le timer de la tâche '${nameParam}'`);
    return;
  }

  const runnerPath = resolveRunnerPath();
  try {
    await fsp.access(runnerPath);
  } catch {
    emitter.error(id, `runner headless introuvable: ${runnerPath}`);
    return;
  }

  const serviceContent = buildServiceUnit(nameParam, tache, tacheDir, runnerPath);
  const timerContent = buildTimerUnit(nameParam, tache.schedule);
  const unitsDir = systemdUserDir();

  try {
    await atomicWriteFile(path.join(unitsDir, unitFileName(nameParam, "service")), serviceContent);
    await atomicWriteFile(path.join(unitsDir, unitFileName(nameParam, "timer")), timerContent);
  } catch (err) {
    emitter.error(id, `écriture des unités systemd impossible: ${errMessage(err)}`);
    return;
  }

  const reload = await runSystemctl(["daemon-reload"]);
  if (reload.failed) {
    emitter.error(id, systemctlErrorMessage("daemon-reload", reload));
    return;
  }

  const unit = unitFileName(nameParam, "timer");
  if (tache.enabled) {
    const result = await runSystemctl(["enable", "--now", unit]);
    if (result.failed) {
      emitter.error(id, systemctlErrorMessage(`activation du timer '${unit}'`, result));
      return;
    }
  } else {
    // Tolérant : un `disable` sur une unité déjà désactivée (ou jamais activée)
    // ne doit pas faire échouer `timerApply` — les unités restent en place.
    await runSystemctl(["disable", "--now", unit]);
  }

  emitter.done(id, { unit, enabled: tache.enabled });
}

// ---------------------------------------------------------------------------
// taches.timerRemove
// ---------------------------------------------------------------------------

export async function handleTachesTimerRemove(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const nameParam = params.name;
  if (!isNonEmptyString(nameParam) || !NAME_RE.test(nameParam)) {
    emitter.error(id, `params.name invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(nameParam)}`);
    return;
  }

  const unit = unitFileName(nameParam, "timer");

  // Tolérant : l'unité peut être déjà désactivée, ou ne pas exister du tout.
  await runSystemctl(["disable", "--now", unit]);

  const unitsDir = systemdUserDir();
  for (const kind of ["service", "timer"] as const) {
    const filePath = path.join(unitsDir, unitFileName(nameParam, kind));
    try {
      await fsp.unlink(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        emitter.error(id, `suppression de '${filePath}' impossible: ${errMessage(err)}`);
        return;
      }
    }
  }

  const reload = await runSystemctl(["daemon-reload"]);
  if (reload.failed) {
    emitter.error(id, systemctlErrorMessage("daemon-reload", reload));
    return;
  }

  emitter.done(id, { removed: true });
}
