/*
 * orchestrateur — CRUD
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/orchestrateur.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, entry, fail, fakeClaudeModule } from "./harness.mjs";

/**
 * Lot O1 : CRUD des agents et orchestrations YAML (sidecar/src/orchestrator.ts).
 * Sous-processus sidecar isolé (comme testUsageClaudeWithFakeSdk/testClaudeMcpConfig
 * ci-dessus) : le scope "global" doit lire XDG_CONFIG_HOME, injecté ici via l'env
 * du spawn — vérifie que le code lit bien cette variable plutôt que de la mettre
 * en cache au chargement du module.
 */
async function testOrchestratorCrud() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-xdg-"));
  const child4 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeModule,
      XDG_CONFIG_HOME: xdgDir,
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
      fail(`stdout du quatrième sidecar (orchestrator) a émis une ligne non-JSON: ${line}`);
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

  let tmpProject = null;
  let tmpOutside = null;

  try {
    await waitFor4((e) => e.event === "ready", 3000, "ready (quatrième sidecar)");

    tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orch-project-"));
    tmpOutside = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-orch-outside-"));

    // 1. agents.write (forme agent) -> agents.list le voit avec les bons défauts.
    send4({
      id: "aw1",
      method: "agents.write",
      params: {
        cwd: tmpProject,
        scope: "project",
        agent: { name: "relecteur-rust", description: "Relit les diffs Rust." },
      },
    });
    const doneAw1 = await waitFor4(
      (e) => e.id === "aw1" && (e.event === "done" || e.event === "error"),
      3000,
      "agents.write aw1",
    );
    assert(
      doneAw1.event === "done",
      `agents.write aw1 attendu 'done', reçu '${doneAw1.event}': ${JSON.stringify(doneAw1.data)}`,
    );
    assert(doneAw1.data.agent.name === "relecteur-rust", `aw1 agent.name incorrect: ${JSON.stringify(doneAw1.data.agent)}`);
    assert(
      doneAw1.data.agent.engine === "claude" &&
        doneAw1.data.agent.provider === null &&
        doneAw1.data.agent.model === null &&
        doneAw1.data.agent.permissionMode === "default" &&
        doneAw1.data.agent.instructions === "" &&
        doneAw1.data.agent.tools === null &&
        doneAw1.data.agent.mcp === true &&
        Array.isArray(doneAw1.data.agent.knowledge) &&
        doneAw1.data.agent.knowledge.length === 0 &&
        doneAw1.data.agent.maxTurns === null,
      `aw1 défauts de l'agent incorrects: ${JSON.stringify(doneAw1.data.agent)}`,
    );
    const aw1Path = doneAw1.data.path;

    send4({ id: "al1", method: "agents.list", params: { cwd: tmpProject } });
    const doneAl1 = await waitFor4(
      (e) => e.id === "al1" && (e.event === "done" || e.event === "error"),
      3000,
      "agents.list al1",
    );
    assert(
      doneAl1.event === "done",
      `agents.list al1 attendu 'done', reçu '${doneAl1.event}': ${JSON.stringify(doneAl1.data)}`,
    );
    const foundAw1 = doneAl1.data.agents.find((a) => a.name === "relecteur-rust");
    assert(foundAw1, `agents.list al1 doit contenir 'relecteur-rust', reçu ${JSON.stringify(doneAl1.data.agents)}`);
    assert(
      foundAw1.scope === "project" && foundAw1.readOnly === false && foundAw1.path === aw1Path,
      `al1 métadonnées de 'relecteur-rust' incorrectes: ${JSON.stringify(foundAw1)}`,
    );

    // 2. write raw avec commentaire -> read restitue le raw exact (préserve les commentaires).
    const rawWithComment =
      "# Commentaire utilisateur à préserver\nname: commented-agent\ndescription: Agent de test avec commentaire\n";
    send4({
      id: "aw2",
      method: "agents.write",
      params: { cwd: tmpProject, scope: "project", raw: rawWithComment },
    });
    const doneAw2 = await waitFor4(
      (e) => e.id === "aw2" && (e.event === "done" || e.event === "error"),
      3000,
      "agents.write aw2 (raw)",
    );
    assert(
      doneAw2.event === "done",
      `agents.write aw2 (raw) attendu 'done', reçu '${doneAw2.event}': ${JSON.stringify(doneAw2.data)}`,
    );
    send4({ id: "ar2", method: "agents.read", params: { cwd: tmpProject, path: doneAw2.data.path } });
    const doneAr2 = await waitFor4(
      (e) => e.id === "ar2" && (e.event === "done" || e.event === "error"),
      3000,
      "agents.read ar2",
    );
    assert(
      doneAr2.event === "done",
      `agents.read ar2 attendu 'done', reçu '${doneAr2.event}': ${JSON.stringify(doneAr2.data)}`,
    );
    assert(
      doneAr2.data.raw === rawWithComment,
      `ar2: raw ne correspond pas exactement au contenu écrit (commentaire perdu ?): ${JSON.stringify(doneAr2.data.raw)}`,
    );
    assert(doneAr2.data.agent.name === "commented-agent", `ar2 agent.name incorrect: ${JSON.stringify(doneAr2.data.agent)}`);

    // 3. YAML invalide dans le dossier -> entrée `invalid` listée (jamais omise).
    const brokenPath = path.join(tmpProject, ".iaction", "agents", "broken.yaml");
    await fsp.writeFile(brokenPath, "name: broken\ndescription: [unclosed\n", "utf8");
    send4({ id: "al3", method: "agents.list", params: { cwd: tmpProject } });
    const doneAl3 = await waitFor4(
      (e) => e.id === "al3" && (e.event === "done" || e.event === "error"),
      3000,
      "agents.list al3",
    );
    assert(doneAl3.event === "done", `agents.list al3 attendu 'done', reçu '${doneAl3.event}'`);
    const foundBroken = doneAl3.data.agents.find((a) => a.name === "broken");
    assert(
      foundBroken,
      `agents.list al3 doit contenir l'entrée 'broken', reçu ${JSON.stringify(doneAl3.data.agents.map((a) => a.name))}`,
    );
    assert(
      typeof foundBroken.invalid === "string" && foundBroken.invalid.length > 0,
      `al3 'broken' doit porter un champ 'invalid' non vide, reçu ${JSON.stringify(foundBroken)}`,
    );

    // 4. import .claude/agents/*.md (frontmatter + corps) -> readOnly.
    const claudeAgentsDirPath = path.join(tmpProject, ".claude", "agents");
    await fsp.mkdir(claudeAgentsDirPath, { recursive: true });
    await fsp.writeFile(
      path.join(claudeAgentsDirPath, "reviewer.md"),
      "---\nname: reviewer\ndescription: Relit le code.\ntools: Read, Grep\n---\nTu es un relecteur attentif.\n",
      "utf8",
    );
    send4({ id: "al4", method: "agents.list", params: { cwd: tmpProject } });
    const doneAl4 = await waitFor4(
      (e) => e.id === "al4" && (e.event === "done" || e.event === "error"),
      3000,
      "agents.list al4",
    );
    const foundImported = doneAl4.data.agents.find((a) => a.name === "reviewer");
    assert(
      foundImported,
      `agents.list al4 doit contenir l'agent importé 'reviewer', reçu ${JSON.stringify(doneAl4.data.agents.map((a) => a.name))}`,
    );
    assert(
      foundImported.scope === "claude-code" && foundImported.readOnly === true && foundImported.engine === "claude",
      `al4 métadonnées d'import de 'reviewer' incorrectes: ${JSON.stringify(foundImported)}`,
    );
    assert(
      Array.isArray(foundImported.tools) && foundImported.tools.join(",") === "Read,Grep",
      `al4 reviewer.tools incorrect: ${JSON.stringify(foundImported.tools)}`,
    );
    assert(
      foundImported.instructions === "Tu es un relecteur attentif.",
      `al4 reviewer.instructions incorrect: ${JSON.stringify(foundImported.instructions)}`,
    );

    // 5. Validation refusée : name invalide, engine neutral sans provider, permissionMode plan + neutral.
    send4({
      id: "av1",
      method: "agents.write",
      params: { cwd: tmpProject, scope: "project", agent: { name: "Bad Name!" } },
    });
    const errAv1 = await waitFor4((e) => e.id === "av1" && e.event === "error", 3000, "agents.write av1 (name invalide)");
    assert(typeof errAv1.data.message === "string" && errAv1.data.message.length > 0, "av1 doit renvoyer un message d'erreur");

    send4({
      id: "av2",
      method: "agents.write",
      params: { cwd: tmpProject, scope: "project", agent: { name: "neutre-sans-provider", engine: "neutral" } },
    });
    const errAv2 = await waitFor4(
      (e) => e.id === "av2" && e.event === "error",
      3000,
      "agents.write av2 (neutral sans provider)",
    );
    assert(typeof errAv2.data.message === "string" && errAv2.data.message.length > 0, "av2 doit renvoyer un message d'erreur");

    send4({
      id: "av3",
      method: "agents.write",
      params: {
        cwd: tmpProject,
        scope: "project",
        agent: { name: "neutre-plan", engine: "neutral", provider: "ollama", permissionMode: "plan" },
      },
    });
    const errAv3 = await waitFor4(
      (e) => e.id === "av3" && e.event === "error",
      3000,
      "agents.write av3 (plan + neutral)",
    );
    assert(typeof errAv3.data.message === "string" && errAv3.data.message.length > 0, "av3 doit renvoyer un message d'erreur");

    // 6. orch.write valide -> orch.list le voit.
    send4({
      id: "ow1",
      method: "orch.write",
      params: {
        cwd: tmpProject,
        scope: "project",
        orchestration: {
          name: "revue-complete",
          description: "Relecture puis synthèse.",
          steps: [
            { id: "relecture", agent: "relecteur-rust", task: "Relis le code." },
            { id: "synthese", agent: "relecteur-rust", task: "Synthétise.", needs: ["relecture"] },
          ],
        },
      },
    });
    const doneOw1 = await waitFor4(
      (e) => e.id === "ow1" && (e.event === "done" || e.event === "error"),
      3000,
      "orch.write ow1",
    );
    assert(
      doneOw1.event === "done",
      `orch.write ow1 attendu 'done', reçu '${doneOw1.event}': ${JSON.stringify(doneOw1.data)}`,
    );
    assert(
      doneOw1.data.orchestration.limits &&
        doneOw1.data.orchestration.limits.maxParallel === 2 &&
        doneOw1.data.orchestration.limits.maxDurationMin === 30,
      `ow1 limits par défaut incorrects: ${JSON.stringify(doneOw1.data.orchestration.limits)}`,
    );

    send4({ id: "ol1", method: "orch.list", params: { cwd: tmpProject } });
    const doneOl1 = await waitFor4(
      (e) => e.id === "ol1" && (e.event === "done" || e.event === "error"),
      3000,
      "orch.list ol1",
    );
    const foundOrch = doneOl1.data.orchestrations.find((o) => o.name === "revue-complete");
    assert(foundOrch, `orch.list ol1 doit contenir 'revue-complete', reçu ${JSON.stringify(doneOl1.data.orchestrations)}`);
    assert(foundOrch.steps.length === 2, `ol1 'revue-complete' doit avoir 2 étapes, reçu ${JSON.stringify(foundOrch.steps)}`);

    // 7. cycle dans needs -> error citant le cycle trouvé.
    send4({
      id: "ow2",
      method: "orch.write",
      params: {
        cwd: tmpProject,
        scope: "project",
        orchestration: {
          name: "cycle-test",
          steps: [
            { id: "a", agent: "x", task: "t", needs: ["b"] },
            { id: "b", agent: "x", task: "t", needs: ["a"] },
          ],
        },
      },
    });
    const errOw2 = await waitFor4((e) => e.id === "ow2" && e.event === "error", 3000, "orch.write ow2 (cycle)");
    assert(
      errOw2.data.message.includes("cycle") && errOw2.data.message.includes("a") && errOw2.data.message.includes("b"),
      `ow2 message d'erreur doit citer le cycle trouvé: ${errOw2.data.message}`,
    );

    // 8. needs référence un id inconnu -> error.
    send4({
      id: "ow3",
      method: "orch.write",
      params: {
        cwd: tmpProject,
        scope: "project",
        orchestration: {
          name: "needs-inconnu",
          steps: [{ id: "a", agent: "x", task: "t", needs: ["n-existe-pas"] }],
        },
      },
    });
    const errOw3 = await waitFor4((e) => e.id === "ow3" && e.event === "error", 3000, "orch.write ow3 (needs inconnu)");
    assert(typeof errOw3.data.message === "string" && errOw3.data.message.length > 0, "ow3 doit renvoyer un message d'erreur");

    // 9. delete + garde anti-traversée (chemin hors dossier -> error, rien supprimé).
    const outsideFile = path.join(tmpOutside, "not-an-agent.yaml");
    await fsp.writeFile(outsideFile, "name: intrus\n", "utf8");
    send4({ id: "ad1", method: "agents.delete", params: { cwd: tmpProject, path: outsideFile } });
    const errAd1 = await waitFor4(
      (e) => e.id === "ad1" && e.event === "error",
      3000,
      "agents.delete ad1 (garde anti-traversée)",
    );
    assert(typeof errAd1.data.message === "string" && errAd1.data.message.length > 0, "ad1 doit renvoyer un message d'erreur");
    const stillExists = await fsp
      .access(outsideFile)
      .then(() => true)
      .catch(() => false);
    assert(stillExists, "ad1: le fichier hors des répertoires autorisés ne doit pas être supprimé");

    send4({ id: "ad2", method: "agents.delete", params: { cwd: tmpProject, path: aw1Path } });
    const doneAd2 = await waitFor4(
      (e) => e.id === "ad2" && (e.event === "done" || e.event === "error"),
      3000,
      "agents.delete ad2",
    );
    assert(
      doneAd2.event === "done" && doneAd2.data.deleted === true,
      `ad2 attendu 'done'/deleted:true, reçu ${JSON.stringify(doneAd2.data)}`,
    );
    const deletedGone = await fsp
      .access(aw1Path)
      .then(() => true)
      .catch(() => false);
    assert(!deletedGone, "ad2: le fichier doit avoir disparu du disque après suppression");

    // 10. scope global : utilise le XDG_CONFIG_HOME temporaire injecté au spawn de ce sidecar.
    send4({
      id: "aw-g",
      method: "agents.write",
      params: { cwd: null, scope: "global", agent: { name: "agent-global" } },
    });
    const doneAwG = await waitFor4(
      (e) => e.id === "aw-g" && (e.event === "done" || e.event === "error"),
      3000,
      "agents.write aw-g (global)",
    );
    assert(
      doneAwG.event === "done",
      `aw-g attendu 'done', reçu '${doneAwG.event}': ${JSON.stringify(doneAwG.data)}`,
    );
    const expectedGlobalPath = path.join(xdgDir, "net.duvam.iaction", "agents", "agent-global.yaml");
    assert(
      path.resolve(doneAwG.data.path) === path.resolve(expectedGlobalPath),
      `aw-g doit écrire sous le XDG_CONFIG_HOME injecté, attendu ${expectedGlobalPath}, reçu ${doneAwG.data.path}`,
    );

    send4({ id: "al-g", method: "agents.list", params: { cwd: null } });
    const doneAlG = await waitFor4(
      (e) => e.id === "al-g" && (e.event === "done" || e.event === "error"),
      3000,
      "agents.list al-g (global)",
    );
    const foundGlobal = doneAlG.data.agents.find((a) => a.name === "agent-global");
    assert(
      foundGlobal && foundGlobal.scope === "global" && foundGlobal.readOnly === false,
      `al-g doit contenir 'agent-global' en scope global, reçu ${JSON.stringify(foundGlobal)}`,
    );
  } catch (err) {
    if (stderrChunks4.length > 0) {
      console.error("--- stderr du quatrième sidecar (orchestrator) ---");
      console.error(stderrChunks4.join(""));
    }
    throw err;
  } finally {
    if (child4.exitCode === null) {
      child4.kill();
    }
    if (tmpProject) await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
    if (tmpOutside) await fsp.rm(tmpOutside, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer(
  "orchestrateur — CRUD",
  testOrchestratorCrud,
);
