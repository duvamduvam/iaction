/*
 * T-153 — une sortie « API Error: » d'une étape d'orchestration est un ÉCHEC.
 *
 * Constaté le 2026-10-06 : la veille des modèles a rendu « API Error: … » deux
 * fois, marquée `success` parce que classifyStepOutcome ne regardait que le
 * subtype. Un échec muet est le défaut que l'observabilité interdit.
 *
 * Lancement isolé : node sidecar/test/issueEtape.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { classifyStepOutcome } = await import(moduleCompile("issueEtape.js"));

const SORTIE_API = "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)";

await lancer(
  "issue d'étape (T-153)",
  async () => {
    const r = classifyStepOutcome({ subtype: "success" }, SORTIE_API);
    assert(r.status === "failed", `success + « API Error: » doit échouer : ${JSON.stringify(r)}`);
    assert(r.message.includes("EAI_AGAIN"), `le message doit citer la sortie : ${r.message}`);
  },
  async () => {
    const r = classifyStepOutcome({ subtype: "max_turns" }, `\n  ${SORTIE_API}`);
    assert(r.status === "failed", "max_turns + « API Error: » (espaces de tête) doit échouer");
  },
  async () => {
    const longue = `API Error: ${"x".repeat(5000)}`;
    const r = classifyStepOutcome({ subtype: "success" }, longue);
    assert(r.message.length < 400, `le message doit rester court : ${r.message.length}`);
  },
  async () => {
    // Un rapport qui MENTIONNE une API Error sans en être une reste un succès.
    const r = classifyStepOutcome({ subtype: "success" }, "Rapport : la veille a vu une « API Error: » hier.");
    assert(r.status === "success", `mention en milieu de texte ≠ échec : ${JSON.stringify(r)}`);
    assert(classifyStepOutcome({ subtype: "success" }, "").status === "success", "sortie vide : inchangé");
    assert(classifyStepOutcome({ subtype: "success" }).status === "success", "sans sortie : inchangé");
  },
  async () => {
    assert(classifyStepOutcome({ subtype: "aborted" }, SORTIE_API).status === "aborted", "aborted prime");
    const e = classifyStepOutcome({ subtype: "error_during_execution" }, "ok");
    assert(e.status === "failed" && e.message.includes("subtype"), "autre subtype : échec moteur inchangé");
  },
);
