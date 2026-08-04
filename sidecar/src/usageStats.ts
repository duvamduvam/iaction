/**
 * Supervision d'usage — Lot 8, tranche 1.
 *
 * Historisation locale au fil de l'eau, en JSONL (append, tolérant : une
 * ligne illisible est ignorée à la lecture), voir docs/protocol.md, section
 * « Méthodes S1 — supervision d'usage ». Répertoire :
 * `${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/usage/` (relu à
 * chaque appel, même convention que orchestrator.ts/taches.ts). Rotation
 * simple : fichier > 20 Mo → renommé en `.1` (un seul niveau, l'ancien `.1`
 * est écrasé).
 *
 * `recordUsageEvent`/`recordClaudeWindowsSnapshot` sont des API internes
 * NON BLOQUANTES appelées par les moteurs en fin de tour : une erreur
 * d'écriture ne doit JAMAIS faire échouer un tour — au pire une entrée
 * `error` de scope `usage` dans le journal applicatif (L1).
 *
 * L1 — les primitives JSONL (append sérialisé, rotation, lecture tolérante,
 * lecture par la fin) vivent désormais dans `jsonlStore.ts` : elles sont
 * partagées avec le journal `app.jsonl`, comportement inchangé.
 */

import path from "node:path";
import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";
import {
  enqueueWrite,
  errMessage,
  globalConfigRoot,
  parseCorrelationIds,
  readJsonlTail,
  readJsonlTolerant,
} from "./jsonlStore.js";

// ---------------------------------------------------------------------------
// Utilitaires (dupliqués depuis orchestrator.ts/taches.ts — non exportés là-bas)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * R3 — heuristique « provider local » (coût nul), partagée avec l'esprit de
 * scripts/usage-baseline.mjs (le script reste autonome) : id de fournisseur
 * contenant ollama, local ou lmstudio.
 */
export function isLocalProviderId(providerId: unknown): boolean {
  if (!isNonEmptyString(providerId)) {
    return false;
  }
  const id = providerId.toLowerCase();
  return id.includes("ollama") || id.includes("local") || id.includes("lmstudio");
}

// ---------------------------------------------------------------------------
// Répertoire racine (lu à chaque appel — jamais mis en cache, voir jsonlStore)
// ---------------------------------------------------------------------------

function usageRoot(): string {
  return path.join(globalConfigRoot(), "usage");
}

function eventsPath(): string {
  return path.join(usageRoot(), "events.jsonl");
}

function claudeWindowsPath(): string {
  return path.join(usageRoot(), "claude-windows.jsonl");
}

/**
 * Échec d'écriture d'un JSONL d'usage : journalisé en `error` de scope
 * `usage` (L1). Le journal, lui, ne repasse jamais par ici — il a sa propre
 * retombée `console.error` brute, sans quoi un disque plein boucherait.
 */
function reportUsageWriteFailure(fileLabel: string, err: unknown): void {
  journal.error("usage", `échec d'écriture de ${fileLabel}`, {
    fields: { fichier: fileLabel, erreur: errMessage(err) },
  });
}

// ---------------------------------------------------------------------------
// recordUsageEvent — API interne appelée par les moteurs (engine.ts,
// neutralAgent.ts, claude.ts) en fin de tour (done/error/aborted).
// ---------------------------------------------------------------------------

export type UsageEngine = "neutral" | "claude";
export type UsageStatus = "done" | "error" | "aborted";

export interface RecordUsageEventInput {
  /**
   * Id de la requête protocolaire ayant porté ce tour (le même `id` que
   * chunk/done/error). Pour une étape d'orchestration, les moteurs sont
   * appelés avec un id interne `<runId>::<stepId>` (voir orchestrator.ts) :
   * ce motif est détecté ici pour remplir orchRunId/orchStepId.
   */
  id: string;
  engine: UsageEngine;
  method: string;
  providerId?: string | null;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  status: UsageStatus;
  /** Paramètre commun optionnel {source?, conversationId?} — validation souple. */
  meta?: unknown;
  /** R0 — slug du modèle réellement servi (modèles de secours OpenRouter), défaut null. */
  modelUsed?: string | null;
  /** R0 — coût réel remonté par le fournisseur (comptabilité d'usage), défaut null. */
  costUsd?: number | null;
  /** R0 — tokens servis depuis le cache, défaut null. */
  cachedTokens?: number | null;
  /**
   * L4 — message d'échec du tour, rempli par les moteurs quand
   * `status: "error"` (tronqué à 500 caractères, sauts de ligne compactés),
   * `null` sinon. Sans lui, `status: "error"` dit qu'un tour a échoué sans
   * jamais dire pourquoi (voir docs/etude-logs.md § 1.4).
   */
  errorMessage?: string | null;
}

