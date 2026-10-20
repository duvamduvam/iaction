/*
 * Enveloppes CHRONOMÉTRÉES de la chaîne voix (T-149).
 *
 * POURQUOI ce module : l'utilisateur trouve la voix lente, mais le journal ne
 * chronométrait ni la transcription ni la synthèse — impossible de désigner le
 * maillon lent. Les enveloppes ci-dessous ont EXACTEMENT la signature de
 * `speechTranscribe`, `speechSynthesize` et `startPlaybackQueue` : les
 * appelants (useVoiceComposer, voiceConversation) ne changent que la
 * provenance de l'import. C'est volontaire — ces fichiers sont à leur plafond
 * du cliquet de taille, ils ne peuvent pas porter la mesure eux-mêmes.
 *
 * Trois mesures :
 * - durée de chaque appel de transcription et de synthèse (par fragment) ;
 * - délai « fin de la dernière transcription → premier texte de la réponse »
 *   (premier appel de synthèse) ;
 * - délai « fin de la dernière transcription → premier son » (`onStarted`).
 *
 * La fin de la dernière transcription réussie sert de repère : en mode
 * conversation comme en dictée, c'est elle qui précède l'envoi. Limite
 * assumée : une dictée non envoyée laisse un repère que la synthèse suivante
 * (lecture à voix haute d'un message) pourrait mesurer à tort ; il expire
 * donc après `VALIDITE_REPERE_MS`.
 *
 * Jamais de texte dicté ni de clé : durées et métadonnées seulement. La config
 * est relue APRÈS l'appel et sans l'attendre — la mesure ne doit rien ajouter
 * à la latence qu'elle mesure, et ne peut jamais faire échouer un appel.
 */
import { startPlaybackQueue as lectureReelle } from "./audioPlayback";
import {
  journalAppelSynthese,
  journalAppelTranscription,
  journalPremierSonReponse,
  journalPremierTexteReponse,
} from "./journalVoix";
import {
  readSpeechConfig,
  speechSynthesize as synthetiserReel,
  speechTranscribe as transcrireReel,
  type SpeechConfig,
} from "./speechAdmin";

/** Au-delà, le repère n'a plus de rapport avec la réponse qui arrive. */
export const VALIDITE_REPERE_MS = 120_000;

/** En-tête WAV canonique : 44 octets, puis PCM16 mono 16 kHz = 32 octets par ms. */
const OCTETS_ENTETE_WAV = 44;
const OCTETS_PAR_MS = 32;

/**
 * Durée d'un WAV PCM16 mono 16 kHz fourni en base64, déduite de la seule
 * longueur de la chaîne (sans décoder). `undefined` si la taille est absurde.
 */
export function dureeAudioWavMs(audioBase64: string): number | undefined {
  const n = audioBase64.length;
  if (n === 0 || n % 4 !== 0) return undefined;
  const bourrage = audioBase64.endsWith("==") ? 2 : audioBase64.endsWith("=") ? 1 : 0;
  const octets = (n / 4) * 3 - bourrage;
  if (octets <= OCTETS_ENTETE_WAV) return undefined;
  return Math.round((octets - OCTETS_ENTETE_WAV) / OCTETS_PAR_MS);
}

/** Mode et modèle réellement utilisés pour la transcription. */
export function descripteurTranscription(c: SpeechConfig): { mode: string; modele: string } {
  const mode = c.stt.mode;
  return { mode, modele: mode === "remote" ? c.stt.remote.model : c.stt.local.model };
}

/** Mode et modèle réellement utilisés pour la synthèse (en local : la voix, il n'y a pas de modèle choisi). */
export function descripteurSynthese(c: SpeechConfig): { mode: string; modele: string } {
  const mode = c.tts.mode;
  return { mode, modele: mode === "remote" ? c.tts.remote.model : c.tts.local.voice };
}

