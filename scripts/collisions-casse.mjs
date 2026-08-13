#!/usr/bin/env node
/**
 * Collisions de casse — ce que le poste Linux ne peut pas voir.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────
 * Le développement se fait sous Linux, où le système de fichiers distingue
 * `ModelPicker` de `modelPicker`. Windows et macOS ne les distinguent pas. Le
 * 2026-08-13, la construction de l'installeur Windows est tombée là-dessus
 * (T-039) : `ModelPicker.tsx` et `modelPicker.ts` cohabitaient, `tsc` voyait
 * deux fois le même fichier et refusait de compiler — alors que la chaîne
 * complète était verte en local, et l'était restée trois publications durant.
 *
 * Le défaut n'est pas la faute de frappe : c'est qu'AUCUN garde-fou ne pouvait
 * l'attraper avant un runner Windows, c'est-à-dire avant la livraison. Ce
 * script rend la propriété vérifiable depuis n'importe quel système.
 *
 * ── Les deux règles ─────────────────────────────────────────────────────
 * 1. Deux fichiers dont le CHEMIN ne diffère que par la casse : sur un système
 *    insensible, un seul survit à l'extraction du dépôt. L'autre est perdu.
 * 2. Deux modules du MÊME dossier dont le nom, extension retirée, ne diffère
 *    que par la casse : `import "./ModelPicker"` devient ambigu, et se résout
 *    sur le mauvais fichier. C'est le cas de T-039.
 *
 * La règle 2 ne vaut que pour les extensions que le résolveur de modules
 * essaie tour à tour (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`) : `page.ts` et
 * `Page.css` ne se marchent pas dessus.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   node scripts/collisions-casse.mjs      vérifie (code de sortie 1 si KO)
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine =
  process.env.IACTION_CASSE_RACINE ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Mêmes arbres que le cliquet de taille : le code que NOUS écrivons. */
const ARBRES = ["ui/src", "sidecar/src", "sidecar/test", "src-tauri/src", "scripts", "docs"];
const IGNORES = new Set(["node_modules", "dist", "dist-dev", "dist-verif", "target", "gen", "build", ".git"]);

/** Extensions que le résolveur essaie pour un import sans extension. */
export const EXTENSIONS_MODULE = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

export async function listerFichiers(dossier) {
  let entrees;
  try {
    entrees = await fsp.readdir(dossier, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const trouves = [];
  for (const entree of entrees) {
    if (IGNORES.has(entree.name)) continue;
    const complet = path.join(dossier, entree.name);
    if (entree.isDirectory()) trouves.push(...(await listerFichiers(complet)));
    else if (entree.isFile()) trouves.push(complet);
  }
  return trouves;
}

/**
 * Cherche les deux formes de collision dans une liste de chemins relatifs,
 * séparateurs en `/`. Fonction pure : c'est elle que les tests exercent.
 */
export function trouverCollisions(chemins) {
  const parChemin = new Map();
  const parModule = new Map();

  for (const chemin of chemins) {
    const cle = chemin.toLowerCase();
    if (!parChemin.has(cle)) parChemin.set(cle, []);
    parChemin.get(cle).push(chemin);

    const ext = path.posix.extname(chemin);
    if (!EXTENSIONS_MODULE.has(ext)) continue;
    // `.test.ts` et `.ts` sont deux fichiers distincts pour le résolveur :
    // seule l'extension finale est retirée, jamais un suffixe composé.
    const sansExt = chemin.slice(0, -ext.length).toLowerCase();
    if (!parModule.has(sansExt)) parModule.set(sansExt, []);
    parModule.get(sansExt).push(chemin);
  }

  const collisions = [];
  for (const [, fichiers] of parChemin) {
    if (new Set(fichiers).size > 1) collisions.push({ regle: "chemin", fichiers: [...new Set(fichiers)].sort() });
  }
  for (const [, fichiers] of parModule) {
    const distincts = [...new Set(fichiers)];
    // Deux fichiers au nom IDENTIQUE et d'extensions différentes (`a.ts` et
    // `a.js`) ne sont pas une collision de casse — c'est un autre débat.
    const nomsBruts = new Set(distincts.map((f) => f.slice(0, -path.posix.extname(f).length)));
    if (nomsBruts.size > 1) collisions.push({ regle: "module", fichiers: distincts.sort() });
  }
  return collisions.sort((a, b) => a.fichiers[0].localeCompare(b.fichiers[0]));
}

const MOTIFS = {
  chemin: "deux chemins qui ne diffèrent que par la casse — un seul survivra à l'extraction sous Windows",
  module: "deux modules du même dossier au nom identique à la casse près — un import sans extension est ambigu",
};

async function main() {
  const chemins = [];
  for (const arbre of ARBRES) {
    for (const fichier of await listerFichiers(path.join(racine, arbre))) {
      chemins.push(path.relative(racine, fichier).split(path.sep).join("/"));
    }
  }

  const collisions = trouverCollisions(chemins);
  if (collisions.length === 0) {
    console.log(`Casse : ${chemins.length} fichier(s) examiné(s), aucune collision.`);
    return;
  }

  console.error(`Collisions de casse : ${collisions.length}.\n`);
  for (const collision of collisions) {
    console.error(`  ${collision.fichiers.join("  <->  ")}`);
    console.error(`    ${MOTIFS[collision.regle]}`);
  }
  console.error(
    "\nRenommer l'un des deux. Le dépôt distingue ces fichiers, Windows et macOS\n" +
      "non : la panne n'apparaîtrait qu'à la construction de l'installeur.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
