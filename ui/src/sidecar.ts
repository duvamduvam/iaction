/*
 * Encapsule la communication avec le sidecar via Tauri :
 * - un seul `listen('sidecar:event', …)` global, corrélation par `id`
 *   dans une Map (pas un listen par requête) ;
 * - `request()` pour envoyer une requête et suivre ses chunks/done/error ;
 * - `subscribeStatus` / `subscribeReady` / `subscribeLog` pour les
 *   abonnements React (add/remove synchrones dans un Set : sûrs même
 *   avec le double montage des effets en StrictMode).
 *
 * Les listeners Tauri eux-mêmes sont initialisés une seule fois, au
 * chargement du module (durée de vie = durée de vie de l'app), donc
 * indépendants du cycle de vie des composants React.
 *
 * L2 (journal applicatif) : toute erreur de protocole est journalisée ICI,
 * automatiquement — les ~50 appelants n'ont rien à faire, et plus aucune
 * erreur ne peut passer inaperçue (docs/etude-logs.md § 2.3). Ce module relaie
 * aussi l'event Tauri `app:log` (messages de la coquille Rust) vers le
 * journal. GARDE ANTI-RÉCURSION : `log.append` passant lui-même par
 * `request()`, l'échec d'une requête `log.append` n'est JAMAIS journalisé.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LOG_APPEND_METHOD, isLogLevel, isLogScope, logUi } from "./journal";

export type SidecarState = "starting" | "running" | "restarting" | "dead";

export interface StatusPayload {
  state: SidecarState;
  pid: number | null;
  attempts: number;
}

export interface ReadyInfo {
  version: string;
  pid: number;
}

interface RawSidecarEvent {
  id?: string;
  event: "chunk" | "done" | "error" | "ready";
  data: Record<string, unknown>;
}

interface PendingRequest {
  /** Méthode appelée — sert la journalisation automatique et sa garde anti-récursion. */
  method: string;
  onChunk?: (data: Record<string, unknown>) => void;
  resolve: (data: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * Payload de l'event Tauri `app:log` : messages propres à la coquille Rust
 * (échec de spawn du sidecar, backoff, réglages WebKit — voir
 * docs/protocol.md § « Event Tauri `app:log` »). DISTINCT de `sidecar:log`,
 * qui reste le relais brut du stderr du sidecar : les confondre créerait la
 * boucle sidecar → stderr → `sidecar:log` → `log.append` → sidecar.
 */
interface RawAppLog {
  level?: unknown;
  scope?: unknown;
  msg?: unknown;
  fields?: unknown;
}

export interface RequestOptions {
  /** Reçoit le `data` brut de chaque événement `chunk` (forme dépendante de la méthode). */
  onChunk?: (data: Record<string, unknown>) => void;
}

export interface RequestHandle {
  /** Identifiant de corrélation de la requête, disponible immédiatement. */
  id: string;
  /** Résolue à la réception du `done`, rejetée à la réception d'un `error`. */
  done: Promise<Record<string, unknown>>;
}

const pending = new Map<string, PendingRequest>();
const statusSubscribers = new Set<(status: StatusPayload) => void>();
const readySubscribers = new Set<(info: ReadyInfo) => void>();
const logSubscribers = new Set<(line: string) => void>();

let requestCounter = 0;

/**
 * Rejette toutes les requêtes en vol, avec un message qui dit la vérité.
 *
 * Appelé quand le sidecar meurt ou redémarre. La Map est vidée AVANT de rejeter
 * : un `catch` d'appelant peut relancer une requête, et il ne doit pas tomber
 * sur une entrée fantôme de la vague précédente.
 */
function rejeterRequetesEnVol(etat: string): void {
  if (pending.size === 0) return;
  const enVol = [...pending.entries()];
  pending.clear();
  const cause =
    etat === "dead"
      ? "le moteur s'est arrêté définitivement — utilisez « Relancer le moteur »"
      : "le moteur redémarre";
  for (const [id, handlers] of enVol) {
    handlers.reject(new Error(`${handlers.method} interrompu : ${cause} (requête ${id})`));
  }
}

function handleSidecarEvent(payload: RawSidecarEvent): void {
  if (payload.event === "ready") {
    const info = payload.data as unknown as ReadyInfo;
    for (const cb of readySubscribers) cb(info);
    return;
  }

  if (!payload.id) return;
  const handlers = pending.get(payload.id);
  if (!handlers) return;

  switch (payload.event) {
    case "chunk": {
      handlers.onChunk?.(payload.data);
      break;
    }
    case "done":
      pending.delete(payload.id);
      handlers.resolve(payload.data);
      break;
    case "error": {
      pending.delete(payload.id);
      const message =
        typeof payload.data.message === "string" ? payload.data.message : "Erreur inconnue";
      // L2 — journalisation AUTOMATIQUE de toute erreur de protocole : avant
      // ce point, chaque appelant affichait l'erreur dans son coin puis
      // l'oubliait. GARDE ANTI-RÉCURSION : ne jamais journaliser l'échec
      // d'une requête de journalisation (elle produirait un nouveau
      // `log.append`, qui échouerait de même — boucle infinie).
      if (handlers.method !== LOG_APPEND_METHOD) {
        logUi("error", "ui", message, { reqId: payload.id, fields: { method: handlers.method } });
      }
      handlers.reject(new Error(message));
      break;
    }
  }
}

/**
 * Relaie un message de la coquille Rust (`app:log`) vers le journal applicatif.
 * Lecture défensive : tout champ absent ou mal typé est neutralisé plutôt que
 * de faire échouer le relais — un message de journal ne doit jamais casser
 * quoi que ce soit.
 */
function handleAppLog(payload: RawAppLog | null | undefined): void {
  if (!payload || typeof payload !== "object") return;
  const level = isLogLevel(payload.level) ? payload.level : "error";
  // Un `app:log` vient par définition du Rust : scope inconnu ramené à `rust`.
  const scope = isLogScope(payload.scope) ? payload.scope : "rust";
  const msg = typeof payload.msg === "string" && payload.msg ? payload.msg : "(sans message)";
  const fields =
    payload.fields && typeof payload.fields === "object" && !Array.isArray(payload.fields)
      ? (payload.fields as Record<string, unknown>)
      : {};
  logUi(level, scope, msg, { fields });
}

async function setupListeners(): Promise<void> {
  await Promise.all([
    listen<RawSidecarEvent>("sidecar:event", (evt) => handleSidecarEvent(evt.payload)),
    listen<StatusPayload>("sidecar:status", (evt) => {
      // Le sidecar est mort ou redémarre : les requêtes en vol n'auront JAMAIS
      // leur événement terminal — le process qui devait l'émettre n'existe
      // plus. Sans ce rejet, la promesse `done` reste suspendue à vie : le
      // `finally` de handleSend ne s'exécute pas, `streaming` reste vrai, la
      // conversation est verrouillée (« arrêtez le tour en cours » à la
      // fermeture) et le bouton Arrêter envoie un abort au NOUVEAU sidecar,
      // qui ne connaît pas cet id.
      if (evt.payload.state === "restarting" || evt.payload.state === "dead") {
        rejeterRequetesEnVol(evt.payload.state);
      }
      for (const cb of statusSubscribers) cb(evt.payload);
    }),
    listen<string>("sidecar:log", (evt) => {
      for (const cb of logSubscribers) cb(evt.payload);
    }),
    // Messages propres à la coquille Rust — relayés vers `log.append`, à ne
    // pas confondre avec `sidecar:log` ci-dessus (flux brut du stderr sidecar).
    listen<RawAppLog>("app:log", (evt) => handleAppLog(evt.payload)),
  ]);
}

const listenersReady = setupListeners();

/**
 * Envoie une requête au sidecar (`sidecar_request`) et suit sa réponse.
 * L'`id` est généré et retourné immédiatement (utile pour l'affichage),
 * `done` se résout/rejette à la réception de l'événement terminal.
 */
export function request(
  method: string,
  params: Record<string, unknown> = {},
  options: RequestOptions = {},
): RequestHandle {
  requestCounter += 1;
  const id = `req-${requestCounter}`;

  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    pending.set(id, { method, onChunk: options.onChunk, resolve, reject });

    listenersReady
      .then(() => invoke("sidecar_request", { request: { id, method, params } }))
      .catch((err: unknown) => {
        pending.delete(id);
        const message = err instanceof Error ? err.message : String(err);
        // L2 — la requête n'a même pas pu partir (sidecar mort, stdin absent).
        // MÊME GARDE ANTI-RÉCURSION que ci-dessus : quand le sidecar est mort,
        // journaliser l'échec d'un `log.append` en déclencherait un autre, qui
        // échouerait pareil — boucle infinie.
        if (method !== LOG_APPEND_METHOD) {
          logUi("error", "ui", `envoi au sidecar impossible : ${message}`, {
            reqId: id,
            fields: { method },
          });
        }
        reject(err instanceof Error ? err : new Error(message));
      });
  });

  return { id, done };
}

