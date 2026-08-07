/*
 * Administration de la voix (dictée STT / synthèse TTS) — miroir de
 * providerAdmin.ts pour le domaine « speech » :
 * - config non-secrète sous la clé `speech` de config.json, via `appConfig`
 *   (lecture → fusion défensive avec les défauts → écriture par
 *   `writeConfig({ speech })`, jamais de clé API dedans) ;
 * - clés API dans le trousseau OS via `secret_get` / `secret_set` /
 *   `secret_delete` (convention de compte `speech:stt` / `speech:tts`), avec
 *   possibilité d'EMPRUNTER la clé d'un fournisseur déjà configuré
 *   (`remote.keySource`, cf. providerAdmin : `""` = automatique par URL de
 *   base, `SPEECH_KEY_DEDICATED` = clé dédiée forcée, sinon id du
 *   fournisseur) ;
 * - poussée de l'ensemble (config + clés) au sidecar via `speech.configure`
 *   (`pushSpeech`), à appeler au démarrage et après chaque changement ;
 * - helpers typés `speechTranscribe` / `speechSynthesize` (events `chunk`
 *   `{ status, progress? }` pendant le téléchargement d'un modèle local).
 */
import { invoke } from "@tauri-apps/api/core";
import { readConfig, writeConfig } from "./appConfig";
import { getProviderKey, readProviders, type ProviderConfig } from "./providerAdmin";
import { DEFAULT_SEND_KEYWORD } from "./sendKeyword";
import { request } from "./sidecar";

export type SpeechMode = "local" | "remote";
export type SpeechKeyKind = "stt" | "tts";

/**
 * Valeur sentinelle de `keySource` : « clé dédiée, sans recherche
 * automatique ». Le point d'exclamation initial garantit l'absence de
 * collision avec un `id` de fournisseur : ces ids servent de suffixe de compte
 * au trousseau (`provider:<id>`) et sont, par convention, de simples slugs
 * (`openrouter`, `groq`, …) — aucun n'a jamais commencé par `!`.
 */
export const SPEECH_KEY_DEDICATED = "!dedicated";

/**
 * URL de base ramenée à une forme comparable : espaces retirés, slash(s)
 * final(aux) ignoré(s), casse ignorée. Partagé par la déduction du préréglage
 * de service (page Configuration) et la recherche automatique de fournisseur
 * ci-dessous, pour que les deux appliquent exactement la même règle.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().toLowerCase();
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

export interface SpeechSttConfig {
  mode: SpeechMode;
  /** Code langue ("fr" par défaut) — chaîne vide = détection automatique. */
  language: string;
  /**
   * Micro utilisé pour la dictée (chaîne vide = périphérique par défaut du
   * système). Réglage purement CÔTÉ UI : le sidecar reçoit déjà l'audio
   * encodé et ignore ce champ (son normalisateur, `sidecar/src/speech.ts`,
   * ne recopie que les champs qu'il connaît — les inconnus sont éliminés
   * sans erreur), on le laisse donc simplement voyager avec le reste.
   */
  inputDeviceId: string;
  local: { model: string };
  remote: {
    baseUrl: string;
    model: string;
    /**
     * Source de la clé API :
     * - `""` = **automatique** : emprunt à un fournisseur configuré dont
     *   l'`baseUrl` correspond à `remote.baseUrl` et qui a une clé au
     *   trousseau, sinon repli sur la clé dédiée (`speech:stt`) ;
     * - `SPEECH_KEY_DEDICATED` = clé dédiée forcée, sans recherche ;
     * - sinon l'`id` d'un fournisseur (providerAdmin) dont la clé est
     *   empruntée au moment de `pushSpeech`.
     *
     * Champ purement CÔTÉ UI : le sidecar ne reçoit que la clé résolue, son
     * contrat `speech.configure` est inchangé.
     */
    keySource: string;
  };
}

export interface SpeechTtsConfig {
  mode: SpeechMode;
  local: { voice: string; speed: number };
  remote: {
    baseUrl: string;
    model: string;
    voice: string;
    speed: number;
    /** Idem `stt.remote.keySource`, pour la clé `speech:tts`. */
    keySource: string;
  };
}

