// Faux moteur Claude qui MEURT SANS RIEN DIRE.
//
// Chargé par sidecar/src/claude.ts quand IACTION_FAKE_CLAUDE=1 et
// IACTION_FAKE_CLAUDE_MODULE pointe ici. Le générateur annonce la session
// (system/init) puis se termine : aucun message `result`, aucune exception.
//
// C'est exactement la panne du 2026-08-09 (T-015) : le tour est journalisé au
// démarrage, le processus CLI disparaît, et le flux du SDK se referme sans
// verdict. Le sidecar doit alors émettre une ERREUR explicite — sans quoi
// l'interface attend indéfiniment « Aucune donnée reçue du fournisseur ».

export function fakeQuery({ options }) {
  async function* generator() {
    yield {
      type: "system",
      subtype: "init",
      session_id: (options && options.resume) || "fake-session-muette",
      model: (options && options.model) || "fake-model",
    };
    // Fin du flux. Rien d'autre : ni texte, ni result, ni erreur.
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
