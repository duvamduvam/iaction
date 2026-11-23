// Faux moteur qui RENVOIE les options reçues (T-227) : le test du périmètre du
// tour du veilleur lit, dans le `result`, ce que claude.ts a vraiment passé au
// SDK (sources de réglages, MCP strict, navigateur, budget, crochets). Il
// appelle aussi le crochet PreToolUse sur une écriture de `.mcp.json` pour
// rapporter sa décision. AUCUN appel réseau, aucun modèle réel.
export function fakeQuery({ options }) {
  return {
    async *[Symbol.asyncIterator]() {
      let decisionMcp = "aucun crochet";
      const garde = options?.hooks?.PreToolUse?.[0]?.hooks?.[0];
      if (typeof garde === "function") {
        const r = await garde({ tool_name: "Write", tool_input: { file_path: `${options.cwd}/.mcp.json` } });
        decisionMcp = r?.hookSpecificOutput?.permissionDecision ?? "allow";
      }
      const vu = {
        settingSources: options?.settingSources ?? null,
        strictMcpConfig: options?.strictMcpConfig ?? null,
        extraArgs: options?.extraArgs ?? null,
        cfc: options?.env?.CLAUDE_CODE_ENABLE_CFC ?? null,
        maxBudgetUsd: options?.maxBudgetUsd ?? null,
        mcpServers: Object.keys(options?.mcpServers ?? {}).sort(),
        decisionMcp,
      };
      const texte = JSON.stringify(vu);
      yield { type: "system", subtype: "init", session_id: "fake-options", model: "fake" };
      yield { type: "assistant", message: { content: [{ type: "text", text: texte }] } };
      yield { type: "result", subtype: "success", result: texte, session_id: "fake-options", usage: { input_tokens: 1, output_tokens: 1 } };
    },
    async interrupt() {},
  };
}
