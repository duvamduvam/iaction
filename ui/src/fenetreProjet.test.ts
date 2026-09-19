/*
 * T-062 — une seule fenêtre par projet. `cleDernierProjet` verrouille la
 * compatibilité des postes existants (la fenêtre historique `main` garde sa
 * clé) ; `choisirProjetInitial` verrouille qu'on n'ouvre JAMAIS un projet
 * déjà porté par une autre fenêtre, sans jamais laisser un écran vide sans
 * raison quand un projet libre existe.
 */
import { describe, expect, it } from "vitest";
import { cleDernierProjet, choisirProjetInitial, FENETRE_PRINCIPALE } from "./fenetreProjet";

describe("cleDernierProjet — compat des postes existants", () => {
  it("la fenêtre historique garde la clé « last-project »", () => {
    expect(cleDernierProjet(FENETRE_PRINCIPALE)).toBe("last-project");
    expect(cleDernierProjet("main")).toBe("last-project");
  });

  it("une autre fenêtre prend une clé distincte, suffixée par son étiquette", () => {
    expect(cleDernierProjet("main-2")).toBe("last-project-main-2");
    expect(cleDernierProjet("main-3")).toBe("last-project-main-3");
  });

  it("deux fenêtres ne partagent jamais la même clé", () => {
    expect(cleDernierProjet("main-2")).not.toBe(cleDernierProjet("main-3"));
    expect(cleDernierProjet("main-2")).not.toBe(cleDernierProjet(FENETRE_PRINCIPALE));
  });
});

describe("choisirProjetInitial — au démarrage, jamais deux fenêtres sur le même projet", () => {
  it("mémorisé libre : on le rouvre", () => {
    expect(choisirProjetInitial("p2", ["p1", "p2", "p3"], {}, "main")).toBe("p2");
  });

  it("mémorisé porté par une AUTRE fenêtre : repli sur le premier projet libre", () => {
    expect(choisirProjetInitial("p2", ["p1", "p2", "p3"], { p2: "main-2" }, "main")).toBe("p1");
  });

  it("mémorisé porté par SOI-MÊME : idempotence, on le rouvre quand même", () => {
    expect(choisirProjetInitial("p2", ["p1", "p2", "p3"], { p2: "main" }, "main")).toBe("p2");
  });

  it("mémorisé disparu de la liste des projets déclarés : premier libre", () => {
    expect(choisirProjetInitial("supprime", ["p1", "p2"], {}, "main")).toBe("p1");
  });

  it("le premier projet libre saute par-dessus ceux déjà pris ailleurs", () => {
    expect(choisirProjetInitial(null, ["p1", "p2", "p3"], { p1: "main-2" }, "main")).toBe("p2");
  });

  it("tous les projets sont pris ailleurs : aucun écran à ouvrir", () => {
    expect(choisirProjetInitial(null, ["p1", "p2"], { p1: "main-2", p2: "main-3" }, "main")).toBeNull();
  });

  it("liste de projets vide : rien à ouvrir", () => {
    expect(choisirProjetInitial(null, [], {}, "main")).toBeNull();
    expect(choisirProjetInitial("p1", [], {}, "main")).toBeNull();
  });
});
