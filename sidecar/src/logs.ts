/**
 * Méthodes protocolaires du journal applicatif — tranche L1/L4.
 *
 * `log.append`, `log.read`, `log.stats`, `log.purge` : voir docs/protocol.md,
 * section « Méthodes L1 — journal applicatif (logs) ». L'écriture passe
 * toujours par `journal.ts` (seul écrivain d'`app.jsonl`) ; la lecture passe
 * par `jsonlStore.ts` (lecture PAR LA FIN, jamais de parse intégral).
 *
 * Ces handlers sont appelés depuis un chemin de gestion d'erreur (l'UI logue
 * ce qui vient de rater) : ils ne rejettent JAMAIS et répondent toujours
 * `done`, quitte à répondre un agrégat vide.
 */

import { promises as fsp } from "node:fs";
import type { EngineEmitter } from "./engine.js";
import { readJsonlTailWithInfo } from "./jsonlStore.js";
import {
  appLogPath,
  buildEntry,
  logEntry,
  normalizeLevel,
  levelRank,
  LOG_LEVELS,
  type LogEntry,
  type LogLevel,
} from "./journal.js";

/**
 * Fenêtre de lecture par la fin pour `log.read`/`log.stats` : 2 Mo, soit
 * quelques milliers d'entrées — largement au-delà du plafond de 5000 entrées
 * du contrat, et sans commune mesure avec un parse intégral des 20 Mo
 * possibles avant rotation. Au-delà, la réponse porte `truncated: true`.
 */
const LOG_READ_BYTES = 2 * 1024 * 1024;

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Lecture et normalisation des lignes relues
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Entrée RELUE : même forme que `LogEntry`, `scope` en `string` près. À
 * l'écriture l'énumération est fermée ; à la lecture on rend ce qui est dans
 * le fichier (une ligne d'un sidecar futur, avec un scope inconnu, reste
 * lisible et filtrable telle quelle plutôt que d'être repliée sur `sidecar`).
 */
type StoredEntry = Omit<LogEntry, "scope"> & { scope: string };

/**
 * Une ligne relue est retaillée à la forme du contrat : les lignes écrites par
 * un sidecar antérieur (ou tronquées) ne doivent jamais faire échouer une
 * lecture, elles sont complétées avec les valeurs par défaut.
 */
function rowToEntry(row: Record<string, unknown>): StoredEntry {
  const fields: Record<string, string | number | boolean | null> = {};
  const rawFields = row.fields;
  if (typeof rawFields === "object" && rawFields !== null && !Array.isArray(rawFields)) {
    for (const [key, value] of Object.entries(rawFields as Record<string, unknown>)) {
      if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        fields[key] = value;
      }
    }
  }
  return {
    ts: asString(row.ts) ?? "",
    level: normalizeLevel(row.level),
    scope: asString(row.scope) ?? "sidecar",
    msg: typeof row.msg === "string" ? row.msg : "(sans message)",
    reqId: asString(row.reqId),
    runId: asString(row.runId),
    stepId: asString(row.stepId),
    fields,
    stack: asString(row.stack),
  };
}

function entryTimeMs(entry: StoredEntry): number | null {
  if (entry.ts.length === 0) {
    return null;
  }
  const t = Date.parse(entry.ts);
  return Number.isNaN(t) ? null : t;
}

function emptyCounts(): Record<LogLevel, number> {
  return { fatal: 0, error: 0, warn: 0, info: 0, debug: 0 };
}

/** Fenêtre lue : lignes du fichier (par la fin) filtrées par `sinceMs` seulement. */
async function readWindow(sinceMs: number | null): Promise<{ entries: StoredEntry[]; truncated: boolean }> {
  const { rows, truncated } = await readJsonlTailWithInfo(appLogPath(), LOG_READ_BYTES);
  const entries: StoredEntry[] = [];
  for (const row of rows) {
    const entry = rowToEntry(row);
    if (sinceMs !== null) {
      const t = entryTimeMs(entry);
      if (t === null || t < sinceMs) {
        continue;
      }
    }
    entries.push(entry);
  }
  return { entries, truncated };
}

function countByLevel(entries: StoredEntry[]): Record<LogLevel, number> {
  const counts = emptyCounts();
  for (const entry of entries) {
    counts[entry.level] += 1;
  }
  return counts;
}

