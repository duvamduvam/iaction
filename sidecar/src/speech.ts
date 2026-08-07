/**
 * Moteur parole — speech-to-text (Whisper) et text-to-speech (Kokoro).
 *
 * Deux modes chacun :
 * - « local »  : inférence dans le sidecar via transformers.js et kokoro-js
 *   (onnxruntime-node embarqué — volontairement la SEULE inférence native du
 *   projet). Modèles téléchargés au premier usage dans
 *   ~/.cache/iaction/models, jamais dans ~/.cache/huggingface.
 * - « remote » : endpoints « dialecte OpenAI » (/audio/transcriptions,
 *   /audio/speech) via fetch natif Node 22.
 *
 * Même modèle qu'engine.ts : configuration et clés poussées EN MÉMOIRE par
 * speech.configure (jamais écrites sur disque, jamais loguées), chargements
 * paresseux mis en cache au niveau module, parsing défensif, messages
 * d'erreur en français. Les bibliothèques d'inférence sont importées
 * dynamiquement : le sidecar ne paie leur coût (chargement du runtime ONNX
 * natif) qu'au premier appel local.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { joinUrl, readBoundedBody, type EngineEmitter } from "./engine.js";
import { globalDataRoot } from "./appPaths.js";
import * as journal from "./journal.js";

// ---------------------------------------------------------------------------
// Types du contrat (voir docs/protocol.md, section « Méthodes speech »)
// ---------------------------------------------------------------------------

export interface SpeechConfig {
  stt: {
    mode: "local" | "remote";
    /** Code langue type "fr" ; chaîne vide = détection automatique. */
    language: string;
    local: { model: string };
    remote: { baseUrl: string; model: string };
  };
  tts: {
    mode: "local" | "remote";
    local: { voice: string; speed: number };
    /**
     * `voice` est un paramètre REQUIS de `POST /audio/speech` (dialecte
     * OpenAI, OpenRouter compris) : il est toujours envoyé, y compris vide —
     * le service répond alors une erreur explicite indiquant les valeurs
     * qu'il accepte, ce qui est plus utile qu'un champ silencieusement omis.
     */
    remote: { baseUrl: string; model: string; voice: string; speed: number };
  };
}

interface SpeechKeys {
  stt?: string;
  tts?: string;
}

