/*
 * Transcription de la page Projets — les tours et leurs blocs.
 *
 * Sortis d'AgentPage.tsx (dernière tranche de l'étape 8) : quatre composants
 * MÉMOÏSÉS déjà autonomes, dont la seule raison d'habiter la page était
 * l'histoire. La mémoïsation n'est pas un détail : sans elle, chaque frappe
 * du composeur re-parsait le markdown de TOUS les tours (constaté le
 * 2026-07-31) — les callbacks reçus doivent donc rester STABLES (wrappers
 * useCallback+ref côté page).
 */

import { memo } from "react";
import { SentAttachments } from "./Attachments";
import { closeDanglingFence, Markdown } from "./Markdown";
import { TtsButton } from "./VoiceControls";
import {
  MESSAGE_ATTENTE_FOURNISSEUR,
  enAttenteDuPremierOctet,
  useAttenteFournisseur,
} from "./useAttenteFournisseur";
import {
  hasVisibleContent,
  mcpServerFromToolName,
  prettyJson,
  spokenTextOfTurn,
  toolPreview,
  turnSubtypeNotice,
  type AgentBlock,
  type AgentTurn,
} from "./agentTurns";

function ThinkingBlockView({ content }: Readonly<{ content: string }>) {
  return (
    <details className="thinking-block">
      <summary>Raisonnement…</summary>
      <div className="thinking-block__content">{content}</div>
    </details>
  );
}

/** `toolName` = "mcp__<serveur>__<outil>" pour un outil MCP (voir docs/protocol.md) — `null` sinon. */

function ToolBlockView({ block }: Readonly<{ block: Extract<AgentBlock, { type: "tool" }> }>) {
  const preview = toolPreview(block.toolName, block.toolInput);
  const state = block.result ? (block.result.isError ? "error" : "ok") : "pending";
  const icon = state === "error" ? "✗" : state === "ok" ? "✓" : "…";
  const mcpServer = mcpServerFromToolName(block.toolName);
  return (
    <details className="tool-activity">
      <summary>
        <span aria-hidden="true">🔧</span>
        <span className="tool-activity__name">{block.toolName}</span>
        {mcpServer && <span className="tool-activity__mcp-badge">MCP:{mcpServer}</span>}
        <span className="tool-activity__preview">{preview}</span>
        <span className={`tool-activity__status tool-activity__status--${state}`}>{icon}</span>
      </summary>
      <div className="tool-activity__detail">
        <pre className="pretty-json">{prettyJson(block.toolInput)}</pre>
        {block.result && (
          <div className={`tool-activity__result${block.result.isError ? " tool-activity__result--error" : ""}`}>
            {block.result.summary}
          </div>
        )}
      </div>
    </details>
  );
}

/** Mémoïsé (comme AgentTurnView) : seuls les blocs dont l'objet change
    re-rendent — le markdown des longs tours n'est pas re-parsé à chaque
    frappe du composeur ni à chaque delta streamé ailleurs dans le tour. */
const AgentBlockView = memo(function AgentBlockView({
  block,
  onFileRef,
}: Readonly<{ block: AgentBlock; onFileRef: (ref: string) => void }>) {
  // Rendu Markdown (GFM) pour le texte de l'assistant uniquement — voir
  // Markdown.tsx. `.agent-text-block` garde son rôle d'espacement entre
  // blocs consécutifs (`.agent-text-block + .agent-text-block`, App.css) ;
  // `.md` y réinitialise `white-space` (hérité en `pre-wrap` depuis
  // `.chat-bubble`) pour laisser le flux Markdown normal s'appliquer.
  if (block.type === "text") {
    return (
      <div className="agent-text-block">
        <Markdown content={block.content} onFileRef={onFileRef} />
      </div>
    );
  }
  if (block.type === "thinking") return <ThinkingBlockView content={block.content} />;
  return <ToolBlockView block={block} />;
});

