/*
 * Résolution des répertoires de l'application — un seul endroit qui connaît le
 * nom du produit sur le disque.
 *
 * Le produit s'appelait « IA Studio » (`net.duvam.ia-studio`, dossier projet
 * `.iadadou/`) jusqu'au renommage en IAction du 2026-08-07. Les données
 * DÉJÀ POSÉES sur les postes et dans les projets portent donc l'ancien nom :
 * on ne les déplace pas dans le dos de l'utilisateur, on les LIT là où elles
 * sont. Règle unique, appliquée partout :
 *
 *   dossier au nouveau nom absent ET dossier à l'ancien nom présent
 *     ⇒ on travaille dans l'ancien
 *   sinon ⇒ nouveau nom (cas d'une installation neuve, et cas d'un poste migré)
 *
 * Conséquence voulue : un poste non migré continue de tourner sans rien perdre,
 * un poste migré (voir scripts/migrer-vers-iaction.sh) n'a plus jamais affaire à
 * l'ancien nom, et un projet neuf reçoit `.iaction/`. Le repli disparaîtra quand
 * plus aucun poste ne portera l'ancien nommage.
 *
 * Jamais de cache : les tests redéfinissent XDG_CONFIG_HOME / XDG_DATA_HOME
 * entre deux appels et doivent être suivis (même convention que les modules qui
 * appelaient ces chemins avant la centralisation).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Identifiant du produit sur le disque (config, données). */
export const APP_ID = "net.duvam.iaction";
/** Ancien identifiant, encore porteur des données des postes non migrés. */
export const LEGACY_APP_ID = "net.duvam.ia-studio";

/** Dossier du produit DANS un projet. */
export const PROJECT_DIR = ".iaction";
/** Ancien dossier projet — encore présent dans les projets non migrés. */
export const LEGACY_PROJECT_DIR = ".iadadou";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDir(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Applique la règle de repli — sur la présence d'un TÉMOIN, jamais sur celle du
 * dossier.
 *
 * L'existence du dossier ne prouve rien : la coquille Tauri crée
 * `~/.local/share/<identifiant>` (WebKit) et `~/.config/<identifiant>` d'elle-même
 * au premier lancement, sans y mettre la moindre donnée de l'application. Se
 * fier au dossier faisait donc basculer un poste non migré vers un dossier
 * VIDE, où l'application réécrivait aussitôt une configuration par défaut —
 * projets et fournisseurs apparemment perdus (incident du 2026-08-07, constaté
 * sur le poste de dev pendant le renommage lui-même).
 *
 * Le témoin est un fichier/dossier que SEULE l'application écrit : sa présence
 * du côté de l'ancien nom, et son absence du côté du nouveau, signent un poste
 * non migré dont les données vivent encore à l'ancienne adresse.
 */
function preferByWitness(current: string, legacy: string, witness: string): string {
  if (!fs.existsSync(path.join(current, witness)) && fs.existsSync(path.join(legacy, witness))) {
    return legacy;
  }
  return current;
}

/** `${XDG_CONFIG_HOME ?? ~/.config}/<app>` — config globale (agents, tâches, logs, usage). */
export function globalConfigRoot(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = isNonEmptyString(xdg) ? xdg : path.join(os.homedir(), ".config");
  // Témoin : `config.json`, écrit par le sidecar seul (la coquille n'y touche pas).
  return preferByWitness(path.join(base, APP_ID), path.join(base, LEGACY_APP_ID), "config.json");
}

/** `${XDG_DATA_HOME ?? ~/.local/share}/<app>` — état (conversations…), miroir de la coquille Rust. */
export function globalDataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = isNonEmptyString(xdg) ? xdg : path.join(os.homedir(), ".local", "share");
  // Témoin : `state/`, écrit par le sidecar — le reste (WebKitCache, storage…)
  // appartient à la coquille et apparaît AVANT toute migration.
  return preferByWitness(path.join(base, APP_ID), path.join(base, LEGACY_APP_ID), "state");
}

/**
 * Dossier du produit dans un projet, éventuellement suivi d'un sous-chemin :
 * `projectDir(cwd, "connaissances")` → `<cwd>/.iaction/connaissances`, ou
 * `<cwd>/.iadadou/connaissances` si le projet n'a que l'ancien dossier.
 */
export function projectDir(cwd: string, ...parts: string[]): string {
  const root = path.resolve(cwd);
  // Ici le dossier lui-même EST le témoin : personne d'autre que l'application
  // ne crée `.iaction/` ni `.iadadou/` dans un projet.
  const current = path.join(root, PROJECT_DIR);
  const legacy = path.join(root, LEGACY_PROJECT_DIR);
  const dir = !isDir(current) && isDir(legacy) ? legacy : current;
  return parts.length > 0 ? path.join(dir, ...parts) : dir;
}
