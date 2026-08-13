/*
 * routeur heuristique
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/router.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

/**
 * R1 — cas unitaires de `classify` (docs/spec-r1-routeur.md §5.1) : fonction
 * pure, importée directement depuis le module compilé (aucun sous-processus).
 */
async function testRouterClassify() {
  const routerModuleUrl = moduleCompile("router.js");
  const { classify } = await import(routerModuleUrl);

  // 1. R7 — trivialité PROUVÉE (score 0 + motif de salutation) -> trivial.
  const triv = classify({ text: "Salut, ça va ?" });
  assert(
    triv.tier === "trivial" && triv.score === 0 && Array.isArray(triv.reasons),
    `classify trivial incorrect: ${JSON.stringify(triv)}`,
  );
  assert(
    triv.reasons.length === 1 && triv.reasons[0].includes("trivialité prouvée"),
    `classify trivial : raison « trivialité prouvée » attendue, reçu ${JSON.stringify(triv.reasons)}`,
  );

  // R7 — acquiescement court -> trivial (motif « ok »/« merci »).
  const ack = classify({ text: "ok merci" });
  assert(
    ack.tier === "trivial" && ack.score === 0,
    `classify acquiescement incorrect: ${JSON.stringify(ack)}`,
  );

  // R7 — score 0 SANS motif de trivialité -> simple (défaut descendant) :
  // l'absence de preuve de complexité n'est plus une preuve de trivialité.
  const noSignal = classify({ text: "j'ai un problème avec mon appli" });
  assert(
    noSignal.tier === "simple" && noSignal.score === 0,
    `classify sans signal incorrect (simple attendu): ${JSON.stringify(noSignal)}`,
  );
  assert(
    noSignal.reasons.length === 1 && noSignal.reasons[0].includes("défaut descendant"),
    `classify sans signal : raison « défaut descendant » attendue, reçu ${JSON.stringify(noSignal.reasons)}`,
  );

  // 2. Court + marqueur de raisonnement -> simple (score 2, une raison française).
  const simple = classify({ text: "Explique pourquoi ce test échoue" });
  assert(
    simple.tier === "simple" && simple.score === 2,
    `classify simple incorrect: ${JSON.stringify(simple)}`,
  );
  assert(
    simple.reasons.length === 1 && simple.reasons[0].includes("raisonnement"),
    `classify simple : raisons attendues ["…raisonnement…"], reçu ${JSON.stringify(simple.reasons)}`,
  );

  // Insensibilité casse/accents (normalisation NFD) : majuscules accentuées.
  const caseless = classify({ text: "ANALYSE ÇA S'IL TE PLAÎT" });
  assert(
    caseless.tier === "simple" && caseless.score === 2,
    `classify casse/accents incorrect: ${JSON.stringify(caseless)}`,
  );

  // 3. R7 — bloc ``` (+2) + « implémente » (+3) = 5 -> moyen (3-6).
  const moyen = classify({
    text: "Implémente la fonction suivante dans le module.\n```\nfunction demo() { return 1; }\n```",
  });
  assert(
    moyen.tier === "moyen" && moyen.score === 5,
    `classify moyen incorrect (attendu score 5 = 2 code + 3 édition): ${JSON.stringify(moyen)}`,
  );

  // R7 — > 400 caractères (+2) + code (+2) + édition (+3) = 7 -> complexe (≥ 7).
  // Le remplissage évite soigneusement tout autre marqueur du barème.
  const filler = "du texte descriptif sans marqueur particulier pour gonfler la longueur du message. ".repeat(6);
  const seuilComplexe = classify({
    text: `Implémente la fonction suivante dans le module.\n\`\`\`\nfunction demo() { return 1; }\n\`\`\`\n${filler}`,
  });
  assert(
    seuilComplexe.tier === "complexe" && seuilComplexe.score === 7,
    `classify seuil complexe incorrect (attendu score 7 = 2 long + 2 code + 3 édition): ${JSON.stringify(seuilComplexe)}`,
  );

  // 4. > 1500 caractères (+2 +3) + code (+2) + édition (+3) + 2 pièces jointes (+2) = 12 -> complexe.
  const longFiller = "du texte descriptif sans marqueur particulier pour gonfler la longueur du message. ".repeat(20);
  const complexe = classify({
    text: `Corrige ce module.\n\`\`\`\nfunction demo() { return 1; }\n\`\`\`\n${longFiller}`,
    attachmentsCount: 2,
  });
  assert(
    complexe.tier === "complexe" && complexe.score === 12,
    `classify complexe incorrect (attendu score 12): ${JSON.stringify(complexe)}`,
  );

  // historique > 10 tours : +1. R7 — le moindre signal (score 1) écarte le
  // tier trivial (preuve positive = score 0 strict) -> simple.
  const withHistory = classify({ text: "Salut, ça va ?", historyTurns: 12 });
  assert(
    withHistory.score === 1 && withHistory.tier === "simple",
    `classify historique incorrect: ${JSON.stringify(withHistory)}`,
  );
}

await lancer(
  "routeur heuristique",
  testRouterClassify,
);
