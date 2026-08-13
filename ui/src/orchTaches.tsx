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
import { toMessage } from "./base";
import { ErrorOrStaleHint, formatReportDate, type LoadState } from "./orchCommun";
import {
  type AgentInfo,
  agentsList,
  type OrchestrationStep,
  orchList,
} from "./orchestrationClient";
import { type ProviderConfig } from "./providerAdmin";
import {
  type TacheInfo,
  type TacheReportInfo,
  tachesDelete,
  tachesRead,
  tachesTimerApply,
  tachesTimerRemove,
  tachesWrite,
  type TacheTimerStatus,
  type TacheWriteInput,
} from "./tachesClient";
import { useEffect, useState } from "react";
import { TacheEditor } from "./orchTacheEditeur";

export function formatMsOrDash(ms: number | null): string {
  return ms === null ? "—" : formatReportDate(ms);
}

/** Manifeste armé mais timer absent/éteint côté systemd — incohérence à signaler (badge « à synchroniser »). */
export function timerNeedsSync(tache: TacheInfo, timer: TacheTimerStatus | null): boolean {
  if (!timer) return false;
  return tache.enabled && (!timer.exists || !timer.active);
}

/** Libellé moteur/modèle d'un agent pour l'affichage LLM d'une tâche — modèle `null` ⇒ moteur seul (pas de « défaut »/« — »). */
export function tacheStepLlmLabel(agent: Pick<AgentInfo, "engine" | "provider" | "model">, providers: ProviderConfig[]): string {
  if (agent.engine === "claude") return agent.model ? `claude · ${agent.model}` : "claude";
  // R2 — moteur/modèle choisis par le routeur au lancement du run.
  if (agent.engine === "auto") return "auto (routeur)";
  const label = providers.find((p) => p.id === agent.provider)?.label ?? agent.provider ?? "neutre";
  return agent.model ? `${label} · ${agent.model}` : label;
}

export type TacheOrchestrationSteps = { status: LoadState; steps: OrchestrationStep[] | null; agents: AgentInfo[] };

/**
 * Charge l'orchestration de la tâche (`orch.list` filtré par nom) et ses agents (`agents.list`), `cwd` = dossier
 * de la tâche — voir mission LLM visibles. `steps: null` = orchestration introuvable (best effort : jamais
 * d'erreur bloquante, juste un statut `error`/liste vide exploité par l'appelant pour rester discret).
 */
export function useTacheOrchestrationSteps(path: string, orchestrationName: string): TacheOrchestrationSteps {
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

export type TacheLlmEntry =
  | { kind: "step"; stepId: string; agentName: string; label: string }
  | { kind: "unknown"; name: string };

/** `steps: null` (orchestration introuvable) ⇒ une seule entrée « inconnue » portant le nom de l'orchestration. */
export function buildTacheLlmEntries(
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
export function TacheLlmSummary({
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

export function TacheCard({
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

export type TachePanelState = {
  mode: "create" | "edit";
  seed: TacheInfo | null;
  raw: string | null;
  initialTab?: "form" | "yaml" | "reports";
} | null;

export interface TachesSectionProps {
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

export function TachesSection({
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
