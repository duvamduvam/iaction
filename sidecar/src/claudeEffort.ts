/*
 * Niveau d'effort de raisonnement d'un tour Claude (`claude.start`, param `effort`).
 *
 * Le SDK l'accepte en `Options.effort`. Un niveau que le modèle ne supporte pas
 * est rétrogradé en silence par le CLI : le sidecar n'a donc pas à connaître la
 * table modèle → niveaux (elle vit côté UI, modelesAbonnementClaude.ts).
 *
 * Valeur absente, nulle ou inconnue ⇒ `undefined` : on ne pose RIEN, et le
 * réglage global (~/.claude/settings.json) ou le défaut du modèle s'applique.
 * Une valeur invalide n'est jamais une erreur bloquante pour le tour.
 */

export const NIVEAUX_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
export type NiveauEffort = (typeof NIVEAUX_EFFORT)[number];

export function effortValide(valeur: unknown): NiveauEffort | undefined {
  return typeof valeur === "string" && (NIVEAUX_EFFORT as readonly string[]).includes(valeur)
    ? (valeur as NiveauEffort)
    : undefined;
}
