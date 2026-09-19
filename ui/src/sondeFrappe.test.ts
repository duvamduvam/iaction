/*
 * Ce qui est verrouillé ici, c'est la CRÉDIBILITÉ de l'instrument, pas son
 * confort : une sonde qui se trompe de centile ou qui mélange deux campagnes
 * de mesure ferait pire que l'absence de sonde — elle donnerait un chiffre
 * faux à quelqu'un qui a décidé de lui faire confiance. Quatre enquêtes ont
 * déjà conclu sans mesure (T-095) ; la cinquième ne doit pas conclure sur une
 * mesure fausse.
 */
import { describe, expect, it } from "vitest";
import {
  ajouter,
  centile,
  creerRegistre,
  echantillons,
  formaterLigne,
  formaterTerrain,
  palierSuivant,
  raz,
  resume,
  PALIERS_NU,
} from "./sondeFrappe";

describe("centile", () => {
  it("prend une valeur RÉELLEMENT observée (rang le plus proche, sans interpolation)", () => {
    const tries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(centile(tries, 50)).toBe(5);
    expect(centile(tries, 95)).toBe(10);
    // La valeur rendue appartient toujours à l'échantillon : c'est ce qui
    // permet de la recouper avec ce qu'on a vu à l'écran.
    expect(tries).toContain(centile(tries, 90));
  });

  it("ne s'effondre pas sur un échantillon d'un seul élément", () => {
    expect(centile([42], 50)).toBe(42);
    expect(centile([42], 95)).toBe(42);
  });

  it("rend NaN sur un échantillon vide plutôt qu'un zéro trompeur", () => {
    // Zéro voudrait dire « latence nulle mesurée ». Non : rien n'a été mesuré.
    expect(Number.isNaN(centile([], 50))).toBe(true);
  });
});

describe("registre circulaire", () => {
  it("garde les mesures tant qu'il n'est pas plein", () => {
    const reg = creerRegistre(4);
    ajouter(reg, 10);
    ajouter(reg, 20);
    expect(echantillons(reg).sort((a, b) => a - b)).toEqual([10, 20]);
    expect(resume(reg)).toEqual({ n: 2, p50: 10, p95: 20, max: 20 });
  });

  it("écrase les plus anciennes une fois plein — une campagne ne traîne pas dans la suivante", () => {
    const reg = creerRegistre(3);
    for (const v of [1, 2, 3, 4, 5]) ajouter(reg, v);
    expect(echantillons(reg).sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(resume(reg)?.n).toBe(3);
  });

  it("refuse les valeurs non finies : une horloge folle ne pollue pas la médiane", () => {
    const reg = creerRegistre(4);
    ajouter(reg, 10);
    ajouter(reg, Number.NaN);
    ajouter(reg, Number.POSITIVE_INFINITY);
    expect(resume(reg)).toEqual({ n: 1, p50: 10, p95: 10, max: 10 });
  });

  it("repart réellement de zéro après remise à zéro", () => {
    const reg = creerRegistre(4);
    ajouter(reg, 99);
    raz(reg);
    expect(resume(reg)).toBeNull();
    ajouter(reg, 7);
    // La mesure d'avant ne doit pas ressortir de la case non effacée.
    expect(resume(reg)).toEqual({ n: 1, p50: 7, p95: 7, max: 7 });
  });

  it("rend null tant que rien n'a été mesuré", () => {
    expect(resume(creerRegistre(4))).toBeNull();
  });
});

describe("paliers du mode nu", () => {
  it("boucle sur lui-même : on revient toujours à l'application intacte", () => {
    let p = 0;
    for (let i = 0; i < PALIERS_NU.length; i += 1) p = palierSuivant(p);
    expect(p).toBe(0);
    expect(PALIERS_NU[0].classe).toBe("");
  });

  it("nomme chaque palier par une classe distincte", () => {
    const classes = PALIERS_NU.map((p) => p.classe);
    expect(new Set(classes).size).toBe(classes.length);
  });
});

describe("formaterLigne", () => {
  it("aligne les colonnes pour que deux campagnes se comparent à l'œil", () => {
    const a = formaterLigne("attente", { n: 3, p50: 3, p95: 12, max: 40 });
    const b = formaterLigne("rendu", { n: 3, p50: 8, p95: 120, max: 400 });
    expect(a).toBe("attente    3  12  40");
    expect(b).toBe("rendu      8 120 400");
    expect(a.length).toBe(b.length);
  });

  it("dit « — » plutôt que des zéros quand il n'y a rien à dire", () => {
    expect(formaterLigne("total", null)).toContain("—");
  });
});

describe("formaterTerrain", () => {
  it("dit l'âge de la page en clair — c'est la variable de l'hypothèse d'accumulation", () => {
    expect(formaterTerrain(0, 12)).toBe("page 0 min · 12 nœuds");
    expect(formaterTerrain(59 * 60000 + 59_000, 1000)).toContain("59 min");
  });

  it("bascule en heures au-delà de soixante minutes, sans perdre les minutes", () => {
    // Une session de travail se compte en heures : « 187 min » ne se compare
    // pas d'un coup d'œil au relevé de la veille.
    expect(formaterTerrain(3 * 3600_000 + 7 * 60000, 5)).toContain("3 h 07");
  });
});
