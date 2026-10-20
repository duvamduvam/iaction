/*
 * T-086 — la propriété qui compte : DEUX CLIENTS BRANCHÉS ⇒ UNE SEULE sonde
 * coûteuse par cycle, quel que soit le nombre de fenêtres qui la demandent.
 *
 * Avant ce correctif, `executerClaudeUsageInit` et `handleUsageCredits`
 * jouaient un micro-tour / un appel réseau à CHAQUE appel : deux fenêtres
 * avec leurs propres minuteurs (T-062) sondaient donc deux fois par cycle,
 * dont un vrai tour Claude sur un abonnement parfois déjà saturé (constat du
 * 2026-08-20, docs/tickets.md T-086). Ce fichier fait la preuve, directement
 * contre le code des handlers (pas contre un mock de la cadence), que ce
 * n'est plus possible : la cadence est désormais tenue en mémoire de
 * PROCESSUS, pas de fenêtre.
 *
 * Lancement isolé : node sidecar/test/cadenceUsageCoalescee.test.js
 */

import http from "node:http";

import { lancer, assert, moduleCompile, makeEmitterCollector } from "./harness.mjs";

const { executerClaudeUsageInit, reinitialiserCadenceUsageInit } = await import(moduleCompile("claudeUsage.js"));
const { CADENCE_SONDE_MS } = await import(moduleCompile("cadenceSondesConso.js"));
const { handleProvidersSet } = await import(moduleCompile("engine.js"));
const { handleUsageCredits, reinitialiserCadenceCredits } = await import(moduleCompile("creditsFournisseur.js"));

/* ------------------------------------------------------- usage.claude.init */

const CINQ_H = { utilization: 12, resets_at: "2026-09-19T18:00:00Z" };
const SEPT_J = { utilization: 34, resets_at: "2026-09-25T00:00:00Z" };

/** Faux SDK minimal : compte ses invocations, répond en un tour « assistant ». */
function fabriquerQueryFn(compteur) {
  return function queryFn() {
    compteur.appels += 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "assistant" };
      },
      async interrupt() {},
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        return {
          rate_limits_available: true,
          subscription_type: "max",
          rate_limits: { five_hour: CINQ_H, seven_day: SEPT_J },
        };
      },
    };
  };
}

/** Faux SDK qui échoue toujours par un refus de saturation (session, sans heure). */
function fabriquerQueryFnSature(compteur, message) {
  return function queryFn() {
    compteur.appels += 1;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error(message);
          },
        };
      },
      async interrupt() {},
    };
  };
}

function depotVide() {
  let snap = null;
  return { lire: () => snap, ecrire: (s) => (snap = s) };
}

async function testDeuxAppelsConcurrentsUneSeuleSonde() {
  reinitialiserCadenceUsageInit();
  const compteur = { appels: 0 };
  const deps = { queryFn: fabriquerQueryFn(compteur), depot: depotVide() };
  const a = makeEmitterCollector();
  const b = makeEmitterCollector();

  // Deux fenêtres, deux ids, LE MÊME cycle : c'est le scénario du 2026-08-20
  // (deux fenêtres, deux minuteurs) rejoué directement contre le handler.
  await Promise.all([
    executerClaudeUsageInit(deps, "req-fenA-1", {}, a.emitter),
    executerClaudeUsageInit(deps, "req-fenB-1", {}, b.emitter),
  ]);

  assert(compteur.appels === 1, `un seul micro-tour attendu pour deux appels concurrents, reçu ${compteur.appels}`);
  const doneA = await a.waitFor((e) => e.id === "req-fenA-1");
  const doneB = await b.waitFor((e) => e.id === "req-fenB-1");
  assert(doneA.kind === "done" && doneB.kind === "done", "les deux fenêtres doivent recevoir une réponse 'done'");
  assert(
    doneA.data.windows?.five_hour?.utilization === 12 && doneB.data.windows?.five_hour?.utilization === 12,
    "les deux fenêtres reçoivent le MÊME relevé",
  );
  console.log("OK: deux appels concurrents ⇒ un seul micro-tour, diffusé aux deux");
}

