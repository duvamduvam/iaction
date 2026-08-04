# Étude — routage LLM & économie de tokens (LiteLLM et alternatives)

Statut : **validée au grill le 2026-07-27 — IMPLÉMENTÉE (R0→R5 livrés le
2026-07-28**, specs `docs/spec-r*.md`, feuille de route Lot 14 dans
`docs/plan.md`) ; points restants ouverts listés au §9.
Question d'origine : « améliorer le système avec LiteLLM afin d'optimiser le
choix du LLM et économiser des tokens ».

## 1. Objectif et critère de réussite

Deux objectifs distincts (souvent confondus) :

1. **Optimiser le choix du LLM** : envoyer chaque requête au modèle le moins
   cher qui suffit — question simple → petit modèle local gratuit, tâche
   complexe → gros modèle.
2. **Économiser des tokens** : réduire ce qu'on envoie (contexte, cache,
   redites), quel que soit le modèle choisi.

**C'est réussi quand (grill 2026-07-27)** :
- la **part des tours à coût marginal nul** (Ollama local + abonnement)
  augmente, mesurée dans Supervision ;
- l'**abonnement Claude est exploité en étages** : les tâches simples partent
  sur Haiku, les moyennes sur Sonnet, seul le lourd va à Fable/Opus — les
  fenêtres 5 h/7 j saturent moins.
- Cible chiffrée : fixée **après une baseline de 2 semaines** (voir §7, B0).

Contrainte structurante : **la structure de coûts de l'app est atypique**.

| Fournisseur | Coût marginal d'un token | Conséquence pour le routage |
|---|---|---|
| Abonnement Claude (Agent SDK, OAuth) | **0 €** (forfait) — mais fenêtres 5 h/7 j plafonnées, pondérées par modèle | étager Haiku→Sonnet→Fable/Opus pour préserver les fenêtres |
| Ollama local | **0 €** (électricité) | à privilégier pour le simple |
| OpenRouter / API à clé | **payant au token** | débord uniquement, plafonné |

Donc « économiser » ici ≠ « payer moins cher au token » (le réflexe des
passerelles du marché) mais : **maximiser les deux ressources à coût marginal
nul — dont l'étage interne de l'abonnement — et n'envoyer au payant que le
débord nécessaire**.

Seconde contrainte : **l'abonnement Claude ne peut transiter par AUCUNE
passerelle externe** (LiteLLM, Portkey, etc.). L'auth OAuth est liée à la
chaîne Claude Code/Agent SDK, et les CGU Anthropic interdisent son
exploitation par des intermédiaires (déjà acté au plan, décisions ouvertes).
Toute solution de type gateway ne verrait donc que le trafic « moteur
neutre » — alors que les deux arbitrages les plus rentables (abo ↔ local ↔
payant, et Fable→Haiku *dans* l'abo) se jouent au-dessus ou à l'intérieur du
moteur Claude.

## 2. Existant sur lequel on s'appuie

| Brique | État | Rôle dans le routage |
|---|---|---|
| Moteur neutre (`engine.ts`) | livré | déjà une passerelle multi-fournisseurs OpenAI-compatible, streaming, zéro dépendance |
| Moteur Claude (Agent SDK) | livré | seul chemin vers l'abonnement ; choix du modèle par session ; jauges 5 h/7 j remontées |
| `usageStats.ts` (JSONL, Lot 8 S1) | livré | historique tokens/modèle/statut — base de la baseline B0 et de la mesure des gains |
| `modelCatalog.ts` | livré | tarifs $/M OpenRouter + repères de benchmark curatés |
| Agents YAML (`.iaction/agents/`) | livré (O1/O3) | champ `model:` par agent — accueil naturel d'un `model: auto` |
| Orchestrateur (`orchestrator.ts`) | livré | mélange déjà les moteurs par étape |
| Tâches planifiées (`taches.ts`) | livré | gros consommateur récurrent → bénéficiaire direct du routage |
| Étalonnage petits modèles (Lot 6) | fait | qwen3.5:4b validé sur tâches d'agent simples |

Constat : **l'app EST déjà une gateway multi-fournisseurs** avec télémétrie.
Ce qui manque, c'est uniquement la **décision** (quel moteur/modèle pour
cette requête) et les **leviers d'économie de contexte**.

