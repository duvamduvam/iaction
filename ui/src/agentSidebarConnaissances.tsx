/*
 * Section « Connaissances » de la barre latérale droite de la page Projets
 * (mode, documents épinglés/détectés, index RAG). Rendu pur sorti de
 * agentSidebarDroit.tsx (T-209) : l'état reste la propriété de la page.
 */
import type { PinnedDoc } from "./connaissances";
import type { KnowledgeStatus } from "./connaissancesClient";
import { Deroulant } from "./Deroulant";
import type { DirEntry } from "./fsClient";
import type { KnowledgeMode } from "./projectAdmin";
import { SidebarSection } from "./SidebarSection";
import { formatRelativeDate } from "./sessionStore";

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
          <Deroulant
            id="knowledge-mode-select"
            value={knowledgeMode}
            disabled={!selectedProjectId || streaming}
            title="Injection : documents recopiés en préambule du 1er tour. RAG : l'agent interroge l'index local via l'outil search_knowledge."
            onChange={(v) => changeKnowledgeMode(v === "rag" ? "rag" : "injection")}
          >
            <option value="injection">Injection intégrale (défaut)</option>
            <option value="rag">RAG — outil search_knowledge</option>
          </Deroulant>
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
