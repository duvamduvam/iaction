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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toMessage } from "./base";
import { Markdown } from "./Markdown";
import { Modal } from "./Modal";
import type { ProjectConfig } from "./projectAdmin";
import type { ProviderConfig } from "./providerAdmin";
import type { ClaudeUsage, PermissionMode } from "./sidecar";
import { stateRead, stateWrite } from "./stateClient";
import {
  tachesDelete,
  tachesList,
  tachesRead,
  tachesReportRead,
  tachesReports,
  tachesTimerApply,
  tachesTimerRemove,
  tachesTimerStatus,
  tachesWrite,
  type TacheInfo,
  type TacheLieu,
  type TacheReportInfo,
  type TacheTimerStatus,
  type TacheWriteInput,
  type TacheWriteResult,
} from "./tachesClient";
import { notifyUsageChanged } from "./usageBus";
import { useRovingFocus } from "./useRovingFocus";
import {
  agentsDelete,
  agentsList,
  agentsRead,
  agentsWrite,
  orchAbort,
  orchDelete,
  orchList,
  orchPermission,
  orchRead,
  orchRun,
  orchWrite,
  type AgentEngine,
  type AgentInfo,
  type AgentScope,
  type AgentWriteInput,
  type OrchestrationInfo,
  type OrchestrationInputField,
  type OrchestrationLimits,
  type OrchestrationScope,
  type OrchestrationStep,
  type OrchestrationWriteInput,
  type OrchRunChunk,
  type OrchRunDoneStep,
  type OrchRunStatus,
} from "./orchestrationClient";

type LoadState = "loading" | "ready" | "error";

/* ---------- Utilitaires partagés ---------- */

/** Un sidecar pas encore à jour rejette avec un message de type « méthode inconnue ». */
function looksLikeUnknownMethod(message: string): boolean {
  return /m[ée]thode inconnue|unknown method|non impl[ée]ment[ée]e|not implemented/i.test(message);
}


function agentScopeLabel(scope: AgentScope): string {
  if (scope === "global") return "Global";
  if (scope === "claude-code") return "Claude Code";
  return "Projet";
}

function engineChipLabel(agent: Pick<AgentInfo, "engine" | "provider" | "model">, providers: ProviderConfig[]): string {
  if (agent.engine === "claude") return `Claude · ${agent.model || "défaut"}`;
  // R2 — moteur/modèle choisis par le routeur à l'exécution.
  if (agent.engine === "auto") return "Auto (routeur)";
  const label = providers.find((p) => p.id === agent.provider)?.label ?? agent.provider ?? "Neutre";
  return `${label} · ${agent.model || "—"}`;
}

const TOOL_OPTIONS: { value: string; label: string }[] = [
  { value: "read_file", label: "Lire un fichier" },
  { value: "list_dir", label: "Lister un dossier" },
  { value: "search", label: "Rechercher" },
  { value: "write_file", label: "Écrire un fichier" },
  { value: "edit_file", label: "Éditer un fichier" },
  { value: "bash", label: "Bash" },
];

const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Valider chaque action" },
  { value: "acceptEdits", label: "Éditions auto-acceptées" },
  { value: "plan", label: "Plan (lecture seule)" },
  { value: "bypassPermissions", label: "⚠ Autonome (aucune validation)" },
];

/** Sérialisation minimale (pas un vrai parseur — le sidecar est seul juge du format, voir orchestrationClient.ts). */
function yamlScalar(s: string): string {
  if (s === "") return '""';
  if (/^[A-Za-z0-9_\-./]+$/.test(s) && !/^(true|false|null|~)$/i.test(s)) return s;
  return JSON.stringify(s);
}

function yamlBlockScalar(s: string, contentIndent: string): string {
  if (!s) return '""';
  return `|\n${s.split("\n").map((l) => `${contentIndent}${l}`).join("\n")}`;
}

function agentYamlPreview(input: AgentWriteInput): string {
  const lines: string[] = [];
  lines.push(`name: ${input.name || "(sans nom)"}`);
  lines.push(`description: ${yamlScalar(input.description)}`);
  lines.push(`engine: ${input.engine}`);
  lines.push(`provider: ${input.provider ? yamlScalar(input.provider) : "null"}`);
  lines.push(`model: ${input.model ? yamlScalar(input.model) : "null"}`);
  lines.push(`permissionMode: ${input.permissionMode}`);
  lines.push(`instructions: ${yamlBlockScalar(input.instructions, "  ")}`);
  if (input.tools === null) {
    lines.push(`tools: null`);
  } else {
    lines.push(`tools:`);
    for (const t of input.tools) lines.push(`  - ${t}`);
  }
  lines.push(`mcp: ${input.mcp}`);
  if (input.knowledge.length === 0) {
    lines.push(`knowledge: []`);
  } else {
    lines.push(`knowledge:`);
    for (const k of input.knowledge) lines.push(`  - ${yamlScalar(k)}`);
  }
  lines.push(`maxTurns: ${input.maxTurns ?? "null"}`);
  return `${lines.join("\n")}\n`;
}

function orchestrationYamlPreview(input: OrchestrationWriteInput): string {
  const lines: string[] = [];
  lines.push(`name: ${input.name || "(sans nom)"}`);
  lines.push(`description: ${yamlScalar(input.description)}`);
  if (input.inputs.length === 0) {
    lines.push(`inputs: []`);
  } else {
    lines.push(`inputs:`);
    for (const inp of input.inputs) {
      lines.push(`  - name: ${inp.name}`);
      lines.push(`    label: ${yamlScalar(inp.label)}`);
      // `default` : absent = requis ; chaîne (même vide) = valeur au lancement.
      if (inp.default !== null) lines.push(`    default: ${yamlScalar(inp.default)}`);
    }
  }
  if (input.steps.length === 0) {
    lines.push(`steps: []`);
  } else {
    lines.push(`steps:`);
    for (const step of input.steps) {
      lines.push(`  - id: ${step.id}`);
      lines.push(`    agent: ${step.agent}`);
      lines.push(`    task: ${yamlBlockScalar(step.task, "      ")}`);
      if (step.needs.length > 0) lines.push(`    needs: [${step.needs.join(", ")}]`);
    }
  }
  lines.push(`limits:`);
  lines.push(`  maxParallel: ${input.limits.maxParallel}`);
  lines.push(`  maxDurationMin: ${input.limits.maxDurationMin}`);
  return `${lines.join("\n")}\n`;
}

function tacheYamlPreview(input: TacheWriteInput): string {
  const lines: string[] = [];
  lines.push(`name: ${input.name || "(sans nom)"}`);
  lines.push(`description: ${yamlScalar(input.description)}`);
  lines.push(`orchestration: ${input.orchestration || "(orchestration manquante)"}`);
  lines.push(`schedule: ${input.schedule ? yamlScalar(input.schedule) : "null"}`);
  const inputEntries = Object.entries(input.inputs);
  if (inputEntries.length === 0) {
    lines.push(`inputs: {}`);
  } else {
    lines.push(`inputs:`);
    for (const [k, v] of inputEntries) lines.push(`  ${k}: ${yamlScalar(v)}`);
  }
  lines.push(`report: ${input.report ? yamlScalar(input.report) : "null"}`);
  lines.push(`enabled: ${input.enabled}`);
  lines.push(`cwd: ${input.cwd ? yamlScalar(input.cwd) : "null"}`);
  // Reflété même sans contrôle d'interface (l'édition du lieu est la tranche
  // D3) : l'aperçu doit montrer EXACTEMENT ce qui sera écrit, sans quoi une
  // tâche `serveur` semblerait repasser en `local` — ou pire, le ferait.
  lines.push(`lieu: ${input.lieu}`);
  return `${lines.join("\n")}\n`;
}

/** Date locale `YYYY-MM-DD` (résolution du gabarit `{{today}}`, voir docs/protocol.md § T1). */
function localDateISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Résout `{{today}}` dans les valeurs d'un objet d'inputs (clefs inchangées) — voir « Lancer maintenant ». */
function resolveTodayTemplates(inputs: Record<string, string>): Record<string, string> {
  const today = localDateISO(new Date());
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputs)) out[k] = v.split("{{today}}").join(today);
  return out;
}

