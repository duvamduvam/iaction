/*
 * Les deux silences d'un tour Claude (T-015).
 *
 * Le défaut vécu le 2026-08-09 : un tour démarre, aucune bulle n'apparaît,
 * aucune erreur non plus, et le journal applicatif — celui que lit la page
 * Système — ne contient RIEN entre le démarrage du tour et le silence.
 * L'interface reste sur « Aucune donnée reçue du fournisseur », indéfiniment.
 *
 * Deux silences distincts, deux garde-fous, un bloc chacun :
 *
 *   1. le flux se REFERME sans `result` (processus disparu en cours de route) ;
 *   2. le flux ne rend JAMAIS le moindre message et ne se referme pas — c'est
 *      le cas réellement observé, qu'aucune fin de flux ne peut rattraper :
 *      seul le plafond de silence (SILENCE_DEMARRAGE_TIMEOUT_MS) le peut.
 *
 * Dans les deux cas on vérifie la même chose : l'interface reçoit un `error`
 * explicite, et le journal une ligne `error` nommant session et modèle — sans
 * jamais de corps de réponse.
 *
 * Lancement isolé : node sidecar/test/claudeSilence.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lancer, assert, dossierTest, entry, fail } from "./harness.mjs";

/**
 * Démarre un sidecar avec un faux moteur donné, dans une configuration
 * JETABLE : le journal relu par le test ne doit contenir que ce que ce tour y
 * a écrit.
 */
