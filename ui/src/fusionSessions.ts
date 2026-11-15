/*
 * Fusion d'une session de projet avec son runtime vif (persistance) — la
 * logique pure sortie d'AgentPage.tsx (T-209). Le runtime est plus frais que
 * la copie de la liste pendant qu'une conversation est ouverte.
 */
import { titreSession, type ConvRuntime, type ProjectSession } from "./modeleProjet";

/** Session dont le tour s'est terminé alors que son projet n'est plus affiché : tours, session serveur et plancher Auto repris du runtime. */
export function sessionApresTourDeFond(s: ProjectSession, runtime: ConvRuntime, maintenant: string): ProjectSession {
  return {
    ...s,
    turns: runtime.turns,
    sessionId: runtime.sessionId,
    routedTier: runtime.routedTier,
    routedTarget: runtime.routedTarget,
    updatedAt: maintenant,
    title: titreSession(s, runtime.turns),
  };
}

/**
 * Session du projet affiché recombinée avec son runtime. `configActive` n'est
 * posé que pour la conversation active (moteur/modèle/agent éditables
 * seulement pour elle) ; le titre auto (non personnalisé) est recalculé.
 */
export function sessionAvecRuntime(
  s: ProjectSession,
  runtime: ConvRuntime,
  configActive: Pick<ProjectSession, "engine" | "selectedAgent"> | null,
  maintenant: string,
): ProjectSession {
  const merged: ProjectSession = {
    ...s,
    turns: runtime.turns,
    sessionId: runtime.sessionId,
    // R2 — l'affinité de session vit dans le runtime (posée au premier
    // envoi routé, effacée par un override) : recopiée pour persistance.
    routedTier: runtime.routedTier,
    routedTarget: runtime.routedTarget,
    // T-120 — le réveil vit aussi dans le runtime (armé/désarmé/consommé
    // au battement) : recopié pareil pour persistance.
    reveils: runtime.reveils,
    reveilsHistorique: runtime.reveilsHistorique,
    ...(configActive ?? {}),
    updatedAt: maintenant,
  };
  return { ...merged, title: titreSession(merged, merged.turns) };
}
