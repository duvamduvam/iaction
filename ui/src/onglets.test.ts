/*
 * Cycle des onglets de conversation.
 *
 * Le cas qui justifie ce fichier est le retour en arrière depuis le premier
 * onglet : `(0 - 1) % 3` vaut `-1` en JavaScript, et `ids[-1]` vaut `undefined`.
 * Sans le `+ ids.length`, Ctrl+Maj+Tab sur le premier onglet ne ferait rien —
 * et ça ne se voit ni au typecheck ni à la relecture.
 */
import { describe, expect, it } from "vitest";
import { prochainOnglet } from "./onglets";

const trois = ["a", "b", "c"];

describe("prochainOnglet", () => {
  it("avance dans l'ordre", () => {
    expect(prochainOnglet(trois, "a", 1)).toBe("b");
    expect(prochainOnglet(trois, "b", 1)).toBe("c");
  });

  it("boucle du dernier au premier", () => {
    expect(prochainOnglet(trois, "c", 1)).toBe("a");
  });

  it("RECULE du premier au dernier — le modulo négatif de JavaScript", () => {
    expect(prochainOnglet(trois, "a", -1)).toBe("c");
  });

  it("recule dans l'ordre ailleurs", () => {
    expect(prochainOnglet(trois, "c", -1)).toBe("b");
    expect(prochainOnglet(trois, "b", -1)).toBe("a");
  });

  it("ne fait rien avec moins de deux onglets", () => {
    expect(prochainOnglet([], "", 1)).toBeNull();
    expect(prochainOnglet(["a"], "a", 1)).toBeNull();
    expect(prochainOnglet(["a"], "a", -1)).toBeNull();
  });

  it("repart du premier quand l'onglet actif n'est plus dans la liste", () => {
    // Arrive juste après la fermeture de la conversation courante.
    expect(prochainOnglet(trois, "disparue", 1)).toBe("b");
    expect(prochainOnglet(trois, "disparue", -1)).toBe("c");
  });

  it("alterne entre deux onglets, dans les deux sens", () => {
    expect(prochainOnglet(["a", "b"], "a", 1)).toBe("b");
    expect(prochainOnglet(["a", "b"], "b", 1)).toBe("a");
    expect(prochainOnglet(["a", "b"], "a", -1)).toBe("b");
  });
});
