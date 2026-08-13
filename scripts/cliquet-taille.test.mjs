/**
 * Tests du cliquet de taille.
 *
 * Ce script est une barrière de CI : s'il passait au vert quoi qu'il arrive,
 * personne ne s'en apercevrait avant le jour où un fichier dieu serait déjà
 * revenu. On l'exerce donc sur de faux dépôts jetables, et on vérifie le CODE
 * DE SORTIE — pas le texte affiché, qui n'engage rien.
 *
 * Lancement : node scripts/cliquet-taille.test.mjs
 */

import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliquet = path.join(__dirname, "cliquet-taille.mjs");

let echecs = 0;
let reussites = 0;

function verifier(intitule, condition, detail = "") {
  if (condition) {
    reussites += 1;
    return;
  }
  echecs += 1;
  console.error(`ECHEC: ${intitule}${detail ? ` — ${detail}` : ""}`);
}

/** Crée un faux dépôt et y écrit les fichiers demandés (chemin → nb de lignes). */
async function fauxDepot(fichiers, reference) {
  const racine = await fsp.mkdtemp(path.join(os.tmpdir(), "cliquet-"));
  await fsp.mkdir(path.join(racine, "scripts"), { recursive: true });
  for (const [relatif, lignes] of Object.entries(fichiers)) {
    const complet = path.join(racine, relatif);
    await fsp.mkdir(path.dirname(complet), { recursive: true });
    await fsp.writeFile(complet, `${"x\n".repeat(lignes)}`, "utf8");
  }
  if (reference !== undefined) {
    await fsp.writeFile(
      path.join(racine, "scripts", "cliquet-taille.json"),
      JSON.stringify(reference, null, 2),
      "utf8",
    );
  }
  return racine;
}

function lancer(racine, ...args) {
  const res = spawnSync(process.execPath, [cliquet, ...args], {
    env: { ...process.env, IACTION_CLIQUET_RACINE: racine },
    encoding: "utf8",
  });
  return { code: res.status, sortie: `${res.stdout}${res.stderr}` };
}

async function lireReference(racine) {
  return JSON.parse(await fsp.readFile(path.join(racine, "scripts", "cliquet-taille.json"), "utf8"));
}

// ── 1. Dépôt sain, sans référence : rien à signaler ────────────────────────
{
  const racine = await fauxDepot({ "ui/src/petit.ts": 120, "sidecar/src/autre.ts": 400 });
  const { code } = lancer(racine);
  verifier("un dépôt sous la limite passe sans fichier de référence", code === 0, `code ${code}`);
}

// ── 2. Le cas qui justifie tout le script : un fichier dieu qui apparaît ───
{
  const racine = await fauxDepot({ "ui/src/enorme.tsx": 801 }, { limite: 800, derogations: {} });
  const { code, sortie } = lancer(racine);
  verifier("un nouveau fichier au-dessus de la limite fait échouer", code === 1, `code ${code}`);
  verifier("le rapport nomme le fichier fautif", sortie.includes("ui/src/enorme.tsx"));
  verifier("801 lignes suffisent : la limite est stricte", sortie.includes("801"));
}

// ── 3. Un fichier sous dérogation n'a pas le droit de grossir ──────────────
{
  const racine = await fauxDepot(
    { "ui/src/dieu.tsx": 1200 },
    { limite: 800, derogations: { "ui/src/dieu.tsx": 1000 } },
  );
  const { code, sortie } = lancer(racine);
  verifier("la croissance d'un fichier sous dérogation échoue", code === 1, `code ${code}`);
  verifier("le rapport chiffre le dépassement", sortie.includes("+200"));
}

// ── 4. …mais il a le droit de rester tel quel ──────────────────────────────
{
  const racine = await fauxDepot(
    { "ui/src/dieu.tsx": 1000 },
    { limite: 800, derogations: { "ui/src/dieu.tsx": 1000 } },
  );
  const { code } = lancer(racine);
  verifier("un fichier pile à son budget passe", code === 0, `code ${code}`);
}