/**
 * `<runId>::<stepId>` (voir orchestrator.ts, buildStepStartParams/
 * stepRunner.start) — même convention que le journal applicatif, factorisée
 * dans jsonlStore.ts ; ici seuls les noms de champs diffèrent.
 */
function parseOrchIds(id: string): { orchRunId: string | null; orchStepId: string | null } {
  const { runId, stepId } = parseCorrelationIds(id);
  return { orchRunId: runId, orchStepId: stepId };
}

/** L4 — une ligne, 500 caractères au plus ; `null` si rien d'exploitable. */
const MAX_ERROR_MESSAGE = 500;

function normalizeErrorMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.replace(/[\r\n]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (text.length === 0) {
    return null;
  }
  return text.length > MAX_ERROR_MESSAGE ? `${text.slice(0, MAX_ERROR_MESSAGE)}…` : text;
}

function normalizeMeta(meta: unknown): {
  source: string | null;
  conversationId: string | null;
  routeTier: string | null;
  routeDebord: boolean | null;
} {
  if (!isPlainObject(meta)) {
    return { source: null, conversationId: null, routeTier: null, routeDebord: null };
  }
  return {
    source: isNonEmptyString(meta.source) ? meta.source : null,
    conversationId: isNonEmptyString(meta.conversationId) ? meta.conversationId : null,
    // R1 — tier du routeur quand le tour a été envoyé en « Auto » (défaut null).
    routeTier: isNonEmptyString(meta.routeTier) ? meta.routeTier : null,
    // R3 — vrai quand le tour a été DÉBORDÉ (abonnement saturé → cible payante).
    routeDebord: meta.routeDebord === true ? true : null,
  };
}

/**
 * Append non bloquant d'un événement de tour dans events.jsonl. Ne lève
 * JAMAIS : toute erreur (id malformé, écriture disque…) finit dans le journal
 * applicatif, jamais en exception remontée à l'appelant.
 */
export function recordUsageEvent(input: RecordUsageEventInput): void {
  try {
    const { orchRunId, orchStepId } = parseOrchIds(input.id);
    const meta = normalizeMeta(input.meta);
    const event = {
      ts: new Date().toISOString(),
      engine: input.engine,
      method: input.method,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      modelUsed: input.modelUsed ?? null,
      costUsd: input.costUsd ?? null,
      cachedTokens: input.cachedTokens ?? null,
      status: input.status,
      // L4 — pourquoi le tour a échoué (matière du rapport qualité hebdo).
      errorMessage: normalizeErrorMessage(input.errorMessage),
      orchRunId,
      orchStepId,
      source: meta.source,
      conversationId: meta.conversationId,
      // R1 — traçabilité du routeur (prépare l'encart « Routage » de R3).
      routeTier: meta.routeTier,
      // R3 — traçabilité du débord (plafond mensuel, voir router.ts).
      routeDebord: meta.routeDebord,
    };
    enqueueWrite(eventsPath(), JSON.stringify(event), (err) =>
      reportUsageWriteFailure("events.jsonl", err),
    );
  } catch (err) {
    journal.error("usage", "recordUsageEvent a échoué", { fields: { erreur: errMessage(err) } });
  }
}

/**
 * Append non bloquant d'un instantané d'usage abonnement dans
 * claude-windows.jsonl — appelé (best effort) partout où claude.ts capture
 * un instantané `usage.claude` avec succès.
 */
