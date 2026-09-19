/*
 * MCP — catalogue de connecteurs et coffre de secrets
 * (mcp.catalog, mcp.add, mcp.remove, mcp.secrets, mcp.secretSet, mcp.secretDelete)
 *
 * T-058 — ces six méthodes dispatchées par sidecar/src/index.ts n'avaient
 * AUCUN test de bout en bout (mcp.test.js couvre mcp.status/mcp.setServer et
 * le SUPPORT MCP de claude.start, mais jamais ces six-là). Vrai sidecar en
 * sous-processus, comme mcp.test.js voisin.
 *
 * Lancement isolé : node sidecar/test/mcpCatalogueEtSecrets.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, entry, fail } from "./harness.mjs";

/**
 * Lance un sidecar isolé (XDG_CONFIG_HOME jetable, propre à ce test — le
 * coffre de secrets en dépend) et rend les mêmes utilitaires send/waitFor que
 * les autres fichiers de la suite.
 */
async function spawnSidecar(xdgDir) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_CONFIG_HOME: xdgDir },
  });
  const received = [];
  const waiters = [];
  function notify(evt) {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.predicate(evt)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(evt);
      }
    }
  }
  function waitFor(predicate, timeoutMs = 3000, label = "événement") {
    const existing = received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => {
        const idx = waiters.indexOf(w);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error(`timeout en attendant ${label}`));
      }, timeoutMs);
      waiters.push(w);
    });
  }
  const stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutRl.on("line", (line) => {
    if (line.trim().length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`stdout du sidecar (mcp catalogue/secrets) a émis une ligne non-JSON: ${line}`);
      return;
    }
    received.push(parsed);
    notify(parsed);
  });
  const stderrChunks = [];
  child.stderr.on("data", (d) => stderrChunks.push(d.toString()));
  function send(obj) {
    child.stdin.write(JSON.stringify(obj) + "\n");
  }
  await waitFor((e) => e.event === "ready", 3000, "ready");
  return { child, send, waitFor, stderrChunks };
}

/**
 * mcp.catalog — connecteurs proposés (imap, airtable, http). Méthode SANS
 * paramètre et sans branche d'échec dans handleMcpCatalog (sidecar/src/mcpCatalog.ts) :
 * elle sert une constante en mémoire, il n'existe aucune entrée invalide à
 * lui fournir. Un seul cas est donc significatif — le nominal — documenté
 * comme tel plutôt que de fabriquer une erreur que le code ne produit pas.
 */
