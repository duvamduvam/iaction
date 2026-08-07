/**
 * Moteur neutre — Lot 6 : boucle agentique tool-calling « tous agents à égalité ».
 *
 * Donne aux fournisseurs OpenAI-compatibles (Ollama/OpenRouter/custom) le même
 * contrat d'événements que `claude.start` (voir sidecar/src/claude.ts) — chunks
 * `kind=init|text|tool_use|tool_result|permission_request`, puis `done`/`error`
 * — pour que l'UI n'ait qu'une seule UI d'agent (docs/protocol.md, section
 * « Méthodes Lot 6 »).
 *
 * Le moteur est SANS état de session : l'appelant renvoie tout l'historique à
 * chaque `neutral.start` (sessionId toujours null).
 *
 * Règle absolue : une apiKey ne doit jamais être écrite sur disque, ni loguée
 * (même sur stderr) — y compris dans les messages d'erreur (héritée de
 * engine.ts via buildHeaders/readBoundedBody, réutilisés tels quels ici).
 */

import { spawn } from "node:child_process";
import { createReadStream, promises as fsp } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { isNonEmptyString, isPlainObject } from "./base.js";
import { buildHeaders, getProvider, joinUrl, readBoundedBody, type EngineEmitter, type Provider } from "./engine.js";
import { formatSearchResults, sanitizeTopK, searchKnowledge } from "./knowledge.js";
import { recordUsageEvent, type UsageStatus } from "./usageStats.js";

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------


function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const MAX_SUMMARY = 500;

/** Résumé textuel borné du résultat d'un outil (même contrat que claude.ts::summarizeToolResult). */
function summarizeText(text: string): string {
  return text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY) + "…" : text;
}

// ---------------------------------------------------------------------------
// Palette d'outils — garde anti-traversée
// ---------------------------------------------------------------------------

/**
 * Résout `rawPath` relativement à `cwd` et vérifie que le résultat reste dans
 * `cwd` (égalité stricte pour "."/racine, ou préfixe `cwd + sep` sinon).
 * Ne lève jamais : renvoie une erreur explicite consommée comme tool_result.
 */
function resolveSafePath(
  cwd: string,
  rawPath: string,
): { ok: true; abs: string } | { ok: false; message: string } {
  const cwdAbs = path.resolve(cwd);
  const abs = path.resolve(cwdAbs, rawPath);
  if (abs === cwdAbs || abs.startsWith(cwdAbs + path.sep)) {
    return { ok: true, abs };
  }
  return { ok: false, message: `chemin hors du répertoire de travail: ${rawPath}` };
}

/** Écriture atomique : fichier temporaire dans le même répertoire, puis rename. Crée les parents. */
async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, absPath);
}

interface ToolExecResult {
  isError: boolean;
  content: string;
}

const READ_FILE_HARD_CAP = 256 * 1024;

async function toolReadFile(cwd: string, input: unknown): Promise<ToolExecResult> {
  if (!isPlainObject(input) || !isNonEmptyString(input.path)) {
    return { isError: true, content: "read_file: paramètre 'path' requis (string)" };
  }
  const safe = resolveSafePath(cwd, input.path);
  if (!safe.ok) {
    return { isError: true, content: safe.message };
  }
  let stat;
  try {
    stat = await fsp.stat(safe.abs);
  } catch {
    return { isError: true, content: `fichier introuvable: ${input.path}` };
  }
  if (stat.isDirectory()) {
    return { isError: true, content: `${input.path} est un répertoire, pas un fichier` };
  }
  const rawMax = input.maxBytes;
  const cap = Math.min(
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : READ_FILE_HARD_CAP,
    READ_FILE_HARD_CAP,
  );
  const readLen = Math.min(cap, stat.size);
  const fh = await fsp.open(safe.abs, "r");
  try {
    const buffer = Buffer.alloc(readLen);
    if (readLen > 0) {
      await fh.read(buffer, 0, readLen, 0);
    }
    // Détection binaire simple : octet nul dans les (au plus) premiers 8 Ko lus.
    const checkLen = Math.min(buffer.length, 8192);
    for (let i = 0; i < checkLen; i++) {
      if (buffer[i] === 0) {
        return { isError: true, content: `fichier binaire (octet nul détecté), lecture refusée: ${input.path}` };
      }
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      return { isError: true, content: `fichier binaire ou encodage non UTF-8, lecture refusée: ${input.path}` };
    }
    if (stat.size > readLen) {
      text += `\n…[tronqué, ${readLen} octets lus sur ${stat.size} au total]`;
    }
    return { isError: false, content: text };
  } finally {
    await fh.close();
  }
}

