/*
 * orchestrateur — ordonnanceur DAG
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/orchestrateurRun.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, entry, fail, fakeClaudeModule, makeEmitterCollector, makeFakeStepRunner, moduleCompile } from "./harness.mjs";

async function testOrchRunFakeStepRunner() {
  const orchestratorModuleUrl = moduleCompile("orchestrator.js");
  const { createOrchestratorRuntime } = await import(orchestratorModuleUrl);

  const tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchrun-project-"));
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchrun-xdg-"));
  const savedXdg = process.env.XDG_CONFIG_HOME;
  // Isole du dossier global réel de la machine (resolveAgentForStep/resolveOrchestrationByName
  // lisent XDG_CONFIG_HOME à chaque appel, comme le reste du module orchestrator.ts).
  process.env.XDG_CONFIG_HOME = xdgDir;

  try {
    const agentsDir = path.join(tmpProject, ".iaction", "agents");
    const orchDir = path.join(tmpProject, ".iaction", "orchestrations");
    await fsp.mkdir(agentsDir, { recursive: true });
    await fsp.mkdir(orchDir, { recursive: true });

    await fsp.writeFile(
      path.join(agentsDir, "worker.yaml"),
      "name: worker\ndescription: Agent de test O3 (stepRunner factice).\nengine: claude\npermissionMode: default\n",
      "utf8",
    );

    await fsp.writeFile(
      path.join(orchDir, "dag-abc.yaml"),
      [
        "name: dag-abc",
        "description: DAG a,b independantes + c needs [a,b] (test O3).",
        "inputs:",
        "  - name: sujet",
        "    label: Sujet",
        "limits:",
        "  maxParallel: 1",
        "steps:",
        "  - id: a",
        "    agent: worker",
        '    task: "Travail A sur {{sujet}}"',
        "  - id: b",
        "    agent: worker",
        '    task: "Travail B sur {{sujet}}"',
        "  - id: c",
        "    agent: worker",
        "    needs: [a, b]",
        '    task: "Combine: {{steps.a.output}} + {{steps.b.output}}"',
        "",
      ].join("\n"),
      "utf8",
    );

    await fsp.writeFile(
      path.join(orchDir, "dag-abort.yaml"),
      [
        "name: dag-abort",
        "description: x puis y (test orch.abort O3).",
        "steps:",
        "  - id: x",
        "    agent: worker",
        '    task: "Tache X"',
        "  - id: y",
        "    agent: worker",
        "    needs: [x]",
        '    task: "Tache Y"',
        "",
      ].join("\n"),
      "utf8",
    );

    // --- Scénario A : parallélisme borné (maxParallel:1) + templating {{steps.<id>.output}} ---
    {
      const fake = makeFakeStepRunner({});
      const runtime = createOrchestratorRuntime({ stepRunner: fake.runner });
      const { emitter, events, waitFor } = makeEmitterCollector();
      const runId = "runA";
      const runPromise = runtime.handleOrchRun(
        runId,
        { cwd: tmpProject, name: "dag-abc", inputs: { sujet: "azur" } },
        emitter,
      );

      const runStarted = await waitFor(
        (e) => e.kind === "chunk" && e.id === runId && e.data.kind === "run_started",
        3000,
        "run_started (scénario A)",
      );
      assert(
        Array.isArray(runStarted.data.steps) && runStarted.data.steps.map((s) => s.stepId).join(",") === "a,b,c",
        `run_started (A) doit lister les étapes dans l'ordre du fichier, reçu ${JSON.stringify(runStarted.data.steps)}`,
      );
      assert(
        runStarted.data.steps.every((s) => s.agent === "worker" && s.engine === "claude"),
        `run_started (A) : agent/engine incorrects, reçu ${JSON.stringify(runStarted.data.steps)}`,
      );

      const doneA = await waitFor((e) => e.kind === "done" && e.id === runId, 5000, "done run A");
      await runPromise;

      assert(doneA.data.status === "success", `run A doit se terminer en 'success', reçu ${JSON.stringify(doneA.data)}`);
      assert(
        doneA.data.steps.a.status === "success" &&
          doneA.data.steps.b.status === "success" &&
          doneA.data.steps.c.status === "success",
        `run A : statuts d'étapes incorrects, reçu ${JSON.stringify(doneA.data.steps)}`,
      );

      assert(
        fake.concurrency.max === 1,
        `scénario A : limits.maxParallel=1 doit borner la concurrence à 1, observé ${fake.concurrency.max}`,
      );
      assert(
        typeof fake.seenPrompts.a === "string" && fake.seenPrompts.a.includes("Travail A sur azur"),
        `scénario A : templating de l'input 'sujet' non appliqué à l'étape a, reçu ${JSON.stringify(fake.seenPrompts.a)}`,
      );
      assert(
        typeof fake.seenPrompts.c === "string" &&
          fake.seenPrompts.c.includes("output-a") &&
          fake.seenPrompts.c.includes("output-b"),
        `scénario A : templating {{steps.a.output}}/{{steps.b.output}} non appliqué à l'étape c, reçu ${JSON.stringify(fake.seenPrompts.c)}`,
      );

      const textChunkA = events.find(
        (e) =>
          e.kind === "chunk" &&
          e.data.kind === "step_chunk" &&
          e.data.stepId === "a" &&
          e.data.chunk &&
          e.data.chunk.kind === "text",
      );
      assert(textChunkA, "scénario A : le step_chunk 'text' de l'étape a doit être relayé tel quel");

      const stepDoneC = events.find((e) => e.kind === "chunk" && e.data.kind === "step_done" && e.data.stepId === "c");
      assert(stepDoneC, "scénario A : step_done manquant pour l'étape c");
    }

    // --- Scénario B : échec de l'étape b -> c sautée (skipped) + status 'partial' ---
    {
      const fake = makeFakeStepRunner({ b: { mode: "fail" } });
      const runtime = createOrchestratorRuntime({ stepRunner: fake.runner });
      const { emitter, events, waitFor } = makeEmitterCollector();
      const runId = "runB";
      const runPromise = runtime.handleOrchRun(
        runId,
        { cwd: tmpProject, name: "dag-abc", inputs: { sujet: "test" } },
        emitter,
      );

      const doneB = await waitFor((e) => e.kind === "done" && e.id === runId, 5000, "done run B");
      await runPromise;

      assert(doneB.data.status === "partial", `run B doit se terminer en 'partial', reçu ${JSON.stringify(doneB.data)}`);
      assert(doneB.data.steps.a.status === "success", `run B : a doit réussir, reçu ${JSON.stringify(doneB.data.steps.a)}`);
      assert(doneB.data.steps.b.status === "failed", `run B : b doit échouer, reçu ${JSON.stringify(doneB.data.steps.b)}`);
      assert(doneB.data.steps.c.status === "skipped", `run B : c doit être sautée, reçu ${JSON.stringify(doneB.data.steps.c)}`);
      assert(
        typeof doneB.data.steps.c.message === "string" && doneB.data.steps.c.message.includes("b"),
        `run B : message de skip de c doit citer 'b', reçu ${JSON.stringify(doneB.data.steps.c)}`,
      );

      const stepFailedB = events.find((e) => e.kind === "chunk" && e.data.kind === "step_failed" && e.data.stepId === "b");
      assert(
        stepFailedB && typeof stepFailedB.data.message === "string" && stepFailedB.data.message.length > 0,
        `run B : step_failed manquant/incorrect pour b, reçu ${JSON.stringify(stepFailedB)}`,
      );
      const stepSkippedC = events.find((e) => e.kind === "chunk" && e.data.kind === "step_skipped" && e.data.stepId === "c");
      assert(
        stepSkippedC && typeof stepSkippedC.data.reason === "string" && stepSkippedC.data.reason.includes("b"),
        `run B : step_skipped manquant/incorrect pour c, reçu ${JSON.stringify(stepSkippedC)}`,
      );
      assert(
        !events.some((e) => e.kind === "chunk" && e.data.kind === "step_started" && e.data.stepId === "c"),
        "run B : c ne doit jamais démarrer (sautée avant tout step_started)",
      );
    }

    // --- Scénario C : orch.abort en cours de route -> étape en cours + étape non démarrée toutes 'aborted' ---
    {
      const fake = makeFakeStepRunner({ x: { mode: "hang" } });
      const runtime = createOrchestratorRuntime({ stepRunner: fake.runner });
      const { emitter, waitFor } = makeEmitterCollector();
      const runId = "runC";
      const runPromise = runtime.handleOrchRun(runId, { cwd: tmpProject, name: "dag-abort", inputs: {} }, emitter);

      await waitFor(
        (e) => e.kind === "chunk" && e.id === runId && e.data.kind === "step_started" && e.data.stepId === "x",
        3000,
        "step_started x (scénario C)",
      );

      const abortCollector = makeEmitterCollector();
      const abortPromise = runtime.handleOrchAbort("abortC", { targetId: runId }, abortCollector.emitter);
      const abortDone = await abortCollector.waitFor(
        (e) => e.kind === "done" && e.id === "abortC",
        3000,
        "done orch.abort (scénario C)",
      );
      await abortPromise;
      assert(abortDone.data.aborted === true, `orch.abort doit répondre aborted:true, reçu ${JSON.stringify(abortDone.data)}`);

      const doneC = await waitFor((e) => e.kind === "done" && e.id === runId, 3000, "done run C (après abort)");
      await runPromise;

      assert(doneC.data.status === "aborted", `run C doit se terminer en 'aborted', reçu ${JSON.stringify(doneC.data)}`);
      assert(
        doneC.data.steps.x.status === "aborted" && doneC.data.steps.y.status === "aborted",
        `run C : x (en cours) et y (jamais démarrée) doivent être 'aborted', reçu ${JSON.stringify(doneC.data.steps)}`,
      );
    }

    // --- Erreurs de résolution : AVANT tout run_started (orchestration inconnue) ---
    {
      const fake = makeFakeStepRunner({});
      const runtime = createOrchestratorRuntime({ stepRunner: fake.runner });
      const { emitter, events, waitFor } = makeEmitterCollector();
      await runtime.handleOrchRun("runUnknown", { cwd: tmpProject, name: "orchestration-inconnue" }, emitter);
      const errUnknown = await waitFor(
        (e) => e.kind === "error" && e.id === "runUnknown",
        2000,
        "error orchestration inconnue",
      );
      assert(
        typeof errUnknown.data.message === "string" && errUnknown.data.message.length > 0,
        "orch.run sur une orchestration inconnue doit renvoyer un message d'erreur",
      );
      assert(
        !events.some((e) => e.kind === "chunk" && e.data.kind === "run_started"),
        "une erreur de résolution ne doit jamais émettre run_started",
      );
    }

    // --- orch.permission sur un targetId/stepId inconnu -> applied:false (pas d'erreur) ---
    {
      const fake = makeFakeStepRunner({});
      const runtime = createOrchestratorRuntime({ stepRunner: fake.runner });
      const permCollector = makeEmitterCollector();
      await runtime.handleOrchPermission(
        "permUnknown",
        { targetId: "no-such-run", stepId: "x", permissionId: "perm-1", decision: "allow" },
        permCollector.emitter,
      );
      const doneUnknownPerm = await permCollector.waitFor(
        (e) => e.kind === "done" && e.id === "permUnknown",
        2000,
        "done orch.permission (targetId inconnu)",
      );
      assert(
        doneUnknownPerm.data.applied === false,
        `orch.permission sur un run inconnu doit répondre applied:false, reçu ${JSON.stringify(doneUnknownPerm.data)}`,
      );
    }
  } finally {
    if (savedXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = savedXdg;
    }
    await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Lot O3 : test d'intégration avec le VRAI moteur Claude fake (IACTION_FAKE_CLAUDE=1,
 * fakeClaude.mjs — voir en tête de fichier). Deux étapes séquentielles (s2 needs [s1]),
 * agent engine "claude" : vérifie orch.run + orch.permission avec les vrais
 * handleClaudeStart/handleClaudePermission comme briques internes, chunks
 * step_chunk relayés tels quels (init/text/tool_use/permission_request/tool_result).
 */
