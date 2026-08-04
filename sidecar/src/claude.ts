/**
 * Moteur Claude — Lot 2.
 *
 * Pilote le Claude Agent SDK (@anthropic-ai/claude-agent-sdk) pour les tours de
 * conversation agentique (voir docs/protocol.md, section « Méthodes Lot 2 —
 * moteur Claude »).
 *
 * Règle absolue : une apiKey ne doit jamais être écrite sur disque, ni loguée
 * (même sur stderr) — y compris dans les messages d'erreur.
 *
 * Injection de dépendance : `createClaudeEngine({ queryFn })` construit un
 * moteur autonome (état en mémoire propre) à partir d'une fonction `query`
 * quelconque — c'est le point d'entrée que les tests utilisent pour injecter
 * un faux SDK. En usage normal, `resolveQueryFn()` choisit la fonction `query`
 * réelle du SDK, importée dynamiquement pour ne jamais toucher le SDK réel
 * (ni le sous-processus `claude`) lorsque les tests activent le mode faux via
 * la variable d'environnement `IACTION_FAKE_CLAUDE=1` (le module de
 * remplacement est désigné par `IACTION_FAKE_CLAUDE_MODULE`, un chemin
 * absolu vers un module ESM exportant `fakeQuery`).
 */

import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { EngineEmitter } from "./engine.js";
import {
  formatTextAttachmentPrefix,
  isImageAttachment,
  isTextAttachment,
  validateAttachments,
  type Attachment,
} from "./attachments.js";
import * as journal from "./journal.js";
import { buildKnowledgeMcpServer } from "./knowledge.js";
import { ensureProjectDoc } from "./projectDoc.js";
import { recordClaudeWindowsSnapshot, recordUsageEvent, type UsageStatus } from "./usageStats.js";

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
  permissionMode?: string;
  systemPrompt?: string;
  includePartialMessages?: boolean;
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
   * sources (défaut CLI). On passe `['project', 'local']` pour le moteur
   * projet : seuls les skills/réglages DU projet comptent, pas les skills
   * globaux (~/.claude/skills) — isolation entre projets
   * (voir docs/protocol.md, claude.start). `'project'` doit rester présent
   * pour que CLAUDE.md du projet soit chargé.
   */
  settingSources?: ("user" | "project" | "local")[];
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

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_SUMMARY = 500;

/** Résumé textuel borné du contenu d'un tool_result (string ou tableau de blocs). */
function summarizeToolResult(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        if (isPlainObject(block) && typeof block.text === "string") {
          return block.text;
        }
        try {
          return JSON.stringify(block);
        } catch {
          return String(block);
        }
      })
      .join("\n");
  } else if (content === null || content === undefined) {
    text = "";
  } else {
    try {
      text = JSON.stringify(content);
    } catch {
      text = String(content);
    }
  }
  return text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY) + "…" : text;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

/** Le SDK expose l'usage en snake_case (hérité de l'API Anthropic). */
function extractUsage(usage: unknown): Usage | null {
  if (!isPlainObject(usage)) {
    return null;
  }
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const result: Usage = { inputTokens, outputTokens };
  if (typeof usage.cache_read_input_tokens === "number") {
    result.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  return result;
}

/**
 * Occupation de la FENÊTRE de contexte d'UN appel API, d'après l'usage d'un
 * message `assistant` (une réponse modèle = un appel). C'est la taille du PROMPT
 * de cet appel : tokens frais + préfixe relu du cache + préfixe nouvellement mis
 * en cache. Ces trois composantes partitionnent le prompt, dont la somme est
 * bornée par la fenêtre du modèle (sinon l'API refuse) → jauge ≤ 100 %.
 *
 * On N'AJOUTE PAS `output_tokens` : la sortie ne compte pas dans la fenêtre
 * d'ENTRÉE (elle se génère par-dessus), et elle est de toute façon ré-incluse
 * dans le `cache_read` de l'appel suivant — l'additionner ici la compterait
 * double et ferait dépasser 100 % (input quasi plein + sortie ⇒ ~140 %).
 *
 * ⚠ NE PAS confondre avec l'usage du message `result` : celui-ci CUMULE toutes
 * les requêtes du tour agentique (N appels d'outils) — son
 * `cache_read_input_tokens` additionne N fois le même préfixe et dépasse alors
 * largement la fenêtre (d'où un « contexte » à plusieurs centaines de %). Pour
 * la jauge, seul le PROMPT du DERNIER appel compte, pas le cumul.
 */
function extractContextTokens(usage: unknown): number | null {
  if (!isPlainObject(usage)) return null;
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
  const total = input + cacheRead + cacheCreation;
  return total > 0 ? total : null;
}

function decorateAuthError(message: string): string {
  // Limite d'abonnement : à distinguer d'un défaut d'authentification (le mot
  // « limit » côtoie souvent « credit »/« plan » dans ces messages), sinon
  // l'utilisateur reçoit un conseil de reconnexion sans rapport.
  if (/usage limit|rate.?limit|limit reached|quota/i.test(message)) {
    return `${message} — limite d'abonnement atteinte ; voir la jauge de session en en-tête pour le temps restant avant réinitialisation.`;
  }
  if (/auth|login|api key/i.test(message)) {
    return `${message} — connectez-vous via \`claude login\` ou configurez une clé API dans Fournisseurs.`;
  }
  return message;
}

// ---------------------------------------------------------------------------
// Pièces jointes — construction du prompt à blocs (voir docs/protocol.md,
// section Pièces jointes, § « Moteur Claude »). Uniquement emprunté quand
// params.attachments contient au moins une pièce ; sans pièces jointes, le
// prompt reste une simple chaîne (chemin inchangé, zéro régression).
// ---------------------------------------------------------------------------

/**
 * Un unique message utilisateur SDK (forme `SDKUserMessage` minimale : les
 * champs optionnels du SDK — uuid, session_id, etc. — sont omis, le SDK ne
 * les exige pas) porté par un flux asynchrone d'un seul élément, comme l'exige
 * la signature `query({prompt: string | AsyncIterable<SDKUserMessage>})`.
 */
function buildUserMessage(promptText: string, attachments: Attachment[]): Record<string, unknown> {
  const textPrefixes = attachments
    .filter(isTextAttachment)
    .map((doc) => formatTextAttachmentPrefix(doc.name, doc.content));
  const text = [...textPrefixes, promptText].filter((part) => part.length > 0).join("\n\n");

  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const image of attachments.filter(isImageAttachment)) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    });
  }

  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

