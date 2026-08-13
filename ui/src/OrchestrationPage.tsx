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


import { toMessage } from "./base";
import { AgentsSection } from "./orchAgents";
import { type LoadState, looksLikeUnknownMethod, resolveTodayTemplates } from "./orchCommun";
import { OrchestrationsSection, RunLaunchModal } from "./orchOrchestrations";
import {
  addRunToolBlock,
  appendRunTextBlock,
  emptyRunDetail,
  MAX_RUNS,
  mergeRunMetas,
  type OrchPermissionItem,
  OrchPermissionModal,
  type OrchStepRunStatus,
  type RunDetail,
  type RunDetailStep,
  type RunMeta,
  RUNS_STATE_KEY,
  RunsSection,
  sanitizeRunMetas,
  setRunToolResult,
  toStepRunStatus,
} from "./orchRuns";
import { TachesSection } from "./orchTaches";
import {
  type AgentInfo,
  agentsList,
  orchAbort,
  type OrchestrationInfo,
  orchList,
  orchPermission,
  orchRun,
  type OrchRunChunk,
  type OrchRunDoneStep,
  type OrchRunStatus,
} from "./orchestrationClient";
import { type ProjectConfig } from "./projectAdmin";
import { type ProviderConfig } from "./providerAdmin";
import { stateRead, stateWrite } from "./stateClient";
import {
  type TacheInfo,
  type TacheReportInfo,
  tachesList,
  tachesReports,
  tachesTimerStatus,
  type TacheTimerStatus,
} from "./tachesClient";
import { notifyUsageChanged } from "./usageBus";
import { useRovingFocus } from "./useRovingFocus";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
