/*
 * R8-A — Catalogue de modèles : où le lire, et comment le normaliser
 * (docs/spec-r8-profils-fournisseur.md §2).
 *
 * ── Pourquoi ce module existe ──────────────────────────────────────────
 * `GET {baseUrl}/models` n'est pas universel. Mesuré le 2026-08-10 : Swiftask
 * y renvoie 8 slugs figés quand la plateforme en sert 142, et le modèle sur
 * lequel tourne leur PROPRE extension n'y figure pas (T-021). L'endroit du
 * catalogue et la forme de sa réponse deviennent donc des traits déclarés,
 * pas une hypothèse du moteur.
 *
 * ── Pourquoi le filtre `isChatLMM` n'est pas cosmétique ────────────────
 * Les 142 entrées de Swiftask ne sont pas homogènes : transcription, export
 * Excel, vidéo, automatisation de navigateur. Interrogé par
 * `/v1/chat/completions`, `excel_export` répond « Je suis un assistant IA
 * conçu pour répondre à vos questions » — sa fonction d'export a disparu,
 * sans erreur. Une liste à plat laisserait donc choisir « Excel Export »
 * comme cerveau d'un agent, et la dégradation serait muette.
 *
 * ── Ce qu'il ne fait pas ───────────────────────────────────────────────
 * Aucun accès réseau, aucun `joinUrl` (l'URL standard lui est PASSÉE, pour ne
 * pas importer `engine.ts` qui l'importe déjà). Fonctions pures, testables
 * sans serveur.
 */
import { isNonEmptyString, isPlainObject } from "./base.js";
import type { ProviderTraits } from "./profilFournisseur.js";

/** Forme de la réponse du catalogue. `openai` reste le défaut implicite. */
export type FormeCatalogue = "openai" | "slugs";

export interface CibleCatalogue {
  url: string;
  forme: FormeCatalogue;
}

/**
 * Où aller chercher le catalogue. `urlStandard` est le `{baseUrl}/models`
 * calculé par l'appelant : sans trait, la cible ne change pas d'un octet.
 */
export function cibleCatalogue(
  traits: ProviderTraits | undefined,
  urlStandard: string,
): CibleCatalogue {
  return {
    url: traits?.catalogUrl ?? urlStandard,
    forme: traits?.catalogShape ?? "openai",
  };
}

/** Entrées brutes d'une réponse `{data:[…]}` ou `[…]`, quelle que soit la forme. */
function entrees(json: unknown): unknown[] {
  if (isPlainObject(json) && Array.isArray(json.data)) {
    return json.data;
  }
  return Array.isArray(json) ? json : [];
}

/**
 * Normalise la réponse du catalogue en entrées « façon OpenAI » (au minimum un
 * `id` non vide), seule forme que connaissent `models.list` et `models.detail`.
 *
 * - `openai` : comportement d'avant R8, au filtre près sur `id` non vide ;
 * - `slugs`  : `id ← slug`, `name ← name`, et on ne garde que `isChatLMM`.
 *
 * Une entrée sans `slug` non vide est ignorée, exactement comme aujourd'hui
 * une entrée sans `id`.
 */
export function normaliserCatalogue(
  json: unknown,
  forme: FormeCatalogue,
): Array<Record<string, unknown>> {
  const brutes = entrees(json).filter((m): m is Record<string, unknown> => isPlainObject(m));
  if (forme === "openai") {
    return brutes.filter((m) => isNonEmptyString(m.id));
  }
  const out: Array<Record<string, unknown>> = [];
  for (const m of brutes) {
    if (m.isChatLMM !== true || !isNonEmptyString(m.slug)) {
      continue;
    }
    out.push({ id: m.slug, ...(isNonEmptyString(m.name) ? { name: m.name } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Détail d'un modèle — déplacé d'engine.ts (le cliquet lui refusait la place)
// ---------------------------------------------------------------------------

export interface DetailedModel {
  id: string;
  name?: string;
  contextLength?: number;
  pricing?: { promptUsdPerM?: number; completionUsdPerM?: number };
  description?: string;
}

/** Arrondit un $/token OpenRouter (chaîne) en $/million (nombre), ou undefined si invalide. */
function usdPerTokenToPerMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const perToken = Number(value);
  if (!Number.isFinite(perToken)) {
    return undefined;
  }
  // 4 décimales suffisent à représenter les grilles tarifaires usuelles ($/M) sans bruit
  // de virgule flottante (ex. 0.000003 * 1e6 → 3, pas 2.9999999999999996).
  return Math.round(perToken * 1e6 * 10000) / 10000;
}

export function toDetailedModel(m: Record<string, unknown>): DetailedModel {
  const model: DetailedModel = { id: m.id as string };
  if (isNonEmptyString(m.name)) {
    model.name = m.name;
  }
  if (typeof m.context_length === "number" && Number.isFinite(m.context_length)) {
    model.contextLength = m.context_length;
  }
  if (isPlainObject(m.pricing)) {
    const promptUsdPerM = usdPerTokenToPerMillion(m.pricing.prompt);
    const completionUsdPerM = usdPerTokenToPerMillion(m.pricing.completion);
    if (promptUsdPerM !== undefined || completionUsdPerM !== undefined) {
      model.pricing = {
        ...(promptUsdPerM !== undefined ? { promptUsdPerM } : {}),
        ...(completionUsdPerM !== undefined ? { completionUsdPerM } : {}),
      };
    }
  }
  if (isNonEmptyString(m.description)) {
    model.description = m.description;
  }
  return model;
}
