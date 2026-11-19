/*
 * S3 — un message glissé pendant un tour Claude : la logique pure de la
 * redirection du flux (feuille extraite d'envoiProjet.ts, qui garde le câblage).
 *
 * La bulle en cours est close (`continued`) avant la redirection : plus rien
 * ne la repassera à « done » ensuite (le `done` du tour ne patche que la
 * DERNIÈRE cible) — laissée en streaming, elle clignotait à vie et
 * disparaissait à la persistance. Viennent ensuite la bulle utilisateur, puis
 * une bulle assistant neuve qui reçoit la suite de la réponse.
 *
 * T-222 — les tâches de fond vivent dans le PROCESS, pas dans la bulle : elles
 * suivent le flux vers la nouvelle bulle. Laissées sur l'ancienne (close),
 * elles y affichaient « interrompue(s) avant leur terme » alors qu'elles
 * tournaient encore, et la nouvelle bulle n'en montrait rien.
 */

import type { AgentTurn } from "./agentTurns";
import type { SentAttachment } from "./Attachments";

export function avecMessageInjecte(
  prev: AgentTurn[],
  cibleId: string,
  ids: { utilisateur: string; assistant: string },
  text: string,
  attachments?: SentAttachment[],
): AgentTurn[] {
  const enCours = (t: AgentTurn) => t.id === cibleId && t.status === "streaming";
  const tachesHeritees = prev.find(enCours)?.backgroundTasks;
  return [
    ...prev.map((t) => {
      if (!enCours(t)) return t;
      const { backgroundTasks: _transferees, ...reste } = t;
      return { ...reste, status: "done" as const, continued: true };
    }),
    {
      id: ids.utilisateur,
      role: "user",
      content: text,
      displayContent: text,
      status: "done",
      injected: true,
      // T-064 — vignette comme pour un message normal, si le push en portait.
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    },
    // `suiteDeTour` : le fournisseur a déjà répondu plus haut dans ce tour —
    // cette bulle attend le prochain outil, pas le premier octet (T-027, sinon
    // l'avis « aucune donnée reçue » s'y affichait).
    {
      id: ids.assistant,
      role: "assistant",
      blocks: [],
      status: "streaming",
      suiteDeTour: true,
      ...(tachesHeritees ? { backgroundTasks: tachesHeritees } : {}),
    },
  ];
}
