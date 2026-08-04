# Étude — Journal applicatif consolidé (logs, erreurs, amélioration continue)

Statut : étude, en attente de validation. Rien d'implémenté — l'existant est
décrit tel quel au § 1.

Objectif : **un seul journal**, **quatre niveaux de criticité**, une **liste
des erreurs par criticité dans la page Système**, et une **boucle de retour**
qui transforme ce journal en tickets.

## 1. L'existant — inventaire complet

### 1.1 Ce qui est bien fait : les journaux structurés d'usage

Deux fichiers JSONL dans `${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/usage/`
(voir [protocol.md § S1](protocol.md), `sidecar/src/usageStats.ts`) :

| Fichier | Contenu | Écrit par |
|---|---|---|
| `events.jsonl` | un événement par TOUR LLM terminé : `ts, engine, method, providerId, model, promptTokens, completionTokens, modelUsed, costUsd, cachedTokens, status, orchRunId, orchStepId, source, conversationId, routeTier, routeDebord` | `engine.ts`, `neutralAgent.ts`, `claude.ts` |
| `claude-windows.jsonl` | un instantané par capture d'usage abonnement | `claude.ts` |

Les qualités à **conserver et généraliser** :

- append JSONL, **file d'écriture sérialisée** (`enqueueWrite`) — jamais
  d'entrelacement de lignes ;
- **non bloquant, ne lève jamais** : une erreur d'écriture ne casse pas un tour ;
- **lecture tolérante** : une ligne difforme est ignorée (`readJsonlTolerant`) ;
- **lecture par la fin** pour le chemin chaud (`readJsonlTail`, 64 Ko) ;
- **rotation** à 20 Mo → `.1` (un seul niveau).

C'est le modèle de référence. Le journal applicatif proposé au § 2 réutilise
exactement ces primitives — qu'il faudra donc **factoriser** (aujourd'hui elles
sont privées à `usageStats.ts`, et déjà « dupliquées depuis
orchestrator.ts/taches.ts » de l'aveu du fichier lui-même).

### 1.2 Ce qui est journalisé nulle part : tout le reste

| Source | Volume | Destination | Survit au redémarrage ? |
|---|---|---|---|
| Sidecar Node | ~14 `console.error` | stderr | **non** |
| Coquille Rust | 15 `eprintln!` (`sidecar.rs` 11, `lib.rs` 4) | stderr du terminal | **non** |
| UI React | **0** `console.*` | néant — erreur affichée dans le composant appelant, puis oubliée | **non** |
| `devErrorProbe.ts` | `window.onerror` + `unhandledrejection` | `POST http://127.0.0.1:9911/log` — **aucun serveur n'écoute** | **non** |
| Étapes d'orchestration | 1 `usage event` par étape, sans message | `events.jsonl` | oui, mais amputé (§ 1.4) |
| Tâches planifiées | stdout du runner | `<tâche>/rapports/journal.log` | oui |
| Tâches planifiées — **erreurs** | stderr du runner (`StandardError=inherit`) | journal systemd, **pas** le fichier | ailleurs |

### 1.3 Les cinq défauts de fond

**a) Aucun niveau de criticité.** Tout est `console.error` / `eprintln!`, y
compris ce qui est purement informatif (« source ignorée, trop grosse », «
réglage WebKit absent, sans effet »). Impossible de distinguer un crash d'une
note. C'est exactement ce que demande la page Système et ce qui manque.

**b) Aucun horodatage, aucune structure.** Chaîne libre en français, préfixes
incohérents selon le fichier : `[sidecar]`, `[speech]`, `[usageStats]`,
`knowledge:`, `projectDoc:`, `claude.start:`, `iaction :`,
`[sidecar:stderr]`, `[orch-run]`. Ni scope normalisé, ni `id` de requête — on
ne peut pas relier une erreur au tour qui l'a produite.

**c) Rien ne persiste.** En développement, tout part dans le terminal de
`./scripts/dev.sh`. **En build packagé lancé au clic, stderr n'a pas de
destination** : les erreurs de la coquille Rust (échec de spawn du sidecar,
crash, backoff, redémarrages) sont perdues. C'est précisément la classe de
panne qu'on ne peut pas reproduire à la demande.

