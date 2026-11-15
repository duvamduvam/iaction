# Spec — Deux comptes Claude (« Claude Perso » / « Claude Teams »)

> Cadre : `docs/etude-deux-comptes.md` (preuve P0 du 2026-11-05, § 7 bis).
> Regroupe les phases P1 (conso par compte) et P2 (sélecteur).

## Règles

1. **IAction ne lit, ne stocke ni ne transmet aucun jeton.** Il passe
   `CLAUDE_CONFIG_DIR` au CLI, rien d'autre. Du fichier d'identifiants, seule la
   date `refreshTokenExpiresAt` peut être lue.
2. **Jamais de bascule automatique** entre comptes. Le changement est un geste de
   l'utilisateur. Le débord ne vise jamais l'autre compte.
3. **Invisible sans second compte.** Si le dossier du compte Teams n'a pas de
   `.credentials.json`, l'interface reste exactement celle d'aujourd'hui, libellé
   « Claude (abonnement) » compris. C'est ce qui garde la fonction hors de la
   version publiée.
4. **Compatibilité.** `compte` absent = `perso`, partout : paramètres, sessions
   persistées, lignes d'historique. Aucune migration de données.

## Comptes

Deux comptes, ids fixes :

| id | Libellé | Dossier |
|---|---|---|
| `perso` | Claude Perso | Celui du processus : aucun `CLAUDE_CONFIG_DIR` ajouté |
| `teams` | Claude Teams | `<foyer>/.claude-compte2` |

Module unique `sidecar/src/compteClaude.ts`. Il est le seul à connaître ce tableau
et rend l'env d'un compte. Le foyer passe par `PathEnv` (`appPaths.ts`).

## Sidecar

- **`claude.comptes`** (nouvelle méthode) : `{ comptes: [{ id, label, connecte }] }`.
  `teams` n'y figure que si son `.credentials.json` existe. `connecte: false` si
  `refreshTokenExpiresAt` est dépassé.
- **`claude.start`** : paramètre optionnel `compte`. Id inconnu, ou compte
  indisponible : `emitter.error` avec un message qui donne la commande
  `CLAUDE_CONFIG_DIR=~/.claude-compte2 claude auth login`. Le compte est journalisé
  à chaque tour.
- **`claude.commands`** : même paramètre, même env.
- **`usage.claude`, `usage.claude.init`** : paramètre optionnel `compte`. Le dépôt
  d'usage devient un relevé par compte, et l'état de cadence de la sonde aussi. Le
  micro-tour reçoit l'env du compte.
- **`claude-windows.jsonl`** : champ `compte` écrit seulement si différent de
  `perso`. `usage.claude.history` et `readLatestClaudeWindows` prennent un compte,
  `perso` par défaut, et filtrent. Une ligne sans champ vaut `perso`.
- **Débord et routeur** : inchangés dans leur logique. Ils lisent les fenêtres de
  `perso`, et ne doivent plus jamais être influencés par une ligne `teams`.
- **Tâches de fond, routage Auto, agents, sessions distantes** : `perso`. Aucun
  changement.
- Mettre à jour `docs/protocol.md` et les fixtures de `fixtures/protocole/`.

## Interface

- Le moteur reste modélisé tel quel (`providerId: null` = Claude) : **ne pas**
  créer de faux fournisseur, de nombreux tests `=== null` en dépendent. On ajoute
  un champ `compte` à `engine` dans l'état de session, persisté.
- Listes « Moteur » de `agentSidebarDroit.tsx` et de `ChatPage.tsx` : si
  `claude.comptes` rend `teams`, deux options « Claude Perso » et « Claude Teams »
  à la place de « Claude (abonnement) ». Un compte `connecte: false` reste
  sélectionnable et son libellé le signale.
- Les listes de configuration d'agents (`orchAgents.tsx`, `ProvidersPage.tsx`) ne
  changent pas.
- `compte` part avec `claude.start` et le menu « / ». Changer de compte garde
  `sessionId` : la reprise croisée est prouvée.
- **Jauges de l'encart** : elles suivent le compte de la session active, cache
  disque compris (un cache par compte). Quand c'est `teams`, le nom du compte est
  affiché à côté. Sans second compte, rendu inchangé.
- Le changement d'onglet entre deux sessions de comptes différents met les jauges
  à jour sans attendre le prochain battement.

## Compte par défaut d'un projet

- Champ optionnel `compteClaude` (`"perso"` | `"teams"`) sur un projet déclaré dans
  la configuration (`ProjectConfig`, `ui/src/projectAdmin.ts`). Rien de propre à un
  projet n'est écrit en dur dans le code : le réglage vit dans la config du poste.
- Résolution du compte d'une session : choix explicite de la session, sinon
  `compteClaude` du projet, sinon `perso`. Une session sans champ `compte` suit donc
  le défaut de son projet ; un choix manuel dans la liste Moteur est conservé.
- Si le défaut vaut `teams` et que le compte n'a **aucun** dossier connecté (poste
  sans second compte) : retour à `perso` avec un journal `warn`, l'interface restant
  celle sans second compte.
- Si le compte existe mais est déconnecté : **pas de repli**. Le tour est refusé
  avec la commande de connexion, comme pour un choix explicite. Le travail d'une
  organisation ne glisse pas seul sur le compte personnel (règle 2).
- Liste des comptes inconnue (sidecar qui démarre, échec d'appel) : un échec ne vaut
  jamais « aucun compte ». La dernière liste connue reste valable, et un envoi
  attend la réponse plutôt que de partir sur `perso`.
- Valeur invalide de `compteClaude` : `warn` au journal. Le champ est lu au
  démarrage de l'application.
- Aucun écran de réglage pour l'instant : le champ s'édite dans la config. Il doit
  survivre aux réécritures de la config par l'application.
- Une nouvelle session repart du défaut de son projet : elle n'hérite pas du choix
  explicite de la session précédente.

## Compte et modèle Auto (décision après revue)

Ce que le sélecteur affiche est le compte du tour, sans exception. Le routage Auto
ne connaît que `perso` : **Auto n'est donc pas proposé quand le compte effectif
n'est pas `perso`**. Choisir Claude Teams alors que le modèle est Auto passe sur le
modèle Claude par défaut. Hors ce cas, changer de compte ne change pas le modèle.

Un agent sélectionné dans une session suit le compte de cette session : c'est la
séparation qui compte. La mention « les agents restent sur `perso` » ne vise que les
tâches de fond.

## Sondes

Chaque compte disponible est sondé à sa cadence, qu'il soit affiché ou non. Le
débord lit ainsi un relevé `perso` frais pendant un travail sur Teams, et un compte
peu utilisé ne se déconnecte pas faute d'usage.

## Tests attendus

- Défaut de projet : session sans `compte` → défaut du projet ; choix explicite
  prioritaire ; projet sans champ → `perso` ; `teams` indisponible → `perso`.
  Le champ `compteClaude` survit à une sauvegarde de la config.

- `compteClaude` : env par compte, dossier absent, expiration dépassée, aucun
  accès au champ de jeton.
- Historique : lignes anciennes = `perso` ; une ligne `teams` à 99 % ne déclenche
  **pas** le débord ; le débord lit bien `perso` derrière elle.
- `claude.start` : `CLAUDE_CONFIG_DIR` présent dans `options.env` pour `teams`,
  absent pour `perso` ; compte inconnu refusé.
- Dépôt d'usage : le relevé d'un compte n'écrase jamais celui de l'autre.
- Interface : option absente sans second compte ; session ancienne = `perso` ;
  `compte` envoyé au tour.