function AgentTurnMeta({ info }: Readonly<{ info: NonNullable<AgentTurn["doneInfo"]> }>) {
  return (
    <div className="chat-bubble__usage">
      {info.usage && (
        <span>
          {info.usage.inputTokens} in / {info.usage.outputTokens} out
        </span>
      )}
      {info.totalCostUsd !== null && <span> · ${info.totalCostUsd.toFixed(4)} est.</span>}
      {info.subtype !== "success" && <span> · {info.subtype}</span>}
    </div>
  );
}

/** Mémoïsé : le brouillon du composeur vit dans l'état de la page — sans
    memo, chaque frappe re-rendait TOUS les tours (parsing markdown compris,
    saisie visiblement ralentie sur les longs fils, constaté le 2026-07-31).
    Exige des props stables : les callbacks passés ici sont des wrappers
    useCallback+ref (voir le composant page). */
export const AgentTurnView = memo(function AgentTurnView({
  turn,
  onFileRef,
  onReleaseBackground,
}: Readonly<{
  turn: AgentTurn;
  onFileRef: (ref: string) => void;
  /** Rendre la main pendant l'attente des rapports de tâches de fond (claude.release). */
  onReleaseBackground?: () => void;
}>) {
  // T-006 — streaming sans le moindre bloc reçu : l'attente devient visible.
  // Appelé AVANT le retour anticipé des tours utilisateur (règle des hooks).
  // T-027 — sauf sur une bulle qui POURSUIT un tour déjà vivant : elle attend
  // le prochain outil, pas le premier octet, et le fournisseur a déjà répondu.
  const attenteFournisseur = useAttenteFournisseur(
    enAttenteDuPremierOctet({ ...turn, vide: (turn.blocks ?? []).length === 0 }),
  );
  if (turn.role === "user") {
    // Le texte AFFICHÉ n'est jamais le bloc de connaissances injecté — voir
    // le commentaire de `AgentTurn.displayContent`.
    const shown = turn.displayContent ?? turn.content;
    const count = turn.injectedKnowledgeCount ?? 0;
    return (
      <div className={`chat-bubble chat-bubble--user${turn.injected ? " chat-bubble--injected" : ""}`}>
        {/* S3 — demande glissée dans un tour déjà en cours : dite comme telle,
            sinon on croirait à un tour normal (l'agent n'a pas « redémarré »). */}
        {turn.injected && <div className="chat-bubble__note">en cours de tour</div>}
        <div className="chat-bubble__content">{shown}</div>
        {turn.attachments && turn.attachments.length > 0 && <SentAttachments items={turn.attachments} />}
        {count > 0 && (
          <div className="chat-bubble__knowledge-pill">
            📎 {count} connaissance{count > 1 ? "s" : ""} injectée{count > 1 ? "s" : ""}
          </div>
        )}
      </div>
    );
  }

  const rawBlocks = turn.blocks ?? [];
  // Pendant le streaming, seul le DERNIER bloc texte peut porter une fence de
  // code encore ouverte (les blocs précédents sont figés) : on la referme pour
  // le rendu — voir closeDanglingFence (Markdown.tsx), stabilité du parse.
  const blocks =
    turn.status === "streaming"
      ? rawBlocks.map((b, i) =>
          i === rawBlocks.length - 1 && b.type === "text" ? { ...b, content: closeDanglingFence(b.content) } : b,
        )
      : rawBlocks;
  return (
    <div className="chat-bubble chat-bubble--assistant">
      <div className="chat-bubble__content">
        {blocks.map((block) => (
          <AgentBlockView key={block.id} block={block} onFileRef={onFileRef} />
        ))}
        {turn.status === "streaming" && <span className="cursor" />}
        {attenteFournisseur && <div className="chat-bubble__note">{MESSAGE_ATTENTE_FOURNISSEUR}</div>}
        {/* Tâches de fond lancées par le modèle : visibles pendant qu'elles
            tournent (l'utilisateur sait que ça travaille), signalées si le
            tour se clôt alors qu'il en restait (interrompues avant terme). */}
        {turn.backgroundTasks && turn.backgroundTasks.count > 0 && (
          <div className="chat-bubble__note">
            {turn.status === "streaming"
              ? turn.backgroundTasks.waiting
                ? `Tour terminé — en attente des rapports de ${turn.backgroundTasks.count} tâche(s) de fond…`
                : `${turn.backgroundTasks.count} tâche(s) de fond en cours`
              : `Tâche(s) de fond interrompue(s) avant leur terme (${turn.backgroundTasks.count}).`}
            {turn.status === "streaming" && turn.backgroundTasks.descriptions.length > 0 && (
              <> : {turn.backgroundTasks.descriptions.join(" · ")}</>
            )}
            {/* Rendre la main : clôt le tour sans attendre les rapports (les
                tâches de fond sont abandonnées — plafond auto par ailleurs,
                voir BACKGROUND_WAIT_TIMEOUT_MS côté sidecar). */}
            {turn.status === "streaming" && turn.backgroundTasks.waiting && onReleaseBackground && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={onReleaseBackground}
                title="Clore le tour sans attendre les rapports des tâches de fond (elles seront abandonnées)"
              >
                Rendre la main
              </button>
            )}
          </div>
        )}
        {/* Fin anormale (limite d'abonnement, max d'étapes…) : message explicite
            plutôt qu'un `subtype` anglais noyé dans la ligne de tokens. */}
        {turn.status === "done" && turn.doneInfo && turnSubtypeNotice(turn.doneInfo.subtype) && (
          <div className="chat-bubble__note chat-bubble__note--strong">
            {turnSubtypeNotice(turn.doneInfo.subtype)}
          </div>
        )}
        {/* Compaction de contexte : confirmation explicite — c'est tout le
            « résultat » d'un /compact, qui ne produit aucun texte par ailleurs. */}
        {turn.compacted && (
          <div className="chat-bubble__note">
            {turn.status === "streaming" ? "Compactage du contexte…" : "Contexte compacté"}
            {turn.compacted.preTokens !== null && ` (${Math.round(turn.compacted.preTokens / 1000)} k tokens avant)`}
            {turn.status !== "streaming" && " — la session continue sur l'historique résumé."}
          </div>
        )}
        {/* Tour clos sans le moindre contenu : on le DIT, au lieu de laisser une
            bulle vide qui donne l'impression que l'application est bloquée. */}
        {turn.status === "done" && !hasVisibleContent(blocks) && !turn.compacted && !turn.continued && (
          <div className="chat-bubble__note">
            L'agent a terminé sans produire de réponse (résultat vide du moteur). Renvoyez votre message ;
            si cela se reproduit, ouvrez une « Nouvelle session ».
          </div>
        )}
      </div>
      {turn.status === "error" && <div className="chat-bubble__error">Erreur : {turn.errorMessage}</div>}
      {turn.status === "done" && turn.doneInfo && <AgentTurnMeta info={turn.doneInfo} />}
      {/* R2 — badge des tours envoyés en « Auto » : tier → modèle, raisons en
          infobulle (même patron visuel que ChatPage). */}
      {turn.routeTier && turn.routeModel && (
        <div className="chat-bubble__route" title={(turn.routeReasons ?? []).join(" · ")}>
          ⚡ auto : descendant → {turn.routeModel}
        </div>
      )}
      {/* Lecture à voix haute des réponses terminées et non vides — même
          bouton que dans le chat (voir VoiceControls.tsx). Placé en pied de
          tour, sous la ligne de tokens : c'est l'équivalent naturel du bas de
          bulle du chat, et il ne s'intercale pas entre les blocs d'un tour
          agentique (texte, raisonnement, outils) qui, eux, se lisent dans
          l'ordre. Seul le texte est lu (voir `spokenTextOfTurn`). */}
      {turn.status === "done" && spokenTextOfTurn(turn) && <TtsButton text={spokenTextOfTurn(turn)} />}
    </div>
  );
});
