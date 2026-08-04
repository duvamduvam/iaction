/**
 * Tâches planifiées — Lot T1 : CRUD des manifestes `tache.yaml` et lecture de
 * leurs rapports datés. Le sidecar ne planifie rien en T1 : la cadence
 * (`schedule`) est déclarative, exécutée par un timer systemd user piloté
 * depuis l'app en T2.
 *
 * Voir docs/etude-taches.md et docs/protocol.md (section « Méthodes T1 —
 * tâches planifiées »).
 *
 * Répertoire racine : `${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/taches/<nom>/`
 * (`XDG_CONFIG_HOME` relu à chaque appel, jamais mis en cache — même
 * convention que `orchestrator.ts`). Le manifeste est `<dossier>/tache.yaml`.
 *
 * Un manifeste illisible/invalide n'est jamais omis d'une liste (`taches.list`) :
 * il est renvoyé avec un champ `invalid` (message lisible) pour que l'UI
 * l'affiche au lieu de le faire disparaître silencieusement — même
 * convention que `agents.list`/`orch.list`.
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { EngineEmitter } from "./engine.js";

// ---------------------------------------------------------------------------
// Utilitaires (dupliqués depuis orchestrator.ts — non exportés là-bas)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Écriture atomique : fichier temporaire dans le même répertoire, puis rename. Crée les parents. */
async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, absPath);
}

// ---------------------------------------------------------------------------
// Répertoire racine (lu à chaque appel — jamais mis en cache)
// ---------------------------------------------------------------------------

function globalConfigRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = isNonEmptyString(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "net.duvam.iaction");
}

function tachesRoot(): string {
  return path.join(globalConfigRoot(), "taches");
}

// ---------------------------------------------------------------------------
// Validation — noyau commun
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9-]{1,64}$/;
const REPORT_FILE_RE = /^[A-Za-z0-9._-]+\.md$/;

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

function fail<T>(message: string): ValidationResult<T> {
  return { ok: false, message };
}

// ---------------------------------------------------------------------------
// Tâche — types + normalisation/validation
// ---------------------------------------------------------------------------

export interface TacheNormalized {
  name: string;
  description: string;
  orchestration: string;
  schedule: string | null;
  inputs: Record<string, string>;
  report: string | null;
  enabled: boolean;
  /** Répertoire projet passé au runner headless (résolution de l'orchestration
      dans `<cwd>/.iaction/orchestrations/`) — null = dossier de la tâche
      (comportement historique : orchestrations globales seulement). */
  cwd: string | null;
}

export interface TacheListEntry extends TacheNormalized {
  path: string;
  invalid?: string;
}

/** Le chemin `report` doit être relatif au dossier de la tâche : ni absolu, ni segment `..`. */
function isSafeRelativeReportPath(value: string): boolean {
  if (path.isAbsolute(value)) {
    return false;
  }
  const segments = value.split(/[\\/]+/);
  return !segments.includes("..");
}

/** Défauts documentés au contrat : description "", schedule null, inputs {}, report null, enabled false. */
function normalizeTache(raw: unknown): ValidationResult<TacheNormalized> {
  if (!isPlainObject(raw)) {
    return fail("le contenu de la tâche doit être un objet YAML (mapping clé/valeur)");
  }

  const name = raw.name;
  if (!isNonEmptyString(name) || !NAME_RE.test(name)) {
    return fail(`champ 'name' invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(name)}`);
  }

  let description = "";
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== "string") {
      return fail("champ 'description' doit être une chaîne");
    }
    description = raw.description;
  }

  const orchestration = raw.orchestration;
  if (!isNonEmptyString(orchestration) || !NAME_RE.test(orchestration)) {
    return fail(
      `champ 'orchestration' invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(orchestration)}`,
    );
  }

  let schedule: string | null = null;
  if (raw.schedule !== undefined && raw.schedule !== null) {
    if (!isNonEmptyString(raw.schedule)) {
      return fail("champ 'schedule' doit être une chaîne non vide, ou absent/null");
    }
    schedule = raw.schedule;
  }

  const inputs: Record<string, string> = {};
  if (raw.inputs !== undefined && raw.inputs !== null) {
    if (!isPlainObject(raw.inputs)) {
      return fail("champ 'inputs' doit être un objet {clef: chaîne}");
    }
    for (const [k, v] of Object.entries(raw.inputs)) {
      if (typeof v !== "string") {
        return fail(`champ 'inputs.${k}' doit être une chaîne`);
      }
      inputs[k] = v;
    }
  }

  let report: string | null = null;
  if (raw.report !== undefined && raw.report !== null) {
    if (!isNonEmptyString(raw.report)) {
      return fail("champ 'report' doit être une chaîne non vide, ou absent/null");
    }
    if (!isSafeRelativeReportPath(raw.report)) {
      return fail(`champ 'report' doit être un chemin relatif au dossier de la tâche, sans '..': ${raw.report}`);
    }
    report = raw.report;
  }

  let enabled = false;
  if (raw.enabled !== undefined && raw.enabled !== null) {
    if (typeof raw.enabled !== "boolean") {
      return fail("champ 'enabled' doit être un booléen");
    }
    enabled = raw.enabled;
  }

  let cwd: string | null = null;
  if (raw.cwd !== undefined && raw.cwd !== null) {
    if (!isNonEmptyString(raw.cwd)) {
      return fail("champ 'cwd' doit être une chaîne non vide, ou absent/null");
    }
    if (!path.isAbsolute(raw.cwd)) {
      return fail(`champ 'cwd' doit être un chemin ABSOLU (répertoire du projet), reçu: ${raw.cwd}`);
    }
    cwd = raw.cwd;
  }

  return { ok: true, value: { name, description, orchestration, schedule, inputs, report, enabled, cwd } };
}

