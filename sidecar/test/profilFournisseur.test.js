/*
 * R8-A bout en bout — profils de fournisseur (spec R8-A §7, cas 1 à 8).
 *
 * Un seul serveur HTTP joue les trois rôles : catalogue standard
 * (`/v1/models`), catalogue dérouté (`/public/bots`, forme « slugs ») et
 * fournisseur de chat (`/v1/chat/completions`). Il enregistre ce qu'il reçoit,
 * parce que la seule chose qui compte ici est **ce qui part réellement**.
 *
 * Le cas 1 est le plus important : sans profil, la requête doit être celle
 * d'avant R8, à l'octet près. C'est le contrat de non-régression de la spec,
 * repris de R0.
 *
 * Ce fichier est neuf plutôt qu'ajouté à protocol.test.js pour la raison qui a
 * motivé R8 elle-même : le cliquet de taille refuse d'agrandir un fichier de
 * 2 670 lignes, et une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié.
 *
 * Lancement isolé : node sidecar/test/profilFournisseur.test.js
 */

import http from "node:http";

import { lancer, assert, moduleCompile, makeEmitterCollector } from "./harness.mjs";

const { handleProvidersSet, handleChatSend, handleModelsList, handleModelsDetail } = await import(
  moduleCompile("engine.js")
);
const { normaliserTraits, reinitialiserSignalementComptabilite } = await import(
  moduleCompile("profilFournisseur.js")
);

/* ---------------------------------------------------------------- serveur */

const recu = { catalogues: [], corpsChat: [] };
/** Dernier bloc `usage` que le faux fournisseur doit annoncer en fin de flux. */
let usageAnnonce = { prompt_tokens: 12, completion_tokens: 3 };

const serveur = http.createServer((req, res) => {
  const morceaux = [];
  req.on("data", (c) => morceaux.push(c));
  req.on("end", () => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/v1/models") {
      recu.catalogues.push(url.pathname);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "standard-1", name: "Standard 1" }] }));
      return;
    }

    if (url.pathname === "/public/bots") {
      recu.catalogues.push(url.pathname);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          { slug: "a", name: "A", isChatLMM: true },
          // non conversationnel : un export Excel n'est pas un cerveau d'agent
          { slug: "b", name: "B", isChatLMM: false },
          // sans slug : ignorée, comme aujourd'hui une entrée sans `id`
          { name: "sans slug", isChatLMM: true },
        ]),
      );
      return;
    }

    if (url.pathname === "/v1/chat/completions") {
      recu.corpsChat.push(JSON.parse(Buffer.concat(morceaux).toString("utf8")));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: usageAnnonce })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(404).end();
  });
});

