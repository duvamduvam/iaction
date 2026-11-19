// Faux moteur Claude pour les tests de l'outil `changer_modele` (T-207).
//
// Le prompt du tour est un JSON décrivant le scénario :
//   { "appels": [{ modele, effort?, raison }, ...],  // appels de l'outil, dans l'ordre
//     "compacter": [{ raison }, ...],                 // T-216 : appels de l'outil `compacter`
//     "reveil": [{ heures, surResetQuota, prompts, raison }, ...],  // T-219 : appels de `programmer_reveil`
//     "echec": "setModel" | "applyFlagSettings",      // fait lever le faux SDK
//     "attente": true }                                // garde le tour ouvert jusqu'à un 2e message
//
// L'outil appelé est le VRAI gestionnaire (sidecar/src/changerModele.ts), servi
// par le serveur de substitution que askUser.ts monte sous
// IACTION_FAKE_CLAUDE_STUDIO=1. Le faux `query` enregistre ce que le moteur lui
// demande (setModel / applyFlagSettings) ; le `result` final rapporte tout au
// test : outils exposés, résultats rendus au modèle, appels reçus.

function textOf(message) {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}

export function fakeQuery({ prompt, options }) {
  let interrupted = false;
  const recus = [];
  let echec = null;

  async function* generator() {
    const sessionId = options?.resume || "fake-modele-session";
    let scenario = { appels: [] };
    let premier = true;
    const iterateur = prompt[Symbol.asyncIterator]();
    const lu = await iterateur.next();
    if (!lu.done && premier) {
      premier = false;
      try {
        scenario = JSON.parse(textOf(lu.value));
      } catch {
        scenario = { appels: [] };
      }
    }
    echec = scenario.echec ?? null;

    yield { type: "system", subtype: "init", session_id: sessionId, model: options?.model || "fake-model" };

    const outils = options?.mcpServers?.studio?.outilsFactices ?? {};
    const resultats = [];
    for (const appel of scenario.appels ?? []) {
      const handler = outils.changer_modele;
      if (!handler) {
        resultats.push({ absent: true });
        continue;
      }
      resultats.push(await handler(appel));
    }
    const resultatsCompacter = [];
    for (const appel of scenario.compacter ?? []) {
      const handler = outils.compacter;
      resultatsCompacter.push(handler ? await handler(appel) : { absent: true });
    }
    const resultatsReveil = [];
    for (const appel of scenario.reveil ?? []) {
      const handler = outils.programmer_reveil;
      resultatsReveil.push(handler ? await handler(appel) : { absent: true });
    }

    if (scenario.attente && !interrupted) {
      // Garde le tour ouvert jusqu'à un message poussé (ou la fermeture de l'entrée).
      await iterateur.next();
    }
    if (interrupted) return;

    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: JSON.stringify({
        hasStudio: Boolean(options?.mcpServers?.studio),
        outils: Object.keys(outils),
        resultats,
        resultatsCompacter,
        resultatsReveil,
        disallowedTools: options?.disallowedTools ?? null,
        recus,
        systemPrompt: options?.systemPrompt ?? null,
      }),
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    };
  }

  const iterator = generator();
  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async interrupt() {
      interrupted = true;
    },
    async setModel(model) {
      recus.push(["setModel", model]);
      if (echec === "setModel") throw new Error("setModel refusé par le faux SDK");
    },
    async applyFlagSettings(settings) {
      recus.push(["applyFlagSettings", settings]);
      if (echec === "applyFlagSettings") throw new Error("applyFlagSettings refusé par le faux SDK");
    },
  };
}
