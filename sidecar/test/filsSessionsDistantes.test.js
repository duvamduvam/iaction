/*
 * T-180 — une session distante par conversation IAction, créée à la demande
 * sur un relais en mode serveur : création, réutilisation, recréation après
 * archivage, fils distincts, cible non relais inchangée, persistance relue,
 * archivage (conversation supprimée, balayage de 7 jours). Faux `fetch` et
 * faux `query` : AUCUN appel réseau.
 *
 * Lancement isolé : node sidecar/test/filsSessionsDistantes.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, lancer, moduleCompile } from "./harness.mjs";

const { demanderASession, listerPourAgent } = await import(moduleCompile("outilsSessionsDistantes.js"));
const { URL_API } = await import(moduleCompile("sessionsDistantes.js"));
const { archiverFilsConversation, balayerFilsInactifs, estRelais, handleSessionsDistantesArchiverConversation, INACTIVITE_MAX_MS, lireFils, normaliserFil, versCse } = await import(
  moduleCompile("filsSessionsDistantes.js")
);

const JETON = "jeton-factice-pour-test";
const ORG = "org-factice";
const dossier = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-fils-"));
let compteurFichier = 0;
const nouveauChemin = () => path.join(dossier, `fils-${(compteurFichier += 1)}.json`);

const relais = { id: "cse_relais", title: "pc-bureau-relais", tags: ["remote-control-cli"], environment_id: "env_1", connection_status: "connected", updated_at: "2026-11-08T10:00:00Z" };
const interactive = { id: "cse_repl", title: "pc-bureau", tags: ["remote-control-repl"], connection_status: "connected", worker_status: "idle", updated_at: "2026-11-08T10:00:00Z" };

/** Faux serveur à état : liste, création, archivage, détail et événements d'une session. */
function fauxServeur({ entrees = [relais, interactive], creationConnectee = true, archivageStatut = 200 } = {}) {
  const etat = { entrees: entrees.map((e) => ({ ...e })), appels: [], creations: 0, archives: [] };
  const fn = async (url, init = {}) => {
    const u = String(url);
    const methode = init.method ?? "GET";
    const corps = init.body ? JSON.parse(init.body) : null;
    etat.appels.push({ methode, url: u, corps, entetes: init.headers ?? {} });
    const json = (c, status = 200) => new Response(JSON.stringify(c), { status });
    if (methode === "GET" && u === `${URL_API}/v1/code/sessions`) return json({ data: etat.entrees.filter((e) => e.status !== "archived") });
    if (methode === "POST" && u === `${URL_API}/v1/sessions`) {
      etat.creations += 1;
      const n = `s${etat.creations}_${etat.appels.length}`;
      etat.entrees.push({ id: `cse_${n}`, title: corps.title, tags: ["remote-control-cli"], environment_id: corps.environment_id, connection_status: creationConnectee ? "connected" : "disconnected", worker_status: "idle", updated_at: "2026-11-08T10:00:01Z" });
      return json({ id: `session_${n}`, session_status: "pending" });
    }
    const archive = /\/v1\/sessions\/(session_[^/]+)\/archive$/.exec(u);
    if (methode === "POST" && archive) {
      etat.archives.push(archive[1]);
      const e = etat.entrees.find((x) => x.id === `cse_${archive[1].slice(8)}`);
      if (archivageStatut === 200 && e) e.status = "archived";
      return json({}, e || archivageStatut !== 200 ? archivageStatut : 404);
    }
    const detail = /\/v1\/code\/sessions\/(cse_[^/]+)(\/events)?$/.exec(u);
    if (methode === "GET" && detail) {
      const e = etat.entrees.find((x) => x.id === detail[1]);
      if (!e) return json({}, 404);
      return json(detail[2] ? { data: [{ sequence_num: 1 }] } : e);
    }
    return new Response("introuvable", { status: 404 });
  };
  return { fn, etat };
}

/** Faux `query` browser qui note la session visée par chaque tour. */
function fauxQuery() {
  const visees = [];
  const query = (options) => {
    visees.push(options.sse.sessionId);
    async function* flux() {
      yield { type: "result", subtype: "success", result: "ok distant", duration_ms: 10 };
    }
    const it = flux();
    return { [Symbol.asyncIterator]: () => it, interrupt: async () => undefined };
  };
  return { query, visees };
}

