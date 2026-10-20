/*
 * Réveil d'une conversation (T-120) — module pur, horloge toujours injectée.
 * Voir docs/spec-reveil.md §8 pour la liste des six cas attendus.
 */
import { describe, expect, it } from "vitest";
import {
  estDu,
  echeanceAbandonnee,
  MARGE_RESET_MS,
  prochaineEcheance,
  RATTRAPAGE_MAX_MS,
  estHeureValide,
  HISTORIQUE_REVEILS_MAX,
  heuresAvecSaisie,
  toReveil,
  toReveils,
  toReveilsHistorique,
  type Reveil,
} from "./reveil";

function reveil(partiel: Partial<Reveil> = {}): Reveil {
  return {
    id: "r1",
    heures: [],
    surResetQuota: false,
    cibleReouverture: null,
    prompts: ["reprends"],
    dernierDeclenchement: null,
    ...partiel,
  };
}

describe("prochaineEcheance", () => {
  it("heure déjà passée aujourd'hui ⇒ demain", () => {
    // 2026-09-04 10:00 locale, heure armée 03:00 : déjà passée aujourd'hui.
    const maintenant = new Date(2026, 8, 4, 10, 0, 0, 0).getTime();
    const t = prochaineEcheance(reveil({ heures: ["03:00"] }), maintenant);
    expect(t).not.toBeNull();
    const d = new Date(t!);
    expect(d.getDate()).toBe(5);
    expect(d.getHours()).toBe(3);
    expect(d.getMinutes()).toBe(0);
  });

  it("plusieurs heures ⇒ la plus proche gagne", () => {
    const maintenant = new Date(2026, 8, 4, 1, 0, 0, 0).getTime();
    const t = prochaineEcheance(reveil({ heures: ["10:00", "03:00", "22:00"] }), maintenant);
    const attendu = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    expect(t).toBe(attendu);
  });

  it("surResetQuota sans silence actif ⇒ aucune échéance de ce côté (reste en sommeil)", () => {
    const maintenant = new Date(2026, 8, 4, 1, 0, 0, 0).getTime();
    expect(prochaineEcheance(reveil({ surResetQuota: true }), maintenant)).toBeNull();
  });

  it("surResetQuota ⇒ la cible FIGÉE à l'armement + marge, pas la seconde près", () => {
    const maintenant = new Date(2026, 8, 4, 1, 0, 0, 0).getTime();
    const reouverture = maintenant + 3_600_000; // rouvre dans 1 h
    const t = prochaineEcheance(
      reveil({ surResetQuota: true, cibleReouverture: new Date(reouverture).toISOString() }),
      maintenant,
    );
    expect(t).toBe(reouverture + MARGE_RESET_MS);
  });

  it("surResetQuota SANS cible ⇒ null : un réveil armé quand rien n'était connu reste inerte", () => {
    expect(prochaineEcheance(reveil({ surResetQuota: true }), Date.now())).toBeNull();
  });

  it("la cible ne bouge plus une fois passée : le réveil la voit DUE, il ne la perd pas", () => {
    // Le défaut du 2026-09-04 : la source relue à chaque battement se taisait
    // dès l'instant dépassé, donc l'échéance n'était jamais observée « due ».
    const reouverture = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    const arme = reveil({
      surResetQuota: true,
      cibleReouverture: new Date(reouverture).toISOString(),
      dernierDeclenchement: new Date(reouverture - 3_600_000).toISOString(),
    });
    expect(estDu(arme, reouverture + MARGE_RESET_MS + 1_000)).toBe(true);
  });

  it("aucune heure et surResetQuota faux ⇒ null (réveil sans échéance calculable)", () => {
    expect(prochaineEcheance(reveil(), Date.now())).toBeNull();
  });
});

describe("estDu — anti-double-tir", () => {
  it("une même échéance ne redéclenche pas au battement suivant", () => {
    const echeance = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    const r = reveil({ heures: ["03:00"] });
    // Premier battement après l'échéance : due.
    expect(estDu(r, echeance + 5_000)).toBe(true);
    // Le câblage honore l'échéance et pose dernierDeclenchement à l'instant du battement.
    const rHonore: Reveil = { ...r, dernierDeclenchement: new Date(echeance + 5_000).toISOString() };
    // Battement suivant, quelques secondes plus tard, même échéance du jour : plus due.
    expect(estDu(rHonore, echeance + 35_000)).toBe(false);
  });
});

