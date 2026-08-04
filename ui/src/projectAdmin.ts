/*
 * Administration des projets déclarés (page « Configuration ») : config
 * non-secrète (nom + répertoire) via `appConfig` (lecture → fusion →
 * écriture du document complet, voir appConfig.ts). Aucun secret associé à
 * un projet — contrairement aux fournisseurs, pas de trousseau OS ici.
 *
 * `id` = slug stable dérivé du nom (normalisé, sans accents, minuscules,
 * séparateurs `-`), dé-collisionné par suffixe numérique si nécessaire.
 * Généré une seule fois à la création ; ne change pas si le nom est
 * renommé ensuite (évite de casser une éventuelle référence future à l'id).
 */
import { readConfig, writeConfig } from "./appConfig";
import { fsWriteFile } from "./fsClient";
import { fsMkdir } from "./stateClient";

/** R5 — mode connaissances d'un projet : injection intégrale au 1er tour (défaut,
 * comportement historique) ou RAG via l'outil `search_knowledge` (docs/spec-r5-rag.md §4). */
export type KnowledgeMode = "injection" | "rag";

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  /** R5 — absent = "injection" (comportement historique strictement inchangé). */
  connaissancesMode?: KnowledgeMode;
}

function isProjectConfig(value: unknown): value is ProjectConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" && typeof v.path === "string";
}

/** Lit la config non-secrète et renvoie la liste des projets ([] si absente/vide). */
export async function readProjects(): Promise<ProjectConfig[]> {
  const raw = await readConfig();
  const projects = raw.projects;
  if (!Array.isArray(projects)) return [];
  return projects.filter(isProjectConfig);
}

/** Écrit la liste des projets dans la config non-secrète (fusion racine, cf. appConfig.ts). */
export async function writeProjects(projects: ProjectConfig[]): Promise<void> {
  await writeConfig({ projects });
}

function slugify(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // diacritiques (accents combinants apres normalize("NFD"))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "projet";
}

function uniqueId(base: string, existingIds: string[]): string {
  if (!existingIds.includes(base)) return base;
  let n = 2;
  while (existingIds.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** Ajoute un projet (id slug généré depuis le nom) et renvoie la liste à jour. */
export async function addProject(name: string, path: string): Promise<ProjectConfig[]> {
  const projects = await readProjects();
  const id = uniqueId(
    slugify(name),
    projects.map((p) => p.id),
  );
  const next = [...projects, { id, name, path }];
  await writeProjects(next);
  return next;
}

/** Modifie le nom et/ou le chemin d'un projet existant (id inchangé). */
export async function updateProject(
  id: string,
  patch: Partial<Pick<ProjectConfig, "name" | "path">>,
): Promise<ProjectConfig[]> {
  const projects = await readProjects();
  const next = projects.map((p) => (p.id === id ? { ...p, ...patch } : p));
  await writeProjects(next);
  return next;
}

/** Supprime un projet. */
export async function deleteProject(id: string): Promise<ProjectConfig[]> {
  const projects = await readProjects();
  const next = projects.filter((p) => p.id !== id);
  await writeProjects(next);
  return next;
}

/**
 * R5 — mode connaissances d'un projet, relu à la demande depuis la config
 * (source de vérité : le disque, comme tout le registre). Projet inconnu ou
 * champ absent/invalide → "injection" (défaut, comportement historique).
 */
export async function readProjectKnowledgeMode(id: string): Promise<KnowledgeMode> {
  const projects = await readProjects();
  const project = projects.find((p) => p.id === id);
  return project?.connaissancesMode === "rag" ? "rag" : "injection";
}

/**
 * R5 — persiste le mode connaissances d'un projet (lecture fraîche → patch →
 * écriture, même cycle que updateProject : les autres champs, y compris ceux
 * posés par d'autres pages, survivent). "injection" retire le champ (défaut).
 */
export async function writeProjectKnowledgeMode(id: string, mode: KnowledgeMode): Promise<void> {
  const projects = await readProjects();
  const next = projects.map((p) => {
    if (p.id !== id) return p;
    if (mode === "injection") {
      const { connaissancesMode: _omitted, ...rest } = p;
      return rest;
    }
    return { ...p, connaissancesMode: mode };
  });
  await writeProjects(next);
}

/**
 * Initialise `.iaction/` dans le répertoire d'un projet fraîchement déclaré
 * (case à cocher du formulaire d'ajout, voir ProvidersPage.tsx) : crée le
 * dossier puis y écrit `project.json` (nom + date de création ISO). Best
 * effort — l'appelant doit traiter un rejet comme un avertissement non
 * bloquant : le projet reste déclaré dans le registre même si cette init
 * échoue (dossier en lecture seule, chemin invalide, etc.).
 */
export async function initProjectIaction(name: string, path: string): Promise<void> {
  const dir = `${path}/.iaction`;
  await fsMkdir(dir);
  const payload = { name, createdAt: new Date().toISOString() };
  await fsWriteFile(`${dir}/project.json`, `${JSON.stringify(payload, null, 2)}\n`);
}
