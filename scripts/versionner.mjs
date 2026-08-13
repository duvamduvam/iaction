#!/usr/bin/env node
/**
 * Version du produit : une seule vérité, cinq fichiers.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────
 * Le numéro de version est déclaré à CINQ endroits — package.json racine, les
 * deux workspaces, `src-tauri/tauri.conf.json` (celui de l'installeur) et
 * `Cargo.toml`. Rien ne les liait : le sidecar est resté à « 0.1.0 » pendant
 * tout le passage à 0.2.0, en annonçant une version fausse dans son événement
 * `ready`, et un test verrouillait même ce mensonge (T-016). Une valeur
 * recopiée à la main finit toujours par diverger — alors on la vérifie, et on
 * la change d'un seul geste.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   node scripts/versionner.mjs           vérifie que les cinq concordent
 *   node scripts/versionner.mjs 0.3.0     les met toutes à cette version
 *
 * La vérification entre dans `npm run verif` : une divergence casse la chaîne
 * au lieu de partir en release.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine =
  process.env.IACTION_VERSION_RACINE ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Les cinq porteurs, avec la façon de lire et de réécrire CHACUN sans toucher
 * au reste du fichier : on remplace la valeur en place plutôt que de
 * reformater du JSON (l'indentation et l'ordre des clés sont du contenu, pas
 * du bruit — un diff de release doit tenir en cinq lignes).
 */
export const PORTEURS = [
  { fichier: "package.json", motif: /("version"\s*:\s*")([^"]+)(")/ },
  { fichier: "ui/package.json", motif: /("version"\s*:\s*")([^"]+)(")/ },
  { fichier: "sidecar/package.json", motif: /("version"\s*:\s*")([^"]+)(")/ },
  { fichier: "src-tauri/tauri.conf.json", motif: /("version"\s*:\s*")([^"]+)(")/ },
  // Cargo : la PREMIÈRE clé `version` du fichier, celle de [package] — les
  // versions de dépendances viennent après et ne doivent jamais être touchées.
  { fichier: "src-tauri/Cargo.toml", motif: /^(version\s*=\s*")([^"]+)(")/m },
];

/** Semver strict, sans pré-version : ce produit n'en publie pas. */
export const FORMAT_VERSION = /^\d+\.\d+\.\d+$/;

export function lireVersionDans(texte, motif) {
  const trouve = motif.exec(texte);
  return trouve ? trouve[2] : null;
}

export function remplacerVersionDans(texte, motif, version) {
  if (!motif.test(texte)) return null;
  motif.lastIndex = 0;
  return texte.replace(motif, `$1${version}$3`);
}

async function relever() {
  const releve = [];
  for (const porteur of PORTEURS) {
    const chemin = path.join(racine, porteur.fichier);
    const texte = await fsp.readFile(chemin, "utf8");
    releve.push({ ...porteur, chemin, texte, version: lireVersionDans(texte, porteur.motif) });
  }
  return releve;
}

async function main() {
  const voulue = process.argv[2];
  const releve = await relever();

  const manquants = releve.filter((r) => r.version === null);
  if (manquants.length > 0) {
    console.error(
      `Version introuvable dans : ${manquants.map((m) => m.fichier).join(", ")}.\n` +
        "Le fichier a changé de forme — corriger le motif dans scripts/versionner.mjs.",
    );
    process.exitCode = 1;
    return;
  }

  if (voulue === undefined) {
    const distinctes = [...new Set(releve.map((r) => r.version))];
    if (distinctes.length === 1) {
      console.log(`Version du produit : ${distinctes[0]} — les ${releve.length} déclarations concordent.`);
      return;
    }
    console.error(`\nVersions DIVERGENTES (${distinctes.length} valeurs pour ${releve.length} fichiers) :\n`);
    for (const r of releve) console.error(`  ${r.version.padEnd(10)} ${r.fichier}`);
    console.error(
      "\nUne seule est la bonne. Aligner d'un geste :\n" +
        `  node scripts/versionner.mjs ${distinctes[0]}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!FORMAT_VERSION.test(voulue)) {
    console.error(`« ${voulue} » n'est pas une version (attendu : MAJEUR.MINEUR.CORRECTIF).`);
    process.exitCode = 1;
    return;
  }

  let changes = 0;
  for (const r of releve) {
    if (r.version === voulue) continue;
    const nouveau = remplacerVersionDans(r.texte, r.motif, voulue);
    await fsp.writeFile(r.chemin, nouveau, "utf8");
    console.log(`  ${r.version} → ${voulue}  ${r.fichier}`);
    changes += 1;
  }
  console.log(
    changes === 0
      ? `Déjà en ${voulue} : rien à faire.`
      : `Version du produit : ${voulue} (${changes} fichier(s) mis à jour).\n` +
          "Penser au CHANGELOG, puis publier — l'étiquette v" + voulue + " déclenche la release.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
