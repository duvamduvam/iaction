/*
 * T-074 — projection minimale du signal d'escalade (sidecar/src/usageEscalade.ts).
 *
 * Ce module ne CALCULE rien (l'algorithme vit côté UI, escaladeSignal.ts,
 * déjà testé) : il PROJETTE les événements du journal vers les quatre champs
 * dont l'algorithme a besoin. Les tests portent donc sur ce qui est gardé, ce
 * qui est écarté, et pourquoi — pas sur la détection d'escalade elle-même.
 *
 * Lancement isolé : node sidecar/test/escaladeAgregat.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { newEscaladeAgg, applyEscaladeEvent, finalizeEscalade } = await import(moduleCompile("usageEscalade.js"));

function evenement(overrides = {}) {
  return {
    ts: "2026-08-29T10:00:00.000Z",
    conversationId: "conv-1",
    model: "claude-haiku-4-5",
    status: "done",
    ...overrides,
  };
}

async function testProjectionMinimale() {
  const agg = newEscaladeAgg();
  applyEscaladeEvent(agg, evenement({ status: "error" }));
  const out = finalizeEscalade(agg);
  assert(out.length === 1, `une ligne attendue, reçu ${out.length}`);
  assert(
    Object.keys(out[0]).sort().join(",") === "conversationId,erreur,model,ts",
    `champ minimal attendu, reçu ${JSON.stringify(Object.keys(out[0]))}`,
  );
  assert(out[0].erreur === true, "status:error ⇒ erreur:true");
  assert(out[0].conversationId === "conv-1" && out[0].model === "claude-haiku-4-5", "champs recopiés tels quels");
}

async function testStatusNonErreur() {
  const agg = newEscaladeAgg();
  applyEscaladeEvent(agg, evenement({ status: "done" }));
  applyEscaladeEvent(agg, evenement({ status: "aborted" }));
  const out = finalizeEscalade(agg);
  assert(out.every((t) => t.erreur === false), "seul status:error vaut erreur:true");
}

async function testConversationIdManquantEcarte() {
  const agg = newEscaladeAgg();
  applyEscaladeEvent(agg, evenement({ conversationId: null }));
  applyEscaladeEvent(agg, evenement({ conversationId: undefined }));
  applyEscaladeEvent(agg, evenement({ conversationId: "" }));
  const out = finalizeEscalade(agg);
  assert(out.length === 0, `sans conversationId, rien ne se place dans une séquence — reçu ${out.length}`);
}

async function testTsManquantEcarte() {
  const agg = newEscaladeAgg();
  applyEscaladeEvent(agg, evenement({ ts: null }));
  applyEscaladeEvent(agg, evenement({ ts: "" }));
  const out = finalizeEscalade(agg);
  assert(out.length === 0, `sans ts, rien ne s'ordonne — reçu ${out.length}`);
}

/*
 * LE choix documenté du module : un modèle absent est GARDÉ, pas écarté, pour
 * ne pas rompre l'adjacence entre le tour qui précède et celui qui suit.
 */
async function testModeleManquantGardeCommeInconnu() {
  const agg = newEscaladeAgg();
  applyEscaladeEvent(agg, evenement({ model: null }));
  applyEscaladeEvent(agg, evenement({ model: undefined }));
  const out = finalizeEscalade(agg);
  assert(out.length === 2, `les deux lignes doivent survivre — reçu ${out.length}`);
  assert(out.every((t) => t.model === "(inconnu)"), "modèle manquant ⇒ (inconnu), jamais deviné");
}

async function testEvenementsMalformesIgnores() {
  const agg = newEscaladeAgg();
  applyEscaladeEvent(agg, null);
  applyEscaladeEvent(agg, {});
  applyEscaladeEvent(agg, { conversationId: 42, ts: "x" });
  const out = finalizeEscalade(agg);
  assert(out.length === 0, `entrées malformées ⇒ aucune ligne, reçu ${out.length}`);
}

await lancer(
  "usageEscalade — projection minimale (T-074)",
  testProjectionMinimale,
  testStatusNonErreur,
  testConversationIdManquantEcarte,
  testTsManquantEcarte,
  testModeleManquantGardeCommeInconnu,
  testEvenementsMalformesIgnores,
);