## 3. Options étudiées

### Option A — Routeur natif dans le sidecar

Un module `router.ts` : pré-classification de la requête → choix
moteur+modèle. Trois étages activables progressivement :

1. **Heuristique locale** (zéro appel réseau, < 1 ms) : longueur, présence de
   code, marqueurs de raisonnement, pièces jointes, profondeur d'historique.
2. **Classificateur LLM local gratuit** (qwen3.5:4b via Ollama) : classe
   low/medium/high quand l'heuristique hésite — le pattern déjà
   identifié au plan (axe 8).
3. **Routage informé par l'état** : jauges abonnement (fenêtre saturée →
   bascule), disponibilité Ollama (`ollama.ps`), crédits OpenRouter.

- ✅ Seule option qui arbitre **entre les deux moteurs** ET **dans l'étage
  interne de l'abonnement** (Fable→Haiku) — là où est le gisement.
- ✅ Zéro service externe, zéro dépendance ; rien à packager en plus.
- ✅ S'appuie sur la télémétrie existante ; gains mesurables dans Supervision.
- ❌ Heuristiques et seuils à écrire et régler soi-même ; fallback
  inter-fournisseurs à écrire (petit).

### Option B — LiteLLM Proxy (+ Auto Router v2)

Serveur Python auto-hébergé, passerelle OpenAI-compatible vers 100+
fournisseurs. Se déclarerait comme UN provider du moteur neutre. Fonctions
pertinentes : **Auto Router v2** (`auto_router/complexity_router`,
classification par tiers — heuristique 7 dimensions, classificateur LLM ou
règles sémantiques — pools par tier, Thompson sampling, affinité de
session), fallbacks par chaîne, budgets par clé virtuelle, cache exact et
sémantique (Redis), suivi des dépenses (Postgres). Ollama supporté.

- ✅ Fonctions mûres ; l'objection « LiteLLM ne route pas par complexité »
  n'est plus vraie depuis Auto Router v2.
- ❌ **Ne voit ni l'abonnement Claude ni son étage interne** : les deux
  arbitrages rentables lui échappent par construction.
- ❌ **Service Python à opérer** (venv/docker, Redis, Postgres) : dette
  d'exploitation permanente, à documenter/packager si l'app est diffusée.
- ❌ **Recouvrement fort** : duplique passerelle, suivi d'usage, config
  providers ; deux sources de vérité pour clés, tarifs, historique.

### Option C — Fonctions de routage natives d'OpenRouter (quasi gratuit à activer)

- **`models: [a, b, c]`** : fallback par priorité (rate-limit, contexte,
  indispo) — une ligne dans `engine.ts`.
- **Routage fournisseur** : `sort: "price"` / suffixe **`:floor`** (moins
  cher), `:nitro` (débit) ; éviction automatique des providers en panne.
- **Auto Router (bêta)** `openrouter/auto` : choisit « le meilleur » modèle,
  PAS le moins cher — contre-indiqué pour notre objectif.
- **Cache de prompts** relayé (`cache_control` Anthropic notamment).

- ✅ Effort minimal, aucun service, gains immédiats sur la part payante.
- ❌ Ne concerne QUE le trafic OpenRouter.

### Option D — Portkey Gateway (écarté)

Gateway TypeScript (la seule embarquable dans le sidecar Node), Apache 2.0
depuis mars 2026. Écartée : rachat par Palo Alto Networks (mai 2026,
intégration Prisma AIRS) = trajectoire incertaine ; et mêmes angles morts
que LiteLLM (abonnement invisible, recouvrement).

### Option E — Leviers d'économie de tokens hors routage

1. **Élagage/résumé d'historique** sur les longues sessions (moteur neutre ;
   côté Claude, la chaîne Agent SDK a déjà sa compaction automatique).
2. **Cache de prompts** : SDK côté Claude ; à relayer côté OpenRouter ;
   ordonner les messages pour maximiser les hits (stable en tête).
