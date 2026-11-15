/*
 * Compte Claude EFFECTIF de la session active d'une page (docs/spec-deux-comptes.md) :
 * choix explicite de la session, sinon défaut du projet, sinon perso — voir
 * `resoudreCompteSession`. Le hook fait deux choses de plus, pour que rien ne se
 * passe en silence :
 *  - il PUBLIE le compte à l'encart conso quand la page est visible, pour que
 *    les jauges (et le réveil) suivent la session active, y compris au
 *    changement d'onglet ;
 *  - il JOURNALISE (warn) le repli d'un défaut `teams` sans second compte vers
 *    perso, une fois par projet tant qu'il dure.
 * Il ne fait JAMAIS de bascule : un choix explicite reste tel quel, et un compte
 * déconnecté n'est pas remplacé (le sidecar refuse le tour avec la commande).
 */
import { useEffect, useRef } from "react";
import {
  journaliserRepliCompte,
  resoudreCompteSession,
  type CompteClaude,
  type CompteDecrit,
} from "./comptesClaude";
import { publierCompteActifConso } from "./usageBus";

export function useCompteSession(args: {
  choisi: CompteClaude | null;
  defautProjet: CompteClaude | null | undefined;
  projetId: string | null;
  comptes: readonly CompteDecrit[] | null;
  visible: boolean;
}): { compte: CompteClaude; attente: boolean } {
  const { choisi, defautProjet, projetId, comptes, visible } = args;
  const { compte, repli, attente } = resoudreCompteSession(choisi, defautProjet, comptes);
  const dejaSignale = useRef<string | null>(null);
  useEffect(() => {
    if (!repli) {
      dejaSignale.current = null;
      return;
    }
    const cle = projetId ?? "";
    if (dejaSignale.current === cle) return;
    dejaSignale.current = cle;
    journaliserRepliCompte(projetId);
  }, [repli, projetId]);
  useEffect(() => {
    if (visible) publierCompteActifConso(compte);
  }, [compte, visible]);
  return { compte, attente };
}
