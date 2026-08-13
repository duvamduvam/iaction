/*
 * Éditeur de tâche (création/édition YAML) — sorti d'orchTaches le 2026-08-08
 * quand le cliquet de taille a refusé le fichier à 836 lignes : découper est
 * la réponse attendue, la dérogation l'exception.
 */

/*
 * Section Tâches : cartes, rapports, éditeur, timers systemd.
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


/** `ms` epoch → date/heure locale lisible, `—` si absent (pas de timer, ou systemd ne fournit rien). */
import { Markdown } from "./Markdown";
import { Modal } from "./Modal";
import { toMessage } from "./base";
import { formatReportDate, type LoadState, tacheYamlPreview } from "./orchCommun";
import { type ProviderConfig } from "./providerAdmin";
import {
  type TacheInfo,
  type TacheLieu,
  type TacheReportInfo,
  tachesReportRead,
  tachesReports,
  tachesTimerApply,
  tachesWrite,
  type TacheWriteInput,
  type TacheWriteResult,
} from "./tachesClient";
import { useEffect, useState } from "react";
import { TacheLlmSummary } from "./orchTaches";

/** Liste des rapports d'une tâche + rendu Markdown du rapport sélectionné (onglet « Rapports » de la fiche). */
export function TacheReportsTab({ name }: Readonly<{ name: string }>) {
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

export interface TacheEditorProps {
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

export function TacheEditor({
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
