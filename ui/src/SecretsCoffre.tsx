/*
 * Écran « Secrets du coffre » (docs/etude-coffre-secrets.md § 5 à § 7) —
 * ouvert depuis le bouton du coffre dans l'en-tête, coffre ouvert.
 *
 * Quatre onglets : la liste des secrets (noms, classe, reclassement), la
 * migration du trousseau et de l'ancien fichier MCP, l'inventaire des `.env`
 * des projets, le changement de mot de passe et le déverrouillage
 * automatique sur ce poste (T-225). Aucune valeur n'est jamais
 * affichée ni reçue ici.
 */
import { useEffect, useState } from "react";
import { toMessage } from "./base";
import { Modal } from "./Modal";
import {
  coffreAutoActiver,
  coffreAutoDesactiver,
  coffreAutoEtat,
  coffreChangerMotDePasse,
  type EtatAuto,
} from "./coffreClient";
import {
  avertissementSansFenetre,
  coffrePosteDomaine,
  coffreChercherEnClair,
  coffreReclasser,
  coffreSecrets,
  libelleCompte,
  type ClasseSecret,
  type SecretListe,
} from "./coffreGestion";
import { FichiersEnv, Migration } from "./MigrationCoffre";
import { readProjects } from "./projectAdmin";

export type OngletCoffre = "secrets" | "migration" | "env" | "mdp";

const ONGLETS: { id: OngletCoffre; libelle: string }[] = [
  { id: "secrets", libelle: "Secrets" },
  { id: "migration", libelle: "Migration" },
  { id: "env", libelle: "Fichiers .env" },
  { id: "mdp", libelle: "Mot de passe" },
];

const message = toMessage;

