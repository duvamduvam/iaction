# Protocole UI ⇄ Rust ⇄ sidecar

Architecture : **UI React** ⇄ (IPC Tauri : commandes + events) ⇄ **cœur Rust mince** ⇄ (stdio, JSON Lines) ⇄ **sidecar Node**.

Le Rust ne comprend PAS le contenu des messages : il relaie des lignes JSON et supervise le processus. Toute la sémantique est entre l'UI et le sidecar.

## Transport Rust ⇄ sidecar : JSON Lines sur stdio

- Une ligne = un objet JSON, encodé UTF-8, terminé par `\n`. Pas de JSON multi-lignes.
- Rust → sidecar : requêtes sur **stdin** du sidecar.
- Sidecar → Rust : événements sur **stdout**. **stdout est réservé au protocole** — tout log libre va sur **stderr**.

### Requête (UI → sidecar)

```json
{"id": "req-1", "method": "ping", "params": {}}
```

- `id` : string non vide, choisie par l'UI, unique par requête en cours.
- `method` : string.
- `params` : objet (peut être vide/absent).

### Événements (sidecar → UI)

Réponses corrélées par `id` :

```json
{"id": "req-1", "event": "chunk", "data": {"text": "mot "}}
{"id": "req-1", "event": "done",  "data": {}}
{"id": "req-1", "event": "error", "data": {"message": "…"}}
```

- Une requête produit 0..n `chunk` puis exactement un `done` OU un `error` (terminal).
- Événement non sollicité (sans `id`), émis une fois au démarrage du sidecar :

```json
{"event": "ready", "data": {"version": "0.1.0", "pid": 1234}}
```

- Méthode inconnue → `error` avec `data.message` explicite. Ligne non-JSON reçue → le sidecar log sur stderr et ignore (il ne crashe jamais sur une entrée invalide).

## Méthodes Lot 0

| method | params | comportement |
|---|---|---|
| `ping` | `{}` | répond immédiatement `done` avec `data: {pong: true}` |
| `stream.echo` | `{text: string, delayMs?: number}` (delayMs défaut 80, borné 0–1000) | découpe `text` en mots, émet un `chunk` `{text: "mot "}` par mot avec `delayMs` entre chaque, puis `done`. Simule un stream de tokens LLM. `text` manquant/vide → `error`. |

## Méthodes Lot 1 — moteur neutre (chat OpenAI-compatible)

Le sidecar héberge le **moteur neutre** : un client streaming vers des endpoints
« dialecte OpenAI » (Ollama, OpenRouter, endpoints custom). Aucune dépendance runtime :
`fetch` natif de Node 22 + parsing SSE maison.

### `providers.set`

Pousse (remplace intégralement) la table des fournisseurs connus du sidecar.
Appelé par l'UI au démarrage et à chaque modification de l'admin.

```json
{"id":"req-2","method":"providers.set","params":{"providers":[
  {"id":"ollama","label":"Ollama local","baseUrl":"http://localhost:11434/v1"},
  {"id":"openrouter","label":"OpenRouter","baseUrl":"https://openrouter.ai/api/v1",
   "apiKey":"sk-or-…","headers":{"HTTP-Referer":"https://github.com/…","X-Title":"IAction"}}
]}}
```

- `id`, `label`, `baseUrl` requis ; `apiKey` et `headers` optionnels.
- Réglages de routage OpenRouter (R0, opt-in, tous optionnels et absents par
  défaut ; sans effet sur le moteur Claude) :
  - `fallbackModels: string[]` — ids de modèles de secours, dans l'ordre
    d'essai (OpenRouter `models`) ;
  - `priceSort: boolean` — router chaque appel vers l'endpoint le moins cher
    du modèle (OpenRouter `provider.sort`) ;
  - `usageAccounting: boolean` — demander coût réel + tokens cachés dans
    l'usage (OpenRouter `usage.include`).
  Validation souple : un champ mal formé (pas un tableau de chaînes non
  vides, pas un booléen) est ignoré sans erreur. Effet sur les requêtes :
  voir `chat.send`.
- Le sidecar garde tout **en mémoire uniquement** (jamais écrit sur disque — les
  secrets persistent dans le trousseau OS côté Rust, la config non-secrète dans
  le store JSON, voir « Commandes Tauri »).
- Réponse : `done` avec `data: {count: n}`.

### `models.list`

```json
{"id":"req-3","method":"models.list","params":{"providerId":"ollama"}}
```

GET `{baseUrl}/models` (+ `Authorization: Bearer <apiKey>` si présent).
Réponse : `done` avec `data: {models: [{"id":"qwen3.5:4b"}, …]}`.
Fournisseur inconnu ou erreur HTTP/réseau → `error` (`data.message` explicite).

### `models.detail`

```json
{"id":"req-6","method":"models.detail","params":{"providerId":"openrouter"}}
```

Comme `models.list` (GET `{baseUrl}/models`) mais conserve les métadonnées
OpenAI/OpenRouter quand présentes : `done` avec
`data: {models: [{id, name?, contextLength?, pricing?: {promptUsdPerM, completionUsdPerM}, description?}]}`.
Les prix OpenRouter arrivent en $/token (chaînes) → convertis en $/million
(nombres). Champs absents chez d'autres fournisseurs (Ollama) → omis.

### `chat.send`

```json
{"id":"req-4","method":"chat.send","params":{
  "providerId":"ollama","model":"qwen3.5:4b",
  "messages":[{"role":"user","content":"Bonjour"}],
  "options":{"temperature":0.7,"maxTokens":1024}}}
```

- POST `{baseUrl}/chat/completions` avec `stream: true` (+ `stream_options.include_usage`
  si accepté). Parsing SSE : lignes `data: {json}`, sentinelle `data: [DONE]`.
- Réglages R0 du provider résolu (voir `providers.set` — opt-in : un provider
  sans ces champs produit un body strictement identique à avant, ni `models`,
  ni `provider`, ni `usage`) :
  - `fallbackModels` → `body.models = [modèle demandé, …secours]` (demandé en
    tête, sans doublon) — fallback automatique OpenRouter en cas de
    rate-limit / contexte dépassé / indisponibilité. `model` est envoyé aussi
    (OpenRouter l'ignore quand `models` est présent ; les endpoints
    OpenAI-compatibles stricts qui ignorent `models` continuent de
    fonctionner) ;
  - `priceSort: true` → `body.provider = {"sort": "price"}` ;
  - `usageAccounting: true` → `body.usage = {"include": true}`.
- Chaque delta de contenu → `chunk` avec `data: {delta: "texte"}`.
- Fin de stream → `done` avec `data: {finishReason: "stop"|"length"|"aborted"|…,
  "usage": {promptTokens, completionTokens, costUsd, cachedTokens} | null,
  "modelUsed": string | null}`.
  - `costUsd` (`usage.cost` OpenRouter, avec la comptabilité d'usage) et
    `cachedTokens` (`usage.prompt_tokens_details.cached_tokens`) : `null` si
    le fournisseur ne les envoie pas.
  - `modelUsed` : slug du modèle réellement servi (dernier champ `model` vu
    dans le flux SSE — peut différer du demandé quand `models` a joué),
    `null` si jamais vu. Le cas `aborted` le porte aussi (`usage: null`
    inchangé).
- Erreur HTTP (statut ≠ 2xx, corps lu et résumé), réseau ou SSE malformé → `error`.
- `messages` : rôles `system|user|assistant`, transmis tels quels.
- **Ordre des messages (R4, cache-friendly)** : le sidecar transmet
  `messages` tel quel — c'est le CLIENT qui garantit un ordre STABLE, les
  blocs stables précédant les blocs variables pour maximiser les hits de
  cache fournisseur (OpenRouter) : `system` → connaissances/documents
  épinglés (si le client en envoie) → message-résumé de compaction (voir
  `context.compact`) → tours de conversation ; les pièces jointes restent
  portées par le DERNIER message utilisateur (bloc variable de fin). C'est
  l'ordre que construit ChatPage.tsx (`toApiMessages`).
- Requêtes concurrentes autorisées (plusieurs chats en parallèle).

### Pièces jointes (`chat.send`, `claude.start`)

Le DERNIER message utilisateur peut porter des pièces jointes. Paramètre
commun aux deux moteurs :

```json
"attachments": [
  {"kind":"image","name":"capture.png","mediaType":"image/png","data":"<base64>"},
  {"kind":"text","name":"notes.md","content":"…texte brut…"}
]
```

- `kind: "image"` : `mediaType` ∈ `image/png|jpeg|webp|gif`, `data` = base64
  SANS préfixe data-URL. Limites (validées côté sidecar, erreurs françaises) :
  ≤ 8 Mo décodés par image, ≤ 8 pièces par message.
- `kind: "text"` : document texte (md, txt, csv, json, code…), `content`
  transmis tel quel, ≤ 2 Mo. Pas de PDF/binaire en v1.
- **Moteur neutre** (`chat.send`) : le contenu du message devient un tableau
  OpenAI — `[{type:"text",…}, {type:"image_url", "image_url":{"url":
  "data:<mediaType>;base64,<data>"}}]` ; les documents texte sont préfixés au
  texte : `Document joint « <name> » :\n\`\`\`\n<contenu>\n\`\`\``. Modèle
  sans vision → l'erreur du fournisseur est relayée telle quelle (l'UI ne
  préjuge pas des capacités).
- **Moteur Claude** (`claude.start`) : quand des pièces sont présentes, le
  `prompt` chaîne est remplacé par un message SDK à blocs (générateur
  asynchrone d'un unique `SDKUserMessage`) — blocs `image` (source base64)
  pour les images, bloc `text` préfixé pour les documents texte. Sans pièces,
  le chemin chaîne historique est inchangé.
- Les pièces ne sont PAS persistées dans les sessions (volumétrie) : l'UI
  garde nom/type pour l'affichage historique, les octets ne vivent que le
  temps du tour.

### `chat.abort`

```json
{"id":"req-5","method":"chat.abort","params":{"targetId":"req-4"}}
```

Interrompt le `chat.send` en cours dont l'`id` est `targetId` (AbortController).
La requête interrompue émet son `done` avec `finishReason: "aborted"`.
Réponse du abort lui-même : `done` avec `data: {aborted: true|false}` (false si
`targetId` inconnu ou déjà terminé).

## Méthodes Lot 2 — moteur Claude (Agent SDK)

Le sidecar embarque `@anthropic-ai/claude-agent-sdk` (qui inclut son binaire
Claude Code — aucune installation séparée requise). Auth : le process hérite de
l'environnement ; si l'utilisateur est loggé à Claude Code (`~/.claude/`),
l'abonnement est utilisé (usage personnel) ; sinon l'UI peut fournir une clé API
via `claude.configure` (lue du trousseau, compte `provider:claude-api`).
⚠️ CGU : la diffusion publique de l'app avec login abonnement requiert une
approbation Anthropic — voir docs/plan.md (décisions ouvertes).

### `claude.configure`

```json
{"id":"req-9","method":"claude.configure","params":{"apiKey":"sk-ant-…|null"}}
```

Pose (ou retire si null) la clé API utilisée par les prochaines sessions
(en mémoire uniquement, jamais loggée). `done` avec `{configured: bool}`.

### `claude.start`

Un TOUR de conversation agentique = un `claude.start` (le multi-tours passe
par `sessionId` : le SDK recharge tout le contexte via `resume`).

```json
{"id":"req-10","method":"claude.start","params":{
  "cwd":"/chemin/projet",
  "prompt":"Corrige le bug de …",
  "sessionId":"uuid-sdk|null",
  "model":"claude-sonnet-5|null",
  "permissionMode":"default|acceptEdits|plan",
  "systemPrompt":null,
  "chatOnly":false,
  "interactive":false,
  "tools":null,
  "mcp":true}}
```

- `chatOnly: true` = **mode chat pur** (utilisé par l'onglet Chat pour le
  fournisseur « Claude (abonnement) ») : le jeu d'outils intégrés est vidé
  côté SDK (`tools: []`) — le modèle ne voit aucun outil et répond
  directement. Dans ce mode, `cwd` est optionnel (défaut : répertoire
  personnel).
- `webSearch: true` (chat pur seulement, ignoré sinon) : exception au vidage —
  `tools: ["WebSearch", "WebFetch"]`. Outils réseau côté serveur, aucun accès
  disque : le chat peut chercher sur internet. Les demandes de permission
  arrivent par le flux normal ; convention UI (onglet Chat) : accord
  automatique pour ces deux outils quand l'option est active, refus
  automatique de tout le reste (inchangé).
- `tools` (hors chat pur) : allowlist d'outils du tour — sert le champ `tools`
  du manifeste d'agent (§ « Forme d'un agent »), transmis par l'orchestrateur
  et par la page Projets. `null`/absent = palette complète du SDK. Sinon, la
  liste devient la base d'outils INTÉGRÉS exposée au modèle (`options.tools`
  du SDK) : ce qui n'y figure pas n'existe pas pour lui. Ce n'est
  volontairement PAS `allowedTools` (qui se contente d'auto-approuver, donc
  n'aurait rien restreint en `bypassPermissions` — le mode obligatoire des
  tâches planifiées).
  Les noms `mcp__*` sont ignorés dans cette liste : les outils MCP entrent par
  `mcpServers` et se gouvernent par `mcp` (ci-dessous) plus l'allowlist locale
  par serveur (§ MCP) — `mcp__studio__ask_user` et `mcp__iaction__*` restent
  donc disponibles quelle que soit l'allowlist déclarée.
- `mcp: false` : ce tour n'hérite PAS des serveurs MCP du projet (§ MCP plus
  bas). Sert le champ `mcp` du manifeste d'agent, transmis par l'orchestrateur.
  Absent ou `true` = comportement historique (hérite).
- `interactive: true` (ignoré en chat pur) : un humain est devant l'écran et
  peut répondre en direct → l'outil de question `mcp__studio__ask_user` est
  exposé (§ Questions interactives plus bas). Armé par la page Projets
  seulement ; jamais par l'orchestration ni les tâches planifiées.

