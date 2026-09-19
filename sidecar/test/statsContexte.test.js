/*
 * `usage.stats` — le KPI de contexte, après T-067.
 *
 * Ce que ce fichier protège tient en une phrase : le chiffre affiché doit
 * venir de `contextTokens` (occupation réelle, cache compris) et jamais de
 * `promptTokens` (entrée fraîche du SDK, cache EXCLU). L'ancien KPI moyennait
 * les seconds et annonçait « Contexte moyen : 6 tokens » sur 1 031 tours —
 * un indicateur faux est plus coûteux qu'un indicateur absent, parce qu'on
 * lui fait confiance.
 *
 * Trois pièges sont exercés, dans l'ordre où ils mordraient :
 *   1. lire le mauvais champ (le test le détecte parce que les deux champs
 *      portent des ordres de grandeur DIFFÉRENTS dans les événements forgés) ;
 *   2. compter un contexte absent ou nul comme une mesure de zéro, ce qui
 *      tirerait la médiane vers le bas ;
 *   3. rendre 0 plutôt que `null` quand rien n'a été relevé — une médiane
 *      absente n'est pas une médiane nulle, et la courbe doit s'interrompre.
 *
 * En processus plutôt qu'en sidecar lancé : `handleUsageStats` lit
 * `events.jsonl` sous le XDG jetable du harness, et cette lecture est
 * exactement ce qu'il faut exercer.
 *
 * Lancement isolé : node sidecar/test/statsContexte.test.js
 */

import path from "node:path";
import { promises as fsp } from "node:fs";

import { lancer, assert, moduleCompile, makeEmitterCollector, defaultXdgConfigHome } from "./harness.mjs";

const { handleUsageStats } = await import(moduleCompile("usageStats.js"));

const usageDir = path.join(defaultXdgConfigHome, "net.duvam.iaction", "usage");
const eventsFile = path.join(usageDir, "events.jsonl");

/** Écrit un lot d'événements d'usage, en écrasant ceux d'un cas précédent. */
async function poserEvenements(evenements) {
  await fsp.mkdir(usageDir, { recursive: true });
  await fsp.writeFile(eventsFile, evenements.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

/** Un tour, le 2026-08-10, avec les deux mesures de contexte dissociées. */
function tour({ contextTokens, promptTokens = 7, id = "c1" }) {
  return {
    ts: "2026-08-10T12:00:00.000Z",
    conversationId: id,
    engine: "claude",
    model: "claude-opus-5",
    status: "done",
    promptTokens,
    completionTokens: 100,
    ...(contextTokens === undefined ? {} : { contextTokens }),
  };
}

async function stats() {
  const c = makeEmitterCollector();
  await handleUsageStats("s", { bucket: "day", from: "2026-08-10", to: "2026-08-10" }, c.emitter);
  const evt = await c.waitFor((e) => e.id === "s");
  assert(evt.kind === "done", `usage.stats: attendu done, reçu ${evt.kind} (${evt.data.message ?? ""})`);
  return evt.data;
}

await lancer(
  "usage.stats — contexte médian (T-067)",

  async function mediane_du_contexte_reel() {
    // Contextes : 10k, 30k, 50k → médiane 30k. Les `promptTokens` valent 7 :
    // si le calcul lisait le mauvais champ, il rendrait 7.
    await poserEvenements([
      tour({ contextTokens: 10_000 }),
      tour({ contextTokens: 50_000 }),
      tour({ contextTokens: 30_000 }),
    ]);
    const d = await stats();
    assert(d.totals.contexteMedian === 30_000, `médiane attendue 30000, reçu ${d.totals.contexteMedian}`);
    assert(d.totals.avgPromptTokens === undefined, "l'ancien champ ne doit plus être servi");
    assert(d.buckets[0].contexteMedian === 30_000, `bucket: médiane attendue 30000, reçu ${d.buckets[0].contexteMedian}`);
    console.log("OK: médiane calculée sur contextTokens, pas sur promptTokens");
  },

  async function contexte_absent_ou_nul_nest_pas_zero() {
    // Deux tours mesurés (20k, 40k) et deux non mesurés (absent, 0). La
    // médiane doit porter sur les DEUX mesurés : médiane basse = 20k. Si les
    // non mesurés comptaient pour zéro, elle tomberait à 0.
    await poserEvenements([
      tour({ contextTokens: 20_000 }),
      tour({ contextTokens: 40_000 }),
      tour({ contextTokens: undefined }),
      tour({ contextTokens: 0 }),
    ]);
    const d = await stats();
    assert(d.totals.contexteMedian === 20_000, `médiane attendue 20000, reçu ${d.totals.contexteMedian}`);
    assert(d.totals.tours === 4, `les 4 tours restent comptés, reçu ${d.totals.tours}`);
    console.log("OK: un contexte non relevé n'est pas un contexte de zéro");
  },

  async function aucune_mesure_rend_null() {
    await poserEvenements([tour({ contextTokens: undefined }), tour({ contextTokens: undefined })]);
    const d = await stats();
    assert(d.totals.contexteMedian === null, `attendu null, reçu ${JSON.stringify(d.totals.contexteMedian)}`);
    console.log("OK: aucune mesure → null, jamais 0");
  },
);

await fsp.rm(eventsFile, { force: true });
