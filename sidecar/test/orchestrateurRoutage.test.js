/*
 * orchestrateur — agent en routage auto
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/orchestrateurRoutage.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, entry, fail, fakeClaudeModule } from "./harness.mjs";

/**
 * R2 — spec §5.4 (révisée 2026-07-31 : routage au DÉMARRAGE de chaque étape,
 * sur la tâche RENDUE) : agent YAML `engine: auto` dans une orchestration.
 * Trois étapes portées par le même agent auto :
 * - s1, tâche triviale (« Salut ») → moteur NEUTRE (table poussée : tier
 *   trivial -> faux serveur OpenAI local) ;
 * - s2, tâche d'édition avec code (score moyen) → moteur CLAUDE (défaut du
 *   tier moyen, ici fakeClaude.mjs) ;
 * - s3, template COURT à motif trivial (« Merci de résumer :
 *   {{steps.s1.output}} ») mais dont le RENDU est volumineux (sortie de s1
 *   gonflée par le faux serveur neutre) → tier complexe : preuve que le
 *   routage se fait sur le texte rendu, pas sur le template.
 * `run_started` annonce `engine: "auto", model: null` (cible inconnue au
 * lancement) ; chaque `step_started` porte la cible résolue
 * (`engine`/`model`/`routeTier`). Sous-processus sidecar isolé + mini serveur
 * HTTP neutre, patron testOrchRunRealClaudeEngine.
 */
