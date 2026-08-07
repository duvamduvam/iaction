# IAction — tickets

> Backlog du projet : corrections à venir et nouvelles fonctionnalités.
> Fichier versionné : un ticket = une entrée du tableau + une section détaillée.

## Convention

- **ID** : `T-001`, incrémental, jamais réutilisé (un ticket fermé garde son numéro).
- **Type** : `bug` (correction) · `feat` (fonctionnalité) · `tech` (dette technique, refacto,
  outillage) · `doc`.
- **Prio** : `P1` (bloquant / à faire ensuite) · `P2` (important, pas urgent) · `P3` (confort,
  un jour).
- **Statut** : `ouvert` → `en cours` → `fait`, ou `abandonné`.
- Les tickets `fait`/`abandonné` descendent dans « Archivés » avec la date de clôture.

Pour ajouter un ticket : prendre le prochain ID libre, ajouter une ligne au tableau **et** une
section détaillée. Le corps peut rester d'une ligne — mieux vaut un ticket court qu'un oubli.

## Ouverts

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|

_Aucun ticket ouvert._

## Archivés

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-004 | bug  | P1   | fait   | Le fil redescend tout seul pendant un streaming |
| T-003 | bug  | P1   | fait   | L'allowlist `tools:` d'un agent n'est pas appliquée (moteur claude) |
| T-002 | feat | P3   | fait   | Lien « dernier rapport qualité » dans la page Système |
| T-001 | feat | P3   | fait   | Page « Tickets » dans l'app |

---

### T-004 — Le fil redescend tout seul pendant un streaming

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-07 · **Clos** 2026-08-07

Constaté sur une réponse longue streamée par un modèle rapide (Gemini via OpenRouter, page
Projets) : impossible de remonter dans le fil, la vue « redescend toute seule » à chaque delta.

Cause : l'état « collé en bas » était déduit de la SEULE position au moment de l'événement
`scroll`, avec un seuil de 48 px (`stickToBottomRef`, dupliqué dans `AgentPage.tsx` et
`ChatPage.tsx`). Or le recollage repose le scroll au fond à chaque delta, et l'événement
`scroll` arrive après le geste : une molette de moins de 48 px laissait `stick` à vrai, le
delta suivant redescendait, et rien ne permettait de s'échapper — sauf à jeter la molette d'un
coup sec, hors de la zone.

**Réalisé** : logique sortie dans [ui/src/useStickToBottom.ts](../ui/src/useStickToBottom.ts),
partagée par les deux pages. L'INTENTION prime désormais sur la position — molette vers le
haut, ou `scrollTop` qui recule (ascenseur, PagePrec, tactile), décolle immédiatement quelle
que soit la distance ; et on ne se recolle qu'une fois vraiment au fond (≤ 4 px), pas dès qu'on
repasse sous 48 px. Le recollage en `useLayoutEffect` (correction du 2026-08-04) est conservé.

### T-003 — L'allowlist `tools:` d'un agent n'est pas appliquée (moteur claude)

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-07-31 · **Clos** 2026-08-07

[protocol.md](protocol.md) § O1 documente `tools: null` = palette complète, « sinon allowlist de
noms d'outils ». Pour une étape d'orchestration portée par un agent `engine: claude`, cette
allowlist **n'est jamais appliquée** : `buildStepStartParams` ([orchestrator.ts:1263-1271](../sidecar/src/orchestrator.ts))
ne transmet que `cwd`, `prompt`, `model`, `permissionMode`, `systemPrompt`, `chatOnly` — jamais
`tools` ; et côté [claude.ts:694](../sidecar/src/claude.ts), `options.tools` n'est posé que sur la
branche `chatOnly` (WebSearch/WebFetch). Le champ est donc purement **déclaratif** : l'agent
reçoit la palette complète quoi qu'il déclare.