/** État courant du sidecar (appel direct, hors abonnement aux events). */
/**
 * Relance un sidecar mort (`sidecar_restart`, côté Rust).
 *
 * L'état `dead` était une impasse : il fallait quitter l'application pour
 * retrouver un sidecar, donc perdre fenêtre, onglets et session en cours pour
 * une panne souvent passagère.
 */
export async function restartSidecar(): Promise<void> {
  await invoke("sidecar_restart");
}

export async function fetchStatus(): Promise<StatusPayload> {
  return invoke<StatusPayload>("sidecar_status");
}

export function subscribeStatus(cb: (status: StatusPayload) => void): () => void {
  statusSubscribers.add(cb);
  return () => statusSubscribers.delete(cb);
}

export function subscribeReady(cb: (info: ReadyInfo) => void): () => void {
  readySubscribers.add(cb);
  return () => readySubscribers.delete(cb);
}

export function subscribeLog(cb: (line: string) => void): () => void {
  logSubscribers.add(cb);
  return () => logSubscribers.delete(cb);
}

/* ---------- Helpers typés Lot 1 : fournisseurs, modèles, chat ---------- */

/** Entrée de la table poussée au sidecar via `providers.set` (clé en mémoire uniquement). */
export interface ProviderPayload {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** R0 — ids de modèles de secours, dans l'ordre d'essai (OpenRouter `models`). */
  fallbackModels?: string[];
  /** R0 — router chaque appel vers l'endpoint le moins cher (OpenRouter `provider.sort`). */
  priceSort?: boolean;
  /** R0 — demander coût réel + tokens cachés dans l'usage (OpenRouter `usage.include`). */
  usageAccounting?: boolean;
}

export interface ModelInfo {
  id: string;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface ChatUsage {
  /** `null` si le fournisseur ne remonte pas ce compteur (le coût peut l'être sans lui). */
  promptTokens: number | null;
  /** Idem — voir `parseChatDone` : les champs sont optionnels INDÉPENDAMMENT. */
  completionTokens: number | null;
  /** R0 — coût réel remonté par le fournisseur (comptabilité d'usage OpenRouter), null si absent. */
  costUsd?: number | null;
  /** R0 — tokens servis depuis le cache, null si absent. */
  cachedTokens?: number | null;
}

export interface ChatDoneData {
  finishReason: string;
  usage: ChatUsage | null;
  /** R0 — slug du modèle réellement servi (modèles de secours OpenRouter), null si inconnu. */
  modelUsed: string | null;
}

function isModelInfo(value: unknown): value is ModelInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

/** Remplace intégralement la table des fournisseurs connus du sidecar. */
export async function providersSet(providers: ProviderPayload[]): Promise<number> {
  const { done } = request("providers.set", { providers });
  const data = await done;
  return typeof data.count === "number" ? data.count : 0;
}

/** Liste les modèles exposés par un fournisseur déjà poussé via `providers.set`. */
export async function modelsList(providerId: string): Promise<ModelInfo[]> {
  const { done } = request("models.list", { providerId });
  const data = await done;
  return Array.isArray(data.models) ? data.models.filter(isModelInfo) : [];
}

/** Tarifs $/million de tokens (déjà convertis côté sidecar depuis le $/token OpenRouter). */
export interface ModelPricing {
  promptUsdPerM?: number;
  completionUsdPerM?: number;
}

/** Métadonnées détaillées d'un modèle (voir docs/protocol.md, `models.detail`). */
export interface ModelDetail {
  id: string;
  name?: string;
  contextLength?: number;
  pricing?: ModelPricing;
  description?: string;
}

/** Parsing défensif de `value.pricing` : nombres finis uniquement, sinon champ omis. */
function toModelPricing(value: unknown): ModelPricing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  const pricing: ModelPricing = {};
  if (typeof p.promptUsdPerM === "number" && Number.isFinite(p.promptUsdPerM)) {
    pricing.promptUsdPerM = p.promptUsdPerM;
  }
  if (typeof p.completionUsdPerM === "number" && Number.isFinite(p.completionUsdPerM)) {
    pricing.completionUsdPerM = p.completionUsdPerM;
  }
  return pricing.promptUsdPerM !== undefined || pricing.completionUsdPerM !== undefined ? pricing : undefined;
}