export function recordClaudeWindowsSnapshot(windows: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), windows });
    enqueueWrite(claudeWindowsPath(), line, (err) =>
      reportUsageWriteFailure("claude-windows.jsonl", err),
    );
  } catch (err) {
    journal.error("usage", "recordClaudeWindowsSnapshot a échoué", {
      fields: { erreur: errMessage(err) },
    });
  }
}

// ---------------------------------------------------------------------------
// R3 — lectures pour la décision de débord (voir router.ts)
// ---------------------------------------------------------------------------

/** Extrait l'`utilization` numérique d'une fenêtre brute de claude-windows.jsonl. */
function windowUtilization(value: unknown): number | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return typeof value.utilization === "number" && Number.isFinite(value.utilization)
    ? value.utilization
    : null;
}

/**
 * R3 — dernier instantané de claude-windows.jsonl (lecture tolérante, PAR LA
 * FIN — voir readJsonlTail : jamais de parse intégral sur le chemin chaud) :
 * pourcentages des fenêtres 5 h et 7 jours de l'abonnement Claude, plus le
 * `ts` de capture (R6-A — le routeur ignore les instantanés trop vieux, voir
 * DEBORD_SNAPSHOT_MAX_AGE_MS dans router.ts). `null` si aucun instantané
 * exploitable (fichier absent/vide) — le routeur ne déborde alors jamais
 * (comportement R1 inchangé).
 */
export async function readLatestClaudeWindows(): Promise<{
  ts: string | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
} | null> {
  const rows = await readJsonlTail(claudeWindowsPath());
  for (let i = rows.length - 1; i >= 0; i--) {
    const windows = rows[i].windows;
    if (!isPlainObject(windows)) {
      continue;
    }
    return {
      ts: isNonEmptyString(rows[i].ts) ? (rows[i].ts as string) : null,
      fiveHourPct: windowUtilization(windows.five_hour),
      sevenDayPct: windowUtilization(windows.seven_day),
    };
  }
  return null;
}

/**
 * R3 — dépense de débord du MOIS CALENDAIRE COURANT (dates locales) : somme
 * des `costUsd` des événements portant `routeDebord: true`. Comparée au
 * plafond `plafondUsdMois` par le routeur — le payant choisi manuellement
 * (sans routeDebord) n'entre jamais dans ce compteur.
 *
 * R6-A — inclut le fichier de rotation `events.jsonl.1` : la rotation à
 * 20 Mo peut y faire basculer des événements du mois courant, et le plafond
 * serait alors sous-compté (ré-ouverture du débord déjà dépensé). L'ordre de
 * lecture est sans effet sur une somme.
 */
