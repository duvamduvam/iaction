/*
 * Page « Projets » : conversation agentique Claude (Agent SDK) dans le
 * répertoire d'un projet déclaré (registre géré dans la page
 * Configuration, voir projectAdmin.ts/useProjects.ts), avec validation des
 * actions (Edit/Write/Bash…) avant application. Réutilise les patterns de
 * streaming/style de ChatPage.tsx (bulles néon, curseur clignotant,
 * auto-scroll) et les tokens de theme.css.
 *
 * Modèle de données : un tour utilisateur est un simple message ; un tour
 * assistant est une séquence ordonnée de blocs (texte / raisonnement / appel
 * d'outil), car le SDK peut entrelacer texte, réflexion et outils au sein
 * d'un même tour — l'ordre d'arrivée des chunks doit être préservé à
 * l'affichage.
 *
 * État par projet : la conversation (turns), le sessionId SDK, les fichiers
 * ouverts/onglets — tout est gardé dans une Map en mémoire (project id →
 * état). Changer de projet bascule vers son état mémorisé (ou un état
 * vierge) ; interdit pendant un run en cours (sélecteur désactivé).
 * L'arborescence (FileTree) suit simplement `cwd`, dérivé du projet
 * sélectionné — pas besoin de la garder dans la Map, FileTree se recharge
 * déjà tout seul sur `rootPath`.
 *
 * Persistance (Lot 3) : la Map ci-dessus est mise en miroir sur disque, clé
 * `project-conversations` (voir stateClient.ts), au format
 * `{[projectId]: {turns, sessionId, openFilePaths, activeTab, updatedAt}}` —
 * seuls les CHEMINS des fichiers ouverts sont persistés, jamais leur
 * contenu ; à la restauration ils sont rechargés paresseusement (au moment
 * où leur onglet devient actif, pas tous d'un coup — voir
 * `pendingLazyLoadsRef`/`triggerLazyLoad`). Chargement au montage une seule
 * fois (StrictMode-safe, même famille de pattern que useProviders/
 * useProjects) ; sauvegarde débouncée (~1,5 s) après chaque changement
 * pertinent, plus une sauvegarde immédiate en fin de tour. Bornes : 200
 * derniers tours par projet ; un tour encore `streaming` n'est jamais
 * sérialisé tel quel (filtré par `buildPersistedEntry`) ; l'entrée d'un
 * projet supprimé du registre est nettoyée au chargement.
 *
 * Sélection externe (palette Ctrl+Maj+P, voir CommandPalette.tsx/App.tsx) :
 * cette page garde la pleine propriété de `selectedProjectId` (pas de
 * lifting dans App — voir le commentaire d'architecture en tête de
 * CommandPalette.tsx) et expose seulement `requestSelectProject` via un
 * `ref` impératif (`AgentPageHandle`).
 *
 * Panneau latéral « zen » : toute la configuration (projet/LLM/fichiers/
 * connaissances/MCP) vit dans un panneau gauche à sections dépliantes (voir
 * SidebarSection.tsx), la zone principale ne gardant que les onglets
 * Conversation/fichiers. Deux fonctionnalités v1 y vivent :
 *  - Connaissances : documents épinglés par projet (persistés comme la
 *    conversation, clé `project-knowledge`), REJOINTS par les fichiers du
 *    dossier `.iaction/connaissances/` du projet (« Automatiques », listés à
 *    chaque changement de projet, best effort — dossier absent = liste vide)
 *    — les deux origines sont injectées en préambule du texte réellement
 *    ENVOYÉ au premier tour d'une session seulement (dédoublonnées par
 *    chemin, voir `injectedKnowledge`/`dedupDocsByPath`) — le texte AFFICHÉ
 *    dans la transcription reste le texte original de l'utilisateur (voir
 *    `AgentTurn.displayContent` vs `content`, et `buildKnowledgeBlock`). Un
 *    troisième groupe « Détectées » (CLAUDE.md, `.claude/memory/*.md`) est
 *    purement informatif dans le panneau — jamais injecté d'office.
 *  - MCP : lecture seule de `.mcp.json` à la racine du projet, plus un
 *    compteur d'appels par serveur déduit des chunks `tool_use` dont le nom
 *    commence par `mcp__` (remis à zéro à la nouvelle session).
 *
 * Sélecteur d'agent (étude docs/etude-orchestration.md, phase O2) : dans la
 * section « LLM », choisir un agent déclaré (`agents.list`, voir
 * orchestrationClient.ts) préconfigure moteur/modèle/mode de permission et
 * arme ses instructions (systemPrompt Claude, ou message `system` en tête
 * côté moteur neutre) + `maxTurns` pour les tours suivants — champs
 * appliqués verrouillés tant que l'agent reste sélectionné. La sélection
 * (nom+portée seulement, pas la configuration recopiée) est PAR SESSION,
 * persistée comme `engine` (voir `ProjectSession.selectedAgent`) ; elle se
 * résout dynamiquement contre la liste vivante d'agents (`projectAgents`) —
 * un agent introuvable (supprimé, ou liste pas encore chargée) retombe sur
 * « Aucun (manuel) » silencieusement, jamais une erreur bloquante. Portée
 * knowledge/tools/mcp de l'agent : hors périmètre O2, non exploitée ici.
 */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { readApps, type AppEntry } from "./appsAdmin";
import {
  AttachmentPickerButton,
  AttachmentTray,
  clipboardHasImage,
  filesFromClipboard,
  filesFromDrop,
  SentAttachments,
  toAttachmentRefs,
  toContractAttachments,
  toSentAttachments,
  useAttachmentDraft,
  type SentAttachment,
} from "./Attachments";
import { FileEditorView, type OpenFileState } from "./FileEditor";
import { FileTree } from "./FileTree";
import { readClipboardImage } from "./clipboardClient";
import { fsFindByName, fsListDir, fsReadFile, fsWriteFile, type DirEntry } from "./fsClient";
import { Markdown } from "./Markdown";
import { readFeatured, splitFeatured } from "./modelCatalog";
import { agentsList, type AgentInfo, type AgentScope } from "./orchestrationClient";
import { OllamaPanel } from "./OllamaPanel";
import {
  readProjectKnowledgeMode,
  writeProjectKnowledgeMode,
  type KnowledgeMode,
  type ProjectConfig,
} from "./projectAdmin";
import type { ProviderConfig } from "./providerAdmin";
import {
  claudeAbort,
  claudeRelease,
  claudeCommands,
  claudeSessionTitles,
  claudePermission,
  claudeStart,
  isRouteTier,
  knowledgeIndex,
  knowledgeStatus,
  modelsList,
  neutralAbort,
  neutralPermission,
  neutralStart,
  parseClaudeDone,
  parseNeutralDone,
  routerRoute,
  toRouteTarget,
  type ChatAttachment,
  type ChatMessage,
  type ClaudeUsage,
  type KnowledgeIndexProgress,
  type KnowledgeStatus,
  type ModelInfo,
  type PermissionMode,
  type RequestMeta,
  type RouteDebord,
  type RouteTarget,
  type RouteTier,
  type SlashCommandInfo,
} from "./sidecar";
import { mergeRoutingTable, readRoutingDebord, readRoutingTable, ROUTE_TIERS } from "./routerAdmin";
import { capSessions, deriveTitleFromText, formatRelativeDate, newSessionMeta, sortByRecent } from "./sessionStore";
import { SidebarSection } from "./SidebarSection";
import { useRovingFocus } from "./useRovingFocus";
import { TtsButton, VoiceButtons, VoiceStatus } from "./VoiceControls";
import {
  DEFAULT_CONVERSATION_SETTINGS,
  useVoiceComposer,
  type ConversationSettings,
} from "./useVoiceComposer";
import { stateRead, stateWrite } from "./stateClient";
import { recordModelUsage } from "./fableUsage";
import { subscribeProvidersPushed } from "./providersBus";
import { publishContext, registerCompactHandler } from "./contextBus";
import { notifyUsageChanged } from "./usageBus";
import type { ProjectsLoadState } from "./useProjects";

const MAX_OPEN_FILES = 6;

/* ---------- Modèle de conversation ---------- */

type AgentBlock =
  | { type: "text"; id: string; content: string }
  | { type: "thinking"; id: string; content: string }
  | {
      type: "tool";
      id: string;
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
      result?: { isError: boolean; summary: string };
    };

type TurnStatus = "streaming" | "done" | "error";

interface AgentTurn {
  id: string;
  role: "user" | "assistant";
  /**
   * Tour utilisateur : texte réellement ENVOYÉ au moteur (peut être préfixé
   * du bloc « connaissances » au premier tour d'une session, voir
   * `buildKnowledgeBlock`) — c'est cette valeur qui alimente l'historique
   * renvoyé au moteur neutre (`buildNeutralMessages`) et qui reste donc du
   * contexte pour les tours suivants. `displayContent`, s'il diffère, est le
   * texte à AFFICHER (texte original tapé par l'utilisateur).
   */
  content?: string;
  displayContent?: string;
  /** Nombre de documents de connaissances injectés dans ce tour (0/absent = aucun). */
  injectedKnowledgeCount?: number;
  blocks?: AgentBlock[];
  status: TurnStatus;
  errorMessage?: string;
  doneInfo?: { subtype: string; usage: ClaudeUsage | null; contextTokens?: number | null; totalCostUsd: number | null };
  /**
   * Tâches de fond lancées par le modèle pendant ce tour (sous-agents en
   * arrière-plan…). `waiting` passe à true quand le tour du modèle est fini
   * mais que le sidecar garde le process ouvert en attendant leurs rapports
   * (chunk `background_wait`) ; la liste vide efface l'encart (tout est fini).
   */
  backgroundTasks?: { count: number; descriptions: string[]; waiting: boolean };
  /**
   * Pièces jointes du tour utilisateur (voir Attachments.tsx). Uniquement
   * porté par le moteur Claude (voir le contrat, docs/protocol.md — ni
   * `neutral.start`) : le composeur désactive l'ajout de pièces tant que le
   * moteur neutre est actif pour la session. `previewUrl` absent après un
   * rechargement (octets jamais persistés, voir `toAttachmentRefs`).
   */
  attachments?: SentAttachment[];
  /** R2 — tier du routeur quand ce tour a été envoyé en « Auto » (badge ⚡, patron ChatPage). */
  routeTier?: RouteTier;
  /** R2 — modèle cible du routage (badge) et raisons du classement (infobulle). */
  routeModel?: string;
  routeReasons?: string[];
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

// Helpers purs (hors composant), même esprit que withAppendedDelta dans ChatPage.tsx.
function appendToLastBlock(blocks: AgentBlock[], type: "text" | "thinking", delta: string): AgentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) {
    const updated = { ...last, content: last.content + delta };
    return [...blocks.slice(0, -1), updated];
  }
  return [...blocks, { type, id: nextId("blk"), content: delta } as AgentBlock];
}

function addToolBlock(blocks: AgentBlock[], toolUseId: string, toolName: string, toolInput: unknown): AgentBlock[] {
  return [...blocks, { type: "tool", id: nextId("blk"), toolUseId, toolName, toolInput }];
}

function setToolResult(blocks: AgentBlock[], toolUseId: string, isError: boolean, summary: string): AgentBlock[] {
  return blocks.map((b) => (b.type === "tool" && b.toolUseId === toolUseId ? { ...b, result: { isError, summary } } : b));
}

/**
 * Taille du contexte de la conversation, en tokens, d'après le DERNIER tour
 * ayant remonté l'info.
 *
 * On privilégie `doneInfo.contextTokens` : l'occupation de la fenêtre au dernier
 * appel API, mesurée côté sidecar (voir `extractContextTokens`). C'est la SEULE
 * valeur fiable — l'`usage` du `result` CUMULE tous les appels d'un tour
 * agentique (son cache_read additionne N fois le préfixe) et peut dépasser
 * plusieurs fois la fenêtre du modèle (« contexte » à 400 %+).
 *
 * Repli sur l'ancien calcul (cacheRead + in + out de l'usage) seulement pour les
 * tours d'AVANT ce champ (persistés) ou le moteur neutre — imparfait, mais mieux
 * que rien tant qu'un nouveau tour n'a pas rafraîchi la valeur.
 */
function contextTokens(turns: AgentTurn[]): number | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const done = turns[i].doneInfo;
    if (!done) continue;
    if (typeof done.contextTokens === "number") return done.contextTokens;
    if (done.usage) {
      return (done.usage.cacheReadInputTokens ?? 0) + done.usage.inputTokens + done.usage.outputTokens;
    }
  }
  return null;
}

function withBlocks(turns: AgentTurn[], id: string, updater: (blocks: AgentBlock[]) => AgentBlock[]): AgentTurn[] {
  return turns.map((t) => (t.id === id ? { ...t, blocks: updater(t.blocks ?? []) } : t));
}

/** Forme commune aux `done` de `claude.start`/`neutral.start` (voir `parseClaudeDone`/`parseNeutralDone`). */
interface TurnDoneInfo {
  subtype: string;
  usage: ClaudeUsage | null;
  /** Occupation de la fenêtre de contexte (dernier appel) — voir `contextTokens`. Absent côté neutre. */
  contextTokens?: number | null;
  totalCostUsd: number | null;
  /** Texte final du SDK (`result`). Parfois seul porteur de la réponse : voir `withTurnDone`. */
  result?: string;
}

/** Vrai si le tour a produit du contenu visible (texte ou outil). */
function hasVisibleContent(blocks: AgentBlock[]): boolean {
  return blocks.some((b) => (b.type === "text" ? b.content.trim().length > 0 : true));
}

/**
 * Texte d'un tour assistant destiné à être LU à voix haute : uniquement les
 * blocs `text`, jamais le raisonnement ni les appels d'outils (lire « Bash :
 * npm run build » n'a aucun intérêt et noierait la réponse). Chaîne vide s'il
 * n'y a rien à lire.
 */
function spokenTextOfTurn(turn: AgentTurn): string {
  return (turn.blocks ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.content)
    .join("\n\n")
    .trim();
}

/**
 * Message clair pour un tour qui ne s'est pas terminé normalement. Le SDK
 * renvoie un `subtype` technique en anglais, jusqu'ici affiché en tout petit
 * dans la ligne de tokens — invisible en pratique (cas typique : limite
 * d'abonnement atteinte).
 */
function turnSubtypeNotice(subtype: string): string | null {
  if (subtype === "success") return null;
  const s = subtype.toLowerCase();
  if (s.includes("max_turns")) {
    return "Tour interrompu : l'agent a atteint son nombre maximum d'étapes. Relancez en précisant la suite à faire.";
  }
  if (s.includes("limit") || s.includes("quota") || s.includes("rate")) {
    return "Limite d'abonnement atteinte : le tour n'a pas pu aboutir. Consultez la jauge de session en en-tête pour le temps restant avant réinitialisation.";
  }
  if (s.includes("abort") || s.includes("interrupt")) {
    return "Tour interrompu avant la fin.";
  }
  if (s.includes("error")) {
    return `Le tour s'est terminé anormalement (${subtype}).`;
  }
  return null;
}

function withTurnDone(turns: AgentTurn[], id: string, info: TurnDoneInfo): AgentTurn[] {
  return turns.map((t) => {
    if (t.id !== id) return t;
    // Le SDK peut clore un tour en ne renvoyant la réponse que dans `result`,
    // sans jamais streamer de bloc `text` : sans ce repli, la bulle restait
    // vide (ou s'arrêtait sur un appel d'outil) alors que la réponse existait.
    // Critère : aucun bloc TEXTE — des tool_use seuls ne comptent pas, un tour
    // « outils puis résultat non streamé » doit aussi récupérer son texte. Pas
    // de risque de doublon : dès qu'un texte a été streamé, un bloc text existe.
    const current = t.blocks ?? [];
    const hasTextBlock = current.some((b) => b.type === "text" && b.content.trim().length > 0);
    const blocks =
      !hasTextBlock && info.result && info.result.trim()
        ? [...current, { type: "text" as const, id: nextId("blk"), content: info.result }]
        : current;
    return {
      ...t,
      blocks,
      status: "done",
      doneInfo: { subtype: info.subtype, usage: info.usage, contextTokens: info.contextTokens, totalCostUsd: info.totalCostUsd },
    };
  });
}

function withTurnError(turns: AgentTurn[], id: string, errorMessage: string): AgentTurn[] {
  return turns.map((t) => (t.id === id ? { ...t, status: "error", errorMessage } : t));
}

/* ---------- Aperçus / rendu JSON ---------- */

