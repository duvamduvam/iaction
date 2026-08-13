/*
 * Parseurs du protocole — la moitié UI du contrat décrit dans docs/protocol.md.
 *
 * ── Pourquoi une feuille séparée de sidecar.ts ──────────────────────────
 * Ces parseurs sont TOLÉRANTS par conception : un champ absent devient null,
 * jamais une erreur. Bonne propriété pour la robustesse, catastrophique pour
 * la détection — une rupture de contrat ne casse rien, une fonctionnalité
 * disparaît en silence (le coût réel d'un tour n'a jamais été affiché pendant
 * des semaines pour cette raison). Le seul filet possible est un test qui les
 * confronte aux ÉCHANTILLONS TÉMOINS émis par le vrai sidecar
 * (fixtures/protocole/, vérifiés des deux côtés).
 *
 * Or sidecar.ts s'abonne aux événements Tauri au chargement du module : tout
 * test qui l'importe parle à une fenêtre native inexistante. D'où cette
 * feuille — aucun import, testable telle quelle. sidecar.ts ré-exporte tout,
 * aucun appelant n'a changé.
 */

export interface ChatUsage {
  /** `null` si le fournisseur ne remonte pas ce compteur (le coût peut l'être sans lui). */
  promptTokens: number | null;
  /** Idem — voir `parseChatDone` : les champs sont optionnels INDÉPENDAMMENT. */
  completionTokens: number | null;
  /** R0 — coût réel remonté par le fournisseur (comptabilité d'usage OpenRouter), null si absent. */
  costUsd?: number | null;
  /** R0 — tokens servis depuis le cache, null si absent. */
  cachedTokens?: number | null;
}

export interface ChatDoneData {
  finishReason: string;
  usage: ChatUsage | null;
  /** R0 — slug du modèle réellement servi (modèles de secours OpenRouter), null si inconnu. */
  modelUsed: string | null;
}

export function parseChatDone(data: Record<string, unknown>): ChatDoneData {
  const finishReason = typeof data.finishReason === "string" ? data.finishReason : "stop";
  let usage: ChatUsage | null = null;
  const rawUsage = data.usage;
  if (rawUsage && typeof rawUsage === "object") {
    const u = rawUsage as Record<string, unknown>;
    // Chaque champ est optionnel INDÉPENDAMMENT : le sidecar émet un usage à
    // champs nullables (voir engine.ts), parce que tous les fournisseurs ne
    // remontent pas les mêmes chiffres. Exiger les deux compteurs de tokens
    // faisait jeter l'objet ENTIER quand un fournisseur ne donnait que le
    // coût : le prix réel du tour n'était jamais affiché, alors que le sidecar
    // l'avait transmis et enregistré dans events.jsonl.
    const nombreOuNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
    const aUneValeur =
      typeof u.promptTokens === "number" ||
      typeof u.completionTokens === "number" ||
      typeof u.costUsd === "number";
    if (aUneValeur) {
      usage = {
        promptTokens: nombreOuNull(u.promptTokens),
        completionTokens: nombreOuNull(u.completionTokens),
        costUsd: nombreOuNull(u.costUsd),
        cachedTokens: nombreOuNull(u.cachedTokens),
      };
    }
  }
  const modelUsed = typeof data.modelUsed === "string" && data.modelUsed ? data.modelUsed : null;
  return { finishReason, usage, modelUsed };
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

/** Données extraites du `done` d'un `claude.start` (un tour de conversation). */
export interface ClaudeDoneData {
  sessionId: string;
  subtype: string;
  result?: string;
  usage: ClaudeUsage | null;
  /**
   * Occupation réelle de la fenêtre de contexte au dernier appel API du tour,
   * en tokens — sert la jauge « Contexte » de l'en-tête. À NE PAS confondre
   * avec `usage`, qui cumule tous les appels du tour agentique (son cache_read
   * additionne N fois le préfixe, d'où des « contextes » à plusieurs centaines
   * de %). `null` si le sidecar ne l'a pas remonté (tour sans appel modèle, ou
   * version antérieure).
   */
  contextTokens: number | null;
  totalCostUsd: number | null;
}

export function parseClaudeDone(data: Record<string, unknown>): ClaudeDoneData {
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  const subtype = typeof data.subtype === "string" ? data.subtype : "success";
  const result = typeof data.result === "string" ? data.result : undefined;

  let usage: ClaudeUsage | null = null;
  if (data.usage && typeof data.usage === "object") {
    const u = data.usage as Record<string, unknown>;
    if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
      usage = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadInputTokens:
          typeof u.cacheReadInputTokens === "number" ? u.cacheReadInputTokens : undefined,
      };
    }
  }

  const contextTokens = typeof data.contextTokens === "number" ? data.contextTokens : null;
  const totalCostUsd = typeof data.totalCostUsd === "number" ? data.totalCostUsd : null;
  return { sessionId, subtype, result, usage, contextTokens, totalCostUsd };
}

/** Données extraites du `done` d'un `neutral.start` : même forme que `parseClaudeDone`, sessionId/totalCostUsd toujours `null`. */
export interface NeutralDoneData {
  sessionId: null;
  subtype: string;
  result?: string;
  usage: ClaudeUsage | null;
  totalCostUsd: null;
}

export function parseNeutralDone(data: Record<string, unknown>): NeutralDoneData {
  const subtype = typeof data.subtype === "string" ? data.subtype : "success";
  const result = typeof data.result === "string" ? data.result : undefined;

  let usage: ClaudeUsage | null = null;
  if (data.usage && typeof data.usage === "object") {
    const u = data.usage as Record<string, unknown>;
    if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
      usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
    }
  }

  return { sessionId: null, subtype, result, usage, totalCostUsd: null };
}

import type { RouteDebord, RouteTarget, RouteTier } from "./sidecar";

export function isRouteTier(value: unknown): value is RouteTier {
  return value === "trivial" || value === "simple" || value === "moyen" || value === "complexe";
}

/** Parsing défensif d'une cible `{engine, providerId?, model}` — null si invalide. */
export function toRouteTarget(value: unknown): RouteTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.engine !== "claude" && v.engine !== "neutral") return null;
  if (typeof v.model !== "string" || !v.model) return null;
  if (v.engine === "neutral") {
    if (typeof v.providerId !== "string" || !v.providerId) return null;
    return { engine: "neutral", providerId: v.providerId, model: v.model };
  }
  return { engine: "claude", model: v.model };
}

/** R3 — parsing défensif (sorti de sidecar.ts, sa place est ici avec isRouteTier/toRouteTarget) du champ `debord` d'un `router.route` (absent/inconnu → null). */
export function toRouteDebord(value: unknown): RouteDebord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.active !== "boolean") return null;
  return {
    active: v.active,
    blocked: v.blocked === true,
    fiveHourPct: typeof v.fiveHourPct === "number" && Number.isFinite(v.fiveHourPct) ? v.fiveHourPct : null,
    sevenDayPct: typeof v.sevenDayPct === "number" && Number.isFinite(v.sevenDayPct) ? v.sevenDayPct : null,
  };
}
