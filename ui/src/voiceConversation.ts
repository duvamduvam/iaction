/*
 * Mode conversation mains libres : détection d'activité vocale (VAD) LOCALE.
 *
 * ── Le principe économique ──────────────────────────────────────────────
 * Le micro écoute en permanence, mais TOUT le travail de détection se fait
 * ici, dans le navigateur, à partir du RMS des blocs PCM. Rien ne part sur le
 * réseau tant qu'un vrai segment de parole n'a pas été isolé. Écouter ne coûte
 * donc rien ; seuls les segments réellement parlés sont transcrits, et c'est
 * la raison d'être de tout ce fichier.
 *
 * ── Chaîne réutilisée ───────────────────────────────────────────────────
 * On ne réimplémente RIEN de la capture : `audioCapture.ts` fournit déjà le
 * nœud collecteur (AudioWorklet avec repli ScriptProcessor), le
 * ré-échantillonnage linéaire, l'encodage WAV PCM16 et le base64. On importe
 * ces helpers. Seule la logique de décision (seuils, hystérésis, segments,
 * file d'attente) est neuve.
 *
 * ── Les quatre pièges traités ───────────────────────────────────────────
 * 1. SEUIL ABSOLU. Un seuil fixe ne marche jamais : selon le micro, le gain
 *    automatique et la pièce, le plancher de bruit varie d'un facteur cent.
 *    On calibre donc ~1 s au démarrage et on place le seuil RELATIVEMENT à ce
 *    plancher (avec tout de même un plancher absolu, cf. plus bas).
 *
 *    ⚠ RÉGRESSION HISTORIQUE, corrigée ici. Cette calibration était une mesure
 *    UNIQUE, DÉFINITIVE et NON ROBUSTE : moyenne des RMS de la toute première
 *    seconde. Deux situations très banales la faisaient dérailler et rendaient
 *    le mode conversation totalement sourd (bloqué sur « À l'écoute », rien ne
 *    déclenche jamais) :
 *      • l'utilisateur commence à parler PENDANT la calibration → le « bruit de
 *        fond » mesuré est sa propre voix → seuil ≈ 4× son niveau de parole ;
 *      • un transitoire pollue la fenêtre (bascule de profil Bluetooth
 *        A2DP→HSP/HFP, notification système, choc sur le micro) → même effet.
 *    Trois garde-fous indépendants répondent maintenant à ce défaut :
 *      a. calibration ROBUSTE — amorçage ignoré, puis quantile bas (et non
 *         moyenne) : quelques trames de parole ne déplacent plus l'estimation ;
 *      b. PLAFOND absolu du seuil d'ouverture — quoi qu'on ait mesuré, il reste
 *         franchement sous une voix normale, donc il n'est JAMAIS impossible de
 *         déclencher ;
 *      c. SUIVI CONTINU du plancher de bruit pendant l'écoute + filet de
 *         sécurité qui abaisse le seuil si rien ne se déclenche alors que le
 *         micro capte manifestement quelque chose.
 *    Aucun des trois ne dépend des deux autres : c'est délibéré, une mesure
 *    unique ne doit plus jamais pouvoir condamner la session.
 * 2. PREMIÈRE SYLLABE COUPÉE. Quand on décide « c'est de la parole », la
 *    parole a déjà commencé depuis `minSpeechMs`. Sans pré-tampon, chaque
 *    segment démarre au milieu du premier mot (« onjour »). D'où l'anneau de
 *    PREROLL_MS conservé en permanence.
 * 3. L'ASSISTANT S'ENTEND PARLER. L'annulation d'écho de `getUserMedia` est
 *    conçue pour la téléphonie et ne suffit pas ici, surtout sur haut-parleurs
 *    ouverts : la synthèse serait captée, transcrite, renvoyée au LLM, et la
 *    conversation partirait en boucle. La seule protection fiable est de
 *    COUPER l'écoute pendant que l'assistant répond (`setExternalActivity`),
 *    puis d'attendre une courte fenêtre de garde à la reprise.
 * 4. RAFALE DE REQUÊTES. L'utilisateur peut enchaîner deux phrases pendant
 *    qu'on transcrit la première. Les segments sont donc mis en FILE et
 *    traités un par un : ordre des `onUtterance` garanti, jamais dix requêtes
 *    simultanées.
 *
 * Comme `audioCapture.ts`, ce module est un singleton à l'échelle du module
 * (une seule conversation à la fois) et ne dépend pas de React.
 */

import {
  TARGET_SAMPLE_RATE,
  acquireMicrophone,
  bytesToBase64,
  concatSamples,
  createCollectorNode,
  encodeWavPcm16,
  isRecording,
  releaseMicrophone,
  resampleLinear,
  toMicError,
} from "./audioCapture";
import { formatSpeechProgress, speechTranscribe } from "./speechAdmin";
import { isLikelyHallucination } from "./transcriptFilter";

/* ---------- Contrat public ---------- */

export type ConversationState =
  | "idle"
  | "calibrating"
  | "listening"
  | "speaking"
  | "transcribing"
  | "thinking"
  | "playing";

