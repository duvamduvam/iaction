/*
 * Wrappers typés pour les méthodes L1 — journal applicatif (voir
 * docs/protocol.md § « Méthodes L1 — journal applicatif (logs) »).
 * Même style défensif que sidecar.ts / usageStatsClient.ts : tout champ
 * manquant ou mal typé côté sidecar est neutralisé (valeur par défaut) plutôt
 * que de faire planter l'UI — le journal est justement ce qu'on consulte
 * quand le reste va mal, il ne doit jamais être la cause d'un écran cassé.
 */
import { request } from "./sidecar";

/** Niveaux de criticité, du plus grave au plus bavard (ordre du contrat). */
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug";

/** Ordre canonique d'affichage et de comparaison de gravité. */
export const LOG_LEVELS: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug"] as const;

/**
 * Énumération FERMÉE des scopes (contrat). Un scope inconnu est ramené à
 * `sidecar` côté sidecar ; on applique la même règle en lecture.
 */
export const LOG_SCOPES = [
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
] as const;

export type LogScope = (typeof LOG_SCOPES)[number];

/** Une entrée du journal (une ligne de `app.jsonl`). */
export interface LogEntry {
  /** Horodatage ISO 8601 UTC. Chaîne vide si le sidecar n'en a pas fourni. */
  ts: string;
  level: LogLevel;
  scope: LogScope;
  msg: string;
  /** Corrélation — `null` par défaut. */
  reqId: string | null;
  runId: string | null;
  stepId: string | null;
  /** Objet plat (valeurs scalaires), `{}` par défaut. */
  fields: Record<string, string | number | boolean | null>;
  stack: string | null;
}

/** Comptage par niveau — toujours les cinq clés, `0` par défaut. */
export type LogCounts = Record<LogLevel, number>;

/** Résultat d'un `log.read`. */
export interface LogReadResult {
  /** Ordre chronologique (plus ancien d'abord), tronqué à `limit` sur les plus RÉCENTES. */
  entries: LogEntry[];
  /** Comptage par niveau sur la fenêtre lue, AVANT les filtres `minLevel`/`scope`. */
  counts: LogCounts;
  /** `true` si la lecture par la fin n'a pas couvert tout le fichier. */
  truncated: boolean;
}

/** Une famille d'erreurs regroupée par message normalisé (`log.stats`). */
export interface LogTopError {
  msg: string;
  level: LogLevel;
  scopes: LogScope[];
  count: number;
  firstMs: number;
  lastMs: number;
}

/** Résultat d'un `log.stats`. */
export interface LogStats {
  counts: LogCounts;
  /** `error` + `fatal` regroupés, triés par `count` décroissant (20 au plus). */
  topErrors: LogTopError[];
  /** Nombre d'`error`+`fatal` par scope. */
  byScope: Record<string, number>;
  truncated: boolean;
}

/* ---------- Lecture défensive ---------- */

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toStrOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

export function isLogScope(value: unknown): value is LogScope {
  return typeof value === "string" && (LOG_SCOPES as readonly string[]).includes(value);
}

/** Rang de gravité : 0 = `fatal` … 4 = `debug` (plus petit = plus grave). */
export function levelRank(level: LogLevel): number {
  const i = LOG_LEVELS.indexOf(level);
  return i === -1 ? LOG_LEVELS.length : i;
}

/** Comptage vide (les cinq clés à zéro) — jamais de `undefined` à l'affichage. */
export function emptyCounts(): LogCounts {
  return { fatal: 0, error: 0, warn: 0, info: 0, debug: 0 };
}

function parseCounts(value: unknown): LogCounts {
  const counts = emptyCounts();
  if (!value || typeof value !== "object") return counts;
  const v = value as Record<string, unknown>;
  for (const level of LOG_LEVELS) counts[level] = toNum(v[level]);
  return counts;
}

/** `fields` plat : seules les valeurs scalaires sont retenues (le contrat n'en promet pas d'autres). */
function parseFields(value: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw === "string" || typeof raw === "boolean") out[key] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

/**
 * Entrée brute → `LogEntry`. Jamais `null` : une ligne difforme reste
 * affichable (niveau/scope ramenés aux valeurs de repli du contrat, message
 * de secours) — mieux vaut une ligne imparfaite qu'une ligne perdue.
 */
