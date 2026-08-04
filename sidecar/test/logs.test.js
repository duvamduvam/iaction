// Tests du journal applicatif (tranche L1) — JS pur, sans framework, sidecar
// piloté en JSON Lines sur stdio comme protocol.test.js.
//
// Contrat vérifié : docs/protocol.md, section « Méthodes L1 — journal
// applicatif (logs) » — log.append (ne rejette jamais, normalise), log.read
// (ordre chronologique, filtres minLevel/scope, `counts` calculé AVANT les
// filtres), log.stats (regroupement par message normalisé) et log.purge.
//
// L'écriture est isolée par un XDG_CONFIG_HOME jetable : aucun test ne doit
// toucher le ~/.config réel de la machine qui lance `npm test`.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "..", "dist", "index.js");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const xdgConfigHome = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-logs-"));

  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_CONFIG_HOME: xdgConfigHome },
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

  let reqSeq = 0;

  /** Envoie une requête et rend l'événement done/error correspondant. */
  async function call(method, params, label = method) {
    reqSeq += 1;
    const id = `log-${reqSeq}`;
    send({ id, method, params });
    const evt = await waitFor((e) => e.id === id && (e.event === "done" || e.event === "error"), 5000, label);
    assert(evt.event === "done", `${label} doit répondre done, reçu ${JSON.stringify(evt)}`);
    return evt.data;
  }

  /**
   * `log.append` répond `done` AVANT que la ligne soit sur le disque
   * (l'écriture est asynchrone et non bloquante, c'est le contrat) : on relit
   * jusqu'à ce que la condition attendue soit vraie.
   */
  async function readUntil(params, predicate, label) {
    const deadline = Date.now() + 5000;
    let last = null;
    while (Date.now() < deadline) {
      last = await call("log.read", params, `log.read (${label})`);
      if (predicate(last)) {
        return last;
      }
      await sleep(50);
    }
    fail(`${label} : condition jamais atteinte, dernière réponse ${JSON.stringify(last)}`);
  }

  try {
    await waitFor((e) => e.event === "ready", 5000, "ready");

    // -----------------------------------------------------------------------
    // 1. Départ propre : log.purge sur un journal inexistant reste un succès.
    // -----------------------------------------------------------------------
    const purgedVide = await call("log.purge", {});
    assert(purgedVide.purged === true, `log.purge sur journal absent doit répondre purged:true, reçu ${JSON.stringify(purgedVide)}`);

    // -----------------------------------------------------------------------
    // 2. log.append — aller-retour, corrélation, et params pourris.
    // -----------------------------------------------------------------------
    const appends = [
      {
        level: "error",
        scope: "claude",
        msg: "tour interrompu par le fournisseur (429)",
        reqId: "run-7::etape-2",
        fields: { httpStatus: 429, providerId: "openrouter" },
      },
      { level: "warn", scope: "knowledge", msg: "source ignorée (trop grosse)" },
      { level: "info", scope: "ui", msg: "page Système montée" },
      { level: "fatal", scope: "rust", msg: "échec du spawn (node)" },
      { level: "error", scope: "claude", msg: "tour interrompu par le fournisseur (503)" },
    ];
    for (const params of appends) {
      const data = await call("log.append", params);
      assert(
        typeof data === "object" && data !== null && Object.keys(data).length === 0,
        `log.append doit répondre done {}, reçu ${JSON.stringify(data)}`,
      );
    }

    // Params pourris : level/scope inconnus, msg absent, fields non-objet,
    // stack non-chaîne. Le contrat interdit tout rejet.
    const pourri = await call(
      "log.append",
      { level: "POUBELLE", scope: 42, msg: { pas: "une chaîne" }, fields: "pas un objet", stack: 12 },
      "log.append (params pourris)",
    );
    assert(
      typeof pourri === "object" && pourri !== null && Object.keys(pourri).length === 0,
      `log.append avec des params pourris doit répondre done {}, reçu ${JSON.stringify(pourri)}`,
    );

    const total = appends.length + 1;
    const lu = await readUntil({}, (d) => Array.isArray(d.entries) && d.entries.length === total, "6 entrées écrites");

    // Ordre chronologique (plus ancien d'abord).
    const timestamps = lu.entries.map((e) => Date.parse(e.ts));
    for (let i = 1; i < timestamps.length; i++) {
      assert(
        Number.isFinite(timestamps[i]) && timestamps[i] >= timestamps[i - 1],
        `log.read doit rendre les entrées en ordre chronologique (index ${i})`,
      );
    }

    const premiere = lu.entries[0];
    assert(premiere.level === "error" && premiere.scope === "claude", `première entrée mal relue: ${JSON.stringify(premiere)}`);
    assert(premiere.msg === "tour interrompu par le fournisseur (429)", `msg mal relu: ${premiere.msg}`);
    assert(premiere.fields.httpStatus === 429, `fields.httpStatus attendu 429, reçu ${JSON.stringify(premiere.fields)}`);
    // `<runId>::<stepId>` déplié automatiquement (même convention qu'events.jsonl).
    assert(
      premiere.reqId === "run-7::etape-2" && premiere.runId === "run-7" && premiere.stepId === "etape-2",
      `corrélation runId/stepId non remplie: ${JSON.stringify(premiere)}`,
    );

    const derniere = lu.entries[total - 1];
    assert(
      derniere.level === "error" && derniere.scope === "sidecar" && derniere.msg === "(sans message)",
      `entrée « params pourris » mal normalisée (error/sidecar/(sans message) attendus): ${JSON.stringify(derniere)}`,
    );
    assert(
      typeof derniere.fields === "object" && derniere.fields !== null && Object.keys(derniere.fields).length === 0,
      `fields non-objet doit devenir {}, reçu ${JSON.stringify(derniere.fields)}`,
    );
    assert(derniere.stack === null, `stack non-chaîne doit devenir null, reçu ${JSON.stringify(derniere.stack)}`);

    const countsAttendus = { fatal: 1, error: 3, warn: 1, info: 1, debug: 0 };
    assert(
      JSON.stringify(lu.counts) === JSON.stringify(countsAttendus),
      `counts attendus ${JSON.stringify(countsAttendus)}, reçus ${JSON.stringify(lu.counts)}`,
    );
    assert(lu.truncated === false, `truncated doit être false sur un petit journal, reçu ${lu.truncated}`);

    // Forme lisible sur stderr (c'est elle que le relais Rust réémet en `sidecar:log`).
    const stderr = stderrChunks.join("");
    assert(
      stderr.includes("ERROR claude tour interrompu par le fournisseur (429)"),
      "stderr doit porter la forme lisible « <LEVEL> <scope> <msg> »",
    );

    // -----------------------------------------------------------------------
    // 3. Filtre minLevel — « au moins aussi grave que ».
    // -----------------------------------------------------------------------
    const warnEtPire = await call("log.read", { minLevel: "warn" }, "log.read minLevel=warn");
    assert(
      warnEtPire.entries.length === 5,
      `minLevel=warn doit ramener fatal+error+warn (5 entrées), reçu ${warnEtPire.entries.length}`,
    );
    assert(
      warnEtPire.entries.every((e) => ["fatal", "error", "warn"].includes(e.level)),
      `minLevel=warn ne doit ramener ni info ni debug: ${JSON.stringify(warnEtPire.entries.map((e) => e.level))}`,
    );
    // counts : calculé AVANT le filtre (compteurs par criticité de la page Système).
    assert(
      JSON.stringify(warnEtPire.counts) === JSON.stringify(countsAttendus),
      `counts ne doit PAS être affecté par minLevel, reçu ${JSON.stringify(warnEtPire.counts)}`,
    );

    const erreurs = await call("log.read", { minLevel: "error" }, "log.read minLevel=error");
    assert(
      erreurs.entries.length === 4 && erreurs.entries.every((e) => e.level === "error" || e.level === "fatal"),
      `minLevel=error doit ramener error+fatal (4 entrées), reçu ${JSON.stringify(erreurs.entries.map((e) => e.level))}`,
    );

    // -----------------------------------------------------------------------
    // 4. Filtre scope — et counts toujours intact.
    // -----------------------------------------------------------------------
    const scopeClaude = await call("log.read", { scope: "claude" }, "log.read scope=claude");
    assert(
      scopeClaude.entries.length === 2 && scopeClaude.entries.every((e) => e.scope === "claude"),
      `scope=claude doit ramener 2 entrées claude, reçu ${JSON.stringify(scopeClaude.entries.map((e) => e.scope))}`,
    );
    assert(
      JSON.stringify(scopeClaude.counts) === JSON.stringify(countsAttendus),
      `counts ne doit PAS être affecté par scope, reçu ${JSON.stringify(scopeClaude.counts)}`,
    );

    // -----------------------------------------------------------------------
    // 5. limit — tronque en gardant les entrées les plus RÉCENTES.
    // -----------------------------------------------------------------------
    const limite = await call("log.read", { limit: 2 }, "log.read limit=2");
    assert(limite.entries.length === 2, `limit=2 doit ramener 2 entrées, reçu ${limite.entries.length}`);
    assert(
      limite.entries[1].msg === derniere.msg,
      `limit doit garder les PLUS RÉCENTES, dernière reçue « ${limite.entries[1].msg} »`,
    );

    // -----------------------------------------------------------------------
    // 6. log.stats — regroupement par message normalisé (nombres → « … »).
    // -----------------------------------------------------------------------
    const stats = await call("log.stats", {});
    assert(
      JSON.stringify(stats.counts) === JSON.stringify(countsAttendus),
      `log.stats counts attendus ${JSON.stringify(countsAttendus)}, reçus ${JSON.stringify(stats.counts)}`,
    );
    assert(Array.isArray(stats.topErrors) && stats.topErrors.length > 0, "log.stats doit rendre un topErrors non vide");
    const groupe = stats.topErrors[0];
    assert(
      groupe.count === 2,
      `les deux « tour interrompu … » (429 / 503) doivent tomber dans le même groupe, reçu ${JSON.stringify(stats.topErrors)}`,
    );
    assert(
      groupe.msg.includes("tour interrompu par le fournisseur") && groupe.msg.includes("…"),
      `le message du groupe doit être normalisé (nombres → …), reçu « ${groupe.msg} »`,
    );
    assert(
      Array.isArray(groupe.scopes) && groupe.scopes.length === 1 && groupe.scopes[0] === "claude",
      `scopes du groupe attendus ["claude"], reçus ${JSON.stringify(groupe.scopes)}`,
    );
    assert(
      typeof groupe.firstMs === "number" && typeof groupe.lastMs === "number" && groupe.lastMs >= groupe.firstMs,
      `firstMs/lastMs incohérents: ${JSON.stringify(groupe)}`,
    );
    // byScope ne compte que error + fatal (l'entrée warn `knowledge` et l'info `ui` en sont exclues).
    assert(
      stats.byScope.claude === 2 && stats.byScope.rust === 1 && stats.byScope.sidecar === 1,
      `byScope attendu {claude:2, rust:1, sidecar:1}, reçu ${JSON.stringify(stats.byScope)}`,
    );
    assert(
      stats.byScope.knowledge === undefined && stats.byScope.ui === undefined,
      `byScope ne doit compter que error+fatal, reçu ${JSON.stringify(stats.byScope)}`,
    );

    // -----------------------------------------------------------------------
    // 7. log.purge — le journal repart de zéro.
    // -----------------------------------------------------------------------
    const purge = await call("log.purge", {});
    assert(purge.purged === true, `log.purge doit répondre purged:true, reçu ${JSON.stringify(purge)}`);
    const apresPurge = await call("log.read", {}, "log.read après purge");
    assert(apresPurge.entries.length === 0, `log.read après purge doit être vide, reçu ${apresPurge.entries.length} entrées`);
    assert(
      JSON.stringify(apresPurge.counts) === JSON.stringify({ fatal: 0, error: 0, warn: 0, info: 0, debug: 0 }),
      `counts après purge doivent être à zéro, reçus ${JSON.stringify(apresPurge.counts)}`,
    );
    const fichierPurge = path.join(xdgConfigHome, "net.duvam.iaction", "logs", "app.jsonl");
    let existeEncore = true;
    try {
      await fsp.stat(fichierPurge);
    } catch {
      existeEncore = false;
    }
    assert(existeEncore === false, `log.purge doit supprimer ${fichierPurge}`);

    // -----------------------------------------------------------------------
    // 8. Fermeture stdin → sortie propre.
    // -----------------------------------------------------------------------
    child.stdin.end();
    const code = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout en attendant la sortie du process")), 3000)),
    ]);
    assert(code === 0, `le sidecar doit sortir avec le code 0 à la fermeture de stdin, reçu ${code}`);

    console.log("OK");
    process.exitCode = 0;
  } catch (err) {
    console.error("ECHEC du test journal (L1):", err.message);
    if (stderrChunks.length > 0) {
      console.error("--- stderr du sidecar ---");
      console.error(stderrChunks.join(""));
    }
    process.exitCode = 1;
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
    await fsp.rm(xdgConfigHome, { recursive: true, force: true }).catch(() => {});
  }
}

main();
