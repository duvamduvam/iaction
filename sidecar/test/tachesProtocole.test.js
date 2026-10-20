/*
 * tâches — CRUD, rapports, et timers (par le VRAI protocole)
 *
 * T-058 (extension) — `taches.list/read/write/delete/reports/reportRead/
 * timerStatus/timerApply/timerRemove` sont dispatchées par
 * sidecar/src/index.ts mais `taches.test.js` (voisin) ne les exerce QUE par
 * import direct des handlers (`moduleCompile("taches.js")`), jamais par le
 * protocole JSON Lines sur un vrai sous-processus sidecar. Ce fichier ne
 * touche pas à taches.test.js — il teste autre chose : le VRAI chemin de
 * dispatch (`case "taches.*"` d'index.ts).
 *
 * Timers (T2, `tachesTimers.ts`) : `taches.timerApply`/`taches.timerRemove`
 * écrivent leurs unités sous `os.homedir()/.config/systemd/user` — TOUJOURS
 * le vrai $HOME, PAR CONCEPTION (voir le commentaire de `systemdUserDir()`,
 * qui ignore XDG_CONFIG_HOME exprès), et leurs chemins nominaux appellent le
 * vrai `systemctl --user`. Aucune couture d'injection n'existe (pas de
 * `IACTION_FAKE_SYSTEMCTL`, pas de client injectable). Conformément à la
 * règle du projet (jamais de test qui suppose un environnement Unix précis
 * ni qui touche le vrai $HOME), ce fichier ne couvre QUE :
 *   - les branches de VALIDATION DE PARAMÈTRES, qui renvoient AVANT tout
 *     appel à systemctl ou tout accès à `systemdUserDir()` ;
 *   - le seul cas nominal atteignable sans effet de bord OS : `taches.timerStatus`
 *     sur un ensemble de noms VIDE (la boucle qui appelle systemctl ne
 *     s'exécute alors jamais — zéro appel système, voir `handleTachesTimerStatus`).
 * Les chemins nominaux de `taches.timerApply`/`taches.timerRemove` (écriture
 * d'unités + `systemctl --user enable/disable/daemon-reload`) restent NON
 * couverts ici — voir le rapport de tâche pour le détail.
 *
 * Lancement isolé : node sidecar/test/tachesProtocole.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, entry, fail } from "./harness.mjs";

async function spawnSidecar(xdgDir) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_CONFIG_HOME: xdgDir },
  });
  const received = [];
  const waiters = [];
  function notify(evt) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(evt);
      }
    }
  }
  function waitFor(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters.push(w);
    });
  }
  const stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutRl.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du sidecar (taches) a émis une ligne non-JSON: ${line}`);
      return;
    }
    received.push(parsed);
    notify(parsed);
  });
  const stderrChunks = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));
  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }
  await waitFor((e) => e.event === "ready", 3000, "ready");
  return { child, send, waitFor, stderrChunks };
}

/** taches.write / taches.list / taches.read / taches.reports / taches.reportRead / taches.delete. */
async function testTachesCrudEtRapports() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-tachescrud-xdg-"));
  const { child, send, waitFor, stderrChunks } = await spawnSidecar(xdgDir);
  try {
    // 1. taches.write nominal (mode objet) : la tâche est créée avec ses défauts documentés.
    send({
      id: "tw1",
      method: "taches.write",
      params: {
        tache: { name: "releve-quotidien", orchestration: "releve", schedule: "*-*-* 08:00" },
      },
    });
    const doneTw1 = await waitFor(
      (e) => e.id === "tw1" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.write tw1",
    );
    assert(doneTw1.event === "done", `tw1 attendu 'done', reçu '${doneTw1.event}': ${JSON.stringify(doneTw1.data)}`);
    assert(
      doneTw1.data.tache.name === "releve-quotidien" &&
        doneTw1.data.tache.enabled === false &&
        doneTw1.data.tache.lieu === "local" &&
        doneTw1.data.tache.description === "",
      `tw1 défauts inattendus: ${JSON.stringify(doneTw1.data.tache)}`,
    );
    const tacheDir = doneTw1.data.path;

    // 2. taches.list nominal : la tâche écrite apparaît.
    send({ id: "tl1", method: "taches.list", params: {} });
    const doneTl1 = await waitFor(
      (e) => e.id === "tl1" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.list tl1",
    );
    assert(doneTl1.event === "done", `tl1 attendu 'done', reçu '${doneTl1.event}'`);
    const foundTl1 = doneTl1.data.taches.find((t) => t.name === "releve-quotidien");
    assert(foundTl1, `tl1 doit contenir 'releve-quotidien', reçu ${JSON.stringify(doneTl1.data.taches.map((t) => t.name))}`);

    // 3. taches.read nominal : raw restitué, forme normalisée cohérente.
    send({ id: "tr1", method: "taches.read", params: { name: "releve-quotidien" } });
    const doneTr1 = await waitFor(
      (e) => e.id === "tr1" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.read tr1",
    );
    assert(doneTr1.event === "done", `tr1 attendu 'done', reçu '${doneTr1.event}'`);
    assert(
      doneTr1.data.tache.orchestration === "releve" && doneTr1.data.tache.schedule === "*-*-* 08:00",
      `tr1 tâche relue incorrecte: ${JSON.stringify(doneTr1.data.tache)}`,
    );
    assert(typeof doneTr1.data.raw === "string" && doneTr1.data.raw.includes("releve-quotidien"), "tr1 raw doit porter le YAML écrit");

    // 4. taches.read erreur : nom inconnu.
    send({ id: "tr2", method: "taches.read", params: { name: "jamais-ecrite" } });
    const errTr2 = await waitFor((e) => e.id === "tr2" && e.event === "error", 3000, "taches.read tr2 (inconnue)");
    assert(typeof errTr2.data.message === "string" && errTr2.data.message.length > 0, "tr2 doit renvoyer une erreur");

    // 5. taches.write erreur : ni 'raw' ni 'tache'.
    send({ id: "tw2", method: "taches.write", params: {} });
    const errTw2 = await waitFor((e) => e.id === "tw2" && e.event === "error", 3000, "taches.write tw2 (ni raw ni tache)");
    assert(typeof errTw2.data.message === "string" && errTw2.data.message.length > 0, "tw2 doit renvoyer une erreur");

    // 6. taches.write erreur : champ 'lieu' invalide, JAMAIS ramené silencieusement au défaut
    // (docs/protocol.md § Forme d'une tâche — garde-fou anti-double-déclenchement).
    send({
      id: "tw3",
      method: "taches.write",
      params: { tache: { name: "mauvais-lieu", orchestration: "x", lieu: "Serveur" } },
    });
    const errTw3 = await waitFor((e) => e.id === "tw3" && e.event === "error", 3000, "taches.write tw3 (lieu invalide)");
    assert(
      errTw3.data.message.includes("lieu") && errTw3.data.message.includes("Serveur"),
      `tw3 doit citer le champ et la valeur reçue, reçu: ${errTw3.data.message}`,
    );

    // 7. taches.reports nominal, dossier vide (créé par taches.write mais sans rapport dedans).
    send({ id: "tp1", method: "taches.reports", params: { name: "releve-quotidien" } });
    const doneTp1 = await waitFor(
      (e) => e.id === "tp1" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.reports tp1 (vide)",
    );
    assert(
      doneTp1.event === "done" && JSON.stringify(doneTp1.data.reports) === "[]",
      `tp1 : rapports:[] attendu, reçu '${doneTp1.event}' ${JSON.stringify(doneTp1.data)}`,
    );

    // 8. Dépose un rapport directement sur disque, puis taches.reports nominal (non vide).
    await fsp.writeFile(path.join(tacheDir, "rapports", "2026-08-01.md"), "# Rapport\nOK\n", "utf8");
    send({ id: "tp2", method: "taches.reports", params: { name: "releve-quotidien" } });
    const doneTp2 = await waitFor(
      (e) => e.id === "tp2" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.reports tp2 (non vide)",
    );
    assert(doneTp2.event === "done", `tp2 attendu 'done', reçu '${doneTp2.event}'`);
    assert(
      doneTp2.data.reports.length === 1 && doneTp2.data.reports[0].file === "2026-08-01.md",
      `tp2 : rapport attendu, reçu ${JSON.stringify(doneTp2.data.reports)}`,
    );

    // 9. taches.reports erreur : nom invalide.
    send({ id: "tp3", method: "taches.reports", params: { name: "Nom Invalide!" } });
    const errTp3 = await waitFor((e) => e.id === "tp3" && e.event === "error", 3000, "taches.reports tp3 (nom invalide)");
    assert(typeof errTp3.data.message === "string" && errTp3.data.message.length > 0, "tp3 doit renvoyer une erreur");

    // 10. taches.reportRead nominal.
    send({ id: "trr1", method: "taches.reportRead", params: { name: "releve-quotidien", file: "2026-08-01.md" } });
    const doneTrr1 = await waitFor(
      (e) => e.id === "trr1" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.reportRead trr1",
    );
    assert(
      doneTrr1.event === "done" && doneTrr1.data.content === "# Rapport\nOK\n",
      `trr1 : contenu attendu, reçu '${doneTrr1.event}' ${JSON.stringify(doneTrr1.data)}`,
    );

    // 11. taches.reportRead erreur : nom de fichier tentant une traversée de chemin.
    send({ id: "trr2", method: "taches.reportRead", params: { name: "releve-quotidien", file: "../tache.yaml" } });
    const errTrr2 = await waitFor((e) => e.id === "trr2" && e.event === "error", 3000, "taches.reportRead trr2 (traversée)");
    assert(
      typeof errTrr2.data.message === "string" && errTrr2.data.message.length > 0,
      "trr2 doit refuser un nom de fichier hors du format '*.md' simple",
    );

    // 12. taches.reportRead erreur : rapport inexistant.
    send({ id: "trr3", method: "taches.reportRead", params: { name: "releve-quotidien", file: "absent.md" } });
    const errTrr3 = await waitFor((e) => e.id === "trr3" && e.event === "error", 3000, "taches.reportRead trr3 (absent)");
    assert(typeof errTrr3.data.message === "string" && errTrr3.data.message.length > 0, "trr3 doit renvoyer une erreur");

    // 13. taches.delete erreur : nom invalide.
    send({ id: "td1", method: "taches.delete", params: { name: "Invalide!" } });
    const errTd1 = await waitFor((e) => e.id === "td1" && e.event === "error", 3000, "taches.delete td1 (nom invalide)");
    assert(typeof errTd1.data.message === "string" && errTd1.data.message.length > 0, "td1 doit renvoyer une erreur");

    // 14. taches.delete nominal : le manifeste disparaît (le dossier et rapports/ restent).
    send({ id: "td2", method: "taches.delete", params: { name: "releve-quotidien" } });
    const doneTd2 = await waitFor(
      (e) => e.id === "td2" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.delete td2",
    );
    assert(
      doneTd2.event === "done" && doneTd2.data.deleted === true,
      `td2 attendu 'done'/deleted:true, reçu ${JSON.stringify(doneTd2.data)}`,
    );
    const manifestGone = await fsp.access(path.join(tacheDir, "tache.yaml")).then(() => true).catch(() => false);
    assert(!manifestGone, "td2 : tache.yaml doit avoir disparu");
    const reportsStayed = await fsp.access(path.join(tacheDir, "rapports", "2026-08-01.md")).then(() => true).catch(() => false);
    assert(reportsStayed, "td2 : rapports/ ne doit PAS être supprimé (contrat documenté de taches.delete)");

    // 15. taches.delete erreur : déjà supprimée.
    send({ id: "td3", method: "taches.delete", params: { name: "releve-quotidien" } });
    const errTd3 = await waitFor((e) => e.id === "td3" && e.event === "error", 3000, "taches.delete td3 (déjà supprimée)");
    assert(typeof errTd3.data.message === "string" && errTd3.data.message.length > 0, "td3 doit renvoyer une erreur");
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr (taches CRUD/rapports) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * taches.timerStatus / taches.timerApply / taches.timerRemove — UNIQUEMENT
 * les branches de validation, sans jamais toucher systemctl ni le vrai $HOME
 * (voir l'en-tête de fichier).
 */
async function testTachesTimersValidationSeule() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-tachestimers-xdg-"));
  const { child, send, waitFor, stderrChunks } = await spawnSidecar(xdgDir);
  try {
    // 1. taches.timerStatus nominal SANS appel système : aucune tâche déclarée
    // dans cet XDG_CONFIG_HOME isolé -> la boucle qui appellerait systemctl est vide.
    send({ id: "ts1", method: "taches.timerStatus", params: {} });
    const doneTs1 = await waitFor(
      (e) => e.id === "ts1" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.timerStatus ts1 (aucune tâche)",
    );
    assert(
      doneTs1.event === "done" && JSON.stringify(doneTs1.data.timers) === "{}",
      `ts1 : timers:{} attendu, reçu '${doneTs1.event}' ${JSON.stringify(doneTs1.data)}`,
    );

    // 2. Même nominal, en fournissant explicitement une liste vide.
    send({ id: "ts2", method: "taches.timerStatus", params: { names: [] } });
    const doneTs2 = await waitFor(
      (e) => e.id === "ts2" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.timerStatus ts2 (names:[])",
    );
    assert(
      doneTs2.event === "done" && JSON.stringify(doneTs2.data.timers) === "{}",
      `ts2 : timers:{} attendu, reçu '${doneTs2.event}' ${JSON.stringify(doneTs2.data)}`,
    );

    // 3. taches.timerStatus erreur : params.names n'est pas un tableau.
    send({ id: "ts3", method: "taches.timerStatus", params: { names: "pas-un-tableau" } });
    const errTs3 = await waitFor((e) => e.id === "ts3" && e.event === "error", 3000, "taches.timerStatus ts3 (names non tableau)");
    assert(typeof errTs3.data.message === "string" && errTs3.data.message.length > 0, "ts3 doit renvoyer une erreur");

    // 4. taches.timerStatus erreur : un nom du tableau ne respecte pas le format.
    send({ id: "ts4", method: "taches.timerStatus", params: { names: ["Nom Invalide!"] } });
    const errTs4 = await waitFor((e) => e.id === "ts4" && e.event === "error", 3000, "taches.timerStatus ts4 (nom invalide)");
    assert(typeof errTs4.data.message === "string" && errTs4.data.message.length > 0, "ts4 doit renvoyer une erreur");

    // 5. taches.timerApply erreur : params.name invalide (avant tout accès disque/OS).
    send({ id: "ta1", method: "taches.timerApply", params: { name: "Invalide!" } });
    const errTa1 = await waitFor((e) => e.id === "ta1" && e.event === "error", 3000, "taches.timerApply ta1 (nom invalide)");
    assert(typeof errTa1.data.message === "string" && errTa1.data.message.length > 0, "ta1 doit renvoyer une erreur");

    // 6. taches.timerApply erreur : tâche introuvable (loadTache échoue AVANT systemdUserDir()).
    send({ id: "ta2", method: "taches.timerApply", params: { name: "jamais-ecrite" } });
    const errTa2 = await waitFor((e) => e.id === "ta2" && e.event === "error", 3000, "taches.timerApply ta2 (tâche introuvable)");
    assert(typeof errTa2.data.message === "string" && errTa2.data.message.length > 0, "ta2 doit renvoyer une erreur");

    // 7. taches.timerApply erreur : tâche existante mais SANS schedule (encore
    // avant tout accès à systemdUserDir()/systemctl).
    send({
      id: "tw-sans-schedule",
      method: "taches.write",
      params: { tache: { name: "sans-horaire", orchestration: "x" } },
    });
    await waitFor(
      (e) => e.id === "tw-sans-schedule" && (e.event === "done" || e.event === "error"),
      3000,
      "taches.write (préparation ta3)",
    );
    send({ id: "ta3", method: "taches.timerApply", params: { name: "sans-horaire" } });
    const errTa3 = await waitFor((e) => e.id === "ta3" && e.event === "error", 3000, "taches.timerApply ta3 (schedule manquant)");
    assert(errTa3.data.message.includes("schedule"), `ta3 doit citer le champ 'schedule' manquant, reçu: ${errTa3.data.message}`);

    // 8. taches.timerRemove erreur : params.name invalide (le seul cas testable
    // sans toucher systemctl/le vrai $HOME — toute autre entrée, même une tâche
    // inconnue, atteint runSystemctl()/systemdUserDir()).
    send({ id: "tremove1", method: "taches.timerRemove", params: { name: "Invalide!" } });
    const errTremove1 = await waitFor(
      (e) => e.id === "tremove1" && e.event === "error",
      3000,
      "taches.timerRemove tremove1 (nom invalide)",
    );
    assert(typeof errTremove1.data.message === "string" && errTremove1.data.message.length > 0, "tremove1 doit renvoyer une erreur");
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr (taches timers, validation seule) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer(
  "tâches — CRUD, rapports, et timers (protocole)",
  testTachesCrudEtRapports,
  testTachesTimersValidationSeule,
);
