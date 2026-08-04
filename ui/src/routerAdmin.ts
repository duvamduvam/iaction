/*
 * Administration du routage automatique « model: auto » (Lot 14, phases R1+R2) —
 * patron providerAdmin.ts, en plus simple (aucun secret) :
 * - config non-secrète, clé racine "routing" = `{ table: Partial<RoutingTable>,
 *   classifier?: ClassifierConfig | null, debord?: DebordConfig }` (lecture →
 *   fusion → écriture du document complet via appConfig.ts) — `classifier`
 *   absent = défaut du sidecar, `null` = classificateur LLM désactivé (R2) ;
 *   `debord` (R3) absent = défauts du sidecar (openrouter · deepseek, seuil
 *   90 %, plafond 10 $), `null` = bascule payante automatique désactivée (R6) ;
 *   `summarizer` (R4) absent = le résumeur de compaction suit le
 *   classificateur, objet = cible dédiée, `null` = compaction automatique
 *   désactivée — clé consommée par l'UI seule (jamais poussée via router.set) ;
 * - `pushRouting` : envoi de la table (+ classificateur + débord) au sidecar
 *   via `router.set` ;
 * - `initRoutingPush` : push au démarrage et à chaque redémarrage du sidecar,
 *   accroché au signal « table des fournisseurs poussée » (providersBus) — le
 *   même « sidecar prêt » que les autres consommateurs, sans dupliquer la
 *   mécanique de retentatives de useProviders (providers.set réussi ⇒ le
 *   sidecar accepte aussi router.set).
 */
import { readConfig, writeConfig } from "./appConfig";
import { subscribeProvidersPushed } from "./providersBus";
import {
  routerSet,
  toRouteTarget,
  type ClassifierConfig,
  type DebordConfig,
  type EmbeddingsConfig,
  type RouteTier,
  type RoutingTable,
} from "./sidecar";

/** Ordre canonique des tiers (affichage + repli trivial→simple→moyen→complexe). */
export const ROUTE_TIERS: readonly RouteTier[] = ["trivial", "simple", "moyen", "complexe"];

/**
 * R7 — plancher de session (spec-r7-topdown §B.2) : le plus haut des deux
 * tiers selon l'ordre canonique — utilisé par ChatPage/AgentPage pour ne
 * jamais faire redescendre `routedTier` (`null` = pas encore de plancher).
 */
export function maxRouteTier(floor: RouteTier | null, tier: RouteTier): RouteTier {
  return floor !== null && ROUTE_TIERS.indexOf(floor) > ROUTE_TIERS.indexOf(tier) ? floor : tier;
}

/** Identique aux défauts codés en dur du sidecar (sidecar/src/router.ts, spec R1 §1.1). */
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  trivial: { engine: "claude", model: "claude-haiku-4-5" },
  simple: { engine: "claude", model: "claude-sonnet-5" },
  moyen: { engine: "claude", model: "claude-opus-4-8" },
  complexe: { engine: "claude", model: "claude-fable-5" },
};

/** R2 — SUGGESTION de préremplissage du classificateur (défaut effectif : désactivé,
 * heuristique seule — identique au sidecar depuis 2026-07-29). */
export const DEFAULT_CLASSIFIER: ClassifierConfig = { providerId: "ollama", model: "qwen3.5:4b" };

