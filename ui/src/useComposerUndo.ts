/*
 * Annuler/Rétablir du composeur (Ctrl+Z / Ctrl+Maj+Z / Ctrl+Y), partagé par
 * les pages « Chat » et « Projets ».
 *
 * Pourquoi un historique maison : le composeur est un <textarea> dont la
 * valeur est régulièrement posée par programme — brouillon restauré au
 * changement d'onglet/de session, dictée vocale qui insère du texte, vidage
 * à l'envoi, réinjection d'un message retiré de la file. Or toute écriture
 * programmatique de `value` détruit la pile d'annulation native du champ
 * (comportement WebKitGTK/Tauri, mais aucun moteur ne la garantit dans ce
 * cas). Ctrl+Z natif est donc structurellement cassé ici : on tient notre
 * propre pile, par session, et on court-circuite toujours le comportement
 * natif sur ces raccourcis pour rester prévisible.
 *
 * Granularité : la frappe est regroupée par fenêtres de COALESCE_MS — un
 * point d'annulation au plus par fenêtre, comme les éditeurs de texte —
 * sinon Ctrl+Z reculerait caractère par caractère. Les changements
 * programmatiques (dictée, vidage…) passent par le même observateur : ils
 * sont donc annulables aussi, sans câblage particulier dans les pages.
 *
 * Le brouillon est fourni par un GETTER (`getDraft`, lecture du runtime vif)
 * et non par sa valeur de rendu : depuis useComposerLiveDraft.ts, la frappe
 * n'est répercutée au rendu que par un rattrapage débouncé — la valeur de
 * rendu peut donc retarder, alors que le runtime est toujours juste. L'
 * observation se fait à chaque rendu ET au moment du raccourci (`record`
 * en tête de `handleUndoKey`), pour qu'un Ctrl+Z en pleine rafale de frappe
 * parte bien du texte réellement affiché.
 */
import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";

/** Profondeur maximale de la pile d'annulation d'une session. */
const MAX_DEPTH = 100;
/** Fenêtre de regroupement de la frappe : un point d'annulation au plus par fenêtre. */
const COALESCE_MS = 800;

type History = {
  undo: string[];
  redo: string[];
  /** Dernière valeur observée du brouillon — l'état « courant » de la pile. */
  last: string;
  /** Date du dernier point posé (regroupement) ; 0 force un nouveau point. */
  lastPushMs: number;
};

/**
 * Suit le brouillon de la session active et rend un gestionnaire à appeler
 * en tête du `onKeyDown` du textarea : il consomme Ctrl+Z / Ctrl+Maj+Z /
 * Ctrl+Y (`true` = événement traité, la page n'a plus rien à en faire).
 */
export function useComposerUndo(
  activeSessionId: string | null,
  /** Brouillon VIF de la session active (lecture du runtime, jamais une valeur de rendu). */
  getDraft: () => string,
  setDraft: (value: string) => void,
): { handleUndoKey: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean } {
  const historiesRef = useRef(new Map<string, History>());

  function history(id: string): History {
    let h = historiesRef.current.get(id);
    if (!h) {
      // Première rencontre de la session : la valeur courante devient l'état
      // de référence, sans point d'annulation (rien à annuler encore).
      h = { undo: [], redo: [], last: getDraft(), lastPushMs: 0 };
      historiesRef.current.set(id, h);
    }
    return h;
  }

  /** Enregistre la valeur courante si elle a changé (point regroupé dans le temps). */
  function record(h: History, value: string) {
    if (value === h.last) return;
    const now = Date.now();
    if (now - h.lastPushMs > COALESCE_MS) {
      h.undo.push(h.last);
      if (h.undo.length > MAX_DEPTH) h.undo.shift();
      h.lastPushMs = now;
    }
    h.redo = [];
    h.last = value;
  }

  // Observateur : chaque changement du brouillon (frappe OU programme) pose
  // un point d'annulation, regroupé dans le temps. Les restaurations faites
  // par undo/redo ci-dessous posent `last` AVANT `setDraft` : l'effet les
  // voit alors comme « déjà connues » et ne les réenregistre pas.
  useEffect(() => {
    if (!activeSessionId) return;
    record(history(activeSessionId), getDraft());
  });

  function restore(h: History, value: string) {
    // `last` posé avant `setDraft` : voir le commentaire de l'observateur.
    h.last = value;
    h.lastPushMs = 0;
    setDraft(value);
  }

  function handleUndoKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
    const key = e.key.toLowerCase();
    const isRedo = key === "y" || (key === "z" && e.shiftKey);
    if (key !== "z" && !isRedo) return false;
    // Toujours consommé, pile vide comprise : laisser passer réveillerait
    // l'annulation native du webview, incohérente avec la nôtre.
    e.preventDefault();
    if (!activeSessionId) return true;
    const h = history(activeSessionId);
    // Rattrape la frappe encore jamais observée par un rendu (voir en-tête).
    record(h, getDraft());
    if (isRedo) {
      const value = h.redo.pop();
      if (value === undefined) return true;
      h.undo.push(h.last);
      restore(h, value);
    } else {
      const value = h.undo.pop();
      if (value === undefined) return true;
      h.redo.push(h.last);
      restore(h, value);
    }
    return true;
  }

  return { handleUndoKey };
}
