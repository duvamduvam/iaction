/*
 * Lecture défensive du catalogue de modèles (`models.detail`).
 *
 * Feuille pure sortie de sidecar.ts le 2026-08-11, à l'occasion de R8-A : le
 * cliquet de taille refusait d'agrandir sidecar.ts, et il avait raison — du
 * parsing sans effet de bord n'a rien à faire dans le module qui tient les
 * abonnements Tauri. Ici, ça se teste sans fenêtre native.
 *
 * Règle de lecture, inchangée : seul `id` est requis ; tout champ absent ou
 * mal formé est OMIS plutôt que deviné. Les fournisseurs sans métadonnées
 * (Ollama, passerelles minimales) sont la norme, pas l'exception.
 */

/** Tarifs $/million de tokens (déjà convertis côté sidecar depuis le $/token OpenRouter). */
export interface ModelPricing {
  promptUsdPerM?: number;
  completionUsdPerM?: number;
}

/** Métadonnées détaillées d'un modèle (voir docs/protocol.md, `models.detail`). */
export interface ModelDetail {
  id: string;
  name?: string;
  contextLength?: number;
  pricing?: ModelPricing;
  description?: string;
}

/** Parsing défensif de `value.pricing` : nombres finis uniquement, sinon champ omis. */
function toModelPricing(value: unknown): ModelPricing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const pricing: ModelPricing = {};
  if (typeof p.promptUsdPerM === "number" && Number.isFinite(p.promptUsdPerM)) {
    pricing.promptUsdPerM = p.promptUsdPerM;
  }
  if (typeof p.completionUsdPerM === "number" && Number.isFinite(p.completionUsdPerM)) {
    pricing.completionUsdPerM = p.completionUsdPerM;
  }
  return pricing.promptUsdPerM !== undefined || pricing.completionUsdPerM !== undefined
    ? pricing
    : undefined;
}

/** Parsing défensif d'une entrée brute `models.detail` : `null` si elle n'a pas d'`id`. */
export function toModelDetail(value: Record<string, unknown>): ModelDetail | null {
  if (typeof value.id !== "string" || !value.id) return null;
  const model: ModelDetail = { id: value.id };
  if (typeof value.name === "string" && value.name) model.name = value.name;
  if (typeof value.contextLength === "number" && Number.isFinite(value.contextLength)) {
    model.contextLength = value.contextLength;
  }
  if (typeof value.description === "string" && value.description) model.description = value.description;
  const pricing = toModelPricing(value.pricing);
  if (pricing) model.pricing = pricing;
  return model;
}
