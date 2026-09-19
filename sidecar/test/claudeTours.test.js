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

/**
 * T-087/T-064 — harnais spawn+JSONL factorisé : les trois scénarios suivants
 * (push perdu, push acquitté, push avec pièces) partagent le même besoin que
 * testClaudeBackgroundRelease/testClaudePush avaient chacun réinventé.
 */
function spawnFakeSidecar(fakeModule, extraEnv = {}) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, IACTION_FAKE_CLAUDE: "1", IACTION_FAKE_CLAUDE_MODULE: fakeModule, ...extraEnv },
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
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du sidecar ${fakeModule} a émis une ligne non-JSON: ${line}`);
      return;
    }
    received.push(parsed);
    notify(parsed);
  });
  const stderrChunks = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));
  return {
    received,
    waitFor,
    send: (obj) => child.stdin.write(JSON.stringify(obj) + "\n"),
    fermer: (err) => {
      if (err && stderrChunks.length > 0) {
        console.error(`--- stderr du sidecar ${fakeModule} ---`);
        console.error(stderrChunks.join(""));
      }
      if (child.exitCode === null) child.kill();
    },
  };
}

const fakeClaudePushPerduModule = path.join(dossierTest, "fakeClaudePushPerdu.mjs");

/** T-087 — push jamais suivi d'un tool_result du fil : `push_perdu` AVANT le `done`. */
async function testClaudePushPerdu() {
  const h = spawnFakeSidecar(fakeClaudePushPerduModule);
  try {
    await h.waitFor((e) => e.event === "ready", 3000, "ready (fakeClaudePushPerdu)");
    h.send({ id: "cl-perdu", method: "claude.start", params: { cwd: "/tmp", prompt: "tour initial" } });
    await h.waitFor((e) => e.id === "cl-perdu" && e.event === "chunk" && e.data.kind === "init", 3000, "chunk init");

    h.send({ id: "push-perdu-1", method: "claude.push", params: { targetId: "cl-perdu", content: "et le CHANGELOG" } });
    const donePush = await h.waitFor((e) => e.id === "push-perdu-1" && e.event === "done", 3000, "claude.push done");
    assert(donePush.data.pushed === true, `push accepté attendu, reçu ${JSON.stringify(donePush.data)}`);

    // Le push_perdu doit arriver AVANT le done du tour — waitFor le trouve
    // dans les deux ordres, mais on vérifie ici explicitement sa position.
    const doneTurn = await h.waitFor((e) => e.id === "cl-perdu" && e.event === "done", 3000, "done du tour");
    const perdu = h.received.find((e) => e.id === "cl-perdu" && e.event === "chunk" && e.data.kind === "push_perdu");
    assert(perdu, "chunk push_perdu attendu, jamais reçu");
    assert(
      perdu.data.contenu === "et le CHANGELOG" && perdu.data.avaitPieces === false,
      `push_perdu incorrect: ${JSON.stringify(perdu?.data)}`,
    );
    assert(
      h.received.indexOf(perdu) < h.received.indexOf(doneTurn),
      "push_perdu doit être émis AVANT le done du tour, jamais après",
    );
  } catch (err) {
    h.fermer(err);
    throw err;
  }
  h.fermer(null);
}

/** T-087 — un outil rappelé (donc un tool_result DU FIL) après le push l'acquitte : pas de `push_perdu`. */
async function testClaudePushAcquitteParOutil() {
  const h = spawnFakeSidecar(fakeClaudePushPerduModule, { IACTION_FAKE_PUSH_OUTIL_APRES: "1" });
  try {
    await h.waitFor((e) => e.event === "ready", 3000, "ready (fakeClaudePushPerdu, outil après)");
    h.send({ id: "cl-acquitte", method: "claude.start", params: { cwd: "/tmp", prompt: "tour initial" } });
    await h.waitFor((e) => e.id === "cl-acquitte" && e.event === "chunk" && e.data.kind === "init", 3000, "chunk init");

    h.send({ id: "push-ok-1", method: "claude.push", params: { targetId: "cl-acquitte", content: "et le CHANGELOG" } });
    await h.waitFor((e) => e.id === "push-ok-1" && e.event === "done", 3000, "claude.push done");

    await h.waitFor((e) => e.id === "cl-acquitte" && e.event === "chunk" && e.data.kind === "tool_result", 3000, "tool_result du fil");
    await h.waitFor((e) => e.id === "cl-acquitte" && e.event === "done", 3000, "done du tour");

    const perdu = h.received.find((e) => e.id === "cl-acquitte" && e.event === "chunk" && e.data.kind === "push_perdu");
    assert(!perdu, `aucun push_perdu attendu (push acquitté par le tool_result), reçu ${JSON.stringify(perdu?.data)}`);
  } catch (err) {
    h.fermer(err);
    throw err;
  }
  h.fermer(null);
}

/** T-064 — un push AVEC pièces jointes les porte jusqu'à l'entrée streamée ; T-087 — perdu, il les signale (`avaitPieces: true`). */
async function testClaudePushAvecPieces() {
  const h = spawnFakeSidecar(fakeClaudePushPerduModule);
  try {
    await h.waitFor((e) => e.event === "ready", 3000, "ready (fakeClaudePushPerdu, pièces)");
    h.send({ id: "cl-pieces", method: "claude.start", params: { cwd: "/tmp", prompt: "tour initial" } });
    await h.waitFor((e) => e.id === "cl-pieces" && e.event === "chunk" && e.data.kind === "init", 3000, "chunk init");

    h.send({
      id: "push-img-1",
      method: "claude.push",
      params: {
        targetId: "cl-pieces",
        content: "regarde cette capture",
        attachments: [{ kind: "image", name: "capture.png", mediaType: "image/png", data: "aGVsbG8=" }],
      },
    });
    await h.waitFor((e) => e.id === "push-img-1" && e.event === "done", 3000, "claude.push done");

    // Le faux moteur rend compte des TYPES de blocs du message poussé : voir
    // le bloc image y prouve que buildUserMessage l'a bien construit.
    const echo = await h.waitFor((e) => e.id === "cl-pieces" && e.event === "chunk" && e.data.kind === "text", 3000, "écho des blocs poussés");
    assert(echo.data.delta.includes("image"), `le bloc image doit avoir traversé l'entrée streamée, reçu ${JSON.stringify(echo.data)}`);

    await h.waitFor((e) => e.id === "cl-pieces" && e.event === "done", 3000, "done du tour");
    const perdu = h.received.find((e) => e.id === "cl-pieces" && e.event === "chunk" && e.data.kind === "push_perdu");
    assert(perdu && perdu.data.avaitPieces === true, `push_perdu avec avaitPieces:true attendu, reçu ${JSON.stringify(perdu?.data)}`);
  } catch (err) {
    h.fermer(err);
    throw err;
  }
  h.fermer(null);
}

