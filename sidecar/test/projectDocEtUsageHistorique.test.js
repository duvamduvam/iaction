/*
 * project.ensureDoc / usage.claude.history
 *
 * T-058 (extension) — ces deux méthodes dispatchées par sidecar/src/index.ts
 * n'avaient aucun test de bout en bout. Vrai sidecar en sous-processus.
 *
 * Lancement isolé : node sidecar/test/projectDocEtUsageHistorique.test.js
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
      fail(`stdout du sidecar (project.ensureDoc/usage.claude.history) a émis une ligne non-JSON: ${line}`);
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
 * project.ensureDoc — dépose/rafraîchit `<cwd>/.iaction/connaissances/iaction.md`,
 * uniquement pour un cwd déjà reconnu comme projet IAction (`.iaction/`
 * existant). Toujours `done` sauf `cwd` manquant/invalide (docs/protocol.md
 * § project.ensureDoc — guide d'intégration du projet).
 */
async function testProjectEnsureDoc() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-ensuredoc-xdg-"));
  const { child, send, waitFor, stderrChunks } = await spawnSidecar(xdgDir);
  let tmpProject = null;
  let tmpNonProjet = null;
  try {
    // 1. Erreur : params.cwd manquant.
    send({ id: "ed1", method: "project.ensureDoc", params: {} });
    const errEd1 = await waitFor((e) => e.id === "ed1" && e.event === "error", 3000, "project.ensureDoc ed1 (cwd manquant)");
    assert(errEd1.data.message.includes("cwd"), `ed1 message inattendu: ${errEd1.data.message}`);

    // 2. Nominal : cwd reconnu comme projet IAction (.iaction/ existant) -> le
    // guide est déposé, marqueur « généré » en première ligne.
    tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-ensuredoc-project-"));
    await fsp.mkdir(path.join(tmpProject, ".iaction"), { recursive: true });
    send({ id: "ed2", method: "project.ensureDoc", params: { cwd: tmpProject } });
    const doneEd2 = await waitFor(
      (e) => e.id === "ed2" && (e.event === "done" || e.event === "error"),
      3000,
      "project.ensureDoc ed2 (nominal)",
    );
    assert(doneEd2.event === "done", `ed2 attendu 'done', reçu '${doneEd2.event}': ${JSON.stringify(doneEd2.data)}`);
    assert(doneEd2.data.ensured === true, `ed2 réponse inattendue: ${JSON.stringify(doneEd2.data)}`);
    const docPath = path.join(tmpProject, ".iaction", "connaissances", "iaction.md");
    const docContent = await fsp.readFile(docPath, "utf8");
    assert(
      docContent.startsWith("<!-- généré par IAction"),
      `ed2 : le fichier déposé doit porter le marqueur « généré », reçu le début: ${docContent.slice(0, 60)}`,
    );

    // 3. Idempotent : un second appel ne change pas le contenu (même octets).
    send({ id: "ed3", method: "project.ensureDoc", params: { cwd: tmpProject } });
    await waitFor((e) => e.id === "ed3" && (e.event === "done" || e.event === "error"), 3000, "project.ensureDoc ed3 (idempotent)");
    const docContentApres = await fsp.readFile(docPath, "utf8");
    assert(docContentApres === docContent, "ed3 : un second appel ne doit pas modifier le contenu déjà à jour");

    // 4. Un fichier édité à la main (sans le marqueur) n'est JAMAIS écrasé.
    await fsp.writeFile(docPath, "édité à la main, aucun marqueur\n", "utf8");
    send({ id: "ed4", method: "project.ensureDoc", params: { cwd: tmpProject } });
    const doneEd4 = await waitFor(
      (e) => e.id === "ed4" && (e.event === "done" || e.event === "error"),
      3000,
      "project.ensureDoc ed4 (édité à la main)",
    );
    assert(doneEd4.event === "done", `ed4 attendu 'done' (best effort, jamais d'erreur), reçu '${doneEd4.event}'`);
    const docContentEdite = await fsp.readFile(docPath, "utf8");
    assert(
      docContentEdite === "édité à la main, aucun marqueur\n",
      "ed4 : un fichier édité à la main ne doit jamais être écrasé",
    );

    // 5. Non-nominal documenté (pas une erreur) : cwd qui n'est PAS un projet
    // IAction (pas de .iaction/) -> toujours 'done', rien n'est créé.
    tmpNonProjet = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-ensuredoc-nonprojet-"));
    send({ id: "ed5", method: "project.ensureDoc", params: { cwd: tmpNonProjet } });
    const doneEd5 = await waitFor(
      (e) => e.id === "ed5" && (e.event === "done" || e.event === "error"),
      3000,
      "project.ensureDoc ed5 (pas un projet IAction)",
    );
    assert(
      doneEd5.event === "done" && doneEd5.data.ensured === true,
      `ed5 doit rester 'done' même hors projet IAction, reçu '${doneEd5.event}' ${JSON.stringify(doneEd5.data)}`,
    );
    const iactionDirCree = await fsp.access(path.join(tmpNonProjet, ".iaction")).then(() => true).catch(() => false);
    assert(!iactionDirCree, "ed5 : aucun dossier .iaction/ ne doit être créé pour un cwd qui n'est pas déjà un projet IAction");
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr (project.ensureDoc) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    if (tmpProject) await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
    if (tmpNonProjet) await fsp.rm(tmpNonProjet, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * usage.claude.history — lecture tolérante de `claude-windows.jsonl`, filtrée
 * par fenêtre de jours. AUCUNE branche d'erreur dans le code
 * (`readJsonlTolerant` ne lève jamais, `params.days` invalide retombe
 * silencieusement sur le défaut 30 — voir sidecar/src/fenetresAbonnement.ts) :
 * testé en nominal, plus le chemin de TOLÉRANCE documenté (lignes
 * corrompues/hors fenêtre écartées sans jamais faire échouer l'appel), à la
 * place d'un `error` que le code ne produit pas.
 */
async function testUsageClaudeHistory() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-usagehist-xdg-"));
  const usageDir = path.join(xdgDir, "net.duvam.iaction", "usage");
  await fsp.mkdir(usageDir, { recursive: true });

  const maintenant = Date.now();
  const ancien = new Date(maintenant - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 jours — hors fenêtre par défaut (30j)
  const recent = new Date(maintenant - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 jour — dans la fenêtre
  const lignes = [
    JSON.stringify({ ts: ancien, windows: { five_hour: { utilization: 10 } } }),
    JSON.stringify({ ts: recent, windows: { five_hour: { utilization: 42 }, seven_day: { utilization: 12 } } }),
    "{ ligne JSON corrompue, jamais fermée", // tolérée : ignorée, pas d'exception
  ].join("\n");
  await fsp.writeFile(path.join(usageDir, "claude-windows.jsonl"), `${lignes}\n`, "utf8");

  const { child, send, waitFor, stderrChunks } = await spawnSidecar(xdgDir);
  try {
    // 1. Nominal (fenêtre par défaut, 30 jours) : seul l'instantané récent
    // passe le filtre, la ligne corrompue est tolérée et écartée.
    send({ id: "uh1", method: "usage.claude.history", params: {} });
    const doneUh1 = await waitFor(
      (e) => e.id === "uh1" && (e.event === "done" || e.event === "error"),
      3000,
      "usage.claude.history uh1 (défaut 30j)",
    );
    assert(doneUh1.event === "done", `uh1 attendu 'done', reçu '${doneUh1.event}': ${JSON.stringify(doneUh1.data)}`);
    assert(
      doneUh1.data.snapshots.length === 1 && doneUh1.data.snapshots[0].ts === recent,
      `uh1 : un seul instantané récent attendu, reçu ${JSON.stringify(doneUh1.data.snapshots)}`,
    );
    assert(
      doneUh1.data.snapshots[0].windows.five_hour.utilization === 42,
      `uh1 : contenu de la fenêtre incorrect, reçu ${JSON.stringify(doneUh1.data.snapshots[0])}`,
    );

    // 2. Nominal, fenêtre élargie (days:90) : l'instantané ancien réapparaît, TRIÉ.
    send({ id: "uh2", method: "usage.claude.history", params: { days: 90 } });
    const doneUh2 = await waitFor(
      (e) => e.id === "uh2" && (e.event === "done" || e.event === "error"),
      3000,
      "usage.claude.history uh2 (days:90)",
    );
    assert(doneUh2.event === "done", `uh2 attendu 'done', reçu '${doneUh2.event}'`);
    assert(
      doneUh2.data.snapshots.length === 2 && doneUh2.data.snapshots[0].ts === ancien && doneUh2.data.snapshots[1].ts === recent,
      `uh2 : deux instantanés triés du plus ancien au plus récent attendus, reçu ${JSON.stringify(doneUh2.data.snapshots)}`,
    );

    // 3. Non-nominal documenté (pas une erreur) : params.days aberrant
    // (négatif) retombe silencieusement sur le défaut 30 — jamais d'`error`.
    send({ id: "uh3", method: "usage.claude.history", params: { days: -5 } });
    const doneUh3 = await waitFor(
      (e) => e.id === "uh3" && (e.event === "done" || e.event === "error"),
      3000,
      "usage.claude.history uh3 (days négatif)",
    );
    assert(
      doneUh3.event === "done" && doneUh3.data.snapshots.length === 1,
      `uh3 : days négatif doit retomber sur le défaut (30j, un seul instantané), reçu '${doneUh3.event}' ${JSON.stringify(doneUh3.data)}`,
    );

    // 4. Non-nominal documenté : fichier claude-windows.jsonl absent (XDG_CONFIG_HOME
    // vierge) -> snapshots:[] , jamais d'erreur.
    const xdgVierge = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-usagehist-vierge-"));
    const { child: child2, send: send2, waitFor: waitFor2, stderrChunks: stderr2 } = await spawnSidecar(xdgVierge);
    try {
      send2({ id: "uh4", method: "usage.claude.history", params: {} });
      const doneUh4 = await waitFor2(
        (e) => e.id === "uh4" && (e.event === "done" || e.event === "error"),
        3000,
        "usage.claude.history uh4 (fichier absent)",
      );
      assert(
        doneUh4.event === "done" && JSON.stringify(doneUh4.data.snapshots) === "[]",
        `uh4 : snapshots:[] attendu sans fichier, reçu '${doneUh4.event}' ${JSON.stringify(doneUh4.data)}`,
      );
    } finally {
      if (child2.exitCode === null) child2.kill();
      if (stderr2.length > 0 && process.exitCode) {
        console.error("--- stderr (usage.claude.history, xdg vierge) ---");
        console.error(stderr2.join(""));
      }
      await fsp.rm(xdgVierge, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr (usage.claude.history) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer(
  "project.ensureDoc / usage.claude.history",
  testProjectEnsureDoc,
  testUsageClaudeHistory,
);