function invalidTacheEntry(dirName: string, dirPath: string, message: string): TacheListEntry {
  return {
    name: dirName,
    description: "",
    orchestration: "",
    schedule: null,
    inputs: {},
    report: null,
    enabled: false,
    cwd: null,
    path: dirPath,
    invalid: message,
  };
}

// ---------------------------------------------------------------------------
// taches.list
// ---------------------------------------------------------------------------

/** Sous-dossiers du répertoire racine contenant un `tache.yaml` (racine absente → []). */
async function listTacheDirNames(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirNames: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    try {
      await fsp.access(path.join(root, e.name, "tache.yaml"));
      dirNames.push(e.name);
    } catch {
      // pas de tache.yaml dans ce dossier : ignoré (pas une tâche déclarée).
    }
  }
  return dirNames;
}

async function loadTacheEntry(dirPath: string, dirName: string): Promise<TacheListEntry> {
  const manifestPath = path.join(dirPath, "tache.yaml");
  let content: string;
  try {
    content = await fsp.readFile(manifestPath, "utf8");
  } catch (err) {
    return invalidTacheEntry(dirName, dirPath, `lecture impossible: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    return invalidTacheEntry(dirName, dirPath, `YAML invalide: ${errMessage(err)}`);
  }
  const result = normalizeTache(parsed);
  if (!result.ok) {
    return invalidTacheEntry(dirName, dirPath, result.message);
  }
  if (result.value.name !== dirName) {
    return invalidTacheEntry(
      dirName,
      dirPath,
      `champ 'name' ('${result.value.name}') différent du nom du dossier ('${dirName}')`,
    );
  }
  return { ...result.value, path: dirPath };
}

export async function handleTachesList(
  id: string,
  _params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const root = tachesRoot();
  const dirNames = await listTacheDirNames(root);

  const entries: TacheListEntry[] = [];
  for (const dirName of dirNames) {
    entries.push(await loadTacheEntry(path.join(root, dirName), dirName));
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  emitter.done(id, { taches: entries });
}

// ---------------------------------------------------------------------------
// taches.read
// ---------------------------------------------------------------------------

export async function handleTachesRead(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const nameParam = params.name;
  if (!isNonEmptyString(nameParam) || !NAME_RE.test(nameParam)) {
    emitter.error(id, `params.name invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(nameParam)}`);
    return;
  }

  const dirPath = path.join(tachesRoot(), nameParam);
  const manifestPath = path.join(dirPath, "tache.yaml");

  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, "utf8");
  } catch (err) {
    emitter.error(id, `manifeste introuvable ou illisible: ${errMessage(err)}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    emitter.error(id, `YAML invalide (tache.yaml de '${nameParam}'): ${errMessage(err)}`);
    return;
  }
  const result = normalizeTache(parsed);
  if (!result.ok) {
    emitter.error(id, `${result.message} (tâche: ${nameParam})`);
    return;
  }
  if (result.value.name !== nameParam) {
    emitter.error(id, `champ 'name' ('${result.value.name}') différent du nom du dossier ('${nameParam}')`);
    return;
  }

  emitter.done(id, { tache: result.value, raw, path: dirPath });
}

// ---------------------------------------------------------------------------
// taches.write
// ---------------------------------------------------------------------------