function prettyJson(value: unknown, maxLen = 800): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n…` : text;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

// Noms d'outils Claude (Agent SDK) et neutre (palette maison, voir
// docs/protocol.md Lot 6) désignent la même action avec des champs
// identiques (`file_path`/`old_string`/`new_string`/`content`/`command`) —
// on reconnaît les deux conventions partout où un aperçu/titre est dérivé.
function toolPreview(toolName: string, toolInput: unknown): string {
  const input = asRecord(toolInput);
  if ((toolName === "Edit" || toolName === "Write" || toolName === "edit_file" || toolName === "write_file") && typeof input.file_path === "string") {
    return input.file_path;
  }
  if ((toolName === "Bash" || toolName === "bash") && typeof input.command === "string") {
    return input.command;
  }
  return prettyJson(toolInput, 160);
}

/* ---------- Blocs d'un tour assistant ---------- */

function DiffLines({ text, prefix, variant }: Readonly<{ text: string; prefix: string; variant: "removed" | "added" }>) {
  return (
    <pre className={`diff-block diff-block--${variant}`}>
      {text.split("\n").map((line, i) => (
        // Bloc figé au rendu (pas de ré-ordonnancement) : l'index suffit comme clé.
        // eslint-disable-next-line react/no-array-index-key
        <div className="diff-line" key={i}>
          {prefix}
          {line}
        </div>
      ))}
    </pre>
  );
}

function EditDiff({ oldString, newString }: Readonly<{ oldString: string; newString: string }>) {
  return (
    <div className="diff-view">
      <DiffLines text={oldString} prefix="− " variant="removed" />
      <DiffLines text={newString} prefix="+ " variant="added" />
    </div>
  );
}

function ThinkingBlockView({ content }: Readonly<{ content: string }>) {
  return (
    <details className="thinking-block">
      <summary>Raisonnement…</summary>
      <div className="thinking-block__content">{content}</div>
    </details>
  );
}

/** `toolName` = "mcp__<serveur>__<outil>" pour un outil MCP (voir docs/protocol.md) — `null` sinon. */
function mcpServerFromToolName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const server = toolName.split("__")[1];
  return server || null;
}

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
const AgentTurnView = memo(function AgentTurnView({
  turn,
  onFileRef,
  onReleaseBackground,
}: Readonly<{
  turn: AgentTurn;
  onFileRef: (ref: string) => void;
  /** Rendre la main pendant l'attente des rapports de tâches de fond (claude.release). */
  onReleaseBackground?: () => void;
}>) {
  if (turn.role === "user") {
    // Le texte AFFICHÉ n'est jamais le bloc de connaissances injecté — voir
    // le commentaire de `AgentTurn.displayContent`.
    const shown = turn.displayContent ?? turn.content;
    const count = turn.injectedKnowledgeCount ?? 0;
    return (
      <div className="chat-bubble chat-bubble--user">
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

  const blocks = turn.blocks ?? [];
  return (
    <div className="chat-bubble chat-bubble--assistant">
      <div className="chat-bubble__content">
        {blocks.map((block) => (
          <AgentBlockView key={block.id} block={block} onFileRef={onFileRef} />
        ))}
        {turn.status === "streaming" && <span className="cursor" />}
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
        {/* Tour clos sans le moindre contenu : on le DIT, au lieu de laisser une
            bulle vide qui donne l'impression que l'application est bloquée. */}
        {turn.status === "done" && !hasVisibleContent(blocks) && (
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

/* ---------- Modale de permission ---------- */

interface PermissionRequestItem {
  targetId: string;
  permissionId: string;
  toolName: string;
  toolInput: unknown;
  /** Moteur d'origine du tour : détermine claudePermission vs neutralPermission à la réponse. */
  engine: "claude" | "neutral";
}

function permissionTitle(item: PermissionRequestItem): string {
  const input = asRecord(item.toolInput);
  if ((item.toolName === "Edit" || item.toolName === "edit_file") && typeof input.file_path === "string") {
    return `Modifier ${input.file_path}`;
  }
  if ((item.toolName === "Write" || item.toolName === "write_file") && typeof input.file_path === "string") {
    return `Créer/écraser ${input.file_path}`;
  }
  if (item.toolName === "Bash" || item.toolName === "bash") return "Exécuter une commande";
  if (item.toolName === "AskUserQuestion") return "Question de l'agent";
  return `Autoriser ${item.toolName} ?`;
}

/* ---------- AskUserQuestion : rendu lisible (au lieu du JSON brut) ---------- */

interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

/** Parseur défensif : toute forme inattendue est ignorée plutôt que de casser la modale. */
function parseAskQuestions(toolInput: unknown): AskQuestion[] {
  const input = asRecord(toolInput);
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const questions: AskQuestion[] = [];
  for (const entry of raw) {
    const q = asRecord(entry);
    if (typeof q.question !== "string" || !q.question) continue;
    const options: AskOption[] = [];
    for (const optEntry of Array.isArray(q.options) ? q.options : []) {
      const o = asRecord(optEntry);
      if (typeof o.label !== "string" || !o.label) continue;
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : "",
        ...(typeof o.preview === "string" && o.preview ? { preview: o.preview } : {}),
      });
    }
    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return questions;
}

/** Séparateur des choix au sein d'UNE question à choix multiple. */
const ANSWER_SEPARATOR = " ; ";

/** Réponses de l'utilisateur, une entrée par question (clé = texte de la
 *  question) — indispensable avec plusieurs questions : chacune garde son
 *  propre choix, sélectionner dans l'une ne touche plus aux autres. */
type AskAnswers = Record<string, string>;

/** Un choix est « sélectionné » s'il figure dans la réponse de SA question. */
function isPicked(answerForQuestion: string | undefined, label: string, multiSelect: boolean): boolean {
  if (!answerForQuestion) return false;
  return multiSelect ? answerForQuestion.split(ANSWER_SEPARATOR).includes(label) : answerForQuestion === label;
}

/**
 * Message communiqué à l'agent, composé des réponses de chaque question. Une
 * seule question : la réponse brute (comportement historique). Plusieurs :
 * chaque réponse est préfixée du `header` (ou, à défaut, de la question) pour
 * que l'agent sache à quoi elle se rapporte.
 */
function composeAskMessage(questions: AskQuestion[], answers: AskAnswers): string {
  const answered = questions
    .map((q) => ({ q, a: answers[q.question] }))
    .filter((x): x is { q: AskQuestion; a: string } => Boolean(x.a));
  if (answered.length === 0) return "";
  if (questions.length === 1) return answered[0].a;
  return answered.map(({ q, a }) => `${q.header || q.question} : ${a}`).join("\n");
}

function AskUserQuestionBody({
  questions,
  answers,
  onPickAnswer,
}: Readonly<{
  questions: AskQuestion[];
  answers: AskAnswers;
  onPickAnswer: (question: string, label: string, multiSelect: boolean) => void;
}>) {
  return (
    <div className="ask-question">
      {questions.map((q) => (
        <div key={q.question} className="ask-question__block">
          <div className="ask-question__head">
            {q.header && <span className="ask-question__chip">{q.header}</span>}
            {q.multiSelect && <span className="ask-question__multi">plusieurs choix possibles</span>}
          </div>
          <p className="ask-question__text">{q.question}</p>
          <ul className="ask-question__options">
            {q.options.map((o) => {
              const picked = isPicked(answers[q.question], o.label, q.multiSelect);
              return (
                <li key={o.label}>
                  <button
                    type="button"
                    className={`ask-question__option${picked ? " ask-question__option--picked" : ""}`}
                    aria-pressed={picked}
                    onClick={() => onPickAnswer(q.question, o.label, q.multiSelect)}
                    title={picked ? "Réponse sélectionnée" : "Utiliser cette réponse"}
                  >
                    <span className="ask-question__label">
                      <span className="ask-question__check" aria-hidden="true">
                        {picked ? "✓" : ""}
                      </span>
                      {o.label}
                    </span>
                    {o.description && <span className="ask-question__desc">{o.description}</span>}
                    {o.preview && <pre className="ask-question__preview">{o.preview}</pre>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PermissionBody({
  item,
  answers,
  onPickAnswer,
}: Readonly<{
  item: PermissionRequestItem;
  answers: AskAnswers;
  onPickAnswer: (question: string, label: string, multiSelect: boolean) => void;
}>) {
  const input = asRecord(item.toolInput);

  if (item.toolName === "AskUserQuestion") {
    const questions = parseAskQuestions(item.toolInput);
    // Forme inattendue : on retombe sur le JSON plutôt que d'afficher un vide.
    if (questions.length > 0) {
      return <AskUserQuestionBody questions={questions} answers={answers} onPickAnswer={onPickAnswer} />;
    }
  }
  if (item.toolName === "Edit" || item.toolName === "edit_file") {
    return <EditDiff oldString={String(input.old_string ?? "")} newString={String(input.new_string ?? "")} />;
  }
  if (item.toolName === "Write" || item.toolName === "write_file") {
    return <DiffLines text={String(input.content ?? "")} prefix="+ " variant="added" />;
  }
  if (item.toolName === "Bash" || item.toolName === "bash") {
    return (
      <div className="bash-block">
        {typeof input.description === "string" && input.description && (
          <p className="bash-block__desc">{input.description}</p>
        )}
        <pre className="bash-block__command">{String(input.command ?? "")}</pre>
      </div>
    );
  }
  return <pre className="pretty-json">{prettyJson(item.toolInput)}</pre>;
}

function PermissionModal({
  item,
  extraCount,
  onDecide,
}: Readonly<{
  item: PermissionRequestItem;
  extraCount: number;
  onDecide: (decision: "allow" | "deny", message: string, rememberTool: boolean) => void;
}>) {
  const [reason, setReason] = useState("");
  const [answers, setAnswers] = useState<AskAnswers>({});
  const [note, setNote] = useState("");
  const [rememberTool, setRememberTool] = useState(false);
  const isAskQuestion = item.toolName === "AskUserQuestion";
  const askQuestions = isAskQuestion ? parseAskQuestions(item.toolInput) : [];

  // Nouvelle demande affichée : on repart d'un état vierge.
  useEffect(() => {
    setReason("");
    setAnswers({});
    setNote("");
    setRememberTool(false);
  }, [item.permissionId]);

  /** Choix cliqué : remplace la réponse de SA question (choix unique) ou l'y bascule (choix multiple). */
  function handlePickAnswer(question: string, label: string, multiSelect: boolean) {
    setAnswers((prev) => {
      const current = prev[question];
      if (!multiSelect) {
        // Re-cliquer le choix retenu le désélectionne.
        if (current === label) {
          const { [question]: _removed, ...rest } = prev;
          return rest;
        }
        return { ...prev, [question]: label };
      }
      const parts = current ? current.split(ANSWER_SEPARATOR).filter(Boolean) : [];
      const index = parts.indexOf(label);
      if (index >= 0) parts.splice(index, 1);
      else parts.push(label);
      if (parts.length === 0) {
        const { [question]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [question]: parts.join(ANSWER_SEPARATOR) };
    });
  }

  // Message final : réponses composées (une par question) + complément libre
  // éventuel. Hors question (demande de permission), c'est la raison du refus.
  const composed = composeAskMessage(askQuestions, answers);
  const askMessage = [composed, note.trim()].filter(Boolean).join("\n");
  const decisionMessage = isAskQuestion ? askMessage : reason;
  // Toutes les questions ont-elles reçu une réponse ? (garde-fou avant envoi.)
  const allAnswered = askQuestions.every((q) => Boolean(answers[q.question]));

  return (
    <div className="permission-overlay">
      <div className="permission-modal">
        <div className="permission-modal__head">
          <h3>{permissionTitle(item)}</h3>
          {extraCount > 0 && <span className="permission-modal__badge">+{extraCount} en attente</span>}
        </div>
        <div className="permission-modal__body">
          <PermissionBody item={item} answers={answers} onPickAnswer={handlePickAnswer} />
        </div>
        {isAskQuestion ? (
          <div className="field">
            <label htmlFor="permission-note">Complément libre (optionnel)</label>
            <input
              id="permission-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              placeholder="Précision à ajouter à vos choix ci-dessus…"
            />
            {askQuestions.length > 1 && !allAnswered && (
              <p className="field__hint">Répondez à chaque question ci-dessus avant d'envoyer.</p>
            )}
          </div>
        ) : (
          <div className="field">
            <label htmlFor="permission-reason">Raison du refus (optionnel)</label>
            <input
              id="permission-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              placeholder="Motif communiqué à l'agent…"
            />
          </div>
        )}
        {/* « Ne plus demander » n'a pas de sens pour une question posée à
            l'utilisateur : on la masque dans ce cas. */}
        {!isAskQuestion && (
          <label
            className="permission-modal__remember"
            title="Les prochaines demandes de cet outil seront autorisées automatiquement, jusqu'à la fermeture de l'application."
          >
            <input
              type="checkbox"
              checked={rememberTool}
              onChange={(e) => setRememberTool(e.currentTarget.checked)}
            />
            Ne plus demander pour « {item.toolName} » (session en cours)
          </label>
        )}
        <div className="permission-modal__actions">
          <button type="button" className="btn btn--deny" onClick={() => onDecide("deny", decisionMessage, false)}>
            {isAskQuestion ? "Ignorer la question" : "Refuser"}
          </button>
          <button
            type="button"
            className="btn btn--allow"
            // Question à réponses multiples : on n'envoie pas tant qu'une
            // question reste sans réponse (l'agent recevrait une réponse
            // partielle sans savoir laquelle manque).
            disabled={isAskQuestion && askQuestions.length > 1 && !allAnswered}
            onClick={() => onDecide("allow", decisionMessage, rememberTool)}
          >
            {isAskQuestion ? "Répondre" : "Autoriser"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- En-tête de page ---------- */

/*
 * R2/R7 — « Auto (routeur) » : valeur sentinelle du sélecteur de modèle,
 * OPT-IN (jamais défaut, contrairement au Chat). CHAQUE tour est classé par
 * le routeur du sidecar (router.route, avec le `cwd` du projet — la
 * surcharge `.iaction/routage.yaml` s'applique), sous un PLANCHER de session
 * (`routedTier`) qui ne descend jamais — le modèle ne change qu'à la hausse
 * (voir resolveAutoRoute) — un modèle explicite choisi = comportement
 * strictement inchangé.
 */
const AUTO_MODEL = "__auto__";

const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "(défaut)" },
  { value: "claude-fable-5", label: "claude-fable-5" },
  { value: "claude-sonnet-5", label: "claude-sonnet-5" },
  { value: "claude-opus-4-8", label: "claude-opus-4-8" },
  { value: "claude-haiku-4-5", label: "claude-haiku-4-5" },
];

const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Valider chaque action" },
  { value: "acceptEdits", label: "Éditions auto-acceptées" },
  { value: "plan", label: "Plan (lecture seule)" },
  { value: "bypassPermissions", label: "⚠ Autonome (aucune validation)" },
];

/* ---------- État par projet (Lot Sessions : plusieurs sessions/projet) ---------- */

/** Moteur + modèle choisis pour cette session. `providerId: null` = Claude (abonnement). */
interface EngineConfig {
  providerId: string | null;
  model: string;
}

function claudeEngine(): EngineConfig {
  return { providerId: null, model: "" };
}

/** Référence (nom + portée) vers un agent déclaré — voir orchestrationClient.ts. `null` = mode manuel. */
interface AgentSelection {
  name: string;
  scope: AgentScope;
}

/**
 * Une session de conversation dans un projet donné : c'est le grain
 * persisté/basculé par le panneau « Sessions » (voir `SidebarSection`
 * « sessions » plus bas). `titleCustom` : `true` dès que l'utilisateur a
 * renommé la session — le titre auto (voir `deriveTitleFromText`,
 * sessionStore.ts) n'est alors plus jamais recalculé.
 *
 * `turns`/`sessionId` restent ici la dernière copie CONNUE (utile tant que la
 * conversation n'a jamais été ouverte cette exécution) — dès qu'elle est
 * ouverte, c'est son `ConvRuntime` (voir plus bas) qui fait foi, y compris en
 * arrière-plan ; `buildLiveSessions` recombine les deux à chaque sauvegarde.
 */
interface ProjectSession {
  id: string;
  title: string;
  titleCustom: boolean;
  createdAt: string;
  updatedAt: string;
  turns: AgentTurn[];
  sessionId: string | null;
  engine: EngineConfig;
  /** Agent sélectionné pour cette session (sélecteur « LLM » → Agent), `null` = manuel. */
  selectedAgent: AgentSelection | null;
  /** R7 — plancher de session du mode Auto (relevé à la hausse uniquement) + dernière cible utilisée (`null` sinon). */
  routedTier: RouteTier | null;
  routedTarget: RouteTarget | null;
}

/**
 * État en mémoire d'un projet : toutes ses sessions, laquelle est « active »
 * (celle dont la config LLM s'affiche/s'édite dans le panneau « LLM »), et
 * les onglets affichés dans la barre principale. `openFiles`/`activeTab`
 * sont désormais PROJET (partagés entre toutes les conversations) — voir le
 * commentaire d'en-tête de fichier : la maquette mélange onglets de
 * conversation et onglets de fichier dans une même barre, ce qui n'aurait
 * aucun sens s'ils restaient dupliqués par session. `activeTab` vaut
 * `convTabId(id)` pour une conversation, ou un chemin de fichier.
 */
interface ProjectState {
  sessions: ProjectSession[];
  activeId: string;
  openConversationIds: string[];
  openFiles: OpenFileState[];
  activeTab: string;
}

/** Préfixe distinguant un onglet de conversation d'un chemin de fichier dans `activeTab`/`openConversationIds`. */
const CONV_TAB_PREFIX = "conv:";
function convTabId(sessionId: string): string {
  return `${CONV_TAB_PREFIX}${sessionId}`;
}
function isConvTab(tab: string): boolean {
  return tab.startsWith(CONV_TAB_PREFIX);
}
function convIdOfTab(tab: string): string {
  return tab.slice(CONV_TAB_PREFIX.length);
}
/** Onglet « vide » : dernier onglet de conversation ET dernier onglet fichier fermés (voir `closeConversationTab`). */
const EMPTY_TAB = "";

/**
 * État VIF d'une conversation ouverte en onglet. Ce qui était mono-valué
 * quand une seule conversation vivait à la fois (`turns`, `sessionId`,
 * `streaming`…) est désormais porté ici, une instance par conversation
 * ouverte : c'est ce qui permet à un onglet d'arrière-plan de continuer à
 * streamer pendant qu'on lit ou qu'on écrit dans un autre.
 *
 * `activeEngine` fige le moteur RÉELLEMENT utilisé par le tour en cours : le
 * sélecteur de moteur peut changer pendant un streaming, l'abandon
 * (`handleAbort`) doit rester routé vers le bon moteur.
 */
interface ConvRuntime {
  turns: AgentTurn[];
  /** Id de session côté serveur Claude (`null` tant qu'aucun tour n'a été envoyé). */
  sessionId: string | null;
  streaming: boolean;
  /** Id de requête protocolaire du tour en cours (permissions/abandon), `null` hors streaming. */
  activeRequestId: string | null;
  activeEngine: "claude" | "neutral";
  /** Brouillon du composeur — par conversation : on peut taper dans l'une pendant que l'autre travaille. */
  draft: string;
  /** Prompts mis en file pendant un streaming, envoyés un par un (ordre d'arrivée) à la fin de chaque tour. */
  queuedPrompts: string[];
  mcpUsage: Record<string, { calls: number; lastTool: string }>;
  /** R7 — plancher de session du mode Auto (miroir vif de `ProjectSession.routedTier`/`routedTarget`). */
  routedTier: RouteTier | null;
  routedTarget: RouteTarget | null;
  /** Raisons du classement (infobulle des tours suivants) — non persistées. */
  routedReasons: string[] | null;
  /** R3 — bandeau de débord du DERNIER tour envoyé (éphémère, jamais persisté — voir ChatPage.tsx). */
  debordNotice: DebordNotice | null;
  /**
   * « Arrêter » cliqué pendant la phase de PRÉ-ENVOI (routage Auto, lecture
   * des connaissances — avant tout claude.start/neutral.start) : le point de
   * contrôle de `handleSend` abandonne alors le tour proprement, sans envoi.
   */
  preSendAbort: boolean;
}

/** R3 — contenu du bandeau de débord (même contrat que ChatPage.tsx). */
interface DebordNotice {
  blocked: boolean;
  fiveHourPct: number | null;
  /** Modèle payant réellement utilisé quand le débord est actif. */
  model: string;
  /** Plafond configuré (affiché quand le débord est bloqué), `null` = sans plafond. */
  plafondUsdMois: number | null;
  /** Vrai = cible de débord non déclarée dans la table des fournisseurs : tour resté sur l'abonnement. */
  unconfigured?: boolean;
}

function freshRuntime(
  turns: AgentTurn[] = [],
  sessionId: string | null = null,
  routedTier: RouteTier | null = null,
  routedTarget: RouteTarget | null = null,
): ConvRuntime {
  return {
    turns,
    sessionId,
    streaming: false,
    activeRequestId: null,
    activeEngine: "claude",
    draft: "",
    queuedPrompts: [],
    mcpUsage: {},
    routedTier,
    routedTarget,
    routedReasons: null,
    debordNotice: null,
    preSendAbort: false,
  };
}

function freshSession(): ProjectSession {
  return {
    ...newSessionMeta(),
    turns: [],
    sessionId: null,
    engine: claudeEngine(),
    selectedAgent: null,
    routedTier: null,
    routedTarget: null,
  };
}

function emptyProjectState(): ProjectState {
  const session = freshSession();
  return { sessions: [session], activeId: session.id, openConversationIds: [session.id], openFiles: [], activeTab: convTabId(session.id) };
}

/* ---------- Persistance (Lot 3, étendu Lot Sessions) ---------- */

const CONVERSATIONS_STATE_KEY = "project-conversations";
/** Dernier projet ouvert : réouvert au démarrage suivant (voir l'effet de sélection initiale). */
const LAST_PROJECT_STATE_KEY = "last-project";
const MAX_PERSISTED_TURNS = 200;
const MAX_SESSIONS_PER_PROJECT = 30;
const SAVE_DEBOUNCE_MS = 1500;

/** Forme persistée d'une session — les CHEMINS des fichiers ouverts vivent désormais au niveau PROJET, voir `PersistedProjectEntry`. */
interface PersistedSession {
  id: string;
  title: string;
  titleCustom: boolean;
  createdAt: string;
  updatedAt: string;
  turns: AgentTurn[];
  sessionId: string | null;
  /** Absent (sessions antérieures au Lot 6) = Claude (abonnement), voir `sessionStateFromPersisted`. */
  engine?: EngineConfig;
  /** Absent (sessions antérieures à la phase O2) = mode manuel, voir `sessionStateFromPersisted`. */
  selectedAgent?: AgentSelection | null;
  /** R2 — absents (sessions antérieures) = aucune affinité de routage, voir `sessionStateFromPersisted`. */
  routedTier?: RouteTier | null;
  routedTarget?: RouteTarget | null;
}

/**
 * Forme persistée d'un projet (Lot Onglets multiples) : plusieurs sessions +
 * laquelle est active, plus les onglets réellement affichés — `openFilePaths`/
 * `activeTab` étaient PAR SESSION avant ce lot (voir `OldMultiSessionEntry`
 * ci-dessous, migrée transparemment par `migrateOldMultiSessionEntry`).
 */
interface PersistedProjectEntry {
  sessions: PersistedSession[];
  activeId: string;
  /** Sessions ouvertes en onglet (voir `openConversationIds` de `ProjectState`). */
  openConversationIds: string[];
  openFilePaths: string[];
  activeTab: string;
}

type PersistedConversations = Record<string, PersistedProjectEntry>;

/**
 * Ancienne forme (avant le Lot Sessions) : UNE seule conversation par projet,
 * pas de tableau `sessions` — voir `migrateLegacyProjectState`, appelée par
 * `sanitizePersistedConversations` pour migrer transparemment au chargement.
 */
interface LegacyPersistedProjectState {
  turns: AgentTurn[];
  sessionId: string | null;
  openFilePaths: string[];
  activeTab: string;
  updatedAt: string;
  engine?: EngineConfig;
}

/**
 * Forme intermédiaire (Lot Sessions, avant le Lot Onglets multiples) :
 * plusieurs sessions, mais `openFilePaths`/`activeTab` PAR SESSION plutôt que
 * par projet — voir `migrateOldMultiSessionEntry`.
 */
interface OldPersistedSession {
  id: string;
  title: string;
  titleCustom: boolean;
  createdAt: string;
  updatedAt: string;
  turns: AgentTurn[];
  sessionId: string | null;
  openFilePaths: string[];
  activeTab: string;
  engine?: EngineConfig;
  selectedAgent?: AgentSelection | null;
}

interface OldMultiSessionEntry {
  sessions: OldPersistedSession[];
  activeId: string;
}

function isEngineConfig(value: unknown): value is EngineConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (typeof v.providerId === "string" || v.providerId === null) && typeof v.model === "string";
}

function isAgentSelection(value: unknown): value is AgentSelection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    !!v.name &&
    (v.scope === "project" || v.scope === "global" || v.scope === "claude-code")
  );
}

/**
 * Valide une sélection d'agent persistée contre la liste vivante du même
 * projet (bascule ENTRE SESSIONS d'un même projet — `list` déjà à jour dans
 * ce cas, contrairement à une bascule de projet où `loadProjectAgents`
 * s'en charge de façon asynchrone). Agent introuvable → retombe sur `null`.
 */
function resolveAgentSelection(key: AgentSelection | null, list: AgentInfo[]): AgentSelection | null {
  if (!key) return null;
  return list.some((a) => a.name === key.name && a.scope === key.scope) ? key : null;
}

/** Valeur d'`<option>` encodant portée + nom (un nom peut se répéter entre portées). */
function agentOptionValue(a: { scope: AgentScope; name: string }): string {
  return `${a.scope}::${a.name}`;
}

/** Champs communs id/titre/tours/agent aux trois formes de session persistée (nouvelle et ancienne). */
function hasCommonSessionFields(v: Record<string, unknown>): boolean {
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.titleCustom === "boolean" &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string" &&
    Array.isArray(v.turns) &&
    (typeof v.sessionId === "string" || v.sessionId === null) &&
    (v.engine === undefined || isEngineConfig(v.engine)) &&
    (v.selectedAgent === undefined || v.selectedAgent === null || isAgentSelection(v.selectedAgent)) &&
    // R2 — affinité de routage : optionnelle, et RÉPARÉE en amont par
    // `withRoutingRepair` (une valeur hors vocabulaire est retirée avant
    // d'arriver ici — ces deux lignes ne restent que par défense en
    // profondeur, elles ne doivent JAMAIS invalider une session réelle).
    (v.routedTier === undefined || v.routedTier === null || isRouteTier(v.routedTier)) &&
    (v.routedTarget === undefined || v.routedTarget === null || toRouteTarget(v.routedTarget) !== null)
  );
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (typeof value !== "object" || value === null) return false;
  return hasCommonSessionFields(value as Record<string, unknown>);
}

function isOldPersistedSession(value: unknown): value is OldPersistedSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    hasCommonSessionFields(v) &&
    Array.isArray(v.openFilePaths) &&
    v.openFilePaths.every((p) => typeof p === "string") &&
    typeof v.activeTab === "string"
  );
}

/** Forme ACTUELLE (Lot Onglets multiples) : onglets au niveau projet, distingués de l'ancienne forme par leur présence. */
function isPersistedProjectEntry(value: unknown): value is PersistedProjectEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.sessions) &&
    v.sessions.length > 0 &&
    v.sessions.every(isPersistedSession) &&
    typeof v.activeId === "string" &&
    Array.isArray(v.openConversationIds) &&
    v.openConversationIds.every((id) => typeof id === "string") &&
    Array.isArray(v.openFilePaths) &&
    v.openFilePaths.every((p) => typeof p === "string") &&
    typeof v.activeTab === "string"
  );
}

/** Forme intermédiaire (Lot Sessions) : onglets encore PAR SESSION, pas de champs projet — voir `migrateOldMultiSessionEntry`. */
function isOldMultiSessionEntry(value: unknown): value is OldMultiSessionEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.sessions) && v.sessions.length > 0 && v.sessions.every(isOldPersistedSession) && typeof v.activeId === "string";
}

function isLegacyPersistedProjectState(value: unknown): value is LegacyPersistedProjectState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.turns) &&
    (typeof v.sessionId === "string" || v.sessionId === null) &&
    Array.isArray(v.openFilePaths) &&
    v.openFilePaths.every((p) => typeof p === "string") &&
    typeof v.activeTab === "string" &&
    typeof v.updatedAt === "string" &&
    (v.engine === undefined || isEngineConfig(v.engine))
  );
}

/** Titre auto d'une session depuis ses tours (premier message utilisateur, voir sessionStore.ts). */
function deriveSessionTitle(turns: AgentTurn[]): string {
  const firstUser = turns.find((t) => t.role === "user");
  return deriveTitleFromText(firstUser?.displayContent ?? firstUser?.content ?? "");
}

/** Migre une conversation « ancienne forme » (pré-Lot Sessions) en une session unique, ouverte en onglet — rien n'est perdu. */
function migrateLegacyProjectState(legacy: LegacyPersistedProjectState): PersistedProjectEntry {
  const session: PersistedSession = {
    id: crypto.randomUUID(),
    title: deriveSessionTitle(legacy.turns),
    titleCustom: false,
    createdAt: legacy.updatedAt,
    updatedAt: legacy.updatedAt,
    turns: legacy.turns,
    sessionId: legacy.sessionId,
    engine: legacy.engine,
  };
  return {
    sessions: [session],
    activeId: session.id,
    openConversationIds: [session.id],
    openFilePaths: legacy.openFilePaths,
    activeTab: legacy.activeTab === "conversation" ? convTabId(session.id) : legacy.activeTab,
  };
}

/**
 * Migre une entrée « Lot Sessions » (onglets fichiers/actif PAR SESSION) vers
 * la forme actuelle (onglets au niveau PROJET) : on reprend les onglets
 * fichiers/l'onglet actif de la session qui était active — les onglets des
 * AUTRES sessions de l'ancienne forme sont perdus (ils dupliquaient de toute
 * façon rarement des fichiers différents en pratique), mais aucun TOUR n'est
 * perdu. Seule la session active rouvre en onglet ; les autres restent
 * consultables depuis le panneau « Sessions ».
 */
function migrateOldMultiSessionEntry(old: OldMultiSessionEntry): PersistedProjectEntry {
  const activeSession = old.sessions.find((s) => s.id === old.activeId) ?? old.sessions[0];
  return {
    sessions: old.sessions.map(({ openFilePaths: _openFilePaths, activeTab: _activeTab, ...rest }) => rest),
    activeId: activeSession.id,
    openConversationIds: [activeSession.id],
    openFilePaths: activeSession.openFilePaths,
    activeTab: activeSession.activeTab === "conversation" ? convTabId(activeSession.id) : activeSession.activeTab,
  };
}

/**
 * RÉPARE les champs d'affinité de routage (R2) d'une session brute AVANT
 * validation — même principe que `withRoutingDefaults` côté ChatPage.tsx : une
 * valeur hors vocabulaire (document altéré, ancienne version) est simplement
 * RETIRÉE, la session est conservée SANS affinité. Sans cette réparation,
 * `hasCommonSessionFields` invalidait la session, et avec elle l'ENTRÉE
 * PROJET entière (historique perdu) — inacceptable pour des champs purement
 * optionnels.
 */
function withRoutingRepair(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (v.routedTier === undefined && v.routedTarget === undefined) return value;
  return {
    ...v,
    routedTier: isRouteTier(v.routedTier) ? v.routedTier : null,
    routedTarget: toRouteTarget(v.routedTarget),
  };
}

/** Applique `withRoutingRepair` à chaque session d'une entrée projet brute (formes avec tableau `sessions`). */
function withSessionsRoutingRepair(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.sessions)) return value;
  return { ...v, sessions: v.sessions.map(withRoutingRepair) };
}

/**
 * Valide défensivement le document lu du disque (peut être `{}`, absent, ou
 * corrompu) et MIGRE au passage toute entrée encore à une forme antérieure
 * (avant le Lot Sessions, ou avant le Lot Onglets multiples) — voir
 * `migrateLegacyProjectState`/`migrateOldMultiSessionEntry`. Une entrée qui
 * ne correspond à aucune forme connue est silencieusement ignorée (comme
 * avant ce lot). L'ordre des essais compte : la forme actuelle en premier
 * (le cas le plus fréquent une fois ce lot déployé), la plus ancienne en
 * dernier. Les champs d'affinité de routage sont RÉPARÉS avant validation
 * (voir `withRoutingRepair`) : jamais une invalidation d'entrée pour eux.
 */
function sanitizePersistedConversations(raw: unknown): PersistedConversations {
  if (typeof raw !== "object" || raw === null) return {};
  const out: PersistedConversations = {};
  for (const [id, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const value = withSessionsRoutingRepair(rawValue);
    if (isPersistedProjectEntry(value)) {
      out[id] = value;
    } else if (isOldMultiSessionEntry(value)) {
      out[id] = migrateOldMultiSessionEntry(value);
    } else if (isLegacyPersistedProjectState(value)) {
      out[id] = migrateLegacyProjectState(value);
    }
  }
  return out;
}

/**
 * Sérialise une `ProjectSession` en vue de la persistance : borne aux 200
 * derniers tours, et exclut tout tour encore `streaming` (jamais persisté
 * dans cet état — un tour interrompu au milieu perd juste son contenu
 * partiel, les tours précédents restent intacts). Le titre auto est
 * recalculé à chaque sauvegarde tant qu'il n'a pas été personnalisé. Les
 * pièces jointes perdent leur aperçu (`toAttachmentRefs`) : conformément au
 * contrat, seuls `kind`/`name` survivent sur disque.
 */
function buildPersistedSession(session: ProjectSession): PersistedSession {
  const persistableTurns = session.turns
    .filter((t) => t.status !== "streaming")
    .slice(-MAX_PERSISTED_TURNS)
    .map((t) => (t.attachments ? { ...t, attachments: toAttachmentRefs(t.attachments) } : t));
  return {
    id: session.id,
    title: session.titleCustom ? session.title : deriveSessionTitle(persistableTurns),
    titleCustom: session.titleCustom,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: persistableTurns,
    sessionId: session.sessionId,
    engine: session.engine,
    selectedAgent: session.selectedAgent,
    routedTier: session.routedTier,
    routedTarget: session.routedTarget,
  };
}

/**
 * Sérialise un `ProjectState` complet : plafonne le nombre de sessions
 * conservées (voir `capSessions`, sessionStore.ts) — `openConversationIds`
 * est filtré en cohérence (jamais une référence à une session tombée hors
 * plafond), avec un repli sur `[activeId]` si ce filtrage le viderait
 * entièrement (jamais zéro onglet de conversation persisté alors qu'une
 * session active existe).
 */
function buildPersistedEntry(state: ProjectState): PersistedProjectEntry {
  const keptSessions = capSessions(state.sessions, state.activeId, MAX_SESSIONS_PER_PROJECT);
  const keptIds = new Set(keptSessions.map((s) => s.id));
  const openConversationIds = state.openConversationIds.filter((id) => keptIds.has(id));
  return {
    sessions: keptSessions.map(buildPersistedSession),
    activeId: state.activeId,
    openConversationIds: openConversationIds.length > 0 ? openConversationIds : [state.activeId],
    openFilePaths: state.openFiles.map((f) => f.path),
    activeTab: state.activeTab,
  };
}

/** Reconstruit une `ProjectSession` en mémoire depuis une entrée persistée (tours/id de session serveur — plus d'onglets, désormais au niveau projet). */
function sessionStateFromPersisted(entry: PersistedSession): ProjectSession {
  return {
    id: entry.id,
    title: entry.title,
    titleCustom: entry.titleCustom,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    turns: entry.turns,
    sessionId: entry.sessionId,
    engine: entry.engine ?? claudeEngine(),
    selectedAgent: entry.selectedAgent ?? null,
    // R2 — assainissement défensif (valeurs corrompues → aucune affinité).
    routedTier: isRouteTier(entry.routedTier) ? entry.routedTier : null,
    routedTarget: toRouteTarget(entry.routedTarget),
  };
}

/**
 * Reconstruit les onglets FICHIER (niveau projet) depuis leurs chemins
 * persistés : redeviennent des onglets à l'état `loading` (contenu vide, pas
 * encore lu), chemin ajouté à `pendingLazy` — c'est `triggerLazyLoad` (dans
 * le composant) qui déclenchera le `fsReadFile` réel, au moment où l'onglet
 * devient actif.
 */
function openFilesFromPaths(paths: string[], pendingLazy: Set<string>): OpenFileState[] {
  return paths.map((path) => {
    pendingLazy.add(path);
    const name = path.slice(path.lastIndexOf("/") + 1) || path;
    return {
      path,
      name,
      kind: "loading",
      content: "",
      base64: "",
      size: 0,
      truncated: false,
      dirty: false,
      saving: false,
      saveError: null,
      errorMessage: null,
    };
  });
}

function projectStateFromPersisted(entry: PersistedProjectEntry, pendingLazy: Set<string>): ProjectState {
  const sessions = entry.sessions.map(sessionStateFromPersisted);
  if (sessions.length === 0) return emptyProjectState();
  const activeId = sessions.some((s) => s.id === entry.activeId) ? entry.activeId : sessions[0].id;
  const openFiles = openFilesFromPaths(entry.openFilePaths, pendingLazy);
  const knownConvIds = entry.openConversationIds.filter((id) => sessions.some((s) => s.id === id));
  const openConversationIds = knownConvIds.length > 0 ? knownConvIds : [activeId];
  const activeTab =
    entry.activeTab === EMPTY_TAB ||
    entry.openFilePaths.includes(entry.activeTab) ||
    (isConvTab(entry.activeTab) && openConversationIds.includes(convIdOfTab(entry.activeTab)))
      ? entry.activeTab
      : convTabId(activeId);
  return { sessions, activeId, openConversationIds, openFiles, activeTab };
}

/* ---------- Connaissances (documents épinglés par projet) ---------- */

const KNOWLEDGE_STATE_KEY = "project-knowledge";
const KNOWLEDGE_DOC_MAX_CHARS = 30_000;
const KNOWLEDGE_TOTAL_MAX_CHARS = 120_000;

/**
 * R5 — mode RAG (docs/spec-r5-rag.md §4) : en mode `connaissances.mode: "rag"`
 * (réglage par projet, voir projectAdmin.ts), AUCUNE injection intégrale au
 * 1er tour — cette ligne système la remplace, et l'outil `search_knowledge`
 * est proposé dans les deux moteurs (palette du moteur neutre ; serveur MCP
 * in-process `mcp__iaction__search_knowledge` côté Claude, activé par le
 * sidecar quand l'index du projet existe).
 */
const RAG_SYSTEM_LINE = "Des connaissances projet sont indexées — utilise l'outil search_knowledge.";

interface PinnedDoc {
  path: string;
  name: string;
}

type KnowledgeDoc = Record<string, PinnedDoc[]>;

function isPinnedDoc(value: unknown): value is PinnedDoc {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === "string" && typeof v.name === "string";
}

/** Valide défensivement le document lu du disque (même esprit que `sanitizePersistedConversations`). */
function sanitizeKnowledgeDoc(raw: unknown): KnowledgeDoc {
  if (typeof raw !== "object" || raw === null) return {};
  const out: KnowledgeDoc = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value) && value.every(isPinnedDoc)) out[id] = value;
  }
  return out;
}

/**
 * Fusionne le document disque avec l'état local courant (StrictMode-safe) :
 * un épinglage déjà fait localement AVANT que la lecture disque ne se
 * termine ne doit jamais être perdu — le disque ne fait qu'ajouter ce qu'il
 * a de plus, jamais retirer ce qui est déjà affiché.
 */
function mergeKnowledgeDocs(disk: KnowledgeDoc, local: KnowledgeDoc): KnowledgeDoc {
  const ids = new Set([...Object.keys(disk), ...Object.keys(local)]);
  const out: KnowledgeDoc = {};
  for (const id of ids) {
    const merged = [...(disk[id] ?? [])];
    for (const item of local[id] ?? []) {
      if (!merged.some((d) => d.path === item.path)) merged.push(item);
    }
    out[id] = merged;
  }
  return out;
}

/** Chemin d'un document épinglé, relatif à la racine du projet (tel qu'affiché dans le bloc injecté). */
function relativeToProject(path: string, root: string): string {
  if (root && path.startsWith(root)) {
    const rest = path.slice(root.length).replace(/^\/+/, "");
    return rest || path;
  }
  return path;
}

/**
 * Concatène plusieurs listes de documents en dédoublonnant par `path` (le
 * premier qui apparaît gagne) — utilisé pour fusionner épinglées + auto
 * (`.iaction/connaissances/`) dans une seule liste à injecter/compter, sans
 * jamais injecter deux fois le même fichier s'il est à la fois épinglé et
 * présent dans le dossier auto.
 */
function dedupDocsByPath(lists: PinnedDoc[][]): PinnedDoc[] {
  const seen = new Set<string>();
  const out: PinnedDoc[] = [];
  for (const list of lists) {
    for (const doc of list) {
      if (seen.has(doc.path)) continue;
      seen.add(doc.path);
      out.push(doc);
    }
  }
  return out;
}

/* ---------- Menu contextuel de l'arbre : renommer/supprimer (voir FileTree.tsx) ---------- */

/** `path` égal à `target`, ou situé dedans (`target` renommé/supprimé était un DOSSIER). */
function isUnderPath(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}/`);
}

