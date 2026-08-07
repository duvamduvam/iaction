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
  migrerDepuisAncienNom,
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

  // Windows : config ET données dans %APPDATA% (itinérant). Ce n'est pas un
  // choix esthétique — c'est ce que résout app_data_dir() de Tauri, et la
  // coquille Rust est celle qui ÉCRIT state/*.json. Un jour où ce test tombera
  // parce que quelqu'un trouve LOCALAPPDATA plus logique : il l'est peut-être,
  // mais il faudra alors changer la coquille D'ABORD.
  const win = env("win32", { APPDATA: "C:\\U\\AppData\\Roaming", LOCALAPPDATA: "C:\\U\\AppData\\Local" }, home);
  assert.equal(globalConfigRoot(win), path.join("C:\\U\\AppData\\Roaming", APP_ID));
  assert.equal(globalDataRoot(win), path.join("C:\\U\\AppData\\Roaming", APP_ID));

  // Windows sans les variables : repli sur le profil, pas sur ~/.config.
  const winNu = env("win32", {}, home);
  assert.equal(globalConfigRoot(winNu), path.join(home, "AppData", "Roaming", APP_ID));
  assert.equal(globalDataRoot(winNu), path.join(home, "AppData", "Roaming", APP_ID));

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
// 2. Migration depuis l'ancien nommage — une fois, au démarrage
// ---------------------------------------------------------------------------

function testMigrationDeplace() {
  const base = tempDir("config");
  const e = env("linux", { XDG_CONFIG_HOME: base, XDG_DATA_HOME: base }, base);

  // Poste non migré : tout est sous l'ancien nom.
  const ancien = path.join(base, LEGACY_APP_ID);
  fs.mkdirSync(path.join(ancien, "taches", "menage-mails"), { recursive: true });
  fs.writeFileSync(path.join(ancien, "config.json"), '{"projects":[1,2]}');

  const bilan = migrerDepuisAncienNom(e);

  assert.deepEqual(bilan.conflits, [], "aucun conflit attendu sur un dossier neuf");
  assert.ok(bilan.deplaces.includes("config.json"), "config.json doit etre deplace");
  assert.ok(bilan.deplaces.includes("taches"), "taches/ doit etre deplace");

  // Tout est arrivé à la nouvelle adresse, contenu compris.
  const nouveau = path.join(base, APP_ID);
  assert.equal(fs.readFileSync(path.join(nouveau, "config.json"), "utf8"), '{"projects":[1,2]}');
  assert.ok(fs.existsSync(path.join(nouveau, "taches", "menage-mails")), "l'arborescence doit suivre");
  assert.ok(!fs.existsSync(ancien), "l'ancien dossier vide doit disparaitre");

  // Et les racines pointent bien là, sans détour.
  assert.equal(globalConfigRoot(e), nouveau);

  console.log("OK: migration deplace config et donnees vers le nouveau nommage");
}

function testMigrationNeCraseJamais() {
  const base = tempDir("config-conflit");
  const e = env("linux", { XDG_CONFIG_HOME: base, XDG_DATA_HOME: base }, base);

  // Cas RÉEL : la coquille Rust a déjà écrit un config.json au nouveau nom
  // (elle n'a aucun repli) alors que l'ancien dossier vit encore.
  const ancien = path.join(base, LEGACY_APP_ID);
  const nouveau = path.join(base, APP_ID);
  fs.mkdirSync(ancien, { recursive: true });
  fs.mkdirSync(nouveau, { recursive: true });
  fs.writeFileSync(path.join(ancien, "config.json"), "ANCIEN");
  fs.writeFileSync(path.join(nouveau, "config.json"), "NOUVEAU");
  fs.mkdirSync(path.join(ancien, "usage"), { recursive: true });

  const bilan = migrerDepuisAncienNom(e);

  assert.ok(bilan.conflits.includes("config.json"), "la collision doit etre signalee");
  assert.equal(
    fs.readFileSync(path.join(nouveau, "config.json"), "utf8"),
    "NOUVEAU",
    "jamais d'ecrasement : la version en place gagne",
  );
  assert.equal(
    fs.readFileSync(path.join(ancien, "config.json"), "utf8"),
    "ANCIEN",
    "la version non migree reste consultable, elle n'est pas detruite",
  );
  assert.ok(bilan.deplaces.includes("usage"), "ce qui ne collisionne pas doit quand meme migrer");

  console.log("OK: migration signale les collisions sans jamais ecraser ni detruire");
}

function testMigrationIdempotente() {
  const base = tempDir("config-vide");
  const e = env("linux", { XDG_CONFIG_HOME: base, XDG_DATA_HOME: base }, base);
  const premier = migrerDepuisAncienNom(e);
  const second = migrerDepuisAncienNom(e);
  assert.deepEqual(premier, { deplaces: [], conflits: [] }, "rien a migrer = rien a faire");
  assert.deepEqual(second, { deplaces: [], conflits: [] }, "et c'est rejouable sans effet");
  console.log("OK: migration idempotente et silencieuse quand il n'y a rien a faire");
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
testMigrationDeplace();
testMigrationNeCraseJamais();
testMigrationIdempotente();
testDossierProjet();
console.log("OK: tous les tests appPaths sont passés");
