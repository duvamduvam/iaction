/*
 * Section « Veilleur » de la barre latérale de la page Projets (T-227,
 * docs/etude-veilleur-relais.md) : état du veilleur du poste, et
 * configuration de celui du projet ouvert (`.iaction/veilleur.json`, écrit par
 * le sidecar, jamais par un agent).
 *
 * Composant mince : la logique est dans veilleurFormulaire.ts (testée), les
 * appels dans veilleurClient.ts. Toute erreur s'affiche sous le formulaire,
 * jamais avalée. Repliée par défaut ; l'indicateur d'en-tête la rouvre
 * (événement `EVENEMENT_OUVRIR_SECTION`).
 */
import { useEffect, useRef, useState } from "react";
import { SidebarSection } from "./SidebarSection";
import { IDS_ABONNEMENT_CLAUDE, NIVEAUX_EFFORT } from "./modelesAbonnementClaude";
import { agentsList } from "./orchestrationClient";
import { useStatutVeilleur } from "./useStatutVeilleur";
import {
  EVENEMENT_OUVRIR_SECTION,
  veilleurActiver,
  veilleurConfigurer,
  veilleurDesactiver,
  veilleurLire,
  veilleurOublier,
  type ConfigVeilleur,
} from "./veilleurClient";
import {
  AVERTISSEMENT_BASH,
  concerneLeProjet,
  configDepuisFormulaire,
  FORMULAIRE_DEFAUT,
  formulaireDepuisConfig,
  encartNonApprouvee,
  GESTE_SCELLE,
  heureDe,
  INFO_APPROBATION,
  libelleEtat,
  motifDeScelle,
  nomDuProjet,
  resumeBilan,
  type FormulaireVeilleur,
} from "./veilleurFormulaire";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Champ({
  libelle,
  valeur,
  onChange,
  aide,
}: Readonly<{ libelle: string; valeur: string; onChange: (v: string) => void; aide?: string }>) {
  return (
    <div className="field">
      <label>
        {libelle}
        <input type="text" value={valeur} onChange={(e) => onChange(e.target.value)} />
      </label>
      {aide && <span className="field__hint">{aide}</span>}
    </div>
  );
}

