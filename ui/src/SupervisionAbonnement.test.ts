/*
 * T-100 — les barres « utilisation hebdomadaire » regroupées par FENÊTRE
 * D'ABONNEMENT (`resetsAt`), pas par semaine ISO.
 *
 * L'ancien découpage (`isoWeekKey`, semaine ISO calée sur le lundi) n'avait
 * aucun rapport avec le cycle réel : l'abonnement Claude se réinitialise le
 * samedi à 20:00. Deux relevés peuvent tomber dans la même semaine ISO tout
 * en appartenant à deux fenêtres différentes (cas ci-dessous), et c'est cette
 * confusion qui masquait le vrai cycle.
 *
 * Le minorant T-059 (« ≥ N % ») change aussi de méthode de détection : il ne
 * compare plus deux relevés consécutifs pour repérer un reset franchi, mais
 * compare DIRECTEMENT le dernier relevé d'une fenêtre close à SA PROPRE
 * clôture (`resetsAt`) — voir `SEUIL_MINORANT_MS` dans SupervisionAbonnement.tsx.
 */
import { describe, expect, it } from "vitest";
import { cleFenetre, SEUIL_MINORANT_MS, summarizeByResetWindow } from "./SupervisionAbonnement";
import type { ClaudeWindowSnapshot } from "./usageStatsClient";

/** Un instantané minimal, une seule fenêtre `seven_day`. */
function snap(ts: string, utilization: number, resetsAt: string): ClaudeWindowSnapshot {
  return { ts, windows: { seven_day: { utilization, resetsAt } } };
}

function points(snapshots: ClaudeWindowSnapshot[]) {
  return snapshots.map((s) => ({ ts: s.ts, pct: s.windows.seven_day.utilization, resetsAt: s.windows.seven_day.resetsAt }));
}

/** Date de référence pour "maintenant" dans les tests : toutes les fenêtres ci-dessous sont closes avant. */
const MAINTENANT = new Date("2026-09-02T00:00:00Z");

/** Idem pour les fenêtres de septembre du bloc T-140 : toutes closes avant. */
const MAINTENANT_SEPT = new Date("2026-10-01T00:00:00Z");

describe("summarizeByResetWindow — regroupement par fenêtre, pas par semaine ISO", () => {
  it("deux points de la même semaine ISO mais de resetsAt distincts → DEUX barres", () => {
    const snapshots = [
      // Mardi 2026-08-11 : fenêtre qui clôture le vendredi 14 à 20:00.
      snap("2026-08-11T08:00:00Z", 40, "2026-08-14T20:00:00Z"),
      // Samedi 2026-08-15 : MÊME semaine ISO (S33, lundi 10 → dimanche 16),
      // mais fenêtre SUIVANTE (clôture le 21). Le découpage par semaine ISO
      // aurait fusionné les deux en une seule barre — c'est le bug corrigé.
      snap("2026-08-15T08:00:00Z", 60, "2026-08-21T20:00:00Z"),
    ];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT);
    expect(fenetres).toHaveLength(2);
    // T-140 — `resetsAt` rendu est la clôture canonique (arrondie), pas la
    // chaîne du relevé : d'où le `.000Z`.
    expect(fenetres[0]).toMatchObject({ resetsAt: "2026-08-14T20:00:00.000Z", max: 40 });
    expect(fenetres[1]).toMatchObject({ resetsAt: "2026-08-21T20:00:00.000Z", max: 60 });
  });

  it("deux points du même resetsAt → une seule barre, au pic des deux", () => {
    const snapshots = [
      snap("2026-08-11T08:00:00Z", 40, "2026-08-14T20:00:00Z"),
      snap("2026-08-12T08:00:00Z", 60, "2026-08-14T20:00:00Z"),
    ];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT);
    expect(fenetres).toHaveLength(1);
    expect(fenetres[0].max).toBe(60);
  });

  it("les fenêtres sont triées chronologiquement par clôture, indépendamment de l'ordre des relevés", () => {
    const snapshots = [
      snap("2026-08-15T08:00:00Z", 60, "2026-08-21T20:00:00Z"),
      snap("2026-08-11T08:00:00Z", 40, "2026-08-14T20:00:00Z"),
    ];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT);
    expect(fenetres.map((f) => f.resetsAt)).toEqual([
      "2026-08-14T20:00:00.000Z",
      "2026-08-21T20:00:00.000Z",
    ]);
  });
});

