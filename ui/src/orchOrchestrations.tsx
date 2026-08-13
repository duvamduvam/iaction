/*
 * Section Orchestrations : cartes, éditeur, et modale de lancement d'un run.
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
import { computeDagOrder, ErrorOrStaleHint, type LoadState, orchestrationYamlPreview } from "./orchCommun";
import {
  type AgentInfo,
  orchDelete,
  type OrchestrationInfo,
  type OrchestrationInputField,
  type OrchestrationLimits,
  type OrchestrationScope,
  type OrchestrationStep,
  type OrchestrationWriteInput,
  orchRead,
  orchWrite,
} from "./orchestrationClient";
import { useEffect, useMemo, useState } from "react";

export interface OrchestrationsSectionProps {
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

export function OrchestrationCard({
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

export function OrchestrationErrorCard({ orch }: Readonly<{ orch: OrchestrationInfo }>) {
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
export function RunLaunchModal({
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

export const DEFAULT_LIMITS: OrchestrationLimits = { maxParallel: 2, maxDurationMin: 30 };

export interface OrchestrationEditorProps {
  mode: "create" | "edit";
  cwd: string | null;
  hasProject: boolean;
  agentsForContext: AgentInfo[];
  initial: OrchestrationInfo | null;
  initialRaw: string | null;
  onClose: () => void;
  onSaved: () => void;
}

export function OrchestrationEditor({
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

export type OrchestrationPanelState = { mode: "create" | "edit"; seed: OrchestrationInfo | null; raw: string | null } | null;

export function OrchestrationsSection({
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
