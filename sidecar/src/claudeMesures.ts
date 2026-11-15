/*
 * Lectures pures sur les messages du SDK Claude : résumé d'un tool_result,
 * usage d'un tour, occupation de la fenêtre de contexte. Sorties de claude.ts
 * (T-209) ; claude.ts les ré-exporte pour ses appelants et ses tests.
 */
import { isPlainObject } from "./base.js";

const MAX_SUMMARY = 500;

/** Résumé textuel borné du contenu d'un tool_result (string ou tableau de blocs). */
export function summarizeToolResult(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        if (isPlainObject(block) && typeof block.text === "string") {
          return block.text;
        }
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .join("\n");
  } else if (content === null || content === undefined) {
    text = "";
  } else {
    try {
      text = JSON.stringify(content);
    } catch {
      text = String(content);
    }
  }
  return text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY) + "…" : text;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

/** Le SDK expose l'usage en snake_case (hérité de l'API Anthropic). */
export function extractUsage(usage: unknown): Usage | null {
  if (!isPlainObject(usage)) {
    return null;
  }
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const result: Usage = { inputTokens, outputTokens };
  if (typeof usage.cache_read_input_tokens === "number") {
    result.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  return result;
}

/**
 * Occupation de la FENÊTRE de contexte d'UN appel API, d'après l'usage d'un
 * message `assistant` (une réponse modèle = un appel). C'est la taille du PROMPT
 * de cet appel : tokens frais + préfixe relu du cache + préfixe nouvellement mis
 * en cache. Ces trois composantes partitionnent le prompt, dont la somme est
 * bornée par la fenêtre du modèle (sinon l'API refuse) → jauge ≤ 100 %.
 *
 * On N'AJOUTE PAS `output_tokens` : la sortie ne compte pas dans la fenêtre
 * d'ENTRÉE (elle se génère par-dessus), et elle est de toute façon ré-incluse
 * dans le `cache_read` de l'appel suivant — l'additionner ici la compterait
 * double et ferait dépasser 100 % (input quasi plein + sortie ⇒ ~140 %).
 *
 * ⚠ NE PAS confondre avec l'usage du message `result` : celui-ci CUMULE toutes
 * les requêtes du tour agentique (N appels d'outils) — son
 * `cache_read_input_tokens` additionne N fois le même préfixe et dépasse alors
 * largement la fenêtre (d'où un « contexte » à plusieurs centaines de %). Pour
 * la jauge, seul le PROMPT du DERNIER appel compte, pas le cumul.
 */
export function extractContextTokens(usage: unknown): number | null {
  if (!isPlainObject(usage)) return null;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
  const total = input + cacheRead + cacheCreation;
  return total > 0 ? total : null;
}
