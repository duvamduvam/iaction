/*
 * Réglages réseau d'entreprise (T-045).
 *
 * L'invariant qui compte n'est pas « le formulaire enregistre » — c'est
 * qu'ouvrir l'encart, ne rien saisir et refermer laisse l'environnement du
 * sidecar identique à l'octet près. Une clé `reseau: {}` écrite par mégarde
 * n'aurait rien cassé aujourd'hui, mais elle aurait rendu la promesse fausse
 * le jour où un champ vide aurait pris un sens.
 */

import { describe, expect, it } from "vitest";

import { avertissementProxy, lireReglages, RESEAU_VIDE, versConfig } from "./reseauAdmin";

describe("lecture des réglages", () => {
  it("tolère l'absence, le mauvais type et les blancs", () => {
    expect(lireReglages(undefined)).toEqual(RESEAU_VIDE);
    expect(lireReglages("http://proxy:3128")).toEqual(RESEAU_VIDE);
    expect(lireReglages({ proxy: 42, caSysteme: "oui" })).toEqual(RESEAU_VIDE);
    expect(lireReglages({ proxy: "   " })).toEqual(RESEAU_VIDE);
  });

  it("rogne les espaces d'une saisie collée", () => {
    // Un proxy se colle depuis une note ou un courriel : les espaces autour
    // sont la règle, pas l'exception.
    expect(lireReglages({ proxy: "  http://proxy:3128  " }).proxy).toBe("http://proxy:3128");
  });
});

describe("écriture", () => {
  it("n'écrit RIEN quand rien n'est saisi", () => {
    expect(versConfig(RESEAU_VIDE)).toEqual({});
  });

  it("omet les champs vides plutôt que de les écrire vides", () => {
    expect(versConfig({ ...RESEAU_VIDE, proxy: "http://proxy:3128" })).toEqual({
      proxy: "http://proxy:3128",
    });
  });

  it("n'écrit le drapeau système que s'il est demandé", () => {
    expect(versConfig({ ...RESEAU_VIDE, caSysteme: true })).toEqual({ caSysteme: true });
    expect("caSysteme" in versConfig(RESEAU_VIDE)).toBe(false);
  });

  it("fait un aller-retour fidèle", () => {
    const r = {
      proxy: "http://proxy:3128",
      sansProxy: "localhost,127.0.0.1",
      autorite: "/etc/ssl/entreprise.pem",
      caSysteme: true,
    };
    expect(lireReglages(versConfig(r))).toEqual(r);
  });
});

describe("avertissement sur le proxy", () => {
  it("ne dit rien sur une saisie vide ou correcte", () => {
    expect(avertissementProxy("")).toBeNull();
    expect(avertissementProxy("http://proxy:3128")).toBeNull();
    expect(avertissementProxy("https://proxy.example.com:8080")).toBeNull();
  });

  it("réclame le schéma, sans refuser la saisie", () => {
    // On signale, l'utilisateur tranche : un proxy d'entreprise peut prendre
    // des formes qu'on ne connaît pas, et bloquer sur une règle devinée serait
    // pire que de le laisser essayer.
    expect(avertissementProxy("proxy:3128")).toMatch(/schéma/);
  });

  it("prévient qu'un mot de passe dans l'URL est stocké en clair", () => {
    const a = avertissementProxy("http://jean:secret@proxy:3128");
    expect(a).toMatch(/mot de passe/);
    expect(a).toMatch(/clair/);
  });

  it("ne prend pas un port pour un mot de passe", () => {
    expect(avertissementProxy("http://proxy:3128")).toBeNull();
  });
});