/**
 * Construit les enveloppes autour d'une horloge. L'horloge est injectée pour
 * que la durée se teste sans attendre ; en production, `performance.now`
 * (monotone : insensible aux sauts de l'horloge système).
 */
export function creerChronoVoix(maintenant: () => number) {
  /** Fin de la dernière transcription réussie ; `null` = rien à mesurer. */
  let repere: number | null = null;
  /** Le premier texte de la réponse a-t-il déjà été mesuré pour ce repère ? */
  let texteMesure = false;
  /** Rang du prochain fragment dans la réponse en cours (remis à 0 à chaque file de lecture). */
  let rang = 0;

  /** Repère encore valable, sinon on l'oublie. */
  const repereValide = (t: number): number | null => {
    if (repere !== null && t - repere > VALIDITE_REPERE_MS) repere = null;
    return repere;
  };

  /** Journalise sans jamais attendre ni lever : la mesure n'est pas dans le chemin critique. */
  const apresCoup = (
    kind: "stt" | "tts",
    ecrire: (mode: string, modele: string) => void,
  ): void => {
    void readSpeechConfig()
      .then((c) => {
        const d = kind === "stt" ? descripteurTranscription(c) : descripteurSynthese(c);
        ecrire(d.mode, d.modele);
      })
      .catch(() => {
        // Config illisible : on perd la mesure, pas l'appel.
      });
  };

  const speechTranscribe: typeof transcrireReel = async (audioBase64, onProgress) => {
    const debut = maintenant();
    const dureeAudioMs = dureeAudioWavMs(audioBase64);
    try {
      const texte = await transcrireReel(audioBase64, onProgress);
      const fin = maintenant();
      const dureeMs = Math.round(fin - debut);
      apresCoup("stt", (mode, modele) => journalAppelTranscription(mode, modele, dureeMs, "ok", dureeAudioMs));
      if (texte.trim()) {
        repere = fin;
        texteMesure = false;
      }
      return texte;
    } catch (err) {
      const dureeMs = Math.round(maintenant() - debut);
      apresCoup("stt", (mode, modele) => journalAppelTranscription(mode, modele, dureeMs, "echec", dureeAudioMs));
      throw err;
    }
  };

  const speechSynthesize: typeof synthetiserReel = async (text, onProgress) => {
    const debut = maintenant();
    const r = repereValide(debut);
    if (r !== null && !texteMesure) {
      texteMesure = true;
      journalPremierTexteReponse(Math.round(debut - r));
    }
    const rangFragment = rang++;
    try {
      const audio = await synthetiserReel(text, onProgress);
      const dureeMs = Math.round(maintenant() - debut);
      apresCoup("tts", (mode, modele) =>
        journalAppelSynthese(mode, modele, dureeMs, "ok", text.length, rangFragment));
      return audio;
    } catch (err) {
      const dureeMs = Math.round(maintenant() - debut);
      apresCoup("tts", (mode, modele) =>
        journalAppelSynthese(mode, modele, dureeMs, "echec", text.length, rangFragment));
      throw err;
    }
  };

  const startPlaybackQueue: typeof lectureReelle = (callbacks) => {
    // Une file = une réponse : le rang des fragments repart de zéro.
    rang = 0;
    return lectureReelle({
      ...callbacks,
      onStarted: () => {
        const r = repereValide(maintenant());
        if (r !== null) {
          journalPremierSonReponse(Math.round(maintenant() - r));
          repere = null; // une réponse, une mesure
        }
        callbacks.onStarted?.();
      },
    });
  };

  return { speechTranscribe, speechSynthesize, startPlaybackQueue };
}

const chrono = creerChronoVoix(() => performance.now());
export const speechTranscribe = chrono.speechTranscribe;
export const speechSynthesize = chrono.speechSynthesize;
export const startPlaybackQueue = chrono.startPlaybackQueue;

/** Ré-export : `voiceConversation.ts` n'a ainsi qu'une ligne d'import à changer (cliquet de taille). */
export { formatSpeechProgress } from "./speechAdmin";
