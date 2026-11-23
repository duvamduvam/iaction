/*
 * Charge de l'indexation des connaissances (T-229).
 *
 * 1. Feuilles pures : tolérance de date, borne de fils.
 * 2. De bout en bout, contre un faux serveur d'embeddings : un index dont les
 *    dates diffèrent au dernier bit (écrit par un autre outil) n'est NI jugé
 *    périmé NI ré-embarqué ; la requête porte bien la borne de fils.
 *
 * Lancement isolé : node sidecar/test/knowledgeCharge.test.js
 */

import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { lancer, assert, moduleCompile, makeEmitterCollector } from "./harness.mjs";

const { memeDate, threadsEmbeddings } = await import(moduleCompile("knowledgeCharge.js"));
const { handleProvidersSet } = await import(moduleCompile("engine.js"));
const { handleRouterSet } = await import(moduleCompile("router.js"));
const { handleKnowledgeIndex, handleKnowledgeStatus } = await import(moduleCompile("knowledge.js"));
const { indexDir } = await import(moduleCompile("knowledgeIndexStore.js"));

let entreesEmbarquees = 0;
let dernierCorps = null;
const serveur = http.createServer((req, res) => {
  const morceaux = [];
  req.on("data", (c) => morceaux.push(c));
  req.on("end", () => {
    const corps = JSON.parse(Buffer.concat(morceaux).toString("utf8"));
    dernierCorps = corps;
    entreesEmbarquees += corps.input.length;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: corps.model, embeddings: corps.input.map(() => [1, 0, 0]) }));
  });
});
await new Promise((resolve) => serveur.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${serveur.address().port}`;

function configurer() {
  const { emitter } = makeEmitterCollector();
  handleProvidersSet("p", { providers: [{ id: "ollama-mock", label: "Ollama mock", baseUrl: `${base}/v1` }] }, emitter);
  handleRouterSet("r", { table: {}, embeddings: { providerId: "ollama-mock", model: "fake-embed" } }, emitter);
}

async function appeler(handler, id, params) {
  const { emitter, waitFor } = makeEmitterCollector();
  const fini = waitFor((e) => e.id === id && (e.kind === "done" || e.kind === "error"), 5000, id);
  await handler(id, params, emitter);
  return fini;
}

async function testFeuillesPures() {
  assert(memeDate(1791489623352.0872, 1791489623352.0874), "écart au dernier bit : même date");
  assert(memeDate(1000, 1000.9), "moins d'une milliseconde : même date");
  assert(!memeDate(1000, 1001), "une milliseconde : date différente");
  assert(!memeDate(undefined, 1000), "fichier inconnu de l'index : différent");
  assert(!memeDate("1000", 1000), "valeur non numérique : différent");
  assert(!memeDate(Number.NaN, 1000), "NaN : différent");

  assert(threadsEmbeddings(24) === 6, "24 cœurs → 6");
  assert(threadsEmbeddings(4) === 2, "plancher 2");
  assert(threadsEmbeddings(64) === 8, "plafond 8");
  assert(threadsEmbeddings(0) === 2, "cœurs inconnus → 2");
  assert(threadsEmbeddings(24, { IACTION_EMBED_THREADS: "12" }) === 12, "variable d'environnement prioritaire");
  assert(threadsEmbeddings(24, { IACTION_EMBED_THREADS: "0" }) === 0, "0 = pas de borne");
  assert(threadsEmbeddings(24, { IACTION_EMBED_THREADS: "beaucoup" }) === 6, "valeur illisible ignorée");
  assert(threadsEmbeddings(24, { IACTION_EMBED_THREADS: "-3" }) === 6, "valeur négative ignorée");
  console.log("OK: tolérance de date et borne de fils");
}

async function testDatesAuDernierBitNiPerimeesNiRecalculees() {
  configurer();
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-knowledge-charge-"));
  const note = path.join(cwd, "note.md");
  await fsp.writeFile(note, "alpha beta gamma\n", "utf8");

  const i1 = await appeler(handleKnowledgeIndex, "i1", { cwd, pinned: [note] });
  assert(i1.kind === "done" && i1.data.chunks === 1, `première indexation : ${JSON.stringify(i1.data)}`);
  assert(dernierCorps.options && Number.isInteger(dernierCorps.options.num_thread) && dernierCorps.options.num_thread >= 2, `borne de fils envoyée : ${JSON.stringify(dernierCorps.options)}`);

  // Un autre outil a réécrit le méta-index : mêmes dates, à un dix-millième de
  // milliseconde près (conversion flottante d'un autre langage).
  const cheminMeta = path.join(indexDir(cwd), "meta.json");
  const meta = JSON.parse(await fsp.readFile(cheminMeta, "utf8"));
  for (const k of Object.keys(meta.files)) meta.files[k] += 0.0002;
  await fsp.writeFile(cheminMeta, JSON.stringify(meta), "utf8");

  const statut = await appeler(handleKnowledgeStatus, "s1", { cwd, pinned: [note] });
  assert(statut.kind === "done" && statut.data.stale === false, `l'index ne doit pas être jugé périmé : ${JSON.stringify(statut.data)}`);

  const avant = entreesEmbarquees;
  const i2 = await appeler(handleKnowledgeIndex, "i2", { cwd, pinned: [note] });
  assert(i2.kind === "done", `seconde indexation : ${JSON.stringify(i2.data)}`);
  assert(entreesEmbarquees === avant, `rien ne doit être ré-embarqué, reçu ${entreesEmbarquees - avant}`);

  // Une vraie modification, elle, est toujours vue.
  await fsp.writeFile(note, "alpha beta gamma delta\n", "utf8");
  const futur = new Date(Date.now() + 5000);
  await fsp.utimes(note, futur, futur);
  const statut2 = await appeler(handleKnowledgeStatus, "s2", { cwd, pinned: [note] });
  assert(statut2.data.stale === true, "un fichier vraiment modifié rend l'index périmé");
  const i3 = await appeler(handleKnowledgeIndex, "i3", { cwd, pinned: [note] });
  assert(i3.kind === "done" && entreesEmbarquees === avant + 1, "le fichier modifié est ré-embarqué, lui seul");

  await fsp.rm(cwd, { recursive: true, force: true });
  console.log("OK: dates au dernier bit — ni périmées ni recalculées ; vraie modification vue");
}

await lancer("charge de l'indexation des connaissances", testFeuillesPures, testDatesAuDernierBitNiPerimeesNiRecalculees);

serveur.close();
