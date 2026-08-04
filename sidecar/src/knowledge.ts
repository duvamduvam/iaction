/**
 * RAG local des connaissances projet — Lot 14, phase R5 (docs/spec-r5-rag.md).
 *
 * Index d'embeddings par projet dans `<projet>/.iaction/connaissances-index/`
 * (`chunks.jsonl` + `meta.json`), construit depuis les MÊMES sources que le
 * panneau Connaissances de la page Projets : documents épinglés (chemins
 * fournis par l'UI — l'état `project-knowledge` vit côté UI, voir
 * ui/src/AgentPage.tsx), dossier `.iaction/connaissances/` (« Automatiques »)
 * et sources détectées (CLAUDE.md, `.claude/memory/*.md`). Le dossier
 * d'index lui-même n'est JAMAIS une source (index ≠ document).
 *
 * Embeddings via l'API NATIVE Ollama (`POST /api/embed`, dérivation
 * `ollamaNativeBase` d'engine.ts), modèle configurable dans la config routage
 * (`router.set`, champ `embeddings` — voir router.ts::getEmbeddingsConfig).
 * Recherche : cosinus brute-force en JS — corpus locaux petits (< 10 k
 * chunks), pas de SQLite, zéro dépendance nouvelle.
 *
 * L'outil `search_knowledge` est exposé aux DEUX moteurs (« tous agents à
 * égalité ») : palette du moteur neutre (neutralAgent.ts, via
 * `searchKnowledge`/`formatSearchResults`) et serveur MCP in-process du
 * moteur Claude (`buildKnowledgeMcpServer`, consommé par claude.ts).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import {
  buildHeaders,
  getProvider,
  joinUrl,
  ollamaNativeBase,
  readBoundedBody,
  type EngineEmitter,
} from "./engine.js";
import * as journal from "./journal.js";
import { getEmbeddingsConfig } from "./router.js";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Taille visée d'un chunk (caractères) — spec R5 §1. */
export const CHUNK_SIZE = 1000;
/** Recouvrement entre chunks consécutifs (caractères), coupé aux frontières de lignes. */
export const CHUNK_OVERLAP = 200;

/** Lots d'embeddings envoyés à /api/embed (spec R5 §1 : ~32). */
const EMBED_BATCH_SIZE = 32;
/** Chargement à froid du modèle d'embeddings : patron OLLAMA_LOAD_TIMEOUT_MS (engine.ts). */
const EMBED_TIMEOUT_MS = 10 * 60 * 1000;

/** Un document source plus gros n'est pas une « connaissance » : ignoré (log stderr). */
const MAX_SOURCE_BYTES = 1024 * 1024;

/** topK par défaut / plafond de knowledge.search. */
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;

/** Erreur lisible quand l'index n'existe pas (spec R5 §2). */
const INDEX_ABSENT_MESSAGE = "index absent — lancer l'indexation";

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dossier de l'index d'un projet : `<cwd>/.iaction/connaissances-index/`. */
function indexDir(cwd: string): string {
  return path.join(path.resolve(cwd), ".iaction", "connaissances-index");
}

/** Écriture atomique (même patron que neutralAgent.ts::atomicWriteFile). */
async function atomicWriteFile(absPath: string, content: string): Promise<void> {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, absPath);
}

// ---------------------------------------------------------------------------
// Chunking — fonction pure (testée unitairement, spec R5 §5.1)
// ---------------------------------------------------------------------------

/**
 * Découpe un texte en chunks d'~CHUNK_SIZE caractères, coupés aux frontières
 * de lignes, avec un recouvrement d'au plus CHUNK_OVERLAP caractères (les
 * dernières lignes entières du chunk précédent). Une ligne isolée plus longue
 * qu'un chunk est découpée en dur (frontière de ligne impossible), sans
 * recouvrement autour de ces morceaux. Texte vide/blanc → aucun chunk.
 */
