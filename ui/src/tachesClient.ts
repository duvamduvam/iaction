/*
 * Wrappers typés pour les méthodes `taches.*` du sidecar (docs/protocol.md
 * § « Méthodes T1 — tâches planifiées » ; voir aussi docs/etude-taches.md).
 * Même style défensif que orchestrationClient.ts : chaque valeur reçue est
 * validée champ par champ, les entrées invalides sont omises silencieusement
 * (sauf `invalid`, voir plus bas) — un sidecar pas encore à jour ou un
 * manifeste YAML mal formé ne doit jamais faire planter l'UI.
 *
 * Contrat (fourni par le protocole, développé en parallèle côté sidecar) :
 *   taches.list {} → {taches: TacheInfo[]}
 *   taches.read {name} → {tache, raw, path}
 *   taches.write {tache?|raw+name?} → {tache, path}
 *   taches.delete {name} → {deleted}
 *   taches.reports {name} → {reports: TacheReportInfo[]}
 *   taches.reportRead {name, file} → {content}
 *   taches.timerStatus {names?} → {timers: {[name]: TacheTimerStatus}}
 *   taches.timerApply {name} → {unit, enabled}
 *   taches.timerRemove {name} → {removed}
 *
 * Contrairement à `agents.*`/`orch.*`, aucune de ces méthodes ne prend de
 * `cwd`/`scope` : une tâche vit dans un répertoire racine unique côté
 * sidecar (`${XDG_CONFIG_HOME}/net.duvam.iaction/taches/<nom>/`).
 *
 * Les erreurs de validation reviennent comme un rejet de `request()` (event
 * `error` du protocole, voir sidecar.ts) avec un message français précis —
 * pas de champ `error` séparé à extraire ici, `await` suffit.
 */
import { request } from "./sidecar";

/** Une tâche telle que renvoyée par `taches.list`/`taches.read`. */
export interface TacheInfo {
  name: string;
  description: string;
  orchestration: string;
  schedule: string | null;
  inputs: Record<string, string>;
  report: string | null;
  enabled: boolean;
  /** Répertoire projet (chemin absolu) où résoudre l'orchestration — null = orchestrations globales. */
  cwd: string | null;
  path: string;
  /** Présent si le manifeste n'a pas pu être chargé/validé — le reste des champs est alors best-effort. */
  invalid?: string;
}

/** Valeurs éditables envoyées à `taches.write {tache}`. */
export interface TacheWriteInput {
  name: string;
  description: string;
  orchestration: string;
  schedule: string | null;
  inputs: Record<string, string>;
  report: string | null;
  enabled: boolean;
  cwd: string | null;
}

export interface TacheWriteResult {
  tache: TacheInfo;
  path: string;
}

export interface TacheReadResult {
  tache: TacheInfo;
  raw: string;
  path: string;
}

/** Une entrée de `taches.reports` — fichier `*.md` sous `<dossier>/rapports/`. */
export interface TacheReportInfo {
  file: string;
  mtimeMs: number;
  size: number;
}

function toTacheInputs(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function toTacheInfo(value: unknown): TacheInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name) return null;
  const info: TacheInfo = {
    name: v.name,
    description: typeof v.description === "string" ? v.description : "",
    orchestration: typeof v.orchestration === "string" ? v.orchestration : "",
    schedule: typeof v.schedule === "string" ? v.schedule : null,
    inputs: toTacheInputs(v.inputs),
    report: typeof v.report === "string" ? v.report : null,
    enabled: v.enabled === true,
    cwd: typeof v.cwd === "string" ? v.cwd : null,
    path: typeof v.path === "string" ? v.path : "",
  };
  if (typeof v.invalid === "string" && v.invalid) info.invalid = v.invalid;
  return info;
}

/** Liste toutes les tâches déclarées (pas de portée : répertoire racine unique côté sidecar). */
export async function tachesList(): Promise<TacheInfo[]> {
  const { done } = request("taches.list", {});
  const data = await done;
  if (!Array.isArray(data.taches)) return [];
  const out: TacheInfo[] = [];
  for (const raw of data.taches) {
    const info = toTacheInfo(raw);
    if (info) out.push(info);
  }
  return out;
}

/** Lit une tâche (source de vérité disque) : `tache` décodée + `raw` (texte YAML brut, onglet YAML). */
export async function tachesRead(name: string): Promise<TacheReadResult> {
  const { done } = request("taches.read", { name });
  const data = await done;
  const tache = toTacheInfo(data.tache);
  if (!tache) throw new Error("Réponse taches.read invalide : tâche manquante.");
  return {
    tache,
    raw: typeof data.raw === "string" ? data.raw : "",
    path: typeof data.path === "string" ? data.path : "",
  };
}

