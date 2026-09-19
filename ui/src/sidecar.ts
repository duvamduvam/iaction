/*
 * Encapsule la communication avec le sidecar via Tauri :
 * - un seul `listen('sidecar:event', …)` global, corrélation par `id`
 *   dans une Map (pas un listen par requête) ;
 * - `request()` pour envoyer une requête et suivre ses chunks/done/error ;
 * - `subscribeStatus` / `subscribeReady` / `subscribeLog` pour les
 *   abonnements React (add/remove synchrones dans un Set : sûrs même
 *   avec le double montage des effets en StrictMode).
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
import { toModelDetail, type ModelDetail } from "./modelDetail";
import type { ProviderTraits } from "./providerTraits";

export type { ModelDetail, ModelPricing } from "./modelDetail";

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
  /** Requête de SONDE : son échec est une réponse, pas une panne (voir RequestOptions). */
  sonde?: boolean;
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
  /**
   * Requête de SONDE (T-007) : on interroge pour SAVOIR, un refus est une
   * réponse valide — journalisé en `debug`, pas en `error`. Rien n'est tu,
   * mais un journal qui crie 140 fois pour une réponse attendue n'est plus
   * lisible, et c'est alors la VRAIE panne qui se perd dans le bruit.
   */
  sonde?: boolean;
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
 * T-062 — préfixe par fenêtre, calculé une fois au chargement du module : chaque webview a
 * son propre compteur reparti de zéro, mais les événements sont diffusés à TOUTES les fenêtres.
 *
 * Exporté depuis T-086 : c'est l'identité de fenêtre la plus utile qui existe côté interface,
 * puisque c'est ELLE qu'on lit dans le journal (`req-xxxxxx-42`). Le verrou de cadence des
 * relevés s'en sert, si bien qu'une ligne du journal suffit à dire quelle fenêtre sondait.
 */
export const identifiantFenetre = Math.random().toString(36).slice(2, 8);

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

/**
 * T-076 — message d'un event `error` de protocole : une chaîne VIDE compte
 * comme absente, pas comme un message légitime (la garde précédente laissait
 * passer `message: ""`, un événement muet malgré son étiquette d'erreur).
 * Exportée : pure, testée sans mock de Tauri.
 */
