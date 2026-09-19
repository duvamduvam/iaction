/*
 * Comptabilité des push non acquittés (T-087) — sidecar/src/poussesEnAttente.ts.
 *
 * Fonctions pures : pas besoin d'un faux SDK, juste le module compilé.
 * Le passage par un vrai tour (fakeClaudePushPerdu.mjs) vit dans
 * claudeTours.test.js — ici on isole la RÈGLE de comptabilité elle-même.
 *
 * Lancement isolé : node sidecar/test/poussesEnAttente.test.js
 */

import { promises as fsp } from "node:fs";
import { lancer, assert, moduleCompile } from "./harness.mjs";

const { creerRegistrePushes, signalerPushesPerdus, executerClaudePush } = await import(
  moduleCompile("poussesEnAttente.js")
);
const { appLogPath } = await import(moduleCompile("journal.js"));
const { flushWrites } = await import(moduleCompile("jsonlStore.js"));

async function testRegistreVideParDefaut() {
  const registre = creerRegistrePushes();
  assert(registre.vider().length === 0, "registre neuf : rien à vider");
  console.log("OK: creerRegistrePushes — registre vide par défaut");
}

async function testEnregistrerPuisVider() {
  const registre = creerRegistrePushes();
  registre.enregistrer("ajoute le CHANGELOG", false);
  registre.enregistrer("regarde cette capture", true);
  const restants = registre.vider();
  assert(restants.length === 2, `2 push en attente attendus, reçu ${restants.length}`);
  assert(
    restants[0].contenu === "ajoute le CHANGELOG" && restants[0].avaitPieces === false,
    `premier push incorrect: ${JSON.stringify(restants[0])}`,
  );
  assert(
    restants[1].contenu === "regarde cette capture" && restants[1].avaitPieces === true,
    `second push incorrect: ${JSON.stringify(restants[1])}`,
  );
  console.log("OK: enregistrer/vider — ordre et pièces jointes conservés");
}

async function testViderEstIdempotent() {
  // Une clôture peut appeler plusieurs chemins de sortie (voir claude.ts,
  // trois points d'appel) : le second `vider()` ne doit RIEN rendre, sous
  // peine de signaler deux fois le même push perdu.
  const registre = creerRegistrePushes();
  registre.enregistrer("une seule fois", false);
  const premier = registre.vider();
  const second = registre.vider();
  assert(premier.length === 1 && second.length === 0, `idempotence violée: ${JSON.stringify({ premier, second })}`);
  console.log("OK: vider — idempotent, jamais signalé deux fois");
}

async function testAcquittementParToolResult() {
  // Le cœur de la règle T-087 : un tool_result DU FIL efface TOUS les push
  // antérieurs, même empilés avant qu'aucun outil n'ait répondu.
  const registre = creerRegistrePushes();
  registre.enregistrer("premier", false);
  registre.enregistrer("second", false);
  registre.acquitterSurToolResult();
  assert(registre.vider().length === 0, "un tool_result du fil doit acquitter TOUS les push antérieurs");

  // Un push arrivé APRÈS l'acquittement reste, lui, en attente.
  registre.enregistrer("après acquittement", false);
  const restants = registre.vider();
  assert(
    restants.length === 1 && restants[0].contenu === "après acquittement",
    `push post-acquittement perdu à tort: ${JSON.stringify(restants)}`,
  );
  console.log("OK: acquitterSurToolResult — efface les push antérieurs, pas les suivants");
}

async function testSignalerPushesPerdus() {
  const emis = [];
  const emitter = {
    chunk: (id, data) => emis.push({ id, data }),
    done: () => {},
    error: () => {},
  };
  signalerPushesPerdus({
    id: "req-1",
    emitter,
    pushes: [
      { contenu: "a", avaitPieces: false },
      { contenu: "b", avaitPieces: true },
    ],
  });
  assert(emis.length === 2, `2 chunks push_perdu attendus, reçu ${emis.length}`);
  assert(
    emis[0].data.kind === "push_perdu" && emis[0].data.contenu === "a" && emis[0].data.avaitPieces === false,
    `premier chunk incorrect: ${JSON.stringify(emis[0])}`,
  );
  assert(
    emis[1].data.kind === "push_perdu" && emis[1].data.contenu === "b" && emis[1].data.avaitPieces === true,
    `second chunk incorrect: ${JSON.stringify(emis[1])}`,
  );

  // Aucun push : aucun chunk (un tour normal ne doit jamais voir passer un
  // push_perdu vide).
  const vide = [];
  signalerPushesPerdus({ id: "req-2", emitter: { chunk: (id, data) => vide.push(data), done: () => {}, error: () => {} }, pushes: [] });
  assert(vide.length === 0, "aucun push en attente ⇒ aucun chunk émis");
  console.log("OK: signalerPushesPerdus — un chunk par push perdu, rien si le registre est vide");
}

