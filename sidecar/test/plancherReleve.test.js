/*
 * T-192 — un relevé en retard ne fait pas redescendre une fenêtre.
 *
 * Constaté le 2026-11-05 : 23 % puis 11 % dans la même fenêtre de 5 h. La conso
 * ne baisse pas avant la réinitialisation, et le dernier relevé reçu écrasait
 * le précédent.
 *
 * Lancement isolé : node sidecar/test/plancherReleve.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { appliquerPlancher, creerDepotUsage } = await import(moduleCompile("claudeUsage.js"));

const RESET = "2026-11-05T20:50:00.000Z";
const RESET_MICRO = "2026-11-05T20:50:00.268456+00:00";
const RESET_SUIVANT = "2026-11-06T01:50:00.000Z";

function releve(pct5h, reset5h, pct7j = 3, capturedAt = "2026-11-05T16:00:00.000Z") {
  const fiveHour = { utilization: pct5h, resetsAt: reset5h };
  const sevenDay = { utilization: pct7j, resetsAt: "2026-11-06T16:00:00.000Z" };
  return {
    available: true,
    subscriptionType: "team",
    fiveHour,
    sevenDay,
    windows: { five_hour: fiveHour, seven_day: sevenDay },
    capturedAt,
  };
}

await lancer(
  "plancher des relevés (T-192)",
  async () => {
    const r = appliquerPlancher(releve(23, RESET), releve(11, RESET_MICRO));
    assert(r.fiveHour.utilization === 23, `attendu 23, reçu ${r.fiveHour.utilization}`);
    assert(r.windows.five_hour.utilization === 23, "windows.five_hour doit suivre");
  },
  async () => {
    const r = appliquerPlancher(releve(11, RESET), releve(23, RESET_MICRO));
    assert(r.fiveHour.utilization === 23, `attendu 23, reçu ${r.fiveHour.utilization}`);
  },
  async () => {
    const r = appliquerPlancher(releve(90, RESET), releve(2, RESET_SUIVANT));
    assert(r.fiveHour.utilization === 2, `attendu 2, reçu ${r.fiveHour.utilization}`);
  },
  async () => {
    const r = appliquerPlancher(releve(23, RESET), releve(11, RESET, 3, "2026-11-05T16:07:00.000Z"));
    assert(r.capturedAt === "2026-11-05T16:07:00.000Z", "capturedAt doit avancer");
  },
  async () => {
    const depot = creerDepotUsage();
    depot.ecrire(releve(69, RESET), "perso");
    depot.ecrire(releve(23, RESET), "teams");
    depot.ecrire(releve(11, RESET_MICRO), "teams");
    assert(depot.lire("teams").fiveHour.utilization === 23, "teams doit rester à 23");
    assert(depot.lire("perso").fiveHour.utilization === 69, "perso ne doit pas bouger");
  },
);