export function chunkText(text: string): string[] {
  if (text.trim().length === 0) {
    return [];
  }
  if (text.length <= CHUNK_SIZE) {
    return [text];
  }

  // Lignes AVEC leur "\n" final (lookbehind : conserve les séparateurs).
  const lines = text.split(/(?<=\n)/);
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  /** Au moins une ligne nouvelle (hors recouvrement) dans `current`. */
  let hasNew = false;

  const closeChunk = (withOverlap: boolean) => {
    if (!hasNew || currentLen === 0) {
      current = [];
      currentLen = 0;
      hasNew = false;
      return;
    }
    chunks.push(current.join(""));
    // Recouvrement : reprend les dernières lignes entières (≤ CHUNK_OVERLAP).
    const overlap: string[] = [];
    let overlapLen = 0;
    if (withOverlap) {
      for (let i = current.length - 1; i >= 0; i--) {
        const l = current[i];
        if (overlapLen + l.length > CHUNK_OVERLAP) break;
        overlap.unshift(l);
        overlapLen += l.length;
      }
    }
    current = overlap;
    currentLen = overlapLen;
    hasNew = false;
  };

  for (const line of lines) {
    if (line.length > CHUNK_SIZE) {
      // Ligne monstrueuse : on clôt le chunk courant puis découpe en dur.
      closeChunk(false);
      for (let i = 0; i < line.length; i += CHUNK_SIZE) {
        chunks.push(line.slice(i, i + CHUNK_SIZE));
      }
      continue;
    }
    if (currentLen + line.length > CHUNK_SIZE && hasNew) {
      closeChunk(true);
      // Le recouvrement seul peut déjà déborder avec la nouvelle ligne : on
      // l'accepte (chunk légèrement > CHUNK_SIZE plutôt que de casser la ligne).
    }
    current.push(line);
    currentLen += line.length;
    hasNew = true;
  }
  closeChunk(false);

  return chunks;
}

// ---------------------------------------------------------------------------
// Cosinus + topK — fonctions pures (spec R5 §5.2)
// ---------------------------------------------------------------------------

/** Similarité cosinus de deux vecteurs — 0 si dimensions incompatibles ou norme nulle. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface SearchResult {
  file: string;
  excerpt: string;
  score: number;
}

/**
 * Classe les chunks par similarité cosinus décroissante avec l'embedding de
 * la requête et renvoie les `topK` premiers (score arrondi à 4 décimales).
 */
export function rankChunks(
  queryEmbedding: number[],
  chunks: Array<{ file: string; text: string; embedding: number[] }>,
  topK: number,
): SearchResult[] {
  return chunks
    .map((chunk) => ({
      file: chunk.file,
      excerpt: chunk.text,
      score: Math.round(cosineSimilarity(queryEmbedding, chunk.embedding) * 10000) / 10000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, topK));
}

// ---------------------------------------------------------------------------
// Collecte des sources — mêmes origines que le panneau Connaissances
// ---------------------------------------------------------------------------

interface SourceFile {
  abs: string;
  /** Chemin relatif au projet (clé de meta.files et champ `file` des chunks). */
  label: string;
  mtimeMs: number;
}

/** Fichiers (non-dossiers) d'un répertoire, non récursif — [] si absent/illisible.
    Les liens symboliques sont retenus tels quels : collectSources re-stat chaque
    candidat (en suivant le lien) et écarte ce qui n'est pas un fichier. */
async function listFilesIn(dirAbs: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dirAbs, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() || e.isSymbolicLink())
      .map((e) => path.join(dirAbs, e.name));
  } catch {
    return [];
  }
}

/**
 * Collecte les sources de connaissances du projet, dans l'ordre du panneau :
 * épinglées (chemins fournis par l'UI), automatiques (`.iaction/
 * connaissances/`), détectées (CLAUDE.md + `.claude/memory/*.md`) —
 * dédoublonnées par chemin (le premier gagne, comme `dedupDocsByPath` côté
 * UI), le dossier d'index exclu, fichiers existants seulement. Best effort :
 * un chemin illisible est simplement ignoré.
 */
async function collectSources(cwd: string, pinned: string[]): Promise<SourceFile[]> {
  const cwdAbs = path.resolve(cwd);
  const candidates: string[] = [];

  for (const p of pinned) {
    candidates.push(path.resolve(cwdAbs, p));
  }
  candidates.push(...(await listFilesIn(path.join(cwdAbs, ".iaction", "connaissances"))));
  candidates.push(path.join(cwdAbs, "CLAUDE.md"));
  candidates.push(
    ...(await listFilesIn(path.join(cwdAbs, ".claude", "memory"))).filter((p) => p.endsWith(".md")),
  );

  const indexDirAbs = indexDir(cwd);
  const seen = new Set<string>();
  const sources: SourceFile[] = [];
  for (const abs of candidates) {
    if (seen.has(abs)) continue;
    seen.add(abs);
    // L'index n'est jamais un document (spec R5 : critère d'acceptation).
    if (abs === indexDirAbs || abs.startsWith(indexDirAbs + path.sep)) continue;
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const rel = path.relative(cwdAbs, abs);
    sources.push({ abs, label: rel.startsWith("..") ? abs : rel, mtimeMs: stat.mtimeMs });
  }
  return sources;
}

