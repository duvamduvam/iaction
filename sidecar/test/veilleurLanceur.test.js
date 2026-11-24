/*
 * Lanceur réel du veilleur (veilleurLanceur.ts), moteur FACTICE injecté :
 * paramètres imposés (perso, headless, consigne, Bash), session par fil, coût,
 * borne de durée, arrêt, refus des permissions, et jamais d'exception.
 *
 * Lancement isolé : node sidecar/test/veilleurLanceur.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, fail, moduleCompile } from "./harness.mjs";

const { creerLanceur, outilsDuTour, composerPrompt, coutDuMessage, ecartDePerimetre } = await import(moduleCompile("veilleurLanceur.js"));
const { creerMemoireFils } = await import(moduleCompile("veilleurFils.js"));

let ok = 0;
const cas = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    fail(`${nom} : ${e.message}`);
  }
};

const config = {
  actif: true,
  expediteurs: ["maison"],
  agent: null,
  compte: "teams", // ignoré : le lanceur impose perso
  modele: "claude-opus-5-5",
  effort: "medium",
  permission: "bypassPermissions",
  bash: true,
  plafonds: { profondeur: 6, coutParMessage: 5, toursParJour: 100, dureeMin: 20 },
  cadenceSec: 30,
  url: "https://relay.example.net",
  jetonSecret: "relais.jeton",
};
const message = { fil: "f1", id: "m1", type: "demande", profondeur: 0, corps: "publie le site" };
const sansPieces = { pieces: { ecrites: [], refusees: [] } };
const fils = async () => creerMemoireFils(path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "lanceur-fils-")), "fils.json"));
const suivreTour = { ouvrir() {}, fermer() {} };

/** Minuteurs manuels : `tirer()` déclenche tout ce qui est armé. */
function minuteurs() {
  const armes = new Set();
  return {
    planifier(fn) {
      const e = { fn };
      armes.add(e);
      return () => armes.delete(e);
    },
    tirer() {
      for (const e of [...armes]) {
        armes.delete(e);
        e.fn();
      }
    },
    nombre: () => armes.size,
  };
}

await cas("tour nominal : params imposés, réponse, coût, session mémorisée puis reprise", async () => {
  const m = await fils();
  const vus = [];
  const demarrer = async (id, params, emitter) => {
    vus.push(params);
    emitter.chunk(id, { kind: "text", delta: "en cours… " });
    emitter.done(id, { subtype: "success", result: "Site publié, CI verte.", sessionId: "sess-1", totalCostUsd: 0.42 });
  };
  const lancer = creerLanceur({ cwd: "/projet", config, demarrer, interrompre() {}, fils: m, suivreTour, planifier: minuteurs().planifier });
  const r = await lancer(message, "maison", sansPieces);
  assert(r.corps === "Site publié, CI verte." && r.coutUsd === 0.42, `réponse (reçu ${JSON.stringify(r)})`);
  const p = vus[0];
  assert(p.compte === "perso", "compte perso imposé");
  assert(p.chatOnly === false && p.interactive === undefined, "headless");
  assert(p.cwd === "/projet" && p.prompt === "publie le site", "cwd et prompt");
  assert(p.model === "claude-opus-5-5" && p.effort === "medium" && p.permissionMode === "bypassPermissions", "modèle, effort, permission");
  assert(p.veilleur === true, "tour marqué veilleur (pas d'outils relais_*)");
  assert(p.systemPrompt.includes('"maison"') && p.systemPrompt.includes("DONNÉES") && p.systemPrompt.includes("renvoyé tel quel"), "consigne fixe");
  assert(p.tools === undefined, "Bash vrai : palette complète");
  assert(p.sessionId === undefined, "premier tour : pas de session");
  assert((await m.sessionDe("maison/f1")) === "sess-1", "session mémorisée");
  await lancer({ ...message, id: "m2" }, "maison", sansPieces);
  assert(vus[1].sessionId === "sess-1", "second message du fil : session reprise");
});