async function testMcpCatalog() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcpcat-xdg-"));
  const { child, send, waitFor, stderrChunks } = await spawnSidecar(xdgDir);
  try {
    send({ id: "cat1", method: "mcp.catalog", params: {} });
    const doneCat1 = await waitFor(
      (e) => e.id === "cat1" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.catalog cat1",
    );
    assert(doneCat1.event === "done", `cat1 attendu 'done', reçu '${doneCat1.event}': ${JSON.stringify(doneCat1.data)}`);
    const ids = doneCat1.data.entries.map((e) => e.id).sort();
    assert(
      JSON.stringify(ids) === JSON.stringify(["airtable", "http", "imap"]),
      `cat1 : connecteurs attendus imap/airtable/http, reçu ${JSON.stringify(ids)}`,
    );
    const imap = doneCat1.data.entries.find((e) => e.id === "imap");
    assert(
      imap.fields.some((f) => f.key === "password" && f.secret === true && f.required === true),
      `cat1 : le champ 'password' de 'imap' doit être marqué secret+requis, reçu ${JSON.stringify(imap.fields)}`,
    );
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr (mcp.catalog) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * mcp.add / mcp.remove — écriture/retrait d'une entrée `<cwd>/.mcp.json`
 * depuis le catalogue, secrets déportés au coffre.
 */
async function testMcpAddRemove() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcpaddrm-xdg-"));
  const { child, send, waitFor, stderrChunks } = await spawnSidecar(xdgDir);
  let tmpProject = null;
  try {
    tmpProject = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcpaddrm-project-"));

    // 1. mcp.add nominal (connecteur 'http', pas de champ secret rempli) : le
    // header Authorization (gabarit non substitué) doit disparaître.
    send({
      id: "add1",
      method: "mcp.add",
      params: { cwd: tmpProject, entryId: "http", name: "distant1", values: { url: "https://exemple.net/mcp" } },
    });
    const doneAdd1 = await waitFor(
      (e) => e.id === "add1" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.add add1",
    );
    assert(doneAdd1.event === "done", `add1 attendu 'done', reçu '${doneAdd1.event}': ${JSON.stringify(doneAdd1.data)}`);
    assert(
      doneAdd1.data.name === "distant1" && doneAdd1.data.added === true,
      `add1 réponse inattendue: ${JSON.stringify(doneAdd1.data)}`,
    );
    let mcpJson = JSON.parse(await fsp.readFile(path.join(tmpProject, ".mcp.json"), "utf8"));
    assert(
      mcpJson.mcpServers.distant1.url === "https://exemple.net/mcp" &&
        Object.keys(mcpJson.mcpServers.distant1.headers ?? {}).length === 0,
      `add1 : .mcp.json doit porter l'URL et omettre le header Authorization non rempli, reçu ${JSON.stringify(mcpJson.mcpServers.distant1)}`,
    );

    // 2. mcp.add nominal, connecteur avec un champ SECRET (imap.password) :
    // le fichier projet ne porte qu'une référence, la valeur va au coffre.
    send({
      id: "add2",
      method: "mcp.add",
      params: {
        cwd: tmpProject,
        entryId: "imap",
        name: "mabox",
        values: { server: "imap.exemple.net", user: "moi@exemple.net", password: "correct-horse-battery" },
      },
    });
    const doneAdd2 = await waitFor(
      (e) => e.id === "add2" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.add add2",
    );
    assert(doneAdd2.event === "done", `add2 attendu 'done', reçu '${doneAdd2.event}': ${JSON.stringify(doneAdd2.data)}`);
    mcpJson = JSON.parse(await fsp.readFile(path.join(tmpProject, ".mcp.json"), "utf8"));
    assert(
      mcpJson.mcpServers.mabox.env.MCP_IMAP_PASSWORD === "${SECRET:mabox.password}",
      `add2 : le mot de passe doit être remplacé par une référence \${SECRET:...}, reçu ${JSON.stringify(mcpJson.mcpServers.mabox.env)}`,
    );
    const coffre = JSON.parse(await fsp.readFile(path.join(xdgDir, "net.duvam.iaction", "mcp-secrets.json"), "utf8"));
    assert(
      coffre["mabox.password"] === "correct-horse-battery",
      `add2 : la valeur réelle doit être au coffre, reçu ${JSON.stringify(Object.keys(coffre))}`,
    );

    // 3. mcp.add erreur : connecteur inconnu.
    send({ id: "add3", method: "mcp.add", params: { cwd: tmpProject, entryId: "inexistant" } });
    const errAdd3 = await waitFor((e) => e.id === "add3" && e.event === "error", 3000, "mcp.add add3 (connecteur inconnu)");
    assert(errAdd3.data.message.includes("connecteur inconnu"), `add3 message inattendu: ${errAdd3.data.message}`);

    // 4. mcp.add erreur : cwd manquant.
    send({ id: "add4", method: "mcp.add", params: { entryId: "http" } });
    const errAdd4 = await waitFor((e) => e.id === "add4" && e.event === "error", 3000, "mcp.add add4 (cwd manquant)");
    assert(typeof errAdd4.data.message === "string" && errAdd4.data.message.length > 0, "add4 doit renvoyer une erreur");

    // 5. mcp.add erreur : champ requis manquant (url absente pour 'http').
    send({ id: "add5", method: "mcp.add", params: { cwd: tmpProject, entryId: "http", name: "sansurl" } });
    const errAdd5 = await waitFor((e) => e.id === "add5" && e.event === "error", 3000, "mcp.add add5 (champ requis manquant)");
    assert(errAdd5.data.message.includes("URL"), `add5 message inattendu: ${errAdd5.data.message}`);

    // 6. mcp.add erreur : .mcp.json existant mais illisible -> refus, rien n'est écrasé.
    const tmpBroken = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcpaddrm-broken-"));
    await fsp.writeFile(path.join(tmpBroken, ".mcp.json"), "{ pas du json valide", "utf8");
    send({
      id: "add6",
      method: "mcp.add",
      params: { cwd: tmpBroken, entryId: "http", name: "x", values: { url: "https://x/mcp" } },
    });
    const errAdd6 = await waitFor((e) => e.id === "add6" && e.event === "error", 3000, "mcp.add add6 (.mcp.json illisible)");
    assert(errAdd6.data.message.includes("illisible"), `add6 message inattendu: ${errAdd6.data.message}`);
    const brokenUntouched = await fsp.readFile(path.join(tmpBroken, ".mcp.json"), "utf8");
    assert(brokenUntouched === "{ pas du json valide", "add6 : le fichier illisible ne doit pas être écrasé");
    await fsp.rm(tmpBroken, { recursive: true, force: true }).catch(() => {});

    // 7. mcp.remove nominal : l'entrée disparaît, le secret RESTE au coffre.
    send({ id: "rm1", method: "mcp.remove", params: { cwd: tmpProject, name: "mabox" } });
    const doneRm1 = await waitFor(
      (e) => e.id === "rm1" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.remove rm1",
    );
    assert(doneRm1.event === "done", `rm1 attendu 'done', reçu '${doneRm1.event}': ${JSON.stringify(doneRm1.data)}`);
    assert(
      doneRm1.data.name === "mabox" && doneRm1.data.removed === true,
      `rm1 réponse inattendue: ${JSON.stringify(doneRm1.data)}`,
    );
    mcpJson = JSON.parse(await fsp.readFile(path.join(tmpProject, ".mcp.json"), "utf8"));
    assert(!("mabox" in mcpJson.mcpServers), "rm1 : l'entrée 'mabox' doit avoir disparu de .mcp.json");
    const coffreApres = JSON.parse(await fsp.readFile(path.join(xdgDir, "net.duvam.iaction", "mcp-secrets.json"), "utf8"));
    assert(
      coffreApres["mabox.password"] === "correct-horse-battery",
      "rm1 : le secret doit rester au coffre après le retrait du connecteur",
    );

    // 8. mcp.remove erreur : serveur inconnu.
    send({ id: "rm2", method: "mcp.remove", params: { cwd: tmpProject, name: "jamais-ajoute" } });
    const errRm2 = await waitFor((e) => e.id === "rm2" && e.event === "error", 3000, "mcp.remove rm2 (serveur inconnu)");
    assert(errRm2.data.message.includes("serveur inconnu"), `rm2 message inattendu: ${errRm2.data.message}`);

    // 9. mcp.remove erreur : name manquant.
    send({ id: "rm3", method: "mcp.remove", params: { cwd: tmpProject } });
    const errRm3 = await waitFor((e) => e.id === "rm3" && e.event === "error", 3000, "mcp.remove rm3 (name manquant)");
    assert(typeof errRm3.data.message === "string" && errRm3.data.message.length > 0, "rm3 doit renvoyer une erreur");

    // 10. mcp.remove erreur : aucun .mcp.json dans le projet.
    const tmpSansMcp = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcpaddrm-sansmcp-"));
    send({ id: "rm4", method: "mcp.remove", params: { cwd: tmpSansMcp, name: "peu-importe" } });
    const errRm4 = await waitFor((e) => e.id === "rm4" && e.event === "error", 3000, "mcp.remove rm4 (aucun .mcp.json)");
    assert(errRm4.data.message.includes("aucun .mcp.json"), `rm4 message inattendu: ${errRm4.data.message}`);
    await fsp.rm(tmpSansMcp, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr (mcp.add/mcp.remove) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    if (tmpProject) await fsp.rm(tmpProject, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * mcp.secrets / mcp.secretSet / mcp.secretDelete — coffre local
 * (`<config>/mcp-secrets.json`, 0600). Contrat : jamais la valeur d'un secret
 * ne ressort par mcp.secrets (seuls les noms).
 */
async function testMcpSecrets() {
  const xdgDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-mcpsecrets-xdg-"));
  const { child, send, waitFor, stderrChunks } = await spawnSidecar(xdgDir);
  try {
    // 1. mcp.secretSet nominal.
    send({ id: "set1", method: "mcp.secretSet", params: { name: "serveur.jeton", value: "valeur-tres-secrete" } });
    const doneSet1 = await waitFor(
      (e) => e.id === "set1" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.secretSet set1",
    );
    assert(doneSet1.event === "done", `set1 attendu 'done', reçu '${doneSet1.event}': ${JSON.stringify(doneSet1.data)}`);
    assert(
      doneSet1.data.name === "serveur.jeton" && doneSet1.data.saved === true,
      `set1 réponse inattendue: ${JSON.stringify(doneSet1.data)}`,
    );
    const coffrePath = path.join(xdgDir, "net.duvam.iaction", "mcp-secrets.json");
    const stat1 = await fsp.stat(coffrePath);
    /*
     * T-134 — le mode POSIX n'a de sens que sur POSIX. Windows ignore
     * `mode: 0o600` et rend 666 : le code de production le sait déjà (son
     * `chmod` est suivi d'un `.catch()`), mais ce test, écrit après la
     * dernière release, n'avait jamais tourné sur un runner Windows — il y a
     * fait tomber la construction de la 0.6.0. On garde l'exigence ENTIÈRE là
     * où elle s'applique, et on dit ce qui la remplace ailleurs plutôt que de
     * sauter en silence : sur Windows la confidentialité du coffre repose sur
     * les ACL du profil utilisateur (`%APPDATA%`), pas sur un mode.
     */
    if (process.platform === "win32") {
      assert(stat1.isFile(), "set1 : le coffre doit exister (mode POSIX non applicable sur Windows)");
      console.log("   (Windows : vérification du mode 0600 sans objet, ACL du profil à la place)");
    } else {
      assert(
        (stat1.mode & 0o777) === 0o600,
        `set1 : le coffre doit être en mode 0600, reçu ${(stat1.mode & 0o777).toString(8)}`,
      );
    }

    // 2. mcp.secretSet erreur : name invalide (caractère interdit).
    send({ id: "set2", method: "mcp.secretSet", params: { name: "nom invalide!", value: "x" } });
    const errSet2 = await waitFor((e) => e.id === "set2" && e.event === "error", 3000, "mcp.secretSet set2 (name invalide)");
    assert(typeof errSet2.data.message === "string" && errSet2.data.message.length > 0, "set2 doit renvoyer une erreur");

    // 3. mcp.secretSet erreur : value manquante.
    send({ id: "set3", method: "mcp.secretSet", params: { name: "autre.nom" } });
    const errSet3 = await waitFor((e) => e.id === "set3" && e.event === "error", 3000, "mcp.secretSet set3 (value manquante)");
    assert(typeof errSet3.data.message === "string" && errSet3.data.message.length > 0, "set3 doit renvoyer une erreur");

    // 4. mcp.secrets nominal : liste les NOMS, jamais les valeurs.
    send({ id: "list1", method: "mcp.secretSet", params: { name: "second.jeton", value: "autre-valeur-secrete" } });
    await waitFor((e) => e.id === "list1" && (e.event === "done" || e.event === "error"), 3000, "mcp.secretSet list1");
    send({ id: "list2", method: "mcp.secrets", params: {} });
    const doneList2 = await waitFor(
      (e) => e.id === "list2" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.secrets list2",
    );
    assert(doneList2.event === "done", `list2 attendu 'done', reçu '${doneList2.event}'`);
    assert(
      JSON.stringify(doneList2.data.names) === JSON.stringify(["second.jeton", "serveur.jeton"]),
      `list2 : noms attendus triés, reçu ${JSON.stringify(doneList2.data.names)}`,
    );
    const payload = JSON.stringify(doneList2.data);
    assert(
      !payload.includes("valeur-tres-secrete") && !payload.includes("autre-valeur-secrete"),
      "list2 : mcp.secrets ne doit JAMAIS renvoyer la valeur d'un secret",
    );

    // 5. mcp.secretDelete nominal : le secret disparaît du coffre.
    send({ id: "del1", method: "mcp.secretDelete", params: { name: "serveur.jeton" } });
    const doneDel1 = await waitFor(
      (e) => e.id === "del1" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.secretDelete del1",
    );
    assert(doneDel1.event === "done", `del1 attendu 'done', reçu '${doneDel1.event}': ${JSON.stringify(doneDel1.data)}`);
    assert(
      doneDel1.data.name === "serveur.jeton" && doneDel1.data.removed === true,
      `del1 réponse inattendue: ${JSON.stringify(doneDel1.data)}`,
    );
    const coffreApres = JSON.parse(await fsp.readFile(coffrePath, "utf8"));
    assert(!("serveur.jeton" in coffreApres), "del1 : le secret doit avoir disparu du coffre");

    // 6. mcp.secretDelete non-nominal documenté : secret déjà absent -> done{removed:false} (pas d'erreur).
    send({ id: "del2", method: "mcp.secretDelete", params: { name: "jamais-existe" } });
    const doneDel2 = await waitFor(
      (e) => e.id === "del2" && (e.event === "done" || e.event === "error"),
      3000,
      "mcp.secretDelete del2 (absent)",
    );
    assert(
      doneDel2.event === "done" && doneDel2.data.removed === false,
      `del2 sur un secret absent doit répondre removed:false, reçu ${JSON.stringify(doneDel2.data ?? doneDel2)}`,
    );

    // 7. mcp.secretDelete erreur : name manquant.
    send({ id: "del3", method: "mcp.secretDelete", params: {} });
    const errDel3 = await waitFor((e) => e.id === "del3" && e.event === "error", 3000, "mcp.secretDelete del3 (name manquant)");
    assert(typeof errDel3.data.message === "string" && errDel3.data.message.length > 0, "del3 doit renvoyer une erreur");
  } catch (err) {
    if (stderrChunks.length > 0) {
      console.error("--- stderr (mcp.secrets/secretSet/secretDelete) ---");
      console.error(stderrChunks.join(""));
    }
    throw err;
  } finally {
    if (child.exitCode === null) child.kill();
    await fsp.rm(xdgDir, { recursive: true, force: true }).catch(() => {});
  }
}

await lancer(
  "MCP — catalogue de connecteurs et coffre de secrets",
  testMcpCatalog,
  testMcpAddRemove,
  testMcpSecrets,
);