**Sources de réglages** (hors chat pur) : `settingSources: ['user', 'project',
'local']`. Un tour de projet hérite donc des skills et commandes **globaux du
poste** (`~/.claude/skills`, `~/.claude/commands` — grill-me, maison…) en plus
de ceux du projet (`<cwd>/.claude`) et du `CLAUDE.md` du projet. Décision du
2026-08-03, qui remplace l'isolation stricte d'origine (`['project','local']`,
justifiée alors par l'étanchéité entre projets) : un skill transverse n'a pas à
être recopié dans chaque projet. **Contrepartie assumée** : les réglages
utilisateur globaux (`~/.claude/settings.json` et `settings.local.json` —
`permissions.allow`, `effortLevel`, et les hooks s'il y en avait) s'appliquent
désormais aussi aux tours de l'app.

**Outil `AskUserQuestion` désactivé** : retiré via `disallowedTools` (hors
chat pur, où aucun outil n'est exposé). Son formulaire interactif ne peut être
ni rendu ni répondu par l'API programmatique du SDK v0.3.x — `canUseTool` ne
sait qu'autoriser/refuser (jamais fournir de réponse) et le dialogue
`onUserDialog` n'est jamais émis par le CLI bundlé. Laissé actif, l'outil
s'affichait en bloc brut puis renvoyait un résultat vide, et le modèle
réexpliquait sa question en texte. Il est **remplacé** par notre propre outil
(§ Questions interactives ci-dessous), dont on maîtrise les deux bouts.

**Questions interactives** (`interactive: true`, hors chat pur) : le sidecar
expose un serveur MCP in-process `studio` (voir `sidecar/src/askUser.ts`),
outil `mcp__studio__ask_user`, qui pose 1 à 4 questions à choix et **attend**
la réponse humaine — celle-ci devient le résultat de l'outil, donc le tour
continue sans que l'utilisateur ait à recopier quoi que ce soit.

- Transport : le handler de l'outil émet un chunk `permission_request`
  (`toolName: "mcp__studio__ask_user"`, `toolInput: {questions:[…]}`, même
  charge utile que l'`AskUserQuestion` intégré) et attend le
  `claude.permission` correspondant : `allow` + `message` = réponse rendue au
  modèle, `deny` (ou message vide) = « question ignorée », l'agent poursuit en
  l'annonçant. Aucun nouveau chunk ni nouvelle méthode : côté UI une question
  EST une modale bloquante de plus (rendu à choix cliquables dans
  `AgentPage`).
- L'outil lui-même n'est **jamais** soumis à `canUseTool` (auto-autorisé) :
  la modale de question est déjà l'interaction humaine.
- **La réponse peut ne correspondre à AUCUN choix proposé** : chaque question
  porte une échappatoire « Autre… » (champ libre) dans la modale, en plus du
  complément libre global. En choix unique elle remplace la suggestion, en
  choix multiple elle s'ajoute aux cases cochées (même séparateur ` ; `). Un
  agent ne doit donc jamais présumer que la réponse reçue est l'un de ses
  `options[].label`.
- `interactive` n'est armé que par une page ouverte devant l'utilisateur
  (Projets). Les tours headless (orchestration, tâches planifiées) ne
  l'envoient pas : sans humain, la question bloquerait le tour. Le modèle y
  pose alors ses questions en texte, comme avant.
- Un tour interactif relève `MCP_TOOL_TIMEOUT` (10 min, sauf si le poste l'a
  déjà fixé) : le temps de réflexion de l'humain ne doit pas être coupé par le
  délai d'exécution des outils MCP du CLI.
- Toute question encore en attente à l'interruption ou à la fin du tour est
  close comme « ignorée » — jamais de handler suspendu.

**MCP** : avant de lancer le tour, `claude.start` lit `<cwd>/.mcp.json`
(convention Claude Code : `{"mcpServers": {"<nom>": {…}}}`, config stdio
`{command, args?, env?}` ou distante `{type:"http"|"sse", url, headers?}`).
Fichier absent → comportement inchangé, aucun `mcpServers` transmis au SDK.
Fichier présent : `mcpServers` est passé aux Options du SDK (pas de
re-validation des schémas — c'est le SDK qui s'en charge), après une
validation minimale (chaque entrée doit être un objet non nul) et **trois
filtres** (voir « Méthodes MCP » plus bas) :

1. **interrupteur local** — un serveur listé dans `disabled` de
   `<cwd>/.iaction/mcp.local.json` n'est pas transmis du tout (donc zéro coût
   de contexte) ;
2. **secrets** — toute chaîne `${SECRET:nom}` de l'entrée (dans `env`,
   `headers`, `args`, `url`…) est remplacée par sa valeur, lue dans
   `<config>/mcp-secrets.json` (fichier 0600, hors projet, hors git). Une
   référence introuvable **écarte le serveur** (avertissement au journal,
   scope `mcp`) plutôt que de lancer un serveur à moitié configuré ;
3. **allowlist d'outils** — `allowedTools` de `mcp.local.json`
   (`{serveur: [outils courts]}`) ajoute les outils NON retenus à
   `disallowedTools` des Options, en s'appuyant sur les outils constatés au
   tour précédent (`mcp.runtime.json`).

JSON invalide ou `mcpServers` absent/malformé → le tour n'échoue **jamais**
pour autant : avertissement sur stderr et poursuite sans MCP. En mode
`chatOnly`, `.mcp.json` n'est même pas pris en compte : le chat pur ne doit
voir aucun outil, MCP compris. Les outils exposés par un serveur MCP arrivent
dans les chunks `tool_use`/`tool_result`/`permission_request` existants comme
n'importe quel autre outil, sous le nom `mcp__<serveur>__<outil>` (convention
du SDK) — même flux de permission que les outils intégrés.

**État constaté** : le message `system/init` du SDK porte `mcp_servers`
(`[{name, status}]`) et `tools` (noms complets). Le sidecar en tire un
instantané qu'il (a) renvoie dans le chunk `init`, (b) écrit dans
`<cwd>/.iaction/mcp.runtime.json`, (c) rend en fiche
`<cwd>/.iaction/connaissances/iaction-mcp.md` — liste des outils réels plus
la règle « source avant mémoire », pour que le modèle interroge la source au
lieu de réciter un index périmé. (b) et (c) n'ont lieu que dans un vrai projet
IAction (`.iaction/` existant) et jamais en `chatOnly`. Chaque appel d'outil
MCP terminé produit une ligne de journal (scope `mcp` : serveur, outil, durée,
issue, taille du résultat — jamais d'arguments ni de contenu).

**RAG local (R5)** : quand l'index de connaissances du projet existe
(`<cwd>/.iaction/connaissances-index/`, voir la section « Méthodes R5 »), le
sidecar ajoute un serveur MCP **in-process** `iaction` (via
`createSdkMcpServer`/`tool` du Agent SDK) exposant l'outil
`mcp__iaction__search_knowledge` (args `query`, `topK?`) — même flux de
permission que les autres outils MCP. Sans index : rien n'est ajouté
(comportement inchangé). Un serveur `iaction` déclaré dans `.mcp.json` prime.
Jamais en mode `chatOnly`.

Événements `chunk` typés par `data.kind` :

| kind | data | sens |
|---|---|---|
| `init` | `{sessionId, model, mcpServers?, mcpToolCount?, builtinToolCount?, startupMs?}` | session démarrée (capturer sessionId pour le tour suivant). `mcpServers` = état RÉEL des serveurs MCP (`[{name, status, tools[]}]`, outils en noms courts) ; les décomptes séparent outils MCP et intégrés (coût de contexte) ; `startupMs` = délai jusqu'à l'init, connexion des serveurs comprise. `mcpServers: []` en `chatOnly` (aucun outil) ou quand aucun serveur n'a été monté |
| `text` | `{delta}` | texte assistant au fil de l'eau |
| `thinking` | `{delta}` | raisonnement (si exposé par le SDK) |
| `tool_use` | `{toolUseId, toolName, toolInput}` | l'agent invoque un outil (info) |
| `tool_result` | `{toolUseId, isError, summary, durationMs}` | résultat d'outil (résumé borné 500 c.). `durationMs` = durée mesurée de l'appel pour un outil MCP, `null` pour les outils intégrés |
| `permission_request` | `{permissionId, toolName, toolInput}` | **bloquant** : l'agent veut utiliser un outil soumis à validation (Edit/Write/Bash…) — l'UI doit répondre via `claude.permission`. Pour `Edit` : `toolInput.file_path/old_string/new_string` ; pour `Write` : `file_path/content` → l'UI construit le diff. Cas particulier `toolName: "mcp__studio__ask_user"` : ce n'est pas une permission mais une **question** posée à l'utilisateur (`toolInput.questions[]`) — voir § Questions interactives |
| `background_tasks` | `{count, descriptions[]}` | liste COMPLÈTE des tâches de fond vivantes lancées par le modèle (sous-agents en arrière-plan…) — sémantique REPLACE, `count: 0` = tout est terminé |
| `background_wait` | `{count, descriptions[]}` | le tour du modèle est fini mais `count` tâche(s) de fond tournent encore : le sidecar garde le process ouvert, leurs rapports réveilleront l'agent (le `done` viendra du tour suivant) |
| `compact` | `{trigger, preTokens}` | compaction de contexte terminée (`trigger` = `manual` pour « /compact », `auto` pour la compaction automatique du CLI ; `preTokens` = contexte avant compaction, `null` si inconnu) — un tour « /compact » ne produit AUCUN texte : sans ce chunk, l'UI n'a aucun signal de fin de travail |

Fin de tour : `done` avec
`{sessionId, subtype:"success|error_…", result, usage:{inputTokens,outputTokens,cacheReadInputTokens?}, totalCostUsd}`
(`totalCostUsd` = estimation locale SDK, non contractuelle).

Un `claude.start` peut traverser PLUSIEURS messages `result` du SDK avant son
`done` : (1) un `result` reçu alors que des tâches de fond vivent n'est PAS
final (chunk `background_wait`, le process reste ouvert — le clore tuerait les
tâches) ; (2) un `result` `success` à 0 token sans le moindre contenu
assistant est un micro-tour interne du CLI (ex. livraison de notifications de
tâches sur un `resume`) : ignoré (2 max, garde-fou 30 s), le vrai tour suit.
Le `done` reprend le DERNIER `result` connu ; l'usage n'est journalisé qu'une
fois, sur ce résultat final.
Erreur de spawn/auth → `error` (`data.message` doit rester lisible : suggérer
`claude login` ou une clé API si l'auth échoue).

### `claude.permission`

```json
{"id":"req-11","method":"claude.permission","params":{
  "targetId":"req-10","permissionId":"perm-3",
  "decision":"allow|deny","message":"raison si deny"}}
```

Répond à un `permission_request` en attente. `done` `{applied: bool}`
(false si la demande n'existe plus). Un abort du tour rejette (deny)
automatiquement toutes les demandes en attente.

Même méthode pour répondre à une **question** (`mcp__studio__ask_user`) :
`decision: "allow"` + `message` = la réponse, rendue telle quelle au modèle
comme résultat de l'outil ; `decision: "deny"` (ou `message` vide) = question
ignorée. Un abort clôt les questions en attente de la même façon.

### `claude.abort`

```json
{"id":"req-12","method":"claude.abort","params":{"targetId":"req-10"}}
```

Appelle `query.interrupt()` sur le tour en cours. Le tour interrompu émet son
`done` avec le dernier état connu (`subtype` d'interruption du SDK).
Réponse : `done` `{aborted: bool}`.

### `claude.push`

```json
{"id":"req-12c","method":"claude.push","params":{"targetId":"req-10","content":"ajoute aussi le CHANGELOG"}}
```

Glisse une demande utilisateur dans le tour **en cours** (`targetId`), sans le
couper ni en ouvrir un nouveau : le message est poussé dans l'entrée streamée
que `claude.start` garde ouverte (voir `createTurnPrompt`), et le CLI l'injecte
au **prochain retour d'outil** — même comportement que Claude Code dans VSCode.
Vérifié sur le vrai moteur : message poussé à T+6 s, pris en compte à T+18 s à
la fin du premier `Bash`, dans le même tour (un seul `result`). C'est ce qui
permet d'interroger l'agent pendant qu'il attend ses tâches de fond.

Réponse : `done` `{pushed: bool}` — `false` (jamais une erreur) si le tour
n'existe plus ou a été interrompu ; l'UI se rabat alors sur sa file d'attente
plutôt que de perdre le message. `content` est **texte seul** : pas de pièces
jointes sur un message poussé.

Deux limites de nature, pas d'implémentation : un tour **sans aucun appel
d'outil** n'offre aucun point d'injection (le message ne sera vu qu'au tour
suivant) — c'est le cas du Chat en mode `chatOnly` ; et le moteur neutre
(`neutral.start`) n'a pas d'entrée streamée à alimenter, donc pas de
`claude.push`.

### `claude.release`

```json
{"id":"req-12b","method":"claude.release","params":{"targetId":"req-10"}}
```

Rend la main pendant l'attente des rapports de tâches de fond (phase signalée
par le chunk `background_wait` : le tour du modèle est fini, le process reste
ouvert pour leurs rapports). Clôt le tour proprement — `query.interrupt()`
fait retomber la boucle, dont le repli livre le `done` avec le **résultat déjà
connu** (usage/coût du tour), sans le marquer interrompu. Les tâches de fond
sont abandonnées (leurs rapports ne réveilleront plus l'agent). Réponse :
`done` `{released: bool}` — `false` si le tour n'existe pas ou n'est pas dans
cette phase (en pleine génération, c'est `claude.abort`).

Cette attente est par ailleurs **plafonnée** côté sidecar
(`BACKGROUND_WAIT_TIMEOUT_MS`, 10 min par défaut, surchargable via
l'environnement `IACTION_BACKGROUND_WAIT_TIMEOUT_MS`) : au-delà, même effet
qu'un `claude.release`. Sans plafond, une tâche de fond qui ne se termine
jamais (serveur, watcher) tenait le tour ouvert indéfiniment.

### `claude.commands`

```json
{"id":"req-13","method":"claude.commands","params":{"cwd":"/chemin/projet"}}
```

Énumère les slash-commands / skills invocables pour un projet — alimente le
menu « / » du composeur (UI). Ouvre une session SDK en **entrée streamée**
(prompt = générateur asynchrone qui ne produit AUCUN tour), lit
`query.supportedCommands()` (capturé à l'initialisation, donc **sans consommer
de tour ni de tokens**), puis referme la session. Même `settingSources:
['user','project','local']` que `claude.start` hors chat pur : le menu reflète
exactement ce qu'un tour verra — skills et commandes du projet, intégrés Claude
Code, **et** globaux du poste (`~/.claude/skills`, `~/.claude/commands`).
`done` :

```json
{"commands": [{"name":"code-review","description":"…","argumentHint":"<PR#>","aliases":["review"]}]}
```

`argumentHint`/`aliases` best effort (`""`/absent si le SDK ne les fournit
pas). Échec d'initialisation SDK (auth, cwd invalide) → `error` lisible ;
l'UI se rabat alors sur un menu vide (aucun blocage de la saisie).

### `claude.sessionTitles`

```json
{"id":"req-14","method":"claude.sessionTitles","params":{"cwd":"/chemin/projet","sessionIds":["<uuid>","<uuid>"]}}
```

Récupère les titres déjà calculés par le CLI Claude pour les sessions d'un
projet, afin de remplacer le repli local terne de l'UI (les premiers
caractères du premier message, voir `deriveTitleFromText` dans
`ui/src/sessionStore.ts`). Appelle `listSessions({dir: cwd})` du SDK : une
simple lecture des métadonnées JSONL déjà sur disque, **sans ouvrir de
session ni consommer le moindre token**. `sessionIds` est optionnel ; s'il
est fourni, seules ces sessions sont considérées.

Titre retenu par session : `customTitle` (renommage manuel via `/rename`)
s'il existe, sinon `summary`. Filtré si `summary` n'est en réalité que le
premier prompt tel quel (le SDK y retombe tant qu'aucun titre IA n'a été
calculé) — comparé à `firstPrompt` par préfixe (le SDK tronque parfois
`summary`) : dans ce cas la session est absente du résultat, l'UI garde alors
son repli local. `done` :

```json
{"titles": [{"sessionId":"<uuid>","title":"Organiser tâches sprint 2 et études stratégiques"}]}
```

Best effort, **ne lève jamais** : SDK indisponible, `cwd` inconnu du CLI ou
aucune session → `done` `{titles: []}` (jamais `error`), amélioration
purement cosmétique qui ne doit jamais bloquer l'affichage du panneau
Sessions.

## Méthodes Lot 6 — agent du moteur neutre (« tous agents à égalité »)

Boucle agentique tool-calling OpenAI-compatible dans le sidecar, pour donner
aux fournisseurs neutres (Ollama, OpenRouter, custom) les mêmes capacités
d'agent que Claude — même contrat d'événements que `claude.start`
(chunks `kind=init|text|tool_use|tool_result|permission_request`, `done`,
`error`), donc même UI.

### `neutral.start`

```json
{"id":"req-20","method":"neutral.start","params":{
  "providerId":"ollama","model":"qwen3.5:9b",
  "cwd":"/chemin/projet",
  "messages":[{"role":"system","content":"…"},{"role":"user","content":"…"}],
  "permissionMode":"default|acceptEdits|bypassPermissions",
  "tools":null,
  "maxTurns":24}}
```

- Moteur SANS état de session : l'UI envoie tout l'historique `messages`
  (le dernier élément = nouveau message utilisateur). Le chunk `init` renvoie
  `{sessionId: null, model}`.
- Boucle : POST chat/completions stream avec la palette d'outils ; chaque
  `tool_calls` → exécution locale (voir palette) → renvoi du résultat →
  itération, jusqu'à réponse finale sans outil ou `maxTurns` atteint
  (alors `done.subtype="max_turns"`).
- `done` : `{sessionId:null, subtype:"success|max_turns|aborted|…",
  result, usage:{inputTokens,outputTokens} (cumulé), totalCostUsd:null}`.
- R6-A : les réglages provider R0 (`fallbackModels`, `priceSort`,
  `usageAccounting` — voir `providers.set`) s'appliquent aussi aux
  complétions de la boucle, et l'usage étendu remonté (`usage.cost`, tokens
  cachés) est cumulé dans l'événement `events.jsonl` du tour
  (`costUsd`/`cachedTokens` — voir la section S1). `meta.routeDebord: true`
  force `usage: {include: true}` même sans `usageAccounting` (base du
  plafond de débord).
- `tools` : même allowlist que `claude.start` (champ `tools` du manifeste
  d'agent). `null`/absent = palette complète. Sinon, seuls les outils retenus
  sont DÉCLARÉS au modèle, et un appel à un outil écarté est refusé à
  l'exécution (`outil non autorisé pour cet agent`). Les noms acceptés sont
  ceux de la palette neutre (`read_file`, `bash`…) **et** leurs équivalents
  Claude Code (`Read` → `read_file`, `Grep`/`Glob` → `search`/`list_dir`,
  `Write` → `write_file`, `Edit` → `edit_file`, `Bash` → `bash`) : un agent
  `engine: auto` ne sait pas sur quel moteur il tombera. Un nom inconnu des
  deux mondes est ignoré — une allowlist qui ne désigne rien laisse l'agent
  sans aucun outil, jamais avec la palette complète. `search_knowledge` (RAG,
  lecture seule) échappe à l'allowlist, comme les outils MCP côté Claude.
- `neutral.permission` / `neutral.abort` : mêmes contrats que
  `claude.permission` / `claude.abort` (params `targetId`/`permissionId`…).

### Palette d'outils du moteur neutre

Tous les chemins sont résolus relativement à `cwd` et DOIVENT rester dans
`cwd` (garde anti-traversée : résolution + préfixe, sinon erreur d'outil).

| outil | input | permission | comportement |
|---|---|---|---|
| `read_file` | `{path, maxBytes?}` | non | contenu texte (cap 256 Ko, binaire → erreur d'outil) |
| `list_dir` | `{path?}` | non | entrées `{name,isDir,size}` (cap 500) |
| `search` | `{pattern, path?, maxResults?}` | non | grep -rn (regex simple), résultats `fichier:ligne:texte` (cap 100), ignore .git/node_modules/target/dist |
| `search_knowledge` | `{query, topK?}` | non | R5 — recherche dans les connaissances indexées du projet (voir « Méthodes R5 ») ; index absent → erreur d'outil lisible |
| `write_file` | `{path, content}` | **oui** | écriture atomique (création parents) |
| `edit_file` | `{path, old_string, new_string}` | **oui** | remplacement d'une occurrence exacte (0 ou >1 → erreur d'outil explicite) |
| `bash` | `{command, timeoutMs?}` | **oui** | exécution sh -c dans cwd, env nettoyée des variables Snap, timeout défaut 30 s (cap 300 s), sortie tronquée 10 Ko |

- `permissionMode` : `default` = permission pour write_file/edit_file/bash ;
  `acceptEdits` = write_file/edit_file auto, bash demandé ;
  `bypassPermissions` = tout auto. (Pas de mode `plan` côté neutre.)
- Les `permission_request` portent `toolName` (`write_file`/`edit_file`/`bash`)
  et `toolInput` — l'UI réutilise la même modale/diff que pour Claude
  (edit_file expose old_string/new_string comme l'outil Edit du SDK).

## Méthodes conso (mini-tranche du Lot 8)

### `usage.openrouter`

```json
{"id":"req-13","method":"usage.openrouter","params":{"providerId":"openrouter"}}
```

GET `{baseUrl}/credits` (API officielle OpenRouter, clé requise) →
`done` `{totalCredits, totalUsage, remaining}` (montants en dollars).
Erreur HTTP/réseau/clé absente → `error`.

### `usage.claude`

```json
{"id":"req-14","method":"usage.claude","params":{}}
```

Renvoie le **dernier instantané connu** des limites d'abonnement, capturé en
fin de chaque tour `claude.start` via la méthode expérimentale du SDK
(`usage_EXPERIMENTAL…` — voie officielle, instable : tout est optionnel et
enveloppé défensivement). `done` :

```json
{"available": true,
 "subscriptionType": "max|pro|…|null",
 "fiveHour": {"utilization": 42, "resetsAt": "ISO"},
 "sevenDay": {"utilization": 13, "resetsAt": "ISO"},
 "windows": {"five_hour": {"utilization": 42, "resetsAt": "ISO"},
             "seven_day": {"utilization": 13, "resetsAt": "ISO"},
             "seven_day_opus": {"utilization": 7, "resetsAt": "ISO"}},
 "capturedAt": "ISO"}
```

`windows` relaie **toutes** les fenêtres présentes dans `rate_limits` (clé
brute de l'API → fenêtre), y compris celles spécifiques à un modèle (ex.
hebdo Opus/Fable) dont le nommage n'est pas garanti par cette API
expérimentale. `fiveHour`/`sevenDay` restent extraits à part (compatibilité).

Contrainte vérifiée en réel : la méthode d'usage du SDK est une requête de
contrôle vers le processus CLI et doit partir PENDANT le tour (après le
message `result`, elle échoue : « ProcessTransport is not ready for
writing ») — d'où la capture opportuniste sur les messages `assistant`.

### `usage.claude.init`

```json
{"id":"req-15","method":"usage.claude.init","params":{}}
```

Initialise le relevé sans conversation : joue un micro-tour chat pur
(`claude-haiku-4-5`, prompt « ping », aucun outil, cwd = home) et renvoie le
même `done` que `usage.claude` (instantané capturé pendant ce tour, mémorisé
comme dernier instantané connu). Coût négligeable ; à réserver à une action
explicite de l'utilisateur (bouton ↻ de l'encart conso). Erreur du micro-tour
→ `error`.

`{"available": false}` tant qu'aucun tour Claude n'a été joué dans cette
session sidecar (ou si les limites ne s'appliquent pas — clé API).

## Méthodes O1 — agents & orchestrations (CRUD YAML)

Nouveau module `sidecar/src/orchestrator.ts` (voir docs/etude-orchestration.md,
§4 « Formats de fichiers », dont ce contrat est la traduction protocole).
CRUD de fichiers YAML décrivant des **agents** et des **orchestrations**, par
portée projet et globale, avec import lecture seule des agents Claude Code.
**Aucune exécution dans cette phase** (pas de méthode `orch.run` — prévue en
phase O3).

### Répertoires

| Portée | Agents | Orchestrations |
|---|---|---|
| Projet | `<cwd>/.iaction/agents/*.yaml` | `<cwd>/.iaction/orchestrations/*.yaml` |
| Globale | `${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/agents/*.yaml` | `.../net.duvam.iaction/orchestrations/*.yaml` |
| Import Claude Code (agents seulement, lecture seule) | `<cwd>/.claude/agents/*.md` | — |

`XDG_CONFIG_HOME` est relu à chaque appel (jamais mis en cache) : la valeur
courante de la variable d'environnement du process sidecar fait foi.

### Forme d'un agent (normalisée, camelCase)

```json
{
  "name": "relecteur-rust",
  "description": "Relit les diffs Rust et signale les pièges unsafe/perf.",
  "engine": "claude",
  "provider": null,
  "model": "claude-fable-5",
  "permissionMode": "acceptEdits",
  "instructions": "Tu es relecteur. Réponds en français. …",
  "tools": null,
  "mcp": true,
  "knowledge": [],
  "maxTurns": 12
}
```

- `engine` : `"claude"`, `"neutral"` ou `"auto"` (R2 — moteur/modèle résolus
  par le routeur à l'exécution, voir « Méthodes R1/R2/R3 — routage »).
- `permissionMode` : `"default"` | `"acceptEdits"` | `"plan"` | `"bypassPermissions"`.
- `tools: null` = palette complète (pas de restriction) ; sinon allowlist de
  noms d'outils, APPLIQUÉE par les deux moteurs (voir `claude.start` et
  `neutral.start` : outils intégrés seulement — le MCP se gouverne par `mcp`).
- Défauts si le champ est absent du YAML : `engine: "claude"`,
  `provider: null`, `model: null`, `permissionMode: "default"`,
  `instructions: ""`, `tools: null`, `mcp: true`, `knowledge: []`,
  `maxTurns: null`, `description: ""`.
- Validation (messages d'erreur en français, précisant le champ fautif) :
  - `name` requis, `[a-z0-9-]{1,64}`.
  - `engine: "neutral"` ⇒ `provider` requis (chaîne non vide).
  - `engine: "auto"` (R2) ⇒ `model` omis ou `"auto"` (normalisé en `null`) —
    la cible réelle vient du routeur au lancement du run ; si le routeur
    envoie vers le moteur neutre, un `permissionMode: "plan"` est replié sur
    `"default"` (le mode plan n'existe pas côté neutre).
  - `permissionMode: "plan"` interdit si `engine: "neutral"`.
  - `tools`, `knowledge` : listes de chaînes si présentes.
  - `maxTurns` : entier ≥ 1 si présent (ou absent/null).

### Forme d'une orchestration (normalisée, camelCase)

```json
{
  "name": "revue-complete",
  "description": "Relecture parallèle puis synthèse.",
  "inputs": [{ "name": "cible", "label": "Fichier ou dossier à relire" }],
  "steps": [
    { "id": "relecture-rust", "agent": "relecteur-rust", "task": "Relis {{cible}}…", "needs": [] },
    { "id": "synthese", "agent": "synthetiseur", "task": "Synthétise…", "needs": ["relecture-rust"] }
  ],
  "limits": { "maxParallel": 2, "maxDurationMin": 30 }
}
```

- Défauts : `inputs: []`, `description: ""`, `needs: []` par étape,
  `limits: {maxParallel: 2, maxDurationMin: 30}`.
- Validation :
  - `name` requis, `[a-z0-9-]{1,64}` ; chaque `steps[].id` idem, et unique.
  - Au moins une étape ; chaque étape a un `agent` et un `task` non vides.
  - Chaque entrée de `needs` doit référencer un `id` d'étape existant, sinon
    erreur explicite (« l'étape 'x' référence une dépendance inconnue… »).
  - **Pas de cycle** dans le graphe `needs` : détection topologique (DFS),
    message d'erreur citant le chemin du cycle trouvé, ex. :
    `cycle détecté dans les dépendances (needs): a → b → a`.
  - `limits.maxParallel` / `limits.maxDurationMin` : entiers ≥ 1 si présents.

### `agents.list`

```json
{"id":"req-30","method":"agents.list","params":{"cwd":"/chemin/projet"}}
```

`cwd: null` = pas de projet ouvert (n'affecte que le scope « projet » et
l'import Claude Code, tous deux omis ; le scope global reste actif).

Fusionne : agents projet (si `cwd` non null) + agents globaux + import
`<cwd>/.claude/agents/*.md` (si `cwd` non null). `done` :

```json
{"agents": [{
  "...": "forme normalisée ci-dessus",
  "scope": "project|global|claude-code",
  "path": "/chemin/absolu/du/fichier",
  "readOnly": false,
  "invalid": "message si le fichier n'a pas pu être chargé (optionnel)"
}]}
```

- Un fichier YAML illisible ou invalide n'est **jamais omis** : il apparaît
  avec `invalid: "<message>"` (le reste des champs porte les valeurs par
  défaut, `name` = nom de fichier sans extension) pour que l'UI l'affiche au
  lieu de le faire disparaître silencieusement.
- Import Claude Code (`.claude/agents/*.md`) : frontmatter YAML entre deux
  lignes `---` (`name`, `description`, `tools` — `tools` accepté en liste ou
  en chaîne `"Read, Write, Bash"`, éclatée sur les virgules) ; le corps
  markdown après le second `---` devient `instructions` (`trim()`). `engine`
  forcé à `"claude"`, `scope: "claude-code"`, `readOnly: true`. Frontmatter
  absent/malformé → entrée `invalid` (jamais d'erreur bloquante pour le reste
  de la liste).
- Collision de nom entre scopes : **toutes** les entrées sont renvoyées (le
  sidecar ne déduplique pas) ; convention côté UI : le projet gagne sur le
  global gagne sur l'import Claude Code.

### `agents.read`

```json
{"id":"req-31","method":"agents.read","params":{"cwd":"/chemin/projet","path":"/chemin/projet/.iaction/agents/relecteur-rust.yaml"}}
```

`done` : `{"agent": {"...": "forme normalisée"}, "raw": "contenu texte exact du fichier"}`.

Garde anti-traversée : `path` (résolu) doit préfixer l'un des répertoires
d'agents reconnus — `<cwd>/.iaction/agents`, `<cwd>/.claude/agents` (si `cwd`
fourni), ou le dossier global — sinon `error`. Fichier `.md` : lu via le même
parseur de frontmatter que `agents.list`. YAML/frontmatter invalide → `error`
(message précis, nom de fichier inclus).

### `agents.write`

```json
{"id":"req-32","method":"agents.write","params":{
  "cwd":"/chemin/projet","scope":"project",
  "raw":"# commentaire\nname: relecteur-rust\n…"}}
```

- Exactement **un** de `raw` ou `agent` (jamais les deux, jamais aucun) →
  sinon `error`.
- `raw` : parsé, validé, puis **écrit tel quel** (préserve les commentaires
  de l'utilisateur) — `raw` invalide (YAML cassé ou champs invalides) →
  `error`, rien n'est écrit.
- `agent` : normalisé puis sérialisé en YAML lisible (`lineWidth: 0`, pas de
  retour à la ligne forcé dans les chaînes longues).
- `scope: "project"` exige `cwd` non vide ; `scope: "global"` l'ignore.
- Fichier cible : `<dossier-du-scope>/agents/<name>.yaml` (le nom vient de
  l'agent validé, pas du nom de fichier précédent — un changement de `name`
  crée un nouveau fichier). Écriture atomique (fichier temporaire + rename),
  répertoire créé si besoin (`mkdir -p`).
- `done` : `{"agent": {"...": "normalisé"}, "path": "/chemin/absolu"}`.

### `agents.delete`

```json
{"id":"req-33","method":"agents.delete","params":{"cwd":"/chemin/projet","path":"/chemin/projet/.iaction/agents/x.yaml"}}
```

Garde anti-traversée stricte : `path` doit préfixer `<cwd>/.iaction/agents`
(si `cwd` fourni) ou le dossier global — **jamais** `.claude/agents`, qui
n'est pas supprimable depuis ce protocole (import lecture seule). Chemin hors
de ces répertoires ou suppression impossible → `error`. `done` : `{"deleted": true}`.

### `orch.list` / `orch.read` / `orch.write` / `orch.delete`

Mêmes conventions que `agents.*`, appliquées aux fichiers
`.iaction/orchestrations/*.yaml` (projet) et
`.../net.duvam.iaction/orchestrations/*.yaml` (global) — **pas d'import
Claude Code** (une orchestration n'a pas d'équivalent côté Claude Code).

- `orch.list {cwd}` → `done {"orchestrations": [{"...": "forme normalisée", "scope": "project|global", "path", "readOnly": false, "invalid"?}]}`.
- `orch.read {path, cwd}` → `done {"orchestration": {...}, "raw": "..."}` (mêmes gardes anti-traversée, restreintes aux deux répertoires d'orchestrations).
- `orch.write {cwd, scope, raw?|orchestration?}` → `done {"orchestration": {...normalisée}, "path"}` (mêmes règles raw/objet, atomique, `<dossier>/orchestrations/<name>.yaml`).
- `orch.delete {cwd, path}` → `done {"deleted": true}` (mêmes gardes).

## Méthodes O3 — exécution d'orchestrations

Toujours dans `sidecar/src/orchestrator.ts` (voir docs/etude-orchestration.md
§6). `orch.run` exécute un DAG d'étapes → agents en réutilisant
`handleClaudeStart`/`handleNeutralStart` (et leurs `*.permission`/`*.abort`)
comme **briques internes**, SANS dupliquer leur logique : chaque étape tourne
sous un id interne `<runId>::<stepId>` (le `id` de la requête `orch.run` sert
de `runId`) avec un émetteur synthétique qui relaie ses chunks moteur en
`step_chunk` et traduit son `done`/`error` en `step_done`/`step_failed`.
Testabilité : un « stepRunner » (les vrais moteurs par défaut) est injectable
via `createOrchestratorRuntime({stepRunner})`, réservé aux tests.

### `orch.run`

```json
{"id":"req-40","method":"orch.run","params":{
  "cwd":"/chemin/projet","name":"revue-complete",
  "inputs":{"cible":"src/main.rs"}}}
```

Charge l'orchestration `name` (projet puis global) et résout `step.agent`
pour chaque étape (projet > global > import Claude Code — mêmes règles de
priorité qu'`agents.list`). **Erreurs de résolution AVANT tout
`run_started`** (`error` immédiat, rien n'est démarré) :

- orchestration `name` introuvable ou invalide (fichier cassé sur disque) ;
- un `step.agent` introuvable ou invalide, pour n'importe quelle étape ;
- templating invalide (voir plus bas) : `{{steps.<id>.output}}` référençant un
  id absent des `needs` de l'étape, ou input **déclaré** et **utilisé** dans
  une `task` mais absent de `params.inputs`.

Une fois la résolution validée, chunks streamés (`id` de corrélation =
`runId`, réutilisé pour `orch.permission`/`orch.abort`) :

| kind | data | sens |
|---|---|---|
| `run_started` | `{steps:[{stepId, agent, engine, model}]}` | une fois, ordre du fichier orchestration ; pour une étape d'agent `engine: auto`, la cible n'est pas encore connue → `engine: "auto"`, `model: null` (résolue au démarrage de l'étape, voir `step_started`) |
| `step_started` | `{stepId, engine, model, routeTier?}` | l'étape démarre (toutes ses `needs` ont réussi) ; `engine`/`model` = cible **effective** de l'étape — pour un agent `engine: auto`, résolue par le routeur À CE MOMENT-LÀ sur la tâche **rendue**, avec `routeTier` (tier retenu) ; `routeTier` absent pour un agent à moteur explicite |
| `step_chunk` | `{stepId, chunk}` | `chunk` = chunk moteur **TEL QUEL** (kind `init`/`text`/`thinking`/`tool_use`/`tool_result`/`permission_request`) — relais transparent, aucune réécriture |
| `step_done` | `{stepId, output, usage}` | `output` = texte final de l'étape (claude : `result` du moteur ; neutral : concaténation des deltas `text` relayés), borné 200 000 caractères (mention de troncature) ; `usage` = `usage` du `done` moteur ou `null` |
| `step_failed` | `{stepId, message}` | l'étape a échoué (erreur moteur, ou `done` de subtype autre que succès/`max_turns`/`aborted`) |
| `step_skipped` | `{stepId, reason}` | une dépendance (`needs`) a échoué, a été sautée ou annulée ; `reason` = `"étape sautée : dépendance <id> en échec"` |

Pas de `step_chunk`/événement dédié pour une étape `aborted` (un abort en
cours de route se voit uniquement dans le statut terminal, voir `orch.abort`).

**Sémantique DAG** : une étape démarre dès que toutes ses `needs` sont à
`success`. Si une `needs` échoue/est sautée/est annulée, l'étape est marquée
`skipped` (cascade multi-niveaux : sauter une étape peut en sauter d'autres en
aval). Parallélisme borné par `limits.maxParallel` (défaut 2). Coupe-circuit
`limits.maxDurationMin` (défaut 30) : à l'échéance, `abort` de toutes les
étapes en cours (comme `orch.abort`), le run se termine en `aborted`.

**Templating** (`task` de chaque étape, remplacement textuel simple, tokens
inconnus laissés tels quels) :

- `{{<nomInput>}}` → valeur fournie dans `params.inputs` (chaînes uniquement).
- `{{steps.<id>.output}}` → `output` de l'étape `<id>`, disponible seulement
  si `<id>` figure dans les `needs` de l'étape courante (sinon erreur de
  validation avant tout démarrage — voir ci-dessus).

**Agents `engine: auto`** (R2, révisé 2026-07-31) : la résolution de routage
n'a plus lieu au lancement du run mais au **démarrage de chaque étape**, sur
le texte **rendu** de sa tâche (les `{{…}}` interpolés — c'est ce que le
modèle recevra) : une tâche courte au template mais volumineuse une fois
rendue (ex. `Résume : {{steps.collecte.output}}`) est classée sur sa taille
réelle, et le débord/plafond (R3/R6) est re-vérifié au moment où l'étape
démarre (un plafond fermé en cours de run est donc pris en compte). La cible
résolue est annoncée par `step_started` (`engine`/`model`/`routeTier`, voir
tableau) ; `run_started` annonce `engine: "auto"`, `model: null`.

**Exécution d'une étape**, selon `engine` de l'agent résolu :

- `engine: "claude"` → `handleClaudeStart` interne avec
  `{cwd, prompt: <task templatée>, model: agent.model, permissionMode: agent.permissionMode,
  systemPrompt: agent.instructions, chatOnly: false, mcp: agent.mcp}`.
- `engine: "neutral"` → `handleNeutralStart` interne avec
  `{providerId: agent.provider, model: agent.model, cwd,
  messages: [{role:"system", content: agent.instructions}? (si non vide), {role:"user", content: <task templatée>}],
  permissionMode: agent.permissionMode, maxTurns: agent.maxTurns ?? défaut existant (omis si null, le moteur applique son propre défaut)}`.

Fin de run : `done`

```json
{"status": "success|partial|failed|aborted",
 "steps": {
   "<stepId>": {"status": "success|failed|skipped|aborted",
                "output": "…(optionnel, borné 8000 c. — l'intégral est dans step_done)",
                "message": "…(optionnel : raison d'échec/skip)"}
 }}
```

- `success` : toutes les étapes ont réussi.
- `failed` : aucune étape n'a réussi.
- `partial` : au moins un succès ET au moins un échec/skip.
- `aborted` : le run a été annulé (`orch.abort` ou coupe-circuit
  `maxDurationMin`) — prime sur les trois autres statuts même en cas de
  succès partiels avant l'annulation.

### `orch.permission`

```json
{"id":"req-41","method":"orch.permission","params":{
  "targetId":"req-40","stepId":"relecture-rust","permissionId":"perm-3",
  "decision":"allow|deny","message":"raison si deny","updatedInput":{}}}
```

Route vers `handleClaudePermission`/`handleNeutralPermission` de l'étape
concernée (selon son moteur), avec `targetId` réécrit vers l'id interne
`<targetId>::<stepId>`. `done` `{applied: bool}` (`false` si l'étape n'est
plus en cours ou le couple `targetId`/`stepId`/`permissionId` ne correspond à
rien). `updatedInput` est accepté et relayé pour compatibilité future ; les
moteurs actuels ne l'exploitent pas encore (seul `allow`/`deny` simple est
appliqué).

### `orch.abort`

```json
{"id":"req-42","method":"orch.abort","params":{"targetId":"req-40"}}
```

Abandonne le run `targetId` (id du `orch.run` correspondant) : `abort` de
toutes les étapes en cours (`handleClaudeAbort`/`handleNeutralAbort`), les
étapes pas encore démarrées passent directement au statut `aborted` (jamais
`skipped` — cette annulation-là n'est pas une cascade de dépendance en
échec). Réponse immédiate : `done {aborted: bool}` (`false` si `targetId` ne
correspond à aucun run actif). Le `orch.run` correspondant se termine
ensuite, de façon asynchrone, avec `status: "aborted"`.

## Méthodes T1 — tâches planifiées

Une **tâche** est un agent récurrent : un dossier autonome portant un
manifeste, ses agents/orchestrations `.iaction/`, son éventuel `.mcp.json`
et ses rapports datés (voir `docs/etude-taches.md`). Répertoire racine :
`${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/taches/<nom>/`
(`XDG_CONFIG_HOME` relu à chaque appel, comme pour les agents globaux).
Le manifeste est `<dossier>/tache.yaml`.

En T1 le sidecar ne planifie rien : la cadence (`schedule`) est déclarative,
exécutée par un timer systemd user (piloté depuis l'app en T2).

### Forme d'une tâche (normalisée, camelCase)

```json
{
  "name": "menage-mails",
  "description": "Ménage quotidien de la boîte mail.",
  "orchestration": "menage-mails",
  "schedule": "*-*-* 08:15",
  "inputs": { "date": "{{today}}" },
  "report": "rapports/{{today}}.md",
  "enabled": true,
  "cwd": "/home/moi/mon-projet",
  "lieu": "local"
}
```

- Défauts si champ absent : `description: ""`, `schedule: null`,
  `inputs: {}`, `report: null`, `enabled: false`, `cwd: null`,
  `lieu: "local"`.
- Validation (messages en français, champ fautif cité) :
  - `name` requis, `[a-z0-9-]{1,64}`, et DOIT être égal au nom du dossier.
  - `orchestration` requise, `[a-z0-9-]{1,64}` (l'existence du fichier
    `.iaction/orchestrations/<nom>.yaml` n'est PAS exigée à l'écriture —
    l'UI la signale, le run échouera proprement sinon).
  - `schedule` : chaîne non vide si présente (syntaxe `OnCalendar` systemd,
    non validée par le sidecar — systemd fait foi en T2).
  - `inputs` : objet `{clef: chaîne}` (les valeurs sont des gabarits).
  - `report` : chemin RELATIF au dossier de la tâche, sans `..` ni chemin
    absolu.
  - `enabled` : booléen.
  - `cwd` : chemin ABSOLU si présent — répertoire projet passé au runner
    headless et à « Lancer maintenant » : l'orchestration (et ses agents,
    routage compris) est alors résolue dans `<cwd>/.iaction/`, ce qui permet
    à une tâche de cibler une orchestration DU PROJET (versionnée dans son
    repo). Absent/null = comportement historique, cwd = dossier de la tâche
    (orchestrations globales seulement).
  - `lieu` : `"local"` ou `"serveur"` — **rien d'autre**. Absent/null →
    `"local"` ; toute autre valeur (`"server"`, `"Serveur"`, `"serveur "`…)
    est REFUSÉE par une `error` citant la valeur reçue, jamais ramenée
    silencieusement au défaut. `local` = exécutée par le timer systemd du
    poste (§ T2) ; `serveur` = exécutée par le conteneur `ia-runner`, depuis
    une racine de tâches distincte et synchronisée. C'est le garde-fou
    anti-double-déclenchement (voir `docs/etude-remote.md` § 3 bis) : chaque
    exécuteur ne prend que les tâches de son lieu, une tâche n'est donc jamais
    armée des deux côtés. Le champ fait l'aller-retour sans perte, y compris
    par le mode `tache` de `taches.write` qui ré-sérialise le manifeste —
    l'effacer ferait retomber une tâche serveur en `local` sans aucun signal.
- Gabarit `{{today}}` (date locale `YYYY-MM-DD`) : résolu **au lancement**
  par l'appelant (UI « Lancer maintenant », runner headless/timer) — le
  sidecar stocke et renvoie le gabarit tel quel.
- LLM `auto` (R2) : le manifeste `tache.yaml` ne déclare pas de LLM
  lui-même — le LLM d'une tâche vient des **agents** de son orchestration
  (`.iaction/agents/` du dossier de la tâche). Un agent `engine: auto` y est
  résolu via le routeur **au lancement du run** (`orch.run`, cwd = dossier
  de la tâche — la surcharge `.iaction/routage.yaml` du dossier s'applique),
  texte = tâche de l'étape ; voir « Méthodes R1/R2/R3 — routage ».

### `taches.list`

```json
{"id":"req-50","method":"taches.list","params":{}}
```

`done` : `{"taches": [{…forme normalisée, "path": "/chemin/absolu/du/dossier",
"invalid": "message si tache.yaml illisible/invalide (optionnel)"}]}`.

Parcourt les sous-dossiers du répertoire racine qui contiennent un
`tache.yaml`. Même convention que `agents.list` : une entrée invalide n'est
jamais omise (`invalid` + défauts + `name` = nom du dossier). Racine absente
→ `{"taches": []}` (pas une erreur). Tri par `name`.

### `taches.read`

```json
{"id":"req-51","method":"taches.read","params":{"name":"menage-mails"}}
```

`done` : `{"tache": {…}, "raw": "contenu texte exact de tache.yaml", "path": "/chemin/du/dossier"}`.
`name` validé `[a-z0-9-]{1,64}` (garde anti-traversée). Manifeste absent ou
invalide → `error` précise.

### `taches.write`

```json
{"id":"req-52","method":"taches.write","params":{"tache":{"name":"veille","orchestration":"veille",…}}}
{"id":"req-53","method":"taches.write","params":{"name":"veille","raw":"# commentaire préservé\nname: veille\n…"}}
```

Deux modes exclusifs, comme `agents.write` : `tache` (objet normalisé,
sérialisé en YAML) ou `raw` (texte écrit tel quel après validation — les
commentaires sont préservés). En mode `raw`, `params.name` est requis et doit
égaler le `name` du YAML. Crée le dossier de la tâche (et `rapports/`) au
besoin ; écriture atomique (fichier temporaire + rename). `done` :
`{"tache": {…}, "path": "…"}`.

### `taches.delete`

```json
{"id":"req-54","method":"taches.delete","params":{"name":"veille"}}
```

Supprime **uniquement `tache.yaml`** : le dossier, ses `.iaction/`, son
`.mcp.json` et ses `rapports/` restent en place (une tâche se « dé-déclare »,
son historique ne s'efface pas d'un clic). `done` : `{"deleted": true}` ;
manifeste absent → `error`.

### `taches.reports`

```json
{"id":"req-55","method":"taches.reports","params":{"name":"menage-mails"}}
```

`done` : `{"reports": [{"file":"2026-07-19.md","mtimeMs":…, "size":…}]}` —
fichiers `*.md` directement sous `<dossier>/rapports/` (pas de récursion),
triés du plus récent au plus ancien (mtime). Dossier absent → `{"reports": []}`.

### `taches.reportRead`

```json
{"id":"req-56","method":"taches.reportRead","params":{"name":"menage-mails","file":"2026-07-19.md"}}
```

`done` : `{"content": "…"}`. `file` : nom simple `[A-Za-z0-9._-]+\.md`, sans
séparateur de chemin (garde anti-traversée) ; fichier absent → `error`.

## Méthodes T2 — timers systemd des tâches

Le sidecar **génère et pilote** les unités systemd user d'une tâche — il ne
planifie rien lui-même (voir `docs/etude-taches.md` § 3.2). Convention :
`iaction-tache-<nom>.service` + `.timer` dans `~/.config/systemd/user/`
(nom d'unité dérivé du `name` validé `[a-z0-9-]{1,64}` — jamais d'autre
forme). Les unités sont regénérées à chaque `taches.timerApply` : toute
modification manuelle y est écrasée.

Contenu généré :

- **service** (`Type=oneshot`) : `ExecStart=<node> <runner> <dossier-tâche>
  <orchestration> [--input clef=gabarit]… [--save-output
  <dossier>/rapports/…]` — `<node>` = `process.execPath` du sidecar,
  `<runner>` = `scripts/orch-run-headless.mjs` résolu relativement au dist du
  sidecar (l'app et le timer utilisent donc le même dépôt). AUCUNE
  substitution shell : les gabarits `{{today}}` partent tels quels, le runner
  les résout en date locale au lancement (voir sa section). Sortie du run
  ET erreurs ajoutées au MÊME fichier `<dossier>/rapports/journal.log`
  (`StandardOutput=append:…`, `StandardError=append:…`) : une tâche tourne
  sans humain devant, ses échecs doivent atterrir dans son journal à elle et
  non dans le journal systemd (voir [etude-logs.md](etude-logs.md) § 3).
- **timer** : `OnCalendar=<schedule>`, `Persistent=true`,
  `WantedBy=timers.target`.

### `taches.timerStatus`

```json
{"id":"req-60","method":"taches.timerStatus","params":{"names":["menage-mails"]}}
```

`names` absent → toutes les tâches déclarées (`taches.list`). `done` :

```json
{"timers": {"menage-mails": {
  "unit": "iaction-tache-menage-mails.timer",
  "exists": true, "enabled": true, "active": true,
  "nextMs": 1784528100000, "lastMs": 1784441700000
}}}
```

Via `systemctl --user show` (`LoadState`, `UnitFileState`, `ActiveState`,
`NextElapseUSecRealtime`, `LastTriggerUSec`). `exists: false` (LoadState
`not-found`) ⇒ les autres champs `false`/`null`. `nextMs`/`lastMs` en ms
epoch, `null` si systemd ne fournit rien. `systemctl` indisponible → `error`
globale (pas de statuts partiels).

### `taches.timerApply`

```json
{"id":"req-61","method":"taches.timerApply","params":{"name":"menage-mails"}}
```

Lit le manifeste (erreur s'il est invalide) ; **`schedule` requis** (erreur
sinon). Écrit les deux unités (écriture atomique), `daemon-reload`, puis
`enable --now` du `.timer` si `enabled: true`, `disable --now` sinon (les
unités restent en place, prêtes à être réarmées). `done` :
`{"unit": "iaction-tache-<nom>.timer", "enabled": bool}`.

### `taches.timerRemove`

```json
{"id":"req-62","method":"taches.timerRemove","params":{"name":"menage-mails"}}
```

`disable --now` (tolérant si l'unité n'existe pas), supprime les deux
fichiers d'unités (tolérant s'ils sont absents), `daemon-reload`. `done` :
`{"removed": true}`. Convention UI : appelé avant `taches.delete` pour ne
jamais laisser un timer orphelin continuer à tirer.

## Méthodes S1 — supervision d'usage (Lot 8, tranche 1)

Historisation locale au fil de l'eau, côté sidecar, en JSONL (append,
tolérant : une ligne illisible est ignorée à la lecture). Répertoire :
`${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/usage/`. Rotation
simple : fichier > 20 Mo → renommé en `.1` (un seul niveau, l'ancien `.1`
est écrasé).

**`events.jsonl`** — un événement par TOUR terminé (succès, erreur ou
abandon), écrit par les moteurs :

```json
{"ts":"2026-07-19T21:00:00.000Z","engine":"neutral","method":"chat.send",
 "providerId":"ollama","model":"gemma3:4b","promptTokens":123,
 "completionTokens":45,"modelUsed":null,"costUsd":null,"cachedTokens":null,
 "status":"done","errorMessage":null,
 "orchRunId":null,"orchStepId":null,"source":"chat","conversationId":"s-12",
 "routeTier":null,"routeDebord":null,"projectId":null,"projectPath":null}
```

- `promptTokens`/`completionTokens` : `null` si le fournisseur ne les donne
  pas. `status` : `done|error|aborted`.
- `errorMessage` (L4) : message d'échec du tour, rempli par les moteurs quand
  `status: "error"` (tronqué à 500 caractères, sauts de ligne compactés),
  `null` sinon — et `null` aussi sur les lignes écrites par un sidecar
  antérieur (lecture tolérante). Sans lui, `status: "error"` dit qu'un tour a
  échoué sans jamais dire pourquoi : c'est la matière de base du rapport
  qualité hebdomadaire (voir [etude-logs.md](etude-logs.md) § 2.7).
- `modelUsed`/`costUsd`/`cachedTokens` (R0) : slug du modèle réellement servi,
  coût réel et tokens servis depuis le cache, remplis par `chat.send` quand le
  fournisseur les remonte (voir les réglages OpenRouter de `providers.set`) ;
  `null` sinon. R6-A : `neutral.start` remplit aussi `costUsd`/`cachedTokens`
  (cumulés sur les tours de sa boucle agentique ; `modelUsed` reste `null`) —
  `claude.start` les laisse à `null`. Non agrégés par `usage.stats` en R0
  (historisés pour l'encart « Routage » de R3).
- `orchRunId`/`orchStepId` : remplis automatiquement pour les étapes
  d'orchestration (ids internes `<runId>::<stepId>`) — c'est le marqueur
  « sous-agent ».
- `source`/`conversationId`/`routeTier`/`routeDebord` : optionnels, fournis
  par l'UI via un paramètre commun `meta: {source?: string, conversationId?:
  string, routeTier?: string, routeDebord?: boolean}` sur `chat.send`,
  `claude.start` et `neutral.start` (relayé tel quel, jamais requis).
  `routeTier` (R1/R2) : tier du routeur quand le tour a été envoyé en « Auto
  (routeur) » (Chat et Projets — voir « Méthodes R1/R2/R3 — routage »), ou
  quand une étape d'orchestration portée par un agent `engine: auto` a été
  routée (rempli côté sidecar par orchestrator.ts) ; `null` sinon — agrégé
  par le champ `routage` de `usage.stats` (R3). `routeDebord` (R3) : `true`
  quand le tour « Auto » a été **débordé** vers la cible payante (abonnement
  saturé, voir `router.route`) ; `null` sinon — c'est la base du plafond
  mensuel (`plafondUsdMois`, somme des `costUsd` de ces événements sur le
  mois calendaire courant, fichier de rotation `events.jsonl.1` inclus —
  R6-A). Le payant choisi MANUELLEMENT ne porte jamais `routeDebord` : il
  n'entre ni dans le plafond, ni dans les bandeaux. R6-A : sur un tour
  `meta.routeDebord: true`, `chat.send` et `neutral.start` **forcent**
  `usage: {include: true}` dans le corps envoyé au fournisseur, même si le
  provider n'a pas coché `usageAccounting` — le comptage du plafond ne doit
  jamais dépendre d'une case à cocher.

- `projectId`/`projectPath` (S2) : projet auquel imputer le tour, base de
  l'agrégat `parProjet` de `usage.stats`. `projectId` = id d'un projet déclaré,
  posé par l'UI (page Projets) via le même `meta` ; `projectPath` = répertoire
  du run, posé par l'UI (Projets) **et côté sidecar par `orchestrator.ts`**
  pour chaque étape d'orchestration — c'est ce qui rattache à son projet un
  tour autonome (orchestration lancée à la main ou tâche de fond), là où
  aucune UI n'est là pour poser un id. Le Chat ne pose rien : il est agrégé
  comme un projet à part entière depuis `source: "chat"`. `null`/`null` sur
  les lignes écrites avant S2 → elles tombent dans « (non attribué) ».

**`claude-windows.jsonl`** — un instantané par capture d'usage abonnement
réussie (voir usage.claude) : `{"ts":"…","windows":{…}}` (mêmes `windows`
génériques que le snapshot usage.claude).

### `usage.stats`

```json
{"id":"req-70","method":"usage.stats","params":{"from":"2026-06-19","to":"2026-07-19","bucket":"day"}}
```

`bucket` ∈ `day|week|month` (semaines ISO, lundi). `from`/`to` : dates
`YYYY-MM-DD` locales incluses ; défaut = 30 derniers jours. `done` :

```json
{"totals":{"tours":120,"orchTours":34,"conversations":18,
  "avgPromptTokens":2100,"totalTokens":900000},
 "buckets":[{"start":"2026-07-19","tours":12,"orchTours":4,
  "conversations":3,"avgPromptTokens":1800,"totalTokens":80000}],
 "models":[{"model":"claude-fable-5","engine":"claude","tours":40,
  "totalTokens":600000}],
 "routage":{"parTier":{"trivial":{"tours":10},"simple":{"tours":25}},
  "toursAuto":35,"partCoutNulPct":78,
  "mixAbo":[{"model":"claude-haiku-4-5","tours":20}],
  "debordMoisUsd":1.25},
 "parProjet":[{"projectId":"orgai","name":"OrgAI","tours":40,
  "totalTokens":300000,"partTokensPct":33,"autonomeTours":12,
  "autonomeTokens":120000,"autonomePct":40},
  {"projectId":"chat","name":"Chat","tours":30,"totalTokens":270000,
   "partTokensPct":30,"autonomeTours":0,"autonomeTokens":0,"autonomePct":0}]}
```

- `conversations` = `conversationId` distincts (événements sans id ignorés
  pour ce compteur) ; `orchTours` = événements avec `orchRunId` (le « niveau
  d'orchestration » = orchTours/tours, calculé côté UI).
- `avgPromptTokens` = moyenne des `promptTokens` non nuls (`null` si aucun).
- `models` trié par `tours` décroissant, `model` null → `"(inconnu)"`.
- `routage` (R3, encart « Routage » de Supervision) — calculé sur la MÊME
  période `from`/`to` que le reste : `parTier` = tours par `routeTier` ;
  `toursAuto` = événements portant un `routeTier` ; `partCoutNulPct` = part
  (arrondie, %) des tours à coût nul — moteur `claude` (abonnement) ou
  provider local (id contenant `ollama`/`local`/`lmstudio`, même heuristique
  que `scripts/usage-baseline.mjs`) — `null` si aucun tour ; `mixAbo` = tours
  moteur claude par modèle (trié décroissant) ; `debordMoisUsd` = somme des
  `costUsd` des événements `routeDebord: true` du **mois calendaire
  courant** (indépendant de `from`/`to` — c'est la valeur comparée au
  plafond ; R6-A : inclut le fichier de rotation `events.jsonl.1`, où des
  événements du mois courant peuvent avoir basculé).
- `parProjet` (S2, encart « Usage par projet » de Supervision) — même période
  `from`/`to` que le reste. Une entrée par projet, **le Chat compris**
  (`projectId: "chat"`, pseudo-projet dérivé de `source: "chat"`) :
  - `partTokensPct` = part du projet dans `totals.totalTokens` (arrondie ; la
    somme peut donc valoir 99 ou 101), `null` si aucun token n'a été compté
    sur la période — l'UI se rabat alors sur la part des tours ;
  - `autonomeTours`/`autonomeTokens`/`autonomePct` = ce que le projet a
    consommé **en orchestration** (événements portant un `orchRunId`),
    `autonomePct` étant la part autonome DANS le projet ;
  - attribution d'un événement, par ordre de précision : `projectId` →
    `projectPath` rattaché au projet déclaré de même répertoire (registre lu
    en LECTURE SEULE dans `config.json`, `projects: [{id,name,path}]`) →
    répertoire inconnu conservé sous l'id `chemin:<dir>` (nom = son dernier
    segment) → `source: "chat"` → `conversationId` rattaché à son projet via
    l'état applicatif `state/project-conversations.json` (LECTURE SEULE, sous
    `${XDG_DATA_HOME ?? ~/.local/share}/net.duvam.iaction/`) → sinon
    `projectId: null`, nom `(non attribué)`.
  - ce dernier rattachement par conversation est ce qui rend l'encart utile
    **dès le premier affichage** : les tours historisés avant S2 ne portent ni
    `projectId` ni `projectPath`, mais leur `conversationId` suffit tant que la
    conversation existe encore côté UI. Rien n'est réécrit dans
    `events.jsonl` — la résolution est refaite à chaque appel, et une
    conversation supprimée fait simplement retomber ses vieux tours au résidu.
  - tri par tokens décroissants puis par tours, `(non attribué)` toujours en
    dernier — c'est un résidu, pas un projet. Un projet déclaré dont l'id
    vaudrait littéralement `chat` serait fusionné avec le pseudo-projet Chat.

### `usage.claude.history`

```json
{"id":"req-71","method":"usage.claude.history","params":{"days":30}}
```

`done` : `{"snapshots":[{"ts":"…","windows":{…}}]}` — relit
`claude-windows.jsonl`, filtré aux `days` derniers jours (défaut 30), ordre
chronologique.

## Méthode TK1 — backlog de tickets (lecture)

Expose un backlog Markdown au panneau « Tickets » de la page Système.
**Lecture seule assumée** : il n'y a pas de `tickets.write`, ni d'édition
depuis l'UI. Le fichier reste écrit à la main — c'est lui la source de vérité ;
une méthode d'écriture aurait imposé de regénérer le Markdown, donc d'en figer
la mise en forme. Implémentation : `sidecar/src/tickets.ts`.

### Résolution du fichier

**`<config>/tickets.md`** — au même niveau que `config.json`, `logs/`,
`agents/` et `taches/`. Ce carnet n'appartient ni à un projet ni au dépôt : il
suit l'utilisateur, comme le reste de sa configuration.

**Créé au premier accès** à partir d'un gabarit (en-tête, convention, deux
tableaux vides) : c'est la seule écriture du module, en création EXCLUSIVE
(`wx`), et un fichier existant n'est jamais touché. Sans ce dépôt initial,
l'utilisateur verrait « backlog introuvable » sans moyen de deviner où poser le
fichier ni sous quelle forme.

La variable **`IACTION_TICKETS_MD`** l'emporte si elle est posée — c'est ainsi
que `scripts/dev.sh` fait pointer le panneau sur le `docs/tickets.md` VERSIONNÉ
du dépôt pendant le développement.

> Historique : ce chemin était résolu depuis le `dist/` du sidecar vers le
> `docs/tickets.md` du dépôt. Une application installée allait donc chercher le
> backlog du dépôt qui l'avait produite, à un chemin inexistant chez
> l'utilisateur (`%LOCALAPPDATA%\docs\tickets.md`) — de la plomberie de
> développement qui fuyait dans le produit. Corrigé le 2026-08-07.

### `tickets.list`

```json
{"id":"req-90","method":"tickets.list","params":{}}
```

Aucun paramètre. `done` :

```json
{"tickets":[{"id":"T-001","type":"feat","prio":"P3","statut":"ouvert",
             "titre":"Page « Tickets » dans l'app","cree":"2026-07-22",
             "corps":"**Type** feat · …\n\nExposer ce backlog…","archive":false}],
 "disponible":true,
 "chemin":"/home/…/iaction/docs/tickets.md"}
```

- `disponible` : `false` quand le fichier est introuvable ou illisible —
  `tickets` vaut alors `[]` et `chemin` dit **où** il a été cherché. Ce n'est
  **jamais** un `error` : l'UI affiche « backlog introuvable » sans casser la
  page.
- `chemin` : chemin absolu effectivement lu, affiché par le panneau — on doit
  savoir QUEL `tickets.md` on regarde.
- `corps` : le Markdown de la section détaillée **tel quel** (ligne
  d'en-tête `**Type** … **Créé** …` comprise), rendu par le composant
  `Markdown` de l'UI. `""` si le ticket n'a pas de section.
- `archive` : `true` pour les tickets situés sous un titre de niveau 2 dont le
  libellé contient « archiv » (« ## Archivés »).
- `tickets` : ordre d'apparition dans le fichier (le tri est une affaire d'UI).

### Tolérance du parseur

Le fichier est écrit à la main : il dérivera. Le parseur est ligne à ligne,
sans dépendance Markdown, et **n'échoue jamais** :

- un ticket est reconnu par une **ligne de tableau**
  (`| T-001 | feat | P3 | ouvert | Titre |`) et/ou par une **section
  détaillée** (`### T-001 — Titre`) ; l'un des deux suffit à le faire remonter,
  avec ce qu'on a et les champs manquants à `""` ;
- une ligne de tableau difforme (colonnes manquantes, premier champ qui n'est
  pas un `T-<chiffres>`) est **ignorée** — c'est aussi ce qui écarte la ligne
  d'en-tête et la ligne de séparation, sans les traiter à part ;
- le **tableau prime** sur la ligne d'en-tête de la section pour
  `type`/`prio`/`statut`/`titre` (c'est lui qu'on relit d'un coup d'œil, donc
  lui qu'on tient à jour) ; la section ne comble que les trous, et fournit
  seule `cree` ;
- `statut` accepte les valeurs en deux mots (« en cours ») ; `type`/`statut`
  sont normalisés en minuscules, `prio` et `id` en majuscules ; une valeur hors
  convention est rendue telle quelle plutôt que rejetée ;
- un tableau écrit **dans** le corps d'un ticket n'est pas confondu avec le
  tableau d'index ; un titre `####` reste dans le corps.

## Méthodes L1 — journal applicatif (logs)

Journal unique et persistant de l'application, étude complète :
[docs/etude-logs.md](etude-logs.md). Fichier
`${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/logs/app.jsonl`, mêmes
primitives que `usage/` (append sérialisé, lecture tolérante, lecture par la
fin, rotation > 20 Mo → `.1`) — factorisées dans `sidecar/src/jsonlStore.ts`
et partagées avec `usageStats.ts`.

Le sidecar est le **seul écrivain** du fichier. Trois portes d'entrée :

1. **sidecar** — appel direct à `journal.log(...)` (`sidecar/src/journal.ts`) ;
2. **UI** — méthode `log.append` ci-dessous ;
3. **Rust** — event Tauri **`app:log`** (voir plus bas), relayé par l'UI vers
   `log.append`. Cet event est DISTINCT de `sidecar:log` (qui reste le relais
   brut du stderr sidecar) : confondre les deux créerait une boucle
   sidecar → stderr → `sidecar:log` → `log.append` → sidecar.

#### Journal de secours de la coquille — `logs/coquille.jsonl`

La porte n°3 traverse le sidecar : **quand c'est lui qui est mort, la panne la
plus grave est la seule à ne laisser aucune trace**. C'est arrivé le 2026-08-07
(sidecar mort-né sous Windows, journal inexistant) ; il a fallu capturer le
stderr du process à distance pour voir l'erreur.

La coquille Rust écrit donc AUSSI, directement sur le disque, dans un fichier
**distinct** — le contrat d'écrivain unique d'`app.jsonl` reste intact :

- `<config>/logs/coquille.jsonl`, même forme de ligne, rotation en `.1` au-delà
  de 1 Mo ;
- y sont écrits : les niveaux `fatal` et `error` de `log_app`, **et** une ligne
  `info` au démarrage de la supervision portant les chemins résolus du runtime
  Node et de l'entrypoint. Cette ligne de démarrage exerce le mécanisme à
  chaque lancement : un journal de secours qui ne servirait qu'aux
  catastrophes serait un journal dont personne ne sait s'il fonctionne encore
  le jour de la catastrophe.

### Forme d'une entrée

```json
{"ts":"2026-07-31T09:12:03.114Z","level":"error","scope":"claude",
 "msg":"tour interrompu par le fournisseur","reqId":"req-42",
 "runId":null,"stepId":null,
 "fields":{"providerId":"openrouter","httpStatus":429},"stack":null}
```

- `level` : `fatal | error | warn | info | debug` (ordre de gravité
  décroissant). `debug` n'est PAS écrit par défaut — voir `IACTION_LOG_LEVEL`.
- `scope` : énumération **fermée** — `sidecar`, `rust`, `ui`, `claude`,
  `neutral`, `orchestrator`, `taches`, `knowledge`, `speech`, `router`,
  `usage`, `mcp`. Un scope inconnu est ramené à `sidecar` (jamais un rejet).
- `msg` : une ligne, sans saut de ligne (les sauts sont remplacés par des
  espaces à l'écriture — une entrée = une ligne JSONL).
- `reqId` / `runId` / `stepId` : corrélation, `null` par défaut. Un `reqId` de
  la forme `<runId>::<stepId>` remplit automatiquement les deux derniers
  (même convention que `events.jsonl`).
- `fields` : objet **plat** (valeurs scalaires), `{}` par défaut. `stack` :
  `string | null`.
- **Interdits, jamais journalisés** : clé API ou secret, corps de prompt ou de
  réponse, contenu de fichier. Un `msg` ou un `fields` est un libellé
  technique, pas de la donnée utilisateur.

Niveau minimum écrit : variable d'environnement `IACTION_LOG_LEVEL`
(`fatal|error|warn|info|debug`, défaut `info`). Sous ce seuil, l'appel est un
no-op — c'est ce qui rend `debug` gratuit en usage normal.

L'écriture est **mise en file et non attendue** : `log.append` répond `done`
avant que la ligne soit sur le disque (une journalisation ne doit jamais
ralentir un tour). Conséquence assumée : un `log.read` immédiat peut ne pas
encore voir la dernière entrée. En revanche le sidecar **vide sa file avant de
sortir** (`flushWrites`, appelé à la fermeture de stdin) — sans quoi les
dernières lignes avant un arrêt, celles qui expliquent un plantage, seraient
perdues.

Toute entrée est AUSSI émise sur stderr en clair
(`<LEVEL> <scope> <msg>`), donc reste visible dans le panneau brut
« Logs sidecar » via le relais `sidecar:log` existant : la chaîne actuelle
Rust → UI n'a rien à changer.

### `log.append`

```json
{"id":"req-80","method":"log.append","params":{
  "level":"error","scope":"ui","msg":"échec de chargement des projets",
  "fields":{"page":"projects"},"stack":"…","reqId":"req-79"}}
```

`done` : `{}`. **Ne rejette jamais** : `level`/`scope` invalides sont
normalisés (`error` / `sidecar`), `msg` absent devient `"(sans message)"`.
Une écriture disque impossible se termine quand même en `done` — l'appelant
est un chemin de gestion d'erreur, il ne doit pas avoir à gérer l'échec de sa
propre journalisation.

### `log.read`

```json
{"id":"req-81","method":"log.read","params":{
  "minLevel":"warn","scope":"claude","sinceMs":1785000000000,"limit":500}}
```

Tous les paramètres sont optionnels. `minLevel` filtre **par gravité au moins
égale** (`warn` ⇒ `warn`, `error`, `fatal`). `limit` défaut 500, plafond 5000.
Lecture PAR LA FIN (jamais de parse intégral). `done` :

```json
{"entries":[{"ts":"…","level":"error","scope":"claude","msg":"…",
             "reqId":null,"runId":null,"stepId":null,"fields":{},"stack":null}],
 "counts":{"fatal":0,"error":12,"warn":43,"info":108,"debug":0},
 "truncated":false}
```

- `entries` : ordre **chronologique** (plus ancien d'abord), tronqué à `limit`
  en gardant les plus RÉCENTES.
- `counts` : comptage par niveau sur la fenêtre lue, **avant** le filtre
  `minLevel`/`scope` — c'est ce qui alimente les compteurs par criticité de la
  page Système, qui doivent rester justes même quand un filtre est actif.
- `truncated` : `true` si la lecture par la fin n'a pas couvert tout le fichier.

### `log.stats`

```json
{"id":"req-82","method":"log.stats","params":{"sinceMs":1785000000000}}
```

`done` :

```json
{"counts":{"fatal":0,"error":12,"warn":43,"info":108,"debug":0},
 "topErrors":[{"msg":"tour interrompu par le fournisseur","level":"error",
               "scopes":["claude","neutral"],"count":7,
               "firstMs":1784900000000,"lastMs":1785000000000}],
 "byScope":{"claude":9,"orchestrator":3},
 "truncated":false}
```

`topErrors` : entrées `error`+`fatal` regroupées par **message normalisé**
(minuscules, nombres et chemins remplacés par `…`, espaces compactés), triées
par `count` décroissant, 20 au plus. `byScope` ne compte que `error`+`fatal`.

### `log.purge`

```json
{"id":"req-83","method":"log.purge","params":{}}
```

Supprime `app.jsonl` et `app.jsonl.1`. `done` : `{"purged": true}`.

### Event Tauri `app:log`

Émis par la coquille Rust pour ses PROPRES messages (échec de spawn du
sidecar, crash, backoff, redémarrage, réglages WebKit). Payload :

```json
{"level":"fatal","scope":"rust","msg":"échec du spawn (node …)","fields":{"attempts":3}}
```

L'UI s'y abonne et relaie vers `log.append`. Si le sidecar est mort, la ligne
n'est pas écrite : c'est assumé, `sidecar:status` porte déjà l'information.
Le Rust continue par ailleurs d'écrire ses `eprintln!` (visibles au terminal
en développement).

## Méthodes R1/R2/R3 — routage (`model: auto`)

Routeur du sidecar (`sidecar/src/router.ts`, specs `docs/spec-r1-routeur.md`,
`docs/spec-r2-classificateur.md` et `docs/spec-r3-debord.md`) : classe une
requête en **tier de complexité** (`trivial|simple|moyen|complexe`,
heuristique pure — complétée en R2 d'un classificateur LLM local optionnel
pour les scores ambigus) et renvoie la cible moteur/modèle d'après une table
configurable — en R3, la cible abonnement d'un tier peut **déborder** vers
une cible payante quand la fenêtre 5 h est saturée (voir `router.route`).
Table par défaut, codée en dur (utilisée tant que `router.set` n'a pas été
appelé, et pour compléter un tier manquant ou invalide) :

| tier | cible |
|---|---|
| trivial | claude · `claude-haiku-4-5` |
| simple | claude · `claude-sonnet-5` |
| moyen | claude · `claude-opus-4-8` |
| complexe | claude · `claude-fable-5` |

Tout-abonnement depuis le 2026-07-29 (choix utilisateur : abonnement Max,
qwen local trop lent en réponse). Le local reste utilisable via la table configurée ou une
surcharge projet. Depuis la même date, le **classificateur par défaut est
désactivé** (heuristique seule) : `classifier` absent dans `router.set` vaut
`null` ; la table par défaut étant entièrement sur l'abonnement, une
misclassification ne coûte rien.

### `router.set`

```json
{"id":"req-80","method":"router.set","params":{"table":{
  "trivial":{"engine":"neutral","providerId":"ollama","model":"qwen3.5:4b"},
  "complexe":{"engine":"claude","model":"claude-fable-5"}},
  "classifier":{"providerId":"ollama","model":"qwen3.5:4b"},
  "debord":{"target":{"engine":"neutral","providerId":"openrouter",
    "model":"deepseek/deepseek-chat"},"seuilPct":90,"plafondUsdMois":10}}}
```

Remplace la table courante (fusion avec les défauts, comme `providers.set`
remplace la table providers). Une cible : `{engine: "claude"|"neutral",
providerId?, model}` — `providerId` requis si `engine:"neutral"`. Validation
souple par tier : une entrée invalide est simplement ignorée (le tier
retombe sur son défaut), jamais d'erreur globale. `done` : `{"count": 2}`
(nb de tiers valides retenus). `error` seulement si `params.table` n'est pas
un objet.

`classifier` (R2) — configuration du classificateur LLM :
`{providerId, model}` (le provider doit être déclaré via `providers.set`,
sinon le classificateur est simplement inerte), **`null` = désactivé**.
Depuis le 2026-07-29, absent ou invalide = **désactivé** aussi (heuristique
seule) — il n'y a plus de classificateur par défaut.

`debord` (R3) — configuration du débord d'abonnement : `target` (cible
`{engine, providerId?, model}` payante), `seuilPct` (seuil de saturation de
la fenêtre 5 h, %), `plafondUsdMois` (plafond mensuel de dépense de débord
en **USD** — devise d'OpenRouter ; **`null` = pas de plafond**). Validation
souple champ par champ : toute valeur absente ou invalide retombe sur son
défaut — `target` = neutral · `openrouter` · `deepseek/deepseek-chat`,
`seuilPct` = 90, `plafondUsdMois` = 10. R6-A : **`debord: null` = débord
DÉSACTIVÉ** (jamais de bascule payante automatique) — distinct de « champ
absent » = retour aux défauts (même distinction que le classificateur).

**Runner headless (R6-A)** : `scripts/orch-run-headless.mjs` pousse
`router.set` AVANT `orch.run`, à partir de la clé racine `routing` du
`config.json` non secret de l'app (le même fichier que le config_store
Tauri : `${XDG_CONFIG_HOME ?? ~/.config}/net.duvam.iaction/config.json`),
en relayant `table`/`classifier`/`debord`/`embeddings` tels quels. Config
illisible, absente ou sans clé `routing` → `{table: {}, debord: null}` : un
run nocturne sans configuration explicite ne déclenche JAMAIS de débord
payant (les défauts du sidecar, eux, l'autoriseraient).

`embeddings` (R5) — modèle d'embeddings du RAG local (voir « Méthodes R5 —
connaissances projet ») : `{providerId, model}`, même forme et même
validation souple que le classificateur, absent ou invalide = retour au
défaut `{"providerId":"ollama","model":"nomic-embed-text"}`. Pas de forme
« désactivé » : l'indexation n'a lieu que sur action explicite
(`knowledge.index`).

### `router.route`

```json
{"id":"req-81","method":"router.route","params":{"text":"Explique pourquoi ce test échoue","historyTurns":3,"attachmentsCount":0,"cwd":"/chemin/projet","allowLlm":true}}
```

`done` :

```json
{"tier":"simple","score":2,"reasons":["marqueur de raisonnement"],
 "target":{"engine":"claude","model":"claude-haiku-4-5"},
 "method":"heuristique",
 "debord":{"active":true,"fiveHourPct":95}}
```

- Barème additif (longueur > 400/1500, présence de code, marqueurs de
  raisonnement, demande d'édition, pièces jointes, historique > 10 tours) ;
  détection insensible à la casse et aux accents (normalisation NFD).
  **Mapping descendant (R7)** : score ≤ 2 → `simple` · 3-6 → `moyen` · ≥ 7 →
  `complexe`. `trivial` UNIQUEMENT sur preuve positive : score 0 ET 0 pièce
  jointe ET texte ≤ 160 caractères ET correspondance d'un motif de
  `TRIVIAL_PATTERNS` (salutations/politesse, acquiescements courts, question
  factuelle d'une phrase sans référence technique) — `reasons` :
  « trivialité prouvée : … ». Sans signal ni motif, un score 0 part en
  `simple` (« aucun signal → simple (défaut descendant) ») : l'absence de
  preuve de complexité n'est plus une preuve de trivialité. `reasons` :
  libellés français courts.

  **Stratégies par flux (R7, côté UI)** : le Chat applique la stratégie
  MONTANTE (classification de chaque tour + plancher `minTier`, sélecteur
  « Auto (montant) ») ; la page Projets applique la stratégie DESCENDANTE
  (premier tour à `tier: "complexe"` imposé — sommet de la table, aucune
  classification, aucune descente automatique, sélecteur « Auto
  (descendant) »). Le sidecar est agnostique : il n'expose que `tier` et
  `minTier`, la stratégie est un choix d'appelant.
- **Classificateur LLM (R2)** : quand le score heuristique est à ±1 d'une
  frontière de tier (3, 7 depuis R7 — `trivial` n'étant plus atteignable par
  score, la frontière basse a disparu) et que le classificateur est configuré (voir
  `router.set`), le sidecar fait une complétion NON streamée (température 0,
  `max_tokens` ~4, prompt système français « un seul mot parmi
  trivial|simple|moyen|complexe ») via le provider résolu. Timeout **3 s**
  (`AbortSignal.timeout`) : tout échec — provider inconnu, réseau, réponse
  illisible ou hors liste — replie **silencieusement** sur le tier
  heuristique (le routeur ne retarde jamais un envoi au-delà de ~3 s).
  `done.method` vaut `"llm"` si le classement vient du LLM (et `reasons`
  gagne `classificateur LLM : <tier>`), `"heuristique"` sinon.
- `allowLlm` (R2, défaut `true`) : `false` = pas d'appel au classificateur
  (tests, appels internes pressés).
- `cwd` (R2) : active la **surcharge projet** `<cwd>/.iaction/routage.yaml`
  (voir ci-dessous) — fusion `défauts ← table globale ← table projet`.
- `target` = table effective[tier]. AUCUNE vérification de disponibilité du
  provider ici (le routeur est pur) — le repli est à la charge de l'UI, qui
  connaît la table des fournisseurs déclarés.
- **Débord (R3)** : quand la cible du tier est `engine: "claude"` (et que le
  débord n'est pas désactivé — `debord: null` de `router.set`), le sidecar
  lit le dernier instantané de `claude-windows.jsonl` (lecture PAR LA FIN du
  fichier — dernier bloc ~64 Ko — jamais de parse intégral sur ce chemin
  chaud, R6-A). **Fraîcheur (R6-A)** : un instantané plus vieux que 30 min
  (`DEBORD_SNAPSHOT_MAX_AGE_MS`) est ignoré — même comportement que « pas
  d'instantané ». Si la fenêtre 5 h ≥ `seuilPct` : plafond non atteint →
  `target` = `debord.target` et `done.debord = {active: true, fiveHourPct}` ;
  plafond atteint (somme des `costUsd` des événements `routeDebord: true` du
  mois calendaire courant, `events.jsonl.1` inclus, ≥ `plafondUsdMois`) →
  repli **local** `target` = table.trivial et `done.debord = {active: false,
  blocked: true, fiveHourPct}` — **garde R6-A** : si la cible du tier
  trivial n'est PAS un moteur neutre sur provider local (id contenant
  `ollama`/`local`/`lmstudio`), la cible claude d'origine est CONSERVÉE (le
  « repli local » ne doit router ni vers du payant, ni vers l'abo saturé).
  Pas d'instantané (ou pas de pourcentage 5 h, ou instantané périmé) →
  comportement R1 inchangé, champ `debord` absent. `reasons` mentionne
  l'état (`débord : fenêtre 5 h à N %`, `plafond débord atteint : repli
  local`, ou `plafond débord atteint : cible abonnement conservée (tier
  trivial non local)`).
- `tier` (R3, optionnel) : tier IMPOSÉ — saute toute classification
  (heuristique et LLM ; `score` 0, `reasons` = `["tier imposé par
  l'appelant"]`) et ne fait que résoudre cible (fusion tables comprise) +
  débord. Depuis R7, l'UI ne l'utilise plus (chaque tour Auto est re-routé
  avec `minTier`) ; le paramètre reste supporté, et compatible avec
  `minTier`.
- `minTier` (R7, optionnel) : **plancher de session** — après classification
  (ou tier imposé R3 : `tier` prime, puis `minTier` s'applique aussi), le
  tier effectif est `max(tier classé, minTier)` selon l'ordre `trivial <
  simple < moyen < complexe` (constante `TIER_ORDER` exportée). Quand le
  plancher l'emporte, `reasons` gagne `plancher de session : <minTier>`. La
  règle de débord s'applique à la cible du tier effectif. **Sémantique UI
  (ChatPage/AgentPage, patrons jumeaux)** : `routedTier` est ce plancher de
  session — en Auto, CHAQUE tour appelle `router.route` avec
  `minTier = routedTier` (absent au premier tour), et le plancher n'est
  relevé (à la hausse uniquement, `max(plancher, tier utilisé)`) qu'au
  premier signe de succès du tour (mécanique `commitAffinity` R6-B) — jamais
  par un tour débordé/bloqué (règle R3). `routedTarget` garde la dernière
  cible utilisée (affichage/repli). L'override manuel efface plancher +
  cible ; revenir sur Auto repart sans plancher.
- `text` manquant/vide → `error` « params.text manquant ou invalide ».
- Traçabilité : l'UI passe `meta.routeTier` à `chat.send`/`claude.start`/
  `neutral.start` quand le tour a été routé — persisté dans `events.jsonl`
  (voir la section S1 ci-dessus). Les étapes d'orchestration routées
  (`engine: auto`) le passent aussi, côté sidecar. R3 : l'UI passe en plus
  `meta.routeDebord: true` sur les tours effectivement débordés
  (`debord.active`) — jamais sur un modèle payant choisi manuellement ; les
  étapes d'orchestration routées débordées le portent aussi (rempli par
  orchestrator.ts).

### Surcharge projet — `<projet>/.iaction/routage.yaml` (R2)

```yaml
table:            # tiers partiels acceptés — le reste hérite du global
  trivial: { engine: neutral, providerId: ollama, model: qwen3.5:4b }
  complexe: { engine: claude, model: claude-fable-5 }
classifier: { providerId: ollama, model: qwen3.5:4b }   # optionnel ; null = désactivé pour ce projet
```

Lu à **chaque** `router.route` portant un `cwd` (fichier petit, pas de
cache), lecture tolérante : fichier absent = aucune surcharge ; YAML
invalide ou forme inattendue = fichier ignoré et `reasons` mentionne
« routage.yaml invalide (ignoré) » ; chaque tier est validé individuellement
(une cible invalide est ignorée). `classifier` absent = héritage de la
config globale ; `null` = classificateur désactivé pour ce projet.

### Résolution interne (`engine: auto`, R2)

`router.ts` exporte `resolveRoute({text, historyTurns?, attachmentsCount?,
cwd?, allowLlm?, tier?, minTier?})` — la même résolution que `router.route`
(règles de débord R3 et de plancher R7 comprises), réutilisée EN INTERNE par
`orchestrator.ts` (pas d'aller-retour protocole) pour les agents
`engine: auto` : au **démarrage de chaque étape** (révision 2026-07-31 —
plus au lancement du run), l'étape est routée sur le **texte rendu de sa
tâche** (templating `{{…}}` interpolé) avec le `cwd` du run ; la cible
choisie apparaît dans le chunk `step_started` (`engine`/`model`/`routeTier`
par étape — `run_started` annonce `engine: "auto"`, `model: null`) et
l'événement d'usage de l'étape porte `routeTier`. Un `engine`/`model`
explicites dans l'agent priment toujours (aucun routage).

## Méthode R4 — économie de contexte (`context.compact`)

Compaction d'historique du **moteur neutre** (`sidecar/src/context.ts`, spec
`docs/spec-r4-contexte.md`) : sur les longues conversations du Chat,
l'UI remplace les anciens tours par un résumé produit par un modèle local
gratuit, sans toucher à la transcription affichée. Côté Claude : rien
(compaction SDK existante).

### `context.compact`

```json
{"id":"req-90","method":"context.compact","params":{
  "providerId":"ollama","model":"qwen3.5:4b",
  "messages":[{"role":"user","content":"…"},{"role":"assistant","content":"…"}],
  "keepLast":10}}
```

`done` :

```json
{"summary":"Résumé factuel dense…","coveredTurns":24}
```

- Résume les messages FOURNIS (l'appelant choisit quoi résumer) via une
  complétion **non streamée** sur `providerId`/`model` (provider déclaré via
  `providers.set` — mêmes helpers que `chat.send`), timeout **60 s**
  (`AbortSignal.timeout`).
- `keepLast` (optionnel, défaut 0) : les N derniers messages fournis sont
  **exclus** du résumé — `coveredTurns` = `messages.length - keepLast`.
  `keepLast` couvrant tout l'historique fourni → `error` (rien à résumer).
- Prompt système français : résumé factuel et dense — décisions prises,
  faits établis, fichiers/chemins cités, questions ouvertes — ≤ 400 mots,
  sans commentaire méta. Les contenus en tableau OpenAI (pièces jointes)
  sont réduits à leurs blocs `text`.
- Erreur HTTP/réseau/timeout ou réponse illisible → `error` protocolaire
  normale : l'UI n'applique alors PAS la compaction et envoie l'historique
  intégral (jamais de perte).

Côté UI (ChatPage.tsx, conversations moteur neutre uniquement) : état
persisté `compaction {summary, upToIndex, at}` (le résumé couvre les tours
`[0, upToIndex)` de la transcription) ; déclenchement AVANT envoi quand les
tours non couverts dépassent 30 OU quand la taille estimée (~4
caractères/token) dépasse 60 % du `contextLength` du modèle (connu via
`models.detail`, sinon seuil tours seul) ; les 10 derniers tours restent
toujours intacts ; la recompaction s'empile (résumé précédent fourni en tête
des messages à résumer). Cible du résumé : `routing.summarizer` de la config
non-secrète si défini (objet `{providerId, model}` = cible dédiée du
résumeur ; `null` = compaction automatique DÉSACTIVÉE — aucun nouveau résumé,
un résumé existant reste appliqué/consultable) ; clé absente = comportement
historique : `routing.classifier` si défini, sinon `ollama` · `qwen3.5:4b`
(un classificateur pointé vers un modèle payant enverrait sinon les
historiques complets au payant, d'où ce réglage découplé) ; provider absent
de la table déclarée → pas de compaction (silencieux). `routing.summarizer`
est une clé côté UI/config uniquement — le protocole ne change pas :
`context.compact` reçoit toujours `providerId`/`model` en paramètres et
`router.set` ignore cette clé. Messages envoyés ensuite :
`[system éventuel] + [{role:"user", content:"[Résumé de la conversation
antérieure]\n" + summary}] + tours depuis upToIndex` (voir l'ordre stable
documenté sous `chat.send`). Le résumé est consultable/recompactable/
oubliable via l'indicateur « historique compacté » de la transcription.

## Méthodes R5 — connaissances projet (RAG local `search_knowledge`)

RAG local des connaissances projet (`sidecar/src/knowledge.ts`, spec
`docs/spec-r5-rag.md`) : un **index d'embeddings par projet** dans
`<projet>/.iaction/connaissances-index/` — `chunks.jsonl` (une ligne par
chunk `{file, chunkId, mtimeMs, text, embedding: number[]}`) + `meta.json`
(`{model, dim, builtAt, files: {chemin: mtimeMs}}`). Sources = les MÊMES que
le panneau Connaissances de la page Projets : documents **épinglés** (chemins
fournis par l'UI via `params.pinned` — l'état `project-knowledge` vit côté
UI), dossier `.iaction/connaissances/` (« Automatiques », non récursif) et
sources **détectées** (`CLAUDE.md`, `.claude/memory/*.md`), dédoublonnées par
chemin. Le dossier `connaissances-index/` n'est **jamais** une source (index
≠ document). Chunking ~1 000 caractères, recouvrement 200, coupé aux
frontières de lignes ; fichiers texte uniquement (détection binaire par octet
nul + UTF-8 strict, comme `read_file` du moteur neutre). Embeddings via l'API
**NATIVE** Ollama `POST /api/embed` (dérivation `ollamaNativeBase`, voir
`ollama.*` ci-dessous), par lots de ~32, timeout 10 min (chargement à froid) ;
modèle configurable via `router.set` champ `embeddings` (défaut `ollama` ·
`nomic-embed-text`). Recherche : cosinus brute-force en JS (corpus locaux
petits, aucune dépendance nouvelle).

### `knowledge.index`

```json
{"id":"req-95","method":"knowledge.index","params":{"cwd":"/chemin/projet",
  "pinned":["/chemin/projet/docs/note.md"]}}
```

(Re)construit l'index, **incrémental par mtime** : un fichier dont le mtime
n'a pas changé garde ses chunks tels quels (aucun ré-embedding) ; un modèle
d'embeddings différent de celui de `meta.json` force une reconstruction
complète (vecteurs incomparables). Un fichier binaire/trop gros (> 1 Mo) est
ignoré mais inscrit dans `meta.files` (pas de `stale` perpétuel). Chunks
streamés de progression `{file, done, total}` (un par fichier traité), puis
`done` :

```json
{"files":3,"chunks":12,"model":"nomic-embed-text"}
```

`error` lisible si le fournisseur d'embeddings n'est pas déclaré
(`providers.set`) ou si `/api/embed` échoue (HTTP/réseau/timeout).

### `knowledge.search`

```json
{"id":"req-96","method":"knowledge.search","params":{"cwd":"/chemin/projet","query":"…","topK":5}}
```

Embed de la requête + cosinus contre tous les chunks. `topK` optionnel
(défaut 5, plafond 20). `done` :

```json
{"results":[{"file":".iaction/connaissances/note.md","excerpt":"…","score":0.8944}]}
```

Index absent ou vide → `error` « index absent — lancer l'indexation ».

### `knowledge.status`

```json
{"id":"req-97","method":"knowledge.status","params":{"cwd":"/chemin/projet","pinned":["…"]}}
```

`done` : `{exists, files, chunks, model, builtAt, stale}` — `stale` est vrai
quand un document source a changé (mtime différent), est apparu ou a disparu
depuis la construction de l'index (les `pinned` fournis participent au
calcul, mêmes chemins qu'à l'indexation). Sans index :
`{exists:false, files:0, chunks:0, model:null, builtAt:null, stale:false}`.

### Outil `search_knowledge` — les deux moteurs

« Tous agents à égalité » :

- **Moteur neutre** : `search_knowledge` fait partie de la palette
  (voir « Palette d'outils du moteur neutre ») — args `query` (requis),
  `topK?` ; lecture seule, même flux de permission que `search` (aucune
  validation demandée en mode `default`). Index absent → `tool_result`
  `isError` avec le message lisible, le run continue.
- **Moteur Claude** : serveur MCP in-process `iaction`
  (`mcp__iaction__search_knowledge`), ajouté par le sidecar **seulement
  quand l'index du projet existe** — voir `claude.start` § RAG local.

### Outil `search_chat` — historique du Chat (moteur Claude)

Second outil du même serveur MCP in-process `iaction`
(`mcp__iaction__search_chat`, args `query` requis, `limit?` — défaut 5, max
20). Contrairement à `search_knowledge`, il est **toujours présent** : il ne
dépend d'aucun index, et le serveur `iaction` est donc désormais monté même
sans index (il ne porte alors que cet outil).

Raison d'être : les conversations de l'onglet « Chat » vivent dans l'état
applicatif (`${XDG_DATA_HOME ?? ~/.local/share}/net.duvam.iaction/state/chat-conversations.json`),
**hors du répertoire du projet**. Un agent de projet, dont le `cwd` est le
projet, ne peut pas les lire — cet outil est le seul pont. Implémentation :
`sidecar/src/chatHistory.ts`.

Contrat : recherche par sous-chaîne, insensible à la casse et aux accents ;
résultat trié par nombre de tours correspondants ; **extraits bornés**
(±160 caractères autour de la correspondance, 3 extraits par conversation au
plus) — c'est une recherche, jamais un export intégral. Lecture seule et
tolérante : fichier absent, JSON invalide ou forme inattendue → `isError`
avec un message lisible, le tour continue.

Conséquence à connaître : **tout agent de projet peut interroger l'historique
du Chat**, quel que soit le projet. C'est voulu (demande du 2026-08-03), mais
c'est un pont entre espaces auparavant étanches.

### `project.ensureDoc` — guide d'intégration du projet

```json
{"id":"req-90","method":"project.ensureDoc","params":{"cwd":"/chemin/projet"}}
```

Dépose (ou rafraîchit) `<projet>/.iaction/connaissances/iaction.md` — le
guide d'intégration versionné avec le sidecar (`projectDoc.ts`). Réponse :
`done` `{ensured: true}`. Rien n'est créé si `<projet>/.iaction/` n'existe pas,
ni si le fichier a été édité à la main (le marqueur « généré » en première
ligne autorise seul l'écrasement).

Appelé par l'UI **à la sélection du projet**, avant son scan de
`.iaction/connaissances/`. Auparavant le dépôt n'avait lieu qu'au premier tour
(`claude.start`), donc APRÈS ce scan : le guide n'était ni listé dans le
panneau Connaissances ni injecté, pour toute la session (2026-08-03).
Délibérément une méthode à part plutôt qu'un effet de bord de
`knowledge.status` : celle-ci est une lecture, et y écrire faisait apparaître
une source pendant sa propre mesure (index aussitôt `stale`, comptes faussés).

### Mode par projet — `connaissances.mode`

Réglage PAR PROJET côté UI (champ `connaissancesMode` de l'entrée du projet
dans la config non-secrète, voir `ui/src/projectAdmin.ts`) : `"injection"`
(défaut — comportement historique strictement inchangé : documents recopiés
en préambule du 1er tour) ou `"rag"`. En mode `rag` : **aucune** injection
intégrale au 1er tour ; à la place, la ligne système « Des connaissances
projet sont indexées — utilise l'outil search_knowledge. » (ajoutée aux
instructions d'agent éventuelles), et l'outil est proposé dans les deux
moteurs. Panneau Connaissances (page Projets) : sélecteur du mode, bouton
« Indexer maintenant » (progression via les chunks de `knowledge.index`),
état de l'index (`knowledge.status`) et avertissement si `stale`.

## Méthodes MCP — état réel, interrupteurs, secrets, catalogue

Implémentation découpée par responsabilité — `sidecar/src/mcpSecrets.ts`
(coffre, brique du bas sans dépendance), `sidecar/src/mcp.ts` (config, état
constaté, préférences, préparation d'un tour), `sidecar/src/mcpCatalog.ts`
(connecteurs prêts à brancher, la partie exposée à la dérive de gabarits
tiers : elle se supprime en effaçant ce fichier et ses trois `case`, sans
toucher au reste). Client UI : `ui/src/mcpClient.ts`, panneau
`ui/src/McpPanel.tsx` (section « MCP » de la page Projets).

Trois fichiers, trois rôles — à ne pas confondre :

| Fichier | Rôle | Versionné |
|---|---|---|
| `<projet>/.mcp.json` | serveurs déclarés (contrat partagé du projet) | oui |
| `<projet>/.iaction/mcp.local.json` | préférences locales : `{disabled[], allowedTools{}}` | non |
| `<projet>/.iaction/mcp.runtime.json` | état CONSTATÉ au dernier tour (généré) | non |

Les secrets ne vivent dans aucun des trois : ils sont dans
`<config>/mcp-secrets.json` (mode 0600), référencés depuis `.mcp.json` par
`${SECRET:<nom>}`. **Aucune méthode ne renvoie jamais la valeur d'un secret** —
seuls les noms circulent, et uniquement dans le sens UI → sidecar pour les
poser.

### `mcp.status`

```json
{"id":"req-91","method":"mcp.status","params":{"cwd":"/chemin/projet"}}
```

`done` : `{configPath, configExists, configError, capturedAt, mcpToolCount,
builtinToolCount, secretNames[], servers[]}`. Chaque serveur :
`{name, kind:"stdio"|"http"|"sse", detail, declared, enabled, allowedTools,
status, tools[], needsAuth, secretRefs[], missingSecrets[]}` — `declared:false`
désigne un serveur in-process d'IAction (`iaction`, `studio`), visible et
restreignable comme les autres ; `status`/`tools` viennent du dernier tour
(`unknown`/`[]` si le projet n'a jamais tourné) ; `allowedTools: null` = tous
les outils exposés.

### `mcp.setServer`

```json
{"id":"req-92","method":"mcp.setServer",
 "params":{"cwd":"/chemin/projet","name":"airtable","enabled":false,"allowedTools":["list_records"]}}
```

Écrit `mcp.local.json`. `enabled` et `allowedTools` sont indépendants et
facultatifs (champ absent = inchangé). `allowedTools: null` retire
l'allowlist ; `[]` la pose à « aucun outil » — deux intentions distinctes.
`done` : `{state}`.

### `mcp.catalog` / `mcp.add` / `mcp.remove`

`mcp.catalog` (sans params) → `{entries[]}` : connecteurs proposés
(`imap` — serveur IMAP livré dans `tools/mcp-imap` ; `airtable` ; `http`
distant, échappatoire pour tout le reste), chacun avec ses champs
(`{key, label, secret, placeholder, required}`).

```json
{"id":"req-93","method":"mcp.add",
 "params":{"cwd":"/chemin/projet","entryId":"airtable","name":"airtable","values":{"token":"pat…"}}}
```

Écrit l'entrée dans `<cwd>/.mcp.json`. Les champs `secret: true` ne sont
**pas** écrits dans le projet : leur valeur part au coffre sous le nom
`<serveur>.<champ>` et le fichier ne porte qu'un `${SECRET:…}`. Refus (erreur,
sans rien écrire) si `.mcp.json` existe mais est illisible — réécrire par-dessus
effacerait des serveurs que l'utilisateur croit déclarés. `done` :
`{name, added:true}`.

`mcp.remove {cwd, name}` retire l'entrée ; les secrets restent au coffre.

### `mcp.secrets` / `mcp.secretSet` / `mcp.secretDelete`

`mcp.secrets` → `{names[], path}` (noms seulement).
`mcp.secretSet {name, value}` pose/écrase (fichier créé en 0600).
`mcp.secretDelete {name}` → `{name, removed}`.

### Serveurs distants en attente d'authentification

Pas de méthode : un flux OAuth ne peut pas se dérouler dans un tour non
interactif, et le sidecar n'a rien à faire de plus que donner la consigne.
Quand `mcp.status` renvoie `needsAuth: true`, le panneau affiche le bouton
« Connecter », ouvre un terminal sur le projet (`open_terminal`, côté Rust)
et rappelle le geste : lancer `claude`, taper `/mcp`, choisir le serveur. Le
jeton obtenu est ensuite réutilisé par les tours d'IAction.

## `ollama.*` (gestion des modèles chargés)

Trois méthodes qui parlent à l'API **NATIVE** d'Ollama (`/api/…`, sans le
suffixe `/v1` du dialecte OpenAI-compatible utilisé par `providers.set`/
`chat.send`/`neutral.start`) : voir quels modèles sont en mémoire, en charger
ou en décharger un. Valides pour **tout** fournisseur dont l'API native
répond aux mêmes routes — pas seulement un provider nommé `ollama` : c'est
d'ailleurs ainsi que l'UI détecte « ceci est un Ollama » (`ollama.ps` réussit)
vs. « ce n'est pas un Ollama » (erreur, panneau non affiché).

La base native est dérivée du `baseUrl` déclaré via `providers.set` en ôtant
un éventuel suffixe `/v1` ou `/v1/` (ex. `http://localhost:11434/v1` →
`http://localhost:11434`).

### `ollama.ps`

```json
{"id":"req-16","method":"ollama.ps","params":{"providerId":"ollama"}}
```

GET `<base-native>/api/ps`. Réponse Ollama `{models:[{name, size, size_vram,
expires_at, …}]}` mappée en camelCase :

```json
{"models":[{"name":"qwen3.5:4b","sizeVram":3500000000,"sizeTotal":4000000000,
  "expiresAt":"2026-07-19T20:00:00Z"}]}
```

Champs manquants côté Ollama → `null`. Fournisseur inconnu ou erreur HTTP/
réseau (dont « ce n'est pas un serveur Ollama ») → `error` (`data.message`
lisible — l'UI s'en sert pour savoir qu'il ne faut pas afficher le panneau).

### `ollama.load`

```json
{"id":"req-17","method":"ollama.load","params":{"providerId":"ollama","model":"qwen3.5:4b"}}
```

POST `<base-native>/api/generate` avec `{"model":"qwen3.5:4b","prompt":"","stream":false}`
(prompt vide = pas de génération, juste un chargement). Ollama ne répond
qu'une fois le modèle chargé : **timeout long (10 min)**, un chargement à
froid peut prendre plusieurs minutes. `done` `{loaded: true}`. Fournisseur
inconnu, `model` manquant ou erreur HTTP/réseau → `error`.

### `ollama.unload`

```json
{"id":"req-18","method":"ollama.unload","params":{"providerId":"ollama","model":"qwen3.5:4b"}}
```

Même requête que `ollama.load` avec `"keep_alive":0` en plus dans le corps :
Ollama décharge le modèle dès la réponse envoyée. `done` `{unloaded: true}`.
Mêmes cas d'erreur que `ollama.load`.

## Méthodes speech — dictée et synthèse vocale

Nouveau module `sidecar/src/speech.ts` : speech-to-text (Whisper) et
text-to-speech (Kokoro), chacun en deux modes. Mode « local » : inférence
dans le sidecar via transformers.js et kokoro-js (onnxruntime-node embarqué —
volontairement la seule inférence native du projet), modèles téléchargés au
premier usage dans `~/.cache/iaction/models` (jamais dans
`~/.cache/huggingface`). Mode « remote » : endpoints « dialecte OpenAI »
(`/audio/transcriptions`, `/audio/speech`) via fetch natif. Chargements
paresseux : les bibliothèques d'inférence ne sont importées qu'au premier
appel local.

### `speech.configure`

```json
{"id":"req-80","method":"speech.configure","params":{
  "config":{
    "stt":{"mode":"local","language":"fr",
      "local":{"model":"onnx-community/whisper-small"},
      "remote":{"baseUrl":"https://api.groq.com/openai/v1","model":"whisper-large-v3-turbo"}},
    "tts":{"mode":"local",
      "local":{"voice":"ff_siwis","speed":1.0},
      "remote":{"baseUrl":"https://api.openai.com/v1","model":"gpt-4o-mini-tts","voice":"alloy","speed":1.0}}},
  "keys":{"stt":"gsk_…","tts":"sk-…"}}}
```

Stocke config et clés **en mémoire uniquement** (comme `providers.set` — les
secrets vivent dans le trousseau OS côté Rust). Remplacement intégral : une
clé absente de l'appel est retirée. Tout champ absent de `config` reprend sa
valeur par défaut (celles de l'exemple ci-dessus) ; un champ présent mais mal
typé → `error` citant le champ fautif. `language` : code type `"fr"` (ou nom
`"french"`), `""` = détection automatique. Si le modèle STT local change, le
pipeline chargé est invalidé (rechargé au prochain appel) ; la voix TTS est
un paramètre de génération, le modèle Kokoro chargé n'en dépend pas.
Réponse : `done` `{}`.

`tts.remote.voice` accepte la **chaîne vide** (config héritée, ou voix pas
encore choisie) : elle est alors envoyée telle quelle, `voice` étant un
paramètre **requis** de `/audio/speech` (voir ci-dessous) — le service répond
une erreur indiquant les valeurs qu'il accepte, ce qui est plus utile qu'un
champ silencieusement omis. Les champs inconnus du sidecar sont ignorés sans erreur :
l'UI y fait notamment voyager ses réglages purement locaux
(`stt.inputDeviceId`, `stt.remote.keySource`, `tts.remote.keySource`).

**Source des clés (côté UI)** : `keys.stt` / `keys.tts` peuvent provenir soit
d'une clé dédiée du trousseau (`speech:stt` / `speech:tts`), soit de la clé
d'un fournisseur déjà configuré (`provider:<id>`) — utile pour réutiliser une
clé OpenRouter, dont la base `https://openrouter.ai/api/v1` expose
`/audio/transcriptions` et `/audio/speech` en dialecte OpenAI.
`<stt|tts>.remote.keySource` arbitre :

| Valeur | Comportement |
| --- | --- |
| `""` (défaut) | **Automatique** : premier fournisseur `needsKey` dont l'`baseUrl` égale (normalisée : casse, espaces et slash final ignorés) la `remote.baseUrl` de la voix et qui a une clé au trousseau ; sinon repli sur la clé dédiée. |
| `"!dedicated"` | Clé dédiée forcée, sans recherche. Le `!` initial exclut toute collision avec un `id` de fournisseur. |
| `"<id>"` | Emprunt explicite à ce fournisseur ; s'il a disparu ou n'a plus de clé, repli sur la clé dédiée (signalé dans l'UI). |

La résolution est faite **entièrement côté UI** (`pushSpeech`) : le sidecar ne
reçoit que la clé finale et son contrat est inchangé.

### `speech.transcribe`

```json
{"id":"req-81","method":"speech.transcribe","params":{"audioBase64":"UklGR…"}}
```

`audioBase64` : un WAV **PCM16 mono 16 kHz** produit par l'UI (base64 sans
préfixe data-URL, ≤ 64 Mo décodés). Réponse : `done` `{text: string}`.

- **Local** : parseur WAV maison (RIFF/fmt/data vérifiés, PCM16 mono 16 kHz
  exigés, erreurs françaises précises) puis pipeline
  `automatic-speech-recognition` de transformers.js avec le modèle configuré
  (chargé paresseusement, mis en cache). `language` transmis si non vide
  (codes et noms acceptés) avec `task: "transcribe"` ; audio > 30 s →
  découpage glissant (`chunk_length_s: 30`, `stride_length_s: 5`). La
  validation du WAV précède tout chargement de modèle.
- **Remote** : POST multipart `{baseUrl}/audio/transcriptions` (`file` =
  audio.wav, `model`, `language` si non vide), header
  `Authorization: Bearer <keys.stt>`. Réponse JSON → `.text`. Clé absente →
  `error` explicite AVANT tout réseau ; HTTP non-2xx → `error` avec corps
  tronqué.
- Pendant un chargement/téléchargement de modèle local, chunks de
  progression `{status: string, progress?: number}` (throttlés à ~1 événement
  / 500 ms).

### `speech.synthesize`

```json
{"id":"req-82","method":"speech.synthesize","params":{"text":"Bonjour !"}}
```

`text` : ≤ 4000 caractères (au-delà → `error` explicite, découpage à la
charge de l'appelant). Réponse : `done` `{audioBase64, mime}`.

- **Local** : `KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX",
  {dtype:"q8"})` (paresseux, mis en cache), `generate(text, {voice, speed})`,
  résultat encodé en WAV → `mime: "audio/wav"`. Mêmes chunks de progression
  au premier chargement. Voix française par défaut : `ff_siwis`. Limite
  connue de kokoro-js 1.2.1 : son registre interne ne liste que les voix
  anglaises alors que les fichiers de voix des autres langues sont bien
  livrés — le sidecar assouplit la validation pour accepter `ff_siwis` (et
  consœurs), mais la **phonémisation reste anglaise** : sur du texte
  français, l'accent est approximatif.
- **Remote** : POST JSON `{baseUrl}/audio/speech` body
  `{model, input: text, voice, response_format}` + `speed` **si ≠ 1**,
  header Bearer `keys.tts` → octets audio encodés en base64.
  - `voice` est un paramètre **requis** de l'endpoint : toujours envoyé, même
    vide.
  - `response_format` est envoyé **explicitement** (le défaut de l'endpoint est
    `"pcm"`, PCM brut sans en-tête, qu'on étiquetterait à tort `audio/mpeg`) et
    sa valeur est **négociée avec le service** : voir ci-dessous.
  - `speed` reste facultatif et n'est honoré que par certains fournisseurs :
    omis à sa valeur neutre (1) plutôt que de risquer un HTTP 400.
  - Mêmes règles d'erreur (clé absente, HTTP non-2xx) que `speech.transcribe`.

**Négociation du `response_format`.** Le format accepté dépend du **modèle** :
`google/gemini-3.1-flash-tts-preview` n'accepte que `"pcm"` (`HTTP 400 … Gemini
TTS only supports response_format="pcm". Got "mp3".`) là où la plupart des
autres n'acceptent que `"mp3"`. Le catalogue OpenRouter bougeant en permanence,
aucune table modèle→format ne resterait fiable : le sidecar procède donc par
essai.

- Format préféré : celui **déjà validé pour ce modèle** (mémorisé en mémoire,
  jamais sur disque), sinon `"mp3"`.
- Si la réponse est un **4xx dont le message extrait cite le paramètre**
  (`response_format`, `response format`, `response-format`, casse
  indifférente) **et nomme l'autre format** en mot entier, la requête est
  rejouée **une seule fois** avec cet autre format. Les deux conditions
  ensemble excluent les 4xx ordinaires (modèle inexistant, voix invalide, clé
  refusée) et les formats non concernés (`opus`, `flac`…).
- Si la seconde tentative échoue, c'est **son** erreur qui remonte, suffixée
  de `(formats "…" puis "…" tentés tous les deux)`.
- Au succès, le format retenu est mémorisé **par modèle** ; le cache est vidé
  quand `speech.configure` change `tts.remote.model` ou `tts.remote.baseUrl`.

**MIME renvoyé.**

- `mp3` : octets bruts, `mime` **déduit de l'en-tête `Content-Type`**
  (paramètres ignorés), repli sur `audio/mpeg` si l'en-tête manque ou
  n'annonce pas de l'audio.
- `pcm` : un `<audio>` ne sait pas lire du PCM brut — les octets sont
  **emballés dans un conteneur WAV** (en-tête RIFF canonique de 44 octets écrit
  autour du buffer, sans réencodage) et `mime` vaut `"audio/wav"`. Les
  paramètres du flux sont lus dans le `Content-Type` quand il en porte
  (`audio/pcm; rate=24000; channels=1`, `bits`/`bits-per-sample` reconnus,
  variantes `sample-rate`/`samplerate` comprises) ; à défaut, repli sur
  **16 bits signés petit-boutistes, mono, 24 000 Hz**, ce que produisent aussi
  bien Gemini TTS que les modèles TTS OpenAI. Si le service annonce malgré tout
  un conteneur autoportant (`audio/mpeg`, `audio/wav`, `audio/ogg`…), les
  octets sont renvoyés tels quels.

**Lisibilité des erreurs HTTP** (dictée comme synthèse) : quand le corps d'une
réponse non-2xx est du JSON « dialecte OpenAI »
(`{"error":{"message":"…"}}`, `{"error":"…"}` ou `{"message":"…"}`), seul le
message est repris dans l'`error` — `HTTP 400 Bad Request: Model … does not
exist` plutôt que le JSON brut. Corps non-JSON ou de forme inattendue :
conservé tel quel. La troncature du corps (`readBoundedBody`) est maintenue,
doublée d'une troncature à 500 caractères du message extrait.

## Commandes Tauri fichiers (mini-tranche du Lot 4)

Pour l'arborescence + éditeur de la page Agent (le Rust reste mince) :

- `fs_list_dir(path: String) -> Result<Vec<DirEntry>, String>` où DirEntry =
  `{name, path, isDir, size}` — trié dossiers d'abord puis alphabétique,
  entrées cachées incluses, erreurs lisibles. Ignore les liens symboliques
  pointant hors du dossier ? Non : suit le comportement standard, l'UI filtre.
- `fs_read_file(path: String, maxBytes: Option<u64>) -> Result<FileContent, String>`
  où FileContent = `{kind: "text"|"binary"|"image", text?, base64?, size, truncated}` —
  détection : extension image connue → base64 ; sinon tentative UTF-8 (avec
  cap maxBytes, défaut 2 Mo) ; non-UTF-8 → kind "binary" (pas de contenu).
- `fs_write_file(path: String, content: String) -> Result<(), String>` —
  écriture atomique (temp + rename), UTF-8.
- `fs_find_by_name(root: String, name: String, maxResults: Option<u32>)
  -> Result<Vec<String>, String>` — chemins absolus des FICHIERS nommés
  exactement `name` (sensible à la casse) sous `root`, parcours en largeur,
  profondeur ≤ 8, répertoires ignorés : `node_modules`, `target`, `dist`,
  `.git`, `.venv`, `venv`, `__pycache__`. `maxResults` défaut 8 (le parcours
  s'arrête dès le quota atteint). Racine inexistante → erreur lisible.
  Usage : résolution des références de fichiers cliquables dans les
  transcriptions (un nom nu est cherché dans le projet ; un chemin avec `/`
  est d'abord essayé relativement à la racine).

## Commande Tauri apps externes (Lot 5)

- `open_external(path: String, command: Option<String>) -> Result<(), String>`
  — ouvre `path` avec `command` (ex. `"kicad"`) ou, si absent, `xdg-open`
  (Linux ; `open`/`start` selon l'OS plus tard). Spawn **détaché** (setsid)
  avec environnement NETTOYÉ des variables Snap (mêmes variables que
  scripts/dev.sh — piège documenté docs/plan.md axe 5), stdout/stderr
  ignorés, ne bloque jamais. Erreur si le binaire est introuvable.
- Registre côté config non-secrète : `{"apps": [{id, label, command,
  "extensions": ["pdf","kicad_pcb"]}]}` — géré par l'UI (section
  « Applications » de la page Configuration), fusion via appConfig.ts.
  Repli sans règle : `xdg-open`. (Surcharge par projet via `.iaction/` : v2.)

## Commandes Tauri état applicatif (Lot 3)

Persistance d'état UI par clé (conversations par projet, etc.) dans
`{app_data_dir}/state/<name>.json` — séparé de la config (qui reste éditable
à la main) :

- `state_read(name: String) -> Result<Value, String>` — `{}` si absent.
  `name` : `[a-z0-9-]{1,64}` (rejeté sinon, anti-traversée).
- `state_write(name: String, value: Value) -> Result<(), String>` — écriture
  atomique, création du répertoire au besoin.
- `fs_mkdir(path: String) -> Result<(), String>` — création récursive
  (utilisé par l'init `.iaction/` dans un projet).
- `fs_rename(path: String, new_name: String) -> Result<String, String>` —
  renomme dans le même dossier (`new_name` = nom simple : ni vide, ni `..`,
  ni séparateur). Refuse d'écraser une cible existante. Renvoie le nouveau
  chemin absolu.
- `fs_delete(path: String) -> Result<(), String>` — suppression DÉFINITIVE
  (pas de corbeille) : fichier via `remove_file`, dossier ENTIER via
  `remove_dir_all` ; un lien symbolique est supprimé sans suivre sa cible.
  Garde-fou : chemin racine refusé. La confirmation utilisateur est à la
  charge de l'UI (modale avant appel).

## Commandes Tauri poste de travail

- `open_terminal(path: Option<String>) -> Result<String, String>` — ouvre un
  terminal système dans `path` (repli : home si absent/invalide). Essaie dans
  l'ordre gnome-terminal, konsole, xfce4-terminal, kitty, alacritty,
  x-terminal-emulator, xterm (répertoire via `current_dir`, spawn détaché,
  env nettoyée du piège Snap). Renvoie le répertoire retenu.
- `system_stats() -> SystemStats` — instantané
  `{cpuPct, memUsedMb, memTotalMb, gpuPct, gpuMemUsedMb, gpuMemTotalMb}`.
  `cpuPct` est un delta entre deux appels (null au premier) ; GPU via
  `nvidia-smi` (null si absent). Jamais d'erreur : les champs indisponibles
  sont null/0.

## Commandes Tauri hors relais (Lot 1)

Le Rust expose aussi, en dehors du protocole sidecar :

- **Trousseau OS** (crate `keyring`, service `"iaction"`) :
  - `secret_set(account: String, value: String) -> Result<(), String>`
  - `secret_get(account: String) -> Result<Option<String>, String>` (None si absent)
  - `secret_delete(account: String) -> Result<(), String>` (ok même si absent)
  - Convention d'account : `provider:<id>` (ex. `provider:openrouter`).
- **Store de config non-secrète** (JSON dans `{app_config_dir}/config.json`) :
  - `config_read() -> Result<serde_json::Value, String>` (`{}` si absent)
  - `config_write(value: serde_json::Value) -> Result<(), String>` (écriture atomique :
    fichier temporaire puis rename)
  - Contenu Lot 1 : `{"providers": [{id, label, baseUrl, needsKey, headers?}]}` —
    **jamais de clé API dedans**.

Flux des clés : l'UI lit la clé au trousseau (`secret_get`) au démarrage / après
saisie dans l'admin, et l'injecte dans `providers.set`. La clé ne transite qu'en
mémoire (IPC local), n'est jamais écrite ailleurs que dans le trousseau.

## Côté Rust (supervision + relais)

- Spawn au démarrage de l'app : `node <entry>` où `<entry>` = env `IACTION_SIDECAR` si définie, sinon (build debug) `{CARGO_MANIFEST_DIR}/../sidecar/dist/index.js`.
- stdout du sidecar : chaque ligne parsée en JSON → émise telle quelle à l'UI via l'event Tauri **`sidecar:event`** (payload = l'objet JSON). Ligne non parsable → log, ignorée.
- stderr du sidecar : relayé en log Rust (`eprintln`) et émis via l'event Tauri **`sidecar:log`** (payload = string).
- Supervision : si le process meurt, redémarrage avec backoff exponentiel (500 ms, ×2, plafond 8 s) ; compteur remis à zéro après 30 s de stabilité ; après 5 échecs consécutifs → état `dead`, plus de redémarrage.
- État publié via l'event Tauri **`sidecar:status`**, payload `{"state": "starting"|"running"|"restarting"|"dead", "pid": number|null, "attempts": number}`. `running` = process vivant (dès le spawn réussi).

### Commandes Tauri exposées à l'UI

- `sidecar_request(request: serde_json::Value) -> Result<(), String>` : sérialise en une ligne, écrit sur stdin du sidecar. Erreur si le sidecar n'est pas en état `running`.
- `sidecar_status() -> StatusPayload` : dernier état connu (même forme que `sidecar:status`).

## Côté UI

- S'abonne à `sidecar:event`, `sidecar:status`, `sidecar:log` (`@tauri-apps/api/event`).
- Corrèle les événements par `id` ; le `ready` (sans `id`) sert d'indicateur « sidecar opérationnel ».
- Génère les `id` de requête (`req-${compteur}` suffit en Lot 0).

## Outils annexes — serveur MCP IMAP & runner headless

Deux briques génériques, hors du sidecar principal, pour des agents qui ont
besoin d'IMAP et/ou tournent sans UI (ex. agent quotidien de ménage d'une
boîte mail).

### `tools/mcp-imap` — serveur MCP stdio IMAP

Serveur MCP autonome (Node ESM, `@modelcontextprotocol/sdk` + `imapflow`,
`npm install` dans `tools/mcp-imap`) à référencer depuis `<cwd>/.mcp.json`
d'un projet (voir « MCP » sous `claude.start` plus haut) :

```json
{"mcpServers": {"imap": {"command": "node", "args": ["/chemin/vers/tools/mcp-imap/server.mjs"],
  "env": {"IMAP_HOST": "ssl0.ovh.net", "IMAP_USER": "moi@exemple.fr",
          "IMAP_PASSWORD_KEYRING": "service=iaction account=imap-david-duvam"}}}}
```

Configuration par variables d'environnement : `IMAP_HOST` et `IMAP_USER`
requis, `IMAP_PORT` (défaut 993). Mot de passe via `IMAP_PASSWORD` (tests
uniquement, en clair) **ou** `IMAP_PASSWORD_KEYRING="service=<s> account=<a>"`
(lookup unique au démarrage via `secret-tool lookup service <s> account
<a>` — jamais loggé, jamais écrit sur disque). `MCP_IMAP_READONLY=1` bascule
le serveur en **mode rapport seul** : `move_to_trash` ne touche plus au
serveur IMAP. Configuration absente/incomplète → le serveur démarre quand
même (handshake MCP et `tools/list` fonctionnent), chaque appel d'outil
renvoie une erreur d'outil propre ; un `IMAP_PASSWORD_KEYRING` fourni dont le
lookup échoue réellement (secret absent, trousseau verrouillé...) fait
échouer le démarrage (message clair sur stderr, exit 1).

Trois outils (schémas JSON stricts, connexion IMAP ouverte/refermée à chaque
appel, jamais de crash serveur — erreurs renvoyées en `isError`) :

| outil | params | résultat |
|---|---|---|
| `list_folders` | `{}` | `[{path, specialUse?}]` |
| `list_messages` | `{folder?="INBOX", olderThanDays?, newerThanDays?, limit?=200}` | `[{uid, date, from, subject, snippet}]`, plus récents d'abord ; filtre par date de réception (INTERNALDATE, SEARCH BEFORE/SINCE) ; `snippet` = ~300 premiers caractères du texte du message, best effort (`""` si illisible) |
| `move_to_trash` | `{folder?="INBOX", uids: number[]}` | `{moved, trashFolder}` ; dossier Corbeille détecté via `specialUse:"\Trash"` puis repli sur les noms usuels (Trash/Corbeille/INBOX.Trash) ; en mode rapport seul : `{moved:0, dryRun:true, message}` sans connexion au serveur |

### `scripts/orch-run-headless.mjs` — lanceur d'orchestration sans UI

```
node scripts/orch-run-headless.mjs <cwd-du-projet> <nom-orchestration> [--input clef=valeur ...] [--save-output fichier.md]
```

Spawne le sidecar (`../sidecar/dist/index.js`, relatif au script), attend
`ready`, pousse `<cwd>/providers.json` (s'il existe, format `{"providers":[...]}`
identique à `providers.set` — pas requis pour des agents `engine: claude`,
utile pour des agents neutres), puis envoie `orch.run {cwd, name, inputs}` et
relaie sur stdout un résumé lisible des événements (`step_started`/
`step_done`/`step_failed`/`step_skipped`, extraits d'output ≤200 caractères)
et du statut final. Timeout global 30 min (annulation façon `orch.abort` à
l'échéance) ; `SIGTERM`/`SIGINT` déclenchent aussi un `orch.abort` propre
avant de sortir. Code de sortie : `0` (`success`), `2` (`partial`), `1`
sinon (`failed`/`aborted`/erreur de résolution/timeout).

`--save-output fichier.md` : après un run résolu, écrit un rapport Markdown
déterministe (en-tête run/statut puis la sortie **complète** de chaque étape,
dossiers créés au besoin). C'est le runner qui matérialise le fichier — on ne
compte pas sur l'agent pour écrire son rapport sur disque (un modèle peut
résumer en réponse finale sans jamais appeler Write).

Gabarits `{{today}}` (docs/protocol.md § T1) : résolus par le runner en date
**locale** `YYYY-MM-DD` au lancement, dans les valeurs de `--input` et dans le
chemin `--save-output` — les unités systemd T2 passent donc les gabarits tels
quels, sans substitution shell (`--input date={{today}} --save-output
…/rapports/{{today}}.md`).
