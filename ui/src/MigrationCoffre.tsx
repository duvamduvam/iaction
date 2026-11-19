/*
 * Migration vers le coffre (docs/etude-coffre-secrets.md § 6.4 et § 7) —
 * deux onglets de l'écran « Secrets du coffre » (SecretsCoffre.tsx).
 *
 * - Migration : les clés des fournisseurs et de la voix trouvées au
 *   trousseau, et l'ancien `mcp-secrets.json`. Classe proposée (sans fenêtre
 *   pour ce qu'une tâche programmée référence), que l'utilisateur valide
 *   AVANT toute écriture. La coquille relit le coffre sur le disque avant de
 *   supprimer le moindre original.
 * - Fichiers .env : inventaire des projets, versement d'une variable au
 *   coffre, réécriture optionnelle d'un serveur de `.mcp.json`, puis — sur
 *   confirmation seulement — suppression du fichier.
 */
import { useEffect, useState } from "react";
import {
  classeProposee,
  coffreMigrationCandidats,
  coffreMigrer,
  inventaireEnv,
  libelleCompte,
  migrerEnv,
  nomSecretPourEnv,
  secretsDesTaches,
  supprimerEnv,
  type BilanMigration,
  type CandidatMigration,
  type ClasseSecret,
  type FichierEnv,
} from "./coffreGestion";
import { readProjects } from "./projectAdmin";
import { readProviders } from "./providerAdmin";
import { toMessage as message } from "./base";

export function Migration() {
  const [candidats, setCandidats] = useState<CandidatMigration[] | null>(null);
  const [classes, setClasses] = useState<Record<string, ClasseSecret>>({});
  const [exclus, setExclus] = useState<Set<string>>(new Set());
  const [bilan, setBilan] = useState<BilanMigration | null>(null);
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState(false);

  async function charger() {
    setErreur("");
    try {
      const fournisseurs = await readProviders();
      const comptes = [...fournisseurs.map((p) => `provider:${p.id}`), "speech:stt", "speech:tts"];
      const [liste, refs] = await Promise.all([coffreMigrationCandidats(comptes), secretsDesTaches().catch(() => [])]);
      setCandidats(liste);
      setClasses(Object.fromEntries(liste.map((c) => [c.compte, classeProposee(c.compte, refs)])));
    } catch (err) {
      setErreur(message(err));
    }
  }

  useEffect(() => {
    void charger();
  }, []);

  async function migrer() {
    if (!candidats) return;
    setOccupe(true);
    setErreur("");
    try {
      const choix = candidats
        .filter((c) => !exclus.has(c.compte))
        .map((c) => ({ compte: c.compte, classe: classes[c.compte] ?? "coffre" }));
      setBilan(await coffreMigrer(choix));
      await charger();
    } catch (err) {
      setErreur(message(err));
    } finally {
      setOccupe(false);
    }
  }

  if (candidats === null) return erreur ? <p className="empty-hint empty-hint--error">{erreur}</p> : <p>Recherche…</p>;
  return (
    <>
      {bilan && (
        <p className={`empty-hint ${bilan.echecs.length > 0 ? "empty-hint--error" : ""}`}>
          {bilan.migres.length} secret(s) versé(s) au coffre, originaux supprimés après relecture
          {bilan.fichierMcpSupprime ? " (ancien fichier des secrets MCP supprimé)" : ""}.
          {bilan.echecs.map((e) => ` ${libelleCompte(e.compte)} : ${e.cause}.`).join("")}
        </p>
      )}
      {candidats.length === 0 ? (
        <p className="empty-hint">Rien à migrer : aucun secret hors du coffre n'a été trouvé.</p>
      ) : (
        <>
          <p className="empty-hint">
            Secrets trouvés hors du coffre. Vérifie la classe de chacun avant de lancer : <strong>sans fenêtre</strong>{" "}
            est proposé pour ce qu'une tâche programmée utilise (elle tourne sans IAction ouvert).
          </p>
          <ul className="coffre-liste">
            {candidats.map((c) => (
              <li key={c.compte}>
                <label>
                  <input
                    type="checkbox"
                    checked={!exclus.has(c.compte)}
                    onChange={(e) => {
                      const s = new Set(exclus);
                      if (e.currentTarget.checked) s.delete(c.compte);
                      else s.add(c.compte);
                      setExclus(s);
                    }}
                  />{" "}
                  {libelleCompte(c.compte)}
                </label>
                <span className="coffre-liste__date">
                  {c.source === "trousseau"
                    ? "trousseau"
                    : c.source === "reliquat-mcp"
                      ? "copie en clair d'un secret déjà au coffre (retirée)"
                      : "ancien fichier MCP"}
                </span>
                {c.source !== "reliquat-mcp" && (
                  <select
                    value={classes[c.compte] ?? "coffre"}
                    onChange={(e) => setClasses({ ...classes, [c.compte]: e.currentTarget.value as ClasseSecret })}
                  >
                    <option value="coffre">coffre</option>
                    <option value="sans-fenetre">sans fenêtre</option>
                  </select>
                )}
              </li>
            ))}
          </ul>
          <div className="orch-modal__actions">
            <button type="button" className="btn" disabled={occupe} onClick={() => void migrer()}>
              {occupe ? "Migration…" : "Migrer vers le coffre"}
            </button>
          </div>
        </>
      )}
      {erreur && <p className="empty-hint empty-hint--error">{erreur}</p>}
    </>
  );
}

