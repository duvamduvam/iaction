/*
 * Indicateur d'en-tête du veilleur du relais (T-227) : « Veilleur actif ·
 * <projet> », ou l'état qui le bloque (suspendu, en attente du coffre,
 * invalide). Rien quand il est inactif. Un clic ouvre la page Projets et y
 * déplie la section « Veilleur ».
 */
import { useStatutVeilleur } from "./useStatutVeilleur";
import { EVENEMENT_OUVRIR_SECTION } from "./veilleurClient";
import { libelleEtat, libelleIndicateur } from "./veilleurFormulaire";

export function VeilleurIndicateur({ onOuvrir }: Readonly<{ onOuvrir: () => void }>) {
  const { statut, erreur } = useStatutVeilleur();
  if (erreur) {
    return (
      <span className="veilleur-bouton veilleur-bouton--bad" title={erreur}>
        Veilleur : statut illisible
      </span>
    );
  }
  const texte = libelleIndicateur(statut);
  if (!texte || !statut) return null;
  const { ton } = libelleEtat(statut.etat);
  return (
    <button
      type="button"
      className={`veilleur-bouton veilleur-bouton--${ton}`}
      title={statut.motif ?? "Veilleur du relais : ouvrir sa section"}
      onClick={() => {
        onOuvrir();
        // Après le changement de page : la section est montée avant d'être dépliée.
        setTimeout(() => window.dispatchEvent(new Event(EVENEMENT_OUVRIR_SECTION)), 0);
      }}
    >
      {texte}
    </button>
  );
}
