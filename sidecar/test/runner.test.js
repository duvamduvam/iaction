// Tests du runner serveur `ia-runner` (tranche D1 de docs/etude-remote.md) —
// JS pur, sans framework, même style que protocol.test.js / tickets.test.js.
//
// Contrairement aux autres tests du dossier, aucun sidecar n'est lancé : les
// modules testés (docker/ia-runner/bin/*.mjs) sont importés directement. Ils
// sont écrits pour ça — leur point d'entrée est gardé par une comparaison
// `process.argv[1]`, donc les importer n'exécute rien.
//
// Couverture :
//   1. conversion OnCalendar → cron (formes acceptées ET formes refusées) ;
//   2. refus des schedules ambigus ou infidèles (secondes, année, ET/OU
//      jour-du-mois/jour-de-semaine) — le cœur du « aucun échec muet » ;
//   3. résolution du projet (trouvé par 'projet', trouvé par nom de dossier de
//      'cwd', introuvable, repli sur le dossier de la tâche) ;
//   4. construction du crontab sur une arborescence de tâches jetable :
//      sélection `enabled` + `lieu: serveur`, et remontée des refus.

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  construireCrontab,
  convertirOnCalendarEnCron,
  normaliserManifeste,
} from "../../docker/ia-runner/bin/plan-cron.mjs";
import { resoudreProjet } from "../../docker/ia-runner/bin/run-tache.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  console.error(`ECHEC: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

// ---------------------------------------------------------------------------
// 1. OnCalendar → cron : formes acceptées
// ---------------------------------------------------------------------------

function testConversionsAcceptees() {
  const cas = [
    // Raccourcis systemd (systemd.time(7)).
    ["minutely", "* * * * *"],
    ["hourly", "0 * * * *"],
    ["daily", "0 0 * * *"],
    ["weekly", "0 0 * * 1"],
    ["monthly", "0 0 1 * *"],
    ["yearly", "0 0 1 1 *"],
    ["quarterly", "0 0 1 1,4,7,10 *"],
    // Formes réellement utilisées par les tâches du poste.
    ["*-*-* 08:15:00", "15 8 * * *"],
    ["Mon *-*-* 09:00", "0 9 * * 1"],
    ["Mon..Fri *-*-* 07:30:00", "30 7 * * 1-5"],
    ["Mon,Fri *-*-* 12:00:00", "0 12 * * 1,5"],
    // Espace après la virgule : toléré par systemd, doit l'être ici aussi.
    ["Mon, Fri *-*-* 12:00:00", "0 12 * * 1,5"],
    // Date seule / heure seule (défauts systemd : *-*-* et 00:00:00).
    ["*-*-* 06:00:00", "0 6 * * *"],
    ["12:30", "30 12 * * *"],
    ["Sun", "0 0 * * 0"],
    // Zéros de tête : renormalisés (08 ne doit jamais partir en octal).
    ["*-*-* 08:05:00", "5 8 * * *"],
    // Intervalles et pas de répétition.
    ["*-*-* 09..17:00:00", "0 9-17 * * *"],
    ["*-*-* *:0/15:00", "0-59/15 * * * *"],
    ["*-*-* *:*/10:00", "*/10 * * * *"],
    // Jour du mois et mois explicites.
    ["*-01,07-01 00:00:00", "0 0 1 1,7 *"],
    ["*-*-01 03:00:00", "0 3 1 * *"],
  ];

  for (const [schedule, attendu] of cas) {
    const r = convertirOnCalendarEnCron(schedule);
    assert(r.ok, `« ${schedule} » aurait dû être converti, refusé avec: ${r.message}`);
    assert(r.cron === attendu, `« ${schedule} » → attendu "${attendu}", reçu "${r.cron}"`);
  }
}

// ---------------------------------------------------------------------------
// 2. OnCalendar → cron : formes refusées (bruyamment)
// ---------------------------------------------------------------------------

function testConversionsRefusees() {
  const cas = [
    // Secondes non nulles : cron ne descend pas sous la minute.
    ["*-*-* 08:15:30", /seconde/i],
    ["*-*-* *:*:*", /seconde/i],
    // Année explicite : pas de champ année en cron.
    ["2026-01-01 00:00:00", /année/i],
    // ET (systemd) vs OU (cron) sur jour-du-mois / jour-de-semaine.
    ["Mon *-*-01 09:00:00", /ET|OU/],
    // Fuseau horaire / jetons en trop.
    ["*-*-* 09:00:00 Europe/Paris", /jetons en trop|fuseau/i],
    // Raccourci inconnu.
    ["quotidien", /raccourci/i],
    ["", /vide/i],
    // Valeurs hors bornes.
    ["*-*-* 25:00:00", /heure/i],
    ["*-13-01 00:00:00", /mois/i],
    // Syntaxes systemd sans équivalent cron.
    ["*-*-~01 00:00:00", /sans équivalent cron/i],
    ["Fri..Mon *-*-* 09:00:00", /dimanche|équivalent/i],
    // Formes mal fichues.
    ["*-*-* 09", /heure|date/i],
    ["Lundi *-*-* 09:00:00", /jour de semaine|raccourci/i],
  ];

  for (const [schedule, motif] of cas) {
    const r = convertirOnCalendarEnCron(schedule);
    assert(!r.ok, `« ${schedule} » aurait dû être REFUSÉ, converti en "${r.cron}"`);
    assert(
      typeof r.message === "string" && r.message.length > 0,
      `« ${schedule} » : refus sans message — un refus muet est exactement ce qu'on interdit`,
    );
    assert(motif.test(r.message), `« ${schedule} » : message peu explicite (${motif}) → "${r.message}"`);
  }
}

