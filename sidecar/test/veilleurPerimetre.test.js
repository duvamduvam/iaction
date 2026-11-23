/*
 * Périmètre RÉEL d'un tour du veilleur (T-227, I6/I8/I5) : ce que claude.ts
 * passe au SDK pour `veilleur: true`, lu par un faux moteur qui renvoie ses
 * options (fakeClaudeOptions.mjs) — contre un vrai sidecar.
 *   - ni Claude in Chrome (`extraArgs`), ni réglages du poste (`settingSources`
 *     sans `user`), MCP strict (`strictMcpConfig`) ;
 *   - plafond de coût au moteur (`maxBudgetUsd`) ;
 *   - crochet : écriture de `.mcp.json` refusée.
 * Et, pour comparer, un tour projet ordinaire garde tout cela.
 *
 * Lancement isolé : node sidecar/test/veilleurPerimetre.test.js
 */

import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import { assert, dossierTest, entry, lancer } from "./harness.mjs";

async function unTour(params) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, IACTION_FAKE_CLAUDE: "1", IACTION_FAKE_CLAUDE_MODULE: path.join(dossierTest, "fakeClaudeOptions.mjs") },
  });
  try {
    const fin = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout claude.start")), 8000);
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (ligne) => {
        if (!ligne.trim()) return;
        const evt = JSON.parse(ligne);
        if (evt.event === "ready") child.stdin.write(`${JSON.stringify({ id: "t1", method: "claude.start", params })}\n`);
        if (evt.id === "t1" && (evt.event === "done" || evt.event === "error")) {
          clearTimeout(t);
          resolve(evt);
        }
      });
    });
    const evt = await fin;
    assert(evt.event === "done", `done attendu (reçu ${JSON.stringify(evt.data)})`);
    return JSON.parse(evt.data.result);
  } finally {
    child.kill();
  }
}

async function testVeilleur() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-perimetre-"));
  const vu = await unTour({ cwd, prompt: "x", chatOnly: false, veilleur: true, mcp: false, maxBudgetUsd: 5, permissionMode: "bypassPermissions" });
  assert(JSON.stringify(vu.settingSources) === JSON.stringify(["project", "local"]), `pas de réglages du poste (reçu ${vu.settingSources})`);
  assert(vu.strictMcpConfig === true, "MCP strict");
  assert(JSON.stringify(vu.extraArgs) === JSON.stringify({ "no-chrome": null }), `navigateur éteint par --no-chrome (reçu ${JSON.stringify(vu.extraArgs)})`);
  assert(vu.cfc === "0", `CLAUDE_CODE_ENABLE_CFC=0 dans l'environnement du tour (reçu ${vu.cfc})`);
  assert(vu.maxBudgetUsd === 5, "plafond de coût au moteur");
  assert(vu.decisionMcp === "deny", `écriture de .mcp.json refusée (reçu ${vu.decisionMcp})`);
}

async function testTourOrdinaire() {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "veilleur-perimetre-"));
  const vu = await unTour({ cwd, prompt: "x", chatOnly: false });
  assert(vu.settingSources.includes("user"), "tour ordinaire : réglages du poste");
  assert(vu.strictMcpConfig === null && vu.extraArgs && "chrome" in vu.extraArgs && vu.cfc !== "0", "tour ordinaire : navigateur, MCP non strict");
  assert(vu.maxBudgetUsd === null, "pas de budget sans demande");
  assert(vu.decisionMcp === "allow", "tour ordinaire : .mcp.json écrivable");
}

await lancer("périmètre du tour du veilleur", testVeilleur, testTourOrdinaire);
