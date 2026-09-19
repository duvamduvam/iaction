// Faux moteur Claude pour les tests de `push_perdu` (T-087) et des pièces
// jointes poussées (T-064).
//
// Comme fakeClaudePush.mjs, l'entrée streamée reste ouverte après le premier
// message et attend un message SUPPLÉMENTAIRE (le push). Ce qui diffère :
// - il rend compte des TYPES de blocs du message poussé (texte, image…), pour
//   prouver que les pièces jointes ont bien traversé l'entrée streamée ;
// - `IACTION_FAKE_PUSH_OUTIL_APRES=1` fait rappeler un outil (tool_use puis
//   son tool_result DU FIL) APRÈS le push, avant le `result` — c'est le
//   signal d'acquittement que le sidecar guette. Sans cette variable, le
//   moteur passe directement au `result` : aucun tool_result n'a suivi le
//   push, il doit ressortir en `push_perdu`.

function blocTypes(message) {
  const content = message?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.map((b) => (b && typeof b === "object" ? b.type : typeof b));
}

export function fakeQuery({ prompt, options }) {
  let interrupted = false;
  const outilApres = process.env.IACTION_FAKE_PUSH_OUTIL_APRES === "1";

  async function* generator() {
    const sessionId = options?.resume || "fake-push-perdu-session";
    yield { type: "system", subtype: "init", session_id: sessionId, model: "fake-model" };

    let pushedTypes = null;
    let first = true;
    for await (const message of prompt) {
      if (first) {
        first = false;
        continue;
      }
      pushedTypes = blocTypes(message);
      break;
    }

    if (interrupted) return;

    if (pushedTypes !== null) {
      yield {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: `push reçu, blocs: ${pushedTypes.join(",")}` }] },
        session_id: sessionId,
      };
      if (outilApres) {
        yield {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
          session_id: sessionId,
        };
        yield {
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }
    }

    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: pushedTypes === null ? "sans push" : "après push",
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
