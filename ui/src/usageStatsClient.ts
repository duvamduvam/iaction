/*
 * Wrappers typés pour les méthodes S1 — supervision d'usage (voir
 * docs/protocol.md § « Méthodes S1 — supervision d'usage (Lot 8, tranche 1) »).
 * Même style défensif que sidecar.ts : tout champ manquant/mal typé côté
 * sidecar est simplement omis/neutralisé plutôt que de faire planter l'UI.
 */
import { request } from "./sidecar";

export type UsageBucketKind = "day" | "week" | "month";

export interface UsageTotals {
  tours: number;
  orchTours: number;
  conversations: number;
  /** `null` si aucun `promptTokens` non nul sur la période. */
  avgPromptTokens: number | null;
  totalTokens: number;
}

export interface UsageBucket {
  /** Date `YYYY-MM-DD` de début du bucket (jour/lundi de semaine ISO/1er du mois). */
  start: string;
  tours: number;
  orchTours: number;
  conversations: number;
  avgPromptTokens: number | null;
  totalTokens: number;
}

export interface UsageModelStat {
  model: string;
  engine: string;
  tours: number;
  totalTokens: number;
}

/** R3 — agrégat « routage » de `usage.stats` (encart Routage de Supervision). */
export interface UsageRoutage {
  /** Répartition des tours auto par tier du routeur. */
  parTier: Record<string, { tours: number }>;
  /** Tours portant un `routeTier` (envoyés en « Auto »). */
  toursAuto: number;
  /** Part des tours à coût nul (abonnement Claude + providers locaux), `null` si aucun tour. */
  partCoutNulPct: number | null;
  /** Mix intra-abonnement : tours moteur claude par modèle, trié décroissant. */
  mixAbo: Array<{ model: string; tours: number }>;
  /** Dépense de débord du mois calendaire courant (USD), comparée au plafond. */
  debordMoisUsd: number;
}

export interface UsageStats {
  totals: UsageTotals;
  buckets: UsageBucket[];
  models: UsageModelStat[];
  /** R3 — `null` avec un sidecar antérieur (champ absent). */
  routage: UsageRoutage | null;
}

function toNum(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toNumOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseTotals(value: unknown): UsageTotals {
  const v = (value && typeof value === "object" ? (value as Record<string, unknown>) : {}) as Record<
    string,
    unknown
  >;
  return {
    tours: toNum(v.tours),
    orchTours: toNum(v.orchTours),
    conversations: toNum(v.conversations),
    avgPromptTokens: toNumOrNull(v.avgPromptTokens),
    totalTokens: toNum(v.totalTokens),
  };
}

function parseBucket(value: unknown): UsageBucket | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.start !== "string" || !v.start) return null;
  return {
    start: v.start,
    tours: toNum(v.tours),
    orchTours: toNum(v.orchTours),
    conversations: toNum(v.conversations),
    avgPromptTokens: toNumOrNull(v.avgPromptTokens),
    totalTokens: toNum(v.totalTokens),
  };
}

function parseModelStat(value: unknown): UsageModelStat | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return {
    model: toStr(v.model, "(inconnu)"),
    engine: toStr(v.engine, "?"),
    tours: toNum(v.tours),
    totalTokens: toNum(v.totalTokens),
  };
}

/** R3 — parsing défensif de l'agrégat `routage` (absent/mal formé → null). */
function parseRoutage(value: unknown): UsageRoutage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const parTier: Record<string, { tours: number }> = {};
  if (v.parTier && typeof v.parTier === "object") {
    for (const [tier, agg] of Object.entries(v.parTier as Record<string, unknown>)) {
      if (agg && typeof agg === "object") {
        parTier[tier] = { tours: toNum((agg as Record<string, unknown>).tours) };
      }
    }
  }
  const mixAbo: Array<{ model: string; tours: number }> = [];
  if (Array.isArray(v.mixAbo)) {
    for (const raw of v.mixAbo) {
      if (raw && typeof raw === "object") {
        const m = raw as Record<string, unknown>;
        mixAbo.push({ model: toStr(m.model, "(inconnu)"), tours: toNum(m.tours) });
      }
    }
  }
  return {
    parTier,
    toursAuto: toNum(v.toursAuto),
    partCoutNulPct: toNumOrNull(v.partCoutNulPct),
    mixAbo,
    debordMoisUsd: toNum(v.debordMoisUsd),
  };
}

/**
 * Statistiques agrégées sur une plage (`from`/`to` dates locales `YYYY-MM-DD`
 * incluses, `bucket` = granularité du regroupement). Voir `usage.stats`.
 */
export async function usageStats(from: string, to: string, bucket: UsageBucketKind): Promise<UsageStats> {
  const { done } = request("usage.stats", { from, to, bucket });
  const data = await done;
  const buckets = Array.isArray(data.buckets) ? data.buckets.map(parseBucket).filter((b): b is UsageBucket => b !== null) : [];
  const models = Array.isArray(data.models)
    ? data.models.map(parseModelStat).filter((m): m is UsageModelStat => m !== null)
    : [];
  return { totals: parseTotals(data.totals), buckets, models, routage: parseRoutage(data.routage) };
}

/** Une fenêtre de limitation d'abonnement (utilization %, ISO de réinitialisation). */
export interface ClaudeUsageWindowRaw {
  utilization: number;
  resetsAt: string;
}

/** Instantané de `claude-windows.jsonl` : `windows` génériques (clé brute API → fenêtre). */
export interface ClaudeWindowSnapshot {
  ts: string;
  windows: Record<string, ClaudeUsageWindowRaw>;
}

function parseWindow(value: unknown): ClaudeUsageWindowRaw | null {
  if (!value || typeof value !== "object") return null;
  const w = value as Record<string, unknown>;
  if (typeof w.utilization === "number" && typeof w.resetsAt === "string") {
    return { utilization: w.utilization, resetsAt: w.resetsAt };
  }
  return null;
}

function parseSnapshot(value: unknown): ClaudeWindowSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.ts !== "string" || !v.ts) return null;
  const windows: Record<string, ClaudeUsageWindowRaw> = {};
  if (v.windows && typeof v.windows === "object") {
    for (const [key, raw] of Object.entries(v.windows as Record<string, unknown>)) {
      const parsed = parseWindow(raw);
      if (parsed) windows[key] = parsed;
    }
  }
  return { ts: v.ts, windows };
}

/** Historique des instantanés de limites d'abonnement (voir `usage.claude.history`), ordre chronologique. */
export async function usageClaudeHistory(days = 30): Promise<ClaudeWindowSnapshot[]> {
  const { done } = request("usage.claude.history", { days });
  const data = await done;
  if (!Array.isArray(data.snapshots)) return [];
  const out: ClaudeWindowSnapshot[] = [];
  for (const raw of data.snapshots) {
    const parsed = parseSnapshot(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}
