/*
 * Enregistrement micro → WAV PCM16 mono 16 kHz encodé base64 (le format
 * attendu par `speech.transcribe`, voir speechAdmin.ts).
 *
 * ── Pourquoi PAS `MediaRecorder` ────────────────────────────────────────
 * L'app tourne dans une webview WebKitGTK (Tauri sous Linux). WebKitGTK
 * désactive `MediaRecorder` par défaut (réglage `enable-media-recorder`,
 * absent du binding `webkit2gtk` 2.0.2 utilisé par Tauri) : l'objet existe,
 * `start()` ne lève pas, mais AUCUN `dataavailable` n'arrive et le blob final
 * est vide — d'où l'ancien message « Aucun son capté ». On capture donc le
 * PCM brut via Web Audio, qui fonctionne parfaitement dans cette webview.
 *
 * ── Chaîne complète ─────────────────────────────────────────────────────
 * `getUserMedia` (annulation d'écho + réduction de bruit + gain auto)
 *   → `AudioContext` au taux NATIF (on ne force pas 16 kHz : WebKit ne
 *     l'honore pas toujours et renvoie alors un contexte au taux matériel)
 *   → `createMediaStreamSource`
 *   → nœud d'accumulation : `AudioWorkletNode` en priorité (voie moderne,
 *     traitement dans le thread audio), avec repli sur `ScriptProcessorNode`
 *     (déprécié mais universellement présent dans WebKitGTK)
 *   → à l'arrêt : concaténation des `Float32Array` → ré-échantillonnage
 *     linéaire maison à 16 kHz → encodage WAV PCM16 mono → base64.
 *
 * ── Pièges traités ──────────────────────────────────────────────────────
 * • `ScriptProcessorNode` ne s'exécute QUE s'il est connecté à une
 *   destination. On le relie donc à un `GainNode` à gain 0 lui-même relié à
 *   `ctx.destination` : le graphe tourne, mais rien ne revient dans le
 *   casque (pas de larsen). Le worklet est câblé pareil, par sécurité :
 *   certaines implémentations ne planifient pas un nœud sans sortie.
 * • Casque Bluetooth (PipeWire) : le basculement de profil A2DP → HSP/HFP au
 *   démarrage de la capture prend un instant ; les ~300 premières ms sont
 *   silencieuses voire absentes. On les jette (voir WARMUP_MS).
 * • Un seul enregistrement à la fois (état module-scope, comme audioPlayback)
 *   et libération systématique des ressources (`track.stop()`, déconnexion
 *   des nœuds, `ctx.close()`) — y compris sur les chemins d'erreur — sinon
 *   l'indicateur micro de l'OS reste allumé et le profil BT reste en HSP.
 */

import type { CSSProperties } from "react";

/**
 * Taux de sortie imposé par `speech.transcribe`. Exporté : le mode
 * conversation (voiceConversation.ts) ré-échantillonne ses segments au même
 * taux avec les helpers publiés en bas de ce fichier.
 */
export const TARGET_SAMPLE_RATE = 16000;

/**
 * Amorçage ignoré au début de la capture : le temps que PipeWire bascule un
 * casque Bluetooth de A2DP (haute fidélité, sans micro) vers HSP/HFP
 * (mains-libres, avec micro). Ces premières millisecondes sont muettes ou
 * pleines d'artefacts — les garder fausserait la détection de silence.
 */
const WARMUP_MS = 300;

/** Crête en deçà de laquelle on considère que le micro n'a rien capté. */
const SILENCE_PEAK_THRESHOLD = 1e-4;

/** Durée utile minimale (hors amorçage) pour tenter une transcription. */
const MIN_USEFUL_MS = 200;

/** Cadence des remontées de niveau vers l'UI (~10 par seconde). */
const LEVEL_INTERVAL_MS = 100;

/** Taille de bloc du repli `ScriptProcessorNode` (valeur usuelle, ~85 ms à 48 kHz). */
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4096;

