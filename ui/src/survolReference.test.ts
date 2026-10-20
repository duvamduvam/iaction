/*
 * Réglage « ouvrir au survol » (T-104) : normalisation pure et bus
 * module-scope. Aucun accès Tauri ici — `chargerSurvol`/`enregistrerSurvol`
 * ne sont pas testés (voir refFichier.test.ts pour le même parti pris sur
 * `classerReference`/`estReferenceCliquable`).
 */

import { describe, expect, it } from "vitest";

import {
  SURVOL_DEFAUT,
  SURVOL_DELAI_MAX,
  SURVOL_DELAI_MIN,
  appliquerSurvol,
  doitArmerSurvol,
  lireReglageSurvol,
  subscribeSurvol,
  survolCourant,
} from "./survolReference";

describe("normalisation d'un réglage de survol", () => {
  it("retombe sur les défauts pour une valeur absente ou malformée", () => {
    expect(lireReglageSurvol(undefined)).toEqual(SURVOL_DEFAUT);
    expect(lireReglageSurvol(null)).toEqual(SURVOL_DEFAUT);
    expect(lireReglageSurvol("700")).toEqual(SURVOL_DEFAUT);
    expect(lireReglageSurvol(["actif", 700])).toEqual(SURVOL_DEFAUT);
    expect(lireReglageSurvol({})).toEqual(SURVOL_DEFAUT);
  });

  it("n'accepte `actif` que sous forme du booléen true", () => {
    expect(lireReglageSurvol({ actif: true, delaiMs: 700 })).toEqual({ actif: true, delaiMs: 700 });
    expect(lireReglageSurvol({ actif: "true", delaiMs: 700 })).toEqual({ actif: false, delaiMs: 700 });
    expect(lireReglageSurvol({ actif: 1, delaiMs: 700 })).toEqual({ actif: false, delaiMs: 700 });
    expect(lireReglageSurvol({ actif: false, delaiMs: 700 })).toEqual({ actif: false, delaiMs: 700 });
  });

  it("ramène un délai trop bas à la borne basse, sans rejeter le réglage", () => {
    expect(lireReglageSurvol({ actif: true, delaiMs: 0 })).toEqual({ actif: true, delaiMs: SURVOL_DELAI_MIN });
    expect(lireReglageSurvol({ actif: true, delaiMs: -50 })).toEqual({ actif: true, delaiMs: SURVOL_DELAI_MIN });
  });

  it("ramène un délai trop haut à la borne haute, sans rejeter le réglage", () => {
    expect(lireReglageSurvol({ actif: true, delaiMs: 999_999 })).toEqual({
      actif: true,
      delaiMs: SURVOL_DELAI_MAX,
    });
  });

  it("garde un délai déjà dans les bornes", () => {
    expect(lireReglageSurvol({ actif: true, delaiMs: 1200 })).toEqual({ actif: true, delaiMs: 1200 });
  });

  it("retombe sur le délai par défaut si `delaiMs` n'est pas un nombre fini", () => {
    expect(lireReglageSurvol({ actif: true, delaiMs: "700" })).toEqual({
      actif: true,
      delaiMs: SURVOL_DEFAUT.delaiMs,
    });
    expect(lireReglageSurvol({ actif: true, delaiMs: NaN })).toEqual({
      actif: true,
      delaiMs: SURVOL_DEFAUT.delaiMs,
    });
    expect(lireReglageSurvol({ actif: true, delaiMs: Infinity })).toEqual({
      actif: true,
      delaiMs: SURVOL_DEFAUT.delaiMs,
    });
  });
});

describe("bus de notification", () => {
  it("notifie un abonné quand le réglage change réellement", () => {
    // `appliquerSurvol` est la partie pure du bus (cache + notification),
    // partagée par chargerSurvol/enregistrerSurvol sans jamais toucher Tauri.
    let appels = 0;
    const desabonner = subscribeSurvol(() => {
      appels += 1;
    });

    appliquerSurvol({ actif: true, delaiMs: 900 });
    expect(appels).toBe(1);
    expect(survolCourant()).toEqual({ actif: true, delaiMs: 900 });

    // Reposer EXACTEMENT le même réglage ne redéclenche rien (identité stable).
    appliquerSurvol({ actif: true, delaiMs: 900 });
    expect(appels).toBe(1);

    desabonner();
  });

  it("un abonné désabonné ne reçoit plus rien", () => {
    let appels = 0;
    const desabonner = subscribeSurvol(() => {
      appels += 1;
    });
    desabonner();

    appliquerSurvol({ actif: false, delaiMs: 1500 });
    expect(appels).toBe(0);
  });
});

/*
 * Les trois garde-fous du survol. Ils n'ont pas de test DOM (le projet n'a pas
 * d'environnement de rendu en test) : c'est précisément pour ça que la
 * décision a été sortie du gestionnaire d'événement. Ce qui suit est donc la
 * SEULE chose qui empêche un garde-fou de disparaître sans bruit.
 */
describe("décision d'armement au survol", () => {
  it("n'arme rien quand l'option est éteinte", () => {
    expect(doitArmerSurvol(null, "mouse", false)).toBe(false);
  });

  it("arme au pointeur souris quand l'option est active", () => {
    expect(doitArmerSurvol(700, "mouse", false)).toBe(true);
  });

  it("n'arme jamais au doigt ni au stylet — un écran tactile n'a pas de survol", () => {
    expect(doitArmerSurvol(700, "touch", false)).toBe(false);
    expect(doitArmerSurvol(700, "pen", false)).toBe(false);
    expect(doitArmerSurvol(700, "", false)).toBe(false);
  });

  it("ne réarme pas après un déclenchement tant qu'on n'est pas ressorti", () => {
    expect(doitArmerSurvol(700, "mouse", true)).toBe(false);
  });
});
