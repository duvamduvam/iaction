/*
 * Hook « roving tabindex » (pattern WAI-ARIA APG) : dans une collection
 * (onglets, liste, arbre), un seul élément est dans l'ordre de tabulation ;
 * les flèches déplacent le focus d'item en item, Home/End vont aux
 * extrémités. Approche par requête DOM sur le conteneur — robuste face aux
 * listes dynamiques (pas de tableau de refs à entretenir) et l'ordre du
 * document EST l'ordre de navigation (précieux pour l'arbre, où seuls les
 * items visibles sont rendus).
 *
 * Le JSX reste responsable du tabIndex « par défaut » (0 sur l'item actif ou
 * sélectionné, -1 ailleurs) ; le hook re-stampe les tabIndex quand le focus
 * bouge, pour que Tab sorte de la collection puis y revienne sur le dernier
 * item focusé.
 */
import { useCallback, useRef } from "react";
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

/** Flèche « décorée » d'un modificateur : elle appartient au global, pas à la collection. */
export function hasModifier(e: ReactKeyboardEvent): boolean {
  return e.shiftKey || e.ctrlKey || e.metaKey || e.altKey;
}

export function useRovingFocus<T extends HTMLElement = HTMLElement>({
  selector,
  orientation = "vertical",
  loop = true,
}: Readonly<{
  /** Sélecteur CSS des items de la collection (relatif au conteneur). */
  selector: string;
  orientation?: "horizontal" | "vertical";
  /** `false` : butée aux extrémités (arbre APG) ; `true` (défaut) : circulaire. */
  loop?: boolean;
}>) {
  const containerRef = useRef<T | null>(null);

  const getItems = useCallback((): HTMLElement[] => {
    const root = containerRef.current;
    return root ? Array.from(root.querySelectorAll<HTMLElement>(selector)) : [];
  }, [selector]);

  /** Rend `el` seul tabbable de la collection et, si demandé, lui donne le focus. */
  const setCurrent = useCallback(
    (el: HTMLElement, focus: boolean) => {
      for (const item of getItems()) item.tabIndex = item === el ? 0 : -1;
      if (focus) el.focus();
    },
    [getItems],
  );

  /** À poser sur le conteneur : l'item focusé (clic, Tab…) devient le seul tabbable. */
  const onFocus = useCallback(
    (e: ReactFocusEvent<T>) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>(selector);
      if (item && containerRef.current?.contains(item)) setCurrent(item, false);
    },
    [selector, setCurrent],
  );

  /** À poser sur le conteneur : flèches (selon l'orientation), Home et End. */
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<T>) => {
      const target = e.target as HTMLElement;
      // Flèches AVEC modificateur : réservées au global (Alt+flèche = zone
      // voisine, voir App.tsx), jamais à la navigation interne.
      if (hasModifier(e)) return;
      // Ne jamais voler les touches d'un champ de saisie (renommage inline…).
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      const [prevKey, nextKey] = orientation === "horizontal" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      const items = getItems();
      if (items.length === 0) return;
      const current = items.indexOf(target.closest<HTMLElement>(selector) as HTMLElement);
      let index: number;
      if (e.key === prevKey) index = current <= 0 ? (loop ? items.length - 1 : 0) : current - 1;
      else if (e.key === nextKey) index = current >= items.length - 1 ? (loop ? 0 : items.length - 1) : current + 1;
      else if (e.key === "Home") index = 0;
      else if (e.key === "End") index = items.length - 1;
      else return;
      e.preventDefault();
      setCurrent(items[index], true);
    },
    [selector, orientation, loop, getItems, setCurrent],
  );

  return { containerRef, onKeyDown, onFocus, getItems, setCurrent };
}