const LIST_DIR_CAP = 500;

async function toolListDir(cwd: string, input: unknown): Promise<ToolExecResult> {
  const rawPath = isPlainObject(input) && isNonEmptyString(input.path) ? input.path : ".";
  const safe = resolveSafePath(cwd, rawPath);
  if (!safe.ok) {
    return { isError: true, content: safe.message };
  }
  let stat;
  try {
    stat = await fsp.stat(safe.abs);
  } catch {
    return { isError: true, content: `répertoire introuvable: ${rawPath}` };
  }
  if (!stat.isDirectory()) {
    return { isError: true, content: `${rawPath} n'est pas un répertoire` };
  }
  let dirents;
  try {
    dirents = await fsp.readdir(safe.abs, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `lecture du répertoire impossible: ${message}` };
  }
  const entries: { name: string; isDir: boolean; size: number }[] = [];
  for (const d of dirents) {
    let size = 0;
    let isDir = d.isDirectory();
    try {
      const st = await fsp.stat(path.join(safe.abs, d.name));
      isDir = st.isDirectory();
      size = isDir ? 0 : st.size;
    } catch {
      // Entrée illisible (lien symbolique cassé, permissions…) : conservée avec size 0.
    }
    entries.push({ name: d.name, isDir, size });
  }
  // Choix documenté : dossiers d'abord, puis tri alphabétique (locale par défaut).
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) {
      return a.isDir ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  const capped = entries.slice(0, LIST_DIR_CAP);
  return { isError: false, content: JSON.stringify(capped) };
}

const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", "target", "dist"]);
const SEARCH_CAP = 100;

async function searchInFile(
  fileAbs: string,
  cwdAbs: string,
  regex: RegExp,
  results: string[],
  cap: number,
): Promise<void> {
  if (results.length >= cap) {
    return;
  }
  // Détection binaire rapide sur les premiers octets avant de streamer.
  let fh;
  try {
    fh = await fsp.open(fileAbs, "r");
  } catch {
    return;
  }
  try {
    const checkBuf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(checkBuf, 0, 8192, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (checkBuf[i] === 0) {
        return;
      }
    }
  } catch {
    return;
  } finally {
    await fh.close();
  }

  const relPath = path.relative(cwdAbs, fileAbs) || path.basename(fileAbs);
  await new Promise<void>((resolve) => {
    const stream = createReadStream(fileAbs, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNum = 0;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      rl.close();
      stream.destroy();
    };
    rl.on("line", (line) => {
      if (stopped) return;
      lineNum++;
      if (results.length >= cap) {
        stop();
        return;
      }
      if (regex.test(line)) {
        results.push(`${relPath}:${lineNum}:${line}`);
      }
    });
    rl.on("close", () => resolve());
    rl.on("error", () => resolve());
    stream.on("error", () => resolve());
  });
}

async function walkAndSearch(
  dirAbs: string,
  cwdAbs: string,
  regex: RegExp,
  results: string[],
  cap: number,
): Promise<void> {
  if (results.length >= cap) {
    return;
  }
  let entries;
  try {
    entries = await fsp.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= cap) {
      return;
    }
    if (entry.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walkAndSearch(path.join(dirAbs, entry.name), cwdAbs, regex, results, cap);
    } else if (entry.isFile()) {
      await searchInFile(path.join(dirAbs, entry.name), cwdAbs, regex, results, cap);
    }
  }
}

async function toolSearch(cwd: string, input: unknown): Promise<ToolExecResult> {
  if (!isPlainObject(input) || !isNonEmptyString(input.pattern)) {
    return { isError: true, content: "search: paramètre 'pattern' requis (string)" };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `regex invalide: ${message}` };
  }
  const rawPath = isNonEmptyString(input.path) ? input.path : ".";
  const safe = resolveSafePath(cwd, rawPath);
  if (!safe.ok) {
    return { isError: true, content: safe.message };
  }
  const rawMax = input.maxResults;
  const cap = Math.min(
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : SEARCH_CAP,
    SEARCH_CAP,
  );
  const cwdAbs = path.resolve(cwd);
  const results: string[] = [];
  await walkAndSearch(safe.abs, cwdAbs, regex, results, cap);
  return { isError: false, content: results.join("\n") };
}

