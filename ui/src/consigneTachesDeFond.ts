/*
 * T-155 — consigne de tour sur l'attente des jobs : module feuille.
 *
 * Le modèle calque le comportement de Claude Code (réveil sur rapport d'une
 * tâche) sur des jobs lancés HORS du harnais du SDK (script SSH, process
 * distant…), les sonde par un `sleep` au premier plan (plafonné à 2 min), puis
 * clôt son tour en promettant « je reprends à leur fin » : rien ne le réveillera
 * jamais. Seule une tâche SUIVIE par le SDK (sous-agent en arrière-plan, Bash
 * `run_in_background`) garde le tour ouvert.
 *
 * Côté UI pour s'appliquer à chaud, et sur le SEUL chemin du moteur Claude :
 * les autres fournisseurs n'ont pas ces outils (voir envoiProjet.ts). Le chat
 * pur (ChatPage, `chatOnly`) n'a aucun outil : pas concerné.
 */

export const CONSIGNE_ATTENTE_TACHES = [
  "Attente de tâches : seul un sous-agent lancé en arrière-plan ou une commande Bash lancée avec `run_in_background` te réveille à sa fin.",
  "Un job externe (script, process distant, file d'attente) ne te réveillera jamais.",
  "Pour l'attendre, lance en arrière-plan (`run_in_background`) une boucle Bash qui sonde sa fin, par exemple `until <condition de fin>; do sleep 15; done`, plutôt qu'un `sleep` au premier plan (plafonné à 2 min).",
  "N'annonce jamais une reprise automatique si aucune tâche de fond de ce type n'est en cours : dis plutôt à l'utilisateur qu'il devra te relancer.",
  "L'application plafonne cette attente ; au-delà, les tâches encore vivantes sont abandonnées.",
].join("\n");

/** Instructions système du chemin Claude : celles de l'agent (éventuelles) + la consigne. */
export function avecConsigneTachesDeFond(instructions: string | undefined): string {
  return instructions ? `${instructions}\n\n${CONSIGNE_ATTENTE_TACHES}` : CONSIGNE_ATTENTE_TACHES;
}

/** Plafond lisible : « 30 min » (ou « 90 s » sous la minute). */
export function formaterPlafond(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}
