// Faux moteur Claude dédié aux tests MCP v1 (support .mcp.json dans
// claude.ts, section claude.start § MCP de docs/protocol.md).
//
// Contrairement à fakeClaude.mjs (scénario complet init/text/tool_use/
// permission), ce faux SDK n'a besoin que de rapporter, depuis le
// sous-processus sidecar vers le process de test, EXACTEMENT ce que
// `options.mcpServers` valait au moment de l'appel à queryFn — c'est la
// seule façon d'observer les Options reçues par le SDK depuis le process de
// test (qui ne voit que les événements du protocole JSON Lines).
//
// Scénario : system/init immédiat, puis result/success dont le champ
// `result` est un JSON stringifié {hasMcpServers, mcpServers, tools} —
// le test parse ce texte pour vérifier ce qui a été passé au SDK.

export function fakeQuery({ prompt, options }) {
  let interrupted = false;

  async function* generator() {
    const sessionId = (options && options.resume) || "fake-mcp-session";
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: (options && options.model) || "fake-model",
    };

    if (interrupted) return;

    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: JSON.stringify({
        hasMcpServers: Boolean(options && Object.prototype.hasOwnProperty.call(options, "mcpServers")),
        mcpServers: (options && options.mcpServers) ?? null,
        tools: (options && options.tools) ?? null,
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
      return { subtype: "aborted" };
    },
  };
}
