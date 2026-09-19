// Faux moteur Claude dont le flux lève l'exception d'un compte SATURÉ.
//
// Chargé par sidecar/src/claudeUsage.ts (executerClaudeUsageInit) quand
// IACTION_FAKE_CLAUDE=1 et IACTION_FAKE_CLAUDE_MODULE pointe ici. Le message
// est celui, réel, du 2026-08-15 (docs/tickets.md, T-059) : le refus PORTE
// l'heure de réinitialisation, et le sidecar doit le rendre comme une DONNÉE
// structurée plutôt que comme un échec générique du micro-tour.

export function fakeQuery({ options }) {
  async function* generator() {
    yield {
      type: "system",
      subtype: "init",
      session_id: (options && options.resume) || "fake-session-saturee",
      model: (options && options.model) || "fake-model",
    };
    throw new Error("Claude Code returned an error result: You've hit your session limit · resets 7:10pm (Europe/Paris)");
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