// ── 5. Maigrir passe, et « --maj » verrouille le gain ──────────────────────
{
  const racine = await fauxDepot(
    { "ui/src/dieu.tsx": 900 },
    { limite: 800, derogations: { "ui/src/dieu.tsx": 1000 } },
  );
  const avant = lancer(racine);
  verifier("un fichier qui maigrit ne fait pas échouer", avant.code === 0, `code ${avant.code}`);
  verifier("le gain est signalé", avant.sortie.includes("1000 → 900"));

  const inchangee = await lireReference(racine);
  verifier(
    "sans --maj, le budget n'est PAS resserré tout seul",
    inchangee.derogations["ui/src/dieu.tsx"] === 1000,
    `budget ${inchangee.derogations["ui/src/dieu.tsx"]}`,
  );

  const apres = lancer(racine, "--maj");
  verifier("--maj réussit", apres.code === 0, `code ${apres.code}`);
  const resserree = await lireReference(racine);
  verifier(
    "--maj abaisse le budget au niveau atteint",
    resserree.derogations["ui/src/dieu.tsx"] === 900,
    `budget ${resserree.derogations["ui/src/dieu.tsx"]}`,
  );
}

// ── 6. Repasser sous la limite fait sortir des dérogations, définitivement ─
{
  const racine = await fauxDepot(
    { "ui/src/assaini.tsx": 300, "ui/src/parti.tsx": 100 },
    { limite: 800, derogations: { "ui/src/assaini.tsx": 1000, "ui/src/disparu.tsx": 900 } },
  );
  lancer(racine, "--maj");
  const ref = await lireReference(racine);
  verifier(
    "un fichier redescendu sous la limite quitte les dérogations",
    !("ui/src/assaini.tsx" in ref.derogations),
  );
  verifier(
    "une dérogation dont le fichier n'existe plus est retirée",
    !("ui/src/disparu.tsx" in ref.derogations),
  );
  // Le fichier assaini n'a plus de dérogation : le regrossir doit désormais
  // échouer contre la limite générale, sans quoi le cliquet ne cliquette pas.
  await fsp.writeFile(path.join(racine, "ui/src/assaini.tsx"), "x\n".repeat(900), "utf8");
  const { code } = lancer(racine);
  verifier("le gain acquis est réellement irréversible", code === 1, `code ${code}`);
}

// ── 7. « --maj » ne doit jamais servir à blanchir un dépassement ───────────
{
  const racine = await fauxDepot(
    { "ui/src/neuf.tsx": 1500 },
    { limite: 800, derogations: {} },
  );
  const { code } = lancer(racine, "--maj");
  verifier("--maj échoue quand même sur un fichier dieu non déclaré", code === 1, `code ${code}`);
  const ref = await lireReference(racine);
  verifier(
    "--maj n'inscrit PAS de dérogation pour lui : il faut un geste explicite",
    !("ui/src/neuf.tsx" in ref.derogations),
  );
}

// ── 8. Le bruit n'est pas mesuré ───────────────────────────────────────────
{
  const racine = await fauxDepot(
    {
      "ui/src/node_modules/gros.js": 5000,
      "sidecar/src/dist/compile.js": 5000,
      "src-tauri/src/target/debug/build.rs": 5000,
      "ui/src/image.png": 5000,
      "ailleurs/hors-perimetre.ts": 5000,
    },
    { limite: 800, derogations: {} },
  );
  const { code } = lancer(racine);
  verifier(
    "dépendances, artefacts de compilation, binaires et arbres hors périmètre sont ignorés",
    code === 0,
    `code ${code}`,
  );
}

console.log(`\ncliquet-taille : ${reussites} vérification(s) passée(s), ${echecs} en échec.`);
if (echecs > 0) process.exitCode = 1;
