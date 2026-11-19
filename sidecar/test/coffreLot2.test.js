/*
 * Coffre de secrets, lot 2 — côté sidecar (docs/etude-coffre-secrets.md § 5 à § 7)
 *
 * - garde d'écriture des fichiers de secrets (gardeSecrets.ts) : Write, Edit,
 *   Bash, moteur neutre ; crochet PreToolUse du SDK ;
 * - outil `secrets_lister` : des noms, jamais une valeur ;
 * - secrets `sans-fenetre` lus sans coquille (tâche de fond) ;
 * - inventaire et migration guidée des `.env` ; secrets des tâches ;
 * - relais entre studios : serveur MCP contre un FAUX broker local
 *   (routes /boites), de bout en bout par stdio, et ses garde-fous ;
 * - références `${IACTION:…}`.
 *
 * Lancement isolé : node sidecar/test/coffreLot2.test.js
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { assert, entry, lancer, moduleCompile } from "./harness.mjs";

const fs_ = await import(moduleCompile("fichiersSecrets.js"));
const garde = await import(moduleCompile("gardeSecrets.js"));
const relais = await import(moduleCompile("relaisServeur.js"));
const relaisHttp = await import(moduleCompile("relaisHttp.js"));
const integres = await import(moduleCompile("mcpIntegres.js"));
const inv = await import(moduleCompile("inventaireEnv.js"));
const secrets = await import(moduleCompile("mcpSecrets.js"));
const outil = await import(moduleCompile("outilSecrets.js"));
const fond = await import(moduleCompile("trousseauFond.js"));

async function tmp(nom) {
  return fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), `iaction-lot2-${nom}-`)));
}

// ---------------------------------------------------------------------------
// Garde d'écriture
// ---------------------------------------------------------------------------

async function testReglesFichiers() {
  for (const n of [".env", "a/.env.local", "x.pem", "C:\\p\\cle.KEY"]) assert(fs_.estFichierSecretBloque(n), `bloqué : ${n}`);
  for (const n of [".env.example", "env.md", "README.md", "cle.keys.md"]) assert(!fs_.estFichierSecretBloque(n), `libre : ${n}`);
  for (const n of ["id_ed25519", ".ssh/config", "mcp-secrets.json", "a.p12", "credentials"]) {
    assert(fs_.estFichierSensible(n), `sensible : ${n}`);
  }
  assert(!fs_.estFichierSensible("rapport.pdf"), "un rapport n'est pas sensible");
  const c = fs_.ciblesEcritureShell(`echo "K=v" > .env && cat x | tee -a 'sub/.env.prod' 2>/dev/null; ls >> log.txt`);
  assert(c.includes(".env") && c.includes("sub/.env.prod") && c.includes("log.txt"), `cibles : ${JSON.stringify(c)}`);
  assert(!c.includes("/dev/null"), "/dev/null ignoré");
}

async function testGarde() {
  const cwd = await tmp("garde");
  assert(garde.cheminRefuse(cwd, "Write", { file_path: path.join(cwd, ".env") }) !== null, "Write .env refusé");
  assert(garde.cheminRefuse(cwd, "Edit", { file_path: "cle.pem" }) !== null, "Edit relatif .pem refusé");
  assert(garde.cheminRefuse(cwd, "Write", { file_path: path.join(cwd, ".env.example") }) === null, ".env.example permis");
  assert(garde.cheminRefuse(cwd, "Write", { file_path: path.join(os.tmpdir(), ".env") }) === null, "hors projet : non concerné");
  assert(garde.cheminRefuse(cwd, "Bash", { command: "printf 'T=1' > .env" }) !== null, "redirection Bash refusée");
  assert(garde.cheminRefuse(cwd, "Bash", { command: "cat .env" }) === null, "lecture Bash permise");
  assert(garde.cheminRefuse(cwd, "write_file", { path: ".env" }) !== null, "moteur neutre : write_file refusé");
  const refus = garde.refusOutilNeutre(cwd, "edit_file", { path: "a.key" });
  assert(refus?.isError === true && /coffre/.test(refus.content) && /\$\{SECRET:nom\}/.test(refus.content), "message qui renvoie au coffre");

  // Crochet du SDK : appelé quel que soit le mode, décision `deny`.
  const crochets = garde.crochetsSecrets(cwd);
  const [matcher] = crochets.PreToolUse;
  assert(/Write/.test(matcher.matcher) && /Bash/.test(matcher.matcher), `matcher : ${matcher.matcher}`);
  const r = await matcher.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: ".env", content: "JETON=x" } });
  assert(r.hookSpecificOutput?.permissionDecision === "deny", `décision : ${JSON.stringify(r)}`);
  assert(!JSON.stringify(r).includes("JETON=x"), "le contenu ne ressort jamais");
  const ok = await matcher.hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "a.ts" } });
  assert(JSON.stringify(ok) === "{}", "écriture ordinaire : rien");
}

// ---------------------------------------------------------------------------
// Outil secrets_lister, sans-fenêtre hors coquille
// ---------------------------------------------------------------------------

async function testSecretsLister() {
  secrets.chargerCoffre("ouvert", { "relais.jeton": "VALEUR-SECRETE-123" });
  const texte = await outil.executerSecretsLister();
  assert(texte.includes("`relais.jeton`") && texte.includes("${SECRET:nom}"), texte);
  assert(!texte.includes("VALEUR-SECRETE-123"), "aucune valeur dans la réponse de l'outil");
  assert(outil.SECRETS_LISTER_TOOL_NAME === "mcp__studio__secrets_lister", "nom complet");
}

async function testSansFenetre() {
  const xdg = await tmp("xdg");
  const avant = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const dossier = path.join(xdg, "net.duvam.iaction");
    await fsp.mkdir(dossier, { recursive: true });
    assert((await fond.coffreExiste()) === false, "pas de coffre");
    await fsp.writeFile(path.join(dossier, "coffre.cle.age"), "x");
    await fsp.writeFile(fond.indexSansFenetrePath(), JSON.stringify({ version: 1, noms: ["mcp:fond.jeton", "provider:p", "mcp:absent"] }));
    const lus = [];
    const r = await fond.lireSecretsSansFenetre(async (compte) => {
      lus.push(compte);
      return compte === "mcp:fond.jeton" ? "v-fond" : null;
    });
    assert(JSON.stringify(r) === JSON.stringify({ "fond.jeton": "v-fond" }), `lus : ${JSON.stringify(r)}`);
    assert(!lus.includes("provider:p"), "seuls les comptes mcp: sont demandés au trousseau");
  } finally {
    process.env.XDG_CONFIG_HOME = avant;
  }
}

// ---------------------------------------------------------------------------
// .env : inventaire, migration guidée, secrets des tâches
// ---------------------------------------------------------------------------

async function testEnv() {
  const v = inv.lireVariablesEnv(`# c\nexport A=1\nB="deux trois"\nC=quatre # commentaire\n\nmauvais\n`);
  assert(v.get("A") === "1" && v.get("B") === "deux trois" && v.get("C") === "quatre" && v.size === 3, JSON.stringify([...v]));

  const projet = await tmp("env");
  await fsp.mkdir(path.join(projet, "outil", "node_modules"), { recursive: true });
  await fsp.writeFile(path.join(projet, "outil", ".env"), "RELAIS_TOKEN=jeton-du-env\nAUTRE=x\n");
  await fsp.writeFile(path.join(projet, ".env.example"), "RELAIS_TOKEN=\n");
  await fsp.writeFile(path.join(projet, "outil", "node_modules", ".env"), "IGNORE=1\n");
  const trouves = await inv.inventorierEnv([projet]);
  assert(trouves.length === 1 && trouves[0].fichier === "outil/.env", `inventaire : ${JSON.stringify(trouves)}`);
  assert(JSON.stringify(trouves[0].cles) === JSON.stringify(["RELAIS_TOKEN", "AUTRE"]), "noms des variables seulement");
  assert(!JSON.stringify(trouves).includes("jeton-du-env"), "aucune valeur dans l'inventaire");
}

/** Vrai sidecar : migration d'une variable, réécriture du .mcp.json, suppression. */
async function testMigrerEnvBoutEnBout() {
  const xdg = await tmp("xdg-mig");
  const projet = await tmp("mig");
  await fsp.writeFile(path.join(projet, ".env"), "RELAIS_TOKEN=jeton-du-env\n");
  await fsp.writeFile(path.join(projet, ".mcp.json"), JSON.stringify({ mcpServers: { relais: { command: "x", env: { RELAIS_TOKEN: "en dur" } } } }));
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, XDG_CONFIG_HOME: xdg } });
  const evts = [];
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (l) => l.trim() && evts.push(JSON.parse(l)));
  const attendre = async (pred, label) => {
    for (let i = 0; i < 100; i++) {
      const e = evts.find(pred);
      if (e) return e;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error(`timeout : ${label}`);
  };
  const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
  const fin = (id) => attendre((e) => e.id === id && (e.event === "done" || e.event === "error"), id);
  try {
    await attendre((e) => e.event === "ready", "ready");
    send({ id: "m0", method: "coffre.migrerEnv", params: { projet, fichier: ".env", cle: "RELAIS_TOKEN", nom: "relais.jeton" } });
    const m0 = await fin("m0");
    assert(m0.event === "error" && /coffre fermé/.test(m0.data.message), "coffre fermé : refusé (jamais vers l'ancien fichier)");

    send({ id: "c1", method: "coffre.charger", params: { etat: "ouvert", secrets: {} } });
    await fin("c1");
    send({ id: "m1", method: "coffre.migrerEnv", params: { projet, fichier: ".env", cle: "RELAIS_TOKEN", nom: "relais.jeton", serveur: "relais" } });
    const ecrire = await attendre((e) => e.event === "coffre:ecrire", "coffre:ecrire");
    assert(ecrire.data.nom === "relais.jeton" && ecrire.data.valeur === "jeton-du-env", "valeur confiée à la coquille");
    await new Promise((r) => setTimeout(r, 150));
    const mcpAvant = JSON.parse(await fsp.readFile(path.join(projet, ".mcp.json"), "utf8"));
    assert(mcpAvant.mcpServers.relais.env.RELAIS_TOKEN === "en dur", ".mcp.json pas réécrit avant l'accusé de la coquille");
    send({ id: "coffre-ecrit-1", method: "coffre.ecrit", params: { demande: ecrire.data.demande, ok: true } });
    const m1 = await fin("m1");
    assert(m1.event === "done" && m1.data.serveur === "relais", `m1 : ${JSON.stringify(m1)}`);
    const mcp = JSON.parse(await fsp.readFile(path.join(projet, ".mcp.json"), "utf8"));
    assert(mcp.mcpServers.relais.env.RELAIS_TOKEN === "${SECRET:relais.jeton}", `réécrit : ${JSON.stringify(mcp)}`);

    send({ id: "x1", method: "coffre.supprimerEnv", params: { projet, fichier: "../.env" } });
    assert((await fin("x1")).event === "error", "hors projet : refusé");
    send({ id: "x2", method: "coffre.supprimerEnv", params: { projet, fichier: ".mcp.json" } });
    assert((await fin("x2")).event === "error", "pas un .env : refusé");
    send({ id: "x3a", method: "coffre.supprimerEnv", params: { projet, fichier: ".env" } });
    const x3a = await fin("x3a");
    assert(x3a.event === "error" && /RELAIS_TOKEN/.test(x3a.data.message), `sans versements déclarés : refusé (${JSON.stringify(x3a)})`);
    send({ id: "x3b", method: "coffre.supprimerEnv", params: { projet, fichier: ".env", versements: [{ cle: "RELAIS_TOKEN", nom: "autre.nom" }] } });
    assert((await fin("x3b")).event === "error", "versement déclaré mais absent du coffre : refusé");
    send({ id: "x3", method: "coffre.supprimerEnv", params: { projet, fichier: ".env", versements: [{ cle: "RELAIS_TOKEN", nom: "relais.jeton" }] } });
    assert((await fin("x3")).event === "done", "suppression confirmée, valeur vérifiée au coffre");
    assert(!(await fsp.stat(path.join(projet, ".env")).then(() => true, () => false)), ".env supprimé");

    send({ id: "r1", method: "coffre.referencesTaches", params: {} });
    const r1 = await fin("r1");
    assert(r1.event === "done" && Array.isArray(r1.data.noms), `références : ${JSON.stringify(r1)}`);

    const sorties = evts.filter((e) => e.event !== "coffre:ecrire").map((e) => JSON.stringify(e)).join("\n");
    assert(!sorties.includes("jeton-du-env"), "hors la demande à la coquille, la valeur ne sort pas");
  } finally {
    child.kill();
  }
}

