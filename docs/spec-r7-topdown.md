# Spec R7 — Deux stratégies de routage : montante (Chat) et descendante (Projets)

Statut : **spec fermée, prête à déléguer** (révisée le 2026-07-31 après
retour utilisateur : A+B ne font qu'améliorer le bottom-up ; le top-down est
une stratégie distincte, à appliquer par défaut aux gros travaux).
Cadre : `docs/etude-routage-llm.md` §10 (constat : 100 % des tours Auto →
trivial/Haiku ; causes : barème ascendant, affinité figée au 1er message).

**Deux stratégies, par défaut selon le flux :**

| Flux | Stratégie | Comportement Auto |
|---|---|---|
| **Chat** (questions courantes) | **montante** (bottom-up amélioré, §A+§B) | barème descendant + plancher de session qui monte |
| **Projets** (sessions agentiques, gros travail) | **descendante** (top-down, §C) | démarre au SOMMET de la table (`complexe`) ; ne descend jamais automatiquement |

Les orchestrations sont déjà top-down par construction (superviseur fort +
étapes déléguées explicites) — hors périmètre. Une clé `strategie:` dans
`.iaction/routage.yaml` (surcharge par projet) est notée comme décision
ouverte, PAS dans cette spec.

## A. Barème inversé (sidecar/src/router.ts)

Le calcul du score par signaux NE CHANGE PAS. Changent : le mapping
score→tier et la règle du tier `trivial`.

1. **Nouveau mapping** : `simple` si score ≤ 2 · `moyen` si 3-6 ·
   `complexe` si ≥ 7. Sans signal (score 0) → `simple` : l'absence de
   preuve de complexité n'est plus une preuve de trivialité.
2. **`trivial` uniquement sur preuve positive** : score 0 ET
   `attachmentsCount` 0 ET texte ≤ 160 caractères ET correspondance d'un
   motif de trivialité (constante `TRIVIAL_PATTERNS`, normalisation
   NFD/casse comme les autres listes) : salutations/politesse (« salut »,
   « bonjour », « merci », « ça va », « ok », « oui », « non », « parfait »,
   « bonne nuit »…), acquiescements courts, question factuelle d'une phrase
   sans référence technique. `reasons` explicite : « trivialité prouvée :
   … » ou « aucun signal → simple (défaut descendant) ».
3. **Frontières d'ambiguïté R2** (classificateur LLM, si activé) : elles
   deviennent 3 et 7 (±1) — `trivial` n'est plus atteignable par score.
4. `classify` reste pure/exportée, mêmes signaux, mêmes constantes de
   marqueurs.

## B. Ratchet de session (sidecar + les deux pages)

Principe : router CHAQUE tour Auto (heuristique, ~0 ms), avec un **plancher
de session qui ne descend jamais**.

1. **Sidecar — `router.route` gagne `minTier?: RouteTier`** : après
   classification (ou tier imposé R3), le tier effectif est
   `max(tierClassé, minTier)` selon l'ordre trivial < simple < moyen <
   complexe (exporter `TIER_ORDER`). `reasons` mentionne « plancher de
   session : ‹minTier› » quand le plancher l'a emporté. Compatible avec le
   param `tier` imposé (R3) : `tier` prime, puis minTier s'applique aussi.
2. **UI (ChatPage + AgentPage, patrons jumeaux)** : en Auto, CHAQUE tour
   appelle `router.route` avec le texte du message et
   `minTier = routedTier` (le plancher persisté ; absent au 1er tour).
   La sémantique de `routedTier` devient « plancher de session » :
   mis à jour à la hausse uniquement, au premier signe de succès du tour
   (mécanique `commitAffinity` R6-B réutilisée : commit
   `max(plancher, tierUtilisé)`). `routedTarget` garde la dernière cible
   utilisée (affichage/repli). Un tour débordé/bloqué ne monte pas le
   plancher (règle R3 conservée).
   - Le changement de modèle en cours de session est donc possible **à la
     hausse uniquement** — c'est voulu (le coût cache est accepté pour la
     qualité) ; le badge continue d'afficher tier → modèle à chaque tour.
   - Override manuel : efface plancher + cible (comportement R6-B) ;
     revenir sur Auto repart sans plancher.
   - Le repli « provider absent → tier supérieur » (R1) et la
     re-vérification débord (R3) restent inchangés, appliqués à la cible
     du tier effectif.
3. **ui/src/sidecar.ts** : param `minTier` typé.

## C. Stratégie descendante — page Projets (AgentPage)

En Auto sur la page Projets, PAS de classification du prompt :

1. **Premier tour d'une session Auto : tier = `complexe`** (sommet de la
   table — Fable par défaut). Appel `router.route` avec `tier: "complexe"`
   imposé (mécanique R3 existante) → la table, le débord et le plafond
   s'appliquent normalement. Badge : `⚡ auto : descendant → <modèle>`.
2. **Aucune descente automatique** : la session reste au sommet (affinité
   existante). Descendre = choix manuel de l'utilisateur (sélecteur), comme
   aujourd'hui. Le plancher/ratchet du §B ne s'applique pas à ce flux (il
   est déjà au sommet).
3. ChatPage n'est PAS concernée par §C : elle applique §A+§B (montante).
4. Les textes d'aide/libellés distinguent les deux stratégies (aide du
   sélecteur Projets : « Auto (descendant) : démarre sur le modèle le plus
   fort de la table » ; Chat : « Auto (montant) : commence bas, monte selon
   la complexité »).

## Tests (sidecar/test/protocol.test.js — ajuster les cas existants, ajouter)

- `classify` : « Salut, ça va ? » → trivial (motif) ; « ok merci » →
  trivial ; « j'ai un problème avec mon appli » → **simple** (score 0 sans
  motif) ; « Explique pourquoi ce test échoue » → simple (score 2) ;
  code+édition (score 5) → **moyen** ; score ≥ 7 → complexe. Mettre à jour
  les assertions de scores/tiers existantes en conséquence (rr1 : « Salut,
  ça va ? » reste trivial ; rr2/rr3 : tiers selon nouveau mapping).
- `router.route` avec `minTier: "moyen"` et texte trivial → tier moyen +
  raison plancher ; avec tier classé complexe et minTier simple → complexe.
- Ambiguïté R2 : un score 2 (= 3−1) déclenche le classificateur quand il
  est activé (cas rr-llm existant : vérifier qu'il reste valide).

## Docs

`docs/protocol.md` : barème descendant (mapping, trivial sur preuve,
frontières 3/7), param `minTier`, sémantique plancher de `routedTier`.
`docs/etude-routage-llm.md` §10 : marquer A+B implémentés (date).

## Critères d'acceptation

- [ ] `npm run sidecar:test` + `npm run ui:build` verts.
- [ ] Un message sans signal part sur Sonnet (simple), plus jamais sur
      Haiku par défaut ; Haiku reste atteint sur salutations/acquiescements.
- [ ] Une session Chat montée en moyen ne redescend jamais, même si le
      message suivant est « ok merci ».
- [ ] Page Projets en Auto : le premier tour part sur le modèle du tier
      `complexe` de la table (Fable par défaut), quel que soit le texte du
      prompt ; débord/plafond s'appliquent ; aucune descente automatique.
- [ ] Comportement inchangé hors Auto.
