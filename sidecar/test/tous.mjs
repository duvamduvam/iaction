/*
 * Lanceur de la suite du sidecar.
 *
 * ── Pourquoi il découvre les fichiers au lieu de les lister ─────────────
 * La liste des tests vivait dans `package.json`, énumérée à la main. Un
 * fichier neuf qu'on oublie d'y inscrire ne se signale jamais : il ne casse
 * rien, il ne s'exécute simplement pas, et la suite reste verte en couvrant
 * moins qu'hier. La découverte supprime purement et simplement ce mode de
 * panne.
 *
 * ── Pourquoi en séquence, un processus par fichier ──────────────────────
 * Chaque fichier démarre de vrais sidecars et de vrais serveurs HTTP. Un
 * processus par fichier garantit qu'un test qui laisse traîner une ressource
 * ne contamine pas le suivant, et que le CODE DE SORTIE de chacun est lu
 * séparément — c'est lui qui fait foi, jamais le texte affiché.
 *
 * Lancement : node sidecar/test/tous.mjs [motif]
 *   motif : sous-chaîne facultative pour n'exécuter qu'une partie de la suite
 *           (« node test/tous.mjs orchestr »).
 */

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dossier = path.dirname(fileURLToPath(import.meta.url));
const motif = process.argv[2] ?? "";

const fichiers = (await fsp.readdir(dossier))
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => f.includes(motif))
  .sort();

if (fichiers.length === 0) {
  console.error(motif ? `Aucun test ne correspond à « ${motif} ».` : "Aucun fichier de test trouvé.");
  process.exit(1);
}

function lancerUn(fichier) {
  return new Promise((resolve) => {
    const debut = Date.now();
    const enfant = spawn(process.execPath, [path.join(dossier, fichier)], { stdio: "inherit" });
    enfant.on("exit", (code) => resolve({ fichier, code, duree: (Date.now() - debut) / 1000 }));
  });
}

const resultats = [];
for (const fichier of fichiers) {
  console.log(`\n━━━ ${fichier} ${"━".repeat(Math.max(0, 60 - fichier.length))}`);
  resultats.push(await lancerUn(fichier));
}

const echecs = resultats.filter((r) => r.code !== 0);
const total = resultats.reduce((s, r) => s + r.duree, 0);

console.log(`\n${"═".repeat(66)}`);
for (const r of resultats) {
  const etat = r.code === 0 ? "  ok" : ` KO(${r.code})`;
  console.log(`${etat}  ${r.fichier.padEnd(34)} ${r.duree.toFixed(1)} s`);
}
console.log(
  `${"═".repeat(66)}\n` +
    `${resultats.length} fichier(s), ${echecs.length} en échec, ${total.toFixed(1)} s au total.`,
);

if (echecs.length > 0) process.exitCode = 1;
