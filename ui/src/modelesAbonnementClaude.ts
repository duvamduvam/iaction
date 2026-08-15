/*
 * Les modèles de l'abonnement Claude — une seule liste, trois consommateurs.
 *
 * ── Pourquoi une liste en dur ───────────────────────────────────────────
 * Contrairement aux fournisseurs neutres, l'abonnement Claude n'expose aucun
 * catalogue interrogeable : le CLI ne rend pas la liste des modèles auxquels
 * l'abonnement donne droit. On la maintient donc à la main, et on l'épingle
 * dans les sélecteurs pour qu'elle échappe aux filtres du catalogue neutre
 * (T-032).
 *
 * ── Pourquoi ELLE VIT ICI ───────────────────────────────────────────────
 * Elle était recopiée dans trois fichiers — le sélecteur des projets, celui
 * du Chat, et la table des fenêtres de contexte. Le 2026-08-13, `claude-opus-5`
 * était sorti depuis un moment et ne figurait dans aucun des trois : une liste
 * à recopier est une liste qu'on oublie de mettre à jour (T-046). Un seul
 * endroit, donc, et les trois consommateurs en dérivent.
 *
 * Tenir à jour : ordre du plus capable au plus économique — c'est l'ordre
 * d'affichage dans les sélecteurs.
 *
 * Ce qui SORT de la liste ne casse rien : un fil déjà épinglé sur un modèle
 * retiré affiche toujours son id et continue de tourner (ModelPicker retombe
 * sur la valeur brute) — il ne peut simplement plus être resélectionné.
 * `claude-opus-4-8` est sorti ainsi le 2026-08-13 : même tarif qu'Opus 5 pour
 * une génération de moins, il n'avait plus de raison d'occuper une ligne.
 */

/** Un modèle de l'abonnement, tel qu'on le propose à l'utilisateur. */
export interface ModeleAbonnement {
  /** Identifiant exact passé au CLI (jamais de suffixe de date). */
  id: string;
  /** Ce qu'on en dit dans le sélecteur, quand ce n'est pas évident. */
  note?: string;
}

export const MODELES_ABONNEMENT_CLAUDE: ModeleAbonnement[] = [
  { id: "claude-fable-5", note: "Le plus capable — raisonnement long, travail agentique" },
  { id: "claude-opus-5", note: "Opus courant — le meilleur rapport capacité/coût du haut de gamme" },
  { id: "claude-sonnet-5", note: "Proche d'Opus sur le code, plus rapide" },
  { id: "claude-haiku-4-5", note: "Le plus rapide et le plus économique" },
];

/** Ids seuls — pour les consommateurs qui n'ont que faire des libellés. */
export const IDS_ABONNEMENT_CLAUDE: string[] = MODELES_ABONNEMENT_CLAUDE.map((m) => m.id);