async function toolWriteFile(cwd: string, input: unknown): Promise<ToolExecResult> {
  if (!isPlainObject(input) || !isNonEmptyString(input.path) || typeof input.content !== "string") {
    return { isError: true, content: "write_file: paramètres 'path' (string) et 'content' (string) requis" };
  }
  const safe = resolveSafePath(cwd, input.path);
  if (!safe.ok) {
    return { isError: true, content: safe.message };
  }
  try {
    await atomicWriteFile(safe.abs, input.content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `écriture impossible: ${message}` };
  }
  return {
    isError: false,
    content: `Fichier écrit: ${input.path} (${Buffer.byteLength(input.content, "utf8")} octets)`,
  };
}

async function toolEditFile(cwd: string, input: unknown): Promise<ToolExecResult> {
  if (
    !isPlainObject(input) ||
    !isNonEmptyString(input.path) ||
    typeof input.old_string !== "string" ||
    typeof input.new_string !== "string"
  ) {
    return {
      isError: true,
      content: "edit_file: paramètres 'path', 'old_string' et 'new_string' (string) requis",
    };
  }
  if (input.old_string.length === 0) {
    return { isError: true, content: "edit_file: old_string ne peut pas être vide" };
  }
  const safe = resolveSafePath(cwd, input.path);
  if (!safe.ok) {
    return { isError: true, content: safe.message };
  }
  let original: string;
  try {
    original = await fsp.readFile(safe.abs, "utf8");
  } catch {
    return { isError: true, content: `fichier introuvable: ${input.path}` };
  }
  const count = original.split(input.old_string).length - 1;
  if (count === 0) {
    return { isError: true, content: `old_string introuvable dans ${input.path}` };
  }
  if (count > 1) {
    return { isError: true, content: `occurrence ambiguë : ${count} occurrences trouvées` };
  }
  const updated = original.replace(input.old_string, input.new_string);
  try {
    await atomicWriteFile(safe.abs, updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `écriture impossible: ${message}` };
  }
  return { isError: false, content: `Fichier modifié: ${input.path}` };
}

const BASH_DEFAULT_TIMEOUT_MS = 30000;
const BASH_MAX_TIMEOUT_MS = 300000;
const BASH_MIN_TIMEOUT_MS = 100;
const BASH_MAX_OUTPUT = 10 * 1024;

/** Variables injectées par Snap qui cassent les binaires lancés depuis l'app packagée (piège documenté ailleurs). */
const SNAP_ENV_KEYS = [
  "LD_LIBRARY_PATH",
  "GTK_PATH",
  "GTK_EXE_PREFIX",
  "GTK_IM_MODULE_FILE",
  "GDK_PIXBUF_MODULE_FILE",
  "GDK_PIXBUF_MODULEDIR",
  "GIO_MODULE_DIR",
  "GSETTINGS_SCHEMA_DIR",
  "LOCPATH",
];

function toolBash(cwd: string, input: unknown): Promise<ToolExecResult> {
  if (!isPlainObject(input) || !isNonEmptyString(input.command)) {
    return Promise.resolve({ isError: true, content: "bash: paramètre 'command' requis (string)" });
  }
  const command = input.command;
  const rawTimeout = input.timeoutMs;
  const timeoutMs = Math.min(
    BASH_MAX_TIMEOUT_MS,
    Math.max(
      BASH_MIN_TIMEOUT_MS,
      typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0
        ? Math.floor(rawTimeout)
        : BASH_DEFAULT_TIMEOUT_MS,
    ),
  );

  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of SNAP_ENV_KEYS) {
    delete env[key];
  }

  return new Promise<ToolExecResult>((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ isError: true, content: `échec d'exécution: ${message}` });
      return;
    }

    const chunks: Buffer[] = [];
    let totalLen = 0;
    const pushChunk = (buf: Buffer) => {
      if (totalLen >= BASH_MAX_OUTPUT) return;
      chunks.push(buf);
      totalLen += buf.length;
    };
    child.stdout?.on("data", (d: Buffer) => pushChunk(d));
    child.stderr?.on("data", (d: Buffer) => pushChunk(d));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ isError: true, content: `timeout dépassé (${timeoutMs}ms)` });
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ isError: true, content: `échec d'exécution: ${err.message}` });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let out = Buffer.concat(chunks).toString("utf8");
      if (totalLen >= BASH_MAX_OUTPUT) {
        out = out.slice(0, BASH_MAX_OUTPUT) + "\n…[sortie tronquée]";
      }
      if (typeof code === "number" && code !== 0) {
        out += `\n[exit code: ${code}]`;
      }
      resolve({ isError: false, content: out });
    });
  });
}

