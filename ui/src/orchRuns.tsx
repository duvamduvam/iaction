/*
 * Section Runs : suivi des exécutions, détail par étape, permissions en vol,
 * persistance du registre des runs.
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

import {
  type AgentEngine,
  type OrchRunStatus,
} from "./orchestrationClient";
import { type ClaudeUsage } from "./sidecar";

export type OrchStepRunStatus = "pending" | "running" | "success" | "failed" | "skipped" | "aborted";

export const STEP_RUN_STATUSES = new Set<string>(["pending", "running", "success", "failed", "skipped", "aborted"]);

export function toStepRunStatus(value: string): OrchStepRunStatus {
  return (STEP_RUN_STATUSES.has(value) ? value : "failed") as OrchStepRunStatus;
}

export /** Métadonnées d'une étape — SEUL ce qui est persisté (jamais le texte, voir l'étude § 4.3). */
interface RunStepMeta {
  status: OrchStepRunStatus;
}

/**
 * Métadonnées d'un run — forme persistée telle quelle, clé state store
 * "orchestration-runs" (plafond 50, le plus récent en premier).
 */
export interface RunMeta {
  runId: string;
  orchestration: string;
  projectName: string;
  startedAt: string;
  durationMs: number | null;
  status: "running" | OrchRunStatus;
  steps: Record<string, RunStepMeta>;
}

export const RUNS_STATE_KEY = "orchestration-runs";
export const MAX_RUNS = 50;

export function isRunStatus(value: unknown): value is RunMeta["status"] {
  return value === "running" || value === "success" || value === "partial" || value === "failed" || value === "aborted";
}

export function isRunStepMeta(value: unknown): value is RunStepMeta {
  return typeof value === "object" && value !== null && STEP_RUN_STATUSES.has(String((value as Record<string, unknown>).status));
}

export function isRunMeta(value: unknown): value is RunMeta {
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
export function normalizeStaleRun(run: RunMeta): RunMeta {
  if (run.status !== "running") return run;
  const steps = Object.fromEntries(
    Object.entries(run.steps).map(([id, s]) => [
      id,
      { status: s.status === "success" || s.status === "failed" || s.status === "skipped" ? s.status : "aborted" } as RunStepMeta,
    ]),
  );
  return { ...run, status: "aborted", steps };
}

export function sanitizeRunMetas(raw: unknown): RunMeta[] {
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
export function mergeRunMetas(disk: RunMeta[], local: RunMeta[]): RunMeta[] {
  const byId = new Map<string, RunMeta>();
  for (const r of disk) byId.set(r.runId, r);
  for (const r of local) byId.set(r.runId, r);
  return Array.from(byId.values())
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, MAX_RUNS);
}

/* ---------- Détail en mémoire (texte du run COURANT, jamais persisté) ---------- */

export type RunBlock =
  | { type: "text"; id: string; content: string }
  | { type: "thinking"; id: string; content: string }
  | { type: "tool"; id: string; toolUseId: string; toolName: string; toolInput: unknown; result?: { isError: boolean; summary: string } };

let runBlockIdCounter = 0;
export function nextRunBlockId(): string {
  runBlockIdCounter += 1;
  return `rb-${runBlockIdCounter}`;
}

export function appendRunTextBlock(blocks: RunBlock[], type: "text" | "thinking", delta: string): RunBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) {
    return [...blocks.slice(0, -1), { ...last, content: last.content + delta } as RunBlock];
  }
  return [...blocks, { type, id: nextRunBlockId(), content: delta } as RunBlock];
}

export function addRunToolBlock(blocks: RunBlock[], toolUseId: string, toolName: string, toolInput: unknown): RunBlock[] {
  return [...blocks, { type: "tool", id: nextRunBlockId(), toolUseId, toolName, toolInput }];
}

export function setRunToolResult(blocks: RunBlock[], toolUseId: string, isError: boolean, summary: string): RunBlock[] {
  return blocks.map((b) => (b.type === "tool" && b.toolUseId === toolUseId ? { ...b, result: { isError, summary } } : b));
}

export interface RunDetailStep {
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
export interface RunDetail {
  runId: string;
  stepOrder: string[];
  steps: Record<string, RunDetailStep>;
  /** Rejet protocolaire avant le premier chunk (orchestration/agent/input introuvable). */
  protocolError?: string;
}

export function emptyRunDetail(runId: string): RunDetail {
  return { runId, stepOrder: [], steps: {} };
}

export function runDetailPrettyJson(value: unknown, maxLen = 800): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n…` : text;
}

/* ---------- Permissions (file, une modale à la fois — RÉUTILISE .permission-*) ---------- */

export interface OrchPermissionItem {
  /** = runId (voir contrat `orch.permission {targetId: runId, …}`). */
  targetId: string;
  stepId: string;
  permissionId: string;
  toolName: string;
  toolInput: unknown;
}

export function OrchPermissionModal({
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

export function formatRunTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatRunDuration(ms: number | null): string {
  if (ms === null) return "en cours";
  if (ms < 1000) return `${ms} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes} min ${seconds}s`;
}

export function stepStatusIcon(status: OrchStepRunStatus): string {
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

export function runStatusLabel(status: RunMeta["status"]): string {
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

export function runStatusClass(status: RunMeta["status"]): string {
  return `orch-run-status orch-run-status--${status}`;
}

export function stepEngineLabel(step: Pick<RunDetailStep, "engine" | "model">): string {
  // Étape `engine: auto` pas encore démarrée : la cible sera résolue par le
  // routeur au démarrage de l'étape (annoncée par step_started).
  if (step.engine === "auto") return "auto (routé au démarrage)";
  return step.engine === "claude" ? `Claude · ${step.model || "défaut"}` : `Neutre · ${step.model || "—"}`;
}

/* ---------- Vues ---------- */

export function RunBlockView({ block }: Readonly<{ block: RunBlock }>) {
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

export function RunStepRow({ step }: Readonly<{ step: RunDetailStep }>) {
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

export function RunDetailPanel({
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

export function RunListItem({
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

export function RunsSection({
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

