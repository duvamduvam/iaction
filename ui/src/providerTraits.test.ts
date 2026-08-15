/*
 * R8-A — profil du fournisseur côté interface.
 *
 * Deux contrats à tenir, et un seul est évident. Le premier : **champ vide →
 * propriété absente**, comme R0 — un `traits: {}` poussé au sidecar n'est pas
 * la même chose que pas de traits du tout. Le second, moins visible : la
 * validation doit être SOUPLE. Cette config est éditable à la main, et un
 * profil à moitié faux doit dégrader vers le comportement standard, jamais
 * rendre le fournisseur inutilisable.
 */
import { describe, expect, it } from "vitest";
import {
  PROFILS_CONNUS,
  bodyExtrasRecevable,
  construireTraits,
  nettoyerTraits,
} from "./providerTraits";

const formulaireVierge = {
  catalogUrl: "",
  catalogShape: "",
  usageTrustworthy: true,
  bodyExtrasText: "",
};

describe("construireTraits", () => {
  it("formulaire vierge : AUCUN trait, pas un objet vide", () => {
    expect(construireTraits(formulaireVierge)).toBeUndefined();
  });

  it("la comptabilité fiable étant le défaut, la case cochée n'écrit rien", () => {
    expect(construireTraits({ ...formulaireVierge, usageTrustworthy: true })).toBeUndefined();
    expect(construireTraits({ ...formulaireVierge, usageTrustworthy: false })).toEqual({
      usageTrustworthy: false,
    });
  });

  it("profil Swiftask saisi à la main : les quatre traits", () => {
    expect(
      construireTraits({
        catalogUrl: "  https://graphql.swiftask.ai/public/bots  ",
        catalogShape: "slugs",
        usageTrustworthy: false,
        bodyExtrasText: '{"stateless": true}',
      }),
    ).toEqual({
      catalogUrl: "https://graphql.swiftask.ai/public/bots",
      catalogShape: "slugs",
      usageTrustworthy: false,
      bodyExtras: { stateless: true },
    });
  });

  it("JSON illisible : le reste du profil survit", () => {
    expect(construireTraits({ ...formulaireVierge, catalogShape: "slugs", bodyExtrasText: "{oups" })).toEqual({
      catalogShape: "slugs",
    });
  });

  it("les clés du cœur de la requête sont retirées", () => {
    expect(
      construireTraits({ ...formulaireVierge, bodyExtrasText: '{"model":"pirate","stateless":true}' }),
    ).toEqual({ bodyExtras: { stateless: true } });
    // Un bodyExtras qui ne contenait QUE des clés réservées ne laisse rien.
    expect(construireTraits({ ...formulaireVierge, bodyExtrasText: '{"messages":[]}' })).toBeUndefined();
  });
});

describe("nettoyerTraits", () => {
  it("traits mal formés : entièrement retirés, jamais d'erreur", () => {
    expect(nettoyerTraits({ catalogShape: "xxx", catalogUrl: 42, bodyExtras: "non" })).toBeUndefined();
    expect(nettoyerTraits("pas un objet")).toBeUndefined();
    expect(nettoyerTraits(undefined)).toBeUndefined();
  });

  it("profil partiellement valide : seul le trait fautif tombe", () => {
    expect(nettoyerTraits({ catalogUrl: "ftp://x", catalogShape: "slugs" })).toEqual({
      catalogShape: "slugs",
    });
  });
});

describe("bodyExtrasRecevable", () => {
  it("vide = recevable (il n'y a rien à envoyer)", () => {
    expect(bodyExtrasRecevable("   ")).toBe(true);
  });

  it("refuse ce qui n'est pas un objet JSON", () => {
    expect(bodyExtrasRecevable("{oups")).toBe(false);
    expect(bodyExtrasRecevable("[1,2]")).toBe(false);
    expect(bodyExtrasRecevable('"texte"')).toBe(false);
    expect(bodyExtrasRecevable('{"stateless":true}')).toBe(true);
  });
});

describe("PROFILS_CONNUS", () => {
  it("le préréglage Swiftask porte les six traits mesurés (2026-08-10, puis T-036)", () => {
    const swiftask = PROFILS_CONNUS.find((p) => p.id === "swiftask");
    expect(swiftask?.traits).toEqual({
      catalogUrl: "https://graphql.swiftask.ai/public/bots",
      catalogShape: "slugs",
      usageTrustworthy: false,
      // T-036 — `usage.cost` est une extension OpenRouter : Swiftask ne la
      // sert pas, et aucun réglage ne l'y fera apparaître. Déclaré, donc, au
      // lieu d'être compté comme une mesure manquante.
      coutRemonte: false,
      billing: "paid",
      bodyExtras: { stateless: true },
    });
  });

  it("les profils standard ne déclarent QUE leur facturation (T-023)", () => {
    // L'invariant d'origine — « un profil vide n'est pas un profil oublié » —
    // visait les traits de DIALECTE : OpenRouter et Ollama parlent le cas
    // standard, et rien ne doit laisser croire l'inverse. La facturation, elle,
    // n'est pas un dialecte : c'est un fait du fournisseur, et T-023 demande
    // précisément qu'il soit déclaré au lieu d'être deviné sur son nom.
    expect(PROFILS_CONNUS.find((p) => p.id === "openrouter")?.traits).toEqual({
      billing: "paid",
      // T-023 — la jauge de solde est un chemin déclaré, plus un nom de marque
      // inscrit dans le protocole.
      creditsPath: "credits",
    });
    expect(PROFILS_CONNUS.find((p) => p.id === "ollama")?.traits).toEqual({ billing: "free" });
  });

  it("chaque préréglage survit à sa propre validation", () => {
    for (const profil of PROFILS_CONNUS) {
      if (profil.traits) expect(nettoyerTraits(profil.traits)).toEqual(profil.traits);
    }
  });
});
