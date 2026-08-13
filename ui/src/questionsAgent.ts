/*
 * Questions posées par l'agent et titres de permission — la logique PURE de la
 * modale de permissions, sortie d'AgentPage le 2026-08-08 (étape 8, 2/2).
 *
 * Une « demande de permission » de l'outil ask_user est en réalité une
 * question posée à l'utilisateur : ses réponses repartent vers l'agent comme
 * résultat d'outil. Ce module décide ce qui est affiché et ce qui est
 * renvoyé ; les composants (PermissionModal.tsx) ne font que le rendre.
 *
 * Feuille : un seul import, le socle. Le parseur est DÉFENSIF — toute forme
 * inattendue est ignorée plutôt que de casser la modale, car une modale qui
 * plante bloque le tour entier côté agent.
 */

import { asRecord } from "./base";

export interface PermissionRequestItem {
  targetId: string;
  permissionId: string;
  toolName: string;
  toolInput: unknown;
  /** Moteur d'origine du tour : détermine claudePermission vs neutralPermission à la réponse. */
  engine: "claude" | "neutral";
  /** Projet propriétaire du tour (clé du « ne plus demander ») — absent en orchestration. */
  projectId?: string | null;
}

export function permissionTitle(item: PermissionRequestItem): string {
  const input = asRecord(item.toolInput);
  if ((item.toolName === "Edit" || item.toolName === "edit_file") && typeof input.file_path === "string") {
    return `Modifier ${input.file_path}`;
  }
  if ((item.toolName === "Write" || item.toolName === "write_file") && typeof input.file_path === "string") {
    return `Créer/écraser ${input.file_path}`;
  }
  if (item.toolName === "Bash" || item.toolName === "bash") return "Exécuter une commande";
  if (isAskQuestionTool(item.toolName)) return "Question de l'agent";
  return `Autoriser ${item.toolName} ?`;
}

/* ---------- Question de l'agent : rendu lisible (au lieu du JSON brut) ---------- */

/**
 * Outils dont la « demande de permission » est en réalité une QUESTION posée à
 * l'utilisateur : la modale affiche des choix cliquables et la réponse repart
 * comme résultat de l'outil (voir sidecar/src/askUser.ts).
 *
 * - `mcp__studio__ask_user` : notre outil in-process, le seul en service.
 * - `AskUserQuestion` : l'outil intégré du CLI, désactivé côté sidecar
 *   (`disallowedTools`) parce que non adressable via le SDK — gardé ici pour
 *   qu'un tour venu d'ailleurs reste lisible.
 */
export function isAskQuestionTool(toolName: string): boolean {
  return toolName === "mcp__studio__ask_user" || toolName === "AskUserQuestion";
}

export interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

/** Parseur défensif : toute forme inattendue est ignorée plutôt que de casser la modale. */
export function parseAskQuestions(toolInput: unknown): AskQuestion[] {
  const input = asRecord(toolInput);
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const questions: AskQuestion[] = [];
  for (const entry of raw) {
    const q = asRecord(entry);
    if (typeof q.question !== "string" || !q.question) continue;
    const options: AskOption[] = [];
    for (const optEntry of Array.isArray(q.options) ? q.options : []) {
      const o = asRecord(optEntry);
      if (typeof o.label !== "string" || !o.label) continue;
      options.push({
        label: o.label,
        description: typeof o.description === "string" ? o.description : "",
        ...(typeof o.preview === "string" && o.preview ? { preview: o.preview } : {}),
      });
    }
    questions.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : "",
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return questions;
}

/** Séparateur des choix au sein d'UNE question à choix multiple. */
export const ANSWER_SEPARATOR = " ; ";

/** Réponses de l'utilisateur, une entrée par question (clé = texte de la
 *  question) — indispensable avec plusieurs questions : chacune garde son
 *  propre choix, sélectionner dans l'une ne touche plus aux autres. */
export type AskAnswers = Record<string, string>;

/**
 * Réponses libres « Autre », une entrée par question. La CLÉ PRÉSENTE (même
 * avec une valeur vide) signifie « cette question est en réponse libre » —
 * distinct de la valeur vide seule, qui ne dirait pas si le champ est ouvert.
 * Le complément libre global (`note`) répond à côté des questions ; ceci
 * répond À une question précise, quand aucune suggestion ne convient.
 */
export type AskCustomAnswers = Record<string, string>;

/**
 * Réponse effective d'une question : la réponse libre remplace les choix
 * (question à choix unique) ou s'y ajoute (choix multiple — les suggestions
 * cochées restent pertinentes, la précision libre les complète).
 */
export function effectiveAnswer(q: AskQuestion, answers: AskAnswers, customs: AskCustomAnswers): string {
  const picked = answers[q.question] ?? "";
  if (!(q.question in customs)) return picked;
  const custom = customs[q.question].trim();
  if (!q.multiSelect) return custom;
  return [picked, custom].filter(Boolean).join(ANSWER_SEPARATOR);
}

/** Réponses effectives de toutes les questions (choix + réponses libres). */
export function effectiveAnswers(
  questions: AskQuestion[],
  answers: AskAnswers,
  customs: AskCustomAnswers,
): AskAnswers {
  const out: AskAnswers = {};
  for (const q of questions) {
    const value = effectiveAnswer(q, answers, customs);
    if (value) out[q.question] = value;
  }
  return out;
}

/** Un choix est « sélectionné » s'il figure dans la réponse de SA question. */
export function isPicked(answerForQuestion: string | undefined, label: string, multiSelect: boolean): boolean {
  if (!answerForQuestion) return false;
  return multiSelect ? answerForQuestion.split(ANSWER_SEPARATOR).includes(label) : answerForQuestion === label;
}

/**
 * Message communiqué à l'agent, composé des réponses de chaque question. Une
 * seule question : la réponse brute (comportement historique). Plusieurs :
 * chaque réponse est préfixée du `header` (ou, à défaut, de la question) pour
 * que l'agent sache à quoi elle se rapporte.
 */
export function composeAskMessage(questions: AskQuestion[], answers: AskAnswers): string {
  const answered = questions
    .map((q) => ({ q, a: answers[q.question] }))
    .filter((x): x is { q: AskQuestion; a: string } => Boolean(x.a));
  if (answered.length === 0) return "";
  if (questions.length === 1) return answered[0].a;
  return answered.map(({ q, a }) => `${q.header || q.question} : ${a}`).join("\n");
}

