/*
 * Deux petits composants communs aux listes de sessions des pages Projets et
 * Chat (T-197) : le champ de recherche au-dessus de la liste, et le bouton
 * « Nommer les anciennes discussions (N) » en bas. Rendu pur : la décision
 * (filtre, éligibilité, passage) vit dans titresDiscussions.ts.
 */

import type { EtatRattrapage } from "./useRattrapageTitres";

export function RechercheSessions(props: Readonly<{ valeur: string; onChange: (v: string) => void; id: string }>) {
  const { valeur, onChange, id } = props;
  return (
    <input
      id={id}
      type="search"
      className="session-recherche"
      placeholder="Rechercher une discussion…"
      aria-label="Rechercher une discussion"
      value={valeur}
      onChange={(e) => onChange(e.currentTarget.value)}
      onKeyDown={(e) => {
        // Échap vide le champ ; on garde l'événement pour ne pas fermer autre chose si rien n'était saisi.
        if (e.key === "Escape" && valeur !== "") {
          e.preventDefault();
          e.stopPropagation();
          onChange("");
        }
      }}
    />
  );
}

export function RattrapageTitres(
  props: Readonly<{ n: number; etat: EtatRattrapage; onLancer: () => void; onArreter: () => void }>,
) {
  const { n, etat, onLancer, onArreter } = props;
  if (etat.enCours) {
    return (
      <div className="session-rattrapage" role="status">
        <span>
          Nommage en cours… {Math.min(etat.fait + 1, etat.total)}/{etat.total}
        </span>
        <button type="button" className="btn btn--ghost" onClick={onArreter}>
          Arrêter
        </button>
      </div>
    );
  }
  if (n <= 0 && !etat.message) return null;
  return (
    <div className="session-rattrapage">
      {n > 0 && (
        <button
          type="button"
          className="btn btn--ghost session-list__new"
          title="Demande un titre à Haiku pour chaque discussion qui n'en a pas : une requête par discussion, sur votre abonnement."
          onClick={onLancer}
        >
          Nommer les anciennes discussions ({n})
        </button>
      )}
      {etat.message && <p className="empty-hint" role="status">{etat.message}</p>}
    </div>
  );
}
