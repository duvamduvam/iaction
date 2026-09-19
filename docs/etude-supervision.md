# Étude — refonte de la Supervision

> Date : 2026-08-17. Mesures faites sur `usage/events.jsonl` (1083 tours,
> 19 juillet → 17 août 2026) et `usage/claude-windows.jsonl` (17 917
> instantanés). Aucune de ces mesures n'est une estimation : chacune est
> recalculable depuis les fichiers cités.
>
> Objet : la page Supervision montre ce qui était facile à compter, pas ce
> qui permet de décider. Cette étude établit ce qu'on sait, ce qu'on croit
> savoir à tort, et ce qu'il faudrait mesurer — sur quatre axes : **dépense**,
> **historique**, **sobriété**, **répartitions**.

## 0. Ce que la page montre aujourd'hui

Inventaire exhaustif de `SupervisionPage.tsx` (705 lignes) :

| Bloc | Contenu |
|---|---|
| Bandeau KPI | Conversations · Tours (dont orchestration) · Contexte moyen · Tokens totaux |
| Courbes | Les 4 mêmes indicateurs, indexés chacun sur son propre pic |
| Usage par projet | Part des tokens, dont part « autonome » (orchestration) |
| Modèles les plus utilisés | Tours + tokens par modèle |
| Routage | Tours auto · Part à coût nul · Dépense de la période · Débord du mois · Répartition par tier · Mix intra-abonnement |
| Abonnement Claude | Utilisation hebdomadaire |

Six blocs, quatre indicateurs de fond. Le reste de l'étude montre que ces
quatre indicateurs comptent mal, et qu'il en manque une famille entière.

## 1. L'axe DÉPENSE est aveugle, et il le dit mal

### 1.1 Le coût n'est pas renseigné sur 98 % des tours

`costUsd` et `cachedTokens` sont `null` sur **1063 des 1083 tours**. Seuls
les 20 tours OpenRouter portent un coût. Toute la consommation d'abonnement —
soit 96 % des tours — entre dans la carte « Dépense de la période » comme un
zéro.

