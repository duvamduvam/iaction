/**
 * Moteur neutre — Lot 1.
 *
 * Client streaming vers des endpoints « dialecte OpenAI » (Ollama, OpenRouter,
 * endpoints custom). Aucune dépendance runtime : fetch natif Node 22 + parsing
 * SSE maison (voir docs/protocol.md, section « Méthodes Lot 1 »).
 *
 * Règle absolue : une apiKey ne doit jamais être écrite sur disque, ni loguée
 * (même sur stderr) — y compris dans les messages d'erreur.
 */

import {
  formatTextAttachmentPrefix,
  isImageAttachment,
  isTextAttachment,
  validateAttachments,
  type Attachment,
} from "./attachments.js";
import { recordUsageEvent, type UsageStatus } from "./usageStats.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Provider {
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

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

/** Sortie des méthodes du moteur : les mêmes primitives que le protocole (chunk/done/error). */
export interface EngineEmitter {
  chunk(id: string, data: unknown): void;
  done(id: string, data?: unknown): void;
  error(id: string, message: string): void;
}

// ---------------------------------------------------------------------------
// État en mémoire
// ---------------------------------------------------------------------------

const providers = new Map<string, Provider>();
/** chat.send en cours, id de requête -> contrôleur d'abandon. */
const inFlight = new Map<string, AbortController>();

/** Accès en lecture seule à la table des fournisseurs, pour les autres moteurs (ex. neutralAgent.ts). */
export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Tableau non vide dont chaque entrée est une chaîne non vide (réglage `fallbackModels`). */
function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => isNonEmptyString(v));
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
}

export function buildHeaders(
  provider: Provider,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (extra) {
    Object.assign(headers, extra);
  }
  if (provider.apiKey) {
    headers["Authorization"] = `Bearer ${provider.apiKey}`;
  }
  if (provider.headers) {
    Object.assign(headers, provider.headers);
  }
  return headers;
}

const MAX_ERROR_BODY = 2048;

/** Lit le corps d'une réponse HTTP en erreur, borné (pour ne pas gonfler les logs/messages). */
export async function readBoundedBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > MAX_ERROR_BODY ? text.slice(0, MAX_ERROR_BODY) + "…" : text;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// providers.set
// ---------------------------------------------------------------------------

export function handleProvidersSet(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): void {
  const list = params.providers;
  if (!Array.isArray(list)) {
    emitter.error(id, "params.providers doit être un tableau");
    return;
  }

  const next = new Map<string, Provider>();
  for (const entry of list) {
    if (!isPlainObject(entry)) {
      emitter.error(id, "chaque provider doit être un objet");
      return;
    }
    const pid = entry.id;
    const label = entry.label;
    const baseUrl = entry.baseUrl;
    if (!isNonEmptyString(pid) || !isNonEmptyString(label) || !isNonEmptyString(baseUrl)) {
      emitter.error(id, "provider invalide : id, label et baseUrl sont requis");
      return;
    }
    const apiKey = isNonEmptyString(entry.apiKey) ? entry.apiKey : undefined;
    const headers = isPlainObject(entry.headers)
      ? (entry.headers as Record<string, string>)
      : undefined;
    // R0 — réglages de routage OpenRouter : validation souple, un champ mal
    // formé est simplement ignoré (jamais d'erreur).
    const fallbackModels = isNonEmptyStringArray(entry.fallbackModels)
      ? entry.fallbackModels
      : undefined;
    const priceSort = typeof entry.priceSort === "boolean" ? entry.priceSort : undefined;
    const usageAccounting =
      typeof entry.usageAccounting === "boolean" ? entry.usageAccounting : undefined;
    next.set(pid, { id: pid, label, baseUrl, apiKey, headers, fallbackModels, priceSort, usageAccounting });
  }

  providers.clear();
  for (const [k, v] of next) {
    providers.set(k, v);
  }

  emitter.done(id, { count: providers.size });
}

// ---------------------------------------------------------------------------
// models.list / models.detail
// ---------------------------------------------------------------------------

/**
 * Résout le provider depuis params.providerId, fait GET {baseUrl}/models et renvoie le
 * tableau brut de modèles (déjà filtré aux entrées avec un id non vide). En cas d'erreur
 * (provider inconnu, HTTP non-2xx, réseau), émet l'erreur elle-même et renvoie undefined :
 * l'appelant n'a plus qu'à vérifier ce cas et retourner.
 */
