// Faux moteur Claude — scénario « tâches de fond » (claude.release + plafond).
//
// Exporte fakeQuery({prompt, options}), chargé par sidecar/src/claude.ts quand
// IACTION_FAKE_CLAUDE=1 et IACTION_FAKE_CLAUDE_MODULE pointe ici. Simule
// un tour dont le `result` arrive alors qu'une tâche de fond vit encore, puis
// une attente SANS FIN de son rapport (il ne vient jamais) :
//
//   1. system/init
//   2. un delta de texte
//   3. system/background_tasks_changed avec UNE tâche vivante
//   4. result/success — le sidecar doit alors émettre le chunk
//      `background_wait` et GARDER le tour ouvert (pendingResultDone)
//   5. attente indéfinie : seul query.interrupt() (via claude.release, ou le
//      plafond IACTION_BACKGROUND_WAIT_TIMEOUT_MS) fait finir le générateur,
//      et le repli de fin de flux du sidecar livre le done avec le résultat
//      connu (subtype success).
import { readPromptText } from "./fakeClaude.mjs";

export function fakeQuery({ prompt, options }) {
  let releaseWait = null;
  const waitInterrupt = new Promise((resolve) => {
    releaseWait = resolve;
  });

  async function* generator() {
    const sessionId = (options && options.resume) || "fake-bg-session-1";
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: (options && options.model) || "fake-model",
    };

    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Je lance une tâche de fond." },
      },
    };

    yield {
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "bg-1", description: "fausse tâche interminable" }],
    };

    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: `Tour fini, tâche en fond pour: ${await readPromptText(prompt)}`,
      usage: { input_tokens: 7, output_tokens: 3 },
      total_cost_usd: 0.001,
    };

    // Le rapport de la tâche ne vient JAMAIS : seul interrupt() libère.
    await waitInterrupt;
  }

  const iterator = generator();

  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async interrupt() {
      releaseWait?.();
      return { subtype: "aborted" };
    },
  };
}
