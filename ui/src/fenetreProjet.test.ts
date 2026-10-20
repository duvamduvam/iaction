/*
 * T-062 — une seule fenêtre par projet. `cleDernierProjet` verrouille la
 * compatibilité des postes existants (la fenêtre historique `main` garde sa
 * clé) ; `choisirProjetInitial` verrouille qu'on n'ouvre JAMAIS un projet
 * déjà porté par une autre fenêtre, sans jamais laisser un écran vide sans
 * raison quand un projet libre existe.
 */
import { describe, expect, it } from "vitest";
import type { UsageProjet } from "./usageStatsClient";
import { cleDernierProjet, choisirProjetInitial, FENETRE_PRINCIPALE, poidsDepuisStats } from "./fenetreProjet";

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

  it("mémorisé porté par une AUTRE fenêtre : repli sur le premier projet libre (sans stats)", () => {
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

describe("choisirProjetInitial — le projet libre le plus utilisé d'abord", () => {
  const poids = { p1: 10, p2: 500, p3: 80 };

  it("fenêtre principale sans souvenir : le plus utilisé des libres", () => {
    expect(choisirProjetInitial(null, ["p1", "p2", "p3"], {}, "main", poids)).toBe("p2");
  });

  it("fenêtre principale : le souvenir libre passe avant l'usage", () => {
    expect(choisirProjetInitial("p1", ["p1", "p2", "p3"], {}, "main", poids)).toBe("p1");
  });

  it("fenêtre principale, souvenir pris ailleurs : le plus utilisé des restants", () => {
    expect(choisirProjetInitial("p1", ["p1", "p2", "p3"], { p1: "main-2", p2: "main-3" }, "main", poids)).toBe("p3");
  });

  it("fenêtre secondaire : le souvenir est ignoré", () => {
    expect(choisirProjetInitial("p1", ["p1", "p2", "p3"], { p3: "main" }, "main-2", poids)).toBe("p2");
  });

  it("ne choisit jamais un projet déjà ouvert, même le plus utilisé", () => {
    expect(choisirProjetInitial(null, ["p1", "p2", "p3"], { p2: "main" }, "main-2", poids)).toBe("p3");
  });

  it("égalité ou absent des stats : ordre de la liste déclarée", () => {
    expect(choisirProjetInitial(null, ["p1", "p2", "p3"], {}, "main-2", { p1: 5, p2: 5, p3: 5 })).toBe("p1");
    expect(choisirProjetInitial(null, ["p1", "p2", "p3"], {}, "main-2", { p3: 7 })).toBe("p3");
    expect(choisirProjetInitial(null, ["p1", "p2", "p3"], {}, "main-2", {})).toBe("p1");
  });

  it("tout est ouvert : null", () => {
    expect(choisirProjetInitial(null, ["p1"], { p1: "main" }, "main-2", poids)).toBeNull();
  });
});

describe("poidsDepuisStats", () => {
  const ligne = (projectId: string | null, totalTokens: number, tours = 1): UsageProjet => ({
    projectId,
    name: String(projectId),
    tours,
    totalTokens,
    partTokensPct: null,
    autonomeTours: 0,
    autonomeTokens: 0,
    autonomePct: null,
  });

  it("pondère par les tokens, en ignorant le résidu et le Chat", () => {
    expect(poidsDepuisStats([ligne("p1", 100), ligne(null, 900), ligne("chat", 800), ligne("p2", 300)])).toEqual({
      p1: 100,
      p2: 300,
    });
  });

  it("sans aucun token compté : repli sur les tours", () => {
    expect(poidsDepuisStats([ligne("p1", 0, 3), ligne("p2", 0, 9)])).toEqual({ p1: 3, p2: 9 });
  });

  it("stats absentes : table vide", () => {
    expect(poidsDepuisStats(null)).toEqual({});
  });
});
