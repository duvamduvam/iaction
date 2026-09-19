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

import fsp from "node:fs/promises";
import path from "node:path";
import { errMessage, isNonEmptyString, isPlainObject } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";
import {
  enqueueWrite,
  globalConfigRoot,
  parseCorrelationIds,
  readJsonlTail,
  readJsonlTolerant,
} from "./jsonlStore.js";
// T-071 — l'agrégat de sobriété vit dans son propre module, même patron que S2.
import { applySobrieteEvent, finalizeSobriete, newSobrieteAgg, type SobrieteAgg } from "./usageSobriete.js";
// T-074 — projection minimale pour le signal d'escalade (calcul côté UI, voir usageEscalade.ts).
import { applyEscaladeEvent, finalizeEscalade, newEscaladeAgg, type EscaladeAgg } from "./usageEscalade.js";
// S2 — l'attribution d'un tour à son projet vit dans son propre module.
import {
  applyProjetEvent,
  finalizeParProjet,
  indexProjects,
  readConversationProjects,
  readDeclaredProjects,
  type ProjetAgg,
} from "./usageProjets.js";

// ---------------------------------------------------------------------------
// Utilitaires (dupliqués depuis orchestrator.ts/taches.ts — non exportés là-bas)
// ---------------------------------------------------------------------------


/**
 * R3 — ce fournisseur est-il gratuit (coût nul) ?
 *
 * ── La devinette, et pourquoi elle survit ───────────────────────────────
 * La gratuité était DEVINÉE par sous-chaîne de l'identifiant — c'est la ligne
 * que T-023 cite en exemple de ce qu'il faut supprimer : un fournisseur local
 * nommé autrement est facturé à tort, un fournisseur payant contenant « local »
 * compté gratuit. Elle est désormais SUBORDONNÉE au trait `billing`, déclaré
 * par le fournisseur.
 *
 * Elle n'est pas supprimée pour autant, et c'est délibéré : sans trait, le
 * comportement doit rester celui d'avant à l'octet près (discipline R0), sans
 * quoi tout fournisseur non encore déclaré basculerait d'un coup en « payant »
 * et fausserait l'historique. Elle disparaîtra quand les profils seront
 * déclarés, pas avant.
 */
export function isLocalProviderId(providerId: unknown, billing?: "free" | "paid"): boolean {
  if (billing) {
    return billing === "free";
  }
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
   * T-036 — le fournisseur ne remonte AUCUN coût, par construction (trait
   * `coutRemonte: false`). Écrit seulement quand c'est vrai : un tour ordinaire
   * garde un événement identique à l'octet près.
   */
  coutIndisponible?: boolean;
  /**
   * T-023 — facturation DÉCLARÉE du fournisseur au moment du tour (trait
   * `billing`). Absent : l'agrégat retombe sur la devinette par identifiant,
   * qui est tout ce dont dispose l'historique déjà écrit.
   */
  gratuit?: boolean;
  /**
   * L4 — message d'échec du tour, rempli par les moteurs quand
   * `status: "error"` (tronqué à 500 caractères, sauts de ligne compactés),
   * `null` sinon. Sans lui, `status: "error"` dit qu'un tour a échoué sans
   * jamais dire pourquoi (voir docs/etude-logs.md § 1.4).
   */
  errorMessage?: string | null;
  /**
   * T-066 — ventilation par modèle réellement appelé pendant le tour (voir
   * claude.ts, `extractModelUsage`). Le type est décrit ICI plutôt qu'importé
   * de claude.ts : ce module est importé PAR les moteurs, l'importer en retour
   * fermerait un cycle. TypeScript étant structurel, la compatibilité est
   * vérifiée sans dépendance.
   *
   * L'événement reste à UN par tour : la ventilation est imbriquée, elle ne le
   * remplace pas. Émettre une ligne par modèle aurait gonflé le compte de
   * `tours` de tous les agrégats existants — un socle ne casse pas ce qu'il
   * porte.
   */
  ventilation?: ReadonlyArray<UsageVentilationLine> | null;
  /**
   * T-066 — occupation RÉELLE de la fenêtre de contexte au dernier appel du
   * tour (`extractContextTokens`). Elle était calculée puis abandonnée : le
   * KPI « Contexte moyen » retombait sur `promptTokens`, de médiane 6 tokens.
   */
  contextTokens?: number | null;
  /** T-066 — durée du tour. Jamais mesurée jusqu'ici : aucune métrique de latence n'était possible. */
  durationMs?: number | null;
}