async function fetchRawModels(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<Array<Record<string, unknown>> | undefined> {
  const providerId = params.providerId;
  if (!isNonEmptyString(providerId)) {
    emitter.error(id, "params.providerId manquant ou invalide");
    return undefined;
  }
  const provider = providers.get(providerId);
  if (!provider) {
    emitter.error(id, `fournisseur inconnu: ${providerId}`);
    return undefined;
  }

  try {
    const res = await fetch(joinUrl(provider.baseUrl, "models"), {
      method: "GET",
      headers: buildHeaders(provider),
    });
    if (!res.ok) {
      const body = await readBoundedBody(res);
      emitter.error(id, `HTTP ${res.status} ${res.statusText}: ${body}`);
      return undefined;
    }
    const json = (await res.json()) as unknown;
    const rawModels = isPlainObject(json) && Array.isArray(json.data)
      ? json.data
      : Array.isArray(json)
        ? json
        : [];
    return rawModels.filter(
      (m): m is Record<string, unknown> => isPlainObject(m) && isNonEmptyString(m.id),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, `erreur réseau: ${message}`);
    return undefined;
  }
}

export async function handleModelsList(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const rawModels = await fetchRawModels(id, params, emitter);
  if (rawModels === undefined) {
    return;
  }
  const models = rawModels.map((m) => ({ id: m.id as string }));
  emitter.done(id, { models });
}

/** Arrondit un $/token OpenRouter (chaîne) en $/million (nombre), ou undefined si invalide. */
function usdPerTokenToPerMillion(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const perToken = Number(value);
  if (!Number.isFinite(perToken)) {
    return undefined;
  }
  // 4 décimales suffisent à représenter les grilles tarifaires usuelles ($/M) sans bruit
  // de virgule flottante (ex. 0.000003 * 1e6 → 3, pas 2.9999999999999996).
  return Math.round(perToken * 1e6 * 10000) / 10000;
}

interface DetailedModel {
  id: string;
  name?: string;
  contextLength?: number;
  pricing?: { promptUsdPerM?: number; completionUsdPerM?: number };
  description?: string;
}

function toDetailedModel(m: Record<string, unknown>): DetailedModel {
  const model: DetailedModel = { id: m.id as string };
  if (isNonEmptyString(m.name)) {
    model.name = m.name;
  }
  if (isFiniteNumber(m.context_length)) {
    model.contextLength = m.context_length;
  }
  if (isPlainObject(m.pricing)) {
    const promptUsdPerM = usdPerTokenToPerMillion(m.pricing.prompt);
    const completionUsdPerM = usdPerTokenToPerMillion(m.pricing.completion);
    if (promptUsdPerM !== undefined || completionUsdPerM !== undefined) {
      model.pricing = {
        ...(promptUsdPerM !== undefined ? { promptUsdPerM } : {}),
        ...(completionUsdPerM !== undefined ? { completionUsdPerM } : {}),
      };
    }
  }
  if (isNonEmptyString(m.description)) {
    model.description = m.description;
  }
  return model;
}

export async function handleModelsDetail(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const rawModels = await fetchRawModels(id, params, emitter);
  if (rawModels === undefined) {
    return;
  }
  const models = rawModels.map(toDetailedModel);
  emitter.done(id, { models });
}

// ---------------------------------------------------------------------------
// chat.send
// ---------------------------------------------------------------------------

interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** R0 — coût réel `usage.cost` (comptabilité d'usage OpenRouter), null si absent. */
  costUsd: number | null;
  /** R0 — tokens servis depuis le cache (`usage.prompt_tokens_details.cached_tokens`), null si absent. */
  cachedTokens: number | null;
}

function extractUsage(obj: Record<string, unknown>): Usage | null {
  const usage = obj.usage;
  if (!isPlainObject(usage)) {
    return null;
  }
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
  const costUsd = isFiniteNumber(usage.cost) ? usage.cost : null;
  const details = usage.prompt_tokens_details;
  const cachedTokens =
    isPlainObject(details) && isFiniteNumber(details.cached_tokens) ? details.cached_tokens : null;
  return { promptTokens, completionTokens, costUsd, cachedTokens };
}

/**
 * Construit le contenu OpenAI en tableau du dernier message utilisateur quand
 * des pièces jointes sont présentes : un unique bloc `text` (documents texte
 * préfixés, puis texte d'origine) suivi d'un bloc `image_url` par image (voir
 * docs/protocol.md, section Pièces jointes).
 */
function buildOpenAiAttachmentContent(
  originalContent: unknown,
  attachments: Attachment[],
): Array<Record<string, unknown>> {
  const originalText = typeof originalContent === "string" ? originalContent : "";
  const textPrefixes = attachments
    .filter(isTextAttachment)
    .map((doc) => formatTextAttachmentPrefix(doc.name, doc.content));
  const text = [...textPrefixes, originalText].filter((part) => part.length > 0).join("\n\n");

  const blocks: Array<Record<string, unknown>> = [{ type: "text", text }];
  for (const image of attachments.filter(isImageAttachment)) {
    blocks.push({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    });
  }
  return blocks;
}

/** Index du dernier message avec role "user", ou -1 si aucun. */
function findLastUserMessageIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isPlainObject(m) && m.role === "user") {
      return i;
    }
  }
  return -1;
}

