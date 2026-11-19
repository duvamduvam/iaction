/*
 * Outil `programmer_reveil` (T-219) — l'agent arme lui-même le réveil d'IAction.
 *
 * Deux étages, comme compacterOutil.test.js :
 *  1. en-process, sans SDK : le cœur (`executerReveil`) contre un faux pont,
 *     et la fabrique contre un faux `sdk.tool` (schéma zod RÉEL) ;
 *  2. un vrai sidecar (faux SDK fakeClaudeModele.mjs, serveur de substitution
 *     IACTION_FAKE_CLAUDE_STUDIO=1 dont les gestionnaires sont les vrais) :
 *     chunk `reveil_demande`, exposition selon `interactive`/`chatOnly`/
 *     `modeleVerrouille`, annonce de l'instruction système, et outils Cron du
 *     CLI interdits (`disallowedTools`).
 *
 * Lancement isolé : node sidecar/test/reveilOutil.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, dossierTest, entry, fail, lancer, moduleCompile } from "./harness.mjs";

const { executerReveil, creerOutilReveil, REVEIL_TOOL_NAME, REPONSE_REVEIL, OUTILS_CRON_INTERDITS } = await import(
  moduleCompile("reveilOutil.js")
);
const { ANNONCE_REVEIL } = await import(moduleCompile("paletteTour.js"));
const { z } = await import("zod/v4");

function pont() {
  const emis = [];
  return { emis, emettre: (d) => emis.push(d), sessionId: () => "s-test" };
}

const valide = { heures: ["19:00"], surResetQuota: false, prompts: ["reprends le lot 3"], raison: "reprise à 19 h" };

await lancer(
  "programmer_reveil — cœur de l'outil",
  async () => {
    const p = pont();
    const r = executerReveil(valide, p);
    assert(!r.erreur && r.texte === REPONSE_REVEIL, JSON.stringify(r));
    assert(/annulable dans le contrôle ⏰/.test(r.texte) && /reste ouverte/.test(r.texte) && /normalement/.test(r.texte), r.texte);
    assert(JSON.stringify(p.emis) === JSON.stringify([valide]), `émission : ${JSON.stringify(p.emis)}`);
    console.log("OK: demande valide émise telle quelle, réponse « réveil armé » rendue au modèle");
  },
  async () => {
    const p = pont();
    const r = executerReveil({ heures: [" 3:00", "19:00", "19:00", "25:00", "midi"], prompts: [" go ", "  "], raison: "x" }, p);
    assert(!r.erreur, JSON.stringify(r));
    assert(
      JSON.stringify(p.emis[0].heures) === JSON.stringify(["19:00", "3:00"]),
      `heures normalisées, invalides et doublons écartés : ${JSON.stringify(p.emis[0].heures)}`,
    );
    assert(JSON.stringify(p.emis[0].prompts) === JSON.stringify(["go"]) && p.emis[0].surResetQuota === false, JSON.stringify(p.emis[0]));
    console.log("OK: heures invalides écartées, doublons fondus, prompts nettoyés, surResetQuota faux par défaut");
  },
  async () => {
    const p = pont();
    const r = executerReveil({ heures: [], surResetQuota: true, prompts: ["reprends"], raison: "reset" }, p);
    assert(!r.erreur && p.emis.length === 1 && p.emis[0].surResetQuota === true && p.emis[0].heures.length === 0, JSON.stringify([r, p.emis]));
    console.log("OK: sans heure mais au reset du quota — accepté");
  },
  async () => {
    const p = pont();
    const sansHeure = executerReveil({ heures: ["midi", "24:00"], surResetQuota: false, prompts: ["go"], raison: "x" }, p);
    assert(sansHeure.erreur && /aucune heure valide/.test(sansHeure.texte), JSON.stringify(sansHeure));
    const sansPrompt = executerReveil({ heures: ["19:00"], prompts: [], raison: "x" }, p);
    assert(sansPrompt.erreur && /prompts/.test(sansPrompt.texte), JSON.stringify(sansPrompt));
    const blancs = executerReveil({ heures: ["19:00"], prompts: ["   "], raison: "x" }, p);
    assert(blancs.erreur, "prompts blancs refusés");
    assert(p.emis.length === 0, `un refus n'émet rien : ${JSON.stringify(p.emis)}`);
    console.log("OK: aucune heure valide (hors reset) ou prompts vides — refus texte, rien d'émis");
  },
  async () => {
    let capte = null;
    const sdk = { tool: (nom, description, schema, gestionnaire) => (capte = { nom, description, schema, gestionnaire }) };
    const p = pont();
    creerOutilReveil(sdk, z, p);
    assert(capte.nom === "programmer_reveil", capte.nom);
    assert(REVEIL_TOOL_NAME === "mcp__studio__programmer_reveil", REVEIL_TOOL_NAME);
    assert(/CronCreate/.test(capte.description) && /ScheduleWakeup/.test(capte.description) && /reste ouverte/.test(capte.description), capte.description);
    const schema = z.object(capte.schema);
    assert(schema.safeParse(valide).success, "entrée valide");
    assert(schema.safeParse({ heures: [], prompts: ["a"], raison: "r" }).data.surResetQuota === false, "surResetQuota : faux par défaut");
    assert(!schema.safeParse({ ...valide, prompts: [] }).success, "prompts non vide");
    assert(!schema.safeParse({ ...valide, raison: "" }).success, "raison obligatoire");
    assert(!schema.safeParse({ prompts: ["a"], raison: "r" }).success, "heures obligatoire (tableau, éventuellement vide)");
    const ok = await capte.gestionnaire(valide);
    assert(ok.content[0].text === REPONSE_REVEIL && ok.isError === undefined && p.emis.length === 1, JSON.stringify(ok));
    const ko = await capte.gestionnaire({ heures: [], prompts: ["a"], raison: "r" });
    assert(ko.isError === true && /aucune heure valide/.test(ko.content[0].text) && p.emis.length === 1, JSON.stringify(ko));
    console.log("OK: fabrique d'outil — nom, description, schéma, résultat et erreur");
  },
  async () => {
    for (const nom of ["CronCreate", "CronList", "CronDelete", "ScheduleWakeup"]) {
      assert(OUTILS_CRON_INTERDITS.includes(nom), `${nom} doit être interdit`);
    }
    assert(OUTILS_CRON_INTERDITS.length === 4, JSON.stringify(OUTILS_CRON_INTERDITS));
    console.log("OK: les 4 outils Cron du CLI figurent dans la liste d'interdits");
  },
);

/* ── Un vrai sidecar piloté (faux SDK dédié) ────────────────────────────── */