/**
 * R5 — recherche dans les connaissances indexées du projet (RAG local, voir
 * knowledge.ts) : outil en lecture seule, même flux de permission que
 * `search` (aucune validation demandée en mode default). Index absent →
 * tool_result isError avec le message lisible de knowledge.ts.
 */
async function toolSearchKnowledge(cwd: string, input: unknown): Promise<ToolExecResult> {
  if (!isPlainObject(input) || !isNonEmptyString(input.query)) {
    return { isError: true, content: "search_knowledge: paramètre 'query' requis (string)" };
  }
  const outcome = await searchKnowledge(cwd, input.query, sanitizeTopK(input.topK));
  if (!outcome.ok) {
    return { isError: true, content: outcome.message };
  }
  return { isError: false, content: formatSearchResults(outcome.results) };
}

const KNOWN_TOOLS = new Set([
  "read_file",
  "list_dir",
  "search",
  "search_knowledge",
  "write_file",
  "edit_file",
  "bash",
]);

/*
 * T-003 — allowlist `tools:` du manifeste d'agent, appliquée ici aussi (elle
 * n'était transmise à personne : `TOOLS` était une constante, tout agent
 * recevait la palette entière quoi qu'il déclare).
 *
 * Les noms des outils neutres ne sont pas ceux de Claude Code, et un agent
 * `engine: auto` (R2) ne sait pas sur quel moteur il tombera : on accepte donc
 * AUSSI les noms Claude, traduits par cette table. Un nom inconnu des deux
 * mondes est simplement ignoré — une allowlist qui ne désigne rien laisse
 * l'agent sans outil, jamais avec la palette complète (fermé par défaut).
 */
const TOOL_EQUIVALENTS: Record<string, string[]> = {
  Read: ["read_file"],
  Glob: ["list_dir", "search"],
  Grep: ["search"],
  LS: ["list_dir"],
  Write: ["write_file"],
  Edit: ["edit_file"],
  MultiEdit: ["edit_file"],
  NotebookEdit: ["edit_file"],
  Bash: ["bash"],
};

/**
 * Outils toujours exposés, hors allowlist : le RAG local est l'équivalent
 * neutre des outils MCP côté Claude, gouvernés eux par le champ `mcp` du
 * manifeste et non par `tools`. Lecture seule, aucun risque à le laisser.
 */
const TOOLS_HORS_ALLOWLIST = new Set(["search_knowledge"]);

/**
 * Résout l'allowlist déclarée en noms d'outils neutres.
 * `null` (champ absent) = palette complète, aucune restriction.
 */
function resolveAllowedTools(declared: unknown): Set<string> | null {
  if (!Array.isArray(declared) || !declared.every((t) => typeof t === "string")) return null;
  const out = new Set<string>(TOOLS_HORS_ALLOWLIST);
  for (const nom of declared as string[]) {
    if (KNOWN_TOOLS.has(nom)) {
      out.add(nom);
      continue;
    }
    for (const equivalent of TOOL_EQUIVALENTS[nom] ?? []) {
      out.add(equivalent);
    }
  }
  return out;
}