function contexte(serveur, cheminFils, extra = {}) {
  const q = fauxQuery();
  const deps = {
    fetchFn: serveur.fn,
    lireJeton: () => JETON,
    lireOrganisation: () => ORG,
    chargerQuery: async () => q.query,
    machine: "poste-test",
    cheminFils,
    conversationId: "conv-aaaaaaaa-1111",
    pasAttenteMs: 1,
    attenteCreationMs: 50,
    graceMs: 5,
    ...extra,
  };
  return { deps, visees: q.visees };
}

const demande = (extra = {}) => ({ session: "pc-bureau-relais", message: "bonjour", ...extra });

await lancer("détection : relais = remote-control-cli + environnement ; interactive non", async () => {
  const { sessions } = await (await import(moduleCompile("sessionsDistantes.js"))).listerSessionsDistantes({}, { fetchFn: fauxServeur().fn, lireJeton: () => JETON });
  const r = sessions.find((x) => x.id === "cse_relais");
  const i = sessions.find((x) => x.id === "cse_repl");
  assert(estRelais(r) && !estRelais(i) && !estRelais(null), "relais détecté, interactive non");
  assert(versCse("session_abc") === "cse_abc", "session_ → cse_");
  assert(normaliserFil("  ") === "defaut" && normaliserFil(undefined) === "defaut" && normaliserFil(" a  b ") === "a b", "fil normalisé");
});

await lancer("création puis réutilisation : une session neuve par conversation, jamais le relais", async () => {
  const serveur = fauxServeur();
  const chemin = nouveauChemin();
  const { deps, visees } = contexte(serveur, chemin);
  const un = await demanderASession(demande(), deps);
  assert(!un.erreur && un.texte.includes("ok distant"), un.texte);
  assert(un.texte.includes("Nouvelle session distante ouverte"), `note de création attendue : ${un.texte}`);
  assert(serveur.etat.creations === 1, "une création");
  const post = serveur.etat.appels.find((a) => a.methode === "POST" && a.url === `${URL_API}/v1/sessions`);
  assert(post.corps.environment_id === "env_1" && post.corps.source === "remote-control" && post.corps.session_context.cwd === "" && Array.isArray(post.corps.events), "corps de création");
  assert(post.entetes["anthropic-beta"] === "ccr-byoc-2025-07-29" && post.entetes["x-organization-uuid"] === ORG, "en-têtes de création");
  assert(visees.length === 1 && visees[0] !== "cse_relais" && visees[0].startsWith("cse_s1_"), `le tour ne vise pas le relais : ${visees}`);
  const deux = await demanderASession(demande({ message: "encore" }), deps);
  assert(!deux.erreur && !deux.texte.includes("Nouvelle session") && serveur.etat.creations === 1, "réutilisation sans création ni note");
  assert(visees[1] === visees[0], "même session au second tour");
  const fils = await lireFils(chemin);
  assert(fils.length === 1 && fils[0].conversation === "conv-aaaaaaaa-1111" && fils[0].relais === "pc-bureau-relais" && fils[0].fil === "defaut" && fils[0].session.startsWith("session_s1_") && fils[0].environnement === "env_1", JSON.stringify(fils));
});

await lancer("deux fils et deux conversations : sessions distinctes, chacune réutilisée", async () => {
  const serveur = fauxServeur();
  const chemin = nouveauChemin();
  const { deps, visees } = contexte(serveur, chemin);
  await demanderASession(demande(), deps);
  await demanderASession(demande({ fil: "revue" }), deps);
  await demanderASession(demande({ fil: "revue" }), deps);
  await demanderASession(demande(), { ...deps, conversationId: "conv-bbbbbbbb-2222" });
  assert(serveur.etat.creations === 3, `trois sessions (défaut, revue, autre conversation) : ${serveur.etat.creations}`);
  assert(new Set(visees).size === 3 && visees[1] === visees[2], `visées : ${visees}`);
  const titres = serveur.etat.entrees.filter((e) => e.id !== "cse_relais" && e.id !== "cse_repl").map((e) => e.title);
  assert(titres.includes("IAction conv-aaa") && titres.includes("IAction conv-aaa · revue"), `titres : ${titres}`);
  assert((await lireFils(chemin)).length === 3, "trois associations");
});