/** Parsing défensif d'une entrée brute `models.detail` : seul `id` est requis, le reste est omis si invalide. */
function toModelDetail(value: Record<string, unknown>): ModelDetail | null {
  if (typeof value.id !== "string" || !value.id) return null;
  const model: ModelDetail = { id: value.id };
  if (typeof value.name === "string" && value.name) model.name = value.name;
  if (typeof value.contextLength === "number" && Number.isFinite(value.contextLength)) {
    model.contextLength = value.contextLength;
  }
  if (typeof value.description === "string" && value.description) model.description = value.description;
  const pricing = toModelPricing(value.pricing);
  if (pricing) model.pricing = pricing;
  return model;
}

/**
 * Détail des modèles (tarifs, contexte, description) exposés par un fournisseur déjà
 * poussé via `providers.set`. Champs absents chez les fournisseurs sans métadonnées
 * (Ollama…) simplement omis — voir docs/protocol.md, `models.detail`.
 */
export async function modelsDetail(providerId: string): Promise<ModelDetail[]> {
  const { done } = request("models.detail", { providerId });
  const data = await done;
  if (!Array.isArray(data.models)) return [];
  const out: ModelDetail[] = [];
  for (const raw of data.models) {
    if (typeof raw !== "object" || raw === null) continue;
    const detail = toModelDetail(raw as Record<string, unknown>);
    if (detail) out.push(detail);
  }
  return out;
}

/**
 * Métadonnées optionnelles de supervision (voir docs/protocol.md § « Méthodes
 * S1 — supervision d'usage ») : relayées telles quelles par `chat.send`,
 * `claude.start` et `neutral.start` vers `events.jsonl`, jamais requises.
 * `routeTier` (R1) : tier du routeur quand le tour a été envoyé en « Auto ».
 */
export interface RequestMeta {
  source?: string;
  conversationId?: string;
  routeTier?: string;
  /** R3 — vrai quand le tour a été débordé (abonnement saturé → cible payante). */
  routeDebord?: boolean;
  /**
   * S2 — projet déclaré auquel imputer le tour (encart « Usage par projet » de
   * Supervision). Posé par la page Projets ; le Chat n'en pose pas — il est
   * agrégé comme un projet à part entière depuis `source: "chat"`.
   */
  projectId?: string;
  /** S2 — répertoire du run, pour les tours sans `projectId` (étapes d'orchestration). */
  projectPath?: string;
}

/* ---------- Helpers typés R1 : routeur heuristique (`router.*`) ---------- */

export type RouteTier = "trivial" | "simple" | "moyen" | "complexe";

/** Cible d'un tier de la table de routage (voir docs/protocol.md, `router.set`). */
export interface RouteTarget {
  engine: "claude" | "neutral";
  /** Requis si engine === "neutral". */
  providerId?: string;
  model: string;
}

export type RoutingTable = Record<RouteTier, RouteTarget>;

/** R2 — classificateur LLM local du routeur (voir docs/protocol.md, `router.set`). `null` = désactivé. */
export interface ClassifierConfig {
  providerId: string;
  model: string;
}

/** R5 — modèle d'embeddings du RAG local (voir docs/protocol.md, `router.set`) — même forme que le classificateur. */
export interface EmbeddingsConfig {
  providerId: string;
  model: string;
}

/** R3 — configuration du débord d'abonnement (voir docs/protocol.md, `router.set`). */
export interface DebordConfig {
  target: RouteTarget;
  /** Seuil de la fenêtre 5 h (%) au-delà duquel l'abonnement est réputé saturé. */
  seuilPct: number;
  /** Plafond mensuel de dépense de débord (USD) — `null` = pas de plafond. */
  plafondUsdMois: number | null;
}

/** R3 — état de débord d'un `router.route` (absent = routage normal). */
export interface RouteDebord {
  /** Vrai = tour envoyé vers la cible de débord (payante). */
  active: boolean;
  /** Vrai = plafond mensuel atteint, repli sur la cible du tier trivial. */
  blocked: boolean;
  fiveHourPct: number | null;
}

/** Résultat d'un `router.route` : classement + cible de la table courante. */
export interface RouteResult {
  tier: RouteTier;
  score: number;
  reasons: string[];
  target: RouteTarget;
  /** R2 — origine du classement (classificateur LLM ou heuristique seule). */
  method: "heuristique" | "llm";
  /** R3 — `null` quand la règle de débord n'a pas joué (ou sidecar antérieur). */
  debord: RouteDebord | null;
}

export function isRouteTier(value: unknown): value is RouteTier {
  return value === "trivial" || value === "simple" || value === "moyen" || value === "complexe";
}

/** Parsing défensif d'une cible `{engine, providerId?, model}` — null si invalide. */
export function toRouteTarget(value: unknown): RouteTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.engine !== "claude" && v.engine !== "neutral") return null;
  if (typeof v.model !== "string" || !v.model) return null;
  if (v.engine === "neutral") {
    if (typeof v.providerId !== "string" || !v.providerId) return null;
    return { engine: "neutral", providerId: v.providerId, model: v.model };
  }
  return { engine: "claude", model: v.model };
}

/**
 * Remplace la table de routage du sidecar (fusion avec les défauts côté
 * sidecar). R2 — `classifier` : `null` = classificateur LLM désactivé,
 * `undefined` = défaut du sidecar (ollama/qwen3.5:4b). R3/R6 — `debord` :
 * `null` = bascule payante automatique DÉSACTIVÉE, `undefined` = défauts du
 * sidecar (openrouter · deepseek, seuil 90, plafond 10 $).
 */
export async function routerSet(
  table: Partial<RoutingTable>,
  classifier?: ClassifierConfig | null,
  debord?: DebordConfig | null,
  embeddings?: EmbeddingsConfig,
): Promise<number> {
  const { done } = request("router.set", {
    table,
    ...(classifier !== undefined ? { classifier } : {}),
    // R6 — `null` transmis tel quel (débord désactivé) ; absent = défauts du sidecar.
    ...(debord !== undefined ? { debord } : {}),
    // R5 — absent = défaut du sidecar (ollama · nomic-embed-text).
    ...(embeddings !== undefined ? { embeddings } : {}),
  });
  const data = await done;
  return typeof data.count === "number" ? data.count : 0;
}

/**
 * Classe un texte côté sidecar et renvoie tier/score/raisons + cible de la
 * table courante. Rejette si la réponse est inexploitable (sidecar trop
 * ancien) — à l'appelant de retomber sur son comportement manuel.
 * R2 — `cwd` active la surcharge projet (`.iaction/routage.yaml`) ;
 * `allowLlm: false` court-circuite le classificateur LLM ; `method` indique
 * l'origine du classement.
 */