export interface StartRecordingOptions {
  /** Périphérique d'entrée à forcer (voir `listMicrophones`) ; vide = défaut système. */
  deviceId?: string;
  /** Niveau capté en direct (RMS 0→1), appelé ~10 fois par seconde. */
  onLevel?: (rms: number) => void;
}

export interface MicrophoneDevice {
  deviceId: string;
  label: string;
}

interface ActiveRecording {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  /** Nœud d'accumulation : worklet (moderne) ou script processor (repli). */
  node: AudioNode;
  /** Puits muet qui maintient le nœud dans le graphe de rendu. */
  sink: GainNode;
  /** Blocs mono conservés (amorçage déjà retiré). */
  chunks: Float32Array[];
  totalSamples: number;
  /** Échantillons vus depuis le début, amorçage compris (pour le décompte). */
  seenSamples: number;
  /** Nombre d'échantillons d'amorçage à jeter. */
  warmupSamples: number;
  sampleRate: number;
  onLevel?: (rms: number) => void;
  lastLevelAt: number;
  /** Détachement du nœud d'accumulation (retrait des écouteurs). */
  detach: () => void;
}

let active: ActiveRecording | null = null;

/**
 * Nom de l'autre consommateur du micro (aujourd'hui : le mode conversation),
 * quand il en détient un flux. Un micro peut techniquement être ouvert deux
 * fois, mais deux graphes Web Audio concurrents sur le même périphérique
 * donnent, en Bluetooth surtout, des captures hachées — et transcrire deux
 * fois la même phrase coûte deux fois. On refuse donc explicitement, avec un
 * message clair, plutôt que de laisser s'installer un état incohérent.
 *
 * Déclaré ici (et non dans voiceConversation.ts) pour éviter un import
 * circulaire : voiceConversation dépend d'audioCapture, jamais l'inverse.
 */
let micHolder: string | null = null;

/** Un enregistrement est-il en cours ? */
export function isRecording(): boolean {
  return active !== null;
}

/**
 * Réserve (ou libère avec `null`) le micro pour un consommateur externe.
 * Renvoie `false` si une dictée ponctuelle est déjà en cours : l'appelant doit
 * alors renoncer. Toujours relâcher, y compris sur les chemins d'erreur.
 */
export function acquireMicrophone(holder: string): boolean {
  if (active || micHolder) return false;
  micHolder = holder;
  return true;
}

export function releaseMicrophone(holder: string): void {
  if (micHolder === holder) micHolder = null;
}

/** Qui monopolise le micro hors dictée ponctuelle, le cas échéant. */
export function microphoneHolder(): string | null {
  return micHolder;
}

/* ---------- Retour visuel ---------- */

/**
 * Facteur de normalisation du RMS pour l'affichage. La parole ordinaire tient
 * autour de 0,02–0,15 en RMS : ×8 place une voix normale bien au milieu de la
 * jauge sans saturer en permanence.
 */
const LEVEL_DISPLAY_GAIN = 8;

/**
 * RMS brut → style inline portant `--mic-level` (0→1), consommé par les
 * classes `.mic-btn--recording` / `.mic-level` d'App.css. Centralisé ici pour
 * que le composeur du chat et le bouton « Tester » aient la même échelle.
 *
 * `threshold` (optionnel, même unité RMS) ajoute `--mic-threshold` : le mode
 * conversation s'en sert pour poser le repère de son seuil de déclenchement sur
 * la jauge. Il passe par cette fonction, et non par un calcul à part, pour que
 * le niveau et le repère partagent forcément la MÊME échelle — un repère décalé
 * mentirait sur la position du seuil, ce qui serait pire que de ne rien
 * afficher.
 */