await new Promise((resolve) => serveur.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${serveur.address().port}`;

/* ------------------------------------------------------------------ setup */

function declarer(traits) {
  const { emitter } = makeEmitterCollector();
  handleProvidersSet(
    "p",
    { providers: [{ id: "mock", label: "Mock", baseUrl: `${base}/v1`, ...(traits ? { traits } : {}) }] },
    emitter,
  );
}

async function envoyer(id) {
  const { emitter, events, waitFor } = makeEmitterCollector();
  const fini = waitFor((e) => e.id === id && (e.kind === "done" || e.kind === "error"), 8000, id);
  await handleChatSend(
    id,
    { providerId: "mock", model: "m", messages: [{ role: "user", content: "salut" }] },
    emitter,
  );
  await fini;
  return events;
}

async function lister(methode, id) {
  const { emitter, events, waitFor } = makeEmitterCollector();
  const fini = waitFor((e) => e.id === id && (e.kind === "done" || e.kind === "error"), 8000, id);
  await methode(id, { providerId: "mock" }, emitter);
  await fini;
  return events.find((e) => e.kind === "done")?.data?.models;
}

/* ------------------------------------------------------------------ tests */

async function testCorpsSansProfil() {
  declarer(undefined);
  recu.corpsChat.length = 0;
  await envoyer("sans-profil");
  const corps = recu.corpsChat.at(-1);
  const cles = Object.keys(corps).sort();
  assert(
    JSON.stringify(cles) === JSON.stringify(["messages", "model", "stream", "stream_options"]),
    `corps inchangé sans profil, reçu ${JSON.stringify(cles)}`,
  );
  console.log("OK: cas 1 — sans profil, corps strictement identique à avant R8");
}

async function testCatalogueStandard() {
  declarer(undefined);
  recu.catalogues.length = 0;
  const models = await lister(handleModelsList, "cat-standard");
  assert(recu.catalogues.at(-1) === "/v1/models", `catalogue standard, reçu ${recu.catalogues.at(-1)}`);
  assert(models.length === 1 && models[0].id === "standard-1", `un modèle, reçu ${JSON.stringify(models)}`);
  console.log("OK: cas 2 — sans catalogUrl, la requête part sur {baseUrl}/models");
}

async function testCatalogueDeroute() {
  declarer({ catalogUrl: `${base}/public/bots`, catalogShape: "slugs" });
  recu.catalogues.length = 0;
  await lister(handleModelsList, "cat-deroute");
  assert(
    recu.catalogues.at(-1) === "/public/bots",
    `catalogue dérouté, reçu ${recu.catalogues.at(-1)}`,
  );
  assert(!recu.catalogues.includes("/v1/models"), "aucune requête sur /models quand catalogUrl est posé");
  console.log("OK: cas 3 — catalogUrl déroute la requête, /models n'est plus appelé");
}

async function testFormeSlugs() {
  declarer({ catalogUrl: `${base}/public/bots`, catalogShape: "slugs" });
  const models = await lister(handleModelsDetail, "forme-slugs");
  assert(
    JSON.stringify(models) === JSON.stringify([{ id: "a", name: "A" }]),
    `filtré ET normalisé, reçu ${JSON.stringify(models)}`,
  );
  console.log("OK: cas 4 — forme slugs : id ← slug, name ← name, non-chat écartés");
}

async function testBodyExtras() {
  // La clé `model` est INTERDITE : un profil décrit une passerelle, il ne
  // détourne pas le modèle demandé.
  declarer({ bodyExtras: { stateless: true, model: "pirate" } });
  recu.corpsChat.length = 0;
  await envoyer("extras");
  const corps = recu.corpsChat.at(-1);
  assert(corps.stateless === true, "bodyExtras fusionné dans le corps");
  assert(corps.model === "m", `le modèle demandé reste intact, reçu ${corps.model}`);
  console.log("OK: cas 5 — bodyExtras fusionné, clé réservée retirée à la validation");
}

async function testZeroVautInconnu() {
  reinitialiserSignalementComptabilite();
  declarer({ usageTrustworthy: false });
  usageAnnonce = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 7744 };
  const events = await envoyer("zero-inconnu");
  const usage = events.find((e) => e.kind === "done").data.usage;
  assert(
    usage.promptTokens === null && usage.completionTokens === null,
    `zéro annoncé → inconnu, reçu ${JSON.stringify(usage)}`,
  );
  console.log("OK: cas 6 — usageTrustworthy:false, un zéro annoncé vaut « pas de mesure »");
}

async function testZeroResteZero() {
  declarer(undefined);
  usageAnnonce = { prompt_tokens: 0, completion_tokens: 0 };
  const events = await envoyer("zero-reste-zero");
  const usage = events.find((e) => e.kind === "done").data.usage;
  assert(
    usage.promptTokens === 0 && usage.completionTokens === 0,
    `sans le trait, un zéro reste un zéro, reçu ${JSON.stringify(usage)}`,
  );
  usageAnnonce = { prompt_tokens: 12, completion_tokens: 3 };
  console.log("OK: cas 7 — sans le trait, un vrai zéro est conservé");
}

async function testValidationSouple() {
  const traits = normaliserTraits({
    catalogShape: "xxx",
    catalogUrl: 42,
    bodyExtras: "non",
    usageTrustworthy: "peut-être",
  });
  assert(traits === undefined, `traits mal formés entièrement retirés, reçu ${JSON.stringify(traits)}`);

  // Et le fournisseur reste utilisable : un profil illisible dégrade vers le
  // comportement standard, il ne condamne pas le fournisseur.
  declarer({ catalogShape: "xxx", catalogUrl: 42, bodyExtras: "non" });
  recu.catalogues.length = 0;
  const models = await lister(handleModelsList, "souple");
  assert(recu.catalogues.at(-1) === "/v1/models", "retour au catalogue standard");
  assert(models.length === 1, `fournisseur toujours utilisable, reçu ${JSON.stringify(models)}`);

  // Un profil PARTIELLEMENT valide garde ce qui est bon.
  const partiel = normaliserTraits({ catalogShape: "slugs", catalogUrl: "ftp://x", usageTrustworthy: false });
  assert(
    JSON.stringify(partiel) === JSON.stringify({ catalogShape: "slugs", usageTrustworthy: false }),
    `seul le trait invalide est retiré, reçu ${JSON.stringify(partiel)}`,
  );
  console.log("OK: cas 8 — validation souple : traits invalides retirés, jamais d'erreur");
}

await lancer(
  "R8-A — profils de fournisseur",
  testCorpsSansProfil,
  testCatalogueStandard,
  testCatalogueDeroute,
  testFormeSlugs,
  testBodyExtras,
  testZeroVautInconnu,
  testZeroResteZero,
  testValidationSouple,
);

serveur.close();
