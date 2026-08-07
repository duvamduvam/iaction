/*
 * Recollage en bas d'un fil qui grandit (Chat, Projets) — la logique partagée
 * par ChatPage et AgentPage, qui en avaient chacune une copie divergente.
 *
 * Le principe : tant que l'utilisateur est « collé » en bas, chaque mise à
 * jour du contenu repousse le scroll au fond ; dès qu'il remonte, on décolle
 * et on ne le force plus — jusqu'à ce qu'il revienne de lui-même tout en bas.
 *
 * Ce qui ne marchait pas (constaté le 2026-08-07 sur une réponse Gemini
 * streamée) : l'état « collé » était déduit de la SEULE position au moment de
 * l'événement `scroll`, avec un seuil de 48 px. Or pendant un streaming rapide
 * le recollage repose le scroll au fond à chaque delta, et l'événement `scroll`
 * arrive APRÈS le geste : une molette de moins de 48 px laissait `stick` à
 * vrai, le delta suivant redescendait, et le fil redescendait « tout seul » —
 * impossible de remonter autrement qu'en jetant la molette d'un coup sec.
 *
 * Deux corrections :
 *  - l'INTENTION prime sur la position — une molette vers le haut, ou un
 *    scrollTop qui recule (glissement de l'ascenseur, PagePrec, tactile),
 *    décolle immédiatement, quelle que soit la distance parcourue ;
 *  - zone morte entre les deux seuils — on ne se recolle qu'une fois vraiment
 *    au fond (≤ 4 px), pas dès qu'on repasse sous 48 px, sinon un petit geste
 *    vers le haut se fait avaler par le recollage suivant.
 */
import { useCallback, useLayoutEffect, useRef } from "react";

/** Distance au bas (px) sous laquelle on se RECOLLE : « vraiment au fond ». */
const RECOLLAGE_PX = 4;
/** Distance au bas (px) au-delà de laquelle on DÉCOLLE sur la seule position. */
const DECROCHAGE_PX = 48;

export interface StickToBottom {
  /** À poser sur le conteneur scrollable. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** À étaler sur le conteneur scrollable : `<div {...scrollProps} ref={scrollRef}>`. */
  scrollProps: {
    onScroll: () => void;
    onWheel: (e: React.WheelEvent) => void;
  };
  /** Recolle en bas (envoi d'un message, nouvelle bulle…) — effectif au prochain rendu. */
  collerEnBas: () => void;
}

/**
 * @param dep valeur qui change à chaque mise à jour du fil (la liste des tours,
 *            des entrées…) : c'est elle qui déclenche le recollage avant peinture.
 */
export function useStickToBottom(dep: unknown): StickToBottom {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  /** Dernier scrollTop connu (posé par nous ou observé) : sert à détecter un recul. */
  const lastTopRef = useRef(0);

  // `useLayoutEffect` (et non `useEffect`) : le recollage doit se faire APRÈS
  // la mise à jour du DOM mais AVANT la peinture. Avec `useEffect`, le
  // navigateur peignait d'abord la frame au vieux scroll, puis le recollage —
  // et comme la hauteur du fil oscille pendant un streaming (le Markdown d'un
  // bloc incomplet bascule entre code et prose à chaque delta), l'utilisateur
  // voyait le fil pomper de bas en haut (constaté le 2026-08-04).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!stickRef.current) return;
    el.scrollTop = el.scrollHeight;
    // Mémorisé AVANT que l'événement `scroll` correspondant ne parte : sinon
    // notre propre recollage passerait pour un geste de l'utilisateur.
    lastTopRef.current = el.scrollTop;
  }, [dep]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const recul = top < lastTopRef.current - 1;
    lastTopRef.current = top;
    const distance = el.scrollHeight - top - el.clientHeight;

    if (distance <= RECOLLAGE_PX) {
      // Revenu tout en bas de son plein gré : on recolle.
      stickRef.current = true;
      return;
    }
    // Tout recul non provoqué par le recollage est un geste de l'utilisateur,
    // si petit soit-il. Le seuil de position ne sert plus qu'aux sauts qu'on
    // n'aurait pas vus passer (ancre, redimensionnement, Fin/Début).
    if (recul || distance > DECROCHAGE_PX) {
      stickRef.current = false;
    }
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    // Signal le plus sûr : synchrone du geste, donc jamais en retard d'une
    // frame sur le recollage — contrairement à l'événement `scroll`.
    if (e.deltaY < 0) stickRef.current = false;
  }, []);

  const collerEnBas = useCallback(() => {
    stickRef.current = true;
  }, []);

  return {
    scrollRef,
    scrollProps: { onScroll: handleScroll, onWheel: handleWheel },
    collerEnBas,
  };
}
