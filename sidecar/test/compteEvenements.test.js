/*
 * T-191 — `events.jsonl` distingue les comptes Claude.
 *
 * `compte` est écrit seulement hors `perso` (même convention que
 * `claude-windows.jsonl`) ; usage.stats, le plafond de débord et la baseline
 * ne comptent qu'un compte à la fois — `perso` par défaut.
 *
 * Lancement isolé : node sidecar/test/compteEvenements.test.js
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { lancer, assert, moduleCompile, defaultXdgConfigHome, makeEmitterCollector } from "./harness.mjs";

const { recordUsageEvent, autoDebordCostUsdThisMonth, handleUsageStats } = await import(moduleCompile("usageStats.js"));
const { metaAvecCompte } = await import(moduleCompile("compteClaude.js"));
const { flushWrites } = await import(moduleCompile("jsonlStore.js"));

const racine = path.join(defaultXdgConfigHome, "net.duvam.iaction", "usage");
const fichier = path.join(racine, "events.jsonl");

async function lireEvenements() {
  await flushWrites();
  const texte = await fsp.readFile(fichier, "utf8").catch(() => "");
  return texte.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const evenement = (extra) => ({
  ts: new Date().toISOString(),
  engine: "claude",
  method: "claude.start",
  promptTokens: 10,
  completionTokens: 5,
  status: "done",
  ...extra,
});

async function stats(params) {
  const { emitter, waitFor } = makeEmitterCollector();
  await handleUsageStats("s", params, emitter);
  return waitFor((e) => e.id === "s");
}

await lancer(
  "compte dans events.jsonl (T-191)",
  async () => {
    await fsp.rm(racine, { recursive: true, force: true });
    recordUsageEvent({ id: "a", engine: "claude", method: "claude.start", status: "done", meta: metaAvecCompte({ source: "chat" }, "perso") });
    recordUsageEvent({ id: "b", engine: "claude", method: "claude.start", status: "done", meta: metaAvecCompte({ source: "chat" }, "teams") });
    recordUsageEvent({ id: "c", engine: "claude", method: "claude.start", status: "done", meta: { compte: "inconnu" } });
    const evs = await lireEvenements();
    assert(evs.length === 3, `3 événements attendus, reçu ${evs.length}`);
    assert(!("compte" in evs[0]), "perso : aucun champ compte (forme d'avant, à l'octet près)");
    assert(evs[1].compte === "teams", `teams : champ compte attendu, reçu ${JSON.stringify(evs[1])}`);
    assert(!("compte" in evs[2]), "compte inconnu : ignoré");
    assert(evs[1].source === "chat", "le reste du meta est conservé");
  },
  async () => {
    const m = { source: "chat" };
    assert(metaAvecCompte(m, "perso") === m, "perso : meta rendu tel quel");
    assert(metaAvecCompte(undefined, "teams").compte === "teams", "meta absent + teams");
    assert(metaAvecCompte([1], "teams").compte === "teams", "meta non objet + teams");
  },
  async () => {
    await fsp.rm(racine, { recursive: true, force: true });
    await fsp.mkdir(racine, { recursive: true });
    const lignes = [
      evenement({ routeDebord: true, costUsd: 1.5 }),
      evenement({ routeDebord: true, costUsd: 4, compte: "teams" }),
    ];
    await fsp.writeFile(fichier, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const depense = await autoDebordCostUsdThisMonth();
    assert(depense === 1.5, `le plafond ne compte que perso : attendu 1.5, reçu ${depense}`);
  },
  async () => {
    const lignes = [
      evenement({ ts: new Date().toISOString() }),
      evenement({ compte: "teams" }),
      evenement({ compte: "teams" }),
    ];
    await fsp.writeFile(fichier, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const defaut = await stats({});
    assert(defaut.kind === "done" && defaut.data.totals.tours === 1, `défaut = perso (1 tour), reçu ${JSON.stringify(defaut.data.totals ?? defaut.data)}`);
    const teams = await stats({ compte: "teams" });
    assert(teams.data.totals.tours === 2, `teams : 2 tours attendus, reçu ${teams.data.totals.tours}`);
    const perso = await stats({ compte: "perso" });
    assert(perso.data.totals.tours === 1, "perso explicite : 1 tour");
    const inconnu = await stats({ compte: "x" });
    assert(inconnu.kind === "error" && inconnu.data.message.includes("compte"), `compte inconnu refusé : ${JSON.stringify(inconnu)}`);
  },
  async () => {
    // scripts/usage-baseline.mjs : les événements d'un autre compte ne comptent pas.
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "usage-baseline.mjs");
    const lignes = [evenement(), evenement({ compte: "teams" }), evenement({ compte: "teams" }), evenement({ compte: "teams" })];
    await fsp.writeFile(fichier, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const { stdout } = await promisify(execFile)(process.execPath, [script, "--days=1"], {
      env: { ...process.env, XDG_CONFIG_HOME: defaultXdgConfigHome },
    });
    assert(/^1 tours analysés/m.test(stdout), `baseline : 1 tour attendu (perso seul)\n${stdout.slice(0, 600)}`);
  },
);