async function avecSidecar(corps) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      IACTION_FAKE_CLAUDE: "1",
      IACTION_FAKE_CLAUDE_MODULE: path.join(dossierTest, "fakeClaudeModele.mjs"),
      IACTION_FAKE_CLAUDE_STUDIO: "1",
    },
  });
  const received = [];
  const waiters = [];
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      fail(`ligne non-JSON sur stdout : ${line}`);
      return;
    }
    received.push(evt);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(evt)) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(evt);
      }
    }
  });
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const waitFor = (predicate, label) => {
    const existing = received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => reject(new Error(`timeout en attendant ${label}`)), 5000);
      waiters.push(w);
    });
  };
  try {
    await waitFor((e) => e.event === "ready", "ready");
    return await corps({ send, waitFor, received });
  } finally {
    child.kill();
  }
}

/** Lance un tour et rend { chunks, rapport } (le `result` JSON du faux SDK). */
async function tour(ctx, id, scenario, params = {}) {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-reveil-"));
  try {
    ctx.send({
      id,
      method: "claude.start",
      params: { cwd, prompt: JSON.stringify(scenario), model: "claude-opus-5-5", interactive: true, ...params },
    });
    const done = await ctx.waitFor((e) => e.id === id && e.event !== "chunk", `fin du tour ${id}`);
    assert(done.event === "done", `done attendu : ${JSON.stringify(done)}`);
    const chunks = ctx.received.filter((e) => e.id === id && e.event === "chunk").map((e) => e.data);
    return { chunks, rapport: JSON.parse(done.data.result) };
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true });
  }
}