describe("estDu — rattrapage borné", () => {
  it("échéance manquée de 2 h ⇒ rattrapée (due)", () => {
    const echeance = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    const maintenant = echeance + 2 * 3_600_000;
    expect(estDu(reveil({ heures: ["03:00"] }), maintenant)).toBe(true);
    expect(echeanceAbandonnee(reveil({ heures: ["03:00"] }), maintenant)).toBeNull();
  });

  it("échéance manquée de 7 h ⇒ abandonnée (plus due), et signalée comme telle", () => {
    const echeance = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    const maintenant = echeance + 7 * 3_600_000;
    const r = reveil({ heures: ["03:00"] });
    expect(estDu(r, maintenant)).toBe(false);
    expect(echeanceAbandonnee(r, maintenant)).toBe(echeance);
  });

  it("pile à la limite du rattrapage (6 h) ⇒ encore due", () => {
    const echeance = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    const maintenant = echeance + RATTRAPAGE_MAX_MS;
    expect(estDu(reveil({ heures: ["03:00"] }), maintenant)).toBe(true);
  });
});

describe("heure de mur préservée au changement d'heure", () => {
  /*
   * T-133 — ce bloc N'A DE SENS que sous un fuseau qui pratique l'heure d'été.
   * Sous UTC (les runners GitHub), la nuit du 29 mars ne saute pas : l'écart
   * vaut 23 h 30 et l'assertion ci-dessous échoue — c'est ainsi que les deux
   * constructions de la 0.6.0 sont tombées. Le fuseau est désormais figé à
   * Europe/Paris dans `ui/vite.config.ts`. On le VÉRIFIE ici plutôt que de le
   * supposer : sans cette garde, un jour où le réglage sauterait, le test
   * recommencerait à passer en ne prouvant plus rien.
   */
  it("garde : la suite tourne bien sous un fuseau à heure d'été", () => {
    const hiver = new Date(2026, 0, 15).getTimezoneOffset();
    const ete = new Date(2026, 6, 15).getTimezoneOffset();
    expect(hiver).not.toBe(ete);
  });

  it("passage à l'heure d'été (nuit du 29 mars 2026) : 23:00 reste 23:00 en heure LOCALE", () => {
    // 28 mars 2026 23:30 locale (CET, UTC+1) : la prochaine occurrence de
    // 23:00 tombe le 29 mars (CEST, UTC+2) — un pas de 22 h 30 en TEMPS RÉEL,
    // pas 23 h 30, parce qu'une heure a sauté cette nuit-là. Une addition de
    // millisecondes sur l'ancien fuseau donnerait une heure de mur fausse.
    const maintenant = new Date(2026, 2, 28, 23, 30, 0, 0).getTime();
    const t = prochaineEcheance(reveil({ heures: ["23:00"] }), maintenant);
    expect(t).not.toBeNull();
    const d = new Date(t!);
    expect(d.getMonth()).toBe(2); // mars
    expect(d.getDate()).toBe(29);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(0);
    // Écart réel : 22 h 30, pas 23 h 30 — la preuve que le calcul suit le mur
    // local et pas une addition naïve de millisecondes.
    expect(t! - maintenant).toBe(22.5 * 3_600_000);
  });
});

describe("toReveil — assainissement à la relecture du disque", () => {
  it("valeur bien formée ⇒ reprise telle quelle", () => {
    const brut = {
      id: "r7",
      heures: ["03:00"],
      surResetQuota: true,
      cibleReouverture: null,
      prompts: ["go"],
      dernierDeclenchement: null,
    };
    expect(toReveil(brut)).toEqual(brut);
  });

  it("réveil écrit AVANT l'existence des ids ⇒ conservé, avec un id neuf", () => {
    // Le jeter serait perdre en silence un réveil que quelqu'un a armé.
    const ancien = { heures: ["03:00"], surResetQuota: false, prompts: ["go"], dernierDeclenchement: null };
    const repare = toReveil(ancien);
    expect(repare).not.toBeNull();
    expect(repare!.id).toMatch(/[0-9a-f-]{36}/);
    expect(repare!.heures).toEqual(["03:00"]);
  });

  it("absente, corrompue ou d'une forme antérieure ⇒ null", () => {
    expect(toReveil(undefined)).toBeNull();
    expect(toReveil(null)).toBeNull();
    expect(toReveil("03:00")).toBeNull();
    expect(toReveil({ heures: ["03:00"] })).toBeNull(); // champs manquants
    expect(toReveil({ heures: [3], surResetQuota: false, prompts: [], dernierDeclenchement: null })).toBeNull();
  });
});

