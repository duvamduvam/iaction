/*
 * Chemins de l'application (sidecar/src/appPaths.ts).
 *
 * Ces tests exercent les DEUX plateformes depuis n'importe quelle machine :
 * `globalConfigRoot`/`globalDataRoot` reçoivent leur environnement en paramètre
 * (plateforme, variables, home). C'est la contrepartie de la règle qu'on s'est
 * donnée pour le portage — une branche Windows qui ne s'exécuterait qu'à
 * Windows serait une branche jamais vérifiée.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APP_ID,
  LEGACY_APP_ID,
  globalConfigRoot,
  globalDataRoot,
  projectDir,
} from "../dist/appPaths.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `iaction-${prefix}-`));
}

/** Environnement injecté : rien n'est lu du poste réel. */
function env(platform, vars, home) {
  return { platform, env: vars, home };
}

// ---------------------------------------------------------------------------
// 1. Emplacements par plateforme
// ---------------------------------------------------------------------------

function testEmplacementsParPlateforme() {
  const home = tempDir("home");

  // Windows : config itinérante (%APPDATA%), état local (%LOCALAPPDATA%).
  const win = env("win32", { APPDATA: "C:\\U\\AppData\\Roaming", LOCALAPPDATA: "C:\\U\\AppData\\Local" }, home);
  assert.equal(globalConfigRoot(win), path.join("C:\\U\\AppData\\Roaming", APP_ID));
  assert.equal(globalDataRoot(win), path.join("C:\\U\\AppData\\Local", APP_ID));

  // Windows sans les variables : repli sur le profil, pas sur ~/.config.
  const winNu = env("win32", {}, home);
  assert.equal(globalConfigRoot(winNu), path.join(home, "AppData", "Roaming", APP_ID));
  assert.equal(globalDataRoot(winNu), path.join(home, "AppData", "Local", APP_ID));

  // Linux : XDG, sinon les emplacements standards.
  const linux = env("linux", {}, home);
  assert.equal(globalConfigRoot(linux), path.join(home, ".config", APP_ID));
  assert.equal(globalDataRoot(linux), path.join(home, ".local", "share", APP_ID));

  const linuxXdg = env("linux", { XDG_CONFIG_HOME: "/xdg/c", XDG_DATA_HOME: "/xdg/d" }, home);
  assert.equal(globalConfigRoot(linuxXdg), path.join("/xdg/c", APP_ID));
  assert.equal(globalDataRoot(linuxXdg), path.join("/xdg/d", APP_ID));

  // XDG est honoré MÊME sous Windows : c'est ce qui permet aux tests (et au
  // sidecar lancé en one-shot) d'isoler le dossier global du poste réel.
  const winXdg = env("win32", { XDG_CONFIG_HOME: "/xdg/c", APPDATA: "C:\\U\\AppData\\Roaming" }, home);
  assert.equal(globalConfigRoot(winXdg), path.join("/xdg/c", APP_ID));

  console.log("OK: emplacements par plateforme (Windows/Linux, avec et sans variables)");
}

// ---------------------------------------------------------------------------
// 2. Repli sur l'ancien nommage — par TÉMOIN, pas par existence du dossier
// ---------------------------------------------------------------------------

function testRepliParTemoin() {
  const base = tempDir("config");
  const e = env("linux", { XDG_CONFIG_HOME: base }, base);

  // Aucun des deux dossiers : on annonce le nouveau (installation neuve).
  assert.equal(globalConfigRoot(e), path.join(base, APP_ID));

  // Ancien dossier AVEC son témoin : c'est là que vivent les données.
  fs.mkdirSync(path.join(base, LEGACY_APP_ID), { recursive: true });
  fs.writeFileSync(path.join(base, LEGACY_APP_ID, "config.json"), "{}");
  assert.equal(globalConfigRoot(e), path.join(base, LEGACY_APP_ID));

  // Nouveau dossier créé mais VIDE (cas réel : la coquille Tauri le crée seule)
  // — le repli doit TENIR, sinon l'application réécrit une config par défaut
  // dans le vide et l'utilisateur croit avoir tout perdu (incident 2026-08-07).
  fs.mkdirSync(path.join(base, APP_ID), { recursive: true });
  assert.equal(globalConfigRoot(e), path.join(base, LEGACY_APP_ID));

  // Poste migré : le témoin est passé de l'autre côté.
  fs.writeFileSync(path.join(base, APP_ID, "config.json"), "{}");
  assert.equal(globalConfigRoot(e), path.join(base, APP_ID));

  console.log("OK: repli config par témoin (dossier vide de la coquille ignoré)");
}

function testRepliDonnees() {
  const base = tempDir("data");
  const e = env("linux", { XDG_DATA_HOME: base }, base);

  // Le dossier de la coquille existe avec ses caches, mais SANS `state/` :
  // les conversations vivent encore à l'ancienne adresse.
  fs.mkdirSync(path.join(base, APP_ID, "WebKitCache"), { recursive: true });
  fs.mkdirSync(path.join(base, LEGACY_APP_ID, "state"), { recursive: true });
  assert.equal(globalDataRoot(e), path.join(base, LEGACY_APP_ID));

  fs.mkdirSync(path.join(base, APP_ID, "state"), { recursive: true });
  assert.equal(globalDataRoot(e), path.join(base, APP_ID));

  console.log("OK: repli données par témoin `state/`");
}

// ---------------------------------------------------------------------------
// 3. Dossier projet
// ---------------------------------------------------------------------------

function testDossierProjet() {
  const projet = tempDir("projet");

  // Projet neuf : nouveau nom.
  assert.equal(projectDir(projet), path.join(projet, ".iaction"));
  assert.equal(projectDir(projet, "agents"), path.join(projet, ".iaction", "agents"));

  // Projet non migré : on lit où sont les fichiers, sans rien déplacer.
  const ancien = tempDir("projet-ancien");
  fs.mkdirSync(path.join(ancien, ".iadadou", "agents"), { recursive: true });
  assert.equal(projectDir(ancien), path.join(ancien, ".iadadou"));
  assert.equal(projectDir(ancien, "agents"), path.join(ancien, ".iadadou", "agents"));

  // Les deux présents : le nouveau gagne (migration faite, ancien résiduel).
  fs.mkdirSync(path.join(ancien, ".iaction"), { recursive: true });
  assert.equal(projectDir(ancien), path.join(ancien, ".iaction"));

  console.log("OK: dossier projet (neuf, non migré, migré)");
}

testEmplacementsParPlateforme();
testRepliParTemoin();
testRepliDonnees();
testDossierProjet();
console.log("OK: tous les tests appPaths sont passés");
