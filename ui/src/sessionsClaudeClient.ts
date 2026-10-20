/*
 * Appels sidecar du panneau « Sessions Claude » (T-159) — `claude.agents` et
 * `claude.forkSession`, voir docs/protocol.md. Les deux REJETTENT avec le
 * message du sidecar (CLI introuvable, délai, JSON invalide…) : le panneau
 * l'affiche, et le sidecar l'a déjà porté au journal.
 */

import { request } from "./sidecar";
import { lireSessions, type SessionClaude } from "./sessionsClaude";

export async function claudeAgents(inclureTerminees: boolean): Promise<SessionClaude[]> {
  const { done } = request("claude.agents", { all: inclureTerminees });
  return lireSessions(await done);
}

/** Copie la session (jamais d'écriture dans l'originale) et rend l'identifiant de la copie. */
export async function claudeForkSession(sessionId: string, cwd: string): Promise<string> {
  const { done } = request("claude.forkSession", { sessionId, cwd });
  const donnees = await done;
  if (typeof donnees.sessionId !== "string" || donnees.sessionId.length === 0) {
    throw new Error("le sidecar n'a pas rendu l'identifiant de la copie");
  }
  return donnees.sessionId;
}
