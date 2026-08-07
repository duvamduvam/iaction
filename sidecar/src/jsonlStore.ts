/**
 * Primitives JSONL partagées — socle L1 (voir docs/etude-logs.md § 1.1 et 2.2,
 * docs/protocol.md sections « Méthodes S1 » et « Méthodes L1 »).
 *
 * Ces quatre primitives étaient privées à `usageStats.ts`, qui les déclarait
 * lui-même « dupliquées depuis orchestrator.ts/taches.ts ». Le journal
 * applicatif (`journal.ts`) a besoin des MÊMES garanties que `usage/` : append
 * sérialisé, écriture qui ne rejette jamais, lecture tolérante, lecture par la
 * fin, rotation à 20 Mo → `.1`. Les factoriser ici évite une troisième copie —
 * et surtout garantit qu'`app.jsonl` et `events.jsonl` se comportent
 * exactement pareil face à un disque plein ou à une ligne difforme.
 *
 * Règle de fond, valable pour tous les appelants : RIEN ici ne doit faire
 * échouer un appel métier. Toute erreur d'écriture finit dans le rappel
 * `onWriteError` de l'appelant, jamais en exception remontée ; toute erreur de
 * lecture rend une liste vide.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Utilitaires (dupliqués depuis orchestrator.ts/taches.ts — non exportés là-bas)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Répertoire racine (lu à chaque appel — jamais mis en cache)
// ---------------------------------------------------------------------------

/**
 * `${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction` — relu à chaque appel,
 * jamais mis en cache (même convention que orchestrator.ts/taches.ts : les
 * tests redéfinissent XDG_CONFIG_HOME et doivent être suivis).
 */
export { globalConfigRoot } from "./appPaths.js";

// ---------------------------------------------------------------------------
// Convention d'id interne `<runId>::<stepId>`
// ---------------------------------------------------------------------------

/**
 * Ids de corrélation portés par un id de requête de la forme
 * `<runId>::<stepId>` (voir orchestrator.ts, buildStepStartParams/
 * stepRunner.start). Même convention pour `events.jsonl`
 * (orchRunId/orchStepId) et pour `app.jsonl` (runId/stepId) : un seul point
 * de vérité, sinon les deux journaux ne se recoupent plus.
 */
export function parseCorrelationIds(id: unknown): { runId: string | null; stepId: string | null } {
  if (!isNonEmptyString(id)) {
    return { runId: null, stepId: null };
  }
  const idx = id.lastIndexOf("::");
  if (idx === -1) {
    return { runId: null, stepId: null };
  }
  const runId = id.slice(0, idx);
  const stepId = id.slice(idx + 2);
  if (runId.length === 0 || stepId.length === 0) {
    return { runId: null, stepId: null };
  }
  return { runId, stepId };
}

// ---------------------------------------------------------------------------
// Append + rotation (20 Mo, un seul niveau .1)
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 20 * 1024 * 1024;

export async function appendJsonlWithRotation(filePath: string, line: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });

  let size = 0;
  try {
    size = (await fsp.stat(filePath)).size;
  } catch {
    size = 0;
  }
  if (size > MAX_FILE_SIZE) {
    const rotated = `${filePath}.1`;
    try {
      await fsp.rm(rotated, { force: true });
    } catch {
      // best effort : un .1 illisible/verrouillé ne doit pas bloquer la rotation.
    }
    try {
      await fsp.rename(filePath, rotated);
    } catch {
      // best effort : si le rename échoue, on continue et on append au fichier existant.
    }
  }

  await fsp.appendFile(filePath, line + "\n", "utf8");
}

/**
 * File d'écriture partagée par TOUS les fichiers JSONL du sidecar
 * (events.jsonl, claude-windows.jsonl, app.jsonl confondus — écritures peu
 * fréquentes, la sérialisation évite tout entrelacement de lignes en cas
 * d'appels concurrents) sans jamais rejeter côté appelant.
 *
 * `onWriteError` appartient à l'appelant : `usageStats.ts` y journalise un
 * `error` de scope `usage`, tandis que `journal.ts` DOIT y retomber sur un
 * `console.error` brut — se journaliser soi-même sur un échec d'écriture du
 * journal bouclerait à l'infini. Le rappel est lui-même protégé : un rappel
 * qui lève ne casse pas la file.
 */
