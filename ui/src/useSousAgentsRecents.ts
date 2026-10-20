/**
 * T-091 — combien de temps la liste des sous-agents survit-elle à son tour ?
 *
 * T-077 a rendu visibles les sous-agents du dernier tour, terminés compris :
 * savoir QUI vient de travailler pour soi est une information, et l'effacer
 * dès le point final la perdrait. Mais la liste se déduit de `vif.turns`,
 * c'est-à-dire de tours PERSISTÉS : rouvrir une conversation d'il y a trois
 * jours réaffichait « Sous-agents du dernier tour · 16 », sans rien qui dise
 * l'âge. Constat utilisateur du 2026-08-27 : « pourquoi les sous-agents
 * restent affichés ? » — la question est la preuve du défaut, un encart qui
 * doit être daté de tête ne se lit plus comme un état.
 *
 * La règle retenue : pendant le tour, et quelques minutes après. Le compte à
 * rebours part d'une fin de tour OBSERVÉE dans cette fenêtre — pas d'un
 * horodatage stocké dans le tour. Deux raisons :
 *
 *   1. `AgentTurn` n'en porte pas, et lui en ajouter un serait un champ
 *      persisté de plus pour un besoin d'affichage ;
 *   2. surtout, c'est la bonne sémantique. Ce que l'encart annonce, c'est
 *      « ça vient de tourner SOUS TES YEUX ». Une conversation rechargée du
 *      disque n'a rien fait tourner : elle n'affiche donc rien, ce qui est
 *      exactement le cas qui posait question.
 *
 * Le délai ne cache jamais un travail en cours : `streaming` prime, et un
 * sous-agent laissé sans résultat est de toute façon marqué « interrompu »
 * (voir `marqueSousAgent`).
 */

import { useEffect, useRef, useState } from "react";

/**
 * 5 min : assez pour revenir d'un aller-retour dans un fichier ou une autre
 * page et retrouver ce qui vient de tourner ; assez court pour qu'un encart
 * encore là veuille dire « récent » sans avoir à le dater.
 */
export const RETENTION_SOUS_AGENTS_MS = 5 * 60_000;

/**
 * La liste a-t-elle encore le droit d'être affichée ? Pure — c'est la règle,
 * séparée de la mécanique React qui l'alimente (patron `useAttenteFournisseur`).
 *
 * `finDuTour` : instant où le tour a été VU se terminer dans cette fenêtre,
 * `null` s'il ne l'a jamais été (conversation rechargée, ou aucun tour depuis
 * l'ouverture).
 */
export function sousAgentsEncoreVisibles(etat: {
  streaming: boolean;
  finDuTour: number | null;
  maintenant: number;
}): boolean {
  if (etat.streaming) return true;
  if (etat.finDuTour === null) return false;
  return etat.maintenant - etat.finDuTour < RETENTION_SOUS_AGENTS_MS;
}

/**
 * Le versant React : observe la fin des tours de la conversation `sessionId`
 * et fait disparaître la liste à l'échéance — par une minuterie, sinon rien
 * ne provoquerait le rendu qui la retire.
 */
export function useSousAgentsRecents(sessionId: string | null, streaming: boolean): boolean {
  const [finDuTour, setFinDuTour] = useState<number | null>(null);
  // Un tour a-t-il été vu tourner ? `ref` et non `state` : le passage de
  // `true` à `false` est le SEUL événement qui nous intéresse, et l'observer
  // ne doit pas provoquer de rendu à lui seul.
  const tournait = useRef(false);

  // Changement de conversation : rien ne se transporte. Le compte à rebours
  // appartient au tour qu'on a vu finir, pas au panneau.
  useEffect(() => {
    tournait.current = false;
    setFinDuTour(null);
  }, [sessionId]);

  useEffect(() => {
    if (streaming) {
      tournait.current = true;
      setFinDuTour(null);
      return;
    }
    if (!tournait.current) return;
    tournait.current = false;
    setFinDuTour(Date.now());
  }, [streaming]);

  useEffect(() => {
    if (finDuTour === null) return;
    const restant = finDuTour + RETENTION_SOUS_AGENTS_MS - Date.now();
    if (restant <= 0) {
      setFinDuTour(null);
      return;
    }
    const minuterie = window.setTimeout(() => setFinDuTour(null), restant);
    return () => window.clearTimeout(minuterie);
  }, [finDuTour]);

  return sousAgentsEncoreVisibles({ streaming, finDuTour, maintenant: Date.now() });
}