3. **Connaissances : RAG au lieu d'injection intégrale** (piste flexibilité
   n° 2 du plan) : coût par question au lieu de coût par session
   proportionnel au corpus.
4. **Tâches planifiées** : `model: auto` + plafond par run.

## 4. Comparatif synthétique

| Critère | A. Routeur natif | B. LiteLLM Proxy | C. OpenRouter natif | D. Portkey |
|---|---|---|---|---|
| Choix du modèle par complexité | ✅ (à écrire) | ✅ Auto Router v2 | ⚠️ `auto` non aligné coût | ⚠️ conditionnel |
| Arbitrage abo ↔ local ↔ payant | ✅ **seule option** | ❌ | ❌ | ❌ |
| Étage intra-abonnement (Fable→Haiku) | ✅ **seule option** | ❌ | ❌ | ❌ |
| Couvre Ollama local | ✅ | ✅ | ❌ | ✅ |
| Fallback auto inter-fournisseurs | ⚠️ à écrire (petit) | ✅ | ✅ (intra-OpenRouter) | ✅ |
| Cache sémantique | ❌ (hors périmètre) | ✅ (Redis) | ❌ | ✅ |
| Cache de prompts | via SDK + OpenRouter | relayé | ✅ | relayé |
| Budgets/plafonds | ⚠️ à écrire (S1 aide) | ✅ | crédits API | ✅ |
| Infra supplémentaire | **aucune** | Python (+Redis/Postgres) | **aucune** | service Node/edge |
| Recouvrement avec l'existant | aucun | fort | aucun | fort |
| Conformité produit diffusable | ✅ | ❌ | ✅ | ⚠️ rachat Palo Alto |
| Effort initial | ≈ 1 lot | ≈ ½ lot + dette d'ops | ≈ ¼ lot | — |

## 5. Analyse

- Le **gisement d'économie n° 1** est l'arbitrage entre trois ressources dont
  deux sont à coût marginal nul — plus l'étage interne de l'abonnement. Ces
  arbitrages se jouent au-dessus des deux moteurs, là où aucune passerelle du
  marché ne peut se placer. Seul un routeur natif (A) les couvre.
- LiteLLM (B) est un bon produit, mais appliqué ici il optimiserait la
  mauvaise strate (le sous-ensemble payant), au prix d'un service Python à
  vie. **Critère de réveil** : l'app devient multi-utilisateurs avec besoin
  de clés virtuelles/budgets par personne — réévaluer B ce jour-là.
- Les réglages OpenRouter (C) sont des fruits mûrs.
- Les leviers hors routage (E) pèsent autant que le routage sur les longues
  sessions ; indépendants et cumulables.

## 6. Décisions (grill du 2026-07-27)

### Orientation

**A + C + E, sans LiteLLM** (réveil de B seulement si multi-utilisateurs).

### Politique de routage — table par défaut « Local d'abord »

| Tier | Destination | Note |
|---|---|---|
| TRIVIAL | Ollama qwen3.5:4b | 0 €, ne touche pas les fenêtres |
| SIMPLE | Claude **Haiku** (abo) | quota de fenêtre quasi nul |
| MOYEN | Claude **Sonnet** (abo) | |
| COMPLEXE | Claude **Fable/Opus** (abo) | agentique lourd |
| DÉBORD | OpenRouter (deepseek/qwen premium) | uniquement si fenêtres saturées |

Classification : heuristique d'abord (gratuite, < 1 ms), classificateur qwen
local si ambigu ; Ollama indisponible → heuristique seule.

- **Portée** : table par défaut **globale** (config Configuration),
  **surcharge par projet** dans `.iaction/` (le projet prime) — même patron
  que le registre d'apps.
- **Débord** : bascule **automatique + bandeau** « mode débord — abo
  saturé » au-delà d'un seuil réglable (défaut ~90 % de la fenêtre 5 h).
- **Garde-fou débord** : **plafond mensuel configurable + coupure** sur le
  trafic routé automatiquement en payant (atteint → retour local ou attente,
  bandeau explicite). Le payant choisi *manuellement* n'est jamais bloqué.

### Flux routés

