/*
 * Deux comptes Claude (docs/spec-deux-comptes.md) — « Claude Perso » / « Claude Teams ».
 *
 * Ce que ce fichier protège, par ordre de gravité :
 *  1. le débord (module qui parle d'argent) ne lit JAMAIS une ligne d'un autre
 *     compte que `perso` ;
 *  2. un relevé de conso d'un compte n'en écrase jamais un autre (dépôt,
 *     historique, cadence de la sonde) ;
 *  3. `CLAUDE_CONFIG_DIR` part au CLI pour `teams`, et seulement pour lui ;
 *  4. aucun jeton n'est lu : le module ne touche que la date d'expiration.
 *
 * Aucun tour réel : les `queryFn` ci-dessous sont des doublures. Le foyer est un
 * dossier jetable (HOME / USERPROFILE) : ni `~/.claude` ni `~/.claude-compte2`
 * du poste ne sont lus ou écrits.
 *
 * Lancement isolé : node sidecar/test/deuxComptes.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lancer, assert, entry, fakeClaudeModule, makeEmitterCollector, moduleCompile, defaultXdgConfigHome, sleep } from "./harness.mjs";

// Foyer jetable, posé AVANT toute résolution de chemin (os.homedir() le relit à chaque appel).
const foyer = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-foyer-"));
process.env.HOME = foyer;
process.env.USERPROFILE = foyer;
const dossierTeams = path.join(foyer, ".claude-compte2");

const compte = await import(moduleCompile("compteClaude.js"));
const fenetres = await import(moduleCompile("fenetresAbonnement.js"));
const { applyDebord, DEFAULT_DEBORD } = await import(moduleCompile("debord.js"));
const usage = await import(moduleCompile("claudeUsage.js"));
const { createClaudeEngine } = await import(moduleCompile("claude.js"));
const { executerClaudeCommands } = await import(moduleCompile("claudeCommands.js"));
const { flushWrites } = await import(moduleCompile("jsonlStore.js"));

const SECRET_ACCES = "SECRET-ACCES-NE-DOIT-JAMAIS-SORTIR";
const SECRET_RAFRAICHISSEMENT = "SECRET-RAFRAICHISSEMENT-NE-DOIT-JAMAIS-SORTIR";
const PEREMPTION_LOINTAINE = Date.now() + 8 * 24 * 3600 * 1000;

async function poserIdentifiants(expiration) {
  await fsp.mkdir(dossierTeams, { recursive: true });
  const oauth = { accessToken: SECRET_ACCES, refreshToken: SECRET_RAFRAICHISSEMENT, expiresAt: 1 };
  if (expiration !== undefined) oauth.refreshTokenExpiresAt = expiration;
  await fsp.writeFile(path.join(dossierTeams, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
}

async function retirerIdentifiants() {
  await fsp.rm(dossierTeams, { recursive: true, force: true });
}

const fichierFenetres = path.join(defaultXdgConfigHome, "net.duvam.iaction", "usage", "claude-windows.jsonl");

async function ecrireFenetres(lignes) {
  await fsp.mkdir(path.dirname(fichierFenetres), { recursive: true });
  await fsp.writeFile(fichierFenetres, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

const iso = (msAvant) => new Date(Date.now() - msAvant).toISOString();
const fenetre = (pct) => ({ five_hour: { utilization: pct, resetsAt: "2026-11-05T18:00:00Z" }, seven_day: { utilization: pct, resetsAt: "2026-11-09T00:00:00Z" } });

/* ------------------------------------------------------------ compteClaude */

