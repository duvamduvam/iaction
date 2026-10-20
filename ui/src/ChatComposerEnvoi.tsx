/*
 * Colonne de boutons à droite du composeur : envoyer et redescendre au bas du
 * fil (« Arrêter » est passé dans la colonne d'icônes de gauche, voir
 * `BoutonArret` en fin de fichier). Partagée par le Chat et les Projets —
 * les deux pages avaient le même bloc à deux détails près : ce qui tient lieu
 * de destination (fournisseur + modèle ici, dossier de travail là-bas) et ce
 * que dit l'infobulle pendant un tour (mise en file ou injection).
 */

export interface ChatComposerEnvoiProps {
  /** Un tour est en cours : l'envoi met en file ou injecte. */
  streaming: boolean;
  /** Le brouillon ne contient que du vide. */
  brouillonVide: boolean;
  /** Pièces jointes déjà prêtes : un message sans texte reste envoyable. */
  nbPiecesJointes: number;
  /** Une pièce jointe est encore en cours de chargement : envoi bloqué. */
  piecesEnChargement: boolean;
  /** Il y a bien où envoyer (fournisseur + modèle, ou dossier de travail). */
  destinationPrete: boolean;
  /** Infobulle d'« Envoyer » pendant un tour : ce qu'il advient du message. */
  titreEnvoiStreaming: string;
  onEnvoyer: () => void;
  onAllerEnBas: () => void;
}

export function ChatComposerEnvoi({
  streaming,
  brouillonVide,
  nbPiecesJointes,
  piecesEnChargement,
  destinationPrete,
  titreEnvoiStreaming,
  onEnvoyer,
  onAllerEnBas,
}: ChatComposerEnvoiProps) {
  // Pendant un tour, les pièces jointes ne partent pas : seul le texte compte.
  const envoiDesactive =
    !destinationPrete ||
    (streaming ? brouillonVide : (brouillonVide && nbPiecesJointes === 0) || piecesEnChargement);

  return (
    <div className="actions chat-composer__envoi">
      {/* Un SEUL bouton d'envoi, même libellé au repos et pendant un tour
          (choix utilisateur 2026-08-04) : mise en file ou injection dans le
          tour en cours sont des détails d'exécution, dits dans l'infobulle et
          le placeholder — pas un bouton à part. */}
      <button
        type="button"
        className="btn"
        onClick={onEnvoyer}
        disabled={envoiDesactive}
        title={
          streaming ? titreEnvoiStreaming : piecesEnChargement ? "Image en cours de chargement…" : undefined
        }
      >
        Envoyer
      </button>
      {/* Retour au bas du fil après être remonté dans l'historique : le
          recollage automatique ayant été abandonné dès le premier geste vers le
          haut (voir useStickToBottom.ts), il faut un moyen explicite de
          redescendre — sans jeter l'ascenseur. */}
      <button
        type="button"
        className="btn btn--ghost chat-composer__bas"
        onClick={onAllerEnBas}
        title="Revenir au dernier message de la conversation"
      >
        ↓ Aller en bas
      </button>
    </div>
  );
}

/*
 * Bouton d'arrêt de la session, dans la colonne d'icônes à gauche du
 * composeur (Chat et Projets) — demande utilisateur du 2026-10-02 : il
 * vivait auparavant au-dessus d'« Envoyer » et n'apparaissait que pendant un
 * tour. Toujours affiché, grisé au repos : la colonne ne saute plus quand un
 * tour démarre. L'arrêt est « propre » côté appelant (`handleAbort`) : tour
 * interrompu par le moteur, messages en file abandonnés.
 */

export function BoutonArret({
  streaming,
  onArreter,
}: Readonly<{ streaming: boolean; onArreter: () => void }>) {
  const titre = streaming
    ? "Arrêter la session proprement : interrompt le tour en cours et vide la file d'attente"
    : "Arrêter — aucun tour en cours";
  return (
    <button
      type="button"
      className="btn btn--ghost bouton-arret"
      onClick={onArreter}
      disabled={!streaming}
      title={titre}
      aria-label={titre}
    >
      ⏹
    </button>
  );
}
