import { toMessage } from "./base";
/*
 * Hook d'état des projets déclarés pour toute l'app : charge la config au
 * montage et expose la liste + les actions d'édition pour la page
 * « Configuration » ; la page « Projets » (AgentPage) ne fait que lire
 * `projects`/`loadState`.
 *
 * Même architecture StrictMode-safe que useProviders.ts (leçon durement
 * apprise là-bas) : le `useRef` d'initialisation évite un double chargement
 * en StrictMode (montage/démontage/remontage en dev). ATTENTION : l'ÉTAT du
 * composant survit à ce cycle démontage/remontage — il ne faut donc SURTOUT
 * PAS annuler les setState de l'init au démontage (pas de flag `cancelled`
 * ici), sinon ils ne s'appliqueraient jamais puisque l'init ne re-tourne
 * pas. Contrairement à useProviders, il n'y a pas de poussée vers le
 * sidecar ici (les projets ne sont pas envoyés au sidecar) : donc pas de
 * retry/`ready` à gérer.
 */
import { useEffect, useRef, useState } from "react";
import {
  addProject as addProjectAdmin,
  deleteProject as deleteProjectAdmin,
  readProjects,
  updateProject as updateProjectAdmin,
  type ProjectConfig,
} from "./projectAdmin";

export type ProjectsLoadState = "loading" | "ready" | "error";

export interface UseProjectsResult {
  projects: ProjectConfig[];
  loadState: ProjectsLoadState;
  errorMessage: string;
  addProject: (name: string, path: string) => Promise<void>;
  updateProject: (id: string, patch: Partial<Pick<ProjectConfig, "name" | "path">>) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
}


export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [loadState, setLoadState] = useState<ProjectsLoadState>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const initialized = useRef(false);

  useEffect(() => {
    // L'init ne tourne qu'une fois (StrictMode : voir commentaire d'en-tête).
    if (initialized.current) return;
    initialized.current = true;

    (async () => {
      try {
        const list = await readProjects();
        setProjects(list);
        setLoadState("ready");
      } catch (err) {
        setErrorMessage(toMessage(err));
        setLoadState("error");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addProject(name: string, path: string): Promise<void> {
    const next = await addProjectAdmin(name, path);
    setProjects(next);
  }

  async function updateProject(id: string, patch: Partial<Pick<ProjectConfig, "name" | "path">>): Promise<void> {
    const next = await updateProjectAdmin(id, patch);
    setProjects(next);
  }

  async function deleteProject(id: string): Promise<void> {
    const next = await deleteProjectAdmin(id);
    setProjects(next);
  }

  return { projects, loadState, errorMessage, addProject, updateProject, deleteProject };
}
