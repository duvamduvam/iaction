# Spec — Panneau « Sessions Claude » (T-159)

> **Interface retirée le 2026-10-21 (T-179)** : seuls subsistent le client `sessionsDistantes.ts` et les outils MCP de T-178 ; le reste de ce document est l'historique de conception et les faits d'API, conservés.

> Rédigée le 2026-10-20. Origine : faire communiquer les sessions Claude entre
> elles et avec le poste du bureau sans passer par un relais maison (voir
> `docs/etude-mobile.md`, option O0 Remote Control).

## Besoin

Depuis IAction : **voir les sessions Claude Code ouvertes sur ce poste**,
**en reprendre une** dans IAction, et **accéder aux sessions des autres
machines** (Remote Control).

## Ce que la plateforme permet (vérifié le 2026-10-20, CLI 2.1.304)

- `claude agents --json` imprime les sessions actives **de ce poste**
  (interactives et d'arrière-plan) : `pid`, `cwd`, `kind`, `startedAt` (ms),
  `sessionId`, `name`, `status` (`busy`/`idle`…). `--all` ajoute les sessions
  d'arrière-plan terminées. Pas de TTY requis.
- Les sessions **d'autres machines** ne sont visibles que depuis une session
  connectée en Remote Control (`ListAgents`), et leur **prise de contrôle**
  n'existe que dans claude.ai/code ou l'app mobile Claude. Le SDK n'expose
  aucune méthode pour les lister ou s'y attacher : IAction ouvre donc
  claude.ai/code, il ne réimplémente pas Remote Control.
- Le SDK sait reprendre une session par `resume: <sessionId>` ; avec
  `forkSession: true` il en crée une **copie** au lieu d'écrire dans le
  transcript d'origine.

## Comportement attendu

1. **Liste** — un panneau « Sessions Claude » (accès depuis la barre de
   navigation) affiche les sessions : nom, projet (dernier segment du `cwd`,
   chemin complet au survol), type, état, démarrage (heure relative + absolue
   au survol). Bouton « Rafraîchir ». Option « Inclure les terminées » (`--all`).
2. **Reprendre dans IAction** — ouvre une nouvelle conversation IAction
   reprenant la session **en copie** (`resume` + `forkSession: true`), jamais
   en écriture dans la session d'origine (elle peut être vivante). Actif
   seulement si le `cwd` correspond à un projet connu d'IAction ; sinon bouton
   désactivé avec l'explication au survol. Si le modèle de conversation
   d'IAction ne permet pas cette reprise sans refonte, repli : « Copier la
   commande » (`cd <cwd> && claude --resume <id> --fork-session`) — et le
   signaler.
3. **Contrôle à distance** — bouton d'en-tête « Sessions des autres machines »
   qui ouvre `https://claude.ai/code` (voie `ouvrirLienExterne`), avec une
   ligne d'aide : « lancer `/remote-control` dans la session à piloter ».
4. **Copier l'identifiant** de session (pour `SendMessage`, `claude attach`…).

## Exigences

- **Aucun échec muet** : CLI `claude` introuvable, délai dépassé (15 s), JSON
  invalide, code de sortie non nul → message clair dans le panneau ET entrée
  au journal. Résolution du binaire : réutiliser celle qui existe déjà dans le
  sidecar s'il y en a une, sinon `claude` du PATH ; sous Windows, penser au
  binaire de l'extension VSCode si le PATH n'en a pas.
- Le sidecar porte l'appel (le front ne lance pas de processus) ; nouveau
  message de protocole documenté dans `docs/protocol.md`.
- Tests : analyse du JSON (champs manquants tolérés), binaire absent, délai,
  calcul du libellé de projet — attendus calculés avec `path.*`, jamais de
  chemin absolu en dur (piège Windows).

## Sonde « piloter une session distante » (2026-10-21)

Question : IAction peut-il afficher et piloter une session Remote Control
d'une autre machine, au lieu de renvoyer vers claude.ai/code ? Sonde en
lecture seule, hors application, avec le jeton OAuth de Claude Code
(`~/.claude/.credentials.json`, portée `user:sessions:claude_code`).
En-têtes : `Authorization: Bearer`, `anthropic-version: 2023-06-01`,
`anthropic-client-platform`.

| Appel | Résultat |
|---|---|
| `GET /v1/code/sessions` | 200 : toutes les sessions du compte, dont celle du poste du bureau (`title` = nom `--name`, `connection_status`, `worker_status`, `status`, `config.model`, `tags: remote-control-cli`) |
| `GET /v1/code/sessions/{id}` | 200 : détail de la session, ENVELOPPÉ dans `response_shape` (T-174) |
| `GET /v1/code/sessions/{id}/events` | 200 : historique paginé (`data[]`, `resume_cursor`) |
| `GET /v1/code/sessions/{id}/events/stream` | 200 `text/event-stream` : `session_update`, `client_event` avec `id` = `sequence_num` |

**Aller-retour vérifié le même jour** avec le client officiel du SDK,
`query({ sse: { streamUrl, sendUrl, sessionId, headers, fromSequenceNum } })`
de `@anthropic-ai/claude-agent-sdk/browser`, lancé depuis Node 22 (il tourne
hors navigateur) : message envoyé à la session du poste du bureau, accusés
`DELIVERY_STATUS_RECEIVED → PROCESSING → PROCESSED`, puis les messages SDK
habituels (`system/init`, `assistant`, `rate_limit_event`, `result/success`)
avec la réponse attendue. Ce sont les MÊMES `SDKMessage` que ceux qu'IAction
affiche déjà : le rendu du fil est réutilisable tel quel. `canUseTool`
permet de répondre aux demandes de permission (non exercé : le tour n'a
utilisé aucun outil). Curseur de départ : le plus grand `sequence_num` de
`GET …/events` — la liste va du plus récent au plus ancien et son
`resume_cursor` pagine vers le passé (le prendre pour point de reprise
rejoue tout l'historique : erreur constatée en test réel, T-166).

Reste ouvert : la portabilité Windows du jeton (même fichier ?), son
rafraîchissement (expire ; Claude Code le renouvelle, IAction doit le relire
à chaque connexion), et le rendu de l'historique antérieur (`GET …/events`).
Interface non documentée (« v1alpha2 ») : elle peut changer sans préavis —
toute intégration doit échouer bruyamment et garder le repli claude.ai/code.

## v0.7.0 — Piloter une session distante (T-165)

### Besoin

Depuis IAction (poste maison), voir les sessions Remote Control des autres
machines et en **piloter une** dans un onglet d'IAction : fil en direct,
envoi, demandes de permission, arrêt. Sans copie : c'est la session
vivante elle-même.

### Architecture retenue : un `queryFn` distant

Le moteur `createClaudeEngine({ queryFn })` (claude.ts) prend déjà sa
fonction `query()` en dépendance (`claudeQueryFn.ts` la choisit). Le client
distant du SDK, `query({ prompt, canUseTool, abortController, sse })` de
`@anthropic-ai/claude-agent-sdk/browser`, a la même forme (itérable de
`SDKMessage`, `interrupt()`…). D'où :

- `sidecar/src/sessionsDistantes.ts` (nouveau) :
  - lecture du jeton OAuth : `$CLAUDE_CONFIG_DIR/.credentials.json`, sinon
    `~/.claude/.credentials.json` (`os.homedir()`, valable Windows/Linux) ;
    relu à CHAQUE appel (il expire, Claude Code le renouvelle) ; absent →
    erreur claire « connectez Claude Code à claude.ai (/login) » ; jamais
    journalisé ;
  - `listerSessionsDistantes({ archivees })` → `GET /v1/code/sessions`
    (en-têtes : `Authorization: Bearer`, `anthropic-version: 2023-06-01`,
    `anthropic-client-platform`), projeté en `{ id, titre, statut,
    connexion, travail, modele, origine, majLe }` ; archivées masquées par
    défaut ;
  - `creerQueryFnDistant(sessionId)` → un `ClaudeQueryFn` qui appelle le
    `query` « browser » avec `sse: { streamUrl, sendUrl, sessionId,
    headers, fromSequenceNum }` et relaie `prompt`, `canUseTool`,
    `abortController` ; les options locales (cwd, modèle, MCP, instruction
    système…) sont ignorées — c'est la machine distante qui décide.
- `claude.start` reçoit un champ optionnel `sessionDistante: string` (id
  `cse_…`) ; s'il est présent, le moteur utilise le `queryFn` distant pour
  ce tour, tout le reste du pipeline (chunks, permissions, coût, fin de
  tour, arrêt) est inchangé. Si brancher un `queryFn` par tour exige de
  toucher lourdement claude.ts (fichier-dieu plafonné), créer un second
  moteur dédié via `createClaudeEngine({ queryFn: … })` plutôt que gonfler
  claude.ts.
- Nouveau message de protocole `claude.sessionsDistantes` (liste),
  documenté dans `docs/protocol.md`, ainsi que le champ `sessionDistante`.

### Interface

- Page « Sessions Claude » : seconde section « Autres machines »
  (rafraîchir, case « inclure les archivées ») : titre, état de connexion
  (connectée / déconnectée), activité (`worker_status`), modèle, dernière
  activité. Bouton **« Piloter »** (désactivé si déconnectée, avec la raison
  au survol). Le bouton claude.ai/code reste, en secours.
- « Piloter » ouvre dans Projets un onglet « ⇄ <titre> » marqué distant
  (bandeau : « Session distante — les fichiers, le modèle et les outils
  sont ceux de la machine distante »). Les envois de cet onglet partent
  avec `sessionDistante`. Le projet courant n'est qu'un support d'affichage.
- Historique : au premier affichage, `fromSequenceNum: 0` rejoue ce que le
  serveur garde ; si ce rejeu ne donne rien d'exploitable, afficher
  « historique antérieur non affiché » plutôt que rien.

### Exigences

- Aucun échec muet : 401 (jeton expiré/refusé), 404 (session disparue),
  réseau, session déconnectée, format inattendu → message dans l'onglet +
  journal. Interface non documentée : tout écart de format échoue
  bruyamment.
- Tests sidecar avec un faux `fetch` / faux `query` browser : projection de
  la liste, jeton absent, 401, relais de `canUseTool` et de l'interruption.
- Aucune donnée personnelle ni identifiant réel dans les tests (audit).

## v0.7.0 — Rapatrier une session distante (T-168)

### Besoin

Capitaliser en local ce qui s'est dit dans une session distante : la
conversation complète dans le projet local, puis, à la demande, une
distillation vers la mémoire du projet.

### Faits vérifiés (sonde du 2026-10-21, 215 événements)

- `GET …/events?limit=500` : jusqu'à 500 par page (défaut 50), du PLUS
  RÉCENT au plus ancien. Page suivante (plus ancienne) : `?cursor=<next_cursor>`
  rend les `sequence_num` strictement inférieurs. Dernière page : pas de
  `next_cursor` (et `?cursor=1` rend `data: []`).
- `payload` = le `SDKMessage` tel quel (`type`, `message`, `uuid`,
  `parent_tool_use_id`, `session_id`…). Types rencontrés : `user`,
  `assistant`, `result` (`success`), `system` (`init`,
  `background_tasks_changed`, `task_started`, `task_notification`),
  `control_request`, `control_response`, `tool_progress`, `env_manager_log`.

### Comportement

- Bouton **« Rapatrier »** dans le bandeau de l'onglet distant (et dans la
  ligne de la session, section « Autres machines »).
- Le sidecar (`claude.sessionDistante.rapatrier { sessionId, projetPath }`)
  lit TOUT l'historique (pagination, garde-fou : 50 pages), le trie par
  `sequence_num` croissant et écrit un Markdown lisible :
  - en-tête : titre, identifiant, modèle, machine/origine, première et
    dernière activité, date du rapatriement ;
  - « ### Vous » pour les messages utilisateur textuels ; « ### Claude »
    pour le texte de l'assistant ; un appel d'outil = une ligne
    `> 🔧 Outil — résumé de l'entrée` (tronqué à ~200 caractères) ; un
    résultat d'outil = une ligne tronquée ; un `result` = séparateur de tour
    avec coût et durée s'ils sont présents ; le reste (`control_*`,
    `tool_progress`, `env_manager_log`, `system` hors `init`) est omis.