**d) La page Système ne montre qu'un tuyau, pas un journal.**
`SystemPage.tsx` → `LogsPanel` : anneau de 200 lignes brutes alimenté par
`subscribeLog` (event Tauri `sidecar:log` = relais du stderr du sidecar).
Conséquences : pas de niveau, pas de filtre, pas de recherche, pas d'historique
avant le lancement de l'app, et **rien de ce qui vient de l'UI ou du Rust**.
Bon point tout de même : les pages sont toutes montées en permanence
(`slotClass`, `App.tsx:1237`), donc l'abonnement démarre au lancement — le
panneau ne repart pas de zéro à chaque visite.

**e) 86 `catch` silencieux** (`ui/src` + `sidecar/src`). La plupart sont
légitimement best-effort et commentés comme tels. Mais il n'existe **aucun
canal `debug`** où un « best effort » raté pourrait laisser une trace : le
choix est binaire entre casser le flux et ne rien savoir. Top des fichiers :
`AgentPage.tsx` (10), `neutralAgent.ts` (10), `knowledge.ts` (9),
`usageStats.ts` (8), `OrchestrationPage.tsx` (6), `claude.ts` (6).

### 1.4 Le trou le plus béant : `status: "error"` sans le message

`recordUsageEvent` écrit `status: "done" | "error" | "aborted"` et **ne porte
aucun champ de message**. Le seul enregistrement durable et structuré des
échecs de l'application sait donc qu'un tour a échoué, mais **jamais
pourquoi**. Tout diagnostic post-mortem est impossible, et l'agrégation « quelles
erreurs reviennent » — le socle de l'amélioration continue — n'a pas de matière.

Corollaire pour les orchestrations : un run multi-étapes, c'est-à-dire l'objet
le plus long et le plus faillible de l'app, ne laisse **aucune trace de run**
autre qu'un événement d'usage muet par étape.

### 1.5 Deux anomalies ponctuelles relevées au passage

- **`ui/src/devErrorProbe.ts`** (non versionné, importé en tête de
  `ui/src/main.tsx`) : sonde de diagnostic « écran blanc » qui poste sur
  `127.0.0.1:9911`. En l'état c'est la **seule** capture globale d'erreur de la
  webview, et elle est un cul-de-sac — chaque erreur déclenche un `fetch` qui
  échoue en silence. À remplacer par le point d'entrée du § 2.3, pas à
  supprimer sèchement : la fonction manque vraiment.
- **`sidecar/src/usageStats.ts` contient un octet NUL** (ligne 619,
  `` const key = `${engine}\0${model}` `` — séparateur de clé composite,
  volontaire). Effet de bord non voulu : les outils de recherche traitent le
  fichier comme **binaire** et l'**excluent silencieusement** de tout `grep -r`
  du dépôt. Un `\x1f` (ou `"::"`) rendrait le fichier de nouveau visible.

## 2. Architecture proposée

### 2.1 Principe

> Un journal, une porte d'entrée par processus, quatre niveaux, un fichier.

Niveaux, du plus grave au plus bavard :

| Niveau | Sens | Exemple issu de l'existant |
|---|---|---|
| `fatal` | l'app ou un sous-système est hors service | sidecar mort après backoff, échec de spawn `node` |
| `error` | une action de l'utilisateur a échoué | tour LLM en erreur, YAML d'orchestration invalide, écriture impossible |
| `warn` | dégradation acceptée, l'app continue | MCP `search_knowledge` indisponible, `.mcp.json` invalide ignoré, source trop grosse ignorée |
| `info` | jalon de cycle de vie | sidecar prêt, run d'orchestration démarré/terminé, indexation terminée |
| `debug` | trace de mise au point, **coupée par défaut** | les 86 `catch` best-effort qui ne disent rien aujourd'hui |

### 2.2 Le fichier