export function SecretsCoffre({ onClose, onglet: initial }: Readonly<{ onClose: () => void; onglet?: OngletCoffre }>) {
  const [onglet, setOnglet] = useState<OngletCoffre>(initial ?? "secrets");
  return (
    <Modal label="Secrets du coffre" onClose={onClose}>
      <div className="orch-modal coffre-modal coffre-gestion">
        <div className="orch-modal__head">
          <h3>Secrets du coffre</h3>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        <div className="coffre-onglets" role="tablist">
          {ONGLETS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="tab"
              aria-selected={onglet === o.id}
              className={`btn ${onglet === o.id ? "" : "btn--ghost"}`}
              onClick={() => setOnglet(o.id)}
            >
              {o.libelle}
            </button>
          ))}
        </div>
        <div className="orch-modal__body">
          {onglet === "secrets" && <ListeSecrets />}
          {onglet === "migration" && <Migration />}
          {onglet === "env" && <FichiersEnv />}
          {onglet === "mdp" && (
            <>
              <MotDePasse />
              <DeverrouillageAuto />
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ListeSecrets() {
  const [liste, setListe] = useState<SecretListe[] | null>(null);
  const [domaine, setDomaine] = useState<boolean | null>(false);
  const [aConfirmer, setAConfirmer] = useState<string | null>(null);
  const [erreur, setErreur] = useState("");
  const [enClair, setEnClair] = useState<string[] | null>(null);
  const windows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

  async function recharger() {
    try {
      setListe(await coffreSecrets());
    } catch (err) {
      setErreur(message(err));
    }
  }

  useEffect(() => {
    void recharger();
    coffrePosteDomaine()
      .then(setDomaine)
      .catch(() => setDomaine(null));
  }, []);

  async function reclasser(nom: string, classe: ClasseSecret) {
    setErreur("");
    setAConfirmer(null);
    try {
      await coffreReclasser(nom, classe);
      await recharger();
    } catch (err) {
      setErreur(message(err));
    }
  }

  if (liste === null) return erreur ? <p className="empty-hint empty-hint--error">{erreur}</p> : <p>Chargement…</p>;
  return (
    <>
      <p className="empty-hint">
        <strong>coffre</strong> : chiffré par ton mot de passe, disponible quand IAction est ouvert et le coffre
        déverrouillé. <strong>sans fenêtre</strong> : au trousseau du système, lisible par les tâches de fond — et par
        tout programme de ta session.
      </p>
      {liste.length === 0 && <p className="empty-hint">Aucun secret au coffre. Voir l'onglet Migration.</p>}
      <ul className="coffre-liste">
        {liste.map((s) => (
          <li key={s.nom}>
            <span className="coffre-liste__nom" title={s.nom}>
              {libelleCompte(s.nom)}
            </span>
            <span className={`coffre-classe coffre-classe--${s.classe}`}>
              {s.classe === "coffre" ? "coffre" : "sans fenêtre"}
            </span>
            <span className="coffre-liste__date">{s.cree}</span>
            {s.classe === "coffre" ? (
              <button type="button" className="btn btn--ghost" onClick={() => setAConfirmer(s.nom)}>
                Passer sans fenêtre…
              </button>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={() => void reclasser(s.nom, "coffre")}>
                Remettre au coffre
              </button>
            )}
            {aConfirmer === s.nom && (
              <div className="coffre-avertissement" role="alert">
                <p>{avertissementSansFenetre(domaine, windows)}</p>
                <button type="button" className="btn btn--ghost" onClick={() => setAConfirmer(null)}>
                  Annuler
                </button>
                <button type="button" className="btn" onClick={() => void reclasser(s.nom, "sans-fenetre")}>
                  Confirmer
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="orch-modal__actions">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() =>
            void readProjects()
              .then((p) => coffreChercherEnClair(p.map((x) => x.path)))
              .then(setEnClair)
              .catch((err: unknown) => setErreur(message(err)))
          }
        >
          Chercher des secrets en clair
        </button>
      </div>
      {enClair !== null &&
        (enClair.length === 0 ? (
          <p className="empty-hint">Aucune valeur du coffre trouvée en clair (configuration, état, journaux, projets).</p>
        ) : (
          <div className="empty-hint empty-hint--error">
            Valeurs du coffre trouvées en clair dans :
            <ul>
              {enClair.map((c) => (
                <li key={c}>
                  <code>{c}</code>
                </li>
              ))}
            </ul>
          </div>
        ))}
      {erreur && <p className="empty-hint empty-hint--error">{erreur}</p>}
    </>
  );
}

function MotDePasse() {
  const [ancien, setAncien] = useState("");
  const [nouveau, setNouveau] = useState("");
  const [nouveau2, setNouveau2] = useState("");
  const [etat, setEtat] = useState<{ ok: boolean; texte: string } | null>(null);
  const valide = nouveau.length >= 8 && nouveau === nouveau2;

  async function changer() {
    const a = ancien;
    const n = nouveau;
    setAncien("");
    setNouveau("");
    setNouveau2("");
    try {
      // Vide = coffre ouvert par la clé de secours : l'ancien n'est pas exigé.
      await coffreChangerMotDePasse(a.length > 0 ? a : null, n);
      setEtat({ ok: true, texte: "Mot de passe changé. La clé de secours reste la même." });
    } catch (err) {
      setEtat({ ok: false, texte: message(err) });
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valide) void changer();
      }}
    >
      <div className="field">
        <label htmlFor="coffre-ancien">Mot de passe actuel (vide si ouvert par la clé de secours)</label>
        <input id="coffre-ancien" type="password" autoComplete="current-password" value={ancien} onChange={(e) => setAncien(e.currentTarget.value)} />
      </div>
      <div className="field">
        <label htmlFor="coffre-nouveau">Nouveau mot de passe (8 caractères au moins, différent sur chaque poste)</label>
        <input id="coffre-nouveau" type="password" autoComplete="new-password" value={nouveau} onChange={(e) => setNouveau(e.currentTarget.value)} />
      </div>
      <div className="field">
        <label htmlFor="coffre-nouveau2">Une seconde fois</label>
        <input id="coffre-nouveau2" type="password" autoComplete="new-password" value={nouveau2} onChange={(e) => setNouveau2(e.currentTarget.value)} />
      </div>
      {etat && <p className={`empty-hint ${etat.ok ? "" : "empty-hint--error"}`}>{etat.texte}</p>}
      <div className="orch-modal__actions">
        <button type="submit" className="btn" disabled={!valide}>
          Changer le mot de passe
        </button>
      </div>
    </form>
  );
}

/** Déverrouillage automatique sur ce poste (T-225) : identité du coffre au trousseau. */
function DeverrouillageAuto() {
  const [etat, setEtat] = useState<EtatAuto | null>(null);
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState(false);

  async function recharger() {
    try {
      setEtat(await coffreAutoEtat());
    } catch (err) {
      setErreur(message(err));
    }
  }

  useEffect(() => {
    void recharger();
  }, []);

  async function basculer(actif: boolean) {
    setErreur("");
    setOccupe(true);
    try {
      if (actif) await coffreAutoActiver();
      else await coffreAutoDesactiver();
    } catch (err) {
      setErreur(message(err));
    } finally {
      setOccupe(false);
      await recharger();
    }
  }

  const permis = etat?.permis === true;
  return (
    <div className="field">
      <label htmlFor="coffre-auto">
        <input
          id="coffre-auto"
          type="checkbox"
          checked={etat?.actif === true}
          disabled={etat === null || occupe || (!permis && etat.actif !== true)}
          onChange={(e) => void basculer(e.currentTarget.checked)}
        />{" "}
        Déverrouiller automatiquement sur ce poste
      </label>
      <p className="empty-hint">
        La clé du coffre est rangée dans le trousseau du système, ouvert à ta connexion : plus de mot de passe au
        lancement, et le coffre ne se ferme plus à la veille. Refusé sur un Windows joint à un domaine.
      </p>
      {etat !== null && !permis && (
        <p className="empty-hint">
          Indisponible ici : ce poste est un Windows joint à un domaine, ou sa jonction n'a pas pu être vérifiée.
        </p>
      )}
      {erreur && <p className="empty-hint empty-hint--error">{erreur}</p>}
    </div>
  );
}