/** R3 — défauts du débord d'abonnement, identiques au sidecar (spec R3 §1). */
export const DEFAULT_DEBORD: DebordConfig = {
  target: { engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat" },
  seuilPct: 90,
  plafondUsdMois: 10,
};

/** R5 — défaut du modèle d'embeddings du RAG local, identique au sidecar (spec R5 §1). */
export const DEFAULT_EMBEDDINGS: EmbeddingsConfig = { providerId: "ollama", model: "nomic-embed-text" };

/** Objet racine `routing` de la config non-secrète, ou `{}` si absent/corrompu. */
async function readRoutingRoot(): Promise<Record<string, unknown>> {
  const raw = await readConfig();
  const routing = raw.routing;
  if (typeof routing !== "object" || routing === null) return {};
  return routing as Record<string, unknown>;
}

/**
 * Lit la table de routage de la config non-secrète (`{}` si absente) —
 * chaque tier est validé individuellement (une entrée invalide est ignorée,
 * même validation souple que le sidecar).
 */
export async function readRoutingTable(): Promise<Partial<RoutingTable>> {
  const routing = await readRoutingRoot();
  const table = routing.table;
  if (typeof table !== "object" || table === null) return {};
  const out: Partial<RoutingTable> = {};
  for (const tier of ROUTE_TIERS) {
    const target = toRouteTarget((table as Record<string, unknown>)[tier]);
    if (target) out[tier] = target;
  }
  return out;
}

/**
 * R2 — lit la config du classificateur : `null` = désactivé (choix
 * utilisateur), `undefined` = non configuré (défaut du sidecar), objet =
 * provider+modèle choisis. Une valeur invalide retombe sur `undefined`.
 */
export async function readRoutingClassifier(): Promise<ClassifierConfig | null | undefined> {
  const routing = await readRoutingRoot();
  const classifier = routing.classifier;
  if (classifier === null) return null;
  if (typeof classifier !== "object" || classifier === undefined) return undefined;
  const v = classifier as Record<string, unknown>;
  if (typeof v.providerId === "string" && v.providerId && typeof v.model === "string" && v.model) {
    return { providerId: v.providerId, model: v.model };
  }
  return undefined;
}

/**
 * R4 — réglage du résumeur de compaction tel qu'écrit en config
 * (`routing.summarizer`, clé côté UI uniquement — jamais poussée au sidecar,
 * `context.compact` reçoit providerId/model en paramètres) : objet = cible
 * dédiée du résumeur ; `null` = compaction automatique DÉSACTIVÉE (aucun
 * nouveau résumé) ; `"suivre"` = clé omise (le résumeur suit le
 * classificateur, comportement par défaut).
 */
export type SummarizerSetting = ClassifierConfig | null | "suivre";

/**
 * R4 — lit la cible du résumeur de compaction : `null` = compaction
 * automatique désactivée (choix utilisateur), `undefined` = non configuré
 * (le résumeur suit le classificateur, comportement historique), objet =
 * provider+modèle dédiés. Une valeur invalide retombe sur `undefined`.
 */
export async function readRoutingSummarizer(): Promise<ClassifierConfig | null | undefined> {
  const routing = await readRoutingRoot();
  const summarizer = routing.summarizer;
  if (summarizer === null) return null;
  if (typeof summarizer !== "object" || summarizer === undefined) return undefined;
  const v = summarizer as Record<string, unknown>;
  if (typeof v.providerId === "string" && v.providerId && typeof v.model === "string" && v.model) {
    return { providerId: v.providerId, model: v.model };
  }
  return undefined;
}

/**
 * R3 — lit la config de débord, fusionnée champ par champ avec les défauts
 * (une valeur invalide retombe sur son défaut, même validation souple que le
 * sidecar). `plafondUsdMois: null` explicite = pas de plafond.
 * R6 — `debord: null` explicite en config = bascule payante automatique
 * DÉSACTIVÉE (choix utilisateur) → renvoie `null`, à pousser tel quel au
 * sidecar ; absent/corrompu = défauts, comme avant.
 */
export async function readRoutingDebord(): Promise<DebordConfig | null> {
  const routing = await readRoutingRoot();
  const debord = routing.debord;
  if (debord === null) return null;
  const out: DebordConfig = { ...DEFAULT_DEBORD, target: { ...DEFAULT_DEBORD.target } };
  if (typeof debord !== "object") return out;
  const v = debord as Record<string, unknown>;
  const target = toRouteTarget(v.target);
  if (target) out.target = target;
  if (typeof v.seuilPct === "number" && Number.isFinite(v.seuilPct) && v.seuilPct > 0) {
    out.seuilPct = v.seuilPct;
  }
  if (v.plafondUsdMois === null) {
    out.plafondUsdMois = null;
  } else if (typeof v.plafondUsdMois === "number" && Number.isFinite(v.plafondUsdMois) && v.plafondUsdMois >= 0) {
    out.plafondUsdMois = v.plafondUsdMois;
  }
  return out;
}

/**
 * R5 — lit la config du modèle d'embeddings du RAG local : `undefined` = non
 * configuré (défaut du sidecar, ollama · nomic-embed-text). Une valeur
 * invalide retombe sur `undefined` — même validation souple que le
 * classificateur (pas de forme « désactivé » : l'indexation n'a lieu que sur
 * action explicite, voir docs/spec-r5-rag.md).
 */
export async function readRoutingEmbeddings(): Promise<EmbeddingsConfig | undefined> {
  const routing = await readRoutingRoot();
  const embeddings = routing.embeddings;
  if (typeof embeddings !== "object" || embeddings === null) return undefined;
  const v = embeddings as Record<string, unknown>;
  if (typeof v.providerId === "string" && v.providerId && typeof v.model === "string" && v.model) {
    return { providerId: v.providerId, model: v.model };
  }
  return undefined;
}

/**
 * Écrit la config de routage complète dans la config non-secrète (fusion
 * racine, cf. appConfig.ts — la clé `routing` est remplacée en bloc, il faut
 * donc toujours réécrire table, classificateur ET débord ensemble).
 * `classifier`/`debord` `undefined` = clé omise (défauts du sidecar) ;
 * R6 — `debord: null` = bascule payante automatique désactivée (persistée
 * telle quelle, poussée telle quelle au sidecar).
 * R5 — `embeddings` `undefined` = la valeur déjà en config est REPORTÉE telle
 * quelle (le formulaire routage de la page Configuration ne l'édite pas :
 * une sauvegarde ne doit jamais l'effacer).
 * R4 — `summarizer` `undefined` = la valeur déjà en config est REPORTÉE telle
 * quelle (jamais effacée par un appelant qui ne la connaît pas) ; `"suivre"`
 * = clé omise (le résumeur suit le classificateur) ; `null` = compaction
 * automatique désactivée. Clé UI uniquement : rien n'est poussé au sidecar.
 */
export async function writeRoutingTable(
  table: Partial<RoutingTable>,
  classifier?: ClassifierConfig | null,
  debord?: DebordConfig | null,
  embeddings?: EmbeddingsConfig,
  summarizer?: SummarizerSetting,
): Promise<void> {
  const carriedEmbeddings = embeddings ?? (await readRoutingEmbeddings());
  const carriedSummarizer = summarizer !== undefined ? summarizer : await readRoutingSummarizer();
  await writeConfig({
    routing: {
      table,
      ...(classifier !== undefined ? { classifier } : {}),
      ...(debord !== undefined ? { debord } : {}),
      ...(carriedEmbeddings !== undefined ? { embeddings: carriedEmbeddings } : {}),
      ...(carriedSummarizer !== undefined && carriedSummarizer !== "suivre"
        ? { summarizer: carriedSummarizer }
        : {}),
    },
  });
}

/** Table effective : défauts complétés par la config — celle que le sidecar applique. */
export function mergeRoutingTable(partial: Partial<RoutingTable>): RoutingTable {
  return { ...DEFAULT_ROUTING_TABLE, ...partial };
}

/** Pousse table + classificateur + débord + embeddings au sidecar (`router.set`).
 * R6 — `debord: null` = bascule payante automatique désactivée (contrat
 * `router.set`). R5 — `embeddings` absent = relu depuis la config (jamais
 * réinitialisé par un appelant qui ne le connaît pas). Renvoie le nb de tiers
 * retenus. */
export async function pushRouting(
  table: Partial<RoutingTable>,
  classifier?: ClassifierConfig | null,
  debord?: DebordConfig | null,
  embeddings?: EmbeddingsConfig,
): Promise<number> {
  const effectiveEmbeddings = embeddings ?? (await readRoutingEmbeddings());
  return routerSet(table, classifier, debord, effectiveEmbeddings);
}

/**
 * Push automatique de la config de routage : à chaque « providers poussés »
 * (démarrage, `ready` du sidecar après redémarrage, modification dans
 * l'admin), relit la config et pousse table + classificateur — best effort,
 * un échec ne bloque rien (les défauts du sidecar restent alors en vigueur).
 * Renvoie la fonction de désabonnement (cycle de vie d'un effet React).
 */
export function initRoutingPush(): () => void {
  return subscribeProvidersPushed(() => {
    void Promise.all([readRoutingTable(), readRoutingClassifier(), readRoutingDebord()])
      .then(([table, classifier, debord]) => pushRouting(table, classifier, debord))
      .catch(() => {
        // best effort : le prochain signal (ou une sauvegarde) retentera.
      });
  });
}