/*
 * T-140 — la gigue de `resetsAt`, telle que l'API la produit vraiment.
 *
 * Angle mort des tests ci-dessus : ils n'emploient que des `resetsAt`
 * identiques au caractère près (`2026-08-14T20:00:00Z`), une forme que l'API
 * ne renvoie JAMAIS. Le regroupement par chaîne brute passait donc au vert
 * pendant qu'il fabriquait une barre par relevé en production. Les valeurs
 * ci-dessous sont relevées telles quelles dans `usage/claude-windows.jsonl`.
 */
describe("summarizeByResetWindow — T-140, gigue de resetsAt", () => {
  it("microsecondes variables sur la même fenêtre → UNE seule barre", () => {
    const snapshots = [
      snap("2026-09-13T08:00:00Z", 40, "2026-09-19T18:00:00.045125+00:00"),
      snap("2026-09-14T08:00:00Z", 77, "2026-09-19T18:00:00.870908+00:00"),
      snap("2026-09-15T08:00:00Z", 60, "2026-09-19T18:00:00.300595+00:00"),
    ];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT_SEPT);
    expect(fenetres).toHaveLength(1);
    expect(fenetres[0].max).toBe(77);
  });

  it("oscillation 17:59:59 / 18:00:00 sur la même fenêtre → UNE seule barre", () => {
    // Le cas que la troncature à la minute du sidecar ne rattrape PAS : ces
    // deux relevés donnent `2026-09-19T17:59` et `2026-09-19T18:00`.
    const snapshots = [
      snap("2026-09-13T08:00:00Z", 46, "2026-09-19T17:59:59.339246+00:00"),
      snap("2026-09-14T08:00:00Z", 97, "2026-09-19T18:00:00.061717+00:00"),
    ];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT_SEPT);
    expect(fenetres).toHaveLength(1);
    expect(fenetres[0].max).toBe(97);
  });

  it("la clôture rendue est l'heure canonique, qu'aucun relevé ne porte", () => {
    const snapshots = [snap("2026-09-14T08:00:00Z", 97, "2026-09-19T17:59:59.339246+00:00")];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT_SEPT);
    expect(fenetres[0].resetsAt).toBe("2026-09-19T18:00:00.000Z");
  });

  it("deux fenêtres réelles à sept jours d'écart restent DEUX barres malgré la gigue", () => {
    const snapshots = [
      snap("2026-09-14T08:00:00Z", 97, "2026-09-19T17:59:59.987980+00:00"),
      snap("2026-09-19T20:00:00Z", 12, "2026-09-26T18:00:00.347059+00:00"),
    ];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT_SEPT);
    expect(fenetres.map((f) => f.max)).toEqual([97, 12]);
  });

  it("un resetsAt illisible ne casse rien et ne se fond pas dans une vraie fenêtre", () => {
    const snapshots = [
      snap("2026-09-14T08:00:00Z", 97, "2026-09-19T18:00:00.061717+00:00"),
      snap("2026-09-15T08:00:00Z", 33, "pas une date"),
    ];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT_SEPT);
    expect(fenetres).toHaveLength(2);
    // L'illisible est relégué en fin de tri, et garde sa chaîne brute.
    expect(fenetres[1]).toMatchObject({ resetsAt: "pas une date", max: 33 });
  });
});

describe("cleFenetre — T-140", () => {
  it("arrondit à la minute la plus proche, de part et d'autre de la frontière", () => {
    const attendu = Date.parse("2026-09-19T18:00:00Z");
    expect(cleFenetre("2026-09-19T17:59:59.339246+00:00")).toBe(attendu);
    expect(cleFenetre("2026-09-19T18:00:00.870908+00:00")).toBe(attendu);
    expect(cleFenetre("2026-09-19T18:00:00+00:00")).toBe(attendu);
  });

  it("ne fusionne pas deux instants réellement distants d'une minute", () => {
    expect(cleFenetre("2026-09-19T18:00:00Z")).not.toBe(cleFenetre("2026-09-19T18:01:00Z"));
  });

  it("date illisible → null", () => {
    expect(cleFenetre("pas une date")).toBeNull();
  });
});

