/*
 * R9 bout en bout — `chat.send` avec recherche web (spec R9 §7, cas 6 à 9).
 *
 * Un seul serveur HTTP joue les DEUX rôles : le fournisseur compatible OpenAI
 * (flux SSE) et le moteur de recherche (JSON façon SearXNG). Il enregistre ce
 * qu'il reçoit, ce qui permet de vérifier la seule chose qui compte vraiment
 * ici : **ce qui part réellement chez le fournisseur**.
 *
 * Le cas 6 est le plus important de tous — sans `webSearch`, le tour doit être
 * identique à celui d'avant R9, sans UNE requête sortante de plus. C'est le
 * contrat de non-régression de la spec.
 *
 * Lancement isolé : node sidecar/test/webSearchChat.test.js
 */

import http from "node:http";

import { lancer, assert, moduleCompile, makeEmitterCollector } from "./harness.mjs";

const { handleProvidersSet, handleChatSend } = await import(moduleCompile("engine.js"));
const { setWebSearchConfig } = await import(moduleCompile("webSearch.js"));

/* ---------------------------------------------------------------- serveur */

const recu = { recherches: [], corpsChat: [] };
let moteurEnPanne = false;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const serveur = http.createServer((req, res) => {
  const morceaux = [];
  req.on("data", (c) => morceaux.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/search") {
      recu.recherches.push(url.searchParams.get("q"));
      if (moteurEnPanne) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("moteur hors service");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            // URL volontairement LOCALE : la garde doit refuser d'aller la
            // chercher, et le contexte se replier sur l'extrait du moteur.
            { title: "Titre A", url: "http://127.0.0.1:1/page-a", content: "extrait A", publishedDate: "2026-08-09T10:00:00Z" },
            { title: "Titre B", url: "http://192.168.0.9/page-b", content: "extrait B" },
          ],
        }),
      );
      return;
    }

    if (url.pathname === "/v1/chat/completions") {
      recu.corpsChat.push(JSON.parse(Buffer.concat(morceaux).toString("utf8")));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, { choices: [{ delta: { content: "réponse" }, finish_reason: null }] });
      sse(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(404).end();
  });
});

await new Promise((resolve) => serveur.listen(0, "127.0.0.1", resolve));
const port = serveur.address().port;
const base = `http://127.0.0.1:${port}`;

/* ------------------------------------------------------------------ setup */

function declarerFournisseur() {
  const { emitter } = makeEmitterCollector();
  handleProvidersSet("p", { providers: [{ id: "mock", label: "Mock", baseUrl: `${base}/v1` }] }, emitter);
}

async function envoyer(id, params) {
  const { emitter, events, waitFor } = makeEmitterCollector();
  const fini = waitFor((e) => e.id === id && (e.kind === "done" || e.kind === "error"), 8000, `chat.send ${id}`);
  await handleChatSend(id, { providerId: "mock", model: "m", messages: [{ role: "user", content: "actualités" }], ...params }, emitter);
  await fini;
  return events;
}

/* ------------------------------------------------------------------ tests */

async function testSansRecherche() {
  declarerFournisseur();
  setWebSearchConfig({ baseUrl: base });
  recu.recherches.length = 0;
  recu.corpsChat.length = 0;

  const events = await envoyer("sans", {});

  assert(recu.recherches.length === 0, "AUCUNE requête au moteur quand webSearch est absent");
  const corps = recu.corpsChat.at(-1);
  assert(corps.messages.length === 1 && corps.messages[0].role === "user",
    `messages inchangés, reçu ${JSON.stringify(corps.messages)}`);
  assert(!events.some((e) => e.kind === "chunk" && e.data?.web), "aucun chunk `web` émis");
  console.log("OK: cas 6 — sans webSearch, tour identique et zéro requête sortante");
}

async function testAvecRecherche() {
  recu.recherches.length = 0;
  recu.corpsChat.length = 0;

  const events = await envoyer("avec", { webSearch: true });

  assert(recu.recherches.at(-1) === "actualités", "la question part telle quelle au moteur");

  // Le chunk `web` doit précéder le premier delta : l'utilisateur voit d'abord
  // qu'une recherche a lieu, ensuite la réponse.
  const idxWeb = events.findIndex((e) => e.kind === "chunk" && e.data?.web?.etat === "ok");
  const idxDelta = events.findIndex((e) => e.kind === "chunk" && typeof e.data?.delta === "string");
  assert(idxWeb !== -1, "un chunk web.etat === 'ok' est émis");
  assert(idxWeb < idxDelta, "les sources arrivent AVANT le premier delta");

  const sources = events[idxWeb].data.web.sources;
  assert(sources.length === 2 && sources[0].n === 1 && sources[0].url === "http://127.0.0.1:1/page-a",
    `deux sources numérotées, reçu ${JSON.stringify(sources)}`);

  const corps = recu.corpsChat.at(-1);
  assert(corps.messages.length === 2 && corps.messages[0].role === "system",
    `le bloc est préfixé en système, reçu ${JSON.stringify(corps.messages.map((m) => m.role))}`);
  assert(corps.messages[0].content.includes("[1] Titre A"), "source 1 dans le bloc");
  // Les URL des résultats sont locales : la garde a refusé de les récupérer,
  // et le contexte s'est replié sur les extraits du moteur.
  assert(corps.messages[0].content.includes("extrait A"), "repli sur l'extrait quand la page est refusée");
  assert(corps.messages[1].role === "user", "le message utilisateur reste le dernier");
  console.log("OK: cas 7 — recherche injectée, sources avant le texte, garde d'URL appliquée");
}

async function testMoteurEnPanne() {
  moteurEnPanne = true;
  recu.corpsChat.length = 0;

  const events = await envoyer("panne", { webSearch: true });

  const done = events.find((e) => e.kind === "done");
  assert(done, "le tour ABOUTIT malgré le moteur en panne");
  const web = events.find((e) => e.kind === "chunk" && e.data?.web?.etat === "echec");
  assert(web, "un chunk web.etat === 'echec' est émis");
  const corps = recu.corpsChat.at(-1);
  assert(corps.messages[0].content.includes("Dis-le explicitement"),
    "le modèle reçoit l'ORDRE de signaler l'échec, jamais un silence");
  moteurEnPanne = false;
  console.log("OK: cas 8 — moteur en panne : tour réussi, échec annoncé");
}

async function testBlocNonPersiste() {
  recu.corpsChat.length = 0;
  // Deuxième tour de la MÊME conversation, sans recherche : l'historique
  // fourni par l'UI ne doit porter aucune trace du bloc précédent — c'est
  // l'appelant qui garde la main, et le sidecar n'écrit rien dans l'historique.
  await envoyer("suite", {
    messages: [
      { role: "user", content: "actualités" },
      { role: "assistant", content: "réponse" },
      { role: "user", content: "et ensuite ?" },
    ],
  });
  const corps = recu.corpsChat.at(-1);
  assert(corps.messages.length === 3, `3 messages, reçu ${corps.messages.length}`);
  assert(!corps.messages.some((m) => String(m.content).includes("Résultats de recherche web")),
    "aucun bloc de recherche ne survit au tour suivant");
  console.log("OK: cas 9 — le bloc injecté ne persiste pas d'un tour à l'autre");
}

await lancer(
  "recherche web — chat.send bout en bout",
  testSansRecherche,
  testAvecRecherche,
  testMoteurEnPanne,
  testBlocNonPersiste,
);

serveur.close();
