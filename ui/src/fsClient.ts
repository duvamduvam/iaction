/*
 * Wrappers typés autour des commandes Tauri fichiers (mini-tranche du Lot 4,
 * voir docs/protocol.md « Commandes Tauri fichiers ») : `fs_list_dir`,
 * `fs_read_file`, `fs_write_file`, `fs_find_by_name`. Utilisé par
 * FileTree.tsx (arborescence), AgentPage.tsx (éditeur, résolution des
 * références de fichiers cliquables dans les transcriptions) — un seul
 * point de contact avec `invoke` pour ces commandes, contrats camelCase
 * respectés à la lettre.
 */
import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export type FileKind = "text" | "binary" | "image";

export interface FileContent {
  kind: FileKind;
  text?: string;
  base64?: string;
  size: number;
  truncated: boolean;
}

/** Liste (triée dossiers d'abord puis alphabétique, côté Rust) le contenu d'un dossier. */
export async function fsListDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("fs_list_dir", { path });
}

/** Lit un fichier : texte (UTF-8, borné `maxBytes`, défaut 2 Mo), image (base64) ou binaire. */
export async function fsReadFile(path: string, maxBytes?: number): Promise<FileContent> {
  return invoke<FileContent>("fs_read_file", { path, maxBytes: maxBytes ?? null });
}

/** Écriture atomique (temp + rename), UTF-8. */
export async function fsWriteFile(path: string, content: string): Promise<void> {
  await invoke("fs_write_file", { path, content });
}

/**
 * Renomme dans le même dossier (`newName` = nom simple, sans séparateur ; refuse
 * d'écraser une cible existante). Renvoie le nouveau chemin absolu.
 */
export async function fsRename(path: string, newName: string): Promise<string> {
  return invoke<string>("fs_rename", { path, newName });
}

/**
 * Suppression DÉFINITIVE (pas de corbeille) — fichier ou dossier entier. La
 * confirmation utilisateur est à la charge de l'appelant.
 */
export async function fsDelete(path: string): Promise<void> {
  await invoke("fs_delete", { path });
}

/**
 * Cherche, sous `root`, les fichiers nommés exactement `name` (sensible à la
 * casse, BFS, profondeur ≤ 8, dossiers `node_modules`/`target`/`dist`/`.git`/
 * `.venv`/`venv`/`__pycache__` ignorés). `maxResults` défaut 8 côté Rust.
 * Racine inexistante → rejet.
 */
export async function fsFindByName(root: string, name: string, maxResults?: number): Promise<string[]> {
  return invoke<string[]>("fs_find_by_name", { root, name, maxResults: maxResults ?? null });
}
