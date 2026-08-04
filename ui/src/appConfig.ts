/*
 * Point d'accès unique à la config non-secrète (commandes Tauri
 * `config_read` / `config_write`, voir docs/protocol.md). Document JSON
 * `{ providers: [...], projects: [...], ...reste }`.
 *
 * ⚠ `config_write` REMPLACE tout le fichier côté Rust (pas de fusion :
 * `read_config_from`/`write_config_to` dans src-tauri/src/config_store.rs
 * sérialisent tel quel, sans schéma). Toute écriture doit donc lire le
 * document existant, fusionner au niveau racine (chaque clé de `patch`
 * remplace entièrement la clé correspondante, les clés absentes de `patch`
 * sont préservées), puis écrire le document complet. C'est le SEUL module
 * qui appelle `config_write` — providerAdmin.ts et projectAdmin.ts passent
 * tous les deux par `writeConfig`.
 */
import { invoke } from "@tauri-apps/api/core";

export interface AppConfig {
  providers?: unknown;
  projects?: unknown;
  [key: string]: unknown;
}

/** Lit le document de config complet (`{}` si le fichier est absent). */
export async function readConfig(): Promise<AppConfig> {
  const raw = await invoke<unknown>("config_read");
  if (typeof raw !== "object" || raw === null) return {};
  return raw as AppConfig;
}

/**
 * Fusionne `patch` dans le document existant au niveau racine puis écrit le
 * document complet. Lit toujours l'existant en premier pour ne pas écraser
 * les clés inconnues (ou celles gérées par un autre module).
 */
export async function writeConfig(patch: Partial<AppConfig>): Promise<void> {
  const current = await readConfig();
  const next: AppConfig = { ...current, ...patch };
  await invoke("config_write", { value: next });
}