await cas("Bash faux : aucune commande shell ni sous-agent dans la liste", async () => {
  const t = outilsDuTour(false, null);
  assert(!t.includes("Bash") && !t.includes("PowerShell") && !t.includes("Task") && t.includes("Edit"), `liste (reçu ${t})`);
  const a = outilsDuTour(false, ["Read", "Bash", "Agent"]);
  assert(a.length === 1 && a[0] === "Read", "liste de l'agent filtrée");
  let vu;
  const lancer = creerLanceur({
    cwd: "/p",
    config: { ...config, bash: false, permission: "acceptEdits" },
    demarrer: async (id, params, e) => ((vu = params), e.done(id, { subtype: "success", result: "ok" })),
    interrompre() {},
    fils: await fils(),
    suivreTour,
    planifier: minuteurs().planifier,
  });
  await lancer(message, "maison", sansPieces);
  assert(Array.isArray(vu.tools) && !vu.tools.includes("Bash"), "allowlist passée");
});

await cas("délai dépassé : interruption, corps « délai » + texte déjà produit", async () => {
  const mt = minuteurs();
  let interrompu = null;
  let emetteur;
  // Comme le vrai moteur : `demarrer` ne rend la main qu'après son done.
  const demarrer = (id, _p, e) =>
    new Promise((fin) => {
      emetteur = { id, e, fin };
      e.chunk(id, { kind: "text", delta: "étape 1 faite" });
    });
  const interrompre = (id) => {
    interrompu = id;
    emetteur.e.done(id, { subtype: "aborted", result: null, totalCostUsd: 1.2 });
    emetteur.fin();
  };
  const lancer = creerLanceur({ cwd: "/p", config, demarrer, interrompre, fils: await fils(), suivreTour, planifier: mt.planifier });
  const promesse = lancer(message, "maison", sansPieces);
  await new Promise((r) => setTimeout(r, 10));
  mt.tirer();
  const r = await promesse;
  assert(interrompu === emetteur.id, "moteur interrompu");
  assert(r.corps.startsWith("Délai de 20 min dépassé, tour interrompu.") && r.corps.includes("étape 1 faite"), `corps (reçu ${r.corps})`);
  assert(r.coutUsd === 1.2, "coût rendu");
});

await cas("interruption sans done du moteur : la main n'est PAS rendue (aucun tour vivant affiché fini)", async () => {
  const mt = minuteurs();
  let rendu = false;
  let e2;
  const lancer = creerLanceur({ cwd: "/p", config, demarrer: (id, _p, e) => new Promise((fin) => (e2 = { id, e, fin })), interrompre() {}, fils: await fils(), suivreTour, planifier: mt.planifier });
  const promesse = lancer(message, "maison", sansPieces).then((r) => ((rendu = true), r));
  await new Promise((r) => setTimeout(r, 10));
  mt.tirer(); // délai
  await new Promise((r) => setTimeout(r, 10));
  mt.tirer(); // aucune grâce ne doit exister
  await new Promise((r) => setTimeout(r, 10));
  assert(!rendu, "toujours en attente du moteur");
  e2.e.done(e2.id, { subtype: "aborted" });
  e2.fin();
  const r = await promesse;
  assert(r.corps.startsWith("Délai de 20 min dépassé") && r.interrompu === true && r.coutUsd === null, "rendu au vrai done");
});

await cas("arrêt déjà demandé : demarrer n'est JAMAIS appelé", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  let demarre = false;
  const lancer = creerLanceur({ cwd: "/p", config, demarrer: async () => void (demarre = true), interrompre() {}, fils: await fils(), suivreTour, planifier: minuteurs().planifier });
  const r = await lancer(message, "maison", { ...sansPieces, signal: ctrl.signal });
  assert(!demarre, "aucun tour ouvert");
  assert(r.corps.includes("avant le tour"), r.corps);
});

await cas("run inconnu du moteur : l'interruption est réessayée jusqu'à être prise", async () => {
  const mt = minuteurs();
  const ctrl = new AbortController();
  let essais = 0;
  let e2;
  const interrompre = (id) => {
    essais += 1;
    if (essais < 3) return false; // le moteur n'a pas encore enregistré le run
    e2.e.done(id, { subtype: "aborted" });
    e2.fin();
    return true;
  };
  const lancer = creerLanceur({ cwd: "/p", config, demarrer: (id, _p, e) => new Promise((fin) => (e2 = { id, e, fin })), interrompre, fils: await fils(), suivreTour, planifier: mt.planifier });
  const promesse = lancer(message, "maison", { ...sansPieces, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 10));
  ctrl.abort();
  for (let i = 0; i < 5 && essais < 3; i++) {
    await new Promise((r) => setTimeout(r, 5));
    mt.tirer();
  }
  const r = await promesse;
  assert(essais === 3, `trois essais (reçu ${essais})`);
  assert(r.corps.startsWith("Veilleur arrêté") && r.interrompu === true, r.corps);
});

