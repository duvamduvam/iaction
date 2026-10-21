/*
 * T-162 — logique pure de la reprise d'une session Claude dans « Projets » :
 * la RAISON d'un refus (au lieu d'un booléen qui fondait quatre causes en un
 * seul message), le message de chacune, et l'attente bornée de la page
 * « Projets » quand elle n'a jamais été visitée (`SlotPage` ne la monte qu'à
 * la première visite, donc son `ref` est nul jusque-là).
 */

export type RaisonReprise = "ok" | "page-indisponible" | "projet-inconnu" | "tour-en-cours" | "autre-fenetre";

/** Message affiché dans le panneau pour un refus ; `null` pour `ok`. */
export function messageReprise(raison: RaisonReprise): string | null {
  switch (raison) {
    case "ok":
      return null;
    case "page-indisponible":
      return "Reprise impossible : la page Projets n'a pas pu s'ouvrir. La copie existe, relancez la reprise.";
    case "projet-inconnu":
      return "Reprise impossible : ce projet n'est plus déclaré dans IAction. La copie existe.";
    case "tour-en-cours":
      return "Reprise refusée : un tour est en cours dans Projets. Attendez sa fin puis relancez la reprise (la copie existe).";
    case "autre-fenetre":
      return "Reprise refusée : ce projet est ouvert dans une autre fenêtre d'IAction. Faites la reprise depuis cette fenêtre (la copie existe).";
  }
}

/** Nombre maximal d'images attendues : le montage suit le changement de page en 1 ou 2 images. */
export const IMAGES_ATTENTE_MAX = 30;

/**
 * Attend que `lire()` rende une valeur, au plus `maxImages` fois, en cédant la
 * main entre deux essais via `imageSuivante`. `null` si elle n'est jamais venue.
 */
export async function attendreDisponible<T>(
  lire: () => T | null | undefined,
  imageSuivante: () => Promise<void>,
  maxImages: number = IMAGES_ATTENTE_MAX,
): Promise<T | null> {
  for (let i = 0; i <= maxImages; i++) {
    const v = lire();
    if (v !== null && v !== undefined) return v;
    if (i < maxImages) await imageSuivante();
  }
  return null;
}

/** Image suivante du navigateur (repli sur un `setTimeout(0)` hors navigateur). */
export function imageSuivanteNavigateur(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
