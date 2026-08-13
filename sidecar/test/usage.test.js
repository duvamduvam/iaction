/*
 * usage.claude
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/usage.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { lancer, assert, entry, fail, fakeClaudeWithUsageModule } from "./harness.mjs";

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

await lancer(
  "usage.claude",
  testUsageClaudeWithFakeSdk,
);
