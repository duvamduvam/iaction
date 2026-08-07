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
 * SEMI-NON-CONTRÔLÉ (`defaultValue` + ref, plus de prop `value`) :
 * - Frappe (`onComposerChange`) : le brouillon est écrit dans le runtime de
 *   façon SILENCIEUSE (`writeDraft`, sans re-rendu — la donnée vive reste
 *   donc toujours juste pour qui la lit), puis un re-rendu de rattrapage
 *   unique est programmé (`tick`, débouncé) pour les états dérivés du
 *   brouillon — bouton « Envoyer » grisé, etc. Retard borné à TICK_MS,
 *   invisible à l'œil ; les gestionnaires d'ENVOI ne doivent jamais dépendre
 *   de ce rattrapage : ils lisent le brouillon vif du runtime, pas la valeur
 *   du dernier rendu.
 * - Écriture programmatique (dictée vocale, vidage à l'envoi, changement de
 *   session/onglet, annulation Ctrl+Z…) : elle passe par le `setDraft`
 *   ordinaire (avec re-rendu), et l'effet de synchronisation ci-dessous
 *   pousse alors la nouvelle valeur dans le DOM — c'est le seul moment où le
 *   textarea est écrit par programme.
 *
 * Pourquoi pas un contrôlé « silencieux » : React REVERTE un champ contrôlé
 * quand `onChange` ne re-rend pas avec la nouvelle valeur (restauration de
 * l'état contrôlé) — la frappe serait annulée au fil de l'eau. D'où le
 * passage en `defaultValue`.
 */
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/** Retard maximal du re-rendu de rattrapage après la dernière frappe. */
const TICK_MS = 250;

export function useComposerLiveDraft(opts: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Brouillon du runtime tel que vu par le RENDU courant (peut retarder d'un tick sur la frappe). */
  draft: string;
  /** Écrit le brouillon dans le runtime SANS déclencher de re-rendu. */
  writeDraft: (value: string) => void;
  /** Force un re-rendu (rattrapage des états dérivés du brouillon). */
  tick: () => void;
}): { onComposerChange: (value: string) => void; onComposerBlur: () => void } {
  const { textareaRef, draft, writeDraft, tick } = opts;
  /** Valeur actuellement AFFICHÉE par le textarea (miroir du DOM). */
  const domValueRef = useRef(draft);
  const tickTimerRef = useRef<number | null>(null);

  // Synchronisation « externe → DOM » : un brouillon de rendu qui diffère du
  // DOM ne peut venir que d'une écriture programmatique (la frappe, elle,
  // met `domValueRef` à jour AVANT le runtime) — on pousse alors la valeur
  // dans le champ. Volontairement sans tableau de dépendances : la
  // comparaison est triviale, et le brouillon peut changer à n'importe quel
  // rendu (changement de session comme mutation du runtime actif).
  useEffect(() => {
    if (draft === domValueRef.current) return;
    domValueRef.current = draft;
    const el = textareaRef.current;
    if (el && el.value !== draft) el.value = draft;
  });

  // Un rattrapage encore en vol au démontage ne doit pas tirer sur une page morte.
  useEffect(() => {
    return () => {
      if (tickTimerRef.current !== null) window.clearTimeout(tickTimerRef.current);
    };
  }, []);

  function onComposerChange(value: string) {
    domValueRef.current = value;
    writeDraft(value);
    if (tickTimerRef.current !== null) window.clearTimeout(tickTimerRef.current);
    tickTimerRef.current = window.setTimeout(() => {
      tickTimerRef.current = null;
      tick();
    }, TICK_MS);
  }

  /**
   * Quitter le champ vide le rattrapage en attente TOUT DE SUITE. Sans cela,
   * taper puis cliquer « Envoyer » en moins de TICK_MS trouverait le bouton
   * encore grisé (son `disabled` est dérivé du brouillon de rendu) : le
   * `blur` du champ précède le `click` du bouton, l'état est donc à jour à
   * temps.
   */
  function onComposerBlur() {
    if (tickTimerRef.current === null) return;
    window.clearTimeout(tickTimerRef.current);
    tickTimerRef.current = null;
    tick();
  }

  return { onComposerChange, onComposerBlur };
}
