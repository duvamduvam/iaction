/*
 * Commandes vocales du composeur, communes aux pages « Chat » et « Projets ».
 *
 * Rendu seulement : toute la logique vit dans `useVoiceComposer.ts`. Les deux
 * pages passent l'objet renvoyé par le hook, ce qui garantit des composeurs
 * jumeaux (mêmes classes, mêmes libellés, mêmes états) sans recopier une seule
 * ligne de JSX.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { micLevelStyle } from "./audioCapture";
import { stopPlayback } from "./audioPlayback";
import {
  abonnerEtatVoix,
  dicteeUtilisable,
  formatSpeechProgress,
  lireEtatVoix,
  syntheseUtilisable,
} from "./speechAdmin";
import { splitForSpeech } from "./speechChunker";
import {
  CONVERSATION_STATE_LABELS,
  startSpeechPipeline,
  stripMarkdownForSpeech,
  type SpeechPipeline,
  type VoiceComposer,
} from "./useVoiceComposer";

type TtsButtonState = "idle" | "loading" | "playing";

/**
 * Bouton lecture ⏵/⏹ discret des réponses assistant terminées : le texte
 * (Markdown grossièrement nettoyé) est découpé en fragments, synthétisé
 * fragment par fragment et joué au fil de l'eau — le son démarre après le
 * premier fragment, pas après la synthèse de toute la réponse. Re-clic = stop.
 * La lecture est unique à l'échelle de l'app (voir audioPlayback.ts) : démarrer
 * ici arrête la lecture d'une autre réponse, dont le bouton repasse au repos via
 * son rappel de fin.
 *
 * Ici, rien à anticiper : la réponse est terminée, il n'y a donc pas de mode
 * « pendant l'écriture » — seulement le pipeline de synthèse.
 */
export function TtsButton({ text }: Readonly<{ text: string }>) {
  const [state, setState] = useState<TtsButtonState>("idle");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  // Pipeline courant : sert à l'arrêt sur re-clic et au démontage (un bouton qui
  // disparaît ne doit pas laisser des synthèses tourner dans le vide).
  const pipelineRef = useRef<SpeechPipeline | null>(null);

  useEffect(() => {
    return () => {
      pipelineRef.current?.stop();
      pipelineRef.current = null;
    };
  }, []);

  function handleClick() {
    if (state === "loading" || state === "playing") {
      // Arrêt : coupe le son ET annule les fragments encore à synthétiser.
      pipelineRef.current?.stop();
      stopPlayback();
      return;
    }
    const chunks = splitForSpeech(stripMarkdownForSpeech(text));
    if (chunks.length === 0) return;
    setState("loading");
    setProgress("");
    setError("");
    const pipeline = startSpeechPipeline({
      onProgress: (p) => setProgress(formatSpeechProgress(p)),
      // Le premier son démarre : on passe de « … » à ⏹.
      onStarted: () => {
        setState("playing");
        setProgress("");
      },
      onError: (message) => setError(message),
      onFinished: () => {
        // Garanti exactement une fois : fin normale, arrêt, remplacement par
        // une autre lecture, ou échec total.
        if (pipelineRef.current === pipeline) pipelineRef.current = null;
        setState("idle");
        setProgress("");
      },
    });
    pipelineRef.current = pipeline;
    pipeline.enqueue(chunks);
    pipeline.end();
  }

  const label =
    state === "playing"
      ? "Arrêter la lecture"
      : state === "loading"
        ? `${progress || "Synthèse en cours…"} — cliquer pour annuler`
        : "Lire à voix haute";

  return (
    <div className="chat-bubble__tts">
      <button
        type="button"
        className={`tts-btn${state === "playing" ? " tts-btn--playing" : ""}`}
        // Le bouton reste actif pendant la synthèse : elle est maintenant
        // fragment par fragment, donc annulable à tout moment (et ce n'est plus
        // la courte attente d'un unique appel).
        onClick={handleClick}
        title={label}
        aria-label={label}
      >
        {state === "playing" ? "⏹" : state === "loading" ? "…" : "⏵"}
      </button>
      {state === "loading" && progress && <span className="chat-bubble__tts-progress">{progress}</span>}
      {error && <span className="chat-bubble__tts-error">Erreur : {error}</span>}
    </div>
  );
}

/**
 * Le niveau et le seuil sont des RMS (typiquement 0,001 → 0,2) : illisibles
 * tels quels. On les affiche en POUR MILLE, sans unité et sans décimale — deux
 * ou trois chiffres qui se comparent d'un coup d'œil, ce qui est exactement
 * l'usage : « est-ce que ma voix dépasse le seuil, oui ou non ? ».
 */
function formatVadValue(rms: number): string {
  return String(Math.round(Math.max(0, rms) * 1000));
}

/**
 * Bandeau d'état du mode conversation, avec DIAGNOSTIC de la détection.
 *
 * Pourquoi ce diagnostic existe : lors d'une régression, une calibration polluée
 * plaçait le seuil d'activité vocale au-dessus de la voix de l'utilisateur. Le
 * bandeau affichait « À l'écoute », l'utilisateur parlait, et rien — absolument
 * rien — ne lui indiquait la cause. La jauge porte donc maintenant un REPÈRE à
 * la position du seuil, doublé des deux valeurs chiffrées : si la barre ne
 * franchit jamais le repère quand on parle, le diagnostic est immédiat et le
 * réglage de sensibilité devient actionnable.
 *
 * Le tout reste discret (police mono, 0,7 rem, `aria-hidden` sur les valeurs)
 * pour ne pas transformer un composeur de chat en console de mixage.
 */
