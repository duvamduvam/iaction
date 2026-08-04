/*
 * Modèles « mis en avant » (favoris) par fournisseur + repères de benchmark
 * curatés statiquement, pour la section « Modèles OpenRouter » de la page
 * Configuration et les sélecteurs de modèles (ChatPage/AgentPage).
 *
 * Persistance des favoris : config non-secrète, clé racine "featuredModels"
 * = {[providerId]: string[]}, fusion via appConfig.ts (même pattern que
 * appsAdmin.ts/projectAdmin.ts — lecture → fusion → écriture du document
 * complet, jamais d'écriture partielle directe).
 */
import { readConfig, writeConfig } from "./appConfig";

export type FeaturedModelsMap = Record<string, string[]>;

function isFeaturedModelsMap(value: unknown): value is FeaturedModelsMap {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  );
}

async function readFeaturedMap(): Promise<FeaturedModelsMap> {
  const raw = await readConfig();
  return isFeaturedModelsMap(raw.featuredModels) ? raw.featuredModels : {};
}

/** Ids des modèles mis en avant pour ce fournisseur (ordre = ordre d'ajout). `[]` si aucun. */
export async function readFeatured(providerId: string): Promise<string[]> {
  const map = await readFeaturedMap();
  return map[providerId] ?? [];
}

/** Ajoute/retire `modelId` des favoris du fournisseur, persiste, renvoie la liste à jour. */
export async function toggleFeatured(providerId: string, modelId: string): Promise<string[]> {
  const map = await readFeaturedMap();
  const current = map[providerId] ?? [];
  const next = current.includes(modelId) ? current.filter((id) => id !== modelId) : [...current, modelId];
  await writeConfig({ featuredModels: { ...map, [providerId]: next } });
  return next;
}

/**
 * Sépare `featuredIds` en modèles réellement présents dans `models`, dans l'ordre
 * de `featuredIds` — pour l'optgroup « Mis en avant » des sélecteurs de modèles
 * (ChatPage/AgentPage, fournisseurs neutres uniquement).
 */
export function splitFeatured<T extends { id: string }>(models: T[], featuredIds: string[]): T[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const out: T[] = [];
  for (const id of featuredIds) {
    const m = byId.get(id);
    if (m) out.push(m);
  }
  return out;
}

/* ---------- Repères de benchmark (curatés à la main, statiques) ---------- */

/**
 * Avertissement affiché partout où une note de benchmark apparaît : ces
 * repères sont écrits à la main à partir des publications éditeurs
 * (mi-2026), PAS d'un flux de mesure en direct — à traiter comme une
 * indication grossière, pas une source d'arbitrage fine.
 */
export const BENCH_DISCLAIMER =
  "Repères indicatifs (publications éditeurs, mi-2026) — pas de flux temps réel.";

interface BenchNote {
  pattern: RegExp;
  note: string;
}

/**
 * Table curatée par grande famille de modèles (pas par id exact : un modèle
 * inconnu de cette liste n'a simplement pas de badge). Notes volontairement
 * courtes, un ordre de grandeur + un trait marquant, jamais un chiffre
 * présenté comme définitif (voir BENCH_DISCLAIMER).
 */
export const BENCH_NOTES: BenchNote[] = [
  { pattern: /claude-opus/i, note: "≈92 MMLU-Pro · référence raisonnement/agentique" },
  { pattern: /claude-sonnet/i, note: "≈88 MMLU-Pro · excellent rapport perf/coût, très bon code" },
  { pattern: /claude-haiku/i, note: "≈80 MMLU-Pro · rapide et économique" },
  { pattern: /claude-fable/i, note: "abonnement Claude Code · usage agentique intégré" },
  { pattern: /gpt-5/i, note: "≈90 MMLU-Pro · généraliste très solide, bon raisonnement" },
  { pattern: /gpt-4/i, note: "≈86 MMLU-Pro · généraliste éprouvé" },
  { pattern: /o[134](-mini|-preview)?(-|$)/i, note: "raisonnement renforcé (chaîne de pensée longue)" },
  { pattern: /gemini-3/i, note: "≈91 MMLU-Pro · fort en multimodal, grand contexte" },
  { pattern: /gemini-2/i, note: "≈85 MMLU-Pro · bon rapport perf/contexte" },
  { pattern: /llama-4/i, note: "≈83 MMLU-Pro · open-weight, bon généraliste" },
  { pattern: /llama-3/i, note: "≈78 MMLU-Pro · open-weight, très répandu" },
  { pattern: /qwen/i, note: "≈82 MMLU-Pro · fort en code/multilingue, open-weight" },
  { pattern: /deepseek/i, note: "≈83 MMLU-Pro · excellent rapport perf/prix, fort en code" },
  { pattern: /mistral/i, note: "≈75 MMLU-Pro · rapide, bon rapport perf/prix" },
  { pattern: /grok/i, note: "≈85 MMLU-Pro · bon raisonnement, gros contexte" },
];

/** Note curatée correspondant à `modelId` (première entrée qui matche), sinon `null`. */
export function matchBenchNote(modelId: string): string | null {
  return BENCH_NOTES.find((entry) => entry.pattern.test(modelId))?.note ?? null;
}