Gravité : les tâches planifiées tournent en `permissionMode: bypassPermissions` (obligatoire en
headless — aucun humain pour répondre au flux de permission), donc un agent qui déclare
`tools: [Read, Grep, Glob]` dispose en réalité de Write, Edit et Bash sans aucune barrière. Le
seul garde-fou effectif aujourd'hui est le **prompt** de l'agent, ce qui n'est pas une frontière
de sécurité. Découvert le 2026-07-31 en écrivant l'agent `analyste-qualite` (lecture seule
voulue), dont le README avertit du problème en attendant.

**Réalisé** — `buildStepStartParams` transmet désormais `agent.tools` aux DEUX moteurs, et :

- côté [claude.ts](../sidecar/src/claude.ts), l'allowlist devient `options.tools` (base d'outils
  intégrés exposée au modèle) et **non** `options.allowedTools` comme envisagé à l'ouverture du
  ticket : ce dernier ne fait qu'auto-approuver sans rien retirer de la palette, donc n'aurait
  rien restreint précisément sur les tours `bypassPermissions` visés. Les noms `mcp__*` sont
  écartés de la liste : les outils MCP entrent par `mcpServers` et se gouvernent par le champ
  `mcp` du manifeste — `mcp__studio__ask_user` et `mcp__iaction__*` restent donc disponibles
  quelle que soit l'allowlist ;
- symptôme confirmé côté moteur neutre : `TOOLS` était bien une constante. Les outils sont
  maintenant filtrés à la déclaration ET refusés à l'exécution. Comme les noms neutres ne sont
  pas ceux de Claude Code et qu'un agent `engine: auto` ignore où il tombera, les noms Claude
  sont acceptés et traduits (`Read` → `read_file`…) ; `search_knowledge` (RAG, lecture seule)
  échappe à l'allowlist comme le MCP côté Claude ;
- l'allowlist s'applique aussi aux tours lancés depuis la page Projets avec un agent
  sélectionné, où le champ était tout aussi décoratif.

Fermé par défaut : une allowlist qui ne désigne aucun outil connu laisse l'agent SANS outil,
jamais avec la palette complète. Contrat dans [protocol.md](protocol.md) (`claude.start`,
`neutral.start`, « Forme d'un agent »), couverture dans `protocol.test.js` (cas `mcp-e3`/`mcp-e4`).

### T-002 — Lien « dernier rapport qualité » dans la page Système

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-07-31 · **Clos** 2026-08-07

Dernier point du § 2.6 de [etude-logs.md](etude-logs.md), non fait en L5 : le panneau
« Journal » de la page Système doit exposer un lien vers le **dernier rapport** de la tâche
`qualite-iaction` (`taches.reports` + `taches.reportRead`, rendu par le composant `Markdown`
existant), pour que la boucle *journal → rapport hebdo → ticket* se voie depuis l'endroit où
l'on constate les erreurs. Discret et tolérant : la tâche n'est pas forcément installée — sans
rapport, pas de lien, pas d'erreur affichée.

**Réalisé** : bouton « ▤ Dernier rapport qualité · <date> » dans les actions du panneau Journal
([SystemPage.tsx](../ui/src/SystemPage.tsx)), qui ouvre le rapport dans une modale rendue par
`Markdown`. Aucune méthode nouvelle. Tolérance : toute erreur de `taches.reports` (tâche
absente, sidecar sans `taches.*`) se solde par l'absence du bouton, jamais par un message
d'erreur dans un panneau qui parle d'autre chose.

### T-001 — Page « Tickets » dans l'app

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-07-22 · **Clos** 2026-07-31

Exposer ce backlog dans l'UI (page dédiée façon `OrchestrationPage`, méthodes `tickets.*` côté
sidecar) au lieu d'éditer le markdown à la main. Nécessite : `ui/src/TicketsPage.tsx`,
`ui/src/ticketsClient.ts`, `sidecar/src/tickets.ts`, et la section correspondante dans
[docs/protocol.md](protocol.md).

À ne lancer que si le fichier montre ses limites (trop de tickets, suivi pénible).

**Réalisé** sous la forme d'un panneau « Tickets » de la page Système en **lecture seule**
(méthode `tickets.list`, voir [protocol.md](protocol.md) § TK1), et non de la page dédiée avec
CRUD initialement envisagée : ce fichier reste édité à la main et versionné.
