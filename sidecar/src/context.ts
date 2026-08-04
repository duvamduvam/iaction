/**
 * Économie de contexte — Lot 14, phase R4 (docs/spec-r4-contexte.md).
 *
 * `context.compact` : résume les messages FOURNIS (l'appelant choisit quoi
 * résumer) via une complétion NON streamée sur un provider déclaré via
 * `providers.set` — mêmes helpers qu'engine.ts, timeout 60 s. Erreur/timeout
 * → `error` protocolaire normale : l'UI n'applique alors PAS la compaction et
 * envoie l'historique intégral (jamais de perte).
 *
 * Le module exporte aussi les fonctions PURES de la logique de compaction
 * côté UI (seuil de déclenchement, construction des messages post-compaction),
 * testées unitairement dans protocol.test.js — ChatPage.tsx applique la même
 * logique avec les mêmes constantes (dupliquées là-bas, comme la table de
 * routage par défaut entre router.ts et routerAdmin.ts).
 */

import {
  buildHeaders,
  getProvider,
  joinUrl,
  readBoundedBody,
  type ChatMessage,
  type EngineEmitter,
} from "./engine.js";

// ---------------------------------------------------------------------------
// Constantes de compaction (spec R4 §2.2) — nommées, faciles à régler.
// ---------------------------------------------------------------------------

/** Compacter dès que les tours non couverts par le résumé dépassent ce nombre. */
export const COMPACT_UNCOVERED_TURNS_MAX = 30;
/** …ou dès que la taille estimée dépasse cette fraction du contexte du modèle. */
export const COMPACT_CONTEXT_RATIO = 0.6;
/** Estimation grossière ~4 caractères par token (suffisante pour un seuil). */
export const COMPACT_CHARS_PER_TOKEN = 4;
/** Les N derniers tours de la transcription restent TOUJOURS intacts. */
export const COMPACT_KEEP_LAST = 10;
/** Préfixe du message-résumé injecté en tête de l'historique envoyé (spec §2.3). */
export const COMPACT_SUMMARY_PREFIX = "[Résumé de la conversation antérieure]";

/** Le résumé est produit par un petit modèle local : à froid, laisser du temps. */
const COMPACT_TIMEOUT_MS = 60_000;

/** Prompt système du résumeur (spec R4 §1) : factuel, dense, sans méta. */
const COMPACT_SYSTEM_PROMPT =
  "Tu résumes une conversation pour qu'elle puisse continuer avec moins de contexte. " +
  "Produis un résumé factuel et dense, en français : décisions prises, faits établis, " +
  "fichiers et chemins cités, questions encore ouvertes. 400 mots maximum. " +
  "Réponds par le résumé seul, sans introduction ni commentaire méta.";

// ---------------------------------------------------------------------------
// Utilitaires (mêmes conventions qu'engine.ts/router.ts)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Fonctions pures (testées dans protocol.test.js, miroir côté ChatPage.tsx)
// ---------------------------------------------------------------------------

export interface CompactThresholdInput {
  /** Tours de la transcription non couverts par le résumé courant. */
  uncoveredTurns: number;
  /** Taille (caractères) de l'envoi tel qu'il partirait avec l'état courant. */
  estimatedChars: number;
  /** Fenêtre du modèle en tokens (`models.detail`), null/absent si inconnue. */
  contextLength?: number | null;
}

/**
 * Décision de compaction (spec R4 §2.2) : tours non couverts > 30 OU taille
 * estimée > 60 % du contexte du modèle (~4 caractères/token). Sans
 * `contextLength` (fournisseur muet, ex. Ollama), le seuil tours s'applique
 * seul.
 */
export function shouldCompact(input: CompactThresholdInput): boolean {
  if (input.uncoveredTurns > COMPACT_UNCOVERED_TURNS_MAX) {
    return true;
  }
  const contextLength = input.contextLength;
  if (typeof contextLength === "number" && Number.isFinite(contextLength) && contextLength > 0) {
    return input.estimatedChars / COMPACT_CHARS_PER_TOKEN > COMPACT_CONTEXT_RATIO * contextLength;
  }
  return false;
}

/**
 * Construction des messages post-compaction (spec R4 §2.3) : `[system
 * éventuel] + [message-résumé role:"user"] + tours depuis upToIndex`. Les
 * tours conservés sont repris TELS QUELS (jamais de perte) ; `turns` n'est
 * pas modifié (la transcription affichée ne change pas).
 */
