/*
 * T-033 — les deux calculs du graphique de courbes qui peuvent rendre le graphe
 * FAUX ou ILLISIBLE sans lever la moindre erreur : l'indexation sur le maximum
 * (division par zéro, trous confondus avec des zéros) et le désempilage des
 * étiquettes (deux noms de série écrits l'un sur l'autre).
 */
import { describe, expect, it } from "vitest";
import { LABEL_GAP, desempiler, indexerSerie, segmenter } from "./supervisionCourbesCalc";

describe("indexerSerie", () => {
  it("ramène la série à son propre maximum", () => {
    expect(indexerSerie([5, 10, 0])).toEqual({ max: 10, pct: [50, 100, 0] });
  });

  it("ne divise pas par zéro sur une série vide ou nulle", () => {
    expect(indexerSerie([0, 0])).toEqual({ max: 0, pct: [0, 0] });
    expect(indexerSerie([])).toEqual({ max: 0, pct: [] });
    // Aucun NaN ne doit sortir d'ici : un NaN dans un attribut SVG fait
    // disparaître la courbe entière, silencieusement.
    for (const v of indexerSerie([0, 0]).pct) expect(Number.isNaN(v)).toBe(false);
  });

  it("garde les trous comme trous, jamais comme zéros", () => {
    // Une moyenne absente vaut « pas de donnée » ; la rabattre à 0 dessinerait
    // une chute d'activité qui n'a pas eu lieu.
    const r = indexerSerie([null, 200, null, 100]);
    expect(r.max).toBe(200);
    expect(r.pct).toEqual([null, 100, null, 50]);
  });

  it("ignore les trous dans le calcul du maximum", () => {
    expect(indexerSerie([null, null, 7]).max).toBe(7);
  });
});

describe("segmenter", () => {
  it("coupe le trait au trou au lieu de l'enjamber", () => {
    // Défaut constaté au rendu : une polyligne unique reliait le point d'avant
    // au point d'après, et le mois sans mesure se lisait comme une valeur
    // interpolée. Deux segments = un vrai blanc dans la courbe.
    expect(segmenter([1, 2, null, 4, 5])).toEqual([
      [1, 2],
      [4, 5],
    ]);
  });

  it("ne rend aucun segment quand tout est absent", () => {
    expect(segmenter([null, null])).toEqual([]);
    expect(segmenter([])).toEqual([]);
  });

  it("gère les trous en bord de fenêtre", () => {
    expect(segmenter([null, 1, 2])).toEqual([[1, 2]]);
    expect(segmenter([1, 2, null])).toEqual([[1, 2]]);
  });

  it("garde un point isolé : une pastille sans trait vaut mieux que rien", () => {
    expect(segmenter([1, null, 3, null, 5])).toEqual([[1], [3], [5]]);
  });
});

describe("desempiler", () => {
  it("laisse en place des étiquettes déjà séparées", () => {
    expect(desempiler([10, 40, 80], 0, 200)).toEqual([10, 40, 80]);
  });

  it("écarte des étiquettes superposées sans changer leur ordre", () => {
    const out = desempiler([50, 52, 51], 0, 200);
    // Ordre vertical préservé : la 1re reste au-dessus de la 3e, elle-même au-dessus de la 2e.
    expect(out[0]).toBeLessThan(out[2]);
    expect(out[2]).toBeLessThan(out[1]);
    const tries = [...out].sort((a, b) => a - b);
    for (let i = 1; i < tries.length; i++) expect(tries[i] - tries[i - 1]).toBeGreaterThanOrEqual(LABEL_GAP);
  });

  it("ne pousse jamais une étiquette hors du cadre", () => {
    // Quatre étiquettes au même endroit, contre le bord bas : elles doivent
    // toutes rester dans [min, max] même si l'écart minimal n'y tient pas.
    const out = desempiler([100, 100, 100, 100], 0, 100);
    for (const y of out) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
    expect(out).toHaveLength(4);
  });

  it("rend une position par entrée, même pour une seule série", () => {
    expect(desempiler([42], 0, 100)).toEqual([42]);
    expect(desempiler([], 0, 100)).toEqual([]);
  });
});