async function testEnvEtDisponibilite() {
  await retirerIdentifiants();

  // perso : aucun CLAUDE_CONFIG_DIR ajouté, que le paramètre soit absent ou explicite.
  for (const brut of [undefined, null, "perso"]) {
    const r = compte.resoudreCompte(brut);
    assert(r.ok && r.compte === "perso", `perso attendu pour ${String(brut)} : ${JSON.stringify(r)}`);
    assert(!("CLAUDE_CONFIG_DIR" in r.env), `perso ne doit pas ajouter CLAUDE_CONFIG_DIR : ${JSON.stringify(r.env)}`);
  }

  // Dossier absent : refus, avec la commande à lancer.
  const absent = compte.resoudreCompte("teams");
  assert(!absent.ok, "teams sans identifiants doit être refusé");
  assert(absent.message.includes("CLAUDE_CONFIG_DIR=~/.claude-compte2 claude auth login"), `commande de connexion absente : ${absent.message}`);

  // Id inconnu ou de mauvais type : refusé, jamais replié sur perso.
  for (const brut of ["autre", "", 3, {}, "__proto__", "toString"]) {
    const r = compte.resoudreCompte(brut);
    assert(!r.ok, `compte ${JSON.stringify(brut)} doit être refusé`);
  }

  // Identifiants présents, expiration lointaine : l'env porte le dossier du foyer, et lui seul.
  await poserIdentifiants(PEREMPTION_LOINTAINE);
  const ok = compte.resoudreCompte("teams");
  assert(ok.ok && ok.compte === "teams", `teams attendu disponible : ${JSON.stringify(ok)}`);
  assert(JSON.stringify(ok.env) === JSON.stringify({ CLAUDE_CONFIG_DIR: dossierTeams }), `env teams inattendu : ${JSON.stringify(ok.env)}`);

  // Le foyer vient de PathEnv, pas de os.homedir() en dur.
  const autreFoyer = compte.envCompte("teams", { platform: "linux", env: {}, home: path.join(os.tmpdir(), "autre-foyer") });
  assert(autreFoyer.CLAUDE_CONFIG_DIR === path.join(os.tmpdir(), "autre-foyer", ".claude-compte2"), `foyer injecté ignoré : ${JSON.stringify(autreFoyer)}`);
  console.log("OK: env par compte — perso sans variable, teams = <foyer>/.claude-compte2, refus (absent, inconnu)");
}

async function testExpiration() {
  const e = { platform: "linux", env: {}, home: foyer };
  const maintenant = Date.now();
  // Trois formes de date : ms, secondes, ISO. Passée ⇒ déconnecté ; future ⇒ connecté.
  const cas = [
    [maintenant - 1000, false, "ms passées"],
    [Math.floor((maintenant - 1000) / 1000), false, "secondes passées"],
    [new Date(maintenant - 1000).toISOString(), false, "ISO passée"],
    [maintenant + 3600_000, true, "ms futures"],
    [new Date(maintenant + 3600_000).toISOString(), true, "ISO future"],
    [undefined, true, "date absente : on laisse le CLI trancher"],
  ];
  for (const [valeur, attendu, etiquette] of cas) {
    await poserIdentifiants(valeur);
    const etat = compte.etatCompte("teams", e, maintenant);
    assert(etat.present && etat.connecte === attendu, `${etiquette} : connecte=${attendu} attendu, reçu ${JSON.stringify(etat)}`);
  }

  // Expiré : listé (donc sélectionnable) mais signalé, et le tour est refusé avec la commande.
  await poserIdentifiants(maintenant - 1000);
  const liste = compte.listerComptes(e, maintenant);
  const teams = liste.find((c) => c.id === "teams");
  assert(teams && teams.connecte === false && teams.label === "Claude Teams", `teams expiré mal listé : ${JSON.stringify(liste)}`);
  const refus = compte.resoudreCompte("teams", e, maintenant);
  assert(!refus.ok && refus.message.includes("claude auth login"), `tour teams expiré à refuser : ${JSON.stringify(refus)}`);
  console.log("OK: expiration — ms/secondes/ISO, listé mais déconnecté, tour refusé avec la commande");
}