await cas("périmètre : mcp:false et plafond de coût passé au moteur ; arrêt au plafond = dépassement", async () => {
  let vu;
  const agent = { name: "pub", engine: "claude", instructions: "", tools: null, mcp: true, model: null, permissionMode: "default" };
  const lancer = creerLanceur({
    cwd: "/p",
    config: { ...config, agent: "pub" },
    demarrer: async (id, p, e) => ((vu = p), e.done(id, { subtype: "error_max_budget_usd", totalCostUsd: 5.3 })),
    interrompre() {},
    resoudreAgent: async () => ({ ok: true, value: agent }),
    fils: await fils(),
    suivreTour,
    planifier: minuteurs().planifier,
  });
  const r = await lancer(message, "maison", sansPieces);
  assert(vu.mcp === false, "aucun MCP du projet, même si l'agent en veut");
  assert(vu.maxBudgetUsd === 5, "budget au moteur");
  assert(r.depassement === true && r.corps.startsWith("Plafond de coût atteint"), r.corps);
});

await cas("coût d'un message : écart avec le cumul de la session reprise", async () => {
  assert(coutDuMessage(3, 1, true) === 2, "écart");
  assert(coutDuMessage(3, 1, false) === 3, "session neuve : total");
  assert(coutDuMessage(0.5, 1, true) === 0.5, "cumul plus petit (transcript sans total) : total");
  assert(coutDuMessage(null, 1, true) === null, "inconnu");
  const m = await fils();
  let total = 1.0;
  const l = creerLanceur({ cwd: "/p", config, demarrer: async (id, _p, e) => e.done(id, { subtype: "success", result: "ok", sessionId: "s", totalCostUsd: total }), interrompre() {}, fils: m, suivreTour, planifier: minuteurs().planifier });
  const r1 = await l(message, "maison", sansPieces);
  total = 1.75;
  const r2 = await l({ ...message, id: "m2" }, "maison", sansPieces);
  assert(r1.coutUsd === 1 && Math.abs(r2.coutUsd - 0.75) < 1e-9, `coûts ${r1.coutUsd} puis ${r2.coutUsd}`);
});

await cas("arrêt du veilleur : corps « veilleur arrêté »", async () => {
  const ctrl = new AbortController();
  let e2;
  const lancer = creerLanceur({
    cwd: "/p",
    config,
    demarrer: (id, _p, e) => new Promise((fin) => (e2 = { id, e, fin })),
    interrompre: (id) => (e2.e.done(id, { subtype: "aborted" }), e2.fin()),
    fils: await fils(),
    suivreTour,
    planifier: minuteurs().planifier,
  });
  const promesse = lancer(message, "maison", { ...sansPieces, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 10));
  ctrl.abort();
  const r = await promesse;
  assert(r.corps.startsWith("Veilleur arrêté, tour interrompu."), `corps (reçu ${r.corps})`);
});

await cas("erreur du moteur ou exception : corps d'échec lisible, jamais de levée ni de pile", async () => {
  const l1 = creerLanceur({ cwd: "/p", config, demarrer: async (id, _p, e) => e.error(id, "Claude Perso indisponible"), interrompre() {}, fils: await fils(), suivreTour, planifier: minuteurs().planifier });
  const r1 = await l1(message, "maison", sansPieces);
  assert(r1.corps === "Échec du tour : Claude Perso indisponible", `erreur (reçu ${r1.corps})`);
  const l2 = creerLanceur({ cwd: "/p", config, demarrer: async () => { throw new Error("boum"); }, interrompre() {}, fils: await fils(), suivreTour, planifier: minuteurs().planifier });
  const r2 = await l2(message, "maison", sansPieces);
  assert(r2.corps.startsWith("Échec du tour : boum") && !r2.corps.includes("at "), "exception rendue sans pile");
  const l3 = creerLanceur({ cwd: "/p", config, demarrer: async () => {}, interrompre() {}, fils: await fils(), suivreTour, planifier: minuteurs().planifier });
  const r3 = await l3(message, "maison", sansPieces);
  assert(r3.corps.includes("sans issue de tour"), "moteur rendu sans done : dit, pas d'attente sans fin");
});