await lancer("persistance : l'association relue après redémarrage est réutilisée", async () => {
  const chemin = nouveauChemin();
  const premier = fauxServeur();
  await demanderASession(demande(), contexte(premier, chemin).deps);
  // « Redémarrage » : nouveau faux serveur qui connaît la même session, mêmes dépendances neuves.
  const second = fauxServeur({ entrees: premier.etat.entrees });
  const { deps, visees } = contexte(second, chemin);
  const r = await demanderASession(demande(), deps);
  assert(!r.erreur && second.etat.creations === 0 && visees.length === 1 && !r.texte.includes("Nouvelle session"), r.texte);
});

await lancer("recréation : session archivée ou déconnectée durablement → neuve, et l'agent est prévenu", async () => {
  const chemin = nouveauChemin();
  const serveur = fauxServeur();
  const { deps } = contexte(serveur, chemin);
  await demanderASession(demande(), deps);
  const premiere = serveur.etat.entrees.find((e) => e.id.startsWith("cse_s1_"));
  premiere.status = "archived"; // archivée de l'extérieur
  const r1 = await demanderASession(demande(), deps);
  assert(!r1.erreur && serveur.etat.creations === 2 && r1.texte.includes("contexte précédent perdu") && r1.texte.includes("archivée ou introuvable"), r1.texte);
  assert(serveur.etat.archives.length === 0, "déjà archivée : pas de second archivage");
  const deuxieme = serveur.etat.entrees.find((e) => e.id.startsWith("cse_s2_"));
  deuxieme.connection_status = "disconnected";
  const r2 = await demanderASession(demande(), deps);
  assert(!r2.erreur && serveur.etat.creations === 3 && r2.texte.includes("contexte précédent perdu") && r2.texte.includes("déconnectée"), r2.texte);
  assert(serveur.etat.archives.length === 1 && deuxieme.id === `cse_${serveur.etat.archives[0].slice(8)}`, "l'ancienne session déconnectée est archivée");
  const fils = await lireFils(chemin);
  assert(fils.length === 1 && fils[0].session.startsWith("session_s3_"), "l'association pointe la dernière");
});

await lancer("création jamais connectée : erreur claire, session archivée, association retirée", async () => {
  const chemin = nouveauChemin();
  const serveur = fauxServeur({ creationConnectee: false });
  const r = await demanderASession(demande(), contexte(serveur, chemin).deps);
  assert(r.erreur && r.texte.includes("n'a pas pris la session") && serveur.etat.archives.length === 1, r.texte);
  assert((await lireFils(chemin)).length === 0, "pas d'association fantôme");
});

await lancer("cible non relais (session interactive) : comportement inchangé, aucune création", async () => {
  const chemin = nouveauChemin();
  const serveur = fauxServeur();
  const { deps, visees } = contexte(serveur, chemin, { conversationId: undefined });
  const r = await demanderASession({ session: "pc-bureau", message: "salut", fil: "x" }, deps);
  assert(!r.erreur && visees[0] === "cse_repl" && serveur.etat.creations === 0 && !r.texte.includes("Nouvelle session"), r.texte);
  const parId = await demanderASession({ session: "cse_repl", message: "salut" }, deps);
  assert(!parId.erreur && visees[1] === "cse_repl", "par identifiant aussi");
  await fsp.access(chemin).then(() => assert(false, "aucun fichier d'association écrit"), () => undefined);
});

await lancer("relais sans identifiant de conversation : erreur explicite, rien créé", async () => {
  const serveur = fauxServeur();
  const r = await demanderASession(demande(), contexte(serveur, nouveauChemin(), { conversationId: undefined }).deps);
  assert(r.erreur && r.texte.includes("Conversation IAction inconnue") && serveur.etat.creations === 0, r.texte);
});

