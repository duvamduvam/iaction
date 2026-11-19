/*
 * Coffre de secrets — bouton d'en-tête et modale d'ouverture
 * (docs/etude-coffre-secrets.md § 4.3 et § 4.4).
 *
 * - Au lancement, coffre absent ou verrouillé : la modale s'ouvre (créer /
 *   déverrouiller / « Plus tard »). « Plus tard » laisse l'application
 *   utilisable ; un tour qui a besoin d'un secret le dira.
 * - Le bouton d'en-tête montre l'état, verrouille (coffre ouvert) ou rouvre
 *   la modale (coffre fermé). Pendant une fermeture automatique différée, il
 *   affiche « fermeture du coffre en attente : N tours en cours ».
 * - Création : mot de passe deux fois, puis la clé de secours UNE fois, et
 *   la recopie de sa fin pour confirmer qu'elle est rangée. La migration
 *   (écran « Secrets du coffre », SecretsCoffre.tsx) s'ouvre ensuite.
 * - Coffre ouvert, « Secrets… » ouvre l'écran des secrets.
 *
 * Les mots de passe ne vivent que dans l'état local du formulaire, vidé
 * aussitôt après l'appel.
 */
import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { SecretsCoffre, type OngletCoffre } from "./SecretsCoffre";
import {
  coffreCreer,
  coffreDeverrouiller,
  coffreDeverrouillerSecours,
  coffreEtat,
  coffreVerrouiller,
  ecouterEtatCoffre,
  fragmentDeControle,
  libelleEtat,
  type EtatPublicCoffre,
} from "./coffreClient";
import { tachesSansSecrets, texteTachesSansSecrets } from "./coffreGestion";

const MIN = 8;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function CoffreControle() {
  const [etat, setEtat] = useState<EtatPublicCoffre | null>(null);
  // Mode FIGÉ à l'ouverture de la modale : la création ouvre le coffre
  // (événement « ouvert ») AVANT que la clé de secours ait été montrée.
  const [modale, setModale] = useState<"absent" | "verrouille" | null>(null);
  // Écran « Secrets du coffre » (lot 2) ; ouvert sur la migration juste après la création.
  const [gestion, setGestion] = useState<OngletCoffre | null>(null);
  // Avis du lancement : tâches programmées qu'un secret manquera hors de l'app.
  const [avisTaches, setAvisTaches] = useState("");

  useEffect(() => {
    let vivant = true;
    coffreEtat()
      .then((e) => {
        if (!vivant || !e) return;
        setEtat(e);
        // Au lancement : coffre à créer ou fermé → la modale se présente.
        if (e.etat !== "ouvert") setModale(e.etat);
        if (e.etat !== "absent") {
          tachesSansSecrets()
            .then((t) => {
              if (vivant) setAvisTaches(texteTachesSansSecrets(t));
            })
            .catch(() => {
              // Sidecar ancien : pas d'avis.
            });
        }
      })
      .catch(() => {
        // Coquille sans coffre (version ancienne) : rien à afficher.
      });
    const fin = ecouterEtatCoffre(setEtat);
    return () => {
      vivant = false;
      fin();
    };
  }, []);

  if (!etat) return null;
  const ouvert = etat.etat === "ouvert";
  return (
    <>
      <button
        type="button"
        className={`coffre-bouton coffre-bouton--${etat.attente ? "attente" : etat.etat}`}
        onClick={() => {
          if (ouvert) {
            if (!etat.attente) void coffreVerrouiller();
          } else {
            setModale(etat.etat === "absent" ? "absent" : "verrouille");
          }
        }}
        title={
          ouvert
            ? "Coffre de secrets ouvert — cliquer pour le verrouiller maintenant"
            : "Coffre de secrets fermé — cliquer pour l'ouvrir"
        }
      >
        {ouvert && !etat.attente ? "🔓 " : "🔒 "}
        {libelleEtat(etat)}
      </button>
      {etat.repliPrecedent && (
        <span className="coffre-bouton coffre-bouton--attente" role="alert">
          Coffre ouvert sur sa version précédente : la dernière modification est perdue
        </span>
      )}
      {avisTaches && (
        <button
          type="button"
          className="coffre-bouton coffre-bouton--attente"
          title={avisTaches}
          onClick={() => setAvisTaches("")}
        >
          ⚠ tâches sans leurs secrets
        </button>
      )}
      {ouvert && (
        <button
          type="button"
          className="coffre-bouton coffre-bouton--gestion"
          onClick={() => setGestion("secrets")}
          title="Secrets du coffre : liste, classes, migration, fichiers .env, mot de passe"
        >
          Secrets…
        </button>
      )}
      {modale && (
        <CoffreModale
          etat={modale}
          onClose={() => setModale(null)}
          onCree={() => {
            setModale(null);
            setGestion("migration");
          }}
        />
      )}
      {gestion && <SecretsCoffre onglet={gestion} onClose={() => setGestion(null)} />}
    </>
  );
}

function CoffreModale({
  etat,
  onClose,
  onCree,
}: Readonly<{ etat: "absent" | "verrouille"; onClose: () => void; onCree: () => void }>) {
  // Clé de secours affichée : ni Échap ni clic au fond ne ferment, seule la
  // confirmation « C'est rangé » le fait (la clé ne sera plus jamais montrée).
  const [bloque, setBloque] = useState(false);
  return (
    <Modal label="Coffre de secrets" onClose={() => !bloque && onClose()}>
      <div className="orch-modal coffre-modal">
        <div className="orch-modal__head">
          <h3>Coffre de secrets</h3>
          {!bloque && (
            <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Plus tard">
              ×
            </button>
          )}
        </div>
        {etat === "absent" ? <Creation onClose={onClose} onCree={onCree} onCleAffichee={setBloque} /> : <Ouverture onClose={onClose} />}
      </div>
    </Modal>
  );
}

