// Faux moteur Claude TOTALEMENT MUET : le flux ne rend aucun message et ne se
// referme jamais.
//
// Chargé quand IACTION_FAKE_CLAUDE=1 et IACTION_FAKE_CLAUDE_MODULE pointe ici.
// C'est le pire cas de T-015, et celui réellement vécu le 2026-08-09 : le tour
// est journalisé au démarrage, AUCUN processus `claude` n'est jamais lancé, et
// le `for await` du sidecar reste suspendu pour toujours. Aucun garde-fou de
// fin de flux ne peut s'y déclencher — seul un plafond de silence le peut.
//
// `interrupt()` est volontairement inopérant : un vrai processus bloqué ne
// répond pas non plus. Le sidecar doit rendre son verdict sans son aide.

export function fakeQuery() {
  async function* generator() {
    await new Promise(() => {
      // Jamais résolue : le générateur ne rend rien et ne se termine pas.
    });
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
