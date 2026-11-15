/*
 * T-186 — garde de la persistance par projet. Feuille pure (aucun import) :
 * la page Agent écrit le fichier d'état d'un projet à partir de REFS
 * (`sessionsRef`, onglets, fichiers ouverts) qui décrivent le projet CHARGÉ,
 * mais sous l'id que l'appelant lui passe — souvent pris dans une closure de
 * rendu. Si les deux divergent (bascule de projet en vol, minuteur de
 * sauvegarde tiré entre le chargement et le rendu), les sessions d'un projet
 * sont écrites sous la clé d'un autre : constaté le 2026-11-04, `projet-rdpl`
 * réécrit avec les quatre sessions de Krishnamurti. La cause exacte n'est pas
 * reproduite ; ce garde est donc DÉFENSIF — il refuse l'écriture douteuse, et
 * l'appelant la rend visible (journal + avis), jamais muette.
 */

export type VerdictEcriture =
  | { autorise: true }
  | { autorise: false; raison: string; champs: Record<string, string | null> };

/**
 * @param idEcrit    le projet sous la clé duquel l'appelant veut écrire
 * @param idCharge   le projet dont les sessions sont réellement dans `sessionsRef`
 *                   (`null` : aucun projet chargé)
 */
export function jugerEcritureProjet(idEcrit: string, idCharge: string | null): VerdictEcriture {
  if (idCharge === idEcrit) return { autorise: true };
  return {
    autorise: false,
    raison:
      idCharge === null
        ? "aucun projet n'est chargé dans les sessions vives"
        : "le projet chargé dans les sessions vives n'est pas celui qu'on écrit",
    champs: { projetEcrit: idEcrit, projetCharge: idCharge },
  };
}

/** Avis à l'utilisateur quand une écriture est refusée : court, renvoie au journal. */
export const AVIS_ECRITURE_REFUSEE =
  "Sauvegarde du projet refusée : l'état affiché ne correspond pas au projet à écrire. Rien n'a été modifié sur le disque, voir le journal.";

/**
 * File d'exécution en série : chaque tâche attend la fin de la précédente,
 * qu'elle ait réussi ou échoué (un rejet ne bloque pas la file). Sert à
 * sérialiser `selectProject` — deux bascules concurrentes se chevauchaient
 * autour de l'`await` de revendication.
 */
export function creerSerie(): { executer: <T>(tache: () => Promise<T>) => Promise<T> } {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    executer<T>(tache: () => Promise<T>): Promise<T> {
      const resultat = queue.then(tache, tache);
      queue = resultat.catch(() => undefined);
      return resultat;
    },
  };
}

/** Avis à l'utilisateur quand l'écriture du fichier projet échoue : court, renvoie au journal. */
export const AVIS_ECRITURE_ECHOUEE =
  "Sauvegarde du projet impossible : le fichier n'a pas pu être écrit (disque plein ou verrouillé ?). Voir le journal.";

/**
 * Un `sauverProjet` rejeté ne doit jamais être muet : journal consolidé (niveau
 * `error`, le projet et la cause) PUIS avis visible. Les deux effets sont
 * injectés, la feuille reste pure ; l'appelant ne fait que lui passer l'erreur.
 */
export function signalerEchecEcritureProjet(
  err: unknown,
  projetId: string,
  effets: {
    journaliser: (message: string, champs: Record<string, string>) => void;
    avertir: (avis: string) => void;
  },
): void {
  const cause = err instanceof Error ? err.message : String(err);
  effets.journaliser("écriture du fichier projet en échec", { projet: projetId, cause });
  effets.avertir(AVIS_ECRITURE_ECHOUEE);
}
