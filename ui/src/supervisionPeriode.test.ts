/*
 * T-033 — la période de Supervision est LA sélection (un jour, une semaine ISO,
 * un mois), pas une fenêtre glissante de 30 jours partagée par « Jour » et
 * « Semaine ». Ces tests verrouillent les trois invariants qui manquaient :
 * chaque granularité découpe une période distincte, ◀ ▶ avance d'UNE période
 * sans dériver, et la tendance s'achève sur la période affichée.
 */
import { describe, expect, it } from "vitest";
import { periodRange, shiftAnchor, superRange, trendRange } from "./supervisionPeriode";

const TODAY = "2026-08-13"; // jeudi, semaine ISO 33

describe("periodRange", () => {
  it("découpe une période DIFFÉRENTE par granularité", () => {
    expect(periodRange("day", TODAY)).toEqual({ from: "2026-08-13", to: "2026-08-13" });
    expect(periodRange("week", TODAY)).toEqual({ from: "2026-08-10", to: "2026-08-16" });
    expect(periodRange("month", TODAY)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
  });

  it("cale la semaine sur le lundi ISO, dimanche compris", () => {
    // Dimanche 16 août appartient à la semaine du lundi 10, pas à la suivante.
    expect(periodRange("week", "2026-08-16")).toEqual({ from: "2026-08-10", to: "2026-08-16" });
    expect(periodRange("week", "2026-08-10")).toEqual({ from: "2026-08-10", to: "2026-08-16" });
  });

  it("borne le mois sur son dernier jour réel, février compris", () => {
    expect(periodRange("month", "2026-02-14")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodRange("month", "2024-02-14")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });
});

describe("shiftAnchor", () => {
  it("recule d'UNE période, pas d'une fenêtre de 30 jours", () => {
    expect(shiftAnchor("day", TODAY, -1, TODAY)).toBe("2026-08-12");
    expect(periodRange("week", shiftAnchor("week", TODAY, -1, TODAY))).toEqual({
      from: "2026-08-03",
      to: "2026-08-09",
    });
    expect(periodRange("month", shiftAnchor("month", TODAY, -1, TODAY))).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });

  it("ne dérive pas en enchaînant les mois courts", () => {
    // Partir du 31 mars : le décalage se fait depuis le 1er du mois, sinon
    // « 31 mars − 1 mois » retomberait sur le 3 mars.
    let a = "2026-03-31";
    const mois: string[] = [];
    for (let i = 0; i < 4; i++) {
      a = shiftAnchor("month", a, -1, TODAY);
      mois.push(periodRange("month", a).from);
    }
    expect(mois).toEqual(["2026-02-01", "2026-01-01", "2025-12-01", "2025-11-01"]);
  });

  it("ne navigue jamais dans le futur", () => {
    expect(shiftAnchor("day", TODAY, 1, TODAY)).toBe(TODAY);
    expect(shiftAnchor("week", TODAY, 1, TODAY)).toBe(TODAY);
    expect(shiftAnchor("month", TODAY, 1, TODAY)).toBe(TODAY);
  });

  it("revient à la période d'où l'on vient (aller-retour)", () => {
    for (const b of ["day", "week", "month"] as const) {
      const avant = shiftAnchor(b, TODAY, -1, TODAY);
      const retour = shiftAnchor(b, avant, 1, TODAY);
      expect(periodRange(b, retour)).toEqual(periodRange(b, TODAY));
    }
  });
});

describe("superRange — le cran AU-DESSUS de la sélection", () => {
  it("jour → sa semaine, semaine → son mois, mois → son année", () => {
    expect(superRange("day", TODAY)).toEqual({ from: "2026-08-10", to: "2026-08-16" });
    expect(superRange("month", TODAY)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("étend le mois aux semaines ENTIÈRES qui le couvrent", () => {
    // Août 2026 commence un samedi : sans extension, la première barre ne
    // couvrirait que deux jours et se lirait comme un effondrement d'activité.
    expect(superRange("week", TODAY)).toEqual({ from: "2026-07-27", to: "2026-09-06" });
  });
});

describe("trendRange", () => {
  it("tronque la fenêtre à la période en cours, jamais de futur vide", () => {
    // Jeudi : la semaine s'arrête à aujourd'hui, pas au dimanche à venir.
    expect(trendRange("day", TODAY, TODAY)).toEqual({ from: "2026-08-10", to: "2026-08-13" });
    // L'année courante s'arrête à la fin du mois en cours, pas au 31 décembre.
    expect(trendRange("month", TODAY, TODAY)).toEqual({ from: "2026-01-01", to: "2026-08-31" });
  });

  it("garde la fenêtre ENTIÈRE sur une période passée", () => {
    expect(trendRange("month", "2025-03-14", TODAY)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(trendRange("day", "2026-06-03", TODAY)).toEqual({ from: "2026-06-01", to: "2026-06-07" });
  });

  it("commence sur un début de bucket, pour que le point corresponde", () => {
    // Le premier jour doit être une clé de bucket valide côté sidecar (lundi /
    // 1er du mois), sinon le point le plus ancien agrège une période tronquée.
    expect(periodRange("week", trendRange("week", TODAY, TODAY).from).from).toBe("2026-07-27");
    expect(trendRange("month", TODAY, TODAY).from).toBe("2026-01-01");
  });

  it("contient toujours la période sélectionnée", () => {
    for (const b of ["day", "week", "month"] as const) {
      const p = periodRange(b, TODAY);
      const t = trendRange(b, TODAY, TODAY);
      expect(t.from <= p.from).toBe(true);
      expect(t.to >= p.from).toBe(true);
    }
  });
});