async function testInvisibleSansSecondCompte() {
  await retirerIdentifiants();
  const seul = compte.listerComptes();
  assert(seul.length === 1 && seul[0].id === "perso" && seul[0].label === "Claude Perso", `sans teams, perso seul attendu : ${JSON.stringify(seul)}`);
  await poserIdentifiants(PEREMPTION_LOINTAINE);
  const deux = compte.listerComptes();
  assert(deux.map((c) => c.id).join() === "perso,teams" && deux.every((c) => c.connecte), `deux comptes attendus : ${JSON.stringify(deux)}`);

  // La méthode `claude.comptes` rend la même chose, dans `done`.
  const { emitter, events } = makeEmitterCollector();
  compte.executerClaudeComptes("c1", {}, emitter);
  assert(events[0].kind === "done" && events[0].data.comptes.length === 2, `done claude.comptes inattendu : ${JSON.stringify(events)}`);
  console.log("OK: invisible sans second compte, claude.comptes rend les deux sinon");
}

async function testAucunJeton() {
  await poserIdentifiants(PEREMPTION_LOINTAINE);
  const sorties = JSON.stringify([
    compte.listerComptes(),
    compte.resoudreCompte("teams"),
    compte.etatCompte("teams"),
    compte.envCompte("teams"),
  ]);
  assert(!sorties.includes("SECRET"), `un jeton a fuité dans une sortie : ${sorties}`);
  // Le module ne nomme même pas les champs de jeton : seule la date est visée.
  const source = await fsp.readFile(path.join(path.dirname(fileURLToPath(moduleCompile("compteClaude.js"))), "compteClaude.js"), "utf8").catch(() => null);
  if (source !== null) {
    assert(!/accessToken/.test(source), "le module ne doit pas nommer le jeton d'accès");
    assert(!/refreshToken(?!ExpiresAt)/.test(source), "le module ne doit pas nommer le jeton de rafraîchissement");
    assert(!/JSON\.parse/.test(source), "le fichier d'identifiants ne doit jamais être désérialisé");
  }
  console.log("OK: aucun accès au champ de jeton — sorties propres, champs non nommés, pas de JSON.parse");
}

/* ------------------------------------------------- historique et débord */

async function testHistoriqueEtDebord() {
  const cfgDebord = { ...DEFAULT_DEBORD, seuilPct: 90 };
  const cible = { engine: "claude", providerId: null, model: "sonnet" };
  const table = { trivial: { engine: "neutral", providerId: "ollama", model: "x" } };

  // Lignes anciennes (sans champ) = perso ; une ligne teams à 99 % tombe APRÈS elles.
  await ecrireFenetres([
    { ts: iso(120_000), windows: fenetre(20) },
    { ts: iso(60_000), compte: "teams", windows: fenetre(99) },
  ]);
  const perso = await fenetres.readLatestClaudeWindows();
  assert(perso && perso.fiveHourPct === 20, `perso doit lire sa propre ligne (20 %), reçu ${JSON.stringify(perso)}`);
  const lTeams = await fenetres.readLatestClaudeWindows("teams");
  assert(lTeams && lTeams.fiveHourPct === 99, `teams doit lire la sienne (99 %), reçu ${JSON.stringify(lTeams)}`);
  const decision = await applyDebord(cfgDebord, cible, table);
  assert(decision.debord === null && decision.target === cible, `une ligne teams à 99 % ne doit PAS déclencher le débord : ${JSON.stringify(decision)}`);

  // Et le débord lit bien perso quand c'est perso qui sature, malgré une ligne teams plus récente à 0 %.
  await ecrireFenetres([
    { ts: iso(120_000), windows: fenetre(95) },
    { ts: iso(60_000), compte: "teams", windows: fenetre(0) },
  ]);
  const sature = await applyDebord(cfgDebord, cible, table);
  assert(sature.debord?.active === true, `perso à 95 % derrière une ligne teams doit déborder : ${JSON.stringify(sature)}`);

  // Sans aucune ligne perso : pas de relevé, donc pas de débord (jamais d'emprunt à teams).
  await ecrireFenetres([{ ts: iso(60_000), compte: "teams", windows: fenetre(99) }]);
  assert((await fenetres.readLatestClaudeWindows()) === null, "perso sans ligne doit rendre null");
  const rien = await applyDebord(cfgDebord, cible, table);
  assert(rien.debord === null, "aucune ligne perso ⇒ jamais de débord");

  // Perso noyé sous plus de 64 Kio de lignes teams : la lecture s'élargit et le retrouve.
  const noyade = [{ ts: iso(3_600_000), windows: fenetre(93) }];
  for (let i = 0; i < 400; i++) noyade.push({ ts: iso(1000 + i), compte: "teams", windows: fenetre(i % 100) });
  await ecrireFenetres(noyade);
  const retrouve = await fenetres.readLatestClaudeWindows();
  assert(retrouve && retrouve.fiveHourPct === 93, `perso noyé sous des lignes teams non retrouvé : ${JSON.stringify(retrouve)}`);
  console.log("OK: historique — anciennes lignes = perso, teams à 99 % sans débord, perso lu derrière, lecture élargie");
}

