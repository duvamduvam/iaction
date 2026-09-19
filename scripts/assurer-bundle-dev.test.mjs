/**
 * Tests du garde-fou de ressource cargo en développement (T-127).
 *
 * `build/sidecar-bundle/` n'est produit que par `preparer-bundle.sh`, à
 * l'empaquetage. En développement, `cargo build` (déclenché par `tauri dev`)
 * exige pourtant que la ressource existe. On exerce donc la DÉCISION prise
 * par `assurerBundleDev` sur de vrais dossiers temporaires — jamais sur le
 * `build/` du dépôt, pour ne pas dépendre de son état au moment du test.
 *
 * Lancement : node scripts/assurer-bundle-dev.test.mjs
 */

import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assurerBundleDev, NOM_TEMOIN } from "./assurer-bundle-dev.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "assurer-bundle-dev.mjs");

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

async function dossierTemporaire() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "assurer-bundle-dev-"));
}

// ── Dossier absent ──────────────────────────────────────────────────────────
{
  const racine = await dossierTemporaire();
  const bundle = path.join(racine, "sidecar-bundle");
  const { action } = await assurerBundleDev(bundle);
  verifier("dossier absent : il est créé", action === "cree");
  const entrees = await fsp.readdir(bundle);
  verifier("le témoin est déposé", entrees.includes(NOM_TEMOIN), entrees.join(", "));
  const contenu = await fsp.readFile(path.join(bundle, NOM_TEMOIN), "utf8");
  verifier("le témoin explique qu'il n'est PAS le bundle", contenu.includes("n'est PAS le bundle"));
  verifier("le témoin nomme IACTION_SIDECAR", contenu.includes("IACTION_SIDECAR"));
  verifier("le témoin nomme la vraie commande de bundle", contenu.includes("npm run preparer-bundle"));
  await fsp.rm(racine, { recursive: true, force: true });
}

// ── Dossier déjà présent avec le témoin (relance de dev.sh) ────────────────
{
  const racine = await dossierTemporaire();
  const bundle = path.join(racine, "sidecar-bundle");
  await assurerBundleDev(bundle);
  const avant = await fsp.readFile(path.join(bundle, NOM_TEMOIN), "utf8");
  const { action } = await assurerBundleDev(bundle);
  verifier("relance : rien n'est recréé", action === "deja-present");
  const apres = await fsp.readFile(path.join(bundle, NOM_TEMOIN), "utf8");
  verifier("relance : le témoin n'est pas réécrit différemment", apres === avant);
  await fsp.rm(racine, { recursive: true, force: true });
}

// ── Dossier avec un VRAI bundle (npm run preparer-bundle déjà passé) ───────
{
  const racine = await dossierTemporaire();
  const bundle = path.join(racine, "sidecar-bundle");
  await fsp.mkdir(bundle, { recursive: true });
  await fsp.writeFile(path.join(bundle, "index.js"), "// sidecar compilé, pas un témoin\n");
  const { action } = await assurerBundleDev(bundle);
  verifier("un vrai bundle n'est jamais écrasé", action === "deja-present");
  const entrees = await fsp.readdir(bundle);
  verifier("le témoin n'est PAS ajouté à côté d'un vrai bundle", !entrees.includes(NOM_TEMOIN), entrees.join(", "));
  verifier("le fichier du vrai bundle est toujours là", entrees.includes("index.js"));
  await fsp.rm(racine, { recursive: true, force: true });
}

// ── Le script en ligne de commande ─────────────────────────────────────────
// Contre l'ANCIEN dev.sh (qui n'appelle rien), rien ne garantit que ce fichier
// existe seulement s'il est appelé — c'est justement pourquoi ce test échoue
// tant que `dev.sh` ne l'invoque pas : voir la vérification suivante.
{
  const { status } = spawnSync(process.execPath, [script], { encoding: "utf8" });
  verifier("lancé en ligne de commande, il rend un code de sortie 0", status === 0, `code ${status}`);
}

// ── dev.sh appelle bien ce garde-fou avant `tauri dev` ─────────────────────
// C'est la garantie demandée par T-127 : sans cet appel, un `target/`
// reconstruit fait échouer la compilation en développement. Test TEXTUEL,
// même gabarit que `preparer-bundle.test.mjs` — au même titre que la purge de
// mise en scène, ce qui compte est la PRÉSENCE de l'appel et sa PLACE, pas
// l'exécution complète de `dev.sh` (qui lancerait une vraie session Tauri).
{
  const devSh = await fsp.readFile(path.join(__dirname, "dev.sh"), "utf8");
  const iGarde = devSh.indexOf("assurer-bundle-dev.mjs");
  const iExecDev = devSh.indexOf("exec npm run dev");
  verifier("dev.sh invoque le garde-fou (T-127)", iGarde !== -1);
  verifier(
    "dev.sh invoque le garde-fou AVANT `tauri dev`",
    iGarde !== -1 && iExecDev !== -1 && iGarde < iExecDev,
    `garde à ${iGarde}, exec à ${iExecDev}`,
  );
}

console.log(`\nassurer-bundle-dev : ${reussites} vérification(s) passée(s), ${echecs} en échec.`);
if (echecs > 0) process.exitCode = 1;
