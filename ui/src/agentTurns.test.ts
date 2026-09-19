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
  buildNeutralMessages,
  contextTokens,
  hasVisibleContent,
  mcpServerFromToolName,
  modeleSousAgentDeclare,
  prettyJson,
  setToolResult,
  sousAgentOccupaitLeTour,
  sousAgentsDuTour,
  sousAgentsVifs,
  spokenTextOfTurn,
  toolPreview,
  turnSubtypeNotice,
  withAgentSystemPrompt,
  withPushPerdu,
  withSousAgentBattement,
  withTurnError,
  retirerPushCorrespondant,
  type AgentBlock,
  type AgentTurn,
  resumerTachesDeFond,
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

describe("withPushPerdu — T-087, une bulle qui cesse de mentir", () => {
  it("marque le tour injecté ET la bulle assistant qu'il avait ouverte", () => {
    const turns = [
      tour({ id: "u1", role: "user", content: "et le CHANGELOG", injected: true }),
      tour({ id: "a2", role: "assistant", status: "streaming", suiteDeTour: true }),
    ];
    const apres = withPushPerdu(turns, "et le CHANGELOG");
    expect(apres[0]).toMatchObject({ reporte: true });
    expect(apres[1]).toMatchObject({ reporte: true, status: "done" });
    // Immuabilité : comme les autres withX, jamais de mutation en place.
    expect(turns[0].reporte).toBeUndefined();
  });

  it("ignore un tour non injecté portant le même texte (un vrai message utilisateur)", () => {
    const turns = [tour({ id: "u1", role: "user", content: "et le CHANGELOG" })];
    const apres = withPushPerdu(turns, "et le CHANGELOG");
    expect(apres).toBe(turns);
  });

  it("contenu introuvable : tableau inchangé, jamais d'exception", () => {
    const turns = [tour({ id: "u1", role: "user", content: "autre chose", injected: true })];
    expect(withPushPerdu(turns, "et le CHANGELOG")).toBe(turns);
  });

  it("FIFO : marque le PREMIER tour injecté non encore reporté portant ce contenu", () => {
    const turns = [
      tour({ id: "u1", role: "user", content: "relance", injected: true }),
      tour({ id: "u2", role: "user", content: "relance", injected: true }),
    ];
    const apres = withPushPerdu(turns, "relance");
    expect(apres[0].reporte).toBe(true);
    expect(apres[1].reporte).toBeUndefined();
    // Un second push_perdu pour le même texte marque le SUIVANT, pas le même.
    const encore = withPushPerdu(apres, "relance");
    expect(encore[1].reporte).toBe(true);
  });
});