describe("summarizeByResetWindow — T-059/T-100, minorant signalé", () => {
  // Chaque cas ajoute un relevé d'une fenêtre SUIVANTE : sans lui, la fenêtre
  // testée serait la DERNIÈRE connue et tomberait dans le repli « à défaut de
  // fenêtre future, la dernière est en cours » (§ fenêtre en cours ci-dessous)
  // — or une fenêtre en cours n'est jamais signalée incertaine. Un relevé
  // suivant rend la fenêtre testée bien CLOSE, condition du test.
  const relevesSuivant = [snap("2026-08-18T08:00:00Z", 10, "2026-08-21T20:00:00Z")];

  it("le cas du ticket : dernier relevé à 1h19 de la clôture (> 30 min) → incertaine", () => {
    const snapshots = [snap("2026-08-14T18:41:00Z", 95, "2026-08-14T20:00:00Z"), ...relevesSuivant];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT);
    expect(fenetres[0].max).toBe(95);
    expect(fenetres[0].incertaine).toBe(true);
  });

  it("dernier relevé tout près de la clôture (5 min, < 30 min) → pas incertaine", () => {
    const snapshots = [snap("2026-08-14T19:55:00Z", 99, "2026-08-14T20:00:00Z"), ...relevesSuivant];
    expect(summarizeByResetWindow(points(snapshots), MAINTENANT)[0].incertaine).toBe(false);
  });

  it("pile au seuil de 30 min : pas encore incertaine (strictement supérieur)", () => {
    const avant = new Date("2026-08-14T19:30:00Z");
    const reset = new Date(avant.getTime() + SEUIL_MINORANT_MS);
    const snapshots = [snap(avant.toISOString(), 90, reset.toISOString()), ...relevesSuivant];
    expect(summarizeByResetWindow(points(snapshots), MAINTENANT)[0].incertaine).toBe(false);
  });

  it("juste au-dessus du seuil de 30 min : incertaine", () => {
    const reset = new Date("2026-08-14T20:00:00Z");
    const avant = new Date(reset.getTime() - SEUIL_MINORANT_MS - 1000); // 30 min et 1 s avant
    const snapshots = [snap(avant.toISOString(), 90, reset.toISOString()), ...relevesSuivant];
    expect(summarizeByResetWindow(points(snapshots), MAINTENANT)[0].incertaine).toBe(true);
  });

  it("la fenêtre EN COURS n'est jamais signalée incertaine, même si son dernier relevé est loin de sa clôture", () => {
    const snapshots = [snap("2026-08-14T18:41:00Z", 70, "2026-08-14T20:00:00Z")];
    // "maintenant" est AVANT la clôture annoncée : la fenêtre n'est pas close.
    const maintenant = new Date("2026-08-14T19:00:00Z");
    const fenetres = summarizeByResetWindow(points(snapshots), maintenant);
    expect(fenetres[0].enCours).toBe(true);
    expect(fenetres[0].incertaine).toBe(false);
  });
});

describe("summarizeByResetWindow — fenêtre en cours", () => {
  it("la fenêtre en cours est celle dont le resetsAt est dans le futur", () => {
    const snapshots = [
      snap("2026-08-11T08:00:00Z", 40, "2026-08-14T20:00:00Z"),
      snap("2026-08-16T08:00:00Z", 20, "2026-08-21T20:00:00Z"),
    ];
    const maintenant = new Date("2026-08-16T12:00:00Z"); // entre les deux clôtures
    const fenetres = summarizeByResetWindow(points(snapshots), maintenant);
    expect(fenetres[0].enCours).toBe(false);
    expect(fenetres[1].enCours).toBe(true);
  });

  it("à défaut de fenêtre future, la dernière connue est considérée en cours", () => {
    const snapshots = [
      snap("2026-08-11T08:00:00Z", 40, "2026-08-14T20:00:00Z"),
      snap("2026-08-16T08:00:00Z", 20, "2026-08-21T20:00:00Z"),
    ];
    const fenetres = summarizeByResetWindow(points(snapshots), MAINTENANT); // toutes deux passées
    expect(fenetres[0].enCours).toBe(false);
    expect(fenetres[1].enCours).toBe(true);
  });

  it("sans point : aucune fenêtre, rien ne casse", () => {
    expect(summarizeByResetWindow([], MAINTENANT)).toEqual([]);
  });
});
