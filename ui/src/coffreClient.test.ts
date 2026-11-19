import { describe, expect, it } from "vitest";
import { fragmentDeControle, libelleEtat, lireEtatCoffre, texteMcpEcartes } from "./coffreClient";

describe("coffreClient", () => {
  it("lit un état valide et refuse le reste", () => {
    expect(lireEtatCoffre({ etat: "ouvert", attente: null })).toEqual({ etat: "ouvert", attente: null });
    expect(lireEtatCoffre({ etat: "verrouille", attente: { cause: "mise en veille", tours: 2 } })).toEqual({
      etat: "verrouille",
      attente: { cause: "mise en veille", tours: 2 },
    });
    expect(lireEtatCoffre({ etat: "autre" })).toBeNull();
    expect(lireEtatCoffre(null)).toBeNull();
  });

  it("annonce l'attente de fermeture avec le nombre de tours", () => {
    expect(libelleEtat({ etat: "ouvert", attente: { cause: "mise en veille", tours: 2 } })).toBe(
      "fermeture du coffre en attente : 2 tours en cours",
    );
    expect(libelleEtat({ etat: "ouvert", attente: { cause: "x", tours: 1 } })).toBe(
      "fermeture du coffre en attente : 1 tour en cours",
    );
    expect(libelleEtat({ etat: "verrouille", attente: null })).toBe("Coffre verrouillé");
    expect(libelleEtat({ etat: "absent", attente: null })).toBe("Coffre à créer");
  });

  it("prend la FIN de la clé de secours comme fragment de contrôle", () => {
    expect(fragmentDeControle("AGE-SECRET-KEY-1ABCDEFGHIJKLMNOP \n")).toBe("IJKLMNOP");
  });

  it("dit la cause d'un serveur MCP écarté", () => {
    expect(texteMcpEcartes({ serveurs: ["relais"], coffreVerrouille: true })).toMatch(
      /^Coffre verrouillé : le serveur MCP « relais » est écarté/,
    );
    expect(texteMcpEcartes({ serveurs: ["a", "b"], coffreVerrouille: false })).toMatch(
      /^Secret manquant : les serveurs MCP « a », « b » sont écartés/,
    );
  });
});

describe("lireEtatCoffre — repli sur la version précédente", () => {
  it("garde le drapeau seulement s'il est vrai", () => {
    expect(lireEtatCoffre({ etat: "ouvert", attente: null, repliPrecedent: true })).toEqual({
      etat: "ouvert",
      attente: null,
      repliPrecedent: true,
    });
    expect(lireEtatCoffre({ etat: "ouvert", attente: null, repliPrecedent: false })).toEqual({ etat: "ouvert", attente: null });
  });
});
