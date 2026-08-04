/*
 * Hook d'état de la voix (dictée STT / synthèse TTS) pour toute l'app — même
 * patron que useProviders : charge la config au montage (écrit les défauts au
 * premier lancement), pousse config + clés au sidecar (`speech.configure`) au
 * démarrage et à chaque changement, et expose les actions d'édition pour
 * l'onglet « Voix » de la page Configuration.
 *
 * Robustesse au démarrage : la config est affichée dès sa lecture, même si la
 * poussée vers le sidecar échoue (il peut ne pas encore être prêt) ; la
 * poussée initiale est retentée avec délai, et re-jouée à chaque événement
 * `ready` du sidecar (son état étant en mémoire, un redémarrage la perdrait).
 *
 * Le `useRef` d'initialisation évite un double chargement/double push en
 * StrictMode (montage/démontage/remontage en dev).
 */
import { useEffect, useRef, useState } from "react";
import { subscribeReady } from "./sidecar";
import {
  DEFAULT_SPEECH_CONFIG,
  deleteSpeechKey,
  ensureSpeechConfig,
  mergeSpeechConfig,
  pushSpeech,
  setSpeechKey,
  writeSpeechConfig,
  type SpeechConfig,
  type SpeechConfigPatch,
  type SpeechKeyKind,
  type SpeechKeyOrigins,
  type SpeechKeyStatus,
} from "./speechAdmin";

/**
 * Origine initiale, avant la première poussée : rien n'a encore été résolu, on
 * n'annonce donc ni emprunt ni clé disponible.
 */
const UNRESOLVED_ORIGIN = {
  providerId: "",
  auto: false,
  borrowed: false,
  fallback: false,
  configured: false,
} as const;
const DEDICATED_ORIGINS: SpeechKeyOrigins = { stt: UNRESOLVED_ORIGIN, tts: UNRESOLVED_ORIGIN };

export interface UseSpeechResult {
  config: SpeechConfig;
  keyStatus: SpeechKeyStatus;
  /** Origine réelle de la clé poussée au sidecar (emprunt, repli, disponibilité). */
  keyOrigin: SpeechKeyOrigins;
  errorMessage: string;
  saveConfig: (patch: SpeechConfigPatch) => Promise<void>;
  saveKey: (kind: SpeechKeyKind, value: string) => Promise<void>;
  clearKey: (kind: SpeechKeyKind) => Promise<void>;
}

const PUSH_RETRY_DELAY_MS = 700;
const PUSH_RETRY_MAX = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? "erreur inconnue";
  } catch {
    return "erreur inconnue";
  }
}

export function useSpeech(): UseSpeechResult {
  const [config, setConfig] = useState<SpeechConfig>(DEFAULT_SPEECH_CONFIG);
  const [keyStatus, setKeyStatus] = useState<SpeechKeyStatus>({ stt: false, tts: false });
  const [keyOrigin, setKeyOrigin] = useState<SpeechKeyOrigins>(DEDICATED_ORIGINS);
  const [errorMessage, setErrorMessage] = useState("");
  const initialized = useRef(false);

  // `pushSpeech` relit config + clés du disque/trousseau à chaque appel : pas
  // besoin de ref sur l'état courant (contrairement à useProviders).
  async function pushWithState(): Promise<void> {
    const result = await pushSpeech();
    setKeyStatus(result.keyStatus);
    setKeyOrigin(result.keyOrigin);
    setErrorMessage("");
  }

  useEffect(() => {
    // Re-pousse la config au sidecar à chaque `ready` (démarrage tardif ou
    // redémarrage après crash : son état en mémoire repart de zéro).
    // Souscrit à CHAQUE montage de l'effet (StrictMode compris).
    const unsubscribe = subscribeReady(() => {
      pushWithState().catch((err) => setErrorMessage(toMessage(err)));
    });

    // L'init ne tourne qu'une fois — voir l'avertissement StrictMode dans
    // useProviders : l'état du composant survit au démontage du premier effet,
    // il ne faut donc pas annuler ces setState au démontage.
    if (!initialized.current) {
      initialized.current = true;

      (async () => {
        try {
          const loaded = await ensureSpeechConfig();
          setConfig(loaded);

          // Poussée initiale avec retentatives (speech.configure échoue tant
          // que le sidecar n'est pas prêt).
          let lastError: unknown = null;
          for (let attempt = 0; attempt < PUSH_RETRY_MAX; attempt++) {
            try {
              await pushWithState();
              return;
            } catch (err) {
              lastError = err;
              await sleep(PUSH_RETRY_DELAY_MS);
            }
          }
          if (lastError) setErrorMessage(toMessage(lastError));
        } catch (err) {
          setErrorMessage(toMessage(err));
        }
      })();
    }

    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveConfig(patch: SpeechConfigPatch): Promise<void> {
    try {
      const next = mergeSpeechConfig(config, patch);
      await writeSpeechConfig(next);
      setConfig(next);
      await pushWithState();
    } catch (err) {
      setErrorMessage(toMessage(err));
      throw err;
    }
  }

  async function saveKey(kind: SpeechKeyKind, value: string): Promise<void> {
    await setSpeechKey(kind, value);
    await pushWithState();
  }

  async function clearKey(kind: SpeechKeyKind): Promise<void> {
    await deleteSpeechKey(kind);
    await pushWithState();
  }

  return { config, keyStatus, keyOrigin, errorMessage, saveConfig, saveKey, clearKey };
}
