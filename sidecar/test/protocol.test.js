// Test d'intégration en JS pur (pas de framework) pour le sidecar Lot 0.
// Spawn dist/index.js, parle le protocole JSON Lines via stdin/stdout,
// et vérifie le contrat décrit dans docs/protocol.md.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "..", "dist", "index.js");

// Lot 8, tranche 1 (usageStats.ts) : chaque tour chat.send/claude.start/
// neutral.start terminé écrit maintenant un événement JSONL sous
// XDG_CONFIG_HOME/net.duvam.iaction/usage/. La plupart des spawns de ce
// fichier construisent leur env avec `...process.env` SANS redéfinir
// XDG_CONFIG_HOME : sans un défaut jetable ici, ils écriraient dans le
// ~/.config réel de la machine qui lance `npm test`. Les blocs qui ont
// besoin d'un XDG_CONFIG_HOME dédié (CRUD O1/O3) le redéfinissent
// explicitement après le spread, ce qui prime sur ce défaut.
const defaultXdgConfigHome = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-xdg-"));
process.env.XDG_CONFIG_HOME = defaultXdgConfigHome;

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

const fakeClaudeModule = path.join(__dirname, "fakeClaude.mjs");
const fakeClaudeWithUsageModule = path.join(__dirname, "fakeClaudeWithUsage.mjs");
const fakeClaudeMcpModule = path.join(__dirname, "fakeClaudeMcp.mjs");

/**
 * usage.claude, cas (fake AVEC usage_EXPERIMENTAL...) : nécessite un second
 * sous-processus sidecar (le premier tourne avec fakeClaude.mjs, qui doit
 * rester SANS cette méthode pour couvrir le cas contraire). Isolé dans sa
 * propre fonction, avec son propre spawn/kill, pour ne pas polluer l'état
 * du child principal.
 */
async function testUsageClaudeWithFakeSdk() {
  const child2 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeWithUsageModule,
    },
  });

  const received2 = [];
  const waiters2 = [];

  function notifyWaiters2(evt) {
    for (let i = waiters2.length - 1; i >= 0; i--) {
      const w = waiters2[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters2.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor2(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received2.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters2.indexOf(w);
        if (idx >= 0) waiters2.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters2.push(w);
    });
  }

  const stdoutRl2 = createInterface({ input: child2.stdout, crlfDelay: Infinity });
  stdoutRl2.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du second sidecar (fakeClaudeWithUsage) a émis une ligne non-JSON: ${line}`);
      return;
    }
    received2.push(parsed);
    notifyWaiters2(parsed);
  });

  const stderrChunks2 = [];
  child2.stderr.on("data", (d) => stderrChunks2.push(d.toString()));

  function send2(obj) {
    child2.stdin.write(JSON.stringify(obj) + "\n");
  }

  try {
    await waitFor2((e) => e.event === "ready", 3000, "ready (second sidecar)");

    send2({ id: "cl-usage", method: "claude.start", params: { cwd: "/tmp", prompt: "usage check" } });
    const doneClUsage = await waitFor2(
      (e) => e.id === "cl-usage" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start cl-usage done",
    );
    assert(
      doneClUsage.event === "done",
      `cl-usage attendu 'done', reçu '${doneClUsage.event}': ${JSON.stringify(doneClUsage.data)}`,
    );

    send2({ id: "uc3", method: "usage.claude", params: {} });
    const doneUc3 = await waitFor2((e) => e.id === "uc3" && e.event === "done", 3000, "usage.claude uc3");
    assert(
      doneUc3.data.available === true,
      `usage.claude uc3 doit répondre available:true, reçu ${JSON.stringify(doneUc3.data)}`,
    );
    assert(
      doneUc3.data.subscriptionType === "max",
      `usage.claude uc3 subscriptionType incorrect: ${JSON.stringify(doneUc3.data)}`,
    );
    assert(
      doneUc3.data.fiveHour &&
        doneUc3.data.fiveHour.utilization === 42 &&
        doneUc3.data.fiveHour.resetsAt === "2026-07-19T18:00:00Z",
      `usage.claude uc3 fiveHour incorrect: ${JSON.stringify(doneUc3.data.fiveHour)}`,
    );
    assert(
      doneUc3.data.sevenDay &&
        doneUc3.data.sevenDay.utilization === 13 &&
        doneUc3.data.sevenDay.resetsAt === "2026-07-25T00:00:00Z",
      `usage.claude uc3 sevenDay incorrect: ${JSON.stringify(doneUc3.data.sevenDay)}`,
    );
    assert(
      typeof doneUc3.data.capturedAt === "string" && doneUc3.data.capturedAt.length > 0,
      `usage.claude uc3 capturedAt doit être une chaîne ISO non vide, reçu ${JSON.stringify(doneUc3.data.capturedAt)}`,
    );
    // Relais générique de TOUTES les fenêtres (dont celles spécifiques à un
    // modèle, au nommage non garanti par l'API expérimentale).
    assert(
      doneUc3.data.windows &&
        doneUc3.data.windows.five_hour?.utilization === 42 &&
        doneUc3.data.windows.seven_day?.utilization === 13 &&
        doneUc3.data.windows.seven_day_opus?.utilization === 7 &&
        doneUc3.data.windows.seven_day_opus?.resetsAt === "2026-07-25T00:00:00Z",
      `usage.claude uc3 windows incorrect: ${JSON.stringify(doneUc3.data.windows)}`,
    );

    // usage.claude.init : micro-tour d'initialisation → même forme de done
    // que usage.claude, sans claude.start préalable nécessaire (le fake
    // répond à la capture post-tour, filet des SDK hors transport processus).
    send2({ id: "uci", method: "usage.claude.init", params: {} });
    const doneUci = await waitFor2(
      (e) => e.id === "uci" && (e.event === "done" || e.event === "error"),
      3000,
      "usage.claude.init uci",
    );
    assert(
      doneUci.event === "done" && doneUci.data.available === true,
      `usage.claude.init doit répondre done/available:true, reçu ${doneUci.event}: ${JSON.stringify(doneUci.data)}`,
    );
    assert(
      doneUci.data.windows?.five_hour?.utilization === 42,
      `usage.claude.init windows incorrect: ${JSON.stringify(doneUci.data.windows)}`,
    );
  } catch (err) {
    if (stderrChunks2.length > 0) {
      console.error("--- stderr du second sidecar (fakeClaudeWithUsage) ---");
      console.error(stderrChunks2.join(""));
    }
    throw err;
  } finally {
    if (child2.exitCode === null) {
      child2.kill();
    }
  }
}

/**
 * claude.release + plafond d'attente des tâches de fond (docs/protocol.md,
 * § claude.release) : sous-processus sidecar dédié (fakeClaudeBackground.mjs,
 * dont le rapport de tâche de fond ne vient jamais), avec un plafond court
 * (IACTION_BACKGROUND_WAIT_TIMEOUT_MS=1500) pour tester la clôture auto.
 */
async function testClaudeBackgroundRelease() {
  const fakeClaudeBackgroundModule = path.join(__dirname, "fakeClaudeBackground.mjs");
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
 * Support MCP v1 de claude.start (docs/protocol.md, claude.start § MCP) :
 * lecture de <cwd>/.mcp.json. Isolé dans son propre sous-processus sidecar
 * (fakeClaudeMcp.mjs, qui rapporte ce que valait `options.mcpServers` au
 * moment de l'appel à queryFn via le champ `result` du message "result" —
 * seule façon d'observer les Options depuis ce process de test) et ses
 * propres répertoires temporaires (mkdtemp) pour cwd.
 */
async function testClaudeMcpConfig() {
  const child3 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeMcpModule,
    },
  });

  const received3 = [];
  const waiters3 = [];

  function notifyWaiters3(evt) {
    for (let i = waiters3.length - 1; i >= 0; i--) {
      const w = waiters3[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters3.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor3(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received3.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters3.indexOf(w);
        if (idx >= 0) waiters3.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters3.push(w);
    });
  }

  const stdoutRl3 = createInterface({ input: child3.stdout, crlfDelay: Infinity });
  stdoutRl3.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du troisième sidecar (fakeClaudeMcp) a émis une ligne non-JSON: ${line}`);
      return;
    }
    received3.push(parsed);
    notifyWaiters3(parsed);
  });

  const stderrChunks3 = [];
  child3.stderr.on("data", (d) => stderrChunks3.push(d.toString()));

  function send3(obj) {
    child3.stdin.write(JSON.stringify(obj) + "\n");
  }

  let tmpDirValid = null;
  let tmpDirInvalid = null;
  let tmpDirChatOnly = null;

  try {
    await waitFor3((e) => e.event === "ready", 3000, "ready (troisième sidecar)");

    // (a) cwd avec .mcp.json valide -> options.mcpServers contient les serveurs.
    tmpDirValid = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcp-valid-"));
    const validServers = { demo: { command: "node", args: ["server.js"] } };
    await fsp.writeFile(
      path.join(tmpDirValid, ".mcp.json"),
      JSON.stringify({ mcpServers: validServers }),
      "utf8",
    );
    send3({ id: "mcp-a", method: "claude.start", params: { cwd: tmpDirValid, prompt: "mcp check a" } });
    const doneMcpA = await waitFor3(
      (e) => e.id === "mcp-a" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-a done",
    );
    assert(
      doneMcpA.event === "done",
      `mcp-a attendu 'done', reçu '${doneMcpA.event}': ${JSON.stringify(doneMcpA.data)}`,
    );
    const resultA = JSON.parse(doneMcpA.data.result);
    assert(resultA.hasMcpServers === true, `mcp-a doit passer mcpServers au SDK, reçu ${JSON.stringify(resultA)}`);
    assert(
      JSON.stringify(resultA.mcpServers) === JSON.stringify(validServers),
      `mcp-a mcpServers incorrect: ${JSON.stringify(resultA.mcpServers)}`,
    );

    // (b) .mcp.json invalide (JSON cassé) -> pas de mcpServers, pas d'erreur du tour,
    // log d'avertissement sur stderr.
    tmpDirInvalid = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcp-invalid-"));
    await fsp.writeFile(path.join(tmpDirInvalid, ".mcp.json"), "{ not valid json", "utf8");
    send3({ id: "mcp-b", method: "claude.start", params: { cwd: tmpDirInvalid, prompt: "mcp check b" } });
    const doneMcpB = await waitFor3(
      (e) => e.id === "mcp-b" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-b done",
    );
    assert(
      doneMcpB.event === "done",
      `mcp-b (.mcp.json invalide) doit se terminer par 'done' (jamais d'échec du tour), reçu '${doneMcpB.event}': ${JSON.stringify(doneMcpB.data)}`,
    );
    const resultB = JSON.parse(doneMcpB.data.result);
    assert(
      resultB.hasMcpServers === false,
      `mcp-b ne doit pas passer mcpServers au SDK (JSON invalide), reçu ${JSON.stringify(resultB)}`,
    );
    await new Promise((r) => setTimeout(r, 50)); // laisse le temps au chunk stderr d'arriver
    assert(
      stderrChunks3.join("").includes(".mcp.json"),
      "mcp-b (.mcp.json invalide) doit logger un avertissement sur stderr mentionnant .mcp.json",
    );

    // (c) chatOnly avec .mcp.json présent -> pas de mcpServers (chat pur = aucun outil).
    tmpDirChatOnly = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcp-chatonly-"));
    await fsp.writeFile(
      path.join(tmpDirChatOnly, ".mcp.json"),
      JSON.stringify({ mcpServers: validServers }),
      "utf8",
    );
    send3({
      id: "mcp-c",
      method: "claude.start",
      params: { cwd: tmpDirChatOnly, prompt: "mcp check c", chatOnly: true },
    });
    const doneMcpC = await waitFor3(
      (e) => e.id === "mcp-c" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start mcp-c done",
    );
    assert(
      doneMcpC.event === "done",
      `mcp-c attendu 'done', reçu '${doneMcpC.event}': ${JSON.stringify(doneMcpC.data)}`,
    );
    const resultC = JSON.parse(doneMcpC.data.result);
    assert(
      resultC.hasMcpServers === false,
      `mcp-c (chatOnly) ne doit jamais passer mcpServers au SDK même si .mcp.json existe, reçu ${JSON.stringify(resultC)}`,
    );
    assert(
      Array.isArray(resultC.tools) && resultC.tools.length === 0,
      `mcp-c (chatOnly) doit garder tools:[] (mode chat pur), reçu ${JSON.stringify(resultC.tools)}`,
    );
  } catch (err) {
    if (stderrChunks3.length > 0) {
      console.error("--- stderr du troisième sidecar (fakeClaudeMcp) ---");
      console.error(stderrChunks3.join(""));
    }
    throw err;
  } finally {
    if (child3.exitCode === null) {
      child3.kill();
    }
    if (tmpDirValid) await fsp.rm(tmpDirValid, { recursive: true, force: true }).catch(() => {});
    if (tmpDirInvalid) await fsp.rm(tmpDirInvalid, { recursive: true, force: true }).catch(() => {});
    if (tmpDirChatOnly) await fsp.rm(tmpDirChatOnly, { recursive: true, force: true }).catch(() => {});
  }
}

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

// ---------------------------------------------------------------------------
// Lot O3 : exécution d'orchestrations (sidecar/src/orchestrator.ts).
//
// Deux tests distincts :
// - testOrchRunFakeStepRunner : en-process (import direct de dist/orchestrator.js),
//   avec un stepRunner FACTICE injecté via createOrchestratorRuntime — vérifie
//   l'ordonnanceur DAG lui-même (parallélisme, templating, cascade skip/partial,
//   abort) sans dépendre des vrais moteurs. La résolution agents/orchestrations
//   reste réelle (lecture de vrais fichiers YAML sur disque, comme O1).
// - testOrchRunRealClaudeEngine : sous-processus sidecar isolé (comme les tests
//   O1 ci-dessus), avec IACTION_FAKE_CLAUDE=1 — vérifie l'intégration bout en
//   bout avec un vrai moteur (claude.ts), permission_request comprise.
// ---------------------------------------------------------------------------

