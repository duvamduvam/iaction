/*
 * T-186 — non-régression : un projet ne s'écrit jamais avec les sessions d'un
 * autre, et deux bascules ne se chevauchent plus.
 */
import { describe, expect, it } from "vitest";
import { creerSerie, jugerEcritureProjet } from "./gardePersistanceProjet";

describe("jugerEcritureProjet", () => {
  it("autorise l'écriture du projet réellement chargé", () => {
    expect(jugerEcritureProjet("rdpl", "rdpl")).toEqual({ autorise: true });
  });

  it("refuse l'écriture sous la clé d'un autre projet (le cas du 2026-11-04) et dit lesquels", () => {
    const v = jugerEcritureProjet("rdpl", "krishnamurti");
    expect(v.autorise).toBe(false);
    if (!v.autorise) {
      expect(v.champs).toEqual({ projetEcrit: "rdpl", projetCharge: "krishnamurti" });
      expect(v.raison).toContain("n'est pas celui");
    }
  });

  it("refuse quand aucun projet n'est chargé", () => {
    const v = jugerEcritureProjet("rdpl", null);
    expect(v.autorise).toBe(false);
    if (!v.autorise) expect(v.champs.projetCharge).toBeNull();
  });
});

describe("creerSerie", () => {
  it("exécute les tâches l'une après l'autre, même si la première est la plus lente", async () => {
    const serie = creerSerie();
    const ordre: string[] = [];
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const a = serie.executer(async () => {
      ordre.push("a:début");
      await pause(20);
      ordre.push("a:fin");
      return "A";
    });
    const b = serie.executer(async () => {
      ordre.push("b:début");
      return "B";
    });
    expect(await Promise.all([a, b])).toEqual(["A", "B"]);
    expect(ordre).toEqual(["a:début", "a:fin", "b:début"]);
  });

  it("un rejet est rendu à son appelant sans bloquer la file", async () => {
    const serie = creerSerie();
    const echec = serie.executer(async () => {
      throw new Error("boum");
    });
    const suite = serie.executer(async () => "ok");
    await expect(echec).rejects.toThrow("boum");
    await expect(suite).resolves.toBe("ok");
  });
});

describe("signalerEchecEcritureProjet", () => {
  it("journalise la cause avec le projet puis avertit l'utilisateur", async () => {
    const { signalerEchecEcritureProjet, AVIS_ECRITURE_ECHOUEE } = await import("./gardePersistanceProjet");
    const journal: Array<[string, Record<string, string>]> = [];
    const avis: string[] = [];
    signalerEchecEcritureProjet(new Error("disque plein"), "alpha", {
      journaliser: (m, c) => journal.push([m, c]),
      avertir: (a) => avis.push(a),
    });
    expect(journal).toEqual([["écriture du fichier projet en échec", { projet: "alpha", cause: "disque plein" }]]);
    expect(avis).toEqual([AVIS_ECRITURE_ECHOUEE]);
  });

  it("accepte une cause qui n'est pas une Error", async () => {
    const { signalerEchecEcritureProjet } = await import("./gardePersistanceProjet");
    const champs: Record<string, string>[] = [];
    signalerEchecEcritureProjet("refusé", "beta", { journaliser: (_m, c) => champs.push(c), avertir: () => {} });
    expect(champs[0].cause).toBe("refusé");
  });
});
