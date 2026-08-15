/*
 * Réponses SSE d'un faux serveur OpenAI-compatible.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────
 * Ces trois helpers vivaient en closures dans `protocol.test.js`, alors qu'ils
 * ne lisent RIEN de son état : ils ne parlent que le protocole SSE de
 * `/v1/chat/completions`. Les sortir rend le gros fichier de test un peu moins
 * gros — c'est ce que demandait le cliquet de taille le 2026-08-15 — et surtout
 * les rend réutilisables par le prochain mock au lieu d'être recopiés.
 *
 * Ils ne vont PAS dans `harness.mjs` : sa règle écrite est que rien n'y
 * connaisse un domaine particulier, et le format de trame d'un fournisseur
 * OpenAI-compatible en est un.
 */

/** Une trame `data:` du flux SSE. */
export function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * Réponse « appel d'outil », arguments FRAGMENTÉS en deux morceaux.
 *
 * La fragmentation est délibérée : l'id et le nom n'arrivent que sur le premier
 * `delta.tool_calls`, les arguments ensuite par bouts. C'est ce qui exerce
 * l'accumulation par index côté moteur neutre — un mock qui enverrait l'appel
 * d'un seul tenant ne prouverait rien de ce chemin-là.
 */
export function sendToolCallResponse(res, toolCall) {
  const argsJson = JSON.stringify(toolCall.args ?? {});
  const mid = Math.max(1, Math.floor(argsJson.length / 2));
  const fragments = [argsJson.slice(0, mid), argsJson.slice(mid)];
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sseChunk(res, {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: "" } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  for (const frag of fragments) {
    sseChunk(res, {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: frag } }] }, finish_reason: null },
      ],
    });
  }
  sseChunk(res, {
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

/**
 * Réponse texte finale.
 *
 * R6-A : `extraUsage` optionnel, fusionné dans l'usage final (usage étendu
 * R0 — cost/prompt_tokens_details — pour l'op `final_cost`).
 */
export function sendFinalTextResponse(res, text, extraUsage = null) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sseChunk(res, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sseChunk(res, {
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 6, completion_tokens: 2, ...(extraUsage ?? {}) },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}
