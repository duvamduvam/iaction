/*
 * Rappel factuel du tour suivant, après un abandon avec sous-agent en vol
 * (sidecar/src/rappelInterruption.ts, T-102).
 *
 * Constat du 2026-08-29 (docs/tickets.md, T-102) : privé de toute information
 * sur son sous-agent annulé, le modèle a affirmé « rien ne tournait,
 * j'attendais ta main » — faux sur toute la ligne. Ce module met en mots ce
 * que le sidecar SAIT, jamais une supposition.
 *
 * Lancement isolé : node sidecar/test/rappelInterruption.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

const { formaterRappelInterruption } = await import(moduleCompile("rappelInterruption.js"));

async function testAucunSousAgentEnVol() {
  assert(formaterRappelInterruption([], "protocole") === null, "aucun sous-agent en vol ⇒ aucun rappel");
  console.log("OK: un abandon sans sous-agent en vol ne produit aucun rappel");
}

async function testRappelContientLesFaitsConnus() {
  const texte = formaterRappelInterruption(
    [{ type: "explorateur", description: "Écrire le .scad du support micro", ms: 38 * 60_000 }],
    "protocole",
  );
  assert(typeof texte === "string" && texte.length > 0, "un sous-agent en vol ⇒ un rappel non vide");
  assert(texte.includes("Écrire le .scad du support micro"), "le rappel doit citer la description du sous-agent");
  assert(texte.includes("38 min"), `la durée doit être en minutes (38 min), reçu: ${texte}`);
  assert(texte.includes("`Agent`"), "le rappel doit nommer l'outil concerné");
  // Le point qui a le plus coûté à l'utilisateur (T-102, § constat) : le
  // modèle ne doit plus pouvoir se dire que rien ne tournait.
  assert(
    texte.toLowerCase().includes("jamais") || texte.toLowerCase().includes("coupé"),
    `le rappel doit exclure explicitement la lecture « rien ne tournait », reçu: ${texte}`,
  );
  console.log("OK: le rappel cite description et durée réelles, jamais une supposition");
}

async function testRepliSurLeTypeSansDescription() {
  const texte = formaterRappelInterruption([{ type: "sous-agent", description: "", ms: 5_000 }], "orchestration");
  assert(texte.includes("sous-agent"), `sans description, le repli doit nommer le type, reçu: ${texte}`);
  assert(texte.includes("5 s"), `moins d'une minute ⇒ secondes (5 s), reçu: ${texte}`);
  console.log("OK: sans description, repli sur le type ; durée courte en secondes");
}

async function testPlusieursSousAgents() {
  const texte = formaterRappelInterruption(
    [
      { type: "a", description: "premier travail", ms: 90_000 },
      { type: "b", description: "second travail", ms: 30_000 },
    ],
    "protocole",
  );
  assert(texte.includes("premier travail") && texte.includes("second travail"), `les deux doivent apparaître, reçu: ${texte}`);
  console.log("OK: plusieurs sous-agents en vol ⇒ tous cités");
}

async function testDureeJamaisNulle() {
  const texte = formaterRappelInterruption([{ type: "x", description: "y", ms: 200 }], "protocole");
  assert(!texte.includes("0 s"), `un abandon quasi immédiat ne doit jamais afficher « 0 s », reçu: ${texte}`);
  console.log("OK: la durée affichée n'est jamais « 0 s »");
}

await lancer(
  "rappelInterruption — le rappel factuel du tour suivant (T-102)",
  testAucunSousAgentEnVol,
  testRappelContientLesFaitsConnus,
  testRepliSurLeTypeSansDescription,
  testPlusieursSousAgents,
  testDureeJamaisNulle,
);