export function messageErreurProtocole(data: Record<string, unknown>): string {
  return typeof data.message === "string" && data.message.length > 0 ? data.message : "Erreur inconnue";
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
      const message = messageErreurProtocole(payload.data);
      // L2 — journalisation AUTOMATIQUE de toute erreur de protocole : avant
      // ce point, chaque appelant affichait l'erreur dans son coin puis
      // l'oubliait. GARDE ANTI-RÉCURSION : ne jamais journaliser l'échec
      // d'une requête de journalisation (elle produirait un nouveau
      // `log.append`, qui échouerait de même — boucle infinie).
      if (handlers.method !== LOG_APPEND_METHOD) {
        // Une SONDE descend en `debug` : son échec est une réponse (T-007).
        logUi(handlers.sonde ? "debug" : "error", "ui", message, {
          reqId: payload.id,
          fields: { method: handlers.method },
        });
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

// T-055 — hors webview (tests Node), pas de `window` : rien à écouter, et le
// module doit rester importable sans s'installer par effet de bord d'import.
const listenersReady = typeof window === "undefined" ? Promise.resolve() : setupListeners();

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
  const id = `req-${identifiantFenetre}-${requestCounter}`;

  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    pending.set(id, { method, sonde: options.sonde, onChunk: options.onChunk, resolve, reject });

    listenersReady
      .then(() => invoke("sidecar_request", { request: { id, method, params } }))
      .catch((err: unknown) => {
        pending.delete(id);
        const message = err instanceof Error ? err.message : String(err);
        // L2 — la requête n'a même pas pu partir (sidecar mort, stdin absent).
        // MÊME GARDE ANTI-RÉCURSION que ci-dessus (log.append sur lui-même).
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

/** État courant du sidecar (appel direct, hors abonnement aux events). */
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
  /** R8-A — écarts déclarés de ce fournisseur (catalogue, corps, comptabilité). */
  traits?: ProviderTraits;
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

import { toRouteDebord, isRouteTier, toRouteTarget } from "./protocole";

export {
  parseChatDone,
  parseClaudeDone,
  parseNeutralDone,
  type ChatDoneData,
  type ChatUsage,
  type ClaudeDoneData,
  type ClaudeUsage,
  type NeutralDoneData,
  isRouteTier,
  toRouteTarget,
} from "./protocole";

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
  /** T-005 — occupation de la fenêtre 7 jours (`null` : absente, ou sidecar antérieur). */
  sevenDayPct: number | null;
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
// R9 — le contrat de la recherche web vit dans la feuille `rechercheWeb.ts`
// (testable sans Tauri) ; on le ré-exporte pour les appelants habitués à
// trouver les types du protocole ici.
import { parseEtatWeb, type OptionsWebChat } from "./rechercheWeb";
export type { AvancementWeb, EtatRechercheWeb, OptionsWebChat, SourceWeb } from "./rechercheWeb";

export interface ExtrasChatSend {
  attachments?: ChatAttachment[];
  meta?: RequestMeta;
  /** R9 — recherche web. Absent = tour identique à celui d'avant R9. */
  web?: OptionsWebChat;
}

export function chatSend(
  providerId: string,
  model: string,
  messages: ChatMessage[],
  options: ChatOptions,
  onDelta: (delta: string) => void,
  extras: ExtrasChatSend = {},
): RequestHandle {
  const { attachments, meta, web } = extras;
  return request(
    "chat.send",
    {
      providerId,
      model,
      messages,
      options,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(meta ? { meta } : {}),
      // R9 — opt-in strict : le champ n'est envoyé QUE s'il est vrai, pour que
      // le corps d'un tour sans recherche reste identique à l'octet près.
      ...(web?.actif ? { webSearch: true } : {}),
    },
    {
      onChunk: (data) => {
        const etat = parseEtatWeb(data.web);
        if (etat) {
          web?.onWeb?.(etat);
          return;
        }
        const delta = typeof data.delta === "string" ? data.delta : "";
        if (delta) onDelta(delta);
      },
    },
  );
}

/** Extrait `finishReason`/`usage`/`modelUsed` du `data` reçu au `done` d'un `chat.send`. */
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
  /**
   * T-102 — signe de vie d'un sous-agent : compteur cumulé et dernier outil,
   * jamais la liste que T-092 a retirée du fil. Sans lui, un `Agent` peut
   * occuper le tour 38 min sans rien qui le distingue d'un blocage.
   */
  onSousAgentBattement?: (
    toolUseId: string,
    outils: number,
    dernierOutil: string | null,
    instant: number,
  ) => void;
  /** Tour du modèle terminé mais le sidecar attend les rapports de `count` tâche(s) de fond. */
  onBackgroundWait?: (count: number, descriptions: string[]) => void;
  /** Compaction de contexte terminée (« /compact » ou compaction auto) — `preTokens` = taille du contexte avant, si connue. */
  onCompact?: (trigger: string, preTokens: number | null) => void;
  /** T-087 — un `claude.push` jamais injecté (aucun retour d'outil depuis) : à reposer en file, jamais perdu en silence. */
  onPushPerdu?: (contenu: string, avaitPieces: boolean) => void;
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
  sous_agent_battement: (data, callbacks) =>
    callbacks.onSousAgentBattement?.(
      str(data, "toolUseId"),
      typeof data.outils === "number" ? data.outils : 0,
      typeof data.dernierOutil === "string" ? data.dernierOutil : null,
      // Instant pris à la SOURCE, pas au rendu (T-101) : sinon « il y a 40 s » dérive.
      typeof data.instant === "number" ? data.instant : Date.now(),
    ),
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
  push_perdu: (data, callbacks) => callbacks.onPushPerdu?.(str(data, "contenu"), data.avaitPieces === true),
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
 * S3/T-064 — glisse une demande (et ses pièces jointes) dans le tour EN COURS
 * (`targetId`) : le moteur l'injecte au prochain retour d'outil, sans couper
 * le tour ni en ouvrir un nouveau. `true` est un accusé de DÉPÔT, pas de
 * réception (T-087) : un tour sans retour d'outil après ce push le repose de
 * lui-même en file via le chunk `push_perdu` (voir `onPushPerdu`). `false` si
 * le tour n'existe plus ou a été interrompu — l'appelant doit alors se
 * rabattre sur la file d'attente.
 */
export async function claudePush(
  targetId: string,
  content: string,
  attachments?: ChatAttachment[],
): Promise<boolean> {
  const { done } = request("claude.push", {
    targetId,
    content,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  });
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

// Helpers typés R5 (`knowledge.*`, connaissances indexées) : sortis dans
// connaissancesClient.ts (cliquet de taille) — voir aussi consoClient.ts,
// même patron.

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
