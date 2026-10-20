/*
 * `usage.credits` — ce que la méthode répond quand elle NE PEUT PAS relever.
 *
 * Les deux cas testés ici sont ceux qui ont pourri le journal du poste : 1 197
 * lignes « clé API manquante » (T-057) et 1 996 lignes « fetch failed
 * (ERR_TLS_CERT_ALTNAME_INVALID) » qui ne disaient pas quel hôte avait échoué
 * (T-085). Le premier ne doit plus être une erreur du tout ; le second doit
 * nommer sa cible.
 *
 * Le cas nominal est testé aussi, et c'est le plus important des trois : la
 * forme de la réponse en succès ne change pas d'un octet.
 *
 * Lancement isolé : node sidecar/test/usageCredits.test.js
 */

import http from "node:http";

import { lancer, assert, moduleCompile, makeEmitterCollector } from "./harness.mjs";

const { handleProvidersSet } = await import(moduleCompile("engine.js"));
const { handleUsageCredits, reinitialiserCadenceCredits } = await import(moduleCompile("creditsFournisseur.js"));

/* ---------------------------------------------------------------- serveur */

/** Ce que le faux fournisseur répond sur `/v1/credits` au prochain appel. */
let reponseCredits = { data: { total_credits: 12.5, total_usage: 2.5 } };

const serveur = http.createServer((req, res) => {
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

/**
 * Pose la table des fournisseurs — `apiKey` absente = clé non configurée.
 *
 * T-086 — `reinitialiserCadenceCredits()` AVANT chaque scénario : la cadence
 * de `handleUsageCredits` est désormais tenue en mémoire de PROCESSUS, une
 * entrée par `providerId` (voir creditsFournisseur.ts). Sans ce reset, le
 * SUCCÈS de `succes_forme_inchangee` armerait la cadence stable (5 min) pour
 * « mock », et `panne_reseau_nomme_sa_cible` — millisecondes plus tard, même
 * `providerId` — recevrait la valeur mise en cache au lieu de taper la vraie
 * URL cassée : exactement le comportement voulu en usage normal, mais qui
 * casserait ici l'isolation entre scénarios.
 */
function poserFournisseur({ baseUrl = base, apiKey = "sk-test" } = {}) {
  reinitialiserCadenceCredits();
  const emitter = makeEmitterCollector();
  handleProvidersSet(
    "p",
    { providers: [{ id: "mock", label: "Mock", baseUrl, ...(apiKey ? { apiKey } : {}) }] },
    emitter.emitter,
  );
}

/* ------------------------------------------------------------------ tests */

await lancer(
  "usage.credits — l'indisponible n'est pas une panne",

  async function succes_forme_inchangee() {
    poserFournisseur();
    const c = makeEmitterCollector();
    await handleUsageCredits("r1", { providerId: "mock" }, c.emitter);
    const evt = await c.waitFor((e) => e.id === "r1");
    assert(evt.kind === "done", `attendu done, reçu ${evt.kind} (${evt.data.message ?? ""})`);
    assert(evt.data.totalCredits === 12.5, "totalCredits inchangé");
    assert(evt.data.totalUsage === 2.5, "totalUsage inchangé");
    assert(evt.data.remaining === 10, "remaining = credits − usage");
    assert(evt.data.disponible === undefined, "le succès ne porte AUCUN drapeau de disponibilité");
    console.log("OK: succès — forme de la réponse inchangée");
  },

  async function cle_absente_repond_done() {
    poserFournisseur({ apiKey: "" });
    const c = makeEmitterCollector();
    await handleUsageCredits("r2", { providerId: "mock" }, c.emitter);
    const evt = await c.waitFor((e) => e.id === "r2");
    // Le cœur de T-057 : une clé non configurée est un état CHOISI. La
    // journaliser en erreur 1 197 fois n'a informé de rien et a enterré les
    // vraies pannes.
    assert(evt.kind === "done", `clé absente : attendu done, reçu ${evt.kind}`);
    assert(evt.data.disponible === false, "done structuré : disponible=false");
    assert(evt.data.raison === "cle-absente", `raison nommée, reçu ${evt.data.raison}`);
    console.log("OK: clé absente — done structuré, aucune ligne d'erreur");
  },

  async function panne_reseau_nomme_sa_cible() {
    // Port fermé : `fetch` échoue au niveau connexion, comme le certificat
    // invalide du 2026-08-20 échouait au niveau TLS.
    poserFournisseur({ baseUrl: "http://127.0.0.1:1/v1" });
    const c = makeEmitterCollector();
    await handleUsageCredits("r3", { providerId: "mock" }, c.emitter);
    const evt = await c.waitFor((e) => e.id === "r3");
    assert(evt.kind === "error", "une vraie panne réseau reste une erreur");
    const msg = evt.data.message;
    // T-085 — la cause SANS la cible a bloqué le diagnostic trois jours.
    assert(msg.includes("mock"), `le fournisseur est nommé, reçu : ${msg}`);
    assert(msg.includes("127.0.0.1:1"), `l'hôte est nommé, reçu : ${msg}`);
    assert(!msg.includes("/v1/credits"), `l'hôte SEUL, jamais le chemin : ${msg}`);
    console.log("OK: panne réseau — cause ET cible dans le message");
  },

  async function fournisseur_inconnu_reste_une_erreur() {
    const c = makeEmitterCollector();
    await handleUsageCredits("r4", { providerId: "jamais-declare" }, c.emitter);
    const evt = await c.waitFor((e) => e.id === "r4");
    // Distinction volontaire : « pas de clé » est un état, « fournisseur
    // inconnu » est un appel faux — l'un se tait, l'autre doit se voir.
    assert(evt.kind === "error", "un providerId inconnu reste une erreur de protocole");
    console.log("OK: fournisseur inconnu — toujours une erreur");
  },
);

serveur.close();
