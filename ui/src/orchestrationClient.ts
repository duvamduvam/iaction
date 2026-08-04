/*
 * Wrappers typés pour les méthodes `agents.*` / `orch.*` du sidecar (étude
 * docs/etude-orchestration.md, phase O1). Même style défensif que
 * sidecar.ts : chaque valeur reçue est validée champ par champ, les entrées
 * invalides sont omises silencieusement (sauf `invalid`, voir plus bas) —
 * un sidecar pas encore à jour ou un fichier YAML mal formé ne doit jamais
 * faire planter l'UI.
 *
 * Contrat (fourni par l'étude, développé en parallèle côté sidecar) :
 *   agents.list {cwd} → {agents: AgentInfo[]}
 *   agents.read {path, cwd} → {agent, raw}
 *   agents.write {cwd, scope, raw?|agent?} → {agent, path}
 *   agents.delete {cwd, path} → {deleted}
 *   orch.list {cwd} → {orchestrations: OrchestrationInfo[]}
 *   orch.read {path, cwd} → {orchestration, raw}
 *   orch.write {cwd, scope, raw?|orchestration?} → {orchestration, path}
 *   orch.delete {cwd, path} → {deleted}
 *
 * Les erreurs de validation reviennent comme un rejet de `request()` (event
 * `error` du protocole, voir sidecar.ts) avec un message français précis —
 * pas de champ `error` séparé à extraire ici, `await` suffit.
 */
import { request, type ClaudeUsage, type PermissionMode } from "./sidecar";

/* ---------- Agents ---------- */

/** R2 — `"auto"` : moteur/modèle résolus par le routeur à l'exécution (voir docs/protocol.md § R1/R2). */
export type AgentEngine = "claude" | "neutral" | "auto";
export type AgentScope = "project" | "global" | "claude-code";

/** Un agent tel que renvoyé par `agents.list`/`agents.read`. */
export interface AgentInfo {
  name: string;
  description: string;
  engine: AgentEngine;
  provider: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  instructions: string;
  /** `null` = palette complète (pas de restriction). */
  tools: string[] | null;
  mcp: boolean;
  knowledge: string[];
  maxTurns: number | null;
  scope: AgentScope;
  path: string;
  /** Vrai pour les agents importés de `.claude/agents/` : non éditables ni supprimables. */
  readOnly: boolean;
  /** Présent si le fichier n'a pas pu être chargé/validé — le reste des champs est alors best-effort. */
  invalid?: string;
}

/** Valeurs éditables envoyées à `agents.write {agent}` (pas de scope/path/readOnly : déterminés par l'appel). */
export interface AgentWriteInput {
  name: string;
  description: string;
  engine: AgentEngine;
  provider: string | null;
  model: string | null;
  permissionMode: PermissionMode;
  instructions: string;
  tools: string[] | null;
  mcp: boolean;
  knowledge: string[];
  maxTurns: number | null;
}

export interface AgentWriteResult {
  agent: AgentInfo;
  path: string;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function toAgentEngine(value: unknown): AgentEngine {
  return value === "neutral" || value === "auto" ? value : "claude";
}

function toPermissionMode(value: unknown): PermissionMode {
  return value === "acceptEdits" || value === "plan" || value === "bypassPermissions" ? value : "default";
}

function toAgentScope(value: unknown): AgentScope {
  return value === "global" || value === "claude-code" ? value : "project";
}

function toAgentInfo(value: unknown): AgentInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name) return null;
  const info: AgentInfo = {
    name: v.name,
    description: typeof v.description === "string" ? v.description : "",
    engine: toAgentEngine(v.engine),
    provider: typeof v.provider === "string" ? v.provider : null,
    model: typeof v.model === "string" ? v.model : null,
    permissionMode: toPermissionMode(v.permissionMode),
    instructions: typeof v.instructions === "string" ? v.instructions : "",
    tools: Array.isArray(v.tools) ? toStringArray(v.tools) : null,
    mcp: v.mcp === true,
    knowledge: toStringArray(v.knowledge),
    maxTurns: typeof v.maxTurns === "number" && Number.isFinite(v.maxTurns) ? v.maxTurns : null,
    scope: toAgentScope(v.scope),
    path: typeof v.path === "string" ? v.path : "",
    readOnly: v.readOnly === true,
  };
  if (typeof v.invalid === "string" && v.invalid) info.invalid = v.invalid;
  return info;
}