/** R3 — parsing défensif du champ `debord` d'un `router.route` (absent/inconnu → null). */
function toRouteDebord(value: unknown): RouteDebord | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.active !== "boolean") return null;
  return {
    active: v.active,
    blocked: v.blocked === true,
    fiveHourPct: typeof v.fiveHourPct === "number" && Number.isFinite(v.fiveHourPct) ? v.fiveHourPct : null,
  };
}

export async function routerRoute(params: {
  text: string;
  historyTurns?: number;
  attachmentsCount?: number;
  cwd?: string;
  allowLlm?: boolean;
  /** R3 — tier imposé : saute la classification, ne résout que cible + débord. */
  tier?: RouteTier;
  /** R7 — plancher de session : le tier effectif ne descend jamais sous ce tier. */
  minTier?: RouteTier;
}): Promise<RouteResult> {
  const { done } = request("router.route", {
    text: params.text,
    ...(params.historyTurns !== undefined ? { historyTurns: params.historyTurns } : {}),
    ...(params.attachmentsCount !== undefined ? { attachmentsCount: params.attachmentsCount } : {}),
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    ...(params.allowLlm !== undefined ? { allowLlm: params.allowLlm } : {}),
    ...(params.tier !== undefined ? { tier: params.tier } : {}),
    ...(params.minTier !== undefined ? { minTier: params.minTier } : {}),
  });
  const data = await done;
  const target = toRouteTarget(data.target);
  if (!isRouteTier(data.tier) || !target) {
    throw new Error("réponse router.route invalide");
  }
  return {
    tier: data.tier,
    score: typeof data.score === "number" ? data.score : 0,
    reasons: Array.isArray(data.reasons)
      ? data.reasons.filter((r): r is string => typeof r === "string")
      : [],
    target,
    // Sidecar d'avant R2 : pas de champ method — le classement était heuristique.
    method: data.method === "llm" ? "llm" : "heuristique",
    // R3 — sidecar d'avant R3 : pas de champ debord — routage normal.
    debord: toRouteDebord(data.debord),
  };
}

/* ---------- Pièces jointes (`chat.send`/`claude.start` — voir docs/protocol.md) ---------- */

export type ImageAttachmentMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageAttachment {
  kind: "image";
  name: string;
  mediaType: ImageAttachmentMediaType;
  /** Base64 SANS préfixe data-URL. */
  data: string;
}

export interface TextAttachment {
  kind: "text";
  name: string;
  content: string;
}

/** Pièce jointe du DERNIER message utilisateur — contrat commun `chat.send`/`claude.start` (docs/protocol.md). */
export type ChatAttachment = ImageAttachment | TextAttachment;

/**
 * Lance un `chat.send` streamé. `onDelta` reçoit le texte de chaque delta
 * (déjà extrait de `data.delta`). Utiliser le `done` de la poignée retournée
 * (via `parseChatDone`) pour connaître le `finishReason` et l'`usage` final,
 * et l'`id` retourné pour un éventuel `chatAbort`. `attachments` (voir le
 * contrat) : porté par le DERNIER message utilisateur, omis si vide.
 */
export function chatSend(
  providerId: string,
  model: string,
  messages: ChatMessage[],
  options: ChatOptions,
  onDelta: (delta: string) => void,
  attachments?: ChatAttachment[],
  meta?: RequestMeta,
): RequestHandle {
  return request(
    "chat.send",
    {
      providerId,
      model,
      messages,
      options,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(meta ? { meta } : {}),
    },
    {
      onChunk: (data) => {
        const delta = typeof data.delta === "string" ? data.delta : "";
        if (delta) onDelta(delta);
      },
    },
  );
}

/** Extrait `finishReason`/`usage`/`modelUsed` du `data` reçu au `done` d'un `chat.send`. */
export function parseChatDone(data: Record<string, unknown>): ChatDoneData {
  const finishReason = typeof data.finishReason === "string" ? data.finishReason : "stop";
  let usage: ChatUsage | null = null;
  const rawUsage = data.usage;
  if (rawUsage && typeof rawUsage === "object") {
    const u = rawUsage as Record<string, unknown>;
    // Chaque champ est optionnel INDÉPENDAMMENT : le sidecar émet un usage à
    // champs nullables (voir engine.ts), parce que tous les fournisseurs ne
    // remontent pas les mêmes chiffres. Exiger les deux compteurs de tokens
    // faisait jeter l'objet ENTIER quand un fournisseur ne donnait que le
    // coût : le prix réel du tour n'était jamais affiché, alors que le sidecar
    // l'avait transmis et enregistré dans events.jsonl.
    const nombreOuNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
    const aUneValeur =
      typeof u.promptTokens === "number" ||
      typeof u.completionTokens === "number" ||
      typeof u.costUsd === "number";
    if (aUneValeur) {
      usage = {
        promptTokens: nombreOuNull(u.promptTokens),
        completionTokens: nombreOuNull(u.completionTokens),
        costUsd: nombreOuNull(u.costUsd),
        cachedTokens: nombreOuNull(u.cachedTokens),
      };
    }
  }
  const modelUsed = typeof data.modelUsed === "string" && data.modelUsed ? data.modelUsed : null;
  return { finishReason, usage, modelUsed };
}

/** Interrompt le `chat.send` en cours identifié par `targetId`. */
export async function chatAbort(targetId: string): Promise<boolean> {
  const { done } = request("chat.abort", { targetId });
  const data = await done;
  return data.aborted === true;
}

/* ---------- Helpers typés R4 : économie de contexte (`context.compact`) ---------- */

/** Résultat d'un `context.compact` : résumé + nombre de messages couverts. */
export interface ContextCompactResult {
  summary: string;
  coveredTurns: number;
}

/**
 * Résume `messages` via une complétion NON streamée sur `providerId`/`model`
 * (voir docs/protocol.md, `context.compact`). `keepLast` : les N derniers
 * messages fournis sont exclus du résumé (absent = tout est résumé). Rejette
 * en cas d'erreur/timeout — l'appelant renonce alors à la compaction et
 * envoie l'historique intégral (jamais de perte).
 */
export async function contextCompact(
  providerId: string,
  model: string,
  messages: ChatMessage[],
  keepLast?: number,
): Promise<ContextCompactResult> {
  const { done } = request("context.compact", {
    providerId,
    model,
    messages,
    ...(keepLast !== undefined ? { keepLast } : {}),
  });
  const data = await done;
  if (typeof data.summary !== "string" || !data.summary) {
    throw new Error("réponse context.compact invalide");
  }
  return {
    summary: data.summary,
    coveredTurns:
      typeof data.coveredTurns === "number" && Number.isFinite(data.coveredTurns)
        ? data.coveredTurns
        : 0,
  };
}