/**
 * Lit un fichier source en texte UTF-8 — `null` si binaire (octet nul dans
 * les premiers 8 Ko, même détection que neutralAgent.ts::toolReadFile),
 * non-UTF-8, trop gros ou illisible. Jamais d'exception.
 */
async function readTextSource(abs: string, sizeBytes: number): Promise<string | null> {
  if (sizeBytes > MAX_SOURCE_BYTES) {
    // `warn` : l'indexation continue sans cette source — dégradation acceptée.
    journal.warn("knowledge", "source ignorée (trop grosse)", {
      fields: { fichier: abs, octets: sizeBytes, plafond: MAX_SOURCE_BYTES },
    });
    return null;
  }
  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(abs);
  } catch {
    return null;
  }
  const checkLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) {
      return null;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Embeddings — API NATIVE Ollama POST /api/embed
// ---------------------------------------------------------------------------

type EmbedResult = { ok: true; embeddings: number[][]; model: string } | { ok: false; message: string };

/**
 * Embed une liste de textes par lots de EMBED_BATCH_SIZE via le provider de
 * la config routage (`embeddings`). Toute erreur — provider non déclaré,
 * HTTP, réseau, timeout, réponse difforme — renvoie un message français
 * lisible, jamais d'exception.
 */
async function embedTexts(texts: string[]): Promise<EmbedResult> {
  const config = getEmbeddingsConfig();
  const provider = getProvider(config.providerId);
  if (!provider) {
    return {
      ok: false,
      message: `fournisseur d'embeddings inconnu: ${config.providerId} — déclarer le fournisseur (providers.set) ou ajuster la config routage (embeddings)`,
    };
  }

  const embeddings: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    try {
      const res = await fetch(joinUrl(ollamaNativeBase(provider.baseUrl), "api/embed"), {
        method: "POST",
        headers: buildHeaders(provider, { "Content-Type": "application/json" }),
        body: JSON.stringify({ model: config.model, input: batch }),
        // Timeout long : le premier appel peut charger le modèle à froid.
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await readBoundedBody(res);
        return { ok: false, message: `embeddings (${config.model}) : HTTP ${res.status} ${res.statusText}: ${body}` };
      }
      const json = (await res.json()) as unknown;
      const rawEmbeddings = isPlainObject(json) ? json.embeddings : undefined;
      if (
        !Array.isArray(rawEmbeddings) ||
        rawEmbeddings.length !== batch.length ||
        !rawEmbeddings.every((e) => Array.isArray(e) && e.every((v) => typeof v === "number"))
      ) {
        return { ok: false, message: "réponse /api/embed inattendue (forme inconnue)" };
      }
      embeddings.push(...(rawEmbeddings as number[][]));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message: `embeddings (${config.model}) : erreur réseau: ${message}` };
    }
  }
  return { ok: true, embeddings, model: config.model };
}

// ---------------------------------------------------------------------------
// Index sur disque — chunks.jsonl + meta.json
// ---------------------------------------------------------------------------

interface IndexChunk {
  file: string;
  chunkId: string;
  mtimeMs: number;
  text: string;
  embedding: number[];
}

interface IndexMeta {
  model: string;
  dim: number;
  builtAt: string;
  files: Record<string, number>;
}

function parseMeta(raw: string): IndexMeta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || !isNonEmptyString(parsed.model) || !isPlainObject(parsed.files)) {
    return null;
  }
  const files: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed.files)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      files[key] = value;
    }
  }
  return {
    model: parsed.model,
    dim: typeof parsed.dim === "number" && Number.isFinite(parsed.dim) ? parsed.dim : 0,
    builtAt: isNonEmptyString(parsed.builtAt) ? parsed.builtAt : "",
    files,
  };
}

async function loadMeta(cwd: string): Promise<IndexMeta | null> {
  try {
    const raw = await fsp.readFile(path.join(indexDir(cwd), "meta.json"), "utf8");
    return parseMeta(raw);
  } catch {
    return null;
  }
}

/** Lecture défensive de chunks.jsonl : une ligne difforme est ignorée. */
async function loadChunks(cwd: string): Promise<IndexChunk[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(path.join(indexDir(cwd), "chunks.jsonl"), "utf8");
  } catch {
    return [];
  }
  const chunks: IndexChunk[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      isPlainObject(parsed) &&
      isNonEmptyString(parsed.file) &&
      isNonEmptyString(parsed.chunkId) &&
      typeof parsed.mtimeMs === "number" &&
      typeof parsed.text === "string" &&
      Array.isArray(parsed.embedding) &&
      parsed.embedding.every((v) => typeof v === "number")
    ) {
      chunks.push({
        file: parsed.file,
        chunkId: parsed.chunkId,
        mtimeMs: parsed.mtimeMs,
        text: parsed.text,
        embedding: parsed.embedding as number[],
      });
    }
  }
  return chunks;
}