export function micLevelStyle(rms: number, threshold?: number): CSSProperties {
  const level = Math.max(0, Math.min(1, rms * LEVEL_DISPLAY_GAIN));
  const style: Record<string, string> = { "--mic-level": level.toFixed(3) };
  if (threshold !== undefined) {
    const mark = Math.max(0, Math.min(1, threshold * LEVEL_DISPLAY_GAIN));
    style["--mic-threshold"] = mark.toFixed(3);
  }
  return style as CSSProperties;
}

/* ---------- Périphériques d'entrée ---------- */

/**
 * Liste les micros disponibles. Attention : les libellés ne sont renseignés
 * par le navigateur qu'APRÈS une première autorisation micro accordée — avant
 * cela `label` est vide, d'où le repli sur un nom générique. Utile surtout en
 * Bluetooth, pour forcer explicitement le casque plutôt que le micro interne.
 */
export async function listMicrophones(): Promise<MicrophoneDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audioinput")
    .map((d, index) => ({
      deviceId: d.deviceId,
      label: d.label || `Micro ${index + 1}`,
    }));
}

/* ---------- Démarrage ---------- */

/**
 * Erreur `getUserMedia` → message français actionnable. Exporté pour que le
 * mode conversation, qui ouvre son propre flux, rende exactement les mêmes
 * diagnostics que la dictée ponctuelle.
 */
export function toMicError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Accès au micro refusé — autorisez le micro pour utiliser la dictée.";
      case "NotFoundError":
        return "Aucun micro détecté sur cette machine.";
      case "OverconstrainedError":
        return "Le micro choisi n'est plus disponible — sélectionnez-en un autre dans Configuration › Dictée.";
      case "NotReadableError":
        return "Micro indisponible (déjà utilisé par une autre application ?).";
    }
  }
  return `Impossible d'accéder au micro : ${err instanceof Error ? err.message : String(err)}`;
}

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Code du processeur AudioWorklet, chargé depuis une blob URL (la CSP est à
 * `null` dans tauri.conf.json, donc `blob:` est permis ; l'URL est révoquée
 * juste après `addModule`). Il mixe les canaux en mono et poste des paquets
 * de 2048 échantillons — poster chaque quantum de 128 ferait ~375 messages
 * par seconde pour rien.
 */
const WORKLET_SOURCE = `
class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channels = input.length;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i];
      this.buffer[this.filled++] = sample / channels;
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-collector', PcmCollector);
`;

/**
 * Construit le nœud d'accumulation : AudioWorklet si possible, sinon
 * ScriptProcessorNode. Renvoie le nœud et sa fonction de détachement.
 *
 * Exporté : le mode conversation câble le même nœud, mais analyse chaque bloc
 * au lieu de tout accumuler.
 */
export async function createCollectorNode(
  ctx: AudioContext,
  onSamples: (samples: Float32Array) => void,
): Promise<{ node: AudioNode; detach: () => void }> {
  // Voie moderne : le traitement a lieu dans le thread audio, sans à-coups.
  if (ctx.audioWorklet) {
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, "pcm-collector", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      node.port.onmessage = (event: MessageEvent) => {
        if (event.data instanceof Float32Array) onSamples(event.data);
      };
      return {
        node,
        detach: () => {
          node.port.onmessage = null;
        },
      };
    } catch {
      // Worklet indisponible (module refusé, blob bloquée…) : on retombe
      // sur le ScriptProcessor ci-dessous plutôt que d'échouer.
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Repli : déprécié depuis des années, mais toujours présent — et fiable —
  // dans WebKitGTK. Il ne tourne que s'il est connecté à une destination
  // (câblage assuré par l'appelant, via un GainNode à gain 0).
  const node = ctx.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER_SIZE, 1, 1);
  const handler = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer;
    const channels = input.numberOfChannels;
    const frames = input.length;
    const mono = new Float32Array(frames);
    if (channels === 1) {
      mono.set(input.getChannelData(0));
    } else {
      for (let c = 0; c < channels; c++) {
        const data = input.getChannelData(c);
        for (let i = 0; i < frames; i++) mono[i] += data[i] / channels;
      }
    }
    onSamples(mono);
  };
  node.addEventListener("audioprocess", handler as EventListener);
  return {
    node,
    detach: () => node.removeEventListener("audioprocess", handler as EventListener),
  };
}