describe("retirerPushCorrespondant — T-064, la copie locale des pièces poussées", () => {
  it("retire et rend la première entrée correspondante (FIFO)", () => {
    const enCours = [
      { contenu: "a", attachments: ["img1"] },
      { contenu: "b", attachments: ["img2"] },
    ];
    const { trouve, reste } = retirerPushCorrespondant(enCours, "a");
    expect(trouve).toEqual({ contenu: "a", attachments: ["img1"] });
    expect(reste).toEqual([{ contenu: "b", attachments: ["img2"] }]);
    // Immuabilité : le tableau d'entrée n'est jamais modifié en place.
    expect(enCours.length).toBe(2);
  });

  it("contenu introuvable : trouve undefined, reste inchangé", () => {
    const enCours = [{ contenu: "a", attachments: [] }];
    const { trouve, reste } = retirerPushCorrespondant(enCours, "x");
    expect(trouve).toBeUndefined();
    expect(reste).toBe(enCours);
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

  it("T-102 — distingue un tour INTERROMPU d'une vraie PANNE", () => {
    // Le sidecar (claudeFinDeTour.ts, subtypePourInterface) masque désormais
    // le subtype brut `error_during_execution` derrière `aborted` quand
    // l'interruption est connue (arrêt demandé, refus de permission) : c'est
    // ce que l'UI doit lire ici comme une interruption, jamais une panne.
    const interrompu = turnSubtypeNotice("aborted");
    expect(interrompu).toMatch(/interrompu/i);
    expect(interrompu).not.toMatch(/anormalement/i);

    // Un `error_during_execution` non classé (aucune interruption connue en
    // amont) reste, lui, une vraie panne.
    const panne = turnSubtypeNotice("error_during_execution");
    expect(panne).toMatch(/anormalement/i);
    expect(panne).not.toMatch(/interrompu/i);
  });
});

describe("buildNeutralMessages — l'historique que le moteur neutre relit à CHAQUE tour", () => {
  it("assistant = concaténation des blocs texte SEULS (thinking/tool sans équivalent OpenAI)", () => {
    const history: AgentTurn[] = [
      { id: "u1", role: "user", content: "question", status: "done" },
      {
        id: "a1",
        role: "assistant",
        status: "done",
        blocks: [
          { type: "thinking", id: "b1", content: "je réfléchis" },
          { type: "text", id: "b2", content: "début" },
          { type: "tool", id: "b3", toolUseId: "t", toolName: "Bash", toolInput: {} },
          { type: "text", id: "b4", content: " et fin" },
        ],
      },
    ];
    expect(buildNeutralMessages(history, "suite")).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "début et fin" },
      { role: "user", content: "suite" },
    ]);
  });

  it("les tours en ERREUR sont sautés (contenu potentiellement vide/partiel)", () => {
    const history: AgentTurn[] = [
      { id: "u1", role: "user", content: "ok", status: "done" },
      { id: "a1", role: "assistant", status: "error", blocks: [{ type: "text", id: "b", content: "partiel" }] },
    ];
    const messages = buildNeutralMessages(history, "nouveau");
    expect(messages.map((m) => m.content)).toEqual(["ok", "nouveau"]);
  });
});

describe("sousAgentsDuTour — T-077, qui travaille pour ce tour", () => {
  function blocOutil(partiel: Partial<Extract<AgentBlock, { type: "tool" }>>): AgentBlock {
    return { type: "tool", id: "b", toolUseId: "t", toolName: "Task", toolInput: {}, ...partiel } as AgentBlock;
  }

  it("ne retient que les outils de délégation, pas les outils ordinaires", () => {
    const turn = tour({
      blocks: [
        blocOutil({ id: "b1", toolName: "Bash", toolInput: { command: "ls" } }),
        blocOutil({ id: "b2", toolName: "Task", toolInput: { subagent_type: "explorateur" } }),
        blocOutil({ id: "b3", toolName: "Agent", toolInput: { subagent_type: "relecteur" } }),
      ],
    });
    expect(sousAgentsDuTour(turn).map((a) => a.nom)).toEqual(["explorateur", "relecteur"]);
  });

  it("un lancement sans `subagent_type` n'invente PAS de nom", () => {
    const turn = tour({ blocks: [blocOutil({ toolInput: { description: "chercher" } })] });
    expect(sousAgentsDuTour(turn)[0]).toEqual({
      nom: "sous-agent",
      description: "chercher",
      termine: false,
      erreur: false,
    });
  });

  it("distingue en vol, terminé et terminé EN ERREUR", () => {
    const turn = tour({
      blocks: [
        blocOutil({ id: "b1", toolInput: { subagent_type: "a" } }),
        blocOutil({ id: "b2", toolInput: { subagent_type: "b" }, result: { isError: false, summary: "ok" } }),
        blocOutil({ id: "b3", toolInput: { subagent_type: "c" }, result: { isError: true, summary: "boum" } }),
      ],
    });
    expect(sousAgentsDuTour(turn).map((a) => [a.termine, a.erreur])).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ]);
  });

  it("un tour sans blocs, ou absent, ne rend rien (jamais d'exception)", () => {
    expect(sousAgentsDuTour(undefined)).toEqual([]);
    expect(sousAgentsDuTour(tour({ blocks: undefined }))).toEqual([]);
  });

  it("`sousAgentsVifs` lit le DERNIER tour assistant, pas le tour utilisateur qui le suit", () => {
    const turns: AgentTurn[] = [
      tour({ id: "a1", blocks: [blocOutil({ toolInput: { subagent_type: "vieux" } })] }),
      tour({ id: "a2", blocks: [blocOutil({ toolInput: { subagent_type: "recent" } })] }),
      { id: "u1", role: "user", content: "et après ?", status: "done" },
    ];
    expect(sousAgentsVifs(turns).map((a) => a.nom)).toEqual(["recent"]);
    expect(sousAgentsVifs([])).toEqual([]);
  });
});