async function testAppelTropTotReutiliseLeDernierResultat() {
  reinitialiserCadenceUsageInit();
  const compteur = { appels: 0 };
  const deps = { queryFn: fabriquerQueryFn(compteur), depot: depotVide() };
  let horloge = 1_700_000_000_000;
  const maintenant = () => horloge;

  const c1 = makeEmitterCollector();
  await executerClaudeUsageInit(deps, "r1", {}, c1.emitter, maintenant);
  assert(compteur.appels === 1, "premier appel : un micro-tour");

  // Une seconde fenêtre, un peu plus tard, mais AVANT la cadence de 5 min.
  horloge += 1000;
  const c2 = makeEmitterCollector();
  await executerClaudeUsageInit(deps, "r2", {}, c2.emitter, maintenant);
  assert(compteur.appels === 1, "trop tôt après la première sonde : aucun second micro-tour");
  const evt2 = await c2.waitFor((e) => e.id === "r2");
  assert(evt2.kind === "done" && evt2.data.windows?.five_hour?.utilization === 12, "le dernier relevé connu répond");

  // À la cadence pile : un nouveau micro-tour est de nouveau autorisé.
  horloge += CADENCE_SONDE_MS;
  const c3 = makeEmitterCollector();
  await executerClaudeUsageInit(deps, "r3", {}, c3.emitter, maintenant);
  assert(compteur.appels === 2, "à la cadence : un nouveau micro-tour doit avoir lieu");
  console.log("OK: un appel trop tôt réutilise le dernier relevé, sans nouveau micro-tour");
}

async function testSaturationArmeLeSilenceEtTaitLaSonde() {
  reinitialiserCadenceUsageInit();
  const compteur = { appels: 0 };
  const deps = {
    queryFn: fabriquerQueryFnSature(compteur, "You've hit your session limit for today."),
    depot: depotVide(),
  };
  let horloge = 1_700_000_000_000;
  const maintenant = () => horloge;

  const c1 = makeEmitterCollector();
  await executerClaudeUsageInit(deps, "r1", {}, c1.emitter, maintenant);
  assert(compteur.appels === 1, "premier appel : un micro-tour, refusé pour saturation");
  const evt1 = await c1.waitFor((e) => e.id === "r1");
  assert(
    evt1.kind === "done" && evt1.data.available === false && evt1.data.saturation?.fenetre === "session",
    `un refus de saturation doit rendre 'done' structuré, reçu ${JSON.stringify(evt1.data)}`,
  );

  // Une seconde fenêtre, bien après la cadence de 5 min normale, mais ENCORE
  // dans le silence par défaut (30 min, aucune heure exploitable dans le
  // message) : la sonde doit rester TUE — c'est le point 2 de T-086 (« la
  // sonde repart toutes les 5 min jusque-là »).
  horloge += CADENCE_SONDE_MS * 2;
  const c2 = makeEmitterCollector();
  await executerClaudeUsageInit(deps, "r2", {}, c2.emitter, maintenant);
  assert(compteur.appels === 1, "en silence de saturation : aucun nouveau micro-tour, même après la cadence normale");
  const evt2 = await c2.waitFor((e) => e.id === "r2");
  assert(evt2.data.saturation?.fenetre === "session", "le refus mémorisé continue de répondre pendant le silence");
  console.log("OK: un refus de saturation tait la sonde au-delà de la cadence normale (T-059)");
}

/* ----------------------------------------------------------- usage.credits */

let reponseCredits = { data: { total_credits: 10, total_usage: 4 } };
let requetesRecues = 0;
const serveur = http.createServer((req, res) => {
  requetesRecues += 1;
  if (req.url === "/v1/credits") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reponseCredits));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
const port = serveur.address().port;
const base = `http://127.0.0.1:${port}/v1`;

function poserFournisseur() {
  reinitialiserCadenceCredits();
  requetesRecues = 0;
  const emitter = makeEmitterCollector();
  handleProvidersSet("p", { providers: [{ id: "mock", label: "Mock", baseUrl: base, apiKey: "sk-test" }] }, emitter.emitter);
}

async function testDeuxAppelsConcurrentsUnSeulAppelReseau() {
  poserFournisseur();
  const a = makeEmitterCollector();
  const b = makeEmitterCollector();
  await Promise.all([
    handleUsageCredits("req-fenA-1", { providerId: "mock" }, a.emitter),
    handleUsageCredits("req-fenB-1", { providerId: "mock" }, b.emitter),
  ]);
  assert(requetesRecues === 1, `un seul appel réseau attendu pour deux fenêtres, reçu ${requetesRecues}`);
  const doneA = await a.waitFor((e) => e.id === "req-fenA-1");
  const doneB = await b.waitFor((e) => e.id === "req-fenB-1");
  assert(
    doneA.kind === "done" && doneB.kind === "done" && doneA.data.remaining === 6 && doneB.data.remaining === 6,
    "les deux fenêtres reçoivent le MÊME relevé de crédits",
  );
  console.log("OK: usage.credits — deux appels concurrents ⇒ un seul appel réseau, diffusé aux deux");
}

await lancer(
  "T-086 — une seule sonde coûteuse par cycle, quel que soit le nombre de fenêtres",
  testDeuxAppelsConcurrentsUneSeuleSonde,
  testAppelTropTotReutiliseLeDernierResultat,
  testSaturationArmeLeSilenceEtTaitLaSonde,
  testDeuxAppelsConcurrentsUnSeulAppelReseau,
);

serveur.close();
