/**
 * Orchestrateur — Lot O1 : CRUD des agents et orchestrations déclarés en YAML
 * (portée projet et globale), avec import lecture seule des agents Claude
 * Code. Lot O3 (plus bas dans ce fichier) : exécution d'une orchestration
 * (`orch.run`/`orch.permission`/`orch.abort`) en réutilisant les moteurs
 * `claude.ts`/`neutralAgent.ts` comme briques internes.
 *
 * Voir docs/etude-orchestration.md (§4 formats de fichiers, §6 exécution) et
 * docs/protocol.md (sections « Méthodes O1 » et « Méthodes O3 »).
 *
 * Répertoires :
 * - projet   : `<cwd>/.iaction/agents/*.yaml` et `<cwd>/.iaction/orchestrations/*.yaml`
 * - global   : `${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/agents/*.yaml` (idem orchestrations/)
 * - import   : `<cwd>/.claude/agents/*.md` (lecture seule, frontmatter YAML + corps markdown)
 *
 * Un fichier YAML illisible/invalide n'est jamais omis d'une liste : il est
 * renvoyé avec un champ `invalid` (message lisible) pour que l'UI l'affiche
 * au lieu de le faire disparaître silencieusement.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { EngineEmitter } from "./engine.js";
import { handleClaudeAbort, handleClaudePermission, handleClaudeStart } from "./claude.js";
import { handleNeutralAbort, handleNeutralPermission, handleNeutralStart } from "./neutralAgent.js";
import { resolveRoute, type RouteTier } from "./router.js";
import { globalConfigRoot, projectDir } from "./appPaths.js";

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Écriture atomique : fichier temporaire dans le même répertoire, puis rename. Crée les parents. */
async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, absPath);
}

function baseNameNoExt(filePath: string): string {
  return path.basename(filePath).replace(/\.[^./]+$/, "");
}

/** `candidate` (fichier ou dossier) est-il `dir` lui-même ou un de ses descendants ? */
function isWithinDir(candidate: string, dir: string): boolean {
  const c = path.resolve(candidate);
  const d = path.resolve(dir);
  return c === d || c.startsWith(d + path.sep);
}

// ---------------------------------------------------------------------------
// Répertoires (source de vérité : contrat figé dans docs/etude-orchestration.md §4)
// ---------------------------------------------------------------------------

type FileKind = "agents" | "orchestrations";

// `projectDir` et `globalConfigRoot` viennent d'appPaths.ts (voir l'import) :
// ces répertoires sont relus à chaque appel, jamais mis en cache — les tests
// injectent XDG_CONFIG_HOME au spawn du sidecar.


function globalDir(kind: FileKind): string {
  return path.join(globalConfigRoot(), kind);
}

function claudeAgentsDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".claude", "agents");
}

async function listFilesWithExt(dir: string, ext: string): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => path.join(dir, e.name))
    .sort();
}

// ---------------------------------------------------------------------------
// Validation — noyau commun
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-z0-9-]{1,64}$/;

type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

function fail<T>(message: string): ValidationResult<T> {
  return { ok: false, message };
}

// ---------------------------------------------------------------------------
// Agent — types + normalisation/validation
// ---------------------------------------------------------------------------

/** R2 — `"auto"` : moteur/modèle résolus par le routeur au démarrage de chaque étape, sur la tâche RENDUE (voir router.ts, `resolveRoute`). */
export type AgentEngine = "claude" | "neutral" | "auto";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface AgentNormalized {
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

export type AgentScope = "project" | "global" | "claude-code";

export interface AgentListEntry extends AgentNormalized {
  scope: AgentScope;
  path: string;
  readOnly: boolean;
  invalid?: string;
}

/** Défauts documentés au contrat : engine claude, provider/model null, permissionMode default,
 * instructions "", tools null (palette complète), mcp true, knowledge [], maxTurns null. */
function normalizeAgent(raw: unknown): ValidationResult<AgentNormalized> {
  if (!isPlainObject(raw)) {
    return fail("le contenu de l'agent doit être un objet YAML (mapping clé/valeur)");
  }

  const name = raw.name;
  if (!isNonEmptyString(name) || !NAME_RE.test(name)) {
    return fail(`champ 'name' invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(name)}`);
  }

  let description = "";
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== "string") {
      return fail("champ 'description' doit être une chaîne");
    }
    description = raw.description;
  }

  let engine: AgentEngine = "claude";
  if (raw.engine !== undefined && raw.engine !== null) {
    if (raw.engine !== "claude" && raw.engine !== "neutral" && raw.engine !== "auto") {
      return fail(
        `champ 'engine' invalide (attendu 'claude', 'neutral' ou 'auto'), reçu: ${JSON.stringify(raw.engine)}`,
      );
    }
    engine = raw.engine;
  }

  let provider: string | null = null;
  if (raw.provider !== undefined && raw.provider !== null) {
    if (!isNonEmptyString(raw.provider)) {
      return fail("champ 'provider' doit être une chaîne non vide ou null");
    }
    provider = raw.provider;
  }
  if (engine === "neutral" && provider === null) {
    return fail("engine 'neutral' requiert un champ 'provider' non vide (agent: " + name + ")");
  }

  let model: string | null = null;
  if (raw.model !== undefined && raw.model !== null) {
    if (!isNonEmptyString(raw.model)) {
      return fail("champ 'model' doit être une chaîne non vide ou null");
    }
    model = raw.model;
  }
  // R2 — engine 'auto' : le modèle est choisi par le routeur, le champ ne peut
  // être qu'omis ou "auto" (normalisé en null, décision spec R2 §3).
  if (engine === "auto") {
    if (model !== null && model !== "auto") {
      return fail(`engine 'auto' : champ 'model' doit être omis ou "auto" (agent: ${name})`);
    }
    model = null;
  }

  let permissionMode: PermissionMode = "default";
  if (raw.permissionMode !== undefined && raw.permissionMode !== null) {
    if (
      raw.permissionMode !== "default" &&
      raw.permissionMode !== "acceptEdits" &&
      raw.permissionMode !== "plan" &&
      raw.permissionMode !== "bypassPermissions"
    ) {
      return fail(
        `champ 'permissionMode' invalide (attendu default|acceptEdits|plan|bypassPermissions), reçu: ${JSON.stringify(raw.permissionMode)}`,
      );
    }
    permissionMode = raw.permissionMode;
  }
  if (permissionMode === "plan" && engine === "neutral") {
    return fail(`permissionMode 'plan' n'est pas autorisé avec engine 'neutral' (agent: ${name})`);
  }

  let instructions = "";
  if (raw.instructions !== undefined && raw.instructions !== null) {
    if (typeof raw.instructions !== "string") {
      return fail("champ 'instructions' doit être une chaîne");
    }
    instructions = raw.instructions;
  }

  let tools: string[] | null = null;
  if (raw.tools !== undefined && raw.tools !== null) {
    if (!Array.isArray(raw.tools) || !raw.tools.every((t) => typeof t === "string")) {
      return fail("champ 'tools' doit être une liste de chaînes, ou absent/null pour la palette complète");
    }
    tools = raw.tools as string[];
  }

  let mcp = true;
  if (raw.mcp !== undefined && raw.mcp !== null) {
    if (typeof raw.mcp !== "boolean") {
      return fail("champ 'mcp' doit être un booléen");
    }
    mcp = raw.mcp;
  }

  let knowledge: string[] = [];
  if (raw.knowledge !== undefined && raw.knowledge !== null) {
    if (!Array.isArray(raw.knowledge) || !raw.knowledge.every((k) => typeof k === "string")) {
      return fail("champ 'knowledge' doit être une liste de chaînes");
    }
    knowledge = raw.knowledge as string[];
  }

  let maxTurns: number | null = null;
  if (raw.maxTurns !== undefined && raw.maxTurns !== null) {
    if (typeof raw.maxTurns !== "number" || !Number.isInteger(raw.maxTurns) || raw.maxTurns < 1) {
      return fail("champ 'maxTurns' doit être un entier ≥ 1 (ou absent/null)");
    }
    maxTurns = raw.maxTurns;
  }

  return {
    ok: true,
    value: { name, description, engine, provider, model, permissionMode, instructions, tools, mcp, knowledge, maxTurns },
  };
}

