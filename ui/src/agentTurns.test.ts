/*
 * Modèle des tours d'agent — le cœur de la page Projets, longtemps enfermé
 * dans un fichier de 5 700 lignes et donc jamais testé.
 *
 * `contextTokens` mérite une attention particulière : c'est la fonction dont
 * le défaut a ouvert la session du 2026-08-07 (jauge « Contexte » retombée à
 * 0 % après un `/compact`). Les cas ci-dessous verrouillent exactement le
 * raisonnement qui l'a corrigée.
 */
import { describe, expect, it } from "vitest";
import {
  addToolBlock,
  appendToLastBlock,
  contextTokens,
  hasVisibleContent,
  mcpServerFromToolName,
  prettyJson,
  setToolResult,
  spokenTextOfTurn,
  toolPreview,
  turnSubtypeNotice,
  withTurnError,
  type AgentBlock,
  type AgentTurn,
} from "./agentTurns";

function tour(partiel: Partial<AgentTurn> = {}): AgentTurn {
  return { id: "t1", role: "assistant", status: "done", blocks: [], ...partiel } as AgentTurn;
}

describe("contextTokens — l'occupation réelle de la fenêtre", () => {
  it("prend la mesure du dernier tour qui en porte une", () => {
    const turns = [
      tour({ id: "a", doneInfo: { subtype: "success", usage: null, contextTokens: 50_000, totalCostUsd: null } }),
      tour({ id: "b", doneInfo: { subtype: "success", usage: null, contextTokens: 66_000, totalCostUsd: null } }),
    ];
    expect(contextTokens(turns)).toBe(66_000);
  });

  it("un total NUL n'est pas une mesure : c'est la signature d'un tour /compact", () => {
    // Un tour de compaction ne fait aucun appel modèle : pas de contextTokens,
    // et un usage à 0/0. Le prendre pour argent comptant affichait
    // « Contexte 0 % · 0/200 k » sur un fil qui portait tout son résumé.
    const turns = [
      tour({ id: "a", doneInfo: { subtype: "success", usage: null, contextTokens: 66_000, totalCostUsd: null } }),
      tour({
        id: "compact",
        compacted: { trigger: "manual", preTokens: 124_000 },
        doneInfo: {
          subtype: "success",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
          contextTokens: null,
          totalCostUsd: 0.86,
        },
      }),
    ];
    // Après une compaction SANS mesure, les tours antérieurs sont périmés : ils
    // décrivent la fenêtre d'AVANT le résumé. La taille est donc INCONNUE.
    expect(contextTokens(turns)).toBeNull();
  });

  it("une compaction qui porte une mesure post-compaction la rend", () => {
    // Compaction AUTOMATIQUE en cours de tour : le tour continue après le
    // résumé, ses appels suivants donnent une mesure valide.
    const turns = [
      tour({
        id: "auto",
        compacted: { trigger: "auto", preTokens: 180_000 },
        doneInfo: { subtype: "success", usage: null, contextTokens: 22_000, totalCostUsd: null },
      }),
    ];
    expect(contextTokens(turns)).toBe(22_000);
  });

  it("repli sur l'usage cumulé pour les tours d'avant ce champ", () => {
    const turns = [
      tour({
        id: "vieux",
        doneInfo: {
          subtype: "success",
          usage: { inputTokens: 1_000, outputTokens: 500, cacheReadInputTokens: 8_000 },
          totalCostUsd: null,
        },
      }),
    ];
    expect(contextTokens(turns)).toBe(9_500);
  });

  it("aucun tour mesurable : null, jamais zéro", () => {
    expect(contextTokens([])).toBeNull();
    expect(contextTokens([tour({ status: "streaming" })])).toBeNull();
  });
});

