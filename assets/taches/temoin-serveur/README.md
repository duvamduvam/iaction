# Tâche `temoin-serveur` — gabarit

Gabarit **versionné** du premier cobaye de la tranche **D1** de
[docs/etude-remote.md](../../../docs/etude-remote.md) : le conteneur
`ia-runner` qui exécute des tâches d'agent sur le VPS OVH pendant que le PC
est éteint.

Ce dossier n'est **pas** une tâche installée : rien ici n'est lu par
l'application tant que vous ne l'avez pas copié dans l'espace des tâches. Il
est livré **désarmé** (`enabled: false`).

## À quoi elle sert

À ne rien produire d'utile — et c'est le but. Le témoin valide la **chaîne**,
pas le métier. Un run réussi prouve d'un coup, sans risque et pour un coût
quasi nul, que :

1. la **synchro descendante** a bien déposé le projet sur le serveur (le
   témoin cherche les marqueurs `.iaction/`) ;
2. le **jeton d'abonnement Claude** fonctionne en headless dans le conteneur ;
3. le **scheduler** (supercronic) a déclenché la tâche à l'heure prévue ;
4. le **runner** a écrit `rapports/<date>.md` ;
5. la **synchro montante** a ramené ce rapport jusqu'à l'app, où il apparaît
   au rallumage du poste.

C'est le jalon de D1 : « le rapport témoin apparaît dans l'app au rallumage ».
Une fois la chaîne éprouvée, le cobaye suivant est l'indexation RAG, puis la
migration de `menage-mails`.

## Ce qu'il rapporte

Un rapport d'une page, dont la **première ligne est un verdict** `OK` ou
`ANOMALIE` — la seule ligne à lire les jours où tout va bien. Suivent
l'environnement relevé (hostname, noyau, date/heure/fuseau, conteneur oui/non,
espace disque), l'état du projet synchronisé (marqueurs présents ou absents,
fichier le plus récemment modifié) et la liste des anomalies.

Le verdict est `ANOMALIE` dès que le répertoire de travail ne contient pas de
dossier `.iaction/`, même si tout le reste va bien : cela signifie que la
synchro descendante n'a pas fait son travail, et donc qu'aucune autre tâche
serveur ne peut fonctionner.

## Choix de conception

- **Modèle `claude-haiku-4-5`** — le moins cher du catalogue ($1/$5 par
  million de tokens). Le témoin constate, il ne raisonne pas ; et il tourne
  potentiellement toutes les heures, donc son coût unitaire compte plus que sa
  finesse.
- **`lieu: serveur`** — champ introduit en D1. Il vaut `local` par défaut, ce
  qui rend une tâche invisible pour le conteneur. C'est le garde-fou
  anti-double-déclenchement : une tâche ne doit **jamais** être armée à la
  fois en timer systemd local et côté serveur.
- **Lecture seule, aucune sortie réseau** — application de la règle d'or des
  « zones d'écriture disjointes » (étude § 3) : une tâche serveur n'écrit que
  dans ses zones (`rapports/`, journal, index, état), jamais dans les sources
  d'un projet. Le témoin est le premier à devoir le prouver.
- **Ne lit aucune variable d'environnement** — le `.env` du serveur porte le
  jeton Claude, le secret HMAC du webhook et le mot de passe IMAP. L'agent a
  interdiction explicite de faire `env`, `printenv` ou de lire un `.env`.

> ⚠️ **Ces garanties reposent sur le prompt, pas sur le moteur.** L'agent
> déclare `tools: [Read, Glob, Bash]`, mais cette allowlist **n'est pas
> appliquée** pour une étape `engine: claude` (voir
> [T-003](../../../docs/tickets.md)) : la palette complète — Write et Edit
> comprises — lui est réellement accessible, et une tâche planifiée tourne
> forcément en `permissionMode: bypassPermissions`.
>
> Le risque, déjà réel en local, est **plus lourd côté serveur** : le
> conteneur héberge le `.env` et voit les projets de la liste blanche
> synchronisés depuis Nextcloud. Un agent qui écrirait dans le projet
> déclencherait en plus des conflits de synchro. Deux mitigations attendent
> T-003 : le conteneur tourne en utilisateur non-root, et les projets
> pourraient être montés en lecture seule hors zones serveur.

## Installation

1. Copier ce dossier dans l'espace des tâches **du serveur** — c'est-à-dire
   dans le dossier synchronisé pointé par `IA_RUNNER_TACHES_DIR`, et non dans
   `~/.config/net.duvam.iaction/taches/` qui, lui, est local à la machine et
   n'est pas synchronisé.
2. Renseigner le projet cible dans `tache.yaml` (champ `projet`, ou `cwd` — le
   runner résout le chemin du poste vers son équivalent sous
   `IA_RUNNER_PROJETS_DIR`, et échoue explicitement s'il ne le trouve pas).
3. **Rodage à la main d'abord** : « Lancer maintenant » depuis l'app, ou
   directement sur le serveur, et vérifier le rapport produit. Ne pas armer un
   timer avant d'avoir vu un `OK`.
4. Passer `enabled: true` une fois le premier run concluant.
5. Espacer la cadence (ou désarmer) une fois la chaîne éprouvée : le témoin
   n'a d'intérêt que tant qu'on doute d'elle. Le heartbeat du runner, lui,
   reste en place en permanence.

## En cas d'échec

- **Aucun rapport n'arrive** → la chaîne est coupée en amont du modèle :
  regarder le journal du runner, puis l'état du conteneur
  (`docker compose ps`) et la synchro rclone. Le heartbeat de D2 est fait pour
  détecter ce cas sans attendre.
- **Verdict `ANOMALIE` sur les marqueurs absents** → la synchro descendante
  n'a pas déposé le projet, ou le champ `projet`/`cwd` ne correspond à rien
  sous `IA_RUNNER_PROJETS_DIR`.
- **Écart de date signalé** → problème d'horloge ou de fuseau dans le
  conteneur (`TZ=Europe/Paris` doit être posé).
- **Échec d'authentification LLM** → le jeton `claude setup-token` a expiré ou
  n'est pas transmis ; le renouveler dans le `.env` du serveur (chmod 600,
  hors dépôt et hors Nextcloud).
