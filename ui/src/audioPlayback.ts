/*
 * Lecture audio de la synthèse vocale, sous forme de FILE séquentielle.
 *
 * La synthèse est désormais incrémentale (voir `speechChunker.ts`) : on enfile
 * les fragments au fil de leur fabrication et ils s'enchaînent dans l'ordre,
 * sans blanc perceptible. Une SEULE file est active dans toute l'application
 * (état de module, comme l'ancienne implémentation) : en démarrer une nouvelle
 * arrête proprement la précédente et déclenche son `onFinished`.
 *
 * POINT CRITIQUE — `onFinished` est appelé EXACTEMENT UNE FOIS, dans TOUS les
 * cas de sortie : fin naturelle, `stop()`, remplacement par une autre file,
 * fragment illisible, échec de lecture. Le mode conversation coupe le micro
 * pendant la lecture et ne le rouvre que sur ce rappel : une file qui ne se
 * termine jamais bloque l'écoute définitivement. Tout passe donc par l'unique
 * fonction `finish()`, protégée par le drapeau `finished`, et aucun autre
 * chemin n'appelle `onFinished`.
 *
 * Autre invariant : toute URL blob créée est révoquée — y compris celle des
 * fragments jamais joués parce que la file a été arrêtée avant d'y arriver.
 *
 * `startPlayback` / `stopPlayback` restent exportés avec leur sémantique
 * d'origine (des appelants existants s'en servent) ; ils sont réimplémentés
 * au-dessus de la file.
 */

/** Un fragment audio prêt à jouer : élément `Audio` déjà construit et préchargé. */
interface QueueItem {
  audio: HTMLAudioElement;
  url: string;
  /** Évite qu'un `onended` et un `onerror` fassent avancer la file deux fois. */
  consumed: boolean;
}

interface QueueCallbacks {
  onStarted?: () => void;
  onFinished: () => void;
  onError: (message: string) => void;
}

interface QueueState {
  callbacks: QueueCallbacks;
  /** Fragments en attente, dans l'ordre. */
  pending: QueueItem[];
  /** Fragment en cours de lecture (ou de démarrage). */
  current: QueueItem | null;
  /** `end()` a été appelé : plus aucun fragment ne viendra. */
  ended: boolean;
  /** `finish()` est passé : la file est morte, `onFinished` a été émis. */
  finished: boolean;
  /** Une lecture est en cours ou en cours de démarrage. */
  busy: boolean;
  /** `onStarted` n'est émis qu'une fois, au tout premier son. */
  announced: boolean;
}

export interface PlaybackQueueHandle {
  /** Enfile un fragment déjà synthétisé. Ignoré après `end()` ou `stop()`. */
  push(audioBase64: string, mime: string): void;
  /** Plus aucun fragment ne viendra : la file se terminera d'elle-même. */
  end(): void;
  /** Arrêt immédiat, vide la file et libère tout. */
  stop(): void;
  /** La file est-elle encore active (en lecture ou en attente de fragments) ? */
  isActive(): boolean;
}

/** File unique de l'application. */
let activeQueue: QueueState | null = null;

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || "audio/wav" });
}

/** Détache les handlers, met en pause et révoque l'URL blob. Idempotent. */
function release(item: QueueItem): void {
  item.audio.onended = null;
  item.audio.onerror = null;
  try {
    item.audio.pause();
  } catch {
    // Un `pause()` sur un élément déjà détruit ne doit rien empêcher.
  }
  URL.revokeObjectURL(item.url);
}

/**
 * Seule et unique sortie de la file. Libère tout (fragment courant ET fragments
 * jamais joués — sinon leurs URL blob fuiraient), puis émet `onFinished`. Les
 * appels ultérieurs sont sans effet : c'est ce qui garantit l'unicité du rappel.
 */
function finish(queue: QueueState): void {
  if (queue.finished) return;
  queue.finished = true;
  queue.busy = false;

  if (activeQueue === queue) activeQueue = null;

  // `consumed` est posé sur tous les fragments restants : une promesse `play()`
  // encore en vol ne pourra donc plus émettre d'`onError` après `onFinished`.
  if (queue.current) {
    queue.current.consumed = true;
    release(queue.current);
    queue.current = null;
  }
  for (const item of queue.pending) {
    item.consumed = true;
    release(item);
  }
  queue.pending = [];

  queue.callbacks.onFinished();
}

/**
 * Passe au fragment suivant. Si la file est vide, deux cas : `end()` a été
 * reçu → la file se termine ; sinon elle se met en sommeil (`busy = false`) et
 * c'est le prochain `push()` qui la relancera.
 */
