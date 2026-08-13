/*
 * Frappe fluide dans le composeur, partagé par les pages « Chat » et
 * « Projets ».
 *
 * Le problème : le composeur était un <textarea> CONTRÔLÉ dont chaque frappe
 * passait par `updateRuntime` → `runtimeTick` → re-rendu de la PAGE ENTIÈRE
 * (fil de conversation, barres latérales, arborescence de fichiers…). Sur une
 * page chargée, ce re-rendu par caractère se voit : la frappe traîne derrière
 * le clavier.
 *
 * Le remède : découpler la frappe du rendu. Le textarea devient
 * SEMI-NON-CONTRÔLÉ (`defaultValue` + ref, plus de prop `value`) : le
 * brouillon est écrit dans le runtime de façon SILENCIEUSE (`writeDraft`, sans
 * re-rendu — la donnée vive reste donc toujours juste pour qui la lit), et
 * l'écriture programmatique (dictée vocale, vidage à l'envoi, changement de
 * session/onglet, annulation Ctrl+Z…) passe par le `setDraft` ordinaire, avec
 * re-rendu ; l'effet de synchronisation ci-dessous pousse alors la nouvelle
 * valeur dans le DOM — c'est le seul moment où le textarea est écrit par
 * programme.
 *
 * Pourquoi pas un contrôlé « silencieux » : React REVERTE un champ contrôlé
 * quand `onChange` ne re-rend pas avec la nouvelle valeur (restauration de
 * l'état contrôlé) — la frappe serait annulée au fil de l'eau. D'où le
 * passage en `defaultValue`.
 *
 * ── T-031 : le rendu de rattrapage qui restait ──────────────────────────
 * Il subsistait un re-rendu de page DÉBOUNCÉ (250 ms) après la frappe, pour
 * « rattraper » les états dérivés du brouillon. Mesuré à l'usage : ce
 * rattrapage était le dernier coût de la frappe, et il tombait au pire moment
 * — pendant les micro-pauses entre deux mots, juste au moment où la frappe
 * reprend. Sur la page Projets, découpée en modules mémoïsés, il passait
 * inaperçu ; sur le Chat, resté monolithique, il se voyait.
 *
 * Or l'inventaire des états « dérivés du brouillon » en donne UN SEUL, dans
 * les deux pages : le bouton « Envoyer » grisé quand il n'y a rien à envoyer.
 * Un rendu de page complet quatre fois par seconde pour un booléen. On rend
 * donc ce booléen — et lui seul : `brouillonVide` ne change qu'au FRANCHISSEMENT
 * de la frontière vide/non-vide (le premier caractère, le dernier effacé), soit
 * deux rendus par message au lieu de quatre par seconde. Taper au milieu d'une
 * phrase ne rend plus rien du tout.
 *
 * Bénéfice de bord : plus de minuteur, donc plus de course entre le `blur` du
 * champ et le `click` du bouton — la bascule est posée dans le gestionnaire de
 * frappe lui-même, elle est donc toujours à jour avant le clic suivant.
 */
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** Un brouillon sans autre chose que des blancs n'a rien à envoyer. */
function estVide(valeur: string): boolean {
  return valeur.trim() === "";
}

export function useComposerLiveDraft(opts: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Brouillon du runtime tel que vu par le RENDU courant. */
  draft: string;
  /** Écrit le brouillon dans le runtime SANS déclencher de re-rendu. */
  writeDraft: (value: string) => void;
}): {
  onComposerChange: (value: string) => void;
  /**
   * Le brouillon est-il vide ? SEUL état de rendu dérivé de la frappe (voir
   * l'en-tête). À utiliser pour griser « Envoyer » — surtout pas `draft`, qui
   * ne provoque plus de rendu quand on tape.
   */
  brouillonVide: boolean;
} {
  const { textareaRef, draft, writeDraft } = opts;
  /** Valeur actuellement AFFICHÉE par le textarea (miroir du DOM). */
  const domValueRef = useRef(draft);
  const [brouillonVide, setBrouillonVide] = useState(() => estVide(draft));
  /** Miroir synchrone de l'état : la bascule se décide sans attendre le rendu. */
  const videRef = useRef(brouillonVide);

  /** Ne demande un rendu que si la frontière vide/non-vide est franchie. */
  function majBascule(valeur: string) {
    const vide = estVide(valeur);
    if (vide === videRef.current) return;
    videRef.current = vide;
    setBrouillonVide(vide);
  }

  // Synchronisation « externe → DOM » : un brouillon de rendu qui diffère du
  // DOM ne peut venir que d'une écriture programmatique (la frappe, elle,
  // met `domValueRef` à jour AVANT le runtime) — on pousse alors la valeur
  // dans le champ. La bascule est resynchronisée au passage : changer d'onglet
  // ou vider le composeur à l'envoi doit regriser le bouton. Volontairement
  // sans tableau de dépendances : les comparaisons sont triviales, et le
  // brouillon peut changer à n'importe quel rendu (changement de session comme
  // mutation du runtime actif).
  useEffect(() => {
    majBascule(draft);
    if (draft === domValueRef.current) return;
    domValueRef.current = draft;
    const el = textareaRef.current;
    if (el && el.value !== draft) el.value = draft;
  });

  function onComposerChange(value: string) {
    domValueRef.current = value;
    writeDraft(value);
    majBascule(value);
  }

  return { onComposerChange, brouillonVide };
}
