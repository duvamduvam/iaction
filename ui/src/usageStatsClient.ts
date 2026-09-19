/*
 * Wrappers typés pour les méthodes S1 — supervision d'usage (voir
 * docs/protocol.md § « Méthodes S1 — supervision d'usage (Lot 8, tranche 1) »).
 * Même style défensif que sidecar.ts : tout champ manquant/mal typé côté
 * sidecar est simplement omis/neutralisé plutôt que de faire planter l'UI.
 */
import { request } from "./sidecar";
import type { TourPourEscalade } from "./escaladeSignal";

export type UsageBucketKind = "day" | "week" | "month";

export interface UsageTotals {
  tours: number;
  orchTours: number;
  conversations: number;
  /**
   * T-067 — médiane de l'occupation RÉELLE du contexte (`contextTokens`).
   * `null` si aucun tour de la période n'a de contexte relevé. Remplace
   * `avgPromptTokens`, qui mesurait `input_tokens` hors cache : médiane de
   * 6 tokens sur 1 031 tours, soit rien.
   */
  contexteMedian: number | null;
  totalTokens: number;
}

export interface UsageBucket {
  /** Date `YYYY-MM-DD` de début du bucket (jour/lundi de semaine ISO/1er du mois). */
  start: string;
  tours: number;
  orchTours: number;
  conversations: number;
  /** T-067 — voir `UsageTotals.contexteMedian`. */
  contexteMedian: number | null;
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
  /**
   * Part des tours hors facturation API (abonnement Claude + providers locaux),
   * `null` si aucun tour. **Vrai pour le portefeuille, faux pour la ressource** :
   * un tour d'abonnement consomme le quota, la seule chose qui sature ici — d'où
   * les deux moitiés ci-dessous, servies avec (T-068).
   */
  partCoutNulPct: number | null;
  /** T-068 — part des tours d'ABONNEMENT : gratuite en dollars, payée en quota. */
  partAbonnementPct: number | null;
  /** T-068 — part des tours LOCAUX : ni dollars, ni quota. */
  partLocalPct: number | null;
  /** Mix intra-abonnement : tours moteur claude par modèle, trié décroissant. */
  mixAbo: Array<{ model: string; tours: number }>;
  /** Dépense de débord du mois calendaire courant (USD), comparée au plafond. */
  debordMoisUsd: number;
  /**
   * S3 — dépense RÉELLE de la période (USD) : tout le payant, débord automatique
   * ET choix manuel. `debordMoisUsd` n'en couvre qu'une fraction — voir T-035.
   */
  coutPeriodeUsd: number;
  /** S3 — tours payants sans coût remonté : la dépense affichée est un minorant. */
  coutInconnuTours: number;
  /** T-036 — tours dont le fournisseur ne remonte structurellement aucun coût. */
  coutNonRemonteTours: number;
}

/**
 * S2 — part d'un projet dans l'usage de la période (le Chat est un projet à
 * part entière, `projectId: "chat"` ; `projectId: null` = résidu « (non
 * attribué) » : tours historisés avant S2 ou sans projet identifiable).
 */
export interface UsageProjet {
  projectId: string | null;
  name: string;
  tours: number;
  totalTokens: number;
  /** Part des tokens de la période (arrondie), `null` si aucun token compté. */
  partTokensPct: number | null;
  /** Tours (et tokens) issus d'une orchestration : la part « autonome » du projet. */
  autonomeTours: number;
  autonomeTokens: number;
  /** Part autonome DANS le projet (arrondie), `null` si le projet n'a aucun token. */
  autonomePct: number | null;
}

/**
 * T-071 — agrégat « sobriété » (voir docs/etude-supervision.md §6).
 *
 * Deux régimes cohabitent, et l'UI DOIT les distinguer :
 * - la fiabilité et les heures se calculent sur tout l'historique ;
 * - tout ce qui vient de la ventilation T-066 n'existe que pour les tours
 *   enregistrés depuis. D'où `toursVentiles` : un pourcentage sans son
 *   dénominateur serait un chiffre faux qui a l'air juste (leçon T-035).
 */
