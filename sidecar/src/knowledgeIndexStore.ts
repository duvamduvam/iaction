/*
 * Index sur disque du RAG local — `<cwd>/.iaction/connaissances-index/`
 * (`chunks.jsonl` + `meta.json`, voir knowledge.ts). Ce module ne connaît
 * QUE le format de ces deux fichiers : où ils vivent, comment les lire
 * défensivement (une ligne difforme est ignorée, jamais une exception), et
 * le cache mémoire qui évite de les reparser à chaque recherche.
 *
 * Sorti de knowledge.ts (cliquet de taille) : c'est une couche de
 * persistance à faible couplage — l'indexation (embeddings, chunking) et la
 * recherche (cosinus) n'ont besoin que de ce que ce module expose, jamais de
 * son détail interne (format des lignes, cache).
 */
import { promises as fsp } from "node:fs";
import path from "node:path";
import { isNonEmptyString, isPlainObject } from "./base.js";
import { projectDir } from "./appPaths.js";

/** Dossier de l'index d'un projet : `<cwd>/.iaction/connaissances-index/`. */
export function indexDir(cwd: string): string {
  return projectDir(cwd, "connaissances-index");
}

export interface IndexChunk {
  file: string;
  chunkId: string;
  mtimeMs: number;
  text: string;
  embedding: number[];
}

export interface IndexMeta {
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

export async function loadMeta(cwd: string): Promise<IndexMeta | null> {
  try {
    const raw = await fsp.readFile(path.join(indexDir(cwd), "meta.json"), "utf8");
    return parseMeta(raw);
  } catch {
    return null;
  }
}

/**
 * Index chargé, gardé en mémoire tant que le fichier n'a pas changé.
 *
 * Sans ce cache, CHAQUE recherche relisait et re-parsait l'index entier —
 * texte ET vecteurs. Mesuré sur un projet réel : 13 Mo pour 747 chunks, soit
 * 100-200 ms et 747 tableaux de doubles alloués puis jetés, à chaque appel.
 * Un agent fait 2 à 5 recherches par tour : sur une session de plusieurs
 * heures, cela représente des centaines de Mo de churn et une latence d'outil
 * parfaitement inutile, pour un fichier qui ne change qu'à la réindexation.
 *
 * Clé de fraîcheur : (mtime, taille) du fichier. Une réindexation réécrit
 * chunks.jsonl et invalide donc le cache d'elle-même — aucun couplage à
 * maintenir entre l'indexation et la recherche.
 *
 * Un seul projet en cache : le cas d'usage est une session de travail sur un
 * projet à la fois, et garder N index de 13 Mo en mémoire coûterait plus cher
 * que la relecture qu'on évite.
 */
let indexCache: { chemin: string; mtimeMs: number; taille: number; chunks: IndexChunk[] } | null = null;

/** Lecture défensive de chunks.jsonl : une ligne difforme est ignorée. */
export async function loadChunks(cwd: string): Promise<IndexChunk[]> {
  const chemin = path.join(indexDir(cwd), "chunks.jsonl");

  let signature: { mtimeMs: number; taille: number } | null = null;
  try {
    const stat = await fsp.stat(chemin);
    signature = { mtimeMs: stat.mtimeMs, taille: stat.size };
  } catch {
    // Index absent : on laisse la lecture ci-dessous rendre [] comme avant.
  }

  if (
    signature &&
    indexCache &&
    indexCache.chemin === chemin &&
    indexCache.mtimeMs === signature.mtimeMs &&
    indexCache.taille === signature.taille
  ) {
    return indexCache.chunks;
  }

  let raw: string;
  try {
    raw = await fsp.readFile(chemin, "utf8");
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

  // Mise en cache seulement si le fichier a pu être daté : sans signature, on
  // ne saurait pas détecter sa prochaine modification, et un cache qu'on ne
  // sait pas invalider est pire que pas de cache du tout.
  if (signature) {
    indexCache = { chemin, mtimeMs: signature.mtimeMs, taille: signature.taille, chunks };
  }
  return chunks;
}

/** L'index du projet existe-t-il ? (gate de l'outil MCP côté moteur Claude.) */
export async function knowledgeIndexExists(cwd: string): Promise<boolean> {
  return (await loadMeta(cwd)) !== null;
}
