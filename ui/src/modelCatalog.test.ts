/*
 * Catalogue de modèles : tri, formats d'affichage, favoris, repères.
 *
 * Le contrat qui compte est celui des VALEURS INCONNUES : un modèle sans prix
 * n'est pas un modèle gratuit, un modèle sans taille de contexte n'est pas un
 * modèle sans contexte. Trié « prix croissant », l'inconnu va en fin de liste
 * — sinon le catalogue recommanderait en tête ce dont on ne sait rien.
 */
import { describe, expect, it } from "vitest";
import { formatContext, formatPricing, matchBenchNote, sortModels, splitFeatured } from "./modelCatalog";
import type { ModelDetail } from "./sidecar";

const modele = (id: string, extra: Partial<ModelDetail> = {}): ModelDetail => ({ id, ...extra });

describe("sortModels", () => {
  const cher = modele("cher", { pricing: { promptUsdPerM: 15, completionUsdPerM: 75 } });
  const donne = modele("donne", { pricing: { promptUsdPerM: 0.25, completionUsdPerM: 1.25 } });
  const sansPrix = modele("sans-prix");

  it("prix croissant : l'inconnu va en FIN, jamais en tête", () => {
    expect(sortModels([sansPrix, cher, donne], "price-in").map((m) => m.id)).toEqual([
      "donne",
      "cher",
      "sans-prix",
    ]);
    expect(sortModels([sansPrix, cher, donne], "price-out").map((m) => m.id)).toEqual([
      "donne",
      "cher",
      "sans-prix",
    ]);
  });

  it("contexte décroissant : l'inconnu va aussi en fin", () => {
    const grand = modele("grand", { contextLength: 200000 });
    const petit = modele("petit", { contextLength: 8192 });
    expect(sortModels([petit, modele("inconnu"), grand], "context").map((m) => m.id)).toEqual([
      "grand",
      "petit",
      "inconnu",
    ]);
  });

  it("par nom : replie sur l'id quand le nom manque", () => {
    const avecNom = modele("zzz", { name: "Aardvark" });
    const sansNom = modele("bbb");
    expect(sortModels([sansNom, avecNom], "name").map((m) => m.id)).toEqual(["zzz", "bbb"]);
  });

  it("ne mute pas la liste d'entrée", () => {
    const entree = [cher, donne];
    sortModels(entree, "price-in");
    expect(entree.map((m) => m.id)).toEqual(["cher", "donne"]);
  });
});

describe("formatPricing", () => {
  it("affiche les deux prix au centime", () => {
    expect(formatPricing({ promptUsdPerM: 3, completionUsdPerM: 15 })).toBe("3 $ / 15 $ /M");
    expect(formatPricing({ promptUsdPerM: 0.256, completionUsdPerM: 1.254 })).toBe("0.26 $ / 1.25 $ /M");
  });

  it("un seul prix connu : l'autre reste un tiret", () => {
    expect(formatPricing({ promptUsdPerM: 3 })).toBe("3 $ / — /M");
  });

  it("aucun prix : tiret seul, pas « — / — /M »", () => {
    expect(formatPricing()).toBe("—");
    expect(formatPricing({})).toBe("—");
  });

  it("un prix NUL est un prix, pas une inconnue", () => {
    // Les modèles gratuits existent (open-weight hébergés) : 0 doit s'afficher.
    expect(formatPricing({ promptUsdPerM: 0, completionUsdPerM: 0 })).toBe("0 $ / 0 $ /M");
  });
});

describe("formatContext", () => {
  it("abrège en k à partir de 1000", () => {
    expect(formatContext(200000)).toBe("200k");
    expect(formatContext(1000)).toBe("1k");
    expect(formatContext(999)).toBe("999");
  });

  it("inconnu ou nul : tiret", () => {
    expect(formatContext()).toBe("—");
    expect(formatContext(0)).toBe("—");
  });
});

describe("splitFeatured", () => {
  const modeles = [modele("a"), modele("b"), modele("c")];

  it("rend les favoris dans l'ORDRE D'AJOUT, pas l'ordre du catalogue", () => {
    expect(splitFeatured(modeles, ["c", "a"]).map((m) => m.id)).toEqual(["c", "a"]);
  });

  it("ignore un favori disparu du catalogue sans jeter", () => {
    expect(splitFeatured(modeles, ["b", "retire-du-catalogue"]).map((m) => m.id)).toEqual(["b"]);
  });
});

describe("matchBenchNote", () => {
  it("reconnaît une famille par motif, pas par id exact", () => {
    expect(matchBenchNote("anthropic/claude-sonnet-5")).toContain("MMLU-Pro");
  });

  it("un modèle hors table n'a simplement pas de badge", () => {
    expect(matchBenchNote("mon-fine-tune-maison")).toBeNull();
  });
});