export interface ConversationOptions {
  deviceId?: string;
  sensitivity?: number; // 0..1 (défaut 0.5) — plus haut = déclenche plus facilement
  silenceMs?: number; // défaut 900 — silence qui clôt un segment
  minSpeechMs?: number; // défaut 300 — parole soutenue avant d'ouvrir un segment
  maxUtteranceMs?: number; // défaut 30000 — garde-fou de coût
}

export interface ConversationCallbacks {
  onState: (state: ConversationState) => void;
  /**
   * Niveau capté ET seuil d'ouverture courant, throttlés ~10/s. Le seuil est
   * remonté avec le niveau A DESSEIN : c'est exactement ce qui a manqué lors de
   * la régression décrite en tête de fichier — l'utilisateur voyait « À
   * l'écoute », parlait, et n'avait AUCUN moyen de comprendre que sa voix
   * passait sous un seuil aberrant. Affiché côte à côte, le problème saute aux
   * yeux (cf. la jauge de `VoiceControls.tsx`).
   */
  onLevel: (rms: number, threshold: number) => void;
  onUtterance: (text: string) => void; // transcription filtrée et non vide
  onNotice?: (message: string) => void; // segment ignoré, et pourquoi
  onError: (message: string) => void; // erreur non fatale (l'écoute continue si possible)
}

/* ---------- Réglages internes ---------- */

/** Nom affiché dans les messages de conflit micro (cf. `acquireMicrophone`). */
const MIC_HOLDER = "le mode conversation";

/**
 * Amorçage IGNORÉ avant de commencer à mesurer le bruit ambiant. Même valeur et
 * même raison que le `WARMUP_MS` d'`audioCapture.ts` : le temps que PipeWire
 * bascule un casque Bluetooth de A2DP (haute fidélité, sans micro) vers
 * HSP/HFP (mains-libres, avec micro), les premières trames sont muettes ou
 * pleines d'artefacts. Les inclure dans la calibration, c'est mesurer un
 * craquement de commutation et en déduire un plancher de bruit fantaisiste.
 */
const CALIBRATION_WARMUP_MS = 300;

/** Durée d'écoute du bruit ambiant au démarrage, APRÈS l'amorçage. */
const CALIBRATION_MS = 1000;

/**
 * Quantile retenu pour estimer le plancher de bruit sur la fenêtre de
 * calibration. On prend le 20ᵉ percentile et SURTOUT PAS la moyenne : la
 * moyenne est tirée vers le haut par n'importe quelle valeur aberrante (une
 * syllabe, un choc, une commutation de profil), et c'est précisément ce qui
 * rendait la détection définitivement sourde. Un quantile bas ignore par
 * construction les trames les plus fortes de la fenêtre : il faudrait que 80 %
 * de la seconde mesurée soit de la parole pour le déplacer.
 */
const CALIBRATION_QUANTILE = 0.2;

/**
 * Audio conservé EN AMONT du déclenchement — le segment envoyé commence bien
 * avant que la décision ne soit prise (piège nº 2).
 *
 * 1 s, et non les 300 ms d'origine : les DÉBUTS DE PHRASE français sont
 * souvent des mots-outils peu accentués (« c'est quoi… », « est-ce que… »)
 * qui restent sous le seuil d'ouverture ; la détection ne part qu'au premier
 * mot appuyé, et 300 ms d'amont ne rattrapaient qu'une syllabe — l'utilisateur
 * recevait « Socle et cadrage IA » pour « C'est quoi socle et cadrage IA »
 * (cas réel). Une seconde couvre deux ou trois mots-outils. Le coût est
 * négligeable : ~190 Ko de flottants à 48 kHz, purgés en anneau.
 */
const PREROLL_MS = 1000;

/**
 * Fenêtre de garde après la reprise (fin de `thinking`/`playing`) : la queue de
 * la lecture, la réverbération de la pièce et le retour du profil Bluetooth
 * arrivent encore dans le micro juste après. On refuse tout déclenchement
 * pendant ce court instant (piège nº 3).
 */
const RESUME_GUARD_MS = 250;

/** Durée utile minimale d'un segment : en dessous, ce n'est pas de la parole. */
const MIN_SEGMENT_MS = 400;

/** Cadence des remontées de niveau vers l'UI (~10 par seconde). */
const LEVEL_INTERVAL_MS = 100;

/** Cadence maximale des messages de progression (téléchargement d'un modèle local). */
const PROGRESS_NOTICE_INTERVAL_MS = 1500;

/**
 * Rapport seuil-haut / plancher de bruit, aux deux extrêmes de `sensitivity`.
 * À sensibilité minimale il faut parler nettement plus fort que la pièce ; à
 * sensibilité maximale, un souffle un peu au-dessus du bruit suffit.
 */
const NOISE_MULTIPLIER_MIN = 1.8; // sensitivity = 1
const NOISE_MULTIPLIER_MAX = 6.0; // sensitivity = 0

/**
 * Plancher ABSOLU du seuil d'ouverture. Sans lui, un micro très silencieux
 * (plancher de bruit quasi nul, typique d'une entrée coupée ou d'une carte son
 * très propre) donnerait un seuil ridicule : le moindre craquement ouvrirait un
 * segment, et l'app enverrait du bruit à transcrire en boucle. La parole
 * ordinaire tient entre 0,02 et 0,15 de RMS, ces valeurs restent donc bien en
 * dessous d'une voix normale.
 */
