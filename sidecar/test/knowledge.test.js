/*
 * RAG local
 *
 * Extrait de protocol.test.js le 2026-08-08. Ce fichier était l'un des blocs
 * d'un test de 6 000 lignes : pour savoir ce qui était couvert, il fallait
 * tout lire. Une couverture qu'on ne peut pas consulter ne protège qu'à
 * moitié — d'où la découpe par domaine, à contenu strictement identique.
 *
 * Lancement isolé : node sidecar/test/knowledge.test.js
 */

import { lancer, assert, moduleCompile } from "./harness.mjs";

async function testKnowledgePure() {
  const knowledgeModuleUrl = moduleCompile("knowledge.js");
  const { chunkText, cosineSimilarity, rankChunks, CHUNK_SIZE, CHUNK_OVERLAP } = await import(knowledgeModuleUrl);

  // 1. Chunking — texte court : un seul chunk, identique ; vide : aucun.
  assert(
    JSON.stringify(chunkText("petit texte\nsur deux lignes\n")) === JSON.stringify(["petit texte\nsur deux lignes\n"]),
    "chunkText : un texte court doit tenir dans un seul chunk inchangé",
  );
  assert(chunkText("   \n\n  ").length === 0, "chunkText : un texte blanc ne doit produire aucun chunk");

  // Texte long à lignes numérotées (~40 caractères chacune) : chaque chunk
  // ≤ CHUNK_SIZE, coupé aux frontières de lignes, recouvrement ≤ CHUNK_OVERLAP
  // (les dernières lignes entières du chunk précédent).
  const lines = [];
  for (let i = 0; i < 120; i++) {
    lines.push(`ligne ${String(i).padStart(3, "0")} lorem ipsum dolor sit amet\n`);
  }
  const longText = lines.join("");
  const chunks = chunkText(longText);
  assert(chunks.length > 1, `chunkText : un texte de ${longText.length} caractères doit produire plusieurs chunks`);
  for (const chunk of chunks) {
    assert(chunk.length <= CHUNK_SIZE, `chunkText : chunk trop long (${chunk.length} > ${CHUNK_SIZE})`);
    assert(/^ligne \d{3} /.test(chunk), "chunkText : chaque chunk doit commencer à une frontière de ligne");
    assert(chunk.endsWith("\n"), "chunkText : chaque chunk doit finir à une frontière de ligne");
  }
  for (let i = 1; i < chunks.length; i++) {
    // Recouvrement : le chunk i commence par un suffixe non vide (≤ CHUNK_OVERLAP)
    // du chunk i-1, puis continue avec du contenu nouveau.
    const prev = chunks[i - 1];
    let overlapLen = -1;
    for (let l = Math.min(CHUNK_OVERLAP, prev.length); l > 0; l--) {
      if (chunks[i].startsWith(prev.slice(prev.length - l))) {
        overlapLen = l;
        break;
      }
    }
    assert(
      overlapLen > 0 && overlapLen <= CHUNK_OVERLAP,
      `chunkText : recouvrement attendu entre les chunks ${i - 1} et ${i} (≤ ${CHUNK_OVERLAP} caractères)`,
    );
    assert(chunks[i].length > overlapLen, `chunkText : le chunk ${i} doit apporter du contenu nouveau après le recouvrement`);
  }
  // Couverture : la concaténation (recouvrements retirés) reconstitue le texte.
  let rebuilt = chunks[0];
  for (let i = 1; i < chunks.length; i++) {
    for (let l = Math.min(CHUNK_OVERLAP, rebuilt.length); l >= 0; l--) {
      if (chunks[i].startsWith(rebuilt.slice(rebuilt.length - l))) {
        rebuilt += chunks[i].slice(l);
        break;
      }
    }
  }
  assert(rebuilt === longText, "chunkText : la concaténation des chunks (recouvrements retirés) doit reconstituer le texte");

  // Ligne monstrueuse (> CHUNK_SIZE, sans \n) : découpe dure, rien de perdu.
  const monster = "x".repeat(2500);
  const monsterChunks = chunkText(monster);
  assert(
    monsterChunks.every((c) => c.length <= CHUNK_SIZE) && monsterChunks.join("") === monster,
    `chunkText : une ligne de 2500 caractères doit être découpée en dur sans perte, reçu ${JSON.stringify(monsterChunks.map((c) => c.length))}`,
  );

  // 2. Cosinus : colinéaires → 1, orthogonaux → 0, vecteur nul/dimensions ≠ → 0.
  assert(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-9, "cosineSimilarity : vecteurs colinéaires → 1");
  assert(cosineSimilarity([1, 0], [0, 1]) === 0, "cosineSimilarity : vecteurs orthogonaux → 0");
  assert(cosineSimilarity([0, 0], [1, 1]) === 0, "cosineSimilarity : vecteur nul → 0");
  assert(cosineSimilarity([1, 2], [1, 2, 3]) === 0, "cosineSimilarity : dimensions incompatibles → 0");

  // 3. topK : résultats ordonnés par score décroissant, bornés à k.
  const forged = [
    { file: "a.md", text: "chunk a", embedding: [1, 0, 0] },
    { file: "b.md", text: "chunk b", embedding: [0.9, 0.1, 0] },
    { file: "c.md", text: "chunk c", embedding: [0, 1, 0] },
    { file: "d.md", text: "chunk d", embedding: [0, 0, 1] },
  ];
  const ranked = rankChunks([1, 0, 0], forged, 3);
  assert(ranked.length === 3, `rankChunks : 3 résultats attendus, reçu ${ranked.length}`);
  assert(
    ranked[0].file === "a.md" && ranked[1].file === "b.md",
    `rankChunks : ordre attendu a.md puis b.md, reçu ${JSON.stringify(ranked.map((r) => r.file))}`,
  );
  assert(
    ranked[0].score === 1 && ranked[0].score > ranked[1].score && ranked[1].score > ranked[2].score,
    `rankChunks : scores décroissants attendus, reçu ${JSON.stringify(ranked.map((r) => r.score))}`,
  );
  assert(ranked[0].excerpt === "chunk a", `rankChunks : excerpt = texte du chunk, reçu ${JSON.stringify(ranked[0])}`);
}

await lancer(
  "RAG local",
  testKnowledgePure,
);
