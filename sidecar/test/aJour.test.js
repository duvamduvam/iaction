/*
 * `a-jour.mjs` — le contrat sur lequel `scripts/dev.sh` saute une compilation.
 *
 * Ce que vérifie ce fichier tient en une phrase : **le doute doit toujours
 * faire recompiler**. Sauter un `tsc` à tort ne produit pas une erreur, il
 * produit une session entière passée à diagnostiquer du code qui n'est pas
 * celui du dépôt — la panne de T-020, trois jours de correctifs jamais
 * exécutés. Le gain visé (2,5 s par lancement, T-029) ne vaut évidemment pas
 * ce risque-là : on ne renvoie 0 que sur un « à jour » explicite.
 *
 * Le code de sortie fait foi, jamais le texte affiché : c'est lui que lit le
 * `if` de dev.sh.
 *
 * Lancement isolé : node sidecar/test/aJour.test.js
 */

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, dossierTest, lancer } from "./harness.mjs";

const script = path.join(dossierTest, "..", "scripts", "a-jour.mjs");

/** Code de sortie de `a-jour.mjs <cible>`. */
function verdict(cible) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, cible], { stdio: "ignore" });
    p.on("close", (code) => resolve(code));
  });
}

await lancer("le dossier fraîchement compilé par la suite est déclaré à jour", async () => {
  // `dist-verif` vient d'être bâti par `npm run test -w sidecar`, empreinte
  // comprise : c'est exactement la situation d'un dev.sh relancé sans avoir
  // touché aux sources.
  assert((await verdict("dist-verif")) === 0, "un compilé conforme aux sources doit valoir 0 (compilation sautée)");
});

await lancer("un dossier absent fait recompiler au lieu de faire confiance", async () => {
  assert((await verdict("dist-inexistant")) === 1, "sans dossier compilé, le verdict doit être « recompiler »");
});

await lancer("un compilé sans sources en regard fait recompiler", async () => {
  // Hors dépôt, `inspecterPeremption` répond « hors-source » : rien à
  // comparer. Pour dev.sh, une vérification qui ne peut pas conclure est une
  // raison de recompiler, pas de sauter.
  const ailleurs = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-a-jour-"));
  await fsp.copyFile(
    path.join(dossierTest, "..", "dist-verif", "peremption.js"),
    path.join(ailleurs, "peremption.js"),
  );
  assert((await verdict(ailleurs)) === 1, "un compilé sans sources comparables doit valoir « recompiler »");
  await fsp.rm(ailleurs, { recursive: true, force: true });
});
