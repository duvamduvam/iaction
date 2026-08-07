/*
 * Voix du composeur, partagée par les pages « Chat » et « Projets ».
 *
 * Ce hook est le DÉPLACEMENT (et non la réécriture) de la logique vocale
 * écrite à l'origine dans ChatPage.tsx : dictée ponctuelle au micro, mode
 * conversation mains libres (écoute → transcription → envoi → réponse →
 * lecture → retour à l'écoute), garde-fous et exclusion mutuelle. Les deux
 * pages en consomment la MÊME instance de code, pour ne jamais diverger.
 *
 * ── Ce que le hook ne sait pas ──────────────────────────────────────────
 * Il ignore tout de la page qui l'utilise : il reçoit une fonction d'envoi
 * (`send`, qui ne doit résoudre qu'à la FIN du tour), un moyen de compter les
 * messages du fil (`turnCount`, pour détecter qu'un envoi n'est pas parti) et
 * un moyen de lire la dernière réponse de l'assistant (`lastReplyText`). Le
 * reste — bulles, tours, sessions, moteurs — ne le regarde pas.
 *
 * ── Envoi par mot-clé (« envoie ») ──────────────────────────────────────
 * Deux façons de déclencher l'envoi à la voix (voir sendKeyword.ts) :
 * - Mode conversation, réglage `sendMode: "keyword"` : chaque segment
 *   transcrit est AJOUTÉ AU BROUILLON du composeur au lieu de partir ; quand
 *   un segment se termine par le mot-clé, tout le brouillon accumulé (dicté
 *   ET tapé au clavier, récupéré via `takeDraft`) part d'un coup. Le mode
 *   « silence » — chaque phrase close par un silence part immédiatement —
 *   reste le défaut.
 * - Dictée ponctuelle (bouton micro) : TOUJOURS active, réglage ou pas — une
 *   transcription qui se termine par le mot-clé envoie directement le
 *   brouillon + le texte dicté, au lieu de tout laisser en brouillon.
 *
 * ── Une seule voix à la fois dans toute l'application ───────────────────
 * `voiceConversation.ts` et `audioCapture.ts` sont des singletons au niveau
 * module (un seul flux micro). Les pages, elles, restent MONTÉES en
 * permanence (masquées en CSS, voir App.tsx) : deux instances de ce hook
 * coexistent donc toujours. Un registre module-level (`conversationOwner`)
 * garantit qu'une seule peut détenir le mode conversation, et l'autre refuse
 * poliment en nommant la page qui l'occupe.
 *
 * ── Quitter la page arrête le mode conversation ─────────────────────────
 * Choix délibéré (voir `pageVisible`) : un micro ouvert sur une page qu'on ne
 * voit plus est à la fois un problème de confidentialité (aucun indicateur
 * d'état sous les yeux) et une source de surprise (des messages partiraient
 * dans un fil invisible). On coupe donc franchement, avec un message qui
 * explique pourquoi. La dictée ponctuelle, elle, n'est pas interrompue : elle
 * est courte, explicitement armée par l'utilisateur, et son texte atterrit
 * dans le brouillon de la page — l'arrêter perdrait l'enregistrement.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { startRecording, stopRecording } from "./audioCapture";
import { startPlaybackQueue, stopPlayback } from "./audioPlayback";
import { DEFAULT_SEND_KEYWORD, matchSendKeyword } from "./sendKeyword";
import {
  formatSpeechProgress,
  speechSynthesize,
  speechTranscribe,
  type SpeechConversationConfig,
  type SpeechProgress,
} from "./speechAdmin";
import { splitForSpeech } from "./speechChunker";
import {
  isConversationActive,
  setExternalActivity,
  startConversation,
  stopConversation,
  type ConversationState,
} from "./voiceConversation";

export type { ConversationState };

/** Réglages du mode conversation (bloc `conversation` de la config voix). */
export type ConversationSettings = SpeechConversationConfig;

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  sensitivity: 0.5,
  silenceMs: 900,
  maxUtteranceMs: 30000,
  autoPlayReply: true,
  sendMode: "silence",
  sendKeyword: DEFAULT_SEND_KEYWORD,
};

/** Libellés de l'indicateur d'état — lisibles en permanence pendant le mode conversation. */
export const CONVERSATION_STATE_LABELS: Record<ConversationState, string> = {
  idle: "En veille",
  calibrating: "Calibrage…",
  listening: "À l'écoute",
  speaking: "Vous parlez…",
  transcribing: "Transcription…",
  thinking: "Réponse…",
  playing: "Lecture…",
};

/**
 * Garde-fou d'inactivité : sans le moindre segment parlé pendant 5 minutes, le
 * mode conversation s'arrête tout seul — un micro ouvert toute la nuit n'a
 * aucun intérêt et pose un vrai problème de confidentialité.
 */
