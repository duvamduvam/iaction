/*
 * Socle de l'interface.
 *
 * Ces fonctions sont partagées par toute l'application : un écart ici se voit
 * partout. Les cas ci-dessous fixent la version RETENUE de deux helpers qui
 * existaient en plusieurs exemplaires divergents avant le 2026-08-07 — c'est
 * précisément ce que ce fichier empêche de recommencer.
 */
import { describe, expect, it } from "vitest";
import { asRecord, isNonEmptyString, toMessage } from "./base";

describe("toMessage", () => {
  it("prend le message d'une Error", () => {
    expect(toMessage(new Error("réseau coupé"))).toBe("réseau coupé");
  });

  it("rend une chaîne telle quelle", () => {
    expect(toMessage("fournisseur inconnu")).toBe("fournisseur inconnu");
  });

  it("SÉRIALISE un objet au lieu d'afficher « [object Object] »", () => {
    // C'est toute la différence avec la version naïve qui traînait dans
    // OrchestrationPage : `String({code: 42})` donne « [object Object] », qui
    // ne dit rien à l'utilisateur et rien au développeur.
    expect(toMessage({ code: 42, detail: "quota" })).toBe('{"code":42,"detail":"quota"}');
  });

  it("ne se laisse pas piéger par une référence circulaire", () => {
    const boucle: Record<string, unknown> = {};
    boucle.self = boucle;
    expect(toMessage(boucle)).toBe("erreur inconnue");
  });

  it("gère les valeurs vides sans jeter", () => {
    expect(toMessage(null)).toBe("null");
    expect(toMessage(undefined)).toBe("erreur inconnue");
  });
});

describe("asRecord", () => {
  it("laisse passer un objet simple", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it("EXCLUT les tableaux — `typeof []` vaut pourtant « object »", () => {
    // La version divergente de speechAdmin les laissait passer : les lectures
    // de champs nommés ressortaient alors `undefined`, sans la moindre erreur.
    expect(asRecord([1, 2])).toEqual({});
  });

  it("neutralise tout le reste", () => {
    expect(asRecord(null)).toEqual({});
    expect(asRecord(undefined)).toEqual({});
    expect(asRecord("texte")).toEqual({});
    expect(asRecord(42)).toEqual({});
  });
});

describe("isNonEmptyString", () => {
  it("distingue les quatre cas que le protocole peut envoyer", () => {
    expect(isNonEmptyString("x")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(0)).toBe(false);
  });
});