describe("toReveils — la liste, et l'ancienne forme au singulier", () => {
  const unReveil = {
    id: "a",
    heures: ["03:00"],
    surResetQuota: false,
    cibleReouverture: null,
    prompts: ["go"],
    dernierDeclenchement: null,
  };

  it("liste bien formée ⇒ reprise telle quelle", () => {
    expect(toReveils({ reveils: [unReveil] })).toEqual([unReveil]);
  });

  it("entrées corrompues ⇒ écartées, les valides survivent", () => {
    expect(toReveils({ reveils: [unReveil, "n'importe quoi", { heures: [3] }] })).toEqual([unReveil]);
  });

  it("ANCIENNE forme au singulier ⇒ convertie, jamais perdue", () => {
    // Un poste qui avait armé un réveil avant la liste doit le retrouver.
    expect(toReveils({ reveil: unReveil })).toEqual([unReveil]);
  });

  it("rien du tout ⇒ liste vide, jamais une erreur", () => {
    expect(toReveils({})).toEqual([]);
    expect(toReveils(null)).toEqual([]);
    expect(toReveils({ reveil: null })).toEqual([]);
  });
});

describe("heuresAvecSaisie — l'heure tapée compte sans cliquer « Ajouter »", () => {
  it("saisie valide ⇒ ajoutée aux heures déjà posées, triée", () => {
    expect(heuresAvecSaisie(["08:00"], "03:00")).toEqual(["03:00", "08:00"]);
  });

  it("saisie seule ⇒ suffit à armer (le cas du 2026-09-04 : « 11:11 » tapé, Armer grisé)", () => {
    expect(heuresAvecSaisie([], "11:11")).toEqual(["11:11"]);
  });

  it("espaces autour ⇒ tolérés", () => {
    expect(heuresAvecSaisie([], "  07:30 ")).toEqual(["07:30"]);
  });

  it("saisie vide, incomplète ou invalide ⇒ les heures posées, inchangées", () => {
    expect(heuresAvecSaisie(["03:00"], "")).toEqual(["03:00"]);
    expect(heuresAvecSaisie(["03:00"], "11")).toEqual(["03:00"]);
    expect(heuresAvecSaisie(["03:00"], "25:00")).toEqual(["03:00"]);
    expect(heuresAvecSaisie(["03:00"], "11h11")).toEqual(["03:00"]);
  });

  it("doublon ⇒ pas d'ajout", () => {
    expect(heuresAvecSaisie(["03:00"], "03:00")).toEqual(["03:00"]);
  });

  it("ne mute jamais la liste d'entrée", () => {
    const depart = ["08:00"];
    heuresAvecSaisie(depart, "03:00");
    expect(depart).toEqual(["08:00"]);
  });
});

describe("estHeureValide — la même règle pour l'UI et pour le moteur", () => {
  it("accepte HH:MM, avec ou sans zéro de tête", () => {
    expect(estHeureValide("03:00")).toBe(true);
    expect(estHeureValide("3:00")).toBe(true);
    expect(estHeureValide("23:59")).toBe(true);
  });

  it("refuse ce qui n'est pas une heure de mur", () => {
    expect(estHeureValide("")).toBe(false);
    expect(estHeureValide("24:00")).toBe(false);
    expect(estHeureValide("11:60")).toBe(false);
    expect(estHeureValide("11h11")).toBe(false);
  });
});

describe("toReveilsHistorique — la trace des réveils passés", () => {
  const entree = {
    id: "a",
    traiteA: "2026-09-04T09:18:00.000Z",
    echeance: "2026-09-04T09:18:00.000Z",
    heures: ["11:18"],
    surResetQuota: false,
    prompts: ["test"],
    issue: "declenche" as const,
  };

  it("entrées bien formées ⇒ reprises telles quelles", () => {
    expect(toReveilsHistorique({ reveilsHistorique: [entree] })).toEqual([entree]);
  });

  it("entrées corrompues ⇒ écartées, les valides survivent", () => {
    expect(toReveilsHistorique({ reveilsHistorique: [entree, null, { id: "b" }, { ...entree, issue: "peut-être" }] })).toEqual([
      entree,
    ]);
  });

  it("plafonné à HISTORIQUE_REVEILS_MAX, les PLUS RÉCENTES gardées", () => {
    const beaucoup = Array.from({ length: 30 }, (_, i) => ({ ...entree, id: `a${i}` }));
    const garde = toReveilsHistorique({ reveilsHistorique: beaucoup });
    expect(garde).toHaveLength(HISTORIQUE_REVEILS_MAX);
    expect(garde[garde.length - 1].id).toBe("a29");
  });

  it("absent ⇒ liste vide, jamais une erreur", () => {
    expect(toReveilsHistorique({})).toEqual([]);
    expect(toReveilsHistorique(null)).toEqual([]);
  });
});
