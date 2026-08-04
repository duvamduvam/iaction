# Spec R4 — Économie de contexte du moteur neutre (Lot 14, phase R4)

Statut : **spec fermée, prête à déléguer** (2026-07-27). Indépendante de
R2/R3 (utilise la config routage de R1 si présente). Cadre :
`docs/etude-routage-llm.md` §6 (résumé auto par modèle local, N derniers
tours intacts, résumé consultable). Taille : 1 lot.

## Objectif

Sur les longues conversations du **moteur neutre** (l'historique est
reconstruit côté UI à chaque `chat.send`), remplacer les anciens tours par
un **résumé compact produit par un modèle local gratuit**, sans toucher à la
transcription affichée. Côté Claude : rien (compaction SDK existante).

## 1. Sidecar — méthode `context.compact`

`params: { providerId: string, model: string, messages: ChatMessage[],
keepLast?: number }` → `done: { summary: string, coveredTurns: number }`.

- Résume les messages FOURNIS (l'appelant choisit quoi résumer) via une
  complétion non streamée sur `providerId`/`model` (mêmes helpers
  qu'engine.ts ; timeout 60 s).
- Prompt système en français : résumé factuel et dense de la conversation —
  décisions prises, faits établis, fichiers/chemins cités, questions
  ouvertes — en ≤ 400 mots, sans commentaire méta.
- Erreur/timeout → `error` protocolaire normale (l'UI n'applique alors PAS
  la compaction et envoie l'historique intégral — jamais de perte).

## 2. UI — ChatPage (conversations moteur neutre uniquement)

### 2.1 État de conversation persisté

`compaction?: { summary: string, upToIndex: number, at: string }` — le
résumé couvre les tours `[0, upToIndex)` de la transcription.

### 2.2 Déclenchement (avant envoi)

Compacter quand `tours non couverts > 30` OU `taille estimée > 60 % du
contexte du modèle` (estimation ~4 caractères/token ; `contextLength` connu
via `models.detail` pour OpenRouter, sinon le seuil tours s'applique seul).
Seuils constantes nommées, faciles à régler. La compaction recouvre
l'ancienne (le résumé précédent est fourni en tête des messages à résumer),
et garde toujours les `keepLast = 10` derniers tours intacts.

Cible du résumé : `routing.classifier` de la config routage si défini
(R1/R2), sinon `ollama` · `qwen3.5:4b` ; provider absent de la table
déclarée → pas de compaction (silencieux, comportement actuel).

### 2.3 Construction des messages envoyés

`[system éventuel] + [{role:"user", content:"[Résumé de la conversation
antérieure]\n" + summary}] + tours depuis upToIndex`. La transcription
AFFICHÉE ne change pas.

### 2.4 Résumé consultable

Indicateur discret en tête de transcription : « historique compacté
(N tours résumés) » — clic → modale (composant `Modal` existant) montrant le
résumé, avec bouton « Recompacter » et « Oublier le résumé » (repasse à
l'envoi intégral).

## 3. Ordonnancement cache-friendly

Vérifier (et corriger si besoin) que le moteur neutre envoie dans un ordre
STABLE : system → connaissances/documents épinglés → résumé → tours. Les
blocs stables doivent précéder les blocs variables pour maximiser les hits
de cache fournisseur (OpenRouter). Documenter l'ordre dans protocol.md.

## 4. Tests

1. `context.compact` : faux serveur → `summary` renvoyé, `coveredTurns`
   correct ; erreur serveur → error protocolaire.
2. Logique de seuil (fonction pure exportée côté UI ou sidecar) : 31 tours →
   compacte ; 12 tours mais estimation > 60 % du contexte → compacte ;
   petit historique → ne compacte pas.
3. Construction des messages post-compaction : résumé en tête, 10 derniers
   tours intacts, transcription affichée inchangée (test unitaire de la
   fonction de construction).

## 5. Critères d'acceptation

- [ ] `npm run sidecar:test` + `npm run ui:build` verts.
- [ ] Aucun changement pour les conversations Claude ni pour les
      conversations neutres courtes.
- [ ] Échec de compaction = envoi intégral (jamais de tour perdu).
- [ ] Résumé consultable/annulable dans l'UI.
- [ ] `docs/protocol.md` à jour (`context.compact`, ordre des messages).