let writeQueue: Promise<void> = Promise.resolve();

export function enqueueWrite(
  filePath: string,
  line: string,
  onWriteError: (err: unknown) => void,
): void {
  writeQueue = writeQueue.then(
    () => appendJsonlWithRotation(filePath, line),
    () => appendJsonlWithRotation(filePath, line),
  ).catch((err) => {
    try {
      onWriteError(err);
    } catch {
      // Le rapport d'erreur a lui-même échoué : plus rien à tenter ici.
    }
  });
}

/**
 * Attend que la file d'écriture soit vidée. À appeler AVANT de terminer le
 * process : `enqueueWrite` rend la main immédiatement (c'est tout l'intérêt —
 * une journalisation ne doit jamais ralentir un tour), donc un `process.exit()`
 * franc jette les lignes encore en vol. Or les dernières lignes avant un arrêt
 * sont précisément celles qui expliquent un plantage : les perdre viderait le
 * journal d'une bonne part de son intérêt (docs/etude-logs.md § 1.3 c).
 *
 * Ne rejette jamais. L'attente est reprise tant que de nouvelles écritures
 * s'empilent pendant le vidage, dans la limite de quelques tours — au-delà,
 * c'est qu'une boucle écrit en continu, et mieux vaut sortir que pendre.
 */
export async function flushWrites(maxTours = 5): Promise<void> {
  for (let i = 0; i < maxTours; i++) {
    const attendue = writeQueue;
    try {
      await attendue;
    } catch {
      // enqueueWrite absorbe déjà ses erreurs ; ceinture et bretelles.
    }
    // Rien ne s'est ajouté pendant l'attente : la file est réellement vide.
    if (writeQueue === attendue) {
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Lecture tolérante (une ligne illisible est ignorée)
// ---------------------------------------------------------------------------

export async function readJsonlTolerant(filePath: string): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const obj: unknown = JSON.parse(trimmed);
      if (isPlainObject(obj)) {
        out.push(obj);
      }
    } catch {
      // ligne illisible : ignorée (tolérance documentée).
    }
  }
  return out;
}

/** Taille du bloc lu en FIN de fichier par readJsonlTail (la dernière ligne y tient largement). */
export const TAIL_READ_BYTES = 64 * 1024;

/**
 * R6-A — lecture JSONL PAR LA FIN : n'ouvre que le dernier bloc du fichier.
 * claude-windows.jsonl peut approcher 20 Mo avant rotation, et le chemin chaud
 * du routeur (décision de débord à chaque envoi) ne veut que la DERNIÈRE ligne
 * valide — un parse intégral serait payé à chaque tour. Même besoin pour
 * `log.read`/`log.stats` (L1), avec une fenêtre plus large. Une première ligne
 * tronquée par la découpe est naturellement ignorée (JSON invalide, même
 * tolérance que readJsonlTolerant).
 *
 * `truncated` : vrai quand la fenêtre n'a PAS couvert tout le fichier — c'est
 * l'information que `log.read` renvoie à l'UI pour dire « il y a plus vieux ».
 */
export async function readJsonlTailWithInfo(
  filePath: string,
  maxBytes = TAIL_READ_BYTES,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  let fh;
  try {
    fh = await fsp.open(filePath, "r");
  } catch {
    return { rows: [], truncated: false };
  }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) {
      return { rows: [], truncated: false };
    }
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, start);
    const rows: Record<string, unknown>[] = [];
    for (const line of buffer.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        const obj: unknown = JSON.parse(trimmed);
        if (isPlainObject(obj)) {
          rows.push(obj);
        }
      } catch {
        // ligne illisible ou tronquée par la découpe : ignorée.
      }
    }
    return { rows, truncated: start > 0 };
  } catch {
    return { rows: [], truncated: false };
  } finally {
    await fh.close();
  }
}

/** Variante sans l'indicateur de troncature (chemin chaud du routeur). */
export async function readJsonlTail(
  filePath: string,
  maxBytes = TAIL_READ_BYTES,
): Promise<Record<string, unknown>[]> {
  return (await readJsonlTailWithInfo(filePath, maxBytes)).rows;
}
