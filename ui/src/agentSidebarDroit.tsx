/*
 * Barre latérale droite de la page Projets — Sessions, LLM, Connaissances.
 *
 * Trois sections de rendu pur sorties d'AgentPage.tsx (dernière tranche de
 * l'étape 8). Comme pour envoiProjet.ts, la taille des interfaces de props
 * n'est pas un accident : c'est la surface de couplage RÉELLE de chaque
 * section, rendue visible — l'état, lui, reste la propriété de la page.
 */

import type { FocusEvent, KeyboardEvent, RefObject } from "react";
import { MODELES_ABONNEMENT_CLAUDE } from "./modelesAbonnementClaude";
import { agentOptionValue, type AgentSelection, type ProjectSession } from "./modeleProjet";
import { OllamaPanel } from "./OllamaPanel";
import { PERMISSION_MODE_OPTIONS } from "./permissions";
import { SidebarSection } from "./SidebarSection";
import { formatRelativeDate } from "./sessionStore";
import type { AgentInfo } from "./orchestrationClient";
import type { ProviderConfig } from "./providerAdmin";
import type { DirEntry } from "./fsClient";
import type { KnowledgeMode } from "./projectAdmin";
import type { PinnedDoc } from "./connaissances";
import { ModelPicker, type OptionEpinglee } from "./ModelPicker";
import { modeleSousAgentDeclare, sousAgentsVifs, type AgentTurn, type SousAgentVu } from "./agentTurns";
import { useSousAgentsRecents } from "./useSousAgentsRecents";
import type { ModelDetail, PermissionMode } from "./sidecar";
import type { KnowledgeStatus } from "./connaissancesClient";

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
 * T-080 — plus de sentinelle « Auto (descendant) », ni d'option « (défaut) »
 * muette. Les deux disaient la même chose — « quelqu'un d'autre choisira » —
 * et ce quelqu'un ne choisissait rien : le mode Auto imposait le sommet de la
 * table sans lire le prompt (T-079), et « (défaut) » laissait simplement le
 * CLI décider sans que l'application sache dire quoi. Une session part
 * désormais sur le modèle réglé dans Configuration, affiché en clair ici.
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
  } = props;
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
      {sessions.length === 0 ? (
        <p className="empty-hint">Aucune session.</p>
      ) : (
        <ul
          className="session-list"
          ref={sessionsRoving.containerRef}
          onKeyDown={sessionsRoving.onKeyDown}
          onFocus={sessionsRoving.onFocus}
        >
          {sortedSessions.map((s) => (
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
                  {s.engine.providerId ? (providers.find((p) => p.id === s.engine.providerId)?.label ?? s.engine.providerId) : "Claude"}
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
  providers: ProviderConfig[];
  handleEngineChange: (value: string) => void;
  permissionMode: PermissionMode;
  setPermissionMode: (mode: PermissionMode) => void;
  model: string;
  setModel: (value: string) => void;
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
    engineProviderId,
    providers,
    handleEngineChange,
    permissionMode,
    setPermissionMode,
    model,
    setModel,
    neutralModelsState,
    neutralModels,
    neutralFeaturedIds,
    basculerFavoriNeutre,
    neutralModelsError,
    vif,
    isCompactViewport,
  } = props;
  const sousAgents = sousAgentsVifs(vif.turns);
  const sousAgentsRecents = useSousAgentsRecents(vif.sessionId, streaming);
  return (
    <SidebarSection id="llm" title="LLM" defaultOpen={!isCompactViewport}>
      <div className="field agent-preset">
        <label htmlFor="agent-preset-select">Agent</label>
        <select
          id="agent-preset-select"
          value={selectedAgentKey ? agentOptionValue(selectedAgentKey) : ""}
          disabled={streaming}
          onChange={(e) => handleAgentSelectChange(e.currentTarget.value)}
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
        </select>
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
        <select
          id="agent-engine"
          value={engineProviderId ?? ""}
          disabled={streaming || selectedAgent !== null}
          onChange={(e) => handleEngineChange(e.currentTarget.value)}
        >
          <option value="">Claude (abonnement)</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="agent-permission-mode">Mode de permission</label>
        <select
          id="agent-permission-mode"
          value={permissionMode}
          disabled={selectedAgent !== null}
          onChange={(e) => setPermissionMode(e.currentTarget.value as PermissionMode)}
        >
          {/* Le mode « plan » n'existe pas côté moteur neutre (docs/protocol.md, Lot 6). */}
          {PERMISSION_MODE_OPTIONS.filter((o) => o.value !== "plan" || engineProviderId === null).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

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
            {streaming ? "Sous-agents en cours" : "Sous-agents du dernier tour"} · {sousAgents.length}
          </span>
          <ul>
            {sousAgents.map((agent, i) => {
              const marque = marqueSousAgent(agent, streaming);
              // T-081 — le modèle que le MANIFESTE déclare pour ce type. Une
              // intention, pas une mesure : le mot « déclaré » est dans
              // l'infobulle, et un type inconnu (agent intégré du SDK)
              // n'affiche rien plutôt qu'un modèle deviné.
              const { modele, connu } = modeleSousAgentDeclare(agent.nom, projectAgentsByScope.claudeCode);
              const libelleModele = modele ?? (connu ? "hérite du fil" : null);
              const detailModele = libelleModele
                ? ` · modèle déclaré : ${modele ?? "aucun, hérite du fil"}`
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
                </li>
              );
            })}
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
          {engineProviderId ? (providers.find((p) => p.id === engineProviderId)?.label ?? engineProviderId) : "Claude"}
        </span>
        <span className={`agent-session-indicator${vif.sessionId ? " agent-session-indicator--active" : ""}`}>
          {vif.sessionId ? `Session ${vif.sessionId.slice(0, 8)}` : "Aucune session"}
        </span>
      </div>
    </SidebarSection>
  );
}

export interface ConnaissancesSectionProps {
  /** Documents réellement injectés au 1er tour (badge de la section). */
  injectedKnowledge: PinnedDoc[];
  knowledgeMode: KnowledgeMode;
  changeKnowledgeMode: (mode: KnowledgeMode) => void;
  selectedProjectId: string | null;
  streaming: boolean;
  knowledgeIdx: KnowledgeStatus | null;
  cwd: string;
  indexingKnowledge: boolean;
  knowledgeIndexProgress: { done: number; total: number } | null;
  knowledgeIndexError: string;
  handleIndexKnowledge: () => Promise<void>;
  pinnedKnowledge: PinnedDoc[];
  autoKnowledgeDocs: PinnedDoc[];
  /** CLAUDE.md du projet (groupe « Détectées ») — null si absent. */
  claudeMdPath: string | null;
  claudeMemoryFiles: DirEntry[];
  handleOpenFile: (path: string, name: string) => void;
  unpinKnowledge: (path: string) => void;
  pinKnowledge: (path: string, name: string) => void;
}

export function ConnaissancesSection(props: Readonly<ConnaissancesSectionProps>) {
  const {
    injectedKnowledge,
    knowledgeMode,
    changeKnowledgeMode,
    selectedProjectId,
    streaming,
    knowledgeIdx,
    cwd,
    indexingKnowledge,
    knowledgeIndexProgress,
    knowledgeIndexError,
    handleIndexKnowledge,
    pinnedKnowledge,
    autoKnowledgeDocs,
    claudeMdPath,
    claudeMemoryFiles,
    handleOpenFile,
    unpinKnowledge,
    pinKnowledge,
  } = props;
  return (
    <SidebarSection
      id="knowledge"
      title="Connaissances"
      defaultOpen={false}
      badge={injectedKnowledge.length > 0 ? <span className="sidebar-section__count">{injectedKnowledge.length}</span> : undefined}
    >
      {/* R5 — bascule injection/RAG + index d'embeddings local (docs/spec-r5-rag.md §4). */}
      <div className="knowledge-rag">
        <div className="field">
          <label htmlFor="knowledge-mode-select">Mode</label>
          <select
            id="knowledge-mode-select"
            value={knowledgeMode}
            disabled={!selectedProjectId || streaming}
            title="Injection : documents recopiés en préambule du 1er tour. RAG : l'agent interroge l'index local via l'outil search_knowledge."
            onChange={(e) => changeKnowledgeMode(e.currentTarget.value === "rag" ? "rag" : "injection")}
          >
            <option value="injection">Injection intégrale (défaut)</option>
            <option value="rag">RAG — outil search_knowledge</option>
          </select>
        </div>
        <div className="knowledge-rag__status">
          {knowledgeIdx?.exists ? (
            <>
              <span>
                Index : {knowledgeIdx.files} fichier{knowledgeIdx.files > 1 ? "s" : ""} ·{" "}
                {knowledgeIdx.chunks} chunk{knowledgeIdx.chunks > 1 ? "s" : ""}
                {knowledgeIdx.model ? ` · ${knowledgeIdx.model}` : ""}
                {knowledgeIdx.builtAt ? ` · ${formatRelativeDate(knowledgeIdx.builtAt)}` : ""}
              </span>
              {knowledgeIdx.stale && (
                <span
                  className="knowledge-rag__stale"
                  title="Un document source a changé depuis la dernière indexation — relancer « Indexer maintenant »."
                >
                  ⚠ index obsolète
                </span>
              )}
            </>
          ) : (
            <span>Aucun index — indexer pour activer l'outil search_knowledge.</span>
          )}
        </div>
        <button
          type="button"
          className="btn btn--ghost knowledge-rag__index"
          disabled={!cwd || indexingKnowledge}
          onClick={() => void handleIndexKnowledge()}
        >
          {indexingKnowledge
            ? knowledgeIndexProgress
              ? `Indexation… ${knowledgeIndexProgress.done}/${knowledgeIndexProgress.total}`
              : "Indexation…"
            : "Reconstruire l'index"}
        </button>
        {knowledgeIndexError && <p className="knowledge-rag__error">{knowledgeIndexError}</p>}
      </div>

      {pinnedKnowledge.length === 0 &&
      autoKnowledgeDocs.length === 0 &&
      !claudeMdPath &&
      claudeMemoryFiles.length === 0 ? (
        <p className="empty-hint">
          Clic droit sur un fichier dans « Fichiers » → « Épingler comme connaissance », ou déposez des
          fichiers dans .iaction/connaissances/.
        </p>
      ) : (
        <>
          {pinnedKnowledge.length > 0 && (
            <div className="knowledge-group">
              <p className="knowledge-group__title">Épinglées</p>
              <ul className="knowledge-list">
                {pinnedKnowledge.map((doc) => (
                  <li key={doc.path} className="knowledge-item">
                    <button
                      type="button"
                      className="knowledge-item__open"
                      title={doc.path}
                      onClick={() => handleOpenFile(doc.path, doc.name)}
                    >
                      {doc.name}
                    </button>
                    <button
                      type="button"
                      className="knowledge-item__remove"
                      aria-label={`Retirer ${doc.name}`}
                      title="Retirer"
                      onClick={() => unpinKnowledge(doc.path)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {autoKnowledgeDocs.length > 0 && (
            <div className="knowledge-group">
              <p
                className="knowledge-group__title"
                title="Retirer un fichier = le supprimer du dossier .iaction/connaissances/"
              >
                Automatiques (.iaction/connaissances)
              </p>
              <ul className="knowledge-list">
                {autoKnowledgeDocs.map((doc) => (
                  <li key={doc.path} className="knowledge-item">
                    <button
                      type="button"
                      className="knowledge-item__open"
                      title={`${doc.path} — retrait : supprimer le fichier du dossier .iaction/connaissances/`}
                      onClick={() => handleOpenFile(doc.path, doc.name)}
                    >
                      {doc.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(claudeMdPath || claudeMemoryFiles.length > 0) && (
            <div className="knowledge-group">
              <p className="knowledge-group__title">Détectées</p>
              <ul className="knowledge-list">
                {claudeMdPath && (
                  <li className="knowledge-item">
                    <button
                      type="button"
                      className="knowledge-item__open"
                      title="Instructions projet — chargée automatiquement par le moteur Claude ; non ré-injectée par iaction"
                      onClick={() => handleOpenFile(claudeMdPath as string, "CLAUDE.md")}
                    >
                      CLAUDE.md
                    </button>
                    <span className="knowledge-item__tag">chargée par le moteur Claude</span>
                  </li>
                )}
                {claudeMemoryFiles.map((f) => {
                  const alreadyPinned = pinnedKnowledge.some((d) => d.path === f.path);
                  return (
                    <li key={f.path} className="knowledge-item">
                      <button
                        type="button"
                        className="knowledge-item__open"
                        title={`${f.path} — mémoire Claude Code`}
                        onClick={() => handleOpenFile(f.path, f.name)}
                      >
                        {f.name}
                      </button>
                      <button
                        type="button"
                        className="knowledge-item__pin"
                        disabled={alreadyPinned}
                        title={
                          alreadyPinned
                            ? "Déjà épinglée (injectée au 1er tour)"
                            : "Épingler comme connaissance (l'ajoute aux épinglées, injectée au 1er tour — utile pour le moteur neutre)"
                        }
                        onClick={() => pinKnowledge(f.path, f.name)}
                      >
                        {alreadyPinned ? "Épinglée" : "Épingler"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </SidebarSection>
  );
}