await cas("permission demandée : refusée aussitôt (aucun humain)", async () => {
  const refus = [];
  const lancer = creerLanceur({
    cwd: "/p",
    config,
    demarrer: async (id, _p, e) => {
      e.chunk(id, { kind: "permission_request", permissionId: "perm-1", toolName: "WebFetch" });
      e.done(id, { subtype: "success", result: "fait sans" });
    },
    interrompre() {},
    refuserPermission: (id, permissionId) => refus.push({ id, permissionId }),
    fils: await fils(),
    suivreTour,
    planifier: minuteurs().planifier,
  });
  await lancer(message, "maison", sansPieces);
  assert(refus.length === 1 && refus[0].permissionId === "perm-1", "refusée");
});

await cas("agent : instructions ajoutées, moteur non Claude refusé", async () => {
  let vu;
  const agent = { name: "pub", engine: "claude", instructions: "Tu publies.", tools: null, mcp: false, model: null, permissionMode: "default" };
  const l = creerLanceur({
    cwd: "/p",
    config: { ...config, agent: "pub" },
    demarrer: async (id, p, e) => ((vu = p), e.done(id, { subtype: "success", result: "ok" })),
    interrompre() {},
    resoudreAgent: async () => ({ ok: true, value: agent }),
    fils: await fils(),
    suivreTour,
    planifier: minuteurs().planifier,
  });
  await l(message, "maison", sansPieces);
  assert(vu.systemPrompt.startsWith("Tu publies.") && vu.systemPrompt.includes("relais"), "instructions + consigne");
  assert(vu.mcp === false, "mcp:false imposé");
  const l2 = creerLanceur({ cwd: "/p", config: { ...config, agent: "x" }, demarrer: async () => {}, resoudreAgent: async () => ({ ok: true, value: { ...agent, engine: "neutral" } }), fils: await fils(), suivreTour });
  const r = await l2(message, "maison", sansPieces);
  assert(r.corps.includes("n'est pas un agent Claude"), "neutre refusé");
});

await cas("session perdue : oubliée, et dit à l'émetteur", async () => {
  const m = await fils();
  await m.memoriserSession("maison/f1", "vieille");
  const l = creerLanceur({ cwd: "/p", config, demarrer: async (id, _p, e) => e.done(id, { subtype: "error_during_execution", sessionPerdue: true }), interrompre() {}, fils: m, suivreTour, planifier: minuteurs().planifier });
  const r = await l(message, "maison", sansPieces);
  assert(r.corps.includes("n'existe plus"), "dit");
  assert((await m.sessionDe("maison/f1")) === null, "oubliée");
});

await cas("périmètre constaté à l'init : serveur étranger ou navigateur ⇒ tour interrompu, suspension demandée", async () => {
  assert(ecartDePerimetre([{ name: "iaction", tools: ["mcp__iaction__search_chat"] }, { name: "studio", tools: [] }]) === null, "internes : conforme");
  assert(ecartDePerimetre([{ name: "claude-in-chrome", tools: ["mcp__claude-in-chrome__navigate"] }]).includes("navigateur"), "navigateur vu");
  assert(ecartDePerimetre([{ name: "github", tools: [] }]).includes("inattendu"), "serveur du projet vu");
  for (const serveurs of [[{ name: "github", tools: ["mcp__github__push"] }], [{ name: "iaction", tools: [] }, { name: "claude-in-chrome", tools: ["mcp__claude-in-chrome__tabs"] }]]) {
    let interrompu = 0;
    let e2;
    const lancer = creerLanceur({
      cwd: "/p",
      config,
      demarrer: (id, _p, e) =>
        new Promise((fin) => {
          e2 = { id, e, fin };
          e.chunk(id, { kind: "init", mcpServers: serveurs });
        }),
      interrompre: (id) => {
        interrompu += 1;
        e2.e.done(id, { subtype: "aborted", totalCostUsd: 0 });
        e2.fin();
        return true;
      },
      fils: await fils(),
      suivreTour,
      planifier: minuteurs().planifier,
    });
    const r = await lancer(message, "maison", sansPieces);
    assert(interrompu === 1, "interrompu à l'init");
    assert(r.corps.startsWith("Tour interrompu avant toute action") && r.suspension?.includes("périmètre"), r.corps);
  }
});