export interface UsageSobriete {
  toursErreur: number;
  toursAbandon: number;
  parCause: Array<{ cause: string; tours: number }>;
  /** T-082 — ventilation des tours INTERROMPUS, tenue à part des pannes. */
  parCauseAbandon: Array<{ cause: string; tours: number }>;
  /** Dénominateur des grandeurs de ventilation. `0` = rien à afficher, et le dire. */
  toursVentiles: number;
  toursAvecDelegation: number;
  tokensFil: number;
  tokensDelegue: number;
  tokensRoleInconnu: number;
  parModeleReel: Array<{ model: string; tokens: number; costUsd: number; toursDelegue: number }>;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** `null` tant qu'aucune entrée n'a été mesurée — jamais 0 %. */
  cacheHitPct: number | null;
  coutVentileUsd: number;
  toursAvecCout: number;
  /** Part du coût portée par les 10 % de tours les plus chers. */
  concentrationTop10Pct: number | null;
  coutTourMedianUsd: number | null;
  coutTourMaxUsd: number | null;
  contexteMedian: number | null;
  contexteP90: number | null;
  dureeMedianeMs: number | null;
  dureeP90Ms: number | null;
  /** 24 entrées, heure LOCALE. */
  heures: number[];
}

export interface UsageStats {
  totals: UsageTotals;
  buckets: UsageBucket[];
  models: UsageModelStat[];
  /** R3 — `null` avec un sidecar antérieur (champ absent). */
  routage: UsageRoutage | null;
  /** S2 — `null` avec un sidecar antérieur (champ absent). */
  parProjet: UsageProjet[] | null;
  /** T-071 — `null` avec un sidecar antérieur (champ absent). */
  sobriete: UsageSobriete | null;
  /**
   * T-074 — projection MINIMALE par tour {conversationId, ts, model, erreur},
   * juste ce dont `calculerSignalEscalade` (escaladeSignal.ts) a besoin pour
   * repérer une escalade — jamais un pré-calcul côté sidecar : l'algorithme
   * ne vit qu'à un seul endroit, testé. `null` avec un sidecar antérieur
   * (champ absent), `[]` si le sidecar répond mais qu'aucun tour de la
   * période ne porte de `conversationId` exploitable — les deux ne se
   * confondent jamais (T-035).
   */
  escaladeTours: TourPourEscalade[] | null;
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
    contexteMedian: toNumOrNull(v.contexteMedian),
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
    contexteMedian: toNumOrNull(v.contexteMedian),
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
    partAbonnementPct: toNumOrNull(v.partAbonnementPct),
    partLocalPct: toNumOrNull(v.partLocalPct),
    mixAbo,
    debordMoisUsd: toNum(v.debordMoisUsd),
    // S3 — absents d'un sidecar antérieur : 0, la carte affiche « — ».
    coutPeriodeUsd: toNum(v.coutPeriodeUsd),
    coutInconnuTours: toNum(v.coutInconnuTours),
    coutNonRemonteTours: toNum(v.coutNonRemonteTours),
  };
}

/** S2 — parsing défensif de `parProjet` (absent → null : sidecar antérieur). */
function parseParProjet(value: unknown): UsageProjet[] | null {
  if (!Array.isArray(value)) return null;
  const out: UsageProjet[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    out.push({
      projectId: typeof v.projectId === "string" ? v.projectId : null,
      name: toStr(v.name, "(non attribué)"),
      tours: toNum(v.tours),
      totalTokens: toNum(v.totalTokens),
      partTokensPct: toNumOrNull(v.partTokensPct),
      autonomeTours: toNum(v.autonomeTours),
      autonomeTokens: toNum(v.autonomeTokens),
      autonomePct: toNumOrNull(v.autonomePct),
    });
  }
  return out;
}

