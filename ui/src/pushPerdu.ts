/*
 * Pièces jointes d'un message glissé dans le tour (claude.push) qui n'a
 * jamais été vu par le modèle (T-087, T-064, T-183). Feuille : la logique de
 * rangement et le choix de l'avis, sans React ni sidecar. Les deux tables
 * (copies locales des pushes en cours, pièces à renvoyer) sont des
 * `Map` par conversation, mutées ici comme elles l'étaient dans
 * `envoiProjet.ts` d'où ce code est sorti.
 */
import { piecesOrphelines, rangerPiecesARenvoyer, retirerPushCorrespondant, type PushEnCoursDeTour } from "./agentTurns";

export type TablePieces<A> = Map<string, PushEnCoursDeTour<A>[]>;

export const AVIS_PUSH_RENVOYE =
  "Message glissé pendant le tour non vu par l'agent : il repart automatiquement avec ses pièces jointes.";
export const AVIS_PIECES_NON_RESTAUREES =
  "Une pièce jointe envoyée pendant le tour n'a pas été vue par l'agent et n'a pas pu être restaurée automatiquement : à rejoindre à la main.";

/**
 * Un push avec pièces est perdu : sa copie locale passe de `pushesEnCours` à
 * `aRenvoyer`. Rend l'avis à afficher, ou `null` si le push n'avait pas de
 * pièces (rien à signaler).
 */
export function rangerPushPerdu<A>(
  pushesEnCours: TablePieces<A>,
  aRenvoyer: TablePieces<A>,
  convId: string,
  contenu: string,
  avaitPieces: boolean,
): string | null {
  if (!avaitPieces) return null;
  const { trouve, reste } = retirerPushCorrespondant(pushesEnCours.get(convId) ?? [], contenu);
  pushesEnCours.set(convId, reste);
  if (trouve && trouve.attachments.length > 0) {
    aRenvoyer.set(convId, rangerPiecesARenvoyer(aRenvoyer.get(convId) ?? [], contenu, trouve.attachments));
    return AVIS_PUSH_RENVOYE;
  }
  return AVIS_PIECES_NON_RESTAUREES;
}

/**
 * Des messages quittent la file sans partir : leurs pièces rangées sortent de
 * `aRenvoyer`. `contenus` null = tout ce qui est rangé pour la conversation.
 */
export function retirerPiecesOrphelines<A>(
  aRenvoyer: TablePieces<A>,
  convId: string,
  contenus: string[] | null,
  motif: string,
): { pieces: A[]; avis: string } | null {
  const rangees = aRenvoyer.get(convId) ?? [];
  const { pieces, reste } = piecesOrphelines(rangees, contenus ?? rangees.map((p) => p.contenu));
  aRenvoyer.set(convId, reste);
  if (pieces.length === 0) return null;
  return { pieces, avis: `${motif} : ses pièces jointes sont revenues dans le composeur.` };
}