/** Liste les agents visibles dans un contexte (`cwd: null` = global uniquement). */
export async function agentsList(cwd: string | null): Promise<AgentInfo[]> {
  const { done } = request("agents.list", { cwd });
  const data = await done;
  if (!Array.isArray(data.agents)) return [];
  const out: AgentInfo[] = [];
  for (const raw of data.agents) {
    const info = toAgentInfo(raw);
    if (info) out.push(info);
  }
  return out;
}

export interface AgentReadResult {
  agent: AgentInfo;
  raw: string;
}

/** Lit un agent (source de vérité disque) : `agent` décodé + `raw` (texte YAML brut, onglet YAML). */
export async function agentsRead(path: string, cwd: string | null): Promise<AgentReadResult> {
  const { done } = request("agents.read", { path, cwd });
  const data = await done;
  const agent = toAgentInfo(data.agent);
  if (!agent) throw new Error("Réponse agents.read invalide : agent manquant.");
  return { agent, raw: typeof data.raw === "string" ? data.raw : "" };
}

/**
 * Écrit un agent — exactement un de `raw` (onglet YAML brut) ou `agent`
 * (onglet Formulaire). Le nom (+ portée) détermine le fichier cible : il n'y
 * a pas de renommage/déplacement via cette méthode (voir OrchestrationPage,
 * qui verrouille ces champs en édition pour éviter d'orphaniser l'ancien
 * fichier).
 */
export async function agentsWrite(
  cwd: string | null,
  scope: "project" | "global",
  body: { raw: string } | { agent: AgentWriteInput },
): Promise<AgentWriteResult> {
  const payload: Record<string, unknown> = { cwd, scope };
  if ("raw" in body) payload.raw = body.raw;
  else payload.agent = body.agent;
  const { done } = request("agents.write", payload);
  const data = await done;
  const agent = toAgentInfo(data.agent);
  if (!agent) throw new Error("Réponse agents.write invalide : agent manquant.");
  return { agent, path: typeof data.path === "string" ? data.path : "" };
}

export async function agentsDelete(cwd: string | null, path: string): Promise<boolean> {
  const { done } = request("agents.delete", { cwd, path });
  const data = await done;
  return data.deleted === true;
}

/* ---------- Orchestrations ---------- */

export type OrchestrationScope = "project" | "global";

export interface OrchestrationInputField {
  name: string;
  label: string;
  /** Valeur par défaut si non fourni au lancement (chaîne vide = optionnel) ; null = requis. */
  default: string | null;
}

export interface OrchestrationStep {
  id: string;
  agent: string;
  task: string;
  needs: string[];
}

export interface OrchestrationLimits {
  maxParallel: number;
  maxDurationMin: number;
}

export interface OrchestrationInfo {
  name: string;
  description: string;
  inputs: OrchestrationInputField[];
  steps: OrchestrationStep[];
  limits: OrchestrationLimits;
  scope: OrchestrationScope;
  path: string;
  invalid?: string;
}

/** Valeurs éditables envoyées à `orch.write {orchestration}`. */
export interface OrchestrationWriteInput {
  name: string;
  description: string;
  inputs: OrchestrationInputField[];
  steps: OrchestrationStep[];
  limits: OrchestrationLimits;
}

export interface OrchestrationWriteResult {
  orchestration: OrchestrationInfo;
  path: string;
}

const DEFAULT_LIMITS: OrchestrationLimits = { maxParallel: 2, maxDurationMin: 30 };

function toOrchestrationInputs(value: unknown): OrchestrationInputField[] {
  if (!Array.isArray(value)) return [];
  const out: OrchestrationInputField[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.name === "string" && r.name && typeof r.label === "string") {
      out.push({ name: r.name, label: r.label, default: typeof r.default === "string" ? r.default : null });
    }
  }
  return out;
}

function toOrchestrationSteps(value: unknown): OrchestrationStep[] {
  if (!Array.isArray(value)) return [];
  const out: OrchestrationStep[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id === "string" && r.id && typeof r.agent === "string" && typeof r.task === "string") {
      out.push({ id: r.id, agent: r.agent, task: r.task, needs: toStringArray(r.needs) });
    }
  }
  return out;
}