const ABSOLUTE_FLOOR_MIN = 0.006; // sensitivity = 1
const ABSOLUTE_FLOOR_MAX = 0.02; // sensitivity = 0

/**
 * PLAFOND absolu du seuil d'ouverture — le garde-fou qui rend le blocage
 * signalé structurellement impossible.
 *
 * Raisonnement du choix. La parole ordinaire captée par un micro proche (casque
 * ou micro de bureau, avec le gain automatique de `getUserMedia`) tient entre
 * 0,02 et 0,15 de RMS ; 0,02 est déjà la limite basse d'une voix ATTÉNUÉE, on
 * ne veut donc pas plafonner au-dessus. On retient 0,025 : à peine au-dessus du
 * plancher absolu le plus sévère (0,02 à sensibilité nulle) pour ne pas
 * neutraliser le réglage de sensibilité, et nettement sous une voix normale
 * pour qu'un utilisateur qui parle franchement déclenche TOUJOURS, quel que
 * soit le « bruit » mesuré à la calibration.
 *
 * La contrepartie est assumée : dans une pièce réellement bruyante, ce plafond
 * laissera passer des segments de bruit. C'est très largement préférable à un
 * mode conversation muet — un segment de bruit est court, filtré par
 * `MIN_SEGMENT_MS` puis par `transcriptFilter.ts`, alors qu'un seuil
 * inatteignable rend la fonctionnalité inutilisable sans le dire.
 */
const OPEN_THRESHOLD_CEILING = 0.025;

/**
 * SUIVI CONTINU du plancher de bruit (constantes de temps d'une moyenne
 * exponentielle, appliquées aux seules trames jugées « non parole »).
 *
 * L'asymétrie est le cœur du mécanisme :
 * • DESCENTE rapide (τ = 400 ms → ~95 % du chemin parcouru en 1,2 s). C'est ce
 *   qui RATTRAPE une calibration ratée : si le plancher a été surestimé, deux
 *   ou trois secondes de silence suffisent à ramener le seuil à sa juste
 *   valeur, sans que l'utilisateur ait à relancer quoi que ce soit.
 * • MONTÉE lente (τ = 6 s). Il faut qu'une pièce qui devient bruyante finisse
 *   par relever le seuil, mais assez lentement pour que de la parole continue
 *   ne puisse pas entraîner l'estimation avec elle : sur une phrase de 2 s,
 *   l'estimation ne bouge que d'environ 28 % de l'écart — et encore, seules les
 *   trames sous le seuil d'ouverture sont prises en compte.
 */
const NOISE_FALL_TAU_MS = 400;
const NOISE_RISE_TAU_MS = 6000;

/**
 * FILET DE SÉCURITÉ. Si aucun segment n'a été ouvert après ce temps d'écoute
 * effective (suspensions et segments exclus) ALORS QUE le micro a capté une
 * énergie non triviale, c'est que le seuil est trop haut : on l'abaisse
 * franchement et on le dit à l'utilisateur.
 */
const RESCUE_WINDOW_MS = 10000;

/**
 * Énergie minimale à observer dans la fenêtre pour que l'abaissement ait un
 * sens. En dessous, le micro ne capte réellement rien (piste coupée, casque
 * resté en A2DP) : baisser le seuil ne ferait qu'ouvrir des segments de bruit
 * numérique sans jamais résoudre le vrai problème.
 */
const RESCUE_MIN_PEAK = 0.004;

/** Le seuil abaissé se cale sous la crête observée, avec cette marge. */
const RESCUE_PEAK_RATIO = 0.6;

/** À défaut de crête exploitable, on divise simplement le seuil courant par deux. */
const RESCUE_FALLBACK_RATIO = 0.5;

/**
 * Bornes de CONVERGENCE du filet : au plus trois abaissements par session, et
 * jamais sous ce plancher (en dessous, on déclencherait sur le bruit de
 * quantification). De plus, chaque abaissement pose un PLAFOND définitif sur le
 * seuil (`thresholdCap`) : le suivi de bruit ne peut plus jamais le faire
 * remonter derrière. Le mécanisme ne peut donc que converger, jamais osciller.
 */
const RESCUE_MAX_STEPS = 3;
const RESCUE_MIN_THRESHOLD = 0.0025;

/** Message unique du filet de sécurité (une seule fois par session). */
const RESCUE_NOTICE =
  "Seuil de détection abaissé automatiquement — ajustez la sensibilité si besoin.";

/**
 * HYSTÉRÉSIS : on ferme sur un seuil plus bas qu'on n'ouvre. Une phrase
 * contient des syllabes faibles et des liaisons ; avec un seuil unique, chaque
 * creux fermerait le segment et la phrase partirait en morceaux — donc en
 * plusieurs requêtes, et en plusieurs tours de parole incohérents.
 */
const CLOSE_RATIO = 0.6;

/* ---------- État du module ---------- */