/**
 * Prompt d'un tour en ENTRÉE STREAMÉE : yield le message utilisateur, puis
 * reste suspendu jusqu'à `close()`.
 *
 * Pourquoi ne pas passer une simple chaîne : avec un prompt-chaîne (ou un
 * générateur d'un seul élément), le SDK ferme l'entrée aussitôt et le CLI
 * s'ARRÊTE de lui-même après le `result` — emportant ses tâches de fond
 * (`run_in_background`), tuées à mi-course. Vécu le 2026-07-31 : un
 * `make docs-build` lancé en fond meurt 5 s après la fin du tour, et le tour
 * suivant reçoit ses `task-notification` « orphelines ». Garder l'entrée
 * ouverte laisse le process vivre : les tâches poursuivent, leurs rapports
 * réveillent l'agent (nouveau tour → nouveau `result`), et c'est le sidecar
 * qui décide de la fin (plafond BACKGROUND_WAIT_TIMEOUT_MS ou claude.release).
 * `close()` est donc OBLIGATOIRE en fin de tour, sinon le process CLI fuit.
 */
function createTurnPrompt(
  promptText: string,
  attachments: Attachment[],
): { iterable: AsyncIterable<Record<string, unknown>>; close: () => void } {
  let closeResolve: (() => void) | null = null;
  const closeSignal = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  async function* gen(): AsyncGenerator<Record<string, unknown>> {
    yield buildUserMessage(promptText, attachments);
    await closeSignal;
  }
  return { iterable: gen(), close: () => closeResolve?.() };
}

// ---------------------------------------------------------------------------
// claude.commands — session « à vide » (aucun tour joué) pour ne récupérer
// que supportedCommands(). Voir docs/protocol.md, section « claude.commands ».
// ---------------------------------------------------------------------------

/**
 * Construit un prompt en entrée streamée qui ne yield JAMAIS de message
 * utilisateur : le générateur reste suspendu sur une promesse tant que
 * `close()` n'a pas été appelé. Ça suffit à faire démarrer une session SDK
 * complète (system/init, supportedCommands()...) sans jamais envoyer de tour
 * à Claude — donc sans consommer le moindre token. `close()` termine le
 * générateur proprement (return), ce qui permet à `query.interrupt()` de
 * refermer le process CLI sous-jacent sans qu'il reste bloqué en attente
 * d'une entrée qui ne viendra jamais.
 */
function createNonYieldingPrompt(): {
  iterable: AsyncIterable<Record<string, unknown>>;
  close: () => void;
} {
  let closeResolve: (() => void) | null = null;
  const closeSignal = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  async function* gen(): AsyncGenerator<Record<string, unknown>> {
    await closeSignal;
  }
  return {
    iterable: gen(),
    close: () => closeResolve?.(),
  };
}

/** Rejette avec `timeoutMessage` si `promise` ne s'est pas réglée sous `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const COMMANDS_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Support MCP v1 — lecture optionnelle de <cwd>/.mcp.json (convention Claude
// Code : {"mcpServers": {"<nom>": {...}}}). Tolérant aux erreurs : un fichier
// absent, invalide, ou mal formé ne fait jamais échouer le tour — juste un
// log stderr et la poursuite sans MCP (voir docs/protocol.md, claude.start §
// MCP).
// ---------------------------------------------------------------------------

async function loadMcpServersConfig(cwd: string): Promise<Record<string, unknown> | null> {
  const mcpConfigPath = path.join(cwd, ".mcp.json");
  let raw: string;
  try {
    raw = await readFile(mcpConfigPath, "utf8");
  } catch {
    // Fichier absent (ou illisible) : comportement inchangé, silencieux.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `warn` et non `error` : le tour continue sans les serveurs MCP du
    // projet — dégradation acceptée, pas un échec de l'action utilisateur.
    journal.warn("claude", ".mcp.json contient du JSON invalide, ignoré", {
      fields: { fichier: mcpConfigPath, erreur: message },
    });
    return null;
  }

  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    journal.warn("claude", ".mcp.json sans objet \"mcpServers\" valide, ignoré", {
      fields: { fichier: mcpConfigPath },
    });
    return null;
  }

  const servers = parsed.mcpServers;
  for (const [name, config] of Object.entries(servers)) {
    if (!isPlainObject(config)) {
      journal.warn("claude", ".mcp.json — entrée mcpServers invalide, fichier ignoré", {
        fields: { fichier: mcpConfigPath, entree: name },
      });
      return null;
    }
  }

  return servers;
}

// ---------------------------------------------------------------------------
// usage.claude — instantané des limites d'abonnement (mini-tranche du Lot 8)
// ---------------------------------------------------------------------------

export interface ClaudeUsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface ClaudeUsageSnapshot {
  available: boolean;
  subscriptionType: string | null;
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  /**
   * TOUTES les fenêtres présentes dans `rate_limits` (clé brute → fenêtre),
   * y compris celles spécifiques à un modèle (ex. hebdo Opus/Fable) dont le
   * nommage peut évoluer — l'API est expérimentale, on relaie sans présumer.
   * `fiveHour`/`sevenDay` restent extraits à part pour compatibilité.
   */
  windows: Record<string, ClaudeUsageWindow>;
  capturedAt: string;
}

const USAGE_CAPTURE_TIMEOUT_MS = 3000;

function extractUsageWindow(value: unknown): ClaudeUsageWindow | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return {
    utilization: typeof value.utilization === "number" ? value.utilization : null,
    resetsAt: typeof value.resets_at === "string" ? value.resets_at : null,
  };
}

/**
 * Capture défensive de l'instantané d'usage via la méthode expérimentale du
 * SDK. Ne lève jamais : indisponibilité, forme inattendue ou lenteur (>3s)
 * renvoient simplement `null` sans perturber la fin du tour claude.start.
 */