const CONVERSATION_IDLE_LIMIT_MS = 5 * 60 * 1000;
const CONVERSATION_IDLE_CHECK_MS = 30 * 1000;
/** Durée d'affichage d'un message discret (segment ignoré) puis d'un message d'arrêt. */
const CONVERSATION_NOTICE_MS = 4000;
const CONVERSATION_STOP_NOTICE_MS = 9000;
/**
 * Filet de sécurité de la lecture : si le `onEnded` du lecteur ne vient jamais
 * (fin d'audio manquée, flux corrompu), l'écoute serait suspendue pour
 * toujours — on la relâche d'office au bout de ce délai.
 */
const CONVERSATION_PLAYBACK_WATCHDOG_MS = 5 * 60 * 1000;
/** Attente maximale de la fin d'un tour déjà en cours avant d'envoyer la parole captée. */
const CONVERSATION_BUSY_TIMEOUT_MS = 2 * 60 * 1000;
/** Petit délai laissé à React pour publier les entrées du tour qui vient de finir. */
const CONVERSATION_COMMIT_DELAY_MS = 60;

function conversationSleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/*
 * Nettoyage grossier du Markdown avant synthèse vocale : les blocs de code
 * n'ont aucun sens lus à voix haute (remplacés par une mention courte), et le
 * balisage inline (gras, backticks, titres) est simplement retiré.
 */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " (bloc de code) ")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/* ---------- Synthèse pipelinée ---------- */

/**
 * Période d'échantillonnage du texte en cours d'écriture pendant un tour. 250 ms
 * est un compromis : assez fin pour attaquer la synthèse dès la première phrase,
 * assez lâche pour que le découpage (pur, mais non gratuit) reste négligeable.
 */
const STREAM_SAMPLE_MS = 250;

/**
 * Longueur du repère de resynchronisation gardé derrière le curseur de
 * streaming (voir `createSpeechCursor`).
 */
const CURSOR_TAIL_CHARS = 48;

export interface SpeechPipelineCallbacks {
  /** Le tout premier son commence (au plus une fois). */
  onStarted?: () => void;
  /** Fin de la lecture — appelé EXACTEMENT une fois, quel que soit le chemin. */
  onFinished: () => void;
  /** Incident non fatal (fragment perdu, audio illisible) : la lecture continue. */
  onError?: (message: string) => void;
  /** Progression de la synthèse du fragment courant. */
  onProgress?: (p: SpeechProgress) => void;
}

export interface SpeechPipeline {
  /** Ajoute des fragments à synthétiser, dans l'ordre. Ignoré après `end()`/`stop()`. */
  enqueue(chunks: string[]): void;
  /** Plus aucun fragment ne viendra : la lecture se termine d'elle-même. */
  end(): void;
  /** Arrêt immédiat : annule les synthèses restantes et coupe le son. */
  stop(): void;
}

/**
 * Chaîne « synthèse → lecture » pipelinée : les fragments sont synthétisés
 * SÉQUENTIELLEMENT (une requête en vol au plus — dix appels parallèles seraient
 * coûteux et desserviraient l'ordre) et poussés dans la file de lecture au fur
 * et à mesure. Le premier fragment se joue donc pendant que le deuxième se
 * fabrique : le délai avant le premier son ne dépend plus de la longueur totale.
 *
 * Garanties, dans cet ordre d'importance :
 *  1. `onFinished` est émis exactement une fois. Il est ENTIÈREMENT délégué à la
 *     file de lecture (`audioPlayback.ts`), qui l'assure déjà dans tous ses cas
 *     de sortie — y compris « aucun fragment poussé puis `end()` » et
 *     « remplacée par une autre lecture ». Aucun autre chemin ne l'appelle.
 *  2. Un arrêt annule vraiment le travail restant : `cancelled` coupe la boucle
 *     de synthèse, aucune requête réseau inutile ne se poursuit.
 *  3. Un fragment dont la synthèse échoue n'annule pas les suivants ; on ne
 *     déclare l'échec que si RIEN n'a pu être joué.
 */
