/**
 * T-006 — l'attente muette d'un fournisseur devient VISIBLE.
 *
 * Constat du 2026-08-08 (12h03) : un tour parti vers un abonnement dont la
 * fenêtre hebdomadaire était saturée est resté suspendu — curseur clignotant,
 * aucun octet, aucun message. Le SDK réessaie en silence ; l'utilisateur, lui,
 * ne peut pas distinguer « le modèle réfléchit » de « rien ne viendra ».
 * La doctrine d'observabilité du projet interdit exactement ça : aucun échec
 * muet.
 *
 * Le contrat est minimal : une bulle assistant en streaming qui n'a encore
 * RIEN reçu après ATTENTE_FOURNISSEUR_MS l'affiche. Dès le premier octet
 * (texte, raisonnement ou appel d'outil), l'avis disparaît — des données qui
 * arrivent prouvent que le fournisseur répond, quelle que soit sa lenteur.
 *
 * ── T-027 : ce qu'il mesurait vraiment, et pourquoi c'était faux ─────────
 * Constaté le 2026-08-10 : l'avis s'affichait à CHAQUE réponse, sur un fil où
 * le fournisseur répondait parfaitement. Il ne mesurait pas « le fournisseur
 * se tait », mais « cette bulle-ci est encore vide » — deux choses très
 * différentes dès qu'un tour dure. Deux corrections :
 *
 *   1. le SEUIL. 10 s était calibré sur un tour court. Le temps jusqu'au
 *      premier octet croît avec le contexte envoyé : à 100 k tokens (cas
 *      courant sur ce produit, l'en-tête affiche le compteur), il dépasse
 *      régulièrement 10 s sans que rien n'aille mal. Un avertissement qui se
 *      déclenche en fonctionnement NORMAL n'avertit plus de rien : on apprend
 *      à ne plus le lire, et il ne servira pas le jour où le tour est vraiment
 *      mort. Le seuil est donc porté à 45 s — largement au-dessus de la
 *      latence normale, et largement en dessous du plafond de silence du
 *      sidecar (120 s, SILENCE_DEMARRAGE_TIMEOUT_MS), qui prend le relais et
 *      transforme l'attente en échec daté ;
 *   2. la PORTÉE. Une bulle ouverte au milieu d'un tour déjà vivant — message
 *      glissé par l'utilisateur (S3, `claude.push`), dont le modèle ne tiendra
 *      compte qu'au prochain outil — est vide par construction, parfois
 *      plusieurs minutes. Le fournisseur, lui, a déjà prouvé qu'il répondait.
 *      Ces bulles-là ne posent jamais l'avis (voir `suiteDeTour`).
 */

import { useEffect, useState } from "react";

/**
 * 45 s : au-delà de toute latence de démarrage plausible, y compris un gros
 * contexte et une préparation MCP lente. Voir l'en-tête pour le calibrage —
 * ce seuil se juge à son taux de FAUX positifs, pas à sa réactivité.
 */
export const ATTENTE_FOURNISSEUR_MS = 45_000;

export const MESSAGE_ATTENTE_FOURNISSEUR =
  `⏳ Aucune donnée reçue du fournisseur depuis ${Math.round(ATTENTE_FOURNISSEUR_MS / 1000)} s — ` +
  "le tour est peut-être suspendu (abonnement saturé, voir l'en-tête). « Arrêter » l'interrompt.";

/**
 * Une bulle assistant est-elle en attente du PREMIER octet de son tour ?
 *
 * Fonction pure et partagée par les deux fils (Projets et Chat) : la règle
 * « quand a-t-on le droit d'avertir » se lisait auparavant en deux conditions
 * recopiées dans deux JSX, ce qui est exactement la forme qu'avait le défaut
 * T-027 — une des deux a divergé sans que rien ne le dise.
 *
 * `suiteDeTour` : bulle ouverte au milieu d'un tour déjà vivant (S3), vide par
 * construction jusqu'au prochain outil — jamais un silence du fournisseur.
 */
export function enAttenteDuPremierOctet(bulle: {
  role: "user" | "assistant";
  status: string;
  /** Vrai si la bulle n'a reçu AUCUN contenu (bloc, texte). */
  vide: boolean;
  suiteDeTour?: boolean;
}): boolean {
  return bulle.role === "assistant" && bulle.status === "streaming" && bulle.vide && !bulle.suiteDeTour;
}

/**
 * Vrai quand `enAttente` (streaming sans le moindre contenu) dure depuis plus
 * de ATTENTE_FOURNISSEUR_MS. Le composant bulle étant mémoïsé, c'est le
 * setState du minuteur qui déclenche le rendu de l'avis — aucun autre rendu
 * n'a lieu tant que rien n'arrive, par construction.
 */
export function useAttenteFournisseur(enAttente: boolean): boolean {
  const [depassee, setDepassee] = useState(false);
  useEffect(() => {
    if (!enAttente) {
      setDepassee(false);
      return;
    }
    const minuteur = window.setTimeout(() => setDepassee(true), ATTENTE_FOURNISSEUR_MS);
    return () => window.clearTimeout(minuteur);
  }, [enAttente]);
  return depassee && enAttente;
}