await cas("interruption ACCEPTÉE mais aucun done après 60 s : blocage signalé", async () => {
  const mt = minuteurs();
  const ctrl = new AbortController();
  const blocages = [];
  let e2;
  const lancer = creerLanceur({
    cwd: "/p",
    config,
    demarrer: (id, _p, e) => new Promise((fin) => (e2 = { id, e, fin })),
    interrompre: () => true, // accepté… mais le moteur ne rend jamais son done
    surBlocage: (m) => blocages.push(m),
    fils: await fils(),
    suivreTour,
    planifier: mt.planifier,
  });
  const promesse = lancer(message, "maison", { ...sansPieces, signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 10));
  ctrl.abort();
  await new Promise((r) => setTimeout(r, 10));
  mt.tirer(); // minuteur de durée et de blocage armés : seul le blocage compte ici
  assert(blocages.length === 1 && blocages[0].includes("relance l'application"), `blocage (reçu ${blocages})`);
  e2.e.done(e2.id, { subtype: "aborted" });
  e2.fin();
  await promesse;
});

await cas("session indexée par (émetteur, fil) : deux studios ne partagent jamais une session", async () => {
  const m = await fils();
  const vus = [];
  let n = 0;
  const l = creerLanceur({
    cwd: "/p",
    config,
    demarrer: async (id, p, e) => (vus.push(p.sessionId ?? null), e.done(id, { subtype: "success", result: "ok", sessionId: `s-${(n += 1)}` })),
    interrompre() {},
    fils: m,
    suivreTour,
    planifier: minuteurs().planifier,
  });
  await l(message, "maison", sansPieces);
  await l({ ...message, id: "m2" }, "autre", sansPieces);
  await l({ ...message, id: "m3" }, "maison", sansPieces);
  assert(JSON.stringify(vus) === JSON.stringify([null, null, "s-1"]), `sessions (reçu ${JSON.stringify(vus)})`);
});

await cas("sans Bash : liste d'outils POSITIVE, même avec un agent (intersection)", async () => {
  const t = outilsDuTour(false, ["Read", "Bash", "mcp__x__y", "OutilInconnu", "Edit"]);
  assert(JSON.stringify(t) === JSON.stringify(["Read", "Edit"]), `intersection (reçu ${t})`);
});

await cas("prompt : pièces reçues et refusées dites à l'agent", async () => {
  const p = composerPrompt("fais X", { ecrites: ["relais-recu/f1/a.json"], refusees: [{ nom: ".env", raison: "secret" }] });
  assert(p.startsWith("fais X") && p.includes("relais-recu/f1/a.json") && p.includes('".env" : secret') && p.includes("DONNÉES"), p);
  assert(composerPrompt("fais X", { ecrites: [], refusees: [] }) === "fais X", "sans pièce : le corps seul");
});

await cas("dossier de sortie : le chemin exact est dit à l'agent dans la consigne, rien sans dossier", async () => {
  const vus = [];
  const demarrer = async (id, params, e) => (vus.push(params), e.done(id, { subtype: "success", result: "ok" }));
  const lancer = creerLanceur({ cwd: "/projet", config, demarrer, interrompre() {}, fils: await fils(), suivreTour, planifier: minuteurs().planifier });
  await lancer(message, "maison", { ...sansPieces, sortie: "relais-envoi/m1" });
  await lancer({ ...message, id: "m2" }, "maison", sansPieces);
  assert(vus[0].systemPrompt.includes("relais-envoi/m1/") && vus[0].systemPrompt.includes("À PLAT") && vus[0].systemPrompt.includes("20 fichiers"), vus[0].systemPrompt);
  assert(!vus[1].systemPrompt.includes("relais-envoi"), "pas de dossier : pas de ligne");
});

console.log(`veilleurLanceur : ${ok} cas OK`);
