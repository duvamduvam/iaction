/*
 * T-092 — d'où vient ce message du SDK : du fil, ou d'un SOUS-AGENT ?
 *
 * ── Le défaut ───────────────────────────────────────────────────────────
 * Constat du 2026-08-27 (capture) : dans une conversation où seize
 * sous-agents avaient travaillé, la transcription montrait un mot coupé en
 * deux par des appels d'outils (« ont pro » … « posé »), et un paragraphe
 * entier réinséré au milieu d'un autre (« On s » + un texte complet +
 * « ait qu'il y a… »). Le fil devenait illisible.
 *
 * ── La cause ────────────────────────────────────────────────────────────
 * Le Claude Agent SDK marque tout ce qu'un sous-agent produit d'un
 * `parent_tool_use_id` (l'id du `Task` qui l'a lancé) — c'est même la seule
 * raison d'être de ce champ, présent sur les messages `assistant`, `user` et
 * `stream_event`. Par défaut le SDK ne transmet que les `tool_use` /
 * `tool_result` des sous-agents (« enough for a heartbeat counter », cf.
 * `forwardSubagentText` dans sdk.d.ts) — mais il les transmet, et le sidecar
 * ne regardait jamais ce champ. Trois conséquences, toutes visibles :
 *
 *   1. les outils d'un sous-agent s'affichaient comme ceux du fil, au milieu
 *      d'une phrase du fil, qu'ils coupaient en deux ;
 *   2. `sawTextDeltaForCall` — le drapeau anti-doublon qui distingue « ce
 *      texte est déjà parti en deltas » de « ce message n'a jamais été
 *      streamé » — était remis à zéro par le message d'un sous-agent. Le
 *      message suivant du fil était alors réémis EN ENTIER, par-dessus les
 *      deltas déjà envoyés : d'où le paragraphe recopié au milieu d'un mot ;
 *   3. l'`usage` d'un message de sous-agent servait de mesure d'occupation du
 *      contexte : la jauge du fil affichait le contexte de quelqu'un d'autre.
 *
 * ── Ce qui est retenu, et ce qui ne l'est pas ───────────────────────────
 * Le fil ne montre plus que ce que le fil a produit. Le travail des
 * sous-agents reste visible ailleurs — panneau « Sous-agents » (T-077), qui
 * se déduit des blocs `Task` du fil, eux bien à lui. Ce qui est perdu : le
 * détail des recherches faites par un sous-agent, qu'on voyait passer (mal
 * attribué). Le rendre correctement demande une transcription imbriquée et
 * l'option `forwardSubagentText` — c'est un autre travail, pas une
 * régression de celui-ci.
 *
 * La comptabilité, elle, ne perd rien : les appels MCP d'un sous-agent
 * continuent d'être chronométrés et journalisés (voir claude.ts) — seule
 * leur ÉMISSION vers la transcription du fil est retirée.
 */

/** Émetteur d'un message du SDK : le fil principal, ou un sous-agent. */
export type OrigineMessage = "fil" | "sous-agent";

/**
 * Un message porte-t-il la marque d'un sous-agent ?
 *
 * `parent_tool_use_id` vaut `null` sur le fil principal et porte l'id du
 * `Task` lanceur sinon. Tolérant par construction : tout ce qui n'est pas une
 * chaîne non vide est traité comme venant du fil — un champ absent ou d'une
 * forme inattendue ne doit jamais faire DISPARAÎTRE du contenu du fil, alors
 * que l'inverse (laisser passer un message de sous-agent non marqué) ne fait
 * que revenir au comportement d'avant.
 */
export function origineMessage(message: unknown): OrigineMessage {
  if (typeof message !== "object" || message === null) return "fil";
  const parent = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof parent === "string" && parent.trim().length > 0 ? "sous-agent" : "fil";
}