/** L'index du projet existe-t-il ? (gate de l'outil MCP côté moteur Claude.) */
export async function knowledgeIndexExists(cwd: string): Promise<boolean> {
  return (await loadMeta(cwd)) !== null;
}

// ---------------------------------------------------------------------------
// Recherche interne — réutilisée par knowledge.search ET les outils des moteurs
// ---------------------------------------------------------------------------

export type KnowledgeSearchOutcome =
  | { ok: true; results: SearchResult[] }
  | { ok: false; message: string };

/** Borne topK : entier 1..MAX_TOP_K, défaut DEFAULT_TOP_K. */
export function sanitizeTopK(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1) {
    return Math.min(Math.floor(value), MAX_TOP_K);
  }
  return DEFAULT_TOP_K;
}

/**
 * Recherche dans l'index du projet : embed de la requête + cosinus brute-force.
 * Index absent/vide → erreur lisible (spec R5 §2), jamais d'exception.
 */
export async function searchKnowledge(
  cwd: string,
  query: string,
  topK: number,
): Promise<KnowledgeSearchOutcome> {
  const meta = await loadMeta(cwd);
  const chunks = meta ? await loadChunks(cwd) : [];
  if (!meta || chunks.length === 0) {
    return { ok: false, message: INDEX_ABSENT_MESSAGE };
  }
  const embedded = await embedTexts([query]);
  if (!embedded.ok) {
    return embedded;
  }
  return { ok: true, results: rankChunks(embedded.embeddings[0], chunks, topK) };
}

/** Rendu textuel des résultats, commun aux deux moteurs (tool_result lisible par le modèle). */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "Aucun résultat dans les connaissances indexées.";
  }
  return results.map((r) => `--- ${r.file} (score ${r.score}) ---\n${r.excerpt}`).join("\n\n");
}

// ---------------------------------------------------------------------------
// Serveur MCP in-process du moteur Claude (spec R5 §3) — construit via
// createSdkMcpServer/tool du Agent SDK, exposé `mcp__iaction__search_knowledge`.
// ---------------------------------------------------------------------------

/**
 * Construit le serveur MCP `iaction` (outil `search_knowledge`) pour un
 * projet — `null` si l'index n'existe pas (outil activé seulement quand
 * l'index existe), en mode faux SDK (tests : le SDK réel ne doit jamais être
 * importé, voir claude.ts::resolveQueryFn) ou si le SDK est indisponible
 * (best effort, log stderr). Import dynamique : le SDK n'est chargé qu'au
 * besoin, comme dans claude.ts.
 */