/** T-066 — une ligne de ventilation. Voir `RecordUsageEventInput.ventilation`. */
export interface UsageVentilationLine {
  model: string;
  role: "fil" | "delegue" | "inconnu";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  contextWindow: number | null;
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
  projectId: string | null;
  projectPath: string | null;
} {
  if (!isPlainObject(meta)) {
    return {
      source: null,
      conversationId: null,
      routeTier: null,
      routeDebord: null,
      projectId: null,
      projectPath: null,
    };
  }
  return {
    source: isNonEmptyString(meta.source) ? meta.source : null,
    conversationId: isNonEmptyString(meta.conversationId) ? meta.conversationId : null,
    // S2 — projet auquel imputer le tour : id déclaré (UI, page Projets) et/ou
    // répertoire du run (orchestrations et tâches de fond, rempli côté sidecar).
    projectId: isNonEmptyString(meta.projectId) ? meta.projectId : null,
    projectPath: isNonEmptyString(meta.projectPath) ? meta.projectPath : null,
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
      // T-036 — écrit seulement si vrai : un tour ordinaire garde un événement
      // identique à l'octet près.
      ...(input.coutIndisponible === true ? { coutIndisponible: true } : {}),
      ...(typeof input.gratuit === "boolean" ? { gratuit: input.gratuit } : {}),
      // T-066 — écrits SEULEMENT quand ils existent : un tour d'un moteur qui
      // ne les fournit pas garde un événement identique à l'octet près (même
      // discipline R0 que `coutIndisponible` ci-dessus).
      ...(input.ventilation && input.ventilation.length > 0
        ? { ventilation: input.ventilation }
        : {}),
      ...(typeof input.contextTokens === "number" ? { contextTokens: input.contextTokens } : {}),
      ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
      status: input.status,
      // L4 — pourquoi le tour a échoué (matière du rapport qualité hebdo).
      errorMessage: normalizeErrorMessage(input.errorMessage),
      orchRunId,
      orchStepId,
      source: meta.source,
      conversationId: meta.conversationId,
      // S2 — attribution par projet (encart « Usage par projet »).
      projectId: meta.projectId,
      projectPath: meta.projectPath,
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
/**
 * Fenêtre lue pour le calcul du débord. Seuls comptent les événements du MOIS
 * COURANT : remonter 8 Mo par fichier couvre très largement un mois de trafic
 * (mesure réelle : 268 Ko pour ~680 tours), tout en bornant le coût.
 *
 * Lire les fichiers ENTIERS était l'inverse de l'optimisation déjà appliquée
 * juste au-dessus pour les fenêtres d'abonnement — et ce calcul est sur le
 * CHEMIN CHAUD du routeur : il tourne à chaque envoi dès que la fenêtre 5 h est
 * saturée, c'est-à-dire pendant la période de plus fort trafic. Avec la
 * rotation à 20 Mo (plus son `.1`), on paierait jusqu'à 40 Mo de parse par
 * message envoyé, précisément au pire moment.
 */
const DEBORD_TAIL_BYTES = 8 * 1024 * 1024;

export async function autoDebordCostUsdThisMonth(): Promise<number> {
  const events = [
    ...(await readJsonlTail(`${eventsPath()}.1`, DEBORD_TAIL_BYTES)),
    ...(await readJsonlTail(eventsPath(), DEBORD_TAIL_BYTES)),
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
  /**
   * T-067 — occupations RÉELLES de la fenêtre de contexte (`contextTokens`,
   * enregistré depuis T-066), pas les `promptTokens` du SDK : ces derniers
   * EXCLUENT le cache, et leur moyenne donnait un « Contexte moyen » de
   * 6 tokens sur 1 031 tours. Un tableau plutôt qu'une somme parce que la
   * bonne statistique ici est la MÉDIANE : la moyenne d'une distribution
   * aussi étalée ne décrit aucun tour réel.
   */
  contextes: number[];
  totalTokens: number;
}

function newAgg(): StatsAgg {
  return {
    tours: 0,
    orchTours: 0,
    conversationIds: new Set(),
    contextes: [],
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
  // Un contexte de 0 n'est pas une mesure : c'est un tour dont le contexte
  // n'a pas été relevé. Il ne doit pas tirer la médiane vers le bas.
  if (typeof ev.contextTokens === "number" && ev.contextTokens > 0) {
    agg.contextes.push(ev.contextTokens);
  }
  agg.totalTokens += (pt ?? 0) + (ct ?? 0);
}

function finalizeAgg(agg: StatsAgg): {
  tours: number;
  orchTours: number;
  conversations: number;
  contexteMedian: number | null;
  totalTokens: number;
} {
  const contextes = [...agg.contextes].sort((a, b) => a - b);
  return {
    tours: agg.tours,
    orchTours: agg.orchTours,
    conversations: agg.conversationIds.size,
    // `null` quand aucun tour de la tranche n'a de contexte relevé : une
    // médiane absente n'est pas une médiane nulle (la courbe s'interrompt).
    contexteMedian: mediane(contextes),
    totalTokens: agg.totalTokens,
  };
}

/** Médiane basse d'une liste DÉJÀ triée. `null` si la liste est vide. */
function mediane(triees: number[]): number | null {
  if (triees.length === 0) return null;
  return triees[Math.floor((triees.length - 1) / 2)];
}

/** R3 — accumulateur de l'agrégat `routage` (encart « Routage » de Supervision). */
interface RoutageAgg {
  parTier: Record<string, { tours: number }>;
  toursAuto: number;
  /**
   * T-068 — les deux moitiés de l'ancien « coût nul », séparées parce qu'elles
   * ne coûtent pas la même chose : un tour d'ABONNEMENT est gratuit pour le
   * portefeuille et consomme le quota (la seule ressource qui sature ici) ;
   * un tour LOCAL ne consomme ni l'un ni l'autre. Les additionner produisait
   * « 98 % de gratuité » pendant que la fenêtre 5 h était à 104 %.
   */
  coutNulAbo: number;
  coutNulLocal: number;
  total: number;
  mixAbo: Map<string, number>;
  /** S3 — dépense RÉELLE de la période : somme des `costUsd` remontés. */
  coutUsd: number;
  /** S3 — tours payants dont le fournisseur n'a remonté AUCUN coût. */
  coutInconnuTours: number;
  /** T-036 — tours dont le fournisseur ne remonte structurellement pas de coût. */
  coutNonRemonteTours: number;
}

function newRoutageAgg(): RoutageAgg {
  return {
    parTier: {},
    toursAuto: 0,
    coutNulAbo: 0,
    coutNulLocal: 0,
    total: 0,
    mixAbo: new Map(),
    coutUsd: 0,
    coutInconnuTours: 0,
    coutNonRemonteTours: 0,
  };
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
  // T-023 — la facturation déclarée au moment du tour prime sur la devinette ;
  // l'historique déjà écrit n'a que la devinette, et c'est pourquoi elle reste.
  const abonnement = ev.engine === "claude";
  const local =
    !abonnement && (typeof ev.gratuit === "boolean" ? ev.gratuit : isLocalProviderId(ev.providerId));
  const coutNul = abonnement || local;
  if (abonnement) agg.coutNulAbo += 1;
  else if (local) agg.coutNulLocal += 1;
  if (ev.engine === "claude") {
    const model = isNonEmptyString(ev.model) ? ev.model : "(inconnu)";
    agg.mixAbo.set(model, (agg.mixAbo.get(model) ?? 0) + 1);
  }
  // S3 — la dépense de la période compte TOUT le payant, débord ou choix
  // manuel : `debordMoisUsd` ne couvre que la fraction routée automatiquement,
  // et laissait invisible un tour OpenRouter choisi à la main (T-035).
  if (typeof ev.costUsd === "number" && Number.isFinite(ev.costUsd)) {
    agg.coutUsd += ev.costUsd;
  } else if (!coutNul) {
    // Fournisseur payant sans coût : la dépense affichée est un MINORANT dans
    // les deux cas, mais un seul appelle une action (T-036). « Structurel » =
    // le fournisseur ne remonte jamais de coût, aucun réglage n'y changera
    // rien ; « inconnu » = il pourrait, et ne l'a pas fait — là, il y a une
    // comptabilité d'usage à cocher.
    if (ev.coutIndisponible === true) agg.coutNonRemonteTours += 1;
    else agg.coutInconnuTours += 1;
  }
}

function finalizeRoutage(agg: RoutageAgg, debordMoisUsd: number): {
  parTier: Record<string, { tours: number }>;
  toursAuto: number;
  partCoutNulPct: number | null;
  partAbonnementPct: number | null;
  partLocalPct: number | null;
  mixAbo: Array<{ model: string; tours: number }>;
  debordMoisUsd: number;
  coutPeriodeUsd: number;
  coutInconnuTours: number;
  coutNonRemonteTours: number;
} {
  const pct = (n: number): number | null => (agg.total > 0 ? Math.round((n / agg.total) * 100) : null);
  return {
    parTier: agg.parTier,
    toursAuto: agg.toursAuto,
    // T-068 — le total reste servi (il reste vrai POUR LE PORTEFEUILLE), mais
    // ses deux moitiés partent avec lui : l'interface ne peut plus présenter
    // une gratuité globale sans dire quelle part consomme le quota.
    partCoutNulPct: pct(agg.coutNulAbo + agg.coutNulLocal),
    partAbonnementPct: pct(agg.coutNulAbo),
    partLocalPct: pct(agg.coutNulLocal),
    mixAbo: [...agg.mixAbo.entries()]
      .map(([model, tours]) => ({ model, tours }))
      .sort((a, b) => b.tours - a.tours),
    debordMoisUsd,
    coutPeriodeUsd: agg.coutUsd,
    coutInconnuTours: agg.coutInconnuTours,
    coutNonRemonteTours: agg.coutNonRemonteTours,
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
  // S2 — index des projets déclarés (config.json) + rattachement des
  // conversations à leur projet (state/project-conversations.json), tous deux
  // en lecture seule.
  const projectIndex = indexProjects(await readDeclaredProjects(), await readConversationProjects());

  const totalsAgg = newAgg();
  const bucketAggs = new Map<string, StatsAgg>();
  const modelAggs = new Map<string, { model: string; engine: string; tours: number; totalTokens: number }>();
  const routageAgg = newRoutageAgg();
  const sobrieteAgg: SobrieteAgg = newSobrieteAgg();
  const escaladeAgg: EscaladeAgg = newEscaladeAgg();
  const projetAggs = new Map<string, ProjetAgg>();

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

    applySobrieteEvent(sobrieteAgg, ev, d);

    applyEscaladeEvent(escaladeAgg, ev);

    applyProjetEvent(projetAggs, ev, projectIndex);

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

  const totals = finalizeAgg(totalsAgg);

  emitter.done(id, {
    totals,
    buckets,
    models,
    routage: finalizeRoutage(routageAgg, debordMoisUsd),
    // T-071 — fiabilité, délégation, cache et distributions (§6 de l'étude).
    sobriete: finalizeSobriete(sobrieteAgg),
    // T-074 — projection minimale {conversationId,ts,model,erreur} : le
    // calcul du signal d'escalade se fait côté UI (escaladeSignal.ts).
    escaladeTours: finalizeEscalade(escaladeAgg),
    // S2 — parts par projet (Chat compris) sur la même période from/to.
    parProjet: finalizeParProjet(projetAggs, totals.totalTokens),
  });
}