- Fichier : `<projet>/.iaction/sessions-distantes/<AAAA-MM-JJ>-<titre-slug>-<8 car. de l'id>.md`,
  réécrit en entier à chaque rapatriement (idempotent). Le dossier reçoit un
  `.gitignore` contenant `*` : la transcription brute n'est **jamais**
  versionnée par défaut (elle peut contenir des données de l'autre machine).
- Le projet cible est le projet IAction **courant** de l'onglet ; le chemin
  du fichier écrit est affiché (cliquable) dans l'onglet.
- Bouton **« Distiller dans la mémoire »**, proposé après un rapatriement :
  ouvre une nouvelle conversation LOCALE dans ce projet avec une consigne
  pré-remplie (non envoyée : l'utilisateur relit et envoie) :
  « Lis <fichier>. Extrais-en ce qui mérite d'être retenu pour ce projet —
  décisions, faits établis, pièges, procédures — et range-le dans la mémoire
  du projet selon ses conventions. N'y recopie aucune donnée brute de
  l'autre machine (extraits de mails, inventaires, noms de personnes,
  identifiants) : uniquement des connaissances. »

### Exigences

- Aucun échec muet (401, 404, réseau, pagination sans fin, écriture
  impossible) → message + journal ; jamais le jeton au journal.
- Tests : pagination (plusieurs pages, arrêt sans `next_cursor`, garde-fou),
  rendu Markdown (types omis, troncature), nom de fichier, `.gitignore`.

## v0.7.0 — Projet d'accueil d'une session distante (T-173)

### Besoin

« Piloter » ouvre l'onglet distant dans le projet IAction courant (ou le
premier) : au hasard du point de vue de l'utilisateur. Il faut le BON projet
local, sans rien coder en dur, pour tout projet et toute machine.

