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
import * as journal from "./journal.js";

/**
 * Borne d'attente de `listSessions` (T-137).
 *
 * Le contrat de ce module est « jamais bloquant » — il n'était honoré que pour
 * les EXCEPTIONS : `await sdk.listSessions(...)` n'avait aucune borne, donc une
 * lenteur (et non une panne) laissait la requête sans réponse pour toujours.
 * Constaté sur les runners Windows, où le premier import dynamique du SDK et le
 * balayage du dossier de sessions dépassent 5 s : la construction NSIS de la
 * 0.6.0 y est tombée. Côté application, l'effet aurait été un enrichissement
 * cosmétique du panneau Sessions resté en suspens, invisible parce que
 * facultatif — un échec muet de plus.
 *
 * Relu à CHAQUE appel (même convention que le seuil de journal) : c'est ce qui
 * rend la borne testable sans rendre le module configurable pour de vrai.
 */
function delaiListSessionsMs(): number {
  const brut = Number(process.env.IACTION_SESSION_TITLES_TIMEOUT_MS);
  return Number.isFinite(brut) && brut > 0 ? brut : 8000;
}

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
    // La borne rend le contrat vrai pour la LENTEUR comme pour la panne. Le
    // repli est le même dans les deux cas (`titles: []`), mais il se DIT :
    // sans cette ligne, on ne saurait pas distinguer « aucun titre » de
    // « le SDK n'a jamais répondu ».
    const delai = delaiListSessionsMs();
    let expire: NodeJS.Timeout | undefined;
    const sessions = await Promise.race([
      sdk.listSessions({ dir: cwd }),
      new Promise<SdkSessionInfoLike[] | null>((resolve) => {
        expire = setTimeout(() => resolve(null), delai);
        // Ne pas retenir le processus pour un enrichissement cosmétique.
        expire.unref?.();
      }),
    ]);
    clearTimeout(expire);
    if (sessions === null) {
      journal.warn("claude", "listSessions n'a pas répondu dans le délai, titres abandonnés", {
        fields: { cwd, delaiMs: delai },
      });
      emitter.done(id, { titles: [] });
      return;
    }
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
