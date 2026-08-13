/*
 * compaction de contexte
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/contexte.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

/**
 * R4 — cas unitaires de la logique pure de compaction (docs/spec-r4-contexte.md
 * §4.2/§4.3) : fonctions pures importées depuis le module compilé, comme
 * testRouterClassify.
 */
async function testContextPure() {
  const contextModuleUrl = moduleCompile("context.js");
  const { shouldCompact, buildCompactedMessages, COMPACT_KEEP_LAST } = await import(contextModuleUrl);

  // Seuil tours : 31 tours non couverts -> compacte (même sans contexte connu).
  assert(
    shouldCompact({ uncoveredTurns: 31, estimatedChars: 100, contextLength: null }) === true,
    "shouldCompact : 31 tours non couverts doivent déclencher la compaction",
  );

  // Seuil contexte : 12 tours seulement, mais estimation > 60 % du contexte
  // (30000 caractères ≈ 7500 tokens > 0,6 × 8000) -> compacte.
  assert(
    shouldCompact({ uncoveredTurns: 12, estimatedChars: 30000, contextLength: 8000 }) === true,
    "shouldCompact : 12 tours mais > 60 % du contexte doivent déclencher la compaction",
  );

  // Petit historique -> ne compacte pas (y compris avec contexte connu large,
  // et sans contexte connu : le seuil tours s'applique alors seul).
  assert(
    shouldCompact({ uncoveredTurns: 5, estimatedChars: 2000, contextLength: 8000 }) === false,
    "shouldCompact : petit historique ne doit pas compacter",
  );
  assert(
    shouldCompact({ uncoveredTurns: 12, estimatedChars: 30000 }) === false,
    "shouldCompact : sans contextLength, seul le seuil tours s'applique",
  );

  // Construction post-compaction : résumé en tête (après le system), les
  // 10 derniers tours intacts, tableau d'origine non modifié.
  const turns = [];
  for (let i = 0; i < 25; i++) {
    turns.push({ role: i % 2 === 0 ? "user" : "assistant", content: `tour ${i}` });
  }
  const upToIndex = turns.length - COMPACT_KEEP_LAST; // 15
  const built = buildCompactedMessages({
    system: "Instructions système",
    summary: "Résumé des quinze premiers tours.",
    turns,
    upToIndex,
  });
  assert(
    built.length === 2 + COMPACT_KEEP_LAST,
    `buildCompactedMessages : ${2 + COMPACT_KEEP_LAST} messages attendus (system + résumé + 10 tours), reçu ${built.length}`,
  );
  assert(
    built[0].role === "system" && built[0].content === "Instructions système",
    `buildCompactedMessages : system en tête attendu, reçu ${JSON.stringify(built[0])}`,
  );
  assert(
    built[1].role === "user" &&
      built[1].content.startsWith("[Résumé de la conversation antérieure]\n") &&
      built[1].content.includes("Résumé des quinze premiers tours."),
    `buildCompactedMessages : message-résumé attendu en 2e position, reçu ${JSON.stringify(built[1])}`,
  );
  for (let i = 0; i < COMPACT_KEEP_LAST; i++) {
    const expected = turns[upToIndex + i];
    const got = built[2 + i];
    assert(
      got.role === expected.role && got.content === expected.content,
      `buildCompactedMessages : tour conservé ${i} altéré, attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(got)}`,
    );
  }
  assert(
    turns.length === 25 && turns[0].content === "tour 0",
    "buildCompactedMessages : la transcription d'origine ne doit pas être modifiée",
  );

  // Sans system : le résumé ouvre le fil.
  const builtNoSystem = buildCompactedMessages({ summary: "S", turns, upToIndex: 20 });
  assert(
    builtNoSystem[0].role === "user" && builtNoSystem[0].content.startsWith("[Résumé de la conversation antérieure]"),
    `buildCompactedMessages sans system : résumé en tête attendu, reçu ${JSON.stringify(builtNoSystem[0])}`,
  );
}

await lancer(
  "compaction de contexte",
  testContextPure,
);
