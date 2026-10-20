/*
 * Rythme de combustion et projection de fin de fenêtre (T-072) — l'enjeu est
 * autant ce qui s'extrapole que ce qui refuse de le faire : une fenêtre
 * presque vide ne doit jamais produire un mur inventé.
 */
import { describe, expect, it } from "vitest";
import { calculerRythmeQuota } from "./rythmeQuota";
import type { ClaudeWindowSnapshot } from "./usageStatsClient";

const RESET = "2026-08-29T20:00:00.000Z";

function snap(ts: string, utilization: number, resetsAt = RESET): ClaudeWindowSnapshot {
  return { ts, windows: { five_hour: { utilization, resetsAt } } };
}

describe("calculerRythmeQuota", () => {
  it("aucun instantané portant la fenêtre demandée ⇒ null", () => {
    expect(calculerRythmeQuota([], "five_hour")).toBeNull();
    expect(calculerRythmeQuota([{ ts: "2026-08-29T10:00:00Z", windows: {} }], "five_hour")).toBeNull();
  });

  it("un seul relevé sur la fenêtre courante ⇒ pas de rythme, la raison est dite", () => {
    const r = calculerRythmeQuota([snap("2026-08-29T15:00:00Z", 40)], "five_hour");
    expect(r).not.toBeNull();
    expect(r!.pctParMinute).toBeNull();
    expect(r!.murIso).toBeNull();
    expect(r!.raisonAbsence).toMatch(/un seul relevé/i);
  });

  it("rythme nul (deux relevés identiques) ⇒ pas d'extrapolation", () => {
    const r = calculerRythmeQuota(
      [snap("2026-08-29T15:00:00Z", 40), snap("2026-08-29T15:10:00Z", 40)],
      "five_hour",
    );
    expect(r!.murIso).toBeNull();
    expect(r!.raisonAbsence).toMatch(/rythme nul/i);
  });

  it("rythme négatif (fenêtre réinitialisée, même resetsAt improbable) ⇒ pas d'extrapolation", () => {
    const r = calculerRythmeQuota(
      [snap("2026-08-29T15:00:00Z", 40), snap("2026-08-29T15:10:00Z", 30)],
      "five_hour",
    );
    expect(r!.murIso).toBeNull();
    expect(r!.raisonAbsence).toMatch(/rythme nul/i);
  });

  it("fenêtre déjà saturée ⇒ pas de mur à calculer, elle est dépassée", () => {
    const r = calculerRythmeQuota(
      [snap("2026-08-29T15:00:00Z", 90), snap("2026-08-29T15:10:00Z", 100)],
      "five_hour",
    );
    expect(r!.murIso).toBeNull();
    expect(r!.raisonAbsence).toMatch(/déjà saturée/i);
  });

  it("rythme positif ⇒ projection du mur à 100 %", () => {
    // 10 % en 10 minutes ⇒ 1 %/min ; de 40 % à 100 % : 60 minutes de plus.
    const r = calculerRythmeQuota(
      [snap("2026-08-29T15:00:00Z", 30), snap("2026-08-29T15:10:00Z", 40)],
      "five_hour",
    );
    expect(r!.pctParMinute).toBeCloseTo(1, 5);
    expect(r!.raisonAbsence).toBeNull();
    expect(r!.murIso).toBe(new Date("2026-08-29T16:10:00.000Z").toISOString());
  });

  it("ignore les instantanés d'une fenêtre PRÉCÉDENTE (resetsAt différent)", () => {
    const r = calculerRythmeQuota(
      [
        // Ancienne fenêtre, presque pleine, ne doit pas polluer le calcul.
        snap("2026-08-29T09:00:00Z", 95, "2026-08-29T10:00:00.000Z"),
        // Fenêtre courante, un seul relevé.
        snap("2026-08-29T15:00:00Z", 20, RESET),
      ],
      "five_hour",
    );
    expect(r!.utilizationActuelle).toBe(20);
    expect(r!.raisonAbsence).toMatch(/un seul relevé/i);
  });
});
