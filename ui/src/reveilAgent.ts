/*
 * L'agent arme lui-même le réveil (T-219) — la logique pure de l'armement.
 *
 * Le chunk `reveil_demande` (voir sidecar/src/reveilOutil.ts) n'arme rien :
 * l'UI construit ici un `Reveil` EXACTEMENT comme le contrôle ⏰ (même
 * `construireReveil` : cible de réouverture figée, repère d'armement posé à
 * l'instant) et le verse dans `reveils` de la conversation du tour. Il est
 * donc visible et annulable dans ⏰, et part par le battement habituel
 * (useReveil.ts) — tant que l'application reste ouverte (T-121).
 *
 * Feuille pure : ni horloge, ni identifiant tiré ici (`maintenant`, `id` et
 * `reouverture` sont des paramètres), ni React, ni journal — l'appelant
 * (envoiProjet.ts) journalise sur le canal `reveil`.
 */

import { construireReveil, estHeureValide, prochaineEcheance, type Reveil } from "./reveil";
import type { RuntimeAvecReveil } from "./reveilRuntime";
import type { ReveilDemandeData } from "./protocole";

/** Ce que l'armement a besoin de connaître du monde, injecté par l'appelant. */
export interface ContexteArmement {
  /** Identité du réveil (voir `nouvelIdReveil`). */
  id: string;
  /** Epoch ms. */
  maintenant: number;
  /** Instant de réouverture du quota connu (epoch ms), ou `null` — voir `instantReouvertureQuota`. */
  reouverture: number | null;
}

/** Heures valides, sans doublon, triées — celles de la demande qui ne sont pas bien formées sont écartées. */
export function heuresValides(heures: readonly string[]): string[] {
  return [...new Set(heures.map((h) => h.trim()).filter(estHeureValide))].sort();
}

/**
 * Le réveil que la demande de l'agent arme, ou le MOTIF du refus. Mêmes
 * règles que le contrôle ⏰ : un message à envoyer, et une échéance
 * calculable (heure valide, ou réouverture de quota connue) — sans elle le
 * réveil serait inerte, et mieux vaut le dire que l'armer en silence.
 */
export function reveilDepuisDemande(
  demande: ReveilDemandeData,
  ctx: ContexteArmement,
): { reveil: Reveil } | { refus: string } {
  const prompts = demande.prompts.map((p) => p.trim()).filter((p) => p !== "");
  if (prompts.length === 0) return { refus: "aucun message à envoyer" };
  const reveil = construireReveil({
    id: ctx.id,
    heures: heuresValides(demande.heures),
    surResetQuota: demande.surResetQuota,
    prompts,
    reouverture: ctx.reouverture,
    maintenant: ctx.maintenant,
  });
  if (prochaineEcheance(reveil, ctx.maintenant) !== null) return { reveil };
  return {
    refus: demande.surResetQuota
      ? "aucune heure valide et aucune date de réouverture de quota connue pour l'instant"
      : "aucune heure valide (format HH:MM)",
  };
}

/** Résultat de la réception du chunk : le runtime à écrire, et ce qu'il faut journaliser. */
export interface ArmementDemande<R> {
  runtime: R;
  /** Réveil armé, `null` si refusé. */
  reveil: Reveil | null;
  /** Motif du refus, `null` si armé. */
  refus: string | null;
}

/**
 * Réception du chunk : le réveil est versé dans `reveils` de la conversation,
 * et une notice discrète le dit (même emplacement que les notices de
 * déclenchement, `reveilNotice`). Un refus ne touche pas aux réveils mais
 * laisse la notice : c'est la seule trace côté écran d'une promesse que
 * l'agent croit tenue.
 */
export function avecReveilDemande<R extends RuntimeAvecReveil>(
  r: R,
  demande: ReveilDemandeData,
  ctx: ContexteArmement,
): ArmementDemande<R> {
  const at = new Date(ctx.maintenant).toISOString();
  const resultat = reveilDepuisDemande(demande, ctx);
  if ("refus" in resultat) {
    const label = `Réveil demandé par l'agent non armé — ${resultat.refus}`;
    return { runtime: { ...r, reveilNotice: { label, at } }, reveil: null, refus: resultat.refus };
  }
  const { reveil } = resultat;
  const quand = [...reveil.heures, ...(reveil.surResetQuota ? ["réouverture du quota"] : [])].join(", ");
  const label = `Réveil armé par l'agent — ${quand} (annulable dans ⏰)`;
  return { runtime: { ...r, reveils: [...r.reveils, reveil], reveilNotice: { label, at } }, reveil, refus: null };
}
