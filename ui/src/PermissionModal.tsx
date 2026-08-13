/*
 * Modale de permissions et de questions d'agent — composants sortis
 * d'AgentPage le 2026-08-08 (étape 8, 2/2). La logique vit dans
 * questionsAgent.ts ; ici, uniquement du rendu.
 */

import { useEffect, useState } from "react";
import { prettyJson } from "./agentTurns";
import { asRecord } from "./base";
import {
  ANSWER_SEPARATOR,
  composeAskMessage,
  effectiveAnswers,
  isAskQuestionTool,
  isPicked,
  parseAskQuestions,
  permissionTitle,
  type AskAnswers,
  type AskCustomAnswers,
  type AskQuestion,
  type PermissionRequestItem,
} from "./questionsAgent";

export function DiffLines({ text, prefix, variant }: Readonly<{ text: string; prefix: string; variant: "removed" | "added" }>) {
  return (
    <pre className={`diff-block diff-block--${variant}`}>
      {text.split("\n").map((line, i) => (
        // Bloc figé au rendu (pas de ré-ordonnancement) : l'index suffit comme clé.
        // Clé = index assumée (voir commentaire) — règle react/no-array-index-key non chargée ici.
        <div className="diff-line" key={i}>
          {prefix}
          {line}
        </div>
      ))}
    </pre>
  );
}

export function EditDiff({ oldString, newString }: Readonly<{ oldString: string; newString: string }>) {
  return (
    <div className="diff-view">
      <DiffLines text={oldString} prefix="− " variant="removed" />
      <DiffLines text={newString} prefix="+ " variant="added" />
    </div>
  );
}

function AskUserQuestionBody({
  questions,
  answers,
  customs,
  onPickAnswer,
  onToggleCustom,
  onCustomChange,
}: Readonly<{
  questions: AskQuestion[];
  answers: AskAnswers;
  customs: AskCustomAnswers;
  onPickAnswer: (question: string, label: string, multiSelect: boolean) => void;
  /** Ouvre/ferme la réponse libre de CETTE question. */
  onToggleCustom: (question: string) => void;
  onCustomChange: (question: string, text: string) => void;
}>) {
  return (
    <div className="ask-question">
      {questions.map((q) => (
        <div key={q.question} className="ask-question__block">
          <div className="ask-question__head">
            {q.header && <span className="ask-question__chip">{q.header}</span>}
            {q.multiSelect && <span className="ask-question__multi">plusieurs choix possibles</span>}
          </div>
          <p className="ask-question__text">{q.question}</p>
          <ul className="ask-question__options">
            {q.options.map((o) => {
              const picked = isPicked(answers[q.question], o.label, q.multiSelect);
              return (
                <li key={o.label}>
                  <button
                    type="button"
                    className={`ask-question__option${picked ? " ask-question__option--picked" : ""}`}
                    aria-pressed={picked}
                    onClick={() => onPickAnswer(q.question, o.label, q.multiSelect)}
                    title={picked ? "Réponse sélectionnée" : "Utiliser cette réponse"}
                  >
                    <span className="ask-question__label">
                      <span className="ask-question__check" aria-hidden="true">
                        {picked ? "✓" : ""}
                      </span>
                      {o.label}
                    </span>
                    {o.description && <span className="ask-question__desc">{o.description}</span>}
                    {o.preview && <pre className="ask-question__preview">{o.preview}</pre>}
                  </button>
                </li>
              );
            })}
            {/* Échappatoire systématique : aucune suggestion ne convient
                toujours, et terminer le tour pour cause de choix inadapté
                coûte plus cher que d'écrire la réponse ici. */}
            <li>
              {(() => {
                const open = q.question in customs;
                return (
                  <button
                    type="button"
                    className={`ask-question__option${open ? " ask-question__option--picked" : ""}`}
                    aria-pressed={open}
                    onClick={() => onToggleCustom(q.question)}
                    title={open ? "Abandonner la réponse libre" : "Répondre autre chose"}
                  >
                    <span className="ask-question__label">
                      <span className="ask-question__check" aria-hidden="true">
                        {open ? "✓" : ""}
                      </span>
                      Autre…
                    </span>
                    <span className="ask-question__desc">
                      {q.multiSelect
                        ? "Ajouter une réponse à vous, en plus des choix cochés"
                        : "Aucune suggestion ne convient : écrire la réponse"}
                    </span>
                  </button>
                );
              })()}
            </li>
          </ul>
          {q.question in customs && (
            <input
              type="text"
              className="ask-question__custom"
              value={customs[q.question]}
              onChange={(e) => onCustomChange(q.question, e.currentTarget.value)}
              placeholder="Votre réponse…"
              aria-label={`Réponse libre — ${q.header || q.question}`}
              // Le champ vient d'apparaître sur un clic explicite : y placer le
              // curseur évite un second clic.
              autoFocus
            />
          )}
        </div>
      ))}
    </div>
  );
}