async function testSecretsDesTaches() {
  const xdg = await tmp("xdg-taches");
  const projet = await tmp("tache-projet");
  const avant = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    await fsp.writeFile(path.join(projet, ".mcp.json"), JSON.stringify({ mcpServers: { r: { command: "x", env: { J: "${SECRET:relais.jeton}" } } } }));
    const ecrire = async (nom, extra) => {
      const d = path.join(xdg, "net.duvam.iaction", "taches", nom);
      await fsp.mkdir(d, { recursive: true });
      await fsp.writeFile(path.join(d, "tache.yaml"), `name: ${nom}\norchestration: o\ncwd: ${projet}\n${extra}`);
      return d;
    };
    await ecrire("matin", "enabled: true\n");
    // Une tâche `serveur` sur un autre projet : ses secrets ne comptent pas ici.
    const autre = await tmp("tache-autre");
    await fsp.writeFile(path.join(autre, ".mcp.json"), JSON.stringify({ mcpServers: { s: { command: "x", env: { J: "${SECRET:serveur.seul}" } } } }));
    const d = path.join(xdg, "net.duvam.iaction", "taches", "distante");
    await fsp.mkdir(d, { recursive: true });
    await fsp.writeFile(path.join(d, "tache.yaml"), `name: distante\norchestration: o\ncwd: ${autre}\nlieu: serveur\n`);
    const noms = await inv.secretsDesTaches();
    assert(JSON.stringify(noms) === JSON.stringify(["relais.jeton"]), `secrets des tâches : ${JSON.stringify(noms)}`);
  } finally {
    process.env.XDG_CONFIG_HOME = avant;
  }
}