function readSinceMs(params: Record<string, unknown>): number | null {
  const raw = params.sinceMs;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

// ---------------------------------------------------------------------------
// log.append
// ---------------------------------------------------------------------------

/**
 * Ne rejette jamais : `level`/`scope` invalides sont normalisés
 * (`error`/`sidecar`), `msg` absent devient `"(sans message)"`, et une
 * écriture disque impossible se termine quand même en `done` (l'écriture est
 * de toute façon asynchrone et non bloquante côté journal).
 */
export function handleLogAppend(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): void {
  try {
    logEntry(
      buildEntry(params.level, params.scope, params.msg, {
        reqId: params.reqId,
        runId: params.runId,
        stepId: params.stepId,
        fields: params.fields,
        stack: params.stack,
      }),
    );
  } catch {
    // buildEntry/logEntry ne lèvent pas, mais l'appelant est un chemin
    // d'erreur : on ne lui rend jamais un échec de journalisation.
  }
  emitter.done(id, {});
}

// ---------------------------------------------------------------------------
// log.read
// ---------------------------------------------------------------------------

export async function handleLogRead(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  try {
    const sinceMs = readSinceMs(params);
    const rawLimit = params.limit;
    const limit =
      typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(MAX_LIMIT, Math.floor(rawLimit))
        : DEFAULT_LIMIT;
    // minLevel absent → aucun filtre de gravité (et pas le défaut `error` de
    // normalizeLevel, qui masquerait warn/info/debug).
    const minLevel: LogLevel | null =
      typeof params.minLevel === "string" && (LOG_LEVELS as readonly string[]).includes(params.minLevel)
        ? (params.minLevel as LogLevel)
        : null;
    // Filtre de scope : comparaison EXACTE sur la chaîne demandée (un scope
    // inconnu ne ramène rien, plutôt que d'être replié sur `sidecar`).
    const scope = asString(params.scope);

    const { entries: windowEntries, truncated } = await readWindow(sinceMs);

    // Contrat : `counts` est calculé AVANT minLevel/scope — les compteurs par
    // criticité de la page Système doivent rester justes quand un filtre est
    // actif.
    const counts = countByLevel(windowEntries);

    const filtered = windowEntries.filter((entry) => {
      if (minLevel !== null && levelRank(entry.level) > levelRank(minLevel)) {
        return false;
      }
      if (scope !== null && entry.scope !== scope) {
        return false;
      }
      return true;
    });

    // Ordre chronologique, tronqué aux plus RÉCENTES.
    const entries = filtered.length > limit ? filtered.slice(filtered.length - limit) : filtered;

    emitter.done(id, { entries, counts, truncated });
  } catch {
    emitter.done(id, { entries: [], counts: emptyCounts(), truncated: false });
  }
}

// ---------------------------------------------------------------------------
// log.stats
// ---------------------------------------------------------------------------

/**
 * Message NORMALISÉ servant de clé de regroupement : minuscules, chemins et
 * nombres remplacés par `…`, espaces compactés. C'est ce qui fait tomber
 * « étape 12 échouée » et « étape 37 échouée » dans le même seau — sans quoi
 * un « top des erreurs » n'a aucun sens.
 */
export function normalizeStatsMessage(msg: string): string {
  return msg
    .toLowerCase()
    // Chemins d'abord (ils contiennent des nombres) : /a/b/c, C:\a\b, ./a/b.
    .replace(/(?:[a-z]:)?(?:[\\/][^\s"'`,;)\]}]+)+/g, "…")
    .replace(/\d+/g, "…")
    // Répétitions de placeholders issues des deux passes.
    .replace(/(?:…[\s:._-]*)+…/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

interface TopErrorAgg {
  msg: string;
  level: LogLevel;
  scopes: Set<string>;
  count: number;
  firstMs: number | null;
  lastMs: number | null;
}

/** Range une entrée error/fatal dans son seau de message normalisé. */
function applyTopError(groups: Map<string, TopErrorAgg>, entry: StoredEntry): void {
  const key = normalizeStatsMessage(entry.msg);
  let agg = groups.get(key);
  if (!agg) {
    agg = { msg: key, level: entry.level, scopes: new Set(), count: 0, firstMs: null, lastMs: null };
    groups.set(key, agg);
  }
  agg.count += 1;
  agg.scopes.add(entry.scope);
  // Le niveau du groupe est le PLUS GRAVE rencontré (fatal l'emporte).
  if (levelRank(entry.level) < levelRank(agg.level)) {
    agg.level = entry.level;
  }
  const t = entryTimeMs(entry);
  if (t !== null) {
    agg.firstMs = agg.firstMs === null ? t : Math.min(agg.firstMs, t);
    agg.lastMs = agg.lastMs === null ? t : Math.max(agg.lastMs, t);
  }
}

export async function handleLogStats(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  try {
    const sinceMs = readSinceMs(params);
    const { entries, truncated } = await readWindow(sinceMs);

    const counts = countByLevel(entries);
    const byScope: Record<string, number> = {};
    const groups = new Map<string, TopErrorAgg>();

    for (const entry of entries) {
      // `topErrors` et `byScope` ne comptent que error + fatal.
      if (entry.level !== "error" && entry.level !== "fatal") {
        continue;
      }
      byScope[entry.scope] = (byScope[entry.scope] ?? 0) + 1;
      applyTopError(groups, entry);
    }

    const topErrors = [...groups.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((agg) => ({
        msg: agg.msg,
        level: agg.level,
        scopes: [...agg.scopes].sort((a, b) => a.localeCompare(b)),
        count: agg.count,
        firstMs: agg.firstMs,
        lastMs: agg.lastMs,
      }));

    emitter.done(id, { counts, topErrors, byScope, truncated });
  } catch {
    emitter.done(id, { counts: emptyCounts(), topErrors: [], byScope: {}, truncated: false });
  }
}

// ---------------------------------------------------------------------------
// log.purge
// ---------------------------------------------------------------------------

export async function handleLogPurge(
  id: string,
  _params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const target = appLogPath();
  let purged = true;
  try {
    // `force` : un fichier absent n'est pas une erreur (purger deux fois de
    // suite doit rester une opération réussie).
    await fsp.rm(target, { force: true });
    await fsp.rm(`${target}.1`, { force: true });
  } catch {
    purged = false;
  }
  emitter.done(id, { purged });
}
