/*
 * Libellé de l'avancement de la recherche web (R9).
 *
 * L'enjeu tient en une phrase : quand la recherche n'a PAS eu lieu,
 * l'utilisateur doit le lire. Sans ça, une réponse produite de mémoire a
 * exactement l'apparence d'une réponse sourcée — c'est le constat qui a
 * ouvert T-010.
 */
import { describe, expect, it } from "vitest";
import { libelleAvancementWeb, parseEtatWeb } from "./rechercheWeb";
import type { AvancementWeb } from "./rechercheWeb";

const av = (partiel: Partial<AvancementWeb>): AvancementWeb => ({ etat: "ok", sources: [], ...partiel });
const source = (n: number) => ({ n, titre: `Titre ${n}`, url: `https://a.exemple.fr/${n}` });

describe("parseEtatWeb — tolérance d'un flux en cours", () => {
  it("lit un chunk complet", () => {
    const lu = parseEtatWeb({ etat: "ok", sources: [{ n: 1, titre: "T", url: "https://a.exemple.fr" }] });
    expect(lu).toEqual({ etat: "ok", sources: [{ n: 1, titre: "T", url: "https://a.exemple.fr" }] });
  });

  it("renvoie null sur ce qui n'est pas un chunk web — le flux retombe alors sur `delta`", () => {
    for (const brut of [undefined, null, 42, "ok", {}, { etat: "inconnu" }]) {
      expect(parseEtatWeb(brut)).toBeNull();
    }
  });

  it("écarte les sources mal formées sans perdre les bonnes", () => {
    // Un sidecar plus récent pourrait envoyer une forme enrichie : on ne doit
    // ni jeter le chunk entier, ni laisser passer une entrée inexploitable.
    const lu = parseEtatWeb({
      etat: "ok",
      sources: [{ n: 1, titre: "T", url: "https://a.exemple.fr" }, { n: "deux", titre: "U", url: "https://b.exemple.fr" }, null],
    });
    expect(lu?.sources).toHaveLength(1);
  });

  it("accepte un état sans sources, et ne fabrique pas de message", () => {
    expect(parseEtatWeb({ etat: "recherche" })).toEqual({ etat: "recherche", sources: [] });
    expect(parseEtatWeb({ etat: "echec", message: 42 })).toEqual({ etat: "echec", sources: [] });
  });
});

describe("libelleAvancementWeb", () => {
  it("annonce la recherche pendant qu'elle a lieu", () => {
    expect(libelleAvancementWeb(av({ etat: "recherche" }))).toBe("Recherche web…");
  });

  it("compte les sources, au singulier comme au pluriel", () => {
    expect(libelleAvancementWeb(av({ etat: "ok", sources: [source(1)] }))).toBe("Recherche web : 1 source");
    expect(libelleAvancementWeb(av({ etat: "ok", sources: [source(1), source(2)] }))).toBe(
      "Recherche web : 2 sources",
    );
  });

  it("dit que la réponse n'est PAS vérifiée quand rien n'a été trouvé", () => {
    const texte = libelleAvancementWeb(av({ etat: "vide" }));
    expect(texte).toContain("aucun résultat");
    expect(texte).toContain("n'est pas vérifiée");
  });

  it("dit que la réponse n'est PAS vérifiée quand le moteur est en panne, et pourquoi", () => {
    const texte = libelleAvancementWeb(av({ etat: "echec", message: "connexion refusée" }));
    expect(texte).toContain("indisponible");
    expect(texte).toContain("connexion refusée");
    expect(texte).toContain("n'est pas vérifiée");
  });

  it("reste explicite même sans cause connue", () => {
    // Un échec sans message ne doit pas produire une parenthèse vide ni, pire,
    // un libellé qui laisserait croire que tout va bien.
    const texte = libelleAvancementWeb(av({ etat: "echec" }));
    expect(texte).toBe("Recherche web indisponible — la réponse n'est pas vérifiée.");
    expect(texte).not.toContain("()");
  });

  it("ne rend jamais une chaîne vide, quel que soit l'état", () => {
    for (const etat of ["recherche", "ok", "vide", "echec"] as const) {
      expect(libelleAvancementWeb(av({ etat })).length).toBeGreaterThan(0);
    }
  });
});
