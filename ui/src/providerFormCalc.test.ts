/*
 * Contrat du formulaire fournisseur.
 *
 * Le cas qui justifie ce fichier est le contrat R0 : **champ vide → propriété
 * ABSENTE**, jamais `false` ni `[]`. Le sidecar traite ces réglages en opt-in
 * pur ; `fallbackModels: []` et « pas de fallbackModels » ne sont pas la même
 * chose une fois arrivés chez OpenRouter, et cet écart ne fait de bruit dans
 * aucune couche.
 */
import { describe, expect, it } from "vitest";
import { construireFournisseur, fournisseurRecevable, parseFallbackModels } from "./providerFormCalc";

const saisieMinimale = {
  id: " mon-fournisseur ",
  label: " Mon fournisseur ",
  baseUrl: " https://api.example.com/v1 ",
  needsKey: true,
  fallbackModelsText: "",
  priceSort: false,
  usageAccounting: false,
};

describe("construireFournisseur", () => {
  it("réglages non renseignés : propriétés ABSENTES, pas false ni []", () => {
    const config = construireFournisseur(saisieMinimale);
    expect(config).toEqual({
      id: "mon-fournisseur",
      label: "Mon fournisseur",
      baseUrl: "https://api.example.com/v1",
      needsKey: true,
    });
    // toEqual ne distingue pas « absent » de « undefined » : on le vérifie.
    expect("fallbackModels" in config).toBe(false);
    expect("priceSort" in config).toBe(false);
    expect("usageAccounting" in config).toBe(false);
    // R8-A — même règle pour le profil : aucun trait saisi, aucune propriété.
    expect("traits" in config).toBe(false);
  });

  it("R8-A — un profil saisi voyage sous `traits` (contrat détaillé dans providerTraits.test)", () => {
    const config = construireFournisseur({
      ...saisieMinimale,
      catalogUrl: "https://exemple.test/public/bots",
      catalogShape: "slugs",
      usageTrustworthy: false,
      bodyExtrasText: '{"stateless": true}',
    });
    expect(config.traits).toEqual({
      catalogUrl: "https://exemple.test/public/bots",
      catalogShape: "slugs",
      usageTrustworthy: false,
      bodyExtras: { stateless: true },
    });
  });

  it("réglages activés : propriétés présentes à true", () => {
    const config = construireFournisseur({ ...saisieMinimale, priceSort: true, usageAccounting: true });
    expect(config.priceSort).toBe(true);
    expect(config.usageAccounting).toBe(true);
  });

  it("rogne id, libellé et URL", () => {
    const config = construireFournisseur(saisieMinimale);
    expect(config.id).toBe("mon-fournisseur");
    expect(config.baseUrl).toBe("https://api.example.com/v1");
  });

  it("modèles de secours : l'ORDRE de saisie est l'ordre d'essai", () => {
    const config = construireFournisseur({
      ...saisieMinimale,
      fallbackModelsText: "z-dernier-espoir, a-premier",
    });
    expect(config.fallbackModels).toEqual(["z-dernier-espoir", "a-premier"]);
  });
});

describe("parseFallbackModels", () => {
  it("accepte virgules ET retours ligne, mélangés", () => {
    expect(parseFallbackModels("a, b\nc,\n d ")).toEqual(["a", "b", "c", "d"]);
  });

  it("une saisie faite de vides ne produit RIEN", () => {
    expect(parseFallbackModels("")).toEqual([]);
    expect(parseFallbackModels(" ,\n, ")).toEqual([]);
  });
});

describe("fournisseurRecevable", () => {
  const brut = { id: "nouveau", label: "Nouveau", baseUrl: "https://x.example.com" };

  it("exige id, libellé et URL non vides — espaces exclus", () => {
    expect(fournisseurRecevable(brut, [], "add")).toBe(true);
    expect(fournisseurRecevable({ ...brut, id: "  " }, [], "add")).toBe(false);
    expect(fournisseurRecevable({ ...brut, label: "" }, [], "add")).toBe(false);
    expect(fournisseurRecevable({ ...brut, baseUrl: "" }, [], "add")).toBe(false);
  });

  it("en création, refuse un identifiant déjà pris — même à un espace près", () => {
    expect(fournisseurRecevable(brut, ["nouveau"], "add")).toBe(false);
    expect(fournisseurRecevable({ ...brut, id: " nouveau " }, ["nouveau"], "add")).toBe(false);
  });

  it("en édition, l'identifiant existe forcément : il n'est pas un doublon", () => {
    expect(fournisseurRecevable(brut, ["nouveau"], "edit")).toBe(true);
  });
});