`${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/logs/app.jsonl`, même
dossier racine et **mêmes primitives** que `usage/` (append sérialisé,
tolérance en lecture, rotation 20 Mo → `.1`). Une ligne :

```json
{"ts":"2026-07-31T09:12:03.114Z","level":"error","scope":"claude",
 "msg":"tour interrompu par le fournisseur",
 "reqId":"req-42","runId":null,"stepId":null,
 "fields":{"providerId":"openrouter","model":"…","httpStatus":429},
 "stack":"…"}
```

`scope` est une **énumération fermée** (`sidecar`, `rust`, `ui`, `claude`,
`neutral`, `orchestrator`, `taches`, `knowledge`, `speech`, `router`,
`usage`) — c'est ce qui rend l'agrégation possible. `fields` est un objet
plat, jamais de corps de prompt, jamais de secret (règle déjà en vigueur :
« aucune clé API loguée », [spec-r0](spec-r0-openrouter.md)).

Prérequis : **factoriser** `appendJsonlWithRotation` / `readJsonlTolerant` /
`readJsonlTail` de `usageStats.ts` vers un `sidecar/src/jsonlStore.ts`. Le
journal les réutilise au lieu d'en faire une troisième copie.

### 2.3 Les trois portes d'entrée

```
UI React ──log.append──┐
                       ├──> sidecar/src/journal.ts ──> app.jsonl
Rust ──app:log event──┘        (seul écrivain)         + stderr (format lisible)
Sidecar ──appel direct─┘
```

- **Sidecar** — `sidecar/src/journal.ts` : `log(level, scope, msg, fields?)`.
  Écrit la ligne JSONL **et** émet une forme lisible sur stderr, ce qui garde
  intact le relais Rust → `sidecar:log` existant : rien à changer dans la
  chaîne actuelle. Les ~14 `console.error` deviennent des appels typés avec
  leur niveau réel (la moitié sont des `warn`, pas des `error`).
- **UI** — `ui/src/journal.ts` : tampon circulaire en mémoire (affichage
  immédiat) + envoi `log.append` best-effort. Y sont branchés `window.onerror`,
  `unhandledrejection`, un `ErrorBoundary` React, et surtout **le wrapper
  `request()` de `sidecar.ts`, qui logue automatiquement tout événement
  `error`**. C'est le gain le plus fort du lot : aujourd'hui chaque appelant
  affiche l'erreur dans son coin et l'oublie ; demain aucune erreur de
  protocole ne peut passer inaperçue, sans toucher aux appelants.
- **Rust** — un **nouvel** event Tauri `app:log` (distinct de `sidecar:log`,
  qui reste le relais du stderr sidecar) pour ses propres messages ; l'UI le
  réémet vers `log.append`. La distinction des deux events évite la boucle
  (sidecar → stderr → `sidecar:log` → UI → `log.append` → sidecar…). Quand le
  sidecar est mort, ces lignes ne sont pas écrites — c'est assumé :
  `sidecar:status` porte déjà l'information et l'UI la conserve en mémoire.

### 2.4 `events.jsonl` gagne `errorMessage`

Un champ, qui bouche le trou du § 1.4 :
`errorMessage: string | null` sur `recordUsageEvent`, rempli par les trois
moteurs sur `status: "error"`. Rétrocompatible (lecture tolérante, `null` par
défaut). Sans lui, aucune analyse d'échec n'est possible.

### 2.5 Protocole — trois méthodes

| Méthode | Rôle |
|---|---|
| `log.append` | `{level, scope, msg, fields?, stack?}` → écrit une ligne. `done: {}`. Ne rejette jamais. |
| `log.read` | `{level?, scope?, since?, limit?}` → lecture par la fin, filtrée. `done: {entries: […], truncated: bool}` |
| `log.stats` | agrégat : occurrences par niveau, et **top des erreurs** (message normalisé → nombre, premier/dernier vu, scopes touchés) |

### 2.6 Page Système — « Erreurs par criticité »

Le panneau `Journal` remplace le `LogsPanel` actuel en tête de page :

