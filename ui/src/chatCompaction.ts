/*
 * Compaction de contexte du moteur NEUTRE (R4) et construction du fil `chat.send`,
 * extraites de ChatPage.tsx (cliquet de taille). Import de TYPES seuls depuis la page.
 */
import type { ChatMessage } from "./sidecar";
import type { ChatEntry } from "./ChatPage";

/*
 * R4 — économie de contexte du moteur NEUTRE (docs/spec-r4-contexte.md) : sur
 * les longues conversations, les anciens tours sont remplacés à l'envoi par un
 * résumé produit par un modèle local (`context.compact`), sans jamais toucher
 * à la transcription AFFICHÉE. Côté Claude : rien (compaction SDK existante).
 * Constantes et logique identiques à sidecar/src/context.ts, où les fonctions
 * pures (`shouldCompact`, `buildCompactedMessages`) sont testées — même
 * duplication assumée que la table de routage par défaut (routerAdmin.ts).
 */
/** Compacter dès que les tours non couverts par le résumé dépassent ce nombre. */
export const COMPACT_UNCOVERED_TURNS_MAX = 30;
/** …ou dès que la taille estimée dépasse cette fraction du contexte du modèle. */
export const COMPACT_CONTEXT_RATIO = 0.6;
/** Estimation grossière ~4 caractères par token (suffisante pour un seuil). */
export const COMPACT_CHARS_PER_TOKEN = 4;
/** Les N derniers tours de la transcription restent TOUJOURS intacts. */
export const COMPACT_KEEP_LAST = 10;
/** Préfixe du message-résumé injecté en tête de l'historique envoyé. */
export const COMPACT_SUMMARY_PREFIX = "[Résumé de la conversation antérieure]";

/** R4 — état de compaction persisté d'une conversation (spec §2.1). */
export interface ChatCompaction {
  summary: string;
  /** Le résumé couvre les tours [0, upToIndex) de la transcription. */
  upToIndex: number;
  /** Date ISO de la (re)compaction. */
  at: string;
}

/** Parsing défensif d'une compaction persistée — null si absente/corrompue. */
export function toChatCompaction(value: unknown): ChatCompaction | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== "string" || !v.summary) return null;
  if (typeof v.upToIndex !== "number" || !Number.isFinite(v.upToIndex) || v.upToIndex <= 0) return null;
  return {
    summary: v.summary,
    upToIndex: Math.floor(v.upToIndex),
    at: typeof v.at === "string" ? v.at : "",
  };
}

/** R4 — décision de compaction : miroir de `shouldCompact` (sidecar/src/context.ts, testé là-bas). */
export function shouldCompactChat(
  uncoveredTurns: number,
  estimatedChars: number,
  contextLength: number | null,
): boolean {
  if (uncoveredTurns > COMPACT_UNCOVERED_TURNS_MAX) return true;
  if (contextLength !== null && contextLength > 0) {
    return estimatedChars / COMPACT_CHARS_PER_TOKEN > COMPACT_CONTEXT_RATIO * contextLength;
  }
  return false;
}

/**
 * Construit le fil complet pour `chat.send`. Ordre STABLE, cache-friendly
 * (voir docs/protocol.md, `chat.send`) : system → résumé de compaction (R4,
 * s'il existe) → tours depuis `upToIndex` → nouveau message — les blocs
 * stables précèdent toujours les blocs variables. Sans compaction (`null`),
 * comportement strictement inchangé (conversations courtes, moteur Claude).
 * Miroir de `buildCompactedMessages` (sidecar/src/context.ts, testé là-bas).
 */
export function toApiMessages(
  entries: ChatEntry[],
  systemPrompt: string,
  newUserContent: string,
  compaction: ChatCompaction | null = null,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const trimmedSystem = systemPrompt.trim();
  if (trimmedSystem) messages.push({ role: "system", content: trimmedSystem });
  if (compaction) {
    messages.push({ role: "user", content: `${COMPACT_SUMMARY_PREFIX}\n${compaction.summary}` });
  }
  const turns = compaction ? entries.slice(compaction.upToIndex) : entries;
  for (const entry of turns) {
    if (entry.status === "error") continue;
    messages.push({ role: entry.role, content: entry.content });
  }
  messages.push({ role: "user", content: newUserContent });
  return messages;
}
