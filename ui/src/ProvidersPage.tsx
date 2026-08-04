/*
 * Page « Configuration » (admin) : section « Projets » (registre de
 * projets déclarés, nom + répertoire) au-dessus de la section
 * « Fournisseurs » (liste éditable, config non-secrète, gestion des clés
 * API par fournisseur — trousseau OS, jamais affichées ni persistées en
 * clair côté UI — et bouton « Tester » `models.list` par fournisseur).
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  addApp,
  deleteApp,
  parseExtensions,
  readApps,
  updateApp,
  type AppEntry,
} from "./appsAdmin";
import { listMicrophones, micLevelStyle, startRecording, stopRecording, type MicrophoneDevice } from "./audioCapture";
import { startPlayback } from "./audioPlayback";
import { BENCH_DISCLAIMER, matchBenchNote, readFeatured, toggleFeatured } from "./modelCatalog";
import { initProjectIaction, type ProjectConfig } from "./projectAdmin";
import type { ProviderConfig } from "./providerAdmin";
import { subscribeProvidersPushed } from "./providersBus";
import {
  DEFAULT_CLASSIFIER,
  DEFAULT_DEBORD,
  mergeRoutingTable,
  pushRouting,
  readRoutingClassifier,
  readRoutingDebord,
  readRoutingSummarizer,
  readRoutingTable,
  ROUTE_TIERS,
  writeRoutingTable,
  type SummarizerSetting,
} from "./routerAdmin";
import {
  modelsDetail,
  modelsList,
  type ClassifierConfig,
  type DebordConfig,
  type ModelDetail,
  type RouteTarget,
  type RouteTier,
  type RoutingTable,
} from "./sidecar";
import {
  coherentVoiceFor,
  formatSpeechProgress,
  KOKORO_VOICES,
  normalizeBaseUrl,
  OPENROUTER_TTS_DEFAULT_MODEL,
  SPEECH_KEY_DEDICATED,
  speechSynthesize,
  speechTranscribe,
  STT_REMOTE_MODELS,
  TTS_REMOTE_MODELS,
  voiceCatalogFor,
  type SpeechConfig,
  type SpeechConfigPatch,
  type SpeechKeyKind,
  type SpeechKeyOrigin,
  type SpeechKeyOrigins,
  type SpeechKeyStatus,
  type SpeechMode,
  type SpeechOption,
} from "./speechAdmin";
import type { ProjectsLoadState } from "./useProjects";
import type { ProvidersLoadState } from "./useProviders";
import { useRovingFocus } from "./useRovingFocus";

const OPENROUTER_PROVIDER_ID = "openrouter";

interface ProvidersPageProps {
  providers: ProviderConfig[];
  keyStatus: Record<string, boolean>;
  loadState: ProvidersLoadState;
  errorMessage: string;
  onSaveProvider: (provider: ProviderConfig) => Promise<void>;
  onDeleteProvider: (id: string) => Promise<void>;
  onSaveKey: (id: string, value: string) => Promise<void>;
  onClearKey: (id: string) => Promise<void>;
  projects: ProjectConfig[];
  projectsLoadState: ProjectsLoadState;
  projectsErrorMessage: string;
  onAddProject: (name: string, path: string) => Promise<void>;
  onUpdateProject: (id: string, patch: Partial<Pick<ProjectConfig, "name" | "path">>) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
  speechConfig: SpeechConfig;
  speechKeyStatus: SpeechKeyStatus;
  speechKeyOrigin: SpeechKeyOrigins;
  speechErrorMessage: string;
  onSaveSpeechConfig: (patch: SpeechConfigPatch) => Promise<void>;
  onSaveSpeechKey: (kind: SpeechKeyKind, value: string) => Promise<void>;
  onClearSpeechKey: (kind: SpeechKeyKind) => Promise<void>;
}

/* ---------- Section Projets ---------- */

interface ProjectFormValues {
  name: string;
  path: string;
}

function ProjectForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  onIactionWarning,
}: Readonly<{
  mode: "add" | "edit";
  initial?: ProjectFormValues;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
  onCancel: () => void;
  /** Appelé (mode "add" seulement) si l'init `.iaction/` best-effort échoue. */
  onIactionWarning?: (message: string) => void;
}>) {
  const [name, setName] = useState(initial?.name ?? "");
  const [path, setPath] = useState(initial?.path ?? "");
  const [initIaction, setInitIaction] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = name.trim().length > 0 && path.trim().length > 0;

  async function handleChoosePath() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") setPath(selected);
    } catch {
      // dialogue annulé/erreur plateforme : rien à faire
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setError("");
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    try {
      await onSubmit({ name: trimmedName, path: trimmedPath });
      // Le projet est déclaré quel que soit le sort de l'init ci-dessous
      // (échec non bloquant, remonté en avertissement discret par le parent).
      if (mode === "add" && initIaction) {
        try {
          await initProjectIaction(trimmedName, trimmedPath);
        } catch (initErr) {
          const msg = initErr instanceof Error ? initErr.message : String(initErr);
          onIactionWarning?.(`« ${trimmedName} » déclaré, mais l'initialisation de .iaction/ a échoué : ${msg}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="project-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="field">
        <label htmlFor={`prf-name-${mode}`}>Nom</label>
        <input
          id={`prf-name-${mode}`}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="ex. Mon projet"
        />
      </div>
      <div className="field">
        <label htmlFor={`prf-path-${mode}`}>Répertoire</label>
        <div className="project-form__path-row">
          <input
            id={`prf-path-${mode}`}
            type="text"
            value={path}
            readOnly
            placeholder="Aucun dossier sélectionné"
          />
          <button type="button" className="btn btn--ghost" onClick={() => void handleChoosePath()}>
            Choisir un dossier
          </button>
        </div>
      </div>
      {mode === "add" && (
        <label className="field field--checkbox" htmlFor="prf-init-iaction">
          <input
            id="prf-init-iaction"
            type="checkbox"
            checked={initIaction}
            onChange={(e) => setInitIaction(e.currentTarget.checked)}
          />
          <span>Initialiser .iaction/ dans le projet</span>
        </label>
      )}
      {error && <div className="result-line result-line--error">Erreur : {error}</div>}
      <div className="actions">
        <button type="submit" className="btn" disabled={!canSubmit || saving}>
          {saving ? "Enregistrement…" : mode === "add" ? "Ajouter" : "Enregistrer"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={saving}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function ProjectCard({
  project,
  onEdit,
  onDelete,
}: Readonly<{
  project: ProjectConfig;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  return (
    <article className="project-card">
      <div className="project-card__head">
        <span className="project-card__name">{project.name}</span>
        <div className="actions">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onEdit}
            aria-label={`Renommer ${project.name}`}
            title="Renommer"
          >
            ✎
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onDelete}
            aria-label={`Supprimer ${project.name}`}
            title="Supprimer"
          >
            Supprimer
          </button>
        </div>
      </div>
      <div className="project-card__path">{project.path}</div>
    </article>
  );
}

function ProjectsSection({
  projects,
  loadState,
  errorMessage,
  onAddProject,
  onUpdateProject,
  onDeleteProject,
}: Readonly<{
  projects: ProjectConfig[];
  loadState: ProjectsLoadState;
  errorMessage: string;
  onAddProject: (name: string, path: string) => Promise<void>;
  onUpdateProject: (id: string, patch: Partial<Pick<ProjectConfig, "name" | "path">>) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
}>) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [iactionWarning, setIactionWarning] = useState<string | null>(null);

  return (
    <section className="config-section">
      <h2 className="config-section__title">Projets</h2>
      <p className="empty-hint">Projets déclarés, chacun lié à un répertoire local.</p>

      {loadState === "loading" && <p className="empty-hint">Chargement…</p>}
      {loadState === "error" && (
        <div className="result-line result-line--error">Erreur de chargement : {errorMessage}</div>
      )}
      {iactionWarning && (
        <div className="result-line result-line--warn">
          ⚠ {iactionWarning}
          <button
            type="button"
            className="btn btn--ghost result-line__dismiss"
            onClick={() => setIactionWarning(null)}
            aria-label="Masquer l'avertissement"
          >
            ×
          </button>
        </div>
      )}

      <div className="project-list">
        {projects.map((project) =>
          editingId === project.id ? (
            <article className="project-card" key={project.id}>
              <ProjectForm
                mode="edit"
                initial={{ name: project.name, path: project.path }}
                onSubmit={async (values) => {
                  await onUpdateProject(project.id, values);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            </article>
          ) : (
            <ProjectCard
              key={project.id}
              project={project}
              onEdit={() => setEditingId(project.id)}
              onDelete={() => {
                if (window.confirm(`Supprimer le projet « ${project.name} » ?`)) {
                  void onDeleteProject(project.id);
                }
              }}
            />
          ),
        )}
        {projects.length === 0 && loadState === "ready" && <p className="empty-hint">Aucun projet déclaré.</p>}
      </div>

      {adding ? (
        <article className="project-card project-card--new">
          <ProjectForm
            mode="add"
            onSubmit={async (values) => {
              await onAddProject(values.name, values.path);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
            onIactionWarning={setIactionWarning}
          />
        </article>
      ) : (
        <div className="actions">
          <button className="btn" onClick={() => setAdding(true)}>
            + Ajouter un projet
          </button>
        </div>
      )}
    </section>
  );
}

/* ---------- Formulaire ajout / édition ---------- */

interface ProviderFormValues {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  /** R0 — réglages de routage OpenRouter (opt-in : propriétés absentes si non renseignées). */
  fallbackModels?: string[];
  priceSort?: boolean;
  usageAccounting?: boolean;
}

function ProviderForm({
  mode,
  initial,
  existingIds,
  onSubmit,
  onCancel,
}: Readonly<{
  mode: "add" | "edit";
  initial?: ProviderFormValues;
  existingIds: string[];
  onSubmit: (values: ProviderFormValues) => Promise<void>;
  onCancel: () => void;
}>) {
  const [id, setId] = useState(initial?.id ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [needsKey, setNeedsKey] = useState(initial?.needsKey ?? false);
  // R0 — routage OpenRouter (saisie libre : ids séparés par virgules ou retours ligne).
  const [fallbackModelsText, setFallbackModelsText] = useState(
    initial?.fallbackModels?.join(", ") ?? "",
  );
  const [priceSort, setPriceSort] = useState(initial?.priceSort ?? false);
  const [usageAccounting, setUsageAccounting] = useState(initial?.usageAccounting ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const trimmedId = id.trim();
  const idTaken = mode === "add" && existingIds.includes(trimmedId);
  const canSubmit =
    trimmedId.length > 0 && label.trim().length > 0 && baseUrl.trim().length > 0 && !idTaken;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setError("");
    try {
      // R0 — champ vide (ou case décochée) → propriété absente (opt-in pur).
      const fallbackModels = fallbackModelsText
        .split(/[\n,]/)
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      await onSubmit({
        id: trimmedId,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        needsKey,
        ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
        ...(priceSort ? { priceSort: true } : {}),
        ...(usageAccounting ? { usageAccounting: true } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="provider-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="field">
        <label htmlFor={`pf-id-${mode}`}>Identifiant</label>
        <input
          id={`pf-id-${mode}`}
          value={id}
          onChange={(e) => setId(e.currentTarget.value)}
          disabled={mode === "edit"}
          placeholder="ex. mon-fournisseur"
        />
      </div>
      <div className="field">
        <label htmlFor={`pf-label-${mode}`}>Libellé</label>
        <input
          id={`pf-label-${mode}`}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          placeholder="ex. Mon fournisseur"
        />
      </div>
      <div className="field">
        <label htmlFor={`pf-url-${mode}`}>URL de base</label>
        <input
          id={`pf-url-${mode}`}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.currentTarget.value)}
          placeholder="https://…/v1"
        />
      </div>
      <label className="field field--checkbox" htmlFor={`pf-needskey-${mode}`}>
        <input
          id={`pf-needskey-${mode}`}
          type="checkbox"
          checked={needsKey}
          onChange={(e) => setNeedsKey(e.currentTarget.checked)}
        />
        <span>Clé API requise</span>
      </label>
      {/* R0 — sous-section routage OpenRouter (opt-in : rien d'envoyé si non renseigné). */}
      <p className="empty-hint">
        <strong>Routage OpenRouter (optionnel)</strong> — ces réglages sont transmis tels quels dans
        les requêtes de chat. Un serveur OpenAI-compatible strict pourrait les rejeter : dans ce cas,
        laissez-les simplement vides.
      </p>
      <div className="field">
        <label htmlFor={`pf-fallback-${mode}`}>Modèles de secours</label>
        <textarea
          id={`pf-fallback-${mode}`}
          rows={2}
          value={fallbackModelsText}
          onChange={(e) => setFallbackModelsText(e.currentTarget.value)}
          placeholder="ids séparés par des virgules ou retours ligne"
        />
        <p className="empty-hint">
          Essayés dans l'ordre si le modèle demandé est indisponible (rate-limit, contexte, panne).
        </p>
      </div>
      <label className="field field--checkbox" htmlFor={`pf-pricesort-${mode}`}>
        <input
          id={`pf-pricesort-${mode}`}
          type="checkbox"
          checked={priceSort}
          onChange={(e) => setPriceSort(e.currentTarget.checked)}
        />
        <span>Trier par prix</span>
      </label>
      <p className="empty-hint">Chaque appel part vers l'endpoint le moins cher du modèle.</p>
      <label className="field field--checkbox" htmlFor={`pf-usageacc-${mode}`}>
        <input
          id={`pf-usageacc-${mode}`}
          type="checkbox"
          checked={usageAccounting}
          onChange={(e) => setUsageAccounting(e.currentTarget.checked)}
        />
        <span>Comptabilité d'usage</span>
      </label>
      <p className="empty-hint">
        Historise le coût réel et les tokens servis depuis le cache (Supervision).
      </p>
      {idTaken && <div className="result-line result-line--error">Identifiant déjà utilisé.</div>}
      {error && <div className="result-line result-line--error">Erreur : {error}</div>}
      <div className="actions">
        <button type="submit" className="btn" disabled={!canSubmit || saving}>
          {saving ? "Enregistrement…" : mode === "add" ? "Ajouter" : "Enregistrer"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={saving}>
          Annuler
        </button>
      </div>
    </form>
  );
}

/* ---------- Carte fournisseur ---------- */

function ProviderCard({
  provider,
  keyConfigured,
  onEdit,
  onDelete,
  onSaveKey,
  onClearKey,
}: Readonly<{
  provider: ProviderConfig;
  keyConfigured: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSaveKey: (id: string, value: string) => Promise<void>;
  onClearKey: (id: string) => Promise<void>;
}>) {
  const [testState, setTestState] = useState<"idle" | "pending" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [keyInputOpen, setKeyInputOpen] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState("");

  async function handleTest() {
    setTestState("pending");
    setTestMessage("");
    try {
      const models = await modelsList(provider.id);
      // La liste des modèles est publique chez certains fournisseurs
      // (OpenRouter) : un test « vert » ne prouve pas que la clé est bonne.
      if (provider.needsKey && !keyConfigured) {
        setTestState("error");
        setTestMessage(
          `${models.length} modèle(s) trouvé(s), mais ⚠ aucune clé configurée : le chat échouera (401). Enregistrez votre clé API ci-dessous.`,
        );
        return;
      }
      setTestState("ok");
      setTestMessage(`${models.length} modèle(s) trouvé(s)`);
    } catch (err) {
      setTestState("error");
      setTestMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveKey() {
    if (!keyValue.trim()) return;
    setKeyBusy(true);
    setKeyError("");
    try {
      await onSaveKey(provider.id, keyValue.trim());
      setKeyValue("");
      setKeyInputOpen(false);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setKeyBusy(false);
    }
  }

  async function handleClearKey() {
    setKeyBusy(true);
    setKeyError("");
    try {
      await onClearKey(provider.id);
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : String(err));
    } finally {
      setKeyBusy(false);
    }
  }

  const headerEntries = provider.headers ? Object.entries(provider.headers) : [];

  return (
    <article className="provider-card">
      <div className="provider-card__head">
        <div>
          <span className="provider-card__label">{provider.label}</span>
          <span className="provider-card__id">{provider.id}</span>
        </div>
        <span
          className={`provider-card__needs-key provider-card__needs-key--${provider.needsKey ? "yes" : "no"}`}
        >
          {provider.needsKey ? "Clé requise" : "Sans clé"}
        </span>
      </div>

      <div className="provider-card__url">{provider.baseUrl}</div>

      {headerEntries.length > 0 && (
        <div className="provider-card__headers">
          {headerEntries.map(([k, v]) => `${k}: ${v}`).join(" · ")}
        </div>
      )}

      {provider.needsKey && (
        <div className="provider-card__key">
          <span className={keyConfigured ? "result-line result-line--ok" : "result-line"}>
            {keyConfigured ? "Clé configurée" : "Clé absente"}
          </span>
          {keyInputOpen ? (
            <div className="actions">
              <input
                type="password"
                value={keyValue}
                onChange={(e) => setKeyValue(e.currentTarget.value)}
                placeholder="sk-…"
                autoComplete="off"
              />
              <button className="btn" onClick={() => void handleSaveKey()} disabled={keyBusy || !keyValue.trim()}>
                Enregistrer
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setKeyInputOpen(false);
                  setKeyValue("");
                }}
                disabled={keyBusy}
              >
                Annuler
              </button>
            </div>
          ) : (
            <div className="actions">
              <button className="btn btn--ghost" onClick={() => setKeyInputOpen(true)} disabled={keyBusy}>
                {keyConfigured ? "Remplacer la clé" : "Renseigner la clé"}
              </button>
              {keyConfigured && (
                <button className="btn btn--ghost" onClick={() => void handleClearKey()} disabled={keyBusy}>
                  Effacer la clé
                </button>
              )}
            </div>
          )}
          {keyError && <div className="result-line result-line--error">Erreur : {keyError}</div>}
        </div>
      )}

      <div className="actions provider-card__actions">
        <button className="btn" onClick={() => void handleTest()} disabled={testState === "pending"}>
          {testState === "pending" ? "Test…" : "Tester"}
        </button>
        <button className="btn btn--ghost" onClick={onEdit}>
          Modifier
        </button>
        <button className="btn btn--ghost" onClick={onDelete}>
          Supprimer
        </button>
      </div>
      {testState !== "idle" && (
        <div
          className={`result-line ${
            testState === "ok" ? "result-line--ok" : testState === "error" ? "result-line--error" : ""
          }`}
        >
          {testState === "pending" ? "Test en cours…" : testMessage}
        </div>
      )}
    </article>
  );
}

/* ---------- Section Modèles OpenRouter ---------- */

type ModelsLoadState = "idle" | "loading" | "ready" | "error";
type ModelSortKey = "name" | "price-in" | "price-out" | "context";

const MODEL_SORT_OPTIONS: { value: ModelSortKey; label: string }[] = [
  { value: "name", label: "Nom" },
  { value: "price-in", label: "Prix entrée ↑" },
  { value: "price-out", label: "Prix sortie ↑" },
  { value: "context", label: "Contexte ↓" },
];

/** "3 $ / 15 $ /M" ou "—" si aucune des deux valeurs n'est connue. */
function formatPricing(pricing?: ModelDetail["pricing"]): string {
  const fmt = (n?: number) => (n === undefined ? "—" : `${Math.round(n * 100) / 100} $`);
  if (!pricing || (pricing.promptUsdPerM === undefined && pricing.completionUsdPerM === undefined)) return "—";
  return `${fmt(pricing.promptUsdPerM)} / ${fmt(pricing.completionUsdPerM)} /M`;
}

/** "200k" ou "—" si inconnu. */
function formatContext(n?: number): string {
  if (!n) return "—";
  return n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
}

function sortModels(models: ModelDetail[], key: ModelSortKey): ModelDetail[] {
  const withFallback = (n: number | undefined, fallback: number) => (n === undefined ? fallback : n);
  const sorted = [...models];
  switch (key) {
    case "price-in":
      sorted.sort((a, b) => withFallback(a.pricing?.promptUsdPerM, Infinity) - withFallback(b.pricing?.promptUsdPerM, Infinity));
      break;
    case "price-out":
      sorted.sort(
        (a, b) => withFallback(a.pricing?.completionUsdPerM, Infinity) - withFallback(b.pricing?.completionUsdPerM, Infinity),
      );
      break;
    case "context":
      sorted.sort((a, b) => withFallback(b.contextLength, 0) - withFallback(a.contextLength, 0));
      break;
    case "name":
    default:
      sorted.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }
  return sorted;
}

function ModelRow({
  model,
  isFavorite,
  onToggleFavorite,
}: Readonly<{
  model: ModelDetail;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
}>) {
  const bench = matchBenchNote(model.id);
  return (
    <article className="model-row" title={model.description || undefined}>
      <button
        type="button"
        className={`model-star${isFavorite ? " model-star--active" : ""}`}
        onClick={() => onToggleFavorite(model.id)}
        aria-label={isFavorite ? `Retirer ${model.id} des favoris` : `Ajouter ${model.id} aux favoris`}
      >
        {isFavorite ? "★" : "☆"}
      </button>
      <span className="model-row__id">{model.name ?? model.id}</span>
      <span className="model-row__price">{formatPricing(model.pricing)}</span>
      <span className="model-row__context">{formatContext(model.contextLength)}</span>
      {bench && (
        <span className="model-row__bench" title={bench}>
          {bench}
        </span>
      )}
    </article>
  );
}

function OpenRouterModelsSection({
  providers,
  keyStatus,
  active,
}: Readonly<{
  providers: ProviderConfig[];
  keyStatus: Record<string, boolean>;
  /** Onglet « Modèles OpenRouter » actuellement affiché — déclenche le chargement la première fois qu'il l'est (voir l'effet ci-dessous), pas à chaque bascule d'onglet. */
  active: boolean;
}>) {
  const provider = providers.find((p) => p.id === OPENROUTER_PROVIDER_ID);
  const keyConfigured = keyStatus[OPENROUTER_PROVIDER_ID] ?? false;

  const [loadState, setLoadState] = useState<ModelsLoadState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [models, setModels] = useState<ModelDetail[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<ModelSortKey>("name");
  const fetchedOnce = useRef(false);

  useEffect(() => {
    // Les favoris (juste des ids persistés) sont peu coûteux à lire : indépendant
    // du premier affichage, contrairement à modelsDetail (requête réseau OpenRouter).
    readFeatured(OPENROUTER_PROVIDER_ID)
      .then(setFavorites)
      .catch(() => setFavorites([]));
  }, []);

  async function loadModels() {
    if (!provider) {
      setLoadState("error");
      setErrorMessage(`Fournisseur « ${OPENROUTER_PROVIDER_ID} » non configuré (voir la section Fournisseurs).`);
      return;
    }
    if (provider.needsKey && !keyConfigured) {
      setLoadState("error");
      setErrorMessage("Clé API absente : renseignez-la dans la section Fournisseurs pour charger les tarifs des modèles.");
      return;
    }
    setLoadState("loading");
    setErrorMessage("");
    try {
      const list = await modelsDetail(OPENROUTER_PROVIDER_ID);
      setModels(list);
      setLoadState("ready");
    } catch (err) {
      setLoadState("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  // Section montée en permanence (masquée via CSS par le parent, voir
  // `configPanelClass`) : le catalogue ne doit se charger qu'à son PREMIER
  // affichage, pas à chaque bascule d'onglet — d'où ce garde-fou par ref
  // plutôt qu'un chargement au montage. `loadModels` volontairement absent
  // des deps (même convention que le reste du fichier, voir les autres
  // `eslint-disable-next-line react-hooks/exhaustive-deps`) : la ref
  // `fetchedOnce` garantit un seul déclenchement, peu importe l'identité de
  // la fonction d'un rendu à l'autre.
  useEffect(() => {
    if (active && !fetchedOnce.current) {
      fetchedOnce.current = true;
      void loadModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function handleToggleFavorite(modelId: string) {
    const next = await toggleFeatured(OPENROUTER_PROVIDER_ID, modelId);
    setFavorites(next);
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? models.filter((m) => m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q))
    : models;
  const sorted = sortModels(filtered, sortKey);

  return (
    <section className="config-section">
      <div className="model-catalog">
        <h2 className="config-section__title">Modèles OpenRouter</h2>
        <p className="empty-hint">
          Modèles OpenRouter mis en avant : favoris persistés, tarifs $/million de tokens et repères de
          performance indicatifs (voir les sélecteurs de modèles du Chat et de l'Agent).
        </p>

        {favorites.length > 0 && (
          <div className="model-favorites-row">
            {favorites.map((id) => (
              <button
                key={id}
                type="button"
                className="model-chip model-chip--active"
                onClick={() => void handleToggleFavorite(id)}
                title="Retirer des favoris"
              >
                ★ {id}
              </button>
            ))}
          </div>
        )}

        {loadState === "idle" && <p className="empty-hint">En attente d'affichage…</p>}
        {loadState === "loading" && <p className="empty-hint">Chargement…</p>}
        {loadState === "error" && (
          <div className="result-line result-line--error model-catalog__error">
            <span>{errorMessage}</span>
            <button type="button" className="btn btn--ghost" onClick={() => void loadModels()}>
              Réessayer
            </button>
          </div>
        )}

        {loadState === "ready" && (
          <>
            <div className="model-catalog__toolbar">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder="Rechercher (id, nom)…"
                aria-label="Rechercher un modèle"
              />
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.currentTarget.value as ModelSortKey)}
                aria-label="Trier les modèles"
              >
                {MODEL_SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn--ghost" onClick={() => void loadModels()}>
                Rafraîchir
              </button>
            </div>

            <div className="model-list">
              {sorted.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  isFavorite={favorites.includes(m.id)}
                  onToggleFavorite={(id) => void handleToggleFavorite(id)}
                />
              ))}
              {sorted.length === 0 && <p className="empty-hint">Aucun modèle ne correspond à la recherche.</p>}
            </div>
          </>
        )}

        <p className="model-catalog__disclaimer">{BENCH_DISCLAIMER}</p>
      </div>
    </section>
  );
}

/* ---------- Section Applications (Lot 5) ---------- */

type AppsLoadState = "loading" | "ready" | "error";

interface AppFormValues {
  label: string;
  command: string;
  extensionsRaw: string;
}

function AppForm({
  mode,
  initial,
  onSubmit,
  onCancel,
}: Readonly<{
  mode: "add" | "edit";
  initial?: AppFormValues;
  onSubmit: (values: { label: string; command: string; extensions: string[] }) => Promise<void>;
  onCancel: () => void;
}>) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [extensionsRaw, setExtensionsRaw] = useState(initial?.extensionsRaw ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canSubmit = label.trim().length > 0 && command.trim().length > 0;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSubmit({
        label: label.trim(),
        command: command.trim(),
        extensions: parseExtensions(extensionsRaw),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="app-form" onSubmit={(e) => void handleSubmit(e)}>
      <div className="field">
        <label htmlFor={`af-label-${mode}`}>Libellé</label>
        <input
          id={`af-label-${mode}`}
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          placeholder="ex. KiCad"
        />
      </div>
      <div className="field">
        <label htmlFor={`af-command-${mode}`}>Commande</label>
        <input
          id={`af-command-${mode}`}
          value={command}
          onChange={(e) => setCommand(e.currentTarget.value)}
          placeholder="ex. kicad"
        />
      </div>
      <div className="field">
        <label htmlFor={`af-ext-${mode}`}>Extensions</label>
        <input
          id={`af-ext-${mode}`}
          value={extensionsRaw}
          onChange={(e) => setExtensionsRaw(e.currentTarget.value)}
          placeholder="ex. kicad_pcb, kicad_sch pdf"
        />
      </div>
      {error && <div className="result-line result-line--error">Erreur : {error}</div>}
      <div className="actions">
        <button type="submit" className="btn" disabled={!canSubmit || saving}>
          {saving ? "Enregistrement…" : mode === "add" ? "Ajouter" : "Enregistrer"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={saving}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function AppCard({
  app,
  onEdit,
  onDelete,
}: Readonly<{
  app: AppEntry;
  onEdit: () => void;
  onDelete: () => void;
}>) {
  return (
    <article className="app-card">
      <div className="app-card__head">
        <span className="app-card__label">{app.label}</span>
        <div className="actions">
          <button type="button" className="btn btn--ghost" onClick={onEdit} aria-label={`Modifier ${app.label}`} title="Modifier">
            ✎
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onDelete}
            aria-label={`Supprimer ${app.label}`}
            title="Supprimer"
          >
            Supprimer
          </button>
        </div>
      </div>
      <div className="app-card__command">{app.command}</div>
      <div className="app-card__extensions">
        {app.extensions.length === 0 ? (
          <span className="empty-hint">Aucune extension associée.</span>
        ) : (
          app.extensions.map((ext) => (
            <span className="app-extension-badge" key={ext}>
              .{ext}
            </span>
          ))
        )}
      </div>
    </article>
  );
}

/* ---------- Section Routage automatique (R1, « model: auto ») ---------- */

const ROUTING_TIER_LABELS: Record<RouteTier, string> = {
  trivial: "Trivial",
  simple: "Simple",
  moyen: "Moyen",
  complexe: "Complexe",
};

/** Modèles Claude proposés dans la datalist du moteur abonnement (mêmes ids que ChatPage). */
const ROUTING_CLAUDE_MODELS = [
  "claude-fable-5",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-haiku-4-5",
];

/** Une ligne du formulaire (un tier) — providerId ignoré quand engine = claude. */
interface RoutingRowState {
  engine: "claude" | "neutral";
  providerId: string;
  model: string;
}

function toRoutingRow(target: RouteTarget): RoutingRowState {
  return { engine: target.engine, providerId: target.providerId ?? "", model: target.model };
}

function fromRoutingRow(row: RoutingRowState): RouteTarget {
  return row.engine === "neutral"
    ? { engine: "neutral", providerId: row.providerId, model: row.model.trim() }
    : { engine: "claude", model: row.model.trim() };
}

/**
 * Table de routage du sélecteur « Auto (routeur) » du Chat : 4 lignes
 * (trivial/simple/moyen/complexe), chacune moteur + fournisseur (si neutre)
 * + modèle (saisie libre avec datalist des modèles connus du fournisseur).
 * Enregistrer = écrire la config (routerAdmin) + pousser au sidecar
 * (`router.set`). `active` : les datalists de modèles ne sont chargées qu'au
 * premier affichage de l'onglet (même principe que OpenRouterModelsSection).
 */
function RoutingSection({
  providers,
  active,
}: Readonly<{ providers: ProviderConfig[]; active: boolean }>) {
  const [rows, setRows] = useState<Record<RouteTier, RoutingRowState> | null>(null);
  // R2 — classificateur LLM des scores ambigus : provider + modèle, avec case
  // « désactiver » (`enabled: false` ⇒ `classifier: null` poussé au sidecar).
  const [classifierRow, setClassifierRow] = useState<{
    enabled: boolean;
    providerId: string;
    model: string;
  } | null>(null);
  // R4 — résumeur (compaction d'historique) : par défaut il SUIT le
  // classificateur (champs vides ⇒ clé `summarizer` omise) ; provider +
  // modèle remplis = cible dédiée ; case « Désactiver la compaction
  // automatique » cochée ⇒ `summarizer: null` persisté (aucun nouveau résumé,
  // envoi intégral de l'historique). Clé UI seule : rien n'est poussé au
  // sidecar (`context.compact` reçoit providerId/model en paramètres).
  const [summarizerRow, setSummarizerRow] = useState<{
    enabled: boolean;
    providerId: string;
    model: string;
  } | null>(null);
  // R3 — débord d'abonnement : cible payante + seuil fenêtre 5 h + plafond
  // mensuel (saisies texte, validées à l'enregistrement ; plafond vide = sans
  // plafond, poussé `null` au sidecar). R6 — `enabled: false` (case
  // « Désactiver la bascule payante automatique » cochée) ⇒ `debord: null`
  // persisté et poussé au sidecar (débord entièrement désactivé).
  const [debordRow, setDebordRow] = useState<{
    enabled: boolean;
    engine: "claude" | "neutral";
    providerId: string;
    model: string;
    seuilPct: string;
    plafond: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  // Ids de modèles par fournisseur (datalist, best effort — un fournisseur
  // muet laisse simplement la saisie libre).
  const [modelIdsByProvider, setModelIdsByProvider] = useState<Record<string, string[]>>({});
  const [activated, setActivated] = useState(false);

  useEffect(() => {
    if (active) setActivated(true);
  }, [active]);

  // Chargement initial de la table + du classificateur (config fusionnée avec
  // les défauts).
  useEffect(() => {
    let cancelled = false;
    Promise.all([readRoutingTable(), readRoutingClassifier(), readRoutingDebord(), readRoutingSummarizer()])
      .then(([partial, classifier, debord, summarizer]) => {
        if (cancelled) return;
        const table = mergeRoutingTable(partial);
        setRows({
          trivial: toRoutingRow(table.trivial),
          simple: toRoutingRow(table.simple),
          moyen: toRoutingRow(table.moyen),
          complexe: toRoutingRow(table.complexe),
        });
        // `undefined` = jamais configuré → défaut du sidecar, activé.
        // Non configuré = désactivé (défaut 2026-07-29) ; les valeurs suggérées restent préremplies.
        const effective = classifier === undefined ? null : classifier;
        setClassifierRow(
          effective === null
            ? { enabled: false, ...DEFAULT_CLASSIFIER }
            : { enabled: true, providerId: effective.providerId, model: effective.model },
        );
        // R4 — résumeur : `undefined` = suit le classificateur (champs
        // vides), `null` = compaction automatique désactivée (case cochée).
        setSummarizerRow(
          summarizer === null
            ? { enabled: false, providerId: "", model: "" }
            : summarizer === undefined
              ? { enabled: true, providerId: "", model: "" }
              : { enabled: true, providerId: summarizer.providerId, model: summarizer.model },
        );
        // R3 — débord (déjà fusionné avec les défauts par readRoutingDebord).
        // R6 — `null` = bascule payante désactivée : case cochée, champs
        // pré-remplis avec les défauts (réactivables d'un clic).
        const effectiveDebord = debord ?? DEFAULT_DEBORD;
        setDebordRow({
          enabled: debord !== null,
          engine: effectiveDebord.target.engine,
          providerId: effectiveDebord.target.providerId ?? "",
          model: effectiveDebord.target.model,
          seuilPct: String(effectiveDebord.seuilPct),
          plafond: effectiveDebord.plafondUsdMois === null ? "" : String(effectiveDebord.plafondUsdMois),
        });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Modèles connus de chaque fournisseur déclaré (datalists) — chargés au
  // premier affichage puis rafraîchis à chaque push de la table providers
  // (le premier essai part souvent avant providers.set au démarrage).
  useEffect(() => {
    if (!activated) return;
    let cancelled = false;
    async function loadAll() {
      for (const provider of providers) {
        try {
          const list = await modelsList(provider.id);
          if (cancelled) return;
          setModelIdsByProvider((prev) => ({ ...prev, [provider.id]: list.map((m) => m.id) }));
        } catch {
          // fournisseur injoignable : datalist absente, saisie libre.
        }
      }
    }
    void loadAll();
    const off = subscribeProvidersPushed(() => void loadAll());
    return () => {
      cancelled = true;
      off();
    };
  }, [activated, providers]);

  function updateRow(tier: RouteTier, patch: Partial<RoutingRowState>) {
    setSaved(false);
    setRows((prev) => (prev ? { ...prev, [tier]: { ...prev[tier], ...patch } } : prev));
  }

  function updateClassifierRow(patch: Partial<{ enabled: boolean; providerId: string; model: string }>) {
    setSaved(false);
    setClassifierRow((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function updateSummarizerRow(patch: Partial<{ enabled: boolean; providerId: string; model: string }>) {
    setSaved(false);
    setSummarizerRow((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function updateDebordRow(
    patch: Partial<{
      enabled: boolean;
      engine: "claude" | "neutral";
      providerId: string;
      model: string;
      seuilPct: string;
      plafond: string;
    }>,
  ) {
    setSaved(false);
    setDebordRow((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  // R3 — seuil : nombre > 0 requis ; plafond : vide (= sans plafond) ou nombre ≥ 0.
  // R6 — débord désactivé : les champs ne sont pas validés (ils ne partent pas).
  const debordValid =
    debordRow !== null &&
    (!debordRow.enabled ||
      (debordRow.model.trim().length > 0 &&
        (debordRow.engine === "claude" || debordRow.providerId.length > 0) &&
        Number.isFinite(Number(debordRow.seuilPct)) &&
        Number(debordRow.seuilPct) > 0 &&
        (debordRow.plafond.trim() === "" ||
          (Number.isFinite(Number(debordRow.plafond)) && Number(debordRow.plafond) >= 0))));

  const canSave =
    rows !== null &&
    ROUTE_TIERS.every((tier) => {
      const row = rows[tier];
      return row.model.trim().length > 0 && (row.engine === "claude" || row.providerId.length > 0);
    }) &&
    classifierRow !== null &&
    (!classifierRow.enabled ||
      (classifierRow.providerId.length > 0 && classifierRow.model.trim().length > 0)) &&
    // R4 — résumeur : champs vides = suit le classificateur (valide) ; un
    // modèle saisi exige un fournisseur choisi.
    summarizerRow !== null &&
    (!summarizerRow.enabled ||
      summarizerRow.model.trim().length === 0 ||
      summarizerRow.providerId.length > 0) &&
    debordValid;

  async function handleSave() {
    if (!rows || !classifierRow || !summarizerRow || !debordRow || !canSave || saving) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const table: Partial<RoutingTable> = {};
      for (const tier of ROUTE_TIERS) {
        table[tier] = fromRoutingRow(rows[tier]);
      }
      const classifier: ClassifierConfig | null = classifierRow.enabled
        ? { providerId: classifierRow.providerId, model: classifierRow.model.trim() }
        : null;
      // R3 — débord : cible + seuil + plafond (`null` = sans plafond).
      // R6 — case « Désactiver » cochée ⇒ `debord: null` persisté et poussé
      // (contrat sidecar : `null` = bascule payante automatique désactivée,
      // distinct de la clé absente = défauts).
      const debord: DebordConfig | null = debordRow.enabled
        ? {
            target: fromRoutingRow({ engine: debordRow.engine, providerId: debordRow.providerId, model: debordRow.model }),
            seuilPct: Number(debordRow.seuilPct),
            plafondUsdMois: debordRow.plafond.trim() === "" ? null : Number(debordRow.plafond),
          }
        : null;
      // R4 — résumeur : case cochée ⇒ `null` (compaction auto désactivée) ;
      // champs vides ⇒ "suivre" (clé omise, le résumeur suit le
      // classificateur) ; sinon cible dédiée. Clé UI seule, rien à pousser
      // au sidecar (pushRouting inchangé).
      const summarizer: SummarizerSetting = !summarizerRow.enabled
        ? null
        : summarizerRow.model.trim() && summarizerRow.providerId
          ? { providerId: summarizerRow.providerId, model: summarizerRow.model.trim() }
          : "suivre";
      await writeRoutingTable(table, classifier, debord, undefined, summarizer);
      await pushRouting(table, classifier, debord);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="config-section">
      <h2 className="config-section__title">Routage automatique (model: auto)</h2>
      <p className="empty-hint">
        Table du sélecteur « Auto » : chaque niveau de complexité part vers ce moteur/modèle. Un
        projet peut la surcharger via son fichier .iaction/routage.yaml.
      </p>

      {error && <div className="result-line result-line--error">Erreur : {error}</div>}

      {rows === null ? (
        <p className="empty-hint">Chargement…</p>
      ) : (
        <>
          {ROUTE_TIERS.map((tier) => {
            const row = rows[tier];
            const label = ROUTING_TIER_LABELS[tier];
            const datalistId = `routing-models-${tier}`;
            const modelOptions =
              row.engine === "claude"
                ? ROUTING_CLAUDE_MODELS
                : (modelIdsByProvider[row.providerId] ?? []);
            return (
              <div className="routing-row" key={tier}>
                <span className="routing-row__tier">{label}</span>
                <select
                  aria-label={`Moteur du niveau ${label}`}
                  value={row.engine}
                  onChange={(e) => {
                    const engine = e.currentTarget.value === "neutral" ? "neutral" : "claude";
                    updateRow(tier, {
                      engine,
                      // Bascule vers neutre sans fournisseur mémorisé : proposer le premier déclaré.
                      ...(engine === "neutral" && !row.providerId
                        ? { providerId: providers[0]?.id ?? "" }
                        : {}),
                    });
                  }}
                >
                  <option value="claude">Claude (abonnement)</option>
                  <option value="neutral">Fournisseur neutre</option>
                </select>
                {row.engine === "neutral" && (
                  <select
                    aria-label={`Fournisseur du niveau ${label}`}
                    value={row.providerId}
                    onChange={(e) => updateRow(tier, { providerId: e.currentTarget.value })}
                  >
                    {/* Fournisseur configuré mais plus déclaré : gardé visible (le Chat replie de toute façon). */}
                    {row.providerId && !providers.some((p) => p.id === row.providerId) && (
                      <option value={row.providerId}>{row.providerId} (absent)</option>
                    )}
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  aria-label={`Modèle du niveau ${label}`}
                  list={datalistId}
                  value={row.model}
                  onChange={(e) => updateRow(tier, { model: e.currentTarget.value })}
                  placeholder="id du modèle"
                />
                <datalist id={datalistId}>
                  {modelOptions.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </div>
            );
          })}

          {/* R2 — classificateur LLM local : consulté seulement quand le score
              heuristique hésite (±1 d'une frontière de tier), timeout 3 s,
              repli heuristique silencieux. */}
          {classifierRow && (
            <>
              <p className="empty-hint">
                Classificateur LLM : quand le score heuristique hésite, un petit modèle local tranche
                le niveau (timeout 3 s, repli heuristique).
              </p>
              <div className="routing-row">
                <span className="routing-row__tier">Classificateur</span>
                <select
                  aria-label="Fournisseur du classificateur LLM"
                  value={classifierRow.providerId}
                  disabled={!classifierRow.enabled}
                  onChange={(e) => updateClassifierRow({ providerId: e.currentTarget.value })}
                >
                  {/* Fournisseur configuré mais plus déclaré : gardé visible (repli heuristique côté sidecar). */}
                  {classifierRow.providerId &&
                    !providers.some((p) => p.id === classifierRow.providerId) && (
                      <option value={classifierRow.providerId}>{classifierRow.providerId} (absent)</option>
                    )}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Modèle du classificateur LLM"
                  list="routing-models-classifier"
                  value={classifierRow.model}
                  disabled={!classifierRow.enabled}
                  onChange={(e) => updateClassifierRow({ model: e.currentTarget.value })}
                  placeholder="id du modèle"
                />
                <datalist id="routing-models-classifier">
                  {(modelIdsByProvider[classifierRow.providerId] ?? []).map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </div>
              <label className="field field--checkbox" htmlFor="routing-classifier-disabled">
                <input
                  id="routing-classifier-disabled"
                  type="checkbox"
                  checked={!classifierRow.enabled}
                  onChange={(e) => updateClassifierRow({ enabled: !e.currentTarget.checked })}
                />
                <span>Désactiver le classificateur (heuristique seule)</span>
              </label>
            </>
          )}

          {/* R4 — résumeur (compaction d'historique) : par défaut il suit le
              classificateur ; réglage dédié pour ne pas envoyer les
              historiques complets à un classificateur payant. */}
          {summarizerRow && (
            <>
              <p className="empty-hint">
                Résumeur (compaction d'historique) : par défaut, le résumeur suit le classificateur
                ci-dessus. Pointer le classificateur vers un modèle payant SANS régler le résumeur
                enverrait les historiques complets au payant — choisissez ici une cible dédiée
                (champs vides = suivre le classificateur).
              </p>
              <div className="routing-row">
                <span className="routing-row__tier">Résumeur</span>
                <select
                  aria-label="Fournisseur du résumeur de compaction"
                  value={summarizerRow.providerId}
                  disabled={!summarizerRow.enabled}
                  onChange={(e) => updateSummarizerRow({ providerId: e.currentTarget.value })}
                >
                  <option value="">(suivre le classificateur)</option>
                  {/* Fournisseur configuré mais plus déclaré : gardé visible (pas de compaction côté Chat). */}
                  {summarizerRow.providerId &&
                    !providers.some((p) => p.id === summarizerRow.providerId) && (
                      <option value={summarizerRow.providerId}>{summarizerRow.providerId} (absent)</option>
                    )}
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Modèle du résumeur de compaction"
                  list="routing-models-summarizer"
                  value={summarizerRow.model}
                  disabled={!summarizerRow.enabled}
                  onChange={(e) => updateSummarizerRow({ model: e.currentTarget.value })}
                  placeholder="vide = suit le classificateur"
                />
                <datalist id="routing-models-summarizer">
                  {(modelIdsByProvider[summarizerRow.providerId] ?? []).map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </div>
              <label className="field field--checkbox" htmlFor="routing-summarizer-disabled">
                <input
                  id="routing-summarizer-disabled"
                  type="checkbox"
                  checked={!summarizerRow.enabled}
                  onChange={(e) => updateSummarizerRow({ enabled: !e.currentTarget.checked })}
                />
                <span>Désactiver la compaction automatique (envoi intégral de l'historique)</span>
              </label>
            </>
          )}

          {/* R3 — débord d'abonnement : cible payante quand la fenêtre 5 h de
              l'abonnement dépasse le seuil, plafonnée au mois (voir
              docs/spec-r3-debord.md). */}
          {debordRow && (
            <>
              <p className="empty-hint">
                Débord d'abonnement : quand la fenêtre 5 h dépasse le seuil, les tours « Auto » visant
                l'abonnement partent vers cette cible, dans la limite du plafond mensuel (vide = sans
                plafond). Le plafond s'appuie sur les coûts réels historisés — activer « Comptabilité
                d'usage » sur le fournisseur de débord.
              </p>
              <div className="routing-row">
                <span className="routing-row__tier">Débord</span>
                <select
                  aria-label="Moteur de la cible de débord"
                  value={debordRow.engine}
                  disabled={!debordRow.enabled}
                  onChange={(e) => {
                    const engine = e.currentTarget.value === "neutral" ? "neutral" : "claude";
                    updateDebordRow({
                      engine,
                      ...(engine === "neutral" && !debordRow.providerId
                        ? { providerId: providers[0]?.id ?? "" }
                        : {}),
                    });
                  }}
                >
                  <option value="claude">Claude (abonnement)</option>
                  <option value="neutral">Fournisseur neutre</option>
                </select>
                {debordRow.engine === "neutral" && (
                  <select
                    aria-label="Fournisseur de la cible de débord"
                    value={debordRow.providerId}
                    disabled={!debordRow.enabled}
                    onChange={(e) => updateDebordRow({ providerId: e.currentTarget.value })}
                  >
                    {/* Fournisseur configuré mais plus déclaré : gardé visible (défaut openrouter avant déclaration). */}
                    {debordRow.providerId && !providers.some((p) => p.id === debordRow.providerId) && (
                      <option value={debordRow.providerId}>{debordRow.providerId} (absent)</option>
                    )}
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  aria-label="Modèle de la cible de débord"
                  list="routing-models-debord"
                  value={debordRow.model}
                  disabled={!debordRow.enabled}
                  onChange={(e) => updateDebordRow({ model: e.currentTarget.value })}
                  placeholder="id du modèle"
                />
                <datalist id="routing-models-debord">
                  {(debordRow.engine === "claude"
                    ? ROUTING_CLAUDE_MODELS
                    : (modelIdsByProvider[debordRow.providerId] ?? [])
                  ).map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </div>
              <div className="routing-row">
                <span className="routing-row__tier">Seuil / plafond</span>
                <label className="field field--inline" htmlFor="routing-debord-seuil">
                  <span>Seuil fenêtre 5 h (%)</span>
                  <input
                    id="routing-debord-seuil"
                    inputMode="numeric"
                    value={debordRow.seuilPct}
                    disabled={!debordRow.enabled}
                    onChange={(e) => updateDebordRow({ seuilPct: e.currentTarget.value })}
                    placeholder={String(DEFAULT_DEBORD.seuilPct)}
                  />
                </label>
                <label className="field field--inline" htmlFor="routing-debord-plafond">
                  <span>Plafond mensuel ($)</span>
                  <input
                    id="routing-debord-plafond"
                    inputMode="decimal"
                    value={debordRow.plafond}
                    disabled={!debordRow.enabled}
                    onChange={(e) => updateDebordRow({ plafond: e.currentTarget.value })}
                    placeholder="vide = sans"
                  />
                </label>
              </div>
              {/* R6 — cochée ⇒ `debord: null` persisté/poussé au sidecar :
                  plus AUCUNE bascule payante automatique (même patron que la
                  case du classificateur ci-dessus). */}
              <label className="field field--checkbox" htmlFor="routing-debord-disabled">
                <input
                  id="routing-debord-disabled"
                  type="checkbox"
                  checked={!debordRow.enabled}
                  onChange={(e) => updateDebordRow({ enabled: !e.currentTarget.checked })}
                />
                <span>Désactiver la bascule payante automatique</span>
              </label>
              {!debordValid && (
                <p className="empty-hint">
                  Débord : seuil numérique &gt; 0 requis ; plafond vide ou numérique ≥ 0.
                </p>
              )}
            </>
          )}

          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => void handleSave()}
              disabled={!canSave || saving}
            >
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
            {saved && (
              <span className="result-line result-line--ok">Table enregistrée et poussée au sidecar.</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function AppsSection() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loadState, setLoadState] = useState<AppsLoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    // StrictMode-safe : même pattern que useProjects/useProviders (voir leur en-tête).
    if (initialized.current) return;
    initialized.current = true;
    readApps()
      .then((list) => {
        setApps(list);
        setLoadState("ready");
      })
      .catch((err: unknown) => {
        setErrorMessage(err instanceof Error ? err.message : String(err));
        setLoadState("error");
      });
  }, []);

  const editingApp = apps.find((a) => a.id === editingId) ?? null;

  return (
    <section className="config-section">
      <h2 className="config-section__title">Applications</h2>
      <p className="empty-hint">
        Ouvrir un fichier de l'arborescence avec une application externe (KiCad, LibreOffice…),
        selon son extension. Sans règle correspondante, IAction utilise l'application système
        par défaut (xdg-open sous Linux).
      </p>

      {loadState === "loading" && <p className="empty-hint">Chargement…</p>}
      {loadState === "error" && (
        <div className="result-line result-line--error">Erreur de chargement : {errorMessage}</div>
      )}

      <div className="app-list">
        {apps.map((app) =>
          editingId === app.id && editingApp ? (
            <article className="app-card" key={app.id}>
              <AppForm
                mode="edit"
                initial={{ label: editingApp.label, command: editingApp.command, extensionsRaw: editingApp.extensions.join(", ") }}
                onSubmit={async (values) => {
                  const next = await updateApp(app.id, values);
                  setApps(next);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            </article>
          ) : (
            <AppCard
              key={app.id}
              app={app}
              onEdit={() => setEditingId(app.id)}
              onDelete={() => {
                if (window.confirm(`Supprimer la règle « ${app.label} » ?`)) {
                  void deleteApp(app.id).then(setApps);
                }
              }}
            />
          ),
        )}
        {apps.length === 0 && loadState === "ready" && <p className="empty-hint">Aucune application déclarée.</p>}
      </div>

      {adding ? (
        <article className="app-card app-card--new">
          <AppForm
            mode="add"
            onSubmit={async (values) => {
              const next = await addApp(values.label, values.command, values.extensions);
              setApps(next);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </article>
      ) : (
        <div className="actions">
          <button className="btn" onClick={() => setAdding(true)}>
            + Ajouter une application
          </button>
        </div>
      )}
    </section>
  );
}

/* ---------- Section Clavier (navigation 100 % sans souris) ---------- */

interface ShortcutRow {
  /** Combinaisons équivalentes ou symétriques, séparées par « / » à l'affichage (ex. ↑ / ↓). */
  combos: string[][];
  action: string;
  note?: string;
}

interface ShortcutGroup {
  title: string;
  intro: string;
  rows: ShortcutRow[];
}

/**
 * Toute la navigation clavier, par thème. Sources : écouteur global et cycle
 * F6 dans App.tsx, useRovingFocus.ts (listes/onglets), FileTree.tsx (arbre),
 * Modal.tsx (<dialog>), composeurs d'AgentPage/ChatPage, CommandPalette.tsx.
 */
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation globale",
    intro:
      "Raccourcis actifs partout, même pendant la frappe d'un message. Ctrl+N et Ctrl+K restent sans effet tant qu'une réponse est en cours d'écriture.",
    rows: [
      {
        combos: [["Ctrl", "1"]],
        action: "Aller à une page par son numéro (1 à 6)",
        note: "Ctrl+1 Projets · 2 Chat · 3 Orchestration · 4 Supervision · 5 Configuration · 6 Système. Fonctionne au pavé numérique comme à la rangée de chiffres, verrouillage numérique éteint compris.",
      },
      { combos: [["Ctrl", "P"]], action: "Aller à la page Projets" },
      { combos: [["Ctrl", "H"]], action: "Aller à la page Chat" },
      {
        combos: [["Ctrl", "N"]],
        action: "Nouvelle conversation",
        note: "Pages Projets et Chat : ouvre une nouvelle conversation dans un ONGLET supplémentaire, les conversations déjà ouvertes le restent (même action que le bouton « + » de la barre d'onglets).",
      },
      {
        combos: [
          ["Ctrl", "Tab"],
          ["Ctrl", "Maj", "Tab"],
        ],
        action: "Conversation suivante / précédente",
        note: "Pages Projets et Chat : fait défiler les onglets de conversation ouverts. Une conversation dont l'onglet n'est pas affiché continue de travailler — un point cyan sur son onglet signale qu'un tour est en cours.",
      },
      {
        combos: [["Ctrl", "Suppr"]],
        action: "Fermer l'onglet de conversation",
        note: "Pages Projets et Chat. L'HISTORIQUE EST CONSERVÉ : la conversation reste dans le panneau latéral (« Sessions »/« Historique ») et se rouvre d'un clic. Sa suppression définitive n'est possible que depuis ce panneau, avec confirmation. Refusé tant qu'un tour est en cours (un message l'indique) : arrêtez-le d'abord.",
      },
      {
        combos: [["Ctrl", "K"]],
        action: "Vider la conversation en cours",
        note: "Efface les messages de la session affichée (elle garde son nom, sa configuration et son id). Un bandeau « Annuler » permet de revenir en arrière juste après.",
      },
      {
        combos: [["Ctrl", "L"]],
        action: "Placer le curseur dans la zone de saisie",
        note: "Pages Projets et Chat. Le curseur y est déjà placé automatiquement à l'arrivée sur la page, après un vidage et après une nouvelle conversation.",
      },
      {
        combos: [["Ctrl", "S"]],
        action: "Enregistrer le fichier en cours d'édition",
        note: "Page Projets, quand un onglet de fichier est actif.",
      },
      {
        combos: [["Ctrl", "T"]],
        action: "Ouvrir un terminal",
        note: "Dans le répertoire du projet en cours si la page Projets est active, sinon dans le dossier personnel.",
      },
      {
        combos: [["Ctrl", "Maj", "P"]],
        action: "Ouvrir la palette de bascule de projet",
        note: "Voir la section « Palette de projet » ci-dessous.",
      },
    ],
  },
  {
    title: "Zones (F6 et Alt+flèches)",
    intro:
      "Deux façons de passer d'une zone de la page à l'autre. Une zone, c'est la navigation d'en-tête, chaque section dépliante des barres latérales (« LLM », « Historique », « Projet », « Fichiers », « Sessions »…), les collections qu'elles contiennent (liste de conversations, arborescence de fichiers), le fil de conversation, la zone de saisie et les panneaux de contenu. Une section repliée reste une zone : son en-tête reçoit le focus, Entrée la déplie. F6 est un parcours séquentiel cyclique ; Alt+flèche va directement au panneau voisin dans la direction indiquée. Alt+flèche fonctionne partout, y compris depuis un champ de texte ou l'éditeur de code — Alt ne servant pas à la sélection, le raccourci n'a rien à voler à la frappe. Une zone de lecture seule (fil de conversation, cette page de documentation, logs) reçoit le focus en tant que telle : les flèches, Page haut et Page bas la font alors défiler. Le découpage en zones s'adapte à la page affichée. Quand une modale est ouverte, ces raccourcis sont sans effet : le focus lui reste réservé.",
    rows: [
      {
        combos: [["F6"]],
        action: "Zone suivante",
        note: "Le parcours suit la page de haut en bas, de gauche à droite. Le focus se pose sur le premier élément de la zone, ou sur la zone elle-même quand elle n'en contient aucun.",
      },
      { combos: [["Maj", "F6"]], action: "Zone précédente" },
      {
        combos: [["F6"], ["Alt", "↓"]],
        action: "Atteindre la liste des conversations",
        note: "Page Chat : la section « Historique » est une zone, et la liste elle-même en est une autre — le focus s'y pose sur la conversation courante, sans traverser la section « LLM » champ par champ. Même principe pour « Sessions » sur la page Projets.",
      },
      {
        combos: [["F6"], ["Alt", "↓"]],
        action: "Atteindre l'arborescence de fichiers",
        note: "Page Projets : l'arborescence est une zone à part entière, atteinte directement sans traverser le reste de la barre latérale gauche. Le focus s'y pose sur le dernier élément parcouru ; le bouton « Rafraîchir » reste accessible par Maj+Tab. Section « Fichiers » repliée : la zone est simplement sautée.",
      },
      {
        combos: [
          ["Alt", "←"],
          ["Alt", "→"],
        ],
        action: "Zone voisine à gauche / à droite",
        note: "La zone retenue est la plus proche dans cette direction ; sans voisine de ce côté, rien ne bouge. Hors de toute zone, le focus entre par la première.",
      },
      {
        combos: [
          ["Alt", "↑"],
          ["Alt", "↓"],
        ],
        action: "Zone voisine au-dessus / en dessous",
      },
    ],
  },
  {
    title: "Listes, onglets et arborescence",
    intro:
      "Chaque collection (liste de sessions, onglets de fichiers, arborescence) ne compte qu'un seul arrêt de tabulation : Tab y entre puis en sort, les flèches se déplacent à l'intérieur.",
    rows: [
      {
        combos: [["↑"], ["↓"]],
        action: "Élément précédent / suivant",
        note: "Listes de sessions et arborescence de fichiers.",
      },
      {
        combos: [["←"], ["→"]],
        action: "Onglet précédent / suivant",
        note: "Onglets de fichiers ouverts (page Projets).",
      },
      { combos: [["Début"], ["Fin"]], action: "Premier / dernier élément" },
      {
        combos: [["→"]],
        action: "Ouvrir le dossier, puis descendre à son premier enfant",
        note: "Arborescence de fichiers.",
      },
      {
        combos: [["←"]],
        action: "Refermer le dossier, ou remonter au dossier parent",
        note: "Arborescence de fichiers.",
      },
      {
        combos: [["Entrée"]],
        action: "Ouvrir l'élément focusé",
        note: "Ouvre la session ou le fichier, active l'onglet (Espace fonctionne aussi sur les onglets et dans l'arborescence). Dans une liste de sessions, Tab atteint ensuite les boutons Renommer et Supprimer de la session focusée.",
      },
    ],
  },
  {
    title: "Menus",
    intro:
      "La barre principale des six pages et les sous-menus (Configuration, Orchestration, granularité de Supervision) se parcourent aux flèches. Le déplacement au clavier ne change PAS de page ni d'onglet : il faut valider avec Entrée ou Espace. Comme pour les autres collections, un seul arrêt de tabulation — l'élément actif — donc Tab traverse le menu au lieu de s'y arrêter six fois. Le bouton « Terminal » fait partie du parcours de la barre principale.",
    rows: [
      { combos: [["←"], ["→"]], action: "Élément de menu précédent / suivant", note: "Le parcours est circulaire." },
      { combos: [["Début"], ["Fin"]], action: "Premier / dernier élément du menu" },
      {
        combos: [["Entrée"], ["Espace"]],
        action: "Activer l'élément focusé",
        note: "Seule façon de changer de page ou d'onglet au clavier depuis un menu. Ctrl+1 à Ctrl+6 restent le raccourci direct vers une page.",
      },
    ],
  },
  {
    title: "Modales",
    intro:
      "Toutes les modales (formulaires d'orchestration, aperçu de pièce jointe…) gardent le focus pour elles : le reste de la page est inerte.",
    rows: [
      {
        combos: [["Échap"]],
        action: "Fermer la modale",
        note: "Le focus revient à l'élément qui l'avait ouverte.",
      },
      { combos: [["Tab"], ["Maj", "Tab"]], action: "Circuler entre les éléments, confiné à la modale" },
    ],
  },
  {
    title: "Zone de saisie",
    intro: "Dans le composeur des pages Projets et Chat.",
    rows: [
      { combos: [["Entrée"]], action: "Envoyer le message" },
      { combos: [["Maj", "Entrée"]], action: "Saut de ligne" },
      {
        combos: [["/"]],
        action: "Ouvrir le menu des commandes",
        note: "En début de ligne, dans le composeur de la page Projets.",
      },
      { combos: [["↑"], ["↓"]], action: "Naviguer dans le menu des commandes" },
      { combos: [["Entrée"], ["Tab"]], action: "Insérer la commande sélectionnée" },
      { combos: [["Échap"]], action: "Fermer le menu des commandes" },
    ],
  },
  {
    title: "Palette de projet",
    intro:
      "Ctrl+Maj+P ouvre, depuis n'importe quelle page, une palette de recherche pour basculer d'un projet à l'autre ; taper filtre la liste.",
    rows: [
      { combos: [["Ctrl", "Maj", "P"]], action: "Ouvrir ou fermer la palette" },
      { combos: [["↑"], ["↓"]], action: "Projet précédent / suivant" },
      {
        combos: [["Entrée"]],
        action: "Basculer vers le projet sélectionné",
        note: "Ouvre la page Projets. Refusé si un run est en cours (un message l'indique).",
      },
      { combos: [["Échap"]], action: "Fermer la palette" },
    ],
  },
];

function ShortcutKeys({ combos }: Readonly<{ combos: string[][] }>) {
  return (
    <span className="shortcut-keys">
      {combos.map((keys, c) => (
        // Combinaisons figées (pas de ré-ordonnancement) : l'index suffit comme clé.
        // eslint-disable-next-line react/no-array-index-key
        <span key={c} className="shortcut-keys__combo">
          {c > 0 && <span className="shortcut-keys__plus">/</span>}
          {keys.map((k, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <span key={i} className="shortcut-keys__combo">
              {i > 0 && <span className="shortcut-keys__plus">+</span>}
              <kbd>{k}</kbd>
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}

function ShortcutsSection() {
  return (
    <section className="config-section">
      <h2 className="config-section__title">Naviguer sans souris</h2>
      <p className="empty-hint">
        L'application se pilote entièrement au clavier : Tab et Maj+Tab passent d'un élément à l'autre (l'élément
        focusé est surligné d'un liseré cyan), F6 et Alt+flèches sautent de zone en zone, et les flèches circulent à l'intérieur des
        listes, onglets et arborescences. Les raccourcis globaux (Ctrl+…) sont neutralisés vis-à-vis du
        navigateur/webview (impression, nouvelle fenêtre…).
      </p>
      {SHORTCUT_GROUPS.map((group) => (
        <div className="shortcuts-group" key={group.title}>
          <h3 className="shortcuts-group__title">{group.title}</h3>
          <p className="empty-hint">{group.intro}</p>
          <div className="shortcuts-table-wrap">
            <table className="shortcuts-table">
              <thead>
                <tr>
                  <th scope="col">Touches</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.action}>
                    <td>
                      <ShortcutKeys combos={row.combos} />
                    </td>
                    <td>
                      {row.action}
                      {row.note && <div className="shortcuts-table__note">{row.note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

/* ---------- Section Voix (dictée STT / synthèse TTS) ---------- */

/** Modèles Whisper locaux proposés (ids attendus par le sidecar, voir le contrat speech). */
const WHISPER_MODELS: { id: string; label: string }[] = [
  { id: "onnx-community/whisper-tiny", label: "Whisper tiny (léger, moins précis)" },
  { id: "onnx-community/whisper-base", label: "Whisper base" },
  { id: "onnx-community/whisper-small", label: "Whisper small (recommandé)" },
  { id: "onnx-community/whisper-large-v3-turbo", label: "Whisper large-v3-turbo (précis, lourd)" },
];

const STT_LANGUAGES: { id: string; label: string }[] = [
  { id: "fr", label: "Français" },
  { id: "en", label: "Anglais" },
  { id: "", label: "Détection automatique" },
];

/**
 * Préréglages de service en mode distant : ils ne font que pré-remplir URL de
 * base + modèle, tous deux restant librement éditables. Rien n'est persisté en
 * plus — le préréglage courant est DÉDUIT de l'URL de base enregistrée
 * (`presetIdFor`), ce qui évite un champ de config supplémentaire à maintenir
 * cohérent avec l'URL et garde la rétrocompatibilité des configs existantes.
 */
interface ServicePreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
}

const STT_PRESETS: ServicePreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/whisper-large-v3-turbo",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-transcribe",
  },
];

const TTS_PRESETS: ServicePreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: OPENROUTER_TTS_DEFAULT_MODEL,
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-tts",
  },
];

/**
 * Identifiant du préréglage correspondant à une URL de base (`""` =
 * personnalisé). La normalisation vit dans speechAdmin (`normalizeBaseUrl`),
 * partagée avec la recherche automatique de fournisseur : une seule règle de
 * comparaison d'URL pour tout le domaine « voix ».
 */
function presetIdFor(presets: ServicePreset[], baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return presets.find((p) => normalizeBaseUrl(p.baseUrl) === normalized)?.id ?? "";
}

/** Select « Service » : applique URL de base + modèle du préréglage choisi. */
function ServicePresetField({
  id,
  presets,
  baseUrl,
  onApply,
}: Readonly<{
  id: string;
  presets: ServicePreset[];
  baseUrl: string;
  onApply: (preset: ServicePreset) => void;
}>) {
  const current = presetIdFor(presets, baseUrl);
  return (
    <div className="field">
      <label htmlFor={id}>Service</label>
      <select
        id={id}
        value={current}
        onChange={(e) => {
          const preset = presets.find((p) => p.id === e.currentTarget.value);
          if (preset) onApply(preset);
        }}
      >
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        {/* « Personnalisé » est un état DÉDUIT (l'URL ne correspond à aucun
            préréglage), pas un choix : on y arrive en éditant les champs, et
            le proposer à la sélection ne ferait rien. */}
        {current === "" && <option value="">Personnalisé</option>}
      </select>
    </div>
  );
}

/** Durée du test de dictée (enregistrement micro). */
const STT_TEST_DURATION_MS = 3000;
const TTS_TEST_SENTENCE = "Bonjour ! Ceci est un test de la synthèse vocale d'IAction.";

/** Sélecteur dont la valeur courante est toujours proposée, même hors liste (config éditée à la main). */
function voiceSelectOptions(options: { id: string; label: string }[], current: string) {
  const known = options.some((o) => o.id === current);
  return (
    <>
      {!known && <option value={current}>{current}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </>
  );
}

/** Champ texte validé au blur (ou Entrée) seulement — évite un config_write + push sidecar par frappe. */
function CommittedInput({
  id,
  label,
  value,
  placeholder,
  allowEmpty = false,
  onCommit,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  /** Autorise la valeur vide (champ facultatif, ex. la voix distante à omettre). */
  allowEmpty?: boolean;
  onCommit: (value: string) => void;
}>) {
  const [draft, setDraft] = useState(value);
  // Resynchronise le brouillon quand la valeur enregistrée change (chargement
  // initial de la config, modification par un autre chemin).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    const trimmed = draft.trim();
    if ((trimmed || allowEmpty) && trimmed !== value) onCommit(trimmed);
    else setDraft(value);
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
      />
    </div>
  );
}

/**
 * Valeur sentinelle des sélecteurs « Modèle » et « Voix » : bascule en saisie
 * libre. Le `!` initial exclut toute collision avec un identifiant réel de
 * modèle ou de voix (même convention que `SPEECH_KEY_DEDICATED`).
 */
const FREEFORM_OPTION = "!freeform";

/**
 * Champ « Modèle » du mode distant : liste déroulante alimentée par le
 * préréglage de service courant, doublée d'une option « Autre (saisie libre) »
 * qui fait réapparaître le champ texte — rien n'est verrouillé. Un préréglage
 * sans liste connue (« Personnalisé ») se saisit directement en texte libre,
 * comme une valeur enregistrée hors liste (config éditée à la main).
 */
function RemoteModelField({
  id,
  options,
  value,
  placeholder,
  onCommit,
}: Readonly<{
  id: string;
  options: SpeechOption[];
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}>) {
  const [freeform, setFreeform] = useState(false);
  const known = options.some((o) => o.id === value);
  const editing = options.length === 0 || freeform || !known;

  if (options.length === 0) {
    return <CommittedInput id={id} label="Modèle" value={value} placeholder={placeholder} onCommit={onCommit} />;
  }

  return (
    <>
      <div className="field">
        <label htmlFor={id}>Modèle</label>
        <select
          id={id}
          value={editing ? FREEFORM_OPTION : value}
          onChange={(e) => {
            const next = e.currentTarget.value;
            if (next === FREEFORM_OPTION) {
              setFreeform(true);
              return;
            }
            setFreeform(false);
            onCommit(next);
          }}
        >
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
          <option value={FREEFORM_OPTION}>Autre (saisie libre)</option>
        </select>
      </div>
      {editing && (
        <CommittedInput
          id={`${id}-custom`}
          label="Identifiant du modèle"
          value={value}
          placeholder={placeholder}
          onCommit={onCommit}
        />
      )}
    </>
  );
}

/**
 * Champ « Voix » du mode distant. La voix est un paramètre REQUIS de
 * `/audio/speech`, mais son catalogue dépend du modèle et n'est publié par
 * OpenRouter sur aucune page modèle : liste déroulante quand le catalogue est
 * connu avec une confiance raisonnable (`voiceCatalogFor`), saisie libre
 * assortie d'une aide honnête sinon. Le composant est remonté à chaque
 * changement de modèle (clé côté appelant) : le mode « saisie libre » choisi
 * pour un modèle ne survit donc pas au suivant.
 */
function RemoteVoiceField({
  id,
  catalog,
  value,
  onCommit,
}: Readonly<{
  id: string;
  catalog: SpeechOption[];
  value: string;
  onCommit: (value: string) => void;
}>) {
  const [freeform, setFreeform] = useState(false);
  const known = catalog.some((o) => o.id === value);
  const editing = catalog.length === 0 || freeform || !known;

  return (
    <>
      {catalog.length > 0 && (
        <div className="field">
          <label htmlFor={id}>Voix</label>
          <select
            id={id}
            value={editing ? FREEFORM_OPTION : value}
            onChange={(e) => {
              const next = e.currentTarget.value;
              if (next === FREEFORM_OPTION) {
                setFreeform(true);
                return;
              }
              setFreeform(false);
              onCommit(next);
            }}
          >
            {catalog.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
            <option value={FREEFORM_OPTION}>Autre (saisie libre)</option>
          </select>
        </div>
      )}
      {editing && (
        <>
          <CommittedInput
            id={`${id}-custom`}
            label={catalog.length > 0 ? "Identifiant de la voix" : "Voix"}
            value={value}
            placeholder="ex. ff_siwis"
            allowEmpty
            onCommit={onCommit}
          />
          <p className="empty-hint voice-form__hint">
            Les voix disponibles dépendent du modèle et ne sont publiées par OpenRouter sur aucune page
            modèle : il faut se référer à la documentation de l'éditeur. Un identifiant inconnu est rejeté
            par le service, dont le message d'erreur indique en général les valeurs acceptées.
          </p>
        </>
      )}
    </>
  );
}

/** Vitesse de lecture (0,5 à 2), validée au blur — retombe sur la valeur enregistrée si invalide. */
function SpeedInput({
  id,
  value,
  onCommit,
}: Readonly<{ id: string; value: number; onCommit: (value: number) => void }>) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = Number.parseFloat(draft.replace(",", "."));
    if (Number.isFinite(parsed) && parsed >= 0.5 && parsed <= 2 && parsed !== value) {
      onCommit(Math.round(parsed * 100) / 100);
    } else {
      setDraft(String(value));
    }
  }

  return (
    <div className="field">
      <label htmlFor={id}>Vitesse (0,5 – 2)</label>
      <input
        id={id}
        type="number"
        min={0.5}
        max={2}
        step={0.05}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

/**
 * Curseur de sensibilité du mode conversation (0 → 1). La valeur n'est
 * enregistrée qu'au relâchement du curseur (pointeur ou clavier) : un
 * `config_write` + push sidecar à chaque pas de glissement serait absurde.
 */
function SensitivitySlider({
  id,
  value,
  onCommit,
}: Readonly<{ id: string; value: number; onCommit: (value: number) => void }>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    if (draft !== value) onCommit(draft);
  }

  return (
    <div className="field">
      <label htmlFor={id}>Sensibilité ({draft.toFixed(2).replace(".", ",")})</label>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={draft}
        onChange={(e) => setDraft(Number.parseFloat(e.currentTarget.value))}
        onPointerUp={commit}
        onBlur={commit}
        onKeyUp={commit}
      />
    </div>
  );
}

/**
 * Champ numérique borné du mode conversation (délai de silence, durée maximale
 * d'un segment) — même principe que SpeedInput : validé au blur ou à Entrée,
 * retour à la valeur enregistrée si la saisie est hors bornes.
 */
function ConversationNumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: Readonly<{
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
}>) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = Number.parseFloat(draft.replace(",", "."));
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== value) {
      onCommit(parsed);
    } else {
      setDraft(String(value));
    }
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

/** Clé dédiée d'un usage voix — même UX que les fournisseurs : jamais affichée, juste remplacer/effacer. */
function SpeechKeyEditor({
  kind,
  configured,
  onSaveKey,
  onClearKey,
}: Readonly<{
  kind: SpeechKeyKind;
  configured: boolean;
  onSaveKey: (kind: SpeechKeyKind, value: string) => Promise<void>;
  onClearKey: (kind: SpeechKeyKind) => Promise<void>;
}>) {
  const [inputOpen, setInputOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!value.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onSaveKey(kind, value.trim());
      setValue("");
      setInputOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    setError("");
    try {
      await onClearKey(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="voice-key__editor">
      {inputOpen ? (
        <div className="actions">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            placeholder="sk-…"
            autoComplete="off"
            aria-label="Clé API"
          />
          <button className="btn" onClick={() => void handleSave()} disabled={busy || !value.trim()}>
            Enregistrer
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setInputOpen(false);
              setValue("");
            }}
            disabled={busy}
          >
            Annuler
          </button>
        </div>
      ) : (
        <div className="actions">
          <button className="btn btn--ghost" onClick={() => setInputOpen(true)} disabled={busy}>
            {configured ? "Remplacer la clé" : "Renseigner la clé"}
          </button>
          {configured && (
            <button className="btn btn--ghost" onClick={() => void handleClear()} disabled={busy}>
              Effacer la clé
            </button>
          )}
        </div>
      )}
      {error && <div className="result-line result-line--error">Erreur : {error}</div>}
    </div>
  );
}

/**
 * Bloc « clé API » d'un usage voix en mode distant : choix de la SOURCE de la
 * clé (automatique, empruntée à un fournisseur précis, ou dédiée), statut réel
 * de la clé effectivement utilisée, et éditeur de clé dédiée.
 *
 * Le défaut est l'automatique : si un fournisseur configuré a la même URL de
 * base que la voix et une clé au trousseau, elle est empruntée sans rien
 * demander (cf. `resolveSpeechKey`).
 *
 * L'emprunt évite de ressaisir (et de payer) une clé séparée quand une clé
 * OpenRouter est déjà au trousseau : `pushSpeech` la relit et l'envoie au
 * sidecar, elle n'est jamais recopiée dans la configuration.
 */
function SpeechKeySourceField({
  kind,
  keySource,
  providers,
  providerKeyStatus,
  origin,
  dedicatedConfigured,
  onChangeSource,
  onSaveKey,
  onClearKey,
}: Readonly<{
  kind: SpeechKeyKind;
  keySource: string;
  providers: ProviderConfig[];
  providerKeyStatus: Record<string, boolean>;
  origin: SpeechKeyOrigin;
  dedicatedConfigured: boolean;
  onChangeSource: (keySource: string) => void;
  onSaveKey: (kind: SpeechKeyKind, value: string) => Promise<void>;
  onClearKey: (kind: SpeechKeyKind) => Promise<void>;
}>) {
  const selectId = `voice-${kind}-key-source`;
  // Seuls les fournisseurs qui exigent une clé ET en ont réellement une au
  // trousseau sont empruntables.
  const borrowable = providers.filter((p) => p.needsKey && (providerKeyStatus[p.id] ?? false));
  // Le fournisseur EXPLICITEMENT référencé a disparu (ou n'a plus de clé) : on
  // le laisse visible dans la liste pour que l'utilisateur comprenne le repli.
  const orphan =
    keySource !== "" &&
    keySource !== SPEECH_KEY_DEDICATED &&
    !borrowable.some((p) => p.id === keySource);
  const orphanLabel = providers.find((p) => p.id === keySource)?.label ?? keySource;
  // Fournisseur réellement retenu par `resolveSpeechKey` — celui demandé en
  // mode explicite, celui deviné en mode automatique.
  const originLabel = providers.find((p) => p.id === origin.providerId)?.label ?? origin.providerId;

  let status: { text: string; variant: string };
  if (origin.borrowed && origin.auto) {
    status = {
      text: `Automatique : clé du fournisseur « ${originLabel} »`,
      variant: " result-line--ok",
    };
  } else if (origin.borrowed) {
    status = { text: `Clé empruntée au fournisseur « ${originLabel} »`, variant: " result-line--ok" };
  } else if (origin.fallback && dedicatedConfigured) {
    status = {
      text: `Fournisseur « ${originLabel} » sans clé disponible : la clé dédiée est utilisée à la place.`,
      variant: " result-line--warn",
    };
  } else if (origin.fallback) {
    status = {
      text: `Fournisseur « ${originLabel} » sans clé disponible, et aucune clé dédiée : renseignez-en une.`,
      variant: " result-line--error",
    };
  } else if (origin.auto && !dedicatedConfigured) {
    // Mode automatique sans correspondance ni clé dédiée : le message dit quoi
    // faire, plutôt que de constater l'absence.
    status = {
      text: "Aucun fournisseur configuré ne correspond à cette URL : choisissez une clé ci-dessus ou renseignez une clé dédiée.",
      variant: " result-line--error",
    };
  } else {
    status = dedicatedConfigured
      ? { text: "Clé dédiée configurée", variant: " result-line--ok" }
      : { text: "Clé absente", variant: "" };
  }

  // L'éditeur de clé dédiée n'a de sens que si c'est bien elle qui sert (ou
  // servira) : mode dédié explicite, repli après emprunt impossible, ou mode
  // automatique sans fournisseur correspondant.
  const showDedicatedEditor =
    keySource === SPEECH_KEY_DEDICATED || origin.fallback || (origin.auto && !origin.borrowed);

  return (
    <div className="voice-key">
      <div className="field voice-key__source">
        <label htmlFor={selectId}>Clé API</label>
        <select id={selectId} value={keySource} onChange={(e) => onChangeSource(e.currentTarget.value)}>
          <option value="">Automatique (clé du fournisseur correspondant à l'URL)</option>
          {borrowable.map((p) => (
            <option key={p.id} value={p.id}>
              Clé du fournisseur « {p.label} »
            </option>
          ))}
          {orphan && <option value={keySource}>Fournisseur « {orphanLabel} » (indisponible)</option>}
          <option value={SPEECH_KEY_DEDICATED}>Clé dédiée</option>
        </select>
      </div>
      <span className={`result-line${status.variant}`}>{status.text}</span>
      {showDedicatedEditor && (
        <SpeechKeyEditor
          kind={kind}
          configured={dedicatedConfigured}
          onSaveKey={onSaveKey}
          onClearKey={onClearKey}
        />
      )}
    </div>
  );
}

interface VoiceTestState {
  state: "idle" | "recording" | "busy" | "ok" | "error";
  message: string;
}

function VoiceSection({
  config,
  keyStatus,
  keyOrigin,
  providers,
  providerKeyStatus,
  errorMessage,
  onSaveConfig,
  onSaveKey,
  onClearKey,
}: Readonly<{
  config: SpeechConfig;
  keyStatus: SpeechKeyStatus;
  keyOrigin: SpeechKeyOrigins;
  providers: ProviderConfig[];
  providerKeyStatus: Record<string, boolean>;
  errorMessage: string;
  onSaveConfig: (patch: SpeechConfigPatch) => Promise<void>;
  onSaveKey: (kind: SpeechKeyKind, value: string) => Promise<void>;
  onClearKey: (kind: SpeechKeyKind) => Promise<void>;
}>) {
  const [sttTest, setSttTest] = useState<VoiceTestState>({ state: "idle", message: "" });
  const [ttsTest, setTtsTest] = useState<VoiceTestState>({ state: "idle", message: "" });
  // Niveau capté en direct pendant le test (RMS 0→1) : le retour visuel doit
  // être immédiat, surtout en Bluetooth où le micro peut être muet sans que
  // rien ne le signale.
  const [sttLevel, setSttLevel] = useState(0);
  const [microphones, setMicrophones] = useState<MicrophoneDevice[]>([]);

  // Liste des micros : rafraîchie au montage puis à chaque `devicechange`
  // (branchement/débranchement, connexion d'un casque Bluetooth…). Effet
  // StrictMode-safe : un drapeau annule les setState après démontage.
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      listMicrophones()
        .then((devices) => {
          if (alive) setMicrophones(devices);
        })
        .catch(() => {
          /* énumération indisponible : le select se limite au défaut système */
        });
    };
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  // Les erreurs de sauvegarde remontent déjà via `errorMessage` (useSpeech) :
  // ce wrapper évite juste une promesse rejetée non gérée par contrôle.
  function save(patch: SpeechConfigPatch) {
    void onSaveConfig(patch).catch(() => {
      /* déjà affiché via errorMessage */
    });
  }

  /**
   * Change le modèle de synthèse distant (et éventuellement l'URL de base,
   * quand le changement vient d'un préréglage de service) en gardant la voix
   * COHÉRENTE : une voix qui n'appartient pas au catalogue connu du nouveau
   * modèle serait rejetée par le service, on la remplace donc par la première
   * voix de ce catalogue — ou par la chaîne vide si le catalogue est inconnu,
   * l'utilisateur la saisissant alors lui-même.
   */
  function saveTtsRemoteModel(model: string, baseUrl?: string) {
    const voice = coherentVoiceFor(model, config.tts.remote.voice);
    save({ tts: { remote: { ...(baseUrl === undefined ? {} : { baseUrl }), model, voice } } });
  }

  /** Test dictée : enregistre 3 s au micro puis transcrit (progression des chunks affichée). */
  async function handleSttTest() {
    if (sttTest.state === "recording" || sttTest.state === "busy") return;
    setSttLevel(0);
    try {
      await startRecording({ deviceId: config.stt.inputDeviceId, onLevel: setSttLevel });
    } catch (err) {
      setSttTest({ state: "error", message: err instanceof Error ? err.message : String(err) });
      return;
    }
    setSttTest({ state: "recording", message: "Enregistrement en cours — parlez !" });
    await new Promise((resolve) => setTimeout(resolve, STT_TEST_DURATION_MS));
    setSttLevel(0);
    setSttTest({ state: "busy", message: "Transcription…" });
    try {
      const audioBase64 = await stopRecording();
      const text = await speechTranscribe(audioBase64, (p) =>
        setSttTest({ state: "busy", message: formatSpeechProgress(p) }),
      );
      const trimmed = text.trim();
      setSttTest(
        trimmed
          ? { state: "ok", message: `« ${trimmed} »` }
          : { state: "error", message: "Aucun texte reconnu." },
      );
    } catch (err) {
      setSttTest({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Test synthèse : synthétise une phrase d'exemple française et la joue. */
  async function handleTtsTest() {
    if (ttsTest.state === "busy") return;
    setTtsTest({ state: "busy", message: "Synthèse…" });
    try {
      const { audioBase64, mime } = await speechSynthesize(TTS_TEST_SENTENCE, (p) =>
        setTtsTest({ state: "busy", message: formatSpeechProgress(p) }),
      );
      await startPlayback(audioBase64, mime, () =>
        setTtsTest({ state: "ok", message: "Phrase d'exemple jouée." }),
      );
      setTtsTest({ state: "ok", message: "Lecture…" });
    } catch (err) {
      setTtsTest({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  function testResultLine(test: VoiceTestState) {
    if (test.state === "idle") return null;
    const variant = test.state === "ok" ? " result-line--ok" : test.state === "error" ? " result-line--error" : "";
    return <div className={`result-line${variant}`}>{test.message}</div>;
  }

  return (
    <>
      {errorMessage && <div className="result-line result-line--error">Erreur : {errorMessage}</div>}

      <section className="config-section voice-section">
        <h2 className="config-section__title">Dictée (speech-to-text)</h2>
        <p className="empty-hint">
          Transcription de la voix en texte (bouton micro du composeur). En local, le modèle Whisper est
          téléchargé au premier usage ; en distant, l'audio est envoyé à l'API configurée. La clé API peut
          être empruntée à un fournisseur déjà configuré ou saisie ici ; dans les deux cas elle est stockée
          dans le trousseau du système, jamais affichée. Coût indicatif de la dictée chez OpenRouter comme
          chez Groq : environ 0,04 $ par heure d'audio.
        </p>

        <div className="voice-form">
          <div className="field">
            <label htmlFor="voice-stt-mode">Mode</label>
            <select
              id="voice-stt-mode"
              value={config.stt.mode}
              onChange={(e) => save({ stt: { mode: e.currentTarget.value as SpeechMode } })}
            >
              <option value="local">Local (sur cette machine)</option>
              <option value="remote">Distant (API)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="voice-stt-language">Langue</label>
            <select
              id="voice-stt-language"
              value={config.stt.language}
              onChange={(e) => save({ stt: { language: e.currentTarget.value } })}
            >
              {voiceSelectOptions(STT_LANGUAGES, config.stt.language)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="voice-stt-device">Micro</label>
            <select
              id="voice-stt-device"
              value={config.stt.inputDeviceId}
              onChange={(e) => save({ stt: { inputDeviceId: e.currentTarget.value } })}
            >
              <option value="">Périphérique par défaut du système</option>
              {microphones
                .filter((d) => d.deviceId !== "")
                .map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
            </select>
          </div>
          {config.stt.mode === "local" ? (
            <div className="field">
              <label htmlFor="voice-stt-model">Modèle Whisper</label>
              <select
                id="voice-stt-model"
                value={config.stt.local.model}
                onChange={(e) => save({ stt: { local: { model: e.currentTarget.value } } })}
              >
                {voiceSelectOptions(WHISPER_MODELS, config.stt.local.model)}
              </select>
            </div>
          ) : (
            <>
              <ServicePresetField
                id="voice-stt-preset"
                presets={STT_PRESETS}
                baseUrl={config.stt.remote.baseUrl}
                onApply={(p) => save({ stt: { remote: { baseUrl: p.baseUrl, model: p.model } } })}
              />
              <CommittedInput
                id="voice-stt-base-url"
                label="URL de base"
                value={config.stt.remote.baseUrl}
                placeholder="https://…/v1"
                onCommit={(v) => save({ stt: { remote: { baseUrl: v } } })}
              />
              <RemoteModelField
                id="voice-stt-remote-model"
                options={STT_REMOTE_MODELS[presetIdFor(STT_PRESETS, config.stt.remote.baseUrl)] ?? []}
                value={config.stt.remote.model}
                placeholder="ex. whisper-large-v3-turbo"
                onCommit={(v) => save({ stt: { remote: { model: v } } })}
              />
            </>
          )}
        </div>

        {config.stt.mode === "remote" && (
          <SpeechKeySourceField
            kind="stt"
            keySource={config.stt.remote.keySource}
            providers={providers}
            providerKeyStatus={providerKeyStatus}
            origin={keyOrigin.stt}
            dedicatedConfigured={keyStatus.stt}
            onChangeSource={(v) => save({ stt: { remote: { keySource: v } } })}
            onSaveKey={onSaveKey}
            onClearKey={onClearKey}
          />
        )}

        <div className="actions">
          <button
            className="btn"
            onClick={() => void handleSttTest()}
            disabled={sttTest.state === "recording" || sttTest.state === "busy"}
          >
            {sttTest.state === "recording"
              ? "Enregistrement… (3 s)"
              : sttTest.state === "busy"
                ? "Transcription…"
                : "Tester (enregistre 3 s)"}
          </button>
          {sttTest.state === "recording" && (
            // Jauge pilotée par `--mic-level` : si elle reste plate, le micro
            // ne capte rien (profil Bluetooth A2DP, micro coupé…).
            <span className="mic-level mic-level--wide" style={micLevelStyle(sttLevel)}>
              <span className="mic-level__bar" />
            </span>
          )}
        </div>
        {testResultLine(sttTest)}
      </section>

      <section className="config-section voice-section">
        <h2 className="config-section__title">Synthèse vocale (text-to-speech)</h2>
        <p className="empty-hint">
          Lecture à voix haute des réponses de l'assistant (bouton ⏵ des bulles du chat). En local, la voix
          Kokoro est téléchargée au premier usage ; en distant, le texte est envoyé à l'API configurée — la
          clé peut elle aussi être empruntée à un fournisseur déjà configuré. En distant, la voix est un
          paramètre obligatoire du service et dépend du modèle choisi ; la vitesse, en revanche, n'est
          honorée que par certains fournisseurs et reste omise de la requête tant qu'elle vaut 1. Le
          format audio (mp3 ou PCM), qui dépend lui aussi du modèle, est négocié automatiquement avec le
          service.
          Contrairement à la dictée, facturée à la durée d'audio, la synthèse est facturée au token
          d'ENTRÉE (le texte envoyé) : les tarifs indiqués dans la liste des modèles sont en dollars par
          million de tokens d'entrée.
        </p>

        <div className="voice-form">
          <div className="field">
            <label htmlFor="voice-tts-mode">Mode</label>
            <select
              id="voice-tts-mode"
              value={config.tts.mode}
              onChange={(e) => save({ tts: { mode: e.currentTarget.value as SpeechMode } })}
            >
              <option value="local">Local (sur cette machine)</option>
              <option value="remote">Distant (API)</option>
            </select>
          </div>
          {config.tts.mode === "local" ? (
            <>
              <div className="field">
                <label htmlFor="voice-tts-voice">Voix Kokoro</label>
                <select
                  id="voice-tts-voice"
                  value={config.tts.local.voice}
                  onChange={(e) => save({ tts: { local: { voice: e.currentTarget.value } } })}
                >
                  {voiceSelectOptions(KOKORO_VOICES, config.tts.local.voice)}
                </select>
              </div>
              <SpeedInput
                id="voice-tts-local-speed"
                value={config.tts.local.speed}
                onCommit={(v) => save({ tts: { local: { speed: v } } })}
              />
            </>
          ) : (
            <>
              <ServicePresetField
                id="voice-tts-preset"
                presets={TTS_PRESETS}
                baseUrl={config.tts.remote.baseUrl}
                onApply={(p) => saveTtsRemoteModel(p.model, p.baseUrl)}
              />
              <CommittedInput
                id="voice-tts-base-url"
                label="URL de base"
                value={config.tts.remote.baseUrl}
                placeholder="https://…/v1"
                onCommit={(v) => save({ tts: { remote: { baseUrl: v } } })}
              />
              <RemoteModelField
                id="voice-tts-remote-model"
                options={TTS_REMOTE_MODELS[presetIdFor(TTS_PRESETS, config.tts.remote.baseUrl)] ?? []}
                value={config.tts.remote.model}
                placeholder="ex. gpt-4o-mini-tts"
                onCommit={(v) => saveTtsRemoteModel(v)}
              />
              {/* Remonté à chaque changement de modèle : le catalogue affiché
                  et le mode « saisie libre » repartent du bon pied. */}
              <RemoteVoiceField
                key={config.tts.remote.model}
                id="voice-tts-remote-voice"
                catalog={voiceCatalogFor(config.tts.remote.model)}
                value={config.tts.remote.voice}
                onCommit={(v) => save({ tts: { remote: { voice: v } } })}
              />
              <SpeedInput
                id="voice-tts-remote-speed"
                value={config.tts.remote.speed}
                onCommit={(v) => save({ tts: { remote: { speed: v } } })}
              />
            </>
          )}
        </div>

        {config.tts.mode === "remote" && (
          <SpeechKeySourceField
            kind="tts"
            keySource={config.tts.remote.keySource}
            providers={providers}
            providerKeyStatus={providerKeyStatus}
            origin={keyOrigin.tts}
            dedicatedConfigured={keyStatus.tts}
            onChangeSource={(v) => save({ tts: { remote: { keySource: v } } })}
            onSaveKey={onSaveKey}
            onClearKey={onClearKey}
          />
        )}

        <div className="actions">
          <button className="btn" onClick={() => void handleTtsTest()} disabled={ttsTest.state === "busy"}>
            {ttsTest.state === "busy" ? "Synthèse…" : "Tester"}
          </button>
        </div>
        {testResultLine(ttsTest)}
      </section>

      <section className="config-section voice-section">
        <h2 className="config-section__title">Mode conversation</h2>
        <p className="empty-hint">
          Écoute continue dans le chat (bouton 🗣 du composeur) : l'application enchaîne toute seule écoute,
          transcription, envoi du message, réponse du modèle et lecture à voix haute, puis se remet à
          l'écoute. Côté coût, soyons précis : la détection de la parole est faite ici, sur cette machine,
          et ne coûte rien — seuls les segments réellement parlés partent à la transcription, facturée
          environ 0,04 $ par heure d'audio <em>parlé</em> (les silences ne sont jamais envoyés). Le coût qui
          domine reste, de très loin, l'appel au modèle de langage à chaque tour, exactement comme si le
          message avait été tapé au clavier : la voix n'y ajoute presque rien. Le micro ne reste jamais
          ouvert indéfiniment — sans parole pendant cinq minutes, le mode s'arrête de lui-même.
        </p>

        <div className="voice-form">
          <SensitivitySlider
            id="voice-conversation-sensitivity"
            value={config.conversation.sensitivity}
            onCommit={(v) => save({ conversation: { sensitivity: v } })}
          />
          <ConversationNumberField
            id="voice-conversation-silence"
            label="Délai de silence (ms)"
            value={config.conversation.silenceMs}
            min={200}
            max={5000}
            step={50}
            onCommit={(v) => save({ conversation: { silenceMs: Math.round(v) } })}
          />
          <ConversationNumberField
            id="voice-conversation-max"
            label="Durée maximale d'un segment (s)"
            value={Math.round(config.conversation.maxUtteranceMs / 1000)}
            min={5}
            max={120}
            step={5}
            onCommit={(v) => save({ conversation: { maxUtteranceMs: Math.round(v) * 1000 } })}
          />
          <label className="field field--checkbox" htmlFor="voice-conversation-autoplay">
            <input
              id="voice-conversation-autoplay"
              type="checkbox"
              checked={config.conversation.autoPlayReply}
              onChange={(e) => save({ conversation: { autoPlayReply: e.currentTarget.checked } })}
            />
            <span>Lire la réponse à voix haute</span>
          </label>
          <p className="empty-hint voice-form__hint">
            Sensibilité : plus elle est haute, plus la parole est détectée facilement — au risque de
            réagir au bruit ambiant (ventilateur, conversation voisine) et de transcrire pour rien.
            Trop basse, les débuts de phrase prononcés doucement sont manqués. Le délai de silence
            est le temps de blanc qui clôt une phrase : l'augmenter laisse le temps de réfléchir en
            parlant, le diminuer rend l'échange plus vif. La durée maximale d'un segment est un
            garde-fou de coût : au-delà, l'enregistrement est clos d'office, ce qui évite qu'un micro
            resté ouvert n'envoie une longue plage d'audio à la transcription.
          </p>
        </div>
      </section>
    </>
  );
}

/* ---------- Page ---------- */

/*
 * Sous-navigation interne (Lot ergonomie) : une seule section visible à la
 * fois, plutôt que l'empilement vertical des sections. Les sections
 * restent montées en permanence (masquées via CSS, `configPanelClass`
 * ci-dessous — même pattern que `.page-slot` dans App.tsx) : chacune garde
 * son état local (formulaire en cours d'édition, catalogue de modèles déjà
 * chargé…) au fil des changements d'onglet.
 */
type ConfigTabId = "projects" | "providers" | "models" | "voice" | "apps" | "shortcuts";

const CONFIG_TABS: { id: ConfigTabId; label: string }[] = [
  { id: "projects", label: "Projets" },
  { id: "providers", label: "Fournisseurs" },
  { id: "models", label: "Modèles OpenRouter" },
  { id: "voice", label: "Voix" },
  { id: "apps", label: "Applications" },
  { id: "shortcuts", label: "Clavier" },
];

function configPanelClass(active: boolean): string {
  return active ? "config-panel" : "config-panel config-panel--hidden";
}

export function ProvidersPage({
  providers,
  keyStatus,
  loadState,
  errorMessage,
  onSaveProvider,
  onDeleteProvider,
  onSaveKey,
  onClearKey,
  projects,
  projectsLoadState,
  projectsErrorMessage,
  onAddProject,
  onUpdateProject,
  onDeleteProject,
  speechConfig,
  speechKeyStatus,
  speechKeyOrigin,
  speechErrorMessage,
  onSaveSpeechConfig,
  onSaveSpeechKey,
  onClearSpeechKey,
}: Readonly<ProvidersPageProps>) {
  const [configTab, setConfigTab] = useState<ConfigTabId>("projects");
  // Sous-menu aux flèches, activation manuelle (Entrée / Espace) — voir Nav dans App.tsx.
  const subnavRoving = useRovingFocus<HTMLElement>({
    selector: ".config-subnav__item:not(:disabled)",
    orientation: "horizontal",
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const existingIds = providers.map((p) => p.id);

  return (
    <div className="page providers-page">
      <div className="page__intro">
        <h1 className="page__title">Configuration</h1>
      </div>

      <nav
        className="config-subnav"
        aria-label="Sections de configuration"
        ref={subnavRoving.containerRef}
        onKeyDown={subnavRoving.onKeyDown}
        onFocus={subnavRoving.onFocus}
      >
        {CONFIG_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`config-subnav__item${configTab === tab.id ? " config-subnav__item--active" : ""}`}
            onClick={() => setConfigTab(tab.id)}
            aria-current={configTab === tab.id ? "page" : undefined}
            tabIndex={configTab === tab.id ? 0 : -1}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <div className={configPanelClass(configTab === "projects")}>
        <ProjectsSection
          projects={projects}
          loadState={projectsLoadState}
          errorMessage={projectsErrorMessage}
          onAddProject={onAddProject}
          onUpdateProject={onUpdateProject}
          onDeleteProject={onDeleteProject}
        />
      </div>

      <div className={configPanelClass(configTab === "providers")}>
        <section className="config-section">
          <h2 className="config-section__title">Fournisseurs</h2>
          <p className="empty-hint">
            Fournisseurs de modèles disponibles pour le chat. Les clés API sont stockées dans le
            trousseau du système, jamais dans la configuration ni dans le navigateur.
          </p>

          {loadState === "loading" && <p className="empty-hint">Chargement…</p>}
          {loadState === "error" && (
            <div className="result-line result-line--error">Erreur de chargement : {errorMessage}</div>
          )}

          <div className="provider-list">
            {providers.map((provider) =>
              editingId === provider.id ? (
                <article className="provider-card" key={provider.id}>
                  <ProviderForm
                    mode="edit"
                    initial={provider}
                    existingIds={existingIds}
                    onSubmit={async (values) => {
                      await onSaveProvider({ ...values, headers: provider.headers });
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                </article>
              ) : (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  keyConfigured={keyStatus[provider.id] ?? false}
                  onEdit={() => setEditingId(provider.id)}
                  onDelete={() => {
                    if (window.confirm(`Supprimer le fournisseur « ${provider.label} » ?`)) {
                      void onDeleteProvider(provider.id);
                    }
                  }}
                  onSaveKey={onSaveKey}
                  onClearKey={onClearKey}
                />
              ),
            )}
            {providers.length === 0 && loadState === "ready" && (
              <p className="empty-hint">Aucun fournisseur configuré.</p>
            )}
          </div>

          {adding ? (
            <article className="provider-card provider-card--new">
              <ProviderForm
                mode="add"
                existingIds={existingIds}
                onSubmit={async (values) => {
                  await onSaveProvider(values);
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            </article>
          ) : (
            <div className="actions">
              <button className="btn" onClick={() => setAdding(true)}>
                + Ajouter un fournisseur
              </button>
            </div>
          )}
        </section>

        {/* R1 — table de routage du sélecteur « Auto » du Chat (niveau page,
            indépendante du formulaire fournisseur ci-dessus). */}
        <RoutingSection providers={providers} active={configTab === "providers"} />
      </div>

      <div className={configPanelClass(configTab === "models")}>
        <OpenRouterModelsSection providers={providers} keyStatus={keyStatus} active={configTab === "models"} />
      </div>

      <div className={configPanelClass(configTab === "voice")}>
        <VoiceSection
          config={speechConfig}
          keyStatus={speechKeyStatus}
          keyOrigin={speechKeyOrigin}
          providers={providers}
          providerKeyStatus={keyStatus}
          errorMessage={speechErrorMessage}
          onSaveConfig={onSaveSpeechConfig}
          onSaveKey={onSaveSpeechKey}
          onClearKey={onClearSpeechKey}
        />
      </div>

      <div className={configPanelClass(configTab === "apps")}>
        <AppsSection />
      </div>

      <div className={configPanelClass(configTab === "shortcuts")}>
        <ShortcutsSection />
      </div>
    </div>
  );
}