Les **quatre flux LLM** : Chat, Agent Projets, Orchestrations/agents YAML,
Tâches planifiées. Un `model:` explicite dans un agent YAML **prime
toujours** sur `auto`. La conversation vocale suit le flux Chat pour sa
partie LLM (transcription/TTS hors périmètre).

### `model: auto`

- **Défaut sur la page Chat** ; **opt-in** pour les sessions Agent Projets
  (disponible dans le sélecteur).
- **Affinité de session** : une session engagée sur un modèle y reste
  (préserve les caches) ; le routage se décide à l'ouverture ou sur nouvelle
  session.
- **Transparence** : badge du modèle effectivement choisi sur chaque tour ;
  **override à un clic**.

### Économie de contexte

- **Résumé auto d'historique par modèle local** (moteur neutre) : au-delà
  d'un seuil (à étalonner, ordre de grandeur ~30 tours ou ~60 % du contexte
  du modèle cible), les anciens tours sont résumés par qwen local en bloc
  compact ; les N derniers tours restent intégraux. Côté Claude : compaction
  SDK existante, harmoniser l'affichage.
- **Cache de prompts** : relais OpenRouter (R0), ordonnancement
  cache-friendly des messages (R4).
- **RAG local intégré au chantier en R5** (reprend la piste flexibilité
  n° 2 : embeddings Ollama `nomic-embed-text` + index SQLite + outil
  `search_knowledge` dans les DEUX moteurs).

### Mesure

- **B0 — baseline 2 semaines** à partir de `usageStats` (données déjà
  historisées) : part locale/abo/payant, mix intra-abo, saturations. La
  **cible chiffrée est fixée après la baseline** (ex. attendu : doubler la
  part à coût nul).
- **Encart « Routage » dans Supervision** : répartition des tours par tier,
  tokens gratuits vs payants, mix Haiku/Sonnet/Fable, gains estimés (tarif
  du modèle évité) **présentés comme estimations** (même règle que
  `BENCH_DISCLAIMER`).

## 7. Phasage (validé, ordre R0→R5 ; chaque phase utile seule)

| Phase | Contenu | Taille |
|---|---|---|
| **B0** | Baseline : calcul de la répartition actuelle depuis `usageStats` (script ou encart), 2 semaines d'usage réel — **démarrable immédiatement, en parallèle** | ~0 |
| **R0** | Réglages OpenRouter dans `engine.ts` : `models` (fallback), `sort`/`:floor` opt-in par provider, relais cache de prompts | ¼ lot |
| **R1** | `router.ts` sidecar : heuristique + table tiers→(moteur, provider, modèle) globale ; `model: auto` défaut au Chat ; badge du choix + override | 1 lot |
| **R2** | Classificateur qwen local pour les cas ambigus ; `model: auto` dans agents YAML, Projets (opt-in) et tâches planifiées ; surcharge de table par projet | ½ lot |
| **R3** | Routage informé par l'état : seuil fenêtre 5 h → débord + bandeau, plafond mensuel + coupure, Ollama down → repli ; encart « Routage » dans Supervision ; **fixation de la cible chiffrée** (post-B0) | ½ lot |
| **R4** | Économie de contexte : résumé auto d'historique par modèle local (moteur neutre), ordonnancement cache-friendly | 1 lot |
| **R5** | RAG local : embeddings Ollama + index SQLite + `search_knowledge` dans les deux moteurs, remplace l'injection intégrale des connaissances | 1 lot+ |

Réévaluation possible après chaque lot ; feuille de route mise à jour dans
`docs/plan.md` (Lot 14).

**B0 — script livré le 2026-07-27** (`scripts/usage-baseline.mjs`, lecture
seule, zéro dépendance). Premier relevé sur l'historique disponible
(2026-07-19 → 2026-07-27, 165 tours) :

- part à coût marginal nul : **96 %** (abo 96 %, local **0 %**, payant 4 %) ;
- mix intra-abonnement : **Opus 48 % + Fable 42 % = 90 % des tours abo** ;
  Haiku 8 %, Sonnet 1 % — l'étage est aujourd'hui inversé ;
- fenêtre 5 h : **touchée à 100 %** (p95 = 83 %) ; fenêtre 7 j : max 83 %.