describe("withSousAgentBattement — T-102, le signe de vie sous l'appel Agent", () => {
  function blocOutil(partiel: Partial<Extract<AgentBlock, { type: "tool" }>>): AgentBlock {
    return { type: "tool", id: "b", toolUseId: "t", toolName: "Task", toolInput: {}, ...partiel } as AgentBlock;
  }

  it("pose le battement sur le bloc dont le toolUseId correspond", () => {
    const turns = [tour({ blocks: [blocOutil({ toolUseId: "agent-1" })] })];
    const suivant = withSousAgentBattement(turns, "agent-1", 3, "Bash", 1_000);
    const bloc = suivant[0].blocks![0] as Extract<AgentBlock, { type: "tool" }>;
    expect(bloc.sousAgent).toEqual({ outils: 3, dernierOutil: "Bash", instant: 1_000 });
  });

  it("le battement ÉCRASE le précédent — c'est un compteur cumulé, pas un historique", () => {
    const turns = [tour({ blocks: [blocOutil({ toolUseId: "agent-1", sousAgent: { outils: 1, dernierOutil: "Bash", instant: 500 } })] })];
    const suivant = withSousAgentBattement(turns, "agent-1", 2, "WebSearch", 900);
    const bloc = suivant[0].blocks![0] as Extract<AgentBlock, { type: "tool" }>;
    expect(bloc.sousAgent).toEqual({ outils: 2, dernierOutil: "WebSearch", instant: 900 });
  });

  it("cherche dans TOUS les tours, pas seulement le dernier (le flux a pu être redirigé — S3)", () => {
    const turns = [
      tour({ id: "a1", status: "done", blocks: [blocOutil({ toolUseId: "agent-1" })] }),
      { id: "u1", role: "user", content: "et alors ?", status: "done", injected: true } as AgentTurn,
      tour({ id: "a2", blocks: [] }),
    ];
    const suivant = withSousAgentBattement(turns, "agent-1", 1, "Bash", 1_000);
    const bloc = (suivant[0].blocks![0] as Extract<AgentBlock, { type: "tool" }>);
    expect(bloc.sousAgent).toEqual({ outils: 1, dernierOutil: "Bash", instant: 1_000 });
    // Les tours SANS le bloc visé ne sont pas touchés (même référence).
    expect(suivant[1]).toBe(turns[1]);
    expect(suivant[2]).toBe(turns[2]);
  });

  it("aucun bloc ne porte ce toolUseId ⇒ tableau inchangé, jamais d'exception", () => {
    const turns = [tour({ blocks: [blocOutil({ toolUseId: "autre" })] })];
    const suivant = withSousAgentBattement(turns, "agent-1", 1, "Bash", 1_000);
    expect(suivant[0]).toBe(turns[0]);
  });
});

describe("sousAgentOccupaitLeTour — T-102, la bulle « en attente » doit savoir pourquoi", () => {
  function blocOutil(partiel: Partial<Extract<AgentBlock, { type: "tool" }>>): AgentBlock {
    return { type: "tool", id: "b", toolUseId: "t", toolName: "Task", toolInput: {}, ...partiel } as AgentBlock;
  }

  it("un sous-agent encore SANS résultat dans le tour précédent ⇒ true", () => {
    const precedent = tour({ blocks: [blocOutil({ toolInput: { subagent_type: "explorateur" } })] });
    expect(sousAgentOccupaitLeTour(precedent)).toBe(true);
  });

  it("tous les sous-agents du tour précédent sont terminés ⇒ false", () => {
    const precedent = tour({
      blocks: [blocOutil({ toolInput: { subagent_type: "explorateur" }, result: { isError: false, summary: "ok" } })],
    });
    expect(sousAgentOccupaitLeTour(precedent)).toBe(false);
  });

  it("aucun sous-agent dans le tour précédent ⇒ false (pas de faux positif)", () => {
    expect(sousAgentOccupaitLeTour(tour({ blocks: [] }))).toBe(false);
  });

  it("pas de tour précédent (premier tour de la conversation) ⇒ false", () => {
    expect(sousAgentOccupaitLeTour(undefined)).toBe(false);
  });
});

