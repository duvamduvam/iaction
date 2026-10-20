/*
 * Combien de temps l'encart « sous-agents » survit-il à son tour ? (T-091)
 *
 * Les deux propriétés qui font qu'il veut encore dire quelque chose : il ne
 * cache jamais un travail EN COURS, et il ne parle jamais d'un tour qu'on n'a
 * pas vu se terminer — c'est-à-dire d'une conversation simplement rouverte,
 * cas qui a produit le constat du 2026-08-27.
 */

import { describe, expect, it } from "vitest";

import { RETENTION_SOUS_AGENTS_MS, sousAgentsEncoreVisibles } from "./useSousAgentsRecents";

const T0 = 1_700_000_000_000;

describe("sousAgentsEncoreVisibles", () => {
  it("affiche pendant le tour, quoi qu'il arrive", () => {
    expect(sousAgentsEncoreVisibles({ streaming: true, finDuTour: null, maintenant: T0 })).toBe(true);
  });

  it("affiche encore quelques minutes après la fin du tour", () => {
    const juste = { streaming: false, finDuTour: T0, maintenant: T0 + RETENTION_SOUS_AGENTS_MS - 1 };
    expect(sousAgentsEncoreVisibles(juste)).toBe(true);
  });

  it("s'efface à l'échéance", () => {
    const echu = { streaming: false, finDuTour: T0, maintenant: T0 + RETENTION_SOUS_AGENTS_MS };
    expect(sousAgentsEncoreVisibles(echu)).toBe(false);
  });

  it("se tait sur un tour jamais vu finir — conversation rechargée du disque", () => {
    // Le cœur de T-091 : les tours persistés porteraient la liste, mais rien
    // n'a tourné dans cette fenêtre. Un encart qui parle d'il y a trois jours
    // au présent est pire que pas d'encart.
    expect(sousAgentsEncoreVisibles({ streaming: false, finDuTour: null, maintenant: T0 })).toBe(false);
  });

  it("garde un délai qui se compte en minutes, pas en secondes ni en heures", () => {
    expect(RETENTION_SOUS_AGENTS_MS).toBeGreaterThanOrEqual(60_000);
    expect(RETENTION_SOUS_AGENTS_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
