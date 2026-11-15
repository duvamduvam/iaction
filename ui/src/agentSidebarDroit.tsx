/*
 * Barre latérale droite de la page Projets — Sessions, LLM (Connaissances : agentSidebarConnaissances.tsx).
 *
 * Trois sections de rendu pur sorties d'AgentPage.tsx (dernière tranche de
 * l'étape 8). Comme pour envoiProjet.ts, la taille des interfaces de props
 * n'est pas un accident : c'est la surface de couplage RÉELLE de chaque
 * section, rendue visible — l'état, lui, reste la propriété de la page.
 */

import { useMemo, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react";
import { ArchivesGroupe } from "./ArchivesGroupe";
import type { EntreeArchive } from "./archivesSessions";
import { effortsPour, MODELES_ABONNEMENT_CLAUDE, type EffortLevel } from "./modelesAbonnementClaude";
import { agentOptionValue, type AgentSelection, type ProjectSession } from "./modeleProjet";
import { OllamaPanel } from "./OllamaPanel";
import { PERMISSION_MODE_OPTIONS } from "./permissions";
import { SidebarSection } from "./SidebarSection";
import { formatRelativeDate } from "./sessionStore";
import { filtrerSessions } from "./titresDiscussions";
import { RattrapageTitres, RechercheSessions } from "./RechercheEtRattrapage";
import type { EtatRattrapage } from "./useRattrapageTitres";
import type { AgentInfo } from "./orchestrationClient";
import type { ProviderConfig } from "./providerAdmin";
import { ModelPicker, type OptionEpinglee } from "./ModelPicker";
import { modeleSousAgentDeclare, sousAgentsVifs, tachesDeFondHorsSousAgents, type AgentTurn, type SousAgentVu } from "./agentTurns";
import { useSousAgentsRecents } from "./useSousAgentsRecents";
import type { ModelDetail, PermissionMode } from "./sidecar";
import { libelleCompte, optionsMoteurClaude, secondCompteDispo, VALEUR_MOTEUR_TEAMS, type CompteClaude, type CompteDecrit } from "./comptesClaude";
import { Deroulant } from "./Deroulant";

/*
 * Modèles de l'abonnement Claude : ils ne viennent d'aucun catalogue
 * interrogeable, d'où leur présence en dur — épinglés dans le sélecteur, donc
 * jamais soumis aux filtres du catalogue neutre (T-032).
 */
const MODEL_OPTIONS: OptionEpinglee[] = MODELES_ABONNEMENT_CLAUDE.map((m) => ({
  value: m.id,
  label: m.id,
  title: m.note,
}));

/*
 * T-080 — plus de sentinelle « Auto (descendant) » ni d'option « (défaut) »
 * muette : toutes deux disaient « quelqu'un d'autre choisira », et personne ne
 * choisissait (le mode Auto imposait le sommet de la table sans lire le prompt,
 * T-079). Une session part sur le modèle réglé dans Configuration, affiché en clair.
 */

export interface SessionsSectionProps {
  sessions: ProjectSession[];
  sortedSessions: ProjectSession[];
  activeSessionId: string | null;
  tabbableSessionId: string | undefined;
  streaming: boolean;
  providers: ProviderConfig[];
  editingSessionId: string | null;
  editingSessionTitle: string;
  setEditingSessionTitle: (value: string) => void;
  commitEditSessionTitle: () => void;
  cancelEditSessionTitle: () => void;
  startEditSessionTitle: (session: ProjectSession) => void;
  confirmDeleteSessionId: string | null;
  setConfirmDeleteSessionId: (value: string | null) => void;
  deleteSession: (id: string) => void;
  selectSession: (id: string) => void;
  handleNewSession: () => void;
  /** Focus roulant de la liste (voir useRovingFocus.ts) — la page possède le hook. */
  sessionsRoving: {
    containerRef: RefObject<HTMLUListElement | null>;
    onKeyDown: (e: KeyboardEvent<HTMLUListElement>) => void;
    onFocus: (e: FocusEvent<HTMLUListElement>) => void;
  };
  /** T-151 — sessions sorties du plafond, archivées (jamais perdues) ; absentes de la liste vive. */
  archives: EntreeArchive[];
  /** Clic sur une archive : restauration dans les sessions vives. */
  restoreArchive: (id: string) => void;
  /** Corbeille d'une archive : mise de côté, pas destruction. */
  trashArchive: (id: string) => void;
  /** T-197 — texte des tours d'une session vive, pour la recherche (les archives n'ont que leur titre en mémoire). */
  texteDe: (session: ProjectSession) => string;
  /** T-197 — rattrapage « Nommer les anciennes discussions (N) » : N, état du passage, gestes. */
  rattrapage: { n: number; etat: EtatRattrapage; lancer: () => void; arreter: () => void };
}

export function SessionsSection(props: Readonly<SessionsSectionProps>) {
  const {
    sessions,
    sortedSessions,
    activeSessionId,
    tabbableSessionId,
    streaming,
    providers,
    editingSessionId,
    editingSessionTitle,
    setEditingSessionTitle,
    commitEditSessionTitle,
    cancelEditSessionTitle,
    startEditSessionTitle,
    confirmDeleteSessionId,
    setConfirmDeleteSessionId,
    deleteSession,
    selectSession,
    handleNewSession,
    sessionsRoving,
    archives,
    restoreArchive,
    trashArchive,
    texteDe,
    rattrapage,
  } = props;
  // T-197 — recherche : titre affiché puis texte des tours pour les sessions vives, titre seul pour les archives.
  const [requete, setRequete] = useState("");
  const rechercheActive = requete.trim() !== "";
  const visibles = useMemo(
    () => (rechercheActive ? filtrerSessions(sortedSessions, requete, texteDe) : sortedSessions),
    // `texteDe` est recréée à chaque rendu : seules la requête et les sessions comptent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rechercheActive, requete, sortedSessions],
  );
  const archivesVisibles = useMemo(
    () => (rechercheActive ? filtrerSessions(archives, requete) : archives),
    [rechercheActive, requete, archives],
  );
  return (
    <SidebarSection
      id="sessions"
      title="Sessions"
      defaultOpen={false}
      badge={sessions.length > 0 ? <span className="sidebar-section__count">{sessions.length}</span> : undefined}
    >
      {/* Bouton de création DANS la section Sessions : « Nouvelle session »
          existait aussi dans la section LLM, mais inaccessible quand celle-ci
          est repliée — le geste doit vivre là où l'on voit les sessions. */}
      <button
        type="button"
        className="btn btn--ghost session-list__new"
        onClick={handleNewSession}
        disabled={streaming}
      >
        + Nouvelle session
      </button>
      {(sessions.length > 0 || archives.length > 0) && (
        <RechercheSessions id="sessions-recherche" valeur={requete} onChange={setRequete} />
      )}
      {sessions.length === 0 ? (
        <p className="empty-hint">Aucune session.</p>
      ) : rechercheActive && visibles.length === 0 && archivesVisibles.length === 0 ? (
        <p className="empty-hint">Aucune discussion ne correspond.</p>
      ) : (
        <ul
          className="session-list"
          ref={sessionsRoving.containerRef}
          onKeyDown={sessionsRoving.onKeyDown}
          onFocus={sessionsRoving.onFocus}
        >
          {visibles.map((s) => (
            <li key={s.id} className={`session-item${s.id === activeSessionId ? " session-item--active" : ""}`}>
              {editingSessionId === s.id ? (
                <input
                  className="session-item__title-input"
                  value={editingSessionTitle}
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setEditingSessionTitle(e.currentTarget.value)}
                  onBlur={commitEditSessionTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitEditSessionTitle();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelEditSessionTitle();
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="session-item__title"
                  title={s.title}
                  disabled={streaming}
                  tabIndex={s.id === tabbableSessionId ? 0 : -1}
                  onClick={() => selectSession(s.id)}
                >
                  {s.title}
                </button>
              )}
              <div className="session-item__meta">
                <span className="session-item__date">{formatRelativeDate(s.updatedAt)}</span>
                <span className="session-item__engine">
                  {s.engine.providerId ? (providers.find((p) => p.id === s.engine.providerId)?.label ?? s.engine.providerId) : s.engine.compte === "teams" ? "Claude Teams" : "Claude"}
                </span>
              </div>
              {confirmDeleteSessionId === s.id ? (
                <div className="session-item__confirm">
                  Supprimer ?
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmDeleteSessionId(null)}>
                    Non
                  </button>
                  <button
                    type="button"
                    className="btn btn--deny"
                    onClick={() => {
                      setConfirmDeleteSessionId(null);
                      deleteSession(s.id);
                    }}
                  >
                    Oui
                  </button>
                </div>
              ) : (
                <div className="session-item__actions">
                  <button
                    type="button"
                    className="session-item__action"
                    title="Renommer"
                    aria-label={`Renommer ${s.title}`}
                    onClick={() => startEditSessionTitle(s)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="session-item__action"
                    title="Supprimer"
                    aria-label={`Supprimer ${s.title}`}
                    disabled={streaming}
                    onClick={() => setConfirmDeleteSessionId(s.id)}
                  >
                    🗑
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ArchivesGroupe
        archives={archivesVisibles}
        restoreArchive={restoreArchive}
        trashArchive={trashArchive}
        rechercheActive={rechercheActive}
      />
      <RattrapageTitres n={rattrapage.n} etat={rattrapage.etat} onLancer={rattrapage.lancer} onArreter={rattrapage.arreter} />
    </SidebarSection>
  );
}

export interface LlmSectionProps {
  selectedAgentKey: AgentSelection | null;
  projectAgentsByScope: { project: AgentInfo[]; global: AgentInfo[]; claudeCode: AgentInfo[] };
  handleAgentSelectChange: (value: string) => void;
  selectedAgent: AgentInfo | null;
  clearAgentSelection: () => void;
  streaming: boolean;
  engineProviderId: string | null;
  comptes: CompteDecrit[] | null; compteClaude: CompteClaude; // comptes Claude proposés et compte effectif (docs/spec-deux-comptes.md)
  providers: ProviderConfig[];
  handleEngineChange: (value: string) => void;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  model: string;
  setModel: (value: string) => void;
  /** Effort de raisonnement (`""` = Défaut) — Claude (abonnement) seulement. */
  effort: EffortLevel | "";
  setEffort: (value: EffortLevel | "") => void;
  neutralModelsState: "idle" | "loading" | "error";
  neutralModels: ModelDetail[];
  neutralFeaturedIds: string[];
  basculerFavoriNeutre: (modelId: string) => void;
  neutralModelsError: string;
  /** T-077 — ce que la session fait VRAIMENT (voir `EtatVifLlm`). */
  vif: EtatVifLlm;
  isCompactViewport: boolean;
}

/**
 * T-077 — état vif de la session : ce qu'elle fait VRAIMENT, par opposition
 * aux contrôles au-dessus qui disent ce qui est demandé.
 *
 * T-080 a retiré la ligne « modèle réellement routé » : depuis la suppression
 * du mode Auto, le sélecteur affiche le modèle réel — il n'y a plus d'écart
 * entre le demandé et l'exécuté. Restent les sous-agents, qui eux ne sont
 * visibles nulle part ailleurs que dans le transcript.
 */
export interface EtatVifLlm {
  sessionId: string | null;
  /** Tours de la session — les sous-agents s'en déduisent (`sousAgentsVifs`). */
  turns: AgentTurn[];
}

/** Marque d'état d'un sous-agent. Hors tour, un lancement sans résultat n'est
 *  pas « en cours » : c'est un travail interrompu, et ça se dit. */
function marqueSousAgent(agent: SousAgentVu, streaming: boolean): { signe: string; classe: string; etat: string } {
  if (!agent.termine) {
    return streaming
      ? { signe: "◉", classe: " llm-vif__agent--vif", etat: "en cours" }
      : { signe: "⚠", classe: " llm-vif__agent--interrompu", etat: "interrompu avant son terme" };
  }
  return agent.erreur
    ? { signe: "✕", classe: " llm-vif__agent--erreur", etat: "terminé en erreur" }
    : { signe: "✓", classe: "", etat: "terminé" };
}

export function LlmSection(props: Readonly<LlmSectionProps>) {
  const {
    selectedAgentKey,
    projectAgentsByScope,
    handleAgentSelectChange,
    selectedAgent,
    clearAgentSelection,
    streaming,
    engineProviderId, comptes, compteClaude,
    providers,
    handleEngineChange,
    permissionMode,
    setPermissionMode,
    model,
    setModel,
    effort,
    setEffort,
    neutralModelsState,
    neutralModels,
    neutralFeaturedIds,
    basculerFavoriNeutre,
    neutralModelsError,
    vif,
    isCompactViewport,
  } = props;
  // Les actifs d'abord : sur neuf pastilles, celle qui travaille ne doit pas
  // se chercher (constat du 2026-10-15). Tri stable, l'ordre de lancement tient.
  const sousAgents = [...sousAgentsVifs(vif.turns)].sort((a, b) => Number(a.termine) - Number(b.termine));
  const sousAgentsActifs = sousAgents.filter((a) => !a.termine).length;
  const sousAgentsRecents = useSousAgentsRecents(vif.sessionId, streaming);
  // T-206 — un `Bash` détaché n'est pas un sous-agent, mais il travaille aussi pour moi.
  const tachesDeFond = tachesDeFondHorsSousAgents(vif.turns);
  return (
    <SidebarSection id="llm" title="LLM" defaultOpen={!isCompactViewport}>
      <div className="field agent-preset">
        <label htmlFor="agent-preset-select">Agent</label>
        <Deroulant
          id="agent-preset-select"
          value={selectedAgentKey ? agentOptionValue(selectedAgentKey) : ""}
          disabled={streaming}
          onChange={handleAgentSelectChange}
        >
          <option value="">Aucun (manuel)</option>
          {projectAgentsByScope.project.length > 0 && (
            <optgroup label="Projet">
              {projectAgentsByScope.project.map((a) => (
                <option key={agentOptionValue(a)} value={agentOptionValue(a)}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
          {projectAgentsByScope.global.length > 0 && (
            <optgroup label="Global">
              {projectAgentsByScope.global.map((a) => (
                <option key={agentOptionValue(a)} value={agentOptionValue(a)}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
          {projectAgentsByScope.claudeCode.length > 0 && (
            <optgroup label="Claude Code">
              {projectAgentsByScope.claudeCode.map((a) => (
                <option key={agentOptionValue(a)} value={agentOptionValue(a)}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          )}
        </Deroulant>
        {selectedAgent && (
          <div className="agent-preset__applied">
            <span>Configuré par l'agent {selectedAgent.name}</span>
            <button
              type="button"
              className="agent-preset__clear"
              disabled={streaming}
              aria-label="Revenir au mode manuel"
              title="Revenir au mode manuel"
              onClick={clearAgentSelection}
            >
              ✕
            </button>
          </div>
        )}
      </div>

      <div className="field">
        <label htmlFor="agent-engine">Moteur</label>
        <Deroulant
          id="agent-engine"
          value={engineProviderId ?? (compteClaude === "teams" ? VALEUR_MOTEUR_TEAMS : "")}
          disabled={streaming || selectedAgent !== null}
          onChange={handleEngineChange}
        >
          {optionsMoteurClaude(comptes, "", compteClaude).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Deroulant>
      </div>

      <div className="field">
        <label htmlFor="agent-permission-mode">Mode de permission</label>
        <Deroulant
          id="agent-permission-mode"
          value={permissionMode}
          disabled={selectedAgent !== null}
          onChange={(v) => setPermissionMode(v as PermissionMode)}
        >
          {/* Le mode « plan » n'existe pas côté moteur neutre (docs/protocol.md, Lot 6). */}
          {PERMISSION_MODE_OPTIONS.filter((o) => o.value !== "plan" || engineProviderId === null).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Deroulant>
      </div>

      {/*
        Effort de raisonnement : moteur Claude seulement, et si le modèle en offre.
        Placé AU-DESSUS du modèle : la liste du sélecteur de modèle (portail en
        position fixe) s'ouvre juste en dessous et masquait ce champ.
      */}
      {engineProviderId === null && effortsPour(model).length > 0 && (
        <div className="field">
          <label htmlFor="agent-effort">Effort</label>
          <Deroulant
            id="agent-effort"
            value={effort}
            disabled={streaming || (selectedAgent !== null && selectedAgent.model !== null)}
            onChange={(v) => setEffort(v as EffortLevel | "")}
          >
            <option value="">Défaut</option>
            {effortsPour(model).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Deroulant>
        </div>
      )}

      <div className="field">
        <label htmlFor="agent-model">Modèle</label>
        {/*
          T-032 — un seul sélecteur pour les deux moteurs. Côté Claude
          (abonnement), les quatre modèles de l'abonnement sont épinglés et le
          catalogue est vide : pas de recherche utile, pas d'étoile. Côté
          neutre, c'est le catalogue du fournisseur, filtrable.
        */}
        <ModelPicker
          id="agent-model"
          value={model}
          models={engineProviderId === null ? [] : neutralModels}
          epingles={engineProviderId === null ? MODEL_OPTIONS : []}
          favoris={neutralFeaturedIds}
          onToggleFavori={engineProviderId === null ? undefined : basculerFavoriNeutre}
          // Verrouillé pendant le streaming (comme ChatPage) : changer de
          // modèle en plein tour enverrait la suite ailleurs que le début.
          disabled={streaming || (selectedAgent !== null && selectedAgent.model !== null)}
          chargement={engineProviderId !== null && neutralModelsState === "loading"}
          onChange={setModel}
        />
      </div>

      {/*
        T-077 — les sous-agents du dernier tour. Le titre distingue « en cours »
        de « dernier tour » : afficher les deux pareil laisserait croire qu'un
        travail fini tourne encore.

        T-091 — et la liste ne survit que quelques minutes au tour : passé ce
        délai, ou sur une conversation simplement rechargée du disque, « dernier
        tour » parlerait d'un travail vieux de plusieurs jours au présent.
      */}
      {sousAgents.length > 0 && sousAgentsRecents && (
        <div className="llm-vif__agents">
          <span className="llm-vif__agents-titre">
            {streaming
              ? `Sous-agents · ${sousAgentsActifs} en cours / ${sousAgents.length}`
              : `Sous-agents du dernier tour · ${sousAgents.length}`}
          </span>
          <ul>
            {sousAgents.map((agent, i) => {
              const marque = marqueSousAgent(agent, streaming);
              // T-081 — le modèle que le MANIFESTE déclare pour ce type. Une
              // intention, pas une mesure : le mot « déclaré » est dans
              // l'infobulle, et un type inconnu (agent intégré du SDK)
              // n'affiche rien plutôt qu'un modèle deviné.
              // T-203 — le `model` passé à l'appel prime : c'est lui qui tourne.
              const declare = modeleSousAgentDeclare(agent.nom, projectAgentsByScope.claudeCode);
              const libelleModele = agent.modele ?? declare.modele ?? (declare.connu ? "hérite du fil" : null);
              const detailModele = agent.modele
                ? ` · modèle demandé à l'appel : ${agent.modele}`
                : libelleModele
                  ? ` · modèle déclaré : ${declare.modele ?? "aucun, hérite du fil"}`
                  : "";
              return (
                <li
                  key={`${agent.nom}-${i}`}
                  className={`llm-vif__agent${marque.classe}`}
                  title={
                    (agent.description ? `${agent.description} — ${marque.etat}` : marque.etat) + detailModele
                  }
                  // Le signe est décoratif : l'état est porté par le libellé
                  // accessible, sinon un lecteur d'écran annoncerait « ◉ ».
                  aria-label={`${agent.nom} — ${marque.etat}${detailModele}`}
                >
                  <span className="llm-vif__agent-signe" aria-hidden="true">
                    {marque.signe}
                  </span>
                  {agent.nom}
                  {libelleModele && (
                    <span className="llm-vif__agent-modele" aria-hidden="true">
                      {libelleModele}
                    </span>
                  )}
                  {/* Ce qu'il fait, écrit en clair pour ceux qui tournent : le
                      nom du type seul (« implementeur » ×6) ne distingue rien. */}
                  {streaming && !agent.termine && agent.description && (
                    <span className="llm-vif__agent-description" aria-hidden="true">
                      {agent.description}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* T-206 — liste VIVANTE (REPLACE côté sidecar) : vide dès que les
          tâches ont rendu leur rapport, donc jamais de travail fini au présent. */}
      {tachesDeFond.length > 0 && (
        <div className="llm-vif__agents">
          <span className="llm-vif__agents-titre">{`Tâches de fond · ${tachesDeFond.length} en cours`}</span>
          <ul>
            {tachesDeFond.map((d, i) => (
              <li key={`${d}-${i}`} className="llm-vif__agent llm-vif__agent--vif" title={d}>
                <span className="llm-vif__agent-signe" aria-hidden="true">◉</span>
                <span className="llm-vif__agent-description">{d}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {engineProviderId !== null && (
        <OllamaPanel providerId={engineProviderId} selectedModel={model} />
      )}

      {engineProviderId !== null && neutralModelsState === "error" && (
        <div className="result-line result-line--error">Erreur modèles : {neutralModelsError}</div>
      )}

      {/* « Nouvelle session » vit désormais en tête de la section Sessions
          (toujours accessible) — plus de doublon ici. */}

      <div className="sidebar-indicators">
        <span
          className={`agent-engine-indicator${engineProviderId ? " agent-engine-indicator--neutral" : " agent-engine-indicator--claude"}`}
          title="Moteur de l'agent"
        >
          {engineProviderId ? (providers.find((p) => p.id === engineProviderId)?.label ?? engineProviderId) : secondCompteDispo(comptes) || compteClaude === "teams" ? libelleCompte(compteClaude) : "Claude"}
        </span>
        <span className={`agent-session-indicator${vif.sessionId ? " agent-session-indicator--active" : ""}`}>
          {vif.sessionId ? `Session ${vif.sessionId.slice(0, 8)}` : "Aucune session"}
        </span>
      </div>
    </SidebarSection>
  );
}