/**
 * Instrumentation légère (Lot 8, tranche 1) : un événement par tour chat.send
 * terminé. L4 — `errorMessage` porte le POURQUOI de l'échec sur `status:
 * "error"` (voir docs/protocol.md § S1) ; il reste `null` sur done/aborted.
 */
function recordChatSendUsage(
  id: string,
  params: Record<string, unknown>,
  providerId: string,
  model: string,
  status: UsageStatus,
  usage: Usage | null,
  modelUsed: string | null,
  errorMessage: string | null = null,
): void {
  recordUsageEvent({
    id,
    engine: "neutral",
    method: "chat.send",
    providerId,
    model,
    promptTokens: usage?.promptTokens ?? null,
    completionTokens: usage?.completionTokens ?? null,
    status,
    errorMessage,
    meta: params.meta,
    modelUsed,
    costUsd: usage?.costUsd ?? null,
    cachedTokens: usage?.cachedTokens ?? null,
  });
}

/**
 * Silence maximal toléré au milieu d'un flux SSE avant de considérer la
 * connexion morte. Généreux à dessein : un modèle local lent peut mettre une
 * minute à produire son premier octet, et un faux positif coûterait un tour
 * perdu. Ce qu'on veut couper, c'est le silence ÉTERNEL.
 */
const SSE_INACTIVITE_MS = 3 * 60 * 1000;

const SSE_INACTIVITE_MESSAGE =
  "flux interrompu : plus aucune donnée reçue depuis 3 minutes (connexion perdue ou service arrêté)";

