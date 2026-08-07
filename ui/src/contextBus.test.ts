/*
 * Bus de l'encart « Contexte » et fenêtres de contexte par modèle.
 *
 * Deux comportements y ont une histoire :
 * - `contextWindowFor` recale la fenêtre sur le palier 1M quand l'API a
 *   ACCEPTÉ plus que la table (cas réel du 2026-07-31 : 313 k tokens sur
 *   claude-opus-4-8, bêta context-1m invisible dans l'id) ;
 * - les seuils du bouton « Compacter » (ratio + plancher absolu) viennent du
 *   même incident — 313 k tokens ne faisaient que 31 % d'une fenêtre 1M.
 */
import { describe, expect, it } from "vitest";
import {
  COMPACT_BUTTON_MIN_TOKENS,
  COMPACT_BUTTON_RATIO,
  contextWindowFor,
  formatTokens,
  publishContext,
  readContext,
  subscribeContext,
} from "./contextBus";

describe("contextWindowFor", () => {
  it("résout la fenêtre par sous-chaîne d'id, préfixe vendeur compris", () => {
    expect(contextWindowFor("claude-sonnet-5")).toBe(200_000);
    expect(contextWindowFor("anthropic/claude-sonnet-5")).toBe(200_000);
    expect(contextWindowFor("gpt-4o-mini")).toBe(128_000);
  });

  it("les variantes spécifiques priment : « [1m] » avant le générique claude", () => {
    expect(contextWindowFor("claude-opus-5[1m]")).toBe(1_000_000);
  });

  it("modèle inconnu : null — l'encart n'invente pas de pourcentage", () => {
    expect(contextWindowFor("mon-modele-maison")).toBeNull();
  });

  it("usage OBSERVÉ au-dessus de la table : recalage 1M pour Claude (cas du 2026-07-31)", () => {
    expect(contextWindowFor("claude-opus-4-8", 313_000)).toBe(1_000_000);
  });

  it("même dépassement sur un modèle non-Claude : fenêtre inconnue, pas de recalage inventé", () => {
    expect(contextWindowFor("gpt-4o", 200_000)).toBeNull();
  });

  it("usage sous la table : la table fait foi", () => {
    expect(contextWindowFor("claude-opus-4-8", 150_000)).toBe(200_000);
  });
});

describe("formatTokens", () => {
  it("paliers : brut, « x,x k », « xxx k », « x M »", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1,2 k");
    expect(formatTokens(66_000)).toBe("66 k");
    expect(formatTokens(200_000)).toBe("200 k");
    expect(formatTokens(1_000_000)).toBe("1 M");
    expect(formatTokens(1_500_000)).toBe("1,5 M");
  });
});

describe("seuils du bouton « Compacter »", () => {
  it("le plancher absolu existe pour le palier 1M : 313 k doivent dépasser le plancher sans atteindre le ratio", () => {
    const usedTokens = 313_000;
    const fenetre1M = 1_000_000;
    expect(usedTokens / fenetre1M).toBeLessThan(COMPACT_BUTTON_RATIO);
    expect(usedTokens).toBeGreaterThanOrEqual(COMPACT_BUTTON_MIN_TOKENS);
  });
});

describe("bus publish/read/subscribe", () => {
  it("publie par source, notifie, et readContext rend la dernière valeur", () => {
    const vues: number[] = [];
    const off = subscribeContext(() => {
      vues.push(readContext("agent")?.usedTokens ?? -1);
    });
    publishContext("agent", { model: "claude-sonnet-5", usedTokens: 1000 });
    publishContext("agent", { model: "claude-sonnet-5", usedTokens: 2000 });
    off();
    expect(vues).toEqual([1000, 2000]);
    expect(readContext("agent")).toEqual({ model: "claude-sonnet-5", usedTokens: 2000 });
    publishContext("agent", null);
    expect(readContext("agent")).toBeNull();
  });

  it("valeur identique republiée : aucune notification (anti-boucle de rendu)", () => {
    publishContext("chat", { model: "m", usedTokens: 5 });
    let notifications = 0;
    const off = subscribeContext(() => {
      notifications += 1;
    });
    publishContext("chat", { model: "m", usedTokens: 5 });
    off();
    publishContext("chat", null);
    expect(notifications).toBe(0);
  });
});
