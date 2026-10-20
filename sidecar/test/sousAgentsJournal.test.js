/*
 * Suivi des sous-agents en vol (sidecar/src/sousAgentsJournal.ts, T-102).
 *
 * Deux ajouts testés ici, absents avant ce chantier :
 *   1. `compterOutil` rend désormais le battement à jour (compteur + dernier
 *      outil vu) au lieu de ne rien rendre — c'est ce que claude.ts reverse
 *      au fil en chunk `sous_agent_battement` ;
 *   2. `instantane()` — les sous-agents encore en vol à un instant T, pour
 *      bâtir le rappel factuel du tour suivant sur un abandon (voir
 *      rappelInterruption.ts).
 *
 * Lancement isolé : node sidecar/test/sousAgentsJournal.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { creerSuiviSousAgents, estLanceurSousAgent } = await import(moduleCompile("sousAgentsJournal.js"));

async function testEstLanceurSousAgent() {
  assert(estLanceurSousAgent("Task") === true, "Task lance un sous-agent");
  assert(estLanceurSousAgent("Agent") === true, "Agent lance un sous-agent");
  assert(estLanceurSousAgent("Bash") === false, "Bash n'en lance pas");
  console.log("OK: estLanceurSousAgent — Task/Agent seulement");
}

async function testCompterOutilRendLeBattement() {
  const suivi = creerSuiviSousAgents();

  // Un outil vu chez un sous-agent INCONNU (jamais lancé, ou déjà terminé) :
  // aucun battement à faire remonter.
  assert(suivi.compterOutil("toolu-inconnu", "Bash") === null, "sous-agent inconnu ⇒ null");
  assert(suivi.compterOutil(null, "Bash") === null, "parentToolUseId absent ⇒ null");

  suivi.lancer("req-1", "toolu-1", { subagent_type: "explorateur", description: "Écrire le .scad" });

  const b1 = suivi.compterOutil("toolu-1", "Bash");
  assert(
    b1 && b1.toolUseId === "toolu-1" && b1.outils === 1 && b1.dernierOutil === "Bash",
    `premier battement attendu {toolu-1,1,Bash}, reçu ${JSON.stringify(b1)}`,
  );

  const b2 = suivi.compterOutil("toolu-1", "WebSearch");
  assert(
    b2 && b2.outils === 2 && b2.dernierOutil === "WebSearch",
    `battement CUMULÉ attendu (outils:2, dernier:WebSearch), reçu ${JSON.stringify(b2)}`,
  );

  // Un outil sans nom (cas défensif, ne devrait pas arriver en pratique) ne
  // doit pas effacer le dernier outil connu.
  const b3 = suivi.compterOutil("toolu-1", null);
  assert(
    b3 && b3.outils === 3 && b3.dernierOutil === "WebSearch",
    `outil sans nom : compteur avance, dernierOutil INCHANGÉ, reçu ${JSON.stringify(b3)}`,
  );

  console.log("OK: compterOutil — battement cumulé (compteur + dernier outil), jamais la liste");
}

async function testInstantane() {
  const suivi = creerSuiviSousAgents();
  assert(suivi.instantane().length === 0, "aucun sous-agent lancé ⇒ instantané vide");

  suivi.lancer("req-1", "toolu-1", { subagent_type: "explorateur", description: "Écrire le .scad du support micro" });
  suivi.lancer("req-1", "toolu-2", {});

  const vus = suivi.instantane();
  assert(vus.length === 2, `deux sous-agents en vol attendus, reçu ${vus.length}`);
  const explorateur = vus.find((v) => v.type === "explorateur");
  assert(explorateur, "le premier sous-agent doit apparaître avec son type déclaré");
  assert(
    explorateur.description === "Écrire le .scad du support micro",
    `description attendue, reçu ${JSON.stringify(explorateur)}`,
  );
  const repli = vus.find((v) => v.type === "sous-agent");
  assert(repli && repli.description === "", "un lancement sans subagent_type/description garde un repli générique");

  // `terminer` retire de l'instantané — un sous-agent fini n'est plus « en vol ».
  suivi.terminer("req-1", "toolu-2", "ok");
  assert(suivi.instantane().length === 1, "un sous-agent terminé disparaît de l'instantané");

  console.log("OK: instantane — sous-agents en vol, terminer() les retire");
}

await lancer(
  "sousAgentsJournal — battement et instantané (T-102)",
  testEstLanceurSousAgent,
  testCompterOutilRendLeBattement,
  testInstantane,
);