export function FichiersEnv() {
  const [fichiers, setFichiers] = useState<FichierEnv[] | null>(null);
  const [erreur, setErreur] = useState("");

  async function charger() {
    setErreur("");
    try {
      const projets = await readProjects();
      setFichiers(await inventaireEnv(projets.map((p) => p.path)));
    } catch (err) {
      setErreur(message(err));
    }
  }

  useEffect(() => {
    void charger();
  }, []);

  if (fichiers === null) return erreur ? <p className="empty-hint empty-hint--error">{erreur}</p> : <p>Inventaire…</p>;
  if (fichiers.length === 0) return <p className="empty-hint">Aucun fichier .env dans les projets ouverts.</p>;
  return (
    <>
      <p className="empty-hint">
        Fichiers .env trouvés dans les projets : leurs jetons sont en clair sur le disque, et synchronisés si le projet
        l'est. Verse chaque variable au coffre ; si un serveur de .mcp.json en a besoin, nomme-le pour que son entrée
        référence le secret. Le fichier n'est supprimé que sur ta confirmation.
      </p>
      {fichiers.map((f) => (
        <FichierEnvBloc key={`${f.projet}/${f.fichier}`} f={f} onSupprime={() => void charger()} />
      ))}
      {erreur && <p className="empty-hint empty-hint--error">{erreur}</p>}
    </>
  );
}

function FichierEnvBloc({ f, onSupprime }: Readonly<{ f: FichierEnv; onSupprime: () => void }>) {
  const [noms, setNoms] = useState<Record<string, string>>(() =>
    Object.fromEntries(f.cles.map((c) => [c, nomSecretPourEnv(f.projet, c)])),
  );
  const [serveur, setServeur] = useState("");
  // Clé → nom de secret, pour les variables versées : le sidecar vérifie au
  // coffre chacune d'elles avant d'accepter de supprimer le fichier.
  const [verses, setVerses] = useState<Map<string, string>>(new Map());
  const ambigues = new Set(f.ambigues);
  const toutVerse = f.cles.every((c) => verses.has(c)) && ambigues.size === 0;
  const [confirmer, setConfirmer] = useState(false);
  const [etat, setEtat] = useState("");

  async function verser(cle: string) {
    setEtat("");
    try {
      const r = await migrerEnv({ projet: f.projet, fichier: f.fichier, cle, nom: noms[cle], ...(serveur.trim() ? { serveur: serveur.trim() } : {}) });
      setVerses(new Map([...verses, [cle, r.nom]]));
      setEtat(`« ${cle} » versé au coffre sous ${r.nom}${r.serveur ? `, référencé par le serveur « ${r.serveur} »` : ""}.`);
    } catch (err) {
      setEtat(message(err));
    }
  }

  return (
    <fieldset className="coffre-env">
      <legend>
        {f.projet.split(/[\\/]/).pop()} — {f.fichier}
      </legend>
      <div className="field">
        <label>Serveur de .mcp.json qui utilise ces variables (optionnel)</label>
        <input value={serveur} placeholder="ex. relais" onChange={(e) => setServeur(e.currentTarget.value)} />
      </div>
      <ul className="coffre-liste">
        {f.cles.map((cle) => (
          <li key={cle}>
            <code>{cle}</code>
            <input
              aria-label={`Nom du secret pour ${cle}`}
              value={noms[cle] ?? ""}
              onChange={(e) => setNoms({ ...noms, [cle]: e.currentTarget.value })}
            />
            {ambigues.has(cle) ? (
              <span className="coffre-liste__date" title="Guillemets non fermés, valeur sur plusieurs lignes ou interpolation">
                valeur ambiguë : à migrer à la main
              </span>
            ) : (
              <button type="button" className="btn btn--ghost" disabled={verses.has(cle)} onClick={() => void verser(cle)}>
                {verses.has(cle) ? "Versé" : "Verser au coffre"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {etat && <p className="empty-hint">{etat}</p>}
      {verses.size > 0 && !toutVerse && (
        <p className="empty-hint">
          Le fichier ne peut être supprimé qu'une fois TOUTES ses variables au coffre
          {ambigues.size > 0 ? " (les valeurs ambiguës se migrent à la main, puis se retirent du fichier)" : ""}.
        </p>
      )}
      {toutVerse &&
        (confirmer ? (
          <div className="coffre-avertissement" role="alert">
            <p>Supprimer définitivement {f.fichier} ? IAction vérifie d'abord que chaque variable est au coffre.</p>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirmer(false)}>
              Annuler
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void supprimerEnv(
                  f.projet,
                  f.fichier,
                  [...verses].map(([cle, nom]) => ({ cle, nom })),
                )
                  .then(onSupprime)
                  .catch((err: unknown) => setEtat(message(err)))
              }
            >
              Supprimer
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn--ghost" onClick={() => setConfirmer(true)}>
            Supprimer ce fichier…
          </button>
        ))}
    </fieldset>
  );
}