async function testEcritureEtLecturePourCompte() {
  fenetres.reinitialiserCadenceInstantanes();
  await fsp.rm(fichierFenetres, { force: true });
  // Même signature pour les deux comptes : l'un ne doit pas faire écarter l'autre.
  const w = { five_hour: { utilization: 0, resetsAt: "2026-11-05T18:00:00Z" } };
  fenetres.recordClaudeWindowsSnapshot(w);
  fenetres.recordClaudeWindowsSnapshot(w, "teams");
  fenetres.recordClaudeWindowsSnapshot(w, "teams"); // doublon du même compte : écarté
  await flushWrites();
  const lignes = (await fsp.readFile(fichierFenetres, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert(lignes.length === 2, `2 lignes attendues (une par compte), reçu ${lignes.length}`);
  assert(!("compte" in lignes[0]), `perso ne doit pas écrire le champ compte : ${JSON.stringify(lignes[0])}`);
  assert(lignes[1].compte === "teams", `teams doit être étiqueté : ${JSON.stringify(lignes[1])}`);

  // usage.claude.history filtre par compte, perso par défaut, refuse l'inconnu.
  const hist = async (params) => {
    const { emitter, events } = makeEmitterCollector();
    await fenetres.handleUsageClaudeHistory("h", params, emitter);
    return events[0];
  };
  assert((await hist({})).data.snapshots.length === 1, "history sans compte = perso seulement");
  assert((await hist({ compte: "teams" })).data.snapshots.length === 1, "history teams = ses lignes seulement");
  assert((await hist({ compte: "xx" })).kind === "error", "history d'un compte inconnu doit être refusée");
  console.log("OK: écriture — champ compte seulement hors perso, cadence par compte, history filtrée");
}

/* ------------------------------------------------------ claude.start / env */

/** queryFn qui note les options reçues et répond une conso différente selon le compte vu dans l'env. */
function queryFnEspion(vus) {
  return function queryFn({ options }) {
    vus.push(options);
    const teams = Boolean(options.env && options.env.CLAUDE_CONFIG_DIR && options.env.CLAUDE_CONFIG_DIR.endsWith(".claude-compte2"));
    async function* gen() {
      yield { type: "system", subtype: "init", session_id: "s-" + (teams ? "teams" : "perso"), model: "fake" };
      yield { type: "result", subtype: "success", session_id: "s", result: "ok", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 };
    }
    const it = gen();
    return {
      [Symbol.asyncIterator]() { return it; },
      async interrupt() {},
      async supportedCommands() { return []; },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        const pct = teams ? 77 : 11;
        return {
          subscription_type: teams ? "team" : "max",
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: pct, resets_at: "2026-11-05T18:00:00Z" }, seven_day: { utilization: pct, resets_at: "2026-11-09T00:00:00Z" } },
        };
      },
    };
  };
}

async function jouerTour(moteur, params) {
  const { emitter, events, waitFor } = makeEmitterCollector();
  const id = "t" + Math.random().toString(36).slice(2);
  await moteur.handleClaudeStart(id, { chatOnly: true, prompt: "bonjour", ...params }, emitter);
  await waitFor((e) => e.id === id && (e.kind === "done" || e.kind === "error"), 3000, "fin du tour");
  return events.filter((e) => e.id === id);
}