describe("modeleSousAgentDeclare — T-081, le modèle déclaré d'un type de sous-agent", () => {
  const manifestes = [
    { name: "explorateur", model: "haiku" },
    { name: "implementeur", model: "sonnet" },
    { name: "sans-modele", model: null },
    { name: "modele-vide", model: "   " },
  ];

  it("rend le modèle déclaré par le manifeste", () => {
    expect(modeleSousAgentDeclare("explorateur", manifestes)).toEqual({ modele: "haiku", connu: true });
    expect(modeleSousAgentDeclare("implementeur", manifestes)).toEqual({ modele: "sonnet", connu: true });
  });

  it("un manifeste SANS modèle est `connu` : l'agent hérite du fil, ce n'est pas une absence", () => {
    expect(modeleSousAgentDeclare("sans-modele", manifestes)).toEqual({ modele: null, connu: true });
    // Un `model:` blanc vaut non déclaré — pas une chaîne d'espaces affichée telle quelle.
    expect(modeleSousAgentDeclare("modele-vide", manifestes)).toEqual({ modele: null, connu: true });
  });

  it("un type INCONNU n'invente aucun modèle (agents intégrés du SDK)", () => {
    expect(modeleSousAgentDeclare("general-purpose", manifestes)).toEqual({ modele: null, connu: false });
    expect(modeleSousAgentDeclare("explorateur", [])).toEqual({ modele: null, connu: false });
  });

  it("tolère casse et espaces de bord entre le `subagent_type` demandé et le manifeste", () => {
    expect(modeleSousAgentDeclare(" Explorateur ", manifestes)).toEqual({ modele: "haiku", connu: true });
  });
});

describe("withAgentSystemPrompt", () => {
  it("préfixe les instructions en message system ; sans instructions, rien ne bouge", () => {
    const base = [{ role: "user" as const, content: "salut" }];
    expect(withAgentSystemPrompt(base, "Tu es concis.")[0]).toEqual({ role: "system", content: "Tu es concis." });
    expect(withAgentSystemPrompt(base, undefined)).toBe(base);
    expect(withAgentSystemPrompt(base, "")).toBe(base);
  });

  it("jamais DEUX messages system : une tête system existante est respectée", () => {
    const deja = [{ role: "system" as const, content: "déjà là" }, { role: "user" as const, content: "x" }];
    expect(withAgentSystemPrompt(deja, "autre")).toBe(deja);
  });
});

describe("resumerTachesDeFond (T-093)", () => {
  it("aplatit une commande multi-lignes et la coupe", () => {
    // Le cas constaté : la description d'un `Bash` détaché EST la commande,
    // heredoc compris — quinze lignes de shell dans un encart d'une ligne.
    const commande = "cat > /tmp/q.ql << 'EOF'\n[out:json];\n(\n  node[\"place\"];\n);\nout body;\nEOF";
    const resume = resumerTachesDeFond([commande]);
    expect(resume).not.toContain("\n");
    expect(resume.length).toBeLessThanOrEqual(60);
    expect(resume.endsWith("…")).toBe(true);
  });

  it("nomme les trois premières et COMPTE le reste — jamais de troncature muette", () => {
    const sept = ["a", "b", "c", "d", "e", "f", "g"];
    expect(resumerTachesDeFond(sept)).toBe("a · b · c · +4 autres");
    expect(resumerTachesDeFond(["a", "b", "c", "d"])).toBe("a · b · c · +1 autre");
  });

  it("rend vide plutôt qu'un séparateur seul quand il n'y a rien à dire", () => {
    expect(resumerTachesDeFond([])).toBe("");
    expect(resumerTachesDeFond(["", "   "])).toBe("");
  });
});
