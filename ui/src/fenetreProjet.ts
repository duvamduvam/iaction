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
 * - le projet mémorisé est rouvert s'il est encore déclaré ET (libre, ou
 *   déjà porté par CETTE fenêtre — idempotence : relire son propre souvenir
 *   au redémarrage du module ne doit jamais être refusé) ;
 * - sinon (pris ailleurs, ou disparu de la liste des projets déclarés), on
 *   ouvre le premier projet LIBRE plutôt que de laisser un écran vide sans
 *   explication ;
 * - si tout est pris, ou si la liste de projets est vide : `null`.
 */
export function choisirProjetInitial(
  memorise: string | null,
  projets: readonly string[],
  revendiques: Readonly<Record<string, string>>,
  etiquetteCourante: string,
): string | null {
  const estLibrePourMoi = (id: string) => {
    const porteur = revendiques[id];
    return !porteur || porteur === etiquetteCourante;
  };
  if (memorise && projets.includes(memorise) && estLibrePourMoi(memorise)) return memorise;
  return projets.find(estLibrePourMoi) ?? null;
}