// ---------------------------------------------------------------------------
// 3. Manifeste : champs serveur (lieu, projet, timeoutMinutes)
// ---------------------------------------------------------------------------

function testManifeste() {
  const base = { name: "temoin", orchestration: "rapport", schedule: "daily", enabled: true };

  const defaut = normaliserManifeste({ ...base });
  assert(defaut.ok, `manifeste minimal refusé: ${defaut.message}`);
  assert(defaut.tache.lieu === "local", `'lieu' doit valoir 'local' par défaut, reçu ${defaut.tache.lieu}`);
  assert(defaut.tache.timeoutMinutes === 30, "'timeoutMinutes' doit valoir 30 par défaut");
  assert(defaut.tache.projet === null, "'projet' doit valoir null par défaut");

  const serveur = normaliserManifeste({ ...base, lieu: "serveur", projet: "mon-projet", timeoutMinutes: 5 });
  assert(serveur.ok, `manifeste serveur refusé: ${serveur.message}`);
  assert(serveur.tache.lieu === "serveur" && serveur.tache.projet === "mon-projet", "champs serveur mal lus");
  assert(serveur.tache.timeoutMinutes === 5, "'timeoutMinutes' mal lu");

  const lieuInvalide = normaliserManifeste({ ...base, lieu: "vps" });
  assert(!lieuInvalide.ok && /lieu/.test(lieuInvalide.message), "'lieu: vps' aurait dû être refusé");

  const projetInvalide = normaliserManifeste({ ...base, projet: "../ailleurs" });
  assert(!projetInvalide.ok && /projet/.test(projetInvalide.message), "'projet' avec séparateur doit être refusé");

  const timeoutInvalide = normaliserManifeste({ ...base, timeoutMinutes: 0 });
  assert(!timeoutInvalide.ok, "'timeoutMinutes: 0' doit être refusé");

  // Un cwd absolu du POSTE reste accepté : c'est run-tache.mjs qui le traduit.
  const avecCwd = normaliserManifeste({ ...base, cwd: "/home/utilisateur/dev/iaction" });
  assert(avecCwd.ok && avecCwd.tache.cwd === "/home/utilisateur/dev/iaction", "'cwd' du poste mal conservé");
}

// ---------------------------------------------------------------------------
// 4. Résolution du projet
// ---------------------------------------------------------------------------

async function testResolutionProjet() {
  const racineProjets = "/data/projets";
  const existants = new Set([path.join(racineProjets, "iaction"), path.join(racineProjets, "demo")]);
  const verifierDossier = async (chemin) => existants.has(chemin);

  // a. champ 'projet' explicite — prioritaire sur cwd.
  const parProjet = await resoudreProjet(
    { projet: "demo", cwd: "/home/utilisateur/dev/iaction" },
    { racineProjets, verifierDossier },
  );
  assert(parProjet.ok, `résolution par 'projet' refusée: ${parProjet.message}`);
  assert(
    parProjet.chemin === path.join(racineProjets, "demo"),
    `'projet' doit primer sur 'cwd', reçu ${parProjet.chemin}`,
  );

  // b. par NOM DE DOSSIER du cwd absolu du poste (qui n'existe pas ici).
  const parCwd = await resoudreProjet(
    { projet: null, cwd: "/home/utilisateur/dev/iaction" },
    { racineProjets, verifierDossier },
  );
  assert(parCwd.ok, `résolution par nom de dossier refusée: ${parCwd.message}`);
  assert(
    parCwd.chemin === path.join(racineProjets, "iaction"),
    `cwd du poste mal traduit, reçu ${parCwd.chemin}`,
  );

  // Un cwd terminé par un séparateur donne le même résultat.
  const parCwdSlash = await resoudreProjet(
    { projet: null, cwd: "/home/utilisateur/dev/iaction/" },
    { racineProjets, verifierDossier },
  );
  assert(parCwdSlash.ok && parCwdSlash.chemin === path.join(racineProjets, "iaction"), "cwd avec / final mal géré");

  // c. introuvable → ÉCHEC EXPLICITE, jamais de repli silencieux.
  const introuvable = await resoudreProjet(
    { projet: null, cwd: "/home/utilisateur/dev/projet-absent" },
    { racineProjets, verifierDossier, dossierTache: "/data/taches/temoin" },
  );
  assert(!introuvable.ok, "un projet absent doit faire ÉCHOUER la résolution (pas de repli sur le dossier de tâche)");
  assert(
    /projet-absent/.test(introuvable.message) && /\/data\/projets/.test(introuvable.message),
    `le message doit nommer le projet cherché ET l'endroit où il a été cherché, reçu: ${introuvable.message}`,
  );

  const projetInconnu = await resoudreProjet(
    { projet: "inconnu", cwd: null },
    { racineProjets, verifierDossier },
  );
  assert(!projetInconnu.ok && /inconnu/.test(projetInconnu.message), "'projet' inconnu doit échouer explicitement");

  // d. ni 'projet' ni 'cwd' → dossier de la tâche (comportement historique des
  //    unités systemd : orchestrations globales seulement).
  const sansRien = await resoudreProjet(
    { projet: null, cwd: null },
    { racineProjets, verifierDossier, dossierTache: "/data/taches/temoin" },
  );
  assert(sansRien.ok && sansRien.chemin === "/data/taches/temoin", "sans 'projet' ni 'cwd', le dossier de la tâche est attendu");
}

