import type { ChatEntry } from "./ChatPage";
import type { ChatUsage } from "./protocole";

// Helpers purs (hors du composant) pour garder les callbacks peu imbriqués,
// même esprit que withAppendedChunk/withStatus dans SystemPage.tsx.
export function withAppendedDelta(entries: ChatEntry[], id: string, delta: string): ChatEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, content: e.content + delta } : e));
}

export function withEntryDone(
  entries: ChatEntry[],
  id: string,
  aborted: boolean,
  usage: ChatUsage | null,
  contextTokens: number | null = null,
): ChatEntry[] {
  return entries.map((e) =>
    e.id === id ? { ...e, status: aborted ? "aborted" : "done", usage, contextTokens } : e,
  );
}

/**
 * Taille du contexte de la conversation, en tokens : prompt + complétion du
 * DERNIER tour ayant remonté un usage. Le prompt d'un tour contient déjà tout
 * l'historique envoyé (voir toApiMessages) — additionner les tours compterait
 * donc plusieurs fois les mêmes messages. `null` tant qu'aucun usage n'est
 * connu (fournisseur muet, session rechargée avant le premier tour).
 */
export function contextTokens(entries: ChatEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    // Priorité à l'occupation réelle mesurée côté sidecar (moteur Claude, voir
    // ChatEntry.contextTokens) ; repli sur prompt + complétion (moteur neutre,
    // ou entrées d'avant ce champ).
    // Un total nul n'est pas une mesure (fournisseur muet, tour sans appel
    // modèle) : on continue de remonter plutôt que d'afficher une jauge à 0 %.
    if (typeof entry.contextTokens === "number" && entry.contextTokens > 0) return entry.contextTokens;
    if (entry.usage) {
      const total = (entry.usage.promptTokens ?? 0) + (entry.usage.completionTokens ?? 0);
      if (total > 0) return total;
    }
  }
  return null;
}

export function withSessionReprise(entries: ChatEntry[], id: string): ChatEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, sessionReprise: true } : e));
}

export function withEntryError(entries: ChatEntry[], id: string, errorMessage: string): ChatEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, status: "error", errorMessage } : e));
}