function parseEntry(value: unknown): LogEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    ts: typeof v.ts === "string" ? v.ts : "",
    level: isLogLevel(v.level) ? v.level : "error",
    scope: isLogScope(v.scope) ? v.scope : "sidecar",
    msg: typeof v.msg === "string" && v.msg ? v.msg : "(sans message)",
    reqId: toStrOrNull(v.reqId),
    runId: toStrOrNull(v.runId),
    stepId: toStrOrNull(v.stepId),
    fields: parseFields(v.fields),
    stack: toStrOrNull(v.stack),
  };
}

function parseTopError(value: unknown): LogTopError | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.msg !== "string" || !v.msg) return null;
  const scopes = Array.isArray(v.scopes) ? v.scopes.filter(isLogScope) : [];
  return {
    msg: v.msg,
    level: isLogLevel(v.level) ? v.level : "error",
    scopes,
    count: toNum(v.count),
    firstMs: toNum(v.firstMs),
    lastMs: toNum(v.lastMs),
  };
}

/* ---------- Méthodes ---------- */

export interface LogReadParams {
  /** Gravité AU MOINS égale (`warn` ⇒ `warn`, `error`, `fatal`). Absent = tous. */
  minLevel?: LogLevel;
  scope?: LogScope;
  /** Borne basse d'horodatage, en millisecondes epoch. */
  sinceMs?: number;
  /** Défaut 500 côté sidecar, plafond 5000. */
  limit?: number;
}

/**
 * Lecture du journal par la fin (voir `log.read`). Rejette si le sidecar est
 * injoignable ou ne connaît pas la méthode (sidecar antérieur à L1) — c'est à
 * l'appelant d'afficher « journal indisponible » plutôt que de casser la page,
 * voir `estJournalIndisponible`.
 */
export async function logRead(params: LogReadParams = {}): Promise<LogReadResult> {
  const { done } = request("log.read", {
    ...(params.minLevel !== undefined ? { minLevel: params.minLevel } : {}),
    ...(params.scope !== undefined ? { scope: params.scope } : {}),
    ...(params.sinceMs !== undefined ? { sinceMs: params.sinceMs } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  });
  const data = await done;
  const entries: LogEntry[] = [];
  if (Array.isArray(data.entries)) {
    for (const raw of data.entries) {
      const entry = parseEntry(raw);
      if (entry) entries.push(entry);
    }
  }
  return { entries, counts: parseCounts(data.counts), truncated: data.truncated === true };
}

/** Agrégat du journal (voir `log.stats`) : comptages, top des erreurs, erreurs par scope. */
export async function logStats(sinceMs?: number): Promise<LogStats> {
  const { done } = request("log.stats", { ...(sinceMs !== undefined ? { sinceMs } : {}) });
  const data = await done;
  const topErrors: LogTopError[] = [];
  if (Array.isArray(data.topErrors)) {
    for (const raw of data.topErrors) {
      const top = parseTopError(raw);
      if (top) topErrors.push(top);
    }
  }
  const byScope: Record<string, number> = {};
  if (data.byScope && typeof data.byScope === "object") {
    for (const [scope, n] of Object.entries(data.byScope as Record<string, unknown>)) {
      byScope[scope] = toNum(n);
    }
  }
  return { counts: parseCounts(data.counts), topErrors, byScope, truncated: data.truncated === true };
}

/** Supprime `app.jsonl` et `app.jsonl.1` (voir `log.purge`). Action destructive : confirmer avant. */
export async function logPurge(): Promise<boolean> {
  const { done } = request("log.purge", {});
  const data = await done;
  return data.purged === true;
}

/**
 * Vrai quand l'échec signifie « ce sidecar ne sait pas encore journaliser »
 * (méthode absente du routeur, voir `sidecar/src/index.ts` : « méthode
 * inconnue: … »). L'UI affiche alors « journal indisponible » au lieu d'une
 * erreur technique — cas normal tant que la tranche L1 n'est pas déployée.
 */
export function estJournalIndisponible(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("méthode inconnue");
}