interface Segment {
  chunks: Float32Array[];
  samples: number;
  /** Silence cumulé (ms) sous le seuil bas depuis le dernier son. */
  silenceMs: number;
}

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  node: AudioNode;
  sink: GainNode;
  detach: () => void;
  callbacks: ConversationCallbacks;
  sampleRate: number;

  /** Réglages résolus (défauts appliqués et bornés). */
  silenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  sensitivity: number;

  /* Calibration */
  calibrating: boolean;
  /** Amorçage restant à jeter avant de commencer à mesurer (Bluetooth). */
  calibrationWarmupMs: number;
  calibrationMs: number;
  /** RMS de chaque trame de la fenêtre — on en prend un QUANTILE, pas la moyenne. */
  calibrationRms: number[];

  /* Seuils (recalculés en continu à partir de `noiseFloor`) */
  openThreshold: number;
  closeThreshold: number;
  /** Estimation glissante du plancher de bruit, entretenue pendant l'écoute. */
  noiseFloor: number;
  /**
   * Plafond supplémentaire imposé au seuil d'ouverture par le filet de
   * sécurité. `Infinity` tant qu'il n'a jamais servi ; il ne peut que
   * descendre, garantissant qu'un abaissement n'est jamais annulé.
   */
  thresholdCap: number;

  /* Filet de sécurité */
  /** Écoute effective (hors segment, hors suspension) depuis le dernier segment. */
  rescueIdleMs: number;
  /** Crête de RMS observée sur cette même fenêtre. */
  rescuePeak: number;
  rescueSteps: number;
  rescueNoticed: boolean;

  /* Détection */
  preroll: Float32Array[];
  prerollSamples: number;
  prerollLimit: number;
  speechMs: number;
  segment: Segment | null;

  /* Suspension */
  external: "thinking" | "playing" | null;
  guardMs: number;

  /* Divers */
  lastLevelAt: number;
  lastProgressAt: number;
  queue: Float32Array[];
  draining: boolean;
  stopped: boolean;
}

let session: Session | null = null;

/** Une conversation est-elle en cours ? */
export function isConversationActive(): boolean {
  return session !== null;
}

/* ---------- Utilitaires ---------- */

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ---------- Logique de seuil (fonctions PURES, testables à la main) ---------- */
/*
 * Tout le calcul de seuil est isolé ici, sans état ni effet de bord : c'est la
 * partie qui a produit la régression, elle doit pouvoir se relire et se
 * vérifier sans dérouler la machine à états ni brancher un micro.
 */

/**
 * Quantile bas d'une série de RMS (interpolation linéaire entre les deux
 * échantillons encadrants). Robuste aux valeurs aberrantes, contrairement à la
 * moyenne : c'est toute la raison de son existence ici.
 */
export function lowQuantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(q, 0, 1) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** Rapport seuil / plancher de bruit, interpolé selon la sensibilité (0..1). */
export function noiseMultiplierFor(sensitivity: number): number {
  const s = clamp(sensitivity, 0, 1);
  return NOISE_MULTIPLIER_MAX - (NOISE_MULTIPLIER_MAX - NOISE_MULTIPLIER_MIN) * s;
}

/** Plancher absolu du seuil, interpolé selon la sensibilité (0..1). */
export function absoluteFloorFor(sensitivity: number): number {
  const s = clamp(sensitivity, 0, 1);
  return ABSOLUTE_FLOOR_MAX - (ABSOLUTE_FLOOR_MAX - ABSOLUTE_FLOOR_MIN) * s;
}

/**
 * Seuil d'ouverture à partir d'un plancher de bruit estimé.
 *
 * Trois bornes, dans cet ordre de priorité :
 * 1. `cap` (filet de sécurité) écrase tout — sinon un abaissement d'urgence
 *    serait immédiatement annulé par le plancher absolu, et le filet
 *    oscillerait au lieu de converger ;
 * 2. `OPEN_THRESHOLD_CEILING` — la garantie « jamais inatteignable » ;
 * 3. le plancher absolu, appliqué seulement s'il reste compatible avec les
 *    deux plafonds ci-dessus.
 */
export function openThresholdFor(
  noiseFloor: number,
  sensitivity: number,
  cap = Number.POSITIVE_INFINITY,
): number {
  const high = Math.min(OPEN_THRESHOLD_CEILING, cap);
  const low = Math.min(absoluteFloorFor(sensitivity), high);
  const relative = Math.max(0, noiseFloor) * noiseMultiplierFor(sensitivity);
  return clamp(relative, low, high);
}

/**
 * Coefficient d'une moyenne exponentielle pour une trame de `frameMs` et une
 * constante de temps `tauMs`. Passer par `exp` (plutôt qu'un coefficient fixe)
 * rend le suivi INDÉPENDANT de la taille de bloc : worklet (2048 échantillons)
 * ou repli ScriptProcessor (4096) donnent la même dynamique.
 */
function emaAlpha(frameMs: number, tauMs: number): number {
  return 1 - Math.exp(-Math.max(0, frameMs) / tauMs);
}

/** RMS d'un bloc mono — la mesure de niveau qui pilote toute la détection. */
function blockRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * État affiché, dérivé de l'état interne. Un seul endroit décide, pour que
 * l'UI ne reçoive jamais de séquence incohérente : l'activité externe prime,
 * puis la parole en cours, puis une transcription en vol, puis l'écoute.
 */
