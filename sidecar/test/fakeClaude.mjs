// Faux moteur Claude pour les tests du sidecar (Lot 2).
//
// Exporte fakeQuery({prompt, options}), chargé dynamiquement par
// sidecar/src/claude.ts quand IACTION_FAKE_CLAUDE=1 et
// IACTION_FAKE_CLAUDE_MODULE pointe vers ce fichier. Simule la séquence de
// messages émise par le vrai Claude Agent SDK — AUCUN appel réseau, AUCUN
// sous-processus `claude` — pour vérifier le mapping vers le protocole
// (chunks init/text/thinking/tool_use/tool_result/permission_request, puis
// done) sans consommer le moindre crédit d'API.
//
// Scénario simulé pour chaque appel :
//   1. system/init
//   2. texte streamé en 3 deltas via stream_event ("Bonjour" + " le" + " monde")
//   3. message assistant complet portant le MÊME texte (pour vérifier que le
//      sidecar ne le réémet pas en double)
//   4. message assistant avec un bloc tool_use ("Bash")
//   5. appel de options.canUseTool(...) — le sidecar doit alors émettre un
//      chunk permission_request et bloquer jusqu'à la résolution (via
//      claude.permission, ou via query.interrupt()/claude.abort)
//   6. selon la décision reçue :
//      - allow  -> message user avec un tool_result isError:false, puis result/success
//      - deny   -> message user avec un tool_result isError:true dont le contenu
//                  est le message de refus (permet de vérifier depuis le process
//                  de test, via les événements protocolaires, que le faux SDK a
//                  bien reçu {behavior:"deny", message})
//      - abort (query.interrupt() appelé avant résolution) -> le générateur
//        s'arrête sans yield supplémentaire, dès que canUseTool se résout
//        (résolu en deny par le sidecar lui-même lors de claude.abort)

/**
 * Texte du prompt du tour. Le sidecar passe TOUJOURS une entrée streamée
 * (AsyncIterable d'un message utilisateur, qui reste ensuite ouverte — voir
 * createTurnPrompt/claude.ts) : on lit le PREMIER message et on s'arrête là,
 * sans consommer la suite (elle ne se termine qu'à la fin du tour).
 */
export async function readPromptText(prompt) {
  if (typeof prompt === "string") return prompt;
  for await (const message of prompt) {
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
  return "";
}

export function fakeQuery({ prompt, options }) {
  let interrupted = false;

  async function* generator() {
    const sessionId = (options && options.resume) || "fake-session-1";
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: (options && options.model) || "fake-model",
    };

    for (const piece of ["Bonjour", " le", " monde"]) {
      if (interrupted) return;
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: piece },
        },
      };
    }

    if (interrupted) return;

    // Message assistant complet reprenant le même texte : ne doit pas être
    // réémis par le sidecar (déjà couvert par les deltas ci-dessus).
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "Bonjour le monde" }] },
    };

    if (interrupted) return;

    const toolUseId = "tool-1";
    yield {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "echo hi" } }],
        // Usage de CE seul appel API (per-call) : la jauge de contexte doit
        // s'appuyer dessus (dernier message assistant), pas sur le cumul du
        // `result`. Prompt = 100 + 5000 + 200 = 5300 ; l'output (50) est
        // volontairement EXCLU (voir extractContextTokens).
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 200,
          output_tokens: 50,
        },
      },
    };

    if (interrupted) return;

    let decision = null;
    if (options && typeof options.canUseTool === "function") {
      decision = await options.canUseTool(
        "Bash",
        { command: "echo hi" },
        { signal: makeNeverAbortingSignal(), toolUseID: toolUseId },
      );
    }

    if (interrupted) {
      return;
    }

    if (decision && decision.behavior === "deny") {
      yield {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              is_error: true,
              content: decision.message,
            },
          ],
        },
      };
      yield {
        type: "result",
        subtype: "error_denied",
        session_id: sessionId,
        result: null,
        usage: { input_tokens: 3, output_tokens: 1 },
        total_cost_usd: 0.0001,
      };
      return;
    }

    yield {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: false, content: "hi\n" }],
      },
    };

    if (interrupted) return;

    // Message assistant SYNTHÉTIQUE, jamais streamé (aucun delta ne le
    // précède) : c'est ainsi que le CLI signale une erreur API en cours de
    // tour (ex. « API Error: 529 Overloaded », model "<synthetic>"). Le
    // sidecar DOIT réémettre son texte (sinon il n'atteint jamais l'UI),
    // sans pour autant dupliquer les textes déjà streamés ci-dessus.
    yield {
      type: "assistant",
      message: {
        model: "<synthetic>",
        content: [{ type: "text", text: "API Error: 529 Overloaded (simulé)" }],
      },
    };

    if (interrupted) return;

    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: `Réponse pour: ${await readPromptText(prompt)}`,
      usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 2 },
      total_cost_usd: 0.0021,
    };
  }

  // Un AbortSignal qui ne s'abort jamais : dans ce faux SDK, c'est
  // query.interrupt() (appelé par claude.abort côté sidecar) qui positionne
  // `interrupted`, pas le signal transmis à canUseTool. Le sidecar réel gère
  // le vrai signal du SDK ; ce faux SDK teste le chemin interrupt()+deny
  // explicite plutôt que le signal.
  function makeNeverAbortingSignal() {
    const controller = new AbortController();
    return controller.signal;
  }

  const iterator = generator();

  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async interrupt() {
      interrupted = true;
      return { subtype: "aborted" };
    },
  };
}