/** Réécrit `path` si renommé — inchangé s'il ne correspond ni à `oldPath` ni à un de ses descendants. */
function renamedPath(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
  return path;
}

/**
 * Construit le bloc « connaissances » préfixé au message ENVOYÉ au premier
 * tour d'une session (voir `handleSend`) — `docs` est la liste déjà fusionnée
 * épinglées + auto (`injectedKnowledge`, voir `dedupDocsByPath`), traitée de
 * façon strictement identique quelle que soit l'origine. Chaque document est
 * tronqué individuellement à `KNOWLEDGE_DOC_MAX_CHARS` ; une fois le budget
 * total `KNOWLEDGE_TOTAL_MAX_CHARS` atteint, les documents suivants ne sont
 * même plus lus (juste listés comme non injectés). Une erreur de lecture
 * n'est jamais fatale : le document est marqué « illisible » et on continue.
 */
async function buildKnowledgeBlock(docs: PinnedDoc[], root: string): Promise<string> {
  const sections: string[] = [];
  let totalUsed = 0;
  for (const doc of docs) {
    const rel = relativeToProject(doc.path, root);
    if (totalUsed >= KNOWLEDGE_TOTAL_MAX_CHARS) {
      sections.push(`--- ${rel} ---\n[non injecté : budget dépassé]`);
      continue;
    }
    let content: string;
    try {
      const fc = await fsReadFile(doc.path);
      content = fc.kind === "text" ? (fc.text ?? "") : "[illisible]";
    } catch {
      content = "[illisible]";
    }
    if (content !== "[illisible]" && content.length > KNOWLEDGE_DOC_MAX_CHARS) {
      content = `${content.slice(0, KNOWLEDGE_DOC_MAX_CHARS)}\n[… tronqué]`;
    }
    totalUsed += content.length;
    sections.push(`--- ${rel} ---\n${content}`);
  }
  return `Documents de connaissances du projet :\n\n${sections.join("\n")}\n\n---\n\n`;
}

/* ---------- MCP (lecture seule .mcp.json + compteurs d'usage) ---------- */

interface McpServerInfo {
  name: string;
  kind: "stdio" | "http" | "sse";
  detail: string;
}

