/**
 * Choix du fournisseur d'une page de discussion : que faire du fournisseur
 * sélectionné quand la liste des fournisseurs disponibles change ?
 *
 * Raison d'être — ticket T-018. Le repli automatique d'origine comparait
 * bêtement le fournisseur courant à la liste du moment : pendant la fenêtre où
 * cette liste est vide (démarrage de l'app, et surtout chaque REDÉMARRAGE du
 * sidecar, qui reperd sa table en mémoire), le seul identifiant restant était
 * « Claude (abonnement) », et le choix de l'utilisateur était écrasé sans un
 * mot. Rien ne le rétablissait ensuite : un repli TRANSITOIRE devenait
 * DÉFINITIF.
 *
 * Deux idées corrigent ça, et elles vivent ici plutôt que dans la page pour
 * être testables sans monter React :
 *
 * 1. une liste vide n'est pas l'information « plus aucun fournisseur », c'est
 *    l'ABSENCE d'information — on ne décide rien tant qu'on ne sait rien ;
 * 2. le choix EXPLICITE de l'utilisateur survit à la disparition temporaire de
 *    son fournisseur : dès qu'il réapparaît, on y revient.
 *
 * Module feuille volontairement pur : types uniquement, aucun import de valeur
 * (surtout pas `sidecar.ts`, qui s'abonne aux événements Tauri dès son
 * chargement et rendrait ce test impossible à exécuter hors de l'app).
 */

export interface EntreeChoixFournisseur {
  /**
   * Dernier fournisseur DÉLIBÉRÉMENT posé (sélecteur, bascule de conversation,
   * restauration de session…) — jamais un repli automatique. Vide tant que
   * l'utilisateur n'a rien choisi.
   */
  choisi: string;
  /** Fournisseur actuellement appliqué à la conversation affichée. */
  courant: string;
  /**
   * Identifiants sélectionnables à cet instant. Vide = on ne sait pas encore
   * (voir plus haut), surtout pas « il n'y en a plus ».
   */
  disponibles: readonly string[];
}

/**
 * L'identifiant à appliquer, ou `null` s'il n'y a rien à changer.
 */
export function resoudreFournisseur({ choisi, courant, disponibles }: EntreeChoixFournisseur): string | null {
  // T-018 : sans information, on ne touche à rien.
  if (disponibles.length === 0) return null;

  // Le choix de l'utilisateur est de retour : on le lui rend.
  if (choisi && choisi !== courant && disponibles.includes(choisi)) return choisi;

  // Le fournisseur courant a réellement disparu (supprimé de la config) : repli
  // sur le premier disponible, faute de mieux.
  if (!disponibles.includes(courant)) return disponibles[0];

  return null;
}
