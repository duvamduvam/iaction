// Faux moteur Claude minimal, avec la méthode expérimentale d'usage, pour
// tester usage.claude (sidecar/src/claude.ts, captureUsageSnapshot). Contrairement
// à fakeClaude.mjs (qui reste volontairement SANS cette méthode pour couvrir le
// cas "SDK sans usage_EXPERIMENTAL..."), ce module simule un tour minimal
// (system/init puis result) et expose
// usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() avec un échantillon
// réaliste conforme à SDKControlGetUsageResponse (voir
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts ~L3151).

export function fakeQuery({ options }) {
  async function* generator() {
    const sessionId = (options && options.resume) || "fake-usage-session";
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: (options && options.model) || "fake-model",
    };
    yield {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0.0001,
    };
  }

  const iterator = generator();

  return {
    [Symbol.asyncIterator]() {
      return iterator;
    },
    async interrupt() {
      return { subtype: "aborted" };
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      return {
        session: {
          total_cost_usd: 0.0001,
          total_api_duration_ms: 10,
          total_duration_ms: 20,
          total_lines_added: 0,
          total_lines_removed: 0,
          model_usage: {},
        },
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42, resets_at: "2026-07-19T18:00:00Z" },
          seven_day: { utilization: 13, resets_at: "2026-07-25T00:00:00Z" },
          // Fenêtre spécifique à un modèle (le nommage réel peut varier —
          // l'extraction générique de `windows` doit la relayer telle quelle).
          seven_day_opus: { utilization: 7, resets_at: "2026-07-25T00:00:00Z" },
        },
        behaviors: null,
      };
    },
  };
}