function defaultSpeechConfig(): SpeechConfig {
  return {
    stt: {
      mode: "local",
      language: "",
      local: { model: "onnx-community/whisper-small" },
      remote: { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo" },
    },
    tts: {
      mode: "local",
      // ff_siwis est la voix française du modèle Kokoro (voir loadKokoro pour
      // les limites de phonémisation de kokoro-js sur le texte français).
      local: { voice: "ff_siwis", speed: 1.0 },
      remote: {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        speed: 1.0,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// État en mémoire (module-level, comme providers dans engine.ts)
// ---------------------------------------------------------------------------

let config: SpeechConfig = defaultSpeechConfig();
let keys: SpeechKeys = {};

/** Type structurel minimal du pipeline ASR (évite de figer les types d'une version de transformers.js). */
type AsrPipeline = (audio: Float32Array, options?: Record<string, unknown>) => Promise<unknown>;

/** Pipeline Whisper chargé (paresseux), indexé par modèle : changer de modèle invalide le cache. */
let sttLoaded: { model: string; promise: Promise<AsrPipeline> } | null = null;

/** Type structurel minimal de l'instance KokoroTTS (mêmes raisons). */
interface KokoroLike {
  generate(
    text: string,
    options: { voice?: string; speed?: number },
  ): Promise<{ audio: Float32Array; sampling_rate: number }>;
  _validate_voice(voice: string): string;
}

/** Instance Kokoro chargée (paresseuse). Le modèle ne dépend ni de la voix ni de
 * la vitesse (paramètres de génération) : pas d'invalidation nécessaire quand
 * seule la voix change. */
let ttsLoaded: Promise<KokoroLike> | null = null;

/**
 * Format de sortie (`response_format`) dont on a la preuve qu'il est accepté
 * par un modèle distant donné, mémorisé au premier succès pour éviter
 * l'aller-retour « 400 puis reprise » aux appels suivants. En mémoire
 * seulement (comme le reste de l'état du module), et invalidé dès que la
 * config change de modèle : le même identifiant peut désigner un modèle
 * différent d'un fournisseur à l'autre.
 */
const ttsFormatByModel = new Map<string, SpeechFormat>();

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/*
 * ---------------------------------------------------------------------------
 * Pile de voix LOCALE — déportée hors de l'application livrée
 * ---------------------------------------------------------------------------
 *
 * `kokoro-js` et `@huggingface/transformers` (avec l'`onnxruntime-node` natif
 * qu'ils tirent, en double) pèsent 1,2 Go : plus que tout le reste réuni. Ils
 * ne sont donc PAS embarqués dans les applications livrées
 * (scripts/preparer-bundle.sh), mais restent installables APRÈS coup, dans un
 * dossier de l'utilisateur — ce que cette section rend possible.
 *
 * Deux emplacements sont acceptés, dans cet ordre :
 *   1. la résolution normale — cas du dépôt en développement, où
 *      `npm install` les a posés dans `node_modules/` ;
 *   2. `<données de l'app>/voix-locale/node_modules` — cas d'une application
 *      installée : ce dossier est INSCRIPTIBLE (contrairement à une AppImage,
 *      qui est une image en lecture seule), et l'utilisateur y installe la
 *      pile lui-même (voir docs/empaquetage.md).
 *
 * La disponibilité est RÉSOLUE, jamais chargée, par `voixLocaleDisponible()` :
 * l'interface s'en sert pour ne pas proposer un bouton qui échouerait — un
 * bouton absent vaut mieux qu'un bouton qui déçoit.
 */

/** `<données de l'app>/voix-locale/node_modules` — installation déportée. */
export function voixLocaleDir(): string {
  return path.join(globalDataRoot(), "voix-locale", "node_modules");
}

/** Modules qui composent la pile de voix locale. */
const MODULES_VOIX_LOCALE = ["kokoro-js", "@huggingface/transformers"] as const;

/**
 * Résout un module de la pile locale sans le charger : chemin du fichier
 * d'entrée, ou `null` s'il est introuvable des deux côtés.
 */
function resoudreVoixLocale(nom: string): string | null {
  try {
    return createRequire(import.meta.url).resolve(nom);
  } catch {
    // Pas dans l'arbre du sidecar : on tente l'installation déportée. Le
    // `require` doit partir d'un fichier FICTIF de ce dossier — c'est la
    // convention de createRequire pour résoudre « comme si » on était là-bas.
    try {
      const base = path.join(voixLocaleDir(), "index.js");
      return createRequire(base).resolve(nom);
    } catch {
      return null;
    }
  }
}

/** Vrai si la pile complète est résolvable (embarquée ou déportée). */
export function voixLocaleDisponible(): boolean {
  return MODULES_VOIX_LOCALE.every((nom) => resoudreVoixLocale(nom) !== null);
}

/**
 * Charge un module de la pile locale, où qu'il soit, et transforme son absence
 * en message actionnable plutôt qu'en `ERR_MODULE_NOT_FOUND` brut.
 */
async function importVoixLocale<T>(nom: string): Promise<T> {
  const resolu = resoudreVoixLocale(nom);
  if (resolu === null) {
    journal.warn("speech", "pile de voix locale absente", {
      fields: { module: nom, dossierDeporte: voixLocaleDir() },
    });
    throw new Error(
      `La voix locale n'est pas installée (module « ${nom} » introuvable). ` +
        `Installez-la dans ${path.dirname(voixLocaleDir())} — voir docs/empaquetage.md — ` +
        "ou choisissez un moteur de voix distant dans Configuration.",
    );
  }
  return (await import(pathToFileURL(resolu).href)) as T;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Répertoire de cache des modèles : ~/.cache/iaction/models (XDG respecté). */
function modelsCacheDir(): string {
  const base = isNonEmptyString(process.env.XDG_CACHE_HOME)
    ? process.env.XDG_CACHE_HOME
    : path.join(os.homedir(), ".cache");
  return path.join(base, "iaction", "models");
}

/**
 * Rend lisible le corps d'une réponse HTTP en erreur. Les services « dialecte
 * OpenAI » répondent `{"error":{"message":"…","code":400}}` (ou, plus rarement,
 * `{"message":"…"}`) : recracher ce JSON brut à l'utilisateur est illisible, on
 * n'en garde donc que le message. Corps non-JSON ou de forme inattendue :
 * renvoyé tel quel. Le corps est déjà tronqué en amont par `readBoundedBody` ;
 * une seconde troncature protège les messages JSON anormalement longs.
 * Exporté pour les tests (test/speech.test.js).
 */
export function extractHttpErrorMessage(body: string): string {
  const MAX = 500;
  const truncate = (text: string): string => (text.length > MAX ? text.slice(0, MAX) + "…" : text);
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) {
    return truncate(trimmed);
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isPlainObject(parsed)) {
      if (isPlainObject(parsed.error) && isNonEmptyString(parsed.error.message)) {
        return truncate(parsed.error.message);
      }
      if (isNonEmptyString(parsed.error)) {
        return truncate(parsed.error);
      }
      if (isNonEmptyString(parsed.message)) {
        return truncate(parsed.message);
      }
    }
  } catch {
    // Corps annoncé JSON mais illisible (tronqué par readBoundedBody, par
    // exemple) : on retombe sur le texte brut.
  }
  return truncate(trimmed);
}

/**
 * Formats de sortie négociés avec `/audio/speech`. Le dialecte OpenAI en
 * connaît d'autres (opus, aac, flac, wav), mais aucun n'est accepté par
 * l'ensemble des modèles : on s'en tient au couple universellement présent —
 * `mp3` (conteneur, lisible tel quel) et `pcm` (brut, qu'on emballe en WAV).
 */
export type SpeechFormat = "mp3" | "pcm";

/** L'autre format du couple, cible de la seule nouvelle tentative autorisée. */
export function otherSpeechFormat(format: SpeechFormat): SpeechFormat {
  return format === "mp3" ? "pcm" : "mp3";
}

/**
 * Corps JSON de `POST {baseUrl}/audio/speech`, isolé pour être testable sans
 * réseau (voir test/speech.test.js).
 *
 * - `response_format` est envoyé EXPLICITEMENT : le défaut de l'endpoint est
 *   `"pcm"` (PCM brut sans en-tête), qu'on étiquetterait à tort `audio/mpeg` —
 *   la lecture échouerait alors silencieusement côté UI. La valeur est
 *   NÉGOCIÉE (voir `isResponseFormatRejection` et `synthesizeRemote`) : chaque
 *   modèle n'en accepte souvent qu'une (Gemini TTS impose `pcm`, la plupart
 *   des autres imposent `mp3`), et aucune table modèle→format ne resterait
 *   fiable dans la durée.
 * - `voice` est un paramètre requis : toujours envoyé, même vide.
 * - `speed` reste facultatif et n'est honoré que par certains fournisseurs :
 *   omis à sa valeur neutre (1) pour ne pas risquer un HTTP 400.
 */
export function buildSpeechRequestBody(
  remote: { model: string; voice: string; speed: number },
  text: string,
  format: SpeechFormat = "mp3",
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: remote.model,
    input: text,
    voice: remote.voice,
    response_format: format,
  };
  if (remote.speed !== 1) {
    body.speed = remote.speed;
  }
  return body;
}

/**
 * Décide si un message d'erreur HTTP 4xx reproche le `response_format` demandé
 * et désigne `alternative` comme format acceptable. Exemple réel (OpenRouter,
 * google/gemini-3.1-flash-tts-preview) :
 *
 *     Gemini TTS only supports response_format="pcm". Got "mp3".
 *
 * Détection VOLONTAIREMENT conjonctive : le message doit citer le paramètre
 * (`response_format`, ou ses variantes d'écriture `response format` /
 * `responseFormat`) ET nommer le format alternatif comme un mot entier. Les
 * deux conditions ensemble excluent les autres 4xx courants — modèle
 * inexistant, voix invalide, clé refusée — qui ne mentionnent jamais le
 * paramètre ; et la seconde évite de rejouer une requête vers un format que le
 * service n'a pas suggéré. La frontière de mot empêche `mp3` de matcher dans
 * un identifiant de modèle du genre `xyz-mp3-tts`.
 * Exportée pour les tests (test/speech.test.js).
 */
export function isResponseFormatRejection(message: string, alternative: SpeechFormat): boolean {
  const lower = message.toLowerCase();
  const mentionsParam = /response[\s_-]?format/.test(lower);
  const mentionsAlternative = new RegExp(`(^|[^a-z0-9])${alternative}([^a-z0-9]|$)`).test(lower);
  return mentionsParam && mentionsAlternative;
}

/**
 * Caractéristiques d'un flux PCM brut, lues dans les paramètres du
 * `Content-Type` quand le service en fournit (`audio/pcm; rate=24000;
 * channels=1`), sinon reprises des valeurs par défaut.
 */
export interface PcmParams {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * Hypothèse par défaut du PCM renvoyé par `/audio/speech` : 16 bits signés
 * petit-boutiste, mono, 24 000 Hz. C'est ce que produisent aussi bien Gemini
 * TTS que les modèles TTS OpenAI (`gpt-4o-mini-tts`, `tts-1`), et le dialecte
 * OpenAI ne documente aucun autre paramétrage. Si un modèle sortait du lot
 * (48 kHz, stéréo…), la voix serait lue trop vite ou trop lentement : c'est
 * ICI qu'il faudrait ajuster — ou, mieux, dans le `Content-Type` du service,
 * que `parsePcmContentType` honore quand il porte l'information.
 */
export const DEFAULT_PCM_PARAMS: PcmParams = { sampleRate: 24000, channels: 1, bitsPerSample: 16 };

/**
 * Lit les paramètres d'un en-tête `Content-Type` décrivant du PCM brut.
 * Reconnaît `rate` / `sample-rate` / `samplerate`, `channels`, et
 * `bits` / `bits-per-sample` ; tout paramètre absent, non numérique ou
 * aberrant retombe sur DEFAULT_PCM_PARAMS. Les guillemets éventuels
 * (`rate="24000"`) sont retirés.
 * Exportée pour les tests (test/speech.test.js).
 */
export function parsePcmContentType(header: string | null): PcmParams {
  const params = { ...DEFAULT_PCM_PARAMS };
  if (!isNonEmptyString(header)) {
    return params;
  }
  const readNumber = (names: string[], min: number, max: number): number | null => {
    for (const part of header.split(";").slice(1)) {
      const eq = part.indexOf("=");
      if (eq < 0) {
        continue;
      }
      const name = part.slice(0, eq).trim().toLowerCase().replace(/[_-]/g, "");
      if (!names.includes(name)) {
        continue;
      }
      const value = Number(part.slice(eq + 1).trim().replace(/^"|"$/g, ""));
      if (Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max) {
        return value;
      }
    }
    return null;
  };
  params.sampleRate = readNumber(["rate", "samplerate"], 8000, 192000) ?? params.sampleRate;
  params.channels = readNumber(["channels"], 1, 2) ?? params.channels;
  params.bitsPerSample = readNumber(["bits", "bitspersample"], 8, 32) ?? params.bitsPerSample;
  return params;
}

/** Taille maximale d'un audio décodé (garde-fou mémoire, largement au-delà des usages dictée). */
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

/** Longueur maximale du texte accepté par speech.synthesize. */
const MAX_TTS_TEXT_LENGTH = 4000;

/**
 * Fabrique un relais de progression pour les progress_callback de
 * transformers.js / kokoro-js : émet des chunks `{status, progress?}` sur la
 * requête, throttlés à un événement toutes les 500 ms maximum (le
 * téléchargement d'un modèle génère des rafales très denses).
 */
function createProgressForwarder(id: string, emitter: EngineEmitter): (info: unknown) => void {
  const THROTTLE_MS = 500;
  let lastEmit = 0;
  return (info: unknown) => {
    if (!isPlainObject(info) || !isNonEmptyString(info.status)) {
      return;
    }
    const now = Date.now();
    if (now - lastEmit < THROTTLE_MS) {
      return;
    }
    lastEmit = now;
    const data: { status: string; progress?: number } = { status: info.status };
    if (typeof info.progress === "number" && Number.isFinite(info.progress)) {
      data.progress = Math.round(info.progress * 10) / 10;
    }
    emitter.chunk(id, data);
  };
}

// ---------------------------------------------------------------------------
// WAV — parseur et encodeur maison (PCM 16 bits, petit-boutiste)
// ---------------------------------------------------------------------------

/**
 * Décode un WAV PCM16 mono : vérifie l'en-tête RIFF/WAVE, localise les chunks
 * `fmt ` et `data`, refuse tout ce qui n'est pas du PCM 16 bits mono.
 * Renvoie les échantillons normalisés en Float32 (÷ 32768) et la fréquence.
 * Exporté pour les tests (test/speech.test.js).
 */
export function parseWavPcm16Mono(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
  if (bytes.length < 44) {
    throw new Error("WAV invalide : fichier trop court pour contenir un en-tête");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("WAV invalide : en-tête RIFF/WAVE absent");
  }

  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null =
    null;
  let data: { offset: number; size: number } | null = null;

  // Parcours des chunks RIFF (taille sur 32 bits, corps aligné sur 2 octets).
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = tag(offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === "fmt ") {
      if (chunkSize < 16 || body + 16 > bytes.length) {
        throw new Error("WAV invalide : chunk fmt tronqué");
      }
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (chunkId === "data") {
      // Taille bornée à ce qui est réellement présent (fichiers tronqués tolérés).
      data = { offset: body, size: Math.max(0, Math.min(chunkSize, bytes.length - body)) };
    }
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (!fmt) {
    throw new Error("WAV invalide : chunk fmt absent");
  }
  if (!data) {
    throw new Error("WAV invalide : chunk data absent");
  }
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(
      `WAV invalide : PCM 16 bits attendu (format ${fmt.audioFormat}, ${fmt.bitsPerSample} bits reçus)`,
    );
  }
  if (fmt.channels !== 1) {
    throw new Error(`WAV invalide : audio mono attendu (${fmt.channels} canaux reçus)`);
  }
  if (fmt.sampleRate <= 0) {
    throw new Error("WAV invalide : fréquence d'échantillonnage nulle");
  }

  const sampleCount = Math.floor(data.size / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(data.offset + 2 * i, true) / 32768;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

/** Taille de l'en-tête WAV canonique (RIFF + fmt de 16 octets + data). */
const WAV_HEADER_SIZE = 44;

/**
 * Écrit l'en-tête WAV canonique de 44 octets décrivant `dataSize` octets de
 * PCM entier petit-boutiste. Brique commune à `encodeWavPcm16` (qui quantifie
 * ensuite des Float32) et à `wrapPcm16InWav` (qui recopie du PCM déjà encodé).
 */
function buildWavHeader(dataSize: number, params: PcmParams): Uint8Array {
  const { sampleRate, channels, bitsPerSample } = params;
  const blockAlign = channels * (bitsPerSample / 8);
  const bytes = new Uint8Array(WAV_HEADER_SIZE);
  const view = new DataView(bytes.buffer);
  const writeTag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) {
      bytes[offset + i] = text.charCodeAt(i);
    }
  };

  writeTag(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // taille du fichier moins « RIFF » + sa taille
  writeTag(8, "WAVE");
  writeTag(12, "fmt ");
  view.setUint32(16, 16, true); // taille du chunk fmt
  view.setUint16(20, 1, true); // PCM entier
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // débit octets
  view.setUint16(32, blockAlign, true); // alignement bloc
  view.setUint16(34, bitsPerSample, true);
  writeTag(36, "data");
  view.setUint32(40, dataSize, true);
  return bytes;
}

/**
 * Emballe des octets PCM DÉJÀ ENCODÉS (entiers petit-boutistes) dans un
 * conteneur WAV, sans les réinterpréter : simple recopie derrière un en-tête.
 * Indispensable pour la synthèse distante en `response_format: "pcm"` — un
 * élément `<audio>` ne sait pas lire du PCM brut, et le WAV est le conteneur
 * le moins cher à fabriquer autour.
 *
 * Un octet orphelin (longueur impaire pour du 16 bits) est ignoré : la taille
 * annoncée du chunk `data` doit rester un multiple de l'alignement de bloc,
 * sinon les lecteurs stricts refusent le fichier.
 * Exportée pour les tests (test/speech.test.js).
 */
export function wrapPcm16InWav(pcm: Uint8Array, params: PcmParams = DEFAULT_PCM_PARAMS): Uint8Array {
  const blockAlign = params.channels * (params.bitsPerSample / 8);
  const dataSize = Math.floor(pcm.length / blockAlign) * blockAlign;
  const bytes = new Uint8Array(WAV_HEADER_SIZE + dataSize);
  bytes.set(buildWavHeader(dataSize, params), 0);
  bytes.set(pcm.subarray(0, dataSize), WAV_HEADER_SIZE);
  return bytes;
}

/**
 * Encode des échantillons Float32 ([-1, 1], écrêtés au besoin) en WAV PCM16
 * mono. Exporté pour les tests (aller-retour avec parseWavPcm16Mono).
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = samples.length * 2;
  const bytes = new Uint8Array(WAV_HEADER_SIZE + dataSize);
  bytes.set(buildWavHeader(dataSize, { sampleRate, channels: 1, bitsPerSample: 16 }), 0);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(WAV_HEADER_SIZE + 2 * i, Math.round(clamped * 32767), true);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// speech.configure
// ---------------------------------------------------------------------------

/** Lit une chaîne non vide de `obj[key]`, sinon le défaut ; type invalide → erreur française. */
function readString(obj: Record<string, unknown>, key: string, fallback: string, where: string): string {
  const value = obj[key];
  if (value === undefined) {
    return fallback;
  }
  if (!isNonEmptyString(value)) {
    throw new Error(`${where}.${key} doit être une chaîne non vide`);
  }
  return value;
}

/** Comme readString mais la chaîne vide est autorisée (language: "" = auto). */
function readOptionalString(
  obj: Record<string, unknown>,
  key: string,
  fallback: string,
  where: string,
): string {
  const value = obj[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`${where}.${key} doit être une chaîne`);
  }
  return value;
}

function readSpeed(obj: Record<string, unknown>, fallback: number, where: string): number {
  const value = obj.speed;
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${where}.speed doit être un nombre strictement positif`);
  }
  return value;
}

function readMode(obj: Record<string, unknown>, fallback: "local" | "remote", where: string): "local" | "remote" {
  const value = obj.mode;
  if (value === undefined) {
    return fallback;
  }
  if (value !== "local" && value !== "remote") {
    throw new Error(`${where}.mode doit valoir "local" ou "remote"`);
  }
  return value;
}

/**
 * Normalise une config poussée par l'UI : chaque champ absent reprend sa
 * valeur par défaut, chaque champ présent mais mal typé lève une erreur
 * française citant le champ fautif.
 */
function normalizeSpeechConfig(raw: Record<string, unknown>): SpeechConfig {
  const defaults = defaultSpeechConfig();

  const rawStt = raw.stt === undefined ? {} : raw.stt;
  if (!isPlainObject(rawStt)) {
    throw new Error("config.stt doit être un objet");
  }
  const rawSttLocal = rawStt.local === undefined ? {} : rawStt.local;
  if (!isPlainObject(rawSttLocal)) {
    throw new Error("config.stt.local doit être un objet");
  }
  const rawSttRemote = rawStt.remote === undefined ? {} : rawStt.remote;
  if (!isPlainObject(rawSttRemote)) {
    throw new Error("config.stt.remote doit être un objet");
  }

  const rawTts = raw.tts === undefined ? {} : raw.tts;
  if (!isPlainObject(rawTts)) {
    throw new Error("config.tts doit être un objet");
  }
  const rawTtsLocal = rawTts.local === undefined ? {} : rawTts.local;
  if (!isPlainObject(rawTtsLocal)) {
    throw new Error("config.tts.local doit être un objet");
  }
  const rawTtsRemote = rawTts.remote === undefined ? {} : rawTts.remote;
  if (!isPlainObject(rawTtsRemote)) {
    throw new Error("config.tts.remote doit être un objet");
  }

  return {
    stt: {
      mode: readMode(rawStt, defaults.stt.mode, "config.stt"),
      language: readOptionalString(rawStt, "language", defaults.stt.language, "config.stt"),
      local: {
        model: readString(rawSttLocal, "model", defaults.stt.local.model, "config.stt.local"),
      },
      remote: {
        baseUrl: readString(rawSttRemote, "baseUrl", defaults.stt.remote.baseUrl, "config.stt.remote"),
        model: readString(rawSttRemote, "model", defaults.stt.remote.model, "config.stt.remote"),
      },
    },
    tts: {
      mode: readMode(rawTts, defaults.tts.mode, "config.tts"),
      local: {
        voice: readString(rawTtsLocal, "voice", defaults.tts.local.voice, "config.tts.local"),
        speed: readSpeed(rawTtsLocal, defaults.tts.local.speed, "config.tts.local"),
      },
      remote: {
        baseUrl: readString(rawTtsRemote, "baseUrl", defaults.tts.remote.baseUrl, "config.tts.remote"),
        model: readString(rawTtsRemote, "model", defaults.tts.remote.model, "config.tts.remote"),
        // La chaîne vide reste ACCEPTÉE ici (config héritée, ou voix pas
        // encore choisie) : c'est `synthesizeRemote` qui l'enverra telle
        // quelle, le service étant seul juge des voix qu'il connaît.
        voice: readOptionalString(rawTtsRemote, "voice", defaults.tts.remote.voice, "config.tts.remote"),
        speed: readSpeed(rawTtsRemote, defaults.tts.remote.speed, "config.tts.remote"),
      },
    },
  };
}

export function handleSpeechConfigure(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): void {
  const rawConfig = params.config;
  if (!isPlainObject(rawConfig)) {
    emitter.error(id, "params.config manquant ou invalide");
    return;
  }

  let next: SpeechConfig;
  try {
    next = normalizeSpeechConfig(rawConfig);
  } catch (err) {
    emitter.error(id, err instanceof Error ? err.message : String(err));
    return;
  }

  const rawKeys = isPlainObject(params.keys) ? params.keys : {};

  // Changement de modèle STT local → le pipeline chargé ne correspond plus,
  // on l'invalide (le prochain speech.transcribe rechargera paresseusement).
  if (sttLoaded && sttLoaded.model !== next.stt.local.model) {
    sttLoaded = null;
  }

  // Changement de modèle TTS distant → le format négocié ne le concerne plus.
  // On vide toute la table plutôt que la seule entrée sortante : un changement
  // de baseUrl (fournisseur) peut donner un autre sens au même identifiant de
  // modèle, et le coût d'une renégociation est d'une requête au plus.
  if (
    next.tts.remote.model !== config.tts.remote.model ||
    next.tts.remote.baseUrl !== config.tts.remote.baseUrl
  ) {
    ttsFormatByModel.clear();
  }

  // Remplacement intégral, comme providers.set : une clé absente de l'appel
  // est retirée de la mémoire.
  config = next;
  keys = {
    stt: isNonEmptyString(rawKeys.stt) ? rawKeys.stt : undefined,
    tts: isNonEmptyString(rawKeys.tts) ? rawKeys.tts : undefined,
  };

  // La disponibilité de la pile locale voyage avec la réponse plutôt que dans
  // une méthode à part : `speech.configure` est déjà appelé au démarrage, à
  // chaque changement de réglage et à chaque `ready` du sidecar — l'interface
  // est donc informée exactement quand il faut, sans plomberie supplémentaire.
  emitter.done(id, {
    voixLocale: { disponible: voixLocaleDisponible(), dossier: path.dirname(voixLocaleDir()) },
  });
}

// ---------------------------------------------------------------------------
// Chargements paresseux des moteurs locaux
// ---------------------------------------------------------------------------

async function loadSttPipeline(model: string, onProgress: (info: unknown) => void): Promise<AsrPipeline> {
  if (sttLoaded && sttLoaded.model === model) {
    // Chargement déjà en cours ou terminé : partagé. Les événements de
    // progression restent câblés sur la requête qui a déclenché le chargement.
    return sttLoaded.promise;
  }
  const promise = (async () => {
    const transformers = await importVoixLocale<typeof import("@huggingface/transformers")>("@huggingface/transformers");
    transformers.env.cacheDir = modelsCacheDir();
    const pipe = await transformers.pipeline("automatic-speech-recognition", model, {
      progress_callback: onProgress as never,
    });
    return pipe as unknown as AsrPipeline;
  })();
  sttLoaded = { model, promise };
  promise.catch(() => {
    // Échec de chargement (réseau, modèle inconnu…) : on oublie la promesse
    // pour qu'une prochaine tentative reparte de zéro.
    if (sttLoaded && sttLoaded.promise === promise) {
      sttLoaded = null;
    }
  });
  return promise;
}

/** Identifiant du modèle Kokoro (fixe : c'est le seul modèle supporté par kokoro-js). */
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/**
 * kokoro-js embarque sa PROPRE copie de transformers.js (version différente de
 * la nôtre, que npm ne peut donc pas dédupliquer) : régler env.cacheDir sur
 * notre import ne suffit pas. On résout ici le module transformers TEL QUE VU
 * par kokoro-js et on règle le cache de cette copie-là. Best effort : en cas
 * d'échec (réorganisation future du paquet), on avertit sur stderr et kokoro
 * utilisera son cache par défaut — jamais bloquant.
 */
async function configureKokoroCacheDir(cacheDir: string): Promise<void> {
  try {
    const require = createRequire(import.meta.url);
    const kokoroEntry = require.resolve("kokoro-js");
    const nestedCjs = createRequire(kokoroEntry).resolve("@huggingface/transformers");
    // require.resolve donne l'entrée CommonJS ; kokoro-js (ESM) charge le .mjs
    // voisin — c'est cette instance-là qu'il faut configurer.
    const nestedMjs = nestedCjs.replace(/\.cjs$/, ".mjs");
    const target = existsSync(nestedMjs) ? nestedMjs : nestedCjs;
    const mod = (await import(pathToFileURL(target).href)) as { env?: { cacheDir?: string | null } };
    if (mod.env && typeof mod.env === "object") {
      mod.env.cacheDir = cacheDir;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `warn` : la synthèse fonctionne quand même, avec le cache par défaut de
    // transformers.js (les modèles seront simplement retéléchargés ailleurs).
    journal.warn("speech", "cache des modèles kokoro-js non configuré", {
      fields: { erreur: message },
    });
  }
}

async function loadKokoro(onProgress: (info: unknown) => void): Promise<KokoroLike> {
  if (ttsLoaded) {
    return ttsLoaded;
  }
  const promise = (async () => {
    await configureKokoroCacheDir(modelsCacheDir());
    const { KokoroTTS } = await importVoixLocale<typeof import("kokoro-js")>("kokoro-js");
    const tts = (await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      dtype: "q8",
      progress_callback: onProgress as never,
    })) as unknown as KokoroLike;

    // kokoro-js 1.2.1 ne référence que les 28 voix anglaises (af_*/am_*/bf_*/
    // bm_*) dans son registre interne, alors que le paquet npm livre bien les
    // fichiers de voix des autres langues — dont ff_siwis.bin, la voix
    // française. Sa validation d'origine rejetterait donc ff_siwis, et son
    // chemin d'échec écrit un console.table sur STDOUT, réservé ici au
    // protocole JSON Lines. On la remplace par une validation de forme : la
    // première lettre de la voix (convention Kokoro : langue) sert de langue
    // de phonémisation, comme dans l'implémentation d'origine.
    //
    // Limite assumée : la phonémisation de kokoro-js reste anglaise
    // (phonemizer en-us/en, quel que soit le code renvoyé ici). Sur du texte
    // français avec ff_siwis, l'accent et certains mots sont donc
    // approximatifs — la voix reste néanmoins la plus adaptée au français et
    // demeure le défaut, conformément au contrat.
    tts._validate_voice = ((voice: string): string => {
      if (!isNonEmptyString(voice) || !/^[a-z]{2}_[a-z0-9]+$/.test(voice)) {
        throw new Error(`voix inconnue: ${String(voice)} (forme attendue : "ff_siwis", "af_heart"…)`);
      }
      return voice.charAt(0);
    }) as KokoroLike["_validate_voice"];

    return tts;
  })();
  ttsLoaded = promise;
  promise.catch(() => {
    if (ttsLoaded === promise) {
      ttsLoaded = null;
    }
  });
  return promise;
}

// ---------------------------------------------------------------------------
// speech.transcribe
// ---------------------------------------------------------------------------

async function transcribeLocal(
  id: string,
  wavBytes: Buffer,
  emitter: EngineEmitter,
): Promise<void> {
  let samples: Float32Array;
  let sampleRate: number;
  try {
    ({ samples, sampleRate } = parseWavPcm16Mono(wavBytes));
  } catch (err) {
    emitter.error(id, err instanceof Error ? err.message : String(err));
    return;
  }
  if (sampleRate !== 16000) {
    emitter.error(id, `WAV invalide : 16 kHz attendu (${sampleRate} Hz reçus)`);
    return;
  }
  if (samples.length === 0) {
    emitter.error(id, "WAV invalide : aucun échantillon audio");
    return;
  }

  try {
    const asr = await loadSttPipeline(config.stt.local.model, createProgressForwarder(id, emitter));

    const options: Record<string, unknown> = {};
    const language = config.stt.language.trim().toLowerCase();
    if (language.length > 0) {
      // transformers.js accepte indifféremment le code ("fr") ou le nom
      // ("french") : whisper_language_to_code gère les deux formes.
      options.language = language;
      options.task = "transcribe";
    }
    if (samples.length / sampleRate > 30) {
      // Whisper ne voit que 30 s à la fois : au-delà, découpage glissant.
      options.chunk_length_s = 30;
      options.stride_length_s = 5;
    }

    const output = await asr(samples, options);
    const first = Array.isArray(output) ? output[0] : output;
    const text = isPlainObject(first) && typeof first.text === "string" ? first.text.trim() : "";
    emitter.done(id, { text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, `échec de la transcription locale: ${message}`);
  }
}

async function transcribeRemote(
  id: string,
  wavBytes: Buffer,
  emitter: EngineEmitter,
): Promise<void> {
  const key = keys.stt;
  if (!isNonEmptyString(key)) {
    emitter.error(
      id,
      "Clé API manquante pour la dictée à distance : renseignez-la dans Configuration › Voix.",
    );
    return;
  }

  const remote = config.stt.remote;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wavBytes)], { type: "audio/wav" }), "audio.wav");
  form.append("model", remote.model);
  const language = config.stt.language.trim();
  if (language.length > 0) {
    form.append("language", language);
  }

  try {
    const res = await fetch(joinUrl(remote.baseUrl, "audio/transcriptions"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      const errorBody = await readBoundedBody(res);
      emitter.error(id, `HTTP ${res.status} ${res.statusText}: ${extractHttpErrorMessage(errorBody)}`);
      return;
    }
    const json = (await res.json()) as unknown;
    if (!isPlainObject(json) || typeof json.text !== "string") {
      emitter.error(id, "réponse inattendue de /audio/transcriptions (champ text absent)");
      return;
    }
    emitter.done(id, { text: json.text.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, `erreur réseau: ${message}`);
  }
}

export async function handleSpeechTranscribe(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const audioBase64 = params.audioBase64;
  if (!isNonEmptyString(audioBase64)) {
    emitter.error(id, "params.audioBase64 manquant ou invalide");
    return;
  }

  const wavBytes = Buffer.from(audioBase64, "base64");
  if (wavBytes.length === 0) {
    emitter.error(id, "params.audioBase64 ne contient pas de données base64 exploitables");
    return;
  }
  if (wavBytes.length > MAX_AUDIO_BYTES) {
    emitter.error(
      id,
      `audio trop volumineux (${wavBytes.length} octets, maximum ${MAX_AUDIO_BYTES})`,
    );
    return;
  }

  if (config.stt.mode === "remote") {
    await transcribeRemote(id, wavBytes, emitter);
  } else {
    await transcribeLocal(id, wavBytes, emitter);
  }
}

// ---------------------------------------------------------------------------
// speech.synthesize
// ---------------------------------------------------------------------------

async function synthesizeLocal(id: string, text: string, emitter: EngineEmitter): Promise<void> {
  try {
    const tts = await loadKokoro(createProgressForwarder(id, emitter));
    const local = config.tts.local;
    const audio = await tts.generate(text, { voice: local.voice, speed: local.speed });
    const wav = encodeWavPcm16(audio.audio, audio.sampling_rate);
    emitter.done(id, { audioBase64: Buffer.from(wav).toString("base64"), mime: "audio/wav" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, `échec de la synthèse vocale locale: ${message}`);
  }
}

/** Issue d'une tentative de `POST /audio/speech` (les erreurs réseau, elles, sont levées). */
type SpeechAttempt =
  | { ok: true; bytes: Buffer; contentType: string | null }
  | { ok: false; status: number; message: string };

async function requestSpeech(
  remote: SpeechConfig["tts"]["remote"],
  key: string,
  text: string,
  format: SpeechFormat,
): Promise<SpeechAttempt> {
  // Corps « dialecte OpenAI », compatible tel quel avec OpenRouter
  // (/audio/speech) — voir buildSpeechRequestBody pour le détail des champs.
  const body = buildSpeechRequestBody(remote, text, format);
  const res = await fetch(joinUrl(remote.baseUrl, "audio/speech"), {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errorBody = await readBoundedBody(res);
    const detail = extractHttpErrorMessage(errorBody);
    return { ok: false, status: res.status, message: `HTTP ${res.status} ${res.statusText}: ${detail}` };
  }
  return { ok: true, bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
}

/**
 * Conteneurs audio autoportants : si le service en annonce un, sa réponse est
 * lisible telle quelle par un `<audio>`, même si on avait demandé du `pcm`
 * (certains services corrigent d'eux-mêmes le format demandé).
 */
const SELF_CONTAINED_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "audio/aac",
  "audio/mp4",
  "audio/webm",
]);

async function synthesizeRemote(id: string, text: string, emitter: EngineEmitter): Promise<void> {
  const key = keys.tts;
  if (!isNonEmptyString(key)) {
    emitter.error(
      id,
      "Clé API manquante pour la synthèse vocale à distance : renseignez-la dans Configuration › Voix.",
    );
    return;
  }

  const remote = config.tts.remote;
  // Format préféré : celui qui a déjà fonctionné pour ce modèle, sinon mp3
  // (majoritaire, et directement jouable).
  const preferred = ttsFormatByModel.get(remote.model) ?? "mp3";
  const fallback = otherSpeechFormat(preferred);

  try {
    let format = preferred;
    let attempt = await requestSpeech(remote, key, text, format);

    // UNE seule reprise, et seulement si le service reproche explicitement le
    // `response_format` en désignant l'autre format : le catalogue des modèles
    // bouge trop pour maintenir une table modèle→format, mais le message
    // d'erreur, lui, dit exactement quoi demander.
    if (!attempt.ok && attempt.status >= 400 && attempt.status < 500 &&
        isResponseFormatRejection(attempt.message, fallback)) {
      format = fallback;
      const retried = await requestSpeech(remote, key, text, format);
      if (!retried.ok) {
        // On remonte l'erreur de la SECONDE tentative (la plus informative :
        // le premier format a déjà été écarté), en disant que les deux ont
        // été essayés pour que l'utilisateur ne cherche pas de son côté.
        emitter.error(
          id,
          `${retried.message} (formats "${preferred}" puis "${fallback}" tentés tous les deux)`,
        );
        return;
      }
      attempt = retried;
    }

    if (!attempt.ok) {
      emitter.error(id, attempt.message);
      return;
    }
    if (attempt.bytes.length === 0) {
      emitter.error(id, "réponse inattendue de /audio/speech (corps vide)");
      return;
    }

    // Succès : on mémorise le format retenu pour ce modèle, les appels
    // suivants partiront directement dessus.
    ttsFormatByModel.set(remote.model, format);

    // Type MIME DÉDUIT de la réponse plutôt que supposé : on demande un format
    // précis, mais un service qui renverrait autre chose doit rester lisible
    // côté UI. Paramètres du type ignorés pour le MIME annoncé
    // (« audio/mpeg; charset=… »), repli sur audio/mpeg.
    const baseType = (attempt.contentType ?? "").split(";")[0].trim().toLowerCase();

    // PCM brut : illisible par un `<audio>`, on l'emballe dans un conteneur
    // WAV. Cas retenu quand on a demandé du `pcm` et que la réponse n'annonce
    // pas un conteneur autoportant (ou n'annonce rien du tout : OpenRouter
    // renvoie parfois application/octet-stream).
    if (format === "pcm" && !SELF_CONTAINED_AUDIO_TYPES.has(baseType)) {
      // Paramètres lus dans le Content-Type quand il en porte
      // (« audio/pcm; rate=24000 »), sinon 24 kHz / mono / 16 bits —
      // voir DEFAULT_PCM_PARAMS pour la justification de ce repli.
      const wav = wrapPcm16InWav(new Uint8Array(attempt.bytes), parsePcmContentType(attempt.contentType));
      emitter.done(id, { audioBase64: Buffer.from(wav).toString("base64"), mime: "audio/wav" });
      return;
    }

    const mime = baseType.startsWith("audio/") ? baseType : "audio/mpeg";
    emitter.done(id, { audioBase64: attempt.bytes.toString("base64"), mime });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, `erreur réseau: ${message}`);
  }
}

export async function handleSpeechSynthesize(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const text = params.text;
  if (!isNonEmptyString(text) || text.trim().length === 0) {
    emitter.error(id, "params.text manquant ou vide");
    return;
  }
  if (text.length > MAX_TTS_TEXT_LENGTH) {
    emitter.error(
      id,
      `texte trop long pour la synthèse vocale (${text.length} caractères, maximum ${MAX_TTS_TEXT_LENGTH}) : découpez-le côté appelant`,
    );
    return;
  }

  if (config.tts.mode === "remote") {
    await synthesizeRemote(id, text, emitter);
  } else {
    await synthesizeLocal(id, text, emitter);
  }
}
