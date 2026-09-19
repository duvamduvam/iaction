/*
 * T-102 bout en bout : le battement d'un sous-agent en vol (chunk
 * `sous_agent_battement`) et le rappel factuel donné au tour SUIVANT après un
 * abandon avec sous-agent encore en vol.
 *
 * Scénario (fakeClaudeSousAgent.mjs) : un `Agent` est lancé, deux outils sont
 * vus chez lui (Bash puis WebSearch), puis 38 minutes de silence sont simulées
 * par un blocage jusqu'à `claude.abort`. Le tour suivant, sur la même session,
 * doit recevoir en tête de son prompt un rappel citant la description du
 * sous-agent et sa durée — c'est ce que le faux moteur renvoie tel quel dans
 * `result`, pour vérification directe.
 *
 * Lancement isolé : node sidecar/test/sousAgentBattementEtRappel.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { lancer, assert, dossierTest, entry, fail } from "./harness.mjs";

const fakeModule = path.join(dossierTest, "fakeClaudeSousAgent.mjs");

/** Même patron que `spawnFakeSidecar` de claudeTours.test.js (harnais propre
 *  à ce fichier — voir la règle de harness.mjs : un helper de domaine vit à
 *  côté de ses tests, pas dans le socle commun). */
function spawnFakeSidecar() {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, IACTION_FAKE_CLAUDE: "1", IACTION_FAKE_CLAUDE_MODULE: fakeModule },
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
      fail(`stdout du sidecar fakeClaudeSousAgent a émis une ligne non-JSON: ${line}`);
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
        console.error("--- stderr du sidecar fakeClaudeSousAgent ---");
        console.error(stderrChunks.join(""));
      }
      if (child.exitCode === null) child.kill();
    },
  };
}

async function testBattementEtRappel() {
  const h = spawnFakeSidecar();
  try {
    await h.waitFor((e) => e.event === "ready", 3000, "ready (fakeClaudeSousAgent)");

    // --- Premier tour : lance le sous-agent, observe son battement.
    h.send({ id: "cl-1", method: "claude.start", params: { cwd: "/tmp", prompt: "Écris le support micro" } });
    const init = await h.waitFor((e) => e.id === "cl-1" && e.event === "chunk" && e.data.kind === "init", 3000, "chunk init");
    const sessionId = init.data.sessionId;
    assert(typeof sessionId === "string" && sessionId.length > 0, "sessionId attendu dans le chunk init");

    // Avant ce chantier, ce chunk n'existait pas : T-092 avait retiré tout
    // relais du détail d'un sous-agent, sans rien mettre à la place.
    const battements = [];
    for (let i = 0; i < 2; i++) {
      const b = await h.waitFor(
        (e) => e.id === "cl-1" && e.event === "chunk" && e.data.kind === "sous_agent_battement" && !battements.includes(e),
        3000,
        `chunk sous_agent_battement #${i + 1}`,
      );
      battements.push(b);
    }
    assert(
      battements[0].data.toolUseId === "agent-1" && battements[0].data.outils === 1 && battements[0].data.dernierOutil === "Bash",
      `premier battement attendu {agent-1,1,Bash}, reçu ${JSON.stringify(battements[0].data)}`,
    );
    assert(
      battements[1].data.outils === 2 && battements[1].data.dernierOutil === "WebSearch",
      `second battement CUMULÉ attendu (outils:2, dernier:WebSearch), reçu ${JSON.stringify(battements[1].data)}`,
    );
    assert(typeof battements[1].data.instant === "number", "le battement doit porter un instant (epoch ms)");

    // Aucun tool_use/tool_result du sous-agent ne doit fuiter dans le fil
    // (T-092 : seul le battement en sort, jamais le détail).
    const fuite = h.received.find(
      (e) => e.id === "cl-1" && e.event === "chunk" && (e.data.kind === "tool_use" || e.data.kind === "tool_result") && e.data.toolUseId !== "agent-1",
    );
    assert(!fuite, `aucun tool_use/tool_result du sous-agent ne doit atteindre le fil, reçu ${JSON.stringify(fuite?.data)}`);

    // --- Abandon : 38 minutes de silence simulées, l'utilisateur interrompt.
    h.send({ id: "ab-1", method: "claude.abort", params: { targetId: "cl-1" } });
    const doneAbort = await h.waitFor((e) => e.id === "ab-1" && e.event === "done", 3000, "claude.abort done");
    assert(doneAbort.data.aborted === true, `abort attendu aborted:true, reçu ${JSON.stringify(doneAbort.data)}`);
    await h.waitFor((e) => e.id === "cl-1" && e.event === "done", 3000, "done du premier tour (clôture anormale)");

    // --- Second tour, même session : le prompt doit porter le rappel EN TÊTE.
    h.send({
      id: "cl-2",
      method: "claude.start",
      params: { cwd: "/tmp", prompt: "c'est vraiment super long c'est bloqué ?", sessionId },
    });
    const doneTour2 = await h.waitFor((e) => e.id === "cl-2" && e.event === "done", 3000, "done du second tour");
    const texteRecu = doneTour2.data.result;
    assert(typeof texteRecu === "string", `le second tour doit renvoyer le prompt reçu, reçu ${JSON.stringify(doneTour2.data)}`);
    assert(
      texteRecu.includes("Écrire le .scad du support micro"),
      `le rappel doit citer la description du sous-agent interrompu, reçu: ${texteRecu}`,
    );
    assert(
      texteRecu.includes("`Agent`"),
      `le rappel doit nommer explicitement l'outil \`Agent\`, reçu: ${texteRecu}`,
    );
    assert(
      texteRecu.endsWith("c'est vraiment super long c'est bloqué ?"),
      `le texte ORIGINAL doit rester lisible, à la SUITE du rappel, reçu: ${texteRecu}`,
    );

    // --- Un rappel n'est consommé qu'UNE fois : un troisième tour ne doit
    // plus le porter (sans quoi le modèle relirait la même alerte à chaque
    // tour, la banalisant).
    h.send({ id: "cl-3", method: "claude.start", params: { cwd: "/tmp", prompt: "et sinon ?", sessionId } });
    const doneTour3 = await h.waitFor((e) => e.id === "cl-3" && e.event === "done", 3000, "done du troisième tour");
    assert(
      doneTour3.data.result === "et sinon ?",
      `le rappel ne doit être consommé qu'une fois, reçu: ${JSON.stringify(doneTour3.data.result)}`,
    );
  } catch (err) {
    h.fermer(err);
    throw err;
  }
  h.fermer(null);
}

await lancer("battement de sous-agent et rappel d'interruption (T-102)", testBattementEtRappel);
