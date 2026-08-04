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
| T-002 | feat | P3   | ouvert | Lien « dernier rapport qualité » dans la page Système |
| T-003 | bug  | P1   | ouvert | L'allowlist `tools:` d'un agent n'est pas appliquée (moteur claude) |

---

### T-002 — Lien « dernier rapport qualité » dans la page Système

**Type** feat · **Prio** P3 · **Statut** ouvert · **Créé** 2026-07-31

Dernier point du § 2.6 de [etude-logs.md](etude-logs.md), non fait en L5 : le panneau
« Journal » de la page Système doit exposer un lien vers le **dernier rapport** de la tâche
`qualite-iaction` (`taches.reports` + `taches.reportRead`, rendu par le composant `Markdown`
existant), pour que la boucle *journal → rapport hebdo → ticket* se voie depuis l'endroit où
l'on constate les erreurs. Discret et tolérant : la tâche n'est pas forcément installée — sans
rapport, pas de lien, pas d'erreur affichée.

### T-003 — L'allowlist `tools:` d'un agent n'est pas appliquée (moteur claude)

**Type** bug · **Prio** P1 · **Statut** ouvert · **Créé** 2026-07-31

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

Correctif : transmettre `agent.tools` dans `buildStepStartParams`, et le poser en
`options.allowedTools` côté `claude.ts` (branche non-`chatOnly`) — en vérifiant que la
combinaison avec `disallowedTools: ["AskUserQuestion"]` et les outils MCP
(`mcp__<serveur>__<outil>`) reste cohérente. Vérifier au passage le moteur neutre :
`buildStepStartParams` ne lui transmet pas non plus `tools`, et `neutralAgent.ts:774` pose une
constante `TOOLS` — même symptôme à confirmer.

## Archivés

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-001 | feat | P3   | fait   | Page « Tickets » dans l'app |

---

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
