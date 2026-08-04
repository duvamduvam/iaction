/*
 * Bus d'événements module-scope pour l'encart « Contexte » de l'en-tête
 * (App.tsx), sur le même modèle que usageBus.ts : les pages de conversation
 * publient la taille de contexte de leur fil courant sans que l'en-tête ait
 * à les connaître.
 *
 * Les pages restent TOUTES montées (voir `.page-slot--hidden`, App.tsx) :
 * chacune publie donc sous sa propre clé (`source`) et l'en-tête lit celle
 * de la page visible, sinon deux fils se disputeraient l'encart.
 *
 * Ce module expose aussi les fenêtres de contexte connues par modèle : le
 * protocole sidecar ne les remonte pas (`ModelInfo` n'a qu'un `id`), donc
 * faute d'une source d'autorité on retombe sur une table de correspondances.
 */

export type ContextSource = "agent" | "chat";

export interface ContextInfo {
  /** Modèle du fil (id brut, ex. « claude-opus-4-8 »). */
  model: string;
  /** Tokens de contexte du dernier tour connu (voir contextTokens côté pages). */
  usedTokens: number;
}

type ContextListener = () => void;

const listeners = new Set<ContextListener>();
const current = new Map<ContextSource, ContextInfo | null>();

/** Publie (ou efface, avec `null`) le contexte du fil courant d'une page. */
export function publishContext(source: ContextSource, info: ContextInfo | null): void {
  const prev = current.get(source) ?? null;
  if (prev?.model === info?.model && prev?.usedTokens === info?.usedTokens) return;
  current.set(source, info);
  for (const cb of listeners) cb();
}

export function readContext(source: ContextSource): ContextInfo | null {
  return current.get(source) ?? null;
}

export function subscribeContext(cb: ContextListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/*
 * Action « Compacter » de l'encart contexte : quand la jauge de la page
 * visible dépasse COMPACT_BUTTON_RATIO, l'en-tête propose un bouton qui
 * déclenche la compaction du fil courant — l'action appartient à la page
 * (Projets : « /compact » au CLI Claude ; Chat : recompaction R4), qui
 * l'enregistre ici (null = indisponible : pas de session, tour en cours…).
 */

/** Fraction de la fenêtre au-delà de laquelle l'en-tête propose « Compacter ». */
export const COMPACT_BUTTON_RATIO = 0.5;

/**
 * Seuil ABSOLU (tokens) qui propose aussi « Compacter », quel que soit le
 * pourcentage : quand la fenêtre est recalée sur le palier 1M (voir
 * contextWindowFor), 313 k tokens ne font que 31 % — sous le ratio — alors
 * que c'est précisément le moment de compacter (cas réel du 2026-07-31).
 */
export const COMPACT_BUTTON_MIN_TOKENS = 100_000;

type CompactHandler = () => void;
const compactHandlers = new Map<ContextSource, CompactHandler | null>();

export function registerCompactHandler(source: ContextSource, handler: CompactHandler | null): void {
  compactHandlers.set(source, handler);
  for (const cb of listeners) cb();
}

export function readCompactHandler(source: ContextSource): CompactHandler | null {
  return compactHandlers.get(source) ?? null;
}

/*
 * Fenêtres de contexte par modèle, en tokens. Correspondance par sous-chaîne
 * sur l'id (les ids OpenRouter sont préfixés du vendeur, ex.
 * « anthropic/claude-sonnet-5 ») : première entrée qui matche, donc les
 * variantes les plus spécifiques d'abord (« [1m] » avant « opus »).
 */
const CONTEXT_WINDOWS: { match: string; tokens: number }[] = [
  { match: "[1m]", tokens: 1_000_000 },
  { match: "claude-opus-4-8", tokens: 200_000 },
  { match: "claude-fable-5", tokens: 200_000 },
  { match: "claude-sonnet-5", tokens: 200_000 },
  { match: "claude-haiku-4-5", tokens: 200_000 },
  { match: "claude", tokens: 200_000 },
  { match: "gpt-5", tokens: 400_000 },
  { match: "gpt-4.1", tokens: 1_000_000 },
  { match: "gpt-4o", tokens: 128_000 },
  { match: "o3", tokens: 200_000 },
  { match: "gemini", tokens: 1_000_000 },
  { match: "llama-3", tokens: 128_000 },
  { match: "mistral", tokens: 128_000 },
  { match: "qwen", tokens: 128_000 },
  { match: "deepseek", tokens: 128_000 },
];

/**
 * Fenêtre de contexte du modèle, ou `null` si inconnue (pas de % affiché).
 *
 * `usedTokens` (occupation observée du dernier appel) sert de correctif : si
 * l'API a ACCEPTÉ un prompt plus grand que la fenêtre de la table, c'est la
 * table qui a tort — le fil tourne en contexte étendu. Cas réel du 2026-07-31 :
 * 313 k tokens acceptés sur `claude-opus-4-8` (bêta context-1m activée par le
 * CLI selon l'abonnement, invisible dans l'id — pas de « [1m] ») ⇒ jauge à
 * 137 %. Pour les modèles Claude on recale alors sur le palier connu 1M ;
 * pour les autres, fenêtre inconnue (tokens affichés sans %).
 */
export function contextWindowFor(model: string, usedTokens?: number): number | null {
  const id = model.toLowerCase();
  for (const { match, tokens } of CONTEXT_WINDOWS) {
    if (!id.includes(match)) continue;
    if (typeof usedTokens === "number" && usedTokens > tokens) {
      return id.includes("claude") ? 1_000_000 : null;
    }
    return tokens;
  }
  return null;
}

/** « 12345 » → « 12 k », « 200000 » → « 200 k », « 1000000 » → « 1 M ». */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(".", ",")} k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)} k`;
  return `${(count / 1_000_000).toFixed(1).replace(".", ",").replace(",0", "")} M`;
}
