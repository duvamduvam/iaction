/*
 * T-080 — réglage « modèle par défaut des Projets », page Configuration.
 *
 * Remplace le mode « Auto (descendant) » supprimé : au lieu d'un routeur qui
 * n'arbitrait rien (T-079), une valeur explicite, visible et modifiable, que
 * chaque nouvelle session reprend et que le sélecteur affiche en clair.
 *
 * Composant à part plutôt qu'une section de plus dans ProvidersPage : ce
 * fichier est à son plafond de cliquet, et « découper est la réponse
 * attendue ». Toute la décision est dans modeleDefaut.ts (feuille pure,
 * testée) ; ici, du DOM et un enregistrement.
 */
import { useEffect, useState } from "react";
import { ecrireModeleDefaut, lireModeleDefaut, MODELE_DEFAUT_USINE, normaliserModeleDefaut } from "./modeleDefaut";
import { MODELES_ABONNEMENT_CLAUDE } from "./modelesAbonnementClaude";

export function ModeleDefautProjets() {
  const [valeur, setValeur] = useState<string | null>(null);
  const [enregistre, setEnregistre] = useState(false);
  const [erreur, setErreur] = useState("");

  useEffect(() => {
    void lireModeleDefaut().then(setValeur);
  }, []);

  async function choisir(modele: string) {
    // Optimiste : le champ suit le clic tout de suite. En cas d'échec
    // d'écriture on le DIT plutôt que de laisser croire à un réglage posé.
    setValeur(modele);
    setErreur("");
    try {
      await ecrireModeleDefaut(modele);
      setEnregistre(true);
      window.setTimeout(() => setEnregistre(false), 2000);
    } catch (err) {
      setErreur(err instanceof Error ? err.message : String(err));
      setValeur(await lireModeleDefaut());
    }
  }

  const courant = normaliserModeleDefaut(valeur) ?? MODELE_DEFAUT_USINE;

  return (
    <section className="config-section">
      <h2 className="config-section__title">Modèle par défaut (Projets)</h2>
      <p className="empty-hint">
        Modèle d'une nouvelle session de projet. Il reste changeable session par session dans le
        sélecteur — c'est là qu'on prend un modèle plus fort pour une tâche qui le mérite.
      </p>

      {erreur && <div className="result-line result-line--error">Erreur : {erreur}</div>}

      {valeur === null ? (
        <p className="empty-hint">Chargement…</p>
      ) : (
        <div className="field">
          <label htmlFor="modele-defaut-projets">Modèle</label>
          <select
            id="modele-defaut-projets"
            value={courant}
            onChange={(e) => void choisir(e.currentTarget.value)}
          >
            {/* Un modèle réglé mais absent de la liste (id saisi ailleurs, modèle
                retiré de l'abonnement) reste proposé : le taire changerait le
                réglage sous les pieds de l'utilisateur au premier rendu. */}
            {!MODELES_ABONNEMENT_CLAUDE.some((m) => m.id === courant) && (
              <option value={courant}>{courant}</option>
            )}
            {MODELES_ABONNEMENT_CLAUDE.map((m) => (
              <option key={m.id} value={m.id} title={m.note}>
                {m.id}
              </option>
            ))}
          </select>
          {enregistre && <span className="result-line">Enregistré.</span>}
        </div>
      )}
    </section>
  );
}
