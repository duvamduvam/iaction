/*
 * Onglets de fichiers de la page Projets — transformations pures de la liste
 * `OpenFileState[]`, sorties d'AgentPage.tsx (T-209). Chaque fonction rend une
 * nouvelle liste ; la page garde `setOpenFiles`.
 */
import type { OpenFileState } from "./FileEditor";
import type { FileContent } from "./fsClient";
import { isUnderPath, renamedPath } from "./hydratationProjet";

/** Onglet qui vient d'être ouvert, contenu pas encore lu. */
export function ongletEnChargement(path: string, name: string): OpenFileState {
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
}

/** Modifie l'onglet `path` (les autres sont rendus tels quels). */
export function ongletModifie(
  files: OpenFileState[],
  path: string,
  patch: Partial<OpenFileState>,
): OpenFileState[] {
  return files.map((f) => (f.path === path ? { ...f, ...patch } : f));
}

/** Lecture réussie : le contenu remplace l'état « en chargement » et l'onglet n'est plus modifié. */
export function ongletLu(files: OpenFileState[], path: string, fc: FileContent): OpenFileState[] {
  return ongletModifie(files, path, {
    kind: fc.kind,
    content: fc.text ?? "",
    base64: fc.base64 ?? "",
    size: fc.size,
    truncated: fc.truncated,
    dirty: false,
  });
}

/** Onglets renommés (fichier ou dossier parent), nom recalculé depuis le nouveau chemin. */
export function ongletsRenommes(files: OpenFileState[], oldPath: string, newPath: string): OpenFileState[] {
  return files.map((f) => {
    const path = renamedPath(f.path, oldPath, newPath);
    if (path === f.path) return f;
    return { ...f, path, name: path.slice(path.lastIndexOf("/") + 1) || path };
  });
}

/** Onglets restants après suppression de `path` (et de ses descendants si c'était un dossier). */
export function ongletsSansChemin(files: OpenFileState[], path: string): OpenFileState[] {
  return files.filter((f) => !isUnderPath(f.path, path));
}