export async function handleChatSend(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const providerId = params.providerId;
  const model = params.model;
  const messages = params.messages;

  if (!isNonEmptyString(providerId)) {
    emitter.error(id, "params.providerId manquant ou invalide");
    return;
  }
  const provider = providers.get(providerId);
  if (!provider) {
    emitter.error(id, `fournisseur inconnu: ${providerId}`);
    return;
  }
  if (!isNonEmptyString(model)) {
    emitter.error(id, "params.model manquant ou invalide");
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    emitter.error(id, "params.messages doit être un tableau non vide");
    return;
  }
  for (const m of messages) {
    if (!isPlainObject(m) || !isNonEmptyString(m.role) || !("content" in m)) {
      emitter.error(id, "chaque message doit avoir role et content");
      return;
    }
  }

  const attachmentsValidation = validateAttachments(params.attachments);
  if (!attachmentsValidation.ok) {
    emitter.error(id, attachmentsValidation.message);
    return;
  }
  let sendMessages: unknown[] = messages;
  if (attachmentsValidation.attachments.length > 0) {
    const lastUserIdx = findLastUserMessageIndex(messages);
    if (lastUserIdx === -1) {
      emitter.error(id, "aucun message utilisateur pour porter les pièces jointes");
      return;
    }
    sendMessages = messages.map((m, i) => {
      if (i !== lastUserIdx || !isPlainObject(m)) {
        return m;
      }
      return { ...m, content: buildOpenAiAttachmentContent(m.content, attachmentsValidation.attachments) };
    });
  }

  const options = isPlainObject(params.options) ? params.options : {};
  const body: Record<string, unknown> = {
    model,
    messages: sendMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (isFiniteNumber(options.temperature)) {
    body.temperature = options.temperature;
  }
  if (isFiniteNumber(options.maxTokens)) {
    body.max_tokens = options.maxTokens;
  }
  // R0 — réglages de routage OpenRouter du provider (opt-in : un provider sans
  // ces champs produit un body strictement identique à avant).
  if (provider.fallbackModels?.length) {
    // modèle demandé en tête, secours ensuite, sans doublon
    body.models = [model, ...provider.fallbackModels.filter((m) => m !== model)];
  }
  if (provider.priceSort) {
    body.provider = { sort: "price" };
  }
  if (provider.usageAccounting) {
    body.usage = { include: true };
  }
  // R6-A — tour DÉBORDÉ (meta.routeDebord) : le plafond mensuel de débord se
  // compte sur `usage.cost` (voir usageStats.ts, autoDebordCostUsdThisMonth).
  // La comptabilité d'usage est donc FORCÉE, même si le provider n'a pas coché
  // usageAccounting : le comptage du plafond ne doit jamais dépendre d'une
  // case à cocher.
  if (isPlainObject(params.meta) && params.meta.routeDebord === true) {
    body.usage = { include: true };
  }

  const controller = new AbortController();
  inFlight.set(id, controller);

  let finishReason: string | null = null;
  let usage: Usage | null = null;
  /** R0 — slug du modèle réellement servi (dernier champ `model` vu dans le flux SSE). */
  let modelUsed: string | null = null;

  function dispatchEvent(raw: string): "continue" | "done" {
    if (raw.trim() === "[DONE]") {
      return "done";
    }
    if (raw.trim().length === 0) {
      return "continue";
    }
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error(`SSE malformé (JSON invalide): ${raw.slice(0, 200)}`);
    }
    if (!isPlainObject(obj)) {
      return "continue";
    }
    if (isNonEmptyString(obj.model)) {
      modelUsed = obj.model;
    }
    const u = extractUsage(obj);
    if (u) {
      usage = u;
    }
    const choices = obj.choices;
    if (Array.isArray(choices) && choices.length > 0 && isPlainObject(choices[0])) {
      const choice = choices[0];
      const delta = choice.delta;
      if (isPlainObject(delta) && typeof delta.content === "string" && delta.content.length > 0) {
        emitter.chunk(id, { delta: delta.content });
      }
      if (isNonEmptyString(choice.finish_reason)) {
        finishReason = choice.finish_reason;
      }
    }
    return "continue";
  }

  try {
    const res = await fetch(joinUrl(provider.baseUrl, "chat/completions"), {
      method: "POST",
      headers: buildHeaders(provider, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await readBoundedBody(res);
      const message = `HTTP ${res.status} ${res.statusText}: ${errBody}`;
      recordChatSendUsage(id, params, providerId, model, "error", null, modelUsed, message);
      emitter.error(id, message);
      return;
    }
    if (!res.body) {
      recordChatSendUsage(id, params, providerId, model, "error", null, modelUsed, "réponse HTTP sans corps");
      emitter.error(id, "réponse HTTP sans corps");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    let streamDone = false;

    function flushEvent(): boolean {
      if (dataLines.length === 0) {
        return false;
      }
      const raw = dataLines.join("\n");
      dataLines = [];
      return dispatchEvent(raw) === "done";
    }

    readLoop: while (!streamDone) {
      // Garde-fou d'INACTIVITÉ. `reader.read()` n'a aucune échéance propre :
      // une connexion à moitié morte (Wi-Fi qui bascule, conteneur Ollama
      // arrêté en plein flux) la laisse suspendue indéfiniment. Le tour restait
      // alors « en cours » pour toujours, son entrée `inFlight` retenue, et
      // toute la file de la conversation bloquée — invisible si l'utilisateur
      // a quitté l'écran. Le moteur Claude, lui, a ses garde-fous depuis
      // toujours ; celui-ci met le moteur neutre au même niveau.
      //
      // C'est bien de l'INACTIVITÉ qu'on borne, pas la durée totale : une
      // longue génération qui débite régulièrement n'est jamais interrompue.
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, rejeter) => {
          const minuteur = setTimeout(() => {
            rejeter(new Error(SSE_INACTIVITE_MESSAGE));
          }, SSE_INACTIVITE_MS);
          // `unref` : ce minuteur ne doit jamais retenir le process à lui seul.
          minuteur.unref?.();
        }),
      ]);
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) {
          line = line.slice(0, -1);
        }
        if (line.length === 0) {
          if (flushEvent()) {
            streamDone = true;
            break readLoop;
          }
          continue;
        }
        if (line.startsWith("data:")) {
          let content = line.slice(5);
          if (content.startsWith(" ")) {
            content = content.slice(1);
          }
          dataLines.push(content);
        }
        // autres champs SSE (event:, id:, retry:, commentaires ':') ignorés.
      }
    }

    if (!streamDone) {
      // Fin de flux sans retour à la ligne final : traiter le reste du buffer.
      let line = buffer;
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.startsWith("data:")) {
        let content = line.slice(5);
        if (content.startsWith(" ")) {
          content = content.slice(1);
        }
        dataLines.push(content);
      }
      flushEvent();
    }

    recordChatSendUsage(id, params, providerId, model, "done", usage, modelUsed);
    emitter.done(id, { finishReason, usage, modelUsed });
  } catch (err) {
    if (controller.signal.aborted) {
      recordChatSendUsage(id, params, providerId, model, "aborted", usage, modelUsed);
      emitter.done(id, { finishReason: "aborted", usage: null, modelUsed });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      recordChatSendUsage(id, params, providerId, model, "error", usage, modelUsed, message);
      emitter.error(id, message);
    }
  } finally {
    inFlight.delete(id);
  }
}

