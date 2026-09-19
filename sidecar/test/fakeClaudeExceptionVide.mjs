// Faux moteur Claude dont le flux lève une exception AU MESSAGE VIDE.
//
// Chargé par sidecar/src/claude.ts quand IACTION_FAKE_CLAUDE=1 et
// IACTION_FAKE_CLAUDE_MODULE pointe ici. Le générateur annonce la session
// (system/init) puis lève `new Error("")` : certaines erreurs du SDK
// n'embarquent aucun message, et le catch de claude.ts prenait alors
// `err.message` tel quel — un événement d'usage et un journal muets malgré
// l'échec bien réel (T-076).

export function fakeQuery({ options }) {
  async function* generator() {
    yield {
      type: "system",
      subtype: "init",
      session_id: (options && options.resume) || "fake-session-exception-vide",
      model: (options && options.model) || "fake-model",
    };
    throw new Error("");
  }

  const iterator = generator();

  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async interrupt() {
      return { subtype: "aborted" };
    },
  };
}