function invalidAgentEntry(filePath: string, scope: AgentScope, message: string): AgentListEntry {
  return {
    name: baseNameNoExt(filePath),
    description: "",
    engine: "claude",
    provider: null,
    model: null,
    permissionMode: "default",
    instructions: "",
    tools: null,
    mcp: true,
    knowledge: [],
    maxTurns: null,
    scope,
    path: filePath,
    readOnly: scope === "claude-code",
    invalid: message,
  };
}

// ---------------------------------------------------------------------------
// Import .claude/agents/*.md — frontmatter YAML entre `---` + corps markdown
// ---------------------------------------------------------------------------

interface FrontmatterResult {
  frontmatter: Record<string, unknown> | null;
  body: string;
  error?: string;
}

/** Parseur maison simple : délimiteurs `---` en début de fichier, YAML entre les deux, corps après. */
function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: null, body: content, error: "frontmatter manquant (le fichier doit commencer par '---')" };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: null, body: content, error: "délimiteur de fermeture '---' du frontmatter introuvable" };
  }
  const fmText = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(fmText);
  } catch (err) {
    return { frontmatter: null, body, error: `frontmatter YAML invalide: ${errMessage(err)}` };
  }
  if (!isPlainObject(parsed)) {
    return { frontmatter: null, body, error: "frontmatter doit être un objet YAML (mapping clé/valeur)" };
  }
  return { frontmatter: parsed, body };
}

/** Le champ `tools` de Claude Code est soit une liste, soit une chaîne "Read, Write, Bash". */
function normalizeImportedTools(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const arr = value.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
    return arr.length > 0 ? arr : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const arr = value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    return arr.length > 0 ? arr : null;
  }
  return null;
}

function buildImportedAgent(filePath: string, frontmatter: Record<string, unknown>, body: string): AgentNormalized {
  const fallbackName = baseNameNoExt(filePath);
  const name = isNonEmptyString(frontmatter.name) ? frontmatter.name : fallbackName;
  const description = isNonEmptyString(frontmatter.description) ? frontmatter.description : "";
  const tools = normalizeImportedTools(frontmatter.tools);
  return {
    name,
    description,
    engine: "claude",
    provider: null,
    model: null,
    permissionMode: "default",
    instructions: body.trim(),
    tools,
    mcp: true,
    knowledge: [],
    maxTurns: null,
  };
}

async function loadImportedAgentEntry(filePath: string): Promise<AgentListEntry> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    return invalidAgentEntry(filePath, "claude-code", `lecture impossible: ${errMessage(err)}`);
  }
  const { frontmatter, body, error } = parseFrontmatter(content);
  if (error || !frontmatter) {
    return invalidAgentEntry(filePath, "claude-code", error ?? "frontmatter manquant");
  }
  return { ...buildImportedAgent(filePath, frontmatter, body), scope: "claude-code", path: filePath, readOnly: true };
}

// ---------------------------------------------------------------------------
// Agent — chargement d'un fichier .iaction/agents/*.yaml (projet ou global)
// ---------------------------------------------------------------------------

async function loadYamlAgentEntry(filePath: string, scope: "project" | "global"): Promise<AgentListEntry> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    return invalidAgentEntry(filePath, scope, `lecture impossible: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    return invalidAgentEntry(filePath, scope, `YAML invalide: ${errMessage(err)}`);
  }
  const result = normalizeAgent(parsed);
  if (!result.ok) {
    return invalidAgentEntry(filePath, scope, result.message);
  }
  return { ...result.value, scope, path: filePath, readOnly: false };
}

// ---------------------------------------------------------------------------
// agents.list
// ---------------------------------------------------------------------------

export async function handleAgentsList(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwdParam = params.cwd;
  const cwd = isNonEmptyString(cwdParam) ? cwdParam : null;

  const entries: AgentListEntry[] = [];

  if (cwd) {
    for (const f of await listFilesWithExt(projectDir(cwd, "agents"), ".yaml")) {
      entries.push(await loadYamlAgentEntry(f, "project"));
    }
  }

  for (const f of await listFilesWithExt(globalDir("agents"), ".yaml")) {
    entries.push(await loadYamlAgentEntry(f, "global"));
  }

  if (cwd) {
    for (const f of await listFilesWithExt(claudeAgentsDir(cwd), ".md")) {
      entries.push(await loadImportedAgentEntry(f));
    }
  }

  emitter.done(id, { agents: entries });
}

// ---------------------------------------------------------------------------
// agents.read
// ---------------------------------------------------------------------------

export async function handleAgentsRead(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const pathParam = params.path;
  if (!isNonEmptyString(pathParam)) {
    emitter.error(id, "params.path manquant ou invalide");
    return;
  }
  const cwdParam = params.cwd;
  const cwd = isNonEmptyString(cwdParam) ? cwdParam : null;

  const allowedDirs = [globalDir("agents")];
  if (cwd) {
    allowedDirs.push(projectDir(cwd, "agents"), claudeAgentsDir(cwd));
  }
  const resolved = path.resolve(pathParam);
  if (!allowedDirs.some((d) => isWithinDir(resolved, d))) {
    emitter.error(id, `chemin hors des répertoires d'agents reconnus: ${pathParam}`);
    return;
  }

  let raw: string;
  try {
    raw = await fsp.readFile(resolved, "utf8");
  } catch (err) {
    emitter.error(id, `lecture impossible: ${errMessage(err)}`);
    return;
  }

  if (resolved.endsWith(".md")) {
    const { frontmatter, body, error } = parseFrontmatter(raw);
    if (error || !frontmatter) {
      emitter.error(id, `frontmatter invalide (${path.basename(resolved)}): ${error ?? "manquant"}`);
      return;
    }
    emitter.done(id, { agent: buildImportedAgent(resolved, frontmatter, body), raw });
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    emitter.error(id, `YAML invalide (${path.basename(resolved)}): ${errMessage(err)}`);
    return;
  }
  const result = normalizeAgent(parsed);
  if (!result.ok) {
    emitter.error(id, `${result.message} (fichier: ${path.basename(resolved)})`);
    return;
  }
  emitter.done(id, { agent: result.value, raw });
}

// ---------------------------------------------------------------------------
// agents.write
// ---------------------------------------------------------------------------