// ---------------------------------------------------------------------------
// Relais entre studios — faux broker
// ---------------------------------------------------------------------------

const JETONS = { "jeton-maison": "maison", "jeton-poste": "poste" };

function fauxBroker() {
  const boites = { maison: new Map(), poste: new Map() };
  const serveur = http.createServer((req, res) => {
    const json = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    const moi = JETONS[(req.headers.authorization ?? "").replace(/^Bearer /, "")];
    if (!req.headers.authorization) return json(401, { detail: "token manquant" });
    if (!moi) return json(403, { detail: "token sans boite" });
    const url = new URL(req.url, "http://x");
    const seg = decodeURIComponent(url.pathname.replace(/^\/boites\/?/, ""));
    if (req.method === "GET" && seg === "") {
      const fichiers = [...boites[moi].entries()].map(([nom, f]) => ({ nom, taille: f.contenu.length, de: f.de, boite: moi, expire_le: 2000000000 }));
      return json(200, { studio: moi, autres: Object.keys(boites).filter((b) => b !== moi), fichiers });
    }
    if (req.method === "POST") {
      if (!boites[seg]) return json(404, { detail: "boite inconnue" });
      const morceaux = [];
      req.on("data", (m) => morceaux.push(m));
      req.on("end", () => {
        const corps = Buffer.concat(morceaux);
        const typeCorps = String(req.headers["content-type"]); // sans regex : CodeQL (ReDoS) sur « boundary=… » répété
        const frontiere = typeCorps.slice(typeCorps.lastIndexOf("boundary=") + "boundary=".length);
        const texte = corps.toString("latin1");
        const nom = /filename="([^"]+)"/.exec(texte)[1];
        const debut = texte.indexOf("\r\n\r\n") + 4;
        const finIdx = texte.lastIndexOf(`\r\n--${frontiere}--`);
        boites[seg].set(nom, { contenu: corps.subarray(debut, finIdx), de: moi });
        json(201, { ok: true, nom });
      });
      return;
    }
    if (req.method === "GET") {
      const f = boites[moi].get(seg);
      if (!f) return json(404, { detail: "fichier inconnu" });
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(f.contenu);
    }
    if (req.method === "DELETE") {
      boites[moi].delete(seg);
      return json(200, { ok: true, nom: seg });
    }
    json(405, {});
  });
  return new Promise((resolve) => serveur.listen(0, "127.0.0.1", () => resolve({ serveur, boites, url: `http://127.0.0.1:${serveur.address().port}` })));
}

