/*
 * Wrappers typés autour des commandes Tauri « état applicatif » (Lot 3, voir
 * docs/protocol.md « Commandes Tauri état applicatif (Lot 3) ») :
 * `state_read` / `state_write` (persistance de petits documents JSON par clé
 * dans `{app_data_dir}/state/<name>.json`, séparée de la config éditable à la
 * main — voir appConfig.ts) et `fs_mkdir` (groupée dans le même lot côté
 * protocole, utilisée par l'init `.iaction/` d'un projet — voir
 * projectAdmin.ts). Un seul point de contact avec `invoke` pour ces trois
 * commandes, contrat camelCase respecté à la lettre.
 */
import { invoke } from "@tauri-apps/api/core";

/** Lit l'état persisté sous `name` (objet vide si absent). `name` : `[a-z0-9-]{1,64}`. */
export async function stateRead<T = unknown>(name: string): Promise<T> {
  return invoke<T>("state_read", { name });
}

/** Écrit (remplace intégralement) l'état persisté sous `name` — écriture atomique côté Rust. */
export async function stateWrite(name: string, value: unknown): Promise<void> {
  await invoke("state_write", { name, value });
}

/** Noms d'état existants commençant par `prefix`, triés (T-061 — état éclaté). */
export async function stateList(prefix: string): Promise<string[]> {
  return invoke<string[]>("state_list", { prefix });
}

/** Renomme un état — refuse d'écraser la cible (T-061 : rien ne détruit un historique). */
export async function stateRename(name: string, newName: string): Promise<void> {
  await invoke("state_rename", { name, newName });
}

/** Création récursive d'un répertoire. */
export async function fsMkdir(path: string): Promise<void> {
  await invoke("fs_mkdir", { path });
}
