/*
 * Outil MCP `lire_usage` (T-202) : formatage pur du relevé d'abonnement —
 * relevé complet, partiel, absent, âge — et erreur de lecture. AUCUN SDK.
 *
 * Lancement isolé : node sidecar/test/outilUsage.test.js
 */

import { assert, lancer, moduleCompile } from "./harness.mjs";

const { formaterDuree, formaterUsage, lireUsagePourAgent, creerOutilUsage } = await import(moduleCompile("outilUsage.js"));

const T0 = Date.parse("2026-11-07T20:30:00Z");
const MIN = 60_000;
const complet = {
  ts: new Date(T0 - 12 * MIN).toISOString(),
  windows: {
    five_hour: { utilization: 54.4, resetsAt: new Date(T0 + 83 * MIN).toISOString() },
    seven_day: { utilization: 2, resetsAt: new Date(T0 + 6 * 24 * 60 * MIN).toISOString() },
    Fable: { utilization: 0, resetsAt: null },
  },
};

await lancer("formaterDuree : unités courtes", () => {
  assert(formaterDuree(10_000) === "moins d'une minute", formaterDuree(10_000));
  assert(formaterDuree(12 * MIN) === "12 min", formaterDuree(12 * MIN));
  assert(formaterDuree(65 * MIN) === "1 h 05", formaterDuree(65 * MIN));
  assert(formaterDuree(-5 * MIN) === "moins d'une minute", "durée négative ramenée à zéro");
  assert(formaterDuree(51 * 60 * MIN) === "2 j 3 h", formaterDuree(51 * 60 * MIN));
});

await lancer("relevé complet : 5 h, 7 j, modèle, reprises et âge", () => {
  const t = formaterUsage(complet, "perso", T0);
  assert(t.includes("Claude Perso (relevé il y a 12 min)"), t);
  assert(t.includes("Fenêtre 5 h : 54 %, reprise dans 1 h 23"), t);
  assert(t.includes("Fenêtre 7 jours : 2 %, reprise dans 6 j 0 h"), t);
  assert(t.includes("Fable (hebdo du modèle) : 0 %") && !t.includes("Fable (hebdo du modèle) : 0 %,"), t);
});

await lancer("relevé partiel : seule la fenêtre présente est rendue", () => {
  const t = formaterUsage({ ts: complet.ts, windows: { five_hour: { utilization: 80, resetsAt: null } } }, "teams", T0);
  assert(t.includes("Claude Teams") && t.includes("Fenêtre 5 h : 80 %"), t);
  assert(!t.includes("7 jours") && !t.includes("reprise"), t);
});

await lancer("fenêtre de modèle nommée par sa clé brute", () => {
  const t = formaterUsage({ ts: complet.ts, windows: { seven_day_opus: { utilization: 31, resetsAt: null } } }, "perso", T0);
  assert(t.includes("Opus (hebdo du modèle) : 31 %"), t);
});

await lancer("reprise passée et date illisible", () => {
  const t = formaterUsage({ ts: "pas une date", windows: { five_hour: { utilization: 10, resetsAt: new Date(T0 - MIN).toISOString() } } }, "perso", T0);
  assert(t.includes("reprise déjà passée") && t.includes("date du relevé inconnue"), t);
});

await lancer("aucun relevé : texte clair", () => {
  for (const r of [null, { ts: null, windows: {} }]) {
    const t = formaterUsage(r, "perso", T0);
    assert(t === "Aucun relevé d'usage disponible pour ce compte (Claude Perso).", t);
  }
});

await lancer("lireUsagePourAgent : compte transmis, absence sans erreur, échec en erreur", async () => {
  const vus = [];
  const ok = await lireUsagePourAgent("teams", async (c) => (vus.push(c), complet), T0);
  assert(vus[0] === "teams" && !ok.erreur && ok.texte.includes("Claude Teams"), JSON.stringify(ok));
  const vide = await lireUsagePourAgent("perso", async () => null, T0);
  assert(!vide.erreur && vide.texte.includes("Aucun relevé"), JSON.stringify(vide));
  const ko = await lireUsagePourAgent("perso", async () => { throw new Error("disque illisible"); }, T0);
  assert(ko.erreur && ko.texte.includes("disque illisible"), JSON.stringify(ko));
});

await lancer("creerOutilUsage : nom, description, isError", async () => {
  let pris;
  const sdk = { tool: (nom, description, schema, fn) => (pris = { nom, description, schema, fn }) };
  creerOutilUsage(sdk, null, { compte: "teams", lire: async () => null });
  assert(pris.nom === "lire_usage" && pris.description.includes("fenêtres 5 h / 7 j"), JSON.stringify(pris));
  const r = await pris.fn();
  assert(r.content[0].text.includes("Claude Teams") && r.isError === undefined, JSON.stringify(r));
  creerOutilUsage(sdk, null, { lire: async () => { throw new Error("boum"); } });
  const e = await pris.fn();
  assert(e.isError === true, JSON.stringify(e));
});