/* ---------- Helpers typés Lot 2 : agent Claude (Agent SDK) ---------- */

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ClaudeStartParams {
  /** Optionnel en mode `chatOnly` (le sidecar prend le répertoire personnel). */
  cwd?: string;
  prompt: string;
  /** `null`/absent démarre une nouvelle session ; sinon reprend la session SDK. */
  sessionId?: string | null;
  /** `null`/absent laisse le SDK choisir son modèle par défaut. */
  model?: string | null;
  permissionMode?: PermissionMode;
  systemPrompt?: string | null;
  /** Mode chat pur : tous les outils sont interdits côté SDK. */
  chatOnly?: boolean;
  /** Chat pur seulement (ignoré sinon) : exception au vidage — `tools: ["WebSearch", "WebFetch"]`. */
  webSearch?: boolean;
  /** Un humain peut répondre en direct : arme l'outil de question interactive
   *  `mcp__studio__ask_user` (modale à choix cliquables). Réservé aux tours
   *  lancés depuis une page ouverte — jamais pour l'orchestration headless. */
  interactive?: boolean;
  /** T-003 — allowlist d'outils de l'agent (`null`/absent = palette complète). Hors mode `chatOnly`. */
  tools?: string[] | null;
  /** Pièces jointes du `prompt` (voir docs/protocol.md) — omis si vide/absent. */
  attachments?: ChatAttachment[];
  /** Métadonnées de supervision (voir docs/protocol.md § S1) — omis si absent. */
  meta?: RequestMeta;
}

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
}

/** Données extraites du `done` d'un `claude.start` (un tour de conversation). */
export interface ClaudeDoneData {
  sessionId: string;
  subtype: string;
  result?: string;
  usage: ClaudeUsage | null;
  /**
   * Occupation réelle de la fenêtre de contexte au dernier appel API du tour,
   * en tokens — sert la jauge « Contexte » de l'en-tête. À NE PAS confondre
   * avec `usage`, qui cumule tous les appels du tour agentique (son cache_read
   * additionne N fois le préfixe, d'où des « contextes » à plusieurs centaines
   * de %). `null` si le sidecar ne l'a pas remonté (tour sans appel modèle, ou
   * version antérieure).
   */
  contextTokens: number | null;
  totalCostUsd: number | null;
}

/** Callbacks appelés au fil de l'eau, un par `kind` de chunk (union discriminée côté protocole). */
/** État d'un serveur MCP au démarrage du tour (chunk `init`, voir docs/protocol.md). */
export interface ClaudeInitMcpServer {
  name: string;
  /** Statut rapporté par le SDK : `connected`, `failed`, `needs_auth`… */
  status: string;
  /** Outils exposés, noms courts (sans le préfixe `mcp__<serveur>__`). */
  tools: string[];
}

export interface ClaudeStartCallbacks {
  onInit?: (sessionId: string, model: string) => void;
  /**
   * État RÉEL des serveurs MCP au démarrage du tour, plus le coût en outils
   * (MCP vs intégrés) et la latence de démarrage. Émis avec le même chunk
   * `init` : un sidecar antérieur ne renvoie rien, le callback n'est alors
   * jamais appelé.
   */
  onMcpInit?: (info: {
    servers: ClaudeInitMcpServer[];
    mcpToolCount: number;
    builtinToolCount: number;
    startupMs: number | null;
  }) => void;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolUse?: (toolUseId: string, toolName: string, toolInput: unknown) => void;
  onToolResult?: (toolUseId: string, isError: boolean, summary: string) => void;
  onPermissionRequest?: (permissionId: string, toolName: string, toolInput: unknown) => void;
  /** Liste COMPLÈTE des tâches de fond vivantes (remplace la précédente — vide = tout est fini). */
  onBackgroundTasks?: (count: number, descriptions: string[]) => void;
  /** Tour du modèle terminé mais le sidecar attend les rapports de `count` tâche(s) de fond. */
  onBackgroundWait?: (count: number, descriptions: string[]) => void;
  /** Compaction de contexte terminée (« /compact » ou compaction auto) — `preTokens` = taille du contexte avant, si connue. */
  onCompact?: (trigger: string, preTokens: number | null) => void;
}

function str(data: Record<string, unknown>, key: string, fallback = ""): string {
  const v = data[key];
  return typeof v === "string" ? v : fallback;
}

type ClaudeChunkHandler = (data: Record<string, unknown>, callbacks: ClaudeStartCallbacks) => void;

const CLAUDE_CHUNK_HANDLERS: Record<string, ClaudeChunkHandler> = {
  init: (data, callbacks) => {
    callbacks.onInit?.(str(data, "sessionId"), str(data, "model"));
    if (!Array.isArray(data.mcpServers)) return;
    const servers: ClaudeInitMcpServer[] = [];
    for (const raw of data.mcpServers) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.name !== "string" || !entry.name) continue;
      servers.push({
        name: entry.name,
        status: typeof entry.status === "string" ? entry.status : "unknown",
        tools: Array.isArray(entry.tools) ? entry.tools.filter((t): t is string => typeof t === "string") : [],
      });
    }
    callbacks.onMcpInit?.({
      servers,
      mcpToolCount: typeof data.mcpToolCount === "number" ? data.mcpToolCount : 0,
      builtinToolCount: typeof data.builtinToolCount === "number" ? data.builtinToolCount : 0,
      startupMs: typeof data.startupMs === "number" ? data.startupMs : null,
    });
  },
  text: (data, callbacks) => {
    const delta = str(data, "delta");
    if (delta) callbacks.onText?.(delta);
  },
  thinking: (data, callbacks) => {
    const delta = str(data, "delta");
    if (delta) callbacks.onThinking?.(delta);
  },
  tool_use: (data, callbacks) =>
    callbacks.onToolUse?.(str(data, "toolUseId"), str(data, "toolName", "outil"), data.toolInput),
  tool_result: (data, callbacks) =>
    callbacks.onToolResult?.(str(data, "toolUseId"), data.isError === true, str(data, "summary")),
  permission_request: (data, callbacks) =>
    callbacks.onPermissionRequest?.(str(data, "permissionId"), str(data, "toolName", "outil"), data.toolInput),
  background_tasks: (data, callbacks) =>
    callbacks.onBackgroundTasks?.(
      typeof data.count === "number" ? data.count : 0,
      Array.isArray(data.descriptions) ? data.descriptions.filter((d): d is string => typeof d === "string") : [],
    ),
  background_wait: (data, callbacks) =>
    callbacks.onBackgroundWait?.(
      typeof data.count === "number" ? data.count : 0,
      Array.isArray(data.descriptions) ? data.descriptions.filter((d): d is string => typeof d === "string") : [],
    ),
  compact: (data, callbacks) =>
    callbacks.onCompact?.(str(data, "trigger", "manual"), typeof data.preTokens === "number" ? data.preTokens : null),
};

