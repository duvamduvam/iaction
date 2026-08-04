# Spec R5 — RAG local `search_knowledge` (Lot 14, phase R5)

Statut : **spec fermée, prête à déléguer** (2026-07-27). Reprend la piste
flexibilité n° 2 du plan. Cadre : `docs/etude-routage-llm.md` §6. Taille :
1 lot+.

## Objectif

Remplacer (en opt-in par projet) l'injection intégrale des connaissances par
un **outil de recherche** adossé à un index d'embeddings local : coût par
question au lieu de coût proportionnel au corpus. Exposé aux **deux
moteurs** (« tous agents à égalité »).

## 1. Index — sidecar/src/knowledge.ts (nouveau)

- **Stockage** : `<projet>/.iaction/connaissances-index/chunks.jsonl` —
  une ligne par chunk `{ file, chunkId, mtimeMs, text, embedding:
  number[] }` + `meta.json` `{ model, dim, builtAt, files: {path: mtimeMs} }`.
  Pas de SQLite : corpus locaux petits, cosinus brute-force en JS suffit
  (< 10 k chunks) et zéro dépendance nouvelle. Le dossier est ignoré par la
  détection de connaissances existante (index ≠ document).
- **Sources** : les mêmes que le panneau Connaissances (documents épinglés +
  `.iaction/connaissances/` + détectées) — réutiliser la logique de collecte
  existante du sidecar, ne pas la dupliquer.
- **Chunking** : ~1 000 caractères, recouvrement 200, coupé aux frontières
  de lignes ; fichiers texte uniquement (mêmes extensions que l'existant).
- **Embeddings** : API NATIVE Ollama `POST /api/embed` (dérivation
  `ollamaNativeBase` d'engine.ts), modèle configurable dans la config
  routage `embeddings: { providerId, model }`, défaut `ollama` ·
  `nomic-embed-text`. Batch par ~32 chunks, timeout 10 min (patron
  OLLAMA_LOAD_TIMEOUT_MS).

## 2. Méthodes protocole

- `knowledge.index { cwd }` → chunks streamés de progression
  `{ file, done, total }`, puis `done { files, chunks, model }`.
  Incrémental : un fichier au mtime inchangé garde ses chunks.
- `knowledge.search { cwd, query, topK? }` (défaut topK 5) →
  `done { results: [{ file, excerpt, score }] }` — embed de la requête +
  cosinus. Index absent → `error` lisible (« index absent — lancer
  l'indexation »).
- `knowledge.status { cwd }` → `done { exists, files, chunks, model,
  builtAt }`.

## 3. Outil `search_knowledge` dans les deux moteurs

- **Moteur neutre** (neutralAgent.ts) : nouvel outil de la palette
  (description française : « Recherche dans les connaissances du projet —
  args: query, topK? ») qui appelle la recherche en interne. Soumis au flux
  de permission normal des outils, comme `search`.
- **Moteur Claude** (claude.ts) : serveur MCP in-process via
  `createSdkMcpServer`/`tool` du Agent SDK, exposé
  `mcp__iaction__search_knowledge` — même flux de permission que les autres
  outils MCP. Activé seulement quand l'index du projet existe.

## 4. Bascule par projet

- Réglage par projet (état/config projet existant) : `connaissances.mode:
  "injection" | "rag"` — défaut `"injection"` (comportement actuel intact).
- En mode `rag` : PAS d'injection intégrale au 1er tour ; à la place, une
  ligne système courte : « Des connaissances projet sont indexées — utilise
  l'outil search_knowledge. » L'outil est proposé dans les deux moteurs.
- **UI (panneau Connaissances, page Projets)** : sélecteur du mode, bouton
  « Indexer maintenant » avec progression, état de l'index
  (fichiers/chunks/date/modèle), avertissement si l'index est plus vieux
  qu'un document source (comparaison mtime via knowledge.status étendu d'un
  bool `stale`).

## 5. Tests

1. Chunking : tailles/recouvrement/frontières de lignes (fonction pure).
2. Cosinus + topK : résultats ordonnés (vecteurs forgés).
3. `knowledge.index` incrémental : fichier inchangé non ré-embeddé (faux
   serveur d'embeddings qui compte les appels).
4. `knowledge.search` : index forgé sur disque → résultats attendus ;
   index absent → erreur lisible.
5. Outil neutre : un run d'agent avec faux serveurs où le modèle appelle
   `search_knowledge` → résultat injecté dans la boucle (patron des tests
   d'outils existants).

## 6. Critères d'acceptation

- [ ] `npm run sidecar:test` + `npm run ui:build` verts.
- [ ] Mode `injection` par défaut : comportement actuel strictement
      inchangé.
- [ ] `.iaction/connaissances-index/` jamais listé comme document.
- [ ] Clés/API : rien de nouveau sur disque hors index (pas de secret).
- [ ] `docs/protocol.md` à jour (méthodes knowledge.*, outil des deux
      moteurs, mode par projet).
