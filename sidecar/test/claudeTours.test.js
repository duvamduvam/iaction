/*
 * tours claude (arrière-plan, push)
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/claudeTours.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { lancer, assert, dossierTest, entry, fail } from "./harness.mjs";

/**
 * claude.release + plafond d'attente des tâches de fond (docs/protocol.md,
 * § claude.release) : sous-processus sidecar dédié (fakeClaudeBackground.mjs,
 * dont le rapport de tâche de fond ne vient jamais), avec un plafond court
 * (IACTION_BACKGROUND_WAIT_TIMEOUT_MS=1500) pour tester la clôture auto.
 */
async function testClaudeBackgroundRelease() {
  const fakeClaudeBackgroundModule = path.join(dossierTest, "fakeClaudeBackground.mjs");
  const child4 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeBackgroundModule,
      IACTION_BACKGROUND_WAIT_TIMEOUT_MS: "1500",
    },
  });

  const received4 = [];
  const waiters4 = [];

  function notifyWaiters4(evt) {
    for (let i = waiters4.length - 1; i >= 0; i--) {
      const w = waiters4[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters4.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor4(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received4.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters4.indexOf(w);
        if (idx >= 0) waiters4.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters4.push(w);
    });
  }

  const stdoutRl4 = createInterface({ input: child4.stdout, crlfDelay: Infinity });
  stdoutRl4.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du sidecar fakeClaudeBackground a émis une ligne non-JSON: ${line}`);
      return;
    }
    received4.push(parsed);
    notifyWaiters4(parsed);
  });

  const stderrChunks4 = [];
  child4.stderr.on("data", (d) => stderrChunks4.push(d.toString()));

  function send4(obj) {
    child4.stdin.write(JSON.stringify(obj) + "\n");
  }

  try {
    await waitFor4((e) => e.event === "ready", 3000, "ready (sidecar fakeClaudeBackground)");

    // --- claude.release sur un targetId inconnu -> released:false
    send4({ id: "rel-unknown", method: "claude.release", params: { targetId: "id-inconnu" } });
    const doneRelUnknown = await waitFor4(
      (e) => e.id === "rel-unknown" && e.event === "done",
      3000,
      "claude.release rel-unknown",
    );
    assert(
      doneRelUnknown.data.released === false,
      `claude.release sur targetId inconnu doit répondre released:false, reçu ${JSON.stringify(doneRelUnknown.data)}`,
    );

    // --- Scénario 1 : rendre la main via claude.release pendant background_wait.
    send4({ id: "cl-bg1", method: "claude.start", params: { cwd: "/tmp", prompt: "tâche de fond" } });
    const waitBg1 = await waitFor4(
      (e) => e.id === "cl-bg1" && e.event === "chunk" && e.data.kind === "background_wait",
      3000,
      "claude.start cl-bg1 chunk background_wait",
    );
    assert(
      waitBg1.data.count === 1 && waitBg1.data.descriptions[0] === "fausse tâche interminable",
      `background_wait cl-bg1 incorrect: ${JSON.stringify(waitBg1.data)}`,
    );

    send4({ id: "rel-bg1", method: "claude.release", params: { targetId: "cl-bg1" } });
    const doneRel1 = await waitFor4(
      (e) => e.id === "rel-bg1" && e.event === "done",
      3000,
      "claude.release rel-bg1",
    );
    assert(
      doneRel1.data.released === true,
      `claude.release pendant background_wait doit répondre released:true, reçu ${JSON.stringify(doneRel1.data)}`,
    );

    const doneBg1 = await waitFor4(
      (e) => e.id === "cl-bg1" && e.event === "done",
      3000,
      "claude.start cl-bg1 done (après release)",
    );
    assert(
      doneBg1.data.subtype === "success" &&
        typeof doneBg1.data.result === "string" &&
        doneBg1.data.usage?.inputTokens === 7,
      `done cl-bg1 doit livrer le résultat connu (success, usage), reçu ${JSON.stringify(doneBg1.data)}`,
    );

    // --- Scénario 2 : plafond automatique (1500 ms) SANS claude.release.
    send4({ id: "cl-bg2", method: "claude.start", params: { cwd: "/tmp", prompt: "plafond" } });
    await waitFor4(
      (e) => e.id === "cl-bg2" && e.event === "chunk" && e.data.kind === "background_wait",
      3000,
      "claude.start cl-bg2 chunk background_wait",
    );
    const doneBg2 = await waitFor4(
      (e) => e.id === "cl-bg2" && e.event === "done",
      5000,
      "claude.start cl-bg2 done (plafond auto)",
    );
    assert(
      doneBg2.data.subtype === "success",
      `done cl-bg2 (plafond) doit livrer le résultat connu (success), reçu ${JSON.stringify(doneBg2.data)}`,
    );

    // Après clôture, claude.release ne connaît plus le tour -> released:false.
    send4({ id: "rel-bg2", method: "claude.release", params: { targetId: "cl-bg2" } });
    const doneRel2 = await waitFor4(
      (e) => e.id === "rel-bg2" && e.event === "done",
      3000,
      "claude.release rel-bg2 (tour clos)",
    );
    assert(
      doneRel2.data.released === false,
      `claude.release après clôture doit répondre released:false, reçu ${JSON.stringify(doneRel2.data)}`,
    );
  } catch (err) {
    if (stderrChunks4.length > 0) {
      console.error("--- stderr du sidecar fakeClaudeBackground ---");
      console.error(stderrChunks4.join(""));
    }
    throw err;
  } finally {
    if (child4.exitCode === null) {
      child4.kill();
    }
  }
}

/**
 * S3 — `claude.push` : une demande glissée dans le tour EN COURS parvient bien
 * au moteur par l'entrée streamée que claude.start garde ouverte (voir
 * docs/protocol.md § claude.push). Le faux moteur (fakeClaudePush.mjs) attend
 * un message SUPPLÉMENTAIRE sur cette entrée et le renvoie en clair : le voir
 * ressortir dans le flux prouve la traversée de bout en bout.
 */
async function testClaudePush() {
  const fakeClaudePushModule = path.join(dossierTest, "fakeClaudePush.mjs");
  const child8 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudePushModule,
    },
  });

  const received8 = [];
  const waiters8 = [];

  function notifyWaiters8(evt) {
    for (let i = waiters8.length - 1; i >= 0; i--) {
      const w = waiters8[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters8.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor8(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received8.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters8.indexOf(w);
        if (idx >= 0) waiters8.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters8.push(w);
    });
  }

  const stdoutRl8 = createInterface({ input: child8.stdout, crlfDelay: Infinity });
  stdoutRl8.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du sidecar fakeClaudePush a émis une ligne non-JSON: ${line}`);
      return;
    }
    received8.push(parsed);
    notifyWaiters8(parsed);
  });

  const stderrChunks8 = [];
  child8.stderr.on("data", (d) => stderrChunks8.push(d.toString()));

  function send8(obj) {
    child8.stdin.write(JSON.stringify(obj) + "\n");
  }

  try {
    await waitFor8((e) => e.event === "ready", 3000, "ready (sidecar fakeClaudePush)");

    // --- Tour inconnu -> pushed:false (jamais une erreur : l'UI se rabat sur
    // sa file d'attente plutôt que de perdre le message).
    send8({ id: "push-unknown", method: "claude.push", params: { targetId: "id-inconnu", content: "coucou" } });
    const donePushUnknown = await waitFor8(
      (e) => e.id === "push-unknown" && e.event === "done",
      3000,
      "claude.push push-unknown",
    );
    assert(
      donePushUnknown.data.pushed === false,
      `claude.push sur targetId inconnu doit répondre pushed:false, reçu ${JSON.stringify(donePushUnknown.data)}`,
    );

    // --- content manquant -> erreur protocolaire (contrairement au tour
    // inconnu, c'est un appel malformé, pas une course normale).
    send8({ id: "push-nocontent", method: "claude.push", params: { targetId: "cl-push" } });
    await waitFor8((e) => e.id === "push-nocontent" && e.event === "error", 3000, "claude.push sans content");

    // --- Demande glissée dans le tour en cours.
    send8({ id: "cl-push", method: "claude.start", params: { cwd: "/tmp", prompt: "tour initial" } });
    await waitFor8(
      (e) => e.id === "cl-push" && e.event === "chunk" && e.data.kind === "init",
      3000,
      "claude.start cl-push chunk init",
    );

    send8({ id: "push-1", method: "claude.push", params: { targetId: "cl-push", content: "et le CHANGELOG" } });
    const donePush1 = await waitFor8((e) => e.id === "push-1" && e.event === "done", 3000, "claude.push push-1");
    assert(
      donePush1.data.pushed === true,
      `claude.push sur un tour en cours doit répondre pushed:true, reçu ${JSON.stringify(donePush1.data)}`,
    );

    // Le faux moteur renvoie le message poussé en clair : le voir ici prouve
    // qu'il a traversé l'entrée streamée du tour DÉJÀ démarré.
    const textChunk = await waitFor8(
      (e) => e.id === "cl-push" && e.event === "chunk" && e.data.kind === "text",
      3000,
      "texte issu du message poussé",
    );
    assert(
      textChunk.data.delta === "injecté: et le CHANGELOG",
      `le message poussé doit parvenir au moteur, reçu ${JSON.stringify(textChunk.data)}`,
    );

    // Le tour reste UN SEUL tour : un unique done, portant le résultat.
    const donePushTurn = await waitFor8((e) => e.id === "cl-push" && e.event === "done", 3000, "done du tour cl-push");
    assert(
      donePushTurn.data.subtype === "success" && donePushTurn.data.result === "injecté: et le CHANGELOG",
      `le tour doit se clore normalement après injection, reçu ${JSON.stringify(donePushTurn.data)}`,
    );

    // --- Tour terminé : plus rien à pousser (le run a été retiré).
    send8({ id: "push-late", method: "claude.push", params: { targetId: "cl-push", content: "trop tard" } });
    const donePushLate = await waitFor8((e) => e.id === "push-late" && e.event === "done", 3000, "claude.push push-late");
    assert(
      donePushLate.data.pushed === false,
      `claude.push après la fin du tour doit répondre pushed:false, reçu ${JSON.stringify(donePushLate.data)}`,
    );
  } catch (err) {
    if (stderrChunks8.length > 0) {
      console.error("--- stderr du sidecar fakeClaudePush ---");
      console.error(stderrChunks8.join(""));
    }
    throw err;
  } finally {
    if (child8.exitCode === null) {
      child8.kill();
    }
  }
}

await lancer(
  "tours claude (arrière-plan, push)",
  testClaudeBackgroundRelease,
  testClaudePush,
);