/**
 * Lance un tour de conversation agentique (`claude.start`), streamé. Chaque
 * chunk `data.kind` est routé vers le callback correspondant. Utiliser l'`id`
 * de la poignée retournée pour `claudeAbort`/corréler les `permission_request`,
 * et le `sessionId` reçu via `onInit` pour le tour suivant.
 */
export function claudeStart(params: ClaudeStartParams, callbacks: ClaudeStartCallbacks): RequestHandle {
  return request(
    "claude.start",
    {
      cwd: params.cwd ?? null,
      prompt: params.prompt,
      sessionId: params.sessionId ?? null,
      model: params.model ?? null,
      permissionMode: params.permissionMode ?? "default",
      systemPrompt: params.systemPrompt ?? null,
      chatOnly: params.chatOnly === true,
      ...(params.webSearch === true ? { webSearch: true } : {}),
      ...(params.interactive === true ? { interactive: true } : {}),
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.attachments && params.attachments.length > 0 ? { attachments: params.attachments } : {}),
      ...(params.meta ? { meta: params.meta } : {}),
    },
    {
      onChunk: (data) => {
        const kind = typeof data.kind === "string" ? data.kind : "";
        CLAUDE_CHUNK_HANDLERS[kind]?.(data, callbacks);
      },
    },
  );
}

/** Extrait les champs typés du `data` reçu au `done` d'un `claude.start`. */
export function parseClaudeDone(data: Record<string, unknown>): ClaudeDoneData {
  const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
  const subtype = typeof data.subtype === "string" ? data.subtype : "success";
  const result = typeof data.result === "string" ? data.result : undefined;

  let usage: ClaudeUsage | null = null;
  if (data.usage && typeof data.usage === "object") {
    const u = data.usage as Record<string, unknown>;
    if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
      usage = {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadInputTokens:
          typeof u.cacheReadInputTokens === "number" ? u.cacheReadInputTokens : undefined,
      };
    }
  }

  const contextTokens = typeof data.contextTokens === "number" ? data.contextTokens : null;
  const totalCostUsd = typeof data.totalCostUsd === "number" ? data.totalCostUsd : null;
  return { sessionId, subtype, result, usage, contextTokens, totalCostUsd };
}

/** Répond à un `permission_request` en attente sur le tour `targetId`. */
export async function claudePermission(
  targetId: string,
  permissionId: string,
  decision: "allow" | "deny",
  message?: string,
): Promise<boolean> {
  const { done } = request("claude.permission", {
    targetId,
    permissionId,
    decision,
    message: message ?? null,
  });
  const data = await done;
  return data.applied === true;
}

/** Interrompt le tour `claude.start` en cours identifié par `targetId`. */
export async function claudeAbort(targetId: string): Promise<boolean> {
  const { done } = request("claude.abort", { targetId });
  const data = await done;
  return data.aborted === true;
}

/**
 * S3 — glisse une demande dans le tour EN COURS (`targetId`) : le moteur
 * l'injecte au prochain retour d'outil, sans couper le tour ni en ouvrir un
 * nouveau. `false` si le tour n'existe plus ou a été interrompu — l'appelant
 * doit alors se rabattre sur la file d'attente.
 */
export async function claudePush(targetId: string, content: string): Promise<boolean> {
  const { done } = request("claude.push", { targetId, content });
  const data = await done;
  return data.pushed === true;
}

/**
 * Dépose (ou rafraîchit) le guide d'intégration `iaction.md` dans
 * `.iaction/connaissances/` du projet. Appelé à la SÉLECTION du projet : sans
 * ça, le guide n'apparaissait qu'au premier tour, après le scan des
 * connaissances par l'UI — donc ni listé ni injecté de toute la session.
 * Best effort : un échec ne bloque rien (le guide est un confort).
 */
export async function projectEnsureDoc(cwd: string): Promise<boolean> {
  const { done } = request("project.ensureDoc", { cwd });
  const data = await done;
  return data.ensured === true;
}

/** Rend la main pendant l'attente des rapports de tâches de fond (chunk
    `background_wait`) : clôt le tour proprement — le résultat déjà connu est
    livré via le `done` du tour — sans le marquer interrompu. `false` si le
    tour n'est pas dans cette phase (en pleine génération, c'est `claudeAbort`). */
export async function claudeRelease(targetId: string): Promise<boolean> {
  const { done } = request("claude.release", { targetId });
  const data = await done;
  return data.released === true;
}

/** Pose (ou retire si `null`) la clé API Claude utilisée par les prochaines sessions. */
export async function claudeConfigure(apiKey: string | null): Promise<boolean> {
  const { done } = request("claude.configure", { apiKey });
  const data = await done;
  return data.configured === true;
}

/* ---------- Helpers typés Lot 6 : agent du moteur neutre (« tous agents à égalité ») ---------- */

/** Pas de mode `plan` côté neutre (voir docs/protocol.md, Lot 6). */
export type NeutralPermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface NeutralStartParams {
  providerId: string;
  model: string;
  cwd: string;
  /** Moteur SANS état de session : historique complet, dernier élément = nouveau message utilisateur. */
  messages: ChatMessage[];
  permissionMode?: NeutralPermissionMode;
  maxTurns?: number;
  /** T-003 — allowlist d'outils de l'agent (`null`/absent = palette complète). */
  tools?: string[] | null;
  /** Métadonnées de supervision (voir docs/protocol.md § S1) — omis si absent. */
  meta?: RequestMeta;
}

/**
 * Mêmes callbacks que `ClaudeStartCallbacks`, sans `onThinking` (le moteur
 * neutre n'émet pas de chunk `thinking`) ; `onInit` reçoit toujours
 * `sessionId: null` (moteur sans état de session, voir docs/protocol.md).
 */
export interface NeutralStartCallbacks {
  onInit?: (sessionId: string | null, model: string) => void;
  onText?: (delta: string) => void;
  onToolUse?: (toolUseId: string, toolName: string, toolInput: unknown) => void;
  onToolResult?: (toolUseId: string, isError: boolean, summary: string) => void;
  onPermissionRequest?: (permissionId: string, toolName: string, toolInput: unknown) => void;
}

type NeutralChunkHandler = (data: Record<string, unknown>, callbacks: NeutralStartCallbacks) => void;

const NEUTRAL_CHUNK_HANDLERS: Record<string, NeutralChunkHandler> = {
  init: (data, callbacks) =>
    callbacks.onInit?.(typeof data.sessionId === "string" ? data.sessionId : null, str(data, "model")),
  text: (data, callbacks) => {
    const delta = str(data, "delta");
    if (delta) callbacks.onText?.(delta);
  },
  tool_use: (data, callbacks) =>
    callbacks.onToolUse?.(str(data, "toolUseId"), str(data, "toolName", "outil"), data.toolInput),
  tool_result: (data, callbacks) =>
    callbacks.onToolResult?.(str(data, "toolUseId"), data.isError === true, str(data, "summary")),
  permission_request: (data, callbacks) =>
    callbacks.onPermissionRequest?.(str(data, "permissionId"), str(data, "toolName", "outil"), data.toolInput),
};

