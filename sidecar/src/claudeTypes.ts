/*
 * Types minimalistes du sous-ensemble du SDK Claude utilisé par le moteur
 * (feuille : types seuls, aucune valeur). Sortis de claude.ts (T-209) ;
 * claude.ts les ré-exporte pour ses appelants et ses tests.
 */
import type { NiveauEffort } from "./claudeEffort.js";

// ---------------------------------------------------------------------------
// Types minimalistes pour le sous-ensemble du SDK utilisé ici.
//
// Basés sur les .d.ts réels de @anthropic-ai/claude-agent-sdk v0.3.x
// (node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts) :
//   - query(params: {prompt, options}): Query
//   - Query extends AsyncGenerator<SDKMessage, void> avec interrupt(): Promise<...>
//   - CanUseTool: (toolName, input, options: {signal, toolUseID, ...}) => Promise<PermissionResult | null>
//   - PermissionResult: {behavior:"allow", updatedInput?} | {behavior:"deny", message: string, ...}
//   - messages : {type:"system", subtype:"init", session_id, model, ...}
//                {type:"stream_event", event: BetaRawMessageStreamEvent, ...}
//                {type:"assistant", message: {content: BetaContentBlock[]}, ...}
//                {type:"user", message: {content: (tool_result|...)[]}, ...}
//                {type:"result", subtype, result?, usage (snake_case: input_tokens,
//                 output_tokens, cache_read_input_tokens, ...), total_cost_usd, session_id}
// On reste volontairement en unknown/Record<string, unknown> + narrowing plutôt
// que d'importer les types réels du SDK, pour ne pas coupler ce module à sa
// surface complète (des dizaines de types non utilisés ici).
// ---------------------------------------------------------------------------

export interface PermissionResultAllow {
  behavior: "allow";
  updatedInput?: Record<string, unknown>;
}

export interface PermissionResultDeny {
  behavior: "deny";
  message: string;
}

export type PermissionResult = PermissionResultAllow | PermissionResultDeny;

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; [key: string]: unknown },
) => Promise<PermissionResult | null>;

export interface ClaudeQueryOptions {
  cwd?: string;
  resume?: string;
  model?: string;
  /** Niveau d'effort de raisonnement (voir claudeEffort.ts) — absent = réglage global. */
  effort?: string;
  permissionMode?: string;
  systemPrompt?: import("./paletteTour.js").InstructionSysteme;
  includePartialMessages?: boolean;
  /** Nombre maximal de tours agent (le titre d'une discussion n'en joue qu'un : `titreDiscussion.ts`). */
  maxTurns?: number;
  /** `false` = rien n'est écrit dans `~/.claude/projects` : un tour jetable ne doit pas laisser de session fantôme. */
  persistSession?: boolean;
  /** Abandon du tour par l'appelant (délai borné). */
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  canUseTool?: CanUseTool;
  /**
   * Jeu d'outils intégrés disponibles. `[]` = aucun outil (mode chat pur :
   * le modèle ne voit même pas les outils, il répond directement).
   */
  tools?: string[];
  /**
   * Serveurs MCP à exposer au SDK (voir docs/protocol.md, section claude.start
   * § MCP). Config stdio ({command, args?, env?}) ou distante ({type, url,
   * headers?}) — passée telle quelle au SDK sans re-validation de schéma.
   * Absent en mode chatOnly.
   */
  mcpServers?: Record<string, unknown>;
  /**
   * Sources de réglages filesystem chargées par le SDK (`user` = ~/.claude,
   * `project` = <cwd>/.claude, `local` = settings.local). Omis = toutes les
   * sources (défaut CLI). On passe les trois pour le moteur projet : les
   * skills GLOBAUX du poste (~/.claude/skills : grill-me, maison…) et les
   * commandes globales (~/.claude/commands) sont volontairement hérités par
   * tous les projets — décision du 2026-08-03, qui remplace l'isolation
   * stricte d'origine (voir docs/protocol.md, claude.start). `'project'` doit
   * rester présent pour que CLAUDE.md du projet soit chargé.
   */
  settingSources?: ("user" | "project" | "local")[];
  /** Drapeaux CLI bruts transmis par le SDK (`null` = drapeau sans valeur). */
  extraArgs?: Record<string, string | null>;
  /**
   * Outils intégrés retirés du contexte du modèle. On y met `AskUserQuestion` :
   * son formulaire interactif ne peut PAS être rendu ni répondu via l'API
   * programmatique du SDK v0.3.x (vérifié : ni `canUseTool` — qui ne peut que
   * autoriser/refuser, jamais fournir de réponse — ni le dialogue
   * `onUserDialog`, jamais émis par le CLI bundlé, ne remontent la question).
   * L'outil s'affichait alors en bloc `tool_use` brut puis retournait un
   * résultat vide, et le modèle réexpliquait sa question en texte. En le
   * retirant, le modèle pose directement ses questions en texte dans le chat —
   * l'utilisateur y répond dans le composeur, ce qui fonctionne réellement.
   */
  disallowedTools?: string[];
}

/** Le sous-ensemble de `Query` (AsyncGenerator<SDKMessage, void> + interrupt()) qu'on utilise. */
export interface ClaudeQuery {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  interrupt(): Promise<unknown>;
  /**
   * Voie officielle mais instable du SDK pour récupérer l'usage de session +
   * l'utilisation des fenêtres de rate-limit d'abonnement (SDKControlGetUsageResponse,
   * voir node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts ~L2417/L3151).
   * Optionnelle : le faux SDK utilisé par la plupart des tests ne l'implémente pas.
   */
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(): Promise<unknown>;
  /**
   * Liste des slash-commands / skills disponibles pour la session, capturée à
   * l'initialisation (voir node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
   * ~L2378, type `SlashCommand`). Optionnelle : le faux SDK des tests ne
   * l'implémente pas forcément.
   */
  supportedCommands?(): Promise<
    Array<{ name: string; description?: string; argumentHint?: string; aliases?: string[] }>
  >;
  /**
   * T-207 — changer de modèle / d'effort EN COURS de tour (mode entrée
   * streamée, celui de tous nos tours). Optionnelles : le faux SDK des tests
   * ne les implémente pas forcément ; leur absence est une erreur franche, pas
   * un échec muet (voir changerModele.ts, `appliquerSurQuery`).
   */
  setModel?(model?: string): Promise<void>;
  applyFlagSettings?(settings: { effortLevel: NiveauEffort | null }): Promise<void>;
}

/**
 * `prompt` accepte aussi un flux asynchrone d'un unique message utilisateur à
 * blocs de contenu (`AsyncIterable<Record<string, unknown>>`) — c'est la forme
 * `SDKUserMessage` du SDK (voir node_modules/@anthropic-ai/claude-agent-sdk/
 * sdk.d.ts : `query(prompt: string | AsyncIterable<SDKUserMessage>)`), utilisée
 * uniquement quand des pièces jointes sont présentes (voir buildAttachedPrompt
 * plus bas). Sans pièces jointes, le chemin chaîne reste inchangé.
 */
export type ClaudeQueryFn = (params: {
  prompt: string | AsyncIterable<Record<string, unknown>>;
  options?: ClaudeQueryOptions;
}) => ClaudeQuery;