function playNext(queue: QueueState): void {
  if (queue.finished) return;

  const item = queue.pending.shift();
  if (!item) {
    queue.busy = false;
    queue.current = null;
    if (queue.ended) finish(queue);
    return;
  }

  queue.busy = true;
  queue.current = item;

  // Avance au fragment suivant, au plus une fois par fragment.
  const advance = (): void => {
    if (item.consumed) return;
    item.consumed = true;
    if (queue.current === item) queue.current = null;
    release(item);
    playNext(queue);
  };

  item.audio.onended = advance;
  item.audio.onerror = () => {
    // Un fragment illisible ne condamne pas les suivants : on signale et on
    // continue. Si c'était le dernier, `playNext` terminera la file
    // normalement — `onFinished` reste garanti.
    if (!item.consumed) queue.callbacks.onError("Fragment audio illisible, ignoré.");
    advance();
  };

  void item.audio
    .play()
    .then(() => {
      if (queue.finished || queue.announced) return;
      queue.announced = true;
      queue.callbacks.onStarted?.();
    })
    .catch((err: unknown) => {
      if (!item.consumed) {
        queue.callbacks.onError(
          `Lecture audio impossible : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      advance();
    });
}

/**
 * Démarre une file de lecture. Arrête d'abord la file précédente, dont le
 * `onFinished` est alors émis.
 *
 * - `onStarted` : le tout premier son commence (au plus une fois).
 * - `onFinished` : exactement une fois, à la fin normale (`end()` reçu et tout
 *   joué), sur `stop()`, sur remplacement, ou après un échec total.
 * - `onError` : incident non fatal sur un fragment ; la file continue.
 */
export function startPlaybackQueue(callbacks: QueueCallbacks): PlaybackQueueHandle {
  stopPlaybackQueue();

  const queue: QueueState = {
    callbacks,
    pending: [],
    current: null,
    ended: false,
    finished: false,
    busy: false,
    announced: false,
  };
  activeQueue = queue;

  return {
    push(audioBase64: string, mime: string): void {
      // Après `end()` ou `stop()`, un `push()` est ignoré silencieusement :
      // l'appelant peut avoir une synthèse en vol au moment où l'utilisateur
      // coupe la lecture, ce n'est pas une erreur.
      if (queue.finished || queue.ended) return;

      let url: string;
      try {
        url = URL.createObjectURL(base64ToBlob(audioBase64, mime));
      } catch (err) {
        queue.callbacks.onError(
          `Audio illisible (base64 invalide) : ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      const audio = new Audio(url);
      // Préchargement : le fragment suivant est construit et chargé pendant que
      // le courant joue, pour que le basculement soit inaudible.
      audio.preload = "auto";
      audio.load();

      queue.pending.push({ audio, url, consumed: false });

      // Relance si la file dormait : soit elle n'a jamais démarré, soit elle a
      // épuisé ses fragments sans avoir encore reçu `end()`.
      if (!queue.busy) playNext(queue);
    },

    end(): void {
      if (queue.finished || queue.ended) return;
      queue.ended = true;
      // Rien en vol et rien en attente : la file se termine tout de suite.
      if (!queue.busy && queue.pending.length === 0) finish(queue);
    },

    stop(): void {
      finish(queue);
    },

    isActive(): boolean {
      return !queue.finished;
    },
  };
}

/** Arrête la file en cours (no-op sinon). Son `onFinished` est appelé. */
function stopPlaybackQueue(): void {
  const current = activeQueue;
  if (current) finish(current);
}

/** Arrête la lecture en cours (no-op sinon). Le `onEnded` de la lecture arrêtée est appelé. */
export function stopPlayback(): void {
  stopPlaybackQueue();
}

/**
 * Joue un audio synthétisé unique — compatibilité avec l'API d'origine,
 * réimplémentée au-dessus de la file.
 *
 * `onEnded` est appelé exactement une fois, à la fin naturelle, sur
 * `stopPlayback()` ou si une autre lecture prend la place — mais PAS si la
 * promesse rejette (le lancement a alors échoué, l'appelant gère son propre
 * état d'erreur).
 */
export function startPlayback(
  audioBase64: string,
  mime: string,
  onEnded: () => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // « pending » tant que le son n'a pas démarré ; « failed » si l'échec est
    // survenu avant le démarrage. C'est ce qui décide, à la fin de la file, si
    // l'on honore `onEnded` ou si l'on rejette.
    let phase: "pending" | "started" | "failed" = "pending";
    let failure = "Lecture audio impossible.";

    const handle = startPlaybackQueue({
      onStarted: () => {
        phase = "started";
        resolve();
      },
      onError: (message) => {
        if (phase === "pending") {
          phase = "failed";
          failure = message;
        }
      },
      onFinished: () => {
        if (phase === "started") onEnded();
        else reject(new Error(failure));
      },
    });

    handle.push(audioBase64, mime);
    handle.end();
  });
}