function publishState(s: Session): void {
  let state: ConversationState;
  if (s.external) state = s.external;
  else if (s.calibrating) state = "calibrating";
  else if (s.segment) state = "speaking";
  else if (s.draining) state = "transcribing";
  else state = "listening";
  s.callbacks.onState(state);
}

function notice(s: Session, message: string): void {
  s.callbacks.onNotice?.(message);
}

/* ---------- Démarrage ---------- */

/**
 * Démarre l'écoute continue. Rejette avec un message français clair si le
 * micro est refusé, absent, ou déjà pris par la dictée ponctuelle
 * (`audioCapture.ts` n'accepte qu'un seul consommateur à la fois : voir
 * `acquireMicrophone`, qui protège les deux sens du conflit).
 */
export async function startConversation(
  options: ConversationOptions,
  callbacks: ConversationCallbacks,
): Promise<void> {
  if (session) throw new Error("Le mode conversation est déjà actif.");
  if (isRecording()) {
    throw new Error(
      "Une dictée est en cours — arrêtez-la avant de lancer le mode conversation.",
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("La capture audio n'est pas disponible dans cet environnement.");
  }
  // Réservation AVANT `getUserMedia` : sinon une dictée lancée pendant la
  // demande d'autorisation se glisserait entre les deux.
  if (!acquireMicrophone(MIC_HOLDER)) {
    throw new Error(
      "Le micro est déjà utilisé par la dictée — arrêtez-la avant de lancer le mode conversation.",
    );
  }

  const deviceId = options.deviceId?.trim() ?? "";
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Utiles mais NON suffisants contre la boucle d'écho : la vraie
        // protection est la suspension pendant `playing` (cf. en-tête).
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
  } catch (err) {
    releaseMicrophone(MIC_HOLDER);
    throw new Error(toMicError(err));
  }

  let ctx: AudioContext;
  try {
    // Taux natif volontairement (cf. audioCapture.ts) : le ré-échantillonnage
    // à 16 kHz a lieu au moment d'encoder chaque segment.
    ctx = new AudioContext();
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    releaseMicrophone(MIC_HOLDER);
    throw new Error(`Impossible d'initialiser l'audio : ${describe(err)}`);
  }

  try {
    if (ctx.state === "suspended") await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const { node, detach } = await createCollectorNode(ctx, onCapturedBlock);

    // Puits muet : indispensable au repli ScriptProcessor, sans retour audio.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    const sensitivity = clamp(options.sensitivity ?? 0.5, 0, 1);
    session = {
      stream,
      ctx,
      source,
      node,
      sink,
      detach,
      callbacks,
      sampleRate: ctx.sampleRate,
      silenceMs: Math.max(200, options.silenceMs ?? 900),
      minSpeechMs: Math.max(50, options.minSpeechMs ?? 300),
      maxUtteranceMs: Math.max(2000, options.maxUtteranceMs ?? 30000),
      sensitivity,
      calibrating: true,
      calibrationWarmupMs: CALIBRATION_WARMUP_MS,
      calibrationMs: 0,
      calibrationRms: [],
      // Seuils provisoires, remplacés à la fin de la calibration puis
      // entretenus en continu par le suivi de bruit.
      openThreshold: openThresholdFor(0, sensitivity),
      closeThreshold: openThresholdFor(0, sensitivity) * CLOSE_RATIO,
      noiseFloor: 0,
      thresholdCap: Number.POSITIVE_INFINITY,
      rescueIdleMs: 0,
      rescuePeak: 0,
      rescueSteps: 0,
      rescueNoticed: false,
      preroll: [],
      prerollSamples: 0,
      prerollLimit: Math.round((PREROLL_MS / 1000) * ctx.sampleRate),
      speechMs: 0,
      segment: null,
      external: null,
      guardMs: 0,
      lastLevelAt: 0,
      lastProgressAt: 0,
      queue: [],
      draining: false,
      stopped: false,
    };
    publishState(session);
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    void ctx.close().catch(() => {
      /* contexte déjà fermé */
    });
    releaseMicrophone(MIC_HOLDER);
    session = null;
    throw new Error(`Impossible de démarrer le mode conversation : ${describe(err)}`);
  }
}

/* ---------- Boucle de détection ---------- */

/** Un bloc mono vient d'arriver du nœud collecteur (~43 ms à 48 kHz). */
function onCapturedBlock(samples: Float32Array): void {
  const s = session;
  if (!s || s.stopped || samples.length === 0) return;

  const frameMs = (samples.length / s.sampleRate) * 1000;
  const rms = blockRms(samples);

  // SUSPENSION : pendant que le LLM répond ou que la synthèse joue, l'audio
  // entrant est purement et simplement jeté. On n'accumule rien, on ne
  // déclenche rien, et le niveau remonté est nul — sans quoi l'app
  // transcrirait la voix de l'assistant et se répondrait à elle-même.
  if (s.external) {
    reportLevel(s, 0);
    return;
  }

  reportLevel(s, rms);

  // CALIBRATION : amorçage jeté, puis ~1 s de mesure du bruit ambiant.
  if (s.calibrating) {
    if (s.calibrationWarmupMs > 0) {
      s.calibrationWarmupMs -= frameMs;
      return;
    }
    s.calibrationRms.push(rms);
    s.calibrationMs += frameMs;
    if (s.calibrationMs >= CALIBRATION_MS) finishCalibration(s);
    return;
  }

  // Fenêtre de garde après une reprise : on continue d'alimenter le pré-tampon
  // (il se purge tout seul) mais aucun déclenchement n'est permis.
  if (s.guardMs > 0) {
    s.guardMs -= frameMs;
    pushPreroll(s, samples);
    return;
  }

  if (s.segment) {
    updateOpenSegment(s, samples, rms, frameMs);
  } else {
    updateIdleListening(s, samples, rms, frameMs);
  }
}

