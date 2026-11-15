/*
 * claude.titreDiscussion (T-197) — le tour de titre ne doit coûter qu'un titre.
 *
 * Ce que ce fichier garde, par ordre de gravité :
 *  1. AUCUNE session fantôme : `persistSession: false`, `tools: []`, aucun
 *     réglage de projet, `maxTurns: 1` ;
 *  2. le texte de la discussion n'entre JAMAIS dans le journal ;
 *  3. la requête reçoit toujours un `done` (jamais `error`), même quand le SDK
 *     traîne ou échoue ;
 *  4. le compte demandé arrive au SDK.
 *
 * Aucun appel réel : les `queryFn` sont des doublures. Foyer et dossiers de
 * données jetables (voir harness.mjs).
 *
 * Lancement isolé : node sidecar/test/titreDiscussion.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { lancer, assert, makeEmitterCollector, moduleCompile } from "./harness.mjs";

const foyer = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-titre-foyer-"));
process.env.HOME = foyer;
process.env.USERPROFILE = foyer;

const titre = await import(moduleCompile("titreDiscussion.js"));
const { flushWrites } = await import(moduleCompile("jsonlStore.js"));
const journal = await import(moduleCompile("journal.js"));

/** Faux SDK : enregistre les appels, rend la séquence fournie. */
function fauxSdk(messages, { echec, suspendu } = {}) {
  const appels = [];
  const queryFn = (params) => {
    appels.push(params);
    if (echec === "synchrone") throw new Error("SDK indisponible");
    return {
      async *[Symbol.asyncIterator]() {
        if (suspendu) await new Promise(() => {});
        if (echec === "iteration") throw new Error("quota atteint");
        for (const m of messages) yield m;
      },
      async interrupt() {
        appels.interrompu = true;
      },
    };
  };
  return { queryFn, appels };
}

const texte = (t) => [
  { type: "assistant", message: { content: [{ type: "text", text: t }] } },
  { type: "result", subtype: "success", result: t },
];

async function executer(deps, params) {
  const { emitter, events } = makeEmitterCollector();
  await titre.executerClaudeTitreDiscussion(deps, "t1", params, emitter);
  return events;
}

async function testOptionsDuTour() {
  const { queryFn, appels } = fauxSdk(texte("Chansons faciles pour ukulélé"));
  const events = await executer({ queryFn }, { message: "m", reponse: "r" });
  assert(events.length === 1 && events[0].kind === "done" && events[0].data.titre === "Chansons faciles pour ukulélé", `done attendu : ${JSON.stringify(events)}`);
  const o = appels[0].options;
  assert(o.model === "claude-haiku-5-5", `modèle : ${o.model}`);
  assert(Array.isArray(o.tools) && o.tools.length === 0, "aucun outil");
  assert(o.persistSession === false, "aucune session écrite sur disque");
  assert(o.maxTurns === 1, "un seul tour");
  assert(Array.isArray(o.settingSources) && o.settingSources.length === 0, "aucune configuration de projet");
  assert(o.mcpServers === undefined, "aucun MCP");
  assert(o.cwd === os.homedir(), "cwd = dossier personnel");
  assert(o.systemPrompt === titre.PROMPT_SYSTEME_TITRE && o.systemPrompt.startsWith("Tu nommes des discussions"), "prompt système");
  assert(o.env === undefined, "compte perso : l'environnement du processus, rien d'ajouté");
  assert(appels[0].prompt === "<message_utilisateur>m</message_utilisateur>\n<reponse>r</reponse>", `prompt : ${appels[0].prompt}`);
  console.log("OK: options du tour — sans outil, sans persistance, sans configuration, prompt balisé");
}

async function testCompteTeams() {
  const dossier = path.join(foyer, ".claude-compte2");
  await fsp.mkdir(dossier, { recursive: true });
  await fsp.writeFile(path.join(dossier, ".credentials.json"), JSON.stringify({ claudeAiOauth: { refreshTokenExpiresAt: Date.now() + 8 * 24 * 3600 * 1000 } }));
  const { queryFn, appels } = fauxSdk(texte("Titre"));
  await executer({ queryFn }, { message: "m", reponse: "r", compte: "teams" });
  assert(appels[0].options.env?.CLAUDE_CONFIG_DIR === dossier, `CLAUDE_CONFIG_DIR : ${appels[0].options.env?.CLAUDE_CONFIG_DIR}`);
  // Compte inconnu : pas de tour, titre null.
  const f2 = fauxSdk(texte("Titre"));
  const ev = await executer({ queryFn: f2.queryFn }, { message: "m", reponse: "r", compte: "fantome" });
  assert(f2.appels.length === 0 && ev[0].kind === "done" && ev[0].data.titre === null, "compte inconnu ⇒ done null sans tour");
  // Teams non connecté : idem.
  await fsp.rm(dossier, { recursive: true, force: true });
  const f3 = fauxSdk(texte("Titre"));
  const ev3 = await executer({ queryFn: f3.queryFn }, { message: "m", reponse: "r", compte: "teams" });
  assert(f3.appels.length === 0 && ev3[0].data.titre === null, "teams absent ⇒ done null sans tour");
  console.log("OK: compte — env du compte, refus muet (done null) du compte inconnu ou non connecté");
}

