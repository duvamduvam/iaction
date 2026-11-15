/*
 * Outil `compacter` (T-216) — l'agent programme lui-même le compactage.
 *
 * Deux étages, comme changerModele.test.js :
 *  1. en-process, sans SDK : le cœur (`executerCompacter`) contre un faux pont,
 *     et la fabrique contre un faux `sdk.tool` (schéma zod RÉEL) ;
 *  2. un vrai sidecar (faux SDK fakeClaudeModele.mjs, serveur de substitution
 *     IACTION_FAKE_CLAUDE_STUDIO=1 dont les gestionnaires sont les vrais) :
 *     chunk `compaction_demandee`, exposition selon `interactive`, `chatOnly`
 *     et `modeleVerrouille`, annonces de l'instruction système (T-210).
 *
 * Lancement isolé : node sidecar/test/compacterOutil.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, dossierTest, entry, fail, lancer, moduleCompile } from "./harness.mjs";

const { executerCompacter, creerOutilCompacter, COMPACTER_TOOL_NAME, REPONSE_COMPACTER } = await import(
  moduleCompile("compacterOutil.js")
);
const { ANNONCE_CHANGER_MODELE, ANNONCE_COMPACTER } = await import(moduleCompile("paletteTour.js"));
const { z } = await import("zod/v4");

function pont() {
  const emis = [];
  return { emis, emettre: (raison) => emis.push(raison), sessionId: () => "s-test" };
}

await lancer(
  "compacter — cœur de l'outil",
  async () => {
    const p = pont();
    const texte = executerCompacter({ raison: "fin de l'étape 2, contexte lourd" }, p);
    assert(JSON.stringify(p.emis) === JSON.stringify(["fin de l'étape 2, contexte lourd"]), `émission : ${JSON.stringify(p.emis)}`);
    assert(texte === REPONSE_COMPACTER, texte);
    assert(/fin de ce tour/.test(texte) && /Termine ton tour normalement/.test(texte), texte);
    console.log("OK: raison émise, réponse « compactage programmé » rendue au modèle");
  },
  async () => {
    let capte = null;
    const sdk = { tool: (nom, description, schema, gestionnaire) => (capte = { nom, description, schema, gestionnaire }) };
    const p = pont();
    creerOutilCompacter(sdk, z, p);
    assert(capte.nom === "compacter", capte.nom);
    assert(COMPACTER_TOOL_NAME === "mcp__studio__compacter", COMPACTER_TOOL_NAME);
    assert(/jauge élevée/.test(capte.description) && /plus d'une fois par tour/i.test(capte.description), capte.description);
    const schema = z.object(capte.schema);
    assert(schema.safeParse({ raison: "r" }).success, "entrée minimale valide");
    assert(!schema.safeParse({}).success, "raison obligatoire");
    assert(!schema.safeParse({ raison: "" }).success, "raison vide refusée");
    const res = await capte.gestionnaire({ raison: "r" });
    assert(res.content[0].type === "text" && res.content[0].text === REPONSE_COMPACTER && res.isError === undefined, JSON.stringify(res));
    assert(p.emis.length === 1, "le gestionnaire passe par le cœur");
    console.log("OK: fabrique d'outil — nom, description, schéma, résultat");
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
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-compacter-"));
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

await lancer("compacter — dans un vrai sidecar", async () => {
  await avecSidecar(async (ctx) => {
    const ok = await tour(ctx, "t-ok", { compacter: [{ raison: "contexte à 80 %" }] });
    const demandes = ok.chunks.filter((c) => c.kind === "compaction_demandee");
    assert(demandes.length === 1, `un chunk compaction_demandee attendu : ${JSON.stringify(ok.chunks)}`);
    assert(JSON.stringify(demandes[0]) === JSON.stringify({ kind: "compaction_demandee", raison: "contexte à 80 %" }), JSON.stringify(demandes[0]));
    assert(ok.rapport.resultatsCompacter[0].content[0].text === REPONSE_COMPACTER, JSON.stringify(ok.rapport.resultatsCompacter));
    const instr = texteInstruction(ok.rapport.systemPrompt);
    assert(instr.includes(ANNONCE_COMPACTER) && instr.includes(ANNONCE_CHANGER_MODELE), `annonces attendues : ${instr}`);
    console.log("OK: tour interactif — chunk émis, réponse rendue, les deux annonces présentes");

    const verrou = await tour(ctx, "t-verrou", { compacter: [{ raison: "x" }] }, { modeleVerrouille: true });
    assert(verrou.rapport.outils.includes("compacter") && !verrou.rapport.outils.includes("changer_modele"), JSON.stringify(verrou.rapport.outils));
    assert(verrou.chunks.some((c) => c.kind === "compaction_demandee"), "modeleVerrouille ⇒ compacter reste actif");
    const instrVerrou = texteInstruction(verrou.rapport.systemPrompt);
    assert(instrVerrou.includes(ANNONCE_COMPACTER) && !instrVerrou.includes(ANNONCE_CHANGER_MODELE), `annonce de changer_modele hors verrou seulement : ${instrVerrou}`);
    console.log("OK: modeleVerrouille — compacter exposé et annoncé, changer_modele ni l'un ni l'autre");

    const pur = await tour(ctx, "t-pur", { compacter: [{ raison: "x" }] }, { chatOnly: true });
    assert(pur.rapport.hasStudio === false && pur.rapport.resultatsCompacter[0].absent === true, "chatOnly ⇒ outil absent");
    assert(!texteInstruction(pur.rapport.systemPrompt).includes(ANNONCE_COMPACTER), "chatOnly ⇒ pas d'annonce");
    const headless = await tour(ctx, "t-headless", { compacter: [{ raison: "x" }] }, { interactive: false });
    assert(headless.rapport.resultatsCompacter[0].absent === true, "tour headless ⇒ outil absent");
    assert(!texteInstruction(headless.rapport.systemPrompt).includes(ANNONCE_COMPACTER), "headless ⇒ pas d'annonce");
    assert(pur.chunks.concat(headless.chunks).every((c) => c.kind !== "compaction_demandee"), "aucun chunk hors tour interactif");
    console.log("OK: chatOnly et headless — outil absent, rien annoncé, rien émis");
  });
});
