// Faux moteur Claude — scénario `claude.commands` (T-058).
//
// Exporte fakeQuery({prompt, options}), chargé par sidecar/src/claudeQueryFn.ts
// quand IACTION_FAKE_CLAUDE=1 et IACTION_FAKE_CLAUDE_MODULE pointe ici.
// `executerClaudeCommands` (sidecar/src/claudeCommands.ts) n'exploite QUE
// deux membres de l'objet rendu par queryFn : `supportedCommands()` et
// `interrupt()` — le prompt qu'il fournit (généré par createNonYieldingPrompt)
// ne yield jamais, donc rien ici ne lit `prompt`.
//
// Un `options.cwd` contenant `echec-init` fait ÉCHOUER l'appel dès
// l'ouverture de la session (simule un échec d'auth/SDK — voir
// docs/protocol.md § claude.commands : « Échec d'initialisation SDK (auth,
// cwd invalide) → error lisible »).
export function fakeQuery({ options }) {
  if (options && typeof options.cwd === "string" && options.cwd.includes("echec-init")) {
    throw new Error("API Error: 401 Unauthorized (simulé, échec d'initialisation)");
  }

  let interrupted = false;

  return {
    async supportedCommands() {
      return [
        { name: "compact", description: "Résume la conversation.", argumentHint: "" },
        { name: "revue", description: "Lance une revue de code.", argumentHint: "<fichier>", aliases: ["r"] },
      ];
    },
    async interrupt() {
      interrupted = true;
      return { subtype: "aborted" };
    },
    get interrompu() {
      return interrupted;
    },
  };
}
