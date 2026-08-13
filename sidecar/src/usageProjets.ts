/**
 * S2 — attribution de l'usage AUX PROJETS : « qui consomme quoi », matière de
 * l'encart « Usage par projet » de Supervision (voir docs/protocol.md §
 * `usage.stats`, champ `parProjet`).
 *
 * Extrait de `usageStats.ts`, qui mélangeait trois responsabilités : écrire le
 * journal d'usage, l'agréger, et résoudre l'appartenance d'un tour à un projet.
 * Seule la troisième vit ici. Tout y est en LECTURE SEULE et tolérant : un
 * fichier absent ou cassé fait retomber l'attribution sur « (non attribué) »,
 * jamais sur une exception — la supervision ne doit pas tomber parce qu'une
 * config est illisible.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { isNonEmptyString, isPlainObject } from "./base.js";
import { globalConfigRoot } from "./jsonlStore.js";
import { globalDataRoot } from "./appPaths.js";

/**
 * S2 — registre des projets déclarés, écrit par l'UI (coquille Rust,
 * `config_read`/`config_write`) dans `config.json` du MÊME répertoire de
 * config que les JSONL d'usage. Lu ici en LECTURE SEULE et uniquement pour
 * mettre un nom (et un id stable) sur les tours attribués à un projet — le
 * sidecar ne pilote toujours rien à partir de ce fichier.
 */
function appConfigPath(): string {
  return path.join(globalConfigRoot(), "config.json");
}

/**
 * S2 — état applicatif persisté par l'UI (`state_read`/`state_write` côté
 * Rust : `{app_data_dir}/state/<name>.json`, soit
 * `${XDG_DATA_HOME ?? ~/.local/share}/net.duvam.iaction/state/`). Seul
 * `project-conversations.json` est lu ici, en LECTURE SEULE : il relie chaque
 * conversation à son projet, ce qui permet d'attribuer RÉTROACTIVEMENT les
 * tours historisés avant S2 (ils ne portent qu'un `conversationId`).
 */
function projectConversationsPath(): string {
  return path.join(globalDataRoot(), "state", "project-conversations.json");
}

// ---------------------------------------------------------------------------
// S2 — agrégat `parProjet` : qui consomme quoi (encart « Usage par projet »).
// ---------------------------------------------------------------------------

interface ProjectEntry {
  id: string;
  name: string;
  path: string;
}

/**
 * Projets déclarés, lus depuis `config.json` (lecture seule, tolérante :
 * fichier absent, JSON cassé ou entrée mal formée → simplement ignorés). Sert
 * à nommer les projets et à rattacher un run à son projet par son répertoire.
 */
export async function readDeclaredProjects(): Promise<ProjectEntry[]> {
  let doc: unknown;
  try {
    doc = JSON.parse(await fsp.readFile(appConfigPath(), "utf8"));
  } catch {
    // Config absente ou illisible : l'attribution par id fonctionne encore,
    // les projets s'afficheront sous leur id brut.
    return [];
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.projects)) {
    return [];
  }
  const out: ProjectEntry[] = [];
  for (const raw of doc.projects) {
    if (isPlainObject(raw) && isNonEmptyString(raw.id) && isNonEmptyString(raw.name) && isNonEmptyString(raw.path)) {
      out.push({ id: raw.id, name: raw.name, path: raw.path });
    }
  }
  return out;
}

/**
 * Conversation → projet, depuis `project-conversations.json` (structure
 * `{[projectId]: {sessions: [{id}]}}`). Tolérant : fichier absent, JSON cassé
 * ou entrée mal formée → map vide, l'attribution retombe simplement sur
 * « (non attribué) ». Une conversation supprimée depuis disparaît de la map :
 * ses vieux tours redeviennent non attribués — on n'invente rien.
 */
export async function readConversationProjects(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let doc: unknown;
  try {
    doc = JSON.parse(await fsp.readFile(projectConversationsPath(), "utf8"));
  } catch {
    return out;
  }
  if (!isPlainObject(doc)) {
    return out;
  }
  for (const [projectId, state] of Object.entries(doc)) {
    if (!isPlainObject(state) || !Array.isArray(state.sessions)) {
      continue;
    }
    for (const session of state.sessions) {
      if (isPlainObject(session) && isNonEmptyString(session.id)) {
        out.set(session.id, projectId);
      }
    }
  }
  return out;
}

/** Pseudo-projet « Chat » : la page Chat compte comme un projet à part entière. */
const CHAT_PROJECT_ID = "chat";

/** Comparaison de répertoires : chemin absolu résolu (path.resolve retire déjà le séparateur final). */
function normalizeDir(p: string): string {
  return path.resolve(p);
}

export interface ProjectIndex {
  byId: Map<string, ProjectEntry>;
  byPath: Map<string, ProjectEntry>;
  /** Conversation → id de projet (rattrapage des tours d'avant S2). */
  byConversation: Map<string, string>;
}

