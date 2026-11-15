/*
 * Titres de la page Chat (T-197) : l'adaptation des entrées du Chat à la règle
 * commune (`titreAffiche`, `doitTitrer`). Feuille pure, testée sans fenêtre —
 * ChatPage.tsx importe les types seulement.
 */
import type { ChatEntry } from "./ChatPage";
import { titreAffiche } from "./sessionStore";
import { premierEchange, type CandidatTitre, type LigneTitrable } from "./titresDiscussions";

/** Titre affiché d'une session Chat : renommage, sinon titre du modèle, sinon repli du premier message. */
export function titreSessionChat(
  session: { title: string; titleCustom: boolean; titreIA?: string },
  entries: readonly ChatEntry[],
): string {
  return titreAffiche(session, entries.find((e) => e.role === "user")?.content ?? "");
}

export function lignesTitrablesChat(entries: readonly ChatEntry[]): LigneTitrable[] {
  return entries.map((e) => ({ role: e.role, texte: e.content, terminee: e.status === "done" }));
}

export function texteRecherchableChat(entries: readonly ChatEntry[]): string {
  return entries.map((e) => e.content).join("\n");
}

/** `moteurClaude` : fournisseur Claude (abonnement) ET dernière cible de routage non neutre. */
export function candidatTitreChat(
  s: { id: string; titleCustom: boolean; titreIA?: string; entries: readonly ChatEntry[]; routedTarget?: { engine: string } | null },
  fournisseurEstClaude: boolean,
): CandidatTitre {
  const moteurClaude = fournisseurEstClaude && s.routedTarget?.engine !== "neutral";
  const ecarte = s.titleCustom || !!s.titreIA || !moteurClaude;
  return {
    id: s.id,
    titleCustom: s.titleCustom,
    titreIA: s.titreIA,
    moteurClaude,
    echange: ecarte ? null : premierEchange(lignesTitrablesChat(s.entries)),
  };
}
