/**
 * Journal applicatif consolidé — tranche L1.
 *
 * Un seul journal persistant pour toute l'application :
 * `${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/logs/app.jsonl`. Voir
 * docs/protocol.md, section « Méthodes L1 — journal applicatif (logs) », et
 * docs/etude-logs.md § 2.
 *
 * Le sidecar est le SEUL écrivain du fichier ; ce module est sa porte d'entrée
 * interne (`log(...)` et ses raccourcis). Les deux autres portes — `log.append`
 * pour l'UI, l'event Tauri `app:log` pour le Rust (relayé par l'UI) — passent
 * par `logs.ts`, qui aboutit ici.
 *
 * Deux sorties pour une même entrée :
 * 1. une ligne JSONL dans `app.jsonl` (via jsonlStore : append sérialisé,
 *    rotation 20 Mo → `.1`) — c'est ce qui SURVIT au redémarrage ;
 * 2. une ligne lisible `<LEVEL> <scope> <msg>` sur stderr — c'est ce que le
 *    relais Rust existant réémet en event Tauri `sidecar:log`, donc le panneau
 *    « Logs sidecar » continue de fonctionner sans rien changer côté Rust.
 *
 * Deux règles non négociables :
 * - **ne lève jamais** : un appel au journal est presque toujours sur un chemin
 *   de gestion d'erreur, il ne doit pas ajouter une panne à la panne ;
 * - **ne se journalise jamais lui-même** : un échec d'écriture d'`app.jsonl`
 *   retombe sur un `console.error` brut, sinon chaque échec en produirait un
 *   nouveau (boucle infinie).
 *
 * Interdits, jamais journalisés (contrat) : clé API ou secret, corps de prompt
 * ou de réponse, contenu de fichier. Un `msg` et un `fields` sont des libellés
 * techniques, pas de la donnée utilisateur.
 */

import path from "node:path";
import { enqueueWrite, globalConfigRoot, parseCorrelationIds } from "./jsonlStore.js";

// ---------------------------------------------------------------------------
// Niveaux et scopes — énumérations FERMÉES (c'est ce qui rend l'agrégation
// possible ; un intrus est ramené à une valeur sûre, jamais rejeté).
// ---------------------------------------------------------------------------

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug";

/** Du plus grave au plus bavard : l'index EST la gravité (0 = fatal). */
export const LOG_LEVELS: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug"];

export type LogScope =
  | "sidecar"
  | "rust"
  | "ui"
  | "claude"
  | "neutral"
  | "orchestrator"
  | "taches"
  | "knowledge"
  | "speech"
  | "router"
  | "usage";

export const LOG_SCOPES: readonly LogScope[] = [
  "sidecar",
  "rust",
  "ui",
  "claude",
  "neutral",
  "orchestrator",
  "taches",
  "knowledge",
  "speech",
  "router",
  "usage",
];

/** Level inconnu → `error` : mieux vaut sur-signaler qu'avaler une entrée. */
export function normalizeLevel(value: unknown, fallback: LogLevel = "error"): LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : fallback;
}

/** Scope inconnu → `sidecar` (jamais un rejet, contrat `log.append`). */
export function normalizeScope(value: unknown): LogScope {
  return typeof value === "string" && (LOG_SCOPES as readonly string[]).includes(value)
    ? (value as LogScope)
    : "sidecar";
}

/** Rang de gravité : 0 = fatal … 4 = debug (plus le rang est haut, plus c'est bavard). */
export function levelRank(level: LogLevel): number {
  const idx = LOG_LEVELS.indexOf(level);
  return idx === -1 ? LOG_LEVELS.indexOf("error") : idx;
}

/**
 * Seuil d'écriture : `IACTION_LOG_LEVEL` (défaut `info`), relu à CHAQUE appel
 * — même convention que XDG_CONFIG_HOME, et cela rend le seuil modifiable sans
 * redémarrer le sidecar. Sous ce seuil, `log()` est un no-op total : c'est ce
 * qui rend `debug` gratuit en usage normal.
 */
export function currentLevelThreshold(): LogLevel {
  return normalizeLevel(process.env.IACTION_LOG_LEVEL, "info");
}

export function isLevelEnabled(level: LogLevel): boolean {
  return levelRank(level) <= levelRank(currentLevelThreshold());
}

// ---------------------------------------------------------------------------
// Emplacement du journal (relu à chaque appel — jamais mis en cache)
// ---------------------------------------------------------------------------

export function logsDir(): string {
  return path.join(globalConfigRoot(), "logs");
}

export function appLogPath(): string {
  return path.join(logsDir(), "app.jsonl");
}

// ---------------------------------------------------------------------------
// Forme d'une entrée
// ---------------------------------------------------------------------------

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: LogScope;
  msg: string;
  reqId: string | null;
  runId: string | null;
  stepId: string | null;
  /** Objet PLAT (scalaires uniquement), `{}` par défaut. */
  fields: Record<string, string | number | boolean | null>;
  stack: string | null;
}

export interface LogOptions {
  /** Id de la requête protocolaire ; la forme `<runId>::<stepId>` remplit runId/stepId. */
  reqId?: unknown;
  runId?: unknown;
  stepId?: unknown;
  fields?: unknown;
  stack?: unknown;
}

/**
 * Bornes défensives : une entrée doit rester une LIGNE de journal, pas un
 * déversoir. Le contrat ne les fixe pas, elles n'ont d'effet que sur des
 * messages déjà anormaux (et protègent la rotation à 20 Mo d'une boucle
 * d'erreur bavarde).
 */