function toOrchestrationLimits(value: unknown): OrchestrationLimits {
  if (typeof value !== "object" || value === null) return DEFAULT_LIMITS;
  const r = value as Record<string, unknown>;
  return {
    maxParallel:
      typeof r.maxParallel === "number" && Number.isFinite(r.maxParallel) ? r.maxParallel : DEFAULT_LIMITS.maxParallel,
    maxDurationMin:
      typeof r.maxDurationMin === "number" && Number.isFinite(r.maxDurationMin)
        ? r.maxDurationMin
        : DEFAULT_LIMITS.maxDurationMin,
  };
}

function toOrchestrationScope(value: unknown): OrchestrationScope {
  return value === "global" ? "global" : "project";
}

function toOrchestrationInfo(value: unknown): OrchestrationInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name) return null;
  const info: OrchestrationInfo = {
    name: v.name,
    description: typeof v.description === "string" ? v.description : "",
    inputs: toOrchestrationInputs(v.inputs),
    steps: toOrchestrationSteps(v.steps),
    limits: toOrchestrationLimits(v.limits),
    scope: toOrchestrationScope(v.scope),
    path: typeof v.path === "string" ? v.path : "",
  };
  if (typeof v.invalid === "string" && v.invalid) info.invalid = v.invalid;
  return info;
}

export async function orchList(cwd: string | null): Promise<OrchestrationInfo[]> {
  const { done } = request("orch.list", { cwd });
  const data = await done;
  if (!Array.isArray(data.orchestrations)) return [];
  const out: OrchestrationInfo[] = [];
  for (const raw of data.orchestrations) {
    const info = toOrchestrationInfo(raw);
    if (info) out.push(info);
  }
  return out;
}

export interface OrchestrationReadResult {
  orchestration: OrchestrationInfo;
  raw: string;
}

export async function orchRead(path: string, cwd: string | null): Promise<OrchestrationReadResult> {
  const { done } = request("orch.read", { path, cwd });
  const data = await done;
  const orchestration = toOrchestrationInfo(data.orchestration);
  if (!orchestration) throw new Error("Réponse orch.read invalide : orchestration manquante.");
  return { orchestration, raw: typeof data.raw === "string" ? data.raw : "" };
}

export async function orchWrite(
  cwd: string | null,
  scope: OrchestrationScope,
  body: { raw: string } | { orchestration: OrchestrationWriteInput },
): Promise<OrchestrationWriteResult> {
  const payload: Record<string, unknown> = { cwd, scope };
  if ("raw" in body) payload.raw = body.raw;
  else payload.orchestration = body.orchestration;
  const { done } = request("orch.write", payload);
  const data = await done;
  const orchestration = toOrchestrationInfo(data.orchestration);
  if (!orchestration) throw new Error("Réponse orch.write invalide : orchestration manquante.");
  return { orchestration, path: typeof data.path === "string" ? data.path : "" };
}

export async function orchDelete(cwd: string | null, path: string): Promise<boolean> {
  const { done } = request("orch.delete", { cwd, path });
  const data = await done;
  return data.deleted === true;
}

/* ---------- Exécutions (orch.run / orch.permission / orch.abort, phase O3) ---------- */

/** Une étape telle qu'annoncée par le chunk `run_started` (voir docs/etude-orchestration.md § 6).
 * Agent `engine: auto` : la cible n'est pas connue au lancement — `engine: "auto"`, `model: null`
 * ici, la cible résolue arrive dans le `step_started` de l'étape. */
export interface OrchRunStepInfo {
  stepId: string;
  agent: string;
  engine: AgentEngine;
  model: string | null;
}

/**
 * Chunk moteur relayé tel quel par `step_chunk.chunk` — mêmes `kind` que
 * `claude.start`/`neutral.start` (voir sidecar.ts, `ClaudeStartCallbacks`),
 * mais pas de callbacks ici : un seul type discriminé, consommé par
 * `OrchestrationPage` au fil de l'eau.
 */
export type EngineStepChunk =
  | { kind: "init"; sessionId: string | null; model: string }
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | { kind: "tool_use"; toolUseId: string; toolName: string; toolInput: unknown }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; summary: string }
  | { kind: "permission_request"; permissionId: string; toolName: string; toolInput: unknown };

