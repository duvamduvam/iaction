/*
 * Le FIL de la page Chat : la bulle et la liste de bulles, sorties de
 * ChatPage.tsx (pendant exact de agentTranscript.tsx pour la page Projets).
 *
 * ── Pourquoi un module à part ───────────────────────────────────────────
 * Pas seulement pour alléger un fichier-dieu. La liste est ici un composant
 * MÉMOÏSÉ à props primitives : tant que la transcription ne change pas, un
 * rendu de la page ne la traverse plus du tout. C'est ce qui manquait à la
 * frappe (T-031) — le rattrapage débouncé du composeur (voir
 * useComposerLiveDraft.ts) re-rend la page quatre fois par seconde pour
 * dégriser un bouton, et parcourait au passage les deux cents bulles du fil.
 * Chacune s'arrêtait bien à son `memo`, mais deux cents comparaisons quatre
 * fois par seconde, sur une page qui en fait déjà beaucoup, se sentent.
 *
 * `ChatEntry` reste défini dans ChatPage.tsx et importé ICI en type seul :
 * l'import disparaît à la compilation, il n'y a donc pas de cycle à
 * l'exécution — même montage que les autres feuilles extraites de la page.
 */
import { memo } from "react";
import { SentAttachments } from "./Attachments";
import { closeDanglingFence, Markdown } from "./Markdown";
import { SourcesWeb } from "./SourcesWeb";
import { MESSAGE_ATTENTE_FOURNISSEUR, enAttenteDuPremierOctet, useAttenteFournisseur } from "./useAttenteFournisseur";
import { TtsButton } from "./VoiceControls";
import type { ChatEntry } from "./ChatPage";

/** Mémoïsé : seules les entrées dont l'objet change re-rendent (le brouillon
    du composeur vit dans l'état de la page — sans memo, chaque frappe
    re-rendait toutes les bulles, markdown compris). */
export const ChatBubble = memo(function ChatBubble({ entry }: Readonly<{ entry: ChatEntry }>) {
  const roleClass = entry.role === "user" ? "chat-bubble--user" : "chat-bubble--assistant";
  // T-006/T-027 — attente du PREMIER octet, règle partagée avec le fil Projets.
  const attenteFournisseur = useAttenteFournisseur(
    enAttenteDuPremierOctet({ role: entry.role, status: entry.status, vide: entry.content === "" }),
  );
  return (
    <div className={`chat-bubble ${roleClass}`}>
      <div className="chat-bubble__content">
        {/* Rendu Markdown pour l'assistant uniquement — l'utilisateur reste en
            texte brut pre-wrap. En streaming, une fence de code encore ouverte
            est refermée pour le rendu (stabilité du parse — voir Markdown.tsx). */}
        {entry.role === "assistant" ? (
          <Markdown content={entry.status === "streaming" ? closeDanglingFence(entry.content) : entry.content} />
        ) : (
          entry.content
        )}
        {entry.status === "streaming" && <span className="cursor" />}
      </div>
      {attenteFournisseur && <div className="chat-bubble__note">{MESSAGE_ATTENTE_FOURNISSEUR}</div>}
      {entry.attachments && entry.attachments.length > 0 && <SentAttachments items={entry.attachments} />}
      {entry.status === "error" && <div className="chat-bubble__error">Erreur : {entry.errorMessage}</div>}
      {entry.status === "aborted" && <div className="chat-bubble__note">Réponse interrompue.</div>}
      {entry.status === "done" && entry.usage && (
        <div className="chat-bubble__usage">
          {entry.usage.promptTokens ?? "?"} + {entry.usage.completionTokens ?? "?"} tokens
        </div>
      )}
      {/*
        R9 — sources citées. Elles sont sous la réponse, numérotées comme les
        `[n]` du texte, et cliquables : une réponse qui se dit fraîche sans
        montrer d'où elle vient est exactement ce que T-010 reprochait.
      */}
      <SourcesWeb sources={entry.sourcesWeb} />
      {/* R1 — badge des tours envoyés en « Auto » : tier → modèle, raisons en infobulle. */}
      {entry.routeTier && entry.routeModel && (
        <div className="chat-bubble__route" title={(entry.routeReasons ?? []).join(" · ")}>
          ⚡ auto : {entry.routeTier} → {entry.routeModel}
        </div>
      )}
      {entry.role === "assistant" && entry.status === "done" && entry.content.trim() && (
        <TtsButton text={entry.content} />
      )}
    </div>
  );
});

/**
 * Contenu du conteneur `.chat-log` : indicateur de compaction, invite du fil
 * vide, bulles. Le conteneur lui-même (défilement, recollage en bas) reste à
 * la page — c'est elle qui tient la ref.
 *
 * Props volontairement PRIMITIVES en dehors de `entries` (`messagesResumes`
 * plutôt que l'objet compaction, rappel stable pour l'ouverture du résumé) :
 * un objet reconstruit à chaque rendu suffirait à faire tomber la mémoïsation
 * sans que rien ne le signale.
 */
export const TranscriptionChat = memo(function TranscriptionChat({
  entries,
  messagesResumes,
  onOuvrirResume,
}: Readonly<{
  entries: ChatEntry[];
  /** Nombre de messages couverts par le résumé de compaction — `null` si aucun (R4). */
  messagesResumes: number | null;
  onOuvrirResume: () => void;
}>) {
  return (
    <>
      {/* R4 — indicateur discret en tête de transcription : le résumé
          remplace les anciens tours À L'ENVOI seulement, la transcription
          affichée reste intégrale. Clic → modale (résumé consultable). */}
      {messagesResumes !== null && (
        <button
          type="button"
          className="chat-compaction"
          onClick={onOuvrirResume}
          title="Les anciens tours sont envoyés sous forme de résumé — cliquez pour le consulter"
        >
          {/* `upToIndex` compte des ENTRÉES de transcription (messages
              utilisateur + assistant), pas des tours complets. */}
          historique compacté ({messagesResumes} messages résumés)
        </button>
      )}
      {entries.length === 0 && <p className="empty-hint">Aucun message. Écrivez ci-dessous pour démarrer.</p>}
      {entries.map((entry) => (
        <ChatBubble key={entry.id} entry={entry} />
      ))}
    </>
  );
});
