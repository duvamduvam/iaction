/*
 * Fonctions PURES de la page Projets sorties d'AgentPage.tsx (qui est au
 * plafond de son cliquet de taille) : reconstruction de l'état d'un projet
 * depuis son entrée persistée, et arithmétique de chemins pour le menu
 * contextuel de l'arbre. Aucun état, aucune IO.
 */

import type { OpenFileState } from "./FileEditor";
import {
  convIdOfTab,
  convTabId,
  EMPTY_TAB,
  emptyProjectState,
  isConvTab,
  sessionStateFromPersisted,
  type PersistedProjectEntry,
  type ProjectState,
} from "./modeleProjet";

/* ---------- État par projet (Lot Sessions : plusieurs sessions/projet) ---------- */

function openFilesFromPaths(paths: string[], pendingLazy: Set<string>): OpenFileState[] {
  return paths.map((path) => {
    pendingLazy.add(path);
    const name = path.slice(path.lastIndexOf("/") + 1) || path;
    return {
      path,
      name,
      kind: "loading",
      content: "",
      base64: "",
      size: 0,
      truncated: false,
      dirty: false,
      saving: false,
      saveError: null,
      errorMessage: null,
    };
  });
}

export function projectStateFromPersisted(entry: PersistedProjectEntry, pendingLazy: Set<string>): ProjectState {
  const sessions = entry.sessions.map(sessionStateFromPersisted);
  if (sessions.length === 0) return emptyProjectState();
  const activeId = sessions.some((s) => s.id === entry.activeId) ? entry.activeId : sessions[0].id;
  const openFiles = openFilesFromPaths(entry.openFilePaths, pendingLazy);
  const knownConvIds = entry.openConversationIds.filter((id) => sessions.some((s) => s.id === id));
  const openConversationIds = knownConvIds.length > 0 ? knownConvIds : [activeId];
  const activeTab =
    entry.activeTab === EMPTY_TAB ||
    entry.openFilePaths.includes(entry.activeTab) ||
    (isConvTab(entry.activeTab) && openConversationIds.includes(convIdOfTab(entry.activeTab)))
      ? entry.activeTab
      : convTabId(activeId);
  return { sessions, activeId, openConversationIds, openFiles, activeTab };
}

/* ---------- Menu contextuel de l'arbre : renommer/supprimer (voir FileTree.tsx) ---------- */

/** `path` égal à `target`, ou situé dedans (`target` renommé/supprimé était un DOSSIER). */
export function isUnderPath(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}/`);
}

/** Réécrit `path` si renommé — inchangé s'il ne correspond ni à `oldPath` ni à un de ses descendants. */
export function renamedPath(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
  return path;
}