function truncateDetail(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Format attendu : `{ mcpServers: { <nom>: { command } | { type, url } } }` — voir docs/protocol.md. */
function parseMcpConfig(raw: string): McpServerInfo[] {
  try {
    const data = JSON.parse(raw) as { mcpServers?: unknown };
    const servers = asRecord(data.mcpServers);
    return Object.entries(servers).map(([name, value]) => {
      const v = asRecord(value);
      if (typeof v.command === "string") {
        return { name, kind: "stdio" as const, detail: truncateDetail(v.command) };
      }
      const kind = v.type === "sse" ? ("sse" as const) : ("http" as const);
      return { name, kind, detail: truncateDetail(typeof v.url === "string" ? v.url : "") };
    });
  } catch {
    return [];
  }
}

/* ---------- Page ---------- */

interface AgentPageProps {
  projects: ProjectConfig[];
  projectsLoadState: ProjectsLoadState;
  /** Fournisseurs neutres configurés (Ollama/OpenRouter/custom) — voir le sélecteur « Moteur ». */
  providers: ProviderConfig[];
  onGoToConfig: () => void;
  /** Micro choisi dans Configuration › Dictée (vide = défaut système). */
  micDeviceId?: string;
  /** Réglages « Mode conversation » de la config voix (défauts si absents). */
  conversationConfig?: ConversationSettings;
  /**
   * Cette page est-elle celle affichée ? Les six pages restent montées en
   * permanence (voir App.tsx) : la voix a besoin de savoir qu'on l'a quittée
   * pour refermer le micro (voir useVoiceComposer.ts).
   */
  pageVisible?: boolean;
}

export interface AgentPageHandle {
  /**
   * Sélection demandée depuis l'extérieur (palette Ctrl+Maj+P). Renvoie `false`
   * si refusée — un run est en cours, ou `id` ne correspond à aucun projet
   * connu — auquel cas l'appelant affiche un message discret et ne change
   * pas d'onglet.
   */
  requestSelectProject: (id: string) => boolean;
  /** Chemin du projet sélectionné (menu Terminal de l'en-tête) — null si aucun. */
  getSelectedProjectPath: () => string | null;
  /**
   * Raccourci global Ctrl+N (voir App.tsx) : nouvelle session du projet
   * courant. Renvoie `false` si refusée (run en cours) — l'appelant reste
   * alors silencieux, comme le bouton correspondant.
   */
  newSession: () => boolean;
  /**
   * Raccourci global Ctrl+K (voir App.tsx) : vide les tours de la session
   * ACTIVE sans en créer de nouvelle. Renvoie `false` si refusée (run en
   * cours) — la confirmation destructive est à la charge de l'appelant.
   */
  clearConversation: () => boolean;
  /**
   * Un tour est-il en cours ? Consultée par App.tsx AVANT d'afficher la
   * confirmation de Ctrl+K — un run en cours doit rester un no-op
   * totalement silencieux (aucune modale), pas juste un clic sans effet.
   */
  isStreaming: () => boolean;
  /** Place le curseur dans le composeur (arrivée sur la page, vidage, nouvelle conversation). */
  focusComposer: () => void;
}

export const AgentPage = forwardRef<AgentPageHandle, AgentPageProps>(function AgentPage(
  {
    projects,
    projectsLoadState,
    providers,
    onGoToConfig,
    micDeviceId = "",
    conversationConfig = DEFAULT_CONVERSATION_SETTINGS,
    pageVisible = true,
  }: Readonly<AgentPageProps>,
  ref,
) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // Sauvegarde de la dernière conversation vidée (Ctrl+K) + bandeau d'annulation.
  // `convId` identifie LA conversation vidée : « Annuler » restaure dans
  // celle-là précisément — jamais dans la conversation active du moment, qui a
  // pu changer entre-temps (bug historique : vider, créer une session neuve,
  // cliquer Annuler ⇒ les anciens tours réapparaissaient dans la neuve).
  const clearedBackupRef = useRef<{
    convId: string;
    turns: AgentTurn[];
    sessionId: string | null;
    /** R2 — affinité de session du mode Auto, restaurée avec les tours. */
    routedTier: RouteTier | null;
    routedTarget: RouteTarget | null;
  } | null>(null);
  const [clearedNotice, setClearedNotice] = useState(false);
  // Dernier projet ouvert, relu du disque au démarrage. `lastProjectLoaded`
  // sert de garde : tant que la lecture n'a pas abouti, on ne sélectionne rien.
  const lastProjectIdRef = useRef<string | null>(null);
  const [lastProjectLoaded, setLastProjectLoaded] = useState(false);

  useEffect(() => {
    stateRead<unknown>(LAST_PROJECT_STATE_KEY)
      .then((raw) => {
        const value = asRecord(raw).projectId;
        if (typeof value === "string" && value) lastProjectIdRef.current = value;
      })
      .catch(() => {
        // best effort : sans mémoire, on ouvrira le premier projet déclaré
      })
      .finally(() => setLastProjectLoaded(true));
  }, []);

  /** Mémorise le projet ouvert pour le prochain démarrage (best effort). */
  function rememberLastProject(id: string) {
    lastProjectIdRef.current = id;
    void stateWrite(LAST_PROJECT_STATE_KEY, { projectId: id }).catch(() => {});
  }
  // État des projets non affichés à l'écran (Map en mémoire, mise en miroir
  // sur disque — voir persistedConversationsRef ci-dessous). Un `ref` suffit
  // pour la Map elle-même : lue/écrite uniquement au moment de la bascule,
  // jamais rendue directement.
  const projectStatesRef = useRef<Map<string, ProjectState>>(new Map());

  // Document complet persisté (toutes conversations, toutes clés) : source
  // de vérité pour `state_write`, qui REMPLACE le fichier (pas de fusion
  // côté Rust) — on doit donc toujours réécrire le document entier.
  const persistedConversationsRef = useRef<PersistedConversations>({});
  // Chemins de fichiers restaurés du disque mais pas encore relus
  // (contenu vide) : `triggerLazyLoad` les consomme au moment de l'activation.
  const pendingLazyLoadsRef = useRef<Set<string>>(new Set());
  const stateInitRef = useRef(false);
  const hydrationDoneRef = useRef(false);
  const [statePhase, setStatePhase] = useState<"loading" | "loaded">("loading");

  // « Autonome » par défaut (choix utilisateur 2026-07-19) : l'agent exécute
  // commandes et éditions sans validation ; repasser à « Valider chaque
  // action » via le sélecteur pour retrouver les modales de permission.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("bypassPermissions");
  // Moteur de l'agent : `null` = Claude (abonnement), sinon l'id d'un
  // fournisseur neutre (Ollama/OpenRouter/custom) — voir le sélecteur
  // « Moteur » de la toolbar. Fait partie de l'état PAR PROJET (persisté).
  const [engineProviderId, setEngineProviderId] = useState<string | null>(null);
  const [model, setModel] = useState("");

  // Agent sélectionné (sélecteur « Agent », section LLM) : `null` = manuel.
  // Fait partie de l'état PAR SESSION (persisté comme `engine`, voir
  // `ProjectSession.selectedAgent`). Ne contient QUE la référence (nom +
  // portée) — la configuration réellement appliquée est relue à chaque rendu
  // depuis `projectAgents` (voir `selectedAgent` ci-dessous), jamais recopiée
  // ici, pour ne jamais désynchroniser affichage et fichier source.
  const [selectedAgentKey, setSelectedAgentKey] = useState<AgentSelection | null>(null);

  // Modèles du fournisseur neutre actif (pattern de ChatPage.tsx) — non
  // pertinent/vide tant que `engineProviderId` est `null` (Claude).
  const [neutralModels, setNeutralModels] = useState<ModelInfo[]>([]);
  const [neutralModelsState, setNeutralModelsState] = useState<"idle" | "loading" | "error">("idle");
  const [neutralModelsError, setNeutralModelsError] = useState("");
  // Favoris du fournisseur neutre actif (voir modelCatalog.ts) : remontés en tête
  // du sélecteur de modèle, préfixés « ★ ». Sans effet côté Claude (abonnement).
  const [neutralFeaturedIds, setNeutralFeaturedIds] = useState<string[]>([]);

  // Sessions du projet COURANT — voir le commentaire détaillé plus bas
  // (juste avant `permissionQueue`) : ces deux déclarations doivent précéder
  // le bloc runtime ci-après, qui en a besoin (`activeSessionId`).
  const [sessions, setSessionsState] = useState<ProjectSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string>("");
  /*
   * Miroirs SYNCHRONES de `sessions`/`activeSessionId` (même patron que
   * `openConversationIdsRef`) : `buildLiveSessions` les lit au lieu de l'état
   * fermé dans la closure. Sans cela, un callback LONG (fin de tour, qui
   * s'exécute des minutes après son `handleSend`) reconstruisait la liste
   * depuis un `sessions` PÉRIMÉ et la réécrivait — toute conversation créée
   * pendant le tour (« + », onglet rouvert depuis l'historique) disparaissait
   * de la liste, donc son ONGLET aussi (la barre ignore un id sans session),
   * et la perte était même persistée. Constaté le 2026-07-31.
   */
  const sessionsRef = useRef<ProjectSession[]>(sessions);
  const activeSessionIdRef = useRef<string>(activeSessionId);
  function setSessions(next: ProjectSession[] | ((prev: ProjectSession[]) => ProjectSession[])) {
    const value = typeof next === "function" ? next(sessionsRef.current) : next;
    sessionsRef.current = value;
    setSessionsState(value);
  }
  function setActiveSessionId(next: string) {
    activeSessionIdRef.current = next;
    setActiveSessionIdState(next);
  }

  /*
   * ---------- Runtime vif PAR CONVERSATION (Lot Onglets multiples) ----------
   *
   * `ConvRuntime` remplace les anciens `turns`/`sessionId`/`streaming`/
   * `activeRequestId`/`draft`/`queuedPrompts`/`mcpUsage` mono-valués : chaque
   * conversation OUVERTE (voir `openConversationIds` plus bas) a désormais
   * son propre runtime, qui continue d'évoluer même quand son onglet n'est
   * pas affiché — c'est ce qui permet à un tour de streamer en arrière-plan.
   *
   * Stocké dans une Map en `ref` (pas en `useState`) : les callbacks de
   * streaming (`onText`, `onToolUse`… dans `sendViaClaudeEngine`/
   * `sendViaNeutralEngine`) CAPTURENT l'id de la conversation par fermeture,
   * exactement comme elles capturent déjà `assistantId` — elles écrivent donc
   * toujours dans la bonne conversation via `updateRuntime(convId, …)`, quel
   * que soit l'onglet affiché au moment où le chunk arrive. `runtimeTick` est
   * le seul bout d'état React de ce mécanisme : il force un nouveau rendu à
   * chaque mutation (n'importe quelle conversation), pour que le point « ● »
   * d'un onglet en arrière-plan et le contenu affiché de la conversation
   * active restent à jour — la DONNÉE elle-même vit dans `runtimesRef.current`,
   * lu à chaque rendu (`getRuntime`), jamais dans un `useState` séparé (qui
   * imposerait de recréer la Map entière à chaque delta de streaming).
   */
  const runtimesRef = useRef<Map<string, ConvRuntime>>(new Map());
  const [runtimeTick, setRuntimeTick] = useState(0);

  /** Runtime vif d'une conversation — créé vierge à la volée si absent (première fois qu'on le lit). */
  function getRuntime(convId: string): ConvRuntime {
    let r = runtimesRef.current.get(convId);
    if (!r) {
      r = freshRuntime();
      runtimesRef.current.set(convId, r);
    }
    return r;
  }

  /**
   * Amorce le runtime d'une conversation depuis sa dernière copie connue
   * (`ProjectSession.turns`/`sessionId`) SI elle n'a encore jamais été
   * ouverte cette exécution — ne touche jamais un runtime déjà vivant (une
   * conversation en cours de streaming ne doit jamais être réinitialisée par
   * une réouverture de son onglet).
   */
  function ensureRuntime(
    session: Pick<ProjectSession, "id" | "turns" | "sessionId" | "routedTier" | "routedTarget">,
  ) {
    if (!runtimesRef.current.has(session.id)) {
      runtimesRef.current.set(
        session.id,
        freshRuntime(session.turns, session.sessionId, session.routedTier, session.routedTarget),
      );
    }
  }

  /** Écrit dans le runtime d'UNE conversation précise et force un nouveau rendu (voir le commentaire ci-dessus). */
  function updateRuntime(convId: string, updater: (prev: ConvRuntime) => ConvRuntime) {
    runtimesRef.current.set(convId, updater(getRuntime(convId)));
    setRuntimeTick((t) => t + 1);
  }

  /** Variante ciblée sur les tours — remplace l'ancien `updateTurns` mono-conversation, désormais paramétré par `convId`. */
  function updateTurnsFor(convId: string, updater: (prev: AgentTurn[]) => AgentTurn[]) {
    updateRuntime(convId, (r) => ({ ...r, turns: updater(r.turns) }));
  }

  // `runtimeTick` n'est lu nulle part d'autre : cette ligne est la SEULE
  // dépendance de rendu sur ce compteur, ce qui suffit à ce que React
  // reprogramme un rendu à chaque mutation de n'importe quel runtime.
  void runtimeTick;

  // Copie VIVE de la conversation ACTIVE (celle affichée/éditée) — dérivée du
  // runtime à CHAQUE rendu, plus un `useState` séparé : `activeSessionId`
  // pilote déjà le rendu, `runtimeTick` couvre les mutations de streaming.
  const activeRuntime = activeSessionId ? getRuntime(activeSessionId) : freshRuntime();
  const turns = activeRuntime.turns;
  const sessionId = activeRuntime.sessionId;
  const streaming = activeRuntime.streaming;
  const draft = activeRuntime.draft;
  const queuedPrompts = activeRuntime.queuedPrompts;
  const mcpUsage = activeRuntime.mcpUsage;
  // R3 — bandeau de débord de la conversation ACTIVE (voir DebordNotice).
  const debordNotice = activeRuntime.debordNotice;

  /** Brouillon : toujours celui de la conversation ACTIVE — seule celle-ci a un composeur affiché. */
  function setDraft(value: string) {
    if (activeSessionId) updateRuntime(activeSessionId, (r) => ({ ...r, draft: value }));
  }
  /** File d'attente de la conversation ACTIVE : retire le message à l'index donné (pastille d'annulation). */
  function removeQueuedPrompt(index: number) {
    if (activeSessionId)
      updateRuntime(activeSessionId, (r) => ({
        ...r,
        queuedPrompts: r.queuedPrompts.filter((_, i) => i !== index),
      }));
  }

  // Menu « / » du composeur (slash-commands/skills du projet) : la référence
  // du textarea sert à lire/poser la position du curseur (détection du token
  // « /frag » et repositionnement après insertion) ; `pendingCursorRef` porte
  // une position de curseur à appliquer au prochain rendu (on ne peut pas
  // appeler `setSelectionRange` avant que React ait commité la nouvelle
  // valeur du textarea, voir l'effet juste après `applySlashCommand`).
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const [slashMenu, setSlashMenu] = useState<{ open: boolean; fragment: string; start: number; selected: number }>({
    open: false,
    fragment: "",
    start: 0,
    selected: 0,
  });
  // Applique une position de curseur en attente APRÈS que React a commité la
  // nouvelle valeur du textarea (voir `applySlashCommand`) — poser
  // `setSelectionRange` avant le commit viserait encore l'ancienne valeur.
  useEffect(() => {
    if (pendingCursorRef.current === null) return;
    const pos = pendingCursorRef.current;
    pendingCursorRef.current = null;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  }, [draft]);
  // Filet de sécurité pour les remises à zéro du brouillon hors saisie
  // clavier (envoi, nouvelle session…) : un texte vide ne commence jamais
  // par « / », le menu doit donc se refermer même sans passer par `onChange`.
  useEffect(() => {
    if (draft === "") setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
  }, [draft]);

  // Pièces jointes du composeur (voir Attachments.tsx) : le contrat sidecar
  // (docs/protocol.md) ne les prévoit QUE pour `claude.start`, pas
  // `neutral.start` — le composeur les désactive donc tant que le moteur
  // neutre est actif pour la session (voir `attachmentsSupported`), et les
  // purge à chaque bascule de moteur/session/projet pour ne jamais en garder
  // en attente pour le mauvais moteur. Purgées après un envoi réussi
  // seulement (voir `handleSend`) : conservées si l'envoi échoue.
  const { attachments, addFiles, beginImage, resolveImage, removeAttachment, clear: clearAttachments, error: attachmentsError, setError: setAttachmentsError } =
    useAttachmentDraft();
  const [composerDragOver, setComposerDragOver] = useState(false);
  // R2 — en mode « Auto (routeur) », le moteur réel n'est connu qu'après
  // routage (possiblement neutre, qui ne supporte pas les pièces jointes) :
  // l'ajout est donc désactivé aussi tant que la sentinelle Auto est choisie.
  const attachmentsSupported = engineProviderId === null && model !== AUTO_MODEL;
  // Au moins une image collée encore en cours d'encodage : l'envoi doit
  // attendre (sinon on enverrait une pièce jointe sans données).
  const attachmentsPending = attachments.some((a) => a.loading);

  // `sessions`/`activeSessionId` sont déclarés PLUS HAUT (le bloc runtime par
  // conversation en dépend). `sessions` porte la dernière copie connue des
  // champs lourds de chaque conversation ; les conversations OUVERTES en
  // onglet ont, elles, un runtime vif dans `runtimesRef` qui prime — voir
  // `buildLiveSessions`, qui recombine les deux à chaque sauvegarde.
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionTitle, setEditingSessionTitle] = useState("");
  const sessionTitleSkipBlurRef = useRef(false);
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);

  const [permissionQueue, setPermissionQueue] = useState<PermissionRequestItem[]>([]);
  // Outils auto-autorisés (« ne plus demander ») — durée de vie : la session
  // de l'application, tous projets confondus.
  const autoAllowToolsRef = useRef<Set<string>>(new Set());

  // Onglets éditeur : "conversation" ou le chemin d'un fichier ouvert.
  const [activeTab, setActiveTab] = useState<string>(EMPTY_TAB);
  const [openFiles, setOpenFiles] = useState<OpenFileState[]>([]);
  const [openFilesNotice, setOpenFilesNotice] = useState<string | null>(null);
  /** Conversations ouvertes en onglet, dans l'ordre d'affichage de la barre. */
  const [openConversationIds, setOpenConversationIdsState] = useState<string[]>([]);
  const openConversationIdsRef = useRef(openConversationIds);
  /**
   * Écrit l'état ET la ref de façon SYNCHRONE : `persistProject` lit la ref
   * juste après l'appel (même tour de boucle), un miroir par `useEffect`
   * arriverait trop tard et persisterait la liste d'onglets d'AVANT la
   * fermeture/l'ouverture.
   */
  function setOpenConversationIds(next: string[] | ((prev: string[]) => string[])) {
    const value = typeof next === "function" ? next(openConversationIdsRef.current) : next;
    openConversationIdsRef.current = value;
    setOpenConversationIdsState(value);
  }

  // Badges de détection (.iaction/CLAUDE.md/.claude) — chemin complet si
  // présent à la racine du projet, `null` sinon. Alimentés par le
  // `fs_list_dir` racine déjà fait par FileTree (voir `handleRootEntries`),
  // pas de second appel dédié.
  const [projectBadges, setProjectBadges] = useState<{
    iactionPath: string | null;
    claudeMdPath: string | null;
    claudeDirPath: string | null;
  }>({ iactionPath: null, claudeMdPath: null, claudeDirPath: null });

  // Registre d'applications externes (Lot 5, voir appsAdmin.ts) : lu une seule fois au
  // montage — alimente le menu contextuel de FileTree (« Ouvrir avec … »). Édité depuis la
  // page Configuration ; une modification n'est reprise ici qu'au redémarrage de l'app
  // (câblage minimal demandé pour ce lot, pas de synchronisation live entre les deux pages).
  const [apps, setApps] = useState<AppEntry[]>([]);
  useEffect(() => {
    readApps()
      .then(setApps)
      .catch(() => {
        // best effort : sans registre, le menu contextuel propose seulement le repli système
      });
  }, []);

  // Connaissances (documents épinglés par projet, panneau latéral) : chargées
  // une seule fois au montage (StrictMode-safe, même famille de pattern que
  // le chargement de `project-conversations` ci-dessus) — le document COMPLET
  // (toutes projets) est gardé en state, la liste du projet courant en étant
  // simplement dérivée (`knowledgeDoc[selectedProjectId]`), pas de mirroring
  // supplémentaire à synchroniser au changement de projet.
  const knowledgeInitRef = useRef(false);
  const [knowledgeDoc, setKnowledgeDoc] = useState<KnowledgeDoc>({});
  useEffect(() => {
    if (knowledgeInitRef.current) return;
    knowledgeInitRef.current = true;
    stateRead<unknown>(KNOWLEDGE_STATE_KEY)
      .then((raw) => {
        const disk = sanitizeKnowledgeDoc(raw);
        // Fusion (jamais un écrasement) : voir le commentaire de `mergeKnowledgeDocs`.
        setKnowledgeDoc((local) => mergeKnowledgeDocs(disk, local));
      })
      .catch(() => {
        // best effort : sans document, la liste reste vide (aucune connaissance épinglée)
      });
  }, []);

  const pinnedKnowledge = selectedProjectId ? (knowledgeDoc[selectedProjectId] ?? []) : [];

  function pinKnowledge(path: string, name: string) {
    if (!selectedProjectId) return;
    setKnowledgeDoc((prev) => {
      const list = prev[selectedProjectId] ?? [];
      if (list.some((d) => d.path === path)) return prev; // pas de doublon (même chemin → ignoré)
      const next = { ...prev, [selectedProjectId]: [...list, { path, name }] };
      void stateWrite(KNOWLEDGE_STATE_KEY, next).catch(() => {
        // best effort : l'épinglage reste visible en mémoire même si l'écriture échoue
      });
      return next;
    });
  }

  function unpinKnowledge(path: string) {
    if (!selectedProjectId) return;
    setKnowledgeDoc((prev) => {
      const list = prev[selectedProjectId] ?? [];
      const next = { ...prev, [selectedProjectId]: list.filter((d) => d.path !== path) };
      void stateWrite(KNOWLEDGE_STATE_KEY, next).catch(() => {});
      return next;
    });
  }

  // MCP (v1 lecture seule) : état déclaré ici, chargé un peu plus bas
  // (l'effet a besoin de `cwd`, calculé après — voir juste après sa
  // déclaration ci-dessous).
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);

  // Les compteurs d'appels par serveur MCP sont PAR CONVERSATION (portés par
  // `ConvRuntime.mcpUsage`, incrémentés dans le `onToolUse` de `handleSend`) :
  // deux conversations ouvertes comptent leurs appels séparément, et le
  // panneau « MCP » affiche ceux de la conversation active (`mcpUsage`).

  // Modèles du moteur neutre (même pattern que `loadModels` dans
  // ChatPage.tsx) : rechargés à chaque changement de fournisseur — y compris
  // lors d'une restauration de projet, `engineProviderId` changeant alors
  // aussi. Si le modèle courant (restauré ou choisi) n'existe pas dans la
  // liste reçue, on retombe sur le premier modèle disponible.
  const loadNeutralModels = useCallback(async (providerId: string) => {
    setNeutralModelsState("loading");
    setNeutralModelsError("");
    try {
      const list = await modelsList(providerId);
      setNeutralModels(list);
      setNeutralModelsState("idle");
      // R2 — la sentinelle « Auto » est toujours un choix valide, à préserver.
      setModel((prev) => (prev === AUTO_MODEL || list.some((m) => m.id === prev) ? prev : (list[0]?.id ?? "")));
    } catch (err) {
      setNeutralModels([]);
      setNeutralModelsState("error");
      setNeutralModelsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (engineProviderId !== null) void loadNeutralModels(engineProviderId);
    // Relance quand la table des fournisseurs atteint (enfin) le sidecar : au
    // démarrage, ce premier chargement part souvent avant providers.set et
    // échoue en « fournisseur inconnu ».
    const off = subscribeProvidersPushed(() => {
      if (engineProviderId !== null) void loadNeutralModels(engineProviderId);
    });
    return off;
  }, [engineProviderId, loadNeutralModels]);

  useEffect(() => {
    if (engineProviderId === null) {
      setNeutralFeaturedIds([]);
      return;
    }
    readFeatured(engineProviderId)
      .then(setNeutralFeaturedIds)
      .catch(() => setNeutralFeaturedIds([]));
  }, [engineProviderId]);

  const neutralFeaturedModels = splitFeatured(neutralModels, neutralFeaturedIds);

  // Le mode « plan » n'existe pas côté moteur neutre (voir docs/protocol.md,
  // Lot 6) : bascule de sécurité si un projet neutre est restauré/sélectionné
  // avec ce mode encore actif (ex. venant d'une session Claude précédente).
  useEffect(() => {
    if (engineProviderId !== null && permissionMode === "plan") {
      setPermissionMode("default");
    }
  }, [engineProviderId, permissionMode]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Miroirs toujours à jour de l'état affiché, pour la sauvegarde immédiate
  // en fin de tour (`handleSend`) : à ce moment-là, l'état React capturé à
  // l'appel de `handleSend` est périmé (plusieurs `setTurns`/`setSessionId`
  // ont eu lieu pendant le stream), il faut donc lire la valeur courante.
  const turnsRef = useRef(turns);
  const sessionIdRef = useRef(sessionId);
  const openFilesRef = useRef(openFiles);
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const cwd = selectedProject?.path ?? "";

  // MCP (v1 lecture seule) : liste des serveurs déclarés dans `.mcp.json` à
  // la racine du projet courant, rechargée à chaque changement de `cwd`.
  // Fichier absent/JSON invalide → liste vide (voir le rendu de la section,
  // qui affiche alors l'état « aucun serveur déclaré »).
  useEffect(() => {
    setMcpServers([]);
    if (!cwd) return;
    let cancelled = false;
    fsReadFile(`${cwd}/.mcp.json`)
      .then((fc) => {
        if (cancelled || fc.kind !== "text") return;
        setMcpServers(parseMcpConfig(fc.text ?? ""));
      })
      .catch(() => {
        // fichier absent/illisible : aucun serveur déclaré, état par défaut déjà posé ci-dessus
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Connaissances AUTOMATIQUES (piste 1 « flexibilité », docs/plan.md) :
  // tout fichier posé dans `.iaction/connaissances/` (pas de récursion,
  // fichiers seulement) rejoint les épinglées comme connaissance injectée au
  // 1er tour (voir `injectedKnowledge` ci-dessous) — groupe « Automatiques »
  // du panneau. Rechargé à chaque changement de projet ; dossier absent ou
  // illisible → liste vide, jamais d'erreur affichée (même esprit que la
  // lecture de `.mcp.json` ci-dessus).
  const [autoKnowledgeFiles, setAutoKnowledgeFiles] = useState<DirEntry[]>([]);
  useEffect(() => {
    setAutoKnowledgeFiles([]);
    if (!cwd) return;
    let cancelled = false;
    fsListDir(`${cwd}/.iaction/connaissances`)
      .then((entries) => {
        if (!cancelled) setAutoKnowledgeFiles(entries.filter((e) => !e.isDir));
      })
      .catch(() => {
        // dossier absent/illisible : aucune connaissance automatique, état par défaut déjà posé ci-dessus
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Mémoire Claude Code détectée (`.claude/memory/*.md`, groupe « Détectées »
  // du panneau, aux côtés de CLAUDE.md — voir `projectBadges.claudeMdPath`
  // plus bas) : purement informatif, JAMAIS injectée d'office (seulement si
  // l'utilisateur clique « Épingler », voir le rendu de la section
  // « Connaissances »). Même politique best effort que ci-dessus.
  const [claudeMemoryFiles, setClaudeMemoryFiles] = useState<DirEntry[]>([]);
  useEffect(() => {
    setClaudeMemoryFiles([]);
    if (!cwd) return;
    let cancelled = false;
    fsListDir(`${cwd}/.claude/memory`)
      .then((entries) => {
        if (!cancelled) setClaudeMemoryFiles(entries.filter((e) => !e.isDir && e.name.endsWith(".md")));
      })
      .catch(() => {
        // dossier absent/illisible : aucune mémoire Claude Code détectée
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Commandes/skills du projet (`claude.commands`, menu « / » du composeur) :
  // best effort — échec (auth, cwd invalide) → liste vide, jamais de message
  // d'erreur bloquant (voir docs/protocol.md). Mémorisées par `cwd` le temps
  // de la session (pas de persistance disque, juste évite un aller-retour
  // sidecar à chaque va-et-vient entre projets déjà visités).
  const slashCommandsCacheRef = useRef<Map<string, SlashCommandInfo[]>>(new Map());
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  useEffect(() => {
    setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
    if (!cwd) {
      setSlashCommands([]);
      return;
    }
    const cached = slashCommandsCacheRef.current.get(cwd);
    if (cached) {
      setSlashCommands(cached);
      return;
    }
    setSlashCommands([]);
    let cancelled = false;
    claudeCommands(cwd)
      .then((commands) => {
        slashCommandsCacheRef.current.set(cwd, commands);
        if (!cancelled) setSlashCommands(commands);
      })
      .catch(() => {
        // échec d'initialisation SDK (auth, cwd invalide) : menu vide, aucun blocage de la saisie
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  /*
   * Titres courts du panneau « Sessions ». Le CLI calcule déjà un titre IA
   * par session (« Organiser tâches sprint 2 et études stratégiques » plutôt
   * que les 48 premiers caractères du premier message) ; `claude.sessionTitles`
   * le relit dans les métadonnées de session — AUCUN token consommé, aucun
   * appel de modèle. Best effort : en cas d'échec, chaque session garde son
   * repli local (`deriveTitleFromText`).
   *
   * Les titres personnalisés à la main (`titleCustom`) ne sont jamais
   * écrasés ; l'appariement se fait sur `sessionId` — l'id de session CÔTÉ
   * SERVEUR, seul connu du CLI —, donc les conversations du moteur neutre
   * (sans session CLI) ne sont pas concernées.
   */
  useEffect(() => {
    if (!cwd || !selectedProjectId) return;
    const serverIds = sessions.map((s) => s.sessionId).filter((id): id is string => id !== null);
    if (serverIds.length === 0) return;
    let cancelled = false;
    void claudeSessionTitles(cwd, serverIds).then((titles) => {
      if (cancelled || titles.size === 0) return;
      setSessions((prev) => {
        let changed = false;
        const next = prev.map((s) => {
          if (s.titleCustom || !s.sessionId) return s;
          const aiTitle = titles.get(s.sessionId);
          if (!aiTitle || aiTitle === s.title) return s;
          changed = true;
          return { ...s, title: aiTitle };
        });
        return changed ? next : prev;
      });
    });
    return () => {
      cancelled = true;
    };
    // Rejoué quand une session obtient son id serveur (fin du 1er tour) : le
    // titre IA n'existe pas avant. `sessions` volontairement hors deps (le
    // setSessions ci-dessus reboucherait), remplacé par la clé stable des ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, selectedProjectId, sessions.map((s) => s.sessionId ?? "").join("\u0000")]);

  // Connaissances AUTOMATIQUES sous la forme `PinnedDoc` (même forme que les
  // épinglées, pour réutiliser `buildKnowledgeBlock` tel quel), et la liste
  // réellement injectée au 1er tour = épinglées + auto, dédoublonnée par
  // chemin (un fichier à la fois épinglé et présent dans le dossier auto
  // n'est injecté qu'une fois — voir `dedupDocsByPath`). C'est aussi le
  // compte affiché par le badge de la section « Connaissances ».
  const autoKnowledgeDocs: PinnedDoc[] = autoKnowledgeFiles.map((e) => ({ path: e.path, name: e.name }));
  const injectedKnowledge = dedupDocsByPath([pinnedKnowledge, autoKnowledgeDocs]);

  // R5 — mode connaissances du projet (injection intégrale / RAG, voir
  // RAG_SYSTEM_LINE) : relu depuis la config projet à chaque changement de
  // projet, écrit à la volée par le sélecteur du panneau. Best effort : une
  // config illisible retombe sur "injection" (comportement historique).
  const [knowledgeMode, setKnowledgeMode] = useState<KnowledgeMode>("injection");
  useEffect(() => {
    setKnowledgeMode("injection");
    if (!selectedProjectId) return;
    let cancelled = false;
    readProjectKnowledgeMode(selectedProjectId)
      .then((mode) => {
        if (!cancelled) setKnowledgeMode(mode);
      })
      .catch(() => {
        // config illisible : défaut "injection" déjà posé ci-dessus
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  function changeKnowledgeMode(mode: KnowledgeMode) {
    if (!selectedProjectId) return;
    setKnowledgeMode(mode);
    writeProjectKnowledgeMode(selectedProjectId, mode).catch(() => {
      // écriture config échouée : le mode reste appliqué pour la session en cours
    });
  }

  // R5 — état de l'index d'embeddings du projet (`knowledge.status`) +
  // indexation à la demande (`knowledge.index`, bouton « Indexer maintenant »
  // avec progression). Les chemins épinglés participent à l'index et au
  // calcul de `stale` — le sidecar collecte lui-même automatiques/détectées.
  const [knowledgeIdx, setKnowledgeIdx] = useState<KnowledgeStatus | null>(null);
  const [indexingKnowledge, setIndexingKnowledge] = useState(false);
  const [knowledgeIndexProgress, setKnowledgeIndexProgress] = useState<KnowledgeIndexProgress | null>(null);
  const [knowledgeIndexError, setKnowledgeIndexError] = useState("");
  const pinnedPathsKey = pinnedKnowledge.map((d) => d.path).join("\n");
  const refreshKnowledgeStatus = useCallback(async () => {
    if (!cwd) {
      setKnowledgeIdx(null);
      return;
    }
    try {
      const status = await knowledgeStatus(cwd, pinnedPathsKey.split("\n").filter(Boolean));
      setKnowledgeIdx(status);
    } catch {
      // sidecar pas prêt : pas d'état affiché, le prochain changement retentera
      setKnowledgeIdx(null);
    }
  }, [cwd, pinnedPathsKey]);
  useEffect(() => {
    void refreshKnowledgeStatus();
    // Le premier appel peut partir avant que le sidecar soit prêt (même motif
    // que loadNeutralModels) : re-tenté à chaque « providers poussés ».
    return subscribeProvidersPushed(() => {
      void refreshKnowledgeStatus();
    });
  }, [refreshKnowledgeStatus]);

  async function handleIndexKnowledge() {
    if (!cwd || indexingKnowledge) return;
    setIndexingKnowledge(true);
    setKnowledgeIndexError("");
    setKnowledgeIndexProgress(null);
    try {
      await knowledgeIndex(
        cwd,
        pinnedKnowledge.map((d) => d.path),
        (progress) => setKnowledgeIndexProgress(progress),
      );
      await refreshKnowledgeStatus();
    } catch (err) {
      setKnowledgeIndexError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexingKnowledge(false);
      setKnowledgeIndexProgress(null);
    }
  }

  // Agents déclarés visibles pour le projet courant (portées projet + global
  // + import Claude Code, `invalid` exclus — voir orchestrationClient.ts) :
  // rechargés à chaque changement de `cwd`, plus sur `subscribeProvidersPushed`
  // (même motif que `loadNeutralModels` ci-dessus — le premier appel peut
  // partir avant que le sidecar soit prêt). Auto-correction : si l'agent
  // actuellement sélectionné pour la session en vue n'est plus dans la liste
  // fraîchement reçue (supprimé, ou juste résolu pour la première fois après
  // une restauration), la sélection retombe silencieusement sur « manuel ».
  const [projectAgents, setProjectAgents] = useState<AgentInfo[]>([]);
  const loadProjectAgents = useCallback(async (path: string) => {
    try {
      const list = (await agentsList(path)).filter((a) => !a.invalid);
      setProjectAgents(list);
      setSelectedAgentKey((prev) =>
        prev && !list.some((a) => a.name === prev.name && a.scope === prev.scope) ? null : prev,
      );
    } catch {
      setProjectAgents([]);
    }
  }, []);

  useEffect(() => {
    setProjectAgents([]);
    if (!cwd) return;
    void loadProjectAgents(cwd);
    const off = subscribeProvidersPushed(() => void loadProjectAgents(cwd));
    return off;
  }, [cwd, loadProjectAgents]);

  // Agent réellement APPLIQUÉ (résolution de `selectedAgentKey` contre la
  // liste vivante) : `null` tant que non résolu (liste pas encore chargée,
  // ou agent introuvable — `loadProjectAgents` nettoie alors la sélection
  // sous peu). Les champs Moteur/Modèle/Permission ne se verrouillent que
  // sur cette valeur résolue, jamais sur la seule référence persistée.
  const selectedAgent: AgentInfo | null = selectedAgentKey
    ? (projectAgents.find((a) => a.name === selectedAgentKey.name && a.scope === selectedAgentKey.scope) ?? null)
    : null;

  // Regroupement par portée pour les `optgroup` du sélecteur (Projet / Global / Claude Code).
  const projectAgentsByScope = {
    project: projectAgents.filter((a) => a.scope === "project"),
    global: projectAgents.filter((a) => a.scope === "global"),
    claudeCode: projectAgents.filter((a) => a.scope === "claude-code"),
  };

  useEffect(() => {
    if (stickToBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 48;
  }

  /** Écrit l'entrée `id` dans le document persisté complet (best effort, no-op tant que non hydraté). */
  function persistProject(id: string, liveSessions: ProjectSession[], activeId?: string) {
    // Tant que l'hydratation initiale n'a pas eu lieu, `persistedConversationsRef`
    // ne reflète pas encore le disque : écrire maintenant écraserait une
    // conversation existante avec un état vide/partiel. On saute simplement
    // cette sauvegarde (rien n'est perdu en mémoire, seulement retardé).
    if (!hydrationDoneRef.current) return;
    const next: PersistedConversations = {
      ...persistedConversationsRef.current,
      [id]: buildPersistedEntry({
        sessions: liveSessions,
        // Défaut par REF (voir sessionsRef) : un appel tardif (fin de tour)
        // ne doit pas re-désigner comme active la conversation d'alors.
        activeId: activeId ?? activeSessionIdRef.current,
        openConversationIds: openConversationIdsRef.current,
        openFiles: openFilesRef.current,
        activeTab: activeTabRef.current,
      }),
    };
    persistedConversationsRef.current = next;
    void stateWrite(CONVERSATIONS_STATE_KEY, next).catch(() => {
      // best effort : une écriture ratée ne bloque pas l'UI, la prochaine
      // sauvegarde (debounce ou fin de tour suivant) retentera.
    });
  }

  /**
   * Recombine les sessions du projet courant avec les runtimes VIFS de toutes
   * les conversations ouvertes en onglet — plus seulement de l'active : avec
   * les onglets multiples, plusieurs conversations peuvent avoir avancé
   * (streaming d'arrière-plan) depuis la dernière sauvegarde, et les oublier
   * ici perdrait leurs tours. Les conversations sans runtime (jamais ouvertes
   * cette exécution) sont laissées telles quelles. Le titre auto (non
   * personnalisé) est recalculé au passage.
   */
  function buildLiveSessions(): ProjectSession[] {
    // Lecture par REF (voir sessionsRef) : appelée depuis des callbacks
    // asynchrones longs, cette fonction doit repartir de la liste À JOUR, pas
    // de celle capturée au montage de la closure.
    const activeId = activeSessionIdRef.current;
    return sessionsRef.current.map((s) => {
      const runtime = runtimesRef.current.get(s.id);
      if (!runtime) return s;
      const merged: ProjectSession = {
        ...s,
        turns: runtime.turns,
        sessionId: runtime.sessionId,
        // R2 — l'affinité de session vit dans le runtime (posée au premier
        // envoi routé, effacée par un override) : recopiée pour persistance.
        routedTier: runtime.routedTier,
        routedTarget: runtime.routedTarget,
        // La config LLM (moteur/modèle/agent) n'est éditable que pour la
        // conversation active : ne l'écrase que pour celle-là (`activeId` par
        // ref — depuis un callback tardif, l'active a pu changer, et écrire la
        // config affichée sur l'ANCIENNE active lui volerait son moteur).
        ...(s.id === activeId
          ? { engine: { providerId: engineProviderId, model }, selectedAgent: selectedAgentKey }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      return merged.titleCustom ? merged : { ...merged, title: deriveSessionTitle(merged.turns) };
    });
  }

  // Chargement du document persisté, une seule fois (StrictMode-safe : même
  // pattern que useProjects/useProviders — le `ref` évite un double appel au
  // double montage/démontage de dev, l'état du composant survit à ce cycle).
  useEffect(() => {
    if (stateInitRef.current) return;
    stateInitRef.current = true;
    stateRead<unknown>(CONVERSATIONS_STATE_KEY)
      .then((raw) => {
        persistedConversationsRef.current = sanitizePersistedConversations(raw);
      })
      .catch(() => {
        persistedConversationsRef.current = {};
      })
      .finally(() => setStatePhase("loaded"));
  }, []);

  // Hydratation : une fois le document persisté ET le registre de projets
  // chargés, on nettoie les entrées orphelines (projet supprimé du
  // registre) et on peuple la Map en mémoire pour chaque projet. Ne tourne
  // qu'une fois (`hydrationDoneRef`).
  useEffect(() => {
    if (hydrationDoneRef.current) return;
    if (statePhase !== "loaded" || projectsLoadState !== "ready") return;
    hydrationDoneRef.current = true;

    const raw = persistedConversationsRef.current;
    const validIds = new Set(projects.map((p) => p.id));
    const cleaned: PersistedConversations = {};
    let removedAny = false;
    for (const [id, entry] of Object.entries(raw)) {
      if (validIds.has(id)) cleaned[id] = entry;
      else removedAny = true;
    }
    persistedConversationsRef.current = cleaned;

    for (const [id, entry] of Object.entries(cleaned)) {
      // Ne pas écraser un état déjà présent en mémoire (session en cours
      // dans cet onglet avant même la fin de ce chargement disque).
      if (projectStatesRef.current.has(id)) continue;
      projectStatesRef.current.set(id, projectStateFromPersisted(entry, pendingLazyLoadsRef.current));
    }

    if (removedAny) {
      void stateWrite(CONVERSATIONS_STATE_KEY, cleaned).catch(() => {});
    }

    // Course possible avec l'auto-sélection ci-dessous : si un projet a déjà
    // été choisi (état vierge, faute de mieux) avant que ce chargement
    // disque arrive, on hydrate l'affichage a posteriori — seulement si rien
    // n'a encore été fait dessus, pour ne jamais écraser une conversation
    // démarrée entre-temps par l'utilisateur.
    if (selectedProjectId && cleaned[selectedProjectId] && turns.length === 0 && sessionId === null) {
      const restored = projectStatesRef.current.get(selectedProjectId);
      if (restored?.sessions.some((s) => s.id === restored.activeId)) {
        loadProjectStateIntoView(restored);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statePhase, projectsLoadState, projects, selectedProjectId]);

  // Sauvegarde débouncée (~1,5 s) après tout changement pertinent du projet
  // affiché. Dépend des chemins des onglets ouverts (pas de leur contenu :
  // seuls les chemins sont persistés) via une clé stable plutôt que le
  // tableau `openFiles` complet, pour ne pas redémarrer le minuteur à chaque
  // frappe dans l'éditeur de fichier.
  const openFilePathsKey = openFiles.map((f) => f.path).join("\u0000");
  useEffect(() => {
    if (!selectedProjectId || !activeSessionId) return;
    const timer = window.setTimeout(() => {
      const liveSessions = buildLiveSessions();
      // Répercuté dans l'état affiché (pas seulement sur disque) : le
      // panneau « Sessions » reflète ainsi le titre auto/la date « mis à
      // jour » sans attendre une bascule. `sessions` n'est pas dans les
      // dépendances de cet effet (sinon boucle) — désactivé ci-dessous,
      // même pattern que le reste de ce fichier pour ce type d'effet.
      setSessions(liveSessions);
      persistProject(selectedProjectId, liveSessions, activeSessionId);
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedProjectId,
    activeSessionId,
    turns,
    sessionId,
    openFilePathsKey,
    activeTab,
    engineProviderId,
    model,
    selectedAgentKey,
  ]);

  /** Charge un `ProjectState` restauré (ou vierge) dans l'affichage — onglets ouverts, session active, liste complète. */
  function loadProjectStateIntoView(next: ProjectState) {
    const activeSession = next.sessions.find((s) => s.id === next.activeId) ?? next.sessions[0];
    // Runtimes repartis de zéro : on change de PROJET, aucune conversation de
    // l'ancien ne doit rester vivante (leurs tours viennent d'être sauvegardés
    // par l'appelant). Ceux des conversations ouvertes sont amorcés depuis
    // leur dernière copie persistée.
    runtimesRef.current = new Map();
    for (const conv of next.sessions) {
      if (next.openConversationIds.includes(conv.id)) {
        runtimesRef.current.set(conv.id, freshRuntime(conv.turns, conv.sessionId, conv.routedTier, conv.routedTarget));
      }
    }
    setSessions(next.sessions);
    setActiveSessionId(activeSession.id);
    setOpenConversationIds(next.openConversationIds);
    setOpenFiles(next.openFiles);
    setActiveTab(next.activeTab);
    setEngineProviderId(activeSession.engine.providerId);
    setModel(activeSession.engine.model);
    // Résolution différée (voir le commentaire de `loadProjectAgents`) : au
    // moment d'une bascule de PROJET, `projectAgents` correspond encore à
    // l'ancien projet — c'est l'effet déclenché par le changement de `cwd`
    // qui validera cette sélection une fois la nouvelle liste chargée.
    setSelectedAgentKey(activeSession.selectedAgent);
  }

  // Aucun projet sélectionné mais la liste n'est plus vide (chargement
  // initial, ou projet précédemment sélectionné supprimé ci-dessous) : on
  // rouvre le DERNIER projet utilisé s'il existe encore, sinon le premier
  // déclaré. On attend d'avoir lu le disque (`lastProjectLoaded`) pour ne pas
  // ouvrir le premier projet puis basculer — ce qui ferait clignoter l'écran
  // et chargerait inutilement l'état du mauvais projet.
  useEffect(() => {
    if (selectedProjectId !== null || projects.length === 0 || !lastProjectLoaded) return;
    const remembered = lastProjectIdRef.current;
    const id = remembered && projects.some((p) => p.id === remembered) ? remembered : projects[0].id;
    setSelectedProjectId(id);
    // Réaligne la mémoire quand le projet retenu n'existe plus (supprimé).
    if (id !== remembered) rememberLastProject(id);
    loadProjectStateIntoView(projectStatesRef.current.get(id) ?? emptyProjectState());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, selectedProjectId, lastProjectLoaded]);

  // Le projet sélectionné a été supprimé depuis Configuration : on efface
  // son état mémorisé (mémoire + disque) et on repart d'aucune sélection
  // (l'effet ci-dessus choisira un autre projet, s'il en reste).
  useEffect(() => {
    if (selectedProjectId !== null && !projects.some((p) => p.id === selectedProjectId)) {
      projectStatesRef.current.delete(selectedProjectId);
      if (selectedProjectId in persistedConversationsRef.current) {
        const next = { ...persistedConversationsRef.current };
        delete next[selectedProjectId];
        persistedConversationsRef.current = next;
        void stateWrite(CONVERSATIONS_STATE_KEY, next).catch(() => {});
      }
      setSelectedProjectId(null);
      runtimesRef.current = new Map();
      setSessions([]);
      setActiveSessionId("");
      setOpenConversationIds([]);
      setOpenFiles([]);
      setActiveTab(EMPTY_TAB);
      setPermissionQueue([]);
      setEngineProviderId(null);
      setModel("");
      setSelectedAgentKey(null);
    }
  }, [projects, selectedProjectId]);

  function selectProject(id: string) {
    if (streaming || id === selectedProjectId) return;
    if (selectedProjectId) {
      const liveSessions = buildLiveSessions();
      projectStatesRef.current.set(selectedProjectId, {
        sessions: liveSessions,
        activeId: activeSessionId,
        openConversationIds,
        openFiles,
        activeTab,
      });
      persistProject(selectedProjectId, liveSessions, activeSessionId);
    }
    setSelectedProjectId(id);
    rememberLastProject(id);
    loadProjectStateIntoView(projectStatesRef.current.get(id) ?? emptyProjectState());
    setPermissionQueue([]);
    clearAttachments();
    setOpenFilesNotice(null);
    setConfirmDeleteSessionId(null);
    setEditingSessionId(null);
    // Changement de projet : bandeau et filet d'annulation du vidage sans objet
    // (ils concernaient une conversation de l'ancien projet).
    setClearedNotice(false);
    clearedBackupRef.current = null;
  }

  /**
   * Sélection d'un agent (section LLM, au-dessus de « Moteur ») : applique
   * moteur/modèle (si non `null`)/mode de permission — les instructions et
   * `maxTurns` sont relus depuis `selectedAgent` au moment de l'envoi (voir
   * `sendViaClaudeEngine`/`sendViaNeutralEngine`), pas recopiés ici. `""` =
   * retour au mode manuel (`clearAgentSelection`).
   */
  /** R2/R7 — efface plancher + cible de session de la conversation active (override du mode Auto). */
  function clearRoutedAffinity() {
    if (!activeSessionId) return;
    updateRuntime(activeSessionId, (r) => ({ ...r, routedTier: null, routedTarget: null, routedReasons: null }));
  }

  function handleAgentSelectChange(value: string) {
    if (streaming) return;
    if (!value) {
      setSelectedAgentKey(null);
      return;
    }
    const sep = value.indexOf("::");
    const scope = value.slice(0, sep) as AgentScope;
    const name = value.slice(sep + 2);
    const agent = projectAgents.find((a) => a.scope === scope && a.name === name);
    if (!agent) return;
    setSelectedAgentKey({ name: agent.name, scope: agent.scope });
    // R2 — agent `engine: auto` : moteur/modèle choisis par le routeur à
    // l'envoi (sentinelle Auto armée) ; sinon config explicite de l'agent.
    if (agent.engine === "auto") {
      setEngineProviderId(null);
      setModel(AUTO_MODEL);
    } else {
      setEngineProviderId(agent.engine === "neutral" ? agent.provider : null);
      if (agent.model !== null) setModel(agent.model);
      // Config explicite = override : le prochain envoi ne re-route pas.
      clearRoutedAffinity();
    }
    setPermissionMode(agent.permissionMode);
    // Le moteur neutre ne supporte pas les pièces jointes (voir le contrat), et
    // le mode Auto peut y router : on ne garde jamais un brouillon en attente
    // pour le mauvais moteur.
    if (agent.engine !== "claude") clearAttachments();
  }

  /** Retombe en mode manuel : les champs restent aux dernières valeurs appliquées, mais redeviennent éditables. */
  function clearAgentSelection() {
    if (streaming) return;
    setSelectedAgentKey(null);
  }

  /** Bascule de moteur depuis le sélecteur toolbar : réinitialise le modèle (repris par `loadNeutralModels` si moteur neutre). */
  function handleEngineChange(value: string) {
    if (streaming || selectedAgent !== null) return;
    const next = value === "" ? null : value;
    setEngineProviderId(next);
    setModel("");
    // R2 — changer de moteur = choix explicite : l'affinité de routage tombe.
    clearRoutedAffinity();
    if (next === null) {
      setNeutralModels([]);
      setNeutralModelsState("idle");
      setNeutralModelsError("");
    } else {
      // Bascule vers le moteur neutre : pas de pièces jointes possibles (voir le contrat).
      clearAttachments();
    }
  }

  /**
   * Crée une nouvelle session d'historique pour le projet courant — l'ancienne
   * reste consultable dans le panneau « Sessions ». Renvoie `false` si refusée
   * (run en cours, ou aucun projet sélectionné) — voir `AgentPageHandle.newSession`,
   * qui s'appuie sur cette même fonction depuis le raccourci global Ctrl+N.
   */
  function handleNewSession(): boolean {
    if (!selectedProjectId) return false;
    // Session courante déjà vierge (aucun tour, titre jamais personnalisé) :
    // en créer une seconde ne ferait qu'empiler des « Nouvelle session »
    // identiques dans l'historique. On réutilise celle-ci.
    const current = sessions.find((s) => s.id === activeSessionId);
    if (current && turns.length === 0 && !current.titleCustom) {
      // Son onglet a pu être fermé (Ctrl+Suppr) : il faut le rouvrir, sinon
      // « + »/Ctrl+N resteraient sans effet visible.
      if (!openConversationIds.includes(current.id)) {
        ensureRuntime(current);
        setOpenConversationIds((prev) => [...prev, current.id]);
      }
      setActiveTab(convTabId(current.id));
      // Réutilisation après un Ctrl+K : l'utilisateur repart sur une session
      // « neuve » — le bandeau d'annulation du vidage n'a plus sa place (un
      // « Annuler » ici ressusciterait les anciens tours dans ce qu'il
      // considère comme une conversation vierge).
      setClearedNotice(false);
      clearedBackupRef.current = null;
      focusComposer();
      return true;
    }
    const liveSessions = buildLiveSessions();
    const fresh: ProjectSession = { ...freshSession(), engine: { providerId: engineProviderId, model } };
    // Purge des sessions vides laissées par d'anciennes créations répétées —
    // en épargnant celles ouvertes en onglet (les fermer sous les pieds de
    // l'utilisateur serait brutal) et celles en cours de streaming.
    const kept = liveSessions.filter(
      (s) =>
        s.id === activeSessionId ||
        s.turns.length > 0 ||
        s.titleCustom ||
        openConversationIds.includes(s.id) ||
        runtimesRef.current.get(s.id)?.streaming === true,
    );
    const nextSessions = [...kept, fresh];
    runtimesRef.current.set(fresh.id, freshRuntime());
    setSessions(nextSessions);
    setActiveSessionId(fresh.id);
    // Ouverte dans un NOUVEL onglet, à la suite : les conversations déjà
    // ouvertes le restent (c'est tout l'objet des onglets multiples).
    setOpenConversationIds((prev) => [...prev, fresh.id]);
    setActiveTab(convTabId(fresh.id));
    setConfirmDeleteSessionId(null);
    setClearedNotice(false);
    setSelectedAgentKey(null);
    clearAttachments();
    persistProject(selectedProjectId, nextSessions, fresh.id);
    focusComposer();
    return true;
  }

  /**
   * Vide les tours de la session ACTIVE, sans en créer de nouvelle — la
   * session garde son id, son titre et sa config LLM (moteur/modèle/agent).
   * Utilisée par le raccourci global Ctrl+K (voir `AgentPageHandle.clearConversation`
   * dans App.tsx) : contrairement à `handleNewSession`, aucune entrée
   * supplémentaire n'apparaît dans le panneau « Sessions ». Renvoie `false`
   * si refusée (run en cours, ou aucun projet sélectionné).
   */
  /**
   * Place le curseur dans le composeur. `requestAnimationFrame` : appelé juste
   * après un changement d'onglet/de page, le textarea peut ne pas être encore
   * visible (slot masqué) — un focus posé trop tôt serait ignoré.
   */
  function focusComposer() {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function clearConversation(): boolean {
    if (!selectedProjectId || !activeSessionId) return false;
    if (streaming) {
      // Refus silencieux inacceptable au clavier (Ctrl+K) : sans retour
      // visible, l'utilisateur croit que « vider » est cassé (même principe
      // que closeConversationTab).
      setOpenFilesNotice("Conversation en cours : arrêtez le tour avant de la vider.");
      return false;
    }
    // Vider écrase ET persiste : sans filet, les messages seraient perdus sans
    // recours. On mémorise l'état d'avant pour permettre une annulation
    // immédiate (bandeau « Annuler »), ce qui évite une modale de confirmation
    // à chaque Ctrl+K. `convId` : voir la déclaration de `clearedBackupRef`.
    clearedBackupRef.current = {
      convId: activeSessionId,
      turns,
      sessionId,
      routedTier: activeRuntime.routedTier,
      routedTarget: activeRuntime.routedTarget,
    };
    // R2 — conversation vidée = repart de zéro : le prochain envoi en Auto re-route.
    updateRuntime(activeSessionId, (r) => ({
      ...r,
      turns: [],
      sessionId: null,
      mcpUsage: {},
      routedTier: null,
      routedTarget: null,
      routedReasons: null,
    }));
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    setPermissionQueue([]);
    setConfirmDeleteSessionId(null);
    persistProject(selectedProjectId, liveSessions, activeSessionId);
    setClearedNotice(true);
    focusComposer();
    return true;
  }

  /**
   * Restaure la conversation vidée juste avant (bandeau « Annuler ») — DANS la
   * conversation d'origine (`backup.convId`), qui peut ne plus être l'active.
   * Refus si elle a été supprimée entre-temps, ou si un tour y a redémarré
   * (écraser un stream en cours serait pire que de perdre l'annulation).
   */
  function undoClearConversation() {
    const backup = clearedBackupRef.current;
    if (!backup || !selectedProjectId) return;
    if (runtimesRef.current.get(backup.convId)?.streaming) return;
    clearedBackupRef.current = null;
    setClearedNotice(false);
    if (!sessions.some((s) => s.id === backup.convId)) return;
    updateRuntime(backup.convId, (r) => ({
      ...r,
      turns: backup.turns,
      sessionId: backup.sessionId,
      routedTier: backup.routedTier,
      routedTarget: backup.routedTarget,
    }));
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    persistProject(selectedProjectId, liveSessions, activeSessionId);
  }

  /**
   * Ouvre une session en onglet et l'active (ou la réactive si déjà ouverte).
   * Plus aucun verrou de streaming ici, contrairement à la version
   * mono-conversation : chaque conversation a son propre runtime, basculer
   * n'écrase donc plus l'état d'un tour en cours — c'est même l'intérêt des
   * onglets (partir travailler ailleurs pendant qu'un agent tourne).
   */
  function selectSession(id: string) {
    if (!selectedProjectId) return;
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    const target = liveSessions.find((s) => s.id === id);
    if (!target) return;
    // Amorce le runtime depuis la dernière copie connue UNIQUEMENT si cette
    // conversation n'a pas déjà un runtime vivant : réactiver l'onglet d'un
    // tour en cours ne doit jamais le réinitialiser.
    ensureRuntime(target);
    setActiveSessionId(id);
    setOpenConversationIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveTab(convTabId(id));
    setEngineProviderId(target.engine.providerId);
    setModel(target.engine.model);
    // Même projet : `projectAgents` est déjà à jour, résolution immédiate.
    setSelectedAgentKey(resolveAgentSelection(target.selectedAgent, projectAgents));
    clearAttachments();
    setConfirmDeleteSessionId(null);
    // Le bandeau « Conversation vidée / Annuler » parle de la conversation
    // qu'on QUITTE : affiché sous une autre, il sème la confusion (l'undo est
    // ciblé, mais l'utilisateur ne peut pas le savoir).
    setClearedNotice(false);
    persistProject(selectedProjectId, liveSessions, id);
    focusComposer();
  }

  /** Renomme une session (titre personnalisé — n'est plus jamais recalculé automatiquement). */
  function renameSession(id: string, title: string) {
    if (!selectedProjectId) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    const liveSessions = buildLiveSessions().map((s) =>
      s.id === id ? { ...s, title: trimmed, titleCustom: true } : s,
    );
    setSessions(liveSessions);
    persistProject(selectedProjectId, liveSessions, activeSessionId);
  }

  /** Supprime une session (définitif — confirmation à la charge de l'appelant, voir le panneau « Sessions »). */
  function deleteSession(id: string) {
    // Refus si CETTE conversation a un tour en cours (les autres peuvent
    // continuer de streamer sans que ça pose problème).
    if (!selectedProjectId || runtimesRef.current.get(id)?.streaming) return;
    const liveSessions = buildLiveSessions();
    const remaining = liveSessions.filter((s) => s.id !== id);
    const finalSessions = remaining.length > 0 ? remaining : [freshSession()];
    runtimesRef.current.delete(id);
    setSessions(finalSessions);
    const nextOpen = openConversationIds.filter((c) => c !== id && finalSessions.some((s) => s.id === c));
    setOpenConversationIds(nextOpen);
    if (id === activeSessionId) {
      setClearedNotice(false);
      const nextActive = finalSessions.find((s) => s.id === nextOpen[nextOpen.length - 1]) ?? finalSessions[0];
      ensureRuntime(nextActive);
      setActiveSessionId(nextActive.id);
      setOpenConversationIds(nextOpen.includes(nextActive.id) ? nextOpen : [...nextOpen, nextActive.id]);
      setActiveTab(convTabId(nextActive.id));
      setEngineProviderId(nextActive.engine.providerId);
      setModel(nextActive.engine.model);
      setSelectedAgentKey(resolveAgentSelection(nextActive.selectedAgent, projectAgents));
      persistProject(selectedProjectId, finalSessions, nextActive.id);
    } else {
      persistProject(selectedProjectId, finalSessions, activeSessionId);
    }
  }

  /**
   * Ferme l'onglet d'une conversation SANS la supprimer (elle reste dans le
   * panneau « Sessions »). Son runtime est abandonné : ses tours viennent
   * d'être recopiés dans `sessions` par `buildLiveSessions`. Un tour en cours
   * serait perdu de vue, donc on refuse tant qu'il streame.
   */
  function closeConversationTab(id: string) {
    if (!selectedProjectId) return;
    if (runtimesRef.current.get(id)?.streaming) {
      // Refus silencieux inacceptable au clavier (Ctrl+Suppr) : l'utilisateur
      // ne verrait rien se passer. Le bouton « × » est lui déjà désactivé.
      setOpenFilesNotice("Conversation en cours : arrêtez le tour avant de fermer son onglet.");
      return;
    }
    setOpenFilesNotice(null);
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    runtimesRef.current.delete(id);
    const nextOpen = openConversationIds.filter((c) => c !== id);
    setOpenConversationIds(nextOpen);

    // Conversation qui devient active : inchangée si on ferme un AUTRE onglet,
    // sinon l'onglet voisin (le précédent, à défaut le premier restant).
    let nextActiveId = activeSessionId;
    if (activeSessionId === id) {
      // Bascule de conversation active : le bandeau « Conversation vidée /
      // Annuler » parlait de celle qu'on quitte (voir selectSession).
      setClearedNotice(false);
      const idx = openConversationIds.indexOf(id);
      const neighbour = nextOpen[Math.max(0, idx - 1)];
      const target = neighbour ? liveSessions.find((s) => s.id === neighbour) : undefined;
      if (target) {
        ensureRuntime(target);
        nextActiveId = target.id;
        setActiveSessionId(target.id);
        setActiveTab(convTabId(target.id));
        setEngineProviderId(target.engine.providerId);
        setModel(target.engine.model);
        setSelectedAgentKey(resolveAgentSelection(target.selectedAgent, projectAgents));
      } else {
        // Dernier onglet de conversation fermé : on en rouvre aussitôt un
        // vierge plutôt que de laisser l'écran vide — même effet visible que
        // Ctrl+K, mais non destructif (la conversation fermée reste dans le
        // panneau « Sessions »). Sans cela l'utilisateur se retrouvait sans
        // conversation ET sans moyen d'en rouvrir une.
        const fresh: ProjectSession = { ...freshSession(), engine: { providerId: engineProviderId, model } };
        // Purge des sessions vides au passage (celle qu'on vient de fermer si
        // elle n'avait aucun tour), comme le fait `handleNewSession`.
        const kept = liveSessions.filter(
          (s) => s.turns.length > 0 || s.titleCustom || runtimesRef.current.get(s.id)?.streaming === true,
        );
        const withFresh = [...kept, fresh];
        runtimesRef.current.set(fresh.id, freshRuntime());
        setSessions(withFresh);
        setOpenConversationIds([fresh.id]);
        setActiveSessionId(fresh.id);
        setActiveTab(convTabId(fresh.id));
        setSelectedAgentKey(null);
        clearAttachments();
        persistProject(selectedProjectId, withFresh, fresh.id);
        focusComposer();
        return;
      }
    }
    persistProject(selectedProjectId, liveSessions, nextActiveId);
  }

  /** Conversation suivante/précédente dans la barre d'onglets (Ctrl+Tab / Ctrl+Maj+Tab). */
  function cycleConversation(direction: 1 | -1) {
    if (openConversationIds.length < 2) return;
    const idx = openConversationIds.indexOf(activeSessionId);
    const base = idx === -1 ? 0 : idx;
    const next = openConversationIds[(base + direction + openConversationIds.length) % openConversationIds.length];
    selectSession(next);
  }

  function startEditSessionTitle(session: ProjectSession) {
    if (streaming) return;
    setEditingSessionId(session.id);
    setEditingSessionTitle(session.title);
  }

  function cancelEditSessionTitle() {
    sessionTitleSkipBlurRef.current = true;
    setEditingSessionId(null);
  }

  function commitEditSessionTitle() {
    if (sessionTitleSkipBlurRef.current) {
      // Provient du `blur` déclenché par le démontage du champ sur Échap : ignoré.
      sessionTitleSkipBlurRef.current = false;
      return;
    }
    if (!editingSessionId) return;
    const id = editingSessionId;
    const value = editingSessionTitle;
    setEditingSessionId(null);
    renameSession(id, value);
  }


  /**
   * Reconstruit l'historique `messages` pour le moteur neutre depuis les
   * tours du projet courant : rôle `user` = son contenu ; rôle `assistant` =
   * concaténation des blocs `text` uniquement (les blocs `thinking`/`tool`
   * n'ont pas d'équivalent dans le dialecte OpenAI-compatible) ; les tours
   * `error` sont sautés (contenu potentiellement vide/partiel). Le moteur
   * neutre n'a pas d'état de session (voir docs/protocol.md, Lot 6) : cet
   * historique complet est renvoyé à CHAQUE tour.
   */
  function buildNeutralMessages(history: AgentTurn[], newContent: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const turn of history) {
      if (turn.status === "error") continue;
      if (turn.role === "user") {
        messages.push({ role: "user", content: turn.content ?? "" });
      } else {
        const text = (turn.blocks ?? [])
          .filter((b): b is Extract<AgentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.content)
          .join("");
        messages.push({ role: "assistant", content: text });
      }
    }
    messages.push({ role: "user", content: newContent });
    return messages;
  }

  /**
   * Préfixe `messages` d'un message `system` portant les instructions de
   * l'agent sélectionné (moteur neutre) — sans effet si l'agent n'en a pas
   * (chaîne vide) ou si un message `system` est déjà en tête (jamais le cas
   * ici, `buildNeutralMessages` n'en produit pas, mais reste défensif comme
   * demandé par la spec O2).
   */
  function withAgentSystemPrompt(messages: ChatMessage[], instructions: string | undefined): ChatMessage[] {
    if (!instructions || messages[0]?.role === "system") return messages;
    return [{ role: "system", content: instructions }, ...messages];
  }

  /**
   * R5 — instructions système effectives du tour : celles de l'agent
   * sélectionné, plus la ligne RAG quand le mode connaissances du projet est
   * `rag` (voir RAG_SYSTEM_LINE — remplace l'injection intégrale au 1er tour).
   * `undefined` = aucune instruction (comportement historique inchangé).
   */
  function composeSystemInstructions(): string | undefined {
    const parts = [
      selectedAgent?.instructions,
      // La ligne RAG n'est injectée que si l'index EXISTE réellement
      // (`knowledge.status`) : sans index, promettre `search_knowledge` au
      // modèle ne mènerait qu'à des appels d'outil vides.
      knowledgeMode === "rag" && knowledgeIdx?.exists ? RAG_SYSTEM_LINE : undefined,
    ].filter((p): p is string => typeof p === "string" && p.length > 0);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  /** Lance le tour via le moteur Claude (Agent SDK) — `systemPrompt` armé par l'agent sélectionné, s'il y en a un.
   * R2 — `modelId`/`meta` figés par `handleSend` (modèle du sélecteur, ou cible routée en mode Auto + routeTier). */
  function sendViaClaudeEngine(
    content: string,
    assistantId: string,
    common: {
      onText: (delta: string) => void;
      onToolUse: (toolUseId: string, toolName: string, toolInput: unknown) => void;
      onToolResult: (toolUseId: string, isError: boolean, summary: string) => void;
    },
    attachments: ChatAttachment[] | undefined,
    /** Conversation propriétaire du tour — voir `handleSend` : tous les callbacks écrivent ici, pas dans « l'active ». */
    convId: string,
    modelId: string | null,
    meta: RequestMeta,
  ) {
    const handle = claudeStart(
      {
        cwd,
        prompt: content,
        // Session serveur de CETTE conversation (le `sessionId` dérivé de
        // l'active serait le mauvais si l'utilisateur a changé d'onglet).
        sessionId: getRuntime(convId).sessionId,
        model: modelId,
        permissionMode,
        // R5 — instructions de l'agent + ligne RAG éventuelle (mode `rag`).
        systemPrompt: composeSystemInstructions() ?? null,
        attachments,
        meta,
      },
      {
        onInit: (sid) => updateRuntime(convId, (r) => ({ ...r, sessionId: sid })),
        onText: common.onText,
        onThinking: (delta) =>
          updateTurnsFor(convId, (prev) => withBlocks(prev, assistantId, (b) => appendToLastBlock(b, "thinking", delta))),
        onToolUse: common.onToolUse,
        onToolResult: common.onToolResult,
        onBackgroundTasks: (count, descriptions) =>
          updateTurnsFor(convId, (prev) =>
            prev.map((t) =>
              t.id === assistantId
                ? {
                    ...t,
                    backgroundTasks:
                      count > 0
                        ? { count, descriptions, waiting: t.backgroundTasks?.waiting === true }
                        : undefined,
                  }
                : t,
            ),
          ),
        onBackgroundWait: (count, descriptions) =>
          updateTurnsFor(convId, (prev) =>
            prev.map((t) => (t.id === assistantId ? { ...t, backgroundTasks: { count, descriptions, waiting: true } } : t)),
          ),
        onPermissionRequest: (permissionId, toolName, toolInput) => {
          // Outil mémorisé (« ne plus demander ») : auto-autorisation sans modale.
          if (autoAllowToolsRef.current.has(toolName)) {
            void claudePermission(handle.id, permissionId, "allow");
            return;
          }
          setPermissionQueue((prev) => [...prev, { targetId: handle.id, permissionId, toolName, toolInput, engine: "claude" }]);
        },
      },
    );
    return handle;
  }

  /** Lance le tour via le moteur neutre (Ollama/OpenRouter/custom) — même contrat de chunks que Claude, sans état de session. `maxTurns` armé par l'agent sélectionné, s'il y en a un.
   * R2 — `modelId`/`meta` figés par `handleSend` (modèle du sélecteur, ou cible routée en mode Auto + routeTier). */
  function sendViaNeutralEngine(
    providerId: string,
    historyMessages: ChatMessage[],
    common: {
      onText: (delta: string) => void;
      onToolUse: (toolUseId: string, toolName: string, toolInput: unknown) => void;
      onToolResult: (toolUseId: string, isError: boolean, summary: string) => void;
    },
    modelId: string,
    meta: RequestMeta,
  ) {
    // Le mode « plan » n'existe pas côté neutre (garde-fou : le sélecteur le
    // désactive déjà pour ce moteur, mais un état résiduel est possible).
    const neutralPermissionMode = permissionMode === "plan" ? "default" : permissionMode;
    const handle = neutralStart(
      {
        providerId,
        model: modelId,
        cwd,
        messages: historyMessages,
        permissionMode: neutralPermissionMode,
        maxTurns: selectedAgent?.maxTurns ?? undefined,
        meta,
      },
      {
        onText: common.onText,
        onToolUse: common.onToolUse,
        onToolResult: common.onToolResult,
        onPermissionRequest: (permissionId, toolName, toolInput) => {
          if (autoAllowToolsRef.current.has(toolName)) {
            void neutralPermission(handle.id, permissionId, "allow");
            return;
          }
          setPermissionQueue((prev) => [...prev, { targetId: handle.id, permissionId, toolName, toolInput, engine: "neutral" }]);
        },
      },
    );
    return handle;
  }

  /** R2 — cible utilisable : moteur Claude (toujours disponible) ou fournisseur déclaré. */
  function isUsableTarget(target: RouteTarget): boolean {
    return target.engine === "claude" || providers.some((p) => p.id === target.providerId);
  }

  /** R3 — libellé court de l'état de débord, ajouté aux raisons (infobulle du badge). */
  function debordReason(debord: RouteDebord): string {
    return debord.active
      ? `débord : fenêtre 5 h à ${Math.round(debord.fiveHourPct ?? 0)} %`
      : "plafond débord atteint : repli local";
  }

  /**
   * R2/R7 — résout la cible d'un tour « Auto » de la page Projets, stratégie
   * DESCENDANTE (spec-r7-topdown §C) : PAS de classification du prompt. Le
   * premier tour d'une session Auto part au SOMMET de la table — tier
   * `complexe` IMPOSÉ à `router.route` (mécanique R3), avec le `cwd` du
   * projet pour que la surcharge `.iaction/routage.yaml` s'applique ;
   * débord et plafond s'appliquent normalement. Les tours suivants
   * réutilisent l'affinité de session : la session RESTE au sommet, AUCUNE
   * descente automatique (descendre = choix manuel du sélecteur) — le
   * plancher montant du Chat (§B) ne s'applique pas ici. Pour une cible
   * abonnement, l'état de débord est re-vérifié à CHAQUE tour via
   * `router.route` à tier IMPOSÉ (aucune re-classification) ; un tour
   * débordé/bloqué ne fixe JAMAIS l'affinité. Repli si la cible neutre
   * référence un fournisseur absent de la table déclarée : tier supérieur,
   * premier utilisable (sans objet au sommet `complexe` — gardé par symétrie
   * avec ChatPage) ; si aucun ne l'est, la cible d'origine est gardée et
   * l'erreur habituelle du moteur s'affichera.
   */
  async function resolveAutoRoute(
    convId: string,
    content: string,
  ): Promise<{
    tier: RouteTier;
    target: RouteTarget;
    reasons: string[];
    debord: RouteDebord | null;
    /** Affinité à mémoriser au PREMIER signe de succès du tour (voir `handleSend`) — jamais posée ici. */
    pendingAffinity: boolean;
    /** Débord annulé : sa cible référence un fournisseur non déclaré (bandeau dédié, tour sur l'abonnement). */
    debordUnconfigured: boolean;
  }> {
    const runtime = getRuntime(convId);
    if (runtime.routedTier && runtime.routedTarget) {
      const affinityReasons =
        runtime.routedReasons ?? ["affinité de session (cible mémorisée au premier envoi)"];
      // R3 — cible abonnement : re-vérification du débord à CHAQUE tour, tier
      // IMPOSÉ (aucune re-classification).
      if (runtime.routedTarget.engine === "claude") {
        try {
          const check = await routerRoute({ text: content, tier: runtime.routedTier, ...(cwd ? { cwd } : {}) });
          if (check.debord) {
            // Cible de débord jamais validée jusqu'ici : si son fournisseur
            // n'est PAS déclaré, on n'envoie pas vers un provider inconnu —
            // le tour reste sur la cible abonnement d'origine, sans débord.
            if (check.debord.active && !isUsableTarget(check.target)) {
              return {
                tier: runtime.routedTier,
                target: runtime.routedTarget,
                reasons: [...affinityReasons, "cible de débord non configurée : envoi sur l'abonnement"],
                debord: null,
                pendingAffinity: false,
                debordUnconfigured: true,
              };
            }
            return {
              tier: runtime.routedTier,
              target: check.target,
              reasons: [...affinityReasons, debordReason(check.debord)],
              debord: check.debord,
              pendingAffinity: false,
              debordUnconfigured: false,
            };
          }
        } catch {
          // Sidecar antérieur à R3 ou injoignable : affinité telle quelle.
        }
      }
      return {
        tier: runtime.routedTier,
        target: runtime.routedTarget,
        reasons: affinityReasons,
        debord: null,
        pendingAffinity: false,
        debordUnconfigured: false,
      };
    }

    // R7 §C — premier tour d'une session Auto : tier `complexe` IMPOSÉ
    // (aucune classification du prompt), le sommet de la table.
    const routed = await routerRoute({
      text: content,
      tier: "complexe",
      ...(cwd ? { cwd } : {}),
    });

    let tier = routed.tier;
    let target = routed.target;
    let debord = routed.debord;
    // Raison lisible du badge : la mention protocolaire du tier imposé est
    // remplacée par l'explication de la stratégie.
    const reasons = [
      "stratégie descendante : premier tour au sommet de la table (complexe)",
      ...routed.reasons.filter((r) => r !== "tier imposé par l'appelant"),
    ];
    let debordUnconfigured = false;
    // Débord actif vers un fournisseur NON déclaré : jamais d'envoi vers un
    // provider inconnu — repli sur la cible abonnement d'origine (table du
    // tier), débord annulé, bandeau dédié.
    if (debord?.active && !isUsableTarget(target)) {
      target = mergeRoutingTable(await readRoutingTable())[tier];
      reasons.push("cible de débord non configurée : envoi sur l'abonnement");
      debord = null;
      debordUnconfigured = true;
    }
    // R3 — cible de débord/repli plafond : pas de repli tier supérieur (elle
    // ne vient pas de la table), l'erreur moteur habituelle s'afficherait.
    if (!debord && !isUsableTarget(target)) {
      const table = mergeRoutingTable(await readRoutingTable());
      for (let i = ROUTE_TIERS.indexOf(routed.tier) + 1; i < ROUTE_TIERS.length; i++) {
        const candidate = table[ROUTE_TIERS[i]];
        if (isUsableTarget(candidate)) {
          reasons.push(`repli : fournisseur « ${target.providerId ?? "?"} » absent`);
          tier = ROUTE_TIERS[i];
          target = candidate;
          break;
        }
      }
    }

    // R3 — un tour débordé/bloqué ne mémorise PAS d'affinité : la conversation
    // re-route normalement dès que la fenêtre d'abonnement se rouvre. Un tour
    // normal, lui, ne la mémorise plus ICI mais au premier signe de succès
    // (`pendingAffinity`, voir `handleSend`) — un tour routé qui échoue
    // (cible éteinte…) ne doit jamais verrouiller la conversation dessus.
    return { tier, target, reasons, debord, pendingAffinity: !debord, debordUnconfigured };
  }

  /**
   * R3 — pose/efface le bandeau de débord de la conversation d'après la
   * résolution du tour qui part (même contrat que ChatPage.tsx).
   * `unconfigured` : cible de débord non déclarée — bandeau dédié, le tour
   * part sur l'abonnement (voir `resolveAutoRoute`).
   */
  async function applyDebordNotice(
    convId: string,
    debord: RouteDebord | null,
    model: string,
    unconfigured = false,
  ): Promise<void> {
    if (unconfigured) {
      updateRuntime(convId, (r) => ({
        ...r,
        debordNotice: { blocked: false, fiveHourPct: null, model, plafondUsdMois: null, unconfigured: true },
      }));
      return;
    }
    if (!debord) {
      updateRuntime(convId, (r) => (r.debordNotice ? { ...r, debordNotice: null } : r));
      return;
    }
    let plafondUsdMois: number | null = null;
    if (debord.blocked) {
      // `null` = bascule payante désactivée (le sidecar ne devrait alors
      // jamais signaler de débord, mais on reste défensif).
      plafondUsdMois = await readRoutingDebord()
        .then((d) => d?.plafondUsdMois ?? null)
        .catch(() => null);
    }
    updateRuntime(convId, (r) => ({
      ...r,
      debordNotice: { blocked: debord.blocked, fiveHourPct: debord.fiveHourPct, model, plafondUsdMois },
    }));
  }

  async function handleSend(overrideContent?: string) {
    // Conversation À LAQUELLE ce tour appartient, figée ici : tout ce qui suit
    // (callbacks de streaming, fin de tour, sauvegarde) écrit dans CETTE
    // conversation via `convId`, jamais dans « l'active ». C'est ce qui permet
    // à l'utilisateur de changer d'onglet pendant qu'un tour tourne sans que
    // la réponse n'atterrisse dans la mauvaise conversation.
    const convId = activeSessionId;
    if (!convId) return;

    // Pendant un tour en cours : on ne lance pas un second envoi, on met le
    // message en file (envoyé à la fin du tour, voir l'effet d'auto-envoi).
    // L'auto-envoi rappelle handleSend avec `overrideContent` une fois
    // `streaming` repassé à false — ce chemin-là ne re-file jamais.
    if (streaming && overrideContent === undefined) {
      const pending = draft.trim();
      if (pending) {
        updateRuntime(convId, (r) => ({ ...r, queuedPrompts: [...r.queuedPrompts, pending], draft: "" }));
        setSlashMenu((m) => ({ ...m, open: false }));
      }
      return;
    }

    // Chemin « file » (overrideContent) : texte seul, pas de pièces jointes.
    const usesComposer = overrideContent === undefined;
    const rawContent = (overrideContent ?? draft).trim();
    if ((!rawContent && (!usesComposer || attachments.length === 0)) || streaming || !cwd) return;
    // Une image collée est encore en cours d'encodage : on attend plutôt que
    // d'envoyer une pièce jointe sans données.
    if (usesComposer && attachmentsPending) {
      setAttachmentsError("Image en cours de chargement… réessayez dans un instant.");
      return;
    }

    const engineSelected: "claude" | "neutral" = engineProviderId !== null ? "neutral" : "claude";
    // R2 — tour « Auto (routeur) » : le moteur/modèle réels ne sont connus
    // qu'après résolution de la cible, juste en dessous.
    const isAutoTurn = model === AUTO_MODEL;
    // Pièces jointes : non supportées par `neutral.start` (voir le contrat), et
    // le mode Auto peut y router — `attachmentsSupported`/les bascules de
    // moteur les vident déjà en amont, mais on reste défensif ici plutôt que
    // de risquer un envoi silencieux vers le mauvais moteur. Capturées avant
    // tout envoi : le brouillon n'est purgé qu'en cas de succès (voir le
    // `try`/`catch` plus bas).
    const attachmentsAllowed = usesComposer && engineSelected === "claude" && !isAutoTurn;
    const contractAttachments = attachmentsAllowed ? toContractAttachments(attachments) : [];
    const sentAttachments = attachmentsAllowed ? toSentAttachments(attachments) : [];

    // Verrouille l'envoi tout de suite (avant les résolutions asynchrones
    // ci-dessous — routage Auto, lecture des documents épinglés) : sans ça, un
    // second Entrée pendant ces attentes pourrait déclencher un double envoi.
    // `preSendAbort` repart de zéro : c'est le drapeau de CE tour (voir
    // `handleAbort` et le point de contrôle plus bas). Chemin « file » : ne
    // pas toucher au brouillon (l'utilisateur a pu recommencer à taper un
    // message suivant pendant que le tour finissait).
    updateRuntime(convId, (r) => ({
      ...r,
      streaming: true,
      preSendAbort: false,
      activeEngine: engineSelected,
      ...(usesComposer ? { draft: "" } : {}),
    }));

    // R2/R7 — mode Auto : résolution de la cible AVANT le reste (le moteur
    // réel conditionne l'injection de connaissances et l'historique neutre).
    // Stratégie DESCENDANTE : premier tour au sommet de la table (`complexe`
    // imposé), affinité de session ensuite (voir `resolveAutoRoute`).
    let engine = engineSelected;
    let turnProviderId: string | null = engineProviderId;
    let turnModel = model;
    let autoRoute: Awaited<ReturnType<typeof resolveAutoRoute>> | null = null;
    if (isAutoTurn) {
      try {
        autoRoute = await resolveAutoRoute(convId, rawContent);
      } catch (err) {
        // Échec du routage (sidecar injoignable…) : tour marqué en erreur,
        // comme n'importe quel échec de moteur.
        const message = err instanceof Error ? err.message : String(err);
        updateRuntime(convId, (r) => ({
          ...r,
          streaming: false,
          turns: [
            ...r.turns,
            { id: nextId("u"), role: "user", content: rawContent, displayContent: rawContent, status: "done" },
            { id: nextId("a"), role: "assistant", blocks: [], status: "error", errorMessage: message },
          ],
        }));
        return;
      }
      engine = autoRoute.target.engine === "neutral" ? "neutral" : "claude";
      turnProviderId = autoRoute.target.engine === "neutral" ? (autoRoute.target.providerId ?? "") : null;
      turnModel = autoRoute.target.model;
      // Moteur réel du tour, pour un abandon correctement routé.
      updateRuntime(convId, (r) => ({ ...r, activeEngine: engine }));
      // R3 — bandeau de débord : posé au tour concerné, effacé au tour normal.
      await applyDebordNotice(convId, autoRoute.debord, autoRoute.target.model, autoRoute.debordUnconfigured);
    } else {
      // R3 — tour à moteur/modèle choisis MANUELLEMENT : jamais bloqué ni
      // bandeau-isé — un éventuel bandeau de débord précédent s'efface.
      updateRuntime(convId, (r) => (r.debordNotice ? { ...r, debordNotice: null } : r));
    }

    // Injection des connaissances (épinglées + auto `.iaction/connaissances/`,
    // voir `injectedKnowledge`) SEULEMENT au premier tour de la session :
    // Claude via `sessionId` (encore `null` = pas de session serveur
    // existante) ; moteur neutre via l'historique (pas d'état de session côté
    // serveur, voir `buildNeutralMessages` — l'historique encore vide EST le
    // premier tour). R5 — mode `rag` : PAS d'injection intégrale, la ligne
    // système RAG_SYSTEM_LINE la remplace (via composeSystemInstructions) et
    // l'outil search_knowledge prend le relais dans les deux moteurs.
    const isFirstTurn = engine === "claude" ? sessionId === null : turns.length === 0;
    const docsToInject = isFirstTurn && knowledgeMode !== "rag" ? injectedKnowledge : [];

    let sentContent = rawContent;
    if (docsToInject.length > 0) {
      sentContent = `${await buildKnowledgeBlock(docsToInject, cwd)}${rawContent}`;
    }

    const historyMessages =
      engine === "neutral"
        ? withAgentSystemPrompt(buildNeutralMessages(turns, sentContent), composeSystemInstructions())
        : [];

    // « Arrêter » cliqué pendant la phase de PRÉ-ENVOI ci-dessus (routage
    // Auto ≤ 3 s, lecture des connaissances) : abandon propre AVANT tout
    // envoi — rien n'est parti vers un moteur, le message est simplement
    // reposé dans le composeur (devant ce que l'utilisateur a pu retaper).
    if (getRuntime(convId).preSendAbort) {
      updateRuntime(convId, (r) => ({
        ...r,
        streaming: false,
        preSendAbort: false,
        draft: r.draft ? `${rawContent}\n${r.draft}` : rawContent,
      }));
      return;
    }

    const userTurn: AgentTurn = {
      id: nextId("u"),
      role: "user",
      content: sentContent,
      displayContent: rawContent,
      injectedKnowledgeCount: docsToInject.length || undefined,
      status: "done",
      ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
    };
    const assistantId = nextId("a");
    updateTurnsFor(convId, (prev) => [
      ...prev,
      userTurn,
      {
        id: assistantId,
        role: "assistant",
        blocks: [],
        status: "streaming",
        // R2 — badge « ⚡ auto : tier → modèle » porté par le tour assistant
        // (persisté avec lui — l'infobulle liste les raisons du classement).
        ...(autoRoute
          ? { routeTier: autoRoute.tier, routeModel: autoRoute.target.model, routeReasons: autoRoute.reasons }
          : {}),
      },
    ]);
    stickToBottomRef.current = true;

    // R2/R6 — affinité de session EN ATTENTE : mémorisée au PREMIER signe de
    // succès du tour (premier texte reçu, ou `done` sans erreur) — un tour
    // routé qui échoue (cible Ollama éteinte…) ne verrouille jamais la
    // conversation sur une cible morte. R7 §C — la session reste ensuite au
    // sommet (aucune descente automatique) : le plancher montant du Chat (§B)
    // ne s'applique pas à ce flux.
    let commitAffinity: (() => void) | null = null;
    if (autoRoute?.pendingAffinity) {
      const { tier: routedTier, target: routedTarget, reasons: routedReasons } = autoRoute;
      commitAffinity = () => {
        commitAffinity = null;
        updateRuntime(convId, (r) => ({ ...r, routedTier, routedTarget, routedReasons }));
      };
    }

    const common = {
      onText: (delta: string) => {
        commitAffinity?.();
        updateTurnsFor(convId, (prev) => withBlocks(prev, assistantId, (b) => appendToLastBlock(b, "text", delta)));
      },
      onToolUse: (toolUseId: string, toolName: string, toolInput: unknown) => {
        updateTurnsFor(convId, (prev) => withBlocks(prev, assistantId, (b) => addToolBlock(b, toolUseId, toolName, toolInput)));
        // Compteur d'usage MCP (section « MCP ») : porté par le runtime de
        // CETTE conversation, donc juste même si l'onglet affiché a changé.
        const server = mcpServerFromToolName(toolName);
        if (server) {
          const tool = toolName.split("__").slice(2).join("__") || toolName;
          updateRuntime(convId, (r) => ({
            ...r,
            mcpUsage: { ...r.mcpUsage, [server]: { calls: (r.mcpUsage[server]?.calls ?? 0) + 1, lastTool: tool } },
          }));
        }
      },
      onToolResult: (toolUseId: string, isError: boolean, summary: string) =>
        updateTurnsFor(convId, (prev) => withBlocks(prev, assistantId, (b) => setToolResult(b, toolUseId, isError, summary))),
    };

    // R2 — meta commun aux deux moteurs : routeTier quand le tour a été routé
    // (persisté dans events.jsonl, voir docs/protocol.md § S1).
    const meta: RequestMeta = { source: "projet", conversationId: convId };
    if (autoRoute) meta.routeTier = autoRoute.tier;
    // R3 — tour réellement débordé : marqué pour le plafond mensuel (events.jsonl).
    if (autoRoute?.debord?.active) meta.routeDebord = true;

    const { id, done } =
      engine === "neutral"
        ? sendViaNeutralEngine(turnProviderId as string, historyMessages, common, turnModel, meta)
        : sendViaClaudeEngine(sentContent, assistantId, common, contractAttachments, convId, turnModel || null, meta);
    updateRuntime(convId, (r) => ({ ...r, activeRequestId: id }));

    try {
      const data = await done;
      // Tour terminé sans erreur (même sans texte reçu) : second signe de
      // succès qui fixe l'affinité en attente (no-op si déjà fixée).
      commitAffinity?.();
      const parsed = engine === "neutral" ? parseNeutralDone(data) : parseClaudeDone(data);
      if (engine === "claude" && parsed.sessionId) {
        updateRuntime(convId, (r) => ({ ...r, sessionId: parsed.sessionId }));
      }
      if (engine === "claude") {
        // Compteur local « conso hebdo Fable » (encart conso) — avant le
        // notifyUsageChanged() du finally, pour que l'encart lise à jour.
        // R2 — `turnModel` : le modèle réellement utilisé (cible routée en Auto).
        await recordModelUsage(turnModel, parsed.usage);
      }
      updateTurnsFor(convId, (prev) => withTurnDone(prev, assistantId, parsed));
      // Envoi réussi : composeur purgé des pièces jointes — conservées en cas
      // d'échec (voir le `catch`), pour éviter de devoir tout rejoindre. Chemin
      // « file » : ne touche pas aux pièces jointes du message suivant.
      if (usesComposer) clearAttachments();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateTurnsFor(convId, (prev) => withTurnError(prev, assistantId, message));
    } finally {
      updateRuntime(convId, (r) => ({ ...r, streaming: false, activeRequestId: null }));
      // Sécurité : purge les demandes de permission orphelines de ce tour
      // (le sidecar les refuse déjà normalement à l'abort/fin de tour).
      setPermissionQueue((prev) => prev.filter((p) => p.targetId !== id));
      // Fin de tour : la conso a pu changer (Claude uniquement pour l'instant).
      notifyUsageChanged();
      // Fin de tour : sauvegarde immédiate (pas d'attente du debounce). Les
      // tours/sessionId sont relus dans le RUNTIME de cette conversation (et
      // non dans l'état React fermé à l'appel, périmé après tout ce
      // streaming) — l'utilisateur a pu changer d'onglet entre-temps, donc on
      // ne peut plus supposer que cette conversation est encore l'active.
      if (selectedProjectId) {
        const liveSessions = buildLiveSessions();
        setSessions(liveSessions);
        persistProject(selectedProjectId, liveSessions);
      }
    }
  }

  // Fin de tour : si des messages ont été mis en file pendant que l'agent
  // travaillait, on envoie le PREMIER automatiquement — les suivants partiront
  // aux fins de tour suivantes, un par un. `streaming` vient de repasser à
  // false ; handleSend(override) ne re-file pas et lance le tour suivant.
  useEffect(() => {
    if (streaming || !activeSessionId) return;
    const pending = getRuntime(activeSessionId).queuedPrompts[0];
    if (!pending || !cwd) return;
    updateRuntime(activeSessionId, (r) => ({ ...r, queuedPrompts: r.queuedPrompts.slice(1) }));
    void handleSend(pending);
    // handleSend/cwd volontairement hors deps : on ne réagit qu'au passage
    // de `streaming` à false (les autres sont lus au moment de l'envoi).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  async function handleAbort() {
    if (!activeSessionId) return;
    const runtime = getRuntime(activeSessionId);
    if (!runtime.streaming && !runtime.activeRequestId) return;
    // Arrêter = tout stopper : on abandonne aussi les messages éventuellement en
    // file (sinon ils partiraient juste après l'interruption, effet surprenant).
    updateRuntime(activeSessionId, (r) => ({ ...r, queuedPrompts: [] }));
    // Tour encore en phase de PRÉ-ENVOI (routage Auto, lecture des
    // connaissances) : aucune requête moteur à abandonner côté sidecar — on
    // lève le drapeau, le point de contrôle de `handleSend` annulera le tour
    // avant tout envoi (message reposé dans le composeur).
    if (!runtime.activeRequestId) {
      updateRuntime(activeSessionId, (r) => ({ ...r, preSendAbort: true }));
      return;
    }
    try {
      if (runtime.activeEngine === "neutral") {
        await neutralAbort(runtime.activeRequestId);
      } else {
        await claudeAbort(runtime.activeRequestId);
      }
    } catch {
      // best effort : le `done` du tour en cours gère l'état final du tour
    }
  }

  /** Rendre la main pendant l'attente des tâches de fond : claude.release clôt
      le tour proprement (le done livre le résultat déjà connu) ; contrairement
      à Arrêter, les messages en file partent ensuite normalement. */
  async function handleReleaseBackground() {
    if (!activeSessionId) return;
    const runtime = getRuntime(activeSessionId);
    if (!runtime.activeRequestId) return;
    try {
      await claudeRelease(runtime.activeRequestId);
    } catch {
      // best effort : le `done` du tour en cours gère l'état final du tour
    }
  }

  /* ---------- Voix du composeur (voir useVoiceComposer.ts) ---------- */

  /*
   * Dictée ponctuelle et mode conversation, MUTUALISÉS avec la page Chat : ce
   * hook porte toute la machinerie (micro, transcription, envoi, lecture,
   * garde-fous), la page ne fournit que ses propres accès au fil et à l'envoi.
   */
  const voice = useVoiceComposer({
    pageLabel: "Projets",
    pageVisible,
    micDeviceId,
    conversation: conversationConfig,
    // `handleSend` ne résout qu'à la fin du tour (elle attend `done`) : c'est
    // ce que le mode conversation attend pour enchaîner lecture puis reprise
    // de l'écoute. Sans projet sélectionné, elle ne fait rien — d'où
    // `notSentNotice` ci-dessous.
    send: (text) => handleSend(text),
    isBusy: () => streaming,
    turnCount: () => turnsRef.current.length,
    lastReplyText: () => {
      const list = turnsRef.current;
      const last = list[list.length - 1];
      if (!last || last.role !== "assistant" || last.status !== "done") return null;
      return spokenTextOfTurn(last) || null;
    },
    // Tour EN COURS d'écriture : `turnsRef` est tenu à jour de façon synchrone
    // par `updateTurns`, on lit donc le tour en construction sans rendu ni effet
    // supplémentaire. Même règle qu'à la fin (`spokenTextOfTurn`) : seuls les
    // blocs de texte sont lus, jamais les appels d'outils ni le raisonnement.
    streamingReplyText: () => {
      const list = turnsRef.current;
      const last = list[list.length - 1];
      if (!last || last.role !== "assistant" || last.status !== "streaming") return null;
      return spokenTextOfTurn(last) || null;
    },
    notSentNotice: "Message non envoyé : vérifiez le projet sélectionné.",
    appendToDraft: (text) => {
      if (activeSessionId) {
        updateRuntime(activeSessionId, (r) => ({ ...r, draft: r.draft ? `${r.draft} ${text}` : text }));
      }
      // Le menu « / » n'est piloté que par la saisie clavier (`updateSlashMenu`) :
      // un texte dicté ne doit ni l'ouvrir, ni le laisser ouvert sur un
      // fragment devenu caduc.
      setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
    },
    focusComposer: () => focusComposer(),
  });

  async function handlePermissionDecision(decision: "allow" | "deny", message: string, rememberTool: boolean) {
    const current = permissionQueue[0];
    if (!current) return;
    const respond = (item: PermissionRequestItem, dec: "allow" | "deny", msg?: string) =>
      item.engine === "neutral"
        ? neutralPermission(item.targetId, item.permissionId, dec, msg)
        : claudePermission(item.targetId, item.permissionId, dec, msg);
    if (decision === "allow" && rememberTool) {
      autoAllowToolsRef.current.add(current.toolName);
      // Autorise aussi d'un coup les demandes déjà en file pour le même outil.
      for (const item of permissionQueue.slice(1)) {
        if (item.toolName === current.toolName) {
          void respond(item, "allow");
        }
      }
    }
    try {
      await respond(current, decision, message || undefined);
    } catch {
      // best effort : la file est purgée dans tous les cas côté UI
    }
    setPermissionQueue((prev) =>
      decision === "allow" && rememberTool
        ? prev.filter((p, i) => i !== 0 && p.toolName !== current.toolName)
        : prev.slice(1),
    );
  }

  /* ---------- Menu « / » du composeur (slash-commands/skills du projet) ---------- */

  /**
   * Détecte un token « /frag » sous le curseur, SEULEMENT s'il démarre la
   * ligne courante (début du texte ou juste après un saut de ligne) — un
   * « / » au milieu d'un mot (ex. « et/ou ») ne matche jamais. Le fragment ne
   * doit contenir ni espace ni saut de ligne (dès qu'un espace suit le nom de
   * la commande, on considère que l'utilisateur tape ses arguments : plus de
   * détection).
   */
  function detectSlashToken(text: string, cursor: number): { start: number; fragment: string } | null {
    const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
    if (text[lineStart] !== "/") return null;
    const token = text.slice(lineStart, cursor);
    if (!/^\/\S*$/.test(token)) return null;
    return { start: lineStart, fragment: token.slice(1) };
  }

  /** Commandes dont le nom OU un alias matche `fragment` — préfixe prioritaire, puis sous-chaîne, insensible à la casse. */
  function matchSlashCommands(commands: SlashCommandInfo[], fragment: string): SlashCommandInfo[] {
    const needle = fragment.toLowerCase();
    const prefix: SlashCommandInfo[] = [];
    const substring: SlashCommandInfo[] = [];
    for (const cmd of commands) {
      const names = [cmd.name, ...(cmd.aliases ?? [])].map((n) => n.toLowerCase());
      if (names.some((n) => n.startsWith(needle))) prefix.push(cmd);
      else if (names.some((n) => n.includes(needle))) substring.push(cmd);
    }
    return [...prefix, ...substring];
  }

  /** Recalcule l'état du menu « / » à partir du texte et de la position du curseur (appelé à chaque frappe). */
  function updateSlashMenu(text: string, cursor: number) {
    const token = detectSlashToken(text, cursor);
    if (!token || slashCommands.length === 0) {
      setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
      return;
    }
    if (matchSlashCommands(slashCommands, token.fragment).length === 0) {
      setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
      return;
    }
    setSlashMenu({ open: true, fragment: token.fragment, start: token.start, selected: 0 });
  }

  /** Insère « /name » (remplace le fragment « /frag » courant), ferme le menu, replace le curseur juste après l'espace. */
  function applySlashCommand(cmd: SlashCommandInfo) {
    const insertion = `/${cmd.name} `;
    const before = draft.slice(0, slashMenu.start);
    const after = draft.slice(slashMenu.start + 1 + slashMenu.fragment.length);
    pendingCursorRef.current = before.length + insertion.length;
    setDraft(`${before}${insertion}${after}`);
    setSlashMenu((m) => ({ ...m, open: false }));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (slashMenu.open) {
      const matches = matchSlashCommands(slashCommands, slashMenu.fragment);
      if (matches.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashMenu((m) => ({ ...m, selected: (m.selected + 1) % matches.length }));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashMenu((m) => ({ ...m, selected: (m.selected - 1 + matches.length) % matches.length }));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applySlashCommand(matches[slashMenu.selected] ?? matches[0]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenu((m) => ({ ...m, open: false }));
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  /* ---------- Onglets fichier (arborescence + éditeur) ---------- */

  function loadFileInto(path: string, opts?: { onErrorCloseTab?: boolean }) {
    fsReadFile(path)
      .then((fc) =>
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === path
              ? { ...f, kind: fc.kind, content: fc.text ?? "", base64: fc.base64 ?? "", size: fc.size, truncated: fc.truncated, dirty: false }
              : f,
          ),
        ),
      )
      .catch((err: unknown) => {
        if (opts?.onErrorCloseTab) {
          // Onglet restauré (Lot 3, relecture paresseuse) dont le fichier
          // est introuvable/illisible (déplacé, supprimé…) : on ferme
          // l'onglet silencieusement plutôt que d'afficher une erreur pour
          // un fichier que l'utilisateur n'a pas explicitement rouvert.
          pendingLazyLoadsRef.current.delete(path);
          setOpenFiles((prev) => prev.filter((f) => f.path !== path));
          setActiveTab((current) => (current === path ? "conversation" : current));
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, kind: "error", errorMessage: message } : f)));
      });
  }

  /** Déclenche la relecture réelle d'un onglet restauré, la première fois qu'il devient actif. */
  function triggerLazyLoad(path: string) {
    if (path === "conversation" || !pendingLazyLoadsRef.current.has(path)) return;
    pendingLazyLoadsRef.current.delete(path);
    loadFileInto(path, { onErrorCloseTab: true });
  }

  /** `setActiveTab` + relecture paresseuse si cet onglet vient d'être restauré du disque. */
  function applyActiveTab(path: string) {
    setActiveTab(path);
    triggerLazyLoad(path);
  }

  // Raccourcis d'ONGLETS de conversation, écouteur LOCAL à cette page :
  // l'écouteur global de App.tsx ne connaît pas ces onglets, et ni Tab ni
  // Suppr n'y sont captés — aucun conflit avec les raccourcis globaux
  // (Ctrl+N/P/H/K/T/L, Ctrl+1..6, Ctrl+Maj+P).
  //   Ctrl+Tab / Ctrl+Maj+Tab : conversation suivante / précédente
  //   Ctrl+Suppr             : ferme l'onglet courant (l'historique est
  //                            CONSERVÉ — la conversation reste dans le
  //                            panneau « Sessions », seule sa suppression
  //                            définitive y est possible, avec confirmation)
  useEffect(() => {
    // Les six pages restent montées en permanence (voir App.tsx) : sans la
    // garde `pageVisible`, ces raccourcis agiraient AUSSI depuis les autres
    // pages — la page Chat ayant désormais ses propres onglets et le même
    // écouteur, Ctrl+Tab y cyclerait invisiblement les onglets de Projets.
    if (!pageVisible) return;
    // `globalThis.KeyboardEvent` : le `KeyboardEvent` non qualifié désigne
    // ici celui de React (importé en tête de fichier), incompatible avec
    // `addEventListener`.
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        cycleConversation(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "Delete" && !e.shiftKey && activeSessionId && isConvTab(activeTab)) {
        e.preventDefault();
        closeConversationTab(activeSessionId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Ces fonctions lisent `openConversationIds`/`activeSessionId`/`activeTab` :
    // on réattache l'écouteur quand ils changent plutôt que de passer par des
    // refs, la liste d'onglets étant petite et rarement modifiée.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openConversationIds, activeSessionId, activeTab, pageVisible]);

  function handleOpenFile(path: string, name: string) {
    setOpenFilesNotice(null);
    if (openFiles.some((f) => f.path === path)) {
      applyActiveTab(path);
      return;
    }
    let files = openFiles;
    if (files.length >= MAX_OPEN_FILES) {
      const evictIdx = files.findIndex((f) => !f.dirty);
      if (evictIdx === -1) {
        setOpenFilesNotice("Fermez un onglet modifié avant d'en ouvrir un nouveau (max 6).");
        return;
      }
      files = files.filter((_, i) => i !== evictIdx);
    }
    const loadingEntry: OpenFileState = {
      path,
      name,
      kind: "loading",
      content: "",
      base64: "",
      size: 0,
      truncated: false,
      dirty: false,
      saving: false,
      saveError: null,
      errorMessage: null,
    };
    setOpenFiles([...files, loadingEntry]);
    setActiveTab(path);
    loadFileInto(path);
  }

  /**
   * Résout une référence de fichier cliquée dans une transcription (voir
   * Markdown.tsx `onFileRef`) et ouvre le fichier trouvé — ou affiche une
   * notice discrète (réutilise `openFilesNotice`, déjà rendue juste
   * au-dessus de la zone conversation/éditeur) sinon :
   *  - référence ABSOLUE (commence par `/`) : ouverte telle quelle si elle
   *    est sous `cwd`, sinon notice « hors du projet » (aucune tentative de
   *    lecture — on ne veut pas exposer le système de fichiers hors projet).
   *  - référence avec `/` : essayée d'abord comme `cwd/ref` — un
   *    `fsReadFile` de contrôle (pas juste `handleOpenFile`, qui ouvrirait
   *    un onglet en erreur plutôt que de retomber sur la recherche) décide
   *    du succès ; en cas d'échec, repli sur la recherche par nom de base.
   *  - nom nu (ou repli ci-dessus) : `fsFindByName(cwd, nom)`.
   */
  /* Wrappers à identité STABLE pour les composants mémoïsés (AgentTurnView /
     AgentBlockView / Markdown) : la dernière implémentation vit dans un ref,
     le useCallback sans dépendance garde la même référence à vie — sans quoi
     le memo serait inopérant (nouvelle fonction à chaque rendu). */
  const fileRefImpl = useRef<(ref: string) => void>(() => {});
  fileRefImpl.current = (ref) => void handleFileRef(ref);
  const stableFileRef = useCallback((ref: string) => fileRefImpl.current(ref), []);
  const releaseBackgroundImpl = useRef<() => void>(() => {});
  releaseBackgroundImpl.current = () => void handleReleaseBackground();
  const stableReleaseBackground = useCallback(() => releaseBackgroundImpl.current(), []);

  async function handleFileRef(ref: string) {
    if (!cwd) return;
    setOpenFilesNotice(null);

    if (ref.startsWith("/")) {
      if (ref === cwd || ref.startsWith(`${cwd}/`)) {
        handleOpenFile(ref, ref.slice(ref.lastIndexOf("/") + 1) || ref);
      } else {
        setOpenFilesNotice(`Fichier hors du projet : ${ref}`);
      }
      return;
    }

    const baseName = ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref;

    if (ref.includes("/")) {
      const candidate = `${cwd}/${ref}`;
      try {
        await fsReadFile(candidate);
        handleOpenFile(candidate, baseName || ref);
        return;
      } catch {
        // Échec de lecture (chemin inexistant depuis la racine du projet) :
        // repli sur la recherche par nom de base, ci-dessous.
      }
    }

    if (!baseName) {
      setOpenFilesNotice(`« ${ref} » introuvable dans le projet.`);
      return;
    }

    try {
      const matches = await fsFindByName(cwd, baseName);
      if (matches.length === 0) {
        setOpenFilesNotice(`« ${ref} » introuvable dans le projet.`);
        return;
      }
      const [first, ...rest] = matches;
      handleOpenFile(first, first.slice(first.lastIndexOf("/") + 1));
      if (rest.length > 0) {
        setOpenFilesNotice(
          `${rest.length} autre${rest.length > 1 ? "s" : ""} correspondance${rest.length > 1 ? "s" : ""} pour « ${ref} ».`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOpenFilesNotice(`Recherche impossible pour « ${ref} » : ${message}`);
    }
  }

  function handleCloseTab(path: string, e: ReactMouseEvent) {
    e.stopPropagation();
    const file = openFiles.find((f) => f.path === path);
    if (file?.dirty && !window.confirm(`Fermer ${file.name} sans enregistrer les modifications ?`)) return;
    pendingLazyLoadsRef.current.delete(path);
    const idx = openFiles.findIndex((f) => f.path === path);
    const remaining = openFiles.filter((f) => f.path !== path);
    setOpenFiles(remaining);
    if (activeTab === path) {
      const fallback = remaining[idx] ?? remaining[idx - 1] ?? null;
      setActiveTab(fallback ? fallback.path : "conversation");
    }
  }

  /**
   * Renommage réussi dans l'arbre (fichier OU dossier — voir FileTree.tsx) :
   * met à jour les onglets ouverts et les connaissances épinglées dont le
   * chemin correspond à `oldPath` OU commence par ce préfixe (renommage d'un
   * dossier contenant des fichiers ouverts/épinglés).
   */
  function handleFileRenamed(oldPath: string, newPath: string) {
    setOpenFiles((prev) =>
      prev.map((f) => {
        const path = renamedPath(f.path, oldPath, newPath);
        if (path === f.path) return f;
        return { ...f, path, name: path.slice(path.lastIndexOf("/") + 1) || path };
      }),
    );
    setActiveTab((prev) => renamedPath(prev, oldPath, newPath));
    if (!selectedProjectId) return;
    setKnowledgeDoc((prev) => {
      const list = prev[selectedProjectId];
      if (!list) return prev;
      let changed = false;
      const nextList = list.map((d) => {
        const path = renamedPath(d.path, oldPath, newPath);
        if (path === d.path) return d;
        changed = true;
        return { path, name: path.slice(path.lastIndexOf("/") + 1) || path };
      });
      if (!changed) return prev;
      const next = { ...prev, [selectedProjectId]: nextList };
      void stateWrite(KNOWLEDGE_STATE_KEY, next).catch(() => {});
      return next;
    });
  }

  /**
   * Suppression réussie dans l'arbre (fichier OU dossier, DÉFINITIVE) : ferme
   * les onglets ouverts et retire les connaissances épinglées dont le chemin
   * correspond à `path` OU en est un descendant.
   */
  function handleFileDeleted(path: string) {
    setOpenFiles((prev) => prev.filter((f) => !isUnderPath(f.path, path)));
    setActiveTab((prev) => (isUnderPath(prev, path) ? "conversation" : prev));
    if (!selectedProjectId) return;
    setKnowledgeDoc((prev) => {
      const list = prev[selectedProjectId];
      if (!list) return prev;
      const nextList = list.filter((d) => !isUnderPath(d.path, path));
      if (nextList.length === list.length) return prev;
      const next = { ...prev, [selectedProjectId]: nextList };
      void stateWrite(KNOWLEDGE_STATE_KEY, next).catch(() => {});
      return next;
    });
  }

  function handleFileContentChange(path: string, content: string) {
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)));
  }

  async function handleSaveFile(path: string) {
    const file = openFiles.find((f) => f.path === path);
    if (!file || file.kind !== "text" || file.truncated || file.saving) return;
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, saving: true, saveError: null } : f)));
    try {
      await fsWriteFile(path, file.content);
      setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, saving: false, dirty: false } : f)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, saving: false, saveError: message } : f)));
    }
  }

  function handleReloadFile(path: string) {
    const file = openFiles.find((f) => f.path === path);
    if (!file) return;
    if (file.dirty && !window.confirm(`Recharger ${file.name} et perdre les modifications non enregistrées ?`)) return;
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, kind: "loading", saveError: null } : f)));
    loadFileInto(path);
  }

  // Ctrl+S / Cmd+S enregistre l'onglet fichier actif.
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeTab !== "conversation") void handleSaveFile(activeTab);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, openFiles]);

  /* ---------- Badges de détection (.iaction/CLAUDE.md/.claude) ---------- */

  // Reçoit les entrées racine du `fs_list_dir` déjà fait par FileTree — pas
  // de second appel dédié. Identité stable (deps vides) : entre dans la
  // dépendance du `loadRoot` de FileTree, un callback instable y
  // provoquerait un rechargement de l'arbre à chaque rendu d'AgentPage.
  const handleRootEntries = useCallback((entries: DirEntry[]) => {
    const find = (name: string) => entries.find((e) => e.name === name)?.path ?? null;
    setProjectBadges({
      iactionPath: find(".iaction"),
      claudeMdPath: find("CLAUDE.md"),
      claudeDirPath: find(".claude"),
    });
  }, []);

  // Changement de projet : on efface les badges le temps que FileTree
  // recharge sa racine et rappelle `handleRootEntries`.
  useEffect(() => {
    setProjectBadges({ iactionPath: null, claudeMdPath: null, claudeDirPath: null });
  }, [cwd]);

  // API impérative pour la palette Ctrl+Maj+P (voir CommandPalette.tsx) : cette
  // page reste seule propriétaire de `selectedProjectId`/de la Map d'état
  // par projet (voir le commentaire d'en-tête de fichier) ; App.tsx ne
  // reçoit qu'un moyen de déclencher une bascule et de savoir si elle a été
  // acceptée.
  useImperativeHandle(ref, () => ({
    requestSelectProject: (id: string) => {
      if (streaming || !projects.some((p) => p.id === id)) return false;
      selectProject(id);
      return true;
    },
    getSelectedProjectPath: () => selectedProject?.path ?? null,
    newSession: () => handleNewSession(),
    clearConversation: () => clearConversation(),
    isStreaming: () => streaming,
    focusComposer: () => focusComposer(),
  }));

  const currentPermission = permissionQueue[0] ?? null;
  const activeFile = isConvTab(activeTab) ? null : (openFiles.find((f) => f.path === activeTab) ?? null);

  // Roving tabindex (WAI-ARIA APG) : onglets de fichiers (←/→) et liste de
  // sessions (↑/↓). Un seul élément tabbable par collection — l'onglet actif /
  // la session active (ou la plus récente), le dernier focusé tant qu'on
  // reste dans la collection.
  const tabsRoving = useRovingFocus<HTMLDivElement>({ selector: '[role="tab"]', orientation: "horizontal" });
  const sessionsRoving = useRovingFocus<HTMLUListElement>({ selector: ".session-item__title" });
  const sortedSessions = sortByRecent(sessions);
  const tabbableSessionId = sortedSessions.some((s) => s.id === activeSessionId)
    ? activeSessionId
    : sortedSessions[0]?.id;

  // Aucun projet déclaré : écran d'accueil dédié plutôt que la page vide
  // (les hooks ci-dessus doivent tout de même tourner à chaque rendu, d'où
  // ce garde-fou en fin de fonction plutôt qu'un retour anticipé plus haut).
  if (projectsLoadState !== "loading" && projects.length === 0) {
    return (
      <div className="page agent-page agent-page--empty">
        <div className="agent-empty-state">
          <h1 className="page__title">Projets</h1>
          <p className="empty-hint">Déclarez votre premier projet dans Configuration pour commencer.</p>
          <button type="button" className="btn" onClick={onGoToConfig}>
            Aller à Configuration
          </button>
        </div>
      </div>
    );
  }

  // Écran étroit au premier affichage : les sections secondaires démarrent
  // repliées (voir spec « reste simple » — calculé une fois, pas ré-évalué
  // au redimensionnement ; `SidebarSection` n'utilise `defaultOpen` qu'à son
  // propre montage, un changement ultérieur de cette valeur est sans effet).
  const isCompactViewport = typeof window !== "undefined" && window.innerWidth <= 900;

  // Commandes affichées par le menu « / » du composeur, filtrées/triées par
  // `matchSlashCommands` (préfixe puis sous-chaîne) — vide tant que le menu
  // n'est pas ouvert.
  const slashMatches = slashMenu.open ? matchSlashCommands(slashCommands, slashMenu.fragment) : [];
  const contextSize = contextTokens(turns);
  // R2 — en Auto, l'encart contexte affiche le modèle routé dès qu'il est connu.
  const contextModel = model === AUTO_MODEL ? (activeRuntime.routedTarget?.model ?? "auto") : model;
  // Encart « Contexte » de l'en-tête (voir contextBus.ts) : publié tant que
  // cette page vit, effacé au démontage pour ne pas laisser un chiffre orphelin.
  useEffect(() => {
    publishContext("agent", contextSize === null ? null : { model: contextModel, usedTokens: contextSize });
    return () => publishContext("agent", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextSize, contextModel]);

  // Bouton « Compacter » de l'encart contexte (voir contextBus.ts) :
  // disponible hors tour en cours, sur une session du moteur Claude — l'action
  // envoie « /compact » au CLI (compaction native Claude Code), comme un tour
  // normal. Ref : handleSend est re-créée à chaque rendu, le handler
  // enregistré doit rester frais sans re-notifier le bus en boucle.
  const compactSendRef = useRef<() => void>(() => {});
  compactSendRef.current = () => {
    if (!streaming) {
      void handleSend("/compact");
      return;
    }
    // Tour en cours : « /compact » part en FILE (jamais handleSend avec
    // argument ici — ce chemin contourne la file et lancerait un envoi
    // concurrent). Dédoublonné : un seul /compact en attente à la fois.
    const convId = activeSessionId;
    if (!convId) return;
    updateRuntime(convId, (r) =>
      r.queuedPrompts.includes("/compact") ? r : { ...r, queuedPrompts: [...r.queuedPrompts, "/compact"] },
    );
  };
  useEffect(() => {
    const available = Boolean(activeSessionId) && engineProviderId === null;
    registerCompactHandler("agent", available ? () => compactSendRef.current() : null);
    return () => registerCompactHandler("agent", null);
  }, [activeSessionId, engineProviderId]);

  return (
    <div className="page agent-page">
      <div className="agent-layout">
        <aside className="agent-sidebar agent-sidebar--left">
          <SidebarSection id="project" title="Projet" defaultOpen={!isCompactViewport}>
            <div className="field">
              <label htmlFor="agent-project">Projet</label>
              <div className="sidebar-project-row">
                <select
                  id="agent-project"
                  value={selectedProjectId ?? ""}
                  disabled={streaming || projects.length === 0}
                  onChange={(e) => selectProject(e.currentTarget.value)}
                >
                  {projects.length === 0 && <option value="">Aucun projet</option>}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id} title={p.path}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={onGoToConfig}
                  title="Déclarer un nouveau projet"
                  aria-label="Déclarer un nouveau projet"
                >
                  +
                </button>
              </div>
            </div>
            {selectedProject && <div className="sidebar-project-path">{selectedProject.path}</div>}
            {selectedProject &&
              (projectBadges.iactionPath || projectBadges.claudeMdPath || projectBadges.claudeDirPath) && (
                <div className="project-badges">
                  {projectBadges.iactionPath && (
                    <span
                      className="project-badge"
                      title="Dossier de config du projet — agents, doc IA, RAG (v2)"
                    >
                      ⚙ .iaction
                    </span>
                  )}
                  {projectBadges.claudeMdPath && (
                    <button
                      type="button"
                      className="project-badge project-badge--link"
                      title="Instructions projet — lues automatiquement par le moteur Claude"
                      onClick={() => handleOpenFile(projectBadges.claudeMdPath as string, "CLAUDE.md")}
                    >
                      📄 CLAUDE.md
                    </button>
                  )}
                  {projectBadges.claudeDirPath && (
                    <span
                      className="project-badge"
                      title="Config Claude Code existante — agents, commandes, permissions"
                    >
                      🤖 .claude/
                    </span>
                  )}
                </div>
              )}
          </SidebarSection>

          <SidebarSection id="files" title="Fichiers" defaultOpen={!isCompactViewport}>
            <div className="sidebar-filetree">
              <FileTree
                rootPath={cwd}
                onOpenFile={handleOpenFile}
                onRootEntries={handleRootEntries}
                apps={apps}
                onPinKnowledge={pinKnowledge}
                onFileRenamed={handleFileRenamed}
                onFileDeleted={handleFileDeleted}
              />
            </div>
          </SidebarSection>
        </aside>

        <div className="agent-main__content">
          <div
            className="agent-tabs"
            role="tablist"
            ref={tabsRoving.containerRef}
            onKeyDown={tabsRoving.onKeyDown}
            onFocus={tabsRoving.onFocus}
          >
            {openConversationIds.map((convId) => {
              const conv = sessions.find((s) => s.id === convId);
              if (!conv) return null;
              const tabId = convTabId(convId);
              const isActive = activeTab === tabId;
              const convStreaming = runtimesRef.current.get(convId)?.streaming === true;
              return (
                <div
                  key={convId}
                  className={`agent-tab agent-tab--conv${isActive ? " agent-tab--active" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  title={conv.title}
                  onClick={() => selectSession(convId)}
                  onKeyDown={(e) => {
                    // `target === currentTarget` : ne pas intercepter Entrée sur
                    // le bouton « × » interne (fermeture native du bouton).
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      selectSession(convId);
                    }
                  }}
                >
                  <span className="agent-tab__name">{conv.title}</span>
                  {convStreaming && (
                    <span
                      className="agent-tab__dot agent-tab__dot--streaming"
                      aria-label="Tour en cours"
                      title="Tour en cours"
                    />
                  )}
                  <button
                    type="button"
                    className="agent-tab__close"
                    aria-label={`Fermer l'onglet ${conv.title}`}
                    title={convStreaming ? "Impossible de fermer : tour en cours" : "Fermer l'onglet"}
                    disabled={convStreaming}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeConversationTab(convId);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="agent-tab agent-tab--new"
              onClick={() => handleNewSession()}
              aria-label="Nouvelle conversation"
              title="Nouvelle conversation (Ctrl+N)"
            >
              +
            </button>
            {openFiles.map((f) => (
              <div
                key={f.path}
                className={`agent-tab${activeTab === f.path ? " agent-tab--active" : ""}`}
                role="tab"
                aria-selected={activeTab === f.path}
                tabIndex={activeTab === f.path ? 0 : -1}
                title={f.path}
                onClick={() => applyActiveTab(f.path)}
                onKeyDown={(e) => {
                  // `target === currentTarget` : ne pas intercepter Entrée sur
                  // le bouton « × » interne (fermeture native du bouton).
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    applyActiveTab(f.path);
                  }
                }}
              >
                <span className="agent-tab__name">{f.name}</span>
                {f.dirty && <span className="agent-tab__dot" aria-hidden="true" title="Modifié" />}
                <button
                  type="button"
                  className="agent-tab__close"
                  aria-label={`Fermer ${f.name}`}
                  onClick={(e) => handleCloseTab(f.path, e)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {openFilesNotice && <div className="agent-tabs__notice">{openFilesNotice}</div>}
          {clearedNotice && (
            <div className="agent-tabs__notice cleared-notice">
              Conversation vidée.
              <button type="button" className="btn btn--ghost cleared-notice__undo" onClick={undoClearConversation}>
                Annuler
              </button>
              <button
                type="button"
                className="cleared-notice__dismiss"
                onClick={() => setClearedNotice(false)}
                aria-label="Masquer"
                title="Masquer"
              >
                ×
              </button>
            </div>
          )}
          {/* R3 — bandeau de débord : posé au tour concerné, effacé dès que le
              routage redevient normal (voir applyDebordNotice). */}
          {debordNotice && (
            <div className={`agent-tabs__notice debord-notice${debordNotice.blocked ? " debord-notice--blocked" : ""}`}>
              {debordNotice.unconfigured
                ? "⚠ Cible de débord non configurée — tour envoyé sur l'abonnement"
                : debordNotice.blocked
                  ? `⛔ Plafond débord atteint (${debordNotice.plafondUsdMois ?? "?"} $/mois) — repli sur le modèle local`
                  : `⚠ Mode débord : abonnement saturé (fenêtre 5 h à ${Math.round(debordNotice.fiveHourPct ?? 0)} %) — tour envoyé sur ${debordNotice.model}`}
            </div>
          )}

          <div className="agent-tabs__body">
            {isConvTab(activeTab) ? (
              <div className="agent-conversation">
                <div className="chat-log" ref={scrollRef} onScroll={handleScroll}>
                  {turns.length === 0 && (
                    <p className="empty-hint">
                      {cwd
                        ? "Aucun message. Décrivez la tâche à réaliser dans ce projet."
                        : "Choisissez d'abord un projet ci-dessus."}
                    </p>
                  )}
                  {turns.map((turn) => (
                    <AgentTurnView
                      key={turn.id}
                      turn={turn}
                      onFileRef={stableFileRef}
                      onReleaseBackground={stableReleaseBackground}
                    />
                  ))}
                </div>

                <div
                  className={`chat-composer${composerDragOver ? " chat-composer--dragover" : ""}`}
                  onDragOver={(e) => {
                    if (streaming || !attachmentsSupported) return;
                    e.preventDefault();
                    setComposerDragOver(true);
                  }}
                  onDragLeave={() => setComposerDragOver(false)}
                  onDrop={(e) => {
                    if (streaming || !attachmentsSupported) return;
                    e.preventDefault();
                    setComposerDragOver(false);
                    const files = filesFromDrop(e);
                    if (files.length > 0) addFiles(files);
                  }}
                >
                  {slashMenu.open && slashMatches.length > 0 && (
                    <ul className="slash-menu" role="listbox">
                      {slashMatches.map((cmd, index) => (
                        <li
                          key={cmd.name}
                          role="option"
                          aria-selected={index === slashMenu.selected}
                          className={`slash-menu__item${index === slashMenu.selected ? " slash-menu__item--selected" : ""}`}
                          onMouseDown={(e) => {
                            // `onMouseDown` (pas `onClick`) : évite que le textarea perde le
                            // focus avant l'insertion, ce qui décalerait le repositionnement du curseur.
                            e.preventDefault();
                            applySlashCommand(cmd);
                          }}
                        >
                          <span className="slash-menu__name">/{cmd.name}</span>
                          {cmd.description && <span className="slash-menu__description">{cmd.description}</span>}
                          {cmd.argumentHint && <span className="slash-menu__hint">{cmd.argumentHint}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {queuedPrompts.map((prompt, index) => (
                    <div
                      key={`${index}-${prompt}`}
                      className="composer-queued"
                      title="Envoyé automatiquement à la fin du tour en cours, dans l'ordre de la file"
                    >
                      <span className="composer-queued__label">
                        {queuedPrompts.length > 1 ? `En file ${index + 1}/${queuedPrompts.length} :` : "En file :"}
                      </span>
                      <span className="composer-queued__text">{prompt}</span>
                      <button
                        type="button"
                        className="composer-queued__cancel"
                        onClick={() => removeQueuedPrompt(index)}
                        aria-label="Retirer ce message de la file"
                        title="Retirer de la file"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <AttachmentTray items={attachments} onRemove={removeAttachment} />
                  {attachmentsError && (
                    <div className="result-line result-line--error">
                      {attachmentsError}
                      <button
                        type="button"
                        className="btn btn--ghost result-line__dismiss"
                        onClick={() => setAttachmentsError(null)}
                        aria-label="Masquer l'erreur"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  {/* Erreur micro, progression de transcription, état du mode
                      conversation et messages discrets — voir VoiceControls.tsx. */}
                  <VoiceStatus voice={voice} />
                  <div className="chat-composer__row">
                    {/* Icônes d'action empilées EN COLONNE à gauche du textarea :
                        la zone de saisie récupère ainsi toute la largeur. */}
                    <div className="chat-composer__tools">
                      <AttachmentPickerButton
                        onFiles={(files) => addFiles(files)}
                        disabled={streaming || !cwd || !attachmentsSupported}
                        title={
                          attachmentsSupported
                            ? "Joindre des fichiers"
                            : "Pièces jointes disponibles uniquement avec le moteur Claude (abonnement)"
                        }
                      />
                      {/* Sans projet sélectionné, il n'y a personne à qui parler :
                          la voix est désactivée comme l'est la zone de saisie. */}
                      <VoiceButtons voice={voice} disabled={!cwd} />
                    </div>
                    <textarea
                      ref={textareaRef}
                      rows={5}
                      value={draft}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setDraft(value);
                        updateSlashMenu(value, e.currentTarget.selectionStart ?? value.length);
                      }}
                      onKeyDown={handleKeyDown}
                      onPaste={(e) => {
                        // Moteur neutre : les pièces jointes ne passent pas par
                        // `neutral.start` — on le DIT au lieu d'ignorer le collage
                        // en silence (l'utilisateur croyait la fonction absente).
                        if (!attachmentsSupported) {
                          if (clipboardHasImage(e)) {
                            e.preventDefault();
                            setAttachmentsError(
                              "Image collée ignorée : les pièces jointes ne sont disponibles qu'avec le moteur Claude (abonnement).",
                            );
                          }
                          return;
                        }
                        const files = filesFromClipboard(e);
                        if (files.length > 0) {
                          e.preventDefault();
                          addFiles(files);
                          return;
                        }
                        // Repli natif : sous WebKitGTK (Tauri Linux), une
                        // capture d'écran n'apparaît PAS dans `clipboardData`.
                        // On ne tente ce repli que si le presse-papier ne porte
                        // pas de texte (sinon c'est un collage de texte normal,
                        // et interroger l'image ferait clignoter une vignette
                        // pour rien).
                        if (e.clipboardData.getData("text/plain")) return;
                        // Vignette « en chargement » AFFICHÉE TOUT DE SUITE, puis
                        // remplie quand l'image arrive du presse-papier natif.
                        const placeholderId = beginImage("capture-collée.png");
                        if (!placeholderId) return; // plus de place
                        void readClipboardImage()
                          .then((bytes) => resolveImage(placeholderId, bytes))
                          .catch(() => resolveImage(placeholderId, null));
                      }}
                      disabled={!cwd}
                      placeholder={
                        streaming
                          ? "L'agent travaille… (Entrée met votre message en file, envoyé à la fin du tour)"
                          : "Décrivez une tâche pour l'agent… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)"
                      }
                    />
                    <div className="actions">
                      {streaming ? (
                        <>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void handleSend()}
                            disabled={!draft.trim() || !cwd}
                            title="Envoyer à la fin du tour en cours"
                          >
                            Mettre en file
                          </button>
                          <button type="button" className="btn btn--ghost" onClick={() => void handleAbort()}>
                            Arrêter
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void handleSend()}
                          disabled={(!draft.trim() && attachments.length === 0) || attachmentsPending || !cwd}
                          title={attachmentsPending ? "Image en cours de chargement…" : undefined}
                        >
                          Envoyer
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              activeFile && (
                <div className="file-editor">
                  <div className="file-editor__toolbar">
                    <span className="file-editor__path" title={activeFile.path}>
                      {activeFile.path}
                      {activeFile.truncated && " — fichier tronqué"}
                    </span>
                    <div className="file-editor__toolbar-actions">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => handleReloadFile(activeFile.path)}
                        title="Recharger"
                        aria-label="Recharger le fichier"
                      >
                        ↻
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => void handleSaveFile(activeFile.path)}
                        disabled={activeFile.kind !== "text" || activeFile.truncated || activeFile.saving || !activeFile.dirty}
                        title="Enregistrer (Ctrl+S)"
                        aria-label="Enregistrer le fichier"
                      >
                        💾
                      </button>
                    </div>
                  </div>
                  {activeFile.truncated && activeFile.kind === "text" && (
                    <div className="file-editor__banner">Fichier tronqué (aperçu 2 Mo) — édition désactivée.</div>
                  )}
                  {activeFile.saveError && (
                    <div className="file-editor__banner file-editor__banner--error">
                      Erreur d'enregistrement : {activeFile.saveError}
                    </div>
                  )}
                  <div className="file-editor__content">
                    <FileEditorView file={activeFile} onChangeContent={handleFileContentChange} />
                  </div>
                </div>
              )
            )}
          </div>
        </div>

        <aside className="agent-sidebar agent-sidebar--right">
          <SidebarSection
            id="sessions"
            title="Sessions"
            defaultOpen={false}
            badge={sessions.length > 0 ? <span className="sidebar-section__count">{sessions.length}</span> : undefined}
          >
            {/* Bouton de création DANS la section Sessions : « Nouvelle session »
                existait aussi dans la section LLM, mais inaccessible quand celle-ci
                est repliée — le geste doit vivre là où l'on voit les sessions. */}
            <button
              type="button"
              className="btn btn--ghost session-list__new"
              onClick={handleNewSession}
              disabled={streaming}
            >
              + Nouvelle session
            </button>
            {sessions.length === 0 ? (
              <p className="empty-hint">Aucune session.</p>
            ) : (
              <ul
                className="session-list"
                ref={sessionsRoving.containerRef}
                onKeyDown={sessionsRoving.onKeyDown}
                onFocus={sessionsRoving.onFocus}
              >
                {sortedSessions.map((s) => (
                  <li key={s.id} className={`session-item${s.id === activeSessionId ? " session-item--active" : ""}`}>
                    {editingSessionId === s.id ? (
                      <input
                        className="session-item__title-input"
                        value={editingSessionTitle}
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setEditingSessionTitle(e.currentTarget.value)}
                        onBlur={commitEditSessionTitle}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEditSessionTitle();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEditSessionTitle();
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="session-item__title"
                        title={s.title}
                        disabled={streaming}
                        tabIndex={s.id === tabbableSessionId ? 0 : -1}
                        onClick={() => selectSession(s.id)}
                      >
                        {s.title}
                      </button>
                    )}
                    <div className="session-item__meta">
                      <span className="session-item__date">{formatRelativeDate(s.updatedAt)}</span>
                      <span className="session-item__engine">
                        {s.engine.providerId ? (providers.find((p) => p.id === s.engine.providerId)?.label ?? s.engine.providerId) : "Claude"}
                      </span>
                    </div>
                    {confirmDeleteSessionId === s.id ? (
                      <div className="session-item__confirm">
                        Supprimer ?
                        <button type="button" className="btn btn--ghost" onClick={() => setConfirmDeleteSessionId(null)}>
                          Non
                        </button>
                        <button
                          type="button"
                          className="btn btn--deny"
                          onClick={() => {
                            setConfirmDeleteSessionId(null);
                            deleteSession(s.id);
                          }}
                        >
                          Oui
                        </button>
                      </div>
                    ) : (
                      <div className="session-item__actions">
                        <button
                          type="button"
                          className="session-item__action"
                          title="Renommer"
                          aria-label={`Renommer ${s.title}`}
                          disabled={streaming}
                          onClick={() => startEditSessionTitle(s)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="session-item__action"
                          title="Supprimer"
                          aria-label={`Supprimer ${s.title}`}
                          disabled={streaming}
                          onClick={() => setConfirmDeleteSessionId(s.id)}
                        >
                          🗑
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SidebarSection>

          <SidebarSection id="llm" title="LLM" defaultOpen={!isCompactViewport}>
            <div className="field agent-preset">
              <label htmlFor="agent-preset-select">Agent</label>
              <select
                id="agent-preset-select"
                value={selectedAgentKey ? agentOptionValue(selectedAgentKey) : ""}
                disabled={streaming}
                onChange={(e) => handleAgentSelectChange(e.currentTarget.value)}
              >
                <option value="">Aucun (manuel)</option>
                {projectAgentsByScope.project.length > 0 && (
                  <optgroup label="Projet">
                    {projectAgentsByScope.project.map((a) => (
                      <option key={agentOptionValue(a)} value={agentOptionValue(a)}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {projectAgentsByScope.global.length > 0 && (
                  <optgroup label="Global">
                    {projectAgentsByScope.global.map((a) => (
                      <option key={agentOptionValue(a)} value={agentOptionValue(a)}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {projectAgentsByScope.claudeCode.length > 0 && (
                  <optgroup label="Claude Code">
                    {projectAgentsByScope.claudeCode.map((a) => (
                      <option key={agentOptionValue(a)} value={agentOptionValue(a)}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {selectedAgent && (
                <div className="agent-preset__applied">
                  <span>Configuré par l'agent {selectedAgent.name}</span>
                  <button
                    type="button"
                    className="agent-preset__clear"
                    disabled={streaming}
                    aria-label="Revenir au mode manuel"
                    title="Revenir au mode manuel"
                    onClick={clearAgentSelection}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>

            <div className="field">
              <label htmlFor="agent-engine">Moteur</label>
              <select
                id="agent-engine"
                value={engineProviderId ?? ""}
                disabled={streaming || selectedAgent !== null}
                onChange={(e) => handleEngineChange(e.currentTarget.value)}
              >
                <option value="">Claude (abonnement)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="agent-permission-mode">Mode de permission</label>
              <select
                id="agent-permission-mode"
                value={permissionMode}
                disabled={selectedAgent !== null}
                onChange={(e) => setPermissionMode(e.currentTarget.value as PermissionMode)}
              >
                {/* Le mode « plan » n'existe pas côté moteur neutre (docs/protocol.md, Lot 6). */}
                {PERMISSION_MODE_OPTIONS.filter((o) => o.value !== "plan" || engineProviderId === null).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="agent-model">Modèle</label>
              <select
                id="agent-model"
                value={model}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setModel(value);
                  // R2 — choisir un modèle explicite efface l'affinité de
                  // session (override) ; revenir sur « Auto » re-route au
                  // prochain envoi (routedTarget redevenu null). Bascule vers
                  // Auto : pièces jointes purgées (moteur réel inconnu, voir
                  // `attachmentsSupported`).
                  if (value !== AUTO_MODEL) {
                    clearRoutedAffinity();
                  } else {
                    clearAttachments();
                  }
                }}
                // R2 — « Auto (routeur) » restant toujours proposé, le
                // sélecteur n'est plus verrouillé quand la liste neutre est
                // vide (seulement pendant son chargement). Verrouillé pendant
                // le streaming (comme ChatPage) : changer de modèle en plein
                // tour effacerait l'affinité de routage sous le tour en cours.
                disabled={
                  streaming ||
                  (engineProviderId !== null && neutralModelsState === "loading") ||
                  (selectedAgent !== null && selectedAgent.model !== null)
                }
              >
                {/* R2 — sentinelle opt-in : jamais défaut, toujours proposée. */}
                <option value={AUTO_MODEL} title="Démarre sur le modèle le plus fort de la table ; descendre est un choix manuel.">Auto (descendant)</option>
                {engineProviderId === null &&
                  MODEL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                {engineProviderId !== null && neutralModels.length === 0 && model !== AUTO_MODEL && (
                  <option value="">—</option>
                )}
                {engineProviderId !== null && neutralModels.length > 0 && neutralFeaturedModels.length === 0 &&
                  neutralModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                {engineProviderId !== null && neutralModels.length > 0 && neutralFeaturedModels.length > 0 && (
                  <>
                    <optgroup label="Mis en avant">
                      {neutralFeaturedModels.map((m) => (
                        <option key={`fav-${m.id}`} value={m.id}>
                          ★ {m.id}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Tous les modèles">
                      {neutralModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </optgroup>
                  </>
                )}
              </select>
            </div>

            {engineProviderId !== null && (
              <OllamaPanel providerId={engineProviderId} selectedModel={model} />
            )}

            {engineProviderId !== null && neutralModelsState === "error" && (
              <div className="result-line result-line--error">Erreur modèles : {neutralModelsError}</div>
            )}

            {/* « Nouvelle session » vit désormais en tête de la section Sessions
                (toujours accessible) — plus de doublon ici. */}

            <div className="sidebar-indicators">
              <span
                className={`agent-engine-indicator${engineProviderId ? " agent-engine-indicator--neutral" : " agent-engine-indicator--claude"}`}
                title="Moteur de l'agent"
              >
                {engineProviderId ? (providers.find((p) => p.id === engineProviderId)?.label ?? engineProviderId) : "Claude"}
              </span>
              <span className={`agent-session-indicator${sessionId ? " agent-session-indicator--active" : ""}`}>
                {sessionId ? `Session ${sessionId.slice(0, 8)}` : "Aucune session"}
              </span>
            </div>
          </SidebarSection>

          <SidebarSection
            id="knowledge"
            title="Connaissances"
            defaultOpen={false}
            badge={injectedKnowledge.length > 0 ? <span className="sidebar-section__count">{injectedKnowledge.length}</span> : undefined}
          >
            {/* R5 — bascule injection/RAG + index d'embeddings local (docs/spec-r5-rag.md §4). */}
            <div className="knowledge-rag">
              <div className="field">
                <label htmlFor="knowledge-mode-select">Mode</label>
                <select
                  id="knowledge-mode-select"
                  value={knowledgeMode}
                  disabled={!selectedProjectId || streaming}
                  title="Injection : documents recopiés en préambule du 1er tour. RAG : l'agent interroge l'index local via l'outil search_knowledge."
                  onChange={(e) => changeKnowledgeMode(e.currentTarget.value === "rag" ? "rag" : "injection")}
                >
                  <option value="injection">Injection intégrale (défaut)</option>
                  <option value="rag">RAG — outil search_knowledge</option>
                </select>
              </div>
              <div className="knowledge-rag__status">
                {knowledgeIdx?.exists ? (
                  <>
                    <span>
                      Index : {knowledgeIdx.files} fichier{knowledgeIdx.files > 1 ? "s" : ""} ·{" "}
                      {knowledgeIdx.chunks} chunk{knowledgeIdx.chunks > 1 ? "s" : ""}
                      {knowledgeIdx.model ? ` · ${knowledgeIdx.model}` : ""}
                      {knowledgeIdx.builtAt ? ` · ${formatRelativeDate(knowledgeIdx.builtAt)}` : ""}
                    </span>
                    {knowledgeIdx.stale && (
                      <span
                        className="knowledge-rag__stale"
                        title="Un document source a changé depuis la dernière indexation — relancer « Indexer maintenant »."
                      >
                        ⚠ index obsolète
                      </span>
                    )}
                  </>
                ) : (
                  <span>Aucun index — indexer pour activer l'outil search_knowledge.</span>
                )}
              </div>
              <button
                type="button"
                className="btn btn--ghost knowledge-rag__index"
                disabled={!cwd || indexingKnowledge}
                onClick={() => void handleIndexKnowledge()}
              >
                {indexingKnowledge
                  ? knowledgeIndexProgress
                    ? `Indexation… ${knowledgeIndexProgress.done}/${knowledgeIndexProgress.total}`
                    : "Indexation…"
                  : "Indexer maintenant"}
              </button>
              {knowledgeIndexError && <p className="knowledge-rag__error">{knowledgeIndexError}</p>}
            </div>

            {pinnedKnowledge.length === 0 &&
            autoKnowledgeDocs.length === 0 &&
            !projectBadges.claudeMdPath &&
            claudeMemoryFiles.length === 0 ? (
              <p className="empty-hint">
                Clic droit sur un fichier dans « Fichiers » → « Épingler comme connaissance », ou déposez des
                fichiers dans .iaction/connaissances/.
              </p>
            ) : (
              <>
                {pinnedKnowledge.length > 0 && (
                  <div className="knowledge-group">
                    <p className="knowledge-group__title">Épinglées</p>
                    <ul className="knowledge-list">
                      {pinnedKnowledge.map((doc) => (
                        <li key={doc.path} className="knowledge-item">
                          <button
                            type="button"
                            className="knowledge-item__open"
                            title={doc.path}
                            onClick={() => handleOpenFile(doc.path, doc.name)}
                          >
                            {doc.name}
                          </button>
                          <button
                            type="button"
                            className="knowledge-item__remove"
                            aria-label={`Retirer ${doc.name}`}
                            title="Retirer"
                            onClick={() => unpinKnowledge(doc.path)}
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {autoKnowledgeDocs.length > 0 && (
                  <div className="knowledge-group">
                    <p
                      className="knowledge-group__title"
                      title="Retirer un fichier = le supprimer du dossier .iaction/connaissances/"
                    >
                      Automatiques (.iaction/connaissances)
                    </p>
                    <ul className="knowledge-list">
                      {autoKnowledgeDocs.map((doc) => (
                        <li key={doc.path} className="knowledge-item">
                          <button
                            type="button"
                            className="knowledge-item__open"
                            title={`${doc.path} — retrait : supprimer le fichier du dossier .iaction/connaissances/`}
                            onClick={() => handleOpenFile(doc.path, doc.name)}
                          >
                            {doc.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {(projectBadges.claudeMdPath || claudeMemoryFiles.length > 0) && (
                  <div className="knowledge-group">
                    <p className="knowledge-group__title">Détectées</p>
                    <ul className="knowledge-list">
                      {projectBadges.claudeMdPath && (
                        <li className="knowledge-item">
                          <button
                            type="button"
                            className="knowledge-item__open"
                            title="Instructions projet — chargée automatiquement par le moteur Claude ; non ré-injectée par iaction"
                            onClick={() => handleOpenFile(projectBadges.claudeMdPath as string, "CLAUDE.md")}
                          >
                            CLAUDE.md
                          </button>
                          <span className="knowledge-item__tag">chargée par le moteur Claude</span>
                        </li>
                      )}
                      {claudeMemoryFiles.map((f) => {
                        const alreadyPinned = pinnedKnowledge.some((d) => d.path === f.path);
                        return (
                          <li key={f.path} className="knowledge-item">
                            <button
                              type="button"
                              className="knowledge-item__open"
                              title={`${f.path} — mémoire Claude Code`}
                              onClick={() => handleOpenFile(f.path, f.name)}
                            >
                              {f.name}
                            </button>
                            <button
                              type="button"
                              className="knowledge-item__pin"
                              disabled={alreadyPinned}
                              title={
                                alreadyPinned
                                  ? "Déjà épinglée (injectée au 1er tour)"
                                  : "Épingler comme connaissance (l'ajoute aux épinglées, injectée au 1er tour — utile pour le moteur neutre)"
                              }
                              onClick={() => pinKnowledge(f.path, f.name)}
                            >
                              {alreadyPinned ? "Épinglée" : "Épingler"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </SidebarSection>

          <SidebarSection
            id="mcp"
            title="MCP"
            defaultOpen={false}
            badge={mcpServers.length > 0 ? <span className="sidebar-section__count">{mcpServers.length}</span> : undefined}
          >
            {mcpServers.length === 0 ? (
              <p className="empty-hint">
                Aucun serveur MCP déclaré. Déclarez-les dans .mcp.json à la racine du projet.
              </p>
            ) : (
              <ul className="mcp-list">
                {mcpServers.map((s) => {
                  const usage = mcpUsage[s.name];
                  return (
                    <li key={s.name} className="mcp-item">
                      <div className="mcp-item__head">
                        <span className="mcp-item__name">{s.name}</span>
                        <span className="mcp-item__kind">{s.kind}</span>
                      </div>
                      <div className="mcp-item__detail" title={s.detail}>
                        {s.detail}
                      </div>
                      {usage && (
                        <div className="mcp-item__usage">
                          {usage.calls} appel{usage.calls > 1 ? "s" : ""} · dernier : {usage.lastTool}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </SidebarSection>
        </aside>
      </div>

      {currentPermission && (
        <PermissionModal
          item={currentPermission}
          extraCount={permissionQueue.length - 1}
          onDecide={(decision, message, rememberTool) =>
            void handlePermissionDecision(decision, message, rememberTool)
          }
        />
      )}
    </div>
  );
});
