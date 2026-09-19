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
import { SEUIL_MINORANT_MS, summarizeByResetWindow } from "./SupervisionAbonnement";
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
    expect(fenetres[0]).toMatchObject({ resetsAt: "2026-08-14T20:00:00Z", max: 40 });
    expect(fenetres[1]).toMatchObject({ resetsAt: "2026-08-21T20:00:00Z", max: 60 });
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
    expect(fenetres.map((f) => f.resetsAt)).toEqual(["2026-08-14T20:00:00Z", "2026-08-21T20:00:00Z"]);
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