export function startSpeechPipeline(callbacks: SpeechPipelineCallbacks): SpeechPipeline {
  const queue: string[] = [];
  let ended = false;
  let cancelled = false;
  let running = false;
  /** Au moins un fragment a atteint la file de lecture. */
  let played = false;
  /** Dernière erreur de synthèse, signalée seulement si rien n'a pu être joué. */
  let lastError = "";

  const playback = startPlaybackQueue({
    onStarted: () => callbacks.onStarted?.(),
    onError: (message) => callbacks.onError?.(message),
    onFinished: () => {
      // Sortie unique : la file est morte, plus rien ne doit être synthétisé.
      cancelled = true;
      queue.length = 0;
      if (!played && lastError) callbacks.onError?.(lastError);
      callbacks.onFinished();
    },
  });

  /**
   * Boucle de synthèse. Une seule instance tourne à la fois (`running`) : c'est
   * ce qui garantit à la fois l'ordre des fragments et l'unicité de la requête
   * en vol.
   */
  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    while (!cancelled) {
      const chunk = queue.shift();
      if (chunk === undefined) break;
      try {
        const { audioBase64, mime } = await speechSynthesize(chunk, callbacks.onProgress);
        // L'utilisateur a pu couper pendant la requête : ne pas enfiler un son
        // qui n'a plus lieu d'être.
        if (cancelled) break;
        playback.push(audioBase64, mime);
        played = true;
      } catch (err) {
        // Fragment perdu : on passe au suivant plutôt que de sacrifier toute la
        // réponse. Le trou s'entend beaucoup moins qu'un silence complet.
        lastError = `Synthèse d'un fragment impossible : ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    running = false;
    // `end()` a pu arriver pendant une synthèse : c'est ici qu'on le honore.
    if (ended && !cancelled && queue.length === 0) playback.end();
  };

  return {
    enqueue(chunks: string[]): void {
      if (cancelled || ended) return;
      for (const chunk of chunks) {
        if (chunk.trim()) queue.push(chunk);
      }
      void pump();
    },
    end(): void {
      if (cancelled || ended) return;
      ended = true;
      // Si la boucle tourne encore, c'est elle qui appellera `playback.end()`.
      if (!running) playback.end();
    },
    stop(): void {
      cancelled = true;
      queue.length = 0;
      playback.stop();
    },
  };
}

/**
 * Curseur de progression dans le texte NETTOYÉ d'une réponse en cours
 * d'écriture.
 *
 * ── Pourquoi un curseur plutôt qu'un simple `splitForSpeech` du texte total ──
 * `splitForSpeech` est recalculé à chaque échantillon sur un texte qui grandit,
 * et ses frontières NE SONT PAS stables : l'agrégation vise `minChars` et borne
 * à `maxChars`, donc l'arrivée d'une phrase peut parfaitement faire basculer une
 * phrase déjà émise dans le fragment suivant. Comparer les listes successives
 * ferait rejouer ou sauter du texte.
 *
 * La stratégie retenue supprime le problème à la racine : on ne redécoupe JAMAIS
 * ce qui a déjà été émis. Le curseur mémorise la position atteinte, et chaque
 * échantillon n'appelle `splitForSpeech` que sur le RELIQUAT. Les frontières
 * déjà consommées sont donc figées par construction.
 *
 * Second piège, plus discret : `stripMarkdownForSpeech` n'est pas tout à fait
 * stable par préfixe (un `` ` `` orphelin reste tel quel jusqu'à ce que son
 * jumeau arrive, et disparaît alors — décalant tout d'un caractère). On garde
 * donc un court repère de texte derrière le curseur ; s'il ne correspond plus,
 * on se recale dessus par recherche.
 */
interface SpeechCursor {
  /** Reliquat non encore émis, curseur recalé si besoin. Chaîne vide si rien de neuf. */
  remaining(spoken: string): string;
  /** Enregistre que `count` fragments de `remaining` viennent d'être émis. */
  consume(spoken: string, chunks: string[], count: number): void;
}

function createSpeechCursor(): SpeechCursor {
  let index = 0;
  let tail = "";

  return {
    remaining(spoken: string): string {
      if (index === 0) return spoken;
      if (spoken.slice(Math.max(0, index - tail.length), index) !== tail) {
        const at = tail ? spoken.indexOf(tail) : -1;
        if (at < 0) {
          // Texte réécrit de fond en comble (cas non nominal) : on préfère ne
          // plus rien émettre que risquer de relire un passage déjà lu.
          return "";
        }
        index = at + tail.length;
      }
      return spoken.slice(index);
    },
    consume(spoken: string, chunks: string[], count: number): void {
      const rest = spoken.slice(index);
      index += contentEndIndex(rest, chunks, count);
      tail = spoken.slice(Math.max(0, index - CURSOR_TAIL_CHARS), index);
    },
  };
}

/**
 * Position (index exclu) dans `source` de la fin des `count` premiers
 * `chunks`.
 *
 * On ne peut pas additionner les longueurs : `splitForSpeech` normalise les
 * blancs (un « \n\n » du texte devient une simple espace dans le fragment). On
 * réaligne donc caractère non blanc par caractère non blanc, en tolérant tout
 * écart intermédiaire — un appariement en sous-séquence, qui retombe toujours
 * sur la bonne position tant que l'ordre du contenu est préservé (ce que
 * `splitForSpeech` garantit).
 */
function contentEndIndex(source: string, chunks: string[], count: number): number {
  let i = 0;
  for (let c = 0; c < count; c += 1) {
    const chunk = chunks[c];
    for (let j = 0; j < chunk.length; j += 1) {
      const ch = chunk[j];
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") continue;
      while (i < source.length && source[i] !== ch) i += 1;
      if (i >= source.length) return source.length;
      i += 1;
    }
  }
  return i;
}

/* ---------- Registre : une seule page peut tenir le mode conversation ---------- */

/**
 * Libellé de la page qui détient actuellement le mode conversation, `null` si
 * personne. Module-level à dessein : c'est le pendant, côté UI, du singleton
 * de `voiceConversation.ts`. Sans lui, la seconde page recevrait un « Le mode
 * conversation est déjà actif » sans savoir d'où il vient.
 */
let conversationOwner: string | null = null;

export type MicState = "idle" | "recording" | "transcribing";

export interface UseVoiceComposerOptions {
  /** Nom de la page, tel qu'il apparaît dans les messages de conflit (« Chat », « Projets »). */
  pageLabel: string;
  /**
   * La page est-elle celle affichée ? Les pages restent montées quand on change
   * d'onglet : passer à `false` arrête le mode conversation de cette page.
   */
  pageVisible: boolean;
  /** Micro choisi dans Configuration › Dictée (vide = défaut système). */
  micDeviceId: string;
  /** Réglages « Mode conversation » de la config voix. */
  conversation: ConversationSettings;
  /**
   * Envoi d'un message par le composeur de la page. DOIT être asynchrone et ne
   * résoudre qu'à la FIN du tour : c'est ce qui permet d'enchaîner la lecture
   * de la réponse puis la reprise de l'écoute.
   */
  send: (text: string) => Promise<void>;
  /** Un tour est-il déjà en cours ? Lue en boucle : doit toujours être fraîche. */
  isBusy: () => boolean;
  /** Nombre de messages/tours du fil — sert uniquement à détecter qu'un envoi n'est pas parti. */
  turnCount: () => number;
  /** Texte lisible de la dernière réponse de l'assistant, `null` si rien à lire. */
  lastReplyText: () => string | null;
  /**
   * FACULTATIF — texte de la réponse de l'assistant EN COURS D'ÉCRITURE, `null`
   * si aucun tour n'est en train de s'écrire. Fourni, il permet de commencer à
   * lire pendant que le modèle rédige encore, au lieu d'attendre la fin du tour
   * (c'est l'essentiel du gain de latence). Une page qui ne sait pas exposer son
   * flux l'omet simplement : la lecture reste pipelinée, mais démarre à la fin
   * du tour.
   *
   * Doit rendre le MÊME texte que `lastReplyText` rendra une fois le tour
   * terminé (mêmes blocs, même nettoyage) : le reliquat de fin est calculé par
   * différence avec ce qui a déjà été lu.
   */
  streamingReplyText?: () => string | null;
  /** Message affiché quand l'envoi n'est pas parti (la raison dépend de la page). */
  notSentNotice: string;
  /** Ajoute le texte dicté au brouillon du composeur (jamais un remplacement). */
  appendToDraft: (text: string) => void;
  /**
   * Rend le brouillon courant du composeur et le VIDE. Sert à l'envoi par
   * mot-clé : ce qui part est exactement ce que l'utilisateur voit dans le
   * composeur (dicté ET tapé).
   */
  takeDraft: () => string;
  /** Rend le curseur au composeur après une dictée. */
  focusComposer?: () => void;
}

export interface VoiceComposer {
  /* Dictée ponctuelle */
  micState: MicState;
  micError: string | null;
  dismissMicError: () => void;
  micProgress: string;
  micLevel: number;
  micLabel: string;
  onMicClick: () => void;

  /* Mode conversation */
  conversationOn: boolean;
  conversationState: ConversationState;
  conversationLevel: number;
  /**
   * Seuil d'ouverture COURANT de la détection d'activité vocale (même échelle
   * RMS que `conversationLevel`). Affiché comme repère sur la jauge : c'est ce
   * qui permet à l'utilisateur de voir d'un coup d'œil si sa voix passe
   * au-dessus du seuil, au lieu de rester devant un « À l'écoute » muet.
   */
  conversationThreshold: number;
  conversationNotice: string;
  conversationLabel: string;
  onToggleConversation: () => void;
}

export function useVoiceComposer(options: UseVoiceComposerOptions): VoiceComposer {
  // Dictée au micro (voir audioCapture.ts / speech.transcribe) : repos →
  // enregistrement (re-clic pour arrêter) → transcription (bouton désactivé),
  // puis le texte reconnu est AJOUTÉ au brouillon.
  const [micState, setMicState] = useState<MicState>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const [micProgress, setMicProgress] = useState("");
  // Niveau capté en direct (RMS 0→1), remonté ~10 fois par seconde par
  // audioCapture : il pilote l'intensité du halo du bouton micro, pour qu'on
  // voie IMMÉDIATEMENT que le micro capte quelque chose.
  const [micLevel, setMicLevel] = useState(0);

  // Mode conversation (voir voiceConversation.ts) : écoute → transcription →
  // envoi → réponse → lecture → retour à l'écoute, en boucle. Exclusif avec la
  // dictée ponctuelle ci-dessus (un seul flux micro à la fois).
  const [conversationOn, setConversationOn] = useState(false);
  const [conversationState, setConversationState] = useState<ConversationState>("idle");
  const [conversationLevel, setConversationLevel] = useState(0);
  // Seuil de déclenchement courant, remonté par la même notification que le
  // niveau. Il n'est PAS constant : la calibration initiale n'est plus
  // définitive, le plancher de bruit est suivi en continu (voir
  // voiceConversation.ts). L'exposer est le seul moyen pour l'utilisateur de
  // constater qu'il parle « sous » le seuil plutôt que de subir un silence
  // inexpliqué.
  const [conversationThreshold, setConversationThreshold] = useState(0);
  // Message discret et éphémère (segment ignoré, arrêt automatique…) : ce
  // n'est PAS une erreur, il ne doit donc pas emprunter `micError`.
  const [conversationNotice, setConversationNotice] = useState("");

  // Refs : les rappels passés à `startConversation` sont capturés une fois pour
  // toutes, ils ne doivent lire que des refs (jamais un état périmé).
  const conversationOnRef = useRef(false);
  const conversationNoticeTimerRef = useRef<number | null>(null);
  const conversationWatchdogRef = useRef<number | null>(null);
  const conversationLastSpeechRef = useRef(0);
  const micStateRef = useRef<MicState>("idle");
  micStateRef.current = micState;

  // Accès « toujours frais » aux options : le mode conversation réutilise
  // l'envoi du composeur de la page, il ne duplique aucune logique d'envoi.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  /** Message discret et éphémère sous le composeur — jamais présenté comme une erreur. */
  const showConversationNotice = useCallback((message: string, durationMs = CONVERSATION_NOTICE_MS) => {
    if (conversationNoticeTimerRef.current !== null) {
      window.clearTimeout(conversationNoticeTimerRef.current);
    }
    setConversationNotice(message);
    conversationNoticeTimerRef.current = window.setTimeout(() => {
      conversationNoticeTimerRef.current = null;
      setConversationNotice("");
    }, durationMs);
  }, []);

  /**
   * Relâche l'activité externe : l'écoute peut reprendre. Idempotent, et appelé
   * depuis TOUS les chemins de sortie (fin de lecture, échec de synthèse, tour
   * en erreur, arrêt) — c'est le point unique qui garantit qu'on ne laisse
   * jamais l'écoute suspendue indéfiniment.
   */
  const releaseConversationActivity = useCallback(() => {
    if (conversationWatchdogRef.current !== null) {
      window.clearTimeout(conversationWatchdogRef.current);
      conversationWatchdogRef.current = null;
    }
    setExternalActivity(null);
  }, []);

  /** Arrêt du mode conversation (re-clic, erreur fatale, inactivité, changement de page, démontage). */
  const stopConversationMode = useCallback(
    (reason?: string) => {
      conversationOnRef.current = false;
      setConversationOn(false);
      setConversationState("idle");
      setConversationLevel(0);
      setConversationThreshold(0);
      stopPlayback();
      releaseConversationActivity();
      try {
        stopConversation();
      } catch {
        // best effort : un arrêt qui échoue ne doit pas casser l'UI
      }
      if (conversationOwner === optionsRef.current.pageLabel) conversationOwner = null;
      if (reason) showConversationNotice(reason, CONVERSATION_STOP_NOTICE_MS);
    },
    [releaseConversationActivity, showConversationNotice],
  );

  /**
   * Arme la chaîne « synthèse → lecture » de la réponse. Appelée au PREMIER
   * fragment prêt, éventuellement bien avant la fin du tour.
   *
   * Le rappel de fin du pipeline est `releaseConversationActivity` : c'est lui
   * qui rouvre le micro, et `audioPlayback.ts` garantit qu'il tombe exactement
   * une fois, y compris si la lecture est coupée ou remplacée.
   */
  const armReplyPipeline = useCallback((): SpeechPipeline => {
    // Filet armé AVANT la lecture ; le rappel de fin le désamorce en relâchant.
    conversationWatchdogRef.current = window.setTimeout(
      releaseConversationActivity,
      CONVERSATION_PLAYBACK_WATCHDOG_MS,
    );
    return startSpeechPipeline({
      // L'écoute est déjà suspendue depuis « Réponse… » : ce n'est ici qu'un
      // changement de libellé, au moment où le son démarre vraiment.
      onStarted: () => setExternalActivity("playing"),
      onError: (message) => showConversationNotice(message),
      onFinished: releaseConversationActivity,
    });
  }, [releaseConversationActivity, showConversationNotice]);

  /** Attend la fin d'un tour déjà en cours (message tapé au clavier pendant l'écoute). */
  const waitForIdleTurn = useCallback(async (): Promise<boolean> => {
    const deadline = Date.now() + CONVERSATION_BUSY_TIMEOUT_MS;
    while (optionsRef.current.isBusy()) {
      if (!conversationOnRef.current || Date.now() > deadline) return false;
      await conversationSleep(200);
    }
    return conversationOnRef.current;
  }, []);

  /**
   * Un tour complet du mode conversation : la parole captée part comme un
   * message ordinaire (`send`, exactement comme le bouton Envoyer), puis la
   * réponse est lue si le réglage `autoPlayReply` est actif.
   *
   * ── Où se joue le délai avant le premier son ────────────────────────────
   * Deux attentes étaient jusqu'ici mises bout à bout : la fin COMPLÈTE de la
   * réponse, puis la synthèse COMPLÈTE du texte entier. Les deux sont désormais
   * pipelinées : on échantillonne la réponse pendant qu'elle s'écrit, on
   * synthétise les fragments dès qu'ils sont complets, et le premier se joue
   * pendant que les suivants se fabriquent.
   */
  const runConversationTurn = useCallback(
    async (text: string) => {
      setExternalActivity("thinking");
      if (!(await waitForIdleTurn())) {
        showConversationNotice("Tour précédent trop long : segment abandonné.");
        releaseConversationActivity();
        return;
      }
      const countBefore = optionsRef.current.turnCount();

      // Lecture automatique : décidée une fois pour toute la durée du tour, pour
      // ne pas se retrouver avec une lecture à moitié armée si le réglage change
      // en cours de route.
      const autoPlay = optionsRef.current.conversation.autoPlayReply;
      const streamText = optionsRef.current.streamingReplyText;

      // Boîte plutôt que variable simple : le pipeline est armé depuis une
      // fermeture (`harvest`), et l'analyse de flot de TypeScript ne suit pas
      // ces affectations sur une variable locale.
      const speech: { pipeline: SpeechPipeline | null } = { pipeline: null };
      const cursor = createSpeechCursor();

      /**
       * Émet les fragments désormais acquis. En cours d'écriture (`final` faux),
       * le DERNIER fragment est délibérément gardé : le texte peut encore
       * s'allonger et le compléter. À la fin du tour, tout part.
       */
      const harvest = (raw: string, final: boolean): void => {
        const spoken = stripMarkdownForSpeech(raw);
        const rest = cursor.remaining(spoken);
        if (!rest) return;
        const chunks = splitForSpeech(rest);
        const ready = final ? chunks.length : chunks.length - 1;
        if (ready <= 0) return;
        cursor.consume(spoken, chunks, ready);
        speech.pipeline ??= armReplyPipeline();
        speech.pipeline.enqueue(chunks.slice(0, ready));
      };

      /** Sortie sans lecture (ou lecture avortée) : l'écoute doit reprendre. */
      const abandon = (): void => {
        // `stop()` coupe le son ET annule les synthèses restantes ; son rappel
        // de fin relâche l'écoute. Sans pipeline, on relâche directement.
        if (speech.pipeline) speech.pipeline.stop();
        else releaseConversationActivity();
      };

      // Échantillonnage du texte en cours d'écriture. Ne tourne que si la page
      // sait l'exposer ET que la lecture automatique est demandée : sans lui, on
      // retombe sur l'unique récolte finale ci-dessous.
      let sampler: number | null = null;
      if (autoPlay && streamText) {
        sampler = window.setInterval(() => {
          if (!conversationOnRef.current) return;
          const raw = streamText();
          if (raw) harvest(raw, false);
        }, STREAM_SAMPLE_MS);
      }

      try {
        await optionsRef.current.send(text);
      } catch {
        // La page inscrit déjà l'erreur dans le message concerné.
      } finally {
        if (sampler !== null) window.clearInterval(sampler);
      }

      // L'envoi publie ses entrées par setState : on laisse React commettre
      // avant de relire le fil.
      await conversationSleep(CONVERSATION_COMMIT_DELAY_MS);
      if (optionsRef.current.turnCount() === countBefore) {
        // Rien n'est parti (fournisseur, modèle ou projet manquant) : on le
        // dit, on REND le texte au brouillon — en mode mot-clé il a été pris
        // par `takeDraft`, le perdre serait un échec muet — et surtout on
        // relâche l'écoute.
        optionsRef.current.appendToDraft(text);
        showConversationNotice(optionsRef.current.notSentNotice);
        abandon();
        return;
      }
      const reply = optionsRef.current.lastReplyText();
      if (!conversationOnRef.current || !autoPlay) {
        // Mode arrêté entre-temps ou lecture désactivée : rien à lire, et
        // surtout pas de synthèse qui continuerait dans le vide.
        abandon();
        return;
      }
      // Reliquat : la réponse complète fait autorité, le curseur ne laisse
      // repartir que ce qui n'a pas déjà été lu. Tour en erreur (`reply` nul) :
      // on ferme simplement ce qui a pu être lu en cours de route.
      if (reply) harvest(reply, true);
      // Fin de la fourniture. Si rien n'a jamais pu être découpé (réponse vide
      // ou sans rien de prononçable), aucun pipeline n'existe : c'est ici, et
      // seulement ici, qu'on relâche l'écoute à la main.
      if (speech.pipeline) speech.pipeline.end();
      else releaseConversationActivity();
    },
    [armReplyPipeline, releaseConversationActivity, showConversationNotice, waitForIdleTurn],
  );

  /** Bouton « Mode conversation » : démarrage / arrêt (exclusif avec la dictée ponctuelle). */
  const toggleConversation = useCallback(async () => {
    if (conversationOnRef.current) {
      stopConversationMode();
      return;
    }
    if (micStateRef.current !== "idle") return;
    // Exclusion mutuelle entre les deux pages : elles restent montées toutes
    // les deux, mais le micro et la machine à états sont uniques.
    const { pageLabel } = optionsRef.current;
    if (conversationOwner !== null && conversationOwner !== pageLabel) {
      showConversationNotice(
        `Le mode conversation tourne déjà dans la page « ${conversationOwner} » — arrêtez-le là-bas avant de le lancer ici.`,
        CONVERSATION_STOP_NOTICE_MS,
      );
      return;
    }
    setMicError(null);
    setConversationLevel(0);
    setConversationThreshold(0);
    setConversationState("calibrating");
    conversationLastSpeechRef.current = Date.now();
    conversationOnRef.current = true;
    conversationOwner = pageLabel;
    setConversationOn(true);
    const settings = optionsRef.current.conversation;
    try {
      await startConversation(
        {
          deviceId: optionsRef.current.micDeviceId,
          sensitivity: settings.sensitivity,
          silenceMs: settings.silenceMs,
          maxUtteranceMs: settings.maxUtteranceMs,
        },
        {
          onState: (state) => {
            setConversationState(state);
            // Toute parole détectée repousse le garde-fou d'inactivité.
            if (state === "speaking") conversationLastSpeechRef.current = Date.now();
          },
          onLevel: (rms, threshold) => {
            setConversationLevel(rms);
            setConversationThreshold(threshold);
          },
          onUtterance: (text) => {
            conversationLastSpeechRef.current = Date.now();
            const trimmed = text.trim();
            if (!trimmed || !conversationOnRef.current) return;
            // Réglage relu À CHAQUE segment (jamais la valeur capturée au
            // démarrage) : un changement de mode en cours de session est pris
            // en compte immédiatement.
            if (optionsRef.current.conversation.sendMode === "keyword") {
              const { body, send } = matchSendKeyword(trimmed, optionsRef.current.conversation.sendKeyword);
              if (!send) {
                // Le segment rejoint le brouillon, l'écoute continue telle
                // quelle — on ne touche pas à l'activité externe.
                optionsRef.current.appendToDraft(body);
                return;
              }
              // Mot-clé : tout le brouillon accumulé part (dicté ET tapé),
              // suivi de l'éventuel reste du segment.
              const full = [optionsRef.current.takeDraft().trim(), body].join(" ").trim();
              if (!full) {
                showConversationNotice("Rien à envoyer : le brouillon est vide.");
                return;
              }
              void runConversationTurn(full);
              return;
            }
            void runConversationTurn(trimmed);
          },
          onNotice: (message) => showConversationNotice(message),
          onError: (message) => {
            // Affichée comme les autres erreurs de la page. Ces erreurs sont
            // annoncées non fatales (l'écoute continue) : on n'arrête le mode
            // que si l'écoute s'est réellement interrompue.
            setMicError(message);
            if (!isConversationActive()) stopConversationMode();
          },
        },
      );
    } catch (err) {
      setMicError(err instanceof Error ? err.message : String(err));
      stopConversationMode();
    }
  }, [runConversationTurn, showConversationNotice, stopConversationMode]);

  // Garde-fou d'inactivité : aucun segment parlé depuis 5 minutes → arrêt
  // automatique, avec un message qui explique pourquoi le micro s'est refermé.
  useEffect(() => {
    if (!conversationOn) return;
    const timer = window.setInterval(() => {
      if (Date.now() - conversationLastSpeechRef.current < CONVERSATION_IDLE_LIMIT_MS) return;
      stopConversationMode(
        "Mode conversation arrêté : aucune parole détectée depuis 5 minutes. Le micro ne reste pas ouvert indéfiniment.",
      );
    }, CONVERSATION_IDLE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [conversationOn, stopConversationMode]);

  // Changement d'onglet : la page quittée ne garde pas un micro ouvert (voir
  // l'en-tête du fichier). Sans effet si le mode n'était pas actif.
  useEffect(() => {
    if (options.pageVisible || !conversationOnRef.current) return;
    stopConversationMode("Mode conversation arrêté : vous avez quitté cette page.");
  }, [options.pageVisible, stopConversationMode]);

  // Démontage : micro refermé, lecture coupée, minuteries purgées. On ne touche
  // à la conversation que si c'est BIEN celle de cette page (l'autre page peut
  // très bien être en train de parler).
  useEffect(() => {
    return () => {
      const wasOwner = conversationOnRef.current;
      conversationOnRef.current = false;
      if (wasOwner) {
        if (isConversationActive()) {
          stopConversation();
          stopPlayback();
        }
        setExternalActivity(null);
      }
      // Le registre ne doit jamais rester bloqué sur une page disparue.
      if (conversationOwner === optionsRef.current.pageLabel) conversationOwner = null;
      if (conversationNoticeTimerRef.current !== null) {
        window.clearTimeout(conversationNoticeTimerRef.current);
        conversationNoticeTimerRef.current = null;
      }
      if (conversationWatchdogRef.current !== null) {
        window.clearTimeout(conversationWatchdogRef.current);
        conversationWatchdogRef.current = null;
      }
    };
  }, []);

  /**
   * Bouton micro : premier clic démarre l'enregistrement, second clic arrête
   * puis transcrit — le texte reconnu est AJOUTÉ au brouillon (jamais un
   * remplacement), et le curseur revient dans le composeur.
   */
  const handleMicClick = useCallback(async () => {
    if (micStateRef.current === "transcribing") return;

    if (micStateRef.current === "idle") {
      setMicError(null);
      setMicLevel(0);
      try {
        await startRecording({ deviceId: optionsRef.current.micDeviceId, onLevel: setMicLevel });
        setMicState("recording");
      } catch (err) {
        setMicError(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Enregistrement en cours : arrêt + transcription.
    setMicState("transcribing");
    setMicProgress("");
    setMicLevel(0);
    try {
      const audioBase64 = await stopRecording();
      const text = (await speechTranscribe(audioBase64, (p) => setMicProgress(formatSpeechProgress(p)))).trim();
      if (text) {
        // Mot-clé « envoie » en fin de dictée (voir sendKeyword.ts) : toujours
        // actif au micro, réglage ou pas. Déclenché, il envoie brouillon + texte
        // dicté SANS attendre le tour — le bouton micro revient au repos tout de
        // suite, l'envoi vit sa vie comme un clic sur Envoyer.
        const { body, send } = matchSendKeyword(text, optionsRef.current.conversation.sendKeyword);
        if (send) {
          const full = [optionsRef.current.takeDraft().trim(), body].join(" ").trim();
          if (full) {
            // Si rien ne part (fournisseur ou projet manquant), le texte est
            // REPOSÉ dans le brouillon : une dictée ne doit jamais se perdre.
            const countBefore = optionsRef.current.turnCount();
            void optionsRef.current
              .send(full)
              .catch(() => {
                // La page inscrit déjà l'erreur dans le message concerné.
              })
              .then(async () => {
                await conversationSleep(CONVERSATION_COMMIT_DELAY_MS);
                if (optionsRef.current.turnCount() === countBefore) {
                  optionsRef.current.appendToDraft(full);
                  setMicError(optionsRef.current.notSentNotice);
                }
              });
          } else {
            setMicError("Rien à envoyer : dites votre message avant le mot-clé.");
          }
        } else {
          optionsRef.current.appendToDraft(text);
        }
      } else {
        setMicError("Aucun texte reconnu — réessayez en parlant plus près du micro.");
      }
    } catch (err) {
      setMicError(err instanceof Error ? err.message : String(err));
    } finally {
      setMicState("idle");
      setMicProgress("");
      optionsRef.current.focusComposer?.();
    }
  }, []);

  const micLabel =
    micState === "recording"
      ? "Arrêter et transcrire"
      : micState === "transcribing"
        ? micProgress || "Transcription en cours…"
        : "Dicter au micro";

  const conversationLabel = conversationOn
    ? "Arrêter le mode conversation"
    : "Mode conversation (écoute continue)";

  return {
    micState,
    micError,
    dismissMicError: () => setMicError(null),
    micProgress,
    micLevel,
    micLabel,
    onMicClick: () => void handleMicClick(),
    conversationOn,
    conversationState,
    conversationLevel,
    conversationThreshold,
    conversationNotice,
    conversationLabel,
    onToggleConversation: () => void toggleConversation(),
  };
}
