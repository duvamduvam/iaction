/*
 * Modale accessible fondée sur l'élément natif <dialog> + showModal() :
 * le navigateur rend le reste de la page inerte, gère Échap (événement
 * « cancel ») et restaure le focus sur l'élément déclencheur à la fermeture
 * — aucun piège de focus maison. Le clic sur le fond ferme aussi : le test
 * `e.target === dialog` n'est vrai que hors du contenu, à condition que
 * celui-ci soit enveloppé dans un élément interne (voir les usages :
 * `.orch-modal`, `.attachment-lightbox`). Styles : `.modal-dialog` et son
 * `::backdrop` dans App.css (reprennent l'ancien overlay).
 */
import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  label,
  onClose,
  children,
}: Readonly<{ label: string; onClose: () => void; children: ReactNode }>) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // Fermeture propre au démontage (bouton « Fermer », enregistrement…) :
    // close() rend au navigateur la restauration du focus.
    return () => dialog.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal-dialog"
      aria-label={label}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      // PAS de gestionnaire sur l'événement `close` : le nettoyage d'effet
      // ci-dessus appelle dialog.close(), et sous StrictMode (dev) l'effet est
      // monté-démonté-remonté — le `close` du cycle simulé déclenchait alors
      // onClose et la modale se refermait À L'OUVERTURE (constaté le
      // 2026-07-31 sur les éditeurs d'Orchestration). Échap passe par
      // `cancel`, le fond par le clic ci-dessus : toutes les fermetures
      // utilisateur restent couvertes.
      onCancel={onClose}
    >
      {children}
    </dialog>
  );
}
