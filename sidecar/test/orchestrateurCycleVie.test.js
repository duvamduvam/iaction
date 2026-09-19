/*
 * orchestrateur — cycle de vie (orch.read, orch.delete, orch.abort)
 *
 * T-058 — ces trois méthodes dispatchées par sidecar/src/index.ts n'étaient
 * traversées par AUCUN test de bout en bout (ni sous-processus, ni même
 * import direct du module) : orch.read et orch.delete n'apparaissaient nulle
 * part dans sidecar/test/, et orch.abort n'était exercé qu'EN-PROCESS via
 * `createOrchestratorRuntime({stepRunner})` (orchestrateurRun.test.js,
 * scénario C) — jamais par le chemin réel `case "orch.abort"` de index.ts.
 *
 * Lancement isolé : node sidecar/test/orchestrateurCycleVie.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, entry, fail, fakeClaudeModule } from "./harness.mjs";

/**
 * orch.read / orch.delete — CRUD en lecture/suppression, mêmes gardes
 * anti-traversée que agents.read/agents.delete (docs/protocol.md § orch.list…).
 */
async function testOrchReadDelete() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchcycle-xdg-"));
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
      fail(`stdout du sidecar (orch.read/orch.delete) a émis une ligne non-JSON: ${line}`);
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

  let tmpProject = null;
  let tmpOutside = null;

  try {
    await waitFor((e) => e.event === "ready", 3000, "ready");

    tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchcycle-project-"));
    tmpOutside = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchcycle-outside-"));

    const orchDir = path.join(tmpProject, ".iaction", "orchestrations");
    await fsp.mkdir(orchDir, { recursive: true });
    const raw = [
      "name: releve-simple",
      "description: Une seule étape (test orch.read/orch.delete).",
      "steps:",
      "  - id: seul",
      "    agent: worker",
      '    task: "Fais le travail."',
      "",
    ].join("\n");
    const orchPath = path.join(orchDir, "releve-simple.yaml");
    await fsp.writeFile(orchPath, raw, "utf8");

    // 1. orch.read nominal : lecture du fichier écrit ci-dessus, raw préservé à l'identique.
    send({ id: "or1", method: "orch.read", params: { cwd: tmpProject, path: orchPath } });
    const doneOr1 = await waitFor(
      (e) => e.id === "or1" && (e.event === "done" || e.event === "error"),
      3000,
      "orch.read or1",
    );
    assert(doneOr1.event === "done", `or1 attendu 'done', reçu '${doneOr1.event}': ${JSON.stringify(doneOr1.data)}`);
    assert(
      doneOr1.data.orchestration.name === "releve-simple" && doneOr1.data.orchestration.steps.length === 1,
      `or1 orchestration incorrecte: ${JSON.stringify(doneOr1.data.orchestration)}`,
    );
    assert(doneOr1.data.raw === raw, `or1 raw doit correspondre exactement au fichier écrit: ${JSON.stringify(doneOr1.data.raw)}`);

    // 2. orch.read erreur : params.path manquant.
    send({ id: "or2", method: "orch.read", params: { cwd: tmpProject } });
    const errOr2 = await waitFor((e) => e.id === "or2" && e.event === "error", 3000, "orch.read or2 (path manquant)");
    assert(typeof errOr2.data.message === "string" && errOr2.data.message.length > 0, "or2 doit renvoyer un message d'erreur");

    // 3. orch.read erreur : garde anti-traversée (chemin hors des répertoires d'orchestrations reconnus).
    const outsideFile = path.join(tmpOutside, "intrus.yaml");
    await fsp.writeFile(outsideFile, "name: intrus\nsteps: []\n", "utf8");
    send({ id: "or3", method: "orch.read", params: { cwd: tmpProject, path: outsideFile } });
    const errOr3 = await waitFor((e) => e.id === "or3" && e.event === "error", 3000, "orch.read or3 (garde anti-traversée)");
    assert(
      errOr3.data.message.includes("hors des répertoires"),
      `or3 doit citer la garde anti-traversée, reçu: ${errOr3.data.message}`,
    );

    // 4. orch.read erreur : YAML invalide.
    const brokenPath = path.join(orchDir, "cassee.yaml");
    await fsp.writeFile(brokenPath, "name: cassee\nsteps: [unclosed\n", "utf8");
    send({ id: "or4", method: "orch.read", params: { cwd: tmpProject, path: brokenPath } });
    const errOr4 = await waitFor((e) => e.id === "or4" && e.event === "error", 3000, "orch.read or4 (YAML invalide)");
    assert(typeof errOr4.data.message === "string" && errOr4.data.message.length > 0, "or4 doit renvoyer un message d'erreur");

    // 5. orch.delete erreur : garde anti-traversée — rien n'est supprimé.
    send({ id: "od1", method: "orch.delete", params: { cwd: tmpProject, path: outsideFile } });
    const errOd1 = await waitFor((e) => e.id === "od1" && e.event === "error", 3000, "orch.delete od1 (garde anti-traversée)");
    assert(typeof errOd1.data.message === "string" && errOd1.data.message.length > 0, "od1 doit renvoyer un message d'erreur");
    const outsideStillThere = await fsp.access(outsideFile).then(() => true).catch(() => false);
    assert(outsideStillThere, "od1 : le fichier hors des répertoires autorisés ne doit pas être supprimé");

    // 6. orch.delete erreur : params.path manquant.
    send({ id: "od2", method: "orch.delete", params: { cwd: tmpProject } });
    const errOd2 = await waitFor((e) => e.id === "od2" && e.event === "error", 3000, "orch.delete od2 (path manquant)");
    assert(typeof errOd2.data.message === "string" && errOd2.data.message.length > 0, "od2 doit renvoyer un message d'erreur");

    // 7. orch.delete nominal : suppression du fichier légitime, disparu du disque ensuite.
    send({ id: "od3", method: "orch.delete", params: { cwd: tmpProject, path: orchPath } });
    const doneOd3 = await waitFor(
      (e) => e.id === "od3" && (e.event === "done" || e.event === "error"),
      3000,
      "orch.delete od3",
    );
    assert(
      doneOd3.event === "done" && doneOd3.data.deleted === true,
      `od3 attendu 'done'/deleted:true, reçu ${JSON.stringify(doneOd3.data)}`,
    );
    const gone = await fsp.access(orchPath).then(() => true).catch(() => false);
    assert(!gone, "od3 : le fichier doit avoir disparu du disque après suppression");

    // 8. orch.delete erreur : fichier déjà supprimé (relance sur le même chemin) -> échec de unlink.
    send({ id: "od4", method: "orch.delete", params: { cwd: tmpProject, path: orchPath } });
    const errOd4 = await waitFor((e) => e.id === "od4" && e.event === "error", 3000, "orch.delete od4 (déjà supprimé)");
    assert(
      errOd4.data.message.includes("suppression impossible"),
      `od4 doit signaler l'échec de la suppression, reçu: ${errOd4.data.message}`,
    );
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr du sidecar (orch.read/orch.delete) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    if (tmpProject) await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
    if (tmpOutside) await fsp.rm(tmpOutside, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * orch.abort — PAR LE VRAI CHEMIN DE DISPATCH (`case "orch.abort"` de
 * index.ts, jamais exercé jusqu'ici : orchestrateurRun.test.js n'appelle que
 * `runtime.handleOrchAbort` directement, en process, sans passer par le
 * protocole JSON Lines). Un run réel (moteur claude fake, fakeClaude.mjs) est
 * lancé, on le laisse geler sur son `permission_request` (jamais répondu),
 * puis on envoie `orch.abort` par le protocole.
 */
async function testOrchAbortSurLeVraiDispatch() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchabort-xdg-"));
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeModule,
      XDG_CONFIG_HOME: xdgDir,
    },
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
      fail(`stdout du sidecar (orch.abort) a émis une ligne non-JSON: ${line}`);
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

  let tmpProject = null;

  try {
    await waitFor((e) => e.event === "ready", 3000, "ready");

    tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchabort-project-"));
    const agentsDir = path.join(tmpProject, ".iaction", "agents");
    const orchDir = path.join(tmpProject, ".iaction", "orchestrations");
    await fsp.mkdir(agentsDir, { recursive: true });
    await fsp.mkdir(orchDir, { recursive: true });

    await fsp.writeFile(
      path.join(agentsDir, "scribe.yaml"),
      "name: scribe\ndescription: Agent de test orch.abort (moteur claude fake).\nengine: claude\npermissionMode: default\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(orchDir, "un-pas.yaml"),
      ["name: un-pas", "description: Une étape (test orch.abort réel).", "steps:", "  - id: x", "    agent: scribe", '    task: "Tache X"', ""].join("\n"),
      "utf8",
    );

    // 1. orch.abort erreur : params.targetId manquant.
    send({ id: "oa-err", method: "orch.abort", params: {} });
    const errOaErr = await waitFor((e) => e.id === "oa-err" && e.event === "error", 3000, "orch.abort (targetId manquant)");
    assert(typeof errOaErr.data.message === "string" && errOaErr.data.message.length > 0, "orch.abort sans targetId doit renvoyer une erreur");

    // 2. orch.abort non-nominal documenté : targetId inconnu -> done{aborted:false} (pas d'erreur).
    send({ id: "oa-inconnu", method: "orch.abort", params: { targetId: "aucun-run-de-ce-nom" } });
    const doneOaInconnu = await waitFor(
      (e) => e.id === "oa-inconnu" && (e.event === "done" || e.event === "error"),
      3000,
      "orch.abort (targetId inconnu)",
    );
    assert(
      doneOaInconnu.event === "done" && doneOaInconnu.data.aborted === false,
      `orch.abort sur un targetId inconnu doit répondre aborted:false, reçu ${JSON.stringify(doneOaInconnu.data ?? doneOaInconnu)}`,
    );

    // 3. orch.abort nominal : run réel lancé, gelé sur son permission_request, puis annulé.
    const runId = "runAbortReel";
    send({ id: runId, method: "orch.run", params: { cwd: tmpProject, name: "un-pas", inputs: {} } });

    await waitFor(
      (e) => e.id === runId && e.event === "chunk" && e.data.kind === "step_started" && e.data.stepId === "x",
      3000,
      "step_started x",
    );
    await waitFor(
      (e) =>
        e.id === runId &&
        e.event === "chunk" &&
        e.data.kind === "step_chunk" &&
        e.data.stepId === "x" &&
        e.data.chunk.kind === "permission_request",
      3000,
      "permission_request x (jamais répondu)",
    );

    send({ id: "oa-reel", method: "orch.abort", params: { targetId: runId } });
    const doneOaReel = await waitFor(
      (e) => e.id === "oa-reel" && (e.event === "done" || e.event === "error"),
      3000,
      "orch.abort (run réel)",
    );
    assert(
      doneOaReel.event === "done" && doneOaReel.data.aborted === true,
      `orch.abort sur le run en cours doit répondre aborted:true, reçu ${JSON.stringify(doneOaReel.data ?? doneOaReel)}`,
    );

    const runDone = await waitFor((e) => e.id === runId && e.event === "done", 3000, "done du run (après abort)");
    assert(
      runDone.data.status === "aborted",
      `le run doit se terminer en 'aborted' après orch.abort, reçu ${JSON.stringify(runDone.data)}`,
    );
    assert(
      runDone.data.steps.x.status === "aborted",
      `l'étape en cours doit être 'aborted', reçu ${JSON.stringify(runDone.data.steps)}`,
    );
    // T-076 — l'étape interrompue n'était pas plus bavarde qu'un statut nu :
    // désormais elle porte un message, comme sa jumelle en échec.
    assert(
      typeof runDone.data.steps.x.message === "string" && runDone.data.steps.x.message.length > 0,
      `l'étape interrompue doit porter un message, reçu ${JSON.stringify(runDone.data.steps)}`,
    );
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr du sidecar (orch.abort) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    if (tmpProject) await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer(
  "orchestrateur — cycle de vie (orch.read, orch.delete, orch.abort)",
  testOrchReadDelete,
  testOrchAbortSurLeVraiDispatch,
);