async function testExecuterClaudePushValidation() {
  // T-064 — mêmes garde-fous protocolaires que claude.start : targetId et
  // content sont requis, les pièces jointes sont validées AVANT tout accès
  // au registre des tours (runs.get).
  const emis = [];
  const emitter = {
    chunk: () => {},
    done: (id, data) => emis.push({ event: "done", id, data }),
    error: (id, message) => emis.push({ event: "error", id, message }),
  };
  const runs = new Map();

  executerClaudePush(runs, "p1", {}, emitter);
  assert(emis.at(-1).event === "error" && /targetId/.test(emis.at(-1).message), "targetId manquant ⇒ error");

  executerClaudePush(runs, "p2", { targetId: "t1" }, emitter);
  assert(emis.at(-1).event === "error" && /content/.test(emis.at(-1).message), "content manquant ⇒ error");

  executerClaudePush(runs, "p3", { targetId: "t1", content: "x", attachments: "pas un tableau" }, emitter);
  assert(emis.at(-1).event === "error" && /attachments/.test(emis.at(-1).message), "attachments invalide ⇒ error");

  // Tour inconnu : pushed:false, jamais une erreur (l'UI se rabat sur sa file).
  executerClaudePush(runs, "p4", { targetId: "inconnu", content: "x" }, emitter);
  assert(emis.at(-1).event === "done" && emis.at(-1).data.pushed === false, "tour inconnu ⇒ pushed:false");

  // Tour connu : le contenu ET les pièces jointes VALIDÉES sont transmis à pushPrompt.
  const vus = [];
  runs.set("t2", { aborted: false, pushPrompt: (text, attachments) => vus.push({ text, attachments }) });
  executerClaudePush(
    runs,
    "p5",
    { targetId: "t2", content: "coucou", attachments: [{ kind: "text", name: "n.md", content: "c" }] },
    emitter,
  );
  assert(emis.at(-1).event === "done" && emis.at(-1).data.pushed === true, "tour connu ⇒ pushed:true");
  assert(
    vus.length === 1 && vus[0].text === "coucou" && vus[0].attachments.length === 1,
    `pushPrompt doit recevoir texte + pièces, reçu ${JSON.stringify(vus)}`,
  );
  console.log("OK: executerClaudePush — validations protocolaires et transmission à pushPrompt");
}

/**
 * T-102 — le DÉPÔT d'un push ne laissait aucune trace, seule sa PERTE en
 * laissait une (`testSignalerPushesPerdus` ci-dessus). Un `claude.push`
 * accepté doit désormais écrire une ligne `info`, même style que la ligne de
 * perte : jamais le contenu, juste sa longueur.
 */
async function testPushDeposeJournalise() {
  const emitter = { chunk: () => {}, done: () => {}, error: () => {} };
  const runs = new Map();
  runs.set("t3", { aborted: false, pushPrompt: () => {} });

  executerClaudePush(runs, "p6", { targetId: "t3", content: "et le CHANGELOG" }, emitter);
  await flushWrites();

  const lignes = (await fsp.readFile(appLogPath(), "utf8"))
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  const ligne = lignes.find((l) => l.reqId === "t3" && l.msg === "push déposé : message glissé dans le tour en cours");
  assert(ligne, `le journal doit contenir la ligne de dépôt, reçu ${JSON.stringify(lignes)}`);
  assert(ligne.level === "info", `le dépôt d'un push est un usage normal ⇒ niveau info, reçu ${ligne.level}`);
  assert(
    ligne.fields.longueur === "et le CHANGELOG".length && ligne.fields.avaitPieces === false,
    `champs de dépôt incorrects: ${JSON.stringify(ligne.fields)}`,
  );
  assert(
    !("content" in ligne.fields) && !JSON.stringify(ligne.fields).includes("CHANGELOG"),
    "le journal ne doit jamais porter le contenu du push (L4)",
  );
  console.log("OK: executerClaudePush — le dépôt d'un push se journalise, jamais son contenu");
}

await lancer(
  "poussesEnAttente — registre et push_perdu",
  testRegistreVideParDefaut,
  testEnregistrerPuisVider,
  testViderEstIdempotent,
  testAcquittementParToolResult,
  testSignalerPushesPerdus,
  testExecuterClaudePushValidation,
  testPushDeposeJournalise,
);
