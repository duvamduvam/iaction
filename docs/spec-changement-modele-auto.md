# Spec — l'agent ajuste lui-même son modèle et son effort (T-207)

Date : 2026-11-08. Décisions de David (questionnaire du jour) :

- **Dans les deux sens, sans validation** : l'agent peut monter (vers Fable) comme descendre (vers Opus/Sonnet/Haiku) et changer l'effort, sans demander. David est informé par un bandeau avec « Annuler ».
- **Effet immédiat** : le changement s'applique dans le tour en cours (`setModel` / `applyFlagSettings` du SDK), puis reste pour les tours suivants de l'onglet.

Contexte : la consigne globale de David demande déjà au modèle de signaler en une ligne « Opus suffit » ou « Fable serait plus adapté ». Ça marche, mais il faut ensuite changer le sélecteur à la main. Cet outil supprime ce geste.

## Périmètre

Moteur Claude de la page Projets uniquement (pas le Chat, pas le moteur neutre). Hors périmètre : routage Auto existant (R2), sous-agents (leur modèle reste celui de l'appel `Agent`).

## 1. Sidecar — outil `changer_modele` dans le serveur MCP interne `studio`

Fichier nouveau `sidecar/src/changerModele.ts`, sur le modèle de `sidecar/src/askUser.ts` (`sdk.tool`, `zod/v4`, `null` en mode `IACTION_FAKE_CLAUDE=1`).

- Nom : `changer_modele` (exposé `mcp__studio__changer_modele`).
- Entrée : `modele` (énumération des identifiants de `MODELES_ABONNEMENT_CLAUDE`, voir `ui/src/modelesAbonnementClaude.ts` — dupliquer la liste côté sidecar ou la partager si un module commun existe déjà), `effort` optionnel (`low|medium|high|xhigh|max`, validé par `effortValide` de `sidecar/src/claudeEffort.ts`), `raison` (une phrase, obligatoire).
- Description de l'outil (en français), à peu près : « Change le modèle Claude (et éventuellement l'effort) de cette conversation, immédiatement et pour les tours suivants. Appelle-le en début de demande, ou dès que la nature du travail change, quand le modèle actuel n'est pas le bon selon les consignes de l'utilisateur (Fable pour trancher, concevoir, spécifier, sécurité, diagnostic qui résiste ; Opus pour le travail courant ; Sonnet/Haiku pour l'exécution d'une spec fermée). Ne l'appelle pas pour un gain marginal, ni plus d'une fois par demande. Après l'appel, continue le travail normalement. »
- Exécution :
  1. Si le modèle demandé est déjà le modèle courant ET l'effort inchangé → rend « déjà en place », rien d'autre.
  2. Sinon `await query.setModel(modele)` ; si `effort` fourni, `await query.applyFlagSettings({ effortLevel: effort })`. L'objet `query` est celui créé dans `claude.ts` (ligne ~642) : passer au serveur une fonction d'application fermée sur lui (le serveur est construit avant la query → fournir un pont dont la cible est posée juste après `queryFn`).
  3. Émettre un événement vers l'UI (voir §2), journaliser (journal consolidé, comme les autres événements du moteur : modèle avant/après, effort avant/après, raison, sessionId).
  4. Rendre au modèle un texte court : « Modèle passé de X à Y (effort Z). Continue. »
  5. En cas d'échec de `setModel` / `applyFlagSettings` : `isError: true` avec le message, événement d'échec journalisé, AUCUN changement côté UI. Jamais d'échec muet.
- Le serveur `studio` doit exister pour TOUT tour projet Claude, pas seulement en mode `interactive` (aujourd'hui `askServer` n'existe qu'en interactif) : regrouper les outils dans un même serveur `studio` (ask_user conditionnel, changer_modele toujours), ou un second serveur `studio_modele` si le regroupement complique — au choix de l'implémenteur, à justifier dans le rapport.
- Agent préréglé à modèle fixe (`selectedAgent.model !== null` côté UI, sélecteur grisé) : le sidecar reçoit un paramètre `modeleVerrouille: true` et l'outil n'est pas exposé (pas de faux espoir pour le modèle).
- Mode chat pur (`chatOnly`) : jamais exposé.

## 2. Protocole

Nouvel événement de flux pendant le tour, ex. chunk `{ type: "model_change", from, to, effortFrom, effortTo, raison }` (aligner le nommage sur les chunks existants de `claude.ts`). Documenter dans `docs/protocol.md`, ajouter une fixture dans `fixtures/protocole/` et l'étendre aux tests de protocole existants (`sidecar/test/protocol.test.js`, `ui/src/protocole.test.ts`).

## 3. UI — page Projets

- À réception : mettre à jour le modèle et l'effort de la conversation (même état que le sélecteur « Modèle » / « Effort » du panneau LLM, persisté comme un choix manuel) pour que les tours suivants partent avec.
- Bandeau dans la conversation (style des bandeaux existants, ex. le « Annuler » du vidage Ctrl+K) : « L'agent est passé à **Opus 5.5** · effort moyen — *raison* » + bouton **Annuler**.
- **Annuler** : remet modèle et effort d'avant dans le sélecteur ; si le tour tourne encore, rappelle aussi le moteur (ajouter une requête sidecar `claude.setModel` ou réutiliser le canal de push existant — au choix, documenté dans protocol.md) ; sinon effet au prochain tour.
- La transcription garde une trace dans le tour (le bloc d'outil `mcp__studio__changer_modele` s'affiche déjà comme les autres outils ; vérifier qu'il est lisible).
- Coût affiché d'un tour à deux modèles : ne rien inventer ; si le coût est ventilé par modèle (`modelUsage`), le montrer ; sinon laisser le total tel quel.

## 4. Tests (obligatoires)

- Sidecar : outil appelé → `setModel`/`applyFlagSettings` appelés avec les bonnes valeurs (faux query), événement émis ; modèle identique → aucun appel ; échec de `setModel` → `isError`, pas d'événement de changement ; `chatOnly` et `modeleVerrouille` → outil absent.
- UI : réception de l'événement → sélecteur mis à jour ; Annuler → valeurs d'avant restaurées.
- `npm run verif` à la racine, vérifié par le CODE DE SORTIE.

## Contraintes

- Ne PAS recompiler le sidecar de l'app lancée (`dist-dev`), ne PAS lancer `npm ci` ni l'app : vérifier par `npm test` (compile dans `dist-verif`) et `npm run verif`.
- Aucun chemin `/home/<compte>/` dans le dépôt.
- Commentaires et textes en français, référencer T-207.
- Ne pas commiter.