export async function autoDebordCostUsdThisMonth(): Promise<number> {
  const events = [
    ...(await readJsonlTolerant(`${eventsPath()}.1`)),
    ...(await readJsonlTolerant(eventsPath())),
  ];
  const now = new Date();
  let sum = 0;
  for (const ev of events) {
    if (ev.routeDebord !== true) {
      continue;
    }
    if (typeof ev.costUsd !== "number" || !Number.isFinite(ev.costUsd)) {
      continue;
    }
    if (!isNonEmptyString(ev.ts)) {
      continue;
    }
    const d = new Date(ev.ts);
    if (Number.isNaN(d.getTime()) || d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) {
      continue;
    }
    sum += ev.costUsd;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// usage.stats
// ---------------------------------------------------------------------------

type Bucket = "day" | "week" | "month";

function isValidBucket(v: unknown): v is Bucket {
  return v === "day" || v === "week" || v === "month";
}

function isValidDateKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Date locale (fuseau du process) formatée YYYY-MM-DD. */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayLocalKey(): string {
  return localDateKey(new Date());
}

function dateFromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(key: string, days: number): string {
  const dt = dateFromKey(key);
  dt.setDate(dt.getDate() + days);
  return localDateKey(dt);
}

/** Début du bucket (jour, lundi ISO de la semaine, ou 1er du mois) contenant `dateKey`, en date locale. */
function bucketKeyForDate(dateKey: string, bucket: Bucket): string {
  if (bucket === "day") {
    return dateKey;
  }
  const dt = dateFromKey(dateKey);
  if (bucket === "month") {
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-01`;
  }
  // week : lundi ISO. getDay() : 0=dimanche..6=samedi.
  const dow = dt.getDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  dt.setDate(dt.getDate() + diffToMonday);
  return localDateKey(dt);
}

/** Toutes les clés de bucket couvrant [fromKey, toKey] (inclus), ordre chronologique. */
function enumerateBucketKeys(fromKey: string, toKey: string, bucket: Bucket): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  let cur = fromKey;
  // Bornée : from/to sont des dates YYYY-MM-DD raisonnables (défaut 30 jours), pas de risque de boucle longue.
  while (true) {
    const bk = bucketKeyForDate(cur, bucket);
    if (!seen.has(bk)) {
      seen.add(bk);
      keys.push(bk);
    }
    if (cur === toKey) {
      break;
    }
    cur = addDays(cur, 1);
  }
  return keys;
}

interface StatsAgg {
  tours: number;
  orchTours: number;
  conversationIds: Set<string>;
  promptTokensSum: number;
  promptTokensCount: number;
  totalTokens: number;
}

function newAgg(): StatsAgg {
  return {
    tours: 0,
    orchTours: 0,
    conversationIds: new Set(),
    promptTokensSum: 0,
    promptTokensCount: 0,
    totalTokens: 0,
  };
}

function applyEvent(agg: StatsAgg, ev: Record<string, unknown>): void {
  agg.tours += 1;
  if (isNonEmptyString(ev.orchRunId)) {
    agg.orchTours += 1;
  }
  if (isNonEmptyString(ev.conversationId)) {
    agg.conversationIds.add(ev.conversationId);
  }
  const pt = typeof ev.promptTokens === "number" ? ev.promptTokens : null;
  const ct = typeof ev.completionTokens === "number" ? ev.completionTokens : null;
  if (pt !== null) {
    agg.promptTokensSum += pt;
    agg.promptTokensCount += 1;
  }
  agg.totalTokens += (pt ?? 0) + (ct ?? 0);
}

function finalizeAgg(agg: StatsAgg): {
  tours: number;
  orchTours: number;
  conversations: number;
  avgPromptTokens: number | null;
  totalTokens: number;
} {
  return {
    tours: agg.tours,
    orchTours: agg.orchTours,
    conversations: agg.conversationIds.size,
    avgPromptTokens:
      agg.promptTokensCount > 0 ? Math.round(agg.promptTokensSum / agg.promptTokensCount) : null,
    totalTokens: agg.totalTokens,
  };
}

/** R3 — accumulateur de l'agrégat `routage` (encart « Routage » de Supervision). */
interface RoutageAgg {
  parTier: Record<string, { tours: number }>;
  toursAuto: number;
  coutNul: number;
  total: number;
  mixAbo: Map<string, number>;
}

function newRoutageAgg(): RoutageAgg {
  return { parTier: {}, toursAuto: 0, coutNul: 0, total: 0, mixAbo: new Map() };
}

function applyRoutageEvent(agg: RoutageAgg, ev: Record<string, unknown>): void {
  agg.total += 1;
  if (isNonEmptyString(ev.routeTier)) {
    agg.toursAuto += 1;
    const tierAgg = agg.parTier[ev.routeTier] ?? { tours: 0 };
    tierAgg.tours += 1;
    agg.parTier[ev.routeTier] = tierAgg;
  }
  // Coût nul = abonnement Claude OU provider local (ollama/local/lmstudio).
  if (ev.engine === "claude" || isLocalProviderId(ev.providerId)) {
    agg.coutNul += 1;
  }
  if (ev.engine === "claude") {
    const model = isNonEmptyString(ev.model) ? ev.model : "(inconnu)";
    agg.mixAbo.set(model, (agg.mixAbo.get(model) ?? 0) + 1);
  }
}

function finalizeRoutage(agg: RoutageAgg, debordMoisUsd: number): {
  parTier: Record<string, { tours: number }>;
  toursAuto: number;
  partCoutNulPct: number | null;
  mixAbo: Array<{ model: string; tours: number }>;
  debordMoisUsd: number;
} {
  return {
    parTier: agg.parTier,
    toursAuto: agg.toursAuto,
    partCoutNulPct: agg.total > 0 ? Math.round((agg.coutNul / agg.total) * 100) : null,
    mixAbo: [...agg.mixAbo.entries()]
      .map(([model, tours]) => ({ model, tours }))
      .sort((a, b) => b.tours - a.tours),
    debordMoisUsd,
  };
}

export async function handleUsageStats(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const bucket: Bucket = isValidBucket(params.bucket) ? params.bucket : "day";
  const toKey = isValidDateKey(params.to) ? params.to : todayLocalKey();
  const fromKey = isValidDateKey(params.from) ? params.from : addDays(toKey, -29);
  const [rangeFrom, rangeTo] = fromKey <= toKey ? [fromKey, toKey] : [toKey, fromKey];

  const events = await readJsonlTolerant(eventsPath());

  const totalsAgg = newAgg();
  const bucketAggs = new Map<string, StatsAgg>();
  const modelAggs = new Map<string, { model: string; engine: string; tours: number; totalTokens: number }>();
  const routageAgg = newRoutageAgg();

  for (const ev of events) {
    if (!isNonEmptyString(ev.ts)) {
      continue;
    }
    const d = new Date(ev.ts);
    if (Number.isNaN(d.getTime())) {
      continue;
    }
    const dateKey = localDateKey(d);
    if (dateKey < rangeFrom || dateKey > rangeTo) {
      continue;
    }

    applyEvent(totalsAgg, ev);

    applyRoutageEvent(routageAgg, ev);

    const bk = bucketKeyForDate(dateKey, bucket);
    let bAgg = bucketAggs.get(bk);
    if (!bAgg) {
      bAgg = newAgg();
      bucketAggs.set(bk, bAgg);
    }
    applyEvent(bAgg, ev);

    const engine = isNonEmptyString(ev.engine) ? ev.engine : "(inconnu)";
    const model = isNonEmptyString(ev.model) ? ev.model : "(inconnu)";
    const key = `${engine}\x1f${model}`;
    let mAgg = modelAggs.get(key);
    if (!mAgg) {
      mAgg = { model, engine, tours: 0, totalTokens: 0 };
      modelAggs.set(key, mAgg);
    }
    mAgg.tours += 1;
    const pt = typeof ev.promptTokens === "number" ? ev.promptTokens : 0;
    const ct = typeof ev.completionTokens === "number" ? ev.completionTokens : 0;
    mAgg.totalTokens += pt + ct;
  }

  const buckets = enumerateBucketKeys(rangeFrom, rangeTo, bucket).map((start) => ({
    start,
    ...finalizeAgg(bucketAggs.get(start) ?? newAgg()),
  }));

  const models = [...modelAggs.values()].sort((a, b) => b.tours - a.tours);

  // R3 — la dépense de débord est TOUJOURS celle du mois calendaire courant
  // (comparée au plafond), indépendante de la période from/to affichée.
  const debordMoisUsd = await autoDebordCostUsdThisMonth();

  emitter.done(id, {
    totals: finalizeAgg(totalsAgg),
    buckets,
    models,
    routage: finalizeRoutage(routageAgg, debordMoisUsd),
  });
}

// ---------------------------------------------------------------------------
// usage.claude.history
// ---------------------------------------------------------------------------

export async function handleUsageClaudeHistory(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const rawDays = params.days;
  const days = typeof rawDays === "number" && Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const rows = await readJsonlTolerant(claudeWindowsPath());
  const snapshots = rows
    .map((r) => {
      if (!isNonEmptyString(r.ts)) {
        return null;
      }
      const t = Date.parse(r.ts);
      if (Number.isNaN(t)) {
        return null;
      }
      return { t, ts: r.ts, windows: isPlainObject(r.windows) ? r.windows : {} };
    })
    .filter((r): r is { t: number; ts: string; windows: Record<string, unknown> } => r !== null && r.t >= cutoff)
    .sort((a, b) => a.t - b.t)
    .map((r) => ({ ts: r.ts, windows: r.windows }));

  emitter.done(id, { snapshots });
}
