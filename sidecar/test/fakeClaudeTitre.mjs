// Faux moteur pour le témoin de claude.titreDiscussion : répond un titre, sans
// permission ni outil. AUCUN appel réseau, aucun modèle réel.
export function fakeQuery() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "assistant", message: { content: [{ type: "text", text: "« Chansons faciles pour ukulélé. »" }] } };
      yield { type: "result", subtype: "success", result: "« Chansons faciles pour ukulélé. »" };
    },
    async interrupt() {},
  };
}