/** Chunk `orch.run` streamé (un seul `kind` reconnu par appel — voir `toOrchRunChunk`). */
export type OrchRunChunk =
  | { kind: "run_started"; steps: OrchRunStepInfo[] }
  /** `engine`/`model` : cible effective résolue au démarrage de l'étape (routeur pour un agent
   * `engine: auto`) — `engine: null` si le sidecar ne l'annonce pas (version antérieure). */
  | { kind: "step_started"; stepId: string; engine: AgentEngine | null; model: string | null }
  | { kind: "step_chunk"; stepId: string; chunk: EngineStepChunk }
  | { kind: "step_done"; stepId: string; output: string | null; usage: ClaudeUsage | null }
  | { kind: "step_failed"; stepId: string; message: string }
  | { kind: "step_skipped"; stepId: string; reason: string };

export type OrchRunStatus = "success" | "partial" | "failed" | "aborted";

/** Statut final d'une étape, tel que renvoyé dans `done.steps` (texte non conservé — voir OrchestrationPage). */
export interface OrchRunDoneStep {
  status: string;
  output?: string;
  message?: string;
}

export interface OrchRunDoneData {
  status: OrchRunStatus;
  steps: Record<string, OrchRunDoneStep>;
}

function toOrchRunStepInfo(value: unknown): OrchRunStepInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.stepId !== "string" || !v.stepId) return null;
  return {
    stepId: v.stepId,
    agent: typeof v.agent === "string" ? v.agent : "",
    engine: toAgentEngine(v.engine),
    model: typeof v.model === "string" ? v.model : null,
  };
}

function toClaudeUsageLike(value: unknown): ClaudeUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.inputTokens === "number" && typeof v.outputTokens === "number") {
    return {
      inputTokens: v.inputTokens,
      outputTokens: v.outputTokens,
      cacheReadInputTokens: typeof v.cacheReadInputTokens === "number" ? v.cacheReadInputTokens : undefined,
    };
  }
  return null;
}

type EngineStepChunkParser = (v: Record<string, unknown>, s: (key: string) => string) => EngineStepChunk | null;

// Une entrée par `kind` reconnu — même patron que CLAUDE_CHUNK_HANDLERS (sidecar.ts) : un
// `kind` absent de cette table est un chunk moteur inconnu, ignoré silencieusement.
const ENGINE_STEP_CHUNK_PARSERS: Record<string, EngineStepChunkParser> = {
  init: (v, s) => ({ kind: "init", sessionId: typeof v.sessionId === "string" ? v.sessionId : null, model: s("model") }),
  text: (_v, s) => (s("delta") ? { kind: "text", delta: s("delta") } : null),
  thinking: (_v, s) => (s("delta") ? { kind: "thinking", delta: s("delta") } : null),
  tool_use: (v, s) => ({ kind: "tool_use", toolUseId: s("toolUseId"), toolName: s("toolName") || "outil", toolInput: v.toolInput }),
  tool_result: (v, s) => ({ kind: "tool_result", toolUseId: s("toolUseId"), isError: v.isError === true, summary: s("summary") }),
  permission_request: (v, s) => ({
    kind: "permission_request",
    permissionId: s("permissionId"),
    toolName: s("toolName") || "outil",
    toolInput: v.toolInput,
  }),
};

/** Chunk moteur (imbriqué dans `step_chunk`) : `kind` inconnu → `null`, ignoré silencieusement. */
function toEngineStepChunk(value: unknown): EngineStepChunk | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const kind = typeof v.kind === "string" ? v.kind : "";
  const s = (key: string): string => (typeof v[key] === "string" ? (v[key] as string) : "");
  return ENGINE_STEP_CHUNK_PARSERS[kind]?.(v, s) ?? null;
}

type OrchRunChunkParser = (data: Record<string, unknown>, stepId: string) => OrchRunChunk | null;