async function releveAttendu(moteur, params, pct) {
  for (let i = 0; i < 40; i++) {
    const { emitter, events } = makeEmitterCollector();
    moteur.handleClaudeUsage("u", params, emitter);
    if (events[0]?.data?.fiveHour?.utilization === pct) return events[0].data;
    await sleep(25);
  }
  return null;
}

async function testStartEnvEtDepot() {
  await poserIdentifiants(PEREMPTION_LOINTAINE);
  fenetres.reinitialiserCadenceInstantanes();
  await fsp.rm(fichierFenetres, { force: true });
  const vus = [];
  const moteur = createClaudeEngine({ queryFn: queryFnEspion(vus) });
  const envInitial = process.env.CLAUDE_CONFIG_DIR;

  // perso : le CLAUDE_CONFIG_DIR du processus passe tel quel, jamais celui du foyer teams.
  const evPerso = await jouerTour(moteur, {});
  assert(evPerso.some((e) => e.kind === "done"), `tour perso : done attendu : ${JSON.stringify(evPerso)}`);
  assert(vus[0].env.CLAUDE_CONFIG_DIR === envInitial, `perso : l'env du processus doit passer intact (${vus[0].env.CLAUDE_CONFIG_DIR})`);

  // teams : CLAUDE_CONFIG_DIR du compte dans options.env.
  const evTeams = await jouerTour(moteur, { compte: "teams" });
  assert(evTeams.some((e) => e.kind === "done"), `tour teams : done attendu : ${JSON.stringify(evTeams)}`);
  assert(vus[1].env.CLAUDE_CONFIG_DIR === dossierTeams, `teams : CLAUDE_CONFIG_DIR attendu ${dossierTeams}, reçu ${vus[1].env.CLAUDE_CONFIG_DIR}`);

  // Sans variable dans le processus, perso n'en reçoit AUCUNE.
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    await jouerTour(moteur, { compte: "perso" });
    assert(!("CLAUDE_CONFIG_DIR" in vus[2].env), "perso : aucun CLAUDE_CONFIG_DIR ne doit être ajouté");
  } finally {
    if (envInitial !== undefined) process.env.CLAUDE_CONFIG_DIR = envInitial;
  }

  // Compte inconnu : refusé, aucun SDK lancé. Compte indisponible : refusé avec la commande.
  const avant = vus.length;
  const inconnu = await jouerTour(moteur, { compte: "fantome" });
  assert(inconnu[0].kind === "error" && vus.length === avant, `compte inconnu à refuser sans lancer le SDK : ${JSON.stringify(inconnu)}`);
  await retirerIdentifiants();
  const indispo = await jouerTour(moteur, { compte: "teams" });
  assert(indispo[0].kind === "error" && indispo[0].data.message.includes("claude auth login") && vus.length === avant,
    `teams indisponible à refuser avec la commande : ${JSON.stringify(indispo)}`);

  // Dépôt : chaque compte garde SON relevé (11 % perso, 77 % teams), sans écrasement croisé.
  const p = await releveAttendu(moteur, {}, 11);
  const t = await releveAttendu(moteur, { compte: "teams" }, 77);
  assert(p !== null, "le relevé perso (11 %) doit rester celui de perso");
  assert(t !== null, "le relevé teams (77 %) doit rester celui de teams");
  assert(p.subscriptionType === "max" && t.subscriptionType === "team", "les types d'abonnement ne doivent pas se mélanger");

  // L'historique a reçu les deux, étiquetés.
  await flushWrites();
  const lignes = (await fsp.readFile(fichierFenetres, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert(lignes.some((l) => l.compte === "teams" && l.windows.five_hour.utilization === 77), "ligne teams à 77 % attendue dans l'historique");
  assert(lignes.some((l) => !("compte" in l) && l.windows.five_hour.utilization === 11), "ligne perso à 11 % (sans champ) attendue");
  console.log("OK: claude.start — env par compte, refus (inconnu, indisponible), dépôt et historique par compte");
}

async function testCommandsEtSonde() {
  await poserIdentifiants(PEREMPTION_LOINTAINE);
  const vus = [];
  const queryFn = queryFnEspion(vus);
  const deps = { queryFn, apiKey: () => null, decorerErreurAuth: (m) => m };

  // claude.commands : même env que le tour.
  for (const [params, attendu] of [[{}, process.env.CLAUDE_CONFIG_DIR], [{ compte: "teams" }, dossierTeams]]) {
    const { emitter, events, waitFor } = makeEmitterCollector();
    await executerClaudeCommands(deps, "c", { cwd: foyer, ...params }, emitter);
    await waitFor((e) => e.kind === "done" || e.kind === "error", 3000, "claude.commands");
    assert(events[0].kind === "done", `claude.commands : done attendu : ${JSON.stringify(events)}`);
    assert(vus[vus.length - 1].env.CLAUDE_CONFIG_DIR === attendu, `claude.commands : env ${attendu} attendu`);
  }
  const { emitter: em, events: ev } = makeEmitterCollector();
  await executerClaudeCommands(deps, "c", { cwd: foyer, compte: "fantome" }, em);
  assert(ev[0].kind === "error", "claude.commands : compte inconnu refusé");

  // Sonde usage.claude.init : l'env du compte part dans le micro-tour, et seulement pour teams.
  usage.reinitialiserCadenceUsageInit();
  fenetres.reinitialiserCadenceInstantanes();
  const depot = usage.creerDepotUsage();
  const sondes = [];
  const queryFnSonde = (arg) => { sondes.push(arg.options); return queryFn(arg); };
  const lancerSonde = async (params) => {
    const { emitter, events } = makeEmitterCollector();
    await usage.executerClaudeUsageInit({ queryFn: queryFnSonde, depot }, "i", params, emitter);
    return events[0];
  };
  const rPerso = await lancerSonde({});
  assert(rPerso.kind === "done" && rPerso.data.fiveHour.utilization === 11, `sonde perso : 11 % attendu : ${JSON.stringify(rPerso)}`);
  assert(!("env" in sondes[0]), "la sonde perso ne doit recevoir aucun env ajouté");

  // Cadence PAR COMPTE : la sonde teams part immédiatement après celle de perso (pas « trop tôt »).
  const rTeams = await lancerSonde({ compte: "teams" });
  assert(rTeams.kind === "done" && rTeams.data.fiveHour.utilization === 77, `sonde teams : 77 % attendu : ${JSON.stringify(rTeams)}`);
  assert(sondes.length === 2 && sondes[1].env.CLAUDE_CONFIG_DIR === dossierTeams, "la sonde teams doit recevoir CLAUDE_CONFIG_DIR");
  assert(depot.lire().fiveHour.utilization === 11 && depot.lire("teams").fiveHour.utilization === 77, "le dépôt doit garder un relevé par compte");

  // Une seconde sonde perso, trop tôt : répond le dernier résultat de PERSO, sans nouveau micro-tour.
  const encore = await lancerSonde({});
  assert(sondes.length === 2 && encore.data.fiveHour.utilization === 11, "cadence perso : pas de nouveau micro-tour, son propre dernier résultat");

  // usage.claude : lecture par compte ; inconnu refusé.
  const lire = (params) => { const { emitter, events } = makeEmitterCollector(); usage.executerClaudeUsage(depot, "u", params, emitter); return events[0]; };
  assert(lire({ compte: "teams" }).data.fiveHour.utilization === 77, "usage.claude teams = relevé teams");
  assert(lire({}).data.fiveHour.utilization === 11, "usage.claude sans compte = perso");
  assert(lire({ compte: "zz" }).kind === "error", "usage.claude compte inconnu refusé");

  // Compte indisponible : la sonde refuse net, sans micro-tour.
  await retirerIdentifiants();
  usage.reinitialiserCadenceUsageInit();
  const avant = sondes.length;
  const refus = await lancerSonde({ compte: "teams" });
  assert(refus.kind === "error" && refus.data.message.includes("claude auth login") && sondes.length === avant, `sonde teams indisponible à refuser : ${JSON.stringify(refus)}`);
  console.log("OK: commandes et sonde — env du compte, cadence et dépôt par compte, refus net");
}

/* ------------------------------------------------- protocole bout en bout */

async function testProtocole() {
  await poserIdentifiants(PEREMPTION_LOINTAINE);
  const xdg = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-comptes-xdg-"));
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: foyer, USERPROFILE: foyer, XDG_CONFIG_HOME: xdg, IACTION_FAKE_CLAUDE: "1", IACTION_FAKE_CLAUDE_MODULE: fakeClaudeModule },
  });
  const recus = [];
  const attentes = [];
  createInterface({ input: child.stdout }).on("line", (ligne) => {
    if (!ligne.trim()) return;
    const evt = JSON.parse(ligne);
    recus.push(evt);
    for (const a of attentes.splice(0)) a();
  });
  const attendre = async (pred, label) => {
    const fin = Date.now() + 5000;
    while (Date.now() < fin) {
      const trouve = recus.find(pred);
      if (trouve) return trouve;
      await new Promise((r) => { attentes.push(r); setTimeout(r, 100); });
    }
    throw new Error(`timeout en attendant ${label}`);
  };
  try {
    await attendre((e) => e.event === "ready", "ready");
    child.stdin.write(JSON.stringify({ id: "k1", method: "claude.comptes", params: {} }) + "\n");
    const comptes = await attendre((e) => e.id === "k1", "claude.comptes");
    assert(comptes.event === "done" && comptes.data.comptes.map((c) => c.id).join() === "perso,teams", `claude.comptes : ${JSON.stringify(comptes)}`);
    child.stdin.write(JSON.stringify({ id: "k2", method: "claude.start", params: { prompt: "x", chatOnly: true, compte: "fantome" } }) + "\n");
    const refus = await attendre((e) => e.id === "k2", "refus claude.start");
    assert(refus.event === "error", `claude.start d'un compte inconnu à refuser : ${JSON.stringify(refus)}`);
  } finally {
    child.kill();
    await fsp.rm(xdg, { recursive: true, force: true }).catch(() => {});
  }
  console.log("OK: protocole — claude.comptes dispatchée, claude.start refuse un compte inconnu");
}