const MAX_MSG_LENGTH = 1000;
const MAX_STACK_LENGTH = 4000;
const MAX_FIELDS_KEYS = 32;
const MAX_FIELD_STRING = 300;

/** Une entrée = une ligne : les sauts de ligne du msg deviennent des espaces. */
function normalizeMsg(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    // Tolérance d'entrée (log.append vient de l'UI) : un scalaire est lisible.
    text = String(value);
  } else {
    return "(sans message)";
  }
  text = text.replace(/[\r\n]+/g, " ").trim();
  if (text.length === 0) {
    return "(sans message)";
  }
  return text.length > MAX_MSG_LENGTH ? `${text.slice(0, MAX_MSG_LENGTH)}…` : text;
}

/** `fields` est APLATI aux scalaires : tout le reste est écarté sans bruit. */
function normalizeFields(value: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return out;
  }
  let kept = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (kept >= MAX_FIELDS_KEYS) {
      break;
    }
    if (raw === null) {
      out[key] = null;
    } else if (typeof raw === "string") {
      out[key] = raw.length > MAX_FIELD_STRING ? `${raw.slice(0, MAX_FIELD_STRING)}…` : raw;
    } else if (typeof raw === "number") {
      out[key] = Number.isFinite(raw) ? raw : null;
    } else if (typeof raw === "boolean") {
      out[key] = raw;
    } else {
      // objet, tableau, fonction, undefined… : pas un scalaire, écarté.
      continue;
    }
    kept++;
  }
  return out;
}

function normalizeStack(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  // Les sauts de ligne d'une pile sont conservés : JSON.stringify les échappe,
  // l'entrée reste bien sur une seule ligne physique.
  return value.length > MAX_STACK_LENGTH ? `${value.slice(0, MAX_STACK_LENGTH)}…` : value;
}

function normalizeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Construit l'entrée normalisée. Exportée pour `logs.ts` (`log.append`), qui
 * doit normaliser exactement de la même façon que les appels internes.
 */
export function buildEntry(
  level: unknown,
  scope: unknown,
  msg: unknown,
  opts: LogOptions = {},
): LogEntry {
  const reqId = normalizeId(opts.reqId);
  const fromReqId = parseCorrelationIds(reqId);
  return {
    ts: new Date().toISOString(),
    level: normalizeLevel(level),
    scope: normalizeScope(scope),
    msg: normalizeMsg(msg),
    reqId,
    // Les ids explicites priment ; sinon on déplie `<runId>::<stepId>`.
    runId: normalizeId(opts.runId) ?? fromReqId.runId,
    stepId: normalizeId(opts.stepId) ?? fromReqId.stepId,
    fields: normalizeFields(opts.fields),
    stack: normalizeStack(opts.stack),
  };
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

/**
 * Échec d'écriture d'`app.jsonl` : `console.error` BRUT et rien d'autre.
 * Passer par `log()` ici rappellerait `enqueueWrite`, qui échouerait de la
 * même façon, qui rappellerait `log()`… — la boucle est la seule vraie panne
 * possible de ce module.
 */
function reportWriteFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[journal] écriture de app.jsonl impossible: ${message}`);
}

/** Émission de la ligne LISIBLE sur stderr (relayée telle quelle en `sidecar:log`). */
function writeReadableLine(entry: LogEntry): void {
  process.stderr.write(`${entry.level.toUpperCase()} ${entry.scope} ${entry.msg}\n`);
}

/**
 * Écrit une entrée du journal. Ne lève JAMAIS, ne rejette JAMAIS, ne rend
 * rien : un appelant sur un chemin d'erreur ne doit pas avoir à gérer l'échec
 * de sa propre journalisation.
 */
export function log(level: LogLevel, scope: LogScope, msg: string, opts?: LogOptions): void {
  try {
    // Filtre AVANT toute normalisation : sous le seuil, l'appel ne coûte rien.
    if (!isLevelEnabled(normalizeLevel(level))) {
      return;
    }
    const entry = buildEntry(level, scope, msg, opts);
    writeReadableLine(entry);
    enqueueWrite(appLogPath(), JSON.stringify(entry), reportWriteFailure);
  } catch (err) {
    reportWriteFailure(err);
  }
}

/** Variante à entrée déjà construite (chemin `log.append`, qui normalise en amont). */
export function logEntry(entry: LogEntry): void {
  try {
    if (!isLevelEnabled(entry.level)) {
      return;
    }
    writeReadableLine(entry);
    enqueueWrite(appLogPath(), JSON.stringify(entry), reportWriteFailure);
  } catch (err) {
    reportWriteFailure(err);
  }
}

// Raccourcis : c'est la forme d'appel normale dans le reste du sidecar.
export function fatal(scope: LogScope, msg: string, opts?: LogOptions): void {
  log("fatal", scope, msg, opts);
}

export function error(scope: LogScope, msg: string, opts?: LogOptions): void {
  log("error", scope, msg, opts);
}

export function warn(scope: LogScope, msg: string, opts?: LogOptions): void {
  log("warn", scope, msg, opts);
}

export function info(scope: LogScope, msg: string, opts?: LogOptions): void {
  log("info", scope, msg, opts);
}

export function debug(scope: LogScope, msg: string, opts?: LogOptions): void {
  log("debug", scope, msg, opts);
}