// Une entrée par `kind` reconnu — un `kind` absent de cette table (chunk protocolaire
// inconnu, ex. sidecar plus récent que l'UI) est ignoré silencieusement.
const ORCH_RUN_CHUNK_PARSERS: Record<string, OrchRunChunkParser> = {
  run_started: (data) => {
    const steps = Array.isArray(data.steps)
      ? data.steps.map(toOrchRunStepInfo).filter((s): s is OrchRunStepInfo => s !== null)
      : [];
    return { kind: "run_started", steps };
  },
  step_started: (data, stepId) =>
    stepId
      ? {
          kind: "step_started",
          stepId,
          engine: typeof data.engine === "string" ? toAgentEngine(data.engine) : null,
          model: typeof data.model === "string" ? data.model : null,
        }
      : null,
  step_chunk: (data, stepId) => {
    if (!stepId) return null;
    const chunk = toEngineStepChunk(data.chunk);
    return chunk ? { kind: "step_chunk", stepId, chunk } : null;
  },
  step_done: (data, stepId) =>
    stepId
      ? {
          kind: "step_done",
          stepId,
          output: typeof data.output === "string" ? data.output : null,
          usage: toClaudeUsageLike(data.usage),
        }
      : null,
  step_failed: (data, stepId) =>
    stepId
      ? { kind: "step_failed", stepId, message: typeof data.message === "string" ? data.message : "Erreur inconnue" }
      : null,
  step_skipped: (data, stepId) =>
    stepId ? { kind: "step_skipped", stepId, reason: typeof data.reason === "string" ? data.reason : "" } : null,
};

/** Chunk `orch.run` top-niveau : `kind` inconnu ou champs requis absents → `null`, ignoré silencieusement. */
function toOrchRunChunk(data: Record<string, unknown>): OrchRunChunk | null {
  const kind = typeof data.kind === "string" ? data.kind : "";
  const stepId = typeof data.stepId === "string" ? data.stepId : "";
  return ORCH_RUN_CHUNK_PARSERS[kind]?.(data, stepId) ?? null;
}

function toOrchRunStatus(value: unknown): OrchRunStatus {
  return value === "success" || value === "partial" || value === "aborted" ? value : "failed";
}

function toOrchRunDoneData(data: Record<string, unknown>): OrchRunDoneData {
  const steps: Record<string, OrchRunDoneStep> = {};
  if (data.steps && typeof data.steps === "object") {
    for (const [stepId, raw] of Object.entries(data.steps as Record<string, unknown>)) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      steps[stepId] = {
        status: typeof r.status === "string" ? r.status : "failed",
        output: typeof r.output === "string" ? r.output : undefined,
        message: typeof r.message === "string" ? r.message : undefined,
      };
    }
  }
  return { status: toOrchRunStatus(data.status), steps };
}

/**
 * Lance une orchestration (`orch.run`), streamé. `onChunk` reçoit chaque
 * chunk déjà décodé (`OrchRunChunk` — parsing défensif, un chunk non
 * reconnu est simplement ignoré, jamais une exception). Le `runId` renvoyé
 * est l'`id` de corrélation de la requête (aussi le `targetId` attendu par
 * `orchPermission`/`orchAbort`) ; `done` se résout avec le statut final et
 * les statuts par étape (SANS le texte — voir OrchestrationPage, qui garde
 * le flux en mémoire au fil des chunks).
 */
export function orchRun(
  cwd: string,
  name: string,
  inputs: Record<string, string> | undefined,
  onChunk: (chunk: OrchRunChunk) => void,
): { runId: string; done: Promise<OrchRunDoneData> } {
  const { id, done } = request(
    "orch.run",
    { cwd, name, inputs: inputs ?? undefined },
    {
      onChunk: (data) => {
        const parsed = toOrchRunChunk(data);
        if (parsed) onChunk(parsed);
      },
    },
  );
  return { runId: id, done: done.then(toOrchRunDoneData) };
}

/** Répond à un `permission_request` en attente sur le run `targetId`, étape `stepId`. */
export async function orchPermission(
  targetId: string,
  stepId: string,
  permissionId: string,
  decision: "allow" | "deny",
  updatedInput?: unknown,
): Promise<boolean> {
  const payload: Record<string, unknown> = { targetId, stepId, permissionId, decision };
  if (updatedInput !== undefined) payload.updatedInput = updatedInput;
  const { done } = request("orch.permission", payload);
  const data = await done;
  return data.applied === true;
}

/** Interrompt le run `targetId` (étapes en cours et à venir annulées). */
export async function orchAbort(targetId: string): Promise<boolean> {
  const { done } = request("orch.abort", { targetId });
  const data = await done;
  return data.aborted === true;
}