/**
 * Recalcule les deux seuils à partir de l'estimation courante du plancher de
 * bruit. Point de passage UNIQUE : calibration, suivi continu et filet de
 * sécurité passent tous par ici, donc `closeThreshold` ne peut pas se
 * désynchroniser d'`openThreshold`.
 */
function refreshThresholds(s: Session): void {
  s.openThreshold = openThresholdFor(s.noiseFloor, s.sensitivity, s.thresholdCap);
  s.closeThreshold = s.openThreshold * CLOSE_RATIO;
}

/**
 * Fin de calibration : le seuil d'ouverture est fixé RELATIVEMENT au plancher
 * de bruit mesuré, modulé par la sensibilité, borné en bas par un plancher
 * absolu et en haut par `OPEN_THRESHOLD_CEILING`. Le plancher absolu évite
 * qu'un ventilateur, une hotte ou une pièce animée ne déclenche des segments en
 * boucle (le coût de l'écoute est nul, celui d'une transcription ne l'est pas) ;
 * le plafond évite le défaut inverse, autrement plus grave, qui a motivé cette
 * réécriture : un seuil qu'aucune voix ne peut atteindre.
 *
 * L'estimation retenue n'est PLUS la moyenne de la fenêtre mais son quantile
 * bas, et elle n'est PLUS définitive : elle sert d'amorce au suivi continu.
 */
function finishCalibration(s: Session): void {
  s.noiseFloor = lowQuantile(s.calibrationRms, CALIBRATION_QUANTILE);
  s.calibrationRms = [];
  refreshThresholds(s);
  s.calibrating = false;
  s.speechMs = 0;
  s.preroll = [];
  s.prerollSamples = 0;
  resetRescueWindow(s);
  publishState(s);
}

/**
 * Suivi continu du plancher de bruit, appelé sur les seules trames candidates
 * au silence (sous le seuil d'ouverture), hors segment, hors suspension et hors
 * fenêtre de garde. Descente rapide / montée lente : voir NOISE_FALL_TAU_MS.
 */
function trackNoiseFloor(s: Session, rms: number, frameMs: number): void {
  if (rms >= s.openThreshold) return; // parole candidate : n'entre pas dans l'estimation
  const tau = rms < s.noiseFloor ? NOISE_FALL_TAU_MS : NOISE_RISE_TAU_MS;
  s.noiseFloor += (rms - s.noiseFloor) * emaAlpha(frameMs, tau);
  refreshThresholds(s);
}

/** Remet à zéro la fenêtre d'observation du filet (segment détecté, reprise…). */
function resetRescueWindow(s: Session): void {
  s.rescueIdleMs = 0;
  s.rescuePeak = 0;
}

/**
 * Filet de sécurité : rien ne s'est déclenché depuis RESCUE_WINDOW_MS d'écoute
 * effective alors que le micro capte manifestement quelque chose → le seuil est
 * trop haut, on l'abaisse et on le dit.
 *
 * Convergence garantie par trois verrous : au plus RESCUE_MAX_STEPS
 * abaissements, jamais sous RESCUE_MIN_THRESHOLD, et chaque abaissement pose un
 * `thresholdCap` définitif que le suivi de bruit ne peut plus franchir vers le
 * haut. Sans ce dernier verrou, le suivi remonterait le seuil dès la trame
 * suivante et le filet se déclencherait en boucle.
 */
function updateRescue(s: Session, rms: number, frameMs: number): void {
  s.rescueIdleMs += frameMs;
  if (rms > s.rescuePeak) s.rescuePeak = rms;
  if (s.rescueIdleMs < RESCUE_WINDOW_MS) return;

  const peak = s.rescuePeak;
  resetRescueWindow(s);

  // Micro réellement muet : abaisser le seuil n'y changerait rien et ouvrirait
  // des segments de bruit numérique. On laisse le garde-fou d'inactivité de
  // `useVoiceComposer` faire son travail.
  if (peak < RESCUE_MIN_PEAK) return;
  if (s.rescueSteps >= RESCUE_MAX_STEPS) return;

  const target = Math.max(
    RESCUE_MIN_THRESHOLD,
    Math.min(s.openThreshold * RESCUE_FALLBACK_RATIO, peak * RESCUE_PEAK_RATIO),
  );
  if (target >= s.openThreshold) return; // rien à gagner : on n'annonce rien

  s.thresholdCap = target;
  s.rescueSteps += 1;
  refreshThresholds(s);
  if (!s.rescueNoticed) {
    s.rescueNoticed = true;
    notice(s, RESCUE_NOTICE);
  }
}

