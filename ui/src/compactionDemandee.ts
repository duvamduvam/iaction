/*
 * L'agent demande lui-même le compactage (T-216) — la logique pure de la file
 * et de l'avis « L'agent a demandé un compactage — il partira à la fin du
 * tour · Annuler » de la page Projets.
 *
 * Le chunk `compaction_demandee` (voir sidecar/src/compacterOutil.ts) ne
 * compacte rien : on fait exactement ce que fait le bouton « Compacter »
 * pendant un tour en cours — « /compact » en FILE, une fois au plus — et la
 * file part quand le tour rend vraiment la main (effet d'auto-envoi
 * d'AgentPage). Feuille pure, testable sans page ni sidecar : le câblage vit
 * dans envoiProjet.ts, AgentPage.tsx et agentTranscript.tsx.
 */

import type { AgentTurn } from "./agentTurns";

/** La commande du CLI, telle qu'elle part en file (bouton comme outil). */
export const COMMANDE_COMPACT = "/compact";

/** Une demande de l'agent, mémorisée sur la bulle qui l'a reçue (persistée avec elle). */
export interface CompactionDemandee {
  raison: string;
  /** Posé par « Annuler » : l'avis reste comme trace, sans bouton. */
  annule?: boolean;
}

/** Ce que ces fonctions lisent et écrivent du runtime d'une conversation. */
interface AvecFileEtTours {
  queuedPrompts: string[];
  turns: AgentTurn[];
}

/** « /compact » en file, sans doublon : déjà présent ⇒ le runtime est rendu tel quel. */
export function avecCompactEnFile<R extends { queuedPrompts: string[] }>(r: R): R {
  return r.queuedPrompts.includes(COMMANDE_COMPACT) ? r : { ...r, queuedPrompts: [...r.queuedPrompts, COMMANDE_COMPACT] };
}

/** Réception du chunk : avis posé sur la bulle `turnId`, « /compact » en file (une fois). */
export function avecCompactionDemandee<R extends AvecFileEtTours>(r: R, turnId: string, raison: string): R {
  const avecFile = avecCompactEnFile(r);
  return { ...avecFile, turns: r.turns.map((t) => (t.id === turnId ? { ...t, compactionDemandee: { raison } } : t)) };
}

/** « Annuler » : « /compact » retiré de la file, avis marqué annulé. */
export function annulerCompactionDemandee<R extends AvecFileEtTours>(r: R, turnId: string): R {
  return {
    ...r,
    queuedPrompts: r.queuedPrompts.filter((p) => p !== COMMANDE_COMPACT),
    turns: r.turns.map((t) =>
      t.id === turnId && t.compactionDemandee ? { ...t, compactionDemandee: { ...t.compactionDemandee, annule: true } } : t,
    ),
  };
}

/**
 * Index de la SEULE bulle dont l'avis peut porter « Annuler » : la dernière
 * demande non annulée, tant qu'aucun tour « /compact » n'est parti après elle
 * (sinon la demande est déjà servie). `-1` : aucune. Que « /compact » soit
 * encore en file, c'est l'appelant qui le sait (la file n'est pas dans les tours).
 */
export function indexCompactionAnnulable(turns: readonly AgentTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === "user" && (t.displayContent ?? t.content ?? "").trim() === COMMANDE_COMPACT) return -1;
    if (t.compactionDemandee) return t.compactionDemandee.annule ? -1 : i;
  }
  return -1;
}