Le libellé de la carte est honnête (`libelleDepense`, T-035/T-036 : « au
moins — N tours sans coût remonté »), mais l'honnêteté d'un minorant ne
remplace pas la mesure. Or **la donnée existe** : le message `result` du SDK
Agent porte `modelUsage: Record<string, ModelUsage>`, et `ModelUsage`
contient `costUSD` en plus de `inputTokens`, `outputTokens`,
`cacheReadInputTokens`, `cacheCreationInputTokens` et `contextWindow`
([sdk.d.ts:1246-1255](../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts#L1246)).
Ce champ est dans le message parsé à
[claude.ts:1050](../sidecar/src/claude.ts#L1050), et jeté.

### 1.2 « Part à coût nul : 98 % » est un indicateur qui ment par omission

`applyRoutageEvent` classe tout tour `engine: claude` comme « coût nul »
([usageStats.ts:538-543](../sidecar/src/usageStats.ts#L538)). C'est vrai pour
le portefeuille et faux pour la ressource : sur un abonnement, la rareté ne
se compte pas en dollars mais en **quota**. Un indicateur qui affiche 98 % de
gratuité pendant que la fenêtre 5 h sature est pire qu'absent — il rassure.

### 1.3 La vraie monnaie est le quota, et son historique existe déjà

`claude-windows.jsonl` contient 17 917 instantanés sur 30 jours, avec trois
fenêtres : `five_hour`, `seven_day`, et une fenêtre à nom de code
(`nimbus_quill`, 2705 relevés) — le sidecar relaie déjà toutes les clés sans
présumer du nommage, ce qui était la bonne décision.

Ce que cet historique dit, et que la page ne montre pas :

- pic `five_hour` : **104 %** · pic `seven_day` : **100 %** ;
- la fenêtre 5 h a dépassé 80 % sur **13 jours sur 30** ;
- la fenêtre 7 jours a dépassé 80 % sur 6 jours, dont trois d'affilée.

La page affiche une seule chose de tout cela : « utilisation hebdomadaire ».
La ressource qui sature réellement est mesurée toutes les quelques secondes,
archivée sur un mois, et résumée par un chiffre instantané.

## 2. L'axe RÉPARTITIONS compte le mauvais grain

### 2.1 Un tour = un modèle : c'est faux depuis qu'il y a des sous-agents

Un seul événement d'usage est émis par `claude.start`, avec
`model: lastModel` et des tokens qui sont le **cumul de tout le process**
([claude.ts:1112-1122](../sidecar/src/claude.ts#L1112)). Quand un tour sur
opus délègue à des sous-agents, leur travail est compté — mais rangé sous
opus.

La carte « Modèles les plus utilisés » n'est donc pas une répartition par
modèle : c'est une répartition par **modèle du fil principal**, tokens des
sous-traitants inclus. Elle ne rate pas la délégation, elle la déguise.

Cause structurelle, et elle est en amont : IAction ne passe jamais l'option
`agents` au SDK. Sans `model` déclaré, un sous-agent hérite du modèle du fil
(« If omitted or 'inherit', uses the main model »,
[sdk.d.ts:56-58](../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts#L56)).
Il n'y a donc, aujourd'hui, rien d'autre à voir que le modèle du fil — la
métrique est fidèle à une réalité qu'il faut changer.

### 2.2 Répartition constatée

Sur 8,9 Mtok :

| Étage | Réel | Cible (skill `sobriete`) |
|---|---|---|
| Haut de table (opus-4-8 38,5 % + fable-5 15,1 % + opus-5 7,0 %) | **60,6 %** | 10–20 % |
| claude-sonnet-5 | **1,1 %** | 50–60 % |
| claude-haiku-4-5 | 0,7 % | 5–10 % |
| Local + gratuit | ~31 % | 20–30 % |

Le local tient son rang. L'étage « implémentation » est vide.

### 2.3 Le routeur n'est presque jamais consulté

`routeTier` est renseigné sur **47 tours sur 1083 (4,3 %)**. Sur la page
Projets — 897 tours, le gros du travail — il l'est sur **3**. Quand le
routeur décide, il choisit sonnet dans 35 cas sur 47 : l'encart « Répartition
par tier » décrit donc 4 % de l'activité et laisse croire qu'il en décrit la
totalité.

## 3. L'axe HISTORIQUE : la granularité est là, les grandeurs ne le sont pas

L'arithmétique de période (`supervisionPeriode.ts`) est saine et testée :
semaines ISO, bornes étendues aux buckets entiers, troncature à la période en
cours. Deux défauts, tous deux d'affichage :

- **Les étiquettes de bout de courbe se superposent** quand les quatre séries
  convergent vers le bas de la fenêtre. `desempiler` pousse chaque étiquette
  vers le bas puis la borne à `max`
  ([supervisionCourbesCalc.ts:56-65](../ui/src/supervisionCourbesCalc.ts#L56)) :
  quand la place manque, plusieurs atterrissent sur la même ligne. Le cas se
  produit à chaque début de période — c'est-à-dire régulièrement.
- **Rien ne signale qu'une période est incomplète.** Le lundi, la vue Semaine
  affiche exactement les chiffres de la vue Jour, sans dire qu'un jour sur
  sept est écoulé. Constat utilisateur du 2026-08-17.

Manque par ailleurs toute notion de **comparaison** : pas de période
précédente, pas de rythme de consommation, pas de projection de fin de
fenêtre de quota.

## 4. L'axe SOBRIÉTÉ n'existe pas encore

Aucun des six blocs ne répond à « est-ce que je délègue au bon niveau ? ».
Les données manquantes, par ordre d'importance :

| Donnée | État | Conséquence |
|---|---|---|
| Ventilation par modèle réellement appelé | jetée (`modelUsage`) | La délégation est invisible |
| Coût par modèle | jeté (`costUSD`) | Aucune dépense mesurable sur abonnement |
| Cache lu / créé | jamais enregistré | Le contexte re-payé est invisible |
| Contexte réel | calculé puis abandonné (`extractContextTokens`, [claude.ts:252](../sidecar/src/claude.ts#L252)) | Le KPI « Contexte moyen » a une médiane de **6 tokens** — il ne mesure rien |
| Statut du tour | enregistré, jamais agrégé | 38 tours en erreur (3,5 %) n'apparaissent nulle part |
| Durée d'un tour | **jamais enregistrée** | Aucune métrique de latence possible |

Le taux d'erreur mérite un mot : il est de **5,0 % sur fable-5**, 3,3 % sur
opus-4-8, et **0 % sur sonnet-5** (44 tours). Le gros modèle n'achète pas la
fiabilité qu'on lui prête.

## 5. État de l'art

Recherche menée le 2026-08-17 sur trois fronts : les plateformes
d'observabilité LLM, les outils de coût des agents de code, et la littérature
sur le routage et l'efficience. Sources en fin de section.

### 5.1 Ce que les autres font mieux

**L'attribution par sous-agent existe, et elle est chez Anthropic.** La
commande `/usage` de Claude Code affiche, sur les plans Pro/Max, une section
« Attribution » : part de l'usage récent imputée à chaque *skill*, *subagent*,
*plugin* et serveur MCP, en pourcentage. Plus une section « Behavior flags »
qui signale un comportement (contexte long, cache miss) dès qu'il dépasse
10 % de l'usage récent. C'est calculé localement, sur 24 h / 7 j glissants.
**Aucun autre outil du panel ne descend à ce niveau** — ni ccusage, ni Cursor,
ni OpenRouter, ni Aider, ni Cline. La direction visée en §2.1 est donc la
bonne, et elle est déjà validée par l'éditeur du SDK qu'on utilise.

**Le bon modèle de ventilation est celui de LangSmith** : la doc décrit trois
niveaux affichés *simultanément* — coût par run enfant, agrégat par run
parent, total sur la trace. Pas « soit le détail, soit le total ». Phoenix
documente le même rollup à trois étages (span → trace → projet). C'est le
patron à copier : un sous-agent garde son coût propre visible, **et** il
remonte au tour parent.

**Le burn rate et la projection de fin de fenêtre** (`ccusage blocks`) : taux
de combustion en tokens/minute sur le bloc de 5 h en cours, et extrapolation
du total si le rythme se maintient. Simple à calculer, et c'est exactement la
question qu'on se pose devant une fenêtre à 80 % : « est-ce que je tape le mur
avant ce soir ? »

**Le triptyque de `claude-usage-tracker`** (outil tiers local, agrégateur
multi-outils) : graphique empilé par source, donut par modèle, **grille
heure × jour**, plus une vue groupée par répertoire de travail. C'est l'outil
le plus proche en esprit de notre page.

**Le vocabulaire est normalisé, autant le prendre.** Les conventions
sémantiques OpenTelemetry GenAI définissent `gen_ai.usage.input_tokens`,
`output_tokens`, `cache_creation.input_tokens`, `cache_read.input_tokens`,
`reasoning.output_tokens`, et une hiérarchie de spans `invoke_agent` →
`chat` / `execute_tool`. Deux réserves utiles : elles sont encore
expérimentales, et **aucun attribut de coût en dollars n'est normalisé** — le
calcul de prix est explicitement laissé aux outils.

**Le piège du tag manquant, documenté deux fois.** LangSmith (un run enfant
sans `thread_id` disparaît silencieusement de l'agrégat) et Traceloop (idem
pour `user_id`) documentent indépendamment la même panne. Transposé chez
nous : l'identifiant de projet/conversation doit être posé **structurellement
sur chaque appel, sous-agents compris**, jamais au mieux — sinon la page
sous-compte sans erreur visible. C'est précisément l'échec muet que la
doctrine d'observabilité interdit.

**L'ordre de lecture qui revient** (Portkey, et 3 plateformes sur 8) :
vue de synthèse d'abord (coût, tokens, requêtes, top modèles), ventilations
ensuite, cache comme onglet de premier ordre.

### 5.2 Ce que personne ne fait — et qui nous concerne directement

C'est la partie la plus utile de la recherche : quatre trous nets.

1. **Personne n'affiche un ratio petits modèles / gros modèles** comme
   indicateur de sobriété. Le routage est prescrit en amont par des dizaines
   d'outils ; rien ne vérifie a posteriori qu'il a été tenu.
2. **Personne ne combine trois devises dans une seule vue** : forfait
   (abonnement Claude), tarif réel (OpenRouter), gratuit (Ollama). Chaque
   outil vit dans son silo de facturation. On a les trois en même temps.
3. **Le taux de cache n'est jamais un pourcentage de tête** — partout des
   tokens bruts en second rang. `/usage` s'en approche avec un drapeau binaire
   à 10 %.
4. **Aucune comparaison période à période structurée** au-delà d'un « delta
   d'hier » basique.

Sur le cas de l'abonnement forfaitaire, le constat est unanime : aucun outil
ne fait mieux qu'un **coût équivalent API au tarif catalogue** (ccusage,
`/usage`, Turnlens). `/usage` montre bien des barres de quota, mais sans les
relier au coût équivalent. Personne ne réunit « % de quota consommé » +
« coût équivalent si c'était de l'API » + « rythme projeté » dans une vue
cohérente.

### 5.3 Comment la littérature juge un routage

Le point commun de tous les travaux sérieux : **ne jamais publier un coût
seul**. Toujours un couple (coût, qualité), idéalement une courbe.

- **RouteLLM** (arXiv:2406.18665) définit le *Performance Gap Recovered* —
  quelle fraction de l'écart de qualité entre petit et grand modèle est
  récupérée — et assimile le coût au **pourcentage de requêtes envoyées au
  gros modèle**. C'est exactement notre métrique de §2.2, avec un nom
  académique.
- **RouterArena** (arXiv:2510.00202) ajoute la *routing optimality* : a-t-on
  choisi le modèle **correct le moins cher**, pas juste un modèle correct.
  Constat du papier, directement rassurant pour nous : **aucun routeur testé
  n'atteint l'oracle, et la faiblesse systématique est de sous-estimer quand
  un petit modèle suffit.** Nos 60 % ne sont pas une anomalie locale, c'est un
  biais connu et documenté.
- **FrugalGPT** (arXiv:2305.05176) formalise la cascade : interroger le moins
  cher d'abord, n'escalader que sur jugement d'insuffisance.
- **Unit economics** : le consensus FinOps-IA 2026 est que le *coût par appel*
  est trompeur, et que la métrique saine est **coût total / résultats
  acceptés** — les runs échoués comptent au numérateur, jamais au
  dénominateur. Un cas documenté montre un coût par tâche résolue dérivant de
  +40 % pendant que le coût par appel baissait de 25 %.
- **Amplification par retry** : un taux de retry de 20 % par étape ne coûte
  pas ×1,2 mais s'approche de ×2, par effet cumulatif.

Sur le **cache**, la formule standard est
`cache_read / (cache_read + cache_creation + input)`, et la tarification
Anthropic (écriture ×1,25, lecture ×0,1) rend le cache rentable dès la
première relecture. Un cas de production rapporté tournait à 7 % de taux de
cache pendant des mois sans que personne le voie — argument suffisant pour en
faire un indicateur de tête.

Sur l'**énergie**, verdict honnête : mesurable approximativement en local
(nvidia-smi, CodeCarbon, MELODI — avec le piège documenté que `nvidia-smi`
mesure tout le GPU, pas le process), et **structurellement impossible côté
API distante**. Tout chiffre affiché pour Claude ou OpenRouter serait une
estimation tierce (EcoLogits) non vérifiable. À écarter ou à étiqueter
explicitement comme estimation — jamais à présenter comme une mesure de même
nature qu'un comptage de tokens.

### 5.4 Ce qu'on écarte volontairement

| Écarté | Raison |
|---|---|
| Attribution par utilisateur / tenant | Mono-utilisateur. Remplacer « utilisateur » par « projet » partout |
| Architecture proxy (Helicone) | On orchestre déjà en local ; un relais réseau ajouterait une dépendance pour un gain nul |
| Tables de prix « 300+ modèles » synchronisées | Trois familles de sources suffisent, mapping statique à la main |
| Evals, scores, feedback (Braintrust, Weave, Phoenix) | Hors des quatre axes ; outillage d'équipe faisant du prompt engineering itératif |
| P50/P95/P99, TTFT, tokens/s | Métriques de serveur d'inférence à charge variable — sans objet sur un poste mono-utilisateur |
| Spec FOCUS | Spec de facturation cross-fournisseurs, pas de mesure de sobriété |
| Énergie des API distantes | Impasse assumée (§5.3) |
| APGR / sur-qualification mesurée | Demande un étiquetage de difficulté ou de l'A/B volontaire — axe ultérieur, pas un prérequis |

**Sources.** ccusage ([github.com/ryoppippi/ccusage](https://github.com/ryoppippi/ccusage)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
Claude Code costs ([code.claude.com/docs/en/costs](https://code.claude.com/docs/en/costs)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
claude-usage-tracker ([github.com/658jjh/claude-usage-tracker](https://github.com/658jjh/claude-usage-tracker)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
LangSmith cost tracking ([docs.langchain.com/langsmith/cost-tracking](https://docs.langchain.com/langsmith/cost-tracking)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
Langfuse ([langfuse.com/docs/observability/features/token-and-cost-tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
Phoenix ([arize.com/docs/phoenix/tracing/how-to-tracing/cost-tracking](https://arize.com/docs/phoenix/tracing/how-to-tracing/cost-tracking)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
Portkey ([portkey.ai/docs/product/observability/analytics](https://portkey.ai/docs/product/observability/analytics)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
OTel GenAI ([opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
OpenRouter Activity ([openrouter.ai/docs/guides/administration/activity-export](https://openrouter.ai/docs/guides/administration/activity-export)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
RouteLLM ([arXiv:2406.18665](https://arxiv.org/html/2406.18665v4)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
RouterArena ([arXiv:2510.00202](https://arxiv.org/html/2510.00202v1)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
FrugalGPT ([arXiv:2305.05176](https://arxiv.org/pdf/2305.05176)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
Prompt caching ([platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) · <!-- audit-publication:ok — source publique citée, pas une infra privée -->
EcoLogits ([ecologits.ai/latest/methodology/](https://ecologits.ai/latest/methodology/)). <!-- audit-publication:ok — source publique citée, pas une infra privée -->

## 6. Ce qu'il faut mesurer

### 6.0 Le socle — un seul changement débloque tout le reste

Aujourd'hui : **un événement par tour**, un modèle, deux compteurs de tokens.
Demain : **un événement par modèle appelé dans le tour**, portant son rôle.

```
{ ts, tourId, conversationId, projectId,      ← rattachement STRUCTUREL (§5.1)
  role: "fil" | "delegue",                    ← la ventilation qui manque
  model, engine, providerId,
  inputTokens, outputTokens,                  ← vocabulaire gen_ai.*
  cacheReadTokens, cacheCreationTokens,       ← jamais enregistrés à ce jour
  costUsd,                                    ← présent dans modelUsage
  contextTokens,                              ← extractContextTokens, déjà calculé
  durationMs,                                 ← jamais enregistré
  status, routeTier, orchRunId }
```

Tout vient de `modelUsage` dans le message `result`, déjà parsé. Trois règles
de fabrication, tirées de la recherche :

1. **Buckets mutuellement exclusifs** (Langfuse) : un token compté une seule
   fois. À normaliser à l'ingestion, car le format varie par fournisseur.
2. **Rattachement structurel** : `tourId`/`projectId` sur chaque ligne, y
   compris déléguée — le piège LangSmith/Traceloop (§5.1).
3. **Agrégat ET détail** (LangSmith) : le total du tour reste lisible, la
   ventilation ne le remplace pas.

### 6.1 Axe DÉPENSE — trois devises, une seule vue

C'est le trou du marché (§5.2). Trois compteurs, jamais additionnés :

| Indicateur | Source | Pourquoi |
|---|---|---|
| **Quota d'abonnement** — % des fenêtres 5 h / 7 j / hebdo-modèle | `claude-windows.jsonl`, déjà là | La vraie rareté. Remplace « Part à coût nul » (§1.2) |
| **Dépense réelle** — USD effectivement payés | `costUsd` OpenRouter | Le seul argent qui sort |
| **Coût équivalent API** — l'abonnement recalculé au tarif catalogue | `costUSD` de `modelUsage` | Ce que vaut le forfait, et ce que coûterait chaque étage de la pyramide |
| **Rythme et projection** — tokens/min sur la fenêtre en cours, extrapolation | dérivé | « Est-ce que je tape le mur avant ce soir ? » (ccusage blocks) |

Le mode de calcul du coût doit être **dit**, comme le fait ccusage : « prix
remonté par la source » ≠ « recalculé au tarif catalogue ». Confondre les deux
serait retomber dans le minorant silencieux de T-035.

### 6.2 Axe SOBRIÉTÉ — les six métriques

Règle de conception héritée de RouteLLM (§5.3) : **jamais un coût sans un
signal de qualité en regard.** Chaque indicateur d'économie est donc apparié.

| # | Métrique | Formule | Champs requis | Apparié à |
|---|---|---|---|---|
| M1 | **Pyramide de délégation** | part de chaque étage {gros, petit payant, mécanique, local/script} | `model`, tokens, prix | Taux d'erreur par étage |
| M2 | **Ratio orchestrateur / délégués** | tokens `role: fil` / tokens `role: delegue` | `role` | — |
| M3 | **Taux de délégation** | % de tours avec ≥ 1 appel `role: delegue` | `role`, `tourId` | — |
| M4 | **Taux de cache** | `cacheRead / (cacheRead + cacheCreation + input)` | champs de cache | Économie réalisée en USD |
| M5 | **Coût par tâche réussie** | coût total de la tâche, échecs inclus / tâches abouties | `tourId`, coût, succès | — |
| M6 | **Coût du re-travail** | tokens des tours `status: error` / tokens totaux | `status`, tokens | — |

Le pairage n'est pas cosmétique : nos propres chiffres montrent **5,0 %
d'erreurs sur fable-5 contre 0 % sur sonnet-5** (§4). Une pyramide affichée
seule inviterait à descendre partout ; affichée avec le taux d'erreur, elle
montre que descendre n'a, ici, rien coûté en qualité.

Les bornes cibles viennent du skill `sobriete` : gros 10–20 %, petit payant
50–60 %, mécanique 5–10 %, local et scripts 20–30 %.

**Ces six métriques sont passées au crible en §7 — quatre d'entre elles n'en
sortent pas indemnes.**

### 6.3 Axe RÉPARTITIONS — changer le grain, pas la liste

Les découpages existants sont bons ; c'est leur unité qui est fausse.

- **Par modèle réellement appelé**, plus « par modèle du fil » (§2.1).
- **Par rôle délégué** — le patron « Attribution » de `/usage` (§5.1).
- **Par projet** — à garder tel quel, c'est déjà juste.
- **Par tier de routage** — à garder, avec un **dénominateur honnête** :
  l'encart doit dire qu'il décrit 4 % des tours, pas laisser croire au tout.

### 6.4 Axe HISTORIQUE — trois manques, tous peu coûteux

- **Comparaison période à période** (% de variation par axe) — trou du marché,
  et pas cher : les buckets sont déjà calculés.
- **Grille heure × jour** — on a la donnée (pic à 22 h UTC), on ne la montre
  pas.
- **Saturation des quotas dans le temps** — jours au-dessus de 80 %, pics,
  au lieu du seul chiffre instantané (§1.3).
- **Marqueur de période incomplète** — « jour 1/7 », sans quoi Semaine et Jour
  s'affichent identiques sans explication (§3).

### 6.5 KPI complémentaires retenus

Arbitrés le 2026-08-17. Légende : ✅ calculable aujourd'hui · ⏳ après le socle
T-066 · 🔧 nouvelle instrumentation.

**Fiabilité** — le seul contrepoids honnête au coût.

| KPI | État | Valeur actuelle |
|---|---|---|
| Taux d'erreur par étage | ✅ | gros 3,6 % · sonnet 0 % · haiku 2,8 % |
| Taux d'abandon (`status: aborted`) | ✅ | 5 / 1083 = 0,5 % |
| Erreurs par cause | ✅ | `error_during_execution` : 18 |
| Tours atteignant `maxTurns` | ✅ | signe d'une tâche mal cadrée |
| Refus de permission, par outil | 🔧 | — |

Un constat en passant, tiré du calcul ci-dessus : sur les 38 tours en erreur,
**17 n'ont aucun message de cause**. Un échec enregistré sans sa raison est
précisément l'échec muet que la doctrine interdit — ticket T-076.

**Concentration du coût** — retenu parce qu'il dit *où* agir.

| KPI | État | Valeur actuelle |
|---|---|---|
| Part du coût dans les 10 % de tours les plus chers | ✅ | **41,4 %** (1 % → 11,0 %) |
| Coût moyen **par tour** et par projet | ✅ | Didier 1,198 $ · le projet le plus travaillé 0,410 $ |
| Part du quota consommée par étage de modèle | ⏳ | — |

Le second corrige un classement trompeur : la carte « Usage par projet »
classe en **total**, donc elle met le projet le plus travaillé en tête (147,15 $) — mais celui-ci est
cher parce qu'il est très travaillé, ses tours sont dans la moyenne basse.
Didier coûte **3× plus par tour**. Pour décider où la délégation rapporterait,
le classement actuel désigne le mauvais projet.

Le premier change la stratégie : 41,4 % de la dépense tient dans une centaine
de tours. Optimiser « en moyenne » ne touche que la moitié la moins chère du
problème.

**Contexte** — remplace le KPI « Contexte moyen » invalidé en §4.

| KPI | État |
|---|---|
| Contexte réel médian et P90 | ⏳ |
| Part des tours au-delà de 50 % de la fenêtre (`contextWindow`) | ⏳ |
| Compactions déclenchées : nombre et coût | 🔧 |
| Ratio sortie / entrée — densité de production | ⏳ |
| Part du coût en entrée vs en sortie | ⏳ |

**Temps** — jamais mesuré à ce jour, aucun champ de durée n'existe.

| KPI | État |
|---|---|
| Durée de tour médiane et P90 | 🔧 `durationMs` |
| Temps d'attente cumulé par jour | 🔧 |
| Heures d'activité (grille heure × jour) | ✅ |

**Routage** — jugé indispensable.

| KPI | État | Valeur actuelle |
|---|---|---|
| Taux de tours routés (dénominateur honnête) | ✅ | 4,3 % |
| Signal d'escalade : petit essayé puis refait en gros | ⏳🔧 | — |
| Écart entre tier décidé et tier réellement utilisé | ✅ | — |

**Écarté — les KPI de travail produit** (tours par commit, coût par ticket
fermé, coût par commit). Rejetés le 2026-08-17, et la raison vaut d'être
gardée : **l'app serait juge et partie.** Mesurer la qualité de ce qu'elle
produit avec les compteurs qu'elle tient elle-même donnerait un indicateur
flatteur et invérifiable. C'est aussi ce qui referme §7.5 : sans arbitre
extérieur, « tâche réussie » n'a pas de définition tenable, et M5 reste
retenue pour la même raison.

## 7. Challenge des six métriques

Une métrique qu'on n'a pas essayé de casser est une décoration. Voici ce que
donne l'exercice — mené, quand c'était possible, en les calculant vraiment.

### 7.1 Le défaut qui touche toute la série : compter en tokens flatte

M1 est spécifiée en **part de tokens**. Recalculée en **coût équivalent API**
sur les mêmes 30 jours, elle ne dit pas la même chose :

| Étage | En tokens | En coût équivalent |
|---|---|---|
| Gros (opus-4-8, opus-5, fable-5) | 60,9 % | **99,4 %** — 404,36 $ |
| Petit payant (sonnet-5) | 1,3 % | 0,4 % — 1,68 $ |
| Mécanique (haiku) | 1,6 % | 0,2 % — 0,63 $ |
| Local et gratuit | 36,3 % | 0,0 % |

Un token de haiku et un token d'opus diffèrent d'un facteur 15 à 75. La
pyramide en tokens annonce « 61 / 39 » ; la pyramide en coût annonce
**« 99,4 / 0,6 »**. Le tiers de volume gratuit, qui donnait à la répartition
une allure raisonnable, pèse exactement zéro dans la facture.

Conséquences, et elles sont sérieuses :

- **M1 doit être pondérée par le coût équivalent, pas par les tokens** — sinon
  elle affichera des progrès qui n'existent pas. Basculer une tâche de fable
  vers sonnet déplacerait 5× plus de barre en coût qu'en tokens.
- **Les bornes cibles du skill `sobriete` sont exprimées en tokens** et
  doivent être relues à cette lumière avant d'être affichées comme repère.
- Au passage, le total est une information en soi : **406,67 $ d'équivalent
  API en 30 jours** sur un abonnement forfaitaire. La question « est-ce que je
  dépense trop » a une réponse, et elle est non.

Second défaut de M1 : la table des étages **pourrit**. `claude-opus-4-8` et
`claude-opus-5` sont au même tarif, `fable-5` aussi — les ranger « à l'œil »
par le nom sera faux à la prochaine sortie. L'étage doit se **déduire du
prix**, seule vérité terrain de « gros ».

### 7.2 M2 — ratio orchestrateur / délégués : pas de cible, donc pas de jauge

Aujourd'hui ≈ 100/0, ce qui est mauvais. Mais 0/100 serait pire : le skill
`sobriete` pose que l'intégration, les arbitrages et les GO/NO-GO ne se
délèguent jamais. Il existe donc une bande saine, et personne ne sait où elle
est. Une jauge sans seuil ne se lit pas — elle se contemple.

**Verdict : à reléguer dans le tableau de détail**, pas en tuile de tête, tant
qu'une bande cible n'est pas posée.

### 7.3 M3 — taux de délégation : une invitation à mal faire

« % de tours ayant délégué » récompense la délégation en soi. Or un tour
trivial ne *doit pas* déléguer : le faire ajoute un aller-retour et du contexte
à repayer. Optimiser cette métrique dégraderait le système — c'est un Goodhart
manuel.

**Verdict : à redéfinir.** Le dénominateur doit être restreint aux tours qui
méritaient une délégation (au-delà d'un seuil de tokens ou d'appels d'outils).
Sinon, M1 la couvre déjà mieux.

### 7.4 M4 — taux de cache : robuste, mais hors de ta main

C'est la mieux définie des six, la formule est standard (§5.3), et la donnée
arrive gratuitement avec le socle. Mais **le cache est géré par le SDK, pas par
IAction** : c'est une jauge sur laquelle aucune action directe n'existe. Une
jauge qu'on ne peut pas actionner ne produit pas de décision, elle produit de
l'inquiétude.

Sa valeur réelle est ailleurs : c'est un **détecteur de changement**. Une chute
soudaine signale que quelque chose s'est modifié dans la façon dont les
contextes sont construits — et ça, ça se corrige.

**Verdict : à garder, mais en drapeau à seuil** (le patron `/usage` à 10 %),
pas en indicateur permanent.

### 7.5 M5 — coût par tâche réussie : non livrable en l'état

C'est la métrique que la littérature FinOps désigne comme la seule saine
(§5.3). C'est aussi celle qu'IAction **ne peut pas calculer**, pour une raison
qui n'est pas technique : il n'existe ni notion de « tâche », ni notion de
« réussie ».

`status: done` signifie que le SDK a rendu la main sans lever d'erreur — pas
que le travail était bon. Livrer M5 avec ce critère afficherait « coût par
tâche réussie » en mesurant « coût par tour non planté ». C'est exactement le
mensonge confortable que la doctrine d'observabilité interdit, et il serait
d'autant plus nuisible qu'il porterait le nom de la bonne métrique.

**Verdict : à retenir en attente d'un vrai signal de succès.** Trois candidats
existent — un ticket fermé, un `npm run verif` au vert, une session close sans
reprise — et c'est une décision, pas un développement.

### 7.6 M6 — coût du re-travail : mesure la petite moitié du problème

Calculée : **51,2 ktok, soit 0,6 % des tokens** sur 30 jours. Un chiffre
rassurant, et c'est le problème.

M6 ne compte que les tours qui ont **planté**. Le re-travail coûteux est
ailleurs : le tour qui a techniquement réussi et dont tu as jeté la sortie.
Celui-là est invisible, et il est certainement plusieurs fois plus gros. La
métrique mesure la partie bon marché du gaspillage et prend le nom de
l'ensemble.

**Verdict : à renommer honnêtement** (« coût des tours en échec ») ou à
compléter par un signal de re-travail silencieux — un tour suivi d'un `git
revert`, ou d'une reprise immédiate sur le même fichier.

### 7.7 Ce qui manque, et qui vaut mieux que quatre des six

- **Le tour le plus cher de la période**, en une ligne cliquable. Pour un
  utilisateur seul, un forage bat six agrégats : on le regarde et on sait.
  C'est le « most expensive session callout » de `claude-usage-tracker` (§5.1).
- **Le signal d'escalade** : les tours où un petit modèle a été essayé puis
  refait par un gros. C'est la *routing optimality* de RouterArena (§5.3), et
  c'est la seule chose qui prouve qu'un routage est **bon** et pas seulement
  **bon marché**. IAction ne peut pas le voir aujourd'hui.

### 7.8 Verdict d'ensemble

| | Sort |
|---|---|
| M1 Pyramide | **Livrable après correction** — pondérer par le coût, déduire l'étage du prix |
| M4 Taux de cache | **Livrable en drapeau à seuil**, pas en jauge permanente |
| M6 Re-travail | **Livrable renommé** — « tours en échec », sans prétendre couvrir le gaspillage |
| M2 Ratio | Tableau de détail, en attente d'une bande cible |
| M3 Taux de délégation | À redéfinir ou à abandonner au profit de M1 |
| M5 Coût par tâche | **Retenue** — demande une décision sur ce qu'est une réussite |
| + Tour le plus cher | **À ajouter** — plus actionnable que M2, M3 et M6 réunies |
| + Signal d'escalade | **À ajouter** — la seule preuve que le routage est bon |

## 8. Refonte de l'UX

> **Maquette : [`maquette-supervision.html`](maquette-supervision.html)** —
> fichier autonome, à ouvrir dans un navigateur. Tous les chiffres qu'elle
> affiche sont réels ; les tuiles en pointillé sont celles qu'aucune donnée
> actuelle ne permet de remplir.

### 8.1 Ce qui ne va pas aujourd'hui

La page est organisée **par source de données** : un bloc par agrégat que le
sidecar sait produire. Les six blocs ont le même poids visuel, aucun ne porte
de seuil, aucun ne se compare à rien. Il faut déjà savoir ce qu'on cherche
pour y trouver quelque chose — c'est-à-dire l'inverse d'un tableau de bord.

### 8.2 Le principe : organiser par question, pas par donnée

Trois questions, posées à trois moments différents, avec trois budgets
d'attention différents.

**Zone 1 — « Est-ce que je peux continuer ? »** · consultée en plein travail,
2 secondes.
La fenêtre de quota la plus saturée, en nombre unique et grand, avec le rythme
de combustion et l'heure projetée du mur. Couleurs de statut (`--status-ok` /
`--status-warn` / `--status-error`), toujours doublées d'une icône et d'un mot
— jamais la couleur seule. C'est la seule chose nécessaire pendant qu'on
travaille, et aujourd'hui elle est en bas de page.

**Zone 2 — « Est-ce que je travaille bien ? »** · consultée une fois par
semaine, 30 secondes.
La pyramide en coût, appariée au taux d'erreur par étage. Les drapeaux à seuil
plutôt que des nombres continus : « le haut de table dépasse 25 % », « le taux
de cache a chuté » — un signal binaire se lit, un pourcentage de plus se
survole. Et le tour le plus cher de la période, en une ligne.

**Zone 3 — « Qu'est-ce que j'ai fait ? »** · consultée à la demande,
exploratoire.
Le contenu actuel de la page, avec deux ajouts : la comparaison à la période
précédente, et des dénominateurs honnêtes (l'encart Routage doit dire qu'il
décrit 4 % des tours). Tout replié par défaut.

### 8.3 Règles de forme

Palette : celle de l'app, **inchangée**. Les quatre teintes de courbe
(`#1478ff`, `#ff0069`, `#aa6900`, `#c800b9`) ont été repassées au validateur
contre la surface des panneaux (`#150f2b`) — bande de clarté, plancher de
chroma, séparation daltonisme et contraste : **tout passe**. Le commentaire
d'en-tête de `SupervisionCourbes.tsx` disait vrai, on n'y touche pas.

Deux ajouts, validés eux aussi :

- **Pyramide** — rampe *ordinale* (étages ordonnés, donc une seule teinte en
  dégradé, jamais quatre couleurs catégorielles) : `#8fc0ff → #5ba0ff →
  #1478ff → #0d4fb0`. Monotonie de clarté, écarts visibles, extrémité claire
  au-dessus de la surface : tout passe.
- **Quotas** — les jetons de statut existants (`#00f5d4`, `#fbbf24`,
  `#ff3131`), réservés au statut et jamais réutilisés comme couleur de série.

Le reste suit les règles de forme : un seul axe (jamais deux échelles), marques
fines, grille en filet, gap de 2 px entre segments empilés plutôt qu'une
bordure, étiquettes directes sélectives — jamais un nombre sur chaque point.

Et une correction de forme qui est un ticket à part entière : **les étiquettes
de bout de courbe se superposent** quand les séries convergent (§3). Le
désempilement pousse vers le bas puis borne ; il faut qu'il reflue vers le haut
quand la place manque.

### 8.4 Ce que la refonte ne fait pas

Elle n'ajoute pas d'écran, ne déplace pas la page, ne touche pas à
l'arithmétique de période (§3 : elle est saine et testée). Zone 3 est
l'existant réordonné. Le travail neuf est concentré sur les zones 1 et 2, et
la zone 2 dépend entièrement du socle T-066.

## 9. Tickets proposés

Rien n'est encore inscrit dans `tickets.md` : les numéros sont réservés, à
confirmer avant écriture.

| ID | Type | Prio | Titre |
|---|---|---|---|
| T-066 | tech | P1 | Enregistrer la ventilation `modelUsage` : un événement d'usage par modèle appelé, avec rôle, cache, coût et durée — le socle de §6.0 |
| T-067 | bug | P2 | « Contexte moyen » a une médiane de 6 tokens : le KPI mesure `input_tokens` hors cache, pas le contexte |
| T-068 | bug | P2 | « Part à coût nul : 98 % » rassure pendant que la fenêtre 5 h sature — l'indicateur compte des dollars là où la rareté est un quota |
| T-069 | bug | P3 | Étiquettes de courbe superposées quand les quatre séries convergent vers le bas de la fenêtre |
| T-070 | feat | P2 | Rien ne signale qu'une période est incomplète : le lundi, Semaine affiche les chiffres de Jour |
| T-071 | feat | P2 | Zone 2 « Est-ce que je travaille bien ? » : pyramide **pondérée par le coût** appariée au taux d'erreur, drapeaux à seuil, tour le plus cher |
| T-072 | feat | P2 | Zone 1 « Est-ce que je peux continuer ? » : trois devises (quota, payé, équivalent API), rythme et projection de fin de fenêtre |
| T-073 | tech | P3 | `claude-windows.jsonl` : 17 917 instantanés et 3,5 Mo pour 1083 tours — revoir la cadence d'échantillonnage |
| T-074 | feat | P3 | Signal d'escalade : repérer les tours refaits par un modèle supérieur — la seule preuve qu'un routage est bon et pas seulement bon marché (§7.7) |
| T-075 | feat | P3 | Zone 3 : comparaison à la période précédente et dénominateurs honnêtes sur l'encart Routage (§8.2) |
| T-076 | bug | P2 | 17 des 38 tours en erreur n'ont aucun message de cause : un échec enregistré sans sa raison reste un échec muet |

Ordre d'exécution : **T-066 d'abord et seul**. Tous les autres se calculent
dessus ; les entamer avant serait construire sur le grain qu'on vient de
déclarer faux.

Deux décisions à prendre avant de coder, et qui ne sont pas des développements :

1. **Ce qu'est une « tâche réussie »** (§7.5) — ticket fermé, `npm run verif`
   au vert, ou session close sans reprise. Sans réponse, M5 reste retenue.
2. **Les bornes cibles de la pyramide**, à relire en coût et non en tokens
   (§7.1) — celles du skill `sobriete` sont exprimées en tokens.

