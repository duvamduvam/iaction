# Journal des versions

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon [SemVer](https://semver.org/lang/fr/).

> Ce journal est tenu à la main, et c'est voulu : l'historique public est fait
> d'instantanés (un commit par publication, voir `docs/github.md`), donc des
> notes de version générées depuis les messages de commit ne diraient rien.
> Les entrées commencent à la 0.3.0 ; les versions antérieures ne sont pas
> reconstituées après coup.

## [0.5.0] — 2026-08-26

### Ajouté

- **L'application dit qu'une version existe.** Il fallait aller voir le dépôt :
  la page Système compare maintenant la version installée à la dernière
  publiée, montre les nouveautés, et ouvre la page de téléchargement dans le
  navigateur déclaré. L'installeur Windows, lui, savait déjà mettre à jour en
  place — c'est la nouvelle qui manquait, pas la mise à jour. **Rien n'est
  téléchargé ni installé automatiquement** : l'installation reste un geste de
  l'utilisateur, et le jour où l'application s'installera seule, ce sera une
  décision explicite avec des clés de signature. La sonde interroge par le
  moteur, donc à travers le proxy et l'autorité déclarés — sans quoi un poste
  d'entreprise s'entendrait dire « à jour » sans que rien n'ait été vérifié
  (T-056).
- **Les panneaux latéraux se replient**, chacun de son côté et indépendamment
  de l'autre : une poignée verticale entre le panneau et la zone de travail,
  et la préférence est retenue d'une session à l'autre. Replié, le panneau
  n'est plus rendu du tout ; la poignée, elle, reste toujours là — c'est le
  seul chemin de retour (T-057).

### Modifié

- **« Arrêter » passe au-dessus d'« Envoyer »** pendant un tour, au lieu d'être
  à côté : deux boutons empilés ne prennent qu'une largeur, et la place gagnée
  revient à la zone de saisie — la même règle que la colonne d'icônes du
  composeur (T-057).

## [0.4.1] — 2026-08-26

### Corrigé

- **Windows : plus de console noire qui clignote.** Une fenêtre de terminal
  apparaissait et se refermait toutes les cinq secondes, en boucle, tant que
  l'application tournait. La sonde GPU relançait `nvidia-smi` — un programme
  console, à qui Windows alloue d'office une fenêtre — sans la masquer.
  `CREATE_NO_WINDOW` la supprime ; la mesure, elle, continue à l'identique. Le
  masquage n'était plus une ligne perdue au fond du lancement du moteur mais une
  fonction partagée, pour que le prochain process console n'ait pas à la
  redécouvrir. Au passage, une machine **sans** carte NVIDIA cesse de relancer un
  binaire absent toutes les cinq secondes : le premier « introuvable » suffit
  (T-054).
- **Le journal cesse (encore) de crier au loup.** Sans clé OpenRouter, l'encart
  de consommation réclamait le crédit toutes les quinze secondes et journalisait
  chaque refus en `error` — pour une configuration parfaitement volontaire. Le
  statut « clé enregistrée », déjà connu, voyage désormais avec la table des
  fournisseurs : on n'interroge plus qui va refuser, et la sonde repart d'elle
  même dès qu'une clé est saisie. La clé, elle, ne quitte pas le trousseau
  (T-055).

## [0.4.0] — 2026-08-15

### Ajouté

- **Encart « Réseau » (Configuration).** Derrière un proxy d'entreprise, il n'y
  avait aucun endroit où saisir une adresse : sous Windows les variables vivent
  souvent dans le profil du terminal et pas dans la session graphique, et il
  fallait passer par `setx`. Proxy, hôtes en direct, autorité de certification
  et magasin du système se règlent maintenant dans l'application. Le fichier de
  configuration automatique (PAC) n'est toujours **pas** lu, et l'encart le dit
  (T-045).

### Corrigé

- **Un chemin cité dans une réponse ne ment plus.** Un `~/Téléchargements/x.pdf`
  devenait un bouton dont le clic répondait « introuvable dans le projet » à
  propos d'un fichier qui existe. Il est désormais nommé « hors du projet », et
  ce qui ne peut pas s'ouvrir ne se déguise plus en bouton (T-024).
- **Un rapport HTML s'ouvre dans le navigateur déclaré**, local ou distant : le
  registre d'applications, que seul l'arbre de fichiers consultait, vaut aussi
  pour les références citées dans une transcription (T-049).
- **Le journal cesse de crier au loup.** La sonde `ollama.ps` interroge le
  fournisseur sélectionné toutes les dix secondes : son échec est une réponse,
  pas une panne, et il produisait 140 lignes `error` en onze jours, avec deux
  kilo-octets de HTML chacune. Une page web reçue au lieu d'une API est
  résumée, et l'erreur nomme enfin le fournisseur concerné (T-007).
- **Plus d'erreur d'usage au démarrage** : l'encart de consommation attend que
  la table des fournisseurs ait atteint le moteur avant de l'interroger
  (T-008).
- **Les questions interactives sont de nouveau proposées au modèle.** L'outil
  n'était documenté que par une fiche qu'il fallait chercher pour lire ; il est
  annoncé par l'instruction système, qui part à chaque tour. Le journal dit
  désormais si l'outil figure dans la palette, ce qu'aucune ligne ne permettait
  de savoir (T-019).
- **Les agents `*-with-search` ne sont plus proposés quand la recherche web est
  active** : la recherche était faite deux fois, et la seconde échouait un tour
  sur cinq (T-025).
- **Le runner serveur ne vole plus le verrou d'un détenteur vivant** hors Linux
  (T-053), et un verrou orphelin ne gèle plus toutes les synchros (T-050).
- **L'empaquetage local ne ressuscite plus les fichiers supprimés** : la mise en
  scène de la construction précédente est purgée (T-041).

### Interne

- **Profils de fournisseur** : la gratuité et le chemin de la jauge de solde
  sont déclarés (`billing`, `creditsPath`) au lieu d'être devinés sur le nom du
  fournisseur. `usage.openrouter` devient `usage.credits` — l'ancien nom reste
  accepté (T-023).
- La dépense de la période distingue « aucun coût reçu » (il y a une
  comptabilité à cocher) de « fournisseur qui n'en remonte jamais » (rien à
  chercher) : Swiftask est dans le second cas, et la recherche web n'a rien à
  facturer (T-036).