async function captureUsageSnapshot(query: ClaudeQuery): Promise<ClaudeUsageSnapshot | null> {
  try {
    if (typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") {
      return null;
    }
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), USAGE_CAPTURE_TIMEOUT_MS);
    });
    const result = await Promise.race([
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      timeout,
    ]);
    if (!isPlainObject(result)) {
      return null;
    }
    const rateLimits = isPlainObject(result.rate_limits) ? result.rate_limits : null;
    const windows: Record<string, ClaudeUsageWindow> = {};
    if (rateLimits) {
      for (const [key, value] of Object.entries(rateLimits)) {
        const window = extractUsageWindow(value);
        if (window && window.utilization !== null) {
          windows[key] = window;
        }
      }
    }
    return {
      available: result.rate_limits_available === true,
      subscriptionType: typeof result.subscription_type === "string" ? result.subscription_type : null,
      fiveHour: rateLimits ? extractUsageWindow(rateLimits.five_hour) : null,
      sevenDay: rateLimits ? extractUsageWindow(rateLimits.seven_day) : null,
      windows,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Moteur : createClaudeEngine({queryFn}) — état en mémoire isolé, injectable
// ---------------------------------------------------------------------------

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
}

interface RunState {
  query: ClaudeQuery;
  pendingPermissions: Map<string, PendingPermission>;
  permCounter: number;
  aborted: boolean;
  /** Tour du modèle fini mais process gardé ouvert en attente des rapports de
      tâches de fond (voir le case "result") : seul état où claude.release agit. */
  waitingBackground: boolean;
  /** Ferme l'entrée streamée du tour (voir createTurnPrompt) : sans cet appel,
      le process CLI reste vivant en attente d'un message qui ne viendra pas. */
  closePrompt: () => void;
}

/** Plafond d'attente des rapports de tâches de fond après la fin du tour du
    modèle : au-delà, interrupt() fait retomber la boucle et le repli de fin de
    flux livre le résultat déjà connu (pendingResultDone). Sans plafond, une
    tâche de fond qui ne se termine jamais (serveur, watcher) gardait le tour
    ouvert indéfiniment — l'UI ne rendait jamais la main. Surchargable via
    l'environnement pour les tests. */
const BACKGROUND_WAIT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.IACTION_BACKGROUND_WAIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();