export async function handleAgentsWrite(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const scopeParam = params.scope;
  if (scopeParam !== "project" && scopeParam !== "global") {
    emitter.error(id, "params.scope doit valoir 'project' ou 'global'");
    return;
  }

  const rawParam = params.raw;
  const agentParam = params.agent;
  const hasRaw = rawParam !== undefined && rawParam !== null;
  const hasAgent = agentParam !== undefined && agentParam !== null;
  if (hasRaw === hasAgent) {
    emitter.error(id, "params doit contenir exactement un de 'raw' ou 'agent' (ni les deux, ni aucun)");
    return;
  }

  const cwdParam = params.cwd;
  if (scopeParam === "project" && !isNonEmptyString(cwdParam)) {
    emitter.error(id, "params.cwd est requis pour scope 'project'");
    return;
  }

  let normalized: AgentNormalized;
  let contentToWrite: string;

  if (hasRaw) {
    if (typeof rawParam !== "string" || rawParam.trim().length === 0) {
      emitter.error(id, "params.raw doit être une chaîne YAML non vide");
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(rawParam);
    } catch (err) {
      emitter.error(id, `YAML invalide: ${errMessage(err)}`);
      return;
    }
    const result = normalizeAgent(parsed);
    if (!result.ok) {
      emitter.error(id, result.message);
      return;
    }
    normalized = result.value;
    contentToWrite = rawParam;
  } else {
    const result = normalizeAgent(agentParam);
    if (!result.ok) {
      emitter.error(id, result.message);
      return;
    }
    normalized = result.value;
    contentToWrite = stringifyYaml(normalized, { lineWidth: 0 });
  }

  const targetDir = scopeParam === "project" ? projectDir(cwdParam as string, "agents") : globalDir("agents");
  const targetPath = path.join(targetDir, `${normalized.name}.yaml`);

  try {
    await atomicWriteFile(targetPath, contentToWrite);
  } catch (err) {
    emitter.error(id, `écriture impossible: ${errMessage(err)}`);
    return;
  }

  emitter.done(id, { agent: normalized, path: targetPath });
}

// ---------------------------------------------------------------------------
// agents.delete — garde anti-traversée : jamais .claude/, uniquement
// .iaction/agents du cwd fourni, ou le dossier global.
// ---------------------------------------------------------------------------

export async function handleAgentsDelete(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const pathParam = params.path;
  if (!isNonEmptyString(pathParam)) {
    emitter.error(id, "params.path manquant ou invalide");
    return;
  }
  const cwdParam = params.cwd;
  const cwd = isNonEmptyString(cwdParam) ? cwdParam : null;

  const allowedDirs = [globalDir("agents")];
  if (cwd) {
    allowedDirs.push(projectDir(cwd, "agents"));
  }
  const resolved = path.resolve(pathParam);
  if (!allowedDirs.some((d) => isWithinDir(resolved, d))) {
    emitter.error(
      id,
      `suppression refusée : chemin hors de .iaction/agents (projet) ou du dossier global: ${pathParam}`,
    );
    return;
  }

  try {
    await fsp.unlink(resolved);
  } catch (err) {
    emitter.error(id, `suppression impossible: ${errMessage(err)}`);
    return;
  }
  emitter.done(id, { deleted: true });
}

// ---------------------------------------------------------------------------
// Orchestration — types + normalisation/validation
// ---------------------------------------------------------------------------

export interface OrchInput {
  name: string;
  label: string;
  /** Valeur utilisée quand l'input n'est pas fourni au lancement (chaîne vide
      permise — « optionnel ») ; null = input requis (comportement historique).
      Indispensable aux tâches planifiées : personne ne saisit d'inputs. */
  default: string | null;
}

export interface OrchStep {
  id: string;
  agent: string;
  task: string;
  needs: string[];
}

export interface OrchLimits {
  maxParallel: number;
  maxDurationMin: number;
}

export interface OrchestrationNormalized {
  name: string;
  description: string;
  inputs: OrchInput[];
  steps: OrchStep[];
  limits: OrchLimits;
}

export type OrchScope = "project" | "global";

export interface OrchListEntry extends OrchestrationNormalized {
  scope: OrchScope;
  path: string;
  readOnly: boolean;
  invalid?: string;
}

/** Parcours DFS (3 couleurs) du graphe de dépendances `needs` : renvoie le chemin du premier
 * cycle trouvé (liste d'ids, le dernier élément répétant le premier), ou null s'il n'y en a pas. */