await lancer("lister : le relais est signalé, la session de fil aussi", async () => {
  const chemin = nouveauChemin();
  const serveur = fauxServeur();
  const { deps } = contexte(serveur, chemin);
  await demanderASession(demande(), deps);
  const l = await listerPourAgent(deps);
  const ligne = (t) => l.texte.split("\n").find((x) => x.includes(t)) ?? "";
  assert(ligne("pc-bureau-relais").includes("relais : crée une session par conversation"), l.texte);
  assert(!ligne("— pc-bureau —").includes("relais"), "l'interactive n'est pas un relais");
  assert(ligne("IAction conv-aaa").includes("fil IAction") && !ligne("IAction conv-aaa").includes("relais :"), l.texte);
});

await lancer("archivage : conversation supprimée, balayage de 7 jours, échec API journalisé et conservé", async () => {
  const chemin = nouveauChemin();
  const serveur = fauxServeur();
  const { deps } = contexte(serveur, chemin);
  await demanderASession(demande(), deps);
  await demanderASession(demande({ fil: "b" }), deps);
  await demanderASession(demande(), { ...deps, conversationId: "conv-bbbbbbbb-2222" });
  const avant = serveur.etat.appels.length;
  const rien = await archiverFilsConversation("conv-inconnue", deps);
  assert(rien.archivees === 0 && serveur.etat.appels.length === avant, "sans association : aucun appel réseau");
  const a = await archiverFilsConversation("conv-aaaaaaaa-1111", deps);
  assert(a.archivees === 2 && a.echecs === 0 && serveur.etat.archives.length === 2, JSON.stringify(a));
  const restant = await lireFils(chemin);
  assert(restant.length === 1 && restant[0].conversation === "conv-bbbbbbbb-2222", "seule l'autre conversation reste");
  const recent = await balayerFilsInactifs({ ...deps, maintenant: () => Date.now() + INACTIVITE_MAX_MS - 3600_000 });
  assert(recent.archivees === 0 && (await lireFils(chemin)).length === 1, "moins de 7 jours : conservée");
  const en_panne = fauxServeur({ entrees: serveur.etat.entrees, archivageStatut: 500 });
  const ko = await balayerFilsInactifs({ ...deps, fetchFn: en_panne.fn, maintenant: () => Date.now() + INACTIVITE_MAX_MS + 3600_000 });
  assert(ko.archivees === 0 && ko.echecs === 1 && (await lireFils(chemin)).length === 1, "échec d'API : association conservée pour un prochain balayage");
  const vieux = await balayerFilsInactifs({ ...deps, maintenant: () => Date.now() + INACTIVITE_MAX_MS + 3600_000 });
  assert(vieux.archivees === 1 && vieux.echecs === 0 && (await lireFils(chemin)).length === 0, "plus de 7 jours : archivée et retirée");
});

await lancer("fichier d'associations corrompu : mis de côté, repart de zéro sans planter", async () => {
  const chemin = nouveauChemin();
  await fsp.writeFile(chemin, "{ pas du json", "utf8");
  const serveur = fauxServeur();
  const r = await demanderASession(demande(), contexte(serveur, chemin).deps);
  assert(!r.erreur && serveur.etat.creations === 1, r.texte);
  const noms = await fsp.readdir(dossier);
  assert(noms.some((n) => n.startsWith(`${path.basename(chemin)}.corrompu-`)), "fichier corrompu conservé à côté");
});

await lancer("handler sessionsDistantes.archiverConversation : paramètre vérifié, bilan rendu", async () => {
  const evenements = [];
  const emitter = { chunk: () => undefined, done: (id, d) => evenements.push(["done", id, d]), error: (id, m) => evenements.push(["error", id, m]) };
  await handleSessionsDistantesArchiverConversation("r1", {}, emitter);
  assert(evenements[0][0] === "error" && evenements[0][2].includes("conversationId"), "paramètre manquant");
  await handleSessionsDistantesArchiverConversation("r2", { conversationId: "conv-sans-fil" }, emitter);
  assert(evenements[1][0] === "done" && evenements[1][2].archivees === 0, JSON.stringify(evenements[1]));
});