/**
 * Lance un tour de conversation agentique via le moteur neutre (`neutral.start`),
 * MÊME contrat de chunks que `claudeStart`. Le moteur n'a pas d'état de
 * session : `params.messages` doit porter tout l'historique (voir
 * `docs/protocol.md`, Lot 6).
 */
export function neutralStart(params: NeutralStartParams, callbacks: NeutralStartCallbacks): RequestHandle {
  return request(
    "neutral.start",
    {
      providerId: params.providerId,
      model: params.model,
      cwd: params.cwd,
      messages: params.messages,
      permissionMode: params.permissionMode ?? "default",
      maxTurns: params.maxTurns ?? null,
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.meta ? { meta: params.meta } : {}),
    },
    {
      onChunk: (data) => {
        const kind = typeof data.kind === "string" ? data.kind : "";
        NEUTRAL_CHUNK_HANDLERS[kind]?.(data, callbacks);
      },
    },
  );
}

/** Données extraites du `done` d'un `neutral.start` : même forme que `parseClaudeDone`, sessionId/totalCostUsd toujours `null`. */
export interface NeutralDoneData {
  sessionId: null;
  subtype: string;
  result?: string;
  usage: ClaudeUsage | null;
  totalCostUsd: null;
}

export function parseNeutralDone(data: Record<string, unknown>): NeutralDoneData {
  const subtype = typeof data.subtype === "string" ? data.subtype : "success";
  const result = typeof data.result === "string" ? data.result : undefined;

  let usage: ClaudeUsage | null = null;
  if (data.usage && typeof data.usage === "object") {
    const u = data.usage as Record<string, unknown>;
    if (typeof u.inputTokens === "number" && typeof u.outputTokens === "number") {
      usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens };
    }
  }

  return { sessionId: null, subtype, result, usage, totalCostUsd: null };
}

/** Répond à un `permission_request` en attente sur le tour `targetId` (même contrat que `claudePermission`). */
export async function neutralPermission(
  targetId: string,
  permissionId: string,
  decision: "allow" | "deny",
  message?: string,
): Promise<boolean> {
  const { done } = request("neutral.permission", {
    targetId,
    permissionId,
    decision,
    message: message ?? null,
  });
  const data = await done;
  return data.applied === true;
}

/** Interrompt le tour `neutral.start` en cours identifié par `targetId` (même contrat que `claudeAbort`). */
export async function neutralAbort(targetId: string): Promise<boolean> {
  const { done } = request("neutral.abort", { targetId });
  const data = await done;
  return data.aborted === true;
}

/* ---------- Helpers typés « Méthodes conso » (mini-tranche du Lot 8) ---------- */

export interface ClaudeUsageWindow {
  utilization: number;
  resetsAt: string;
}

/** Dernier instantané connu des limites d'abonnement Claude (`usage.claude`). */
export interface ClaudeUsageSnapshot {
  available: boolean;
  subscriptionType: string | null;
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  /**
   * Toutes les fenêtres relayées par le sidecar (clé brute de l'API → fenêtre),
   * dont celles spécifiques à un modèle (ex. hebdo Opus/Fable) — voir
   * docs/protocol.md § usage.claude.
   */
  windows: Record<string, ClaudeUsageWindow>;
  capturedAt: string | null;
}

function parseUsageWindow(value: unknown): ClaudeUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const w = value as Record<string, unknown>;
  if (typeof w.utilization === "number" && typeof w.resetsAt === "string") {
    return { utilization: w.utilization, resetsAt: w.resetsAt };
  }
  return null;
}

/**
 * Interroge le dernier instantané des limites d'abonnement Claude (fenêtres
 * 5h / 7j). `available: false` tant qu'aucun tour Claude n'a été joué dans
 * cette session sidecar (ou fournisseur clé API, sans limites applicables).
 */
export async function usageClaude(): Promise<ClaudeUsageSnapshot> {
  const { done } = request("usage.claude", {});
  return parseClaudeUsageSnapshot(await done);
}

/**
 * Initialise le relevé d'abonnement via un micro-tour Claude économique
 * (haiku, chat pur — voir docs/protocol.md § usage.claude.init). À réserver à
 * une action explicite de l'utilisateur.
 */
export async function usageClaudeInit(): Promise<ClaudeUsageSnapshot> {
  const { done } = request("usage.claude.init", {});
  return parseClaudeUsageSnapshot(await done);
}

function parseClaudeUsageSnapshot(data: Record<string, unknown>): ClaudeUsageSnapshot {
  if (data.available !== true) {
    return { available: false, subscriptionType: null, fiveHour: null, sevenDay: null, windows: {}, capturedAt: null };
  }
  const windows: Record<string, ClaudeUsageWindow> = {};
  if (data.windows && typeof data.windows === "object") {
    for (const [key, value] of Object.entries(data.windows as Record<string, unknown>)) {
      const parsed = parseUsageWindow(value);
      if (parsed) windows[key] = parsed;
    }
  }
  return {
    available: true,
    subscriptionType: typeof data.subscriptionType === "string" ? data.subscriptionType : null,
    fiveHour: parseUsageWindow(data.fiveHour),
    sevenDay: parseUsageWindow(data.sevenDay),
    windows,
    capturedAt: typeof data.capturedAt === "string" ? data.capturedAt : null,
  };
}

/** Crédits restants OpenRouter (montants en dollars). Rejette si clé absente/erreur réseau. */
export interface OpenrouterUsage {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

export async function usageOpenrouter(providerId: string): Promise<OpenrouterUsage> {
  const { done } = request("usage.openrouter", { providerId });
  const data = await done;
  return {
    totalCredits: typeof data.totalCredits === "number" ? data.totalCredits : 0,
    totalUsage: typeof data.totalUsage === "number" ? data.totalUsage : 0,
    remaining: typeof data.remaining === "number" ? data.remaining : 0,
  };
}

/* ---------- Helpers typés « ollama.* » (gestion des modèles chargés) ---------- */

/** Un modèle actuellement chargé en mémoire côté serveur Ollama (`ollama.ps`). */
export interface OllamaModelInfo {
  name: string;
  sizeVram: number | null;
  sizeTotal: number | null;
  expiresAt: string | null;
}

function toOllamaModelInfo(value: unknown): OllamaModelInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name) return null;
  return {
    name: v.name,
    sizeVram: typeof v.sizeVram === "number" && Number.isFinite(v.sizeVram) ? v.sizeVram : null,
    sizeTotal: typeof v.sizeTotal === "number" && Number.isFinite(v.sizeTotal) ? v.sizeTotal : null,
    expiresAt: typeof v.expiresAt === "string" && v.expiresAt ? v.expiresAt : null,
  };
}

