#!/usr/bin/env node
/**
 * Vérifications sur `preparer-bundle.sh` — la purge de la mise en scène.
 *
 * ── Pourquoi un test TEXTUEL ────────────────────────────────────────────
 * Exercer le script pour de vrai coûte une construction complète de
 * l'interface et le téléchargement d'un runtime Node : hors de portée d'une
 * chaîne de vérification qu'on veut passer avant chaque livraison. Ce qu'on
 * verrouille ici est donc plus modeste, et suffit à tenir T-041 : la purge
 * existe, elle vise les DEUX dossiers de mise en scène, et elle s'exécute
 * AVANT l'assemblage.
 *
 * La position n'est pas un détail cosmétique : purger après avoir assemblé
 * effacerait le travail du script. Même raisonnement que le test de T-043, qui
 * verrouille la présence d'un drapeau ET sa place avant le script.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = await fsp.readFile(path.join(__dirname, "preparer-bundle.sh"), "utf8");

let reussites = 0;
let echecs = 0;

function verifier(titre, condition, detail = "") {
  if (condition) {
    reussites += 1;
    console.log(`  ok   ${titre}`);
  } else {
    echecs += 1;
    console.error(`  ÉCHEC ${titre}${detail ? ` — ${detail}` : ""}`);
  }
}

const iPurge = script.indexOf("Purge de la mise en scène précédente");
const iAssemblage = script.indexOf('cp -a sidecar/dist/.');

verifier("la purge de la mise en scène est présente (T-041)", iPurge !== -1);
verifier("le point d'assemblage du bundle est toujours reconnaissable", iAssemblage !== -1,
  "le test ne sait plus où commence l'assemblage : le mettre à jour, pas le supprimer");
verifier("la purge s'exécute AVANT l'assemblage", iPurge !== -1 && iAssemblage !== -1 && iPurge < iAssemblage,
  `purge à ${iPurge}, assemblage à ${iAssemblage}`);

for (const scene of ["release/sidecar", "release/bundle"]) {
  verifier(`la purge vise ${scene}`, script.includes(`/${scene}"`),
    "Tauri met les ressources en scène dans les deux, et n'y supprime jamais ce qui a disparu");
}

verifier("la purge respecte CARGO_TARGET_DIR", script.includes("CARGO_TARGET_DIR"),
  "sinon un dépôt qui déplace son dossier target garde sa mise en scène périmée");

console.log(`${reussites} réussite(s), ${echecs} échec(s)`);
process.exit(echecs === 0 ? 0 : 1);
