/*
 * Registre des permissions (côté UI).
 *
 * Deux règles qui parlent de sécurité :
 *   - « plan » n'existe pas côté moteur neutre — le repli est UNIQUE ici,
 *     il était copié sept fois dans l'application ;
 *   - le « ne plus demander » est PAR PROJET : un Bash autorisé sur un
 *     projet ne doit jamais s'appliquer en silence à un autre.
 */
import { describe, expect, it } from "vitest";
import { cleAutoAllow, normaliserModePourMoteur, PERMISSION_MODE_OPTIONS } from "./permissions";

describe("normaliserModePourMoteur", () => {
  it("neutre : « plan » retombe sur « default », les autres modes passent", () => {
    expect(normaliserModePourMoteur("plan", "neutral")).toBe("default");
    expect(normaliserModePourMoteur("acceptEdits", "neutral")).toBe("acceptEdits");
    expect(normaliserModePourMoteur("bypassPermissions", "neutral")).toBe("bypassPermissions");
    expect(normaliserModePourMoteur("default", "neutral")).toBe("default");
  });

  it("claude : tout passe tel quel — c'est le SDK qui interprète, plan compris", () => {
    expect(normaliserModePourMoteur("plan", "claude")).toBe("plan");
    expect(normaliserModePourMoteur("bypassPermissions", "claude")).toBe("bypassPermissions");
  });
});

describe("cleAutoAllow — le « ne plus demander » ne fuit pas entre projets", () => {
  it("même outil, projets différents : clés différentes", () => {
    expect(cleAutoAllow("p1", "Bash")).not.toBe(cleAutoAllow("p2", "Bash"));
  });

  it("pas de collision par concaténation (séparateur hors vocabulaire)", () => {
    expect(cleAutoAllow("ab", "c")).not.toBe(cleAutoAllow("a", "bc"));
  });

  it("sans projet : clé stable, distincte de tout projet nommé", () => {
    expect(cleAutoAllow(null, "Bash")).toBe(cleAutoAllow(null, "Bash"));
    expect(cleAutoAllow(null, "Bash")).not.toBe(cleAutoAllow("p1", "Bash"));
  });
});

describe("PERMISSION_MODE_OPTIONS — la liste unique des deux sélecteurs", () => {
  it("les quatre modes, « plan » présent (c'est le sélecteur qui le filtre côté neutre)", () => {
    expect(PERMISSION_MODE_OPTIONS.map((o) => o.value)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
  });
});