- La suite de tests n'écrit plus dans le vrai dossier de données du poste
  (T-051).
- **Les tours de projet partaient avec un prompt système VIDE.** Le SDK agent
  n'utilise pas le prompt de Claude Code quand on ne lui en donne pas — il en
  envoie un vide — et une instruction d'agent le remplaçait au lieu de s'y
  ajouter. Les tours outillés demandent désormais le preset explicitement, et
  l'instruction de l'agent s'y ajoute. Le chat pur, sans outils, ne change pas
  (T-052).
- **Dépendances montées** : `ip-address`, `fast-uri`, `hono` et
  `@hono/node-server` — les quatre paquets vulnérables qui partaient réellement
  dans le produit. Les cinq alertes restantes concernent la pile de voix locale,
  exclue du bundle, et `glib` dépend d'une montée de Tauri (T-012).
- Extractions imposées par le cliquet de taille, toutes justifiées : navigation
  au clavier (`focusZones.ts`), tableau des raccourcis (`raccourcisClavier.ts`),
  références de fichiers (`refFichier.ts`), palette du tour (`paletteTour.ts`),
  client Ollama, helpers SSE de test.

## [0.3.3] — 2026-08-15

### Corrigé

- **Runner serveur : un verrou survivait à son détenteur et gelait toutes les
  synchros.** `entrypoint.sh` se relance lui-même quand un manifeste change, ce
  qui tue le run en cours sans vider `/tmp` : le verrou restait pris par un
  processus mort et chaque synchro suivante était « reportée », indéfiniment.
  Le détenteur est désormais vérifié vivant (`/proc/<pid>`) et le verrou repris
  sinon, avec une ligne de journal en erreur. Prudence dans l'autre sens : fiche
  absente ou illisible ⇒ détenteur réputé vivant (T-050).
- **`claude-opus-5` manquait dans les sélecteurs de modèle.** L'abonnement
  Claude n'expose pas de catalogue interrogeable, donc la liste est tenue à la
  main — mais elle était recopiée dans trois fichiers, et personne n'a fait le
  tour quand le modèle est sorti. Liste unique désormais, dont les trois
  consommateurs dérivent, avec une note par modèle en infobulle (T-046).
