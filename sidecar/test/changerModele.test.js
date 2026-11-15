/*
 * Outil `changer_modele` (T-207) — docs/spec-changement-modele-auto.md.
 *
 * Deux étages :
 *  1. en-process, sans SDK : le cœur de l'outil (`executerChangerModele`,
 *     `appliquerSurQuery`) contre un FAUX query qui enregistre ses appels, et
 *     la fabrique d'outil contre un faux `sdk.tool` (schéma zod RÉEL) ;
 *  2. un vrai sidecar (faux SDK fakeClaudeModele.mjs, serveur de substitution
 *     IACTION_FAKE_CLAUDE_STUDIO=1 dont les gestionnaires sont les vrais) :
 *     exposition de l'outil, chunk `model_change`, échec, `claude.setModel`.
 *
 * Lancement isolé : node sidecar/test/changerModele.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, dossierTest, entry, fail, lancer, moduleCompile } from "./harness.mjs";

const { executerChangerModele, appliquerSurQuery, creerOutilChangerModele, MODELES_CHANGEABLES, CHANGER_MODELE_TOOL_NAME } =
  await import(moduleCompile("changerModele.js"));
const { z } = await import("zod/v4");

/** Faux query : enregistre les appels, peut échouer à la demande. */
function fauxQuery({ echec = null } = {}) {
  const appels = [];
  return {
    appels,
    async setModel(m) {
      appels.push(["setModel", m]);
      if (echec === "setModel" && m !== "claude-fable-5-1") throw new Error("setModel refusé");
    },
    async applyFlagSettings(s) {
      appels.push(["applyFlagSettings", s]);
      if (echec === "applyFlagSettings") throw new Error("applyFlagSettings refusé");
    },
  };
}

/** Pont de test : l'état vit ici, comme dans claude.ts. */
function pont(query, etat = { model: "claude-fable-5-1", effort: "high" }) {
  const emis = [];
  return {
    emis,
    etat: () => ({ ...etat }),
    appliquer: async (modele, effort) => {
      await appliquerSurQuery(query, { ...etat }, modele, effort);
      etat.model = modele;
      if (effort !== undefined) etat.effort = effort;
    },
    emettre: (c) => emis.push(c),
    sessionId: () => "s-test",
  };
}

