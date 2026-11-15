import { describe, expect, it } from "vitest";

import type { CompteDecrit } from "./comptesClaude";
import { compteEffectif, libelleDebord, nomCompteAffiche } from "./compteSupervision";

const PERSO: CompteDecrit = { id: "perso", label: "Perso", connecte: true };
const TEAMS: CompteDecrit = { id: "teams", label: "Équipe Duvam", connecte: true };

describe("compteEffectif", () => {
  it("garde teams quand le compte est listé", () => {
    expect(compteEffectif("teams", [PERSO, TEAMS])).toBe("teams");
  });
  it("retombe sur perso sans compte teams ou sans liste", () => {
    expect(compteEffectif("teams", [PERSO])).toBe("perso");
    expect(compteEffectif("teams", null)).toBe("perso");
  });
  it("perso reste perso", () => {
    expect(compteEffectif("perso", [PERSO, TEAMS])).toBe("perso");
  });
});

describe("nomCompteAffiche", () => {
  it("n'affiche rien pour perso", () => {
    expect(nomCompteAffiche("perso", [PERSO, TEAMS])).toBeNull();
  });
  it("affiche le nom rendu par claude.comptes pour teams", () => {
    expect(nomCompteAffiche("teams", [PERSO, TEAMS])).toBe("Équipe Duvam");
  });
  it("replie sur le libellé standard si le compte n'est plus listé", () => {
    expect(nomCompteAffiche("teams", null)).toBe("Claude Teams");
  });
});

describe("libelleDebord", () => {
  it("dit que le plafond ne compte que perso", () => {
    expect(libelleDebord("plafond : 10 $/mois")).toContain("perso seulement");
  });
});