async function testOrchRunRealClaudeEngine() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchrun-real-xdg-"));
  const child5 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeModule,
      XDG_CONFIG_HOME: xdgDir,
    },
  });

  const received5 = [];
  const waiters5 = [];

  function notifyWaiters5(evt) {
    for (let i = waiters5.length - 1; i >= 0; i--) {
      const w = waiters5[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters5.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor5(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received5.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters5.indexOf(w);
        if (idx >= 0) waiters5.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters5.push(w);
    });
  }

  const stdoutRl5 = createInterface({ input: child5.stdout, crlfDelay: Infinity });
  stdoutRl5.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du cinquième sidecar (orch.run réel) a émis une ligne non-JSON: ${line}`);
      return;
    }
    received5.push(parsed);
    notifyWaiters5(parsed);
  });

  const stderrChunks5 = [];
  child5.stderr.on("data", (d) => stderrChunks5.push(d.toString()));

  function send5(obj) {
    child5.stdin.write(JSON.stringify(obj) + "\n");
  }

  let tmpProject = null;

  try {
    await waitFor5((e) => e.event === "ready", 3000, "ready (cinquième sidecar)");

    tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchrun-real-project-"));
    const agentsDir = path.join(tmpProject, ".iaction", "agents");
    const orchDir = path.join(tmpProject, ".iaction", "orchestrations");
    await fsp.mkdir(agentsDir, { recursive: true });
    await fsp.mkdir(orchDir, { recursive: true });

    await fsp.writeFile(
      path.join(agentsDir, "scribe.yaml"),
      "name: scribe\ndescription: Agent de test O3 (moteur claude réel/fake).\nengine: claude\npermissionMode: default\ninstructions: Tu es un agent de test.\n",
      "utf8",
    );

    await fsp.writeFile(
      path.join(orchDir, "deux-etapes.yaml"),
      [
        "name: deux-etapes",
        "description: Deux étapes séquentielles (test O3, moteur claude réel).",
        "inputs:",
        "  - name: sujet",
        "    label: Sujet",
        "steps:",
        "  - id: s1",
        "    agent: scribe",
        '    task: "Premier travail: {{sujet}}"',
        "  - id: s2",
        "    agent: scribe",
        "    needs: [s1]",
        '    task: "Second travail, a partir de: {{steps.s1.output}}"',
        "",
      ].join("\n"),
      "utf8",
    );

    const runId = "run5";
    send5({ id: runId, method: "orch.run", params: { cwd: tmpProject, name: "deux-etapes", inputs: { sujet: "O3" } } });

    const runStarted = await waitFor5(
      (e) => e.id === runId && e.event === "chunk" && e.data.kind === "run_started",
      3000,
      "run_started (moteur claude réel)",
    );
    assert(
      Array.isArray(runStarted.data.steps) && runStarted.data.steps.map((s) => s.stepId).join(",") === "s1,s2",
      `run_started doit lister s1 puis s2, reçu ${JSON.stringify(runStarted.data.steps)}`,
    );
    assert(
      runStarted.data.steps.every((s) => s.agent === "scribe" && s.engine === "claude"),
      `run_started : agent/engine incorrects, reçu ${JSON.stringify(runStarted.data.steps)}`,
    );

    // Un step_chunk 'init' relayé tel quel confirme que handleClaudeStart est bien la brique interne utilisée.
    await waitFor5(
      (e) =>
        e.id === runId &&
        e.event === "chunk" &&
        e.data.kind === "step_chunk" &&
        e.data.stepId === "s1" &&
        e.data.chunk.kind === "init",
      3000,
      "step_chunk init s1",
    );
    await waitFor5(
      (e) =>
        e.id === runId &&
        e.event === "chunk" &&
        e.data.kind === "step_chunk" &&
        e.data.stepId === "s1" &&
        e.data.chunk.kind === "text",
      3000,
      "step_chunk text s1",
    );

    // fakeClaude.mjs demande toujours une permission (outil Bash) avant de conclure : on l'autorise pour s1.
    const permReqS1 = await waitFor5(
      (e) =>
        e.id === runId &&
        e.event === "chunk" &&
        e.data.kind === "step_chunk" &&
        e.data.stepId === "s1" &&
        e.data.chunk.kind === "permission_request",
      3000,
      "permission_request s1",
    );
    send5({
      id: "perm-s1",
      method: "orch.permission",
      params: {
        targetId: runId,
        stepId: "s1",
        permissionId: permReqS1.data.chunk.permissionId,
        decision: "allow",
      },
    });
    const donePermS1 = await waitFor5(
      (e) => e.id === "perm-s1" && (e.event === "done" || e.event === "error"),
      3000,
      "orch.permission s1",
    );
    assert(
      donePermS1.event === "done" && donePermS1.data.applied === true,
      `orch.permission s1 doit répondre applied:true, reçu ${JSON.stringify(donePermS1.data ?? donePermS1)}`,
    );

    const stepDoneS1 = await waitFor5(
      (e) => e.id === runId && e.event === "chunk" && e.data.kind === "step_done" && e.data.stepId === "s1",
      3000,
      "step_done s1",
    );
    assert(
      typeof stepDoneS1.data.output === "string" && stepDoneS1.data.output.includes("Réponse pour:"),
      `step_done s1 doit porter le résultat du faux moteur claude, reçu ${JSON.stringify(stepDoneS1.data)}`,
    );

    // s2 (needs [s1]) démarre ensuite : même cycle permission_request -> allow.
    await waitFor5(
      (e) => e.id === runId && e.event === "chunk" && e.data.kind === "step_started" && e.data.stepId === "s2",
      3000,
      "step_started s2",
    );
    const permReqS2 = await waitFor5(
      (e) =>
        e.id === runId &&
        e.event === "chunk" &&
        e.data.kind === "step_chunk" &&
        e.data.stepId === "s2" &&
        e.data.chunk.kind === "permission_request",
      3000,
      "permission_request s2",
    );
    send5({
      id: "perm-s2",
      method: "orch.permission",
      params: {
        targetId: runId,
        stepId: "s2",
        permissionId: permReqS2.data.chunk.permissionId,
        decision: "allow",
      },
    });
    await waitFor5((e) => e.id === "perm-s2" && (e.event === "done" || e.event === "error"), 3000, "orch.permission s2");

    const runDone = await waitFor5((e) => e.id === runId && e.event === "done", 5000, "done run5");
    assert(
      runDone.data.status === "success",
      `run5 doit se terminer en 'success', reçu ${JSON.stringify(runDone.data)}`,
    );
    assert(
      runDone.data.steps.s1.status === "success" && runDone.data.steps.s2.status === "success",
      `run5 : statuts d'étapes incorrects, reçu ${JSON.stringify(runDone.data.steps)}`,
    );
  } catch (err) {
    if (stderrChunks5.length > 0) {
      console.error("--- stderr du cinquième sidecar (orch.run réel) ---");
      console.error(stderrChunks5.join(""));
    }
    throw err;
  } finally {
    if (child5.exitCode === null) {
      child5.kill();
    }
    if (tmpProject) await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer(
  "orchestrateur — ordonnanceur DAG",
  testOrchRunFakeStepRunner,
  testOrchRunRealClaudeEngine,
);