await lancer(
  "changer_modele — cœur de l'outil",
  async () => {
    const q = fauxQuery();
    const p = pont(q);
    const r = await executerChangerModele({ modele: "claude-opus-5-5", effort: "medium", raison: "travail courant" }, p);
    assert(!r.erreur, `pas d'erreur attendue : ${r.texte}`);
    assert(
      JSON.stringify(q.appels) === JSON.stringify([["setModel", "claude-opus-5-5"], ["applyFlagSettings", { effortLevel: "medium" }]]),
      `appels faux query : ${JSON.stringify(q.appels)}`,
    );
    assert(p.emis.length === 1, "un événement de changement attendu");
    assert(
      JSON.stringify(p.emis[0]) ===
        JSON.stringify({ from: "claude-fable-5-1", to: "claude-opus-5-5", effortFrom: "high", effortTo: "medium", raison: "travail courant" }),
      `événement : ${JSON.stringify(p.emis[0])}`,
    );
    assert(r.texte.includes("claude-fable-5-1") && r.texte.includes("claude-opus-5-5") && r.texte.includes("medium"), r.texte);
    console.log("OK: setModel + applyFlagSettings appelés avec les bonnes valeurs, événement émis");
  },
  async () => {
    const q = fauxQuery();
    const p = pont(q);
    await executerChangerModele({ modele: "claude-sonnet-5-5", raison: "exécution" }, p);
    assert(JSON.stringify(q.appels) === JSON.stringify([["setModel", "claude-sonnet-5-5"]]), `effort omis ⇒ pas d'applyFlagSettings : ${JSON.stringify(q.appels)}`);
    assert(p.emis[0].effortFrom === "high" && p.emis[0].effortTo === "high", "effort omis ⇒ inchangé dans l'événement");
    console.log("OK: effort omis — seul setModel part, l'effort reste");
  },
  async () => {
    const q = fauxQuery();
    const p = pont(q);
    const r = await executerChangerModele({ modele: "claude-fable-5-1", effort: "high", raison: "rien à changer" }, p);
    assert(!r.erreur && /déjà en place/i.test(r.texte), r.texte);
    assert(q.appels.length === 0 && p.emis.length === 0, "modèle ET effort identiques ⇒ aucun appel, aucun événement");
    const r2 = await executerChangerModele({ modele: "claude-fable-5-1", raison: "même modèle, effort omis" }, p);
    assert(/déjà en place/i.test(r2.texte) && q.appels.length === 0, "modèle identique, effort omis ⇒ rien");
    // Suffixe de fenêtre rapporté par le SDK : même modèle.
    const p3 = pont(fauxQuery(), { model: "claude-opus-5-5[1m]", effort: null });
    const r3 = await executerChangerModele({ modele: "claude-opus-5-5", raison: "x" }, p3);
    assert(/déjà en place/i.test(r3.texte) && p3.emis.length === 0, "suffixe [1m] ignoré à la comparaison");
    console.log("OK: modèle identique — « déjà en place », aucun appel");
  },
  async () => {
    const q = fauxQuery();
    const p = pont(q);
    const r = await executerChangerModele({ modele: "claude-fable-5-1", effort: "max", raison: "effort seul" }, p);
    assert(!r.erreur && p.emis.length === 1 && q.appels.length === 2, "même modèle mais effort différent ⇒ le changement a lieu");
    console.log("OK: même modèle, effort différent — appliqué");
  },
  async () => {
    const q = fauxQuery({ echec: "setModel" });
    const p = pont(q);
    const r = await executerChangerModele({ modele: "claude-haiku-5-5", effort: "low", raison: "x" }, p);
    assert(r.erreur === true && r.texte.includes("setModel refusé"), `isError attendu : ${JSON.stringify(r)}`);
    assert(p.emis.length === 0, "échec ⇒ aucun événement de changement");
    assert(p.etat().model === "claude-fable-5-1", "échec ⇒ l'état du moteur est inchangé");
    console.log("OK: échec de setModel — erreur rendue, pas d'événement");
  },
  async () => {
    // setModel passe, applyFlagSettings échoue : le modèle d'avant est remis.
    const q = fauxQuery({ echec: "applyFlagSettings" });
    const p = pont(q);
    const r = await executerChangerModele({ modele: "claude-opus-5-5", effort: "low", raison: "x" }, p);
    assert(r.erreur === true && p.emis.length === 0, "échec d'effort ⇒ erreur, pas d'événement");
    assert(
      JSON.stringify(q.appels.map((a) => a[0] === "setModel" ? a[1] : a[0])) === JSON.stringify(["claude-opus-5-5", "applyFlagSettings", "claude-fable-5-1"]),
      `le modèle d'avant doit être remis : ${JSON.stringify(q.appels)}`,
    );
    console.log("OK: échec d'effort — retour arrière du modèle, pas de demi-changement");
  },
  async () => {
    let erreur = null;
    try {
      await appliquerSurQuery({}, { model: null, effort: null }, "claude-opus-5-5", undefined);
    } catch (err) {
      erreur = err.message;
    }
    assert(erreur && erreur.includes("setModel absent"), `query sans setModel ⇒ erreur franche : ${erreur}`);
    console.log("OK: query sans setModel — erreur franche, jamais muette");
  },
  async () => {
    // La fabrique : schéma zod réel, gestionnaire branché sur le cœur.
    let capte = null;
    const sdk = { tool: (nom, description, schema, gestionnaire) => (capte = { nom, description, schema, gestionnaire }) };
    const q = fauxQuery();
    const p = pont(q);
    creerOutilChangerModele(sdk, z, p);
    assert(capte.nom === "changer_modele", capte.nom);
    assert(CHANGER_MODELE_TOOL_NAME === "mcp__studio__changer_modele", CHANGER_MODELE_TOOL_NAME);
    assert(/Fable/.test(capte.description) && /plus d'une fois par demande/.test(capte.description), "description en français attendue");
    const schema = z.object(capte.schema);
    assert(schema.safeParse({ modele: "claude-opus-5-5", raison: "r" }).success, "entrée minimale valide");
    assert(!schema.safeParse({ modele: "gpt-9", raison: "r" }).success, "modèle hors liste refusé");
    assert(!schema.safeParse({ modele: "claude-opus-5-5" }).success, "raison obligatoire");
    assert(!schema.safeParse({ modele: "claude-opus-5-5", raison: "r", effort: "extreme" }).success, "effort inconnu refusé");
    assert(schema.safeParse({ modele: "claude-haiku-5-5", raison: "r", effort: "xhigh" }).success, "xhigh accepté");
    assert(MODELES_CHANGEABLES.length === 4, "quatre modèles de l'abonnement");
    const res = await capte.gestionnaire({ modele: "claude-opus-5-5", raison: "r" });
    assert(res.content[0].type === "text" && res.isError === undefined, JSON.stringify(res));
    const q2 = fauxQuery({ echec: "setModel" });
    capte = null;
    creerOutilChangerModele(sdk, z, pont(q2));
    const res2 = await capte.gestionnaire({ modele: "claude-opus-5-5", raison: "r" });
    assert(res2.isError === true, "échec ⇒ isError: true");
    console.log("OK: fabrique d'outil — schéma, description, isError");
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
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-modele-"));
  try {
    ctx.send({
      id,
      method: "claude.start",
      params: { cwd, prompt: JSON.stringify(scenario), model: "claude-fable-5-1", effort: "high", interactive: true, ...params },
    });
    const done = await ctx.waitFor((e) => e.id === id && e.event !== "chunk", `fin du tour ${id}`);
    assert(done.event === "done", `done attendu : ${JSON.stringify(done)}`);
    const chunks = ctx.received.filter((e) => e.id === id && e.event === "chunk").map((e) => e.data);
    return { chunks, rapport: JSON.parse(done.data.result) };
  } finally {
    await fsp.rm(cwd, { recursive: true, force: true });
  }
}

await lancer(
  "changer_modele — dans un vrai sidecar",
  async () => {
    await avecSidecar(async (ctx) => {
      const { chunks, rapport } = await tour(ctx, "t-ok", {
        appels: [{ modele: "claude-opus-5-5", effort: "medium", raison: "travail courant" }],
      });
      const changements = chunks.filter((c) => c.kind === "model_change");
      assert(changements.length === 1, `un chunk model_change attendu : ${JSON.stringify(chunks)}`);
      assert(changements[0].from === "claude-fable-5-1" && changements[0].to === "claude-opus-5-5", JSON.stringify(changements[0]));
      assert(changements[0].effortFrom === "high" && changements[0].effortTo === "medium", JSON.stringify(changements[0]));
      assert(
        JSON.stringify(rapport.recus) === JSON.stringify([["setModel", "claude-opus-5-5"], ["applyFlagSettings", { effortLevel: "medium" }]]),
        `le moteur doit avoir reçu setModel puis applyFlagSettings : ${JSON.stringify(rapport.recus)}`,
      );
      assert(!rapport.resultats[0].isError, JSON.stringify(rapport.resultats));
      console.log("OK: tour interactif — chunk model_change émis, moteur appelé");
    });
  },
  async () => {
    await avecSidecar(async (ctx) => {
      // Deux appels : le second revient au modèle courant ⇒ « déjà en place ».
      const { chunks, rapport } = await tour(ctx, "t-deux", {
        appels: [
          { modele: "claude-opus-5-5", raison: "a" },
          { modele: "claude-opus-5-5", raison: "b" },
        ],
      });
      assert(chunks.filter((c) => c.kind === "model_change").length === 1, "le second appel (identique) n'émet rien");
      assert(rapport.recus.length === 1, `un seul setModel attendu : ${JSON.stringify(rapport.recus)}`);
      console.log("OK: deuxième appel identique — aucun effet");
    });
  },
  async () => {
    await avecSidecar(async (ctx) => {
      const { chunks, rapport } = await tour(ctx, "t-echec", {
        echec: "setModel",
        appels: [{ modele: "claude-haiku-5-5", raison: "x" }],
      });
      assert(chunks.every((c) => c.kind !== "model_change"), "échec ⇒ aucun chunk model_change");
      assert(rapport.resultats[0].isError === true, JSON.stringify(rapport.resultats));
      console.log("OK: échec de setModel — isError, aucun chunk de changement");
    });
  },
  async () => {
    await avecSidecar(async (ctx) => {
      const verrouille = await tour(ctx, "t-verrou", { appels: [{ modele: "claude-opus-5-5", raison: "x" }] }, { modeleVerrouille: true });
      // T-216 : `compacter` reste exposé sous verrou — seul `changer_modele` doit manquer.
      assert(!verrouille.rapport.outils.includes("changer_modele") && verrouille.rapport.resultats[0].absent === true, "modeleVerrouille ⇒ outil absent");
      assert(verrouille.chunks.every((c) => c.kind !== "model_change"), "modeleVerrouille ⇒ aucun changement");
      const pur = await tour(ctx, "t-pur", { appels: [{ modele: "claude-opus-5-5", raison: "x" }] }, { chatOnly: true });
      assert(pur.rapport.hasStudio === false && pur.rapport.resultats[0].absent === true, "chatOnly ⇒ outil absent");
      const headless = await tour(ctx, "t-headless", { appels: [{ modele: "claude-opus-5-5", raison: "x" }] }, { interactive: false });
      assert(headless.rapport.resultats[0].absent === true, "tour headless ⇒ outil absent (écart assumé, voir claude.ts)");
      const normal = await tour(ctx, "t-normal", { appels: [] });
      assert(normal.rapport.outils.includes("changer_modele"), "tour interactif ordinaire ⇒ outil exposé");
      console.log("OK: modeleVerrouille, chatOnly, headless — outil absent ; tour interactif — présent");
    });
  },
  async () => {
    await avecSidecar(async (ctx) => {
      // claude.setModel (bouton « Annuler ») sur un tour VIVANT.
      const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-modele-"));
      try {
        ctx.send({
          id: "t-vivant",
          method: "claude.start",
          params: { cwd, prompt: JSON.stringify({ appels: [], attente: true }), model: "claude-opus-5-5", effort: "medium", interactive: true },
        });
        await ctx.waitFor((e) => e.id === "t-vivant" && e.event === "chunk" && e.data.kind === "init", "init");
        ctx.send({ id: "sm-1", method: "claude.setModel", params: { targetId: "t-vivant", model: "claude-fable-5-1", effort: null } });
        const ok = await ctx.waitFor((e) => e.id === "sm-1", "réponse claude.setModel");
        assert(ok.event === "done" && ok.data.applied === true, JSON.stringify(ok));
        ctx.send({ id: "sm-2", method: "claude.setModel", params: { targetId: "t-vivant", model: "claude-fable-5-1", effort: "extreme" } });
        const ko = await ctx.waitFor((e) => e.id === "sm-2", "réponse claude.setModel effort invalide");
        assert(ko.event === "error", `effort invalide ⇒ error : ${JSON.stringify(ko)}`);
        ctx.send({ id: "sm-3", method: "claude.setModel", params: { targetId: "inconnu", model: "claude-fable-5-1" } });
        const absent = await ctx.waitFor((e) => e.id === "sm-3", "réponse claude.setModel tour inconnu");
        assert(absent.event === "done" && absent.data.applied === false, JSON.stringify(absent));
        ctx.send({ id: "p-1", method: "claude.push", params: { targetId: "t-vivant", content: "fin" } });
        const done = await ctx.waitFor((e) => e.id === "t-vivant" && e.event !== "chunk", "fin du tour vivant");
        const rapport = JSON.parse(done.data.result);
        assert(
          JSON.stringify(rapport.recus) === JSON.stringify([["setModel", "claude-fable-5-1"], ["applyFlagSettings", { effortLevel: null }]]),
          `le moteur doit avoir reçu le rétablissement : ${JSON.stringify(rapport.recus)}`,
        );
        console.log("OK: claude.setModel — tour vivant rétabli, effort invalide refusé, tour inconnu ⇒ applied:false");
      } finally {
        await fsp.rm(cwd, { recursive: true, force: true });
      }
    });
  },
);