/**
 * Liste les modèles Ollama actuellement chargés en mémoire. Rejette (promesse
 * rejetée) si le fournisseur est inconnu ou si son API native ne répond pas
 * comme un serveur Ollama — c'est le signal utilisé par `OllamaPanel` pour
 * décider de s'afficher ou non.
 */
export async function ollamaPs(providerId: string): Promise<OllamaModelInfo[]> {
  const { done } = request("ollama.ps", { providerId });
  const data = await done;
  if (!Array.isArray(data.models)) return [];
  const out: OllamaModelInfo[] = [];
  for (const raw of data.models) {
    const m = toOllamaModelInfo(raw);
    if (m) out.push(m);
  }
  return out;
}

/** Charge un modèle Ollama en mémoire (peut prendre plusieurs minutes à froid). */
export async function ollamaLoad(providerId: string, model: string): Promise<void> {
  const { done } = request("ollama.load", { providerId, model });
  await done;
}

/** Décharge un modèle Ollama de la mémoire (`keep_alive:0`). */
export async function ollamaUnload(providerId: string, model: string): Promise<void> {
  const { done } = request("ollama.unload", { providerId, model });
  await done;
}

/* ---------- Helpers typés « claude.commands » (menu « / » du composeur) ---------- */

/** Un slash-command/skill invocable pour un projet (voir docs/protocol.md, `claude.commands`). */
export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
}

function toSlashCommandInfo(value: unknown): SlashCommandInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name) return null;
  const info: SlashCommandInfo = {
    name: v.name,
    description: typeof v.description === "string" ? v.description : "",
    argumentHint: typeof v.argumentHint === "string" ? v.argumentHint : "",
  };
  if (Array.isArray(v.aliases)) {
    const aliases = v.aliases.filter((a): a is string => typeof a === "string" && a.length > 0);
    if (aliases.length > 0) info.aliases = aliases;
  }
  return info;
}

/**
 * Énumère les slash-commands/skills invocables pour un projet (alimente le menu
 * « / » du composeur). Best effort : rejette en cas d'échec d'initialisation SDK
 * (auth, cwd invalide) — à l'appelant de retomber sur une liste vide sans bloquer
 * la saisie (voir docs/protocol.md, `claude.commands`).
 */
export async function claudeCommands(cwd: string): Promise<SlashCommandInfo[]> {
  const { done } = request("claude.commands", { cwd });
  const data = await done;
  if (!Array.isArray(data.commands)) return [];
  const out: SlashCommandInfo[] = [];
  for (const raw of data.commands) {
    const info = toSlashCommandInfo(raw);
    if (info) out.push(info);
  }
  return out;
}

/* ---------- Helpers typés R5 : connaissances indexées (`knowledge.*`) ---------- */

/** Progression streamée d'un `knowledge.index` (un chunk par fichier traité). */
export interface KnowledgeIndexProgress {
  file: string;
  done: number;
  total: number;
}

/** `done` d'un `knowledge.index` (voir docs/protocol.md, `knowledge.index`). */
export interface KnowledgeIndexResult {
  files: number;
  chunks: number;
  model: string;
}

/** État de l'index d'un projet (voir docs/protocol.md, `knowledge.status`). */
export interface KnowledgeStatus {
  exists: boolean;
  files: number;
  chunks: number;
  model: string | null;
  builtAt: string | null;
  /** Un document source a changé/apparu/disparu depuis la construction de l'index. */
  stale: boolean;
}

/**
 * (Re)construit l'index d'embeddings du projet (incrémental par mtime).
 * `pinned` : chemins des documents épinglés (l'état `project-knowledge` vit
 * côté UI, le sidecar collecte lui-même automatiques + détectées). Rejette en
 * cas d'erreur (fournisseur d'embeddings inconnu, réseau…) — message lisible.
 */
export async function knowledgeIndex(
  cwd: string,
  pinned: string[],
  onProgress?: (progress: KnowledgeIndexProgress) => void,
): Promise<KnowledgeIndexResult> {
  const { done } = request(
    "knowledge.index",
    { cwd, ...(pinned.length > 0 ? { pinned } : {}) },
    {
      onChunk: (data) => {
        if (typeof data.file === "string" && typeof data.done === "number" && typeof data.total === "number") {
          onProgress?.({ file: data.file, done: data.done, total: data.total });
        }
      },
    },
  );
  const data = await done;
  return {
    files: typeof data.files === "number" ? data.files : 0,
    chunks: typeof data.chunks === "number" ? data.chunks : 0,
    model: typeof data.model === "string" ? data.model : "",
  };
}

/** État de l'index du projet — `pinned` participe au calcul de `stale` (mêmes chemins que l'indexation). */
export async function knowledgeStatus(cwd: string, pinned: string[]): Promise<KnowledgeStatus> {
  const { done } = request("knowledge.status", { cwd, ...(pinned.length > 0 ? { pinned } : {}) });
  const data = await done;
  return {
    exists: data.exists === true,
    files: typeof data.files === "number" ? data.files : 0,
    chunks: typeof data.chunks === "number" ? data.chunks : 0,
    model: typeof data.model === "string" && data.model ? data.model : null,
    builtAt: typeof data.builtAt === "string" && data.builtAt ? data.builtAt : null,
    stale: data.stale === true,
  };
}

/* ---------- Helpers typés « claude.sessionTitles » (titres courts calculés par le CLI) ---------- */

/**
 * Titres de sessions déjà calculés par le CLI Claude (voir docs/protocol.md,
 * `claude.sessionTitles`) — best effort et zéro token : ne rejette jamais,
 * une panne (sidecar, SDK, cwd inconnu du CLI) renvoie une map vide et
 * l'appelant retombe sur son repli local (`deriveTitleFromText`).
 */
export async function claudeSessionTitles(cwd: string, sessionIds?: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const params: Record<string, unknown> = { cwd };
    if (sessionIds && sessionIds.length > 0) params.sessionIds = sessionIds;
    const { done } = request("claude.sessionTitles", params);
    const data = await done;
    if (!Array.isArray(data.titles)) return titles;
    for (const raw of data.titles) {
      if (typeof raw !== "object" || raw === null) continue;
      const v = raw as Record<string, unknown>;
      if (typeof v.sessionId === "string" && v.sessionId && typeof v.title === "string" && v.title) {
        titles.set(v.sessionId, v.title);
      }
    }
    return titles;
  } catch {
    return titles;
  }
}
