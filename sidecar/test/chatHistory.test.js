/*
 * historique du Chat
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/chatHistory.test.js
 */

import path from "node:path";
import { promises as fsp } from "node:fs";
import os from "node:os";
import { lancer, assert, moduleCompile } from "./harness.mjs";

/**
 * R5 — fonctions pures du RAG local (docs/spec-r5-rag.md §5.1/§5.2) :
 * chunking (tailles/recouvrement/frontières de lignes) et cosinus + topK,
 * importées depuis le module compilé — même patron que testRouterClassify.
 */
/**
 * Recherche dans l'historique du Chat (`chatHistory.ts`, outil MCP
 * `mcp__iaction__search_chat`) : fonctions pures, testées sur un faux état
 * applicatif dans un XDG_DATA_HOME temporaire — jamais l'historique réel du
 * poste (le module lit l'environnement à CHAQUE appel, ce qui rend ce test
 * possible et le protège d'une fuite de données personnelles).
 */
async function testChatHistoryPure() {
  const moduleUrl = moduleCompile("chatHistory.js");
  const { searchChatHistory, formatChatSearchResults, sanitizeLimit } = await import(moduleUrl);

  const previousXdgData = process.env.XDG_DATA_HOME;
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-chat-"));
  process.env.XDG_DATA_HOME = dataDir;
  try {
    // 1. Bornes de `limit` (défaut 5, plancher 1, plafond 20).
    assert(sanitizeLimit(undefined) === 5, "sanitizeLimit : défaut 5");
    assert(sanitizeLimit(0) === 1 && sanitizeLimit(999) === 20, "sanitizeLimit : bornes 1..20");

    // 2. Fichier absent : message lisible, jamais une exception.
    const absent = await searchChatHistory("daw", 5);
    assert(
      absent.ok === false && absent.message.includes("absent"),
      `historique absent : message attendu, reçu ${JSON.stringify(absent)}`,
    );

    const stateDir = path.join(dataDir, "net.duvam.iaction", "state");
    await fsp.mkdir(stateDir, { recursive: true });
    await fsp.writeFile(
      path.join(stateDir, "chat-conversations.json"),
      JSON.stringify({
        sessions: [
          {
            id: "c1",
            title: "Musique sous Linux",
            updatedAt: "2026-08-03T20:00:00.000Z",
            entries: [
              { role: "user", content: "quel DAW sur linux ?" },
              { role: "assistant", content: "Bitwig, Ardour ou Reaper selon le workflow." },
              { role: "assistant", content: "Le dáw se pilote aussi au clavier." },
            ],
          },
          { id: "c2", title: "Autre sujet", entries: [{ role: "user", content: "rien à voir" }] },
          // Entrées mal formées : ignorées sans faire échouer la lecture.
          { id: "c3", title: "Cassée", entries: [{ role: "user" }, 42, null] },
        ],
      }),
      "utf8",
    );

    // 3. Recherche insensible à la casse ET aux accents (« daw » trouve « DAW » et « dáw »).
    const found = await searchChatHistory("daw", 5);
    assert(found.ok === true, `recherche : ok attendu, reçu ${JSON.stringify(found)}`);
    assert(found.scanned === 3, `recherche : 3 conversations parcourues, reçu ${found.scanned}`);
    assert(found.hits.length === 1, `recherche : 1 conversation attendue, reçu ${found.hits.length}`);
    assert(
      found.hits[0].title === "Musique sous Linux" && found.hits[0].matches === 2,
      `recherche : conversation/compte incorrects, reçu ${JSON.stringify(found.hits[0])}`,
    );
    assert(
      found.hits[0].excerpts.every((e) => /^\[(user|assistant)\] /.test(e)),
      `recherche : chaque extrait doit porter son rôle, reçu ${JSON.stringify(found.hits[0].excerpts)}`,
    );

    // 4. Aucune correspondance : rendu explicite, pas une erreur.
    const none = await searchChatHistory("zzz-introuvable", 5);
    assert(none.ok === true && none.hits.length === 0, "recherche sans résultat : ok avec 0 résultat");
    assert(
      formatChatSearchResults(none).includes("Aucune conversation"),
      `rendu sans résultat incorrect : ${formatChatSearchResults(none)}`,
    );

    // 5. JSON invalide : message lisible (le tour de l'agent doit continuer).
    await fsp.writeFile(path.join(stateDir, "chat-conversations.json"), "{pas du json", "utf8");
    const broken = await searchChatHistory("daw", 5);
    assert(
      broken.ok === false && broken.message.includes("illisible"),
      `JSON invalide : message attendu, reçu ${JSON.stringify(broken)}`,
    );
  } finally {
    if (previousXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgData;
    await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  console.log("OK: recherche dans l'historique du Chat (search_chat)");
}

await lancer(
  "historique du Chat",
  testChatHistoryPure,
);