// ---------------------------------------------------------------------------
// usage.openrouter
// ---------------------------------------------------------------------------

export async function handleUsageOpenrouter(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const providerId = params.providerId;
  if (!isNonEmptyString(providerId)) {
    emitter.error(id, "params.providerId manquant ou invalide");
    return;
  }
  const provider = providers.get(providerId);
  if (!provider) {
    emitter.error(id, `fournisseur inconnu: ${providerId}`);
    return;
  }
  if (!isNonEmptyString(provider.apiKey)) {
    emitter.error(id, `clé API manquante pour ${providerId}`);
    return;
  }

  try {
    const res = await fetch(joinUrl(provider.baseUrl, "credits"), {
      method: "GET",
      headers: buildHeaders(provider),
    });
    if (!res.ok) {
      const body = await readBoundedBody(res);
      emitter.error(id, `HTTP ${res.status} ${res.statusText}: ${body}`);
      return;
    }
    const json = (await res.json()) as unknown;
    const data = isPlainObject(json) ? json.data : undefined;
    if (
      !isPlainObject(data) ||
      typeof data.total_credits !== "number" ||
      typeof data.total_usage !== "number"
    ) {
      emitter.error(id, "réponse inattendue de /credits (forme inconnue)");
      return;
    }
    const totalCredits = data.total_credits;
    const totalUsage = data.total_usage;
    emitter.done(id, { totalCredits, totalUsage, remaining: totalCredits - totalUsage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, `erreur réseau: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// chat.abort
// ---------------------------------------------------------------------------

export function handleChatAbort(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): void {
  const targetId = params.targetId;
  if (!isNonEmptyString(targetId)) {
    emitter.error(id, "params.targetId manquant ou invalide");
    return;
  }
  const controller = inFlight.get(targetId);
  if (!controller) {
    emitter.done(id, { aborted: false });
    return;
  }
  controller.abort();
  inFlight.delete(targetId);
  emitter.done(id, { aborted: true });
}

// ---------------------------------------------------------------------------
// ollama.* (gestion des modèles chargés) — API NATIVE Ollama, en dehors du
// dialecte OpenAI-compatible utilisé par providers.set/chat.send. Valide pour
// tout provider dont l'API native répond aux mêmes routes (/api/ps,
// /api/generate) : ce n'est pas réservé aux providers nommés "ollama".
// ---------------------------------------------------------------------------

/**
 * Dérive l'URL de base de l'API NATIVE (sans /v1) depuis le baseUrl
 * OpenAI-compatible déclaré via providers.set (ex. "http://localhost:11434/v1"
 * -> "http://localhost:11434"). Provider sans suffixe /v1 : baseUrl inchangée
 * (best effort, le fournisseur ne suit alors simplement pas la convention).
 * Exportée pour knowledge.ts (R5) : les embeddings passent par la même API
 * native (`POST /api/embed`).
 */
export function ollamaNativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

/** Chargement à froid : peut prendre plusieurs minutes (poids du modèle). */
const OLLAMA_LOAD_TIMEOUT_MS = 10 * 60 * 1000;

function resolveOllamaProvider(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Provider | undefined {
  const providerId = params.providerId;
  if (!isNonEmptyString(providerId)) {
    emitter.error(id, "params.providerId manquant ou invalide");
    return undefined;
  }
  const provider = providers.get(providerId);
  if (!provider) {
    emitter.error(id, `fournisseur inconnu: ${providerId}`);
    return undefined;
  }
  return provider;
}

interface OllamaPsModel {
  name: string;
  sizeVram: number | null;
  sizeTotal: number | null;
  expiresAt: string | null;
}

export async function handleOllamaPs(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const provider = resolveOllamaProvider(id, params, emitter);
  if (!provider) {
    return;
  }

  try {
    const res = await fetch(joinUrl(ollamaNativeBase(provider.baseUrl), "api/ps"), {
      method: "GET",
      headers: buildHeaders(provider),
    });
    if (!res.ok) {
      const body = await readBoundedBody(res);
      emitter.error(id, `HTTP ${res.status} ${res.statusText}: ${body}`);
      return;
    }
    const json = (await res.json()) as unknown;
    const rawModels = isPlainObject(json) && Array.isArray(json.models) ? json.models : [];
    const models: OllamaPsModel[] = rawModels
      .filter((m): m is Record<string, unknown> => isPlainObject(m) && isNonEmptyString(m.name))
      .map((m) => ({
        name: m.name as string,
        sizeVram: isFiniteNumber(m.size_vram) ? m.size_vram : null,
        sizeTotal: isFiniteNumber(m.size) ? m.size : null,
        expiresAt: isNonEmptyString(m.expires_at) ? m.expires_at : null,
      }));
    emitter.done(id, { models });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, `erreur réseau: ${message}`);
  }
}

/**
 * POST /api/generate avec un prompt vide : Ollama charge le modèle (s'il ne
 * l'est pas déjà) et répond une fois prêt — c'est la manière documentée de
 * forcer un (dé)chargement sans générer de texte. `keepAlive` absent = charge
 * (garde le comportement par défaut du serveur) ; `0` = décharge aussitôt la
 * réponse envoyée.
 */
async function ollamaGenerateNoop(
  provider: Provider,
  model: string,
  keepAlive?: 0,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const body: Record<string, unknown> = { model, prompt: "", stream: false };
  if (keepAlive !== undefined) {
    body.keep_alive = keepAlive;
  }
  try {
    const res = await fetch(joinUrl(ollamaNativeBase(provider.baseUrl), "api/generate"), {
      method: "POST",
      headers: buildHeaders(provider, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      // Timeout long : un chargement à froid peut prendre plusieurs minutes.
      // Node 22 fournit AbortSignal.timeout nativement.
      signal: AbortSignal.timeout(OLLAMA_LOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      const errBody = await readBoundedBody(res);
      return { ok: false, message: `HTTP ${res.status} ${res.statusText}: ${errBody}` };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `erreur réseau: ${message}` };
  }
}

export async function handleOllamaLoad(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const provider = resolveOllamaProvider(id, params, emitter);
  if (!provider) {
    return;
  }
  const model = params.model;
  if (!isNonEmptyString(model)) {
    emitter.error(id, "params.model manquant ou invalide");
    return;
  }

  const result = await ollamaGenerateNoop(provider, model);
  if (!result.ok) {
    emitter.error(id, result.message);
    return;
  }
  emitter.done(id, { loaded: true });
}

export async function handleOllamaUnload(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const provider = resolveOllamaProvider(id, params, emitter);
  if (!provider) {
    return;
  }
  const model = params.model;
  if (!isNonEmptyString(model)) {
    emitter.error(id, "params.model manquant ou invalide");
    return;
  }

  const result = await ollamaGenerateNoop(provider, model, 0);
  if (!result.ok) {
    emitter.error(id, result.message);
    return;
  }
  emitter.done(id, { unloaded: true });
}