function detectCycle(steps: OrchStep[]): string[] | null {
  const needsById = new Map(steps.map((s) => [s.id, s.needs]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function visit(node: string): string[] | null {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of needsById.get(node) ?? []) {
      const st = state.get(next);
      if (st === "visiting") {
        const idx = stack.indexOf(next);
        return [...stack.slice(idx), next];
      }
      if (st !== "done") {
        const found = visit(next);
        if (found) {
          return found;
        }
      }
    }
    stack.pop();
    state.set(node, "done");
    return null;
  }

  for (const s of steps) {
    if (state.get(s.id) !== "done") {
      const found = visit(s.id);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

/** Défauts documentés au contrat : inputs [], needs [], limits {maxParallel:2, maxDurationMin:30}. */
function normalizeOrchestration(raw: unknown): ValidationResult<OrchestrationNormalized> {
  if (!isPlainObject(raw)) {
    return fail("le contenu de l'orchestration doit être un objet YAML (mapping clé/valeur)");
  }

  const name = raw.name;
  if (!isNonEmptyString(name) || !NAME_RE.test(name)) {
    return fail(`champ 'name' invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(name)}`);
  }

  let description = "";
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== "string") {
      return fail("champ 'description' doit être une chaîne");
    }
    description = raw.description;
  }

  const inputs: OrchInput[] = [];
  if (raw.inputs !== undefined && raw.inputs !== null) {
    if (!Array.isArray(raw.inputs)) {
      return fail("champ 'inputs' doit être une liste");
    }
    for (let i = 0; i < raw.inputs.length; i++) {
      const entry = raw.inputs[i];
      if (!isPlainObject(entry) || !isNonEmptyString(entry.name)) {
        return fail(`inputs[${i}].name manquant ou invalide`);
      }
      const label = isNonEmptyString(entry.label) ? entry.label : entry.name;
      // `default` : chaîne (VIDE comprise — input optionnel) ; absent/null = requis.
      const def = typeof entry.default === "string" ? entry.default : null;
      inputs.push({ name: entry.name, label, default: def });
    }
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    return fail(`orchestration '${name}': champ 'steps' doit contenir au moins une étape`);
  }
  const steps: OrchStep[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.steps.length; i++) {
    const entry = raw.steps[i];
    if (!isPlainObject(entry)) {
      return fail(`steps[${i}] doit être un objet`);
    }
    const stepId = entry.id;
    if (!isNonEmptyString(stepId) || !NAME_RE.test(stepId)) {
      return fail(`steps[${i}].id invalide (attendu [a-z0-9-]{1,64}), reçu: ${JSON.stringify(stepId)}`);
    }
    if (seenIds.has(stepId)) {
      return fail(`id d'étape dupliqué: '${stepId}'`);
    }
    seenIds.add(stepId);
    if (!isNonEmptyString(entry.agent)) {
      return fail(`steps[${i}] (id: ${stepId}).agent manquant ou invalide`);
    }
    if (!isNonEmptyString(entry.task)) {
      return fail(`steps[${i}] (id: ${stepId}).task manquant ou vide`);
    }
    let needs: string[] = [];
    if (entry.needs !== undefined && entry.needs !== null) {
      if (!Array.isArray(entry.needs) || !entry.needs.every((n) => typeof n === "string")) {
        return fail(`steps[${i}] (id: ${stepId}).needs doit être une liste de chaînes`);
      }
      needs = entry.needs as string[];
    }
    steps.push({ id: stepId, agent: entry.agent, task: entry.task, needs });
  }

  for (const step of steps) {
    for (const dep of step.needs) {
      if (!seenIds.has(dep)) {
        return fail(`l'étape '${step.id}' référence une dépendance inconnue dans needs: '${dep}'`);
      }
    }
  }

  const cycle = detectCycle(steps);
  if (cycle) {
    return fail(`cycle détecté dans les dépendances (needs): ${cycle.join(" → ")}`);
  }

  let limits: OrchLimits = { maxParallel: 2, maxDurationMin: 30 };
  if (raw.limits !== undefined && raw.limits !== null) {
    if (!isPlainObject(raw.limits)) {
      return fail("champ 'limits' doit être un objet");
    }
    let maxParallel = 2;
    if (raw.limits.maxParallel !== undefined && raw.limits.maxParallel !== null) {
      if (
        typeof raw.limits.maxParallel !== "number" ||
        !Number.isInteger(raw.limits.maxParallel) ||
        raw.limits.maxParallel < 1
      ) {
        return fail("champ 'limits.maxParallel' doit être un entier ≥ 1");
      }
      maxParallel = raw.limits.maxParallel;
    }
    let maxDurationMin = 30;
    if (raw.limits.maxDurationMin !== undefined && raw.limits.maxDurationMin !== null) {
      if (
        typeof raw.limits.maxDurationMin !== "number" ||
        !Number.isInteger(raw.limits.maxDurationMin) ||
        raw.limits.maxDurationMin < 1
      ) {
        return fail("champ 'limits.maxDurationMin' doit être un entier ≥ 1");
      }
      maxDurationMin = raw.limits.maxDurationMin;
    }
    limits = { maxParallel, maxDurationMin };
  }

  return { ok: true, value: { name, description, inputs, steps, limits } };
}

function invalidOrchEntry(filePath: string, scope: OrchScope, message: string): OrchListEntry {
  return {
    name: baseNameNoExt(filePath),
    description: "",
    inputs: [],
    steps: [],
    limits: { maxParallel: 2, maxDurationMin: 30 },
    scope,
    path: filePath,
    readOnly: false,
    invalid: message,
  };
}

async function loadYamlOrchEntry(filePath: string, scope: OrchScope): Promise<OrchListEntry> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    return invalidOrchEntry(filePath, scope, `lecture impossible: ${errMessage(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (err) {
    return invalidOrchEntry(filePath, scope, `YAML invalide: ${errMessage(err)}`);
  }
  const result = normalizeOrchestration(parsed);
  if (!result.ok) {
    return invalidOrchEntry(filePath, scope, result.message);
  }
  return { ...result.value, scope, path: filePath, readOnly: false };
}

// ---------------------------------------------------------------------------
// orch.list
// ---------------------------------------------------------------------------

export async function handleOrchList(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwdParam = params.cwd;
  const cwd = isNonEmptyString(cwdParam) ? cwdParam : null;

  const entries: OrchListEntry[] = [];

  if (cwd) {
    for (const f of await listFilesWithExt(projectDir(cwd, "orchestrations"), ".yaml")) {
      entries.push(await loadYamlOrchEntry(f, "project"));
    }
  }

  for (const f of await listFilesWithExt(globalDir("orchestrations"), ".yaml")) {
    entries.push(await loadYamlOrchEntry(f, "global"));
  }

  emitter.done(id, { orchestrations: entries });
}

// ---------------------------------------------------------------------------
// orch.read
// ---------------------------------------------------------------------------

export async function handleOrchRead(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const pathParam = params.path;
  if (!isNonEmptyString(pathParam)) {
    emitter.error(id, "params.path manquant ou invalide");
    return;
  }
  const cwdParam = params.cwd;
  const cwd = isNonEmptyString(cwdParam) ? cwdParam : null;

  const allowedDirs = [globalDir("orchestrations")];
  if (cwd) {
    allowedDirs.push(projectDir(cwd, "orchestrations"));
  }
  const resolved = path.resolve(pathParam);
  if (!allowedDirs.some((d) => isWithinDir(resolved, d))) {
    emitter.error(id, `chemin hors des répertoires d'orchestrations reconnus: ${pathParam}`);
    return;
  }

  let raw: string;
  try {
    raw = await fsp.readFile(resolved, "utf8");
  } catch (err) {
    emitter.error(id, `lecture impossible: ${errMessage(err)}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    emitter.error(id, `YAML invalide (${path.basename(resolved)}): ${errMessage(err)}`);
    return;
  }
  const result = normalizeOrchestration(parsed);
  if (!result.ok) {
    emitter.error(id, `${result.message} (fichier: ${path.basename(resolved)})`);
    return;
  }
  emitter.done(id, { orchestration: result.value, raw });
}

// ---------------------------------------------------------------------------
// orch.write
// ---------------------------------------------------------------------------

export async function handleOrchWrite(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const scopeParam = params.scope;
  if (scopeParam !== "project" && scopeParam !== "global") {
    emitter.error(id, "params.scope doit valoir 'project' ou 'global'");
    return;
  }

  const rawParam = params.raw;
  const orchParam = params.orchestration;
  const hasRaw = rawParam !== undefined && rawParam !== null;
  const hasOrch = orchParam !== undefined && orchParam !== null;
  if (hasRaw === hasOrch) {
    emitter.error(id, "params doit contenir exactement un de 'raw' ou 'orchestration' (ni les deux, ni aucun)");
    return;
  }

  const cwdParam = params.cwd;
  if (scopeParam === "project" && !isNonEmptyString(cwdParam)) {
    emitter.error(id, "params.cwd est requis pour scope 'project'");
    return;
  }

  let normalized: OrchestrationNormalized;
  let contentToWrite: string;

  if (hasRaw) {
    if (typeof rawParam !== "string" || rawParam.trim().length === 0) {
      emitter.error(id, "params.raw doit être une chaîne YAML non vide");
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(rawParam);
    } catch (err) {
      emitter.error(id, `YAML invalide: ${errMessage(err)}`);
      return;
    }
    const result = normalizeOrchestration(parsed);
    if (!result.ok) {
      emitter.error(id, result.message);
      return;
    }
    normalized = result.value;
    contentToWrite = rawParam;
  } else {
    const result = normalizeOrchestration(orchParam);
    if (!result.ok) {
      emitter.error(id, result.message);
      return;
    }
    normalized = result.value;
    contentToWrite = stringifyYaml(normalized, { lineWidth: 0 });
  }

  const targetDir = scopeParam === "project" ? projectDir(cwdParam as string, "orchestrations") : globalDir("orchestrations");
  const targetPath = path.join(targetDir, `${normalized.name}.yaml`);

  try {
    await atomicWriteFile(targetPath, contentToWrite);
  } catch (err) {
    emitter.error(id, `écriture impossible: ${errMessage(err)}`);
    return;
  }

  emitter.done(id, { orchestration: normalized, path: targetPath });
}

// ---------------------------------------------------------------------------
// orch.delete — garde anti-traversée : uniquement .iaction/orchestrations du
// cwd fourni, ou le dossier global.
// ---------------------------------------------------------------------------

export async function handleOrchDelete(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const pathParam = params.path;
  if (!isNonEmptyString(pathParam)) {
    emitter.error(id, "params.path manquant ou invalide");
    return;
  }
  const cwdParam = params.cwd;
  const cwd = isNonEmptyString(cwdParam) ? cwdParam : null;

  const allowedDirs = [globalDir("orchestrations")];
  if (cwd) {
    allowedDirs.push(projectDir(cwd, "orchestrations"));
  }
  const resolved = path.resolve(pathParam);
  if (!allowedDirs.some((d) => isWithinDir(resolved, d))) {
    emitter.error(
      id,
      `suppression refusée : chemin hors de .iaction/orchestrations (projet) ou du dossier global: ${pathParam}`,
    );
    return;
  }

  try {
    await fsp.unlink(resolved);
  } catch (err) {
    emitter.error(id, `suppression impossible: ${errMessage(err)}`);
    return;
  }
  emitter.done(id, { deleted: true });
}

// ---------------------------------------------------------------------------
// Lot O3 — exécution d'orchestrations (orch.run / orch.permission / orch.abort)
//
// Voir docs/etude-orchestration.md §6 et docs/protocol.md « Méthodes O3 ».
// Réutilise handleClaudeStart/handleNeutralStart etc. comme briques internes :
// une étape = un id interne `<runId>::<stepId>` passé à ces fonctions avec un
// EMITTER SYNTHÉTIQUE qui relaie les chunks moteur en `step_chunk` et capture
// le `done`/`error` pour les traduire en `step_done`/`step_failed`. Le moteur
// d'exécution lui-même ne duplique jamais la logique des moteurs.
// ---------------------------------------------------------------------------

/** Résout un agent par NOM (pas par chemin) : projet > global > import Claude Code (docs/etude-orchestration.md §4.2). */
async function resolveAgentForStep(cwd: string, name: string): Promise<ValidationResult<AgentNormalized>> {
  for (const f of await listFilesWithExt(projectDir(cwd, "agents"), ".yaml")) {
    const entry = await loadYamlAgentEntry(f, "project");
    if (entry.name === name) {
      return entry.invalid ? fail(`agent '${name}' (projet) invalide: ${entry.invalid}`) : { ok: true, value: entry };
    }
  }
  for (const f of await listFilesWithExt(globalDir("agents"), ".yaml")) {
    const entry = await loadYamlAgentEntry(f, "global");
    if (entry.name === name) {
      return entry.invalid ? fail(`agent '${name}' (global) invalide: ${entry.invalid}`) : { ok: true, value: entry };
    }
  }
  for (const f of await listFilesWithExt(claudeAgentsDir(cwd), ".md")) {
    const entry = await loadImportedAgentEntry(f);
    if (entry.name === name) {
      return entry.invalid ? fail(`agent '${name}' (importé) invalide: ${entry.invalid}`) : { ok: true, value: entry };
    }
  }
  return fail(`agent introuvable: ${name}`);
}

/** Résout une orchestration par NOM : projet > global. */
async function resolveOrchestrationByName(cwd: string, name: string): Promise<ValidationResult<OrchestrationNormalized>> {
  for (const f of await listFilesWithExt(projectDir(cwd, "orchestrations"), ".yaml")) {
    const entry = await loadYamlOrchEntry(f, "project");
    if (entry.name === name) {
      return entry.invalid
        ? fail(`orchestration '${name}' (projet) invalide: ${entry.invalid}`)
        : { ok: true, value: entry };
    }
  }
  for (const f of await listFilesWithExt(globalDir("orchestrations"), ".yaml")) {
    const entry = await loadYamlOrchEntry(f, "global");
    if (entry.name === name) {
      return entry.invalid
        ? fail(`orchestration '${name}' (global) invalide: ${entry.invalid}`)
        : { ok: true, value: entry };
    }
  }
  return fail(`orchestration introuvable: ${name}`);
}

// ---------------------------------------------------------------------------
// Templating — `{{<input>}}` et `{{steps.<id>.output}}`, remplacement textuel
// simple (docs/etude-orchestration.md §4.2).
// ---------------------------------------------------------------------------

const STEP_OUTPUT_TOKEN_RE = /^steps\.([a-z0-9-]+)\.output$/;

/**
 * Scanne `task` à la recherche de tokens `{{...}}` SANS regex à quantificateurs
 * chevauchants (`indexOf` pur : bornes explicites, complexité linéaire garantie —
 * pas de risque de backtracking pathologique). Pour chaque token trouvé, appelle
 * `resolve(inner)` (contenu trimé) ; si `resolve` renvoie une chaîne, elle
 * remplace le token dans le résultat, sinon le token est laissé tel quel.
 */
function scanTemplateTokens(task: string, resolve: (inner: string) => string | null): string {
  let result = "";
  let idx = 0;
  while (idx < task.length) {
    const start = task.indexOf("{{", idx);
    if (start === -1) {
      result += task.slice(idx);
      break;
    }
    const end = task.indexOf("}}", start + 2);
    if (end === -1) {
      result += task.slice(idx);
      break;
    }
    result += task.slice(idx, start);
    const inner = task.slice(start + 2, end).trim();
    const replacement = resolve(inner);
    result += replacement ?? task.slice(start, end + 2);
    idx = end + 2;
  }
  return result;
}

/** Extrait les références `{{steps.<id>.output}}` (stepRefs) et les autres `{{...}}` (inputRefs), telles que rencontrées dans `task`. */
function extractTemplateTokens(task: string): { stepRefs: string[]; inputRefs: string[] } {
  const stepRefs: string[] = [];
  const inputRefs: string[] = [];
  scanTemplateTokens(task, (inner) => {
    const stepMatch = STEP_OUTPUT_TOKEN_RE.exec(inner);
    if (stepMatch) {
      stepRefs.push(stepMatch[1]);
    } else {
      inputRefs.push(inner);
    }
    return null;
  });
  return { stepRefs, inputRefs };
}

/**
 * Validation du templating AVANT tout run_started (docs/etude-orchestration.md §4.2) :
 * - `{{steps.<id>.output}}` n'est autorisé que pour un id présent dans `needs` de l'étape ;
 * - un input DÉCLARÉ et UTILISÉ mais non fourni au lancement → erreur.
 * Renvoie le premier message d'erreur trouvé, ou null si tout est valide.
 */
function validateTemplating(
  orchestration: OrchestrationNormalized,
  providedInputs: Record<string, string>,
): string | null {
  const declaredInputNames = new Set(orchestration.inputs.map((i) => i.name));
  for (const step of orchestration.steps) {
    const { stepRefs, inputRefs } = extractTemplateTokens(step.task);
    for (const refId of stepRefs) {
      if (!step.needs.includes(refId)) {
        return `l'étape '${step.id}' référence {{steps.${refId}.output}} sans déclarer '${refId}' dans needs`;
      }
    }
    for (const name of inputRefs) {
      if (declaredInputNames.has(name) && !(name in providedInputs)) {
        return `l'étape '${step.id}' utilise l'input '${name}' (déclaré) qui n'a pas été fourni au lancement`;
      }
    }
  }
  return null;
}

