// Faux moteur Claude pour les tests de `claude.push` (S3).
//
// Contrairement à fakeClaude.mjs, celui-ci CONTINUE de lire l'entrée streamée
// après le premier message : c'est exactement ce que fait le vrai CLI, et donc
// ce qui permet de vérifier qu'un message poussé en cours de tour lui parvient
// bien (voir createTurnPrompt/claude.ts et docs/protocol.md § claude.push).
//
// Scénario : init, puis attente d'un message SUPPLÉMENTAIRE sur l'entrée. Dès
// qu'il arrive, il est renvoyé en clair dans un message assistant (`injecté:
// <texte>`), suivi du `result`. Si l'entrée se ferme sans qu'aucun message ne
// soit poussé (close() de fin de tour), le tour se termine sur `result` sans
// texte : le test peut ainsi distinguer les deux cas.

function textOf(message) {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

export function fakeQuery({ prompt, options }) {
  let interrupted = false;

  async function* generator() {
    const sessionId = options?.resume || "fake-push-session";
    yield { type: "system", subtype: "init", session_id: sessionId, model: "fake-model" };

    let injected = null;
    let first = true;
    // L'entrée reste ouverte jusqu'au close() de fin de tour : cette boucle
    // rend la main dès qu'un message POUSSÉ arrive (le premier message est
    // celui du tour lui-même).
    for await (const message of prompt) {
      if (first) {
        first = false;
        continue;
      }
      injected = textOf(message);
      break;
    }

    if (interrupted) return;

    if (injected !== null) {
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `injecté: ${injected}` }] },
        session_id: sessionId,
      };
    }

    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: injected === null ? "sans injection" : `injecté: ${injected}`,
      usage: { input_tokens: 3, output_tokens: 4 },
    };
  }

  const iterator = generator();
  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async interrupt() {
      interrupted = true;
      await iterator.return(undefined);
      return { subtype: "aborted" };
    },
  };
}