/** Texte de l'instruction système, quelle que soit sa forme (preset + append, ou chaîne). */
function texteInstruction(systemPrompt) {
  if (typeof systemPrompt === "string") return systemPrompt;
  return systemPrompt?.append ?? "";
}

await lancer("programmer_reveil — dans un vrai sidecar", async () => {
  await avecSidecar(async (ctx) => {
    const ok = await tour(ctx, "t-ok", { reveil: [valide] });
    const demandes = ok.chunks.filter((c) => c.kind === "reveil_demande");
    assert(demandes.length === 1, `un chunk reveil_demande attendu : ${JSON.stringify(ok.chunks)}`);
    assert(JSON.stringify(demandes[0]) === JSON.stringify({ kind: "reveil_demande", ...valide }), JSON.stringify(demandes[0]));
    assert(ok.rapport.resultatsReveil[0].content[0].text === REPONSE_REVEIL, JSON.stringify(ok.rapport.resultatsReveil));
    assert(texteInstruction(ok.rapport.systemPrompt).includes(ANNONCE_REVEIL), "annonce de l'outil attendue");
    for (const nom of ["CronCreate", "CronList", "CronDelete", "ScheduleWakeup"]) {
      assert(ok.rapport.disallowedTools.includes(nom), `${nom} doit être dans disallowedTools : ${JSON.stringify(ok.rapport.disallowedTools)}`);
    }
    assert(ok.rapport.disallowedTools.includes("AskUserQuestion"), "la liste existante est conservée");
    console.log("OK: tour interactif — chunk émis, réponse rendue, annonce présente, outils Cron interdits");

    const refus = await tour(ctx, "t-refus", { reveil: [{ heures: [], prompts: ["go"], raison: "x" }] });
    assert(refus.rapport.resultatsReveil[0].isError === true, JSON.stringify(refus.rapport.resultatsReveil));
    assert(refus.chunks.every((c) => c.kind !== "reveil_demande"), "un refus n'émet aucun chunk");
    console.log("OK: demande sans échéance — erreur rendue au modèle, aucun chunk");

    const verrou = await tour(ctx, "t-verrou", { reveil: [valide] }, { modeleVerrouille: true });
    assert(verrou.rapport.outils.includes("programmer_reveil") && !verrou.rapport.outils.includes("changer_modele"), JSON.stringify(verrou.rapport.outils));
    assert(verrou.chunks.some((c) => c.kind === "reveil_demande"), "modeleVerrouille ⇒ programmer_reveil reste actif");
    console.log("OK: modeleVerrouille — programmer_reveil exposé");

    const pur = await tour(ctx, "t-pur", { reveil: [valide] }, { chatOnly: true });
    assert(pur.rapport.hasStudio === false && pur.rapport.resultatsReveil[0].absent === true, "chatOnly ⇒ outil absent");
    assert(!texteInstruction(pur.rapport.systemPrompt).includes(ANNONCE_REVEIL), "chatOnly ⇒ pas d'annonce");
    const headless = await tour(ctx, "t-headless", { reveil: [valide] }, { interactive: false });
    assert(headless.rapport.resultatsReveil[0].absent === true, "tour headless ⇒ outil absent");
    assert(!texteInstruction(headless.rapport.systemPrompt).includes(ANNONCE_REVEIL), "headless ⇒ pas d'annonce");
    assert(pur.chunks.concat(headless.chunks).every((c) => c.kind !== "reveil_demande"), "aucun chunk hors tour interactif");
    console.log("OK: chatOnly et headless — outil absent, rien annoncé, rien émis");
  });
});