function PermissionBody({
  item,
  answers,
  customs,
  onPickAnswer,
  onToggleCustom,
  onCustomChange,
}: Readonly<{
  item: PermissionRequestItem;
  answers: AskAnswers;
  customs: AskCustomAnswers;
  onPickAnswer: (question: string, label: string, multiSelect: boolean) => void;
  onToggleCustom: (question: string) => void;
  onCustomChange: (question: string, text: string) => void;
}>) {
  const input = asRecord(item.toolInput);

  if (isAskQuestionTool(item.toolName)) {
    const questions = parseAskQuestions(item.toolInput);
    // Forme inattendue : on retombe sur le JSON plutôt que d'afficher un vide.
    if (questions.length > 0) {
      return (
        <AskUserQuestionBody
          questions={questions}
          answers={answers}
          customs={customs}
          onPickAnswer={onPickAnswer}
          onToggleCustom={onToggleCustom}
          onCustomChange={onCustomChange}
        />
      );
    }
  }
  if (item.toolName === "Edit" || item.toolName === "edit_file") {
    return <EditDiff oldString={String(input.old_string ?? "")} newString={String(input.new_string ?? "")} />;
  }
  if (item.toolName === "Write" || item.toolName === "write_file") {
    return <DiffLines text={String(input.content ?? "")} prefix="+ " variant="added" />;
  }
  if (item.toolName === "Bash" || item.toolName === "bash") {
    return (
      <div className="bash-block">
        {typeof input.description === "string" && input.description && (
          <p className="bash-block__desc">{input.description}</p>
        )}
        <pre className="bash-block__command">{String(input.command ?? "")}</pre>
      </div>
    );
  }
  return <pre className="pretty-json">{prettyJson(item.toolInput)}</pre>;
}

