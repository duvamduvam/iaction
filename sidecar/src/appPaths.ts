/*
 * Résolution des répertoires de l'application — un seul endroit qui connaît le
 * nom du produit sur le disque.
 *
 * Le produit s'appelait « IA Studio » (`net.duvam.ia-studio`, dossier projet
 * `.iadadou/`) jusqu'au renommage en IAction du 2026-08-07.
 *
 * DEUX RÈGLES, et elles diffèrent à dessein :
 *
 * 1. **Dossiers de l'application** (config, données) : une seule adresse, le
 *    NOUVEAU nom. Ce qui reste sous l'ancien est déplacé une fois au démarrage
 *    (`migrerDepuisAncienNom`). Ces dossiers sont partagés avec la coquille
 *    Rust, qui n'a aucun repli : deux couches ne peuvent pas se permettre de
 *    diverger sur l'endroit où vivent les mêmes fichiers.
 *
 * 2. **Dossier dans un PROJET** (`.iaction/` vs `.iadadou/`) : repli conservé.
 *    Ces dossiers appartiennent aux projets de l'utilisateur, pas à nous — on
 *    n'y déplace rien, on lit où c'est. Et seul le sidecar les lit, donc aucune
 *    divergence possible entre couches.
 *
 * Jamais de cache : les tests redéfinissent XDG_CONFIG_HOME / XDG_DATA_HOME
 * entre deux appels et doivent être suivis (même convention que les modules qui
 * appelaient ces chemins avant la centralisation).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isNonEmptyString } from "./base.js";

/** Identifiant du produit sur le disque (config, données). */
export const APP_ID = "net.duvam.iaction";
/** Ancien identifiant, encore porteur des données des postes non migrés. */
export const LEGACY_APP_ID = "net.duvam.ia-studio";

/** Dossier du produit DANS un projet. */
export const PROJECT_DIR = ".iaction";
/** Ancien dossier projet — encore présent dans les projets non migrés. */
export const LEGACY_PROJECT_DIR = ".iadadou";


function isDir(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}


/**
 * Environnement dont dépend la résolution : injecté pour que les DEUX systèmes
 * soient testables depuis n'importe quelle machine.
 *
 * C'est la règle qu'on se donne pour le portage : aucune décision de plateforme
 * ne se lit en dur au milieu du code (`process.platform`), sinon la branche
 * Windows ne s'exerce qu'en allumant un PC Windows — et ce qui ne se teste pas
 * pourrit en silence.
 */
export interface PathEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

function currentEnv(): PathEnv {
  return { platform: process.platform, env: process.env, home: os.homedir() };
}

/**
 * Racine de la CONFIG, sans le nom de l'application.
 *
 * - Windows : `%APPDATA%` (itinérant — c'est la config, elle suit l'utilisateur),
 *   repli `~/AppData/Roaming` si la variable manque.
 * - Ailleurs : `$XDG_CONFIG_HOME` sinon `~/.config`.
 *
 * `XDG_CONFIG_HOME` reste honoré sur TOUTES les plateformes : les tests s'en
 * servent pour isoler le dossier global du poste réel.
 */
function configBase(e: PathEnv): string {
  const xdg = e.env.XDG_CONFIG_HOME;
  if (isNonEmptyString(xdg)) return xdg;
  if (e.platform === "win32") {
    const appData = e.env.APPDATA;
    return isNonEmptyString(appData) ? appData : path.join(e.home, "AppData", "Roaming");
  }
  return path.join(e.home, ".config");
}

/**
 * Racine des DONNÉES, sans le nom de l'application.
 *
 * - Windows : `%APPDATA%` — le profil ITINÉRANT, repli `~/AppData/Roaming`.
 * - Ailleurs : `$XDG_DATA_HOME` sinon `~/.local/share`.
 *
 * Ce n'est pas un choix : c'est un MIROIR OBLIGÉ de ce que résout la coquille
 * Tauri (`app_data_dir()`, src-tauri/src/state_store.rs), qui passe par
 * `dirs::data_dir()` — et sur Windows, `data_dir` vaut `FOLDERID_RoamingAppData`,
 * pas `LocalAppData`. C'est la coquille qui ÉCRIT `state/*.json` (conversations
 * du Chat, conversations par projet) ; le sidecar ne fait que les relire.
 *
 * Ce fichier a un temps résolu `%LOCALAPPDATA%` ici, au motif défendable qu'un
 * état volumineux n'a rien à faire dans un profil itinérant. C'était une erreur :
 * le sidecar lisait un dossier que personne n'écrivait. `search_chat` répondait
 * « aucun historique » et l'usage par projet restait vide, sans la moindre
 * erreur — la panne parfaitement silencieuse. Le raisonnement était bon, mais
 * il ne nous appartient pas : changer d'avis suppose de changer la coquille.
 */