function Ouverture({ onClose }: Readonly<{ onClose: () => void }>) {
  const [parSecours, setParSecours] = useState(false);
  const [saisie, setSaisie] = useState("");
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState(false);

  async function valider() {
    const valeur = saisie;
    setSaisie("");
    setOccupe(true);
    setErreur("");
    try {
      if (parSecours) await coffreDeverrouillerSecours(valeur);
      else await coffreDeverrouiller(valeur);
      onClose();
    } catch (err) {
      setErreur(message(err));
    } finally {
      setOccupe(false);
    }
  }

  return (
    <form
      className="orch-modal__body"
      onSubmit={(e) => {
        e.preventDefault();
        void valider();
      }}
    >
      <p className="empty-hint">
        Les clés des fournisseurs et les jetons des serveurs MCP sont chiffrés par ton mot de passe. Sans coffre
        ouvert, les modèles locaux restent utilisables.
      </p>
      <div className="field">
        <label htmlFor="coffre-saisie">{parSecours ? "Clé de secours (AGE-SECRET-KEY-1…)" : "Mot de passe"}</label>
        <input
          id="coffre-saisie"
          type="password"
          autoComplete="off"
          autoFocus
          value={saisie}
          onChange={(e) => setSaisie(e.currentTarget.value)}
        />
      </div>
      {erreur && <p className="empty-hint empty-hint--error">{erreur}</p>}
      <div className="orch-modal__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setParSecours(!parSecours);
            setSaisie("");
            setErreur("");
          }}
        >
          {parSecours ? "Utiliser le mot de passe" : "Mot de passe oublié : clé de secours"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Plus tard
        </button>
        <button type="submit" className="btn" disabled={occupe || saisie.length === 0}>
          {occupe ? "Ouverture…" : "Déverrouiller"}
        </button>
      </div>
    </form>
  );
}

function Creation({
  onClose,
  onCree,
  onCleAffichee,
}: Readonly<{ onClose: () => void; onCree: () => void; onCleAffichee: (affichee: boolean) => void }>) {
  const [mdp, setMdp] = useState("");
  const [mdp2, setMdp2] = useState("");
  const [cle, setCle] = useState<string | null>(null);
  const [fragment, setFragment] = useState("");
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState(false);

  const mdpValide = mdp.length >= MIN && mdp === mdp2;

  async function creer() {
    const valeur = mdp;
    setMdp("");
    setMdp2("");
    setOccupe(true);
    setErreur("");
    try {
      setCle(await coffreCreer(valeur));
      onCleAffichee(true);
    } catch (err) {
      setErreur(message(err));
    } finally {
      setOccupe(false);
    }
  }

  if (cle !== null) {
    const attendu = fragmentDeControle(cle);
    return (
      <div className="orch-modal__body">
        <p>
          <strong>Clé de secours</strong> — affichée une seule fois. Elle ouvre le coffre sans le mot de passe, y
          compris hors d'IAction (<code>age -d -i</code>). Range-la dans ton gestionnaire de mots de passe
          personnel, jamais sur ce poste.
        </p>
        <pre className="coffre-cle" aria-label="Clé de secours">
          {cle}
        </pre>
        <div className="field">
          <label htmlFor="coffre-fragment">Pour confirmer qu'elle est rangée, recopie ses 8 derniers caractères</label>
          <input
            id="coffre-fragment"
            autoComplete="off"
            value={fragment}
            onChange={(e) => setFragment(e.currentTarget.value)}
          />
        </div>
        <div className="orch-modal__actions">
          <button
            type="button"
            className="btn"
            disabled={fragment.trim() !== attendu}
            onClick={() => {
              setCle(null);
              onCleAffichee(false);
              // Coffre créé : la migration (§ 7) s'enchaîne, rien n'est écrit sans validation.
              onCree();
            }}
          >
            C'est rangé
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="orch-modal__body"
      onSubmit={(e) => {
        e.preventDefault();
        if (mdpValide) void creer();
      }}
    >
      <p className="empty-hint">
        Crée le coffre de ce poste. Il est chiffré par ce mot de passe et ne quitte jamais ce poste. Choisis un mot
        de passe <strong>différent sur chaque poste</strong> : celui que tu tapes au bureau ne doit pas ouvrir la
        maison.
      </p>
      <div className="field">
        <label htmlFor="coffre-mdp">Mot de passe ({MIN} caractères au moins)</label>
        <input
          id="coffre-mdp"
          type="password"
          autoComplete="new-password"
          autoFocus
          value={mdp}
          onChange={(e) => setMdp(e.currentTarget.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="coffre-mdp2">Une seconde fois</label>
        <input
          id="coffre-mdp2"
          type="password"
          autoComplete="new-password"
          value={mdp2}
          onChange={(e) => setMdp2(e.currentTarget.value)}
        />
      </div>
      {mdp2.length > 0 && mdp !== mdp2 && <p className="empty-hint empty-hint--error">Les deux saisies diffèrent.</p>}
      {erreur && <p className="empty-hint empty-hint--error">{erreur}</p>}
      <div className="orch-modal__actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Plus tard
        </button>
        <button type="submit" className="btn" disabled={occupe || !mdpValide}>
          {occupe ? "Création…" : "Créer le coffre"}
        </button>
      </div>
    </form>
  );
}
