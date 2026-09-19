/*
 * `knowledge.index` force:true, et l'en-tête daté jusqu'au résultat de
 * recherche (T-115).
 *
 * Extrait de protocol.test.js (ces deux cas avaient fait passer son cliquet
 * de taille de 34 lignes) : ni l'un ni l'autre n'a besoin des lourdeurs du
 * protocole JSON Lines (spawn d'un sidecar, mock OpenAI, providers.set sur
 * dix fournisseurs…) — seuls handleKnowledgeIndex/searchKnowledge et un faux
 * /api/embed suffisent, en process, comme webSearchChat.test.js le fait déjà
 * pour chat.send.
 *
 * Lancement isolé : node sidecar/test/knowledgeIndexForce.test.js
 */

import http from "node:http";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { lancer, assert, moduleCompile, makeEmitterCollector } from "./harness.mjs";

const { handleProvidersSet } = await import(moduleCompile("engine.js"));
const { handleRouterSet } = await import(moduleCompile("router.js"));
const { handleKnowledgeIndex, searchKnowledge } = await import(moduleCompile("knowledge.js"));
const { formatSearchResults } = await import(moduleCompile("rechercheFormat.js"));

/* ---------------------------------------------------------------- serveur */

// Faux serveur d'embeddings (POST /api/embed, API native Ollama) : compte les
// entrées embeddées, comme le mock de protocol.test.js.
let embedInputsTotal = 0;
function fakeEmbedding(text) {
  const count = (needle) => text.split(needle).length - 1;
  return [count("alpha"), count("beta"), 1];
}
const serveur = http.createServer((req, res) => {
  const morceaux = [];
  req.on("data", (c) => morceaux.push(c));
  req.on("end", () => {
    if (req.url !== "/api/embed") {
      res.writeHead(404).end();
      return;
    }
    const corps = JSON.parse(Buffer.concat(morceaux).toString("utf8"));
    embedInputsTotal += corps.input.length;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: corps.model, embeddings: corps.input.map((s) => fakeEmbedding(String(s))) }));
  });
});
await new Promise((resolve) => serveur.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${serveur.address().port}`;

/* ------------------------------------------------------------------ setup */

function configurerEmbeddings() {
  const { emitter } = makeEmitterCollector();
  handleProvidersSet("p", { providers: [{ id: "ollama-mock", label: "Ollama mock", baseUrl: `${base}/v1` }] }, emitter);
  handleRouterSet("r", { table: {}, embeddings: { providerId: "ollama-mock", model: "fake-embed" } }, emitter);
}

async function indexer(id, params) {
  const { emitter, waitFor } = makeEmitterCollector();
  const fini = waitFor((e) => e.id === id && (e.kind === "done" || e.kind === "error"), 5000, `knowledge.index ${id}`);
  await handleKnowledgeIndex(id, params, emitter);
  return fini;
}

/* ------------------------------------------------------------------ tests */

async function testForceIgnoreReutilisationParMtime() {
  configurerEmbeddings();
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-knowledge-force-"));
  const notePath = path.join(cwd, "note.md");
  await fsp.writeFile(notePath, "alpha alpha alpha\n", "utf8");

  const doneI1 = await indexer("i1", { cwd, pinned: [notePath] });
  assert(doneI1.kind === "done" && doneI1.data.chunks === 1, `i1 done incorrect: ${JSON.stringify(doneI1.data)}`);

  // Rien n'a changé sur disque : sans force, l'incrémental par mtime réutilise
  // le chunk existant — c'est le défaut vérifié ici, avant force.
  const embedAvantI2 = embedInputsTotal;
  const doneI2 = await indexer("i2", { cwd, pinned: [notePath] });
  assert(doneI2.kind === "done", `i2 done incorrect: ${JSON.stringify(doneI2.data)}`);
  assert(
    embedInputsTotal === embedAvantI2,
    "sans force, un mtime inchangé ne doit PAS relancer l'embedding (sinon le cas force:true ne prouve rien)",
  );

  // force:true (T-115) : ignore la réutilisation par mtime et ré-embarque
  // TOUT, même un fichier dont le mtime n'a pas bougé — c'est le bouton
  // « Reconstruire l'index », la réparation d'un contenu changé à mtime
  // préservé (restauration, synchro qui n'actualise pas la date), invisible
  // à l'incrémental par mtime.
  const embedAvantI3 = embedInputsTotal;
  const doneI3 = await indexer("i3", { cwd, pinned: [notePath], force: true });
  assert(
    doneI3.kind === "done" && doneI3.data.files === 1 && doneI3.data.chunks === 1,
    `i3 (force:true) done incorrect: ${JSON.stringify(doneI3.data)}`,
  );
  assert(
    embedInputsTotal - embedAvantI3 === 1,
    `force:true doit ré-embarquer le fichier malgré un mtime inchangé, reçu ${embedInputsTotal - embedAvantI3}`,
  );

  await fsp.rm(cwd, { recursive: true, force: true });
  console.log("OK: knowledge.index force:true ignore la réutilisation par mtime");
}

async function testEnTeteDateeJusquauResultatDeRecherche() {
  configurerEmbeddings();
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-knowledge-force-"));
  const notePath = path.join(cwd, "note.md");
  await fsp.writeFile(notePath, "alpha alpha alpha\n", "utf8");
  const doneI1 = await indexer("i1", { cwd, pinned: [notePath] });
  assert(doneI1.kind === "done", `i1 done incorrect: ${JSON.stringify(doneI1.data)}`);

  // T-115 — le texte servi par search_knowledge (moteur neutre ET Claude,
  // voir neutralAgent.ts et knowledge.ts::buildKnowledgeMcpServer) est TOUJOURS
  // `formatSearchResults(searchKnowledge(...))` : reproduit ici tel quel.
  const outcome = await searchKnowledge(cwd, "alpha", 1);
  assert(outcome.ok, `searchKnowledge doit réussir sur un index frais, reçu ${JSON.stringify(outcome)}`);
  const summary = formatSearchResults(outcome.results, outcome.builtAt, outcome.stale);
  assert(
    summary.startsWith("Index construit le") && summary.includes("il y a") && summary.includes(" j)"),
    `en-tête daté attendu en tête du résultat, reçu ${JSON.stringify(summary)}`,
  );
  assert(summary.includes("note.md"), `l'extrait de note.md est attendu dans le résultat, reçu ${JSON.stringify(summary)}`);

  await fsp.rm(cwd, { recursive: true, force: true });
  console.log("OK: l'en-tête daté atteint le texte servi par search_knowledge");
}

await lancer(
  "knowledge.index force:true, en-tête daté",
  testForceIgnoreReutilisationParMtime,
  testEnTeteDateeJusquauResultatDeRecherche,
);

serveur.close();