/** Anneau de pré-tampon : on ne garde que les PREROLL_MS les plus récents. */
function pushPreroll(s: Session, samples: Float32Array): void {
  // Copie obligatoire : le buffer du ScriptProcessor est réutilisé d'un appel
  // à l'autre (même remarque que dans audioCapture.ts).
  s.preroll.push(new Float32Array(samples));
  s.prerollSamples += samples.length;
  while (s.preroll.length > 1 && s.prerollSamples - s.preroll[0].length >= s.prerollLimit) {
    s.prerollSamples -= s.preroll[0].length;
    s.preroll.shift();
  }
}

/** Écoute sans segment ouvert : on cherche `minSpeechMs` de parole soutenue. */
function updateIdleListening(
  s: Session,
  samples: Float32Array,
  rms: number,
  frameMs: number,
): void {
  pushPreroll(s, samples);

  // Auto-correction : l'estimation du bruit se met à jour AVANT la décision,
  // pour que le seuil utilisé soit celui de l'instant. Un seuil hérité d'une
  // calibration ratée se corrige ainsi en quelques secondes de silence.
  trackNoiseFloor(s, rms, frameMs);
  updateRescue(s, rms, frameMs);

  if (rms >= s.openThreshold) {
    s.speechMs += frameMs;
    if (s.speechMs >= s.minSpeechMs) openSegment(s);
    return;
  }
  // Décroissance plutôt que remise à zéro sèche : une syllabe faible au milieu
  // d'un début de phrase ne doit pas annuler tout le crédit accumulé.
  if (rms < s.closeThreshold) s.speechMs = Math.max(0, s.speechMs - frameMs);
}

/** Ouverture d'un segment, amorcé avec le pré-tampon (première syllabe incluse). */
function openSegment(s: Session): void {
  const chunks = s.preroll;
  const samples = s.prerollSamples;
  s.preroll = [];
  s.prerollSamples = 0;
  s.speechMs = 0;
  s.segment = { chunks, samples, silenceMs: 0 };
  // La détection fonctionne : la fenêtre du filet de sécurité repart de zéro.
  // (`thresholdCap` et `rescueSteps`, eux, ne sont JAMAIS relâchés — un seuil
  // abaissé reste abaissé pour toute la session, sinon on oscillerait.)
  resetRescueWindow(s);
  publishState(s);
}

/** Segment ouvert : accumulation, détection de fin de phrase, garde-fou de durée. */
function updateOpenSegment(
  s: Session,
  samples: Float32Array,
  rms: number,
  frameMs: number,
): void {
  const segment = s.segment;
  if (!segment) return;
  segment.chunks.push(new Float32Array(samples));
  segment.samples += samples.length;

  // Hystérésis : tant que le niveau reste au-dessus du seuil BAS, on considère
  // que la phrase continue.
  if (rms >= s.closeThreshold) segment.silenceMs = 0;
  else segment.silenceMs += frameMs;

  const durationMs = (segment.samples / s.sampleRate) * 1000;

  if (durationMs >= s.maxUtteranceMs) {
    // Garde-fou de coût : un micro laissé devant une télévision produirait
    // sinon un segment sans fin. On coupe et on envoie quand même — le début
    // est utile — mais on le signale.
    notice(
      s,
      `Segment coupé après ${Math.round(s.maxUtteranceMs / 1000)} s (garde-fou de durée).`,
    );
    closeSegment(s);
    return;
  }
  if (segment.silenceMs >= s.silenceMs) closeSegment(s);
}

/**
 * Fin de segment : validation de la durée utile, puis mise en FILE. On
 * n'attend pas la transcription ici — l'écoute doit reprendre immédiatement,
 * l'utilisateur peut enchaîner.
 */
function closeSegment(s: Session): void {
  const segment = s.segment;
  s.segment = null;
  s.speechMs = 0;
  s.preroll = [];
  s.prerollSamples = 0;
  if (!segment) return;

  // Durée utile = tout sauf le silence final qui a provoqué la fermeture.
  const totalMs = (segment.samples / s.sampleRate) * 1000;
  const usefulMs = totalMs - segment.silenceMs;
  if (usefulMs < MIN_SEGMENT_MS) {
    // Rejet SILENCIEUX (onNotice, jamais onError) : un claquement de porte
    // n'est pas une panne, et transcrire 200 ms de bruit coûterait pour rien.
    notice(s, "Segment ignoré : trop court pour être de la parole.");
    publishState(s);
    return;
  }

  s.queue.push(concatSamples(segment.chunks, segment.samples));
  publishState(s);
  void drainQueue();
}

function reportLevel(s: Session, rms: number): void {
  const now = Date.now();
  if (now - s.lastLevelAt < LEVEL_INTERVAL_MS) return;
  s.lastLevelAt = now;
  // Le seuil accompagne le niveau : c'est la seule information qui permet à
  // l'utilisateur de diagnostiquer lui-même un « je parle et rien ne se passe ».
  s.callbacks.onLevel(rms, s.openThreshold);
}

/* ---------- File de transcription ---------- */

/**
 * Traite les segments UN PAR UN, dans l'ordre d'arrivée. Deux garanties :
 * les `onUtterance` sortent dans l'ordre où les phrases ont été prononcées, et
 * on n'ouvre jamais plusieurs requêtes simultanées vers le service (coût,
 * limites de débit, et modèle local qui ne supporte pas la concurrence).
 */