export function VeilleurSection({ cwd }: Readonly<{ cwd: string }>) {
  const { statut, erreur: erreurStatut, poser } = useStatutVeilleur();
  const [precedente, setPrecedente] = useState<ConfigVeilleur | null>(null);
  const [lecture, setLecture] = useState<string>("");
  const [f, setF] = useState<FormulaireVeilleur>(FORMULAIRE_DEFAUT);
  const [erreur, setErreur] = useState("");
  const [info, setInfo] = useState("");
  const [occupe, setOccupe] = useState(false);
  // La config du fichier n'est pas celle approuvée (réécrite hors de l'interface).
  const [nonApprouvee, setNonApprouvee] = useState(false);
  const [differences, setDifferences] = useState<string[] | null>(null);
  // Agents Claude du projet, proposés au formulaire (l'agent fait partie de ce qui est scellé).
  const [agents, setAgents] = useState<string[]>([]);
  // Suppression en deux temps (window.confirm ne demande rien dans l'application, T-195).
  const [confirmerOubli, setConfirmerOubli] = useState(false);
  // Remonter la section la rouvre (SidebarSection relit sa préférence au montage).
  const [revision, setRevision] = useState(0);
  const racine = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ouvrir = () => {
      try {
        window.localStorage.setItem("iaction:sidebar:veilleur", "1");
      } catch {
        // préférence non mémorisée : la section se rouvre quand même ci-dessous
      }
      setRevision((r) => r + 1);
      requestAnimationFrame(() => racine.current?.scrollIntoView({ block: "nearest" }));
    };
    window.addEventListener(EVENEMENT_OUVRIR_SECTION, ouvrir);
    return () => window.removeEventListener(EVENEMENT_OUVRIR_SECTION, ouvrir);
  }, []);

  useEffect(() => {
    let vivant = true;
    if (!cwd) {
      setAgents([]);
      return;
    }
    agentsList(cwd)
      .then((liste) => vivant && setAgents(liste.filter((a) => a.engine === "claude" && !a.invalid).map((a) => a.name)))
      .catch((e: unknown) => vivant && setErreur(`Agents du projet illisibles : ${message(e)}`));
    return () => {
      vivant = false;
    };
  }, [cwd]);

  useEffect(() => {
    let vivant = true;
    setErreur("");
    setInfo("");
    if (!cwd) {
      setPrecedente(null);
      setLecture("");
      setF(FORMULAIRE_DEFAUT);
      return;
    }
    veilleurLire(cwd)
      .then((lu) => {
        if (!vivant) return;
        if ("config" in lu) {
          setPrecedente(lu.config);
          // Non approuvée : actif et agent ne sont pas repris du fichier (formulaireDepuisConfig).
          setF(formulaireDepuisConfig(lu.config, lu.scellee));
          setNonApprouvee(lu.scellee === false);
          setDifferences(lu.scellee === false ? (lu.differences ?? null) : null);
          setLecture(lu.scellee === null ? "Coffre fermé : l'approbation de cette config ne peut pas être vérifiée." : "");
        } else {
          setPrecedente(null);
          setNonApprouvee(false);
          setF(FORMULAIRE_DEFAUT);
          setLecture("absent" in lu ? "Aucun veilleur configuré pour ce projet." : `Config actuelle invalide : ${lu.invalide}`);
        }
      })
      .catch((e: unknown) => vivant && setErreur(message(e)));
    return () => {
      vivant = false;
    };
  }, [cwd]);

  const maj = (patch: Partial<FormulaireVeilleur>) => setF((x) => ({ ...x, ...patch }));

  async function agir(action: () => Promise<string>) {
    setOccupe(true);
    setErreur("");
    setInfo("");
    try {
      setInfo(await action());
    } catch (e) {
      setErreur(message(e));
    } finally {
      setOccupe(false);
    }
  }

  const enregistrer = () =>
    agir(async () => {
      const r = configDepuisFormulaire(f);
      if ("erreur" in r) throw new Error(r.erreur);
      const ecrite = await veilleurConfigurer(cwd, r.config);
      setPrecedente(ecrite);
      setNonApprouvee(false);
      setLecture("");
      return INFO_APPROBATION;
    });
  const oublier = () =>
    agir(async () => {
      setConfirmerOubli(false);
      poser(await veilleurOublier(cwd));
      setPrecedente(null);
      setNonApprouvee(false);
      setF(FORMULAIRE_DEFAUT);
      setLecture("Aucun veilleur configuré pour ce projet.");
      return "Configuration et approbation supprimées.";
    });
  const activer = () =>
    agir(async () => {
      poser(await veilleurActiver(cwd));
      return "Veilleur activé sur ce poste.";
    });
  const desactiver = () =>
    agir(async () => {
      const { statut: s, avertissement } = await veilleurDesactiver();
      poser(s);
      // Une réserve (scellé non retiré, poste non oublié) se dit comme une erreur : elle en est une.
      if (avertissement) throw new Error(`Veilleur arrêté, avec réserve : ${avertissement}`);
      return s.etat === "arret-en-cours" ? "Arrêt demandé : le tour en cours s'interrompt." : "Veilleur désactivé.";
    });

  const ici = concerneLeProjet(statut, cwd);
  const etat = statut ? libelleEtat(statut.etat) : null;
  const tonBadge = ici && etat ? etat.ton : "off";

  return (
    <div ref={racine}>
      <SidebarSection
        key={revision}
        id="veilleur"
        title="Veilleur"
        defaultOpen={false}
        badge={ici && etat ? <span className={`mcp-pill mcp-pill--${tonBadge}`}>{etat.texte}</span> : undefined}
      >
        <div className="veilleur">
          {erreurStatut && <p className="empty-hint empty-hint--error">Statut illisible : {erreurStatut}</p>}
          {statut && etat && (
            <div className="veilleur__etat">
              <span className={`mcp-pill mcp-pill--${etat.ton}`}>{etat.texte}</span>
              {statut.cwd && <span className="veilleur__projet">{ici ? "ce projet" : nomDuProjet(statut.cwd)}</span>}
              {statut.motif && <p className={motifDeScelle(statut.motif) ? "empty-hint empty-hint--error" : "empty-hint"}>{statut.motif}</p>}
              {statut.cwd && (
                <p className="empty-hint">
                  Dernière relève : {heureDe(statut.derniereReleve)} ({resumeBilan(statut)}) · tours aujourd'hui : {statut.toursAujourdhui}
                  {statut.enCours ? " · relève en cours" : ""}
                </p>
              )}
              {statut.cwd && !ici && cwd && (
                <p className="empty-hint">Un seul veilleur par poste : activer celui-ci arrête celui de « {nomDuProjet(statut.cwd)} ».</p>
              )}
            </div>
          )}

          {!cwd ? (
            <p className="empty-hint">Ouvrez un projet pour configurer son veilleur.</p>
          ) : (
            <>
              {lecture && <p className="empty-hint">{lecture}</p>}
              {(nonApprouvee || (ici && motifDeScelle(statut?.motif ?? null))) && (
                <p className="empty-hint empty-hint--error" role="alert">
                  {GESTE_SCELLE}
                </p>
              )}
              {nonApprouvee && <p className="empty-hint empty-hint--error">{encartNonApprouvee(differences)}</p>}
              <p className="empty-hint">
                État scellé à l'enregistrement : {f.actif ? "actif (le veilleur tourne sur ce poste)" : "inactif"} — modifié par « Activer » / « Désactiver ».
              </p>
              <div className="field">
                <label>
                  Agent des tours
                  <select value={f.agent} onChange={(e) => maj({ agent: e.target.value })}>
                    <option value="">aucun (agent par défaut)</option>
                    {[...new Set([...(f.agent ? [f.agent] : []), ...agents])].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="field__hint">Son fichier fait partie de l'approbation : modifié ensuite, il faut ré-enregistrer.</span>
              </div>
              <Champ libelle="Adresse du relais" valeur={f.url} onChange={(v) => maj({ url: v })} aide="https://…" />
              <Champ
                libelle="Secret du coffre (nom)"
                valeur={f.jetonSecret}
                onChange={(v) => maj({ jetonSecret: v })}
                aide="Le nom de l'entrée du coffre qui porte le jeton — jamais le jeton lui-même."
              />
              <Champ libelle="Émetteurs écoutés" valeur={f.expediteurs} onChange={(v) => maj({ expediteurs: v })} aide="Noms de studios, séparés par des virgules." />
              <div className="field">
                <label>
                  Modèle
                  <select value={f.modele} onChange={(e) => maj({ modele: e.target.value })}>
                    {[...new Set([f.modele, ...IDS_ABONNEMENT_CLAUDE])].map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="field">
                <label>
                  Effort
                  <select value={f.effort} onChange={(e) => maj({ effort: e.target.value })}>
                    {[...new Set([f.effort, ...NIVEAUX_EFFORT])].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="field field--checkbox">
                <label>
                  <input type="checkbox" checked={f.bash} onChange={(e) => maj({ bash: e.target.checked })} />
                  Bash (shell complet)
                </label>
              </div>
              {f.bash && (
                <p className="empty-hint empty-hint--error" role="alert">
                  {AVERTISSEMENT_BASH}
                </p>
              )}
              <Champ libelle="Allers-retours par fil" valeur={f.profondeur} onChange={(v) => maj({ profondeur: v })} aide="De 1 à 20." />
              <Champ libelle="Coût par message ($)" valeur={f.coutParMessage} onChange={(v) => maj({ coutParMessage: v })} aide="Plus de 0, 50 au plus. Le moteur s'arrête au plafond ; dépassé, ou inconnu après une interruption : réponse envoyée, puis veilleur suspendu." />
              <Champ libelle="Tours par jour" valeur={f.toursParJour} onChange={(v) => maj({ toursParJour: v })} aide="De 1 à 500." />
              <Champ libelle="Durée d'un tour (min)" valeur={f.dureeMin} onChange={(v) => maj({ dureeMin: v })} aide="De 1 à 120." />
              <Champ libelle="Cadence de relève (s)" valeur={f.cadenceSec} onChange={(v) => maj({ cadenceSec: v })} aide="De 10 à 600." />
              <Champ libelle="Proxy HTTPS (optionnel)" valeur={f.proxy} onChange={(v) => maj({ proxy: v })} />
              <Champ libelle="Autorité de certification (fichier PEM, optionnel)" valeur={f.ca} onChange={(v) => maj({ ca: v })} />

              <div className="veilleur__actions">
                <button
                  type="button"
                  className="btn btn--ghost btn--xs"
                  disabled={occupe}
                  onClick={() => void enregistrer()}
                  title="Écrit la config et l'approuve pour ce poste : son empreinte est rangée au coffre (coffre ouvert exigé)"
                >
                  Enregistrer et approuver
                </button>
                <button type="button" className="btn btn--ghost btn--xs" disabled={occupe || !precedente} onClick={() => void activer()} title={precedente ? undefined : "Enregistrez d'abord la config"}>
                  Activer sur ce poste
                </button>
                {ici && statut?.etat === "suspendu" && (
                  // Même geste humain que l'activation : `veilleur.activer` lève la suspension.
                  <button type="button" className="btn btn--ghost btn--xs" disabled={occupe} onClick={() => void activer()}>
                    Lever la suspension
                  </button>
                )}
                <button type="button" className="btn btn--ghost btn--xs" disabled={occupe || !statut || statut.etat === "inactif"} onClick={() => void desactiver()}>
                  Désactiver
                </button>
              </div>
              {precedente && (
                <div className="veilleur__actions">
                  {!confirmerOubli ? (
                    <button type="button" className="btn btn--ghost btn--xs" disabled={occupe} onClick={() => setConfirmerOubli(true)}>
                      Supprimer la configuration
                    </button>
                  ) : (
                    <>
                      <span className="empty-hint">Supprimer la config de ce projet et son approbation ?</span>
                      <button type="button" className="btn btn--ghost btn--xs bouton-arret" disabled={occupe} onClick={() => void oublier()}>
                        Confirmer la suppression
                      </button>
                      <button type="button" className="btn btn--ghost btn--xs" disabled={occupe} onClick={() => setConfirmerOubli(false)}>
                        Annuler
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
          {erreur && <p className="empty-hint empty-hint--error">{erreur}</p>}
          {info && <p className="empty-hint">{info}</p>}
        </div>
      </SidebarSection>
    </div>
  );
}