function ConversationStatus({ voice }: Readonly<{ voice: VoiceComposer }>) {
  const micOpen =
    voice.conversationState === "listening" || voice.conversationState === "speaking";
  const gaugeTitle = `Niveau capté ${formatVadValue(voice.conversationLevel)} — seuil de déclenchement ${formatVadValue(
    voice.conversationThreshold,
  )} (pour mille). Votre voix doit dépasser le repère ; sinon, augmentez la sensibilité dans Configuration › Dictée.`;

  return (
    <div
      className={`conversation-status conversation-status--${voice.conversationState}`}
      role="status"
      aria-live="polite"
    >
      <span className="conversation-status__dot" aria-hidden="true" />
      <span className="conversation-status__label">{CONVERSATION_STATE_LABELS[voice.conversationState]}</span>
      {/* Jauge + repère de seuil : n'ont de sens que micro ouvert — pendant la
          transcription, la réflexion ou la lecture, l'audio entrant est jeté et
          afficher un seuil laisserait croire à une détection en cours. */}
      {micOpen && (
        <>
          <span className="conversation-status__vad" aria-hidden="true">
            {formatVadValue(voice.conversationLevel)}/{formatVadValue(voice.conversationThreshold)}
          </span>
          <span
            className="mic-level mic-level--threshold conversation-status__level"
            style={micLevelStyle(voice.conversationLevel, voice.conversationThreshold)}
            title={gaugeTitle}
          >
            <span className="mic-level__bar" />
            <span className="mic-level__mark" aria-hidden="true" />
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Lignes d'état affichées AU-DESSUS de la ligne du composeur : erreur micro,
 * progression de transcription, état du mode conversation et message discret.
 * Volontairement placées là (et non dans la colonne d'icônes) : ce sont des
 * textes qui ont besoin de toute la largeur pour rester lisibles.
 */
export function VoiceStatus({ voice }: Readonly<{ voice: VoiceComposer }>) {
  return (
    <>
      {voice.micError && (
        <div className="result-line result-line--error">
          {voice.micError}
          <button
            type="button"
            className="btn btn--ghost result-line__dismiss"
            onClick={voice.dismissMicError}
            aria-label="Masquer l'erreur"
          >
            ×
          </button>
        </div>
      )}
      {voice.micState === "transcribing" && (
        <div className="result-line">{voice.micProgress || "Transcription en cours…"}</div>
      )}
      {/* Mode conversation : état lisible en permanence — écoute (micro
          ouvert) et lecture doivent se distinguer d'un coup d'œil. */}
      {voice.conversationOn && <ConversationStatus voice={voice} />}
      {voice.conversationNotice && <div className="conversation-notice">{voice.conversationNotice}</div>}
    </>
  );
}

/**
 * Boutons micro et mode conversation, à placer dans la colonne d'outils du
 * composeur (`.chat-composer__tools`), sous le bouton de pièces jointes.
 * `disabled` couvre les raisons propres à la page (page Projets : aucun projet
 * sélectionné, donc rien à qui parler).
 *
 * Les boutons DISPARAISSENT — ils ne sont pas seulement grisés — quand la voix
 * n'est pas utilisable : mode local choisi alors que la pile locale n'est pas
 * installée (elle n'est pas embarquée dans les applications livrées, voir
 * docs/empaquetage.md). Un bouton grisé invite à chercher pourquoi ; un bouton
 * absent n'appelle rien. L'explication et la marche à suivre vivent au seul
 * endroit qui peut y répondre : Configuration → Voix.
 *
 * Le micro dépend de la DICTÉE, le mode conversation des deux (il écoute puis
 * lit la réponse à voix haute).
 */
export function VoiceButtons({ voice, disabled = false }: Readonly<{ voice: VoiceComposer; disabled?: boolean }>) {
  const etat = useSyncExternalStore(abonnerEtatVoix, lireEtatVoix);
  const dictee = dicteeUtilisable(etat);
  const conversation = dictee && syntheseUtilisable(etat);
  if (!dictee && !conversation) return null;
  return (
    <>
      <button
        type="button"
        className={`btn btn--ghost mic-btn${voice.micState === "recording" ? " mic-btn--recording" : ""}`}
        // `--mic-level` (0→1) pilote l'intensité du halo en CSS.
        style={voice.micState === "recording" ? micLevelStyle(voice.micLevel) : undefined}
        onClick={voice.onMicClick}
        // Exclusif avec le mode conversation : un seul flux micro.
        disabled={disabled || voice.micState === "transcribing" || voice.conversationOn}
        title={voice.micLabel}
        aria-label={voice.micLabel}
      >
        {voice.micState === "transcribing" ? "…" : "🎤"}
      </button>
      {conversation && (
      <button
        type="button"
        className={`btn btn--ghost conversation-btn${voice.conversationOn ? " conversation-btn--active" : ""}`}
        // `--mic-level` (0→1) pilote l'intensité du halo, comme le bouton micro.
        style={voice.conversationOn ? micLevelStyle(voice.conversationLevel) : undefined}
        onClick={voice.onToggleConversation}
        disabled={disabled || voice.micState !== "idle"}
        aria-pressed={voice.conversationOn}
        title={voice.conversationLabel}
        aria-label={voice.conversationLabel}
      >
        🗣
      </button>
      )}
      {voice.micState === "recording" && (
        <span className="mic-level" style={micLevelStyle(voice.micLevel)} aria-hidden="true">
          <span className="mic-level__bar" />
        </span>
      )}
    </>
  );
}