/** Exécution d'un outil, jamais levée : toute exception inattendue devient un tool_result isError. */
async function safeExecuteTool(toolName: string, toolInput: unknown, cwd: string): Promise<ToolExecResult> {
  try {
    switch (toolName) {
      case "read_file":
        return await toolReadFile(cwd, toolInput);
      case "list_dir":
        return await toolListDir(cwd, toolInput);
      case "search":
        return await toolSearch(cwd, toolInput);
      case "search_knowledge":
        return await toolSearchKnowledge(cwd, toolInput);
      case "write_file":
        return await toolWriteFile(cwd, toolInput);
      case "edit_file":
        return await toolEditFile(cwd, toolInput);
      case "bash":
        return await toolBash(cwd, toolInput);
      default:
        return { isError: true, content: `outil inconnu: ${toolName}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: `erreur interne de l'outil ${toolName}: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Déclaration des outils au modèle (OpenAI function-calling)
// ---------------------------------------------------------------------------

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Lit le contenu texte d'un fichier du projet (cap 256 Ko, refuse les fichiers binaires).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Chemin relatif au répertoire de travail" },
          maxBytes: { type: "number", description: "Octets max à lire (défaut et plafond 262144)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "Liste les entrées d'un répertoire du projet (cap 500, dossiers d'abord puis alphabétique).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Chemin relatif, défaut '.'" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Recherche une expression régulière dans les fichiers du projet (cap 100 résultats, ignore .git/node_modules/target/dist).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Expression régulière JS" },
          path: { type: "string", description: "Dossier de départ, défaut '.'" },
          maxResults: { type: "number", description: "Plafonné à 100" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "Recherche dans les connaissances du projet (index local d'embeddings) : renvoie les passages les plus proches de la requête — args: query, topK?.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Texte de la recherche" },
          topK: { type: "number", description: "Nombre de résultats (défaut 5, plafond 20)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Écrit (remplace intégralement) le contenu d'un fichier. Écriture atomique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Remplace une occurrence EXACTE (chaîne, pas regex) d'un texte par un autre dans un fichier.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Exécute une commande shell (sh -c) dans le répertoire de travail.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number", description: "Défaut 30000, plafond 300000" },
        },
        required: ["command"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// permissionMode
// ---------------------------------------------------------------------------

type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

function needsPermission(toolName: string, mode: PermissionMode): boolean {
  if (mode === "bypassPermissions") {
    return false;
  }
  if (mode === "acceptEdits") {
    return toolName === "bash";
  }
  return toolName === "write_file" || toolName === "edit_file" || toolName === "bash";
}

// ---------------------------------------------------------------------------
// État des runs en cours (privé à ce module — pas dans engine.ts::inFlight)
// ---------------------------------------------------------------------------

interface PermissionDecision {
  allow: boolean;
  message?: string;
}

interface PendingPermission {
  resolve: (result: PermissionDecision) => void;
}

interface RunState {
  controller: AbortController;
  pendingPermissions: Map<string, PendingPermission>;
  permCounter: number;
  aborted: boolean;
}

const runs = new Map<string, RunState>();

function denyAllPending(run: RunState, message: string): void {
  for (const pending of run.pendingPermissions.values()) {
    pending.resolve({ allow: false, message });
  }
  run.pendingPermissions.clear();
}

function requestPermission(
  id: string,
  run: RunState,
  emitter: EngineEmitter,
  toolName: string,
  toolInput: unknown,
): Promise<PermissionDecision> {
  return new Promise((resolve) => {
    run.permCounter += 1;
    const permissionId = `perm-${run.permCounter}`;
    run.pendingPermissions.set(permissionId, { resolve });
    emitter.chunk(id, { kind: "permission_request", permissionId, toolName, toolInput });

    const settleIfAborted = () => {
      if (run.pendingPermissions.delete(permissionId)) {
        resolve({ allow: false, message: "Tour interrompu" });
      }
    };
    if (run.controller.signal.aborted) {
      settleIfAborted();
    } else {
      run.controller.signal.addEventListener("abort", settleIfAborted, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Un tour HTTP (POST chat/completions stream:true) — accumulation des
// tool_calls streamés par index (voir docs/protocole, choix documenté dans le
// rapport de livraison) puis retour structuré au bouclage principal.
// ---------------------------------------------------------------------------

interface AccumulatedToolCall {
  id: string | null;
  name: string | null;
  argsText: string;
}

interface TurnUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** R0 — coût réel `usage.cost` (comptabilité d'usage OpenRouter), null si absent. */
  costUsd: number | null;
  /** R0 — tokens servis depuis le cache (`usage.prompt_tokens_details.cached_tokens`), null si absent. */
  cachedTokens: number | null;
}

interface TurnResult {
  aborted: boolean;
  errorMessage?: string;
  text: string;
  toolCalls: AccumulatedToolCall[];
  finishReason: string | null;
  usage: TurnUsage | null;
}

function extractChatUsage(obj: Record<string, unknown>): TurnUsage | null {
  const usage = obj.usage;
  if (!isPlainObject(usage)) {
    return null;
  }
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : null;
  // R6-A — usage étendu R0, extrait comme chat.send (engine.ts::extractUsage) :
  // sans le coût réel, le plafond mensuel de débord ne compte rien.
  const costUsd = isFiniteNumber(usage.cost) ? usage.cost : null;
  const details = usage.prompt_tokens_details;
  const cachedTokens =
    isPlainObject(details) && isFiniteNumber(details.cached_tokens) ? details.cached_tokens : null;
  return { promptTokens, completionTokens, costUsd, cachedTokens };
}

async function runOneTurn(opts: {
  provider: Provider;
  model: string;
  history: unknown[];
  controller: AbortController;
  emitter: EngineEmitter;
  id: string;
  /** R6-A — vrai sur un tour débordé (meta.routeDebord) : force usage.include. */
  forceUsageInclude: boolean;
  /** T-003 — allowlist résolue (`null` = palette complète) : filtre les outils DÉCLARÉS au modèle. */
  allowedTools: Set<string> | null;
}): Promise<TurnResult> {
  const { provider, model, history, controller, emitter, id, forceUsageInclude, allowedTools } = opts;

  // Filtrage à la DÉCLARATION : le modèle ne voit pas les outils qu'il n'a pas
  // le droit d'appeler (le refus à l'exécution, plus bas, n'est que le
  // garde-fou — un modèle qui invente un appel ne doit pas passer non plus).
  const declaredTools = allowedTools ? TOOLS.filter((t) => allowedTools.has(t.function.name)) : TOOLS;

  const body: Record<string, unknown> = {
    model,
    messages: history,
    stream: true,
    stream_options: { include_usage: true },
    // `tools: []` est refusé par une partie des fournisseurs : une allowlist
    // qui ne laisse rien passer se traduit par une requête SANS outil du tout.
    ...(declaredTools.length > 0 ? { tools: declaredTools, tool_choice: "auto" } : {}),
  };
  // R0/R6-A — réglages de routage OpenRouter du provider, appliqués comme dans
  // chat.send (engine.ts) : opt-in, un provider sans ces champs produit un
  // body strictement identique à avant.
  if (provider.fallbackModels?.length) {
    // modèle demandé en tête, secours ensuite, sans doublon
    body.models = [model, ...provider.fallbackModels.filter((m) => m !== model)];
  }
  if (provider.priceSort) {
    body.provider = { sort: "price" };
  }
  // R6-A — la comptabilité d'usage est demandée si le provider l'active (R0)
  // OU si le tour est un DÉBORD : le plafond mensuel se compte sur
  // `usage.cost`, il ne doit jamais dépendre d'une case à cocher du provider.
  if (provider.usageAccounting || forceUsageInclude) {
    body.usage = { include: true };
  }

  let textAcc = "";
  const toolCallsMap = new Map<number, AccumulatedToolCall>();
  let finishReason: string | null = null;
  let usage: TurnUsage | null = null;

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
    const u = extractChatUsage(obj);
    if (u) {
      usage = u;
    }
    const choices = obj.choices;
    if (Array.isArray(choices) && choices.length > 0 && isPlainObject(choices[0])) {
      const choice = choices[0];
      const delta = choice.delta;
      if (isPlainObject(delta)) {
        if (typeof delta.content === "string" && delta.content.length > 0) {
          textAcc += delta.content;
          emitter.chunk(id, { kind: "text", delta: delta.content });
        }
        const deltaToolCalls = delta.tool_calls;
        if (Array.isArray(deltaToolCalls)) {
          for (const rawTc of deltaToolCalls) {
            if (!isPlainObject(rawTc) || typeof rawTc.index !== "number") {
              continue;
            }
            const idx = rawTc.index;
            let entry = toolCallsMap.get(idx);
            if (!entry) {
              entry = { id: null, name: null, argsText: "" };
              toolCallsMap.set(idx, entry);
            }
            if (entry.id === null && typeof rawTc.id === "string") {
              entry.id = rawTc.id;
            }
            const fn = rawTc.function;
            if (isPlainObject(fn)) {
              if (entry.name === null && typeof fn.name === "string") {
                entry.name = fn.name;
              }
              if (typeof fn.arguments === "string") {
                entry.argsText += fn.arguments;
              }
            }
          }
        }
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
      return {
        aborted: false,
        errorMessage: `HTTP ${res.status} ${res.statusText}: ${errBody}`,
        text: textAcc,
        toolCalls: [],
        finishReason,
        usage,
      };
    }
    if (!res.body) {
      return {
        aborted: false,
        errorMessage: "réponse HTTP sans corps",
        text: textAcc,
        toolCalls: [],
        finishReason,
        usage,
      };
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
      const { done, value } = await reader.read();
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
      }
    }

    if (!streamDone) {
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

    const toolCalls = [...toolCallsMap.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);

    return { aborted: false, text: textAcc, toolCalls, finishReason, usage };
  } catch (err) {
    if (controller.signal.aborted) {
      return { aborted: true, text: textAcc, toolCalls: [], finishReason, usage };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      aborted: false,
      errorMessage: `erreur réseau: ${message}`,
      text: textAcc,
      toolCalls: [],
      finishReason,
      usage,
    };
  }
}

// ---------------------------------------------------------------------------
// neutral.start — boucle agentique principale
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 24;
const MAX_MAX_TURNS = 500;

export async function handleNeutralStart(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const providerId = params.providerId;
  const model = params.model;
  const cwdParam = params.cwd;
  const messagesParam = params.messages;

  if (!isNonEmptyString(providerId)) {
    emitter.error(id, "params.providerId manquant ou invalide");
    return;
  }
  const provider = getProvider(providerId);
  if (!provider) {
    emitter.error(id, `fournisseur inconnu: ${providerId}`);
    return;
  }
  if (!isNonEmptyString(model)) {
    emitter.error(id, "params.model manquant ou invalide");
    return;
  }
  if (!isNonEmptyString(cwdParam)) {
    emitter.error(id, "params.cwd manquant ou invalide");
    return;
  }
  if (!Array.isArray(messagesParam) || messagesParam.length === 0) {
    emitter.error(id, "params.messages doit être un tableau non vide");
    return;
  }
  for (const m of messagesParam) {
    if (!isPlainObject(m) || !isNonEmptyString(m.role) || !("content" in m)) {
      emitter.error(id, "chaque message doit avoir role et content");
      return;
    }
  }

  const cwd = path.resolve(cwdParam);

  const permissionModeRaw = params.permissionMode;
  const permissionMode: PermissionMode =
    permissionModeRaw === "acceptEdits" || permissionModeRaw === "bypassPermissions"
      ? permissionModeRaw
      : "default";

  const maxTurnsRaw = params.maxTurns;
  const maxTurns =
    typeof maxTurnsRaw === "number" && Number.isFinite(maxTurnsRaw) && maxTurnsRaw >= 1
      ? Math.min(Math.floor(maxTurnsRaw), MAX_MAX_TURNS)
      : DEFAULT_MAX_TURNS;

  // T-003 — allowlist `tools:` de l'agent (absente = palette complète).
  const allowedTools = resolveAllowedTools(params.tools);

  const controller = new AbortController();
  const run: RunState = { controller, pendingPermissions: new Map(), permCounter: 0, aborted: false };
  runs.set(id, run);

  const history: Record<string, unknown>[] = messagesParam.map((m) => ({ ...(m as Record<string, unknown>) }));

  emitter.chunk(id, { kind: "init", sessionId: null, model });

  // R6-A — tour débordé (meta.routeDebord) : la comptabilité d'usage est
  // forcée à chaque complétion de la boucle (voir runOneTurn) — c'est la base
  // du plafond mensuel de débord.
  const forceUsageInclude = isPlainObject(params.meta) && params.meta.routeDebord === true;

  let cumulativeInput = 0;
  let cumulativeOutput = 0;
  // R6-A — cumuls de l'usage étendu R0 sur les tours de la boucle : null tant
  // qu'aucun tour n'a rien remonté (même convention que chat.send).
  let cumulativeCostUsd: number | null = null;
  let cumulativeCachedTokens: number | null = null;
  let lastText: string | null = null;
  let finalResult: string | null = null;
  let subtype: "success" | "max_turns" | "aborted" = "success";
  let turn = 0;

  while (true) {
    if (controller.signal.aborted) {
      subtype = "aborted";
      break;
    }
    if (turn >= maxTurns) {
      subtype = "max_turns";
      finalResult = lastText;
      break;
    }
    turn++;

    const turnResult = await runOneTurn({
      provider,
      model,
      history,
      controller,
      emitter,
      id,
      forceUsageInclude,
      allowedTools,
    });

    if (turnResult.usage) {
      cumulativeInput += turnResult.usage.promptTokens ?? 0;
      cumulativeOutput += turnResult.usage.completionTokens ?? 0;
      if (turnResult.usage.costUsd !== null) {
        cumulativeCostUsd = (cumulativeCostUsd ?? 0) + turnResult.usage.costUsd;
      }
      if (turnResult.usage.cachedTokens !== null) {
        cumulativeCachedTokens = (cumulativeCachedTokens ?? 0) + turnResult.usage.cachedTokens;
      }
    }
    if (turnResult.text.length > 0) {
      lastText = turnResult.text;
    }

    if (turnResult.aborted) {
      subtype = "aborted";
      break;
    }
    if (turnResult.errorMessage) {
      denyAllPending(run, "Tour interrompu");
      runs.delete(id);
      recordUsageEvent({
        id,
        engine: "neutral",
        method: "neutral.start",
        providerId,
        model,
        promptTokens: cumulativeInput,
        completionTokens: cumulativeOutput,
        status: "error",
        // L4 — le pourquoi de l'échec, pas seulement le fait qu'il a eu lieu.
        errorMessage: turnResult.errorMessage,
        meta: params.meta,
        costUsd: cumulativeCostUsd,
        cachedTokens: cumulativeCachedTokens,
      });
      emitter.error(id, turnResult.errorMessage);
      return;
    }

    if (turnResult.toolCalls.length === 0) {
      finalResult = turnResult.text.length > 0 ? turnResult.text : lastText;
      subtype = "success";
      break;
    }

    const assistantMsg: Record<string, unknown> = {
      role: "assistant",
      content: turnResult.text.length > 0 ? turnResult.text : null,
      tool_calls: turnResult.toolCalls.map((tc, i) => ({
        id: tc.id ?? `call-${turn}-${i}`,
        type: "function",
        function: { name: tc.name ?? "unknown", arguments: tc.argsText },
      })),
    };
    history.push(assistantMsg);

    for (let i = 0; i < turnResult.toolCalls.length; i++) {
      const tc = turnResult.toolCalls[i];
      const toolUseId = tc.id ?? `call-${turn}-${i}`;
      const toolName = tc.name ?? "unknown";

      let toolInput: unknown = {};
      let argsOk = true;
      if (tc.argsText.trim().length > 0) {
        try {
          toolInput = JSON.parse(tc.argsText);
        } catch {
          argsOk = false;
        }
      }

      emitter.chunk(id, {
        kind: "tool_use",
        toolUseId,
        toolName,
        toolInput: argsOk ? toolInput : { _rawArguments: tc.argsText },
      });

      let isError: boolean;
      let resultContent: string;

      if (!argsOk) {
        isError = true;
        resultContent = `arguments JSON invalides pour l'outil ${toolName}: ${tc.argsText.slice(0, 300)}`;
      } else if (!KNOWN_TOOLS.has(toolName)) {
        isError = true;
        resultContent = `outil inconnu: ${toolName}`;
      } else if (allowedTools && !allowedTools.has(toolName)) {
        // T-003 — garde-fou : l'outil n'a pas été déclaré au modèle, mais rien
        // n'empêche un modèle de l'appeler quand même (hallucination, ou
        // historique d'un tour antérieur). Refus sec, jamais d'exécution.
        isError = true;
        resultContent = `outil non autorisé pour cet agent: ${toolName}`;
      } else if (needsPermission(toolName, permissionMode)) {
        const decision = await requestPermission(id, run, emitter, toolName, toolInput);
        if (!decision.allow) {
          isError = true;
          resultContent = decision.message ?? "Refusé par l'utilisateur";
        } else {
          const exec = await safeExecuteTool(toolName, toolInput, cwd);
          isError = exec.isError;
          resultContent = exec.content;
        }
      } else {
        const exec = await safeExecuteTool(toolName, toolInput, cwd);
        isError = exec.isError;
        resultContent = exec.content;
      }

      emitter.chunk(id, { kind: "tool_result", toolUseId, isError, summary: summarizeText(resultContent) });
      history.push({ role: "tool", tool_call_id: toolUseId, content: resultContent });

      if (run.aborted) {
        break;
      }
    }
  }

  denyAllPending(run, "Tour interrompu");
  runs.delete(id);

  const status: UsageStatus = subtype === "aborted" ? "aborted" : "done";
  recordUsageEvent({
    id,
    engine: "neutral",
    method: "neutral.start",
    providerId,
    model,
    promptTokens: cumulativeInput,
    completionTokens: cumulativeOutput,
    status,
    meta: params.meta,
    // R6-A — usage étendu R0 cumulé sur la boucle (plafond de débord).
    costUsd: cumulativeCostUsd,
    cachedTokens: cumulativeCachedTokens,
  });

  emitter.done(id, {
    sessionId: null,
    subtype,
    result: finalResult,
    usage: { inputTokens: cumulativeInput, outputTokens: cumulativeOutput },
    totalCostUsd: null,
  });
}

// ---------------------------------------------------------------------------
// neutral.permission / neutral.abort — mêmes contrats que claude.permission/abort
// ---------------------------------------------------------------------------

export function handleNeutralPermission(
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
    pending.resolve({ allow: true });
  } else {
    const message = isNonEmptyString(params.message) ? params.message : "Refusé par l'utilisateur";
    pending.resolve({ allow: false, message });
  }
  emitter.done(id, { applied: true });
}

export function handleNeutralAbort(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void {
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
  run.controller.abort();
  emitter.done(id, { aborted: true });
}