export interface ClaudeEngine {
  handleClaudeConfigure(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeStart(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void>;
  handleClaudePermission(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeAbort(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeRelease(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeUsage(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeUsageInit(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void>;
  handleClaudeCommands(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void>;
}

export function createClaudeEngine(deps: { queryFn: ClaudeQueryFn }): ClaudeEngine {
  const { queryFn } = deps;

  /** Clé API en mémoire uniquement — jamais écrite sur disque, jamais loguée. */
  let apiKey: string | null = null;

  /** Tours en cours, indexés par l'id de la requête claude.start correspondante. */
  const runs = new Map<string, RunState>();

  /** Dernier instantané connu des limites d'abonnement (voir usage.claude). */
  let lastUsageSnapshot: ClaudeUsageSnapshot | null = null;

  function denyAllPending(run: RunState, message: string): void {
    for (const pending of run.pendingPermissions.values()) {
      pending.resolve({ behavior: "deny", message });
    }
    run.pendingPermissions.clear();
  }

  function handleClaudeConfigure(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void {
    const rawKey = params.apiKey;
    if (rawKey === null || rawKey === undefined) {
      apiKey = null;
      emitter.done(id, { configured: false });
      return;
    }
    if (!isNonEmptyString(rawKey)) {
      emitter.error(id, "params.apiKey doit être une chaîne non vide ou null");
      return;
    }
    apiKey = rawKey;
    emitter.done(id, { configured: true });
  }

  async function handleClaudeStart(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void> {
    const chatOnly = params.chatOnly === true;
    const webSearch = params.webSearch === true;
    // En mode chat pur, aucun outil ne touche au disque : un cwd neutre
    // (répertoire personnel) suffit si l'appelant n'en fournit pas.
    let cwd: string | null = null;
    if (isNonEmptyString(params.cwd)) {
      cwd = params.cwd;
    } else if (chatOnly) {
      cwd = os.homedir();
    }
    const prompt = params.prompt;
    if (!isNonEmptyString(cwd)) {
      emitter.error(id, "params.cwd manquant ou invalide");
      return;
    }
    if (!isNonEmptyString(prompt)) {
      emitter.error(id, "params.prompt manquant ou invalide");
      return;
    }

    const attachmentsValidation = validateAttachments(params.attachments);
    if (!attachmentsValidation.ok) {
      emitter.error(id, attachmentsValidation.message);
      return;
    }
    // Entrée streamée TOUJOURS (pièces jointes ou non) : c'est ce qui garde le
    // process CLI en vie après le `result` — voir createTurnPrompt.
    const turnPrompt = createTurnPrompt(prompt, attachmentsValidation.attachments);
    const promptForQuery: AsyncIterable<Record<string, unknown>> = turnPrompt.iterable;

    const sessionIdParam = params.sessionId;
    const modelParam = params.model;
    const permissionModeParam = params.permissionMode;
    const systemPromptParam = params.systemPrompt;

    // Guide d'intégration déposé dans le projet (.iaction/connaissances/,
    // voir projectDoc.ts) : rafraîchi en début de tour projet, best effort.
    if (!chatOnly) {
      await ensureProjectDoc(cwd);
    }
    // Support MCP v1 : lecture de <cwd>/.mcp.json, sauf en mode chat pur (le
    // chat pur ne doit voir aucun outil, MCP compris — voir docs/protocol.md).
    const mcpServers = chatOnly ? null : await loadMcpServersConfig(cwd);
    // R5 — RAG local : serveur MCP in-process `iaction` (outil
    // `mcp__iaction__search_knowledge`, voir knowledge.ts), exposé SEULEMENT
    // quand l'index du projet existe — même flux de permission que les autres
    // outils MCP (canUseTool). Jamais en mode chat pur.
    const knowledgeServer = chatOnly ? null : await buildKnowledgeMcpServer(cwd);

    const runState: RunState = {
      // Initialisé juste après l'appel à queryFn ci-dessous.
      query: undefined as unknown as ClaudeQuery,
      pendingPermissions: new Map(),
      permCounter: 0,
      aborted: false,
      waitingBackground: false,
      closePrompt: turnPrompt.close,
    };

    const canUseTool: CanUseTool = (toolName, toolInput, toolOptions) => {
      return new Promise<PermissionResult>((resolve) => {
        runState.permCounter += 1;
        const permissionId = `perm-${runState.permCounter}`;
        runState.pendingPermissions.set(permissionId, { resolve });
        emitter.chunk(id, {
          kind: "permission_request",
          permissionId,
          toolName,
          toolInput,
        });

        const settleIfAborted = () => {
          if (runState.pendingPermissions.delete(permissionId)) {
            resolve({ behavior: "deny", message: "Tour interrompu" });
          }
        };
        if (toolOptions.signal.aborted) {
          settleIfAborted();
        } else {
          toolOptions.signal.addEventListener("abort", settleIfAborted, { once: true });
        }
      });
    };

    const options: ClaudeQueryOptions = {
      cwd,
      includePartialMessages: true,
      permissionMode: isNonEmptyString(permissionModeParam) ? permissionModeParam : "default",
      env: { ...process.env, ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) },
      canUseTool,
    };
    if (chatOnly) {
      options.tools = webSearch ? ["WebSearch", "WebFetch"] : [];
    } else {
      // Moteur projet : isolation stricte des skills/réglages au projet —
      // on n'hérite pas des skills globaux (~/.claude/skills) ni des réglages
      // utilisateur globaux. 'project' reste présent → CLAUDE.md chargé.
      options.settingSources = ["project", "local"];
      // AskUserQuestion retiré : non fonctionnel via le SDK (voir le champ
      // `disallowedTools`) — le modèle pose ses questions en texte, ce qui
      // marche. Le mode chat pur n'a de toute façon aucun outil.
      options.disallowedTools = ["AskUserQuestion"];
    }
    if (isNonEmptyString(sessionIdParam)) {
      options.resume = sessionIdParam;
    }
    if (isNonEmptyString(modelParam)) {
      options.model = modelParam;
    }
    if (isNonEmptyString(systemPromptParam)) {
      options.systemPrompt = systemPromptParam;
    }
    if (!chatOnly && (mcpServers || knowledgeServer)) {
      // Le serveur `iaction` s'ajoute aux serveurs déclarés dans .mcp.json ;
      // un serveur du projet nommé « iaction » prime (pas d'écrasement).
      options.mcpServers = {
        ...(knowledgeServer ? { iaction: knowledgeServer } : {}),
        ...(mcpServers ?? {}),
      };
    }

    let query: ClaudeQuery;
    try {
      query = queryFn({ prompt: promptForQuery, options });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitter.error(id, decorateAuthError(message));
      return;
    }
    runState.query = query;
    runs.set(id, runState);

    let lastSessionId: string | null = isNonEmptyString(sessionIdParam) ? sessionIdParam : null;
    // Modèle « effectif » (Lot 8, tranche 1) : celui résolu par le SDK dans le
    // message system/init prime sur celui demandé, s'il est connu.
    let lastModel: string | null = isNonEmptyString(modelParam) ? modelParam : null;
    let sawResult = false;
    /** Passe à true sur le message `result` FINAL : provoque la sortie de la boucle (voir ce case). */
    let turnFinished = false;
    /** Tâches de fond vivantes (system/background_tasks_changed, sémantique REPLACE :
        chaque message remplace la liste entière). Tant qu'il en reste, un `result`
        ne clôt PAS le tour : le process doit vivre pour recevoir leurs rapports. */
    let backgroundTasks: { taskId: string; description: string }[] = [];
    /** Au moins un contenu assistant (texte, raisonnement, outil) vu sur ce tour :
        distingue un vrai tour d'un micro-tour interne du CLI (ex. livraison de
        notifications de tâches sur un resume) clos sans appel au modèle. */
    let sawAssistantOutput = false;
    /** Occupation de la fenêtre de contexte au DERNIER appel API du tour (usage
        du dernier message `assistant`) — voir extractContextTokens. Sert la
        jauge « Contexte » de l'en-tête, à la place du cumul du `result`. */
    let lastContextTokens: number | null = null;
    /** Au moins un delta de texte streamé depuis le dernier message `assistant`
        complet. Sert à repérer les messages assistant JAMAIS streamés — le CLI
        en synthétise (ex. « API Error: 529 Overloaded », model "<synthetic>")
        sans passer par stream_event : sans réémission ici, leur texte
        n'atteindrait jamais l'UI (tour « terminé sans résultat », vécu le
        2026-07-26 sur un 529). Remis à false après chaque message assistant. */
    let sawTextDeltaForCall = false;
    /** Dernier `result` NON final (tour en attente de tâches de fond, micro-tour
        vide) : repli émis si le flux se termine sans autre `result`. */
    let pendingResultDone: {
      sessionId: string | null;
      subtype: string;
      result: string | null;
      usage: ReturnType<typeof extractUsage>;
      contextTokens: number | null;
      totalCostUsd: number | null;
    } | null = null;
    /** Nombre de micro-tours vides ignorés (borné : au-delà, on clôt quand même). */
    let spuriousEmptyResults = 0;
    /** Garde-fou du micro-tour vide : si RIEN ne suit dans les 30 s, interrupt()
        fait retomber la boucle et le repli de fin de flux émet le résultat connu. */
    let emptyResultWatchdog: ReturnType<typeof setTimeout> | null = null;
    const clearEmptyResultWatchdog = () => {
      if (emptyResultWatchdog) {
        clearTimeout(emptyResultWatchdog);
        emptyResultWatchdog = null;
      }
    };
    /** Plafond de l'attente des tâches de fond (BACKGROUND_WAIT_TIMEOUT_MS) :
        armé quand un `result` arrive avec des tâches vivantes, désarmé par
        toute activité du flux (un rapport de tâche relance le tour). */
    let backgroundWaitWatchdog: ReturnType<typeof setTimeout> | null = null;
    const clearBackgroundWaitWatchdog = () => {
      if (backgroundWaitWatchdog) {
        clearTimeout(backgroundWaitWatchdog);
        backgroundWaitWatchdog = null;
      }
    };

    // La méthode d'usage du SDK est une requête de contrôle vers le processus
    // CLI : elle DOIT partir pendant que le tour est vivant. Après le message
    // `result`, le SDK ferme l'entrée du processus et l'appel échoue
    // (« ProcessTransport is not ready for writing », vérifié en réel) — d'où
    // une capture opportuniste sur chaque message assistant, sans blocage du
    // flux ni empilement (une seule requête en vol à la fois).
    let usageCaptureInFlight = false;
    const tryCaptureUsage = () => {
      if (usageCaptureInFlight) return;
      usageCaptureInFlight = true;
      captureUsageSnapshot(query)
        .then((snapshot) => {
          if (snapshot) {
            lastUsageSnapshot = snapshot;
            recordClaudeWindowsSnapshot(snapshot.windows);
          }
        })
        .finally(() => {
          usageCaptureInFlight = false;
        });
    };

    try {
      for await (const message of query) {
        if (!isPlainObject(message) || typeof message.type !== "string") {
          continue;
        }
        // Toute activité du flux désarme le garde-fou du micro-tour vide.
        clearEmptyResultWatchdog();
        // L'attente des tâches de fond ne se termine QUE sur une vraie reprise
        // du modèle (rapport de tâche → nouveau tour) : les messages de
        // service (background_tasks_changed, notifications) ne doivent ni
        // désarmer le plafond ni rendre claude.release inopérant alors que
        // l'UI affiche encore « Rendre la main ».
        if (message.type === "assistant" || message.type === "stream_event") {
          clearBackgroundWaitWatchdog();
          runState.waitingBackground = false;
        }

        switch (message.type) {
          case "system": {
            if (message.subtype === "init") {
              if (typeof message.session_id === "string") {
                lastSessionId = message.session_id;
              }
              if (typeof message.model === "string") {
                lastModel = message.model;
              }
              emitter.chunk(id, {
                kind: "init",
                sessionId: lastSessionId,
                model: typeof message.model === "string" ? message.model : null,
              });
            } else if (message.subtype === "background_tasks_changed") {
              // Liste COMPLÈTE des tâches de fond vivantes (REPLACE) : lancées
              // par le modèle (sous-agents en arrière-plan, jobs détachés).
              // Relayée à l'UI pour que l'utilisateur voie ce qui tourne.
              const tasks = Array.isArray(message.tasks) ? message.tasks : [];
              backgroundTasks = tasks.filter(isPlainObject).map((t) => ({
                taskId: typeof t.task_id === "string" ? t.task_id : "",
                description: typeof t.description === "string" ? t.description : "",
              }));
              emitter.chunk(id, {
                kind: "background_tasks",
                count: backgroundTasks.length,
                descriptions: backgroundTasks.map((t) => t.description).filter(Boolean),
              });
            }
            break;
          }
          case "stream_event": {
            const event = message.event;
            if (isPlainObject(event) && event.type === "content_block_delta") {
              const delta = event.delta;
              if (isPlainObject(delta) && delta.type === "text_delta" && typeof delta.text === "string") {
                sawAssistantOutput = true;
                sawTextDeltaForCall = true;
                emitter.chunk(id, { kind: "text", delta: delta.text });
              } else if (
                isPlainObject(delta) &&
                delta.type === "thinking_delta" &&
                typeof delta.thinking === "string"
              ) {
                sawAssistantOutput = true;
                emitter.chunk(id, { kind: "thinking", delta: delta.thinking });
              }
            }
            break;
          }
          case "assistant": {
            const inner = message.message;
            // Usage de CET appel (une réponse modèle = un appel) : on retient le
            // dernier vu, seul reflet fidèle de l'occupation du contexte.
            if (isPlainObject(inner)) {
              const ctx = extractContextTokens(inner.usage);
              if (ctx !== null) lastContextTokens = ctx;
            }
            const content = isPlainObject(inner) ? inner.content : undefined;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (!isPlainObject(block) || typeof block.type !== "string") {
                  continue;
                }
                // Les blocs text/thinking d'un message STREAMÉ sont déjà émis
                // via les deltas stream_event (includePartialMessages: true) :
                // on ne les réémet pas, pour éviter la duplication du texte.
                // MAIS un message jamais streamé (aucun delta depuis le message
                // assistant précédent) doit être émis ici, sinon son texte est
                // perdu — cas réel : les messages d'erreur synthétisés par le
                // CLI (« API Error: 529 Overloaded », model "<synthetic>"),
                // qui étaient invisibles dans l'UI (« terminé sans résultat »).
                if (block.type === "text" && !sawTextDeltaForCall) {
                  const text = typeof block.text === "string" ? block.text : "";
                  if (text.trim()) {
                    sawAssistantOutput = true;
                    emitter.chunk(id, { kind: "text", delta: text });
                  }
                }
                if (block.type === "tool_use") {
                  sawAssistantOutput = true;
                  emitter.chunk(id, {
                    kind: "tool_use",
                    toolUseId: typeof block.id === "string" ? block.id : null,
                    toolName: typeof block.name === "string" ? block.name : null,
                    toolInput: block.input ?? {},
                  });
                }
              }
            }
            // Prochain appel API : nouveau cycle deltas → message assistant.
            sawTextDeltaForCall = false;
            tryCaptureUsage();
            break;
          }
          case "user": {
            const inner = message.message;
            const content = isPlainObject(inner) ? inner.content : undefined;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (!isPlainObject(block) || block.type !== "tool_result") {
                  continue;
                }
                emitter.chunk(id, {
                  kind: "tool_result",
                  toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
                  isError: block.is_error === true,
                  summary: summarizeToolResult(block.content),
                });
              }
            }
            break;
          }
          case "result": {
            sawResult = true;
            if (typeof message.session_id === "string") {
              lastSessionId = message.session_id;
            }
            const resultSubtype = typeof message.subtype === "string" ? message.subtype : "unknown";
            const resultUsage = extractUsage(message.usage);
            const doneData = {
              sessionId: lastSessionId,
              subtype: resultSubtype,
              result: typeof message.result === "string" ? message.result : null,
              usage: resultUsage,
              // Occupation réelle de la fenêtre de contexte (dernier appel), à ne
              // pas confondre avec `usage` (cumul du tour) — voir
              // extractContextTokens. `null` si aucun appel modèle sur ce tour.
              contextTokens: lastContextTokens,
              totalCostUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
            };

            // Tour du modèle terminé mais des tâches de fond vivent encore :
            // le process DOIT rester ouvert — leurs rapports réveilleront
            // l'agent (task-notification → nouveau tour → nouveau `result`).
            // Clore ici les tuerait : incident du 2026-07-22, trois
            // explorations lancées en arrière-plan puis interrompues 5 s
            // après la fin du tour par l'interrupt de fin de claude.start.
            if (backgroundTasks.length > 0) {
              pendingResultDone = doneData;
              emitter.chunk(id, {
                kind: "background_wait",
                count: backgroundTasks.length,
                descriptions: backgroundTasks.map((t) => t.description).filter(Boolean),
              });
              // L'attente n'est PAS illimitée : claude.release (bouton « Rendre
              // la main ») ou ce plafond font retomber la boucle via interrupt(),
              // et le repli de fin de flux livre doneData. Sinon, une tâche de
              // fond qui ne finit jamais tenait le tour en otage.
              runState.waitingBackground = true;
              backgroundWaitWatchdog = setTimeout(() => {
                turnPrompt.close();
                query.interrupt().catch(() => {
                  // process déjà éteint : la boucle est déjà retombée.
                });
              }, BACKGROUND_WAIT_TIMEOUT_MS);
              break;
            }

            // Micro-tour interne du CLI clos sans appel au modèle (0 token,
            // aucun contenu assistant — ex. livraison de notifications de
            // tâches sur un resume) : le VRAI tour, la réponse au message de
            // l'utilisateur, n'a pas encore eu lieu. On attend la suite au
            // lieu de clore une bulle vide ; borné (2 max) + garde-fou 30 s :
            // si rien ne vient, interrupt() fait retomber la boucle et le
            // repli de fin de flux émet ce résultat.
            const zeroUsage =
              !resultUsage || (resultUsage.inputTokens === 0 && resultUsage.outputTokens === 0);
            if (resultSubtype === "success" && !sawAssistantOutput && zeroUsage && spuriousEmptyResults < 2) {
              spuriousEmptyResults += 1;
              pendingResultDone = doneData;
              emptyResultWatchdog = setTimeout(() => {
                turnPrompt.close();
                query.interrupt().catch(() => {
                  // process déjà éteint : la boucle est déjà retombée.
                });
              }, 30_000);
              break;
            }

            const resultStatus: UsageStatus = resultSubtype === "success" ? "done" : "error";
            // Un seul événement d'usage par claude.start, sur le result FINAL
            // (usage/coût cumulés du process ; les résultats intermédiaires
            // ci-dessus n'en émettent pas pour ne pas compter double).
            recordUsageEvent({
              id,
              engine: "claude",
              method: "claude.start",
              providerId: null,
              model: lastModel,
              promptTokens: resultUsage?.inputTokens ?? null,
              completionTokens: resultUsage?.outputTokens ?? null,
              status: resultStatus,
              // L4 — le `subtype` du SDK EST la cause (error_max_turns,
              // error_during_execution…). `message.result` n'est pas repris :
              // sur un tour réussi il porte la réponse de l'assistant, et le
              // journal ne doit jamais contenir de corps de réponse.
              errorMessage: resultStatus === "error" ? `résultat Claude: ${resultSubtype}` : null,
              meta: params.meta,
            });
            emitter.done(id, doneData);
            const snapshot = await captureUsageSnapshot(query);
            if (snapshot) {
              lastUsageSnapshot = snapshot;
              recordClaudeWindowsSnapshot(snapshot.windows);
            }
            // `result` final = fin du tour dans notre contrat (un tour = un
            // claude.start). Sans sortie EXPLICITE de la boucle, le `break`
            // ci-dessous ne quitterait que le `switch` : le for-await
            // continuerait d'attendre, le process CLI resterait vivant, et le
            // tour suivant, lancé avec `resume` sur cette même session encore
            // occupée, revenait immédiatement à vide (0 token) — symptôme
            // « bloqué ».
            turnFinished = true;
            break;
          }
          default:
            // Autres types de messages du SDK (hooks, notifications, tâches, ...) :
            // hors du contrat protocolaire du Lot 2, ignorés.
            break;
        }
        if (turnFinished) break;
      }
    } catch (err) {
      if (!runState.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        denyAllPending(runState, "Tour interrompu");
        runs.delete(id);
        recordUsageEvent({
          id,
          engine: "claude",
          method: "claude.start",
          providerId: null,
          model: lastModel,
          promptTokens: null,
          completionTokens: null,
          status: "error",
          // L4 — message brut de l'exception (la décoration d'auth ci-dessous
          // est une aide d'affichage, pas la cause).
          errorMessage: message,
          meta: params.meta,
        });
        emitter.error(id, decorateAuthError(message));
        return;
      }
      // Exception survenue après un abort : on l'ignore, le done ci-dessous
      // (subtype "aborted") tient lieu de fin de tour.
    }

    // Fin de tour : on coupe explicitement le process CLI. À ce stade il n'y a
    // plus de tâche de fond légitime (un `result` reçu avec des tâches vivantes
    // ne sort PAS de la boucle, voir le case "result") — l'interrupt ne tue
    // donc que d'éventuels résidus. Best effort : un tour déjà terminé peut
    // rendre `interrupt()` inopérant, sans conséquence.
    clearEmptyResultWatchdog();
    clearBackgroundWaitWatchdog();
    // Ferme l'entrée streamée AVANT l'interrupt : le générateur du prompt doit
    // pouvoir se terminer, sinon le process reste bloqué en attente d'entrée.
    turnPrompt.close();
    try {
      await query.interrupt();
    } catch {
      // process déjà éteint / interrupt non supporté : rien à faire.
    }

    denyAllPending(runState, "Tour interrompu");
    runs.delete(id);

    if (!turnFinished) {
      if (pendingResultDone) {
        // Flux terminé sans `result` final (garde-fou du micro-tour vide,
        // arrêt utilisateur pendant l'attente de tâches de fond, process
        // mort) : on livre le dernier résultat connu plutôt qu'un tour
        // fantôme sans fin.
        recordUsageEvent({
          id,
          engine: "claude",
          method: "claude.start",
          providerId: null,
          model: lastModel,
          promptTokens: pendingResultDone.usage?.inputTokens ?? null,
          completionTokens: pendingResultDone.usage?.outputTokens ?? null,
          status: pendingResultDone.subtype === "success" ? "done" : "error",
          // L4 — même règle que le `result` final : seul le subtype est repris.
          errorMessage:
            pendingResultDone.subtype === "success"
              ? null
              : `résultat Claude: ${pendingResultDone.subtype}`,
          meta: params.meta,
        });
        emitter.done(id, pendingResultDone);
      } else if (!sawResult) {
        recordUsageEvent({
          id,
          engine: "claude",
          method: "claude.start",
          providerId: null,
          model: lastModel,
          promptTokens: null,
          completionTokens: null,
          status: "aborted",
          meta: params.meta,
        });
        emitter.done(id, {
          sessionId: lastSessionId,
          subtype: "aborted",
          result: null,
          usage: null,
          contextTokens: lastContextTokens,
          totalCostUsd: null,
        });
      }
    }
  }

  function handleClaudePermission(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void {
    const targetId = params.targetId;
    const permissionId = params.permissionId;
    const decision = params.decision;
    if (!isNonEmptyString(targetId) || !isNonEmptyString(permissionId)) {
      emitter.error(id, "params.targetId et params.permissionId sont requis");
      return;
    }
    if (decision !== "allow" && decision !== "deny") {
      emitter.error(id, "params.decision doit être 'allow' ou 'deny'");
      return;
    }

    const run = runs.get(targetId);
    const pending = run?.pendingPermissions.get(permissionId);
    if (!run || !pending) {
      emitter.done(id, { applied: false });
      return;
    }
    run.pendingPermissions.delete(permissionId);

    if (decision === "allow") {
      pending.resolve({ behavior: "allow" });
    } else {
      const message = isNonEmptyString(params.message) ? params.message : "Refusé par l'utilisateur";
      pending.resolve({ behavior: "deny", message });
    }
    emitter.done(id, { applied: true });
  }

  function handleClaudeAbort(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void {
    const targetId = params.targetId;
    if (!isNonEmptyString(targetId)) {
      emitter.error(id, "params.targetId manquant ou invalide");
      return;
    }
    const run = runs.get(targetId);
    if (!run) {
      emitter.done(id, { aborted: false });
      return;
    }
    run.aborted = true;
    denyAllPending(run, "Tour interrompu");
    run.closePrompt();
    run.query.interrupt().catch(() => {
      // interrupt() peut rejeter si le tour est déjà terminé : sans conséquence,
      // le done du tour (émis par la boucle handleClaudeStart) fait foi.
    });
    emitter.done(id, { aborted: true });
  }

  /** Rendre la main pendant l'attente des rapports de tâches de fond : clôt le
      tour SANS le marquer interrompu — interrupt() fait retomber la boucle de
      handleClaudeStart, dont le repli de fin de flux livre le résultat déjà
      connu (pendingResultDone). Refusé (released:false) hors de cette phase :
      en pleine génération, couper le tour est le rôle de claude.abort. */
  function handleClaudeRelease(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void {
    const targetId = params.targetId;
    if (!isNonEmptyString(targetId)) {
      emitter.error(id, "params.targetId manquant ou invalide");
      return;
    }
    const run = runs.get(targetId);
    if (!run || !run.waitingBackground) {
      emitter.done(id, { released: false });
      return;
    }
    run.closePrompt();
    run.query.interrupt().catch(() => {
      // interrupt() peut rejeter si le process est déjà éteint : sans
      // conséquence, le done du tour (repli de handleClaudeStart) fait foi.
    });
    emitter.done(id, { released: true });
  }

  function handleClaudeUsage(
    id: string,
    _params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void {
    if (!lastUsageSnapshot) {
      emitter.done(id, { available: false });
      return;
    }
    emitter.done(id, { ...lastUsageSnapshot });
  }

  /**
   * usage.claude.init — initialise le relevé d'abonnement sans conversation :
   * micro-tour chat pur (haiku, prompt « ping », aucun outil) dont on ne garde
   * que l'instantané de limites capturé PENDANT le tour (voir le commentaire
   * de tryCaptureUsage dans handleClaudeStart : après le message result, la
   * requête de contrôle du SDK part dans le vide). Coût négligeable, déclenché
   * uniquement à la demande de l'utilisateur (bouton ↻ de l'encart conso).
   */
  async function handleClaudeUsageInit(
    id: string,
    _params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void> {
    let query: ClaudeQuery;
    try {
      query = queryFn({
        prompt: "ping",
        options: {
          cwd: os.homedir(),
          model: "claude-haiku-4-5",
          tools: [],
          permissionMode: "default",
        },
      });
    } catch (err) {
      emitter.error(id, `échec du micro-tour d'initialisation : ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    try {
      let captured: ClaudeUsageSnapshot | null = null;
      for await (const message of query) {
        if (!captured && isPlainObject(message) && message.type === "assistant") {
          captured = await captureUsageSnapshot(query);
        }
      }
      // Filet pour les SDK/faux SDK qui ne passent pas par le transport
      // processus (la capture post-tour y fonctionne).
      captured ??= await captureUsageSnapshot(query);
      if (captured) {
        lastUsageSnapshot = captured;
        recordClaudeWindowsSnapshot(captured.windows);
        emitter.done(id, { ...captured });
      } else if (lastUsageSnapshot) {
        emitter.done(id, { ...lastUsageSnapshot });
      } else {
        emitter.done(id, { available: false });
      }
    } catch (err) {
      emitter.error(id, `échec du micro-tour d'initialisation : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * claude.commands — énumère les slash-commands/skills disponibles pour un
   * projet sans jouer de tour (voir docs/protocol.md, section
   * « claude.commands »). Ouvre une session SDK en entrée streamée avec un
   * prompt qui ne yield jamais (createNonYieldingPrompt) : le SDK initialise
   * la session (system/init, supportedCommands()...) sans qu'aucun message
   * ne parte jamais vers Claude — zéro token consommé. Referme la session
   * proprement une fois la liste récupérée (ou en cas d'erreur/timeout).
   */
  async function handleClaudeCommands(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void> {
    const cwd = params.cwd;
    if (!isNonEmptyString(cwd)) {
      emitter.error(id, "params.cwd manquant ou invalide");
      return;
    }

    const options: ClaudeQueryOptions = {
      cwd,
      includePartialMessages: false,
      permissionMode: "default",
      env: { ...process.env, ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) },
      // Même isolation que le moteur projet de claude.start : seuls les
      // skills/réglages DU projet comptent, pas les skills globaux
      // (~/.claude/skills).
      settingSources: ["project", "local"],
    };

    const { iterable: promptForQuery, close: closePrompt } = createNonYieldingPrompt();

    let query: ClaudeQuery;
    try {
      query = queryFn({ prompt: promptForQuery, options });
    } catch (err) {
      closePrompt();
      const message = err instanceof Error ? err.message : String(err);
      emitter.error(id, decorateAuthError(message));
      return;
    }

    try {
      if (typeof query.supportedCommands !== "function") {
        throw new Error("le SDK ne fournit pas supportedCommands()");
      }
      const commands = await withTimeout(
        query.supportedCommands(),
        COMMANDS_TIMEOUT_MS,
        "délai dépassé en attendant la liste des commandes",
      );
      await query.interrupt().catch(() => {
        // interrupt() peut rejeter si la session n'a pas encore fini de
        // s'initialiser côté process : sans conséquence, on ferme quand
        // même le générateur juste après.
      });
      closePrompt();
      const mapped = commands.map((command) => ({
        name: command.name,
        description: command.description ?? "",
        argumentHint: command.argumentHint ?? "",
        ...(command.aliases && command.aliases.length > 0 ? { aliases: command.aliases } : {}),
      }));
      emitter.done(id, { commands: mapped });
    } catch (err) {
      await query.interrupt().catch(() => {
        // Idem : on ferme au mieux, l'erreur d'origine prime.
      });
      closePrompt();
      const message = err instanceof Error ? err.message : String(err);
      emitter.error(id, decorateAuthError(message));
    }
  }

  return {
    handleClaudeConfigure,
    handleClaudeStart,
    handleClaudePermission,
    handleClaudeAbort,
    handleClaudeRelease,
    handleClaudeUsage,
    handleClaudeUsageInit,
    handleClaudeCommands,
  };
}

// ---------------------------------------------------------------------------
// Instance par défaut : choisit la vraie fonction query() du SDK, sauf en
// test (IACTION_FAKE_CLAUDE=1) où un faux module est chargé dynamiquement.
// Le SDK réel n'est alors jamais importé : aucun risque d'appel réseau/CLI
// pendant les tests.
// ---------------------------------------------------------------------------

async function resolveQueryFn(): Promise<ClaudeQueryFn> {
  if (process.env.IACTION_FAKE_CLAUDE === "1") {
    const modulePath = process.env.IACTION_FAKE_CLAUDE_MODULE;
    if (isNonEmptyString(modulePath)) {
      const mod = (await import(pathToFileURL(modulePath).href)) as { fakeQuery?: ClaudeQueryFn };
      if (typeof mod.fakeQuery === "function") {
        return mod.fakeQuery;
      }
      throw new Error(`IACTION_FAKE_CLAUDE_MODULE (${modulePath}) n'exporte pas fakeQuery`);
    }
  }
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: (params: { prompt: string; options?: Record<string, unknown> }) => ClaudeQuery;
  };
  return sdk.query as unknown as ClaudeQueryFn;
}

const enginePromise: Promise<ClaudeEngine> = resolveQueryFn().then((queryFn) =>
  createClaudeEngine({ queryFn }),
);

export async function handleClaudeConfigure(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudeConfigure(id, params, emitter);
}

export async function handleClaudeStart(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  await engine.handleClaudeStart(id, params, emitter);
}

export async function handleClaudePermission(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudePermission(id, params, emitter);
}

export async function handleClaudeAbort(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudeAbort(id, params, emitter);
}

export async function handleClaudeRelease(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudeRelease(id, params, emitter);
}

export async function handleClaudeUsage(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudeUsage(id, params, emitter);
}

export async function handleClaudeUsageInit(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  await engine.handleClaudeUsageInit(id, params, emitter);
}

export async function handleClaudeCommands(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  await engine.handleClaudeCommands(id, params, emitter);
}

// ---------------------------------------------------------------------------
// claude.sessionTitles — titres courts déjà calculés par le CLI Claude
// (SDKSessionInfo.customTitle / summary), pour remplacer le repli local terne
// de l'UI (les 48 premiers caractères du premier message, voir
// ui/src/sessionStore.ts deriveTitleFromText). Indépendant du moteur
// createClaudeEngine (pas de queryFn, pas d'apiKey) : `listSessions()` ne fait
// que lire les métadonnées JSONL déjà sur disque, sans relancer de session ni
// consommer le moindre token — voir docs/protocol.md, § claude.sessionTitles.
// ---------------------------------------------------------------------------

/**
 * `summary` retombe sur le premier prompt tel quel tant que le CLI n'a pas
 * encore calculé de titre IA pour la session — dans ce cas il n'apporte rien
 * de mieux que le repli local existant. Le SDK tronque parfois `summary` :
 * on compare donc par préfixe, pas par égalité stricte.
 */
function isFallbackTitle(candidate: string, firstPrompt: string | undefined): boolean {
  if (!isNonEmptyString(firstPrompt)) return false;
  const trimmedCandidate = candidate.trim();
  return trimmedCandidate.length > 0 && firstPrompt.trim().startsWith(trimmedCandidate);
}

interface SdkSessionInfoLike {
  sessionId: string;
  summary: string;
  customTitle?: string;
  firstPrompt?: string;
}

/**
 * claude.sessionTitles — jamais bloquant : amélioration cosmétique du panneau
 * Sessions, toute panne (SDK indisponible, cwd inconnu du CLI, aucune
 * session) retombe sur `{titles: []}` — jamais sur `error` — pour que l'UI
 * garde silencieusement son repli local.
 */
export async function handleClaudeSessionTitles(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwd = params.cwd;
  if (!isNonEmptyString(cwd)) {
    emitter.done(id, { titles: [] });
    return;
  }
  const wantedIds = Array.isArray(params.sessionIds)
    ? new Set(params.sessionIds.filter(isNonEmptyString))
    : null;

  try {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
      listSessions: (options?: { dir?: string }) => Promise<SdkSessionInfoLike[]>;
    };
    const sessions = await sdk.listSessions({ dir: cwd });
    const titles: Array<{ sessionId: string; title: string }> = [];
    for (const session of sessions) {
      if (wantedIds && !wantedIds.has(session.sessionId)) continue;
      const candidate = isNonEmptyString(session.customTitle) ? session.customTitle : session.summary;
      if (!isNonEmptyString(candidate) || isFallbackTitle(candidate, session.firstPrompt)) continue;
      titles.push({ sessionId: session.sessionId, title: candidate });
    }
    emitter.done(id, { titles });
  } catch {
    emitter.done(id, { titles: [] });
  }
}