export function indexProjects(projects: ProjectEntry[], byConversation: Map<string, string>): ProjectIndex {
  const byId = new Map<string, ProjectEntry>();
  const byPath = new Map<string, ProjectEntry>();
  for (const p of projects) {
    byId.set(p.id, p);
    byPath.set(normalizeDir(p.path), p);
  }
  return { byId, byPath, byConversation };
}

/**
 * Projet auquel imputer un événement, par ordre de précision :
 * 1. `projectId` posé par l'UI (page Projets) ;
 * 2. `projectPath` = répertoire du run (orchestrations et tâches de fond),
 *    rattaché au projet déclaré de même chemin — sinon gardé tel quel sous
 *    un id `chemin:<dir>`, pour ne pas noyer un usage réel dans le résidu ;
 * 3. `source: "chat"` → pseudo-projet « Chat » ;
 * 4. `conversationId` connu de `project-conversations.json` — c'est le
 *    rattrapage des tours historisés AVANT S2, qui ne portent rien d'autre ;
 * 5. rien d'exploitable → « (non attribué) ».
 */
function resolveProjet(ev: Record<string, unknown>, index: ProjectIndex): { id: string | null; name: string } {
  if (isNonEmptyString(ev.projectId)) {
    return { id: ev.projectId, name: index.byId.get(ev.projectId)?.name ?? ev.projectId };
  }
  if (isNonEmptyString(ev.projectPath)) {
    const dir = normalizeDir(ev.projectPath);
    const known = index.byPath.get(dir);
    return known ? { id: known.id, name: known.name } : { id: `chemin:${dir}`, name: path.basename(dir) || dir };
  }
  if (ev.source === "chat") {
    return { id: CHAT_PROJECT_ID, name: "Chat" };
  }
  if (isNonEmptyString(ev.conversationId)) {
    const projectId = index.byConversation.get(ev.conversationId);
    if (projectId) {
      return { id: projectId, name: index.byId.get(projectId)?.name ?? projectId };
    }
  }
  return { id: null, name: "(non attribué)" };
}

export interface ProjetAgg {
  id: string | null;
  name: string;
  tours: number;
  totalTokens: number;
  /** Tours issus d'une orchestration (marqueur `orchRunId`) — la part « autonome ». */
  autonomeTours: number;
  autonomeTokens: number;
}

export function applyProjetEvent(aggs: Map<string, ProjetAgg>, ev: Record<string, unknown>, index: ProjectIndex): void {
  const { id, name } = resolveProjet(ev, index);
  // Clé de regroupement : l'id, et `""` pour le résidu non attribué (id null).
  const key = id ?? "";
  let agg = aggs.get(key);
  if (!agg) {
    agg = { id, name, tours: 0, totalTokens: 0, autonomeTours: 0, autonomeTokens: 0 };
    aggs.set(key, agg);
  }
  const pt = typeof ev.promptTokens === "number" ? ev.promptTokens : 0;
  const ct = typeof ev.completionTokens === "number" ? ev.completionTokens : 0;
  const tokens = pt + ct;
  agg.tours += 1;
  agg.totalTokens += tokens;
  if (isNonEmptyString(ev.orchRunId)) {
    agg.autonomeTours += 1;
    agg.autonomeTokens += tokens;
  }
}

/**
 * Parts en % des tokens (métrique retenue : c'est le proxy le plus fidèle de
 * la consommation réelle), arrondies — la somme peut donc valoir 99 ou 101.
 * `null` quand le dénominateur est nul (aucun token compté sur la période :
 * l'abonnement Claude ne remonte pas toujours de tokens). Tri par tokens
 * décroissants, puis par tours ; le résidu « (non attribué) » finit toujours
 * dernier, ce n'est pas un projet.
 */
export function finalizeParProjet(
  aggs: Map<string, ProjetAgg>,
  totalTokens: number,
): Array<{
  projectId: string | null;
  name: string;
  tours: number;
  totalTokens: number;
  partTokensPct: number | null;
  autonomeTours: number;
  autonomeTokens: number;
  autonomePct: number | null;
}> {
  return [...aggs.values()]
    .map((a) => ({
      projectId: a.id,
      name: a.name,
      tours: a.tours,
      totalTokens: a.totalTokens,
      partTokensPct: totalTokens > 0 ? Math.round((a.totalTokens / totalTokens) * 100) : null,
      autonomeTours: a.autonomeTours,
      autonomeTokens: a.autonomeTokens,
      autonomePct: a.totalTokens > 0 ? Math.round((a.autonomeTokens / a.totalTokens) * 100) : null,
    }))
    .sort((a, b) => {
      if ((a.projectId === null) !== (b.projectId === null)) {
        return a.projectId === null ? 1 : -1;
      }
      return b.totalTokens - a.totalTokens || b.tours - a.tours;
    });
}