export async function buildKnowledgeMcpServer(cwd: string): Promise<unknown | null> {
  if (process.env.IACTION_FAKE_CLAUDE === "1") {
    return null;
  }
  if (!(await knowledgeIndexExists(cwd))) {
    return null;
  }
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { z } = await import("zod/v4");
    const searchTool = sdk.tool(
      "search_knowledge",
      "Recherche dans les connaissances du projet (index local d'embeddings) — args: query, topK?",
      {
        query: z.string().describe("Texte de la recherche"),
        topK: z.number().optional().describe(`Nombre de résultats (défaut ${DEFAULT_TOP_K})`),
      },
      async (args) => {
        const outcome = await searchKnowledge(cwd, args.query, sanitizeTopK(args.topK));
        if (!outcome.ok) {
          return { content: [{ type: "text" as const, text: outcome.message }], isError: true };
        }
        return { content: [{ type: "text" as const, text: formatSearchResults(outcome.results) }] };
      },
    );
    return sdk.createSdkMcpServer({ name: "iaction", tools: [searchTool] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `warn` : l'agent tourne sans l'outil de recherche documentaire.
    journal.warn("knowledge", "serveur MCP search_knowledge indisponible", {
      fields: { erreur: message },
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// knowledge.index — indexation incrémentale (spec R5 §2)
// ---------------------------------------------------------------------------

/** `pinned` : liste souple de chemins (chaînes non vides seulement). */
function sanitizePinned(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isNonEmptyString);
}

export async function handleKnowledgeIndex(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwd = params.cwd;
  if (!isNonEmptyString(cwd)) {
    emitter.error(id, "params.cwd manquant ou invalide");
    return;
  }
  const pinned = sanitizePinned(params.pinned);

  const sources = await collectSources(cwd, pinned);
  const config = getEmbeddingsConfig();

  // Incrémental : les chunks existants ne sont réutilisables que si le modèle
  // d'embeddings n'a pas changé (des vecteurs de modèles différents ne sont
  // pas comparables) — sinon reconstruction complète.
  const previousMeta = await loadMeta(cwd);
  const reusable = previousMeta && previousMeta.model === config.model ? previousMeta : null;
  const previousByFile = new Map<string, IndexChunk[]>();
  if (reusable) {
    for (const chunk of await loadChunks(cwd)) {
      const list = previousByFile.get(chunk.file);
      if (list) {
        list.push(chunk);
      } else {
        previousByFile.set(chunk.file, [chunk]);
      }
    }
  }

  const total = sources.length;
  const nextChunks: IndexChunk[] = [];
  const files: Record<string, number> = {};
  let done = 0;
  let dim = 0;

  for (const source of sources) {
    const previous = previousByFile.get(source.label);
    if (reusable && previous && reusable.files[source.label] === source.mtimeMs) {
      // mtime inchangé : chunks conservés tels quels, aucun ré-embedding.
      nextChunks.push(...previous);
    } else {
      const text = await readTextSource(source.abs, await sizeOf(source.abs));
      if (text !== null) {
        const parts = chunkText(text);
        if (parts.length > 0) {
          const embedded = await embedTexts(parts);
          if (!embedded.ok) {
            emitter.error(id, embedded.message);
            return;
          }
          for (let i = 0; i < parts.length; i++) {
            nextChunks.push({
              file: source.label,
              chunkId: `${source.label}#${i}`,
              mtimeMs: source.mtimeMs,
              text: parts[i],
              embedding: embedded.embeddings[i],
            });
          }
        }
      }
      // Fichier binaire/trop gros : inscrit quand même dans `files` (0 chunk),
      // pour ne pas le re-tenter à chaque indexation ni le signaler `stale`.
    }
    files[source.label] = source.mtimeMs;
    done += 1;
    emitter.chunk(id, { file: source.label, done, total });
  }

  for (const chunk of nextChunks) {
    if (chunk.embedding.length > 0) {
      dim = chunk.embedding.length;
      break;
    }
  }

  const meta: IndexMeta = { model: config.model, dim, builtAt: new Date().toISOString(), files };
  const dir = indexDir(cwd);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await atomicWriteFile(
      path.join(dir, "chunks.jsonl"),
      nextChunks.map((c) => JSON.stringify(c)).join("\n") + (nextChunks.length > 0 ? "\n" : ""),
    );
    await atomicWriteFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, `écriture de l'index impossible: ${message}`);
    return;
  }

  emitter.done(id, { files: total, chunks: nextChunks.length, model: config.model });
}

/** Taille d'un fichier (octets) — 0 si illisible (readTextSource échouera de toute façon). */
async function sizeOf(abs: string): Promise<number> {
  try {
    return (await fsp.stat(abs)).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// knowledge.search
// ---------------------------------------------------------------------------

export async function handleKnowledgeSearch(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwd = params.cwd;
  const query = params.query;
  if (!isNonEmptyString(cwd)) {
    emitter.error(id, "params.cwd manquant ou invalide");
    return;
  }
  if (!isNonEmptyString(query) || query.trim().length === 0) {
    emitter.error(id, "params.query manquant ou invalide");
    return;
  }
  const outcome = await searchKnowledge(cwd, query, sanitizeTopK(params.topK));
  if (!outcome.ok) {
    emitter.error(id, outcome.message);
    return;
  }
  emitter.done(id, { results: outcome.results });
}

// ---------------------------------------------------------------------------
// knowledge.status
// ---------------------------------------------------------------------------

export async function handleKnowledgeStatus(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwd = params.cwd;
  if (!isNonEmptyString(cwd)) {
    emitter.error(id, "params.cwd manquant ou invalide");
    return;
  }
  const meta = await loadMeta(cwd);
  if (!meta) {
    emitter.done(id, { exists: false, files: 0, chunks: 0, model: null, builtAt: null, stale: false });
    return;
  }

  const chunks = await loadChunks(cwd);
  // `stale` : un document source a changé (mtime différent), est apparu
  // (absent de meta.files) ou a disparu depuis la construction de l'index.
  const sources = await collectSources(cwd, sanitizePinned(params.pinned));
  const sourceLabels = new Set(sources.map((s) => s.label));
  const stale =
    sources.some((s) => meta.files[s.label] !== s.mtimeMs) ||
    Object.keys(meta.files).some((label) => !sourceLabels.has(label));

  emitter.done(id, {
    exists: true,
    files: Object.keys(meta.files).length,
    chunks: chunks.length,
    model: meta.model,
    builtAt: meta.builtAt || null,
    stale,
  });
}
