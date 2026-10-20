/*
 * Client typé des méthodes `knowledge.*` du protocole (RAG local des
 * connaissances de projet — R5, voir docs/protocol.md).
 *
 * Sorti de `sidecar.ts` (cliquet de taille) : ces deux helpers sont
 * exactement ceux que consomme le panneau Connaissances (useConnaissances.ts)
 * — même patron que `consoClient.ts`.
 */
import { request } from "./sidecar";

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
 *
 * `force` (T-115, défaut false) : ignore la réutilisation par mtime, tout est
 * ré-embarqué — c'est la RÉPARATION que pose le bouton « Reconstruire
 * l'index » (voir docs/protocol.md, `knowledge.index`). L'auto-réindexation
 * de fond (useConnaissances.ts) ne le passe jamais : elle reste incrémentale.
 */
export async function knowledgeIndex(
  cwd: string,
  pinned: string[],
  onProgress?: (progress: KnowledgeIndexProgress) => void,
  force = false,
): Promise<KnowledgeIndexResult> {
  const { done } = request(
    "knowledge.index",
    { cwd, ...(pinned.length > 0 ? { pinned } : {}), ...(force ? { force: true } : {}) },
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