async function drainQueue(): Promise<void> {
  const s = session;
  if (!s || s.draining) return;
  s.draining = true;
  publishState(s);

  try {
    while (session === s && !s.stopped && s.queue.length > 0) {
      const samples = s.queue.shift() as Float32Array;
      await transcribeSegment(s, samples);
    }
  } finally {
    s.draining = false;
    // La session a pu être arrêtée pendant l'attente réseau : ne notifier que
    // si elle est toujours celle du module.
    if (session === s && !s.stopped) publishState(s);
  }
}

async function transcribeSegment(s: Session, samples: Float32Array): Promise<void> {
  let text: string;
  try {
    const resampled = resampleLinear(samples, s.sampleRate, TARGET_SAMPLE_RATE);
    const audioBase64 = bytesToBase64(new Uint8Array(encodeWavPcm16(resampled)));
    text = await speechTranscribe(audioBase64, (progress) => {
      // Première utilisation d'un modèle local : le téléchargement peut durer.
      // On relaie sobrement, sans noyer l'UI.
      const now = Date.now();
      if (now - s.lastProgressAt < PROGRESS_NOTICE_INTERVAL_MS) return;
      s.lastProgressAt = now;
      notice(s, formatSpeechProgress(progress));
    });
  } catch (err) {
    // Erreur NON fatale : réseau, clé absente, service indisponible… L'écoute
    // continue, la phrase suivante peut très bien passer.
    if (session === s && !s.stopped) s.callbacks.onError(`Transcription : ${describe(err)}`);
    return;
  }

  if (session !== s || s.stopped) return;

  const trimmed = text.trim();
  if (!trimmed) {
    notice(s, "Segment ignoré : transcription vide.");
    return;
  }
  if (isLikelyHallucination(trimmed)) {
    // Whisper a comblé du silence avec une formule toute faite (cf.
    // transcriptFilter.ts) : on jette, sans en faire une erreur.
    notice(s, `Segment ignoré (hallucination probable) : « ${trimmed} »`);
    return;
  }
  s.callbacks.onUtterance(trimmed);
}

/* ---------- Suspension pendant la réponse de l'assistant ---------- */

/**
 * L'appelant signale que le LLM réfléchit ou que la synthèse joue. Pendant ce
 * temps, l'audio entrant est jeté (voir `onCapturedBlock`).
 *
 * PROTECTION CONTRE LA BOUCLE « l'assistant s'entend parler » : sans cela, la
 * voix de synthèse sortie des haut-parleurs revient dans le micro, est
 * détectée comme parole, transcrite, renvoyée au LLM — qui répond, et ainsi de
 * suite jusqu'à épuisement du crédit. L'annulation d'écho de `getUserMedia` ne
 * suffit PAS : elle est calibrée pour la téléphonie, ne connaît pas le signal
 * joué par l'app, et laisse largement passer une voix diffusée en champ libre.
 *
 * À la reprise, tout est purgé et une fenêtre de garde de RESUME_GUARD_MS
 * empêche de capter la queue de la lecture (dernières syllabes, réverbération
 * de la pièce, retour du profil Bluetooth).
 */
export function setExternalActivity(activity: "thinking" | "playing" | null): void {
  const s = session;
  if (!s || s.stopped) return;
  if (s.external === activity) return;

  const wasActive = s.external !== null;
  s.external = activity;

  if (activity) {
    // Un segment ouvert au moment où l'assistant prend la main est bien de la
    // parole de l'utilisateur (typiquement la fin de sa question) : on le clôt
    // et on l'envoie plutôt que de le perdre.
    if (s.segment) closeSegment(s);
    s.preroll = [];
    s.prerollSamples = 0;
    s.speechMs = 0;
  } else if (wasActive) {
    s.preroll = [];
    s.prerollSamples = 0;
    s.speechMs = 0;
    s.guardMs = RESUME_GUARD_MS;
    // La suspension a pu durer des minutes (réflexion du LLM, longue lecture) :
    // sans cette remise à zéro, le filet de sécurité déclencherait dès la
    // reprise en croyant que dix secondes d'écoute stérile viennent de passer.
    resetRescueWindow(s);
  }
  publishState(s);
}

/* ---------- Arrêt ---------- */

/**
 * Arrête l'écoute et libère TOUT : pistes du flux (l'indicateur micro de l'OS
 * s'éteint, le casque Bluetooth revient en A2DP), nœuds du graphe, contexte
 * audio, réservation du micro. Idempotent, ne lève jamais. Les segments
 * encore en file sont abandonnés : ils n'ont plus de destinataire.
 */
export function stopConversation(): void {
  const s = session;
  if (!s) return;
  session = null;
  s.stopped = true;
  s.queue = [];
  s.segment = null;
  s.preroll = [];

  try {
    s.detach();
    s.source.disconnect();
    s.node.disconnect();
    s.sink.disconnect();
  } catch {
    // Graphe déjà démonté : rien à faire.
  }
  for (const track of s.stream.getTracks()) track.stop();
  void s.ctx.close().catch(() => {
    /* contexte déjà fermé */
  });
  releaseMicrophone(MIC_HOLDER);
  s.callbacks.onState("idle");
}