const fakeClaudeModule = path.join(dossierTest, "fakeClaude.mjs");

/**
 * T-102 — un « arrêt demandé » ne laissait AUCUNE trace : ni qui, ni quand.
 * `claude.abort` doit désormais journaliser une ligne `info` sur CHAQUE
 * réception, rattachée au tour visé (`reqId` = targetId), avec l'origine
 * qu'on en connaît (protocole direct ici : l'id de la requête d'abandon
 * diffère du tour visé — voir handleClaudeAbort).
 */
async function testClaudeAbortJournalise() {
  const h = spawnFakeSidecar(fakeClaudeModule);
  try {
    await h.waitFor((e) => e.event === "ready", 3000, "ready (fakeClaude, abandon journalisé)");
    h.send({ id: "cl-abandon", method: "claude.start", params: { cwd: "/tmp", prompt: "Bonjour" } });
    // fakeClaude.mjs bloque sur canUseTool avant son tool_use "Bash" : même
    // point d'arrêt que le scénario cl3 de protocol.test.js.
    await h.waitFor(
      (e) => e.id === "cl-abandon" && e.event === "chunk" && e.data.kind === "permission_request",
      3000,
      "chunk permission_request (fakeClaude)",
    );

    h.send({ id: "ab-abandon", method: "claude.abort", params: { targetId: "cl-abandon" } });
    const doneAbort = await h.waitFor((e) => e.id === "ab-abandon" && e.event === "done", 3000, "claude.abort done");
    assert(
      doneAbort.data.aborted === true,
      `claude.abort doit répondre aborted:true, reçu ${JSON.stringify(doneAbort.data)}`,
    );

    // Relit le journal jusqu'à y trouver la ligne (écriture mise en file,
    // même attente que claudeSilence.test.js).
    let ligne = null;
    for (let essai = 0; essai < 40 && !ligne; essai++) {
      h.send({ id: `log-abandon-${essai}`, method: "log.read", params: { minLevel: "info", scope: "claude" } });
      const lu = await h.waitFor(
        (e) => e.id === `log-abandon-${essai}` && e.event === "done",
        3000,
        "log.read",
      );
      ligne = lu.data.entries.find((en) => en.reqId === "cl-abandon" && en.msg === "abandon demandé");
      if (!ligne) await new Promise((r) => setTimeout(r, 50));
    }
    assert(ligne, "le journal doit contenir une ligne « abandon demandé » rattachée au tour visé");
    assert(
      ligne.fields.demandeur === "protocole",
      `un abandon posé directement (id de requête ≠ tour visé) doit se journaliser 'protocole', reçu ${JSON.stringify(ligne.fields)}`,
    );
    assert(
      ligne.fields.trouve === true,
      `le tour ciblé était en vie, 'trouve' attendu à true, reçu ${JSON.stringify(ligne.fields)}`,
    );
  } catch (err) {
    h.fermer(err);
    throw err;
  }
  h.fermer(null);
}

await lancer(
  "tours claude (arrière-plan, push)",
  testClaudeBackgroundRelease,
  testClaudePush,
  testClaudePushPerdu,
  testClaudePushAcquitteParOutil,
  testClaudePushAvecPieces,
  testClaudeAbortJournalise,
);