export function buildCompactedMessages(params: {
  system?: string | null;
  summary: string;
  turns: ChatMessage[];
  /** Le résumé couvre les tours [0, upToIndex) de `turns`. */
  upToIndex: number;
}): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (isNonEmptyString(params.system)) {
    messages.push({ role: "system", content: params.system });
  }
  messages.push({ role: "user", content: `${COMPACT_SUMMARY_PREFIX}\n${params.summary}` });
  const upToIndex = Math.max(0, Math.min(params.upToIndex, params.turns.length));
  messages.push(...params.turns.slice(upToIndex));
  return messages;
}

// ---------------------------------------------------------------------------
// context.compact
// ---------------------------------------------------------------------------

/** Libellés français des rôles dans la transcription soumise au résumeur. */
const ROLE_LABELS: Record<string, string> = {
  user: "Utilisateur",
  assistant: "Assistant",
  system: "Système",
};

/**
 * Texte d'un contenu de message : chaîne telle quelle ; contenu en tableau
 * OpenAI (pièces jointes) réduit à ses blocs `text` ; autre forme ignorée.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => (isPlainObject(block) && typeof block.text === "string" ? block.text : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

export async function handleContextCompact(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const providerId = params.providerId;
  if (!isNonEmptyString(providerId)) {
    emitter.error(id, "params.providerId manquant ou invalide");
    return;
  }
  const provider = getProvider(providerId);
  if (!provider) {
    emitter.error(id, `fournisseur inconnu: ${providerId}`);
    return;
  }
  const model = params.model;
  if (!isNonEmptyString(model)) {
    emitter.error(id, "params.model manquant ou invalide");
    return;
  }
  const messages = params.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    emitter.error(id, "params.messages doit être un tableau non vide");
    return;
  }
  for (const m of messages) {
    if (!isPlainObject(m) || !isNonEmptyString(m.role) || !("content" in m)) {
      emitter.error(id, "chaque message doit avoir role et content");
      return;
    }
  }

  // `keepLast` : les N derniers messages fournis sont EXCLUS du résumé
  // (défaut 0 : tout ce qui est fourni est résumé — l'appelant peut aussi
  // faire le découpage lui-même et ne pas envoyer ce champ).
  const rawKeepLast = params.keepLast;
  const keepLast =
    typeof rawKeepLast === "number" && Number.isFinite(rawKeepLast) && rawKeepLast >= 0
      ? Math.floor(rawKeepLast)
      : 0;
  const covered = messages.slice(0, Math.max(0, messages.length - keepLast));
  if (covered.length === 0) {
    emitter.error(id, "aucun message à résumer (keepLast couvre tout l'historique fourni)");
    return;
  }

  const transcript = covered
    .map((m) => {
      const msg = m as Record<string, unknown>;
      const label = ROLE_LABELS[msg.role as string] ?? (msg.role as string);
      return `${label} : ${contentToText(msg.content)}`;
    })
    .join("\n\n");

  try {
    const res = await fetch(joinUrl(provider.baseUrl, "chat/completions"), {
      method: "POST",
      headers: buildHeaders(provider, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: COMPACT_SYSTEM_PROMPT },
          { role: "user", content: transcript },
        ],
        stream: false,
        // Résumé factuel : température basse, sans être du greedy strict.
        temperature: 0.2,
      }),
      // Timeout 60 s (spec R4 §1) — un chargement à froid du modèle local
      // peut être lent, mais l'UI ne doit jamais rester suspendue sans fin.
      signal: AbortSignal.timeout(COMPACT_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await readBoundedBody(res);
      emitter.error(id, `HTTP ${res.status} ${res.statusText}: ${body}`);
      return;
    }
    const json = (await res.json()) as unknown;
    const choice =
      isPlainObject(json) && Array.isArray(json.choices) && isPlainObject(json.choices[0])
        ? json.choices[0]
        : null;
    const message = choice && isPlainObject(choice.message) ? choice.message : null;
    const summary =
      message && typeof message.content === "string" ? message.content.trim() : "";
    if (!summary) {
      emitter.error(id, "réponse inattendue du fournisseur (résumé absent)");
      return;
    }
    emitter.done(id, { summary, coveredTurns: covered.length });
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    emitter.error(id, `erreur réseau: ${messageText}`);
  }
}
