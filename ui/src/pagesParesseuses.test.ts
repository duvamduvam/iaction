/*
 * Charger une page plus tard, oui ; la perdre, jamais.
 *
 * Le gain de T-029 (ne pas payer 7 Mo de JavaScript au démarrage pour cinq
 * pages qu'on n'a pas ouvertes) ne vaut que s'il ne coûte rien à l'état de
 * l'application. Les six pages étaient montées en permanence pour une raison
 * précise : une conversation en cours, un streaming, des logs chargés ne
 * doivent pas disparaître parce qu'on est allé voir un autre onglet.
 *
 * D'où l'invariant verrouillé ici : une page montée le RESTE, quelle que soit
 * la page active ensuite.
 */

import { describe, expect, it } from "vitest";

import { monter, slotClass } from "./pagesParesseuses";

describe("monter", () => {
  it("ne monte rien tant que la page n'a pas été demandée", () => {
    expect(monter(false, false)).toBe(false);
  });

  it("monte la page dès sa première visite", () => {
    expect(monter(false, true)).toBe(true);
  });

  it("garde montée une page déjà vue, même quand on la quitte", () => {
    expect(monter(true, false)).toBe(true);
    expect(monter(true, true)).toBe(true);
  });
});

describe("slotClass", () => {
  it("masque le slot inactif au lieu de le retirer", () => {
    expect(slotClass(true)).toBe("page-slot");
    expect(slotClass(false)).toContain("page-slot--hidden");
  });
});
