/**
 * Tests du versionneur.
 *
 * Le cas qui compte vraiment est le dernier : le VRAI dépôt. C'est lui qui
 * aurait attrapé T-016 — le sidecar resté à 0.1.0 pendant que tout le reste
 * passait à 0.2.0.
 *
 * Lancement : node scripts/versionner.test.mjs
 */

import { spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORMAT_VERSION,
  PORTEURS,
  lireVersionDans,
  remplacerVersionDans,
} from "./versionner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "versionner.mjs");

let reussites = 0;
let echecs = 0;

function verifier(intitule, condition, detail = "") {
  if (condition) {
    reussites += 1;
    return;
  }
  echecs += 1;
  console.error(`ECHEC: ${intitule}${detail ? ` — ${detail}` : ""}`);
}

/** Faux dépôt : les cinq porteurs, chacun avec la version demandée. */
async function fauxDepot(versions) {
  const racine = await fsp.mkdtemp(path.join(os.tmpdir(), "version-"));
  const contenus = {
    "package.json": (v) => `{\n  "name": "iaction",\n  "version": "${v}",\n  "private": true\n}\n`,
    "ui/package.json": (v) => `{\n  "name": "@iaction/ui",\n  "version": "${v}"\n}\n`,
    "sidecar/package.json": (v) => `{\n  "name": "@iaction/sidecar",\n  "version": "${v}"\n}\n`,
    "src-tauri/tauri.conf.json": (v) => `{\n  "productName": "IAction",\n  "version": "${v}"\n}\n`,
    // Le Cargo.toml porte AUSSI des versions de dépendances : elles ne doivent
    // jamais bouger. C'est tout l'objet du motif ancré en début de ligne.
    "src-tauri/Cargo.toml": (v) =>
      `[package]\nname = "iaction"\nversion = "${v}"\n\n[dependencies]\nserde = { version = "1.0.200" }\ntauri = "2"\n`,
  };
  for (const [i, porteur] of PORTEURS.entries()) {
    const complet = path.join(racine, porteur.fichier);
    await fsp.mkdir(path.dirname(complet), { recursive: true });
    await fsp.writeFile(complet, contenus[porteur.fichier](versions[i]), "utf8");
  }
  return racine;
}

function lancer(racine, ...args) {
  const res = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, IACTION_VERSION_RACINE: racine },
    encoding: "utf8",
  });
  return { code: res.status, sortie: `${res.stdout}${res.stderr}` };
}

// ── Fonctions pures ───────────────────────────────────────────────────────

verifier("une version est lue dans du JSON", lireVersionDans('{"version": "1.2.3"}', PORTEURS[0].motif) === "1.2.3");
verifier(
  "la version de [package] est lue, pas celle d'une dépendance",
  lireVersionDans('[package]\nversion = "0.4.0"\n\n[dependencies]\nserde = { version = "1.0.200" }\n', PORTEURS[4].motif) === "0.4.0",
);
verifier(
  "le remplacement ne touche PAS les versions de dépendances",
  remplacerVersionDans(
    '[package]\nversion = "0.4.0"\n\n[dependencies]\nserde = { version = "1.0.200" }\n',
    PORTEURS[4].motif,
    "0.5.0",
  ) === '[package]\nversion = "0.5.0"\n\n[dependencies]\nserde = { version = "1.0.200" }\n',
);
verifier("un fichier sans version rend null", remplacerVersionDans('{"nom": "x"}', PORTEURS[0].motif, "1.0.0") === null);
verifier("le format semver est exigé", FORMAT_VERSION.test("1.2.3") && !FORMAT_VERSION.test("1.2") && !FORMAT_VERSION.test("v1.2.3"));

// ── Vérification (sans argument) ──────────────────────────────────────────

{
  const racine = await fauxDepot(["0.2.0", "0.2.0", "0.2.0", "0.2.0", "0.2.0"]);
  const { code, sortie } = lancer(racine);
  verifier("cinq versions identiques ⇒ succès", code === 0, `code ${code}`);
  verifier("la version constatée est annoncée", sortie.includes("0.2.0"));
}

{
  // Exactement T-016 : le sidecar oublié en 0.1.0.
  const racine = await fauxDepot(["0.2.0", "0.2.0", "0.1.0", "0.2.0", "0.2.0"]);
  const { code, sortie } = lancer(racine);
  verifier("une divergence ⇒ échec (le cas T-016)", code === 1, `code ${code}`);
  verifier("le fichier fautif est nommé", sortie.includes("sidecar/package.json"));
}

// ── Montée de version ─────────────────────────────────────────────────────

{
  const racine = await fauxDepot(["0.2.0", "0.2.0", "0.1.0", "0.2.0", "0.2.0"]);
  const { code } = lancer(racine, "0.3.0");
  verifier("la montée réaligne TOUT, même le divergent", code === 0, `code ${code}`);
  const { code: apres } = lancer(racine);
  verifier("après montée, la vérification passe", apres === 0, `code ${apres}`);

  const cargo = await fsp.readFile(path.join(racine, "src-tauri/Cargo.toml"), "utf8");
  verifier("Cargo : [package] monté", cargo.includes('version = "0.3.0"'));
  verifier("Cargo : la dépendance serde est INTACTE", cargo.includes('serde = { version = "1.0.200" }'));

  const pkg = await fsp.readFile(path.join(racine, "package.json"), "utf8");
  verifier("le reste du JSON est préservé (pas de reformatage)", pkg.includes('"name": "iaction"') && pkg.includes('"private": true'));
}

{
  const racine = await fauxDepot(["0.2.0", "0.2.0", "0.2.0", "0.2.0", "0.2.0"]);
  const { code, sortie } = lancer(racine, "0.3");
  verifier("une version mal formée est refusée", code === 1 && sortie.includes("MAJEUR"), `code ${code}`);
}

// ── Le vrai dépôt ─────────────────────────────────────────────────────────

{
  const { code, sortie } = lancer(path.join(__dirname, ".."));
  verifier("le dépôt réel : les cinq déclarations concordent", code === 0, sortie.trim());
}

console.log(`${reussites} réussite(s), ${echecs} échec(s)`);
process.exit(echecs === 0 ? 0 : 1);
