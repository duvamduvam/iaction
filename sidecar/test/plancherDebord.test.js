/*
 * T-192 (suite) — le plancher anti-recul vaut aussi pour le DÉBORD.
 *
 * Le relevé servi à l'interface était protégé (plancherReleve.test.js) mais le
 * débord lisait l'historique brut : un relevé en retard (23 % puis 11 % dans la
 * même fenêtre) pouvait être le dernier lu. Le plancher est dérivé de l'historique
 * lui-même : il survit donc au redémarrage du sidecar (ici : relecture à froid).
 *
 * Lancement isolé : node sidecar/test/plancherDebord.test.js
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { lancer, assert, moduleCompile, defaultXdgConfigHome } from "./harness.mjs";

const fenetres = await import(moduleCompile("fenetresAbonnement.js"));
const { applyDebord, DEFAULT_DEBORD } = await import(moduleCompile("debord.js"));

const fichier = path.join(defaultXdgConfigHome, "net.duvam.iaction", "usage", "claude-windows.jsonl");
async function ecrire(lignes) {
  await fsp.mkdir(path.dirname(fichier), { recursive: true });
  await fsp.writeFile(fichier, lignes.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const iso = (msAvant) => new Date(Date.now() - msAvant).toISOString();
const RESET5 = "2026-11-08T20:50:00.000Z";
const RESET5_MICRO = "2026-11-08T20:50:00.268456+00:00";
const RESET5_SUIVANT = "2026-11-09T01:50:00.000Z";
const RESET7 = "2026-11-12T10:00:00.000Z";
const w = (p5, reset5, p7 = 10) => ({
  five_hour: { utilization: p5, resetsAt: reset5 },
  seven_day: { utilization: p7, resetsAt: RESET7 },
});

await lancer(
  "plancher du débord (T-192)",
  async () => {
    // 95 % puis un relevé en retard à 40 % dans la même fenêtre : le débord voit 95.
    await ecrire([
      { ts: iso(300_000), windows: w(95, RESET5) },
      { ts: iso(60_000), windows: w(40, RESET5_MICRO) },
    ]);
    const r = await fenetres.readLatestClaudeWindows();
    assert(r.fiveHourPct === 95, `plancher attendu 95, reçu ${r.fiveHourPct}`);
    assert(r.ts !== null && Date.now() - Date.parse(r.ts) < 120_000, "ts = celui du dernier relevé (fraîcheur)");
    const cible = { engine: "claude", providerId: null, model: "sonnet" };
    const table = { trivial: { engine: "neutral", providerId: "ollama", model: "x" } };
    const d = await applyDebord({ ...DEFAULT_DEBORD, seuilPct: 90 }, cible, table);
    assert(d.debord?.active === true, `un relevé en retard ne doit pas lever le débord : ${JSON.stringify(d)}`);
  },
  async () => {
    // Nouvelle fenêtre (reset différent) : la valeur basse est légitime.
    await ecrire([
      { ts: iso(300_000), windows: w(95, RESET5) },
      { ts: iso(60_000), windows: w(3, RESET5_SUIVANT) },
    ]);
    const r = await fenetres.readLatestClaudeWindows();
    assert(r.fiveHourPct === 3, `après réinitialisation attendu 3, reçu ${r.fiveHourPct}`);
  },
  async () => {
    // Le plancher ne traverse pas une réinitialisation : 95 (ancienne) / 3 / 2 (en retard) → 3.
    await ecrire([
      { ts: iso(500_000), windows: w(95, RESET5) },
      { ts: iso(300_000), windows: w(3, RESET5_SUIVANT) },
      { ts: iso(60_000), windows: w(2, RESET5_SUIVANT) },
    ]);
    const r = await fenetres.readLatestClaudeWindows();
    assert(r.fiveHourPct === 3, `plancher limité à la fenêtre courante : attendu 3, reçu ${r.fiveHourPct}`);
  },
  async () => {
    // Un autre compte intercalé ne compte pas, dans un sens comme dans l'autre.
    await ecrire([
      { ts: iso(300_000), windows: w(80, RESET5) },
      { ts: iso(200_000), compte: "teams", windows: w(99, RESET5) },
      { ts: iso(60_000), windows: w(50, RESET5) },
    ]);
    const perso = await fenetres.readLatestClaudeWindows();
    assert(perso.fiveHourPct === 80, `teams ne relève pas perso : attendu 80, reçu ${perso.fiveHourPct}`);
    const teams = await fenetres.readLatestClaudeWindows("teams");
    assert(teams.fiveHourPct === 99, `teams garde son relevé : ${teams.fiveHourPct}`);
  },
  async () => {
    // La fenêtre 7 jours a son propre plancher, et une fenêtre absente reste null.
    await ecrire([
      { ts: iso(300_000), windows: w(10, RESET5, 91) },
      { ts: iso(60_000), windows: { five_hour: { utilization: 10, resetsAt: RESET5 } } },
    ]);
    const r = await fenetres.readLatestClaudeWindows();
    assert(r.sevenDayPct === null, `fenêtre absente du dernier relevé ⇒ null, reçu ${r.sevenDayPct}`);
    await ecrire([
      { ts: iso(300_000), windows: w(10, RESET5, 91) },
      { ts: iso(60_000), windows: w(10, RESET5, 40) },
    ]);
    const r2 = await fenetres.readLatestClaudeWindows();
    assert(r2.sevenDayPct === 91, `plancher 7 jours attendu 91, reçu ${r2.sevenDayPct}`);
  },
  async () => {
    // L'outil `lire_usage` (readLatestClaudeReleve) lit le même plancher, sur
    // TOUTES les fenêtres, y compris celles propres à un modèle.
    const fable = (p) => ({ utilization: p, resetsAt: RESET7 });
    await ecrire([
      { ts: iso(300_000), windows: { ...w(23, RESET5), seven_day_fable: fable(60) } },
      { ts: iso(60_000), windows: { ...w(11, RESET5_MICRO), seven_day_fable: fable(30) } },
    ]);
    const r = await fenetres.readLatestClaudeReleve();
    assert(r.windows.five_hour.utilization === 23, `lire_usage : plancher 5 h attendu 23, reçu ${r.windows.five_hour.utilization}`);
    assert(r.windows.seven_day_fable.utilization === 60, `lire_usage : plancher par modèle attendu 60, reçu ${r.windows.seven_day_fable.utilization}`);
    assert(r.windows.five_hour.resetsAt === RESET5_MICRO, "la reprise reste celle du dernier relevé");
  },
);
