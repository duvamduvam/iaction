/*
 * Panneaux latéraux rétractables des pages de conversation (Projets et Chat) :
 * l'état partagé « visible / replié » et la poignée qui le bascule.
 *
 * Pourquoi un store module-scope plutôt qu'un état React remonté dans App.tsx
 * (même choix que contextBus.ts / usageBus.ts) : le raccourci global Ctrl+L
 * vit dans App.tsx, les panneaux dans AgentPage.tsx et ChatPage.tsx, et les
 * six pages restent TOUTES montées en permanence (voir `.page-slot--hidden`).
 * Faire descendre deux booléens de plus à travers les props de deux pages qui
 * en portent déjà plusieurs dizaines n'aurait rien clarifié — ici App.tsx
 * appelle une fonction, les pages s'abonnent, personne ne se connaît.
 *
 * Persistance : `localStorage`, même convention que SidebarSection.tsx
 * (`iaction:panneau:<côté>`). Le défaut est « visible » — un panneau replié
 * est une décision de l'utilisateur, jamais un état initial subi. Toute
 * lecture/écriture est enveloppée : `window` n'existe pas sous vitest
 * (environnement node), et le mode privé strict peut refuser l'écriture.
 */
import { useSyncExternalStore } from "react";

export type CotePanneau = "gauche" | "droit";

const PREFIXE_STOCKAGE = "iaction:panneau:";

function lireStockage(cote: CotePanneau): boolean {
  try {
    // Seul "0" replie : une clé absente (premier lancement) laisse le panneau ouvert.
    return window.localStorage.getItem(`${PREFIXE_STOCKAGE}${cote}`) !== "0";
  } catch {
    return true;
  }
}

function ecrireStockage(cote: CotePanneau, visible: boolean) {
  try {
    window.localStorage.setItem(`${PREFIXE_STOCKAGE}${cote}`, visible ? "1" : "0");
  } catch {
    // best effort : la préférence ne survivra simplement pas au rechargement
  }
}

const etat: Record<CotePanneau, boolean> = {
  gauche: lireStockage("gauche"),
  droit: lireStockage("droit"),
};

const abonnes = new Set<() => void>();

function souscrire(cb: () => void): () => void {
  abonnes.add(cb);
  return () => {
    abonnes.delete(cb);
  };
}

/** Lecture hors React (tests, écouteur clavier). */
export function panneauVisible(cote: CotePanneau): boolean {
  return etat[cote];
}

export function reglerPanneau(cote: CotePanneau, visible: boolean): void {
  if (etat[cote] === visible) return;
  etat[cote] = visible;
  ecrireStockage(cote, visible);
  for (const cb of abonnes) cb();
}

export function basculerPanneau(cote: CotePanneau): void {
  reglerPanneau(cote, !etat[cote]);
}

/**
 * Ctrl+L : tout replier tant qu'il reste un panneau ouvert, tout rouvrir
 * sinon. Le OU (plutôt qu'un ET) évite l'état intermédiaire irritant où, un
 * seul panneau étant replié à la main, la première frappe en OUVRE un au lieu
 * de dégager l'écran comme on le demandait.
 */
export function basculerTousPanneaux(): void {
  const cible = !(etat.gauche || etat.droit);
  reglerPanneau("gauche", cible);
  reglerPanneau("droit", cible);
}

export function usePanneauVisible(cote: CotePanneau): boolean {
  return useSyncExternalStore(
    souscrire,
    () => etat[cote],
    () => etat[cote],
  );
}