async function testOrchRunRouterAuto() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchrun-auto-xdg-"));
  const child6 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeModule,
      XDG_CONFIG_HOME: xdgDir,
    },
  });

  const received6 = [];
  const waiters6 = [];

  function notifyWaiters6(evt) {
    for (let i = waiters6.length - 1; i >= 0; i--) {
      const w = waiters6[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters6.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor6(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received6.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters6.indexOf(w);
        if (idx >= 0) waiters6.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters6.push(w);
    });
  }

  const stdoutRl6 = createInterface({ input: child6.stdout, crlfDelay: Infinity });
  stdoutRl6.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du sixième sidecar (orch.run engine auto) a émis une ligne non-JSON: ${line}`);
      return;
    }
    received6.push(parsed);
    notifyWaiters6(parsed);
  });

  const stderrChunks6 = [];
  child6.stderr.on("data", (d) => stderrChunks6.push(d.toString()));

  function send6(obj) {
    child6.stdin.write(JSON.stringify(obj) + "\n");
  }

  // Sortie VOLUMINEUSE de s1 (> 1500 caractères + bloc de code) : une fois
  // interpolée dans le template court de s3, elle doit pousser la
  // classification heuristique au tier `complexe` (longueur +5, code +2).
  const grosPayloadS1 = `Journal brut de l'étape amont : ${"données ".repeat(250)}\n\`\`\`\nlog interne\n\`\`\``;

  // Mini serveur OpenAI-compatible pour le moteur neutre routé : une réponse
  // texte finale (finish_reason "stop"), body capturé pour vérifier le modèle.
  let neutralAutoBody = null;
  const miniServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let bodyJson = null;
      try {
        bodyJson = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        bodyJson = null;
      }
      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        neutralAutoBody = bodyJson;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Sortie neutre\n" }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: grosPayloadS1 }, finish_reason: null }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "route inconnue" }));
    });
  });
  await new Promise((resolve) => miniServer.listen(0, "127.0.0.1", resolve));
  const miniBase = `http://127.0.0.1:${miniServer.address().port}`;

  let tmpProject = null;

  try {
    await waitFor6((e) => e.event === "ready", 3000, "ready (sixième sidecar)");

    // Fournisseur neutre + table de routage : tier trivial -> neutre local ;
    // classificateur désactivé (test purement heuristique, aucun délai).
    send6({
      id: "ps-auto",
      method: "providers.set",
      params: { providers: [{ id: "neutre-auto", label: "Neutre auto", baseUrl: `${miniBase}/v1` }] },
    });
    await waitFor6((e) => e.id === "ps-auto" && e.event === "done", 3000, "providers.set ps-auto");
    send6({
      id: "rs-auto",
      method: "router.set",
      params: {
        table: { trivial: { engine: "neutral", providerId: "neutre-auto", model: "petit-local" } },
        classifier: null,
      },
    });
    await waitFor6((e) => e.id === "rs-auto" && e.event === "done", 3000, "router.set rs-auto");

    tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orchrun-auto-project-"));
    const agentsDir = path.join(tmpProject, ".iaction", "agents");
    const orchDir = path.join(tmpProject, ".iaction", "orchestrations");
    await fsp.mkdir(agentsDir, { recursive: true });
    await fsp.mkdir(orchDir, { recursive: true });

    await fsp.writeFile(
      path.join(agentsDir, "auto-scribe.yaml"),
      "name: auto-scribe\ndescription: Agent de test R2 (engine auto).\nengine: auto\nmodel: auto\ninstructions: Tu es un agent de test.\n",
      "utf8",
    );

    await fsp.writeFile(
      path.join(orchDir, "deux-tiers.yaml"),
      [
        "name: deux-tiers",
        "description: Étapes routées par le routeur au démarrage, sur la tâche rendue (test R2).",
        "steps:",
        "  - id: s1",
        "    agent: auto-scribe",
        '    task: "Salut"',
        "  - id: s2",
        "    agent: auto-scribe",
        "    task: \"Implémente la fonction `demo()` dans le module `src/x.ts`\"",
        // s3 : template COURT à motif trivial (« merci ») — seul, il serait
        // classé `trivial` ; le RENDU (sortie volumineuse de s1 interpolée)
        // doit être classé `complexe`.
        "  - id: s3",
        "    agent: auto-scribe",
        "    needs: [s1]",
        '    task: "Merci de résumer : {{steps.s1.output}}"',
        "",
      ].join("\n"),
      "utf8",
    );

    const runId = "run6";
    send6({ id: runId, method: "orch.run", params: { cwd: tmpProject, name: "deux-tiers" } });

    // run_started : la cible n'est PLUS connue au lancement (routage au
    // démarrage de chaque étape) — toutes les étapes auto sont annoncées
    // `engine: "auto", model: null`.
    const runStarted = await waitFor6(
      (e) => e.id === runId && e.event === "chunk" && e.data.kind === "run_started",
      3000,
      "run_started (engine auto)",
    );
    const stepsById = Object.fromEntries((runStarted.data.steps || []).map((s) => [s.stepId, s]));
    for (const sid of ["s1", "s2", "s3"]) {
      assert(
        stepsById[sid] && stepsById[sid].engine === "auto" && stepsById[sid].model === null,
        `run_started ${sid} : engine "auto" et model null attendus (cible inconnue au lancement), reçu ${JSON.stringify(runStarted.data.steps)}`,
      );
    }

    // step_started : chaque étape porte sa cible résolue au démarrage —
    // s1 (« Salut », trivial) -> neutre/petit-local ; s2 (édition + code,
    // score 5 = moyen) -> claude/claude-opus-4-8 (défaut du tier moyen).
    const stepStartedS1 = await waitFor6(
      (e) => e.id === runId && e.event === "chunk" && e.data.kind === "step_started" && e.data.stepId === "s1",
      3000,
      "step_started s1 (engine auto)",
    );
    assert(
      stepStartedS1.data.engine === "neutral" &&
        stepStartedS1.data.model === "petit-local" &&
        stepStartedS1.data.routeTier === "trivial",
      `step_started s1 : cible neutre routée (tier trivial) attendue, reçu ${JSON.stringify(stepStartedS1.data)}`,
    );
    const stepStartedS2 = await waitFor6(
      (e) => e.id === runId && e.event === "chunk" && e.data.kind === "step_started" && e.data.stepId === "s2",
      3000,
      "step_started s2 (engine auto)",
    );
    assert(
      stepStartedS2.data.engine === "claude" &&
        stepStartedS2.data.model === "claude-opus-4-8" &&
        stepStartedS2.data.routeTier === "moyen",
      `step_started s2 : cible claude routée (tier moyen) attendue, reçu ${JSON.stringify(stepStartedS2.data)}`,
    );

    // s2 (moteur claude, fakeClaude.mjs) demande toujours une permission Bash.
    const permReqS2 = await waitFor6(
      (e) =>
        e.id === runId &&
        e.event === "chunk" &&
        e.data.kind === "step_chunk" &&
        e.data.stepId === "s2" &&
        e.data.chunk.kind === "permission_request",
      3000,
      "permission_request s2 (engine auto)",
    );
    send6({
      id: "perm-auto-s2",
      method: "orch.permission",
      params: { targetId: runId, stepId: "s2", permissionId: permReqS2.data.chunk.permissionId, decision: "allow" },
    });
    await waitFor6(
      (e) => e.id === "perm-auto-s2" && (e.event === "done" || e.event === "error"),
      3000,
      "orch.permission perm-auto-s2",
    );

    // s3 démarre après s1 : son template court aurait donné `trivial` (motif
    // « merci ») mais le RENDU volumineux (sortie de s1) doit donner
    // `complexe` -> claude/claude-fable-5 (défaut du tier complexe) — LA
    // preuve que le routage se fait au démarrage, sur le texte rendu.
    const stepStartedS3 = await waitFor6(
      (e) => e.id === runId && e.event === "chunk" && e.data.kind === "step_started" && e.data.stepId === "s3",
      5000,
      "step_started s3 (engine auto, tâche rendue)",
    );
    assert(
      stepStartedS3.data.engine === "claude" &&
        stepStartedS3.data.model === "claude-fable-5" &&
        stepStartedS3.data.routeTier === "complexe",
      `step_started s3 : cible claude routée (tier complexe, texte rendu) attendue, reçu ${JSON.stringify(stepStartedS3.data)}`,
    );

    // s3 (moteur claude routé, fakeClaude.mjs) demande aussi une permission Bash.
    const permReqS3 = await waitFor6(
      (e) =>
        e.id === runId &&
        e.event === "chunk" &&
        e.data.kind === "step_chunk" &&
        e.data.stepId === "s3" &&
        e.data.chunk.kind === "permission_request",
      3000,
      "permission_request s3 (engine auto)",
    );
    send6({
      id: "perm-auto-s3",
      method: "orch.permission",
      params: { targetId: runId, stepId: "s3", permissionId: permReqS3.data.chunk.permissionId, decision: "allow" },
    });
    await waitFor6(
      (e) => e.id === "perm-auto-s3" && (e.event === "done" || e.event === "error"),
      3000,
      "orch.permission perm-auto-s3",
    );

    const runDone = await waitFor6((e) => e.id === runId && e.event === "done", 8000, "done run6");
    assert(
      runDone.data.status === "success",
      `run6 doit se terminer en 'success', reçu ${JSON.stringify(runDone.data)}`,
    );
    assert(
      runDone.data.steps.s1.status === "success" &&
        typeof runDone.data.steps.s1.output === "string" &&
        runDone.data.steps.s1.output.includes("Sortie neutre"),
      `run6 s1 : sortie du faux moteur neutre attendue, reçu ${JSON.stringify(runDone.data.steps)}`,
    );
    assert(
      runDone.data.steps.s2.status === "success" &&
        typeof runDone.data.steps.s2.output === "string" &&
        runDone.data.steps.s2.output.includes("Réponse pour:"),
      `run6 s2 : sortie du faux moteur claude attendue, reçu ${JSON.stringify(runDone.data.steps)}`,
    );
    // s3 : le faux moteur claude renvoie le prompt reçu — il doit contenir la
    // tâche RENDUE (template interpolé avec la sortie volumineuse de s1).
    assert(
      runDone.data.steps.s3.status === "success" &&
        typeof runDone.data.steps.s3.output === "string" &&
        runDone.data.steps.s3.output.includes("Réponse pour:") &&
        runDone.data.steps.s3.output.includes("Merci de résumer") &&
        runDone.data.steps.s3.output.includes("Journal brut de l'étape amont"),
      `run6 s3 : sortie claude sur la tâche rendue attendue, reçu ${JSON.stringify(runDone.data.steps.s3 && runDone.data.steps.s3.status)}`,
    );
    // Le faux serveur neutre a bien reçu le MODÈLE routé.
    assert(
      neutralAutoBody && neutralAutoBody.model === "petit-local",
      `le faux serveur neutre doit recevoir model "petit-local", reçu ${JSON.stringify(neutralAutoBody && neutralAutoBody.model)}`,
    );
  } catch (err) {
    if (stderrChunks6.length > 0) {
      console.error("--- stderr du sixième sidecar (orch.run engine auto) ---");
      console.error(stderrChunks6.join(""));
    }
    throw err;
  } finally {
    if (child6.exitCode === null) {
      child6.kill();
    }
    await new Promise((resolve) => miniServer.close(resolve));
    if (tmpProject) await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer(
  "orchestrateur — agent en routage auto",
  testOrchRunRouterAuto,
);
