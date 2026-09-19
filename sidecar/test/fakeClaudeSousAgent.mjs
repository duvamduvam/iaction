// Faux moteur Claude — scénario T-102 : un sous-agent qui tourne 38 minutes
// sans un mot, interrompu par claude.abort, puis un second tour qui doit
// recevoir le rappel factuel préparé par le sidecar.
//
// Premier appel (numéro 1, sans `options.resume`) :
//   1. system/init
//   2. message assistant portant un tool_use "Agent" (subagent_type +
//      description) — jamais résolu tant qu'on n'interrompt pas
//   3. deux messages `parent_tool_use_id`-marqués (sous-agent) portant chacun
//      un tool_use ("Bash" puis "WebSearch") — c'est ce que compte
//      sousAgentsJournal.ts, et ce qui doit faire battre `sous_agent_battement`
//   4. blocage jusqu'à interrupt() — puis le générateur s'arrête NET, sans
//      `result` (un des deux chemins réels possibles, voir claudeFinDeTour.ts)
//
// Second appel (numéro 2, `options.resume` = la session du premier) : renvoie
// tel quel le texte du prompt reçu (voir readPromptText), pour que le test
// vérifie que le rappel préparé par le sidecar a bien été préfixé.

import { readPromptText } from "./fakeClaude.mjs";

let appelNumero = 0;

export function fakeQuery({ prompt, options }) {
  appelNumero += 1;
  const monAppel = appelNumero;
  let debloquer;
  const attenteInterruption = new Promise((resolve) => {
    debloquer = resolve;
  });

  async function* generator() {
    const sessionId = (options && options.resume) || "fake-session-sousagent";
    yield { type: "system", subtype: "init", session_id: sessionId, model: "fake-model" };

    if (monAppel === 1) {
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "agent-1",
              name: "Agent",
              input: { subagent_type: "explorateur", description: "Écrire le .scad du support micro" },
            },
          ],
        },
      };

      // Deux outils vus chez le sous-agent : parent_tool_use_id le rattache à
      // "agent-1" (voir origineMessage/claudeSousAgents.ts) — c'est ce battement
      // que le sidecar doit reverser en chunk `sous_agent_battement`.
      yield {
        type: "assistant",
        parent_tool_use_id: "agent-1",
        message: { content: [{ type: "tool_use", id: "sub-1", name: "Bash", input: { command: "openscad --render" } }] },
      };
      yield {
        type: "assistant",
        parent_tool_use_id: "agent-1",
        message: { content: [{ type: "tool_use", id: "sub-2", name: "WebSearch", input: { query: "support micro STL" } }] },
      };

      // Simule les 38 minutes de silence (T-102) : bloque jusqu'à interrupt().
      await attenteInterruption;
      return; // le faux SDK s'arrête NET, sans `result` — voir cloturerTourSansResultatFinal.
    }

    // Second tour (resume) : renvoie le texte reçu, pour que le test vérifie
    // que le rappel d'interruption y a bien été préfixé (voir claude.ts).
    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: await readPromptText(prompt),
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    };
  }

  const iterator = generator();

  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async interrupt() {
      debloquer();
      return { subtype: "aborted" };
    },
  };
}