/**
 * Réglages du mode conversation mains libres (voir voiceConversation.ts).
 *
 * Bloc purement CÔTÉ UI : il pilote la détection d'activité vocale, qui a lieu
 * entièrement dans le navigateur. Rien de neuf n'est transmis au sidecar — son
 * normalisateur (`sidecar/src/speech.ts`) reconstruit sa config champ par
 * champ et ignore les clés qu'il ne connaît pas, ce bloc voyage donc
 * simplement avec le reste sans aucun effet côté service.
 */
export interface SpeechConversationConfig {
  /** Sensibilité de la détection, 0..1 — plus haut = déclenche plus facilement. */
  sensitivity: number;
  /** Silence (ms) qui clôt un segment de parole. */
  silenceMs: number;
  /** Garde-fou de coût : durée maximale (ms) d'un segment envoyé à transcrire. */
  maxUtteranceMs: number;
  /** Lire la réponse de l'assistant à voix haute. */
  autoPlayReply: boolean;
  /**
   * Déclencheur de l'envoi en mode conversation : « silence » = chaque phrase
   * part à la fin du silence qui la clôt ; « keyword » = tout s'accumule dans
   * le brouillon du composeur, l'envoi n'a lieu que sur le mot-clé
   * (voir sendKeyword.ts).
   */
  sendMode: "silence" | "keyword";
  /**
   * Mot-clé d'envoi prononcé en fin de dictée. Vide → défaut (« transmets »,
   * voir sendKeyword.ts pour la justification du choix).
   */
  sendKeyword: string;
}

export interface SpeechConfig {
  stt: SpeechSttConfig;
  tts: SpeechTtsConfig;
  conversation: SpeechConversationConfig;
}

export const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
  stt: {
    mode: "local",
    language: "fr",
    inputDeviceId: "",
    local: { model: "onnx-community/whisper-small" },
    remote: {
      baseUrl: "https://api.groq.com/openai/v1",
      model: "whisper-large-v3-turbo",
      keySource: "",
    },
  },
  tts: {
    mode: "local",
    local: { voice: "ff_siwis", speed: 1.0 },
    remote: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      speed: 1.0,
      keySource: "",
    },
  },
  conversation: {
    sensitivity: 0.5,
    silenceMs: 900,
    maxUtteranceMs: 30000,
    autoPlayReply: true,
    sendMode: "silence",
    sendKeyword: DEFAULT_SEND_KEYWORD,
  },
};

/* ---------- Catalogues de modèles et de voix (mode distant) ---------- */

/** Entrée de liste déroulante : identifiant envoyé au service, libellé affiché. */
export interface SpeechOption {
  id: string;
  label: string;
}

/**
 * Modèles de dictée proposés par préréglage de service (clé = `id` du
 * préréglage, cf. `STT_PRESETS` dans ProvidersPage). Ces listes ne
 * VERROUILLENT rien : l'UI propose toujours « Autre (saisie libre) », et un
 * service absent d'ici (préréglage « Personnalisé ») se saisit en texte libre.
 * Tarifs de la dictée : à la durée d'audio.
 */
