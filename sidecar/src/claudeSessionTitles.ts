/*
 * claude.sessionTitles — module autonome (étape 9 de docs/etude-structure.md).
 *
 * Était le bas de claude.ts ; il n'a jamais dépendu du moteur (ni queryFn,
 * ni apiKey) : `listSessions()` du SDK lit des métadonnées JSONL déjà sur
 * disque. NOTE : il importe le VRAI SDK statiquement (pas resolveQueryFn) —
 * protégé par son catch global, mais un test hors-ligne qui l'exercerait
 * directement toucherait le SDK réel (piège relevé à la cartographie).
 */

import { isNonEmptyString } from "./base.js";
import type { EngineEmitter } from "./engine.js";

// ---------------------------------------------------------------------------
// claude.sessionTitles — titres courts déjà calculés par le CLI Claude
// (SDKSessionInfo.customTitle / summary), pour remplacer le repli local terne
// de l'UI (les 48 premiers caractères du premier message, voir
// ui/src/sessionStore.ts deriveTitleFromText). Indépendant du moteur
// createClaudeEngine (pas de queryFn, pas d'apiKey) : `listSessions()` ne fait
// que lire les métadonnées JSONL déjà sur disque, sans relancer de session ni
// consommer le moindre token — voir docs/protocol.md, § claude.sessionTitles.
// ---------------------------------------------------------------------------

/**
 * `summary` retombe sur le premier prompt tel quel tant que le CLI n'a pas
 * encore calculé de titre IA pour la session — dans ce cas il n'apporte rien
 * de mieux que le repli local existant. Le SDK tronque parfois `summary` :
 * on compare donc par préfixe, pas par égalité stricte.
 */
export function isFallbackTitle(candidate: string, firstPrompt: string | undefined): boolean {
  if (!isNonEmptyString(firstPrompt)) return false;
  const trimmedCandidate = candidate.trim();
  return trimmedCandidate.length > 0 && firstPrompt.trim().startsWith(trimmedCandidate);
}

interface SdkSessionInfoLike {
  sessionId: string;
  summary: string;
  customTitle?: string;
  firstPrompt?: string;
}

/**
 * claude.sessionTitles — jamais bloquant : amélioration cosmétique du panneau
 * Sessions, toute panne (SDK indisponible, cwd inconnu du CLI, aucune
 * session) retombe sur `{titles: []}` — jamais sur `error` — pour que l'UI
 * garde silencieusement son repli local.
 */
export async function handleClaudeSessionTitles(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwd = params.cwd;
  if (!isNonEmptyString(cwd)) {
    emitter.done(id, { titles: [] });
    return;
  }
  const wantedIds = Array.isArray(params.sessionIds)
    ? new Set(params.sessionIds.filter(isNonEmptyString))
    : null;

  try {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
      listSessions: (options?: { dir?: string }) => Promise<SdkSessionInfoLike[]>;
    };
    const sessions = await sdk.listSessions({ dir: cwd });
    const titles: Array<{ sessionId: string; title: string }> = [];
    for (const session of sessions) {
      if (wantedIds && !wantedIds.has(session.sessionId)) continue;
      const candidate = isNonEmptyString(session.customTitle) ? session.customTitle : session.summary;
      if (!isNonEmptyString(candidate) || isFallbackTitle(candidate, session.firstPrompt)) continue;
      titles.push({ sessionId: session.sessionId, title: candidate });
    }
    emitter.done(id, { titles });
  } catch {
    emitter.done(id, { titles: [] });
  }
}