/** Collecteur d'événements en-process pour un EngineEmitter (chunk/done/error), avec waitFor à la manière du harnais subprocess ci-dessus. */
function makeEmitterCollector() {
  const events = [];
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

  const emitter = {
    chunk(id, data) {
      const evt = { kind: "chunk", id, data };
      events.push(evt);
      notify(evt);
    },
    done(id, data) {
      const evt = { kind: "done", id, data };
      events.push(evt);
      notify(evt);
    },
    error(id, message) {
      const evt = { kind: "error", id, data: { message } };
      events.push(evt);
      notify(evt);
    },
  };

  function waitFor(predicate, timeoutMs = 3000, label = "événement") {
    const existing = events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
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

  return { emitter, events, waitFor };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * StepRunner factice contrôlable par scénario (`behaviors: {[stepId]: {mode:"success"|"fail"|"hang", output?, message?}}`).
 * Enregistre la concurrence observée (start()s simultanés en cours) et le prompt
 * vu par chaque étape (pour vérifier le templating) — consommés par les
 * assertions du test appelant.
 */
function makeFakeStepRunner(behaviors) {
  const hangers = new Map(); // internalId -> {resolve, emitter}
  const seenPrompts = {};
  const concurrency = { current: 0, max: 0 };

  const runner = {
    async start(internalId, _engine, params, emitter) {
      const stepId = internalId.slice(internalId.lastIndexOf("::") + 2);
      const behavior = behaviors[stepId] || { mode: "success" };
      seenPrompts[stepId] = params.prompt;

      concurrency.current++;
      concurrency.max = Math.max(concurrency.max, concurrency.current);
      emitter.chunk(internalId, { kind: "text", delta: `hello-${stepId}` });

      if (behavior.mode === "hang") {
        await new Promise((resolve) => {
          hangers.set(internalId, { resolve, emitter });
        });
        concurrency.current--;
        return;
      }

      await sleep(15);
      concurrency.current--;

      if (behavior.mode === "fail") {
        emitter.done(internalId, { subtype: "error_x", result: null, usage: null });
      } else {
        const output = behavior.output ?? `output-${stepId}`;
        emitter.done(internalId, { subtype: "success", result: output, usage: { inputTokens: 1, outputTokens: 1 } });
      }
    },
    async permission(_engine, id, _params, emitter) {
      emitter.done(id, { applied: false });
    },
    async abort(_engine, _id, params, _emitter) {
      const h = hangers.get(params.targetId);
      if (h) {
        hangers.delete(params.targetId);
        h.emitter.done(params.targetId, { subtype: "aborted", result: null, usage: null });
        h.resolve();
      }
    },
  };

  return { runner, seenPrompts, concurrency };
}

async function testOrchRunFakeStepRunner() {
  const orchestratorModuleUrl = pathToFileURL(path.join(__dirname, "..", "dist", "orchestrator.js")).href;
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

/**
 * R3 — débord, plafond et agrégat routage (docs/spec-r3-debord.md §4).
 * Sous-processus sidecar isolé avec son propre XDG_CONFIG_HOME : le test
 * forge claude-windows.jsonl (instantané de fenêtres) et events.jsonl
 * (dépense de débord), que le sidecar relit à chaque appel (aucun cache).
 */
async function testR3Debord() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-r3-xdg-"));
  const usageDir = path.join(xdgDir, "net.duvam.iaction", "usage");
  await fsp.mkdir(usageDir, { recursive: true });
  const windowsFile = path.join(usageDir, "claude-windows.jsonl");
  const eventsFile = path.join(usageDir, "events.jsonl");

  const child7 = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeModule,
      XDG_CONFIG_HOME: xdgDir,
    },
  });

  const received7 = [];
  const waiters7 = [];

  function notifyWaiters7(evt) {
    for (let i = waiters7.length - 1; i >= 0; i--) {
      const w = waiters7[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters7.splice(i, 1);
        w.resolve(evt);
      }
    }
  }

  function waitFor7(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received7.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters7.indexOf(w);
        if (idx >= 0) waiters7.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters7.push(w);
    });
  }

  const stdoutRl7 = createInterface({ input: child7.stdout, crlfDelay: Infinity });
  stdoutRl7.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du septième sidecar (R3 débord) a émis une ligne non-JSON: ${line}`);
      return;
    }
    received7.push(parsed);
    notifyWaiters7(parsed);
  });

  const stderrChunks7 = [];
  child7.stderr.on("data", (d) => stderrChunks7.push(d.toString()));

  function send7(obj) {
    child7.stdin.write(JSON.stringify(obj) + "\n");
  }

  try {
    await waitFor7((e) => e.event === "ready", 3000, "ready (septième sidecar)");

  // Table explicite : ces scénarios raisonnent sur « trivial local / étage
  // claude » — on ne dépend pas des défauts produit (choix utilisateur mouvants).
  const R3_TABLE = {
    trivial: { engine: "neutral", providerId: "ollama", model: "qwen3.5:4b" },
    simple: { engine: "claude", model: "claude-haiku-4-5" },
    moyen: { engine: "claude", model: "claude-sonnet-5" },
    complexe: { engine: "claude", model: "claude-fable-5" },
  };
    send7({ id: "rs-r3-init", method: "router.set", params: { table: R3_TABLE } });
    await waitFor7((e) => e.id === "rs-r3-init" && e.event === "done", 3000, "router.set rs-r3-init");

    // Spec R3 §4.3 : PAS d'instantané de fenêtres -> routage R1 inchangé,
    // aucun champ debord dans le done.
    send7({ id: "rd1", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd1 = await waitFor7((e) => e.id === "rd1" && e.event === "done", 3000, "router.route rd1");
    assert(
      doneRd1.data.tier === "simple" &&
        JSON.stringify(doneRd1.data.target) === JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
      `rd1 : sans instantané, cible du tier simple attendue, reçu ${JSON.stringify(doneRd1.data)}`,
    );
    assert(
      doneRd1.data.debord === undefined,
      `rd1 : champ debord absent attendu (pas d'instantané), reçu ${JSON.stringify(doneRd1.data.debord)}`,
    );

    // R6-A — fraîcheur : un instantané VIEUX de 2 h (> DEBORD_SNAPSHOT_MAX_AGE_MS,
    // 30 min) est ignoré même saturé à 95 % -> comportement « pas d'instantané »
    // (pas de débord).
    const staleTs = new Date(Date.now() - 2 * 3600_000).toISOString();
    await fsp.writeFile(
      windowsFile,
      JSON.stringify({ ts: staleTs, windows: { five_hour: { utilization: 95, resetsAt: staleTs } } }) + "\n",
      "utf8",
    );
    send7({ id: "rd1b", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd1b = await waitFor7((e) => e.id === "rd1b" && e.event === "done", 3000, "router.route rd1b");
    assert(
      doneRd1b.data.debord === undefined &&
        JSON.stringify(doneRd1b.data.target) === JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
      `rd1b : instantané périmé (2 h) -> pas de débord attendu, reçu ${JSON.stringify(doneRd1b.data)}`,
    );

    // Spec R3 §4.1 : fenêtre 5 h forgée à 95 % (>= seuil 90 par défaut) ->
    // débord actif vers la cible par défaut (openrouter · deepseek). Le
    // DERNIER instantané prime (le premier, à 10 %, doit être ignoré).
    const oldTs = new Date(Date.now() - 3600_000).toISOString();
    await fsp.writeFile(
      windowsFile,
      JSON.stringify({ ts: oldTs, windows: { five_hour: { utilization: 10, resetsAt: oldTs } } }) +
        "\n" +
        JSON.stringify({
          ts: new Date().toISOString(),
          windows: { five_hour: { utilization: 95, resetsAt: oldTs }, seven_day: { utilization: 40, resetsAt: oldTs } },
        }) +
        "\n",
      "utf8",
    );
    send7({ id: "rd2", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd2 = await waitFor7((e) => e.id === "rd2" && e.event === "done", 3000, "router.route rd2");
    assert(
      JSON.stringify(doneRd2.data.debord) === JSON.stringify({ active: true, fiveHourPct: 95 }),
      `rd2 : debord actif attendu, reçu ${JSON.stringify(doneRd2.data.debord)}`,
    );
    assert(
      JSON.stringify(doneRd2.data.target) ===
        JSON.stringify({ engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat" }),
      `rd2 : cible de débord par défaut attendue, reçu ${JSON.stringify(doneRd2.data.target)}`,
    );
    assert(
      Array.isArray(doneRd2.data.reasons) && doneRd2.data.reasons.some((r) => r.includes("débord")),
      `rd2 : raison de débord attendue, reçu ${JSON.stringify(doneRd2.data.reasons)}`,
    );

    // Une cible NEUTRE (tier trivial par défaut) ne déborde jamais.
    send7({ id: "rd2b", method: "router.route", params: { text: "Salut, ça va ?" } });
    const doneRd2b = await waitFor7((e) => e.id === "rd2b" && e.event === "done", 3000, "router.route rd2b");
    assert(
      doneRd2b.data.tier === "trivial" && doneRd2b.data.debord === undefined,
      `rd2b : une cible neutre ne doit pas déborder, reçu ${JSON.stringify(doneRd2b.data)}`,
    );

    // router.set : cible de débord personnalisée (mock/debord-model).
    send7({
      id: "rs-r3",
      method: "router.set",
      params: {
        table: R3_TABLE,
        debord: {
          target: { engine: "neutral", providerId: "mock", model: "debord-model" },
          seuilPct: 90,
          plafondUsdMois: 10,
        },
      },
    });
    await waitFor7((e) => e.id === "rs-r3" && e.event === "done", 3000, "router.set rs-r3");
    send7({ id: "rd3", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd3 = await waitFor7((e) => e.id === "rd3" && e.event === "done", 3000, "router.route rd3");
    assert(
      JSON.stringify(doneRd3.data.target) ===
        JSON.stringify({ engine: "neutral", providerId: "mock", model: "debord-model" }),
      `rd3 : cible de débord poussée attendue, reçu ${JSON.stringify(doneRd3.data.target)}`,
    );

    // R3 — tier IMPOSÉ (params.tier) : aucune classification, résolution
    // cible + débord seule (utilisé par l'UI sur les tours à affinité).
    send7({ id: "rd4", method: "router.route", params: { text: "Salut", tier: "complexe" } });
    const doneRd4 = await waitFor7((e) => e.id === "rd4" && e.event === "done", 3000, "router.route rd4");
    assert(
      doneRd4.data.tier === "complexe" &&
        doneRd4.data.score === 0 &&
        doneRd4.data.reasons.includes("tier imposé par l'appelant") &&
        doneRd4.data.debord &&
        doneRd4.data.debord.active === true,
      `rd4 : tier imposé + débord actif attendus, reçu ${JSON.stringify(doneRd4.data)}`,
    );

    // Spec R3 §4.2 : plafond atteint (événements forgés routeDebord+costUsd,
    // 6 + 5 = 11 >= 10 ce mois-ci) -> repli sur la cible du tier trivial,
    // debord {active:false, blocked:true}.
    const nowIso = new Date().toISOString();
    await fsp.writeFile(
      eventsFile,
      [
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 6 }),
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 5 }),
        // Payant choisi MANUELLEMENT (sans routeDebord) : n'entre jamais dans le plafond.
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "gpt-couteux", status: "done", costUsd: 100 }),
      ].join("\n") + "\n",
      "utf8",
    );
    send7({ id: "rd5", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd5 = await waitFor7((e) => e.id === "rd5" && e.event === "done", 3000, "router.route rd5");
    assert(
      JSON.stringify(doneRd5.data.debord) === JSON.stringify({ active: false, blocked: true, fiveHourPct: 95 }),
      `rd5 : debord bloqué attendu (plafond atteint), reçu ${JSON.stringify(doneRd5.data.debord)}`,
    );
    assert(
      JSON.stringify(doneRd5.data.target) ===
        JSON.stringify({ engine: "neutral", providerId: "ollama", model: "qwen3.5:4b" }),
      `rd5 : repli sur la cible du tier trivial attendu, reçu ${JSON.stringify(doneRd5.data.target)}`,
    );

    // R6-A — garde du repli « plafond atteint » : si le tier trivial n'est PAS
    // un moteur neutre sur provider LOCAL (ici openrouter, payant), le repli
    // ne doit router ni vers du payant ni vers l'abo « au nom du repli
    // local » : la cible claude d'origine est conservée.
    send7({
      id: "rs-r6-guard",
      method: "router.set",
      params: {
        table: { ...R3_TABLE, trivial: { engine: "neutral", providerId: "openrouter", model: "pas-local" } },
        debord: {
          target: { engine: "neutral", providerId: "mock", model: "debord-model" },
          seuilPct: 90,
          plafondUsdMois: 10,
        },
      },
    });
    await waitFor7((e) => e.id === "rs-r6-guard" && e.event === "done", 3000, "router.set rs-r6-guard");
    send7({ id: "rd5b", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd5b = await waitFor7((e) => e.id === "rd5b" && e.event === "done", 3000, "router.route rd5b");
    assert(
      JSON.stringify(doneRd5b.data.debord) === JSON.stringify({ active: false, blocked: true, fiveHourPct: 95 }),
      `rd5b : debord bloqué attendu (plafond atteint), reçu ${JSON.stringify(doneRd5b.data.debord)}`,
    );
    assert(
      JSON.stringify(doneRd5b.data.target) === JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
      `rd5b : cible claude d'origine CONSERVÉE attendue (trivial non local), reçu ${JSON.stringify(doneRd5b.data.target)}`,
    );
    assert(
      Array.isArray(doneRd5b.data.reasons) &&
        doneRd5b.data.reasons.some((r) => r.includes("cible abonnement conservée")),
      `rd5b : raison « cible abonnement conservée » attendue, reçu ${JSON.stringify(doneRd5b.data.reasons)}`,
    );

    // plafondUsdMois: null = SANS plafond -> débord actif malgré la dépense.
    send7({
      id: "rs-r3b",
      method: "router.set",
      params: {
        table: R3_TABLE,
        debord: {
          target: { engine: "neutral", providerId: "mock", model: "debord-model" },
          seuilPct: 90,
          plafondUsdMois: null,
        },
      },
    });
    await waitFor7((e) => e.id === "rs-r3b" && e.event === "done", 3000, "router.set rs-r3b");
    send7({ id: "rd6", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd6 = await waitFor7((e) => e.id === "rd6" && e.event === "done", 3000, "router.route rd6");
    assert(
      doneRd6.data.debord && doneRd6.data.debord.active === true,
      `rd6 : sans plafond, débord actif attendu malgré la dépense, reçu ${JSON.stringify(doneRd6.data.debord)}`,
    );

    // R6-A — `debord: null` = débord DÉSACTIVÉ : jamais de bascule payante
    // automatique, même fenêtre saturée (distinct de « champ absent » =
    // défauts, couvert par rd2). C'est l'état poussé par le runner headless
    // quand la config de l'app est illisible.
    send7({ id: "rs-r6-off", method: "router.set", params: { table: R3_TABLE, debord: null } });
    await waitFor7((e) => e.id === "rs-r6-off" && e.event === "done", 3000, "router.set rs-r6-off");
    send7({ id: "rd7", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRd7 = await waitFor7((e) => e.id === "rd7" && e.event === "done", 3000, "router.route rd7");
    assert(
      doneRd7.data.debord === undefined &&
        JSON.stringify(doneRd7.data.target) === JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
      `rd7 : debord:null -> aucun débord attendu (cible du tier conservée), reçu ${JSON.stringify(doneRd7.data)}`,
    );

    // Spec R3 §4.4 : agrégat `routage` de usage.stats sur événements forgés.
    // 5 tours dans la période : 2 claude (routeTier simple), 1 ollama
    // (trivial), 1 débord openrouter (simple, 0.5 $), 1 manuel openrouter
    // sans routeTier ; plus 1 vieux débord (60 jours : hors période ET hors
    // mois calendaire courant, quel que soit le jour du test).
    const oldMonthIso = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
    await fsp.writeFile(
      eventsFile,
      [
        JSON.stringify({ ts: nowIso, engine: "claude", providerId: null, model: "claude-haiku-4-5", status: "done", routeTier: "simple" }),
        JSON.stringify({ ts: nowIso, engine: "claude", providerId: null, model: "claude-haiku-4-5", status: "done", routeTier: "simple" }),
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "ollama", model: "qwen3.5:4b", status: "done", routeTier: "trivial" }),
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 0.5 }),
        JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "gpt-couteux", status: "done" }),
        JSON.stringify({ ts: oldMonthIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 99 }),
      ].join("\n") + "\n",
      "utf8",
    );
    send7({ id: "us-r3", method: "usage.stats", params: {} });
    const doneUsR3 = await waitFor7((e) => e.id === "us-r3" && e.event === "done", 3000, "usage.stats us-r3");
    const routage = doneUsR3.data.routage;
    assert(routage, `us-r3 : champ routage attendu, reçu ${JSON.stringify(doneUsR3.data)}`);
    assert(
      routage.toursAuto === 4,
      `us-r3 : toursAuto attendu 4, reçu ${JSON.stringify(routage.toursAuto)}`,
    );
    assert(
      JSON.stringify(routage.parTier) === JSON.stringify({ simple: { tours: 3 }, trivial: { tours: 1 } }),
      `us-r3 : parTier incorrect, reçu ${JSON.stringify(routage.parTier)}`,
    );
    // 3 tours à coût nul (2 claude + 1 ollama) sur 5 -> 60 %.
    assert(
      routage.partCoutNulPct === 60,
      `us-r3 : partCoutNulPct attendu 60, reçu ${JSON.stringify(routage.partCoutNulPct)}`,
    );
    assert(
      JSON.stringify(routage.mixAbo) === JSON.stringify([{ model: "claude-haiku-4-5", tours: 2 }]),
      `us-r3 : mixAbo incorrect, reçu ${JSON.stringify(routage.mixAbo)}`,
    );
    // Seul le débord du MOIS CALENDAIRE COURANT compte (0.5, pas 99.5).
    assert(
      routage.debordMoisUsd === 0.5,
      `us-r3 : debordMoisUsd attendu 0.5, reçu ${JSON.stringify(routage.debordMoisUsd)}`,
    );

    // R6-A — rotation : un événement de débord du mois courant BASCULÉ dans
    // events.jsonl.1 (rotation 20 Mo) compte AUSSI dans le plafond/l'agrégat
    // mensuel (0.5 + 2 = 2.5).
    await fsp.writeFile(
      `${eventsFile}.1`,
      JSON.stringify({ ts: nowIso, engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat", status: "done", routeTier: "simple", routeDebord: true, costUsd: 2 }) + "\n",
      "utf8",
    );
    send7({ id: "us-r6rot", method: "usage.stats", params: {} });
    const doneUsR6rot = await waitFor7((e) => e.id === "us-r6rot" && e.event === "done", 3000, "usage.stats us-r6rot");
    assert(
      doneUsR6rot.data.routage.debordMoisUsd === 2.5,
      `us-r6rot : debordMoisUsd attendu 2.5 (events.jsonl.1 inclus), reçu ${JSON.stringify(doneUsR6rot.data.routage.debordMoisUsd)}`,
    );
  } catch (err) {
    if (stderrChunks7.length > 0) {
      console.error("--- stderr du septième sidecar (R3 débord) ---");
      console.error(stderrChunks7.join(""));
    }
    throw err;
  } finally {
    if (child7.exitCode === null) {
      child7.kill();
    }
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * R1 — cas unitaires de `classify` (docs/spec-r1-routeur.md §5.1) : fonction
 * pure, importée directement depuis le module compilé (aucun sous-processus).
 */
async function testRouterClassify() {
  const routerModuleUrl = pathToFileURL(path.join(__dirname, "..", "dist", "router.js")).href;
  const { classify } = await import(routerModuleUrl);

  // 1. R7 — trivialité PROUVÉE (score 0 + motif de salutation) -> trivial.
  const triv = classify({ text: "Salut, ça va ?" });
  assert(
    triv.tier === "trivial" && triv.score === 0 && Array.isArray(triv.reasons),
    `classify trivial incorrect: ${JSON.stringify(triv)}`,
  );
  assert(
    triv.reasons.length === 1 && triv.reasons[0].includes("trivialité prouvée"),
    `classify trivial : raison « trivialité prouvée » attendue, reçu ${JSON.stringify(triv.reasons)}`,
  );

  // R7 — acquiescement court -> trivial (motif « ok »/« merci »).
  const ack = classify({ text: "ok merci" });
  assert(
    ack.tier === "trivial" && ack.score === 0,
    `classify acquiescement incorrect: ${JSON.stringify(ack)}`,
  );

  // R7 — score 0 SANS motif de trivialité -> simple (défaut descendant) :
  // l'absence de preuve de complexité n'est plus une preuve de trivialité.
  const noSignal = classify({ text: "j'ai un problème avec mon appli" });
  assert(
    noSignal.tier === "simple" && noSignal.score === 0,
    `classify sans signal incorrect (simple attendu): ${JSON.stringify(noSignal)}`,
  );
  assert(
    noSignal.reasons.length === 1 && noSignal.reasons[0].includes("défaut descendant"),
    `classify sans signal : raison « défaut descendant » attendue, reçu ${JSON.stringify(noSignal.reasons)}`,
  );

  // 2. Court + marqueur de raisonnement -> simple (score 2, une raison française).
  const simple = classify({ text: "Explique pourquoi ce test échoue" });
  assert(
    simple.tier === "simple" && simple.score === 2,
    `classify simple incorrect: ${JSON.stringify(simple)}`,
  );
  assert(
    simple.reasons.length === 1 && simple.reasons[0].includes("raisonnement"),
    `classify simple : raisons attendues ["…raisonnement…"], reçu ${JSON.stringify(simple.reasons)}`,
  );

  // Insensibilité casse/accents (normalisation NFD) : majuscules accentuées.
  const caseless = classify({ text: "ANALYSE ÇA S'IL TE PLAÎT" });
  assert(
    caseless.tier === "simple" && caseless.score === 2,
    `classify casse/accents incorrect: ${JSON.stringify(caseless)}`,
  );

  // 3. R7 — bloc ``` (+2) + « implémente » (+3) = 5 -> moyen (3-6).
  const moyen = classify({
    text: "Implémente la fonction suivante dans le module.\n```\nfunction demo() { return 1; }\n```",
  });
  assert(
    moyen.tier === "moyen" && moyen.score === 5,
    `classify moyen incorrect (attendu score 5 = 2 code + 3 édition): ${JSON.stringify(moyen)}`,
  );

  // R7 — > 400 caractères (+2) + code (+2) + édition (+3) = 7 -> complexe (≥ 7).
  // Le remplissage évite soigneusement tout autre marqueur du barème.
  const filler = "du texte descriptif sans marqueur particulier pour gonfler la longueur du message. ".repeat(6);
  const seuilComplexe = classify({
    text: `Implémente la fonction suivante dans le module.\n\`\`\`\nfunction demo() { return 1; }\n\`\`\`\n${filler}`,
  });
  assert(
    seuilComplexe.tier === "complexe" && seuilComplexe.score === 7,
    `classify seuil complexe incorrect (attendu score 7 = 2 long + 2 code + 3 édition): ${JSON.stringify(seuilComplexe)}`,
  );

  // 4. > 1500 caractères (+2 +3) + code (+2) + édition (+3) + 2 pièces jointes (+2) = 12 -> complexe.
  const longFiller = "du texte descriptif sans marqueur particulier pour gonfler la longueur du message. ".repeat(20);
  const complexe = classify({
    text: `Corrige ce module.\n\`\`\`\nfunction demo() { return 1; }\n\`\`\`\n${longFiller}`,
    attachmentsCount: 2,
  });
  assert(
    complexe.tier === "complexe" && complexe.score === 12,
    `classify complexe incorrect (attendu score 12): ${JSON.stringify(complexe)}`,
  );

  // historique > 10 tours : +1. R7 — le moindre signal (score 1) écarte le
  // tier trivial (preuve positive = score 0 strict) -> simple.
  const withHistory = classify({ text: "Salut, ça va ?", historyTurns: 12 });
  assert(
    withHistory.score === 1 && withHistory.tier === "simple",
    `classify historique incorrect: ${JSON.stringify(withHistory)}`,
  );
}

/**
 * R4 — cas unitaires de la logique pure de compaction (docs/spec-r4-contexte.md
 * §4.2/§4.3) : fonctions pures importées depuis le module compilé, comme
 * testRouterClassify.
 */
async function testContextPure() {
  const contextModuleUrl = pathToFileURL(path.join(__dirname, "..", "dist", "context.js")).href;
  const { shouldCompact, buildCompactedMessages, COMPACT_KEEP_LAST } = await import(contextModuleUrl);

  // Seuil tours : 31 tours non couverts -> compacte (même sans contexte connu).
  assert(
    shouldCompact({ uncoveredTurns: 31, estimatedChars: 100, contextLength: null }) === true,
    "shouldCompact : 31 tours non couverts doivent déclencher la compaction",
  );

  // Seuil contexte : 12 tours seulement, mais estimation > 60 % du contexte
  // (30000 caractères ≈ 7500 tokens > 0,6 × 8000) -> compacte.
  assert(
    shouldCompact({ uncoveredTurns: 12, estimatedChars: 30000, contextLength: 8000 }) === true,
    "shouldCompact : 12 tours mais > 60 % du contexte doivent déclencher la compaction",
  );

  // Petit historique -> ne compacte pas (y compris avec contexte connu large,
  // et sans contexte connu : le seuil tours s'applique alors seul).
  assert(
    shouldCompact({ uncoveredTurns: 5, estimatedChars: 2000, contextLength: 8000 }) === false,
    "shouldCompact : petit historique ne doit pas compacter",
  );
  assert(
    shouldCompact({ uncoveredTurns: 12, estimatedChars: 30000 }) === false,
    "shouldCompact : sans contextLength, seul le seuil tours s'applique",
  );

  // Construction post-compaction : résumé en tête (après le system), les
  // 10 derniers tours intacts, tableau d'origine non modifié.
  const turns = [];
  for (let i = 0; i < 25; i++) {
    turns.push({ role: i % 2 === 0 ? "user" : "assistant", content: `tour ${i}` });
  }
  const upToIndex = turns.length - COMPACT_KEEP_LAST; // 15
  const built = buildCompactedMessages({
    system: "Instructions système",
    summary: "Résumé des quinze premiers tours.",
    turns,
    upToIndex,
  });
  assert(
    built.length === 2 + COMPACT_KEEP_LAST,
    `buildCompactedMessages : ${2 + COMPACT_KEEP_LAST} messages attendus (system + résumé + 10 tours), reçu ${built.length}`,
  );
  assert(
    built[0].role === "system" && built[0].content === "Instructions système",
    `buildCompactedMessages : system en tête attendu, reçu ${JSON.stringify(built[0])}`,
  );
  assert(
    built[1].role === "user" &&
      built[1].content.startsWith("[Résumé de la conversation antérieure]\n") &&
      built[1].content.includes("Résumé des quinze premiers tours."),
    `buildCompactedMessages : message-résumé attendu en 2e position, reçu ${JSON.stringify(built[1])}`,
  );
  for (let i = 0; i < COMPACT_KEEP_LAST; i++) {
    const expected = turns[upToIndex + i];
    const got = built[2 + i];
    assert(
      got.role === expected.role && got.content === expected.content,
      `buildCompactedMessages : tour conservé ${i} altéré, attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(got)}`,
    );
  }
  assert(
    turns.length === 25 && turns[0].content === "tour 0",
    "buildCompactedMessages : la transcription d'origine ne doit pas être modifiée",
  );

  // Sans system : le résumé ouvre le fil.
  const builtNoSystem = buildCompactedMessages({ summary: "S", turns, upToIndex: 20 });
  assert(
    builtNoSystem[0].role === "user" && builtNoSystem[0].content.startsWith("[Résumé de la conversation antérieure]"),
    `buildCompactedMessages sans system : résumé en tête attendu, reçu ${JSON.stringify(builtNoSystem[0])}`,
  );
}

/**
 * R5 — fonctions pures du RAG local (docs/spec-r5-rag.md §5.1/§5.2) :
 * chunking (tailles/recouvrement/frontières de lignes) et cosinus + topK,
 * importées depuis le module compilé — même patron que testRouterClassify.
 */
async function testKnowledgePure() {
  const knowledgeModuleUrl = pathToFileURL(path.join(__dirname, "..", "dist", "knowledge.js")).href;
  const { chunkText, cosineSimilarity, rankChunks, CHUNK_SIZE, CHUNK_OVERLAP } = await import(knowledgeModuleUrl);

  // 1. Chunking — texte court : un seul chunk, identique ; vide : aucun.
  assert(
    JSON.stringify(chunkText("petit texte\nsur deux lignes\n")) === JSON.stringify(["petit texte\nsur deux lignes\n"]),
    "chunkText : un texte court doit tenir dans un seul chunk inchangé",
  );
  assert(chunkText("   \n\n  ").length === 0, "chunkText : un texte blanc ne doit produire aucun chunk");

  // Texte long à lignes numérotées (~40 caractères chacune) : chaque chunk
  // ≤ CHUNK_SIZE, coupé aux frontières de lignes, recouvrement ≤ CHUNK_OVERLAP
  // (les dernières lignes entières du chunk précédent).
  const lines = [];
  for (let i = 0; i < 120; i++) {
    lines.push(`ligne ${String(i).padStart(3, "0")} lorem ipsum dolor sit amet\n`);
  }
  const longText = lines.join("");
  const chunks = chunkText(longText);
  assert(chunks.length > 1, `chunkText : un texte de ${longText.length} caractères doit produire plusieurs chunks`);
  for (const chunk of chunks) {
    assert(chunk.length <= CHUNK_SIZE, `chunkText : chunk trop long (${chunk.length} > ${CHUNK_SIZE})`);
    assert(/^ligne \d{3} /.test(chunk), "chunkText : chaque chunk doit commencer à une frontière de ligne");
    assert(chunk.endsWith("\n"), "chunkText : chaque chunk doit finir à une frontière de ligne");
  }
  for (let i = 1; i < chunks.length; i++) {
    // Recouvrement : le chunk i commence par un suffixe non vide (≤ CHUNK_OVERLAP)
    // du chunk i-1, puis continue avec du contenu nouveau.
    const prev = chunks[i - 1];
    let overlapLen = -1;
    for (let l = Math.min(CHUNK_OVERLAP, prev.length); l > 0; l--) {
      if (chunks[i].startsWith(prev.slice(prev.length - l))) {
        overlapLen = l;
        break;
      }
    }
    assert(
      overlapLen > 0 && overlapLen <= CHUNK_OVERLAP,
      `chunkText : recouvrement attendu entre les chunks ${i - 1} et ${i} (≤ ${CHUNK_OVERLAP} caractères)`,
    );
    assert(chunks[i].length > overlapLen, `chunkText : le chunk ${i} doit apporter du contenu nouveau après le recouvrement`);
  }
  // Couverture : la concaténation (recouvrements retirés) reconstitue le texte.
  let rebuilt = chunks[0];
  for (let i = 1; i < chunks.length; i++) {
    for (let l = Math.min(CHUNK_OVERLAP, rebuilt.length); l >= 0; l--) {
      if (chunks[i].startsWith(rebuilt.slice(rebuilt.length - l))) {
        rebuilt += chunks[i].slice(l);
        break;
      }
    }
  }
  assert(rebuilt === longText, "chunkText : la concaténation des chunks (recouvrements retirés) doit reconstituer le texte");

  // Ligne monstrueuse (> CHUNK_SIZE, sans \n) : découpe dure, rien de perdu.
  const monster = "x".repeat(2500);
  const monsterChunks = chunkText(monster);
  assert(
    monsterChunks.every((c) => c.length <= CHUNK_SIZE) && monsterChunks.join("") === monster,
    `chunkText : une ligne de 2500 caractères doit être découpée en dur sans perte, reçu ${JSON.stringify(monsterChunks.map((c) => c.length))}`,
  );

  // 2. Cosinus : colinéaires → 1, orthogonaux → 0, vecteur nul/dimensions ≠ → 0.
  assert(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-9, "cosineSimilarity : vecteurs colinéaires → 1");
  assert(cosineSimilarity([1, 0], [0, 1]) === 0, "cosineSimilarity : vecteurs orthogonaux → 0");
  assert(cosineSimilarity([0, 0], [1, 1]) === 0, "cosineSimilarity : vecteur nul → 0");
  assert(cosineSimilarity([1, 2], [1, 2, 3]) === 0, "cosineSimilarity : dimensions incompatibles → 0");

  // 3. topK : résultats ordonnés par score décroissant, bornés à k.
  const forged = [
    { file: "a.md", text: "chunk a", embedding: [1, 0, 0] },
    { file: "b.md", text: "chunk b", embedding: [0.9, 0.1, 0] },
    { file: "c.md", text: "chunk c", embedding: [0, 1, 0] },
    { file: "d.md", text: "chunk d", embedding: [0, 0, 1] },
  ];
  const ranked = rankChunks([1, 0, 0], forged, 3);
  assert(ranked.length === 3, `rankChunks : 3 résultats attendus, reçu ${ranked.length}`);
  assert(
    ranked[0].file === "a.md" && ranked[1].file === "b.md",
    `rankChunks : ordre attendu a.md puis b.md, reçu ${JSON.stringify(ranked.map((r) => r.file))}`,
  );
  assert(
    ranked[0].score === 1 && ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score,
    `rankChunks : scores décroissants attendus, reçu ${JSON.stringify(ranked.map((r) => r.score))}`,
  );
  assert(ranked[0].excerpt === "chunk a", `rankChunks : excerpt = texte du chunk, reçu ${JSON.stringify(ranked[0])}`);
}

async function main() {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: fakeClaudeModule,
    },
  });

  const received = [];
  const waiters = [];

  function notifyWaiters(evt) {
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
    if (existing) {
      return Promise.resolve(existing);
    }
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
      fail(`stdout du sidecar a émis une ligne non-JSON (stdout doit être réservé au protocole): ${line}`);
      return;
    }
    received.push(parsed);
    notifyWaiters(parsed);
  });

  const stderrChunks = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));

  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  // ---------------------------------------------------------------------
  // Serveur mock OpenAI-compatible pour les tests Lot 1 (providers.set,
  // models.list, chat.send, chat.abort).
  // ---------------------------------------------------------------------
  const MOCK_API_KEY = "secret-key-123";
  const MOCK_CUSTOM_HEADER = "abc";

  // -----------------------------------------------------------------------
  // Helpers SSE pour /v1-neutral/chat/completions (Lot 6 : boucle agentique
  // du moteur neutre). Le tool_call est toujours fragmenté en 2 morceaux
  // d'arguments (id/name sur le premier delta.tool_calls, puis les fragments)
  // pour exercer l'accumulation par index décrite dans le rapport de livraison.
  // -----------------------------------------------------------------------
  let neutralLoopCallCount = 0;
  // R0 : derniers bodies POST /chat/completions capturés, pour vérifier le corps
  // de requête produit par chat.send (rétrocompat stricte / réglages OpenRouter).
  let lastChatCompletionsBody = null;
  let lastRoutedChatBody = null;
  // R2 : dernier body reçu par le faux classificateur LLM (vérifie complétion
  // non streamée, température 0, max_tokens court, prompt système présent).
  let lastClassifierBody = null;
  // R4 : dernier body reçu par le faux résumeur (context.compact) — vérifie
  // complétion non streamée, prompt système français, transcription fournie.
  let lastCompactBody = null;
  // R6-A : dernier body reçu par la route agentique /v1-neutral — vérifie que
  // meta.routeDebord force usage:{include:true} même sans usageAccounting.
  let lastNeutralBody = null;

  function sseChunk(res, obj) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  function sendToolCallResponse(res, toolCall) {
    const argsJson = JSON.stringify(toolCall.args ?? {});
    const mid = Math.max(1, Math.floor(argsJson.length / 2));
    const fragments = [argsJson.slice(0, mid), argsJson.slice(mid)];
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseChunk(res, {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    for (const frag of fragments) {
      sseChunk(res, {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: frag } }] }, finish_reason: null },
        ],
      });
    }
    sseChunk(res, {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  // R6-A : `extraUsage` optionnel, fusionné dans l'usage final (usage étendu
  // R0 — cost/prompt_tokens_details — pour l'op final_cost ci-dessous).
  function sendFinalTextResponse(res, text, extraUsage = null) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseChunk(res, { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
    sseChunk(res, {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 6, completion_tokens: 2, ...(extraUsage ?? {}) },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }

  const mockServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let bodyJson = null;
      try {
        bodyJson = raw ? JSON.parse(raw) : null;
      } catch {
        bodyJson = null;
      }

      if (req.url === "/v1/models" && req.method === "GET") {
        if (
          req.headers["authorization"] !== `Bearer ${MOCK_API_KEY}` ||
          req.headers["x-custom"] !== MOCK_CUSTOM_HEADER
        ) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "en-têtes attendus manquants" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              {
                id: "model-a",
                name: "Model A",
                description: "Modèle de démo avec tarification OpenRouter",
                context_length: 128000,
                pricing: { prompt: "0.000003", completion: "0.000015" },
              },
              // Volontairement sans pricing/name/context_length/description : vérifie
              // que models.detail omet ces champs sans erreur (et que models.list,
              // qui ne renvoie que l'id, n'est pas affecté par ces métadonnées).
              { id: "model-b" },
            ],
          }),
        );
        return;
      }

      if (req.url === "/v1/credits" && req.method === "GET") {
        if (
          req.headers["authorization"] !== `Bearer ${MOCK_API_KEY}` ||
          req.headers["x-custom"] !== MOCK_CUSTOM_HEADER
        ) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "en-têtes attendus manquants" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { total_credits: 100, total_usage: 37 } }));
        return;
      }

      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        if (
          req.headers["authorization"] !== `Bearer ${MOCK_API_KEY}` ||
          req.headers["x-custom"] !== MOCK_CUSTOM_HEADER
        ) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "en-têtes attendus manquants" }));
          return;
        }
        lastChatCompletionsBody = bodyJson;
        if (!bodyJson || bodyJson.stream !== true) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "stream:true attendu" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const deltas = ["Bonjour", " le", " monde"];
        let i = 0;
        const sendNext = () => {
          if (i < deltas.length) {
            res.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-mock",
                choices: [{ index: 0, delta: { content: deltas[i] }, finish_reason: null }],
              })}\n\n`,
            );
            i++;
            setTimeout(sendNext, 15);
          } else {
            res.write(
              `data: ${JSON.stringify({
                id: "chatcmpl-mock",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 7, completion_tokens: 3 },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }
        };
        sendNext();
        return;
      }

      // Route R0 : flux SSE dont les chunks portent `model` (slug réellement
      // servi, comme OpenRouter quand `models` a joué) et dont l'usage final
      // est étendu (cost + prompt_tokens_details.cached_tokens). Capture le
      // body pour vérifier models/provider/usage produits par chat.send.
      if (req.url === "/v1-routed/chat/completions" && req.method === "POST") {
        lastRoutedChatBody = bodyJson;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        sseChunk(res, {
          model: "b",
          choices: [{ index: 0, delta: { content: "Routé" }, finish_reason: null }],
        });
        sseChunk(res, {
          model: "b",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 5,
            cost: 0.000123,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // R2 : faux classificateur LLM — complétion NON streamée qui répond
      // toujours « complexe » (spec R2 §5.1) ; capture le body.
      if (req.url === "/v1-classifier/chat/completions" && req.method === "POST") {
        lastClassifierBody = bodyJson;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "complexe" } }] }));
        return;
      }

      // R4 : faux résumeur (context.compact) — complétion NON streamée qui
      // renvoie un résumé fixe ; capture le body.
      if (req.url === "/v1-compact/chat/completions" && req.method === "POST") {
        lastCompactBody = bodyJson;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "Résumé factuel de la conversation de test." } }],
          }),
        );
        return;
      }

      // R2 : classificateur trop lent (spec R2 §5.2) — ne répond qu'après
      // ~4,5 s, le timeout de 3 s du routeur doit replier sur l'heuristique
      // AVANT (le timer est nettoyé quand le sidecar abandonne la connexion).
      if (req.url === "/v1-classifier-slow/chat/completions" && req.method === "POST") {
        const timer = setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "complexe" } }] }));
        }, 4500);
        res.on("close", () => clearTimeout(timer));
        return;
      }

      // Toute requête sous /v1-401/ répond 401 avec un corps JSON d'erreur.
      if (req.url.startsWith("/v1-401/")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key provided" } }));
        return;
      }

      // Route lente : un delta toutes les 400ms, pour tester l'abort.
      if (req.url === "/v1-slow/chat/completions" && req.method === "POST") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const deltas = ["un", "deux", "trois"];
        let i = 0;
        const sendNext = () => {
          if (i < deltas.length) {
            res.write(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: deltas[i] }, finish_reason: null }],
              })}\n\n`,
            );
            i++;
            setTimeout(sendNext, 400);
          } else {
            res.write(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }
        };
        setTimeout(sendNext, 400);
        return;
      }

      // Route agentique pour les tests Lot 6 (neutral.start). Le premier message
      // "user" porte une commande JSON ({op:...}) qui pilote le scénario ; les
      // tours suivants (dernier message role:"tool") renvoient un texte final qui
      // fait écho au contenu du tool_result reçu, pour vérifier ce que le sidecar
      // a effectivement envoyé dans l'historique.
      if (req.url === "/v1-neutral/chat/completions" && req.method === "POST") {
        lastNeutralBody = bodyJson;
        const messages = bodyJson && Array.isArray(bodyJson.messages) ? bodyJson.messages : [];
        const userMsg = messages.find((m) => m && m.role === "user");
        let op = {};
        try {
          op = userMsg ? JSON.parse(userMsg.content) : {};
        } catch {
          op = {};
        }
        const last = messages[messages.length - 1];

        if (op.op === "list_dir_loop") {
          neutralLoopCallCount++;
          sendToolCallResponse(res, { id: `call-loop-${neutralLoopCallCount}`, name: "list_dir", args: { path: "." } });
          return;
        }

        if (last && last.role === "tool") {
          sendFinalTextResponse(res, `TOOL_RESULT:${last.content}`);
          return;
        }

        if (op.op === "read_file") {
          sendToolCallResponse(res, { id: "call-1", name: "read_file", args: { path: op.path } });
          return;
        }
        if (op.op === "write_file") {
          sendToolCallResponse(res, {
            id: "call-1",
            name: "write_file",
            args: { path: op.path, content: op.content },
          });
          return;
        }
        if (op.op === "edit_file") {
          sendToolCallResponse(res, {
            id: "call-1",
            name: "edit_file",
            args: { path: op.path, old_string: op.old_string, new_string: op.new_string },
          });
          return;
        }
        if (op.op === "traversal") {
          sendToolCallResponse(res, { id: "call-1", name: op.tool, args: op.args });
          return;
        }
        // R5 — le faux modèle appelle l'outil search_knowledge (RAG local).
        if (op.op === "search_knowledge") {
          sendToolCallResponse(res, { id: "call-1", name: "search_knowledge", args: { query: op.query, topK: op.topK } });
          return;
        }
        // R6-A — réponse finale directe avec usage ÉTENDU (cost + cached_tokens),
        // comme OpenRouter quand usage:{include:true} a été demandé.
        if (op.op === "final_cost") {
          sendFinalTextResponse(res, "coût compté", { cost: 0.00005, prompt_tokens_details: { cached_tokens: 2 } });
          return;
        }

        sendFinalTextResponse(res, "no-op");
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "route inconnue" }));
    });
  });

  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const mockPort = mockServer.address().port;
  const mockBase = `http://127.0.0.1:${mockPort}`;

  // -----------------------------------------------------------------------
  // Serveur mock imitant l'API NATIVE Ollama (SANS /v1) pour ollama.ps/load/
  // unload. Déclaré avec un baseUrl à suffixe /v1 (comme un vrai provider
  // Ollama) : le sidecar doit dériver la base native en interne.
  // -----------------------------------------------------------------------
  let lastOllamaGenerateBody = null;
  // R5 — faux serveur d'embeddings (POST /api/embed, API native) : compte les
  // entrées embeddées (test d'incrémentalité) et renvoie des vecteurs
  // DÉTERMINISTES dimension 4 : [nb "alpha", nb "beta", nb "gamma", 1] — la
  // constante finale garantit une norme non nulle pour le cosinus.
  let embedInputsTotal = 0;
  let lastEmbedBody = null;
  function fakeEmbedding(text) {
    const count = (needle) => text.split(needle).length - 1;
    return [count("alpha"), count("beta"), count("gamma"), 1];
  }
  const ollamaServer = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let bodyJson = null;
      try {
        bodyJson = raw ? JSON.parse(raw) : null;
      } catch {
        bodyJson = null;
      }

      if (req.url === "/api/ps" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                name: "qwen3:4b",
                model: "qwen3:4b",
                size: 4000000000,
                size_vram: 3500000000,
                expires_at: "2026-07-19T20:00:00Z",
              },
            ],
          }),
        );
        return;
      }

      if (req.url === "/api/generate" && req.method === "POST") {
        lastOllamaGenerateBody = bodyJson;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: bodyJson && bodyJson.model, done: true }));
        return;
      }

      if (req.url === "/api/embed" && req.method === "POST") {
        lastEmbedBody = bodyJson;
        const inputs = bodyJson && Array.isArray(bodyJson.input) ? bodyJson.input : [];
        embedInputsTotal += inputs.length;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: bodyJson && bodyJson.model,
            embeddings: inputs.map((s) => fakeEmbedding(String(s))),
          }),
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "route inconnue" }));
    });
  });
  await new Promise((resolve) => ollamaServer.listen(0, "127.0.0.1", resolve));
  const ollamaPort = ollamaServer.address().port;
  const ollamaBase = `http://127.0.0.1:${ollamaPort}`;

  // Répertoire temporaire pour les tests Lot 6 (outils fichiers du moteur neutre).
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-neutral-"));
  // R5 — faux projets pour les tests knowledge.* (index d'embeddings local).
  const knowledgeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-knowledge-"));
  const forgedDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-knowledge-forge-"));

  try {
    // 1. ready au démarrage
    const ready = await waitFor((e) => e.event === "ready", 3000, "ready");
    assert(ready.data && ready.data.version === "0.1.0", "ready.data.version doit valoir 0.1.0");
    assert(typeof ready.data.pid === "number" && ready.data.pid === child.pid, "ready.data.pid doit être le pid du process");

    // 2. ping -> done avec pong:true
    send({ id: "p1", method: "ping", params: {} });
    const d1 = await waitFor((e) => e.id === "p1" && e.event === "done", 3000, "done de ping p1");
    assert(d1.data && d1.data.pong === true, "ping doit répondre data.pong === true");

    // 3. stream.echo "un deux trois" delayMs:10 -> 3 chunks puis done
    send({ id: "e1", method: "stream.echo", params: { text: "un deux trois", delayMs: 10 } });
    const doneE1 = await waitFor(
      (e) => e.id === "e1" && (e.event === "done" || e.event === "error"),
      3000,
      "done de stream.echo e1",
    );
    assert(doneE1.event === "done", `stream.echo e1 attendu 'done', reçu '${doneE1.event}'`);
    const chunksE1 = received.filter((e) => e.id === "e1" && e.event === "chunk");
    assert(chunksE1.length === 3, `stream.echo e1 attendu 3 chunks, reçu ${chunksE1.length}`);
    const textE1 = chunksE1.map((c) => c.data.text).join("").trim();
    assert(textE1 === "un deux trois", `texte reconstitué incorrect: "${textE1}"`);

    // 4. ligne non-JSON sur stdin -> le process ne meurt pas, un ping suivant répond toujours
    child.stdin.write("pas du json\n");
    await new Promise((r) => setTimeout(r, 50));
    assert(child.exitCode === null, "le sidecar ne doit pas crasher sur une entrée invalide");
    send({ id: "p2", method: "ping", params: {} });
    const d2 = await waitFor((e) => e.id === "p2" && e.event === "done", 3000, "done de ping p2");
    assert(d2.data && d2.data.pong === true, "ping p2 doit répondre data.pong === true après entrée invalide");

    // 5. deux stream.echo concurrents avec des id différents
    send({ id: "c1", method: "stream.echo", params: { text: "alpha beta gamma delta", delayMs: 30 } });
    send({ id: "c2", method: "stream.echo", params: { text: "x y", delayMs: 5 } });

    const [doneC1, doneC2] = await Promise.all([
      waitFor((e) => e.id === "c1" && (e.event === "done" || e.event === "error"), 4000, "done de c1"),
      waitFor((e) => e.id === "c2" && (e.event === "done" || e.event === "error"), 4000, "done de c2"),
    ]);
    assert(doneC1.event === "done", "c1 doit se terminer par 'done'");
    assert(doneC2.event === "done", "c2 doit se terminer par 'done'");

    const chunksC1 = received.filter((e) => e.id === "c1" && e.event === "chunk");
    const chunksC2 = received.filter((e) => e.id === "c2" && e.event === "chunk");
    assert(chunksC1.length === 4, `c1 attendu 4 chunks, reçu ${chunksC1.length}`);
    assert(chunksC2.length === 2, `c2 attendu 2 chunks, reçu ${chunksC2.length}`);
    assert(
      chunksC1.map((c) => c.data.text).join("").trim() === "alpha beta gamma delta",
      "texte reconstitué de c1 incorrect",
    );
    assert(chunksC2.map((c) => c.data.text).join("").trim() === "x y", "texte reconstitué de c2 incorrect");

    // c2 (delayMs plus court) doit se terminer avant ou en même temps que c1 : preuve que le
    // traitement est concurrent et non mis en file (sinon c2 attendrait la fin de c1, ~90ms).
    const idxDoneC1 = received.indexOf(doneC1);
    const idxDoneC2 = received.indexOf(doneC2);
    assert(idxDoneC2 < idxDoneC1, "c2 (delayMs court) devrait se terminer avant c1 (delayMs long) si le traitement est concurrent");

    // text manquant/vide -> error
    send({ id: "err1", method: "stream.echo", params: {} });
    const errDone = await waitFor((e) => e.id === "err1" && e.event === "error", 3000, "error pour text manquant");
    assert(typeof errDone.data.message === "string" && errDone.data.message.length > 0, "error doit contenir un message");

    // ---------------------------------------------------------------------
    // Lot 1 : providers.set / models.list / chat.send / chat.abort
    // ---------------------------------------------------------------------

    // providers.set -> done avec count
    send({
      id: "ps1",
      method: "providers.set",
      params: {
        providers: [
          {
            id: "mock",
            label: "Mock",
            baseUrl: `${mockBase}/v1`,
            apiKey: MOCK_API_KEY,
            headers: { "X-Custom": MOCK_CUSTOM_HEADER },
          },
          { id: "unauthorized", label: "Unauthorized", baseUrl: `${mockBase}/v1-401` },
          { id: "slow", label: "Slow", baseUrl: `${mockBase}/v1-slow` },
          { id: "neutral", label: "Neutral agent mock", baseUrl: `${mockBase}/v1-neutral` },
          { id: "ollama-mock", label: "Ollama mock", baseUrl: `${ollamaBase}/v1` },
          // R0 : provider avec les trois réglages de routage OpenRouter.
          {
            id: "routed",
            label: "Routed",
            baseUrl: `${mockBase}/v1-routed`,
            fallbackModels: ["b", "a"],
            priceSort: true,
            usageAccounting: true,
          },
          // R2 : faux classificateurs LLM du routeur (voir le bloc de tests R2).
          { id: "classifier-ok", label: "Classifier OK", baseUrl: `${mockBase}/v1-classifier` },
          { id: "classifier-slow", label: "Classifier lent", baseUrl: `${mockBase}/v1-classifier-slow` },
          // R4 : faux résumeur de context.compact (voir le bloc de tests R4).
          { id: "compacteur", label: "Compacteur", baseUrl: `${mockBase}/v1-compact` },
          // R0 : réglages mal formés -> ignorés sans erreur (validation souple),
          // le provider reste utilisable (voir cs-bad plus bas).
          {
            id: "badfallback",
            label: "Bad fallback",
            baseUrl: `${mockBase}/v1`,
            apiKey: MOCK_API_KEY,
            headers: { "X-Custom": MOCK_CUSTOM_HEADER },
            fallbackModels: { pas: "un tableau" },
            priceSort: "oui",
            usageAccounting: 1,
          },
        ],
      },
    });
    const donePs1 = await waitFor((e) => e.id === "ps1" && e.event === "done", 3000, "done de providers.set");
    assert(
      donePs1.data && donePs1.data.count === 10,
      `providers.set doit répondre count:10, reçu ${JSON.stringify(donePs1.data)}`,
    );

    // models.list ok
    send({ id: "ml1", method: "models.list", params: { providerId: "mock" } });
    const doneMl1 = await waitFor(
      (e) => e.id === "ml1" && (e.event === "done" || e.event === "error"),
      3000,
      "models.list ml1",
    );
    assert(
      doneMl1.event === "done",
      `models.list ml1 attendu 'done', reçu '${doneMl1.event}': ${JSON.stringify(doneMl1.data)}`,
    );
    assert(
      Array.isArray(doneMl1.data.models) && doneMl1.data.models.length === 2,
      `models.list doit renvoyer 2 modèles, reçu ${JSON.stringify(doneMl1.data)}`,
    );
    assert(
      doneMl1.data.models[0].id === "model-a" && doneMl1.data.models[1].id === "model-b",
      `ids des modèles incorrects: ${JSON.stringify(doneMl1.data.models)}`,
    );

    // models.list provider inconnu -> error
    send({ id: "ml2", method: "models.list", params: { providerId: "does-not-exist" } });
    const errMl2 = await waitFor(
      (e) => e.id === "ml2" && e.event === "error",
      3000,
      "models.list ml2 erreur provider inconnu",
    );
    assert(
      typeof errMl2.data.message === "string" && errMl2.data.message.length > 0,
      "models.list provider inconnu doit renvoyer un message d'erreur",
    );

    // ---------------------------------------------------------------------
    // models.detail
    // ---------------------------------------------------------------------

    // models.detail ok : conserve name/contextLength/pricing/description quand présents,
    // convertit le pricing OpenRouter ($/token, chaînes) en $/million (nombres), et omet
    // les champs absents (model-b n'a ni pricing, ni name, ni description, ni context_length).
    send({ id: "md1", method: "models.detail", params: { providerId: "mock" } });
    const doneMd1 = await waitFor(
      (e) => e.id === "md1" && (e.event === "done" || e.event === "error"),
      3000,
      "models.detail md1",
    );
    assert(
      doneMd1.event === "done",
      `models.detail md1 attendu 'done', reçu '${doneMd1.event}': ${JSON.stringify(doneMd1.data)}`,
    );
    const detailModels = doneMd1.data && doneMd1.data.models;
    assert(
      Array.isArray(detailModels) && detailModels.length === 2,
      `models.detail doit renvoyer 2 modèles, reçu ${JSON.stringify(doneMd1.data)}`,
    );
    const [detailA, detailB] = detailModels;
    assert(
      detailA.id === "model-a" && detailB.id === "model-b",
      `models.detail doit conserver l'ordre de l'API (model-a puis model-b), reçu ${JSON.stringify(detailModels)}`,
    );
    assert(detailA.name === "Model A", `models.detail model-a.name incorrect: ${JSON.stringify(detailA)}`);
    assert(
      detailA.description === "Modèle de démo avec tarification OpenRouter",
      `models.detail model-a.description incorrect: ${JSON.stringify(detailA)}`,
    );
    assert(
      detailA.contextLength === 128000,
      `models.detail model-a.contextLength incorrect: ${JSON.stringify(detailA)}`,
    );
    assert(
      detailA.pricing &&
        typeof detailA.pricing.promptUsdPerM === "number" &&
        typeof detailA.pricing.completionUsdPerM === "number",
      `models.detail model-a.pricing doit contenir des nombres: ${JSON.stringify(detailA)}`,
    );
    assert(
      detailA.pricing.promptUsdPerM === 3,
      `models.detail model-a.pricing.promptUsdPerM doit valoir 3 (0.000003 $/token -> $/M), reçu ${detailA.pricing.promptUsdPerM}`,
    );
    assert(
      detailA.pricing.completionUsdPerM === 15,
      `models.detail model-a.pricing.completionUsdPerM doit valoir 15 (0.000015 $/token -> $/M), reçu ${detailA.pricing.completionUsdPerM}`,
    );
    // model-b : aucune métadonnée dans la réponse mock -> tous les champs optionnels omis,
    // sans erreur ni NaN.
    assert(
      detailB.name === undefined &&
        detailB.contextLength === undefined &&
        detailB.pricing === undefined &&
        detailB.description === undefined,
      `models.detail model-b doit omettre tous les champs optionnels, reçu ${JSON.stringify(detailB)}`,
    );

    // models.detail provider inconnu -> error (même comportement que models.list)
    send({ id: "md2", method: "models.detail", params: { providerId: "does-not-exist" } });
    const errMd2 = await waitFor(
      (e) => e.id === "md2" && e.event === "error",
      3000,
      "models.detail md2 erreur provider inconnu",
    );
    assert(
      typeof errMd2.data.message === "string" && errMd2.data.message.length > 0,
      "models.detail provider inconnu doit renvoyer un message d'erreur",
    );

    // ---------------------------------------------------------------------
    // usage.openrouter (mini-tranche du Lot 8)
    // ---------------------------------------------------------------------

    // usage.openrouter ok
    send({ id: "uo1", method: "usage.openrouter", params: { providerId: "mock" } });
    const doneUo1 = await waitFor(
      (e) => e.id === "uo1" && (e.event === "done" || e.event === "error"),
      3000,
      "usage.openrouter uo1",
    );
    assert(
      doneUo1.event === "done",
      `usage.openrouter uo1 attendu 'done', reçu '${doneUo1.event}': ${JSON.stringify(doneUo1.data)}`,
    );
    assert(
      doneUo1.data.totalCredits === 100 && doneUo1.data.totalUsage === 37 && doneUo1.data.remaining === 63,
      `usage.openrouter uo1 données incorrectes: ${JSON.stringify(doneUo1.data)}`,
    );

    // usage.openrouter provider sans clé API -> error
    send({ id: "uo2", method: "usage.openrouter", params: { providerId: "unauthorized" } });
    const errUo2 = await waitFor(
      (e) => e.id === "uo2" && e.event === "error",
      3000,
      "usage.openrouter uo2 erreur clé absente",
    );
    assert(
      typeof errUo2.data.message === "string" && errUo2.data.message.length > 0,
      "usage.openrouter sans clé API doit renvoyer un message d'erreur lisible",
    );

    // chat.send flux complet : chunks concaténés = texte attendu, done avec finishReason + usage
    send({
      id: "cs1",
      method: "chat.send",
      params: {
        providerId: "mock",
        model: "model-a",
        messages: [{ role: "user", content: "Bonjour" }],
      },
    });
    const doneCs1 = await waitFor(
      (e) => e.id === "cs1" && (e.event === "done" || e.event === "error"),
      3000,
      "chat.send cs1",
    );
    assert(
      doneCs1.event === "done",
      `chat.send cs1 attendu 'done', reçu '${doneCs1.event}': ${JSON.stringify(doneCs1.data)}`,
    );
    const chunksCs1 = received.filter((e) => e.id === "cs1" && e.event === "chunk");
    const textCs1 = chunksCs1.map((c) => c.data.delta).join("");
    assert(textCs1 === "Bonjour le monde", `texte reconstitué chat.send incorrect: "${textCs1}"`);
    assert(
      doneCs1.data.finishReason === "stop",
      `finishReason attendu 'stop', reçu ${JSON.stringify(doneCs1.data.finishReason)}`,
    );
    assert(
      doneCs1.data.usage &&
        doneCs1.data.usage.promptTokens === 7 &&
        doneCs1.data.usage.completionTokens === 3,
      `usage incorrect: ${JSON.stringify(doneCs1.data.usage)}`,
    );

    // ---------------------------------------------------------------------
    // R0 — réglages de routage OpenRouter (docs/spec-r0-openrouter.md §7)
    // ---------------------------------------------------------------------

    // R0 test 1 : provider SANS réglages -> body strictement identique à
    // aujourd'hui (ni models, ni provider, ni usage — mêmes clés qu'avant).
    assert(lastChatCompletionsBody, "le mock doit avoir capturé le body de cs1");
    const cs1BodyKeys = Object.keys(lastChatCompletionsBody).sort();
    assert(
      JSON.stringify(cs1BodyKeys) === JSON.stringify(["messages", "model", "stream", "stream_options"]),
      `body cs1 : clés inattendues (rétrocompat cassée) : ${JSON.stringify(cs1BodyKeys)}`,
    );
    // Flux SSE sans champ `model` -> modelUsed null, usage étendu à null.
    assert(
      doneCs1.data.modelUsed === null,
      `cs1 modelUsed doit valoir null (aucun champ model dans le flux), reçu ${JSON.stringify(doneCs1.data.modelUsed)}`,
    );
    assert(
      doneCs1.data.usage.costUsd === null && doneCs1.data.usage.cachedTokens === null,
      `cs1 costUsd/cachedTokens doivent valoir null, reçu ${JSON.stringify(doneCs1.data.usage)}`,
    );

    // R0 tests 2/3/4 : provider avec fallbackModels ["b","a"], priceSort et
    // usageAccounting ; modèle demandé "a".
    send({
      id: "cs-r0",
      method: "chat.send",
      params: {
        providerId: "routed",
        model: "a",
        messages: [{ role: "user", content: "salut" }],
        // R1 (spec §5.5) : meta.routeTier relayé tel quel vers events.jsonl.
        meta: { source: "chat", conversationId: "conv-r1", routeTier: "simple" },
      },
    });
    const doneCsR0 = await waitFor(
      (e) => e.id === "cs-r0" && (e.event === "done" || e.event === "error"),
      3000,
      "chat.send cs-r0",
    );
    assert(
      doneCsR0.event === "done",
      `chat.send cs-r0 attendu 'done', reçu '${doneCsR0.event}': ${JSON.stringify(doneCsR0.data)}`,
    );
    // Test 2 : body avec models dédupliqué (demandé en tête), provider, usage.
    assert(lastRoutedChatBody, "le mock doit avoir capturé le body de cs-r0");
    assert(
      JSON.stringify(lastRoutedChatBody.models) === JSON.stringify(["a", "b"]),
      `cs-r0 body.models attendu ["a","b"], reçu ${JSON.stringify(lastRoutedChatBody.models)}`,
    );
    assert(
      JSON.stringify(lastRoutedChatBody.provider) === JSON.stringify({ sort: "price" }),
      `cs-r0 body.provider attendu {sort:"price"}, reçu ${JSON.stringify(lastRoutedChatBody.provider)}`,
    );
    assert(
      JSON.stringify(lastRoutedChatBody.usage) === JSON.stringify({ include: true }),
      `cs-r0 body.usage attendu {include:true}, reçu ${JSON.stringify(lastRoutedChatBody.usage)}`,
    );
    assert(
      lastRoutedChatBody.model === "a",
      `cs-r0 body.model doit rester le modèle demandé, reçu ${JSON.stringify(lastRoutedChatBody.model)}`,
    );
    // Test 3 : modelUsed capturé depuis les chunks SSE (champ model: "b").
    assert(
      doneCsR0.data.modelUsed === "b",
      `cs-r0 modelUsed attendu "b", reçu ${JSON.stringify(doneCsR0.data.modelUsed)}`,
    );
    // Test 4 : usage étendu complet dans le done.
    assert(
      doneCsR0.data.usage &&
        doneCsR0.data.usage.promptTokens === 11 &&
        doneCsR0.data.usage.completionTokens === 5 &&
        doneCsR0.data.usage.costUsd === 0.000123 &&
        doneCsR0.data.usage.cachedTokens === 4,
      `cs-r0 usage étendu incorrect: ${JSON.stringify(doneCsR0.data.usage)}`,
    );
    // Test 4 (suite) : événement JSONL avec modelUsed/costUsd/cachedTokens
    // remplis (append asynchrone non bloquant -> petite boucle d'attente).
    const eventsFile = path.join(
      defaultXdgConfigHome,
      "net.duvam.iaction",
      "usage",
      "events.jsonl",
    );
    let r0Event = null;
    for (let attempt = 0; attempt < 40 && !r0Event; attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      const rawEvents = await fsp.readFile(eventsFile, "utf8").catch(() => "");
      for (const line of rawEvents.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.providerId === "routed" && ev.method === "chat.send") r0Event = ev;
        } catch {
          // ligne illisible : ignorée (même tolérance que le sidecar).
        }
      }
    }
    assert(r0Event, "events.jsonl doit contenir l'événement du tour cs-r0");
    assert(
      r0Event.modelUsed === "b" && r0Event.costUsd === 0.000123 && r0Event.cachedTokens === 4,
      `événement cs-r0 : modelUsed/costUsd/cachedTokens incorrects: ${JSON.stringify(r0Event)}`,
    );
    // R1 (spec §5.5) : le meta.routeTier du chat.send est persisté dans la ligne JSONL.
    assert(
      r0Event.routeTier === "simple",
      `événement cs-r0 : routeTier attendu "simple", reçu ${JSON.stringify(r0Event.routeTier)}`,
    );
    assert(
      r0Event.source === "chat" && r0Event.conversationId === "conv-r1",
      `événement cs-r0 : source/conversationId incorrects: ${JSON.stringify(r0Event)}`,
    );

    // R0 test 5 : fallbackModels mal formé (pas un tableau de chaînes) ->
    // ignoré sans erreur par providers.set (count:7 déjà vérifié), et le
    // provider reste utilisable avec un body sans réglages.
    send({
      id: "cs-bad",
      method: "chat.send",
      params: {
        providerId: "badfallback",
        model: "model-a",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const doneCsBad = await waitFor(
      (e) => e.id === "cs-bad" && (e.event === "done" || e.event === "error"),
      3000,
      "chat.send cs-bad",
    );
    assert(
      doneCsBad.event === "done",
      `chat.send cs-bad attendu 'done', reçu '${doneCsBad.event}': ${JSON.stringify(doneCsBad.data)}`,
    );
    const textCsBad = received
      .filter((e) => e.id === "cs-bad" && e.event === "chunk")
      .map((c) => c.data.delta)
      .join("");
    assert(textCsBad === "Bonjour le monde", `texte reconstitué cs-bad incorrect: "${textCsBad}"`);
    const csBadBodyKeys = Object.keys(lastChatCompletionsBody).sort();
    assert(
      JSON.stringify(csBadBodyKeys) === JSON.stringify(["messages", "model", "stream", "stream_options"]),
      `body cs-bad : les réglages mal formés ne doivent produire aucun champ nouveau : ${JSON.stringify(csBadBodyKeys)}`,
    );

    // ---------------------------------------------------------------------
    // R6-A — plafond de débord réellement compté, bout en bout (SANS forger
    // events.jsonl) : un tour meta.routeDebord doit écrire un événement
    // routeDebord:true avec un costUsd non nul, et autoDebordCostUsdThisMonth
    // (exposé par usage.stats.routage.debordMoisUsd) doit le compter.
    // ---------------------------------------------------------------------

    // Événement d'un chat.send débordé (le mock "routed" renvoie usage.cost).
    send({
      id: "cs-r6",
      method: "chat.send",
      params: {
        providerId: "routed",
        model: "a",
        messages: [{ role: "user", content: "salut" }],
        meta: { source: "chat", conversationId: "conv-r6", routeTier: "simple", routeDebord: true },
      },
    });
    const doneCsR6 = await waitFor(
      (e) => e.id === "cs-r6" && (e.event === "done" || e.event === "error"),
      3000,
      "chat.send cs-r6",
    );
    assert(
      doneCsR6.event === "done",
      `chat.send cs-r6 attendu 'done', reçu '${doneCsR6.event}': ${JSON.stringify(doneCsR6.data)}`,
    );
    let r6ChatEvent = null;
    for (let attempt = 0; attempt < 40 && !r6ChatEvent; attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      const rawEvents = await fsp.readFile(eventsFile, "utf8").catch(() => "");
      for (const line of rawEvents.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.conversationId === "conv-r6" && ev.method === "chat.send") r6ChatEvent = ev;
        } catch {
          // ligne illisible : ignorée (même tolérance que le sidecar).
        }
      }
    }
    assert(r6ChatEvent, "events.jsonl doit contenir l'événement du tour cs-r6");
    assert(
      r6ChatEvent.routeDebord === true && r6ChatEvent.costUsd === 0.000123,
      `événement cs-r6 : routeDebord:true + costUsd non nul attendus, reçu ${JSON.stringify(r6ChatEvent)}`,
    );

    // Usage FORCÉ même sans usageAccounting : provider "mock" (aucun réglage
    // R0) + meta.routeDebord -> body.usage = {include:true} quand même (le
    // plafond ne doit pas dépendre d'une case à cocher du provider).
    send({
      id: "cs-r6b",
      method: "chat.send",
      params: {
        providerId: "mock",
        model: "model-a",
        messages: [{ role: "user", content: "salut" }],
        meta: { conversationId: "conv-r6b", routeTier: "simple", routeDebord: true },
      },
    });
    const doneCsR6b = await waitFor(
      (e) => e.id === "cs-r6b" && (e.event === "done" || e.event === "error"),
      3000,
      "chat.send cs-r6b",
    );
    assert(doneCsR6b.event === "done", `chat.send cs-r6b attendu 'done', reçu '${doneCsR6b.event}'`);
    assert(
      JSON.stringify(lastChatCompletionsBody.usage) === JSON.stringify({ include: true }),
      `body cs-r6b : usage {include:true} FORCÉ par meta.routeDebord attendu, reçu ${JSON.stringify(lastChatCompletionsBody.usage)}`,
    );

    // neutral.start débordé (mock outillé /v1-neutral, op final_cost) : usage
    // forcé dans le body (provider "neutral" sans usageAccounting) et
    // costUsd/cachedTokens cumulés dans l'événement.
    send({
      id: "n-r6",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        messages: [{ role: "user", content: JSON.stringify({ op: "final_cost" }) }],
        meta: { source: "projets", conversationId: "conv-r6n", routeTier: "simple", routeDebord: true },
      },
    });
    const doneNR6 = await waitFor(
      (e) => e.id === "n-r6" && (e.event === "done" || e.event === "error"),
      3000,
      "neutral.start n-r6",
    );
    assert(
      doneNR6.event === "done" && doneNR6.data.subtype === "success",
      `neutral.start n-r6 attendu done/success, reçu ${JSON.stringify(doneNR6.data)}`,
    );
    assert(
      lastNeutralBody && JSON.stringify(lastNeutralBody.usage) === JSON.stringify({ include: true }),
      `body n-r6 : usage {include:true} FORCÉ par meta.routeDebord attendu, reçu ${JSON.stringify(lastNeutralBody && lastNeutralBody.usage)}`,
    );
    let r6NeutralEvent = null;
    for (let attempt = 0; attempt < 40 && !r6NeutralEvent; attempt++) {
      await new Promise((r) => setTimeout(r, 50));
      const rawEvents = await fsp.readFile(eventsFile, "utf8").catch(() => "");
      for (const line of rawEvents.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.conversationId === "conv-r6n" && ev.method === "neutral.start") r6NeutralEvent = ev;
        } catch {
          // ligne illisible : ignorée.
        }
      }
    }
    assert(r6NeutralEvent, "events.jsonl doit contenir l'événement du tour n-r6");
    assert(
      r6NeutralEvent.routeDebord === true && r6NeutralEvent.costUsd === 0.00005 && r6NeutralEvent.cachedTokens === 2,
      `événement n-r6 : routeDebord/costUsd/cachedTokens incorrects: ${JSON.stringify(r6NeutralEvent)}`,
    );

    // La dépense de débord du mois compte les DEUX tours débordés ci-dessus
    // (0.000123 + 0.00005) — cs-r6b, sans coût remonté, n'ajoute rien.
    send({ id: "us-r6", method: "usage.stats", params: {} });
    const doneUsR6 = await waitFor((e) => e.id === "us-r6" && e.event === "done", 3000, "usage.stats us-r6");
    assert(
      doneUsR6.data.routage && Math.abs(doneUsR6.data.routage.debordMoisUsd - 0.000173) < 1e-9,
      `us-r6 : debordMoisUsd attendu ~0.000173, reçu ${JSON.stringify(doneUsR6.data.routage && doneUsR6.data.routage.debordMoisUsd)}`,
    );

    // chat.send vers un provider qui répond 401 -> error avec statut + extrait du corps
    send({
      id: "cs2",
      method: "chat.send",
      params: {
        providerId: "unauthorized",
        model: "model-x",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    const errCs2 = await waitFor((e) => e.id === "cs2" && e.event === "error", 3000, "chat.send cs2 erreur 401");
    assert(
      errCs2.data.message.includes("401"),
      `message d'erreur doit contenir le statut 401: ${errCs2.data.message}`,
    );
    assert(
      errCs2.data.message.includes("invalid api key"),
      `message d'erreur doit contenir un extrait du corps: ${errCs2.data.message}`,
    );

    // chat.abort pendant un stream lent -> done finishReason:"aborted" + chat.abort -> done {aborted:true}
    send({
      id: "cs-slow",
      method: "chat.send",
      params: {
        providerId: "slow",
        model: "model-x",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    await new Promise((r) => setTimeout(r, 150)); // avant le premier delta (émis à 400ms)
    send({ id: "ab1", method: "chat.abort", params: { targetId: "cs-slow" } });
    const doneAb1 = await waitFor((e) => e.id === "ab1" && e.event === "done", 3000, "chat.abort ab1");
    assert(
      doneAb1.data.aborted === true,
      `chat.abort ab1 doit répondre aborted:true, reçu ${JSON.stringify(doneAb1.data)}`,
    );
    const doneCsSlow = await waitFor(
      (e) => e.id === "cs-slow" && (e.event === "done" || e.event === "error"),
      3000,
      "chat.send cs-slow après abort",
    );
    assert(
      doneCsSlow.event === "done",
      `cs-slow doit se terminer par 'done', reçu '${doneCsSlow.event}': ${JSON.stringify(doneCsSlow.data)}`,
    );
    assert(
      doneCsSlow.data.finishReason === "aborted",
      `cs-slow finishReason attendu 'aborted', reçu ${JSON.stringify(doneCsSlow.data.finishReason)}`,
    );

    // chat.abort sur un id inconnu -> done {aborted:false}
    send({ id: "ab2", method: "chat.abort", params: { targetId: "id-inconnu" } });
    const doneAb2 = await waitFor((e) => e.id === "ab2" && e.event === "done", 3000, "chat.abort ab2 id inconnu");
    assert(
      doneAb2.data.aborted === false,
      `chat.abort sur id inconnu doit répondre aborted:false, reçu ${JSON.stringify(doneAb2.data)}`,
    );

    // ---------------------------------------------------------------------
    // R4 — économie de contexte (docs/spec-r4-contexte.md §4.1) :
    // context.compact via le faux résumeur, cas nominal puis erreur serveur.
    // ---------------------------------------------------------------------

    // Cas nominal : 6 messages, keepLast:2 -> les 4 premiers sont résumés
    // (coveredTurns:4), complétion NON streamée avec prompt système français.
    send({
      id: "cx1",
      method: "context.compact",
      params: {
        providerId: "compacteur",
        model: "resumeur-local",
        messages: [
          { role: "user", content: "Premier message sur le fichier src/a.ts" },
          { role: "assistant", content: "Réponse un" },
          { role: "user", content: "Deuxième message" },
          { role: "assistant", content: "Réponse deux" },
          { role: "user", content: "Tour récent à garder intact" },
          { role: "assistant", content: "Réponse récente à garder intacte" },
        ],
        keepLast: 2,
      },
    });
    const doneCx1 = await waitFor(
      (e) => e.id === "cx1" && (e.event === "done" || e.event === "error"),
      3000,
      "context.compact cx1",
    );
    assert(
      doneCx1.event === "done",
      `context.compact cx1 attendu 'done', reçu '${doneCx1.event}': ${JSON.stringify(doneCx1.data)}`,
    );
    assert(
      doneCx1.data.summary === "Résumé factuel de la conversation de test.",
      `context.compact cx1 : summary du faux serveur attendu, reçu ${JSON.stringify(doneCx1.data)}`,
    );
    assert(
      doneCx1.data.coveredTurns === 4,
      `context.compact cx1 : coveredTurns attendu 4 (6 messages - keepLast 2), reçu ${JSON.stringify(doneCx1.data)}`,
    );
    assert(
      lastCompactBody &&
        lastCompactBody.model === "resumeur-local" &&
        lastCompactBody.stream === false &&
        Array.isArray(lastCompactBody.messages) &&
        lastCompactBody.messages.length === 2 &&
        lastCompactBody.messages[0].role === "system" &&
        /résum/i.test(lastCompactBody.messages[0].content) &&
        /400 mots/.test(lastCompactBody.messages[0].content),
      `context.compact cx1 : corps du résumeur incorrect (non streamé + prompt système français attendu): ${JSON.stringify(lastCompactBody)}`,
    );
    // La transcription soumise porte les messages couverts, PAS les keepLast
    // derniers (gardés intacts côté appelant).
    assert(
      lastCompactBody.messages[1].role === "user" &&
        lastCompactBody.messages[1].content.includes("src/a.ts") &&
        lastCompactBody.messages[1].content.includes("Utilisateur : ") &&
        !lastCompactBody.messages[1].content.includes("Tour récent à garder intact"),
      `context.compact cx1 : transcription soumise incorrecte: ${JSON.stringify(lastCompactBody.messages[1])}`,
    );

    // Erreur serveur (HTTP 401) -> error protocolaire (l'UI n'applique pas la
    // compaction et envoie l'historique intégral).
    send({
      id: "cx2",
      method: "context.compact",
      params: {
        providerId: "unauthorized",
        model: "resumeur-local",
        messages: [{ role: "user", content: "Bonjour" }],
      },
    });
    const errCx2 = await waitFor((e) => e.id === "cx2" && e.event === "error", 3000, "context.compact cx2 erreur 401");
    assert(
      typeof errCx2.data.message === "string" && errCx2.data.message.includes("401"),
      `context.compact cx2 : erreur HTTP 401 attendue, reçu ${JSON.stringify(errCx2.data)}`,
    );

    // Paramètres invalides : provider inconnu / keepLast couvrant tout.
    send({
      id: "cx3",
      method: "context.compact",
      params: { providerId: "does-not-exist", model: "m", messages: [{ role: "user", content: "x" }] },
    });
    const errCx3 = await waitFor((e) => e.id === "cx3" && e.event === "error", 3000, "context.compact cx3");
    assert(
      typeof errCx3.data.message === "string" && errCx3.data.message.includes("fournisseur inconnu"),
      `context.compact cx3 : « fournisseur inconnu » attendu, reçu ${JSON.stringify(errCx3.data)}`,
    );
    send({
      id: "cx4",
      method: "context.compact",
      params: {
        providerId: "compacteur",
        model: "resumeur-local",
        messages: [{ role: "user", content: "x" }],
        keepLast: 5,
      },
    });
    const errCx4 = await waitFor((e) => e.id === "cx4" && e.event === "error", 3000, "context.compact cx4");
    assert(
      typeof errCx4.data.message === "string" && errCx4.data.message.includes("aucun message à résumer"),
      `context.compact cx4 : « aucun message à résumer » attendu, reçu ${JSON.stringify(errCx4.data)}`,
    );

    // Fonctions pures de la logique de compaction (spec §4.2 et §4.3).
    await testContextPure();

    // R5 — fonctions pures du RAG local (chunking, cosinus + topK).
    await testKnowledgePure();

    // ---------------------------------------------------------------------
    // R1 — routeur heuristique (docs/spec-r1-routeur.md §5) : cas unitaires
    // de classify (module compilé), puis router.route/router.set en protocole.
    // ---------------------------------------------------------------------

    await testRouterClassify();

    // Spec §5.2 : router.route SANS router.set préalable -> cible = défauts codés.
    send({ id: "rr1", method: "router.route", params: { text: "Salut, ça va ?" } });
    const doneRr1 = await waitFor(
      (e) => e.id === "rr1" && (e.event === "done" || e.event === "error"),
      3000,
      "router.route rr1",
    );
    assert(
      doneRr1.event === "done",
      `router.route rr1 attendu 'done', reçu '${doneRr1.event}': ${JSON.stringify(doneRr1.data)}`,
    );
    assert(
      doneRr1.data.tier === "trivial" && doneRr1.data.score === 0 && Array.isArray(doneRr1.data.reasons),
      `router.route rr1 tier/score incorrects: ${JSON.stringify(doneRr1.data)}`,
    );
    assert(
      JSON.stringify(doneRr1.data.target) ===
        JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
      `router.route rr1 : cible par défaut du tier trivial attendue, reçu ${JSON.stringify(doneRr1.data.target)}`,
    );

    // router.route sans texte -> error « params.text manquant ou invalide ».
    send({ id: "rr-bad", method: "router.route", params: {} });
    const errRrBad = await waitFor(
      (e) => e.id === "rr-bad" && e.event === "error",
      3000,
      "router.route rr-bad erreur texte manquant",
    );
    assert(
      errRrBad.data.message === "params.text manquant ou invalide",
      `router.route rr-bad : message d'erreur incorrect: ${JSON.stringify(errRrBad.data)}`,
    );

    // Spec §5.3 : router.set partiel — un tier valide + un tier invalide
    // (cible neutre sans providerId) -> fusion défauts, count = 1.
    send({
      id: "rs1",
      method: "router.set",
      params: {
        table: {
          simple: { engine: "neutral", providerId: "mock", model: "model-a" },
          moyen: { engine: "neutral", model: "sans-provider" },
        },
      },
    });
    const doneRs1 = await waitFor((e) => e.id === "rs1" && e.event === "done", 3000, "router.set rs1");
    assert(
      doneRs1.data.count === 1,
      `router.set rs1 : count attendu 1 (un seul tier valide), reçu ${JSON.stringify(doneRs1.data)}`,
    );

    // Spec §5.4 : router.route avec table poussée -> cible poussée (tier simple).
    send({ id: "rr2", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRr2 = await waitFor((e) => e.id === "rr2" && e.event === "done", 3000, "router.route rr2");
    assert(
      doneRr2.data.tier === "simple" && doneRr2.data.score === 2,
      `router.route rr2 tier/score incorrects: ${JSON.stringify(doneRr2.data)}`,
    );
    assert(
      JSON.stringify(doneRr2.data.target) ===
        JSON.stringify({ engine: "neutral", providerId: "mock", model: "model-a" }),
      `router.route rr2 : cible poussée attendue, reçu ${JSON.stringify(doneRr2.data.target)}`,
    );

    // Le tier invalide de rs1 (moyen) est resté au défaut codé.
    // R7 — code (+2) + édition (+3) = score 5 -> moyen (3-6).
    send({
      id: "rr3",
      method: "router.route",
      params: {
        text: "Implémente la fonction suivante dans le module.\n```\nfunction demo() { return 1; }\n```",
      },
    });
    const doneRr3 = await waitFor((e) => e.id === "rr3" && e.event === "done", 3000, "router.route rr3");
    assert(
      doneRr3.data.tier === "moyen",
      `router.route rr3 : tier attendu 'moyen', reçu ${JSON.stringify(doneRr3.data)}`,
    );
    assert(
      JSON.stringify(doneRr3.data.target) === JSON.stringify({ engine: "claude", model: "claude-opus-4-8" }),
      `router.route rr3 : le tier invalide de rs1 doit rester au défaut, reçu ${JSON.stringify(doneRr3.data.target)}`,
    );

    // ---------------------------------------------------------------------
    // R7 — plancher de session (param `minTier`, docs/spec-r7-topdown.md §B.1)
    // ---------------------------------------------------------------------

    // Texte trivial + minTier moyen -> le plancher l'emporte : tier moyen,
    // cible du tier moyen, raison « plancher de session ».
    send({ id: "rr-min1", method: "router.route", params: { text: "Salut, ça va ?", minTier: "moyen" } });
    const doneRrMin1 = await waitFor((e) => e.id === "rr-min1" && e.event === "done", 3000, "router.route rr-min1");
    assert(
      doneRrMin1.data.tier === "moyen" &&
        JSON.stringify(doneRrMin1.data.target) === JSON.stringify({ engine: "claude", model: "claude-opus-4-8" }) &&
        doneRrMin1.data.reasons.includes("plancher de session : moyen"),
      `router.route rr-min1 : plancher moyen attendu, reçu ${JSON.stringify(doneRrMin1.data)}`,
    );

    // Tier classé complexe (score 7) + minTier simple -> la classification
    // l'emporte, aucune raison « plancher ».
    send({
      id: "rr-min2",
      method: "router.route",
      params: {
        text:
          "Implémente la fonction suivante dans le module.\n```\nfunction demo() { return 1; }\n```\n" +
          "du texte descriptif sans marqueur particulier pour gonfler la longueur du message. ".repeat(6),
        minTier: "simple",
      },
    });
    const doneRrMin2 = await waitFor((e) => e.id === "rr-min2" && e.event === "done", 3000, "router.route rr-min2");
    assert(
      doneRrMin2.data.tier === "complexe" &&
        doneRrMin2.data.score === 7 &&
        JSON.stringify(doneRrMin2.data.target) === JSON.stringify({ engine: "claude", model: "claude-fable-5" }) &&
        !doneRrMin2.data.reasons.some((r) => r.includes("plancher de session")),
      `router.route rr-min2 : tier complexe sans raison plancher attendu, reçu ${JSON.stringify(doneRrMin2.data)}`,
    );

    // Tier IMPOSÉ (R3) + minTier : `tier` prime sur la classification, PUIS le
    // plancher s'applique aussi (spec R7 §B.1).
    send({ id: "rr-min3", method: "router.route", params: { text: "Salut", tier: "simple", minTier: "moyen" } });
    const doneRrMin3 = await waitFor((e) => e.id === "rr-min3" && e.event === "done", 3000, "router.route rr-min3");
    assert(
      doneRrMin3.data.tier === "moyen" &&
        doneRrMin3.data.reasons.includes("tier imposé par l'appelant") &&
        doneRrMin3.data.reasons.includes("plancher de session : moyen"),
      `router.route rr-min3 : tier imposé relevé par le plancher attendu, reçu ${JSON.stringify(doneRrMin3.data)}`,
    );

    // Remise aux défauts (table vide -> count 0), pour ne rien laisser derrière.
    send({ id: "rs2", method: "router.set", params: { table: {} } });
    const doneRs2 = await waitFor((e) => e.id === "rs2" && e.event === "done", 3000, "router.set rs2");
    assert(
      doneRs2.data.count === 0,
      `router.set rs2 : count attendu 0 (remise aux défauts), reçu ${JSON.stringify(doneRs2.data)}`,
    );

    // router.set sans table -> error (seule erreur globale possible).
    send({ id: "rs-bad", method: "router.set", params: {} });
    const errRsBad = await waitFor(
      (e) => e.id === "rs-bad" && e.event === "error",
      3000,
      "router.set rs-bad erreur table manquante",
    );
    assert(
      typeof errRsBad.data.message === "string" && errRsBad.data.message.length > 0,
      "router.set sans table doit renvoyer un message d'erreur lisible",
    );

    // ---------------------------------------------------------------------
    // R2 — classificateur LLM + surcharge projet (docs/spec-r2-classificateur.md §5)
    // ---------------------------------------------------------------------

    // Spec R2 §5.1 : score ambigu (2 = 3−1, frontière R7 ±1) + faux
    // classificateur qui répond « complexe » -> tier complexe, method "llm".
    send({
      id: "rs-cls",
      method: "router.set",
      params: { table: {}, classifier: { providerId: "classifier-ok", model: "cls-model" } },
    });
    await waitFor((e) => e.id === "rs-cls" && e.event === "done", 3000, "router.set rs-cls");
    send({ id: "rr-llm", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRrLlm = await waitFor((e) => e.id === "rr-llm" && e.event === "done", 5000, "router.route rr-llm");
    assert(
      doneRrLlm.data.tier === "complexe" && doneRrLlm.data.method === "llm" && doneRrLlm.data.score === 2,
      `router.route rr-llm : tier "complexe"/method "llm" attendus, reçu ${JSON.stringify(doneRrLlm.data)}`,
    );
    assert(
      JSON.stringify(doneRrLlm.data.target) === JSON.stringify({ engine: "claude", model: "claude-fable-5" }),
      `router.route rr-llm : cible du tier complexe attendue, reçu ${JSON.stringify(doneRrLlm.data.target)}`,
    );
    assert(
      Array.isArray(doneRrLlm.data.reasons) && doneRrLlm.data.reasons.includes("classificateur LLM : complexe"),
      `router.route rr-llm : raison du classificateur attendue, reçu ${JSON.stringify(doneRrLlm.data.reasons)}`,
    );
    // Le corps envoyé au classificateur : complétion NON streamée, température
    // 0, max_tokens court, prompt système français en tête.
    assert(lastClassifierBody, "le faux classificateur doit avoir reçu un body");
    assert(
      lastClassifierBody.model === "cls-model" &&
        lastClassifierBody.stream === false &&
        lastClassifierBody.temperature === 0 &&
        typeof lastClassifierBody.max_tokens === "number" &&
        lastClassifierBody.max_tokens <= 8 &&
        Array.isArray(lastClassifierBody.messages) &&
        lastClassifierBody.messages[0].role === "system" &&
        /trivial|simple|moyen|complexe/.test(lastClassifierBody.messages[0].content),
      `body du classificateur inattendu: ${JSON.stringify(lastClassifierBody)}`,
    );

    // allowLlm:false : pas d'appel LLM même sur un score ambigu.
    lastClassifierBody = null;
    send({
      id: "rr-nollm",
      method: "router.route",
      params: { text: "Explique pourquoi ce test échoue", allowLlm: false },
    });
    const doneRrNoLlm = await waitFor((e) => e.id === "rr-nollm" && e.event === "done", 3000, "router.route rr-nollm");
    assert(
      doneRrNoLlm.data.tier === "simple" && doneRrNoLlm.data.method === "heuristique",
      `router.route rr-nollm : heuristique attendue (allowLlm:false), reçu ${JSON.stringify(doneRrNoLlm.data)}`,
    );
    assert(lastClassifierBody === null, "allowLlm:false ne doit pas appeler le classificateur");

    // Spec R2 §5.2 + critère d'acceptation : classificateur trop lent (répond
    // à ~4,5 s) -> timeout 3 s, repli heuristique SILENCIEUX (done, pas error),
    // sans jamais retarder la réponse au-delà de ~3 s.
    send({
      id: "rs-cls-slow",
      method: "router.set",
      params: { table: {}, classifier: { providerId: "classifier-slow", model: "cls-model" } },
    });
    await waitFor((e) => e.id === "rs-cls-slow" && e.event === "done", 3000, "router.set rs-cls-slow");
    const slowStart = Date.now();
    send({ id: "rr-timeout", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRrTimeout = await waitFor(
      (e) => e.id === "rr-timeout" && e.event === "done",
      6000,
      "router.route rr-timeout (repli heuristique)",
    );
    const slowElapsedMs = Date.now() - slowStart;
    assert(
      doneRrTimeout.data.tier === "simple" && doneRrTimeout.data.method === "heuristique",
      `router.route rr-timeout : repli heuristique attendu, reçu ${JSON.stringify(doneRrTimeout.data)}`,
    );
    assert(
      slowElapsedMs < 4000,
      `router.route rr-timeout : réponse attendue en ~3 s (timeout), mesurée à ${slowElapsedMs}ms`,
    );

    // classifier:null = désactivé — heuristique seule, même sur score ambigu.
    send({ id: "rs-cls-off", method: "router.set", params: { table: {}, classifier: null } });
    await waitFor((e) => e.id === "rs-cls-off" && e.event === "done", 3000, "router.set rs-cls-off");
    send({ id: "rr-off", method: "router.route", params: { text: "Explique pourquoi ce test échoue" } });
    const doneRrOff = await waitFor((e) => e.id === "rr-off" && e.event === "done", 3000, "router.route rr-off");
    assert(
      doneRrOff.data.tier === "simple" && doneRrOff.data.method === "heuristique",
      `router.route rr-off : classificateur désactivé, heuristique attendue, reçu ${JSON.stringify(doneRrOff.data)}`,
    );

    // Spec R2 §5.3 : surcharge projet .iaction/routage.yaml — partielle
    // (fusionnée par-dessus la table globale) puis invalide (ignorée + mention
    // dans reasons). allowLlm:false : ces cas ne testent que la fusion.
    const routageProjDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-routage-"));
    try {
      await fsp.mkdir(path.join(routageProjDir, ".iaction"), { recursive: true });
      await fsp.writeFile(
        path.join(routageProjDir, ".iaction", "routage.yaml"),
        "table:\n  trivial: { engine: claude, model: modele-projet }\n",
        "utf8",
      );
      send({
        id: "rr-proj",
        method: "router.route",
        params: { text: "Salut, ça va ?", cwd: routageProjDir, allowLlm: false },
      });
      const doneRrProj = await waitFor((e) => e.id === "rr-proj" && e.event === "done", 3000, "router.route rr-proj");
      assert(
        doneRrProj.data.tier === "trivial" &&
          JSON.stringify(doneRrProj.data.target) === JSON.stringify({ engine: "claude", model: "modele-projet" }),
        `router.route rr-proj : cible du routage.yaml projet attendue, reçu ${JSON.stringify(doneRrProj.data)}`,
      );

      // Tier NON surchargé par le projet : la table globale (ici les défauts) reste.
      send({
        id: "rr-proj2",
        method: "router.route",
        params: { text: "Explique pourquoi ce test échoue", cwd: routageProjDir, allowLlm: false },
      });
      const doneRrProj2 = await waitFor((e) => e.id === "rr-proj2" && e.event === "done", 3000, "router.route rr-proj2");
      assert(
        doneRrProj2.data.tier === "simple" &&
          JSON.stringify(doneRrProj2.data.target) === JSON.stringify({ engine: "claude", model: "claude-sonnet-5" }),
        `router.route rr-proj2 : fusion partielle attendue (tier simple global), reçu ${JSON.stringify(doneRrProj2.data)}`,
      );

      // YAML invalide -> table globale + mention « routage.yaml invalide » dans reasons.
      await fsp.writeFile(
        path.join(routageProjDir, ".iaction", "routage.yaml"),
        "table: [ceci: n'est: pas: du: yaml",
        "utf8",
      );
      send({
        id: "rr-proj3",
        method: "router.route",
        params: { text: "Salut, ça va ?", cwd: routageProjDir, allowLlm: false },
      });
      const doneRrProj3 = await waitFor((e) => e.id === "rr-proj3" && e.event === "done", 3000, "router.route rr-proj3");
      assert(
        JSON.stringify(doneRrProj3.data.target) ===
          JSON.stringify({ engine: "claude", model: "claude-haiku-4-5" }),
        `router.route rr-proj3 : YAML invalide doit retomber sur la table globale, reçu ${JSON.stringify(doneRrProj3.data.target)}`,
      );
      assert(
        Array.isArray(doneRrProj3.data.reasons) &&
          doneRrProj3.data.reasons.some((r) => r.includes("routage.yaml invalide")),
        `router.route rr-proj3 : mention « routage.yaml invalide » attendue dans reasons, reçu ${JSON.stringify(doneRrProj3.data.reasons)}`,
      );
    } finally {
      await fsp.rm(routageProjDir, { recursive: true, force: true }).catch(() => {});
    }

    // Remise aux défauts R2 (classificateur par défaut : désactivé — heuristique
    // seule) pour ne rien laisser derrière.
    send({ id: "rs-r2-reset", method: "router.set", params: { table: {} } });
    await waitFor((e) => e.id === "rs-r2-reset" && e.event === "done", 3000, "router.set rs-r2-reset");

    // ---------------------------------------------------------------------
    // Lot 2 : claude.configure / claude.start / claude.permission / claude.abort
    // Le sous-processus tourne avec IACTION_FAKE_CLAUDE=1 : aucun appel
    // réseau ni SDK réel, tout passe par test/fakeClaude.mjs.
    // ---------------------------------------------------------------------

    // claude.configure : pose puis retire la clé.
    send({ id: "cc1", method: "claude.configure", params: { apiKey: "sk-ant-test" } });
    const doneCc1 = await waitFor((e) => e.id === "cc1" && e.event === "done", 3000, "claude.configure cc1");
    assert(
      doneCc1.data.configured === true,
      `claude.configure avec apiKey doit répondre configured:true, reçu ${JSON.stringify(doneCc1.data)}`,
    );
    send({ id: "cc2", method: "claude.configure", params: { apiKey: null } });
    const doneCc2 = await waitFor((e) => e.id === "cc2" && e.event === "done", 3000, "claude.configure cc2");
    assert(
      doneCc2.data.configured === false,
      `claude.configure avec apiKey:null doit répondre configured:false, reçu ${JSON.stringify(doneCc2.data)}`,
    );

    // usage.claude avant tout tour claude.start joué dans cette session sidecar -> available:false
    send({ id: "uc1", method: "usage.claude", params: {} });
    const doneUc1 = await waitFor((e) => e.id === "uc1" && e.event === "done", 3000, "usage.claude uc1");
    assert(
      doneUc1.data.available === false,
      `usage.claude avant tout tour doit répondre available:false, reçu ${JSON.stringify(doneUc1.data)}`,
    );

    // claude.start (scénario allow) : init -> deltas texte -> tool_use -> permission_request
    send({
      id: "cl1",
      method: "claude.start",
      params: { cwd: "/tmp", prompt: "Bonjour" },
    });
    const initCl1 = await waitFor(
      (e) => e.id === "cl1" && e.event === "chunk" && e.data.kind === "init",
      3000,
      "claude.start cl1 chunk init",
    );
    assert(typeof initCl1.data.sessionId === "string" && initCl1.data.sessionId.length > 0, "init cl1 doit porter un sessionId");
    assert(initCl1.data.model === "fake-model", `init cl1 doit porter model:'fake-model', reçu ${JSON.stringify(initCl1.data)}`);

    const permReqCl1 = await waitFor(
      (e) => e.id === "cl1" && e.event === "chunk" && e.data.kind === "permission_request",
      3000,
      "claude.start cl1 chunk permission_request",
    );
    assert(permReqCl1.data.toolName === "Bash", `permission_request cl1 toolName attendu 'Bash', reçu ${JSON.stringify(permReqCl1.data)}`);
    assert(
      typeof permReqCl1.data.permissionId === "string" && permReqCl1.data.permissionId.length > 0,
      "permission_request cl1 doit porter un permissionId",
    );

    // Pas de duplication du texte : exactement 3 chunks "text" à ce stade
    // (avant la permission), reconstituant "Bonjour le monde" — le message
    // assistant complet qui reprend ces deltas ne doit PAS être réémis.
    const textChunksCl1 = received.filter((e) => e.id === "cl1" && e.event === "chunk" && e.data.kind === "text");
    assert(textChunksCl1.length === 3, `cl1 attendu 3 chunks 'text' (deltas, sans duplication), reçu ${textChunksCl1.length}`);
    assert(
      textChunksCl1.map((c) => c.data.delta).join("") === "Bonjour le monde",
      `texte reconstitué cl1 incorrect: "${textChunksCl1.map((c) => c.data.delta).join("")}"`,
    );

    const toolUseCl1 = received.find((e) => e.id === "cl1" && e.event === "chunk" && e.data.kind === "tool_use");
    assert(toolUseCl1, "cl1 doit émettre un chunk tool_use avant la permission_request");
    assert(toolUseCl1.data.toolName === "Bash", "tool_use cl1 toolName attendu 'Bash'");

    // Répond allow -> le faux SDK reçoit {behavior:'allow'} et poursuit jusqu'au done.
    send({
      id: "perm1",
      method: "claude.permission",
      params: { targetId: "cl1", permissionId: permReqCl1.data.permissionId, decision: "allow" },
    });
    const donePerm1 = await waitFor((e) => e.id === "perm1" && e.event === "done", 3000, "claude.permission perm1");
    assert(donePerm1.data.applied === true, `claude.permission perm1 doit répondre applied:true, reçu ${JSON.stringify(donePerm1.data)}`);

    const toolResultCl1 = await waitFor(
      (e) => e.id === "cl1" && e.event === "chunk" && e.data.kind === "tool_result",
      3000,
      "claude.start cl1 chunk tool_result (allow)",
    );
    assert(toolResultCl1.data.isError === false, `tool_result cl1 (allow) doit avoir isError:false, reçu ${JSON.stringify(toolResultCl1.data)}`);

    const doneCl1 = await waitFor((e) => e.id === "cl1" && e.event === "done", 3000, "claude.start cl1 done");
    assert(doneCl1.data.subtype === "success", `cl1 done.subtype attendu 'success', reçu ${JSON.stringify(doneCl1.data)}`);
    assert(
      doneCl1.data.usage &&
        doneCl1.data.usage.inputTokens === 12 &&
        doneCl1.data.usage.outputTokens === 5 &&
        doneCl1.data.usage.cacheReadInputTokens === 2,
      `usage cl1 incorrect: ${JSON.stringify(doneCl1.data.usage)}`,
    );
    assert(doneCl1.data.totalCostUsd === 0.0021, `totalCostUsd cl1 incorrect: ${JSON.stringify(doneCl1.data.totalCostUsd)}`);
    // contextTokens : taille du PROMPT au DERNIER appel API (usage du dernier
    // message assistant), PAS le cumul du result NI l'output. Le fake pose sur
    // le message tool_use 100 + 5000(cache_read) + 200(cache_creation) = 5300
    // (output 50 exclu) — sans lien avec l'usage du result (12/5/2).
    assert(
      doneCl1.data.contextTokens === 5300,
      `contextTokens cl1 attendu 5300 (prompt du dernier appel, output exclu), reçu ${JSON.stringify(doneCl1.data.contextTokens)}`,
    );
    // Message assistant SYNTHÉTIQUE jamais streamé (erreur API simulée, émise
    // par le fake après le tool_result) : son texte DOIT avoir été relayé en
    // un chunk 'text' supplémentaire — c'était le bug « tour terminé sans
    // résultat » sur un 529 réel. Total : 3 deltas + 1 message synthétique.
    const allTextCl1 = received.filter((e) => e.id === "cl1" && e.event === "chunk" && e.data.kind === "text");
    assert(
      allTextCl1.length === 4,
      `cl1 attendu 4 chunks 'text' au total (3 deltas + 1 synthétique), reçu ${allTextCl1.length}`,
    );
    assert(
      allTextCl1[3].data.delta === "API Error: 529 Overloaded (simulé)",
      `dernier chunk text cl1 attendu le message synthétique, reçu: "${allTextCl1[3].data.delta}"`,
    );

    // usage.claude après un tour joué avec le fake SANS la méthode usage_EXPERIMENTAL... :
    // le tour s'est terminé normalement (doneCl1 ci-dessus), et usage.claude reste available:false
    // (requirement (d) : capture défensive, la méthode absente ne fait jamais échouer le tour).
    send({ id: "uc2", method: "usage.claude", params: {} });
    const doneUc2 = await waitFor((e) => e.id === "uc2" && e.event === "done", 3000, "usage.claude uc2");
    assert(
      doneUc2.data.available === false,
      `usage.claude après un tour avec le fake sans usage_EXPERIMENTAL... doit rester available:false, reçu ${JSON.stringify(doneUc2.data)}`,
    );

    // usage.claude, fake AVEC usage_EXPERIMENTAL... (second sous-processus sidecar isolé)
    await testUsageClaudeWithFakeSdk();

    // claude.release + plafond d'attente des tâches de fond (sous-processus dédié).
    await testClaudeBackgroundRelease();

    // Support MCP v1 de claude.start : lecture de <cwd>/.mcp.json (troisième
    // sous-processus sidecar isolé, voir testClaudeMcpConfig ci-dessus).
    await testClaudeMcpConfig();

    // Lot O1 : CRUD agents.*/orch.* (quatrième sous-processus sidecar isolé,
    // voir testOrchestratorCrud ci-dessus).
    await testOrchestratorCrud();

    // Lot O3 : ordonnanceur DAG (stepRunner factice, en-process) puis intégration
    // avec le vrai moteur claude (cinquième sous-processus sidecar isolé) —
    // voir testOrchRunFakeStepRunner/testOrchRunRealClaudeEngine ci-dessus.
    await testOrchRunFakeStepRunner();
    await testOrchRunRealClaudeEngine();

    // R2 : agent `engine: auto` routé par le routeur dans une orchestration
    // (sixième sous-processus sidecar isolé + faux serveur neutre, voir
    // testOrchRunRouterAuto ci-dessus).
    await testOrchRunRouterAuto();

    // R3 : débord d'abonnement, plafond mensuel et agrégat `routage` de
    // usage.stats (septième sous-processus sidecar isolé, fichiers JSONL
    // forgés — voir testR3Debord ci-dessus).
    await testR3Debord();

    // claude.start (scénario deny avec message) : le faux SDK doit recevoir le message de refus
    // et le renvoyer dans le contenu du tool_result (seule façon, depuis ce process de test, de
    // vérifier ce que le faux SDK a reçu — il tourne dans le sous-processus sidecar).
    send({ id: "cl2", method: "claude.start", params: { cwd: "/tmp", prompt: "Bonjour 2" } });
    const permReqCl2 = await waitFor(
      (e) => e.id === "cl2" && e.event === "chunk" && e.data.kind === "permission_request",
      3000,
      "claude.start cl2 chunk permission_request",
    );
    send({
      id: "perm2",
      method: "claude.permission",
      params: {
        targetId: "cl2",
        permissionId: permReqCl2.data.permissionId,
        decision: "deny",
        message: "Non merci",
      },
    });
    const donePerm2 = await waitFor((e) => e.id === "perm2" && e.event === "done", 3000, "claude.permission perm2");
    assert(donePerm2.data.applied === true, `claude.permission perm2 doit répondre applied:true, reçu ${JSON.stringify(donePerm2.data)}`);

    const toolResultCl2 = await waitFor(
      (e) => e.id === "cl2" && e.event === "chunk" && e.data.kind === "tool_result",
      3000,
      "claude.start cl2 chunk tool_result (deny)",
    );
    assert(toolResultCl2.data.isError === true, `tool_result cl2 (deny) doit avoir isError:true, reçu ${JSON.stringify(toolResultCl2.data)}`);
    assert(
      toolResultCl2.data.summary === "Non merci",
      `tool_result cl2 (deny) doit porter le message de refus en summary, reçu ${JSON.stringify(toolResultCl2.data)}`,
    );

    const doneCl2 = await waitFor((e) => e.id === "cl2" && e.event === "done", 3000, "claude.start cl2 done");
    assert(
      doneCl2.data.subtype === "error_denied",
      `cl2 done.subtype attendu 'error_denied', reçu ${JSON.stringify(doneCl2.data)}`,
    );

    // claude.permission avec permissionId déjà résolu -> applied:false
    send({
      id: "perm2b",
      method: "claude.permission",
      params: { targetId: "cl2", permissionId: permReqCl2.data.permissionId, decision: "allow" },
    });
    const donePerm2b = await waitFor((e) => e.id === "perm2b" && e.event === "done", 3000, "claude.permission perm2b");
    assert(
      donePerm2b.data.applied === false,
      `claude.permission sur une permission déjà résolue doit répondre applied:false, reçu ${JSON.stringify(donePerm2b.data)}`,
    );

    // claude.start (scénario abort) : abort pendant une permission_request en attente ->
    // done émis (jamais d'error), pending permission refusée automatiquement.
    send({ id: "cl3", method: "claude.start", params: { cwd: "/tmp", prompt: "Bonjour 3" } });
    await waitFor(
      (e) => e.id === "cl3" && e.event === "chunk" && e.data.kind === "permission_request",
      3000,
      "claude.start cl3 chunk permission_request",
    );
    send({ id: "ab-cl3", method: "claude.abort", params: { targetId: "cl3" } });
    const doneAbCl3 = await waitFor((e) => e.id === "ab-cl3" && e.event === "done", 3000, "claude.abort ab-cl3");
    assert(
      doneAbCl3.data.aborted === true,
      `claude.abort ab-cl3 doit répondre aborted:true, reçu ${JSON.stringify(doneAbCl3.data)}`,
    );
    const doneCl3 = await waitFor(
      (e) => e.id === "cl3" && (e.event === "done" || e.event === "error"),
      3000,
      "claude.start cl3 après abort",
    );
    assert(
      doneCl3.event === "done",
      `cl3 doit se terminer par 'done' (jamais 'error') après abort, reçu '${doneCl3.event}': ${JSON.stringify(doneCl3.data)}`,
    );
    assert(doneCl3.data.subtype === "aborted", `cl3 done.subtype attendu 'aborted', reçu ${JSON.stringify(doneCl3.data)}`);

    // claude.abort sur un targetId inconnu -> done {aborted:false}
    send({ id: "ab-unknown", method: "claude.abort", params: { targetId: "id-inconnu" } });
    const doneAbUnknown = await waitFor(
      (e) => e.id === "ab-unknown" && e.event === "done",
      3000,
      "claude.abort ab-unknown",
    );
    assert(
      doneAbUnknown.data.aborted === false,
      `claude.abort sur targetId inconnu doit répondre aborted:false, reçu ${JSON.stringify(doneAbUnknown.data)}`,
    );

    // ---------------------------------------------------------------------
    // Guide d'intégration projet (projectDoc.ts) : un claude.start projet
    // (non chatOnly) dépose .iaction/connaissances/iaction.md — mais
    // UNIQUEMENT si <cwd>/.iaction/ existe déjà (vrai projet IAction).
    // ---------------------------------------------------------------------
    const docProjDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iastudio-doc-"));
    await fsp.mkdir(path.join(docProjDir, ".iaction"));
    send({ id: "cl-doc", method: "claude.start", params: { cwd: docProjDir, prompt: "dépôt guide" } });
    await waitFor(
      (e) => e.id === "cl-doc" && e.event === "chunk" && e.data.kind === "permission_request",
      3000,
      "claude.start cl-doc permission_request",
    );
    send({
      id: "perm-doc",
      method: "claude.permission",
      params: { targetId: "cl-doc", permissionId: "perm-1", decision: "deny" },
    });
    await waitFor((e) => e.id === "cl-doc" && e.event === "done", 3000, "claude.start cl-doc done");
    const guideContent = await fsp.readFile(
      path.join(docProjDir, ".iaction", "connaissances", "iaction.md"),
      "utf8",
    );
    assert(
      guideContent.startsWith("<!-- généré par IAction"),
      "le guide déposé doit commencer par le marqueur « généré par IAction »",
    );
    const docProjDir2 = await fsp.mkdtemp(path.join(os.tmpdir(), "iastudio-nodoc-"));
    send({ id: "cl-nodoc", method: "claude.start", params: { cwd: docProjDir2, prompt: "sans .iaction" } });
    await waitFor(
      (e) => e.id === "cl-nodoc" && e.event === "chunk" && e.data.kind === "permission_request",
      3000,
      "claude.start cl-nodoc permission_request",
    );
    send({
      id: "perm-nodoc",
      method: "claude.permission",
      params: { targetId: "cl-nodoc", permissionId: "perm-1", decision: "deny" },
    });
    await waitFor((e) => e.id === "cl-nodoc" && e.event === "done", 3000, "claude.start cl-nodoc done");
    const iactionCreated = await fsp
      .stat(path.join(docProjDir2, ".iaction"))
      .then(() => true)
      .catch(() => false);
    assert(!iactionCreated, "sans .iaction/ préexistant, claude.start ne doit RIEN créer dans le cwd");
    await fsp.rm(docProjDir, { recursive: true, force: true });
    await fsp.rm(docProjDir2, { recursive: true, force: true });

    // ---------------------------------------------------------------------
    // Lot 6 : neutral.start / neutral.permission / neutral.abort — boucle
    // agentique tool-calling du moteur neutre (docs/protocol.md, section
    // « Méthodes Lot 6 »). Réutilise le provider "mock" (tour texte simple,
    // scénario 1) et le nouveau provider "neutral" (tool-calling, scénarios
    // 2 à 6 et 8) ainsi que "slow" (abort, scénario 7).
    // ---------------------------------------------------------------------

    // 1. Tour simple sans tool_calls -> chunks text puis done subtype:"success".
    send({
      id: "n1",
      method: "neutral.start",
      params: {
        providerId: "mock",
        model: "model-a",
        cwd: tmpDir,
        messages: [{ role: "user", content: "Bonjour" }],
      },
    });
    const initN1 = await waitFor(
      (e) => e.id === "n1" && e.event === "chunk" && e.data.kind === "init",
      3000,
      "neutral.start n1 chunk init",
    );
    assert(initN1.data.sessionId === null, `init n1 sessionId doit être null, reçu ${JSON.stringify(initN1.data)}`);
    assert(initN1.data.model === "model-a", `init n1 model incorrect: ${JSON.stringify(initN1.data)}`);
    const doneN1 = await waitFor(
      (e) => e.id === "n1" && (e.event === "done" || e.event === "error"),
      3000,
      "neutral.start n1 done",
    );
    assert(doneN1.event === "done", `n1 attendu 'done', reçu '${doneN1.event}': ${JSON.stringify(doneN1.data)}`);
    assert(doneN1.data.subtype === "success", `n1 subtype attendu 'success', reçu ${JSON.stringify(doneN1.data)}`);
    assert(doneN1.data.sessionId === null, `n1 sessionId doit rester null, reçu ${JSON.stringify(doneN1.data)}`);
    assert(doneN1.data.totalCostUsd === null, `n1 totalCostUsd doit être null, reçu ${JSON.stringify(doneN1.data)}`);
    const textChunksN1 = received.filter((e) => e.id === "n1" && e.event === "chunk" && e.data.kind === "text");
    assert(textChunksN1.length === 3, `n1 attendu 3 chunks 'text', reçu ${textChunksN1.length}`);
    assert(
      textChunksN1.map((c) => c.data.delta).join("") === "Bonjour le monde",
      `texte reconstitué n1 incorrect: "${textChunksN1.map((c) => c.data.delta).join("")}"`,
    );
    assert(doneN1.data.result === "Bonjour le monde", `n1 result incorrect: ${JSON.stringify(doneN1.data.result)}`);
    assert(
      doneN1.data.usage && doneN1.data.usage.inputTokens === 7 && doneN1.data.usage.outputTokens === 3,
      `n1 usage incorrect: ${JSON.stringify(doneN1.data.usage)}`,
    );

    // 2. tool_call read_file sur un vrai fichier -> tool_use puis tool_result isError:false,
    // puis un second tour mock qui fait écho au contenu reçu -> done success.
    const sampleFile = path.join(tmpDir, "sample.txt");
    await fsp.writeFile(sampleFile, "hello world\n", "utf8");
    send({
      id: "n2",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        messages: [{ role: "user", content: JSON.stringify({ op: "read_file", path: "sample.txt" }) }],
      },
    });
    const toolUseN2 = await waitFor(
      (e) => e.id === "n2" && e.event === "chunk" && e.data.kind === "tool_use",
      3000,
      "n2 chunk tool_use",
    );
    assert(toolUseN2.data.toolName === "read_file", `n2 tool_use toolName incorrect: ${JSON.stringify(toolUseN2.data)}`);
    assert(
      toolUseN2.data.toolInput && toolUseN2.data.toolInput.path === "sample.txt",
      `n2 tool_use toolInput.path incorrect (accumulation des arguments fragmentés) : ${JSON.stringify(toolUseN2.data)}`,
    );
    const toolResultN2 = await waitFor(
      (e) => e.id === "n2" && e.event === "chunk" && e.data.kind === "tool_result",
      3000,
      "n2 chunk tool_result",
    );
    assert(toolResultN2.data.isError === false, `n2 tool_result doit être isError:false, reçu ${JSON.stringify(toolResultN2.data)}`);
    assert(
      toolResultN2.data.summary === "hello world\n",
      `n2 tool_result summary incorrect: ${JSON.stringify(toolResultN2.data.summary)}`,
    );
    const doneN2 = await waitFor(
      (e) => e.id === "n2" && (e.event === "done" || e.event === "error"),
      3000,
      "n2 done",
    );
    assert(doneN2.event === "done" && doneN2.data.subtype === "success", `n2 done incorrect: ${JSON.stringify(doneN2.data)}`);
    assert(
      doneN2.data.result === "TOOL_RESULT:hello world\n",
      `n2 result doit faire écho au contenu lu (preuve que le tool_call a bien été exécuté et renvoyé au modèle) : ${JSON.stringify(doneN2.data.result)}`,
    );

    // 3. write_file en permissionMode:"default" -> permission_request avant écriture.
    // 3a. decision:"allow" -> le fichier est réellement écrit sur disque.
    send({
      id: "n3-allow",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        permissionMode: "default",
        messages: [
          { role: "user", content: JSON.stringify({ op: "write_file", path: "allowed.txt", content: "written content" }) },
        ],
      },
    });
    const permReqN3a = await waitFor(
      (e) => e.id === "n3-allow" && e.event === "chunk" && e.data.kind === "permission_request",
      3000,
      "n3-allow permission_request",
    );
    assert(permReqN3a.data.toolName === "write_file", `n3-allow permission_request toolName incorrect: ${JSON.stringify(permReqN3a.data)}`);
    send({
      id: "n3-allow-perm",
      method: "neutral.permission",
      params: { targetId: "n3-allow", permissionId: permReqN3a.data.permissionId, decision: "allow" },
    });
    const donePermN3a = await waitFor((e) => e.id === "n3-allow-perm" && e.event === "done", 3000, "n3-allow-perm done");
    assert(donePermN3a.data.applied === true, `n3-allow-perm doit répondre applied:true, reçu ${JSON.stringify(donePermN3a.data)}`);
    const toolResultN3a = await waitFor(
      (e) => e.id === "n3-allow" && e.event === "chunk" && e.data.kind === "tool_result",
      3000,
      "n3-allow tool_result",
    );
    assert(toolResultN3a.data.isError === false, `n3-allow tool_result doit être isError:false, reçu ${JSON.stringify(toolResultN3a.data)}`);
    const doneN3a = await waitFor(
      (e) => e.id === "n3-allow" && (e.event === "done" || e.event === "error"),
      3000,
      "n3-allow done",
    );
    assert(doneN3a.event === "done" && doneN3a.data.subtype === "success", `n3-allow done incorrect: ${JSON.stringify(doneN3a.data)}`);
    const allowedContent = await fsp.readFile(path.join(tmpDir, "allowed.txt"), "utf8");
    assert(allowedContent === "written content", `n3-allow: contenu écrit sur disque incorrect: ${JSON.stringify(allowedContent)}`);

    // 3b. decision:"deny" -> tool_result isError:true, fichier NON créé, message de refus
    // transmis au modèle (vérifié via l'écho du second tour de la route mock).
    send({
      id: "n3-deny",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        permissionMode: "default",
        messages: [
          { role: "user", content: JSON.stringify({ op: "write_file", path: "denied.txt", content: "should not exist" }) },
        ],
      },
    });
    const permReqN3d = await waitFor(
      (e) => e.id === "n3-deny" && e.event === "chunk" && e.data.kind === "permission_request",
      3000,
      "n3-deny permission_request",
    );
    send({
      id: "n3-deny-perm",
      method: "neutral.permission",
      params: {
        targetId: "n3-deny",
        permissionId: permReqN3d.data.permissionId,
        decision: "deny",
        message: "Non merci n3",
      },
    });
    await waitFor((e) => e.id === "n3-deny-perm" && e.event === "done", 3000, "n3-deny-perm done");
    const toolResultN3d = await waitFor(
      (e) => e.id === "n3-deny" && e.event === "chunk" && e.data.kind === "tool_result",
      3000,
      "n3-deny tool_result",
    );
    assert(toolResultN3d.data.isError === true, `n3-deny tool_result doit être isError:true, reçu ${JSON.stringify(toolResultN3d.data)}`);
    assert(
      toolResultN3d.data.summary === "Non merci n3",
      `n3-deny tool_result summary doit porter le message de refus, reçu ${JSON.stringify(toolResultN3d.data.summary)}`,
    );
    const doneN3d = await waitFor(
      (e) => e.id === "n3-deny" && (e.event === "done" || e.event === "error"),
      3000,
      "n3-deny done",
    );
    assert(doneN3d.event === "done" && doneN3d.data.subtype === "success", `n3-deny done incorrect: ${JSON.stringify(doneN3d.data)}`);
    assert(
      doneN3d.data.result === "TOOL_RESULT:Non merci n3",
      `n3-deny: le modèle doit recevoir le message de refus dans le message role:tool suivant, reçu ${JSON.stringify(doneN3d.data.result)}`,
    );
    let deniedExists = true;
    try {
      await fsp.access(path.join(tmpDir, "denied.txt"));
    } catch {
      deniedExists = false;
    }
    assert(deniedExists === false, "n3-deny: le fichier refusé ne doit pas être créé");

    // 4. permissionMode:"bypassPermissions" -> aucun permission_request, écriture directe.
    send({
      id: "n4",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        permissionMode: "bypassPermissions",
        messages: [{ role: "user", content: JSON.stringify({ op: "write_file", path: "bypass.txt", content: "bypassed" }) }],
      },
    });
    const doneN4 = await waitFor(
      (e) => e.id === "n4" && (e.event === "done" || e.event === "error"),
      3000,
      "n4 done",
    );
    assert(doneN4.event === "done" && doneN4.data.subtype === "success", `n4 done incorrect: ${JSON.stringify(doneN4.data)}`);
    const permReqsN4 = received.filter((e) => e.id === "n4" && e.event === "chunk" && e.data.kind === "permission_request");
    assert(permReqsN4.length === 0, `n4 (bypassPermissions) ne doit émettre aucun permission_request, reçu ${permReqsN4.length}`);
    const bypassContent = await fsp.readFile(path.join(tmpDir, "bypass.txt"), "utf8");
    assert(bypassContent === "bypassed", `n4: contenu écrit sur disque incorrect: ${JSON.stringify(bypassContent)}`);

    // 5. edit_file : occurrence unique -> remplacement correct sur disque.
    const editUniquePath = path.join(tmpDir, "edit-unique.txt");
    await fsp.writeFile(editUniquePath, "hello world, unique marker here", "utf8");
    send({
      id: "n5-unique",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        permissionMode: "bypassPermissions",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              op: "edit_file",
              path: "edit-unique.txt",
              old_string: "unique marker",
              new_string: "REPLACED",
            }),
          },
        ],
      },
    });
    const doneN5u = await waitFor(
      (e) => e.id === "n5-unique" && (e.event === "done" || e.event === "error"),
      3000,
      "n5-unique done",
    );
    assert(doneN5u.event === "done" && doneN5u.data.subtype === "success", `n5-unique done incorrect: ${JSON.stringify(doneN5u.data)}`);
    const editUniqueAfter = await fsp.readFile(editUniquePath, "utf8");
    assert(
      editUniqueAfter === "hello world, REPLACED here",
      `n5-unique: contenu après édition incorrect: ${JSON.stringify(editUniqueAfter)}`,
    );

    // 5b. occurrence ambiguë -> tool_result isError:true explicite, boucle continue (pas de crash).
    const editAmbiguousPath = path.join(tmpDir, "edit-ambiguous.txt");
    await fsp.writeFile(editAmbiguousPath, "dup dup", "utf8");
    send({
      id: "n5-ambiguous",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        permissionMode: "bypassPermissions",
        messages: [
          {
            role: "user",
            content: JSON.stringify({ op: "edit_file", path: "edit-ambiguous.txt", old_string: "dup", new_string: "X" }),
          },
        ],
      },
    });
    const toolResultN5a = await waitFor(
      (e) => e.id === "n5-ambiguous" && e.event === "chunk" && e.data.kind === "tool_result",
      3000,
      "n5-ambiguous tool_result",
    );
    assert(toolResultN5a.data.isError === true, `n5-ambiguous tool_result doit être isError:true, reçu ${JSON.stringify(toolResultN5a.data)}`);
    assert(
      toolResultN5a.data.summary.includes("occurrence ambiguë"),
      `n5-ambiguous message d'erreur incorrect: ${JSON.stringify(toolResultN5a.data.summary)}`,
    );
    const doneN5a = await waitFor(
      (e) => e.id === "n5-ambiguous" && (e.event === "done" || e.event === "error"),
      3000,
      "n5-ambiguous done",
    );
    assert(
      doneN5a.event === "done",
      `n5-ambiguous doit se terminer par 'done' (pas de crash après erreur d'outil), reçu '${doneN5a.event}': ${JSON.stringify(doneN5a.data)}`,
    );
    const editAmbiguousAfter = await fsp.readFile(editAmbiguousPath, "utf8");
    assert(editAmbiguousAfter === "dup dup", "n5-ambiguous: le fichier ne doit pas être modifié");

    // 6. path traversal -> tool_result isError:true explicite mentionnant le hors-cwd, boucle continue.
    send({
      id: "n6",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        permissionMode: "bypassPermissions",
        messages: [
          {
            role: "user",
            content: JSON.stringify({ op: "traversal", tool: "read_file", args: { path: "../outside.txt" } }),
          },
        ],
      },
    });
    const toolResultN6 = await waitFor(
      (e) => e.id === "n6" && e.event === "chunk" && e.data.kind === "tool_result",
      3000,
      "n6 tool_result",
    );
    assert(toolResultN6.data.isError === true, `n6 tool_result doit être isError:true, reçu ${JSON.stringify(toolResultN6.data)}`);
    assert(
      toolResultN6.data.summary.includes("hors du répertoire de travail"),
      `n6 message d'erreur doit mentionner le hors-cwd: ${JSON.stringify(toolResultN6.data.summary)}`,
    );
    const doneN6 = await waitFor(
      (e) => e.id === "n6" && (e.event === "done" || e.event === "error"),
      3000,
      "n6 done",
    );
    assert(
      doneN6.event === "done",
      `n6 (path traversal) doit se terminer par 'done' (pas de crash), reçu '${doneN6.event}': ${JSON.stringify(doneN6.data)}`,
    );

    // 7. neutral.abort pendant un stream en cours -> done subtype:"aborted" sur neutral.start,
    // done {aborted:true} sur la requête d'abort.
    send({
      id: "n7",
      method: "neutral.start",
      params: {
        providerId: "slow",
        model: "model-x",
        cwd: tmpDir,
        messages: [{ role: "user", content: "go slow" }],
      },
    });
    await new Promise((r) => setTimeout(r, 150)); // avant le premier delta (émis à 400ms)
    send({ id: "n7-abort", method: "neutral.abort", params: { targetId: "n7" } });
    const doneN7Abort = await waitFor((e) => e.id === "n7-abort" && e.event === "done", 3000, "neutral.abort n7-abort");
    assert(doneN7Abort.data.aborted === true, `n7-abort doit répondre aborted:true, reçu ${JSON.stringify(doneN7Abort.data)}`);
    const doneN7 = await waitFor(
      (e) => e.id === "n7" && (e.event === "done" || e.event === "error"),
      3000,
      "n7 done après abort",
    );
    assert(
      doneN7.event === "done",
      `n7 doit se terminer par 'done' (jamais 'error') après abort, reçu '${doneN7.event}': ${JSON.stringify(doneN7.data)}`,
    );
    assert(doneN7.data.subtype === "aborted", `n7 subtype attendu 'aborted', reçu ${JSON.stringify(doneN7.data)}`);

    // neutral.abort sur un targetId inconnu -> done {aborted:false}
    send({ id: "n7-abort-unknown", method: "neutral.abort", params: { targetId: "id-inconnu" } });
    const doneN7AbortUnknown = await waitFor(
      (e) => e.id === "n7-abort-unknown" && e.event === "done",
      3000,
      "neutral.abort n7-abort-unknown",
    );
    assert(
      doneN7AbortUnknown.data.aborted === false,
      `neutral.abort sur targetId inconnu doit répondre aborted:false, reçu ${JSON.stringify(doneN7AbortUnknown.data)}`,
    );

    // 8. maxTurns:2 avec un mock qui boucle indéfiniment sur des tool_calls (list_dir) ->
    // done subtype:"max_turns" après exactement 2 itérations HTTP.
    const neutralLoopCallsBefore = neutralLoopCallCount;
    send({
      id: "n8",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        permissionMode: "bypassPermissions",
        maxTurns: 2,
        messages: [{ role: "user", content: JSON.stringify({ op: "list_dir_loop" }) }],
      },
    });
    const doneN8 = await waitFor(
      (e) => e.id === "n8" && (e.event === "done" || e.event === "error"),
      5000,
      "n8 done",
    );
    assert(doneN8.event === "done" && doneN8.data.subtype === "max_turns", `n8 done incorrect: ${JSON.stringify(doneN8.data)}`);
    const toolUsesN8 = received.filter((e) => e.id === "n8" && e.event === "chunk" && e.data.kind === "tool_use");
    assert(toolUsesN8.length === 2, `n8 attendu exactement 2 chunks tool_use (2 itérations HTTP), reçu ${toolUsesN8.length}`);
    assert(
      neutralLoopCallCount - neutralLoopCallsBefore === 2,
      `n8: le mock doit recevoir exactement 2 appels HTTP, reçu ${neutralLoopCallCount - neutralLoopCallsBefore}`,
    );

    // ---------------------------------------------------------------------
    // ollama.* (gestion des modèles chargés) — GET/POST sur l'API NATIVE
    // Ollama (sans /v1), dérivée du baseUrl OpenAI-compatible déclaré via
    // providers.set (voir docs/protocol.md, section « ollama.* »).
    // ---------------------------------------------------------------------

    // ollama.ps : mappe name/sizeVram/sizeTotal/expiresAt en camelCase.
    send({ id: "ops1", method: "ollama.ps", params: { providerId: "ollama-mock" } });
    const doneOps1 = await waitFor(
      (e) => e.id === "ops1" && (e.event === "done" || e.event === "error"),
      3000,
      "ollama.ps ops1",
    );
    assert(
      doneOps1.event === "done",
      `ollama.ps ops1 attendu 'done', reçu '${doneOps1.event}': ${JSON.stringify(doneOps1.data)}`,
    );
    assert(
      Array.isArray(doneOps1.data.models) && doneOps1.data.models.length === 1,
      `ollama.ps doit renvoyer 1 modèle, reçu ${JSON.stringify(doneOps1.data)}`,
    );
    const opsModel = doneOps1.data.models[0];
    assert(opsModel.name === "qwen3:4b", `ollama.ps name incorrect: ${JSON.stringify(opsModel)}`);
    assert(opsModel.sizeVram === 3500000000, `ollama.ps sizeVram incorrect: ${JSON.stringify(opsModel)}`);
    assert(opsModel.sizeTotal === 4000000000, `ollama.ps sizeTotal incorrect: ${JSON.stringify(opsModel)}`);
    assert(
      opsModel.expiresAt === "2026-07-19T20:00:00Z",
      `ollama.ps expiresAt incorrect: ${JSON.stringify(opsModel)}`,
    );

    // ollama.load : POST /api/generate SANS keep_alive (charge le modèle).
    send({ id: "oload1", method: "ollama.load", params: { providerId: "ollama-mock", model: "qwen3:4b" } });
    const doneOload1 = await waitFor(
      (e) => e.id === "oload1" && (e.event === "done" || e.event === "error"),
      3000,
      "ollama.load oload1",
    );
    assert(
      doneOload1.event === "done",
      `ollama.load oload1 attendu 'done', reçu '${doneOload1.event}': ${JSON.stringify(doneOload1.data)}`,
    );
    assert(
      doneOload1.data.loaded === true,
      `ollama.load oload1 doit répondre loaded:true, reçu ${JSON.stringify(doneOload1.data)}`,
    );
    assert(
      lastOllamaGenerateBody &&
        lastOllamaGenerateBody.model === "qwen3:4b" &&
        lastOllamaGenerateBody.prompt === "" &&
        lastOllamaGenerateBody.stream === false &&
        !("keep_alive" in lastOllamaGenerateBody),
      `ollama.load: corps POST /api/generate incorrect (ne doit PAS porter keep_alive): ${JSON.stringify(lastOllamaGenerateBody)}`,
    );

    // ollama.unload : POST /api/generate AVEC keep_alive:0 (décharge aussitôt).
    send({ id: "ounload1", method: "ollama.unload", params: { providerId: "ollama-mock", model: "qwen3:4b" } });
    const doneOunload1 = await waitFor(
      (e) => e.id === "ounload1" && (e.event === "done" || e.event === "error"),
      3000,
      "ollama.unload ounload1",
    );
    assert(
      doneOunload1.event === "done",
      `ollama.unload ounload1 attendu 'done', reçu '${doneOunload1.event}': ${JSON.stringify(doneOunload1.data)}`,
    );
    assert(
      doneOunload1.data.unloaded === true,
      `ollama.unload ounload1 doit répondre unloaded:true, reçu ${JSON.stringify(doneOunload1.data)}`,
    );
    assert(
      lastOllamaGenerateBody && lastOllamaGenerateBody.keep_alive === 0,
      `ollama.unload: corps POST /api/generate doit porter keep_alive:0, reçu ${JSON.stringify(lastOllamaGenerateBody)}`,
    );

    // providerId inconnu -> error, pour les trois méthodes.
    send({ id: "ops2", method: "ollama.ps", params: { providerId: "does-not-exist" } });
    const errOps2 = await waitFor(
      (e) => e.id === "ops2" && e.event === "error",
      3000,
      "ollama.ps ops2 erreur provider inconnu",
    );
    assert(
      typeof errOps2.data.message === "string" && errOps2.data.message.length > 0,
      "ollama.ps provider inconnu doit renvoyer un message d'erreur",
    );

    send({ id: "oload2", method: "ollama.load", params: { providerId: "does-not-exist", model: "x" } });
    const errOload2 = await waitFor(
      (e) => e.id === "oload2" && e.event === "error",
      3000,
      "ollama.load oload2 erreur provider inconnu",
    );
    assert(
      typeof errOload2.data.message === "string" && errOload2.data.message.length > 0,
      "ollama.load provider inconnu doit renvoyer un message d'erreur",
    );

    send({ id: "ounload2", method: "ollama.unload", params: { providerId: "does-not-exist", model: "x" } });
    const errOunload2 = await waitFor(
      (e) => e.id === "ounload2" && e.event === "error",
      3000,
      "ollama.unload ounload2 erreur provider inconnu",
    );
    assert(
      typeof errOunload2.data.message === "string" && errOunload2.data.message.length > 0,
      "ollama.unload provider inconnu doit renvoyer un message d'erreur",
    );

    // ---------------------------------------------------------------------
    // R5 — knowledge.* : index d'embeddings local + recherche (docs/
    // spec-r5-rag.md §5.3/§5.4/§5.5). Le provider d'embeddings est le mock
    // Ollama natif ci-dessus ("ollama-mock", POST /api/embed déterministe).
    // ---------------------------------------------------------------------

    // Config routage : embeddings → mock (les autres champs retombent sur les
    // défauts, sans incidence — plus aucun router.route dans la suite du test).
    send({
      id: "rs-r5",
      method: "router.set",
      params: { table: {}, embeddings: { providerId: "ollama-mock", model: "fake-embed" } },
    });
    await waitFor((e) => e.id === "rs-r5" && e.event === "done", 3000, "router.set rs-r5");

    // knowledge.status AVANT indexation -> exists:false.
    send({ id: "ks0", method: "knowledge.status", params: { cwd: knowledgeDir } });
    const doneKs0 = await waitFor((e) => e.id === "ks0" && e.event === "done", 3000, "knowledge.status ks0");
    assert(
      doneKs0.data.exists === false && doneKs0.data.stale === false,
      `knowledge.status ks0 : exists:false attendu sans index, reçu ${JSON.stringify(doneKs0.data)}`,
    );

    // knowledge.search sans index -> erreur lisible « index absent ».
    send({ id: "kq0", method: "knowledge.search", params: { cwd: knowledgeDir, query: "alpha" } });
    const errKq0 = await waitFor((e) => e.id === "kq0" && e.event === "error", 3000, "knowledge.search kq0");
    assert(
      typeof errKq0.data.message === "string" && errKq0.data.message.includes("index absent"),
      `knowledge.search kq0 : message « index absent — lancer l'indexation » attendu, reçu ${JSON.stringify(errKq0.data)}`,
    );

    // Sources du faux projet : automatique (.iaction/connaissances/), épinglée
    // (hors dossier auto, passée via params.pinned) et détectée (CLAUDE.md).
    await fsp.mkdir(path.join(knowledgeDir, ".iaction", "connaissances"), { recursive: true });
    await fsp.mkdir(path.join(knowledgeDir, "docs"), { recursive: true });
    await fsp.writeFile(path.join(knowledgeDir, ".iaction", "connaissances", "note-alpha.md"), "alpha alpha alpha\n", "utf8");
    const pinnedBetaPath = path.join(knowledgeDir, "docs", "note-beta.md");
    await fsp.writeFile(pinnedBetaPath, "beta beta\n", "utf8");
    await fsp.writeFile(path.join(knowledgeDir, "CLAUDE.md"), "gamma gamma gamma gamma\n", "utf8");

    // knowledge.index : chunks de progression {file, done, total} puis done
    // {files, chunks, model} — 3 fichiers, 1 chunk chacun (textes courts).
    const embedBefore = embedInputsTotal;
    send({ id: "ki1", method: "knowledge.index", params: { cwd: knowledgeDir, pinned: [pinnedBetaPath] } });
    const doneKi1 = await waitFor(
      (e) => e.id === "ki1" && (e.event === "done" || e.event === "error"),
      5000,
      "knowledge.index ki1",
    );
    assert(doneKi1.event === "done", `ki1 attendu 'done', reçu '${doneKi1.event}': ${JSON.stringify(doneKi1.data)}`);
    assert(
      doneKi1.data.files === 3 && doneKi1.data.chunks === 3 && doneKi1.data.model === "fake-embed",
      `ki1 done incorrect (3 fichiers / 3 chunks / fake-embed attendus): ${JSON.stringify(doneKi1.data)}`,
    );
    const progressKi1 = received.filter((e) => e.id === "ki1" && e.event === "chunk");
    assert(progressKi1.length === 3, `ki1 : 3 chunks de progression attendus, reçu ${progressKi1.length}`);
    assert(
      progressKi1.every((e) => typeof e.data.file === "string" && e.data.total === 3) &&
        progressKi1[progressKi1.length - 1].data.done === 3,
      `ki1 : progression {file, done, total} incorrecte: ${JSON.stringify(progressKi1.map((e) => e.data))}`,
    );
    assert(
      embedInputsTotal - embedBefore === 3,
      `ki1 : 3 entrées embeddées attendues (une par chunk), reçu ${embedInputsTotal - embedBefore}`,
    );
    assert(
      lastEmbedBody && lastEmbedBody.model === "fake-embed",
      `ki1 : POST /api/embed doit porter le modèle configuré, reçu ${JSON.stringify(lastEmbedBody)}`,
    );
    // L'index est bien sur disque, au format documenté.
    const metaKi1 = JSON.parse(
      await fsp.readFile(path.join(knowledgeDir, ".iaction", "connaissances-index", "meta.json"), "utf8"),
    );
    assert(
      metaKi1.model === "fake-embed" && metaKi1.dim === 4 && typeof metaKi1.builtAt === "string" &&
        Object.keys(metaKi1.files).length === 3,
      `ki1 meta.json incorrect: ${JSON.stringify(metaKi1)}`,
    );
    const chunksLinesKi1 = (
      await fsp.readFile(path.join(knowledgeDir, ".iaction", "connaissances-index", "chunks.jsonl"), "utf8")
    )
      .split("\n")
      .filter((l) => l.trim().length > 0);
    assert(chunksLinesKi1.length === 3, `ki1 chunks.jsonl : 3 lignes attendues, reçu ${chunksLinesKi1.length}`);
    const firstChunkKi1 = JSON.parse(chunksLinesKi1[0]);
    assert(
      typeof firstChunkKi1.file === "string" && typeof firstChunkKi1.chunkId === "string" &&
        typeof firstChunkKi1.mtimeMs === "number" && typeof firstChunkKi1.text === "string" &&
        Array.isArray(firstChunkKi1.embedding),
      `ki1 chunks.jsonl : forme {file, chunkId, mtimeMs, text, embedding} attendue, reçu ${chunksLinesKi1[0]}`,
    );

    // Incrémental : ré-indexation sans changement -> AUCUNE entrée ré-embeddée.
    const embedBeforeKi2 = embedInputsTotal;
    send({ id: "ki2", method: "knowledge.index", params: { cwd: knowledgeDir, pinned: [pinnedBetaPath] } });
    const doneKi2 = await waitFor(
      (e) => e.id === "ki2" && (e.event === "done" || e.event === "error"),
      5000,
      "knowledge.index ki2",
    );
    assert(
      doneKi2.event === "done" && doneKi2.data.files === 3 && doneKi2.data.chunks === 3,
      `ki2 done incorrect: ${JSON.stringify(doneKi2.data)}`,
    );
    assert(
      embedInputsTotal === embedBeforeKi2,
      `ki2 : fichiers inchangés, aucune entrée ne doit être ré-embeddée (reçu ${embedInputsTotal - embedBeforeKi2})`,
    );

    // Incrémental : un seul fichier modifié -> seules SES entrées repassent par /api/embed.
    await fsp.writeFile(pinnedBetaPath, "beta beta beta modifié\n", "utf8");
    await fsp.utimes(pinnedBetaPath, new Date(), new Date(Date.now() + 2000));
    const embedBeforeKi3 = embedInputsTotal;
    send({ id: "ki3", method: "knowledge.index", params: { cwd: knowledgeDir, pinned: [pinnedBetaPath] } });
    const doneKi3 = await waitFor(
      (e) => e.id === "ki3" && (e.event === "done" || e.event === "error"),
      5000,
      "knowledge.index ki3",
    );
    assert(
      doneKi3.event === "done" && doneKi3.data.chunks === 3,
      `ki3 done incorrect: ${JSON.stringify(doneKi3.data)}`,
    );
    assert(
      embedInputsTotal - embedBeforeKi3 === 1,
      `ki3 : seul le fichier modifié doit être ré-embeddé (1 chunk), reçu ${embedInputsTotal - embedBeforeKi3}`,
    );

    // knowledge.status après indexation -> exists/files/chunks/model/builtAt, stale:false.
    send({ id: "ks1", method: "knowledge.status", params: { cwd: knowledgeDir, pinned: [pinnedBetaPath] } });
    const doneKs1 = await waitFor((e) => e.id === "ks1" && e.event === "done", 3000, "knowledge.status ks1");
    assert(
      doneKs1.data.exists === true && doneKs1.data.files === 3 && doneKs1.data.chunks === 3 &&
        doneKs1.data.model === "fake-embed" && typeof doneKs1.data.builtAt === "string" &&
        doneKs1.data.stale === false,
      `knowledge.status ks1 incorrect: ${JSON.stringify(doneKs1.data)}`,
    );

    // Un document source plus récent que l'index -> stale:true.
    await fsp.utimes(path.join(knowledgeDir, "CLAUDE.md"), new Date(), new Date(Date.now() + 60_000));
    send({ id: "ks2", method: "knowledge.status", params: { cwd: knowledgeDir, pinned: [pinnedBetaPath] } });
    const doneKs2 = await waitFor((e) => e.id === "ks2" && e.event === "done", 3000, "knowledge.status ks2");
    assert(
      doneKs2.data.exists === true && doneKs2.data.stale === true,
      `knowledge.status ks2 : stale:true attendu après modification d'une source, reçu ${JSON.stringify(doneKs2.data)}`,
    );

    // knowledge.search : la requête « alpha » doit classer note-alpha.md en tête.
    send({ id: "kq1", method: "knowledge.search", params: { cwd: knowledgeDir, query: "alpha", topK: 2 } });
    const doneKq1 = await waitFor(
      (e) => e.id === "kq1" && (e.event === "done" || e.event === "error"),
      3000,
      "knowledge.search kq1",
    );
    assert(doneKq1.event === "done", `kq1 attendu 'done', reçu '${doneKq1.event}': ${JSON.stringify(doneKq1.data)}`);
    assert(
      Array.isArray(doneKq1.data.results) && doneKq1.data.results.length === 2,
      `kq1 : 2 résultats attendus (topK), reçu ${JSON.stringify(doneKq1.data)}`,
    );
    const topKq1 = doneKq1.data.results[0];
    assert(
      topKq1.file === path.join(".iaction", "connaissances", "note-alpha.md") &&
        topKq1.excerpt.includes("alpha") &&
        typeof topKq1.score === "number" &&
        topKq1.score > doneKq1.data.results[1].score,
      `kq1 : note-alpha.md attendu en tête avec un score supérieur, reçu ${JSON.stringify(doneKq1.data.results)}`,
    );

    // Index FORGÉ sur disque (spec §5.4) : chunks/meta écrits à la main, sans
    // passer par knowledge.index — la recherche doit les servir tels quels.
    const forgedIndexDir = path.join(forgedDir, ".iaction", "connaissances-index");
    await fsp.mkdir(forgedIndexDir, { recursive: true });
    const forgedChunks = [
      { file: "a.md", chunkId: "a.md#0", mtimeMs: 1, text: "contenu alpha forgé", embedding: [3, 0, 0, 1] },
      { file: "b.md", chunkId: "b.md#0", mtimeMs: 1, text: "contenu beta forgé", embedding: [0, 3, 0, 1] },
    ];
    await fsp.writeFile(
      path.join(forgedIndexDir, "chunks.jsonl"),
      forgedChunks.map((c) => JSON.stringify(c)).join("\n") + "\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(forgedIndexDir, "meta.json"),
      JSON.stringify({ model: "fake-embed", dim: 4, builtAt: "2026-07-27T00:00:00Z", files: { "a.md": 1, "b.md": 1 } }),
      "utf8",
    );
    send({ id: "kq2", method: "knowledge.search", params: { cwd: forgedDir, query: "beta" } });
    const doneKq2 = await waitFor(
      (e) => e.id === "kq2" && (e.event === "done" || e.event === "error"),
      3000,
      "knowledge.search kq2",
    );
    assert(
      doneKq2.event === "done" && doneKq2.data.results[0].file === "b.md" &&
        doneKq2.data.results[0].excerpt === "contenu beta forgé",
      `kq2 (index forgé) : b.md attendu en tête, reçu ${JSON.stringify(doneKq2.data)}`,
    );

    // Outil neutre bout en bout (spec §5.5) : le faux modèle appelle
    // search_knowledge, le sidecar exécute la recherche sur l'index du projet
    // et renvoie le résultat dans la boucle (écho TOOL_RESULT au 2e tour).
    send({
      id: "kn1",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: knowledgeDir,
        messages: [{ role: "user", content: JSON.stringify({ op: "search_knowledge", query: "alpha", topK: 1 }) }],
      },
    });
    const toolUseKn1 = await waitFor(
      (e) => e.id === "kn1" && e.event === "chunk" && e.data.kind === "tool_use",
      3000,
      "kn1 chunk tool_use",
    );
    assert(
      toolUseKn1.data.toolName === "search_knowledge" && toolUseKn1.data.toolInput.query === "alpha",
      `kn1 tool_use incorrect: ${JSON.stringify(toolUseKn1.data)}`,
    );
    const toolResultKn1 = await waitFor(
      (e) => e.id === "kn1" && e.event === "chunk" && e.data.kind === "tool_result",
      3000,
      "kn1 chunk tool_result",
    );
    assert(
      toolResultKn1.data.isError === false && toolResultKn1.data.summary.includes("note-alpha.md"),
      `kn1 tool_result : extrait de note-alpha.md attendu, reçu ${JSON.stringify(toolResultKn1.data)}`,
    );
    const doneKn1 = await waitFor(
      (e) => e.id === "kn1" && (e.event === "done" || e.event === "error"),
      3000,
      "kn1 done",
    );
    assert(
      doneKn1.event === "done" && doneKn1.data.subtype === "success" &&
        typeof doneKn1.data.result === "string" && doneKn1.data.result.startsWith("TOOL_RESULT:") &&
        doneKn1.data.result.includes("note-alpha.md"),
      `kn1 : le résultat de search_knowledge doit être réinjecté dans la boucle, reçu ${JSON.stringify(doneKn1.data)}`,
    );

    // Outil neutre sans index -> tool_result isError:true, message lisible,
    // le tour continue (jamais d'échec du run).
    send({
      id: "kn2",
      method: "neutral.start",
      params: {
        providerId: "neutral",
        model: "model-x",
        cwd: tmpDir,
        messages: [{ role: "user", content: JSON.stringify({ op: "search_knowledge", query: "alpha" }) }],
      },
    });
    const toolResultKn2 = await waitFor(
      (e) => e.id === "kn2" && e.event === "chunk" && e.data.kind === "tool_result",
      3000,
      "kn2 chunk tool_result",
    );
    assert(
      toolResultKn2.data.isError === true && toolResultKn2.data.summary.includes("index absent"),
      `kn2 : tool_result isError « index absent » attendu, reçu ${JSON.stringify(toolResultKn2.data)}`,
    );
    const doneKn2 = await waitFor(
      (e) => e.id === "kn2" && (e.event === "done" || e.event === "error"),
      3000,
      "kn2 done",
    );
    assert(doneKn2.event === "done" && doneKn2.data.subtype === "success", `kn2 done incorrect: ${JSON.stringify(doneKn2.data)}`);

    // 9. fermeture stdin -> exit code 0
    child.stdin.end();
    const code = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout en attendant la sortie du process")), 3000)),
    ]);
    assert(code === 0, `le sidecar doit sortir avec le code 0 à la fermeture de stdin, reçu ${code}`);

    console.log("OK");
    process.exitCode = 0;
  } catch (err) {
    console.error("ECHEC du test protocole:", err.message);
    if (stderrChunks.length > 0) {
      console.error("--- stderr du sidecar ---");
      console.error(stderrChunks.join(""));
    }
    process.exitCode = 1;
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
    await new Promise((resolve) => mockServer.close(resolve));
    await new Promise((resolve) => ollamaServer.close(resolve));
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(knowledgeDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(forgedDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(defaultXdgConfigHome, { recursive: true, force: true }).catch(() => {});
  }
}

main();