- **`claude-opus-4-8` retiré du sélecteur** : même tarif qu'Opus 5 pour une
  génération de moins. Le palier `moyen` du routage automatique passe à
  `claude-opus-5`. Un fil déjà épinglé sur 4.8 continue de tourner et affiche
  son id — il ne peut simplement plus être resélectionné.

### Interne

- Garde-fou sur la table de routage par défaut, écrite à la fois dans le
  sidecar et dans l'interface : `npm run routage` refuse tout écart entre les
  deux, palier par palier (T-047).
- **La suite de tests travaillait dans le vrai `~/.local/share`.** Le harnais
  imposait un `XDG_CONFIG_HOME` jetable mais pas `XDG_DATA_HOME` : sur un shell
  ordinaire, le sidecar de test visait le dossier de données réel, où il migre
  au démarrage l'ancien nommage — une opération qui DÉPLACE. Un dossier jetable
  est désormais imposé pour les deux (T-051).

## [0.3.2] — 2026-08-13

### Corrigé

- **Réseau d'entreprise : tous les fournisseurs en « erreur réseau ».** Le
  `fetch` de Node n'honore pas `HTTP_PROXY`/`HTTPS_PROXY`, contrairement à curl
  ou à un navigateur : derrière un proxy obligatoire, chaque appel expirait en
  `UND_ERR_CONNECT_TIMEOUT` pendant que le navigateur d'à côté fonctionnait. Le
  sidecar est désormais lancé avec `--use-env-proxy` (T-043).
- **Le journal disait « erreur réseau: fetch failed » sans la cause.** Un
  proxy, un certificat, un DNS muet et un service éteint produisaient la même
  ligne. Le code (`UND_ERR_CONNECT_TIMEOUT`, `ENOTFOUND`…) accompagne
  maintenant le message, y compris dans le Chat (T-044).

### Interne

- `sidecar.rs` sort des dérogations de taille : ses tests unitaires vivent dans
  un fichier à part, le fichier repasse sous la limite de 800 lignes (T-034).

## [0.3.1] — 2026-08-13

### Ajouté

- **Sélecteur de modèle lisible** : les fournisseurs qui servent des centaines
  de références ne déversent plus leurs slugs bruts dans une liste déroulante —
  recherche, regroupement et favoris sans doublon (T-032).
- **Supervision — carte « Dépense de la période »** : la dépense RÉELLE de la
  période, tous tours payants confondus, à côté du « Débord du mois » qui ne
  compte que le routage automatique. On pouvait dépenser sans qu'aucun écran ne
  l'affiche (T-035). Tant que des tours payants ne remontent pas de coût, la
  carte annonce un minorant explicite plutôt qu'un faux total (T-036).
- **Supervision — graphique de courbes** des quatre indicateurs, tracé sur le
  cran de période au-dessus de la sélection (jour → sa semaine, semaine → son
  mois, mois → son année), séries indexées sur leur propre pic pour tenir sur un
  axe unique, palette vérifiée par calcul (contraste et séparation daltonisme).

### Corrigé

- **Supervision : Jour et Semaine affichaient les mêmes chiffres.** La
  granularité ne pilotait que l'histogramme, jamais la période d'analyse : les
  deux modes interrogeaient la même fenêtre de 30 jours, et ◀ ▶ sautait d'un
  mois entier en mode Semaine. La sélection EST désormais la période — un jour,
  la semaine ISO, le mois calendaire — et ◀ ▶ avance d'une période (T-033).

### Interne

- `usage.stats` rend `coutPeriodeUsd` et `coutInconnuTours` (`docs/protocol.md`).
- La résolution « à quel projet appartient ce tour » sort de `usageStats.ts`
  dans `usageProjets.ts` : 869 → 662 lignes, sous sa dérogation de taille.
- Cliquet de taille : dérogation datée pour `src-tauri/src/sidecar.rs` (807
  lignes) afin que `npm run verif` cesse d'être rouge en permanence — le
  découpage réel reste dû (T-034). Gains verrouillés sur cinq autres fichiers.