// ---------------------------------------------------------------------------
// 5. Construction du crontab sur une arborescence jetable
// ---------------------------------------------------------------------------

async function testConstructionCrontab(racine) {
  const ecrire = async (nom, yaml) => {
    await fsp.mkdir(path.join(racine, nom), { recursive: true });
    await fsp.writeFile(path.join(racine, nom, "tache.yaml"), yaml, "utf8");
  };

  await ecrire(
    "temoin-serveur",
    ["name: temoin-serveur", "orchestration: rapport", "schedule: '*-*-* 08:15:00'", "enabled: true", "lieu: serveur", ""].join("\n"),
  );
  await ecrire(
    "menage-mails",
    ["name: menage-mails", "orchestration: gardien-boites", "schedule: daily", "enabled: true", "lieu: local", ""].join("\n"),
  );
  await ecrire(
    "desactivee",
    ["name: desactivee", "orchestration: rapport", "schedule: daily", "enabled: false", "lieu: serveur", ""].join("\n"),
  );
  await ecrire(
    "schedule-impossible",
    ["name: schedule-impossible", "orchestration: rapport", "schedule: '*-*-* 08:15:30'", "enabled: true", "lieu: serveur", ""].join("\n"),
  );
  await ecrire("yaml-casse", "name: [pas\n  un: mapping\n");
  // Dossier sans tache.yaml (ex. la zone d'état remontée) : ignoré sans bruit.
  await fsp.mkdir(path.join(racine, "_etat-serveur"), { recursive: true });

  const resultat = await construireCrontab(racine, { node: "/usr/bin/node", runTache: "/app/run-tache.mjs" });

  assert(resultat.lignes.length === 1, `une seule tâche planifiable attendue, reçu ${JSON.stringify(resultat.lignes)}`);
  assert(
    resultat.lignes[0] === "15 8 * * * /usr/bin/node /app/run-tache.mjs temoin-serveur",
    `ligne de crontab inattendue: ${resultat.lignes[0]}`,
  );

  // Les deux fautives remontent, nommées, avec leur valeur.
  assert(resultat.erreurs.length === 2, `2 erreurs attendues, reçu ${JSON.stringify(resultat.erreurs)}`);
  const erreurs = resultat.erreurs.join("\n");
  assert(/schedule-impossible/.test(erreurs) && /08:15:30/.test(erreurs), "le refus doit nommer la tâche ET la valeur");
  assert(/yaml-casse/.test(erreurs), "un manifeste illisible doit remonter, jamais disparaître");

  // Les non concernées sont listées comme telles (information, pas anomalie).
  const ignorees = resultat.ignorees.join(", ");
  assert(/menage-mails \(lieu: local\)/.test(ignorees), `'lieu: local' doit être ignoré et listé, reçu: ${ignorees}`);
  assert(/desactivee \(enabled: false\)/.test(ignorees), `'enabled: false' doit être ignoré et listé, reçu: ${ignorees}`);
}

// ---------------------------------------------------------------------------

async function main() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ia-runner-test-"));
  try {
    testConversionsAcceptees();
    testConversionsRefusees();
    testManifeste();
    await testResolutionProjet();
    await testConstructionCrontab(path.join(tmp, "taches"));

    // Les scripts shell doivent être exécutables : l'entrypoint les appelle
    // directement (`"$BIN/sync-down.sh"`), un bit manquant ne se verrait qu'au
    // premier démarrage du conteneur.
    for (const nom of ["entrypoint.sh", "sync-down.sh", "sync-up.sh", "plan-cron.mjs", "run-tache.mjs"]) {
      const chemin = path.resolve(__dirname, "..", "..", "docker", "ia-runner", "bin", nom);
      const stat = await fsp.stat(chemin);
      assert((stat.mode & 0o111) !== 0, `${nom} doit être exécutable (chmod +x)`);
    }

    console.log("OK");
    process.exitCode = 0;
  } catch (err) {
    console.error("ECHEC du test ia-runner (D1):", err.message);
    process.exitCode = 1;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

main();