```
┌ Journal ───────────────────────────────────────────────────┐
│  [ fatal 0 ] [ error 12 ] [ warn 43 ] [ info 108 ] [ debug ]│  ← chips filtrantes
│  scope : [ tous ▾ ]   période : [ 24 h ▾ ]   [rechercher…]  │
├────────────────────────────────────────────────────────────┤
│ ● error  09:12:03  claude       tour interrompu (429)     ▸ │
│ ● error  09:11:47  orchestrator étape "veille" échouée    ▸ │
│ ▲ warn   08:59:02  knowledge    MCP search_knowledge …    ▸ │
└────────────────────────────────────────────────────────────┘
   ▸ déplie fields + stack + reqId/runId
```

- compteurs par niveau en tête = la **liste des erreurs par criticité** demandée ;
- chargement initial depuis `app.jsonl` puis complétion en direct → contrairement
  à aujourd'hui, **l'historique survit au redémarrage de l'app** ;
- le flux brut `sidecar:log` reste disponible **en dessous, replié** — utile pour
  le debug vif, mais ce n'est plus la vue principale ;
- actions : « Copier », « Ouvrir le dossier », « Purger ».

### 2.7 La boucle d'amélioration continue

C'est la partie qui distingue « avoir des logs » de « s'en servir ». Le motif
existe déjà dans le projet ([etude-taches.md](etude-taches.md) § 2, tâche
`maj-iaction`) : une **tâche planifiée hebdomadaire** `qualite-iaction`.

- lit `app.jsonl` + `events.jsonl` (les données sont locales, aucune sortie
  réseau) ;
- produit `rapports/<date>.md` : top des erreurs de la semaine, nouveautés
  par rapport à la semaine précédente, régressions, scopes les plus fragiles,
  taux d'échec par moteur/fournisseur ;
- **propose des tickets rédigés au format de [tickets.md](tickets.md)** —
  proposition seulement. Aucune écriture automatique dans `tickets.md` : même
  règle que la tâche `bourse`, le rapport informe, l'humain décide.
- la page Système expose un lien « dernier rapport qualité ».

Boucle complète : *erreur vécue → ligne structurée → agrégat → rapport
hebdo → ticket → correction*.

## 3. Découpage proposé

| Tranche | Contenu | Dépend de |
|---|---|---|
| **L1 — socle** | `jsonlStore.ts` factorisé, `journal.ts` sidecar, `log.append`/`log.read`, les ~14 `console.error` reclassés par niveau | — |
| **L2 — UI** | `ui/src/journal.ts`, `ErrorBoundary`, capture globale, log auto des `error` de `request()`, retrait de `devErrorProbe.ts`, event Rust `app:log` | L1 |
| **L3 — page Système** | panneau `Journal` : compteurs par criticité, filtres, détail dépliable, purge | L1 + L2 |
| **L4 — matière** | `errorMessage` dans `events.jsonl`, `log.stats` | L1 |
| **L5 — boucle** | tâche `qualite-iaction`, rapport hebdo, propositions de tickets | L3 + L4 |

Corrections indépendantes, faisables tout de suite : l'octet NUL de
`usageStats.ts` (§ 1.5) et le `StandardError=inherit` des tâches
(→ `append:` sur le même `journal.log`, pour que les erreurs d'une tâche
atterrissent dans le journal de cette tâche).

## 4. Ce que l'étude écarte

- **Tout envoi hors du poste** (Sentry, télémétrie distante) : contraire au
  principe local-first du projet, et l'app manipule des chemins de projets et
  des contenus de conversation.
- **SQLite** malgré l'axe 6 du [plan](plan.md) : le JSONL append-only fait déjà
  le travail pour ce volume, la lecture par la fin est O(64 Ko), et il n'y a
  pas de requête relationnelle à servir. À reconsidérer seulement si `log.stats`
  devient trop lent — ce que le rapport hebdo saura dire.
- **Une bibliothèque de log** (pino, tracing) : ~80 lignes suffisent, et le
  format doit rester lisible par une tâche IA sans dépendance.
