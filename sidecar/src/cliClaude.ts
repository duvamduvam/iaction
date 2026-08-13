/*
 * Le CLI Claude embarqué : détendu au premier lancement (T-038).
 *
 * ── Pourquoi le paquet Linux ne contient pas le binaire tel quel ────────
 * L'AppImage se fabrique avec `linuxdeploy`, qui parcourt TOUS les fichiers ELF
 * de l'AppDir, leur réécrit leur RUNPATH avec `patchelf`, puis les interroge
 * avec `ldd`. Le CLI Claude porte une charge utile collée en queue de fichier :
 * la réécriture le CASSE. Mesuré le 2026-08-13 — même BuildID, 4 096 octets de
 * plus, `ldd` qui passe de 0 à 1 — après quoi linuxdeploy abandonne (SIGABRT)
 * en reprochant au fichier un défaut qu'il vient d'y introduire.
 *
 * `scripts/preparer-bundle.sh` range donc le CLI **compressé** dans le paquet
 * Linux : un `.gz` n'est pas un ELF, linuxdeploy passe devant sans le voir. Ce
 * module fait l'autre moitié — le détendre, une fois, dans un dossier
 * inscriptible. Une AppImage étant une image en lecture seule, il n'y a de
 * toute façon aucun autre endroit où poser un exécutable.
 *
 * ── Ce que ce module NE fait pas ────────────────────────────────────────
 * Rien, sur Windows, sur macOS, et dans le dépôt en développement : là, le
 * binaire est en place et le SDK le trouve tout seul. `preparerCliClaude()`
 * rend alors `null`, et l'appelant laisse le SDK faire comme avant. Un chemin
 * de repli qui s'active partout serait un chemin qu'on ne teste nulle part.
 *
 * ── Doctrine ────────────────────────────────────────────────────────────
 * Un échec de détente n'est jamais silencieux : il part au journal avec sa
 * cause, et le tour échouera franchement plutôt que d'exécuter on ne sait
 * quoi. C'est la leçon de T-015 appliquée au démarrage.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { globalDataRoot, type PathEnv } from "./appPaths.js";
import * as journal from "./journal.js";

/** Nom du CLI une fois posé, et du paquet compressé qui le porte. */
const NOM_CLI = "claude";
const SUFFIXE_EMBALLE = ".gz";

