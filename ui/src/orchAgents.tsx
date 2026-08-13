/*
 * Section Agents : cartes, visionneuse, éditeur (création/édition YAML).
 * Extrait d'OrchestrationPage le 2026-08-08 (étape 7) — déplacement pur.
 */

/*
 * Page « Orchestration » (phase O1, voir docs/etude-orchestration.md § 5) :
 * sous-navigation en pilules (même patron que ProvidersPage) — Agents /
 * Orchestrations / Exécutions / Tâches (T1, docs/etude-taches.md § 3.3) —
 * au-dessus d'un sélecteur de contexte projet qui détermine le `cwd` passé
 * aux méthodes `agents.*`/`orch.*` (`null` = « Global uniquement »). Ce
 * sélecteur gagne un optgroup « Tâches » (T1) : choisir une tâche pointe le
 * `cwd` sur son dossier — du point de vue des scopes `agents.*`/`orch.*`,
 * une tâche sélectionnée s'affiche comme un contexte « Projet » ordinaire
 * (mêmes libellés, aucune notion de « tâche » côté agents/orchestrations).
 *
 * Les panneaux Agents/Orchestrations restent montés en permanence (masqués
 * via CSS, même pattern que `config-panel` dans ProvidersPage) : la liste
 * des agents est nécessaire aux DEUX (le sélecteur d'agent d'une étape
 * d'orchestration vient de la même liste), donc chargée indépendamment de
 * l'onglet actif. Un changement de contexte projet REMONTE les deux
 * sections (`key={cwd}`) : ça réinitialise proprement tout éditeur ouvert
 * plutôt que de le laisser pointer vers un `cwd` périmé. Le panneau Tâches
 * n'a pas besoin de ce `key={cwd}` : les méthodes `taches.*` n'ont pas de
 * notion de `cwd`/portée (répertoire racine unique côté sidecar).
 */


import { Modal } from "./Modal";
import { toMessage } from "./base";
import {
  agentScopeLabel,
  agentYamlPreview,
  engineChipLabel,
  ErrorOrStaleHint,
  type LoadState,
  PERMISSION_MODE_OPTIONS,
  TOOL_OPTIONS,
} from "./orchCommun";
import {
  type AgentInfo,
  agentsDelete,
  agentsRead,
  agentsWrite,
  type AgentWriteInput,
} from "./orchestrationClient";
import { type ProviderConfig } from "./providerAdmin";
import { type PermissionMode } from "./sidecar";
import { useEffect, useState } from "react";

export interface AgentsSectionProps {
  cwd: string | null;
  hasProject: boolean;
  providers: ProviderConfig[];
  agents: AgentInfo[];
  loadState: LoadState;
  errorMessage: string;
  staleEngine: boolean;
  onReload: () => void;
}