/**
 * Démarre l'enregistrement micro. Rejette avec un message français clair
 * (micro refusé, aucun micro…). `options.deviceId` force un périphérique
 * précis (utile en Bluetooth), `options.onLevel` reçoit le niveau en direct.
 */
export async function startRecording(options: StartRecordingOptions = {}): Promise<void> {
  if (active) throw new Error("Un enregistrement est déjà en cours.");
  if (micHolder) {
    throw new Error(
      `Micro déjà utilisé par ${micHolder} — arrêtez-le avant de lancer la dictée.`,
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("La capture audio n'est pas disponible dans cet environnement.");
  }

  const deviceId = options.deviceId?.trim() ?? "";
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
  } catch (err) {
    throw new Error(toMicError(err));
  }

  let ctx: AudioContext;
  try {
    // Taux natif volontairement : imposer 16000 ici est ignoré par WebKit et
    // peut faire échouer la construction du contexte sur certains backends.
    ctx = new AudioContext();
  } catch (err) {
    releaseStream(stream);
    throw new Error(
      `Impossible d'initialiser l'audio : ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    // Un contexte créé hors geste utilisateur peut naître « suspended ».
    if (ctx.state === "suspended") await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const { node, detach } = await createCollectorNode(ctx, onCapturedSamples);

    // Puits muet : indispensable au ScriptProcessor (il ne s'exécute que
    // relié à une destination) et sans risque de retour audio, gain à 0.
    const sink = ctx.createGain();
    sink.gain.value = 0;

    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);

    active = {
      stream,
      ctx,
      source,
      node,
      sink,
      chunks: [],
      totalSamples: 0,
      seenSamples: 0,
      warmupSamples: Math.round((WARMUP_MS / 1000) * ctx.sampleRate),
      sampleRate: ctx.sampleRate,
      onLevel: options.onLevel,
      lastLevelAt: 0,
      detach,
    };
  } catch (err) {
    releaseStream(stream);
    void ctx.close();
    throw new Error(
      `Impossible de démarrer l'enregistrement : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Réception d'un bloc mono : amorçage retiré, accumulation, remontée du niveau. */
function onCapturedSamples(samples: Float32Array): void {
  const current = active;
  if (!current) return;

  const start = current.seenSamples;
  current.seenSamples += samples.length;

  // Amorçage Bluetooth : on jette tout ce qui précède WARMUP_MS.
  if (current.seenSamples <= current.warmupSamples) return;
  const kept =
    start >= current.warmupSamples ? samples : samples.subarray(current.warmupSamples - start);
  if (kept.length === 0) return;

  // Copie obligatoire : le buffer du ScriptProcessor est réutilisé d'un
  // appel à l'autre, et `subarray` partage la mémoire sous-jacente.
  current.chunks.push(new Float32Array(kept));
  current.totalSamples += kept.length;

  if (current.onLevel) {
    const now = Date.now();
    if (now - current.lastLevelAt >= LEVEL_INTERVAL_MS) {
      current.lastLevelAt = now;
      let sum = 0;
      for (let i = 0; i < kept.length; i++) sum += kept[i] * kept[i];
      current.onLevel(Math.sqrt(sum / kept.length));
    }
  }
}

/** Démonte le graphe audio et libère le micro (idempotent, jamais lançant). */
function teardown(rec: ActiveRecording): void {
  try {
    rec.detach();
    rec.source.disconnect();
    rec.node.disconnect();
    rec.sink.disconnect();
  } catch {
    // Graphe déjà démonté : rien à faire.
  }
  releaseStream(rec.stream);
  void rec.ctx.close().catch(() => {
    /* contexte déjà fermé */
  });
}

/**
 * Arrête l'enregistrement en cours, libère le micro et renvoie l'audio
 * converti en WAV PCM16 mono 16 kHz, encodé base64 (sans préfixe data-URL).
 * Lève un message français distinct selon la cause d'un échec silencieux.
 */
export async function stopRecording(): Promise<string> {
  const current = active;
  if (!current) throw new Error("Aucun enregistrement en cours.");
  active = null;
  teardown(current);

  const { chunks, totalSamples, sampleRate } = current;

  // 1) Rien du tout : le nœud d'accumulation n'a jamais été appelé.
  if (totalSamples === 0) {
    throw new Error(
      "Aucune donnée audio reçue du micro. Une autre application monopolise peut-être le périphérique — fermez-la, puis réessayez.",
    );
  }

  // 2) Trop court pour transcrire quoi que ce soit.
  const durationMs = (totalSamples / sampleRate) * 1000;
  if (durationMs < MIN_USEFUL_MS) {
    throw new Error(
      "Enregistrement trop court — laissez la dictée tourner au moins une seconde avant de l'arrêter.",
    );
  }

  const samples = concatSamples(chunks, totalSamples);

  // 3) Le flux existe mais il est plat : micro coupé, ou casque Bluetooth
  //    resté en profil A2DP (qui ne fournit tout simplement pas de micro).
  const peak = peakLevel(samples);
  if (peak < SILENCE_PEAK_THRESHOLD) {
    throw new Error(
      "Micro silencieux : aucun son détecté. Vérifiez que le micro n'est pas coupé ; " +
        'si vous utilisez un casque Bluetooth, vérifiez que son profil est bien "Casque / mains-libres (HSP/HFP)" ' +
        'et non "Haute fidélité (A2DP)", qui ne fournit pas de micro.',
    );
  }

  const resampled = resampleLinear(samples, sampleRate, TARGET_SAMPLE_RATE);
  return bytesToBase64(new Uint8Array(encodeWavPcm16(resampled)));
}

/** Abandonne l'enregistrement en cours sans rien encoder (libère le micro). */
export function cancelRecording(): void {
  const current = active;
  if (!current) return;
  active = null;
  teardown(current);
}

/* ---------- Traitement du PCM accumulé ---------- */
/*
 * Les quatre helpers ci-dessous (concaténation, ré-échantillonnage, encodage
 * WAV, base64) sont EXPORTÉS et forment la chaîne « Float32 natif → base64
 * prêt pour `speech.transcribe` ». Le mode conversation les réutilise tels
 * quels sur chacun de ses segments : c'est la même chaîne, écrite une seule
 * fois — surtout ne pas la recopier ailleurs.
 */

export function concatSamples(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Amplitude maximale absolue — sert à distinguer « silence » de « son faible ». */
function peakLevel(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * Ré-échantillonnage linéaire maison (48 kHz → 16 kHz en pratique). On part
 * déjà de Float32 en mémoire : un aller-retour par `OfflineAudioContext`
 * imposerait un encodage/décodage inutile. L'interpolation linéaire suffit
 * amplement pour de la parole destinée à Whisper.
 */
export function resampleLinear(
  samples: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = samples[index];
    const b = index + 1 < samples.length ? samples[index + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Échantillons flottants [-1, 1] → fichier WAV PCM16 mono 16 kHz complet (en-tête de 44 octets). */
export function encodeWavPcm16(samples: Float32Array): ArrayBuffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // taille du bloc fmt
  view.setUint16(20, 1, true); // PCM linéaire
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * bytesPerSample, true); // octets/seconde
  view.setUint16(32, bytesPerSample, true); // alignement de bloc
  view.setUint16(34, 16, true); // bits par échantillon
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += bytesPerSample;
  }
  return buffer;
}

/** Base64 par tranches (éviter un `String.fromCharCode(...tout)` qui exploserait la pile d'appels). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