export async function handleTachesWrite(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const rawParam = params.raw;
  const tacheParam = params.tache;
  const hasRaw = rawParam !== undefined && rawParam !== null;
  const hasTache = tacheParam !== undefined && tacheParam !== null;
  if (hasRaw === hasTache) {
    emitter.error(id, "params doit contenir exactement un de 'raw' ou 'tache' (ni les deux, ni aucun)");
    return;
  }

  let normalized: TacheNormalized;
  let contentToWrite: string;
  let targetName: string;

  if (hasRaw) {
    const nameParam = params.name;
    if (!isNonEmptyString(nameParam) || !NAME_RE.test(nameParam)) {
      emitter.error(id, `params.name invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(nameParam)}`);
      return;
    }
    if (typeof rawParam !== "string" || rawParam.trim().length === 0) {
      emitter.error(id, "params.raw doit être une chaîne YAML non vide");
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(rawParam);
    } catch (err) {
      emitter.error(id, `YAML invalide: ${errMessage(err)}`);
      return;
    }
    const result = normalizeTache(parsed);
    if (!result.ok) {
      emitter.error(id, result.message);
      return;
    }
    if (result.value.name !== nameParam) {
      emitter.error(id, `champ 'name' ('${result.value.name}') différent de params.name ('${nameParam}')`);
      return;
    }
    normalized = result.value;
    contentToWrite = rawParam;
    targetName = nameParam;
  } else {
    const result = normalizeTache(tacheParam);
    if (!result.ok) {
      emitter.error(id, result.message);
      return;
    }
    normalized = result.value;
    contentToWrite = stringifyYaml(normalized, { lineWidth: 0 });
    targetName = normalized.name;
  }

  const dirPath = path.join(tachesRoot(), targetName);
  const manifestPath = path.join(dirPath, "tache.yaml");
  const reportsDir = path.join(dirPath, "rapports");

  try {
    await fsp.mkdir(reportsDir, { recursive: true });
    await atomicWriteFile(manifestPath, contentToWrite);
  } catch (err) {
    emitter.error(id, `écriture impossible: ${errMessage(err)}`);
    return;
  }

  emitter.done(id, { tache: normalized, path: dirPath });
}

// ---------------------------------------------------------------------------
// taches.delete — supprime UNIQUEMENT tache.yaml (le dossier, .iaction/,
// .mcp.json et rapports/ restent en place).
// ---------------------------------------------------------------------------

export async function handleTachesDelete(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const nameParam = params.name;
  if (!isNonEmptyString(nameParam) || !NAME_RE.test(nameParam)) {
    emitter.error(id, `params.name invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(nameParam)}`);
    return;
  }

  const manifestPath = path.join(tachesRoot(), nameParam, "tache.yaml");
  try {
    await fsp.unlink(manifestPath);
  } catch (err) {
    emitter.error(id, `suppression impossible: ${errMessage(err)}`);
    return;
  }
  emitter.done(id, { deleted: true });
}

// ---------------------------------------------------------------------------
// taches.reports
// ---------------------------------------------------------------------------

export async function handleTachesReports(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const nameParam = params.name;
  if (!isNonEmptyString(nameParam) || !NAME_RE.test(nameParam)) {
    emitter.error(id, `params.name invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(nameParam)}`);
    return;
  }

  const reportsDir = path.join(tachesRoot(), nameParam, "rapports");
  let entries;
  try {
    entries = await fsp.readdir(reportsDir, { withFileTypes: true });
  } catch {
    emitter.done(id, { reports: [] });
    return;
  }

  const reports: { file: string; mtimeMs: number; size: number }[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".md")) {
      continue;
    }
    try {
      const stat = await fsp.stat(path.join(reportsDir, e.name));
      reports.push({ file: e.name, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // fichier disparu entre le readdir et le stat : ignoré.
    }
  }
  reports.sort((a, b) => b.mtimeMs - a.mtimeMs);

  emitter.done(id, { reports });
}

// ---------------------------------------------------------------------------
// taches.reportRead
// ---------------------------------------------------------------------------

export async function handleTachesReportRead(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const nameParam = params.name;
  if (!isNonEmptyString(nameParam) || !NAME_RE.test(nameParam)) {
    emitter.error(id, `params.name invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(nameParam)}`);
    return;
  }

  const fileParam = params.file;
  if (!isNonEmptyString(fileParam) || !REPORT_FILE_RE.test(fileParam)) {
    emitter.error(
      id,
      `params.file invalide (attendu un nom simple '*.md' sans séparateur de chemin), reçu: ${JSON.stringify(fileParam)}`,
    );
    return;
  }

  const filePath = path.join(tachesRoot(), nameParam, "rapports", fileParam);
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    emitter.error(id, `lecture impossible: ${errMessage(err)}`);
    return;
  }

  emitter.done(id, { content });
}