Lecture : le gisement n'est PAS la part payante (déjà marginale) mais
1) l'étage intra-abo (descendre le simple vers Haiku/Sonnet) et 2) l'usage
local (aujourd'hui nul). Cela conforte le critère de réussite du grill ; la
cible chiffrée sera fixée après 2 semaines de relevés post-R1.

## 8. Risques & garde-fous

- **Routage trop agressif → réponses médiocres** : badge + override à un
  clic ; `model:` explicite prime ; seuils réglables ; étalonnage sur tâches
  réelles (méthode Lot 6). Auto par défaut limité au Chat (enjeu faible).
- **Classificateur qui coûte plus qu'il ne rapporte** : étage 1 heuristique
  (gratuit) ; étage LLM local (gratuit), déclenché sur ambiguïté seulement.
- **Surcoût débord silencieux** : plafond mensuel + coupure (décidé §6) ;
  bandeau à chaque bascule.
- **Résumé d'historique qui perd une info critique** : N derniers tours
  toujours intégraux ; résumé consultable/éditable ; seuils à étalonner
  avant d'en faire un défaut.
- **Session cassée par un changement de modèle en cours** : affinité de
  session (décidé §6).
- **Mesure malhonnête** : gains affichés = estimations, marquées comme
  telles.

## 9. Points restants ouverts

| Point | Option par défaut proposée | À trancher |
|---|---|---|
| Montant du plafond mensuel de débord | 10 €/mois | avant R3 |
| Seuil de bascule débord | 90 % fenêtre 5 h | réglable, étalonner en R3 |
| Modèle(s) exact(s) de débord OpenRouter | deepseek/qwen premium, liste `models` de fallback | R1 (table) |
| Cible chiffrée de réussite | ex. doubler la part à coût nul | après B0 (2 semaines) |
| Seuils du résumé d'historique | ~30 tours ou ~60 % contexte | étalonner en R4 |
| Pondération exacte des fenêtres abo par modèle (Haiku vs Opus) | à mesurer via jauges SDK | B0/R3 |

## 10. Routage descendant « top-down » (étude du 2026-07-29)

**Constat d'usage** (2 jours après mise en service, table tout-abonnement) :
100 % des tours routés en Auto sont classés `trivial` → Haiku (5/5 au
journal) ; réponses jugées moins bonnes, plus d'interactions de recadrage.
Les tours Opus/Fable de la période sont tous des choix manuels — le routeur
n'envoie personne vers le haut.

**Diagnostic — trois causes structurelles, pas un problème de seuils :**

1. **Barème ascendant** : le score part de 0 (= trivial) et il faut
   *accumuler* des preuves pour monter. Un message court mais difficile
   (« pourquoi l'orchestrateur perd les permissions ? ») n'a aucun signal
   formel → trivial. L'absence de preuve de complexité est traitée comme
   preuve de trivialité.
2. **Affinité au premier message** : le routage n'a lieu qu'au 1er envoi,
   et les 1ers messages sont typiquement courts (« salut, j'ai un souci
   avec X ») → toute la conversation hérite de Haiku.
3. **Asymétrie des coûts d'erreur inversée** : avec un abonnement Max,
   sous-classer coûte cher (qualité, allers-retours — vécu), sur-classer ne
   coûte presque rien (un peu de fenêtre 5 h). Le barème actuel minimise le
   mauvais risque : il a été conçu à l'époque « local d'abord » où chaque
   montée coûtait de l'argent.

**Principe top-down : inverser la charge de la preuve.** Fort par défaut,
déclassement seulement sur preuve positive de trivialité — et une session ne
redescend jamais.

| Option | Contenu | Effort |
|---|---|---|
| **A. Barème inversé** | Sans signal → `simple` (Sonnet) minimum. `trivial` réservé aux preuves positives (salutation, remerciement, question factuelle ≤ 1 phrase sans code ni référence projet). Les signaux existants (code, raisonnement, édition, longueur, pièces jointes) font monter comme aujourd'hui. | petit (barème seul, même infra, tests à ajuster) |
| **B. Ratchet de session** | Router CHAQUE tour (plus seulement le 1er) ; l'affinité devient un plancher : la session monte au max des tiers vus, ne redescend jamais (cohérent avec l'affinité-cache : on ne change de modèle qu'à la hausse). Règle le piège du 1er message court. | petit-moyen (ChatPage/AgentPage + router) |
| **C. Signaux de recadrage** | Détection des marqueurs d'insatisfaction (« non », « pas ça », reformulation rapide, message < 30 s après la réponse) → escalade d'un tier. Réactif : l'interaction ratée a déjà eu lieu. | moyen |
| **D. Triage LLM abonnement (R7)** | Session Haiku résidente côté sidecar (Agent SDK) qui classe avec le CONTEXTE des derniers tours, prompt « dans le doute, classe au-dessus ». ~1-2 s, quota négligeable sur Max. | moyen (nouveau composant) |

**Recommandation : A + B** — zéro nouveau composant, réglable, et les deux
causes principales (barème et affinité) sont traitées à la racine. C (recadrage)
et D (LLM contextuel) ne se justifient que si A+B laissent encore des
misclassements fréquents au badge. Sous abonnement Max, viser :
`trivial` = exception prouvée, `simple` = régime de croisière, montée
franche dès le premier signal technique.

**Mise en œuvre — IMPLÉMENTÉ le 2026-07-31** (spec fermée
`docs/spec-r7-topdown.md`, révisée après retour utilisateur : deux
stratégies distinctes par flux, pas un seul barème) :

- **Chat = stratégie MONTANTE** (bottom-up amélioré, options A+B) : barème
  descendant dans `sidecar/src/router.ts` (simple ≤ 2 · moyen 3-6 ·
  complexe ≥ 7, `trivial` réservé aux preuves positives `TRIVIAL_PATTERNS`,
  frontières d'ambiguïté R2 → 3 et 7) ; ratchet de session via `minTier`
  de `router.route` (plancher `routedTier` routé à CHAQUE tour, relevé à
  la hausse uniquement par `commitAffinity`, effacé par l'override).
- **Projets = stratégie DESCENDANTE** (top-down) : premier tour Auto au
  sommet de la table (tier `complexe` imposé, aucune classification du
  prompt), aucune descente automatique ; débord/plafond appliqués.
- Restent ouverts : clé `strategie:` dans `.iaction/routage.yaml`
  (surcharge par projet), options C (signaux de recadrage) et D (triage
  LLM abonnement) — à réévaluer sur le journal.
- Routage des étapes d'orchestration sur texte RENDU : **IMPLÉMENTÉ le
  2026-07-31** — la résolution des étapes `engine: auto` a lieu au démarrage
  de chaque étape, après interpolation des `{{…}}` (débord/plafond
  re-vérifiés à ce moment-là) ; cible annoncée par `step_started`, voir
  docs/protocol.md « orch.run ».

## Sources (consultées le 2026-07-27)

- LiteLLM : [Auto Routing](https://docs.litellm.ai/docs/proxy/auto_routing) ·
  [Auto Router v2 (blog)](https://docs.litellm.ai/blog/autorouter-v2) ·
  [Fallbacks](https://docs.litellm.ai/docs/proxy/reliability) ·
  [Budgets](https://docs.litellm.ai/docs/proxy/users) ·
  [Load balancing](https://docs.litellm.ai/docs/routing-load-balancing)
- OpenRouter : [Model routing (blog)](https://openrouter.ai/blog/insights/model-routing/) ·
  [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) ·
  [Lowest-cost guide](https://openrouter.ai/blog/tutorials/how-to-get-the-lowest-cost-llm-inference-on-openrouter/) ·
  [Contrôler les coûts (FAQ)](https://openrouter.zendesk.com/hc/en-us/articles/51691947905051)
- Comparatifs gateways : [Portkey vs LiteLLM (API7)](https://api7.ai/portkey-vs-litellm) ·
  [LiteLLM vs Portkey vs OpenRouter (Requesty)](https://www.requesty.ai/blog/litellm-vs-portkey-vs-openrouter-best-llm-gateway-2026) ·
  [LLM routers compared (Developers Digest)](https://www.developersdigest.tech/blog/llm-router-comparison-2026)