async function testCoupeEntree() {
  const { queryFn, appels } = fauxSdk(texte("T"));
  await executer({ queryFn }, { message: "a".repeat(5000), reponse: "b".repeat(5000) });
  const p = appels[0].prompt;
  assert(p.includes("a".repeat(1500)) && !p.includes("a".repeat(1501)), "message coupé à 1500");
  assert(p.includes("b".repeat(1500)) && !p.includes("b".repeat(1501)), "réponse coupée à 1500");
  console.log("OK: entrées coupées à 1500 caractères");
}

async function testNettoyage() {
  const n = titre.nettoyerTitre;
  assert(n("« Chansons faciles. »") === "Chansons faciles", "guillemets et point");
  assert(n('"Titre"\nExplication ensuite') === "Titre", "première ligne");
  assert(n("  Deux   espaces  ") === "Deux espaces", "espaces normalisés");
  assert(n("") === null && n("   \n ") === null, "vide ⇒ null");
  assert(n("x".repeat(71)) === null && n("x".repeat(70)) === "x".repeat(70), "plus de 70 ⇒ null");
  assert(n(undefined) === null, "non-chaîne ⇒ null");
  console.log("OK: nettoyage — première ligne, guillemets, point, 70 caractères");
}

async function testEchecs() {
  for (const [nom, sdk] of [
    ["SDK qui lève à l'appel", fauxSdk([], { echec: "synchrone" })],
    ["SDK qui échoue en cours de tour (quota)", fauxSdk([], { echec: "iteration" })],
    ["réponse inexploitable", fauxSdk(texte("x".repeat(200)))],
    ["résultat en erreur", fauxSdk([{ type: "result", subtype: "error_during_execution", is_error: true, result: "boum" }])],
  ]) {
    const ev = await executer({ queryFn: sdk.queryFn }, { message: "m", reponse: "r" });
    assert(ev.length === 1 && ev[0].kind === "done" && ev[0].data.titre === null, `${nom} ⇒ done {titre:null}, reçu ${JSON.stringify(ev)}`);
  }
  const vide = await executer({ queryFn: fauxSdk(texte("T")).queryFn }, { message: "", reponse: "r" });
  assert(vide[0].kind === "done" && vide[0].data.titre === null, "message absent ⇒ done null");
  console.log("OK: échecs — toujours done {titre:null}, jamais error");
}

async function testDelai() {
  const sdk = fauxSdk([], { suspendu: true });
  const t0 = Date.now();
  const ev = await executer({ queryFn: sdk.queryFn, delaiMs: 50 }, { message: "m", reponse: "r" });
  assert(Date.now() - t0 < 2000, "la borne coupe un tour qui ne finit jamais");
  assert(ev.length === 1 && ev[0].kind === "done" && ev[0].data.titre === null, "délai ⇒ done null");
  assert(sdk.appels[0].options.abortController?.signal.aborted === true, "le tour est abandonné (abort)");
  assert(sdk.appels.interrompu === true, "le tour est interrompu");
  console.log("OK: délai — abandon du tour et done {titre:null}");
}

async function testJournalSansTexte() {
  const SECRET = "SECRET-DE-LA-DISCUSSION-42";
  const sdk = fauxSdk([], { echec: "iteration" });
  await executer({ queryFn: sdk.queryFn }, { message: SECRET, reponse: SECRET });
  const inexploitable = fauxSdk(texte(SECRET.repeat(5)));
  await executer({ queryFn: inexploitable.queryFn }, { message: SECRET, reponse: SECRET });
  await flushWrites();
  const contenu = await fsp.readFile(journal.appLogPath(), "utf8").catch(() => "");
  assert(/titre de discussion abandonné/.test(contenu), "l'échec est journalisé (warn)");
  assert(!contenu.includes(SECRET), "le texte de la discussion n'apparaît pas dans le journal");
  console.log("OK: journal — une ligne par échec, sans le texte de la discussion");
}

await lancer(
  "claude.titreDiscussion",
  testOptionsDuTour,
  testCompteTeams,
  testCoupeEntree,
  testNettoyage,
  testEchecs,
  testDelai,
  testJournalSansTexte,
);
await fsp.rm(foyer, { recursive: true, force: true }).catch(() => {});