/** Remplacement textuel simple : tokens inconnus laissés tels quels. */
function renderTemplate(
  task: string,
  providedInputs: Record<string, string>,
  stepOutputs: Map<string, string>,
): string {
  return scanTemplateTokens(task, (inner) => {
    const stepMatch = STEP_OUTPUT_TOKEN_RE.exec(inner);
    if (stepMatch) {
      return stepOutputs.get(stepMatch[1]) ?? "";
    }
    if (Object.hasOwn(providedInputs, inner)) {
      return providedInputs[inner];
    }
    return null;
  });
}

/** Borne un texte à `max` caractères, avec mention explicite en cas de troncature. */
function boundText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + `\n…[sortie tronquée à ${max} caractères]`;
}

// ---------------------------------------------------------------------------
// StepRunner — abstraction injectable des moteurs d'exécution d'étape.
// Par défaut : les vrais moteurs handleClaudeStart/handleNeutralStart etc.
// Les tests injectent un stepRunner factice (DAG contrôlé, sans dépendance
// réseau/SDK) via `createOrchestratorRuntime({stepRunner})`.
// ---------------------------------------------------------------------------

export interface StepRunner {
  start(
    internalId: string,
    engine: AgentEngine,
    startParams: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void>;
  permission(
    engine: AgentEngine,
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void | Promise<void>;
  abort(engine: AgentEngine, id: string, params: Record<string, unknown>, emitter: EngineEmitter): void | Promise<void>;
}

const defaultStepRunner: StepRunner = {
  async start(internalId, engine, startParams, emitter) {
    if (engine === "claude") {
      await handleClaudeStart(internalId, startParams, emitter);
    } else {
      await handleNeutralStart(internalId, startParams, emitter);
    }
  },
  async permission(engine, id, params, emitter) {
    if (engine === "claude") {
      await handleClaudePermission(id, params, emitter);
    } else {
      handleNeutralPermission(id, params, emitter);
    }
  },
  async abort(engine, id, params, emitter) {
    if (engine === "claude") {
      await handleClaudeAbort(id, params, emitter);
    } else {
      handleNeutralAbort(id, params, emitter);
    }
  },
};

/** `emitter` jetable pour les appels internes de fire-and-forget (ex. abort d'une étape) dont la réponse n'est pas relayée au protocole. */
const noopEmitter: EngineEmitter = {
  chunk() {},
  done() {},
  error() {},
};

// ---------------------------------------------------------------------------
// Paramètres de démarrage d'une étape selon le moteur de l'agent résolu
// (docs/etude-orchestration.md §6, docs/protocol.md « orch.run »).
// ---------------------------------------------------------------------------

function buildStepStartParams(
  agent: AgentNormalized,
  cwd: string,
  renderedTask: string,
  /** R2 — tier du routeur quand l'agent de l'étape était `engine: auto` (traçabilité `meta.routeTier`). */
  routeTier?: RouteTier,
  /** R3 — vrai quand l'étape routée a été DÉBORDÉE (compte dans le plafond mensuel, voir router.ts). */
  routeDebord?: boolean,
): Record<string, unknown> {
  let params: Record<string, unknown>;
  if (agent.engine === "claude") {
    params = {
      cwd,
      prompt: renderedTask,
      model: agent.model,
      permissionMode: agent.permissionMode,
      systemPrompt: agent.instructions,
      chatOnly: false,
      // Champ `mcp` du manifeste d'agent : `false` = n'hérite PAS du
      // .mcp.json du projet. Documenté de longue date, il n'était jusqu'ici
      // transmis à personne — un agent qui refusait le MCP les recevait
      // quand même (et en payait le contexte).
      mcp: agent.mcp,
    };
    // T-003 — allowlist `tools:` du manifeste : transmise (elle ne l'était à
    // personne, cf. claude.ts). Absente/null = palette complète, donc rien à
    // poser — le moteur garde son défaut.
    if (agent.tools !== null) {
      params.tools = agent.tools;
    }
  } else {
    const messages: Record<string, unknown>[] = [];
    if (agent.instructions.trim().length > 0) {
      messages.push({ role: "system", content: agent.instructions });
    }
    messages.push({ role: "user", content: renderedTask });
    params = {
      providerId: agent.provider,
      model: agent.model,
      cwd,
      messages,
      permissionMode: agent.permissionMode,
    };
    if (agent.maxTurns !== null) {
      params.maxTurns = agent.maxTurns;
    }
    // T-003 — même allowlist côté moteur neutre (noms d'outils neutres, ou
    // équivalents Claude pour un agent `engine: auto` — voir neutralAgent.ts).
    if (agent.tools !== null) {
      params.tools = agent.tools;
    }
  }
  // S2 — `projectPath` : le répertoire du run EST l'identité du projet pour
  // une étape d'orchestration (aucune UI derrière une tâche de fond pour
  // poser un `projectId`) ; usageStats.ts le rattache au projet déclaré de
  // même chemin. Toujours posé, même sans routage : c'est ce qui rend la part
  // « autonome » visible par projet dans Supervision.
  params.meta = {
    projectPath: cwd,
    ...(routeTier ? { routeTier } : {}),
    ...(routeTier && routeDebord ? { routeDebord: true } : {}),
  };
  return params;
}

/** Classe le `done` d'une étape moteur (subtype claude/neutral) en issue d'étape. */
function classifyStepOutcome(doneData: Record<string, unknown>): {
  status: "success" | "failed" | "aborted";
  message?: string;
} {
  const subtype = typeof doneData.subtype === "string" ? doneData.subtype : "unknown";
  if (subtype === "aborted") {
    return { status: "aborted" };
  }
  if (subtype === "success" || subtype === "max_turns") {
    return { status: "success" };
  }
  return { status: "failed", message: `échec du moteur (subtype: ${subtype})` };
}

/**
 * Texte final d'une étape (docs/etude-orchestration.md §6) : pour claude,
 * `result` du `done` moteur ; pour neutral, la concaténation des deltas
 * `text` relayés pendant l'étape (accumulés dans `textAcc` par l'appelant).
 */
function extractStepOutput(engine: AgentEngine, doneData: Record<string, unknown>, textAcc: string): string {
  if (engine !== "claude") {
    return textAcc;
  }
  return typeof doneData.result === "string" ? doneData.result : "";
}

// ---------------------------------------------------------------------------
// Runtime — état d'un run en cours, DAG, parallélisme, coupe-circuit.
// ---------------------------------------------------------------------------

type StepStatus = "pending" | "running" | "success" | "failed" | "skipped" | "aborted";

interface StepRuntimeInfo {
  status: StepStatus;
  /** Moteur de l'étape — `"auto"` tant que le routeur n'a pas résolu la cible (au démarrage de l'étape). */
  engine: AgentEngine;
  /** Id interne `<runId>::<stepId>` tant que l'étape est en cours (pour le routage permission/abort). */
  internalId: string | null;
  output?: string;
  message?: string;
  usage?: unknown;
}

interface RunContext {
  cwd: string;
  abortRequested: boolean;
  steps: Map<string, StepRuntimeInfo>;
}

const STEP_OUTPUT_CHUNK_CAP = 200_000;
const STEP_OUTPUT_DONE_CAP = 8_000;

export interface OrchestratorRuntime {
  handleOrchRun(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void>;
  handleOrchPermission(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void>;
  handleOrchAbort(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void>;
}

export function createOrchestratorRuntime(deps: { stepRunner?: StepRunner } = {}): OrchestratorRuntime {
  const stepRunner = deps.stepRunner ?? defaultStepRunner;
  /** Runs actifs, indexés par l'id de la requête `orch.run` correspondante (= runId pour permission/abort). */
  const activeRuns = new Map<string, RunContext>();

  async function handleOrchRun(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
    const cwdParam = params.cwd;
    const nameParam = params.name;
    if (!isNonEmptyString(cwdParam)) {
      emitter.error(id, "params.cwd manquant ou invalide");
      return;
    }
    if (!isNonEmptyString(nameParam)) {
      emitter.error(id, "params.name manquant ou invalide");
      return;
    }
    const cwd = cwdParam;

    const inputsParam = params.inputs;
    const providedInputs: Record<string, string> = {};
    if (inputsParam !== undefined && inputsParam !== null) {
      if (!isPlainObject(inputsParam)) {
        emitter.error(id, "params.inputs doit être un objet {nom: valeur}");
        return;
      }
      for (const [k, v] of Object.entries(inputsParam)) {
        if (typeof v !== "string") {
          emitter.error(id, `params.inputs.${k} doit être une chaîne`);
          return;
        }
        providedInputs[k] = v;
      }
    }

    // 1. Résolution AVANT tout run_started : orchestration inconnue, agent manquant, templating invalide.
    const orchResult = await resolveOrchestrationByName(cwd, nameParam);
    if (!orchResult.ok) {
      emitter.error(id, orchResult.message);
      return;
    }
    const orchestration = orchResult.value;

    const resolvedAgents = new Map<string, AgentNormalized>();
    for (const step of orchestration.steps) {
      const agentResult = await resolveAgentForStep(cwd, step.agent);
      if (!agentResult.ok) {
        emitter.error(id, `étape '${step.id}': ${agentResult.message}`);
        return;
      }
      // R2 (révision 2026-07-31) — les agents `engine: auto` ne sont PLUS
      // routés ici : la résolution a lieu au DÉMARRAGE de chaque étape, sur
      // le texte RENDU de sa tâche (voir runStepBody plus bas). `run_started`
      // annonce donc `engine: "auto", model: null` pour ces étapes.
      resolvedAgents.set(step.id, agentResult.value);
    }

    // Défauts des inputs (`default:`) : un input déclaré non fourni au
    // lancement prend sa valeur par défaut s'il en a une — c'est ce qui rend
    // une orchestration lançable par une tâche planifiée (aucune saisie).
    for (const input of orchestration.inputs) {
      if (input.default !== null && !(input.name in providedInputs)) {
        providedInputs[input.name] = input.default;
      }
    }

    const templatingError = validateTemplating(orchestration, providedInputs);
    if (templatingError) {
      emitter.error(id, templatingError);
      return;
    }

    // 2. Contexte de run + run_started (ordre du fichier).
    const ctx: RunContext = { cwd, abortRequested: false, steps: new Map() };
    for (const step of orchestration.steps) {
      ctx.steps.set(step.id, { status: "pending", engine: resolvedAgents.get(step.id)!.engine, internalId: null });
    }
    activeRuns.set(id, ctx);

    // Pour une étape d'agent `engine: auto`, la cible n'est pas encore connue
    // au lancement : `engine: "auto"`, `model: null` ici, la cible résolue est
    // annoncée par le `step_started` de l'étape (docs/protocol.md « orch.run »).
    emitter.chunk(id, {
      kind: "run_started",
      steps: orchestration.steps.map((s) => ({
        stepId: s.id,
        agent: s.agent,
        engine: resolvedAgents.get(s.id)!.engine,
        model: resolvedAgents.get(s.id)!.model,
      })),
    });

    // 3. Ordonnanceur DAG.
    const stepOutputs = new Map<string, string>();
    const maxParallel = Math.max(1, orchestration.limits.maxParallel);
    const deadline = Date.now() + orchestration.limits.maxDurationMin * 60_000;
    let timedOut = false;
    const runningPromises = new Map<string, Promise<void>>();
    const finalizedSteps = new Set<string>();

    function finalizeStep(
      stepId: string,
      status: "success" | "failed" | "aborted",
      output: string,
      message: string | undefined,
      usage: unknown,
    ): void {
      if (finalizedSteps.has(stepId)) {
        return;
      }
      finalizedSteps.add(stepId);
      const info = ctx.steps.get(stepId)!;
      info.status = status;
      info.internalId = null;
      if (output) {
        info.output = output;
      }
      if (message) {
        info.message = message;
      }
      info.usage = usage;
      if (status === "success") {
        stepOutputs.set(stepId, output);
        emitter.chunk(id, { kind: "step_done", stepId, output: boundText(output, STEP_OUTPUT_CHUNK_CAP), usage: usage ?? null });
      } else if (status === "failed") {
        emitter.chunk(id, { kind: "step_failed", stepId, message: message ?? "échec inconnu" });
      }
      // "aborted" : aucun chunk dédié — seul le statut final (`done`) le porte.
    }

    /** Cascade `skipped` (dépendance en échec/skip/abort) et `aborted` (run annulé) sur les étapes encore pending. Point fixe (multi-niveaux). */
    function computeSkipsAndAborts(): void {
      let changed = true;
      while (changed) {
        changed = false;
        for (const step of orchestration.steps) {
          const info = ctx.steps.get(step.id)!;
          if (info.status !== "pending") {
            continue;
          }
          if (ctx.abortRequested) {
            info.status = "aborted";
            changed = true;
            continue;
          }
          const badNeed = step.needs.find((n) => {
            const s = ctx.steps.get(n)!.status;
            return s === "failed" || s === "skipped" || s === "aborted";
          });
          if (badNeed) {
            info.status = "skipped";
            info.message = `étape sautée : dépendance ${badNeed} en échec`;
            emitter.chunk(id, { kind: "step_skipped", stepId: step.id, reason: info.message });
            changed = true;
          }
        }
      }
    }

    function countRunning(): number {
      let n = 0;
      for (const info of ctx.steps.values()) {
        if (info.status === "running") n++;
      }
      return n;
    }

    /**
     * Corps asynchrone d'une étape déjà marquée `running` : routage éventuel
     * (agent `engine: auto`) résolu ICI, sur la tâche RENDUE — le texte avec
     * les {{...}} interpolés est ce que le modèle recevra ; une tâche courte
     * au template mais volumineuse une fois rendue est donc classée sur sa
     * taille réelle, et le débord/plafond (R3/R6) est re-vérifié au moment où
     * l'étape démarre, plus au lancement du run. Émet ensuite `step_started`
     * (cible résolue), puis démarre le moteur.
     */
    async function runStepBody(step: OrchStep, info: StepRuntimeInfo, internalId: string): Promise<void> {
      const renderedTask = renderTemplate(step.task, providedInputs, stepOutputs);

      let agent = resolvedAgents.get(step.id)!;
      /** R2 — tier retenu par le routeur (traçabilité `meta.routeTier`). */
      let routeTier: RouteTier | undefined;
      /** R3 — étape routée DÉBORDÉE (abonnement saturé) : `meta.routeDebord` pour le plafond mensuel. */
      let routeDebord = false;
      if (agent.engine === "auto") {
        // R2 — résolution INTERNE via le routeur (pas d'aller-retour protocole) :
        // texte = tâche RENDUE, cwd du run (la surcharge .iaction/routage.yaml
        // du projet s'applique donc). `resolveRoute` ne rejette jamais — repli
        // heuristique/table par défaut silencieux au pire.
        const route = await resolveRoute({ text: renderedTask, cwd });
        routeTier = route.tier;
        routeDebord = route.debord?.active === true;
        agent = {
          ...agent,
          engine: route.target.engine,
          provider: route.target.engine === "neutral" ? (route.target.providerId ?? null) : null,
          model: route.target.model,
          // Le mode « plan » n'existe pas côté moteur neutre (même garde-fou
          // que l'UI Projets) : replié sur « default » si le routeur y envoie.
          permissionMode:
            agent.permissionMode === "plan" && route.target.engine === "neutral" ? "default" : agent.permissionMode,
        };
        // Moteur résolu : requis pour router permission/abort de l'étape en cours.
        info.engine = agent.engine;
      }

      // Annulation (orch.abort ou coupe-circuit) arrivée pendant la résolution :
      // le moteur n'a pas démarré, l'étape se termine `aborted` sans step_started.
      if (ctx.abortRequested) {
        finalizeStep(step.id, "aborted", "", undefined, null);
        return;
      }

      // `step_started` porte la cible EFFECTIVE de l'étape (`routeTier` présent
      // uniquement quand le routeur a résolu un agent `engine: auto`).
      emitter.chunk(id, {
        kind: "step_started",
        stepId: step.id,
        engine: agent.engine,
        model: agent.model,
        ...(routeTier ? { routeTier } : {}),
      });

      const startParams = buildStepStartParams(agent, cwd, renderedTask, routeTier, routeDebord);

      let textAcc = "";
      const synthEmitter: EngineEmitter = {
        chunk(_internalId, data) {
          emitter.chunk(id, { kind: "step_chunk", stepId: step.id, chunk: data });
          if (
            agent.engine === "neutral" &&
            isPlainObject(data) &&
            data.kind === "text" &&
            typeof data.delta === "string"
          ) {
            textAcc += data.delta;
          }
        },
        done(_internalId, data) {
          const doneData = isPlainObject(data) ? data : {};
          const outcome = classifyStepOutcome(doneData);
          const fullOutput = extractStepOutput(agent.engine, doneData, textAcc);
          finalizeStep(step.id, outcome.status, fullOutput, outcome.message, doneData.usage ?? null);
        },
        error(_internalId, message) {
          finalizeStep(step.id, "failed", textAcc, message, null);
        },
      };

      await stepRunner.start(internalId, agent.engine, startParams, synthEmitter);
    }

    function startReadySteps(): void {
      if (ctx.abortRequested || timedOut) {
        return;
      }
      for (const step of orchestration.steps) {
        if (countRunning() >= maxParallel) {
          break;
        }
        const info = ctx.steps.get(step.id)!;
        if (info.status !== "pending") {
          continue;
        }
        if (!step.needs.every((n) => ctx.steps.get(n)!.status === "success")) {
          continue;
        }

        info.status = "running";
        const internalId = `${id}::${step.id}`;
        info.internalId = internalId;

        const stepPromise = runStepBody(step, info, internalId)
          .catch((err) => {
            finalizeStep(step.id, "failed", "", err instanceof Error ? err.message : String(err), null);
          })
          .then(() => {
            runningPromises.delete(step.id);
          });
        runningPromises.set(step.id, stepPromise);
      }
    }

    computeSkipsAndAborts();
    startReadySteps();

    while (true) {
      const stillActive = [...ctx.steps.values()].some((s) => s.status === "pending" || s.status === "running");
      if (!stillActive) {
        break;
      }

      const stepPromises = [...runningPromises.values()];
      const remainingMs = Math.max(0, deadline - Date.now());
      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remainingMs);
      });
      const winner = await Promise.race([Promise.race(stepPromises).then(() => "steps" as const), timeoutPromise]);
      clearTimeout(timer!);

      if (winner === "timeout" && !timedOut) {
        timedOut = true;
        ctx.abortRequested = true;
        for (const [, info] of ctx.steps) {
          if (info.status === "running" && info.internalId) {
            await stepRunner.abort(info.engine, info.internalId, { targetId: info.internalId }, noopEmitter);
          }
        }
      }

      computeSkipsAndAborts();
      startReadySteps();
    }

    activeRuns.delete(id);

    // 4. Statut terminal (docs/protocol.md « orch.run ») : aborted prime sur success/partial/failed.
    let successCount = 0;
    for (const info of ctx.steps.values()) {
      if (info.status === "success") successCount++;
    }
    let overallStatus: "success" | "partial" | "failed" | "aborted";
    if (ctx.abortRequested) {
      overallStatus = "aborted";
    } else if (successCount === orchestration.steps.length) {
      overallStatus = "success";
    } else if (successCount === 0) {
      overallStatus = "failed";
    } else {
      overallStatus = "partial";
    }

    const stepsOut: Record<string, { status: StepStatus; output?: string; message?: string }> = {};
    for (const step of orchestration.steps) {
      const info = ctx.steps.get(step.id)!;
      const entry: { status: StepStatus; output?: string; message?: string } = { status: info.status };
      if (info.output) {
        entry.output = boundText(info.output, STEP_OUTPUT_DONE_CAP);
      }
      if (info.message) {
        entry.message = info.message;
      }
      stepsOut[step.id] = entry;
    }

    emitter.done(id, { status: overallStatus, steps: stepsOut });
  }

  async function handleOrchPermission(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void> {
    const targetId = params.targetId;
    const stepId = params.stepId;
    const permissionId = params.permissionId;
    const decision = params.decision;
    if (!isNonEmptyString(targetId) || !isNonEmptyString(stepId) || !isNonEmptyString(permissionId)) {
      emitter.error(id, "params.targetId, params.stepId et params.permissionId sont requis");
      return;
    }
    if (decision !== "allow" && decision !== "deny") {
      emitter.error(id, "params.decision doit être 'allow' ou 'deny'");
      return;
    }

    const ctx = activeRuns.get(targetId);
    const info = ctx?.steps.get(stepId);
    if (!ctx || !info || info.status !== "running" || !info.internalId) {
      emitter.done(id, { applied: false });
      return;
    }

    const forwardParams: Record<string, unknown> = { targetId: info.internalId, permissionId, decision };
    if (isNonEmptyString(params.message)) {
      forwardParams.message = params.message;
    }
    if (params.updatedInput !== undefined) {
      forwardParams.updatedInput = params.updatedInput;
    }
    await stepRunner.permission(info.engine, id, forwardParams, emitter);
  }

  async function handleOrchAbort(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
    const targetId = params.targetId;
    if (!isNonEmptyString(targetId)) {
      emitter.error(id, "params.targetId manquant ou invalide");
      return;
    }
    const ctx = activeRuns.get(targetId);
    if (!ctx) {
      emitter.done(id, { aborted: false });
      return;
    }
    ctx.abortRequested = true;
    const abortCalls: Promise<void>[] = [];
    for (const [, info] of ctx.steps) {
      if (info.status === "running" && info.internalId) {
        abortCalls.push(
          Promise.resolve(stepRunner.abort(info.engine, info.internalId, { targetId: info.internalId }, noopEmitter)),
        );
      }
    }
    await Promise.all(abortCalls);
    emitter.done(id, { aborted: true });
  }

  return { handleOrchRun, handleOrchPermission, handleOrchAbort };
}

const defaultOrchestratorRuntime = createOrchestratorRuntime();

export const handleOrchRun = defaultOrchestratorRuntime.handleOrchRun;
export const handleOrchPermission = defaultOrchestratorRuntime.handleOrchPermission;
export const handleOrchAbort = defaultOrchestratorRuntime.handleOrchAbort;