function dataBase(e: PathEnv): string {
  const xdg = e.env.XDG_DATA_HOME;
  if (isNonEmptyString(xdg)) return xdg;
  if (e.platform === "win32") {
    const appData = e.env.APPDATA;
    return isNonEmptyString(appData) ? appData : path.join(e.home, "AppData", "Roaming");
  }
  return path.join(e.home, ".local", "share");
}

/** Config globale (agents, tâches, logs, usage) — voir `configBase`. */
export function globalConfigRoot(env: PathEnv = currentEnv()): string {
  return path.join(configBase(env), APP_ID);
}

/** État (conversations…), miroir de la coquille Rust — voir `dataBase`. */
export function globalDataRoot(env: PathEnv = currentEnv()): string {
  return path.join(dataBase(env), APP_ID);
}

/*
 * ---------------------------------------------------------------------------
 * Migration depuis l'ancien nommage — UNE FOIS, au démarrage
 * ---------------------------------------------------------------------------
 *
 * Ces deux fonctions ont d'abord appliqué un REPLI : si le dossier au nouveau
 * nom n'avait pas son « témoin », on lisait l'ancien. L'intention était bonne
 * (ne rien déplacer dans le dos de l'utilisateur), le résultat mauvais : la
 * coquille Rust, elle, n'a aucun repli — `app_config_dir()`/`app_data_dir()`
 * de Tauri désignent TOUJOURS le nouveau nom. Les deux couches pouvaient donc
 * travailler dans deux dossiers différents en même temps.
 *
 * Pire, le témoin choisi (`config.json`) est écrit par la COQUILLE, pas par le
 * sidecar : à la première sauvegarde de réglages sur un poste non migré, le
 * témoin basculait et le sidecar perdait d'un coup ses `taches/`, `logs/`,
 * `usage/` et `tickets.md` restés dans l'ancien dossier. Un repli censé
 * protéger les données faisait exactement ce qu'il devait empêcher.
 *
 * On règle donc le problème une bonne fois : au démarrage, ce qui reste sous
 * l'ancien nom est DÉPLACÉ sous le nouveau, puis plus personne n'a de double
 * chemin à connaître. Une seule adresse, la même pour les deux couches.
 */

/** Résultat d'une migration, pour le journal (rien à faire → tableaux vides). */
export interface MigrationAncienNom {
  deplaces: string[];
  /** Entrées présentes des DEUX côtés : l'ancienne est laissée en place, jamais écrasée. */
  conflits: string[];
}

function migrerRacine(ancien: string, nouveau: string): MigrationAncienNom {
  const bilan: MigrationAncienNom = { deplaces: [], conflits: [] };
  if (!isDir(ancien)) return bilan;

  let entrees: string[];
  try {
    entrees = fs.readdirSync(ancien);
  } catch {
    return bilan;
  }

  for (const nom of entrees) {
    const source = path.join(ancien, nom);
    const cible = path.join(nouveau, nom);
    if (fs.existsSync(cible)) {
      // Jamais d'écrasement : on préfère laisser une trace visible à l'ancienne
      // adresse plutôt que de détruire l'une des deux versions.
      bilan.conflits.push(nom);
      continue;
    }
    try {
      fs.mkdirSync(nouveau, { recursive: true });
      fs.renameSync(source, cible);
      bilan.deplaces.push(nom);
    } catch {
      bilan.conflits.push(nom);
    }
  }

  // Dossier vidé de tout : on le retire pour que la migration ne se repose pas
  // à chaque démarrage. S'il reste des conflits, il survit — c'est voulu.
  try {
    fs.rmdirSync(ancien);
  } catch {
    /* pas vide, ou déjà parti : sans conséquence */
  }
  return bilan;
}

/**
 * Déplace config et données de l'ancien nommage vers le nouveau. Idempotent :
 * sans rien à migrer, ne fait rien et ne coûte que deux `stat`.
 *
 * À appeler une fois au démarrage du sidecar, AVANT tout accès aux fichiers.
 */
export function migrerDepuisAncienNom(env: PathEnv = currentEnv()): MigrationAncienNom {
  const config = migrerRacine(
    path.join(configBase(env), LEGACY_APP_ID),
    path.join(configBase(env), APP_ID),
  );
  const donnees = migrerRacine(
    path.join(dataBase(env), LEGACY_APP_ID),
    path.join(dataBase(env), APP_ID),
  );
  return {
    deplaces: [...config.deplaces, ...donnees.deplaces],
    conflits: [...config.conflits, ...donnees.conflits],
  };
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
