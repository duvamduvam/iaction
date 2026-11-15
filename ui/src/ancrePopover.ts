/*
 * Popover ancré à un bouton — partagé par ModelPicker et Deroulant.
 *
 * ── Pourquoi un portail ────────────────────────────────────────────────
 * Ces contrôles vivent dans `.sidebar-section`, qui porte `overflow: hidden`
 * (App.css) : un popover en `position: absolute` y serait COUPÉ. Il est donc
 * rendu ailleurs en `position: fixed`, aux coordonnées du bouton — recalculées
 * au défilement et au redimensionnement plutôt que fermées, pour que la liste
 * ne disparaisse pas sous le doigt.
 *
 * ── Pourquoi pas toujours `document.body` ──────────────────────────────
 * `Modal.tsx` repose sur `showModal()` : le `<dialog>` passe dans la top layer
 * et tout ce qui est hors de lui devient inerte. Un popover porté sur `body`
 * s'y afficherait DERRIÈRE la modale, et ne recevrait aucun clic.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface PositionPopover {
  left: number;
  width: number;
  /** Place réellement disponible du côté retenu, bornée par `hauteurMax`. */
  hauteur: number;
  /** L'un des deux seulement : `top` (ouverture vers le bas) ou `bottom` (vers le haut). */
  top?: number;
  bottom?: number;
}

export interface GabaritPopover {
  largeurMin: number;
  hauteurMax: number;
}

const MARGE = 8;
const ECART = 4;

export function calculerPosition(
  rect: Pick<DOMRect, "left" | "top" | "bottom" | "width">,
  vue: { largeur: number; hauteur: number },
  { largeurMin, hauteurMax }: GabaritPopover,
): PositionPopover {
  const width = Math.max(rect.width, largeurMin);
  const left = Math.max(MARGE, Math.min(rect.left, vue.largeur - width - MARGE));
  const placeEnDessous = vue.hauteur - rect.bottom;
  const versLeBas = placeEnDessous >= hauteurMax || placeEnDessous >= rect.top;
  const place = (versLeBas ? placeEnDessous : rect.top) - ECART - MARGE;
  const hauteur = Math.min(hauteurMax, place);
  return versLeBas
    ? { left, width, hauteur, top: rect.bottom + ECART }
    : { left, width, hauteur, bottom: vue.hauteur - rect.top + ECART };
}

/** Où porter le popover : la modale englobante s'il y en a une (voir l'en-tête). */
export function conteneurPopover(bouton: HTMLElement | null): HTMLElement {
  return bouton?.closest("dialog") ?? document.body;
}

/** `surDehors` doit être stable (`useCallback`) : il entre dans les dépendances de l'effet. */
export function useAncrePopover(ouvert: boolean, gabarit: GabaritPopover, surDehors: () => void) {
  const boutonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PositionPopover | null>(null);

  const positionner = useCallback(() => {
    const bouton = boutonRef.current;
    if (!bouton) return;
    const vue = { largeur: window.innerWidth, hauteur: window.innerHeight };
    setPosition(calculerPosition(bouton.getBoundingClientRect(), vue, gabarit));
  }, [gabarit]);

  // Position suivie plutôt que figée : la barre latérale défile, et un popover
  // `fixed` resterait sinon accroché à la place que le bouton occupait.
  useEffect(() => {
    if (!ouvert) return;
    const suivre = (e: Event) => {
      // Le défilement DANS la liste ne déplace pas le bouton : l'ignorer,
      // sinon chaque cran de molette recalcule pour rien.
      if (e.type === "scroll" && popoverRef.current?.contains(e.target as Node)) return;
      positionner();
    };
    window.addEventListener("scroll", suivre, true);
    window.addEventListener("resize", suivre);
    return () => {
      window.removeEventListener("scroll", suivre, true);
      window.removeEventListener("resize", suivre);
    };
  }, [ouvert, positionner]);

  // Clic hors du popover ET hors du bouton : fermeture. `mousedown` plutôt que
  // `click` pour fermer avant qu'un autre contrôle ne prenne le focus.
  useEffect(() => {
    if (!ouvert) return;
    const dehors = (e: MouseEvent) => {
      const cible = e.target as Node;
      if (popoverRef.current?.contains(cible) || boutonRef.current?.contains(cible)) return;
      surDehors();
    };
    document.addEventListener("mousedown", dehors);
    return () => document.removeEventListener("mousedown", dehors);
  }, [ouvert, surDehors]);

  return { boutonRef, popoverRef, position, positionner };
}