export function PermissionModal({
  item,
  extraCount,
  onDecide,
}: Readonly<{
  item: PermissionRequestItem;
  extraCount: number;
  onDecide: (decision: "allow" | "deny", message: string, rememberTool: boolean) => void;
}>) {
  const [reason, setReason] = useState("");
  const [answers, setAnswers] = useState<AskAnswers>({});
  const [customs, setCustoms] = useState<AskCustomAnswers>({});
  const [note, setNote] = useState("");
  const [rememberTool, setRememberTool] = useState(false);
  const isAskQuestion = isAskQuestionTool(item.toolName);
  const askQuestions = isAskQuestion ? parseAskQuestions(item.toolInput) : [];

  // Nouvelle demande affichée : on repart d'un état vierge.
  useEffect(() => {
    setReason("");
    setAnswers({});
    setCustoms({});
    setNote("");
    setRememberTool(false);
  }, [item.permissionId]);

  /** Ouvre/ferme la réponse libre d'une question. À l'ouverture, en choix
      unique, le choix suggéré est abandonné : les deux se contrediraient. */
  function handleToggleCustom(question: string) {
    const q = askQuestions.find((x) => x.question === question);
    setCustoms((prev) => {
      if (question in prev) {
        const { [question]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [question]: "" };
    });
    if (q && !q.multiSelect && !(question in customs)) {
      setAnswers((prev) => {
        const { [question]: _removed, ...rest } = prev;
        return rest;
      });
    }
  }

  function handleCustomChange(question: string, text: string) {
    setCustoms((prev) => ({ ...prev, [question]: text }));
  }

  /** Choix cliqué : remplace la réponse de SA question (choix unique) ou l'y bascule (choix multiple). */
  function handlePickAnswer(question: string, label: string, multiSelect: boolean) {
    // Choix unique : cliquer une suggestion ferme la réponse libre ouverte —
    // sinon la modale afficherait deux réponses contradictoires cochées.
    if (!multiSelect && question in customs) {
      setCustoms((prev) => {
        const { [question]: _removed, ...rest } = prev;
        return rest;
      });
    }
    setAnswers((prev) => {
      const current = prev[question];
      if (!multiSelect) {
        // Re-cliquer le choix retenu le désélectionne.
        if (current === label) {
          const { [question]: _removed, ...rest } = prev;
          return rest;
        }
        return { ...prev, [question]: label };
      }
      const parts = current ? current.split(ANSWER_SEPARATOR).filter(Boolean) : [];
      const index = parts.indexOf(label);
      if (index >= 0) parts.splice(index, 1);
      else parts.push(label);
      if (parts.length === 0) {
        const { [question]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [question]: parts.join(ANSWER_SEPARATOR) };
    });
  }

  // Message final : réponses composées (une par question) + complément libre
  // éventuel. Hors question (demande de permission), c'est la raison du refus.
  // Réponses effectives = choix cochés + réponses libres « Autre » (voir
  // effectiveAnswers) : c'est ce qui part à l'agent ET ce qui compte comme
  // « répondu », une réponse libre valant une réponse.
  const finalAnswers = effectiveAnswers(askQuestions, answers, customs);
  const composed = composeAskMessage(askQuestions, finalAnswers);
  const askMessage = [composed, note.trim()].filter(Boolean).join("\n");
  const decisionMessage = isAskQuestion ? askMessage : reason;
  // Toutes les questions ont-elles reçu une réponse ? (garde-fou avant envoi.)
  // Un « Autre… » ouvert mais laissé vide ne compte pas : la question reste
  // sans réponse, et le bouton d'envoi reste bloqué.
  const allAnswered = askQuestions.every((q) => Boolean(finalAnswers[q.question]));

  return (
    <div className="permission-overlay">
      <div className="permission-modal">
        <div className="permission-modal__head">
          <h3>{permissionTitle(item)}</h3>
          {extraCount > 0 && <span className="permission-modal__badge">+{extraCount} en attente</span>}
        </div>
        <div className="permission-modal__body">
          <PermissionBody
            item={item}
            answers={answers}
            customs={customs}
            onPickAnswer={handlePickAnswer}
            onToggleCustom={handleToggleCustom}
            onCustomChange={handleCustomChange}
          />
        </div>
        {isAskQuestion ? (
          <div className="field">
            <label htmlFor="permission-note">Complément libre (optionnel)</label>
            <input
              id="permission-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.currentTarget.value)}
              placeholder="Précision à ajouter à vos choix ci-dessus…"
            />
            {askQuestions.length > 1 && !allAnswered && (
              <p className="field__hint">Répondez à chaque question ci-dessus avant d'envoyer.</p>
            )}
          </div>
        ) : (
          <div className="field">
            <label htmlFor="permission-reason">Raison du refus (optionnel)</label>
            <input
              id="permission-reason"
              type="text"
              value={reason}
              onChange={(e) => setReason(e.currentTarget.value)}
              placeholder="Motif communiqué à l'agent…"
            />
          </div>
        )}
        {/* « Ne plus demander » n'a pas de sens pour une question posée à
            l'utilisateur : on la masque dans ce cas. */}
        {!isAskQuestion && (
          <label
            className="permission-modal__remember"
            title="Les prochaines demandes de cet outil seront autorisées automatiquement, jusqu'à la fermeture de l'application."
          >
            <input
              type="checkbox"
              checked={rememberTool}
              onChange={(e) => setRememberTool(e.currentTarget.checked)}
            />
            Ne plus demander pour « {item.toolName} » (session en cours)
          </label>
        )}
        <div className="permission-modal__actions">
          <button type="button" className="btn btn--deny" onClick={() => onDecide("deny", decisionMessage, false)}>
            {isAskQuestion ? "Ignorer la question" : "Refuser"}
          </button>
          <button
            type="button"
            className="btn btn--allow"
            // Question à réponses multiples : on n'envoie pas tant qu'une
            // question reste sans réponse (l'agent recevrait une réponse
            // partielle sans savoir laquelle manque).
            disabled={isAskQuestion && askQuestions.length > 1 && !allAnswered}
            onClick={() => onDecide("allow", decisionMessage, rememberTool)}
          >
            {isAskQuestion ? "Répondre" : "Autoriser"}
          </button>
        </div>
      </div>
    </div>
  );
}
