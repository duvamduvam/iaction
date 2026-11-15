/*
 * Lecture défensive des réponses `claude.commands` et `models.detail`
 * (sorties de sidecar.ts, T-209) : une entrée malformée est écartée, jamais
 * d'exception.
 */
import { describe, expect, it } from "vitest";
import { parseCommandesSlash } from "./commandesSlash";
import { parseModelsDetail } from "./modelDetail";

describe("parseCommandesSlash", () => {
  it("réponse sans liste : vide", () => {
    expect(parseCommandesSlash({})).toEqual([]);
    expect(parseCommandesSlash({ commands: "x" })).toEqual([]);
  });

  it("écarte les entrées sans nom et complète les champs absents", () => {
    const r = parseCommandesSlash({
      commands: [null, 3, { name: "" }, { name: "init" }, { name: "x", description: "d", argumentHint: "h", aliases: ["a", "", 2] }],
    });
    expect(r).toEqual([
      { name: "init", description: "", argumentHint: "" },
      { name: "x", description: "d", argumentHint: "h", aliases: ["a"] },
    ]);
  });

  it("alias tous invalides : pas de clé aliases", () => {
    expect(parseCommandesSlash({ commands: [{ name: "x", aliases: [1, ""] }] })[0]).not.toHaveProperty("aliases");
  });
});

describe("parseModelsDetail", () => {
  it("réponse sans liste : vide", () => {
    expect(parseModelsDetail({})).toEqual([]);
  });

  it("écarte les entrées sans id ou non-objets", () => {
    expect(parseModelsDetail({ models: [null, "x", {}, { id: "m1", name: "M" }] })).toEqual([{ id: "m1", name: "M" }]);
  });
});