/** T-071 — parsing défensif de l'agrégat `sobriete` (absent/mal formé → null). */
function parseSobriete(value: unknown): UsageSobriete | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  // T-082 — deux listes de même forme (pannes, interruptions) : un sidecar
  // antérieur n'envoie pas la seconde, elle vaut alors [] et l'encart se tait.
  const listeCauses = (brut: unknown): Array<{ cause: string; tours: number }> => {
    const out: Array<{ cause: string; tours: number }> = [];
    if (!Array.isArray(brut)) return out;
    for (const raw of brut) {
      if (raw && typeof raw === "object") {
        const c = raw as Record<string, unknown>;
        out.push({ cause: toStr(c.cause, "(inconnue)"), tours: toNum(c.tours) });
      }
    }
    return out;
  };
  const causes = listeCauses(v.parCause);
  const modeles: UsageSobriete["parModeleReel"] = [];
  if (Array.isArray(v.parModeleReel)) {
    for (const raw of v.parModeleReel) {
      if (raw && typeof raw === "object") {
        const m = raw as Record<string, unknown>;
        modeles.push({
          model: toStr(m.model, "(inconnu)"),
          tokens: toNum(m.tokens),
          costUsd: toNum(m.costUsd),
          toursDelegue: toNum(m.toursDelegue),
        });
      }
    }
  }
  // 24 cases toujours, même si le sidecar en renvoie moins : un graphe d'heures
  // à trous se dessinerait de travers sans que rien ne le signale.
  const heures = new Array<number>(24).fill(0);
  if (Array.isArray(v.heures)) {
    v.heures.slice(0, 24).forEach((h, i) => {
      heures[i] = toNum(h);
    });
  }
  return {
    toursErreur: toNum(v.toursErreur),
    toursAbandon: toNum(v.toursAbandon),
    parCause: causes,
    parCauseAbandon: listeCauses(v.parCauseAbandon),
    toursVentiles: toNum(v.toursVentiles),
    toursAvecDelegation: toNum(v.toursAvecDelegation),
    tokensFil: toNum(v.tokensFil),
    tokensDelegue: toNum(v.tokensDelegue),
    tokensRoleInconnu: toNum(v.tokensRoleInconnu),
    parModeleReel: modeles,
    cacheReadTokens: toNum(v.cacheReadTokens),
    cacheCreationTokens: toNum(v.cacheCreationTokens),
    cacheHitPct: toNumOrNull(v.cacheHitPct),
    coutVentileUsd: toNum(v.coutVentileUsd),
    toursAvecCout: toNum(v.toursAvecCout),
    concentrationTop10Pct: toNumOrNull(v.concentrationTop10Pct),
    coutTourMedianUsd: toNumOrNull(v.coutTourMedianUsd),
    coutTourMaxUsd: toNumOrNull(v.coutTourMaxUsd),
    contexteMedian: toNumOrNull(v.contexteMedian),
    contexteP90: toNumOrNull(v.contexteP90),
    dureeMedianeMs: toNumOrNull(v.dureeMedianeMs),
    dureeP90Ms: toNumOrNull(v.dureeP90Ms),
    heures,
  };
}

/**
 * T-074 — parsing défensif de la projection `escaladeTours` (absent → null :
 * sidecar antérieur ; mal formé → ligne ignorée plutôt que devinée).
 */
function parseEscaladeTours(value: unknown): TourPourEscalade[] | null {
  if (!Array.isArray(value)) return null;
  const out: TourPourEscalade[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const v = raw as Record<string, unknown>;
    if (typeof v.conversationId !== "string" || typeof v.ts !== "string") continue;
    out.push({
      conversationId: v.conversationId,
      ts: v.ts,
      model: toStr(v.model, "(inconnu)"),
      erreur: v.erreur === true,
    });
  }
  return out;
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
  return {
    totals: parseTotals(data.totals),
    buckets,
    models,
    routage: parseRoutage(data.routage),
    parProjet: parseParProjet(data.parProjet),
    sobriete: parseSobriete(data.sobriete),
    escaladeTours: parseEscaladeTours(data.escaladeTours),
  };
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