### Faits (relevés le 2026-10-21 sur `GET /v1/code/sessions`)

Une session lancée dans un dépôt git porte son identité :
`config.outcomes[].git_info.repo` = `"<propriétaire>/<dépôt>"` et
`config.sources[].url` = l'URL du dépôt (ex. forme
`https://<hôte>/<propriétaire>/<dépôt>`). Les sessions VSCode sans dépôt n'ont
ni l'un ni l'autre.

### Règle de choix (dans cet ordre)

1. **Association mémorisée** : si l'utilisateur a déjà choisi un projet pour
   cette session distante (clé : identifiant `cse_…`, ET clé de repli : titre
   de session + dépôt, pour qu'une session relancée sous le même nom retrouve
   son projet), on la reprend. Stockée dans l'état persistant d'IAction (là où
   vivent déjà les préférences d'UI), pas dans le code.
2. **Correspondance git** : identité normalisée `propriétaire/dépôt` de la
   session (`git_info.repo`, sinon tirée de `sources[].url`) comparée à celle
   de chaque projet local, lue de ses remotes git (`git remote -v`, toutes les
   remotes, par le sidecar). Normalisation : minuscules ; retirer schéma,
   hôte, utilisateur, port, alias SSH (`alias:` ou `user@hôte:`), `.git`
   final et `/` superflus ; garder les DEUX derniers segments du chemin.
   Exactement un projet → choisi. Plusieurs → étape 3 avec ceux-là en tête.
3. **Choix de l'utilisateur** : petit sélecteur de projet au clic sur
   « Piloter » (pré-sélection : projet courant), avec case « Se souvenir pour
   cette session » cochée par défaut → étape 1 la fois suivante.

Le projet retenu est affiché dans la ligne de la session (« → alpha ») et
modifiable (« changer de projet »). Aucun nom de projet, d'hôte ni de dépôt
n'apparaît dans le code ni dans les tests (exemples génériques).

### Exigences

- `git` absent ou remote illisible pour un projet : ce projet est simplement
  sans identité (journal `debug`), jamais une erreur bloquante.
- Tests de la normalisation : `alias:proprio/depot.git`,
  `git@hote:proprio/depot.git`, `ssh://git@hote:2222/proprio/depot`,
  `https://hote/proprio/depot`, `https://hote/groupe/sous/proprio/depot.git`
  (deux derniers segments), casse.

## v0.7.0 — Sessions homonymes, historique et revue de semaine (T-175 à T-177)

### T-175 — Sessions homonymes

Relancer la session d'une autre machine sous le même nom laisse l'ancienne
dans la liste, déconnectée (constat du 2026-10-21). Section « Autres
machines » : par défaut, masquer une session **déconnectée** quand une
session plus récente de même titre ET même dépôt existe (case « Afficher
les sessions remplacées »). Onglet distant visant une session déconnectée
(erreur T-174) : proposer « Basculer vers la session connectée du même
nom » s'il y en a une — l'onglet garde son titre, son `sessionId` devient
le nouvel `cse_…` ; l'association de projet (T-173) suit.

### T-176 — L'historique des sessions distantes dans IAction

But : retrouver dans IAction tout ce qui s'est dit sur la machine distante,
pour une revue ultérieure. Sans nouveau format : la transcription Markdown
de « Rapatrier » (T-168) EST l'historique local.
- **Rapatriement automatique** à la fin de chaque tour distant (après le
  `result`) et à l'ouverture de l'onglet, dans le projet d'accueil (T-173).
  Silencieux s'il réussit, journalisé et signalé discrètement s'il échoue ;
  jamais bloquant pour le tour.
- **Affichage** : en tête de l'onglet distant, un volet repliable
  « Historique (n échanges) » rend cette transcription avec le composant
  Markdown existant, à la place de la note « historique antérieur non
  affiché ».

### T-177 — Revue de la semaine

Bouton « Revue de la semaine » (page Sessions Claude, avec le projet
d'accueil choisi ou le projet courant) : ouvre une conversation LOCALE dans
ce projet, consigne pré-remplie NON envoyée, période par défaut 7 jours :
« Fais la revue des 7 derniers jours de ce projet (depuis le <date>) :
transcriptions des sessions distantes dans `.iaction/sessions-distantes/`
(fichiers modifiés depuis cette date) et conversations Claude Code locales
de ce projet (`<dossier des transcriptions Claude Code du projet>`, fichiers
`.jsonl` modifiés depuis cette date). Résume ce qui a été fait et décidé,
puis propose — sans les appliquer — les mises à jour de la documentation et
de la mémoire du projet. N'y recopie aucune donnée brute d'une autre
machine : uniquement des connaissances. » Le dossier des transcriptions
locales se calcule sans rien coder en dur : `~/.claude/projects/` + chemin
du projet dont chaque caractère hors `[A-Za-z0-9]` devient `-` (convention
de Claude Code, à vérifier sur ce poste avant de la figer ; respecter
`CLAUDE_CONFIG_DIR`).

### Plusieurs sessions sur une machine distante

Mode serveur (`claude remote-control --name <nom> --permission-mode <mode>`) :
jusqu'à 32 sessions ; une nouvelle session se crée depuis claude.ai/code ou
l'app (environnement de la machine), puis apparaît dans « Autres machines »
où « Piloter » s'applique. La création depuis IAction demandera une sonde
de l'API (non faite) : hors v0.7.0.

## v0.7.0 — Outils MCP « sessions distantes » pour les agents (T-178)

### Besoin

Qu'un AGENT (pas seulement l'utilisateur dans un onglet) puisse dialoguer
avec une session d'une autre machine — typiquement un sous-agent de projet
lancé par l'outil `Agent`, visible dans le panneau « Sous-agents en cours »
comme les autres. IAction fournit les outils, génériques ; le projet définit
l'agent (fichier `.claude/agents/<nom>.md`, format Claude Code), hors code.

### Outils (serveur MCP interne `iaction`, toujours présent pour les tours Claude locaux)

- `sessions_distantes_lister` → liste projetée (titre, id, état de connexion,
  activité, dépôt, dernière activité), archivées exclues.
- `session_distante_demander { session, message, delai_minutes? }` :
  `session` = titre (ex. nom passé à `--name`) ou id `cse_…` ; un titre
  désigne la session **connectée** la plus récente de ce titre (cf. T-175),
  erreur explicite si aucune ou si ambiguïté. Envoie `message`, attend le
  `result` du tour distant (délai par défaut 15 min, max 30), renvoie : le
  texte final de l'assistant, la liste résumée des outils utilisés là-bas,
  le coût et la durée si présents. Même client que « Piloter »
  (`creerQueryFnDistant` / curseur T-166 / connexion vérifiée T-174) ;
  `canUseTool` : toute demande de permission distante est REFUSÉE avec un
  message clair (« un agent ne valide pas de permission à la place de
  l'utilisateur ; lancez la machine distante en mode sans demande ») et
  signalée dans le résultat de l'outil. **Amendé par T-185 (2026-11-03)** : sur un tour
  interactif, la demande est posée à l'utilisateur dans la fenêtre de
  question d'IAction (« Autoriser » / « Refuser ») ; de même, une session
  absente, déconnectée ou en attente de validation (`requires_action`)
  ouvre une question « Réessayer / Abandonner » avant tout envoi. Le refus
  d'office ne subsiste que pour les tours headless. Pas de rapatriement automatique
  (décision du 2026-10-21 : l'historique est celui de la conversation locale
  de l'agent).
- Erreurs (déconnectée, 401, délai, refus) → résultat d'outil `isError`
  lisible, jamais d'exception muette ; journal.
- Le message part préfixé d'une ligne d'origine générique (« [Message d'un
  agent de <machine locale> via IAction] ») pour que la session distante
  sache qui lui parle (constat : elle croyait parler à une autre session).

### Hors code (projet)

Un sous-agent de projet décrit sa mission, ses règles et liste l'outil
`mcp__iaction__session_distante_demander` (et `…_lister`) dans `tools`.

## Sonde « créer une session sur le relais » (2026-10-21, T-180)

- Environnements du compte : `GET /v1/environments?beta=true` avec
  `anthropic-beta: environments-2025-11-01` → `data[]` (`id` `env_…`,
  `name` = `<hôte>:<dossier>:<suffixe>`, `state`, `metadata.machine_id`).
  Un relais en **mode serveur** (`claude remote-control`) enregistre un
  environnement « Bridge » ; une session interactive (`--remote-control`)
  n'en a pas (tag `remote-control-repl`, `environment_id` vide).
- Création : `POST /v1/sessions` avec `anthropic-beta: ccr-byoc-2025-07-29`
  et `x-organization-uuid` (champ `organizationUuid` du fichier de jeton),
  corps `{ title, events: [], session_context: { sources: [], outcomes: [],
  model: null, cwd: "" }, environment_id, source: "remote-control" }` → 200,
  `id: "session_<suffixe>"` (même suffixe que le `cse_<suffixe>` des listes),
  `session_status: "pending"`.
- Archivage : `POST /v1/sessions/{id}/archive` (mêmes en-têtes) → 200.
- Vérifié le 2026-11-08 : un relais en mode serveur ACTIF (`claude
  remote-control --name pc-bureau-relais`) PREND la session créée (`connected`
  / `idle` en moins de 5 s). Le 2026-10-21, l'environnement sondé était celui
  d'un ancien relais arrêté : la session était restée `pending`, déconnectée.
- Le relais figure aussi dans `GET /v1/code/sessions` : session
  `remote-control-cli`, `environment_id` = son environnement, `title` = son
  `--name`. Une session interactive (`--remote-control`) porte l'étiquette
  `remote-control-repl` et aucun `environment_id`.

## Une session par conversation sur un relais (T-180, décision du 2026-11-08)

Constat : tous les appels visaient la même session « pc-bureau » (contexte
mêlé entre conversations IAction). Décision : **un relais ne reçoit jamais de
message** ; IAction lui fait créer une session neuve par conversation.

- **Relais** = session de la liste dont la première étiquette est
  `remote-control-cli` ET qui porte un `environment_id` (`estRelais`). Toute
  autre cible (session interactive, `cse_…` hors liste) : comportement
  inchangé, verrou par session compris.
- **Paramètre `fil`** (optionnel, relais seulement) de
  `session_distante_demander` : nom du fil (40 caractères, espaces réduits ;
  défaut `defaut`). Une conversation peut ouvrir plusieurs fils distincts sur
  le même relais ; un fil = une session distante = un contexte.
- **Conversation** : `meta.conversationId` de `claude.start` (déjà posé par la
  page Projets) est transmis au serveur MCP `iaction`. Sans lui (tour headless
  : orchestration, tâche), un relais est refusé avec un message explicite —
  mêler tous les appels dans une session partagée est précisément ce que
  T-180 supprime.
- **Création** : `POST /v1/sessions` (corps de la sonde), titre
  `IAction <8 premiers caractères de la conversation>[ · <fil>]`. L'association
  est enregistrée AVANT l'attente de connexion (un arrêt en cours de route
  n'orpheline pas la session). La session doit passer `connected` en 30 s,
  sinon elle est archivée, l'association retirée et l'agent reçoit l'erreur.
- **Association persistée** : `<données>/state/sessions-distantes-fils.json`
  (même dossier d'état que `chat-conversations.json`), écriture atomique
  (temporaire + renommage), accès sérialisés :
  `{ "version": 1, "fils": [ { "conversation", "relais", "environnement",
  "fil", "session", "creeLe", "utiliseLe" } ] }` — `relais` = titre du relais
  (à défaut l'id de son environnement), `session` = identifiant de création
  `session_…` (celui qu'attend l'archivage ; `cse_…` pour les listes),
  instants en millisecondes. Fichier illisible : renommé `….corrompu-<ms>`,
  erreur journalisée, on repart de zéro.
- **Recréation** : session associée absente de la liste (archivée,
  supprimée), ou déconnectée au-delà d'une grâce de 10 s (alors archivée) :
  nouvelle session, et le résultat de l'outil commence par « Nouvelle session
  distante, contexte précédent perdu (raison). ». Première création : « Nouvelle
  session distante ouverte pour cette conversation. ».
- **Verrou** : l'ouverture d'un fil est sérialisée par (conversation, relais,
  fil) ; l'échange l'est ensuite par session (les fils de conversations
  différentes tournent en parallèle).
- **Archivage** (`POST /v1/sessions/{session_…}/archive`, corps `{}`) : à la
  suppression d'une conversation d'une page Projets (méthode
  `sessionsDistantes.archiverConversation`, appel non bloquant), et au
  démarrage du sidecar pour les associations inutilisées depuis plus de 7
  jours. Un 404 vaut « déjà archivée » ; toute autre erreur est journalisée
  (`claude`, niveau `error`) et l'association est conservée pour le balayage
  suivant. Fermer un onglet n'archive rien. Un balayage sans association ne
  fait aucun appel réseau.
- `sessions_distantes_lister` ajoute « relais : crée une session par
  conversation » aux relais et « fil IAction : session propre à une
  conversation » aux sessions de fil.
- Code : `filsSessionsDistantes.ts` (association, création, archivage),
  `verrousSessions.ts` (verrous par clé, extrait d'`outilsSessionsDistantes.ts`).