export const STT_REMOTE_MODELS: Record<string, SpeechOption[]> = {
  openrouter: [
    { id: "openai/whisper-large-v3-turbo", label: "Whisper large-v3-turbo (0,04 $/h — recommandé)" },
    { id: "openai/whisper-large-v3", label: "Whisper large-v3" },
    { id: "openai/gpt-4o-transcribe", label: "GPT-4o transcribe" },
    { id: "openai/gpt-4o-mini-transcribe", label: "GPT-4o mini transcribe" },
    { id: "google/chirp-3", label: "Google Chirp 3" },
    { id: "mistralai/voxtral-mini-transcribe", label: "Mistral Voxtral mini transcribe" },
    { id: "deepgram/nova-3", label: "Deepgram Nova 3" },
    { id: "nvidia/parakeet-tdt-0.6b-v3", label: "NVIDIA Parakeet TDT 0.6B v3" },
    { id: "qwen/qwen3-asr-flash-2026-02-10", label: "Qwen3 ASR Flash" },
    { id: "microsoft/mai-transcribe-1.5", label: "Microsoft MAI transcribe 1.5" },
  ],
  groq: [
    { id: "whisper-large-v3-turbo", label: "Whisper large-v3-turbo (recommandé)" },
    { id: "whisper-large-v3", label: "Whisper large-v3" },
  ],
  openai: [
    { id: "gpt-4o-transcribe", label: "GPT-4o transcribe" },
    { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini transcribe" },
    { id: "whisper-1", label: "Whisper 1" },
  ],
};

/**
 * Modèles de synthèse proposés par préréglage de service. Les tarifs affichés
 * sont indicatifs et exprimés en dollars par MILLION DE TOKENS D'ENTRÉE (le
 * texte envoyé) — la synthèse n'est pas facturée à la durée d'audio produite.
 * Ordre OpenRouter : les modèles les mieux armés pour le français d'abord.
 */
export const TTS_REMOTE_MODELS: Record<string, SpeechOption[]> = {
  openrouter: [
    { id: "google/gemini-3.1-flash-tts-preview", label: "Gemini 3.1 Flash TTS — 1 $/M (70+ langues, recommandé)" },
    { id: "mistralai/voxtral-mini-tts-2603", label: "Mistral Voxtral mini TTS — 16 $/M (multilingue, clonage de voix)" },
    { id: "hexgrad/kokoro-82m", label: "Kokoro 82M — 0,62 $/M (voix française ff_siwis, le moins cher)" },
    { id: "x-ai/grok-voice-tts-1.0", label: "Grok Voice TTS 1.0 — 15 $/M" },
    { id: "microsoft/mai-voice-2", label: "Microsoft MAI Voice 2 — 22 $/M" },
    { id: "deepgram/aura-2", label: "Deepgram Aura 2 — 30 $/M" },
    { id: "canopylabs/orpheus-3b-0.1-ft", label: "Orpheus 3B — 7 $/M" },
    { id: "sesame/csm-1b", label: "Sesame CSM 1B — 7 $/M" },
    { id: "minimax/speech-2.8-turbo", label: "MiniMax Speech 2.8 Turbo — 60 $/M" },
    { id: "minimax/speech-2.8-hd", label: "MiniMax Speech 2.8 HD — 100 $/M" },
  ],
  openai: [
    { id: "gpt-4o-mini-tts", label: "GPT-4o mini TTS" },
    { id: "tts-1", label: "TTS-1 (rapide)" },
    { id: "tts-1-hd", label: "TTS-1 HD (qualité)" },
  ],
};

/** Voix du modèle Kokoro — mêmes identifiants en local et via OpenRouter. */
export const KOKORO_VOICES: SpeechOption[] = [
  { id: "ff_siwis", label: "Français — Siwis" },
  { id: "af_heart", label: "Anglais — Heart (femme)" },
  { id: "af_bella", label: "Anglais — Bella (femme)" },
  { id: "am_adam", label: "Anglais — Adam (homme)" },
];

/** Voix préconstruites des modèles TTS Gemini. */
const GEMINI_VOICES: SpeechOption[] = [
  { id: "Zephyr", label: "Zephyr" },
  { id: "Puck", label: "Puck" },
  { id: "Charon", label: "Charon" },
  { id: "Kore", label: "Kore" },
  { id: "Fenrir", label: "Fenrir" },
  { id: "Leda", label: "Leda" },
  { id: "Orus", label: "Orus" },
  { id: "Aoede", label: "Aoede" },
];

/** Voix de l'API OpenAI, communes à ses trois modèles TTS. */
const OPENAI_VOICES: SpeechOption[] = [
  { id: "alloy", label: "Alloy" },
  { id: "echo", label: "Echo" },
  { id: "fable", label: "Fable" },
  { id: "onyx", label: "Onyx" },
  { id: "nova", label: "Nova" },
  { id: "shimmer", label: "Shimmer" },
];

/**
 * Catalogues de voix CONNUS, par modèle distant. Volontairement incomplet :
 * OpenRouter ne publie les identifiants de voix sur aucune page modèle, et
 * inventer une voix produirait un refus du service. Un modèle absent d'ici se
 * règle donc en saisie libre (l'UI l'explique).
 */
const TTS_VOICE_CATALOGS: Record<string, SpeechOption[]> = {
  "hexgrad/kokoro-82m": KOKORO_VOICES,
  "google/gemini-3.1-flash-tts-preview": GEMINI_VOICES,
  "gpt-4o-mini-tts": OPENAI_VOICES,
  "tts-1": OPENAI_VOICES,
  "tts-1-hd": OPENAI_VOICES,
};

/** Catalogue de voix d'un modèle distant, liste vide si inconnu. */
export function voiceCatalogFor(model: string): SpeechOption[] {
  return TTS_VOICE_CATALOGS[model] ?? [];
}

/**
 * Voix cohérente avec un modèle : l'ancienne si elle appartient au catalogue
 * connu du nouveau modèle, sinon la première voix de ce catalogue — et la
 * chaîne vide quand le catalogue est inconnu, pour ne pas traîner une voix
 * d'un autre modèle que le service rejetterait.
 */
export function coherentVoiceFor(model: string, currentVoice: string): string {
  const catalog = voiceCatalogFor(model);
  if (catalog.length === 0) return "";
  return catalog.some((v) => v.id === currentVoice) ? currentVoice : catalog[0].id;
}

/** Modèle de synthèse par défaut chez OpenRouter (70+ langues, bon marché). */
export const OPENROUTER_TTS_DEFAULT_MODEL = "google/gemini-3.1-flash-tts-preview";

/**
 * CORRECTION PONCTUELLE (pas un mécanisme de migration général) : ce slug,
 * repris d'un billet de blog OpenRouter périmé, a été écrit dans les configs
 * de la version précédente alors qu'il ne correspond à AUCUN modèle du
 * catalogue — la synthèse échouait avec « Model … does not exist ». On le
 * remplace au chargement par le défaut OpenRouter, en réalignant la voix sur
 * le catalogue du nouveau modèle. Toute autre valeur est laissée intacte.
 */
const DEAD_TTS_MODEL = "openai/gpt-4o-mini-tts-2025-12-15";

/* ---------- Lecture / écriture de la config (fusion défensive) ---------- */

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toMode(value: unknown, fallback: SpeechMode): SpeechMode {
  return value === "local" || value === "remote" ? value : fallback;
}

function toStr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function toSpeed(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Nombre borné : hors bornes, mal typé ou absent → défaut (jamais d'exception). */
function toBounded(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * `config.speech.conversation` brut → bloc complet. Une config antérieure à
 * l'ajout du mode conversation n'a pas cette clé du tout : chaque champ
 * retombe alors sur son défaut, et rien n'est cassé (rétrocompatibilité).
 * Les bornes évitent qu'une valeur aberrante (sensibilité à 12, silence à 0)
 * rende la détection inutilisable.
 */
function toConversationConfig(raw: unknown): SpeechConversationConfig {
  const d = DEFAULT_SPEECH_CONFIG.conversation;
  const c = asRecord(raw);
  return {
    sensitivity: toBounded(c.sensitivity, d.sensitivity, 0, 1),
    silenceMs: toBounded(c.silenceMs, d.silenceMs, 200, 5000),
    maxUtteranceMs: toBounded(c.maxUtteranceMs, d.maxUtteranceMs, 2000, 300000),
    autoPlayReply: toBool(c.autoPlayReply, d.autoPlayReply),
    // Toute valeur autre que « keyword » (champ absent d'une config antérieure
    // compris) retombe sur le défaut : rétrocompatible, aucune migration.
    sendMode: c.sendMode === "keyword" ? "keyword" : d.sendMode,
    sendKeyword: toStr(c.sendKeyword, d.sendKeyword).trim() || d.sendKeyword,
  };
}

/** `config.speech` brut → `SpeechConfig` complet (chaque champ manquant/invalide retombe sur le défaut). */
function toSpeechConfig(raw: unknown): SpeechConfig {
  const d = DEFAULT_SPEECH_CONFIG;
  const root = asRecord(raw);
  const stt = asRecord(root.stt);
  const sttLocal = asRecord(stt.local);
  const sttRemote = asRecord(stt.remote);
  const tts = asRecord(root.tts);
  const ttsLocal = asRecord(tts.local);
  const ttsRemote = asRecord(tts.remote);

  // Correction ponctuelle du slug mort (cf. DEAD_TTS_MODEL) : le modèle
  // enregistré est remplacé par le défaut OpenRouter, et la voix réalignée sur
  // le catalogue de ce nouveau modèle. La config n'est pas réécrite ici : elle
  // le sera au prochain enregistrement, la lecture corrigée suffisant à faire
  // fonctionner la synthèse entre-temps.
  const rawTtsModel = toStr(ttsRemote.model, d.tts.remote.model) || d.tts.remote.model;
  const ttsModel = rawTtsModel === DEAD_TTS_MODEL ? OPENROUTER_TTS_DEFAULT_MODEL : rawTtsModel;
  const rawTtsVoice = toStr(ttsRemote.voice, d.tts.remote.voice);
  const ttsVoice = ttsModel === rawTtsModel ? rawTtsVoice : coherentVoiceFor(ttsModel, rawTtsVoice);

  return {
    stt: {
      mode: toMode(stt.mode, d.stt.mode),
      language: toStr(stt.language, d.stt.language),
      inputDeviceId: toStr(stt.inputDeviceId, d.stt.inputDeviceId),
      local: { model: toStr(sttLocal.model, d.stt.local.model) || d.stt.local.model },
      remote: {
        baseUrl: toStr(sttRemote.baseUrl, d.stt.remote.baseUrl) || d.stt.remote.baseUrl,
        model: toStr(sttRemote.model, d.stt.remote.model) || d.stt.remote.model,
        // Champ absent (config antérieure à l'emprunt de clé) ou mal typé →
        // `""`, c'est-à-dire le mode automatique.
        keySource: toStr(sttRemote.keySource, d.stt.remote.keySource),
      },
    },
    tts: {
      mode: toMode(tts.mode, d.tts.mode),
      local: {
        voice: toStr(ttsLocal.voice, d.tts.local.voice) || d.tts.local.voice,
        speed: toSpeed(ttsLocal.speed, d.tts.local.speed),
      },
      remote: {
        baseUrl: toStr(ttsRemote.baseUrl, d.tts.remote.baseUrl) || d.tts.remote.baseUrl,
        model: ttsModel,
        // Voix distante : la chaîne vide reste tolérée (config héritée, ou
        // modèle dont le catalogue de voix est inconnu), elle ne retombe donc
        // pas sur le défaut — le service dira lui-même ce qu'il accepte.
        voice: ttsVoice,
        speed: toSpeed(ttsRemote.speed, d.tts.remote.speed),
        keySource: toStr(ttsRemote.keySource, d.tts.remote.keySource),
      },
    },
    conversation: toConversationConfig(root.conversation),
  };
}

/** Lit `config.speech` et le complète avec les défauts (config absente/partielle comprise). */
export async function readSpeechConfig(): Promise<SpeechConfig> {
  const raw = await readConfig();
  return toSpeechConfig(raw.speech);
}

/**
 * Comme `readSpeechConfig`, mais écrit les défauts dans config.json au premier
 * lancement (clé `speech` absente) — même comportement d'amorçage que la
 * liste de fournisseurs dans useProviders.
 */
export async function ensureSpeechConfig(): Promise<SpeechConfig> {
  const raw = await readConfig();
  const merged = toSpeechConfig(raw.speech);
  if (raw.speech === undefined) await writeSpeechConfig(merged);
  return merged;
}

/** Écrit la config voix (fusion racine, cf. appConfig.ts — le reste du document est préservé). */
export async function writeSpeechConfig(config: SpeechConfig): Promise<void> {
  await writeConfig({ speech: config });
}

/* ---------- Patch partiel (page Configuration) ---------- */

export interface SpeechConfigPatch {
  stt?: {
    mode?: SpeechMode;
    language?: string;
    inputDeviceId?: string;
    local?: Partial<SpeechSttConfig["local"]>;
    remote?: Partial<SpeechSttConfig["remote"]>;
  };
  tts?: {
    mode?: SpeechMode;
    local?: Partial<SpeechTtsConfig["local"]>;
    remote?: Partial<SpeechTtsConfig["remote"]>;
  };
  conversation?: Partial<SpeechConversationConfig>;
}

function mergeStt(base: SpeechSttConfig, patch?: SpeechConfigPatch["stt"]): SpeechSttConfig {
  if (!patch) return base;
  return {
    mode: patch.mode ?? base.mode,
    language: patch.language ?? base.language,
    inputDeviceId: patch.inputDeviceId ?? base.inputDeviceId,
    local: { ...base.local, ...patch.local },
    remote: { ...base.remote, ...patch.remote },
  };
}

function mergeTts(base: SpeechTtsConfig, patch?: SpeechConfigPatch["tts"]): SpeechTtsConfig {
  if (!patch) return base;
  return {
    mode: patch.mode ?? base.mode,
    local: { ...base.local, ...patch.local },
    remote: { ...base.remote, ...patch.remote },
  };
}

/** Fusion profonde d'un patch partiel dans une config complète (immutable). */
export function mergeSpeechConfig(base: SpeechConfig, patch: SpeechConfigPatch): SpeechConfig {
  return {
    stt: mergeStt(base.stt, patch.stt),
    tts: mergeTts(base.tts, patch.tts),
    conversation: { ...base.conversation, ...patch.conversation },
  };
}

/* ---------- Clés API (trousseau OS) ---------- */

function keyAccount(kind: SpeechKeyKind): string {
  return `speech:${kind}`;
}

export async function getSpeechKey(kind: SpeechKeyKind): Promise<string | null> {
  return invoke<string | null>("secret_get", { account: keyAccount(kind) });
}

export async function setSpeechKey(kind: SpeechKeyKind, value: string): Promise<void> {
  await invoke("secret_set", { account: keyAccount(kind), value });
}

export async function deleteSpeechKey(kind: SpeechKeyKind): Promise<void> {
  await invoke("secret_delete", { account: keyAccount(kind) });
}

/* ---------- Poussée au sidecar ---------- */

/** Statut « clé DÉDIÉE configurée » par usage (jamais la valeur elle-même). */
export interface SpeechKeyStatus {
  stt: boolean;
  tts: boolean;
}

/** D'où vient réellement la clé envoyée au sidecar, pour un usage donné. */
export interface SpeechKeyOrigin {
  /**
   * Fournisseur dont la clé a été retenue — celui demandé par la config en
   * mode explicite, celui découvert en mode automatique, `""` si aucun
   * (clé dédiée, ou automatique sans correspondance).
   */
  providerId: string;
  /** Mode automatique (`keySource` vide) : la source a été DEVINÉE depuis l'URL de base. */
  auto: boolean;
  /** La clé envoyée a bien été empruntée à `providerId`. */
  borrowed: boolean;
  /** Emprunt EXPLICITE demandé mais impossible (fournisseur supprimé ou sans clé) → repli sur la clé dédiée. */
  fallback: boolean;
  /** Une clé est effectivement disponible (empruntée ou dédiée). */
  configured: boolean;
}

export interface SpeechKeyOrigins {
  stt: SpeechKeyOrigin;
  tts: SpeechKeyOrigin;
}

export interface SpeechPushResult {
  config: SpeechConfig;
  keyStatus: SpeechKeyStatus;
  keyOrigin: SpeechKeyOrigins;
  voixLocale: VoixLocaleEtat;
}

/**
 * Disponibilité de la pile de voix LOCALE, telle que la rapporte le sidecar en
 * réponse à `speech.configure`.
 *
 * Elle n'est PAS embarquée dans les applications livrées (1,2 Go) : elle
 * s'installe après coup dans `dossier`. L'interface s'en sert pour ne pas
 * proposer micro et conversation quand ils échoueraient — voir
 * docs/empaquetage.md.
 *
 * En attendant la première réponse du sidecar, on suppose la voix DISPONIBLE :
 * masquer des boutons puis les faire réapparaître serait plus déroutant que
 * l'inverse, et le cas nominal (dépôt en développement, installation complétée)
 * est celui-là.
 */
export interface VoixLocaleEtat {
  disponible: boolean;
  /** Dossier où l'installer — vide tant que le sidecar n'a pas répondu. */
  dossier: string;
}

export const VOIX_LOCALE_INCONNUE: VoixLocaleEtat = { disponible: true, dossier: "" };

/*
 * ---------------------------------------------------------------------------
 * État vif de la voix, publié pour toute l'application
 * ---------------------------------------------------------------------------
 *
 * `useSpeech()` ne vit qu'une fois, dans App.tsx, alors que les boutons de voix
 * sont rendus dans DEUX pages (Projets et Chat). Plutôt que de faire descendre
 * l'information de props en props à travers toute l'arborescence, on la publie
 * ici — même patron que contextBus.ts / usageBus.ts.
 *
 * Ce que les boutons en font : ne pas s'afficher quand ils échoueraient. Un
 * micro qui ne peut rien transcrire est pire qu'un micro absent.
 */

interface EtatVoix {
  voixLocale: VoixLocaleEtat;
  config: SpeechConfig;
}

let etatVoix: EtatVoix = { voixLocale: VOIX_LOCALE_INCONNUE, config: DEFAULT_SPEECH_CONFIG };
const abonnesVoix = new Set<() => void>();

function publierEtatVoix(next: EtatVoix): void {
  etatVoix = next;
  for (const cb of abonnesVoix) cb();
}

export function lireEtatVoix(): EtatVoix {
  return etatVoix;
}

export function abonnerEtatVoix(cb: () => void): () => void {
  abonnesVoix.add(cb);
  return () => abonnesVoix.delete(cb);
}

/**
 * La dictée est-elle utilisable en l'état ? Faux uniquement dans le cas
 * « mode local choisi, mais pile locale absente » : en mode distant, la
 * disponibilité locale n'a rien à voir.
 */
export function dicteeUtilisable(etat: EtatVoix = etatVoix): boolean {
  return etat.config.stt.mode !== "local" || etat.voixLocale.disponible;
}

/** Idem pour la synthèse (lecture des réponses). */
export function syntheseUtilisable(etat: EtatVoix = etatVoix): boolean {
  return etat.config.tts.mode !== "local" || etat.voixLocale.disponible;
}

/** Clé d'un fournisseur, `null` si le compte est absent du trousseau (jamais d'exception). */
async function providerKeyOrNull(providerId: string): Promise<string | null> {
  try {
    return await getProviderKey(providerId);
  } catch {
    // Compte inexistant au trousseau : traité comme une clé absente.
    return null;
  }
}

/**
 * Mode automatique : premier fournisseur dont l'URL de base correspond (une
 * fois normalisée) à celle de la voix ET qui a une clé au trousseau. Plusieurs
 * fournisseurs peuvent partager la même URL : le premier qui a une clé gagne,
 * ce n'est pas un cas d'erreur.
 */
async function findMatchingProviderKey(
  providers: ProviderConfig[],
  baseUrl: string,
): Promise<{ providerId: string; key: string } | null> {
  const target = normalizeBaseUrl(baseUrl);
  if (!target) return null;
  for (const provider of providers) {
    if (!provider.needsKey || normalizeBaseUrl(provider.baseUrl) !== target) continue;
    const key = await providerKeyOrNull(provider.id);
    if (key) return { providerId: provider.id, key };
  }
  return null;
}

/**
 * Résout la clé d'un usage selon `keySource` :
 * - `""` → automatique : fournisseur deviné depuis l'URL de base, sinon clé
 *   dédiée (aucune des deux n'est une erreur ici, l'UI le signale) ;
 * - `SPEECH_KEY_DEDICATED` → clé dédiée, sans recherche ;
 * - id de fournisseur → emprunt explicite, avec repli silencieux (mais signalé
 *   via `fallback`) sur la clé dédiée si le fournisseur a disparu ou n'a plus
 *   de clé au trousseau. Une valeur inconnue tombe dans ce cas : elle se
 *   comporte comme un fournisseur sans clé, jamais comme une erreur.
 */
async function resolveSpeechKey(
  keySource: string,
  dedicated: string | null,
  providers: ProviderConfig[],
  baseUrl: string,
): Promise<{ key: string | null; origin: SpeechKeyOrigin }> {
  if (!keySource) {
    const match = await findMatchingProviderKey(providers, baseUrl);
    if (match) {
      return {
        key: match.key,
        origin: {
          providerId: match.providerId,
          auto: true,
          borrowed: true,
          fallback: false,
          configured: true,
        },
      };
    }
    return {
      key: dedicated,
      origin: {
        providerId: "",
        auto: true,
        borrowed: false,
        fallback: false,
        configured: !!dedicated,
      },
    };
  }
  if (keySource === SPEECH_KEY_DEDICATED) {
    return {
      key: dedicated,
      origin: {
        providerId: "",
        auto: false,
        borrowed: false,
        fallback: false,
        configured: !!dedicated,
      },
    };
  }
  const borrowed = await providerKeyOrNull(keySource);
  if (borrowed) {
    return {
      key: borrowed,
      origin: {
        providerId: keySource,
        auto: false,
        borrowed: true,
        fallback: false,
        configured: true,
      },
    };
  }
  return {
    key: dedicated,
    origin: {
      providerId: keySource,
      auto: false,
      borrowed: false,
      fallback: true,
      configured: !!dedicated,
    },
  };
}

/**
 * Relit la config + les clés du trousseau et pousse le tout au sidecar via
 * `speech.configure`. À appeler au démarrage de l'app et après chaque
 * changement (config modifiée, clé enregistrée/effacée).
 *
 * L'emprunt de clé à un fournisseur est résolu ICI : le sidecar ne reçoit
 * jamais que la clé finale dans `keys.stt` / `keys.tts`, son contrat est
 * inchangé.
 */
export async function pushSpeech(): Promise<SpeechPushResult> {
  const config = await readSpeechConfig();
  const [sttKey, ttsKey, providers] = await Promise.all([
    getSpeechKey("stt"),
    getSpeechKey("tts"),
    readProviders(),
  ]);
  const [stt, tts] = await Promise.all([
    resolveSpeechKey(config.stt.remote.keySource, sttKey, providers, config.stt.remote.baseUrl),
    resolveSpeechKey(config.tts.remote.keySource, ttsKey, providers, config.tts.remote.baseUrl),
  ]);
  const keys: { stt?: string; tts?: string } = {};
  if (stt.key) keys.stt = stt.key;
  if (tts.key) keys.tts = tts.key;
  const reponse = await request("speech.configure", { config, keys }).done;
  const brut = (reponse as Record<string, unknown> | undefined)?.voixLocale;
  const voixLocale: VoixLocaleEtat =
    typeof brut === "object" && brut !== null
      ? {
          disponible: (brut as Record<string, unknown>).disponible !== false,
          dossier:
            typeof (brut as Record<string, unknown>).dossier === "string"
              ? ((brut as Record<string, unknown>).dossier as string)
              : "",
        }
      : VOIX_LOCALE_INCONNUE;
  publierEtatVoix({ voixLocale, config });
  return {
    config,
    keyStatus: { stt: !!sttKey, tts: !!ttsKey },
    keyOrigin: { stt: stt.origin, tts: tts.origin },
    voixLocale,
  };
}

/* ---------- Transcription / synthèse (events `chunk` de progression) ---------- */

/** Progression relayée pendant le téléchargement d'un modèle local (voir le contrat). */
export interface SpeechProgress {
  status: string;
  progress?: number;
}

function toProgress(data: Record<string, unknown>): SpeechProgress | null {
  if (typeof data.status !== "string" || !data.status) return null;
  const p = data.progress;
  return {
    status: data.status,
    ...(typeof p === "number" && Number.isFinite(p) ? { progress: p } : {}),
  };
}

/** « statut (42 %) » — tolère un `progress` en fraction (0-1) comme en pourcentage (0-100). */
export function formatSpeechProgress(p: SpeechProgress): string {
  if (p.progress === undefined) return p.status;
  const pct = p.progress <= 1 ? p.progress * 100 : p.progress;
  return `${p.status} (${Math.round(pct)} %)`;
}

/** Transcrit un WAV PCM16 mono 16 kHz (base64) en texte via `speech.transcribe`. */
export async function speechTranscribe(
  audioBase64: string,
  onProgress?: (p: SpeechProgress) => void,
): Promise<string> {
  const { done } = request(
    "speech.transcribe",
    { audioBase64 },
    {
      onChunk: (data) => {
        const p = toProgress(data);
        if (p) onProgress?.(p);
      },
    },
  );
  const data = await done;
  return typeof data.text === "string" ? data.text : "";
}

export interface SynthesizedAudio {
  audioBase64: string;
  mime: string;
}

/** Synthétise un texte en audio via `speech.synthesize` (base64 + type MIME). */
export async function speechSynthesize(
  text: string,
  onProgress?: (p: SpeechProgress) => void,
): Promise<SynthesizedAudio> {
  const { done } = request(
    "speech.synthesize",
    { text },
    {
      onChunk: (data) => {
        const p = toProgress(data);
        if (p) onProgress?.(p);
      },
    },
  );
  const data = await done;
  if (typeof data.audioBase64 !== "string" || !data.audioBase64) {
    throw new Error("Synthèse vocale : audio absent de la réponse du sidecar.");
  }
  return {
    audioBase64: data.audioBase64,
    mime: typeof data.mime === "string" && data.mime ? data.mime : "audio/wav",
  };
}
