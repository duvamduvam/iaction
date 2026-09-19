/*
 * Pyramide de délégation pondérée par le coût (T-071) — l'enjeu du test est
 * précisément celui du ticket : une pyramide en tokens ment, une pyramide en
 * coût dit la vérité (docs/etude-supervision.md §7.1).
 */
import { describe, expect, it } from "vitest";
import { calculerPyramide, BORNES_ETAGE, type LignePyramide } from "./pyramideDelegation";
import type { UsageSobriete } from "./usageStatsClient";

function ligne(overrides: Partial<UsageSobriete["parModeleReel"][number]>): UsageSobriete["parModeleReel"][number] {
  return { model: "x", tokens: 0, costUsd: 0, toursDelegue: 0, ...overrides };
}

function trouver(pyramide: { lignes: LignePyramide[] }, etage: LignePyramide["etage"]): LignePyramide {
  const l = pyramide.lignes.find((x) => x.etage === etage);
  if (!l) throw new Error(`étage ${etage} absent`);
  return l;
}

describe("calculerPyramide", () => {
  it("aucun tour ventilé ⇒ null, jamais une pyramide à zéro", () => {
    expect(calculerPyramide([])).toBeNull();
  });

  it("ignore les modèles à zéro token (rien à classer)", () => {
    expect(calculerPyramide([ligne({ tokens: 0, costUsd: 5 })])).toBeNull();
  });

  it("un modèle gratuit tombe en « local », jamais deviné par le nom", () => {
    const p = calculerPyramide([ligne({ model: "qwen3.5:4b", tokens: 1000, costUsd: 0 })]);
    expect(p).not.toBeNull();
    expect(trouver(p!, "local").pctCout).toBe(100);
    expect(trouver(p!, "gros").pctCout).toBe(0);
  });

  it("reproduit l'écart mesuré §7.1 : 61 % de tokens devient 99 % de coût", () => {
    // Reprise à l'échelle des chiffres de l'étude : gros modèle à 60,9 % des
    // TOKENS, local gratuit à 36,3 % — mais le gros pèse 99,4 % du COÛT.
    // Coûts dérivés de taux $/M réalistes (opus ≈30, sonnet ≈6, haiku ≈2,
    // local nul) plutôt que recopiés tels quels : l'étude les mesure sur un
    // mélange de tokens de cache à tarifs différents, ce que ce test ne
    // modélise pas.
    const parModele = [
      ligne({ model: "claude-opus-5", tokens: 610_000, costUsd: (610_000 * 30) / 1e6 }),
      ligne({ model: "claude-sonnet-5", tokens: 13_000, costUsd: (13_000 * 6) / 1e6 }),
      ligne({ model: "claude-haiku-4-5", tokens: 16_000, costUsd: (16_000 * 2) / 1e6 }),
      ligne({ model: "qwen3.5:4b", tokens: 363_000, costUsd: 0 }),
    ];
    const p = calculerPyramide(parModele);
    expect(p).not.toBeNull();
    const totalTokens = parModele.reduce((s, m) => s + m.tokens, 0);
    const partTokensGros = (trouver(p!, "gros").tokens / totalTokens) * 100;
    // En tokens, le gros modèle ne dépasse pas 61 % — en coût, il dépasse 99 %.
    expect(partTokensGros).toBeLessThan(62);
    expect(trouver(p!, "gros").pctCout).toBeGreaterThan(99);
    expect(trouver(p!, "local").pctCout).toBe(0);
  });

  it("les quatre étages somment à 100 % du coût ventilé", () => {
    const p = calculerPyramide([
      ligne({ model: "claude-opus-5", tokens: 1000, costUsd: 20 }),
      ligne({ model: "claude-sonnet-5", tokens: 1000, costUsd: 6 }),
      ligne({ model: "claude-haiku-4-5", tokens: 1000, costUsd: 1 }),
    ]);
    const total = p!.lignes.reduce((s, l) => s + l.pctCout, 0);
    expect(Math.round(total)).toBe(100);
  });

  it("dansLaBorne suit les bornes cibles du skill sobriete, relues en coût", () => {
    // Taux fixés pour que chaque ligne tombe dans l'étage voulu (§7.1 : le
    // taux $/M classe, pas le nom) : opus à 15 000 $/M ⇒ gros, un modèle à
    // 2,83 $/M sur un GROS volume ⇒ mécanique — et le gros pèse pile 15 % du
    // coût total, au milieu de sa borne 10-20.
    const p = calculerPyramide([
      ligne({ model: "claude-opus-5", tokens: 1_000, costUsd: 15 }),
      ligne({ model: "un-modele-mecanique", tokens: 30_000_000, costUsd: 85 }),
    ]);
    const gros = trouver(p!, "gros");
    expect(trouver(p!, "mecanique").costUsd).toBe(85);
    expect(gros.pctCout).toBe(15);
    expect(gros.borne).toEqual(BORNES_ETAGE.gros);
    expect(gros.dansLaBorne).toBe(true);
  });
});