async function demarrerSidecar(fakeModule, envSupplement = {}) {
  const xdgConfigHome = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-silence-"));
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfigHome,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: path.join(dossierTest, fakeModule),
      ...envSupplement,
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

  function waitFor(predicate, timeoutMs = 5000, label = "événement") {
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

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du sidecar a émis une ligne non-JSON: ${line}`);
      return;
    }
    received.push(parsed);
    notifyWaiters(parsed);
  });
  child.stderr.on("data", () => {});

  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /**
   * Relit le journal jusqu'à y trouver une entrée `error` : l'écriture
   * d'`app.jsonl` est mise en file (journal.enqueueWrite), donc elle n'est pas
   * encore sur le disque quand l'`error` atteint l'interface. Attendre une
   * réponse plutôt qu'un délai fixe évite un test qui dépend de la machine.
   */
  async function lireErreursDuJournal(prefixe) {
    let entrees = [];
    for (let essai = 0; essai < 40 && entrees.length === 0; essai++) {
      send({ id: `${prefixe}-${essai}`, method: "log.read", params: { minLevel: "error" } });
      const lu = await waitFor(
        (e) => e.id === `${prefixe}-${essai}` && e.event === "done",
        5000,
        "log.read minLevel=error",
      );
      entrees = lu.data.entries;
      if (entrees.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    return entrees;
  }

  async function arreter() {
    child.kill();
    await fsp.rm(xdgConfigHome, { recursive: true, force: true }).catch(() => {});
  }

  await waitFor((e) => e.event === "ready", 5000, "ready");
  return { send, waitFor, received, lireErreursDuJournal, arreter };
}

/** Vérifie qu'une ligne de journal ne transporte aucun corps de réponse. */
function assertPasDeCorpsDeReponse(ligne) {
  assert(
    !("result" in ligne.fields),
    `le journal ne doit jamais porter de corps de réponse, reçu ${JSON.stringify(ligne.fields)}`,
  );
}

/** 1. Le flux se referme sans `result` : erreur explicite + journal. */
async function testTourSansResultat() {
  const sc = await demarrerSidecar("fakeClaudeSansResultat.mjs");
  try {
    sc.send({ id: "muet-1", method: "claude.start", params: { cwd: "/tmp", prompt: "bonjour ?" } });

    // Le tour démarre bien (le chunk init prouve que le silence qui suit n'est
    // pas un refus de démarrer, mais bien une mort en cours de route).
    await sc.waitFor(
      (e) => e.id === "muet-1" && e.event === "chunk" && e.data.kind === "init",
      5000,
      "chunk init du tour muet",
    );

    const err = await sc.waitFor(
      (e) => e.id === "muet-1" && e.event === "error",
      5000,
      "error du tour muet",
    );
    assert(
      typeof err.data?.message === "string" && err.data.message.includes("sans résultat"),
      `l'erreur doit dire que le tour s'est terminé sans résultat, reçu ${JSON.stringify(err.data)}`,
    );
    assert(
      !sc.received.some((e) => e.id === "muet-1" && e.event === "done"),
      "un tour mort sans résultat ne doit PAS être annoncé comme terminé (done)",
    );

    const entrees = await sc.lireErreursDuJournal("lecture");
    const ligne = entrees.find((e) => e.msg === "tour Claude terminé sans résultat");
    assert(
      ligne !== undefined,
      `le journal doit contenir « tour Claude terminé sans résultat », reçu ${JSON.stringify(
        entrees.map((e) => e.msg),
      )}`,
    );
    assert(
      ligne.level === "error" && ligne.scope === "claude" && ligne.reqId === "muet-1",
      `la ligne de journal doit être error/claude/muet-1, reçu ${JSON.stringify(ligne)}`,
    );
    assert(
      ligne.fields.sessionId === "fake-session-muette" && ligne.fields.sortieAssistant === false,
      `la ligne doit nommer la session et dire qu'aucun contenu n'est sorti, reçu ${JSON.stringify(ligne.fields)}`,
    );
    assertPasDeCorpsDeReponse(ligne);
  } finally {
    await sc.arreter();
  }
}

/**
 * 2. Le flux ne rend RIEN et ne se referme pas : seul le plafond de silence
 *    peut trancher. Le plafond est ramené à 400 ms par
 *    IACTION_SILENCE_DEMARRAGE_MS — un test qui dormirait les 120 s réelles ne
 *    serait jamais lancé, donc ne prouverait rien.
 */
async function testPlafondDeSilence() {
  const sc = await demarrerSidecar("fakeClaudeMuet.mjs", { IACTION_SILENCE_DEMARRAGE_MS: "400" });
  try {
    const debut = Date.now();
    sc.send({
      id: "silence-1",
      method: "claude.start",
      params: { cwd: "/tmp", prompt: "quelqu'un ?", model: "modele-test" },
    });

    const err = await sc.waitFor(
      (e) => e.id === "silence-1" && e.event === "error",
      5000,
      "error du plafond de silence",
    );
    const ecoule = Date.now() - debut;
    assert(
      typeof err.data?.message === "string" && err.data.message.includes("aucun signe de vie"),
      `l'erreur doit dire que le moteur n'a donné aucun signe de vie, reçu ${JSON.stringify(err.data)}`,
    );
    assert(
      ecoule >= 400,
      `le plafond ne doit pas se déclencher avant son délai (écoulé ${ecoule} ms)`,
    );
    assert(
      !sc.received.some((e) => e.id === "silence-1" && (e.event === "done" || e.event === "chunk")),
      "un tour jamais démarré ne doit produire ni chunk ni done",
    );

    const entrees = await sc.lireErreursDuJournal("lecture-silence");
    const ligne = entrees.find((e) => e.msg === "tour Claude sans aucun message du SDK");
    assert(
      ligne !== undefined,
      `le journal doit contenir « tour Claude sans aucun message du SDK », reçu ${JSON.stringify(
        entrees.map((e) => e.msg),
      )}`,
    );
    assert(
      ligne.level === "error" && ligne.scope === "claude" && ligne.reqId === "silence-1",
      `la ligne doit être error/claude/silence-1, reçu ${JSON.stringify(ligne)}`,
    );
    assert(
      ligne.fields.plafondMs === 400 && ligne.fields.attenteMs >= 400,
      `la ligne doit porter le plafond et la durée écoulée, reçu ${JSON.stringify(ligne.fields)}`,
    );
    assert(
      ligne.fields.model === "modele-test",
      `la ligne doit nommer le modèle demandé, reçu ${JSON.stringify(ligne.fields)}`,
    );
    assertPasDeCorpsDeReponse(ligne);

    // Le plafond ne frappe qu'UNE fois : pas de second verdict après coup.
    await new Promise((r) => setTimeout(r, 600));
    assert(
      sc.received.filter((e) => e.id === "silence-1" && e.event === "error").length === 1,
      "le plafond de silence ne doit signaler l'échec qu'une seule fois",
    );
  } finally {
    await sc.arreter();
  }
}

await lancer("silences d'un tour Claude", testTourSansResultat, testPlafondDeSilence);