/** Dossier du code compilé qui s'exécute — le paquet, en production. */
function dossierCourant(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Le CLI compressé livré dans le paquet, s'il y en a un.
 *
 * On cherche sous `@anthropic-ai/claude-agent-sdk-linux*` : c'est là que npm
 * pose le binaire par plateforme, et `preparer-bundle.sh` n'emballe que les
 * variantes Linux (les seules qui passent par linuxdeploy).
 */
export function trouverCliEmballe(racine = dossierCourant()): string | null {
  const dir = path.join(racine, "node_modules", "@anthropic-ai");
  if (!existsSync(dir)) return null;
  let entrees: string[];
  try {
    entrees = readdirSync(dir);
  } catch {
    return null;
  }
  for (const nom of entrees) {
    if (!nom.startsWith("claude-agent-sdk-linux")) continue;
    const emballe = path.join(dir, nom, NOM_CLI + SUFFIXE_EMBALLE);
    if (existsSync(emballe)) return emballe;
  }
  return null;
}

/**
 * Taille du contenu détendu, lue dans le pied du gzip (champ ISIZE, 4 octets
 * en petit-boutien).
 *
 * Pourquoi s'en servir : c'est ce qui permet de savoir qu'une extraction
 * précédente est COMPLÈTE sans la refaire. Un simple « le fichier existe »
 * ferait passer une extraction interrompue pour un succès — et on relancerait
 * l'application sur un binaire tronqué, panne autrement plus difficile à lire
 * qu'une extraction refaite.
 *
 * ISIZE est modulo 2^32 : au-delà de 4 Go la valeur ment. Le CLI en pèse 265
 * millions d'octets, on est loin du compte, et si un jour ce n'est plus vrai
 * la comparaison échouera dans le sens prudent (on ré-extrait).
 */
export function tailleDetendue(cheminEmballe: string): number {
  const stat = statSync(cheminEmballe);
  const pied = Buffer.alloc(4);
  const fd = openSync(cheminEmballe, "r");
  try {
    readSync(fd, pied, 0, 4, stat.size - 4);
  } finally {
    closeSync(fd);
  }
  return pied.readUInt32LE(0);
}

/** Où le binaire détendu est posé : un dossier inscriptible, par version. */
export function cheminCliDetendu(cheminEmballe: string, env?: PathEnv): string {
  // L'empreinte du paquet compressé nomme le fichier : deux versions du CLI ne
  // se marchent jamais dessus, et une mise à jour de l'application ne réutilise
  // pas par accident le binaire de la précédente.
  const empreinte = createHash("sha256").update(readFileSync(cheminEmballe)).digest("hex").slice(0, 12);
  return path.join(globalDataRoot(env), "bin", `${NOM_CLI}-${empreinte}`);
}

export interface PreparationCli {
  chemin: string;
  /** `true` si ce lancement a fait le travail, `false` s'il était déjà fait. */
  detendu: boolean;
  dureeMs: number;
}

/**
 * Détend le CLI si le paquet en porte un, et rend son chemin.
 *
 * Rend `null` quand il n'y a rien à faire — Windows, macOS, dépôt en
 * développement — auquel cas l'appelant laisse le SDK résoudre son binaire
 * comme il l'a toujours fait.
 *
 * Ne lève jamais : une exception ici tuerait le démarrage du sidecar. L'échec
 * part au journal et rend `null`, ce qui redonne la main au SDK — il échouera
 * peut-être à son tour, mais avec son propre message, et le journal portera
 * déjà la vraie cause.
 */
/**
 * Enveloppe une fonction `query` du SDK pour qu'elle lance le CLI détendu.
 *
 * Rend la fonction TELLE QUELLE quand il n'y a pas de CLI emballé — Windows,
 * macOS, dépôt en développement : le SDK résout alors son binaire comme il l'a
 * toujours fait.
 *
 * Vit ici et non dans `claude.ts` pour deux raisons : la connaissance du paquet
 * Linux appartient à ce module, et l'aiguillage se pose ainsi en UN endroit,
 * alors que `claude.ts`, `claudeUsage.ts` et `claudeCommands.ts` composent
 * chacun leurs options — une consigne à recopier dans trois fichiers est une
 * consigne qu'on oubliera au quatrième.
 */
export function aiguillerVersCliEmballe<T>(query: T, racine = dossierCourant(), env?: PathEnv): T {
  const cli = preparerCliClaude(racine, env);
  if (!cli) return query;
  // Le SDK décrit `query` avec des types riches (prompt itérable, options
  // typées) dont ce module n'a que faire : il n'ajoute qu'une clé. On passe
  // donc par une forme minimale, et l'appelant récupère SON type intact.
  const brut = query as unknown as (params: ParamsQuery) => unknown;
  return ((params: ParamsQuery) =>
    brut({
      ...params,
      // Un appelant qui a déjà choisi son exécutable garde la main : la règle
      // ne vaut que pour le cas non renseigné.
      options: { pathToClaudeCodeExecutable: cli.chemin, ...(params.options ?? {}) },
    })) as unknown as T;
}

interface ParamsQuery {
  prompt: unknown;
  options?: Record<string, unknown>;
}

export function preparerCliClaude(racine = dossierCourant(), env?: PathEnv): PreparationCli | null {
  const emballe = trouverCliEmballe(racine);
  if (!emballe) return null;

  const debut = Date.now();
  const cible = cheminCliDetendu(emballe, env);

  try {
    const attendue = tailleDetendue(emballe);
    if (existsSync(cible) && statSync(cible).size === attendue) {
      journal.info("sidecar", "CLI Claude déjà détendu", { fields: { chemin: cible, octets: attendue } });
      return { chemin: cible, detendu: false, dureeMs: Date.now() - debut };
    }

    mkdirSync(path.dirname(cible), { recursive: true });
    // Écriture sous un nom provisoire puis renommage : un `rename` est atomique
    // sur le même système de fichiers. Sans ce détour, une extraction coupée
    // (batterie, fermeture de session) laisserait un binaire tronqué portant le
    // nom du bon, et le lancement suivant le croirait valide.
    const provisoire = `${cible}.partiel`;
    rmSync(provisoire, { force: true });
    writeFileSync(provisoire, gunzipSync(readFileSync(emballe)));
    chmodSync(provisoire, 0o755);
    renameSync(provisoire, cible);

    const dureeMs = Date.now() - debut;
    journal.info("sidecar", "CLI Claude détendu depuis le paquet", {
      fields: { source: emballe, chemin: cible, octets: attendue, dureeMs },
    });
    return { chemin: cible, detendu: true, dureeMs };
  } catch (err) {
    journal.error("sidecar", "échec de la détente du CLI Claude embarqué", {
      fields: {
        source: emballe,
        cible,
        cause: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}