describe("construction des blocs", () => {
  it("agrège les deltas dans le dernier bloc de même type", () => {
    let blocks: AgentBlock[] = [];
    blocks = appendToLastBlock(blocks, "text", "Bon");
    blocks = appendToLastBlock(blocks, "text", "jour");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text", content: "Bonjour" });
  });

  it("ouvre un nouveau bloc quand le type change", () => {
    let blocks: AgentBlock[] = [];
    blocks = appendToLastBlock(blocks, "thinking", "hmm");
    blocks = appendToLastBlock(blocks, "text", "voilà");
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  it("attache le résultat au bon appel d'outil, sans toucher aux autres", () => {
    let blocks: AgentBlock[] = [];
    blocks = addToolBlock(blocks, "u1", "Read", { file_path: "/a" });
    blocks = addToolBlock(blocks, "u2", "Bash", { command: "ls" });
    blocks = setToolResult(blocks, "u2", false, "a.md b.md");
    const [b1, b2] = blocks as Extract<AgentBlock, { type: "tool" }>[];
    expect(b1.result).toBeUndefined();
    expect(b2.result).toEqual({ isError: false, summary: "a.md b.md" });
  });

  it("un résultat pour un id inconnu ne casse rien", () => {
    const blocks = setToolResult(addToolBlock([], "u1", "Read", {}), "fantome", true, "boum");
    expect((blocks[0] as Extract<AgentBlock, { type: "tool" }>).result).toBeUndefined();
  });
});

describe("lecture d'un tour", () => {
  it("hasVisibleContent ignore le texte vide mais compte les outils", () => {
    expect(hasVisibleContent([])).toBe(false);
    expect(hasVisibleContent([{ type: "text", content: "   " } as AgentBlock])).toBe(false);
    expect(hasVisibleContent(addToolBlock([], "u1", "Read", {}))).toBe(true);
  });

  it("spokenTextOfTurn ne rend que le texte, jamais le raisonnement ni les outils", () => {
    let blocks: AgentBlock[] = [];
    blocks = appendToLastBlock(blocks, "thinking", "réflexion interne");
    blocks = appendToLastBlock(blocks, "text", "La réponse.");
    blocks = addToolBlock(blocks, "u1", "Bash", { command: "ls" });
    const dit = spokenTextOfTurn(tour({ blocks }));
    expect(dit).toContain("La réponse.");
    expect(dit).not.toContain("réflexion interne");
    expect(dit).not.toContain("ls");
  });

  it("withTurnError marque le bon tour en erreur", () => {
    const turns = [tour({ id: "a" }), tour({ id: "b", status: "streaming" })];
    const apres = withTurnError(turns, "b", "réseau coupé");
    expect(apres[0].status).toBe("done");
    expect(apres[1]).toMatchObject({ status: "error", errorMessage: "réseau coupé" });
    // Immuabilité : l'entrée n'est jamais mutée en place (état React).
    expect(turns[1].status).toBe("streaming");
  });
});

describe("affichage des outils", () => {
  it("extrait le serveur d'un outil MCP, ignore les outils natifs", () => {
    expect(mcpServerFromToolName("mcp__iaction__search_chat")).toBe("iaction");
    expect(mcpServerFromToolName("Bash")).toBeNull();
    expect(mcpServerFromToolName("mcp__")).toBeNull();
  });

  it("prettyJson borne la longueur (+ le marqueur de troncature)", () => {
    // maxLen caractères, puis « \n… » : deux caractères, pas un.
    const tronque = prettyJson({ a: "x".repeat(500) }, 60);
    expect(tronque).toHaveLength(62);
    expect(tronque.endsWith("\n…")).toBe(true);
    // Sous la limite, aucun marqueur ajouté.
    expect(prettyJson({ a: 1 }, 800).endsWith("…")).toBe(false);
  });


  it("toolPreview reste court quel que soit l'outil", () => {
    expect(toolPreview("Bash", { command: "ls -la" }).length).toBeLessThanOrEqual(160);
  });
});

describe("turnSubtypeNotice", () => {
  it("ne dit rien sur un succès, avertit sur les fins anormales", () => {
    expect(turnSubtypeNotice("success")).toBeNull();
    expect(turnSubtypeNotice("error_max_turns")).toBeTruthy();
  });
});
