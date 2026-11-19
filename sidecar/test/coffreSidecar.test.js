/*
 * Coffre de secrets — côté sidecar (docs/etude-coffre-secrets.md § 4.2, § 4.3)
 *
 * - `coffre.charger` : la table poussée par la coquille sert les tours, sans
 *   jamais toucher le disque ; la réponse ne porte ni nom ni valeur ;
 * - coffre ouvert : `mcp.secretSet` part à la coquille (`coffre:ecrire`), pas
 *   dans `mcp-secrets.json` ;
 * - coffre verrouillé : écriture refusée, serveur MCP écarté AVEC la cause ;
 * - `coffre.attendreFin` et le compteur de tours (toursActifs.ts).
 *
 * Vrai sidecar en sous-processus (XDG_CONFIG_HOME jetable).
 * Lancement isolé : node sidecar/test/coffreSidecar.test.js
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, entry, moduleCompile } from "./harness.mjs";

const VALEUR = "jeton-du-coffre-tres-secret-42";

async function spawnSidecar(xdgDir) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_CONFIG_HOME: xdgDir },
  });
  const received = [];
  const waiters = [];
  const lignes = [];
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    lignes.push(line);
    const evt = JSON.parse(line);
    received.push(evt);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(evt)) {
        clearTimeout(waiters[i].timer);
        waiters.splice(i, 1)[0].resolve(evt);
      }
    }
  });
  const stderr = [];
  child.stderr.on("data", (d) => stderr.push(d.toString()));
  function waitFor(predicate, label, timeoutMs = 3000) {
    const deja = received.find(predicate);
    if (deja) return Promise.resolve(deja);
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve };
      w.timer = setTimeout(() => reject(new Error(`timeout : ${label}`)), timeoutMs);
      waiters.push(w);
    });
  }
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const fin = (id) => waitFor((e) => e.id === id && (e.event === "done" || e.event === "error"), id);
  await waitFor((e) => e.event === "ready", "ready");
  return { child, send, waitFor, fin, lignes, stderr };
}

async function avecSidecar(nom, corps) {
  const xdg = await fsp.mkdtemp(path.join(os.tmpdir(), `iaction-coffre-${nom}-`));
  const s = await spawnSidecar(xdg);
  try {
    await corps(s, xdg);
  } catch (err) {
    if (s.stderr.length > 0) console.error(s.stderr.join(""));
    throw err;
  } finally {
    if (s.child.exitCode === null) s.child.kill();
    await fsp.rm(xdg, { recursive: true, force: true }).catch(() => {});
  }
}

async function testCoffreOuvert() {
  await avecSidecar("ouvert", async ({ send, fin, waitFor, lignes }, xdg) => {
    send({ id: "c1", method: "coffre.charger", params: { etat: "ouvert", secrets: { "relais.token": VALEUR } } });
    const c1 = await fin("c1");
    assert(c1.event === "done" && c1.data.secrets === 1, `c1 : ${JSON.stringify(c1)}`);
    assert(!JSON.stringify(c1).includes("relais.token"), "la réponse de coffre.charger ne cite aucun nom");

    send({ id: "l1", method: "mcp.secrets", params: {} });
    const l1 = await fin("l1");
    assert(l1.data.coffre === "ouvert", `l1.coffre : ${l1.data.coffre}`);
    assert(l1.data.names.includes("relais.token"), "le nom du coffre est listé");

    send({ id: "s1", method: "mcp.secretSet", params: { name: "autre.token", value: "valeur-posee" } });
    const ecrire = await waitFor((e) => e.event === "coffre:ecrire", "coffre:ecrire");
    assert(ecrire.data.nom === "autre.token" && ecrire.data.valeur === "valeur-posee", "demande d'écriture à la coquille");
    assert(typeof ecrire.data.demande === "string", "la demande porte un identifiant d'accusé");
    // Pas d'accusé, pas de succès : s1 attend.
    await new Promise((r) => setTimeout(r, 150));
    assert(!lignes.some((l) => l.includes('"id":"s1"')), "sans accusé de la coquille, mcp.secretSet ne répond pas « enregistré »");
    send({ id: "coffre-ecrit-1", method: "coffre.ecrit", params: { demande: ecrire.data.demande, ok: true } });
    const s1 = await fin("s1");
    assert(s1.event === "done", `s1 : ${JSON.stringify(s1)}`);

    // Échec d'écriture côté coquille : l'erreur remonte, rien n'est « enregistré ».
    send({ id: "s2", method: "mcp.secretSet", params: { name: "rate.token", value: "valeur-ratee" } });
    const ecrire2 = await waitFor((e) => e.event === "coffre:ecrire" && e.data.nom === "rate.token", "coffre:ecrire 2");
    send({ id: "coffre-ecrit-2", method: "coffre.ecrit", params: { demande: ecrire2.data.demande, ok: false, erreur: "disque plein" } });
    const s2 = await fin("s2");
    assert(s2.event === "error" && /disque plein/.test(s2.data.message), `s2 : ${JSON.stringify(s2)}`);
    send({ id: "l2", method: "mcp.secrets", params: {} });
    assert(!(await fin("l2")).data.names.includes("rate.token"), "un secret refusé par la coquille n'est pas servi");
    const fichier = path.join(xdg, "net.duvam.iaction", "mcp-secrets.json");
    assert(await fsp.stat(path.dirname(fichier)).then(() => true, () => false), "dossier de config du test introuvable");
    const existe = await fsp.stat(fichier).then(() => true, () => false);
    assert(!existe, "coffre ouvert : rien n'est écrit dans mcp-secrets.json");

    send({ id: "d1", method: "mcp.secretDelete", params: { name: "autre.token" } });
    const retirer = await waitFor((e) => e.event === "coffre:retirer" && e.data.nom === "autre.token", "coffre:retirer");
    send({ id: "coffre-ecrit-3", method: "coffre.ecrit", params: { demande: retirer.data.demande, ok: true } });
    const d1 = await fin("d1");
    assert(d1.data.removed === true, `d1 : ${JSON.stringify(d1)}`);

    // Hors la demande d'écriture destinée à la coquille, aucune ligne ne porte la valeur.
    const fuites = lignes.filter((l) => l.includes(VALEUR));
    assert(fuites.length === 0, `valeur du coffre sur stdout : ${fuites.join(" | ")}`);
  });
}

async function testCoffreVerrouille() {
  await avecSidecar("verrouille", async ({ send, fin }, xdg) => {
    send({ id: "c1", method: "coffre.charger", params: { etat: "ouvert", secrets: { "relais.token": VALEUR } } });
    await fin("c1");
    // Verrouillé, la coquille ne pousse que les secrets `sans-fenetre` (lot 2) :
    // le sidecar sert ce qu'on lui pousse, et rien de l'ancienne table.
    send({ id: "c2", method: "coffre.charger", params: { etat: "verrouille", secrets: { "fond.jeton": "v-fond" } } });
    const c2 = await fin("c2");
    assert(c2.data.secrets === 1, `verrouillé : seuls les sans-fenêtre poussés restent, reçu ${JSON.stringify(c2.data)}`);

    send({ id: "l1", method: "mcp.secrets", params: {} });
    const l1 = await fin("l1");
    assert(!l1.data.names.includes("relais.token"), "verrouillé : le secret du coffre n'est plus disponible");
    assert(l1.data.names.includes("fond.jeton"), "verrouillé : le secret sans fenêtre reste disponible");

    send({ id: "s1", method: "mcp.secretSet", params: { name: "x", value: "y" } });
    const s1 = await fin("s1");
    assert(s1.event === "error" && /coffre verrouillé/.test(s1.data.message), `s1 : ${JSON.stringify(s1)}`);

    send({ id: "c3", method: "coffre.charger", params: { etat: "n-importe" } });
    const c3 = await fin("c3");
    assert(c3.event === "error", "état inconnu refusé");

    // Serveur MCP qui attend un secret du coffre : écarté, cause dite.
    const { prepareMcpForTurn } = await import(moduleCompile("mcp.js"));
    const { chargerCoffre } = await import(moduleCompile("mcpSecrets.js"));
    const projet = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-coffre-projet-"));
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      await fsp.writeFile(
        path.join(projet, ".mcp.json"),
        JSON.stringify({ mcpServers: { relais: { command: "node", args: ["r.js"], env: { RELAIS_TOKEN: "${SECRET:relais.token}" } } } }),
      );
      chargerCoffre("verrouille", {});
      const ferme = await prepareMcpForTurn(projet);
      assert(ferme.missingSecrets.includes("relais") && ferme.coffreVerrouille === true, `fermé : ${JSON.stringify(ferme)}`);
      chargerCoffre("ouvert", { "relais.token": VALEUR });
      const ouvert = await prepareMcpForTurn(projet);
      assert(ouvert.missingSecrets.length === 0, "ouvert : le serveur part");
      assert(ouvert.servers.relais.env.RELAIS_TOKEN === VALEUR, "ouvert : le jeton est résolu depuis la table");
    } finally {
      await fsp.rm(projet, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function testAttendreFin() {
  const t = await import(moduleCompile("toursActifs.js"));
  t._reinitialiser();
  const evts = [];
  const emetteur = {
    chunk: (id, data) => evts.push(["chunk", data.tours]),
    done: (id, data) => evts.push(["done", data.tours]),
    error: () => evts.push(["error"]),
  };
  t.handleCoffreAttendreFin("a0", emetteur);
  assert(JSON.stringify(evts) === JSON.stringify([["done", 0]]), `sans tour : done immédiat, reçu ${JSON.stringify(evts)}`);

  evts.length = 0;
  t.ouvrirSiTour("t1", "claude.start");
  t.ouvrirSiTour("t2", "orch.run");
  t.ouvrirSiTour("p1", "mcp.status"); // pas un tour
  assert(t.nombreDeTours() === 2, "deux tours comptés");
  t.handleCoffreAttendreFin("a1", emetteur);
  t.fermer("t1");
  t.fermer("t1"); // double fin : sans effet
  t.fermer("t2");
  assert(
    JSON.stringify(evts) === JSON.stringify([["chunk", 2], ["chunk", 1], ["done", 0]]),
    `attente : ${JSON.stringify(evts)}`,
  );

  // De bout en bout : coffre.attendreFin sans tour en cours répond aussitôt.
  await avecSidecar("attente", async ({ send, fin }) => {
    send({ id: "coffre-attente-1", method: "coffre.attendreFin", params: {} });
    const a = await fin("coffre-attente-1");
    assert(a.event === "done" && a.data.tours === 0, `attendreFin : ${JSON.stringify(a)}`);
  });
}

await lancer("Coffre de secrets — côté sidecar", testCoffreOuvert, testCoffreVerrouille, testAttendreFin);