function formatReportDate(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Aperçu du DAG : profondeur = 1 + profondeur max de ses dépendances (0 si sans `needs`). */
function computeDagOrder(steps: OrchestrationStep[]): { step: OrchestrationStep; index: number; depth: number }[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depthCache = new Map<string, number>();

  function depthOf(id: string, seen: Set<string>): number {
    if (depthCache.has(id)) return depthCache.get(id) as number;
    if (seen.has(id)) return 0; // cycle : pas de garde-fou plus fin ici, juste éviter la boucle infinie
    const step = byId.get(id);
    if (!step || step.needs.length === 0) {
      depthCache.set(id, 0);
      return 0;
    }
    const nextSeen = new Set(seen).add(id);
    const depths = step.needs.filter((n) => byId.has(n)).map((n) => depthOf(n, nextSeen));
    const depth = depths.length === 0 ? 0 : 1 + Math.max(...depths);
    depthCache.set(id, depth);
    return depth;
  }

  return steps
    .map((step, index) => ({ step, index, depth: depthOf(step.id, new Set()) }))
    .sort((a, b) => a.depth - b.depth);
}

function ErrorOrStaleHint({ stale, message }: Readonly<{ stale: boolean; message: string }>) {
  if (stale) {
    return (
      <div className="result-line result-line--warn">
        ⚠ Moteur trop ancien : redémarre l'application (méthode non reconnue par le sidecar).
      </div>
    );
  }
  return <div className="result-line result-line--error">Erreur de chargement : {message}</div>;
}

/* ================= Agents ================= */

interface AgentsSectionProps {
  cwd: string | null;
  hasProject: boolean;
  providers: ProviderConfig[];
  agents: AgentInfo[];
  loadState: LoadState;
  errorMessage: string;
  staleEngine: boolean;
  onReload: () => void;
}

function AgentCard({
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

function AgentErrorCard({ agent }: Readonly<{ agent: AgentInfo }>) {
  return (
    <article className="orch-card orch-card--error">
      <div className="orch-card__head">
        <span className="orch-card__name">{agent.name || "(agent invalide)"}</span>
      </div>
      <div className="result-line result-line--error">{agent.invalid}</div>
    </article>
  );
}

function AgentViewPanel({ agent, onClose }: Readonly<{ agent: AgentInfo; onClose: () => void }>) {
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

interface AgentEditorProps {
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

function AgentEditor({ mode, cwd, hasProject, providers, initial, initialRaw, onClose, onSaved }: Readonly<AgentEditorProps>) {
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

type AgentPanelState = { mode: "create" | "edit"; seed: AgentInfo | null; raw: string | null } | null;

function AgentsSection({
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

interface OrchestrationsSectionProps {
  cwd: string | null;
  hasProject: boolean;
  agentsForContext: AgentInfo[];
  orchestrations: OrchestrationInfo[];
  loadState: LoadState;
  errorMessage: string;
  staleEngine: boolean;
  onReload: () => void;
  /** `null` = lancement possible dans ce contexte ; sinon motif commun à toutes les cartes. */
  launchDisabledReason: string | null;
  onRequestLaunch: (orch: OrchestrationInfo) => void;
}

function OrchestrationCard({
  orch,
  launchDisabledReason,
  onLaunch,
  onEdit,
  onDuplicate,
  onDelete,
}: Readonly<{
  orch: OrchestrationInfo;
  /** `null` = lancement possible ; sinon motif affiché en info-bulle (bouton désactivé). */
  launchDisabledReason: string | null;
  onLaunch: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}>) {
  return (
    <article className="orch-card">
      <div className="orch-card__head">
        <span className="orch-card__name">{orch.name}</span>
        <span className={`orch-badge orch-badge--scope-${orch.scope}`}>{orch.scope === "global" ? "Global" : "Projet"}</span>
      </div>
      {orch.description && <p className="orch-card__desc">{orch.description}</p>}
      <span className="orch-chip">
        {orch.steps.length} étape{orch.steps.length > 1 ? "s" : ""}
      </span>
      <div className="actions">
        <button type="button" className="btn" onClick={onLaunch} disabled={!!launchDisabledReason} title={launchDisabledReason ?? undefined}>
          ▶ Lancer
        </button>
        <button type="button" className="btn btn--ghost" onClick={onEdit}>
          Éditer
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDuplicate}>
          Dupliquer
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDelete}>
          Supprimer
        </button>
      </div>
    </article>
  );
}

function OrchestrationErrorCard({ orch }: Readonly<{ orch: OrchestrationInfo }>) {
  return (
    <article className="orch-card orch-card--error">
      <div className="orch-card__head">
        <span className="orch-card__name">{orch.name || "(orchestration invalide)"}</span>
      </div>
      <div className="result-line result-line--error">{orch.invalid}</div>
    </article>
  );
}

/** Modale de lancement (§ « Orchestrations » de l'étude) : rappel du nom + un champ par entrée déclarée. */
function RunLaunchModal({
  orch,
  projectName,
  onClose,
  onLaunch,
}: Readonly<{
  orch: OrchestrationInfo;
  projectName: string;
  onClose: () => void;
  onLaunch: (values: Record<string, string>) => void;
}>) {
  const [values, setValues] = useState<Record<string, string>>(
    // Préremplissage avec la valeur par défaut de chaque input (champ `default`).
    Object.fromEntries(orch.inputs.map((i) => [i.name, i.default ?? ""])),
  );
  return (
    <Modal label={`Lancer ${orch.name}`} onClose={onClose}>
      <div className="orch-modal">
        <div className="orch-modal__head">
          <h3>Lancer « {orch.name} »</h3>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        <div className="orch-modal__body">
          <p className="empty-hint">Projet : {projectName}</p>
          {orch.inputs.map((inp) => (
            <div className="field" key={inp.name}>
              <label htmlFor={`run-input-${inp.name}`}>{inp.label || inp.name}</label>
              <input
                id={`run-input-${inp.name}`}
                value={values[inp.name] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [inp.name]: e.currentTarget.value }))}
              />
            </div>
          ))}
          {orch.inputs.length === 0 && <p className="empty-hint">Aucune entrée déclarée pour cette orchestration.</p>}
        </div>
        <div className="actions orch-modal__actions">
          <button type="button" className="btn" onClick={() => onLaunch(values)}>
            ▶ Lancer
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Annuler
          </button>
        </div>
      </div>
    </Modal>
  );
}

const DEFAULT_LIMITS: OrchestrationLimits = { maxParallel: 2, maxDurationMin: 30 };

interface OrchestrationEditorProps {
  mode: "create" | "edit";
  cwd: string | null;
  hasProject: boolean;
  agentsForContext: AgentInfo[];
  initial: OrchestrationInfo | null;
  initialRaw: string | null;
  onClose: () => void;
  onSaved: () => void;
}

function OrchestrationEditor({
  mode,
  cwd,
  hasProject,
  agentsForContext,
  initial,
  initialRaw,
  onClose,
  onSaved,
}: Readonly<OrchestrationEditorProps>) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [scope, setScope] = useState<OrchestrationScope>(initial?.scope ?? (hasProject ? "project" : "global"));
  const [inputs, setInputs] = useState<OrchestrationInputField[]>(initial?.inputs ?? []);
  const [steps, setSteps] = useState<OrchestrationStep[]>(initial?.steps ?? []);
  const [maxParallel, setMaxParallel] = useState(String(initial?.limits.maxParallel ?? DEFAULT_LIMITS.maxParallel));
  const [maxDurationMin, setMaxDurationMin] = useState(
    String(initial?.limits.maxDurationMin ?? DEFAULT_LIMITS.maxDurationMin),
  );

  const [activeTab, setActiveTab] = useState<"form" | "yaml">("form");
  const [yamlText, setYamlText] = useState(initialRaw ?? "");
  const [yamlTouched, setYamlTouched] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const validAgents = useMemo(() => agentsForContext.filter((a) => !a.invalid), [agentsForContext]);

  function buildInput(): OrchestrationWriteInput {
    return {
      name: name.trim(),
      description: description.trim(),
      inputs: inputs
        .filter((i) => i.name.trim())
        .map((i) => ({ name: i.name.trim(), label: i.label.trim(), default: i.default })),
      steps: steps.filter((s) => s.id.trim()).map((s) => ({ id: s.id.trim(), agent: s.agent, task: s.task, needs: s.needs })),
      limits: {
        maxParallel: Number(maxParallel) || DEFAULT_LIMITS.maxParallel,
        maxDurationMin: Number(maxDurationMin) || DEFAULT_LIMITS.maxDurationMin,
      },
    };
  }

  useEffect(() => {
    if (activeTab === "yaml" && !yamlTouched) {
      setYamlText(orchestrationYamlPreview(buildInput()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  function addInput() {
    setInputs((prev) => [...prev, { name: "", label: "", default: null }]);
  }
  function updateInput(i: number, patch: Partial<OrchestrationInputField>) {
    setInputs((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function removeInput(i: number) {
    setInputs((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addStep() {
    setSteps((prev) => [...prev, { id: "", agent: "", task: "", needs: [] }]);
  }
  function updateStep(i: number, patch: Partial<OrchestrationStep>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function removeStep(i: number) {
    setSteps((prev) => {
      const removedId = prev[i]?.id;
      return prev.filter((_, idx) => idx !== i).map((s) => (removedId ? { ...s, needs: s.needs.filter((n) => n !== removedId) } : s));
    });
  }
  function toggleStepNeed(i: number, needId: string) {
    setSteps((prev) =>
      prev.map((s, idx) => {
        if (idx !== i) return s;
        const has = s.needs.includes(needId);
        return { ...s, needs: has ? s.needs.filter((n) => n !== needId) : [...s.needs, needId] };
      }),
    );
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      if (activeTab === "yaml") {
        await orchWrite(cwd, scope, { raw: yamlText });
      } else {
        const input = buildInput();
        if (!input.name) {
          setError("Le nom est obligatoire.");
          return;
        }
        await orchWrite(cwd, scope, { orchestration: input });
      }
      onSaved();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const dagOrder = computeDagOrder(steps);

  return (
    <Modal
      label={mode === "edit" ? `Éditer l'orchestration ${initial?.name ?? ""}` : "Nouvelle orchestration"}
      onClose={onClose}
    >
      <div className="orch-modal">
        <div className="orch-modal__head">
          <h3>{mode === "edit" ? `Éditer « ${initial?.name} »` : "Nouvelle orchestration"}</h3>
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
              <label htmlFor="or-name">Nom</label>
              <input
                id="or-name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                disabled={mode === "edit"}
                placeholder="ex. revue-complete"
              />
            </div>
            <div className="field">
              <label htmlFor="or-desc">Description</label>
              <input
                id="or-desc"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder="Ce que fait l'orchestration en une phrase"
              />
            </div>
            <div className="field">
              <label htmlFor="or-scope">Portée</label>
              <select
                id="or-scope"
                value={scope}
                disabled={mode === "edit"}
                onChange={(e) => setScope(e.currentTarget.value as OrchestrationScope)}
              >
                {hasProject && <option value="project">Projet</option>}
                <option value="global">Global</option>
              </select>
            </div>

            <div className="field">
              <label>Entrées (variables demandées au lancement)</label>
              <div className="orch-rows">
                {inputs.map((inp, i) => (
                  <div className="orch-row" key={i}>
                    <input
                      value={inp.name}
                      onChange={(e) => updateInput(i, { name: e.currentTarget.value })}
                      placeholder="nom (ex. cible)"
                    />
                    <input
                      value={inp.label}
                      onChange={(e) => updateInput(i, { label: e.currentTarget.value })}
                      placeholder="libellé affiché"
                    />
                    <input
                      value={inp.default ?? ""}
                      onChange={(e) => updateInput(i, { default: e.currentTarget.value })}
                      placeholder="défaut (vide = requis, sauf si déjà posé en YAML)"
                      title="Valeur utilisée si l'input n'est pas fourni au lancement (tâches planifiées). Sans défaut, l'input est requis."
                    />
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => removeInput(i)}
                      aria-label="Supprimer cette entrée"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="btn btn--ghost" onClick={addInput}>
                + Ajouter une entrée
              </button>
            </div>

            <div className="field">
              <label>Étapes</label>
              <div className="orch-rows orch-rows--steps">
                {steps.map((step, i) => (
                  <div className="orch-step-row" key={i}>
                    <div className="orch-step-row__line">
                      <input
                        value={step.id}
                        onChange={(e) => updateStep(i, { id: e.currentTarget.value })}
                        placeholder="id (ex. relecture-rust)"
                      />
                      <select value={step.agent} onChange={(e) => updateStep(i, { agent: e.currentTarget.value })}>
                        <option value="">— agent —</option>
                        {validAgents.map((a) => (
                          <option key={a.name} value={a.name}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => removeStep(i)}
                        aria-label="Supprimer cette étape"
                      >
                        ×
                      </button>
                    </div>
                    <textarea
                      rows={2}
                      value={step.task}
                      onChange={(e) => updateStep(i, { task: e.currentTarget.value })}
                      placeholder="Tâche — {{input}} et {{steps.<id>.output}} disponibles"
                    />
                    {steps.length > 1 && (
                      <div className="orch-step-row__needs">
                        <span className="empty-hint">Dépend de :</span>
                        {steps.map((other, j) =>
                          j === i ? null : (
                            <label key={other.id || `idx-${j}`} className="field--checkbox orch-need-checkbox">
                              <input
                                type="checkbox"
                                checked={step.needs.includes(other.id)}
                                disabled={!other.id}
                                onChange={() => toggleStepNeed(i, other.id)}
                              />
                              <span>{other.id || `(étape ${j + 1} sans id)`}</span>
                            </label>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <button type="button" className="btn btn--ghost" onClick={addStep}>
                + Ajouter une étape
              </button>
              {validAgents.length === 0 && (
                <p className="empty-hint">Aucun agent disponible dans ce contexte — déclarez-en un dans l'onglet Agents.</p>
              )}
            </div>

            {steps.length > 0 && (
              <div className="field">
                <label>Aperçu du DAG</label>
                <ol className="orch-dag">
                  {dagOrder.map(({ step, index, depth }) => (
                    <li key={index} style={{ marginLeft: `${depth * 18}px` }}>
                      <span className="orch-dag__id">{step.id || "(id manquant)"}</span>
                      {step.agent && <span className="orch-dag__agent"> · {step.agent}</span>}
                      {step.needs.length > 0 && <span className="orch-dag__needs"> (après {step.needs.join(", ")})</span>}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <div className="field field--inline">
              <label htmlFor="or-maxparallel">Étapes simultanées max.</label>
              <input
                id="or-maxparallel"
                type="number"
                min={1}
                value={maxParallel}
                onChange={(e) => setMaxParallel(e.currentTarget.value)}
              />
            </div>
            <div className="field field--inline">
              <label htmlFor="or-maxduration">Durée max. (min)</label>
              <input
                id="or-maxduration"
                type="number"
                min={1}
                value={maxDurationMin}
                onChange={(e) => setMaxDurationMin(e.currentTarget.value)}
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
                  setYamlText(orchestrationYamlPreview(buildInput()));
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

type OrchestrationPanelState = { mode: "create" | "edit"; seed: OrchestrationInfo | null; raw: string | null } | null;

function OrchestrationsSection({
  cwd,
  hasProject,
  agentsForContext,
  orchestrations,
  loadState,
  errorMessage,
  staleEngine,
  onReload,
  launchDisabledReason,
  onRequestLaunch,
}: Readonly<OrchestrationsSectionProps>) {
  const [panel, setPanel] = useState<OrchestrationPanelState>(null);
  const [actionError, setActionError] = useState("");
  const [readingPath, setReadingPath] = useState<string | null>(null);

  async function openEdit(orch: OrchestrationInfo) {
    setActionError("");
    setReadingPath(orch.path);
    try {
      const { orchestration: fresh, raw } = await orchRead(orch.path, cwd);
      setPanel({ mode: "edit", seed: fresh, raw });
    } catch (err) {
      setActionError(toMessage(err));
    } finally {
      setReadingPath(null);
    }
  }

  function openDuplicate(orch: OrchestrationInfo) {
    setPanel({ mode: "create", seed: { ...orch, name: `${orch.name}-copie` }, raw: null });
  }

  function openCreate() {
    setPanel({ mode: "create", seed: null, raw: null });
  }

  async function handleDelete(orch: OrchestrationInfo) {
    if (!window.confirm(`Supprimer l'orchestration « ${orch.name} » ?`)) return;
    setActionError("");
    try {
      await orchDelete(cwd, orch.path);
      onReload();
    } catch (err) {
      setActionError(toMessage(err));
    }
  }

  return (
    <section className="config-section">
      <div className="orch-toolbar">
        <p className="empty-hint">Enchaînements d'agents déclarés dans ce contexte (DAG par dépendances).</p>
        <button type="button" className="btn" onClick={openCreate}>
          + Nouvelle orchestration
        </button>
      </div>

      {loadState === "loading" && <p className="empty-hint">Chargement…</p>}
      {loadState === "error" && <ErrorOrStaleHint stale={staleEngine} message={errorMessage} />}
      {actionError && <div className="result-line result-line--error">Erreur : {actionError}</div>}

      <div className="orch-card-grid">
        {orchestrations.map((orch) =>
          orch.invalid ? (
            <OrchestrationErrorCard key={orch.path || orch.name} orch={orch} />
          ) : (
            <OrchestrationCard
              key={orch.path || orch.name}
              orch={orch}
              launchDisabledReason={launchDisabledReason}
              onLaunch={() => onRequestLaunch(orch)}
              onEdit={() => void openEdit(orch)}
              onDuplicate={() => openDuplicate(orch)}
              onDelete={() => void handleDelete(orch)}
            />
          ),
        )}
        {orchestrations.length === 0 && loadState === "ready" && (
          <p className="empty-hint">Aucune orchestration déclarée dans ce contexte.</p>
        )}
      </div>

      {readingPath && <p className="empty-hint">Chargement de « {readingPath} »…</p>}

      {panel && (
        <OrchestrationEditor
          mode={panel.mode}
          cwd={cwd}
          hasProject={hasProject}
          agentsForContext={agentsForContext}
          initial={panel.seed}
          initialRaw={panel.raw}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            onReload();
          }}
        />
      )}
    </section>
  );
}

/* ================= Tâches (T1, docs/etude-taches.md § 3.3 ; timers T2, docs/protocol.md § T2) ================= */

/** `ms` epoch → date/heure locale lisible, `—` si absent (pas de timer, ou systemd ne fournit rien). */
function formatMsOrDash(ms: number | null): string {
  return ms === null ? "—" : formatReportDate(ms);
}

/** Manifeste armé mais timer absent/éteint côté systemd — incohérence à signaler (badge « à synchroniser »). */
function timerNeedsSync(tache: TacheInfo, timer: TacheTimerStatus | null): boolean {
  if (!timer) return false;
  return tache.enabled && (!timer.exists || !timer.active);
}

/** Libellé moteur/modèle d'un agent pour l'affichage LLM d'une tâche — modèle `null` ⇒ moteur seul (pas de « défaut »/« — »). */
function tacheStepLlmLabel(agent: Pick<AgentInfo, "engine" | "provider" | "model">, providers: ProviderConfig[]): string {
  if (agent.engine === "claude") return agent.model ? `claude · ${agent.model}` : "claude";
  // R2 — moteur/modèle choisis par le routeur au lancement du run.
  if (agent.engine === "auto") return "auto (routeur)";
  const label = providers.find((p) => p.id === agent.provider)?.label ?? agent.provider ?? "neutre";
  return agent.model ? `${label} · ${agent.model}` : label;
}

type TacheOrchestrationSteps = { status: LoadState; steps: OrchestrationStep[] | null; agents: AgentInfo[] };

/**
 * Charge l'orchestration de la tâche (`orch.list` filtré par nom) et ses agents (`agents.list`), `cwd` = dossier
 * de la tâche — voir mission LLM visibles. `steps: null` = orchestration introuvable (best effort : jamais
 * d'erreur bloquante, juste un statut `error`/liste vide exploité par l'appelant pour rester discret).
 */
function useTacheOrchestrationSteps(path: string, orchestrationName: string): TacheOrchestrationSteps {
  const [state, setState] = useState<TacheOrchestrationSteps>({ status: "loading", steps: null, agents: [] });
  useEffect(() => {
    let cancelled = false;
    if (!orchestrationName || !path) {
      setState({ status: "ready", steps: null, agents: [] });
      return;
    }
    setState({ status: "loading", steps: null, agents: [] });
    Promise.all([orchList(path), agentsList(path)])
      .then(([orchs, agents]) => {
        if (cancelled) return;
        const orch = orchs.find((o) => o.name === orchestrationName);
        setState({ status: "ready", steps: orch ? orch.steps : null, agents });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error", steps: null, agents: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [path, orchestrationName]);
  return state;
}

type TacheLlmEntry =
  | { kind: "step"; stepId: string; agentName: string; label: string }
  | { kind: "unknown"; name: string };

/** `steps: null` (orchestration introuvable) ⇒ une seule entrée « inconnue » portant le nom de l'orchestration. */
function buildTacheLlmEntries(
  steps: OrchestrationStep[] | null,
  agents: AgentInfo[],
  orchestrationName: string,
  providers: ProviderConfig[],
): TacheLlmEntry[] {
  if (steps === null) return orchestrationName ? [{ kind: "unknown", name: orchestrationName }] : [];
  return steps.map((step) => {
    const agent = agents.find((a) => a.name === step.agent);
    if (!agent) return { kind: "unknown", name: step.agent };
    return { kind: "step", stepId: step.id, agentName: step.agent, label: tacheStepLlmLabel(agent, providers) };
  });
}

/** LLM utilisés par une tâche : résumé compact (une ligne, carte) ou détaillé (liste par étape, fiche). */
function TacheLlmSummary({
  tache,
  providers,
  compact,
}: Readonly<{ tache: TacheInfo; providers: ProviderConfig[]; compact: boolean }>) {
  // Résolution au même endroit que le run : le projet déclaré par la tâche
  // (champ cwd), sinon le dossier de la tâche (orchestrations globales).
  const { status, steps, agents } = useTacheOrchestrationSteps(tache.cwd ?? tache.path, tache.orchestration);
  if (tache.invalid || !tache.orchestration || status !== "ready") return null;
  const entries = buildTacheLlmEntries(steps, agents, tache.orchestration, providers);
  if (entries.length === 0) return null;
  if (compact) {
    const labels = Array.from(
      new Set(entries.map((e) => (e.kind === "step" ? e.label : `agent inconnu : ${e.name}`))),
    );
    return <p className="orch-tache-llm-compact">{labels.join(", ")}</p>;
  }
  return (
    <ul className="orch-tache-llm-list">
      {entries.map((e) => (
        <li
          key={e.kind === "step" ? e.stepId : e.name}
          className={e.kind === "unknown" ? "orch-tache-llm-list__item orch-tache-llm-list__item--unknown" : "orch-tache-llm-list__item"}
        >
          {e.kind === "step" ? `${e.agentName} — ${e.label}` : `agent inconnu : ${e.name}`}
        </li>
      ))}
    </ul>
  );
}

function TacheCard({
  tache,
  timer,
  providers,
  lastReport,
  busy,
  toggling,
  cardError,
  launchDisabledReason,
  onLaunch,
  onOpenReports,
  onEdit,
  onDelete,
  onToggleEnabled,
  onSyncTimer,
}: Readonly<{
  tache: TacheInfo;
  /** Statut du timer systemd (T2) — `null` tant que non chargé (sous-onglet pas encore ouvert, ou erreur best-effort). */
  timer: TacheTimerStatus | null;
  providers: ProviderConfig[];
  lastReport: TacheReportInfo | null;
  busy: boolean;
  /** Bascule Armée/Désarmée en cours pour CETTE carte. */
  toggling: boolean;
  /** Erreur de bascule/synchronisation à afficher sur la carte (vide = aucune). */
  cardError: string;
  /** `null` = lancement possible ; sinon motif affiché en info-bulle (bouton désactivé). */
  launchDisabledReason: string | null;
  onLaunch: () => void;
  onOpenReports: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onSyncTimer: () => void;
}>) {
  const reason = tache.invalid ? "Manifeste invalide — voir le message ci-dessous." : launchDisabledReason;
  const needsSync = timerNeedsSync(tache, timer);
  return (
    <article className="orch-card">
      <div className="orch-card__head">
        <span className="orch-card__name">{tache.name}</span>
        <div className="orch-card__badges">
          <button
            type="button"
            className={`orch-badge orch-badge--toggle ${tache.enabled ? "orch-badge--enabled" : "orch-badge--disabled"}`}
            onClick={onToggleEnabled}
            disabled={!!tache.invalid || toggling}
            title={tache.enabled ? "Désarmer (désactive le timer systemd)" : "Armer (active le timer systemd)"}
          >
            {toggling ? "…" : tache.enabled ? "Armée" : "Désarmée"}
          </button>
          {/* Lecture seule : l'édition du lieu d'exécution est la tranche D3.
              Affiché seulement pour `serveur` — `local` est le défaut, le
              signaler ferait du bruit sur toutes les cartes. */}
          {tache.lieu === "serveur" && (
            <span className="orch-badge" title="Exécutée par le conteneur ia-runner (pas par le timer systemd local)">
              serveur
            </span>
          )}
          {tache.invalid && <span className="orch-badge orch-badge--invalid">Invalide</span>}
        </div>
      </div>
      {tache.description && <p className="orch-card__desc">{tache.description}</p>}
      {tache.invalid && <div className="result-line result-line--error">{tache.invalid}</div>}
      {cardError && <div className="result-line result-line--error">{cardError}</div>}
      {tache.schedule && <span className="orch-chip">{tache.schedule}</span>}
      {tache.schedule && (
        <p className="orch-tache-timer-info">
          Prochain run : {formatMsOrDash(timer?.nextMs ?? null)} · Dernier run : {formatMsOrDash(timer?.lastMs ?? null)}
        </p>
      )}
      {needsSync && (
        <div className="orch-tache-sync">
          <span className="orch-badge orch-badge--sync" title="Le timer systemd n'est pas synchronisé avec le manifeste">
            à synchroniser
          </span>
          <button type="button" className="btn btn--ghost" onClick={onSyncTimer} disabled={toggling}>
            ↻ Synchroniser
          </button>
        </div>
      )}
      <TacheLlmSummary tache={tache} providers={providers} compact />
      <p className="empty-hint">
        {lastReport ? `Dernier rapport : ${formatReportDate(lastReport.mtimeMs)}` : "Aucun rapport pour l'instant."}
      </p>
      <div className="actions">
        <button type="button" className="btn" onClick={onLaunch} disabled={!!reason} title={reason ?? undefined}>
          ▶ Lancer maintenant
        </button>
        <button type="button" className="btn btn--ghost" onClick={onOpenReports} disabled={busy}>
          Rapports
        </button>
        <button type="button" className="btn btn--ghost" onClick={onEdit} disabled={busy}>
          {busy ? "Chargement…" : "Éditer"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDelete}>
          Supprimer
        </button>
      </div>
    </article>
  );
}

/** Liste des rapports d'une tâche + rendu Markdown du rapport sélectionné (onglet « Rapports » de la fiche). */
function TacheReportsTab({ name }: Readonly<{ name: string }>) {
  const [reports, setReports] = useState<TacheReportInfo[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState("");

  useEffect(() => {
    setLoadState("loading");
    tachesReports(name)
      .then((list) => {
        setReports(list);
        setLoadState("ready");
      })
      .catch((err: unknown) => {
        setErrorMessage(toMessage(err));
        setLoadState("error");
      });
  }, [name]);

  async function openReport(file: string) {
    setSelected(file);
    setContent(null);
    setContentError("");
    setContentLoading(true);
    try {
      const text = await tachesReportRead(name, file);
      setContent(text);
    } catch (err) {
      setContentError(toMessage(err));
    } finally {
      setContentLoading(false);
    }
  }

  return (
    <div className="orch-tache-reports">
      <div className="orch-tache-reports__list">
        {loadState === "loading" && <p className="empty-hint">Chargement…</p>}
        {loadState === "error" && <div className="result-line result-line--error">Erreur : {errorMessage}</div>}
        {loadState === "ready" && reports.length === 0 && <p className="empty-hint">Aucun rapport pour l'instant.</p>}
        <ul className="orch-tache-report-list">
          {reports.map((r) => (
            <li key={r.file}>
              <button
                type="button"
                className={`orch-tache-report-item${selected === r.file ? " orch-tache-report-item--selected" : ""}`}
                onClick={() => void openReport(r.file)}
              >
                <span className="orch-tache-report-item__file">{r.file}</span>
                <span className="orch-tache-report-item__meta">{formatReportDate(r.mtimeMs)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="orch-tache-reports__content">
        {!selected && <p className="empty-hint">Sélectionnez un rapport pour l'afficher.</p>}
        {selected && contentLoading && <p className="empty-hint">Chargement…</p>}
        {selected && contentError && <div className="result-line result-line--error">Erreur : {contentError}</div>}
        {selected && content !== null && <Markdown content={content} />}
      </div>
    </div>
  );
}

interface TacheEditorProps {
  mode: "create" | "edit";
  /** Édition : tâche chargée via taches.read. Création : `null` (vierge). */
  initial: TacheInfo | null;
  /** Texte YAML chargé via taches.read (édition uniquement) — sinon régénéré depuis le formulaire. */
  initialRaw: string | null;
  providers: ProviderConfig[];
  /** Onglet ouvert à l'affichage — « Rapports » pour l'accès direct depuis la carte, sinon « Formulaire ». */
  initialTab?: "form" | "yaml" | "reports";
  /** Rafraîchit le statut du timer (T2) des noms donnés — appelé après synchronisation post-sauvegarde. */
  onRefreshTimers: (names?: string[]) => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}

function TacheEditor({
  mode,
  initial,
  initialRaw,
  providers,
  initialTab,
  onRefreshTimers,
  onClose,
  onSaved,
}: Readonly<TacheEditorProps>) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [orchestration, setOrchestration] = useState(initial?.orchestration ?? "");
  const [schedule, setSchedule] = useState(initial?.schedule ?? "");
  const [inputRows, setInputRows] = useState<{ key: string; value: string }[]>(
    Object.entries(initial?.inputs ?? {}).map(([key, value]) => ({ key, value })),
  );
  const [report, setReport] = useState(initial?.report ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [cwd, setCwd] = useState(initial?.cwd ?? "");
  // Lieu d'exécution : NON éditable ici (tranche D3), mais porté par l'état du
  // formulaire pour survivre à l'aller-retour — `taches.write {tache}`
  // ré-sérialise le manifeste depuis ce seul objet, donc tout champ non
  // restitué serait effacé sans un mot (voir TacheLieu dans tachesClient.ts).
  const [lieu] = useState<TacheLieu>(initial?.lieu ?? "local");

  const [activeTab, setActiveTab] = useState<"form" | "yaml" | "reports">(initialTab ?? "form");
  const [yamlText, setYamlText] = useState(initialRaw ?? "");
  const [yamlTouched, setYamlTouched] = useState(false);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function buildInput(): TacheWriteInput {
    const inputs: Record<string, string> = {};
    for (const row of inputRows) {
      const key = row.key.trim();
      if (key) inputs[key] = row.value;
    }
    return {
      name: name.trim(),
      description: description.trim(),
      orchestration: orchestration.trim(),
      schedule: schedule.trim() ? schedule.trim() : null,
      inputs,
      report: report.trim() ? report.trim() : null,
      enabled,
      cwd: cwd.trim() ? cwd.trim() : null,
      lieu,
    };
  }

  // Onglet YAML régénéré depuis le formulaire tant que l'utilisateur n'y a
  // pas touché — même patron que AgentEditor/OrchestrationEditor.
  useEffect(() => {
    if (activeTab === "yaml" && !yamlTouched) {
      setYamlText(tacheYamlPreview(buildInput()));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  function addInputRow() {
    setInputRows((prev) => [...prev, { key: "", value: "" }]);
  }
  function updateInputRow(i: number, patch: Partial<{ key: string; value: string }>) {
    setInputRows((prev) => prev.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function removeInputRow(i: number) {
    setInputRows((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      let result: TacheWriteResult;
      if (activeTab === "yaml") {
        result = await tachesWrite({ raw: yamlText, name: name.trim() });
      } else {
        const input = buildInput();
        if (!input.name) {
          setError("Le nom est obligatoire.");
          return;
        }
        if (!input.orchestration) {
          setError("L'orchestration est obligatoire.");
          return;
        }
        result = await tachesWrite({ tache: input });
      }
      // Synchronisation timer (T2) : un manifeste avec cadence doit toujours avoir un timer à jour après
      // sauvegarde. Best effort — un échec ici ne fait pas échouer la sauvegarde déjà actée ; l'incohérence
      // (manifeste armé, timer absent/éteint) ressort via le badge « à synchroniser » de la carte.
      if (result.tache.schedule) {
        try {
          await tachesTimerApply(result.tache.name);
        } catch {
          // best effort, voir commentaire ci-dessus
        }
        await onRefreshTimers([result.tache.name]);
      }
      onSaved();
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal label={mode === "edit" ? `Éditer la tâche ${initial?.name ?? ""}` : "Nouvelle tâche"} onClose={onClose}>
      <div className="orch-modal">
        <div className="orch-modal__head">
          <h3>{mode === "edit" ? `Éditer « ${initial?.name} »` : "Nouvelle tâche"}</h3>
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
          {mode === "edit" && (
            <button
              type="button"
              className={`orch-tab${activeTab === "reports" ? " orch-tab--active" : ""}`}
              onClick={() => setActiveTab("reports")}
            >
              Rapports
            </button>
          )}
        </div>

        {activeTab === "form" && (
          <div className="orch-modal__body">
            <div className="field">
              <label htmlFor="ta-name">Nom</label>
              <input
                id="ta-name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                disabled={mode === "edit"}
                placeholder="ex. veille"
              />
            </div>
            <div className="field">
              <label htmlFor="ta-desc">Description</label>
              <input
                id="ta-desc"
                value={description}
                onChange={(e) => setDescription(e.currentTarget.value)}
                placeholder="Ce que fait la tâche en une phrase"
              />
            </div>
            <div className="field">
              <label htmlFor="ta-orch">Orchestration</label>
              <input
                id="ta-orch"
                value={orchestration}
                onChange={(e) => setOrchestration(e.currentTarget.value)}
                placeholder="nom de l'orchestration (.iaction/orchestrations/<nom>.yaml du dossier de la tâche)"
              />
            </div>
            {mode === "edit" && initial && !initial.invalid && initial.orchestration && (
              <div className="field">
                <label>LLM utilisés</label>
                <TacheLlmSummary tache={initial} providers={providers} compact={false} />
              </div>
            )}
            <div className="field">
              <label htmlFor="ta-schedule">Cadence</label>
              <input
                id="ta-schedule"
                value={schedule}
                onChange={(e) => setSchedule(e.currentTarget.value)}
                placeholder='ex. "*-*-* 08:15" (syntaxe OnCalendar systemd)'
              />
            </div>
            <div className="field">
              <label>{"Entrées (gabarits d'inputs — {{today}} résolu au lancement)"}</label>
              <div className="orch-rows">
                {inputRows.map((row, i) => (
                  <div className="orch-row" key={i}>
                    <input
                      value={row.key}
                      onChange={(e) => updateInputRow(i, { key: e.currentTarget.value })}
                      placeholder="clef (ex. date)"
                    />
                    <input
                      value={row.value}
                      onChange={(e) => updateInputRow(i, { value: e.currentTarget.value })}
                      placeholder="gabarit (ex. {{today}})"
                    />
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => removeInputRow(i)}
                      aria-label="Supprimer cette entrée"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="btn btn--ghost" onClick={addInputRow}>
                + Ajouter une entrée
              </button>
            </div>
            <div className="field">
              <label htmlFor="ta-report">{"Rapport (chemin relatif au dossier, {{today}} résolu au lancement)"}</label>
              <input
                id="ta-report"
                value={report}
                onChange={(e) => setReport(e.currentTarget.value)}
                placeholder="rapports/{{today}}.md"
              />
            </div>
            <div className="field">
              <label htmlFor="ta-cwd">
                Projet (chemin absolu — l'orchestration est cherchée dans son .iaction/orchestrations/ ; vide = orchestrations globales)
              </label>
              <input
                id="ta-cwd"
                value={cwd}
                onChange={(e) => setCwd(e.currentTarget.value)}
                placeholder="/home/moi/mon-projet"
              />
            </div>
            <label className="field field--checkbox" htmlFor="ta-enabled">
              <input id="ta-enabled" type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
              <span>Armée (timer actif)</span>
            </label>
          </div>
        )}

        {activeTab === "yaml" && (
          <div className="orch-modal__body">
            <div className="actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setYamlText(tacheYamlPreview(buildInput()));
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

        {activeTab === "reports" && mode === "edit" && initial && (
          <div className="orch-modal__body">
            <TacheReportsTab name={initial.name} />
          </div>
        )}

        {error && <div className="result-line result-line--error">Erreur : {error}</div>}
        <div className="actions orch-modal__actions">
          {activeTab === "reports" ? (
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Fermer
            </button>
          ) : (
            <>
              <button type="button" className="btn" disabled={saving} onClick={() => void handleSave()}>
                {saving ? "Enregistrement…" : "Enregistrer"}
              </button>
              <button type="button" className="btn btn--ghost" onClick={onClose} disabled={saving}>
                Annuler
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

type TachePanelState = {
  mode: "create" | "edit";
  seed: TacheInfo | null;
  raw: string | null;
  initialTab?: "form" | "yaml" | "reports";
} | null;

interface TachesSectionProps {
  taches: TacheInfo[];
  tacheReports: Record<string, TacheReportInfo[]>;
  /** Statuts des timers systemd (T2), par nom de tâche — absent tant que non chargé. */
  tacheTimers: Record<string, TacheTimerStatus>;
  providers: ProviderConfig[];
  loadState: LoadState;
  errorMessage: string;
  staleEngine: boolean;
  onReload: () => void;
  onRefreshTimers: (names?: string[]) => Promise<void>;
  /** `null` = lancement possible ; sinon motif commun à toutes les cartes (ex. run déjà en cours). */
  launchDisabledReason: string | null;
  onLaunch: (tache: TacheInfo) => void;
}

function TachesSection({
  taches,
  tacheReports,
  tacheTimers,
  providers,
  loadState,
  errorMessage,
  staleEngine,
  onReload,
  onRefreshTimers,
  launchDisabledReason,
  onLaunch,
}: Readonly<TachesSectionProps>) {
  const [panel, setPanel] = useState<TachePanelState>(null);
  const [actionError, setActionError] = useState("");
  const [readingName, setReadingName] = useState<string | null>(null);
  const [togglingName, setTogglingName] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  async function openEdit(tache: TacheInfo, initialTab?: "form" | "yaml" | "reports") {
    setActionError("");
    setReadingName(tache.name);
    try {
      const { tache: fresh, raw } = await tachesRead(tache.name);
      setPanel({ mode: "edit", seed: fresh, raw, initialTab });
    } catch (err) {
      setActionError(toMessage(err));
    } finally {
      setReadingName(null);
    }
  }

  function openCreate() {
    setPanel({ mode: "create", seed: null, raw: null });
  }

  async function handleDelete(tache: TacheInfo) {
    if (
      !window.confirm(
        `Supprimer le manifeste de la tâche « ${tache.name} » ? Son timer systemd est désarmé et supprimé. Le dossier, ses agents/orchestrations et ses rapports sont conservés — seul tache.yaml est supprimé.`,
      )
    )
      return;
    setActionError("");
    try {
      // Convention du contrat (docs/protocol.md § T2) : le timer est retiré AVANT le manifeste — jamais de
      // timer orphelin continuant à tirer une tâche dé-déclarée.
      await tachesTimerRemove(tache.name);
      await tachesDelete(tache.name);
      onReload();
    } catch (err) {
      setActionError(toMessage(err));
    }
  }

  async function handleToggleEnabled(tache: TacheInfo) {
    if (tache.invalid || togglingName) return;
    setCardErrors((prev) => ({ ...prev, [tache.name]: "" }));
    setTogglingName(tache.name);
    try {
      const input: TacheWriteInput = {
        name: tache.name,
        description: tache.description,
        orchestration: tache.orchestration,
        schedule: tache.schedule,
        inputs: tache.inputs,
        report: tache.report,
        enabled: !tache.enabled,
        cwd: tache.cwd,
        // Recopié tel quel : armer/désarmer ne déplace pas la tâche (une tâche
        // serveur reste serveur), et l'omettre la ramènerait en `local`.
        lieu: tache.lieu,
      };
      await tachesWrite({ tache: input });
      await tachesTimerApply(tache.name);
      await onRefreshTimers([tache.name]);
      onReload();
    } catch (err) {
      // État non basculé visuellement : pas d'onReload() ici, la carte garde l'état affiché avant la bascule.
      setCardErrors((prev) => ({ ...prev, [tache.name]: toMessage(err) }));
    } finally {
      setTogglingName(null);
    }
  }

  async function handleSyncTimer(tache: TacheInfo) {
    setCardErrors((prev) => ({ ...prev, [tache.name]: "" }));
    setTogglingName(tache.name);
    try {
      await tachesTimerApply(tache.name);
      await onRefreshTimers([tache.name]);
    } catch (err) {
      setCardErrors((prev) => ({ ...prev, [tache.name]: toMessage(err) }));
    } finally {
      setTogglingName(null);
    }
  }

  return (
    <section className="config-section">
      <div className="orch-toolbar">
        <p className="empty-hint">
          Agents récurrents déclarés (voir docs/etude-taches.md) — cadence déclarative, pilotée par un timer systemd en T2.
        </p>
        <button type="button" className="btn" onClick={openCreate}>
          + Nouvelle tâche
        </button>
      </div>

      {loadState === "loading" && <p className="empty-hint">Chargement…</p>}
      {loadState === "error" && <ErrorOrStaleHint stale={staleEngine} message={errorMessage} />}
      {actionError && <div className="result-line result-line--error">Erreur : {actionError}</div>}

      <div className="orch-card-grid">
        {taches.map((tache) => (
          <TacheCard
            key={tache.path || tache.name}
            tache={tache}
            timer={tacheTimers[tache.name] ?? null}
            providers={providers}
            lastReport={tacheReports[tache.name]?.[0] ?? null}
            busy={readingName === tache.name}
            toggling={togglingName === tache.name}
            cardError={cardErrors[tache.name] ?? ""}
            launchDisabledReason={launchDisabledReason ?? (tache.orchestration ? null : "Orchestration manquante dans le manifeste.")}
            onLaunch={() => onLaunch(tache)}
            onOpenReports={() => void openEdit(tache, "reports")}
            onEdit={() => void openEdit(tache)}
            onDelete={() => void handleDelete(tache)}
            onToggleEnabled={() => void handleToggleEnabled(tache)}
            onSyncTimer={() => void handleSyncTimer(tache)}
          />
        ))}
        {taches.length === 0 && loadState === "ready" && <p className="empty-hint">Aucune tâche déclarée.</p>}
      </div>

      {panel && (
        <TacheEditor
          mode={panel.mode}
          initial={panel.seed}
          initialRaw={panel.raw}
          providers={providers}
          initialTab={panel.initialTab}
          onRefreshTimers={onRefreshTimers}
          onClose={() => setPanel(null)}
          onSaved={() => {
            setPanel(null);
            onReload();
          }}
        />
      )}
    </section>
  );
}

/* ================= Exécutions (phase O3) ================= */

/**
 * Statut d'une étape au fil d'un run — union UI, plus fine que
 * `OrchRunDoneStep.status` (chaîne libre côté protocole, validée ici via
 * `toStepRunStatus`). `pending`/`running` n'existent qu'en cours de run ;
 * une fois le run terminé, toute étape encore à l'un de ces deux états est
 * retombée sur `aborted` par `finalizeRun`.
 */
type OrchStepRunStatus = "pending" | "running" | "success" | "failed" | "skipped" | "aborted";

const STEP_RUN_STATUSES = new Set<string>(["pending", "running", "success", "failed", "skipped", "aborted"]);

function toStepRunStatus(value: string): OrchStepRunStatus {
  return (STEP_RUN_STATUSES.has(value) ? value : "failed") as OrchStepRunStatus;
}

/** Métadonnées d'une étape — SEUL ce qui est persisté (jamais le texte, voir l'étude § 4.3). */
interface RunStepMeta {
  status: OrchStepRunStatus;
}

/**
 * Métadonnées d'un run — forme persistée telle quelle, clé state store
 * "orchestration-runs" (plafond 50, le plus récent en premier).
 */
interface RunMeta {
  runId: string;
  orchestration: string;
  projectName: string;
  startedAt: string;
  durationMs: number | null;
  status: "running" | OrchRunStatus;
  steps: Record<string, RunStepMeta>;
}

const RUNS_STATE_KEY = "orchestration-runs";
const MAX_RUNS = 50;

function isRunStatus(value: unknown): value is RunMeta["status"] {
  return value === "running" || value === "success" || value === "partial" || value === "failed" || value === "aborted";
}

function isRunStepMeta(value: unknown): value is RunStepMeta {
  return typeof value === "object" && value !== null && STEP_RUN_STATUSES.has(String((value as Record<string, unknown>).status));
}

function isRunMeta(value: unknown): value is RunMeta {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.runId !== "string" || !v.runId) return false;
  if (typeof v.orchestration !== "string" || typeof v.projectName !== "string" || typeof v.startedAt !== "string") return false;
  if (!(v.durationMs === null || typeof v.durationMs === "number")) return false;
  if (!isRunStatus(v.status)) return false;
  if (typeof v.steps !== "object" || v.steps === null) return false;
  return Object.values(v.steps as Record<string, unknown>).every(isRunStepMeta);
}

/** Un run resté « en cours » sur disque n'a plus de processus derrière lui après un redémarrage : réputé interrompu. */
function normalizeStaleRun(run: RunMeta): RunMeta {
  if (run.status !== "running") return run;
  const steps = Object.fromEntries(
    Object.entries(run.steps).map(([id, s]) => [
      id,
      { status: s.status === "success" || s.status === "failed" || s.status === "skipped" ? s.status : "aborted" } as RunStepMeta,
    ]),
  );
  return { ...run, status: "aborted", steps };
}

function sanitizeRunMetas(raw: unknown): RunMeta[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRunMeta).map(normalizeStaleRun);
}

/**
 * Fusionne le document disque avec l'état local courant (StrictMode-safe,
 * même motif que `mergeKnowledgeDocs` dans AgentPage.tsx) : un run déjà
 * démarré localement avant la fin de cette lecture disque ne doit jamais
 * être perdu — le local l'emporte sur le disque en cas de conflit d'id
 * (plus à jour), trié par date de départ décroissante, plafonné.
 */
function mergeRunMetas(disk: RunMeta[], local: RunMeta[]): RunMeta[] {
  const byId = new Map<string, RunMeta>();
  for (const r of disk) byId.set(r.runId, r);
  for (const r of local) byId.set(r.runId, r);
  return Array.from(byId.values())
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, MAX_RUNS);
}

/* ---------- Détail en mémoire (texte du run COURANT, jamais persisté) ---------- */

type RunBlock =
  | { type: "text"; id: string; content: string }
  | { type: "thinking"; id: string; content: string }
  | { type: "tool"; id: string; toolUseId: string; toolName: string; toolInput: unknown; result?: { isError: boolean; summary: string } };

let runBlockIdCounter = 0;
function nextRunBlockId(): string {
  runBlockIdCounter += 1;
  return `rb-${runBlockIdCounter}`;
}

function appendRunTextBlock(blocks: RunBlock[], type: "text" | "thinking", delta: string): RunBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) {
    return [...blocks.slice(0, -1), { ...last, content: last.content + delta } as RunBlock];
  }
  return [...blocks, { type, id: nextRunBlockId(), content: delta } as RunBlock];
}

function addRunToolBlock(blocks: RunBlock[], toolUseId: string, toolName: string, toolInput: unknown): RunBlock[] {
  return [...blocks, { type: "tool", id: nextRunBlockId(), toolUseId, toolName, toolInput }];
}

function setRunToolResult(blocks: RunBlock[], toolUseId: string, isError: boolean, summary: string): RunBlock[] {
  return blocks.map((b) => (b.type === "tool" && b.toolUseId === toolUseId ? { ...b, result: { isError, summary } } : b));
}

interface RunDetailStep {
  stepId: string;
  agent: string;
  engine: AgentEngine;
  model: string | null;
  status: OrchStepRunStatus;
  blocks: RunBlock[];
  output: string | null;
  usage: ClaudeUsage | null;
  message?: string;
  reason?: string;
}

/** Détail en mémoire d'un run — un par run lancé DANS CETTE SESSION (jamais relu du disque). */
interface RunDetail {
  runId: string;
  stepOrder: string[];
  steps: Record<string, RunDetailStep>;
  /** Rejet protocolaire avant le premier chunk (orchestration/agent/input introuvable). */
  protocolError?: string;
}

function emptyRunDetail(runId: string): RunDetail {
  return { runId, stepOrder: [], steps: {} };
}

function runDetailPrettyJson(value: unknown, maxLen = 800): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n…` : text;
}

/* ---------- Permissions (file, une modale à la fois — RÉUTILISE .permission-*) ---------- */

interface OrchPermissionItem {
  /** = runId (voir contrat `orch.permission {targetId: runId, …}`). */
  targetId: string;
  stepId: string;
  permissionId: string;
  toolName: string;
  toolInput: unknown;
}

function OrchPermissionModal({
  item,
  extraCount,
  onDecide,
}: Readonly<{ item: OrchPermissionItem; extraCount: number; onDecide: (decision: "allow" | "deny") => void }>) {
  return (
    <div className="permission-overlay">
      <div className="permission-modal">
        <div className="permission-modal__head">
          <h3>
            Étape « {item.stepId} » — {item.toolName}
          </h3>
          {extraCount > 0 && <span className="permission-modal__badge">+{extraCount} en attente</span>}
        </div>
        <div className="permission-modal__body">
          <pre className="pretty-json">{runDetailPrettyJson(item.toolInput)}</pre>
        </div>
        <div className="permission-modal__actions">
          <button type="button" className="btn btn--deny" onClick={() => onDecide("deny")}>
            Refuser
          </button>
          <button type="button" className="btn btn--allow" onClick={() => onDecide("allow")}>
            Autoriser
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Formatage ---------- */

function formatRunTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatRunDuration(ms: number | null): string {
  if (ms === null) return "en cours";
  if (ms < 1000) return `${ms} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes} min ${seconds}s`;
}

function stepStatusIcon(status: OrchStepRunStatus): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "running":
      return "▶";
    case "success":
      return "✓";
    case "failed":
      return "✗";
    case "skipped":
      return "⤼";
    case "aborted":
      return "■";
    default:
      return "?";
  }
}

function runStatusLabel(status: RunMeta["status"]): string {
  switch (status) {
    case "running":
      return "En cours";
    case "success":
      return "Réussi";
    case "partial":
      return "Partiel";
    case "failed":
      return "Échoué";
    case "aborted":
      return "Interrompu";
    default:
      return status;
  }
}

function runStatusClass(status: RunMeta["status"]): string {
  return `orch-run-status orch-run-status--${status}`;
}

function stepEngineLabel(step: Pick<RunDetailStep, "engine" | "model">): string {
  // Étape `engine: auto` pas encore démarrée : la cible sera résolue par le
  // routeur au démarrage de l'étape (annoncée par step_started).
  if (step.engine === "auto") return "auto (routé au démarrage)";
  return step.engine === "claude" ? `Claude · ${step.model || "défaut"}` : `Neutre · ${step.model || "—"}`;
}

/* ---------- Vues ---------- */

function RunBlockView({ block }: Readonly<{ block: RunBlock }>) {
  if (block.type === "text") return <div className="orch-run-flow__text">{block.content}</div>;
  if (block.type === "thinking") return <div className="orch-run-flow__thinking">{block.content}</div>;
  const state = block.result ? (block.result.isError ? "error" : "ok") : "pending";
  return (
    <div className={`orch-run-flow__tool orch-run-flow__tool--${state}`}>
      <span aria-hidden="true">🔧</span> {block.toolName}
      {block.result && <span className="orch-run-flow__tool-result"> — {block.result.summary}</span>}
    </div>
  );
}

function RunStepRow({ step }: Readonly<{ step: RunDetailStep }>) {
  const hasFlow = step.blocks.length > 0 || step.output !== null;
  return (
    <li className={`orch-run-step orch-run-step--${step.status}`}>
      <div className="orch-run-step__head">
        <span className="orch-run-step__icon" aria-hidden="true">
          {stepStatusIcon(step.status)}
        </span>
        <span className="orch-run-step__id">{step.stepId}</span>
        {step.agent && <span className="orch-run-step__agent">{step.agent}</span>}
        {step.agent && <span className="orch-chip">{stepEngineLabel(step)}</span>}
        {step.usage && (
          <span className="orch-run-step__usage">
            {step.usage.inputTokens} in / {step.usage.outputTokens} out
          </span>
        )}
      </div>
      {step.status === "failed" && step.message && <div className="result-line result-line--error">{step.message}</div>}
      {step.status === "skipped" && step.reason && <div className="result-line result-line--warn">{step.reason}</div>}
      {hasFlow && (
        <details className="orch-run-step__flow">
          <summary>Flux</summary>
          <div className="orch-run-flow">
            {step.blocks.map((b) => (
              <RunBlockView key={b.id} block={b} />
            ))}
          </div>
          {step.output !== null && (
            <div className="orch-run-step__output">
              <div className="orch-run-step__output-label">Sortie finale</div>
              <pre>{step.output}</pre>
            </div>
          )}
        </details>
      )}
    </li>
  );
}

function RunDetailPanel({
  run,
  detail,
  isActive,
  onAbort,
}: Readonly<{ run: RunMeta; detail: RunDetail | null; isActive: boolean; onAbort: () => void }>) {
  const order = detail && detail.stepOrder.length > 0 ? detail.stepOrder : Object.keys(run.steps);
  return (
    <div className="orch-run-detail">
      <div className="orch-run-detail__head">
        <div>
          <h3>{run.orchestration}</h3>
          <p className="empty-hint">
            {run.projectName} · {formatRunTime(run.startedAt)} · {formatRunDuration(run.durationMs)}
          </p>
        </div>
        <div className="orch-run-detail__head-right">
          <span className={runStatusClass(run.status)}>{runStatusLabel(run.status)}</span>
          {isActive && (
            <button type="button" className="btn btn--ghost" onClick={onAbort}>
              ■ Interrompre
            </button>
          )}
        </div>
      </div>
      {!detail && (
        <p className="empty-hint">Flux non conservé (l'application a redémarré depuis ce run) — seuls les statuts restent connus.</p>
      )}
      {detail?.protocolError && <div className="result-line result-line--error">Erreur : {detail.protocolError}</div>}
      {order.length === 0 ? (
        <p className="empty-hint">Aucune étape.</p>
      ) : (
        <ol className="orch-run-timeline">
          {order.map((stepId) => {
            const step = detail?.steps[stepId];
            if (step) return <RunStepRow key={stepId} step={step} />;
            const meta = run.steps[stepId];
            return (
              <li key={stepId} className={`orch-run-step orch-run-step--${meta?.status ?? "pending"}`}>
                <div className="orch-run-step__head">
                  <span className="orch-run-step__icon" aria-hidden="true">
                    {stepStatusIcon(meta?.status ?? "pending")}
                  </span>
                  <span className="orch-run-step__id">{stepId}</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function RunListItem({
  run,
  selected,
  onSelect,
}: Readonly<{ run: RunMeta; selected: boolean; onSelect: () => void }>) {
  const total = Object.keys(run.steps).length;
  const ok = Object.values(run.steps).filter((s) => s.status === "success").length;
  return (
    <li>
      <button
        type="button"
        className={`orch-run-list-item${selected ? " orch-run-list-item--selected" : ""}`}
        onClick={onSelect}
      >
        <div className="orch-run-list-item__row">
          <span className="orch-run-list-item__name">{run.orchestration}</span>
          <span className={runStatusClass(run.status)}>{runStatusLabel(run.status)}</span>
        </div>
        <div className="orch-run-list-item__meta">
          <span>{run.projectName}</span>
          <span>{formatRunTime(run.startedAt)}</span>
          <span>{formatRunDuration(run.durationMs)}</span>
          {total > 0 && (
            <span>
              {ok}/{total} étapes
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

function RunsSection({
  runs,
  runDetails,
  activeRunId,
  selectedRunId,
  onSelectRun,
  onAbort,
}: Readonly<{
  runs: RunMeta[];
  runDetails: Record<string, RunDetail>;
  activeRunId: string | null;
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onAbort: () => void;
}>) {
  const selected = runs.find((r) => r.runId === selectedRunId) ?? null;
  return (
    <section className="config-section">
      <h2 className="config-section__title">Exécutions</h2>
      {runs.length === 0 ? (
        <p className="empty-hint">Aucune exécution pour l'instant — lancez une orchestration depuis l'onglet « Orchestrations ».</p>
      ) : (
        <div className="orch-runs-layout">
          <div className="orch-run-list-col">
            <ul className="orch-run-list">
              {runs.map((r) => (
                <RunListItem key={r.runId} run={r} selected={r.runId === selectedRunId} onSelect={() => onSelectRun(r.runId)} />
              ))}
            </ul>
          </div>
          <div className="orch-run-detail-col">
            {selected ? (
              <RunDetailPanel
                run={selected}
                detail={runDetails[selected.runId] ?? null}
                isActive={selected.runId === activeRunId}
                onAbort={onAbort}
              />
            ) : (
              <p className="empty-hint">Sélectionnez une exécution pour voir son détail.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ================= Page ================= */

type OrchSubTab = "agents" | "orchestrations" | "runs" | "taches";

const ORCH_TABS: { id: OrchSubTab; label: string; disabled?: boolean; title?: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "orchestrations", label: "Orchestrations" },
  { id: "runs", label: "Exécutions" },
  { id: "taches", label: "Tâches" },
];

function orchPanelClass(active: boolean): string {
  return active ? "orch-panel" : "orch-panel orch-panel--hidden";
}

/** Préfixe des valeurs de l'optgroup « Tâches » dans le sélecteur de contexte (distinct des id de projets, slugs sans `:`). */
const TACHE_CONTEXT_PREFIX = "tache:";

const TACHES_LAST_VISIT_KEY = "iaction:taches:lastVisit";

function readTachesLastVisit(): number {
  try {
    const raw = window.localStorage.getItem(TACHES_LAST_VISIT_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // localStorage indisponible (mode privé strict, etc.) : le badge « non lu » reste simplement toujours actif
  }
}

function writeTachesLastVisit(ts: number) {
  try {
    window.localStorage.setItem(TACHES_LAST_VISIT_KEY, String(ts));
  } catch {
    // best effort : la préférence ne survivra simplement pas au rechargement
  }
}

export interface OrchestrationPageProps {
  projects: ProjectConfig[];
  providers: ProviderConfig[];
}

export function OrchestrationPage({ projects, providers }: Readonly<OrchestrationPageProps>) {
  const [subTab, setSubTab] = useState<OrchSubTab>("agents");
  const [contextId, setContextId] = useState("");
  // Sous-menu aux flèches, activation manuelle (Entrée / Espace) — voir Nav dans App.tsx.
  const subnavRoving = useRovingFocus<HTMLElement>({
    selector: ".config-subnav__item:not(:disabled)",
    orientation: "horizontal",
  });

  const [taches, setTaches] = useState<TacheInfo[]>([]);
  const [tachesLoadState, setTachesLoadState] = useState<LoadState>("loading");
  const [tachesErrorMessage, setTachesErrorMessage] = useState("");
  const [tachesStale, setTachesStale] = useState(false);
  const [tacheReportsByName, setTacheReportsByName] = useState<Record<string, TacheReportInfo[]>>({});

  // Statuts des timers systemd (T2, docs/protocol.md § T2) — chargés à l'ouverture du sous-onglet Tâches
  // pour toutes les tâches, puis rafraîchis ciblés (un nom) après chaque bascule/synchronisation/sauvegarde.
  const [tacheTimersByName, setTacheTimersByName] = useState<Record<string, TacheTimerStatus>>({});
  const refreshTacheTimers = useCallback((names?: string[]) => {
    return tachesTimerStatus(names)
      .then((map) => {
        setTacheTimersByName((prev) => ({ ...prev, ...map }));
      })
      .catch(() => {
        // best effort : les cartes retombent sur « — » pour prochain/dernier run, pas de badge « à synchroniser »
      });
  }, []);

  useEffect(() => {
    if (subTab !== "taches") return;
    void refreshTacheTimers();
  }, [subTab, refreshTacheTimers]);

  const reloadTaches = useCallback(() => {
    setTachesLoadState("loading");
    setTachesStale(false);
    tachesList()
      .then((list) => {
        setTaches(list);
        setTachesLoadState("ready");
        // Rapports chargés par tâche (indépendamment les uns des autres — voir docs/etude-taches.md § 3.3,
        // « date du dernier rapport » sur chaque carte) : une tâche dont les rapports ne chargent pas ne
        // doit jamais empêcher l'affichage des autres.
        for (const t of list) {
          if (t.invalid) continue;
          tachesReports(t.name)
            .then((reports) => setTacheReportsByName((prev) => ({ ...prev, [t.name]: reports })))
            .catch(() => {
              // best effort : la carte retombe simplement sur « aucun rapport »
            });
        }
      })
      .catch((err: unknown) => {
        const message = toMessage(err);
        setTachesErrorMessage(message);
        setTachesStale(looksLikeUnknownMethod(message));
        setTachesLoadState("error");
      });
  }, []);

  useEffect(() => {
    reloadTaches();
  }, [reloadTaches]);

  // Badge « non lu » sur la pilule Tâches : un point tant que le rapport le plus
  // récent (tous rapports de toutes les tâches confondus) est postérieur à la
  // dernière visite du sous-onglet — mémorisée en localStorage, même patron que
  // SidebarSection.tsx (clé préfixée `iaction:`).
  const [tachesLastVisit, setTachesLastVisit] = useState(() => readTachesLastVisit());
  const latestReportMtime = useMemo(() => {
    let max = 0;
    for (const reports of Object.values(tacheReportsByName)) {
      for (const r of reports) if (r.mtimeMs > max) max = r.mtimeMs;
    }
    return max;
  }, [tacheReportsByName]);
  const tachesUnread = latestReportMtime > tachesLastVisit;

  useEffect(() => {
    if (subTab !== "taches") return;
    const now = Date.now();
    writeTachesLastVisit(now);
    setTachesLastVisit(now);
  }, [subTab]);

  const selectedProject = useMemo(() => projects.find((p) => p.id === contextId) ?? null, [projects, contextId]);
  const selectedTache = useMemo(
    () => (contextId.startsWith(TACHE_CONTEXT_PREFIX) ? taches.find((t) => t.name === contextId.slice(TACHE_CONTEXT_PREFIX.length)) ?? null : null),
    [taches, contextId],
  );

  const cwd = selectedTache ? selectedTache.path : selectedProject ? selectedProject.path : null;
  const hasProject = cwd !== null;

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentsLoadState, setAgentsLoadState] = useState<LoadState>("loading");
  const [agentsErrorMessage, setAgentsErrorMessage] = useState("");
  const [agentsStale, setAgentsStale] = useState(false);

  const [orchestrations, setOrchestrations] = useState<OrchestrationInfo[]>([]);
  const [orchLoadState, setOrchLoadState] = useState<LoadState>("loading");
  const [orchErrorMessage, setOrchErrorMessage] = useState("");
  const [orchStale, setOrchStale] = useState(false);

  const reloadAgents = useCallback(() => {
    setAgentsLoadState("loading");
    setAgentsStale(false);
    agentsList(cwd)
      .then((list) => {
        setAgents(list);
        setAgentsLoadState("ready");
      })
      .catch((err: unknown) => {
        const message = toMessage(err);
        setAgentsErrorMessage(message);
        setAgentsStale(looksLikeUnknownMethod(message));
        setAgentsLoadState("error");
      });
  }, [cwd]);

  const reloadOrchestrations = useCallback(() => {
    setOrchLoadState("loading");
    setOrchStale(false);
    orchList(cwd)
      .then((list) => {
        setOrchestrations(list);
        setOrchLoadState("ready");
      })
      .catch((err: unknown) => {
        const message = toMessage(err);
        setOrchErrorMessage(message);
        setOrchStale(looksLikeUnknownMethod(message));
        setOrchLoadState("error");
      });
  }, [cwd]);

  // Recharge les deux listes à chaque changement de contexte projet.
  useEffect(() => {
    reloadAgents();
    reloadOrchestrations();
  }, [reloadAgents, reloadOrchestrations]);

  /* ---------- Exécutions (phase O3) ---------- */

  const selectedContextName = selectedProject?.name ?? selectedTache?.name ?? null;

  // Métadonnées des runs (persistées) : `runsRef` reflète toujours la même
  // valeur que l'état affiché — lu de façon SYNCHRONE par `commitRuns` pour
  // enchaîner plusieurs mises à jour dans le même tick sans jamais partir
  // d'un instantané périmé (même besoin que turnsRef/sessionIdRef dans
  // AgentPage, mais ici l'écriture disque doit rester hors d'un updater de
  // `setState`, d'où ce miroir plutôt qu'un simple `setRuns(prev => …)`).
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const runsRef = useRef<RunMeta[]>([]);
  const runsInitRef = useRef(false);

  function commitRuns(next: RunMeta[]) {
    runsRef.current = next;
    setRuns(next);
    void stateWrite(RUNS_STATE_KEY, next).catch(() => {
      // best effort : une écriture ratée n'empêche pas l'affichage, la prochaine mise à jour retentera
    });
  }

  function updateRunMeta(runId: string, updater: (meta: RunMeta) => RunMeta) {
    commitRuns(runsRef.current.map((r) => (r.runId === runId ? updater(r) : r)));
  }

  function updateRunStepMeta(runId: string, stepId: string, status: OrchStepRunStatus) {
    updateRunMeta(runId, (meta) => ({ ...meta, steps: { ...meta.steps, [stepId]: { status } } }));
  }

  // Chargement du document persisté, une seule fois (StrictMode-safe) puis
  // fusion avec l'état local courant — voir `mergeRunMetas` (même motif que
  // `mergeKnowledgeDocs` dans AgentPage.tsx : un run déjà démarré localement
  // avant la fin de cette lecture ne doit jamais être perdu).
  useEffect(() => {
    if (runsInitRef.current) return;
    runsInitRef.current = true;
    stateRead<unknown>(RUNS_STATE_KEY)
      .then((raw) => {
        const merged = mergeRunMetas(sanitizeRunMetas(raw), runsRef.current);
        runsRef.current = merged;
        setRuns(merged);
      })
      .catch(() => {
        // best effort : sans document, la liste reste vide
      });
  }, []);

  // Détail en mémoire (texte des runs lancés CETTE SESSION) — jamais persisté.
  const [runDetails, setRunDetails] = useState<Record<string, RunDetail>>({});

  function updateRunDetail(runId: string, updater: (detail: RunDetail) => RunDetail) {
    setRunDetails((prev) => ({ ...prev, [runId]: updater(prev[runId] ?? emptyRunDetail(runId)) }));
  }

  function updateRunStepDetail(runId: string, stepId: string, updater: (step: RunDetailStep) => RunDetailStep) {
    updateRunDetail(runId, (detail) => {
      const step = detail.steps[stepId];
      if (!step) return detail; // chunk pour une étape pas encore annoncée par run_started : ignoré
      return { ...detail, steps: { ...detail.steps, [stepId]: updater(step) } };
    });
  }

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [launchTarget, setLaunchTarget] = useState<OrchestrationInfo | null>(null);
  const [permissionQueue, setPermissionQueue] = useState<OrchPermissionItem[]>([]);

  function handleOrchChunk(runId: string, chunk: OrchRunChunk) {
    switch (chunk.kind) {
      case "run_started": {
        updateRunDetail(runId, (detail) => {
          const steps: Record<string, RunDetailStep> = {};
          const order: string[] = [];
          for (const s of chunk.steps) {
            steps[s.stepId] = {
              stepId: s.stepId,
              agent: s.agent,
              engine: s.engine,
              model: s.model,
              status: "pending",
              blocks: [],
              output: null,
              usage: null,
            };
            order.push(s.stepId);
          }
          return { ...detail, stepOrder: order, steps };
        });
        updateRunMeta(runId, (meta) => ({
          ...meta,
          steps: Object.fromEntries(chunk.steps.map((s) => [s.stepId, { status: "pending" as OrchStepRunStatus }])),
        }));
        break;
      }
      case "step_started":
        // Cible effective annoncée au démarrage (agent `engine: auto` routé à ce
        // moment-là) : remplace le `engine: "auto", model: null` du run_started.
        updateRunStepDetail(runId, chunk.stepId, (step) => ({
          ...step,
          status: "running",
          engine: chunk.engine ?? step.engine,
          model: chunk.engine ? chunk.model : step.model,
        }));
        updateRunStepMeta(runId, chunk.stepId, "running");
        break;
      case "step_chunk": {
        const ec = chunk.chunk;
        if (ec.kind === "text" || ec.kind === "thinking") {
          updateRunStepDetail(runId, chunk.stepId, (step) => ({ ...step, blocks: appendRunTextBlock(step.blocks, ec.kind, ec.delta) }));
        } else if (ec.kind === "tool_use") {
          updateRunStepDetail(runId, chunk.stepId, (step) => ({
            ...step,
            blocks: addRunToolBlock(step.blocks, ec.toolUseId, ec.toolName, ec.toolInput),
          }));
        } else if (ec.kind === "tool_result") {
          updateRunStepDetail(runId, chunk.stepId, (step) => ({
            ...step,
            blocks: setRunToolResult(step.blocks, ec.toolUseId, ec.isError, ec.summary),
          }));
        } else if (ec.kind === "permission_request") {
          setPermissionQueue((prev) => [
            ...prev,
            { targetId: runId, stepId: chunk.stepId, permissionId: ec.permissionId, toolName: ec.toolName, toolInput: ec.toolInput },
          ]);
        }
        break;
      }
      case "step_done":
        updateRunStepDetail(runId, chunk.stepId, (step) => ({ ...step, status: "success", output: chunk.output, usage: chunk.usage }));
        updateRunStepMeta(runId, chunk.stepId, "success");
        break;
      case "step_failed":
        updateRunStepDetail(runId, chunk.stepId, (step) => ({ ...step, status: "failed", message: chunk.message }));
        updateRunStepMeta(runId, chunk.stepId, "failed");
        break;
      case "step_skipped":
        updateRunStepDetail(runId, chunk.stepId, (step) => ({ ...step, status: "skipped", reason: chunk.reason }));
        updateRunStepMeta(runId, chunk.stepId, "skipped");
        break;
      default:
      // chunk de kind inconnu : déjà filtré par orchestrationClient.ts, rien à faire ici
    }
  }

  /** Fin de run : le `done.steps` fait foi sur les statuts (couvre une étape jamais annoncée par chunk, ex. aboutie « aborted »). */
  function finalizeRun(runId: string, startedAtMs: number, status: OrchRunStatus, doneSteps: Record<string, OrchRunDoneStep>) {
    const durationMs = Date.now() - startedAtMs;
    updateRunMeta(runId, (meta) => {
      const steps = { ...meta.steps };
      for (const [stepId, s] of Object.entries(doneSteps)) {
        steps[stepId] = { status: toStepRunStatus(s.status) };
      }
      return { ...meta, status, durationMs, steps };
    });
    updateRunDetail(runId, (detail) => {
      const steps = { ...detail.steps };
      for (const [stepId, s] of Object.entries(doneSteps)) {
        const prevStep = steps[stepId];
        if (prevStep) {
          steps[stepId] = {
            ...prevStep,
            status: toStepRunStatus(s.status),
            output: s.output ?? prevStep.output,
            message: s.message ?? prevStep.message,
          };
        }
      }
      return { ...detail, steps };
    });
  }

  function startRun(runCwd: string, projectName: string, orch: Pick<OrchestrationInfo, "name">, values: Record<string, string>) {
    if (activeRunId) return; // garde-fou : un seul run à la fois côté UI
    const startedAtMs = Date.now();
    const { runId, done } = orchRun(runCwd, orch.name, values, (chunk) => handleOrchChunk(runId, chunk));
    setActiveRunId(runId);
    setSelectedRunId(runId);
    setSubTab("runs");
    const meta: RunMeta = {
      runId,
      orchestration: orch.name,
      projectName,
      startedAt: new Date(startedAtMs).toISOString(),
      durationMs: null,
      status: "running",
      steps: {},
    };
    commitRuns([meta, ...runsRef.current].slice(0, MAX_RUNS));
    setRunDetails((prev) => ({ ...prev, [runId]: emptyRunDetail(runId) }));

    done
      .then((result) => {
        finalizeRun(runId, startedAtMs, result.status, result.steps);
      })
      .catch((err: unknown) => {
        // Rejet protocolaire (avant tout chunk) : orchestration/agent/input introuvable.
        finalizeRun(runId, startedAtMs, "failed", {});
        updateRunDetail(runId, (detail) => ({ ...detail, protocolError: toMessage(err) }));
      })
      .finally(() => {
        setActiveRunId((cur) => (cur === runId ? null : cur));
        setPermissionQueue((prev) => prev.filter((p) => p.targetId !== runId));
        notifyUsageChanged();
      });
  }

  async function handleAbortRun() {
    if (!activeRunId) return;
    try {
      await orchAbort(activeRunId);
    } catch {
      // best effort : le `done` du run en cours gère l'état final
    }
  }

  async function handleOrchPermissionDecision(decision: "allow" | "deny") {
    const current = permissionQueue[0];
    if (!current) return;
    try {
      await orchPermission(current.targetId, current.stepId, current.permissionId, decision);
    } catch {
      // best effort : la file est purgée dans tous les cas côté UI
    }
    setPermissionQueue((prev) => prev.slice(1));
  }

  const launchDisabledReason = !hasProject
    ? "Sélectionnez un projet dans le contexte pour lancer une orchestration (un run exige un projet)."
    : activeRunId
      ? "Un run est déjà en cours — un seul run à la fois."
      : null;

  // « Lancer maintenant » (T1) : gabarits `{{today}}` résolus dans les valeurs d'inputs, cwd = dossier
  // de la tâche (PAS le contexte sélectionné) — voir docs/etude-taches.md § 3.3. Réutilise startRun/la
  // vue Exécutions telle quelle (même bascule automatique sur la pilule Exécutions).
  const tachesLaunchDisabledReason = activeRunId ? "Un run est déjà en cours — un seul run à la fois." : null;

  function handleLaunchTache(tache: TacheInfo) {
    if (activeRunId || !tache.orchestration) return;
    // cwd : le projet déclaré par la tâche (orchestrations du projet), sinon
    // le dossier de la tâche — même résolution que l'unité systemd (T2).
    startRun(tache.cwd ?? tache.path, tache.name, { name: tache.orchestration }, resolveTodayTemplates(tache.inputs));
  }

  const currentOrchPermission = permissionQueue[0] ?? null;

  return (
    <div className="page orch-page">
      <div className="page__intro">
        <h1 className="page__title">Orchestration</h1>
        <p className="empty-hint">
          Agents déclaratifs et enchaînements d'agents — voir docs/etude-orchestration.md pour le format des fichiers.
        </p>
      </div>

      <div className="orch-header-row">
        <nav
          className="config-subnav"
          aria-label="Sections d'orchestration"
          ref={subnavRoving.containerRef}
          onKeyDown={subnavRoving.onKeyDown}
          onFocus={subnavRoving.onFocus}
        >
          {ORCH_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`config-subnav__item${subTab === tab.id ? " config-subnav__item--active" : ""}`}
              onClick={() => !tab.disabled && setSubTab(tab.id)}
              disabled={tab.disabled}
              title={tab.title}
              aria-current={subTab === tab.id ? "page" : undefined}
              tabIndex={subTab === tab.id ? 0 : -1}
            >
              {tab.label}
              {tab.id === "taches" && tachesUnread && (
                <span className="agent-tab__dot" aria-hidden="true" title="Nouveau rapport" />
              )}
            </button>
          ))}
        </nav>

        <div className="field orch-context-select">
          <label htmlFor="orch-context">Contexte</label>
          <select id="orch-context" value={contextId} onChange={(e) => setContextId(e.currentTarget.value)}>
            <option value="">Global uniquement</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {taches.length > 0 && (
              <optgroup label="Tâches">
                {taches.map((t) => (
                  <option key={t.name} value={`${TACHE_CONTEXT_PREFIX}${t.name}`}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      </div>

      <div className={orchPanelClass(subTab === "agents")}>
        <AgentsSection
          key={cwd ?? "__global__"}
          cwd={cwd}
          hasProject={hasProject}
          providers={providers}
          agents={agents}
          loadState={agentsLoadState}
          errorMessage={agentsErrorMessage}
          staleEngine={agentsStale}
          onReload={reloadAgents}
        />
      </div>

      <div className={orchPanelClass(subTab === "orchestrations")}>
        <OrchestrationsSection
          key={cwd ?? "__global__"}
          cwd={cwd}
          hasProject={hasProject}
          agentsForContext={agents}
          orchestrations={orchestrations}
          loadState={orchLoadState}
          errorMessage={orchErrorMessage}
          staleEngine={orchStale}
          onReload={reloadOrchestrations}
          launchDisabledReason={launchDisabledReason}
          onRequestLaunch={(orch) => setLaunchTarget(orch)}
        />
      </div>

      <div className={orchPanelClass(subTab === "runs")}>
        <RunsSection
          runs={runs}
          runDetails={runDetails}
          activeRunId={activeRunId}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
          onAbort={() => void handleAbortRun()}
        />
      </div>

      <div className={orchPanelClass(subTab === "taches")}>
        <TachesSection
          taches={taches}
          tacheReports={tacheReportsByName}
          tacheTimers={tacheTimersByName}
          providers={providers}
          loadState={tachesLoadState}
          errorMessage={tachesErrorMessage}
          staleEngine={tachesStale}
          onReload={reloadTaches}
          onRefreshTimers={refreshTacheTimers}
          launchDisabledReason={tachesLaunchDisabledReason}
          onLaunch={handleLaunchTache}
        />
      </div>

      {launchTarget && cwd && (
        <RunLaunchModal
          orch={launchTarget}
          projectName={selectedContextName ?? "—"}
          onClose={() => setLaunchTarget(null)}
          onLaunch={(values) => {
            startRun(cwd, selectedContextName ?? "Projet", launchTarget, values);
            setLaunchTarget(null);
          }}
        />
      )}

      {currentOrchPermission && (
        <OrchPermissionModal
          item={currentOrchPermission}
          extraCount={permissionQueue.length - 1}
          onDecide={(decision) => void handleOrchPermissionDecision(decision)}
        />
      )}
    </div>
  );
}
