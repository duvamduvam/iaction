/*
 * T-062 — logique pure de la fenêtre : quelle clé de mémoire utiliser pour
 * « dernier projet ouvert », et quel projet ouvrir au démarrage compte tenu
 * des fenêtres DÉJÀ ouvertes ailleurs (une seule fenêtre par projet,
 * décision utilisateur du 2026-08-15 — voir docs/etude-deux-projets.md §7).
 *
 * Feuille pure, sans accès Tauri : le câblage (lecture du registre côté
 * Rust, `getCurrentWindow()`, revendication) vit dans AgentPage.tsx.
 */
import { LAST_PROJECT_STATE_KEY } from "./modeleProjet";
import type { UsageProjet } from "./usageStatsClient";

/** Étiquette de la toute première fenêtre — celle qui existait avant T-062. */
export const FENETRE_PRINCIPALE = "main";

/**
 * Clé de state pour le dernier projet ouvert PAR CETTE fenêtre.
 *
 * `main` garde la clé historique `last-project` : c'est elle que portent
 * tous les postes déjà installés, et `state/last-project.json` reste un
 * singleton pour cette fenêtre-là — aucune migration à faire. Une AUTRE
 * fenêtre (`main-2`, `main-3`…) prend une clé dédiée : sans ça, les deux
 * fenêtres se disputeraient le même fichier, et la seconde ouverte
 * écraserait le souvenir de la première à chaque bascule de projet.
 */
export function cleDernierProjet(etiquette: string): string {
  return etiquette === FENETRE_PRINCIPALE ? LAST_PROJECT_STATE_KEY : `${LAST_PROJECT_STATE_KEY}-${etiquette}`;
}

/**
 * Projet à ouvrir au démarrage de cette fenêtre.
 *
 * `revendiques` est le registre `projet → étiquette` que porte la coquille
 * (`fenetres_projets_ouverts`) : une fenêtre ne doit jamais ouvrir un projet
 * qu'une AUTRE fenêtre a déjà revendiqué — sinon les deux écriraient dans le
 * même état projet, exactement le défaut que T-061/T-062 suppriment.
 *
 * - fenêtre PRINCIPALE : le projet mémorisé est rouvert s'il est encore
 *   déclaré ET (libre, ou déjà porté par CETTE fenêtre — idempotence : relire
 *   son propre souvenir au redémarrage du module ne doit jamais être refusé) ;
 * - fenêtre SECONDAIRE (`main-2`…) : le souvenir est ignoré — les étiquettes
 *   repartent à `main-2` à chaque lancement, il serait arbitraire ;
 * - dans les deux cas, à défaut : le projet LIBRE le plus utilisé (`poids`,
 *   voir `poidsDepuisStats`), plutôt qu'un écran vide sans explication ;
 *   égalité ou projet absent de la table → ordre de la liste déclarée ;
 * - si tout est pris, ou si la liste de projets est vide : `null`.
 */
export function choisirProjetInitial(
  memorise: string | null,
  projets: readonly string[],
  revendiques: Readonly<Record<string, string>>,
  etiquetteCourante: string,
  poids: Readonly<Record<string, number>> = {},
): string | null {
  const estLibrePourMoi = (id: string) => {
    const porteur = revendiques[id];
    return !porteur || porteur === etiquetteCourante;
  };
  if (
    etiquetteCourante === FENETRE_PRINCIPALE &&
    memorise &&
    projets.includes(memorise) &&
    estLibrePourMoi(memorise)
  ) {
    return memorise;
  }
  let meilleur: string | null = null;
  for (const id of projets) {
    if (!estLibrePourMoi(id)) continue;
    // Strictement supérieur : à égalité, le premier de la liste garde la place.
    if (meilleur === null || (poids[id] ?? 0) > (poids[meilleur] ?? 0)) meilleur = id;
  }
  return meilleur;
}

/**
 * Table `projet → poids d'utilisation` tirée de `parProjet` (stats d'usage).
 * Poids = tokens consommés (la part en % n'en est que la normalisation
 * arrondie : mêmes rangs, plus d'égalités artificielles) ; si aucun projet n'a
 * de tokens comptés, repli sur le nombre de tours. Le résidu « non attribué »
 * (`projectId` null) et le Chat n'ont pas de fenêtre de projet : ignorés.
 */
export function poidsDepuisStats(parProjet: readonly UsageProjet[] | null): Record<string, number> {
  const lignes = (parProjet ?? []).filter((l) => l.projectId !== null && l.projectId !== "chat");
  const parTokens = lignes.some((l) => l.totalTokens > 0);
  const out: Record<string, number> = {};
  for (const l of lignes) out[l.projectId as string] = parTokens ? l.totalTokens : l.tours;
  return out;
}