- CI : un test neuf construisait un chemin en `/D:/…` et ne tombait que sur le
  runner Windows (T-037) ; l'étape de construction recopie désormais son échec
  en annotation, seule sortie lisible sans droits d'administration (T-038).
- **L'installeur Windows ne compilait plus** : `ModelPicker.tsx` et
  `modelPicker.ts` sont quatre fichiers sous Linux, deux sous Windows. Feuilles
  de logique renommées en `…Calc.ts`, et un garde-fou (`npm run casse`) refuse
  désormais toute collision de casse depuis n'importe quel système (T-039).
- **Le paquet livré n'embarquait pas la version testée.** Le manifeste du
  bundle reprenait des plages de versions et se réinstallait sans verrou : la
  0.3.1 Windows distribuée porte le CLI Claude 0.3.231 là où toute la chaîne a
  été validée en 0.3.214. Les versions sont désormais figées sur l'installé, et
  le journal d'empaquetage les annonce (T-042).
- **L'AppImage Linux ne se construisait plus** : linuxdeploy réécrit le CLI
  Claude avec `patchelf`, le casse, puis abandonne en lui reprochant de l'être.
  Le CLI voyage maintenant compressé dans le paquet (253 → 90 Mo) et se détend
  au premier lancement dans un dossier inscriptible (T-038).

## [0.3.0] — 2026-08-09

### Ajouté

- **Températures dans les indicateurs de l'en-tête** : processeur (lecture
  `/sys/class/hwmon`, puces `coretemp`/`k10temp`/`zenpower`, `acpitz` en
  dernier recours) et carte graphique (même requête `nvidia-smi` que les
  autres champs GPU). Une sonde mémoire existe mais reste muette faute de
  capteur sur la plupart des machines. Aucune dépendance ajoutée.
- **Version de l'application dans l'en-tête**, injectée à la compilation
  depuis le `package.json` racine — la même valeur que l'installeur.
- **Publication par pull request** (`npm run publier`) : l'instantané passe
  par un portique qui rejoue la chaîne complète sur deux machines vierges,
  Linux et Windows, avant toute fusion.
- **Analyse CodeQL** (TypeScript, Rust et les workflows) à chaque poussée et
  chaque semaine.
- **Miroir des tickets vers les issues GitHub** : `docs/tickets.md` reste la
  source de vérité, les issues en sont la vitrine.
- **Garde de cohérence des versions** (`npm run version:verifier`) : les cinq
  déclarations du dépôt doivent concorder, sous peine d'échec de `verif`.
- **Installeur Windows** : la mise à jour ne désinstalle plus par défaut
  (gabarit NSIS désormais possédé par le dépôt).

### Corrigé

- Le débord d'abonnement ignorait la fenêtre 7 jours et pouvait router vers un
  abonnement saturé (T-005).
- Un tour d'abonnement en attente affichait un curseur infini sans rien dire
  (T-006).
- Le « ne plus demander » des permissions fuyait d'un projet à l'autre.
- L'audit de publication ne voyait pas les fichiers non suivis par git (T-011).
- Le sidecar annonçait une version fausse ; elle est désormais lue, plus
  recopiée (T-016).
- Le fournisseur choisi dans le Chat retombait silencieusement sur Claude
  quand la table des fournisseurs était momentanément vide, sans jamais être
  rétabli (T-018).

### Observabilité

- Un tour qui échoue écrit désormais dans le journal applicatif : sous-type,
  session, modèle, et la pile en cas d'exception — jamais le corps de la
  réponse (T-015).
- **Plafond de silence au démarrage d'un tour** : sans le moindre message du
  moteur dans le délai imparti, le tour devient un échec daté au lieu d'une
  attente infinie.
- La coquille journalise la **mort** du sidecar — cause, signal, durée de vie,
  dernières lignes de sa sortie d'erreur — et distingue un premier démarrage
  d'une relance (T-017).

### Interne

- Étude de structure soldée : `AgentPage` 5 558 → 2 936 lignes, `claude.ts`
  1 826 → 1 497, registre de permissions par couche, `sidecar.rs` sorti des
  dérogations de taille.
- Couverture de l'interface portée de 64 à 239 tests — conséquence du
  découpage, pas d'un effort séparé.