async function testRelais() {
  const { serveur, boites, url } = await fauxBroker();
  const racine = await tmp("relais");
  try {
    const cfgMaison = relais.lireConfig({ RELAIS_URL: url, RELAIS_JETON: "jeton-maison", RELAIS_RACINE: racine });
    const cfgPoste = relais.lireConfig({ RELAIS_URL: url, RELAIS_JETON: "jeton-poste", RELAIS_RACINE: racine });
    assert(typeof cfgMaison === "object", `config : ${cfgMaison}`);
    assert(/jeton/.test(relais.lireConfig({ RELAIS_URL: url, RELAIS_JETON: "${SECRET:relais.jeton}" })), "référence non résolue : message clair");
    assert(/RELAIS_URL/.test(relais.lireConfig({ RELAIS_JETON: "x" })), "adresse manquante : message clair");

    const contenu = Buffer.from("rapport binaire \u0000\u00ff fin", "latin1");
    await fsp.writeFile(path.join(racine, "rapport.bin"), contenu);
    await fsp.writeFile(path.join(racine, ".env"), "T=1");

    const d = await relais.appelerOutil(cfgMaison, "relais_deposer", { chemin: "rapport.bin", destinataire: "poste" });
    assert(!d.erreur && d.texte.includes(createHash("sha256").update(contenu).digest("hex")), `dépôt : ${d.texte}`);
    assert(boites.poste.get("rapport.bin")?.contenu.equals(contenu), "contenu identique côté broker");

    const s = await relais.appelerOutil(cfgMaison, "relais_deposer", { chemin: ".env", destinataire: "poste" });
    assert(s.erreur && /secret/.test(s.texte), "un .env ne part pas");
    const h = await relais.appelerOutil(cfgMaison, "relais_deposer", { chemin: "../../etc/hostname", destinataire: "poste" });
    assert(h.erreur && /(hors du projet|introuvable)/.test(h.texte), `hors racine : ${h.texte}`);

    const l = await relais.appelerOutil(cfgPoste, "relais_lister", {});
    assert(l.texte.includes('nom="rapport.bin"') && l.texte.includes('de "maison"'), `liste (noms cités comme données) : ${l.texte}`);

    const r1 = await relais.appelerOutil(cfgPoste, "relais_recuperer", { nom: "rapport.bin" });
    const r2 = await relais.appelerOutil(cfgPoste, "relais_recuperer", { nom: "../rapport.bin" });
    assert(/DONNÉE/.test(r1.texte), "rappel : donnée, pas consigne");
    const recus = (await fsp.readdir(path.join(racine, relais.DOSSIER_RECU))).sort();
    assert(JSON.stringify(recus) === JSON.stringify(["rapport-1.bin", "rapport.bin"]), `pas d'écrasement : ${recus} / ${r2.texte}`);
    assert((await fsp.readFile(path.join(racine, relais.DOSSIER_RECU, "rapport.bin"))).equals(contenu), "reçu à l'identique");

    const x = await relais.appelerOutil(cfgPoste, "relais_supprimer", { nom: "rapport.bin" });
    assert(!x.erreur && !boites.poste.has("rapport.bin"), "supprimé");

    const mauvais = relais.lireConfig({ RELAIS_URL: url, RELAIS_JETON: "faux", RELAIS_RACINE: racine });
    const refus = await relais.appelerOutil(mauvais, "relais_lister", {});
    assert(refus.erreur && /jeton refusé/.test(refus.texte) && !refus.texte.includes("faux"), `jeton refusé : ${refus.texte}`);

    // De bout en bout : le vrai serveur, par stdio.
    const serveurMcp = path.join(path.dirname(entry), "relaisServeur.js");
    const enfant = spawn(process.execPath, [serveurMcp], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RELAIS_URL: url, RELAIS_JETON: "jeton-maison", RELAIS_RACINE: racine },
    });
    const reponses = [];
    createInterface({ input: enfant.stdout }).on("line", (ligne) => reponses.push(JSON.parse(ligne)));
    const ecrire = (o) => enfant.stdin.write(JSON.stringify(o) + "\n");
    ecrire({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
    ecrire({ jsonrpc: "2.0", method: "notifications/initialized" });
    ecrire({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    ecrire({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "relais_lister", arguments: {} } });
    for (let i = 0; i < 100 && reponses.length < 3; i++) await new Promise((r) => setTimeout(r, 30));
    enfant.kill();
    const parId = Object.fromEntries(reponses.map((r) => [r.id, r]));
    assert(parId[1]?.result?.serverInfo?.name === "relais" && /donnée/.test(parId[1].result.instructions), "initialize");
    const noms = parId[2]?.result?.tools?.map((t) => t.name) ?? [];
    assert(JSON.stringify(noms) === JSON.stringify(["relais_lister", "relais_deposer", "relais_recuperer", "relais_supprimer"]), `outils : ${noms}`);
    assert(/Boîte de "maison"/.test(parId[3]?.result?.content?.[0]?.text ?? ""), `appel : ${JSON.stringify(parId[3])}`);
  } finally {
    serveur.close();
  }
}

async function testRelaisReseau() {
  assert(relaisHttp.controlerAdresse(new URL("http://exemple.net/")) !== null, "http distant refusé");
  assert(relaisHttp.controlerAdresse(new URL("http://127.0.0.1:9/")) === null, "http boucle locale permis");
  assert(relaisHttp.controlerAdresse(new URL("https://exemple.net/")) === null, "https permis");
  const env = { HTTPS_PROXY: "http://proxy.exemple.net:3128", NO_PROXY: "interne.exemple.net,.voisin.exemple.fr" };
  assert(relaisHttp.proxyPour(new URL("https://relais.exemple.net/"), env)?.host === "proxy.exemple.net:3128", "proxy suivi");
  assert(relaisHttp.proxyPour(new URL("https://a.interne.exemple.net/"), env) === null, "NO_PROXY respecté (suffixe)");
  assert(relaisHttp.proxyPour(new URL("https://x.voisin.exemple.fr/"), env) === null, "NO_PROXY respecté (point)");
  assert(relaisHttp.proxyPour(new URL("https://127.0.0.1/"), env) === null, "boucle locale sans proxy");
  const m = relaisHttp.corpsMultipart('a"b.txt', Buffer.from("x"));
  assert(m.type.startsWith("multipart/form-data; boundary=") && m.corps.toString().includes('filename="a_b.txt"'), "multipart");
}

async function testIntegres() {
  const r = integres.resoudreIntegres({ command: "${IACTION:node}", args: ["${IACTION:relais}"], env: { R: "${IACTION:projet}", S: "${SECRET:x}" } }, "/p");
  assert(r.command === process.execPath, "node embarqué");
  assert(r.args[0].endsWith("relaisServeur.js"), `serveur relais : ${r.args[0]}`);
  assert(r.env.R === "/p" && r.env.S === "${SECRET:x}", "projet résolu, secrets laissés à leur module");
}

await lancer(
  "Coffre de secrets, lot 2 — côté sidecar",
  testReglesFichiers,
  testGarde,
  testSecretsLister,
  testSansFenetre,
  testEnv,
  testMigrerEnvBoutEnBout,
  testSecretsDesTaches,
  testRelais,
  testRelaisReseau,
  testIntegres,
);