/**
 * Écrit une tâche — exactement un de `raw` (onglet YAML brut, `name` requis
 * et doit égaler le `name` du YAML) ou `tache` (onglet Formulaire). Crée le
 * dossier de la tâche (et `rapports/`) au besoin.
 */
export async function tachesWrite(
  body: { raw: string; name: string } | { tache: TacheWriteInput },
): Promise<TacheWriteResult> {
  const payload: Record<string, unknown> = {};
  if ("raw" in body) {
    payload.raw = body.raw;
    payload.name = body.name;
  } else {
    payload.tache = body.tache;
  }
  const { done } = request("taches.write", payload);
  const data = await done;
  const tache = toTacheInfo(data.tache);
  if (!tache) throw new Error("Réponse taches.write invalide : tâche manquante.");
  return { tache, path: typeof data.path === "string" ? data.path : "" };
}

/** Supprime UNIQUEMENT le manifeste `tache.yaml` — dossier, `.iaction/`, `.mcp.json` et `rapports/` restent en place. */
export async function tachesDelete(name: string): Promise<boolean> {
  const { done } = request("taches.delete", { name });
  const data = await done;
  return data.deleted === true;
}

function toTacheReportInfo(value: unknown): TacheReportInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.file !== "string" || !v.file) return null;
  return {
    file: v.file,
    mtimeMs: typeof v.mtimeMs === "number" && Number.isFinite(v.mtimeMs) ? v.mtimeMs : 0,
    size: typeof v.size === "number" && Number.isFinite(v.size) ? v.size : 0,
  };
}

/** Rapports `*.md` de la tâche, triés du plus récent au plus ancien (mtime) — [] si dossier `rapports/` absent. */
export async function tachesReports(name: string): Promise<TacheReportInfo[]> {
  const { done } = request("taches.reports", { name });
  const data = await done;
  if (!Array.isArray(data.reports)) return [];
  const out: TacheReportInfo[] = [];
  for (const raw of data.reports) {
    const info = toTacheReportInfo(raw);
    if (info) out.push(info);
  }
  return out;
}

/** Contenu Markdown d'un rapport (`file` : nom simple, sans séparateur de chemin — garde côté sidecar). */
export async function tachesReportRead(name: string, file: string): Promise<string> {
  const { done } = request("taches.reportRead", { name, file });
  const data = await done;
  return typeof data.content === "string" ? data.content : "";
}

/** Statut du timer systemd d'une tâche — voir `taches.timerStatus` (docs/protocol.md § T2). */
export interface TacheTimerStatus {
  unit: string;
  exists: boolean;
  enabled: boolean;
  active: boolean;
  /** ms epoch, `null` si systemd ne fournit rien (ou timer absent/désactivé). */
  nextMs: number | null;
  lastMs: number | null;
}

function toTacheTimerStatus(value: unknown): TacheTimerStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.unit !== "string" || !v.unit) return null;
  return {
    unit: v.unit,
    exists: v.exists === true,
    enabled: v.enabled === true,
    active: v.active === true,
    nextMs: typeof v.nextMs === "number" && Number.isFinite(v.nextMs) ? v.nextMs : null,
    lastMs: typeof v.lastMs === "number" && Number.isFinite(v.lastMs) ? v.lastMs : null,
  };
}

/** Statut des timers systemd des tâches (`names` absent = toutes les tâches déclarées). */
export async function tachesTimerStatus(names?: string[]): Promise<Record<string, TacheTimerStatus>> {
  const { done } = request("taches.timerStatus", names ? { names } : {});
  const data = await done;
  const out: Record<string, TacheTimerStatus> = {};
  if (typeof data.timers === "object" && data.timers !== null) {
    for (const [name, raw] of Object.entries(data.timers as Record<string, unknown>)) {
      const status = toTacheTimerStatus(raw);
      if (status) out[name] = status;
    }
  }
  return out;
}

export interface TacheTimerApplyResult {
  unit: string;
  enabled: boolean;
}

/** (Ré)écrit et (dés)active les unités systemd d'une tâche depuis son manifeste — `schedule` requis côté sidecar. */
export async function tachesTimerApply(name: string): Promise<TacheTimerApplyResult> {
  const { done } = request("taches.timerApply", { name });
  const data = await done;
  return {
    unit: typeof data.unit === "string" ? data.unit : "",
    enabled: data.enabled === true,
  };
}

/** Désactive et supprime les unités systemd d'une tâche — à appeler AVANT `tachesDelete` (jamais de timer orphelin). */
export async function tachesTimerRemove(name: string): Promise<boolean> {
  const { done } = request("taches.timerRemove", { name });
  const data = await done;
  return data.removed === true;
}
