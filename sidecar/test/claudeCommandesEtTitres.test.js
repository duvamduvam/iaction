/*
 * claude.commands / claude.sessionTitles
 *
 * T-058 — ces deux méthodes dispatchées par sidecar/src/index.ts n'avaient
 * aucun test de bout en bout par le vrai protocole (sous-processus + JSON
 * Lines) : `claude.commands` n'était exercée qu'EN-PROCESS via
 * `executerClaudeCommands` (claudePur.test.js), et `claude.sessionTitles`
 * n'avait strictement aucun test.
 *
 * Lancement isolé : node sidecar/test/claudeCommandesEtTitres.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { lancer, assert, entry, fail } from "./harness.mjs";

/*
 * T-135 — `fileURLToPath`, et surtout PAS `new URL(...).pathname`.
 *
 * Sous Windows, `pathname` rend « /D:/a/iaction/sidecar/test » : une barre
 * oblique en tête, une lettre de lecteur, des séparateurs POSIX. `path.join`
 * en tire un chemin qui n'existe pas, et la doublure n'est jamais trouvée —
 * c'est ce qui a fait tomber la construction NSIS de la 0.6.0. Sur Linux les
 * deux formes coïncident, d'où un test vert ici et rouge là-bas.
 * `fileURLToPath` est l'outil prévu pour cette conversion ; le reste de la
 * suite l'utilise déjà (voir `harness.mjs`).
 */
const fakeClaudeCommandsModule = path.join(path.dirname(fileURLToPath(import.meta.url)), "fakeClaudeCommands.mjs");

async function spawnSidecar(extraEnv) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
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
      fail(`stdout du sidecar (claude.commands/sessionTitles) a émis une ligne non-JSON: ${line}`);
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

/**
 * claude.commands — session SDK ouverte en entrée streamée qui ne joue AUCUN
 * tour, `supportedCommands()` lu puis session refermée (docs/protocol.md
 * § claude.commands).
 */
async function testClaudeCommands() {
  const { child, send, waitFor, stderrChunks } = await spawnSidecar({
    IACTION_FAKE_CLAUDE: "1",
    IACTION_FAKE_CLAUDE_MODULE: fakeClaudeCommandsModule,
  });
  let tmpProject = null;
  try {
    tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-claudecmd-project-"));

    // 1. Nominal : la liste mappée (description/argumentHint par défaut à "",
    // aliases porté seulement s'il est non vide).
    send({ id: "cc1", method: "claude.commands", params: { cwd: tmpProject } });
    const doneCc1 = await waitFor(
      (e) => e.id === "cc1" && (e.event === "done" || e.event === "error"),
      5000,
      "claude.commands cc1",
    );
    assert(doneCc1.event === "done", `cc1 attendu 'done', reçu '${doneCc1.event}': ${JSON.stringify(doneCc1.data)}`);
    assert(
      JSON.stringify(doneCc1.data.commands) ===
        JSON.stringify([
          { name: "compact", description: "Résume la conversation.", argumentHint: "" },
          { name: "revue", description: "Lance une revue de code.", argumentHint: "<fichier>", aliases: ["r"] },
        ]),
      `cc1 : mapping des commandes inattendu, reçu ${JSON.stringify(doneCc1.data.commands)}`,
    );

    // 2. Erreur : params.cwd manquant (validation avant tout appel au SDK).
    send({ id: "cc2", method: "claude.commands", params: {} });
    const errCc2 = await waitFor((e) => e.id === "cc2" && e.event === "error", 3000, "claude.commands cc2 (cwd manquant)");
    assert(errCc2.data.message.includes("cwd"), `cc2 message inattendu: ${errCc2.data.message}`);

    // 3. Erreur : échec d'initialisation du SDK (auth) — le faux moteur lève
    // dès l'appel si options.cwd se termine par 'echec-init'.
    const tmpEchec = path.join(os.tmpdir(), `iaction-claudecmd-echec-init-${process.pid}`);
    await fsp.mkdir(tmpEchec, { recursive: true });
    send({ id: "cc3", method: "claude.commands", params: { cwd: tmpEchec } });
    const errCc3 = await waitFor(
      (e) => e.id === "cc3" && e.event === "error",
      5000,
      "claude.commands cc3 (échec d'initialisation SDK)",
    );
    assert(typeof errCc3.data.message === "string" && errCc3.data.message.length > 0, "cc3 doit renvoyer un message d'erreur lisible");
    await fsp.rm(tmpEchec, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr (claude.commands) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    if (tmpProject) await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * claude.sessionTitles — best effort, ne lève JAMAIS (docs/protocol.md §
 * claude.sessionTitles). N'a pas de point d'injection (elle importe le SDK
 * réel STATIQUEMENT — voir l'en-tête de sidecar/src/claudeSessionTitles.ts) :
 * IACTION_FAKE_CLAUDE ne s'y applique pas, un vrai sidecar suffit puisque
 * `listSessions` ne fait qu'une lecture disque locale, sans réseau ni tour.
 */
async function testClaudeSessionTitles() {
  const { child, send, waitFor, stderrChunks } = await spawnSidecar({});
  let tmpProject = null;
  try {
    tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-sessiontitres-project-"));

    // 1. Nominal (chemin court-circuité) : cwd manquant -> {titles:[]} immédiat,
    // sans jamais appeler le SDK.
    send({ id: "st1", method: "claude.sessionTitles", params: {} });
    const doneSt1 = await waitFor(
      (e) => e.id === "st1" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.sessionTitles st1 (cwd manquant)",
    );
    assert(
      doneSt1.event === "done" && JSON.stringify(doneSt1.data.titles) === "[]",
      `st1 : sans cwd, titles:[] attendu immédiatement, reçu '${doneSt1.event}' ${JSON.stringify(doneSt1.data)}`,
    );

    // 2. Comportement documenté « ne lève jamais » : cwd valide mais SANS
    // AUCUNE session Claude connue pour ce dossier -> {titles:[]}, jamais
    // 'error' (c'est le chemin qui absorbe toute panne de listSessions —
    // SDK indisponible, cwd inconnu du CLI, aucune session).
    send({ id: "st2", method: "claude.sessionTitles", params: { cwd: tmpProject } });
    const doneSt2 = await waitFor(
      (e) => e.id === "st2" && (e.event === "done" || e.event === "error"),
      15000,
      "claude.sessionTitles st2 (cwd sans session connue)",
    );
    assert(
      doneSt2.event === "done" && JSON.stringify(doneSt2.data.titles) === "[]",
      `st2 : un cwd sans session connue doit renvoyer 'done' {titles:[]}, jamais 'error', reçu '${doneSt2.event}' ${JSON.stringify(doneSt2.data)}`,
    );

    // 3. Même trajet avec un filtre sessionIds explicite : toujours {titles:[]},
    // jamais d'erreur (aucune session ne peut correspondre).
    send({
      id: "st3",
      method: "claude.sessionTitles",
      params: { cwd: tmpProject, sessionIds: ["session-inexistante"] },
    });
    const doneSt3 = await waitFor(
      (e) => e.id === "st3" && (e.event === "done" || e.event === "error"),
      15000,
      "claude.sessionTitles st3 (sessionIds filtrant tout)",
    );
    assert(
      doneSt3.event === "done" && JSON.stringify(doneSt3.data.titles) === "[]",
      `st3 : reçu '${doneSt3.event}' ${JSON.stringify(doneSt3.data)}`,
    );
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr (claude.sessionTitles) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    if (tmpProject) await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer(
  "claude.commands / claude.sessionTitles",
  testClaudeCommands,
  testClaudeSessionTitles,
);