export function AgentCard({
  agent,
  providers,
  busy,
  onEdit,
  onView,
  onDuplicate,
  onDelete,
}: Readonly<{
  agent: AgentInfo;
  providers: ProviderConfig[];
  busy: boolean;
  onEdit: () => void;
  onView: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}>) {
  return (
    <article className="orch-card">
      <div className="orch-card__head">
        <span className="orch-card__name">{agent.name}</span>
        <div className="orch-card__badges">
          <span className={`orch-badge orch-badge--scope-${agent.scope}`}>{agentScopeLabel(agent.scope)}</span>
          {agent.readOnly && <span className="orch-badge orch-badge--readonly">Lecture seule</span>}
        </div>
      </div>
      {agent.description && <p className="orch-card__desc">{agent.description}</p>}
      <span className="orch-chip">{engineChipLabel(agent, providers)}</span>
      <div className="actions">
        {agent.readOnly ? (
          <button type="button" className="btn btn--ghost" onClick={onView}>
            Voir
          </button>
        ) : (
          <button type="button" className="btn btn--ghost" onClick={onEdit} disabled={busy}>
            {busy ? "Chargement…" : "Éditer"}
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onDuplicate}>
          Dupliquer
        </button>
        {!agent.readOnly && (
          <button type="button" className="btn btn--ghost" onClick={onDelete}>
            Supprimer
          </button>
        )}
      </div>
    </article>
  );
}

export function AgentErrorCard({ agent }: Readonly<{ agent: AgentInfo }>) {
  return (
    <article className="orch-card orch-card--error">
      <div className="orch-card__head">
        <span className="orch-card__name">{agent.name || "(agent invalide)"}</span>
      </div>
      <div className="result-line result-line--error">{agent.invalid}</div>
    </article>
  );
}

export function AgentViewPanel({ agent, onClose }: Readonly<{ agent: AgentInfo; onClose: () => void }>) {
  return (
    <Modal label={`Voir ${agent.name}`} onClose={onClose}>
      <div className="orch-modal">
        <div className="orch-modal__head">
          <h3>
            {agent.name}
            <span className="orch-badge orch-badge--readonly">Importé de .claude/agents</span>
          </h3>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        <div className="orch-modal__body">
          {agent.description && <p className="empty-hint">{agent.description}</p>}
          <div className="field">
            <label htmlFor="agv-instructions">Instructions</label>
            <textarea id="agv-instructions" rows={16} value={agent.instructions} readOnly />
          </div>
          <p className="empty-hint">Chemin : {agent.path}</p>
        </div>
        <div className="actions orch-modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </Modal>
  );
}

export interface AgentEditorProps {
  mode: "create" | "edit";
  cwd: string | null;
  hasProject: boolean;
  providers: ProviderConfig[];
  /** Édition : agent chargé via agents.read. Création : `null` (vierge) ou agent source (duplication). */
  initial: AgentInfo | null;
  /** Texte YAML chargé via agents.read (édition uniquement) — sinon régénéré depuis le formulaire. */
  initialRaw: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AgentEditor({ mode, cwd, hasProject, providers, initial, initialRaw, onClose, onSaved }: Readonly<AgentEditorProps>) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [scope, setScope] = useState<"project" | "global">(
    initial?.scope === "global" || !hasProject ? "global" : "project",
  );
  // "" = Claude (abonnement) ; sinon id du fournisseur (moteur neutre).
  const [engineValue, setEngineValue] = useState(initial?.engine === "neutral" ? (initial.provider ?? "") : "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initial?.permissionMode ?? "default");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [toolsAll, setToolsAll] = useState(initial ? initial.tools === null : true);
  const [toolsSet, setToolsSet] = useState<Set<string>>(
    new Set(initial?.tools ?? TOOL_OPTIONS.map((t) => t.value)),
  );
  const [mcp, setMcp] = useState(initial?.mcp ?? false);
  const [knowledgeRaw, setKnowledgeRaw] = useState((initial?.knowledge ?? []).join("\n"));
  const [maxTurnsRaw, setMaxTurnsRaw] = useState(initial?.maxTurns != null ? String(initial.maxTurns) : "");

  const [activeTab, setActiveTab] = useState<"form" | "yaml">("form");
  const [yamlText, setYamlText] = useState(initialRaw ?? "");
  const [yamlTouched, setYamlTouched] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Le mode « plan » n'existe pas côté moteur neutre (voir AgentPage.tsx).
  useEffect(() => {
    if (engineValue !== "" && permissionMode === "plan") setPermissionMode("default");
  }, [engineValue, permissionMode]);

  function buildInput(): AgentWriteInput {
    const trimmedMaxTurns = maxTurnsRaw.trim();
    return {
      name: name.trim(),
      description: description.trim(),
      engine: engineValue === "" ? "claude" : "neutral",
      provider: engineValue === "" ? null : engineValue,
      model: model.trim() ? model.trim() : null,
      permissionMode,
      instructions,
      tools: toolsAll ? null : Array.from(toolsSet),
      mcp,
      knowledge: knowledgeRaw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      maxTurns: trimmedMaxTurns ? Number(trimmedMaxTurns) : null,
    };
  }

  // Onglet YAML affiché sans édition manuelle depuis le dernier passage :
  // on le régénère depuis le formulaire (tabs « synchronisés »). Une fois
  // l'utilisateur passé à l'édition manuelle, on respecte son texte tant
  // qu'il ne clique pas explicitement sur « Regénérer ».
  useEffect(() => {
    if (activeTab === "yaml" && !yamlTouched) {
      setYamlText(agentYamlPreview(buildInput()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  function toggleTool(value: string) {
    setToolsSet((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      if (activeTab === "yaml") {
        await agentsWrite(cwd, scope, { raw: yamlText });
      } else {
        const input = buildInput();
        if (!input.name) {
          setError("Le nom est obligatoire.");
          return;
        }
        await agentsWrite(cwd, scope, { agent: input });
      }
      onSaved();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal label={mode === "edit" ? `Éditer l'agent ${initial?.name ?? ""}` : "Nouvel agent"} onClose={onClose}>
      <div className="orch-modal">
        <div className="orch-modal__head">
          <h3>{mode === "edit" ? `Éditer « ${initial?.name} »` : "Nouvel agent"}</h3>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>

        <div className="orch-tabs">
          <button
            type="button"
            className={`orch-tab${activeTab === "form" ? " orch-tab--active" : ""}`}
            onClick={() => setActiveTab("form")}
          >
            Formulaire
          </button>
          <button
            type="button"
            className={`orch-tab${activeTab === "yaml" ? " orch-tab--active" : ""}`}
            onClick={() => setActiveTab("yaml")}
          >
            YAML brut
          </button>
        </div>

        {activeTab === "form" ? (
          <div className="orch-modal__body">
            <div className="field">
              <label htmlFor="ag-name">Nom</label>
              <input
                id="ag-name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                disabled={mode === "edit"}
                placeholder="ex. relecteur-rust"
              />
            </div>
            <div className="field">
              <label htmlFor="ag-desc">Description</label>
              <input
                id="ag-desc"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder="Rôle en une phrase"
              />
            </div>
            <div className="field">
              <label htmlFor="ag-scope">Portée</label>
              <select
                id="ag-scope"
                value={scope}
                disabled={mode === "edit"}
                onChange={(e) => setScope(e.currentTarget.value as "project" | "global")}
              >
                {hasProject && <option value="project">Projet</option>}
                <option value="global">Global</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ag-engine">Moteur</label>
              <select id="ag-engine" value={engineValue} onChange={(e) => setEngineValue(e.currentTarget.value)}>
                <option value="">Claude (abonnement)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ag-model">Modèle</label>
              <input
                id="ag-model"
                value={model}
                onChange={(e) => setModel(e.currentTarget.value)}
                placeholder="ex. claude-fable-5, qwen3.5:4b"
              />
            </div>
            <div className="field">
              <label htmlFor="ag-permission">Mode de permission</label>
              <select
                id="ag-permission"
                value={permissionMode}
                onChange={(e) => setPermissionMode(e.currentTarget.value as PermissionMode)}
              >
                {PERMISSION_MODE_OPTIONS.filter((o) => o.value !== "plan" || engineValue === "").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="ag-instructions">Instructions</label>
              <textarea
                id="ag-instructions"
                rows={8}
                value={instructions}
                onChange={(e) => setInstructions(e.currentTarget.value)}
                placeholder="Prompt système de l'agent…"
              />
            </div>
            <div className="field">
              <label className="field--checkbox" htmlFor="ag-tools-all">
                <input
                  id="ag-tools-all"
                  type="checkbox"
                  checked={toolsAll}
                  onChange={(e) => setToolsAll(e.currentTarget.checked)}
                />
                <span>Tous les outils (aucune restriction)</span>
              </label>
              {!toolsAll && (
                <div className="orch-tools-grid">
                  {TOOL_OPTIONS.map((t) => (
                    <label key={t.value} className="field--checkbox">
                      <input type="checkbox" checked={toolsSet.has(t.value)} onChange={() => toggleTool(t.value)} />
                      <span>{t.label}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label className="field field--checkbox" htmlFor="ag-mcp">
              <input id="ag-mcp" type="checkbox" checked={mcp} onChange={(e) => setMcp(e.currentTarget.checked)} />
              <span>Hérite du .mcp.json du projet</span>
            </label>
            <div className="field">
              <label htmlFor="ag-knowledge">Connaissances (un chemin par ligne)</label>
              <textarea
                id="ag-knowledge"
                rows={3}
                value={knowledgeRaw}
                onChange={(e) => setKnowledgeRaw(e.currentTarget.value)}
                placeholder="docs/conventions.md"
              />
            </div>
            <div className="field">
              <label htmlFor="ag-maxturns">Nombre max. de tours (optionnel)</label>
              <input
                id="ag-maxturns"
                type="number"
                min={1}
                value={maxTurnsRaw}
                onChange={(e) => setMaxTurnsRaw(e.currentTarget.value)}
                placeholder="ex. 12"
              />
            </div>
          </div>
        ) : (
          <div className="orch-modal__body">
            <div className="actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setYamlText(agentYamlPreview(buildInput()));
                  setYamlTouched(false);
                }}
              >
                ↻ Regénérer depuis le formulaire
              </button>
            </div>
            <textarea
              className="orch-yaml-editor"
              rows={20}
              value={yamlText}
              onChange={(e) => {
                setYamlText(e.currentTarget.value);
                setYamlTouched(true);
              }}
              spellCheck={false}
            />
          </div>
        )}

        {error && <div className="result-line result-line--error">Erreur : {error}</div>}
        <div className="actions orch-modal__actions">
          <button type="button" className="btn" disabled={saving} onClick={() => void handleSave()}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
            Annuler
          </button>
        </div>
      </div>
    </Modal>
  );
}

export type AgentPanelState = { mode: "create" | "edit"; seed: AgentInfo | null; raw: string | null } | null;

export function AgentsSection({
  cwd,
  hasProject,
  providers,
  agents,
  loadState,
  errorMessage,
  staleEngine,
  onReload,
}: Readonly<AgentsSectionProps>) {
  const [panel, setPanel] = useState<AgentPanelState>(null);
  const [viewing, setViewing] = useState<AgentInfo | null>(null);
  const [actionError, setActionError] = useState("");
  const [readingPath, setReadingPath] = useState<string | null>(null);

  async function openEdit(agent: AgentInfo) {
    setActionError("");
    setReadingPath(agent.path);
    try {
      const { agent: fresh, raw } = await agentsRead(agent.path, cwd);
      setPanel({ mode: "edit", seed: fresh, raw });
    } catch (err) {
      setActionError(toMessage(err));
    } finally {
      setReadingPath(null);
    }
  }

  function openDuplicate(agent: AgentInfo) {
    const seedScope = agent.scope === "claude-code" ? (hasProject ? "project" : "global") : agent.scope;
    setPanel({ mode: "create", seed: { ...agent, name: `${agent.name}-copie`, readOnly: false, scope: seedScope }, raw: null });
  }

  function openCreate() {
    setPanel({ mode: "create", seed: null, raw: null });
  }

  async function handleDelete(agent: AgentInfo) {
    if (!window.confirm(`Supprimer l'agent « ${agent.name} » ?`)) return;
    setActionError("");
    try {
      await agentsDelete(cwd, agent.path);
      onReload();
    } catch (err) {
      setActionError(toMessage(err));
    }
  }

  return (
    <section className="config-section">
      <div className="orch-toolbar">
        <p className="empty-hint">
          Agents déclarés dans ce contexte (projet + globaux ; le projet gagne en cas de collision de nom).
        </p>
        <button type="button" className="btn" onClick={openCreate}>
          + Nouvel agent
        </button>
      </div>

      {loadState === "loading" && <p className="empty-hint">Chargement…</p>}
      {loadState === "error" && <ErrorOrStaleHint stale={staleEngine} message={errorMessage} />}
      {actionError && <div className="result-line result-line--error">Erreur : {actionError}</div>}

      <div className="orch-card-grid">
        {agents.map((agent) =>
          agent.invalid ? (
            <AgentErrorCard key={agent.path || agent.name} agent={agent} />
          ) : (
            <AgentCard
              key={agent.path || agent.name}
              agent={agent}
              providers={providers}
              busy={readingPath === agent.path}
              onEdit={() => void openEdit(agent)}
              onView={() => setViewing(agent)}
              onDuplicate={() => openDuplicate(agent)}
              onDelete={() => void handleDelete(agent)}
            />
          ),
        )}
        {agents.length === 0 && loadState === "ready" && <p className="empty-hint">Aucun agent déclaré dans ce contexte.</p>}
      </div>

      {panel && (
        <AgentEditor
          mode={panel.mode}
          cwd={cwd}
          hasProject={hasProject}
          providers={providers}
          initial={panel.seed}
          initialRaw={panel.raw}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            onReload();
          }}
        />
      )}

      {viewing && <AgentViewPanel agent={viewing} onClose={() => setViewing(null)} />}
    </section>
  );
}

/* ================= Orchestrations ================= */