/*
 * Les tâches de fond (planifiées, étapes d'orchestration headless) restent sur perso : aucun paramètre
 * `compte` n'est construit par l'orchestrateur ni par les timers. Un agent SÉLECTIONNÉ dans une session
 * passe par claude.start de l'interface, qui porte le compte de la session.
 */
async function testTachesDeFondSansCompte() {
  const dossier = path.dirname(fileURLToPath(moduleCompile("orchestrator.js")));
  for (const fichier of ["orchestrator.js", "tachesTimers.js", "taches.js"]) {
    const source = await fsp.readFile(path.join(dossier, fichier), "utf8").catch(() => null);
    if (source === null) continue;
    assert(!/\bcompte\s*:/.test(source) && !/params\.compte/.test(source), `${fichier} ne doit pas poser de compte : les tâches de fond restent sur perso`);
  }
  console.log("OK: tâches de fond — aucun compte posé par l'orchestrateur ni les timers");
}

await lancer(
  "deux comptes Claude",
  testEnvEtDisponibilite,
  testExpiration,
  testInvisibleSansSecondCompte,
  testAucunJeton,
  testHistoriqueEtDebord,
  testEcritureEtLecturePourCompte,
  testStartEnvEtDepot,
  testCommandsEtSonde,
  testProtocole,
  testTachesDeFondSansCompte,
);
await fsp.rm(foyer, { recursive: true, force: true }).catch(() => {});
