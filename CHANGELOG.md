# Journal des versions

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon [SemVer](https://semver.org/lang/fr/).

> Ce journal est tenu à la main, et c'est voulu : l'historique public est fait
> d'instantanés (un commit par publication, voir `docs/github.md`), donc des
> notes de version générées depuis les messages de commit ne diraient rien.
> Les entrées commencent à la 0.3.0 ; les versions antérieures ne sont pas
> reconstituées après coup.

## [0.6.0] — 2026-09-19

Une cinquantaine de tickets depuis la 0.5.0. Trois fils dominent : **on peut
désormais programmer une conversation**, **la voix marche vraiment**, et
**l'application cesse d'échouer en silence** sur une série de chemins où elle
le faisait encore.

### Ajouté

- **Une conversation peut se programmer.** Une session saturée s'arrêtait net
  et rien ne repartait avant qu'on revienne cliquer : le travail était prêt, la
  machine libre, et la fenêtre de 5 h se rouvrait à 3 h du matin pour personne.
  On arme un réveil — à une heure, ou « dès que le quota rouvre » —, il verse
  son message dans la file existante à l'échéance et le chemin nominal fait le
  reste. Un réveil est une promesse **datée** : déclenché ou abandonné, il est
  consommé et versé à l'historique, jamais ré-armé tout seul pour le lendemain.
  Valable **application ouverte** ; le poste éteint reste à faire (T-120).
- **La barre d'onglets se lit.** Sur onze conversations ouvertes, trois titres
  commençaient par les mêmes mots et la troncature emportait justement ce qui
  les distinguait. Le préfixe commun aux onglets voisins est maintenant replié
  en « … » et la place gagnée montre la suite ; l'onglet actif se voit enfin
  (texte franc et gras, coiffe cyan, et le droit d'afficher son nom en entier) ;
  chaque onglet porte son numéro, et **Alt+1…Alt+9** y va directement — Alt+9
  sur le dernier, comme dans un navigateur. Le titre stocké ne change pas :
  l'infobulle et la liste des sessions gardent le nom complet (T-122).
- **Les lignes discrètes du fil portent l'heure.** Recherche web, débordement,
  « historique compacté », état de la dictée : une ligne lue dix minutes après
  coup ne disait pas si elle datait du dernier tour ou de la veille, et ne
  pouvait se rapprocher ni du journal ni de la chronologie. L'heure est prise à
  la source de l'événement, pas au rendu — un re-rendu ne la fait pas dériver
  (T-101).
- **Un sous-agent donne signe de vie.** Un `Agent` pouvait occuper le tour
  38 minutes sans qu'une seule ligne apparaisse : rien ne distinguait un travail
  en cours d'un blocage. Une ligne discrète sous l'appel dit maintenant combien
  d'outils il a utilisés et lequel en dernier — un compteur, jamais le flot
  d'outils. Un message glissé pendant ce temps est annoncé comme tel plutôt que
  d'attendre sans explication (T-102).

### Modifié

- **Le mot-clé d'envoi vocal devient « banane ».** « transmets » ressortait de
  la transcription en « très prends ce mail », « transmettre », « je
  transmets » — quatre tentatives, zéro envoi. Un verbe se conjugue, appelle un
  pronom, et le modèle de langue le réécrit vers un mot plus probable. Un nom
  commun absurde en fin de consigne ne fait rien de tout ça. Répéter le mot-clé
  est sans risque : les occurrences sont toutes retirées du message envoyé
  (T-123, T-126).
- **La prise de son ne détruit plus les consonnes.** Le passage 48 → 16 kHz se
  faisait par interpolation linéaire, sans le moindre filtre : un 20 kHz
  arrivait intact dans la bande vocale, là où vivent les sifflantes et les
  fricatives — exactement les sons qui distinguent deux mots proches. Le modèle,
  privé de ces indices, complétait par sa statistique, d'où des phrases
  globalement justes aux mots-clés détruits (T-124).

### Corrigé

- **Le badge « session saturée » retombe tout seul.** Il restait affiché, avec
  « réinitialisation dans 0 », pendant que les tours s'enchaînaient normalement.
  Une saturation n'expire pas sur un événement mais sur le temps qui passe :
  sans re-rendu, l'heure n'était jamais relue et l'utilisateur se croyait
  bloqué alors que tout fonctionnait (T-117).
- **L'heure de reprise s'affiche de nouveau.** Le badge disait « reprise à heure
  inconnue » pendant que le fil portait « resets 6pm » deux lignes plus bas :
  quand la réinitialisation tombe pile sur l'heure, le message omet les minutes,
  que le lecteur exigeait. Deux chiffres absents dégradaient en silence le
  badge, le réveil « au reset » et la mise en sourdine de la sonde (T-130).
- **La sonde d'abonnement ne consomme plus double.** Deux fenêtres ouvertes
  faisaient deux fois les sondes — dont un vrai micro-tour Claude, c'est-à-dire
  que la mesure de la saturation consommait la ressource qu'elle mesure, sur un
  compte déjà saturé. La cadence des sondes coûteuses vit maintenant dans le
  sidecar, unique par construction : deux appels simultanés produisent un seul
  tour et une seule requête réseau (T-086).
- **Une erreur de connexion dit ce qu'elle est.** « API Error: Unable to
  connect to API » s'affichait brut, et la seule conclusion possible était
  « l'application ne marche pas ». Quatre familles sont désormais distinguées —
  abonnement saturé, HTTPS intercepté par un antivirus ou un proxy, API
  injoignable (réseau, VPN), compte non connecté — et chacune porte le geste qui
  lui correspond, un seul. Un message qu'on ne sait pas classer reste affiché
  tel quel : un conseil faux est pire qu'un conseil absent (T-118).
- **Un dossier cité dans le fil s'ouvre.** Il était déclaré « introuvable dans
  le projet » alors qu'il existait : la résolution ne sondait que des fichiers
  (T-119).
- **L'encart GPU ne s'évapore plus sans rien dire.** Quand `nvidia-smi` échoue,
  le groupe disparaissait et l'utilisateur n'avait aucun moyen, depuis
  l'application, de savoir si sa carte était morte, si le pilote avait bougé ou
  si c'était un défaut d'affichage. La cause est maintenant journalisée — une
  fois par cause, pas douze fois par minute — et l'en-tête garde une pastille
  qui la donne au survol. Les tentatives s'espacent au lieu de marteler (T-129).
- **L'application se construit de nouveau sur un poste neuf.** Une ressource
  déclarée dans la configuration Tauri n'était produite que par l'empaquetage :
  au premier nettoyage du répertoire de compilation, le projet devenait
  inconstructible en développement, sans qu'une ligne de code ait bougé (T-127).
- **La frappe n'est plus bridée.** La webview tournait en rendu logiciel imposé
  par une ligne du lanceur — le plafond que deux tickets successifs avaient
  approché sans pouvoir le franchir (T-095).
- **`search_chat` retrouve l'historique.** Il répondait « aucune conversation »
  avec 58 conversations sur le disque : le sidecar lisait un monolithe que
  l'interface avait cessé d'écrire (T-114).
- **Le RAG s'entretient seul.** Sa mise à jour dépendait d'un bouton que
  personne ne cliquait, faute de savoir quand ni pourquoi : trois index sur
  quatre dataient d'un mois (T-115).

### Observabilité

- **La chaîne voix écrit enfin au journal.** Elle n'y laissait pas une ligne :
  ni le segment transcrit, ni le verdict du mot-clé, ni l'issue de l'envoi. Un
  « ça n'envoie pas » se reconstituait à la main depuis le texte resté dans le
  composeur. Le module de décision rend maintenant la RAISON de son verdict —
  ce qui sépare « le mot-clé n'a pas été entendu » de « il a été entendu et j'ai
  refusé d'envoyer », les deux pannes qu'on ne pouvait pas distinguer (T-125).
- **Le journal redevient lisible.** Il était à 85 % d'erreurs, des jauges
  périodiques criant en boucle des états parfaitement nominaux ; une jauge
  tapait 1 371 fois en quatre heures sur un certificat sans jamais dire lequel
  (T-057, T-085).
- **L'application ne peut plus disparaître sans un mot.** C'était l'échec le
  plus muet du projet : plus une seule ligne au journal (T-112).
- **Les artefacts de développement cessent de crier.** Un rechargement à chaud
  bancal produisait une erreur de niveau maximal dans le fichier qu'on ouvre
  quand ça va mal. En version empaquetée, une erreur de la même famille reste au
  niveau le plus grave — c'est la condition qui rendait ce changement
  acceptable (T-116).

### Interne

- `npm run verif` ne tue plus la session de développement en cours (T-111), et
  le refus du port 1420 propose enfin un remède qui fonctionne (T-103).
- La barre hebdomadaire d'abonnement se cale sur le cycle réel plutôt que sur
  la semaine ISO, deux jours à côté (T-100).
- Le fuseau horaire des tests est figé : un test du réveil dépendait de celui
  de la machine sans le dire — vert sur un poste européen, rouge sur un runner
  en UTC, où la nuit du changement d'heure ne saute pas (T-133).
- Trois tests qui testaient l'OS sans l'annoncer sont corrigés : celui du
  fuseau ci-dessus ; celui qui exigeait un mode POSIX `0600` sur le coffre de
  secrets, que Windows ignore — l'exigence reste entière sur POSIX, mais la
  confidentialité du coffre y repose sur les ACL du profil, ce que rien ne
  disait (T-134) ; et un chemin de test fabriqué à la main, qui rendait
  « /D:/a/… » sous Windows (T-135).
- **`claude.sessionTitles` ne peut plus rester sans réponse.** Le module
  promettait « best effort, jamais bloquant » — c'était vrai des pannes, pas
  de la lenteur : l'attente du SDK n'avait aucune borne. Un enrichissement
  cosmétique du panneau Sessions pouvait donc rester en suspens pour toujours,
  sans que rien ne le dise. L'attente est bornée, le repli est le même, et le
  dépassement laisse une trace au journal (T-137).
- La CI dit désormais CE QUI a échoué : elle ne gardait que les 60 dernières
  lignes de la sortie des tests, c'est-à-dire le tableau récapitulatif, jamais
  le message d'erreur. Elle nomme le fichier fautif et remonte sa section
  (T-136).
- Plusieurs fichiers-dieux ont rendu des modules feuilles testables — décision
  temporelle du réveil, titres d'onglets, raccourcis, vocabulaire de journal de
  la voix, diagnostic d'erreur, sonde GPU — au lieu d'ouvrir des dérogations de
  taille.

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
  (T-097).
- **Les panneaux latéraux se replient**, chacun de son côté et indépendamment
  de l'autre : une poignée verticale entre le panneau et la zone de travail,
  et la préférence est retenue d'une session à l'autre. Replié, le panneau
  n'est plus rendu du tout ; la poignée, elle, reste toujours là — c'est le
  seul chemin de retour (T-084).

### Modifié

- **« Arrêter » passe au-dessus d'« Envoyer »** pendant un tour, au lieu d'être
  à côté : deux boutons empilés ne prennent qu'une largeur, et la place gagnée
  revient à la zone de saisie — la même règle que la colonne d'icônes du
  composeur.

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

- **L'état des conversations vit éclaté** : un fichier par projet, un fichier
  par conversation de Chat, au lieu de deux monolithes (12 Mo et 467 Ko)
  réécrits en entier à chaque sauvegarde. Migration automatique au premier
  chargement, les anciens fichiers sont conservés en sauvegarde. C'est le
  socle du travail sur deux projets en deux fenêtres (T-061, prépare T-062).

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
- **Une fenêtre qui s'ouvre trop tôt le dit.** En développement, la page
  pouvait être chargée pendant que vite se réchauffait : l'interface
  s'affichait, l'air saine, mais la greffe IPC n'était jamais établie — treize
  minutes sans un octet ni un message, réparées par un simple rechargement.
  Passé six secondes sans la moindre réponse de la coquille, un bandeau le dit
  et propose de recharger. Il ne recharge pas de lui-même : ce serait rendre la
  panne invisible une seconde fois (T-009).
- **Une fenêtre figée dit enfin pourquoi.** Quand le process de contenu de la
  webview meurt — quatre fois en six jours sur ce poste, sur un plantage du
  greffon PipeWire de GStreamer —, la fenêtre affichait sa dernière image pour
  toujours, sans une ligne de journal ni un mot à l'utilisateur. L'incident est
  désormais écrit dans les deux journaux SANS passer par l'interface (qui est
  précisément ce qui vient de mourir), et la fenêtre propose de recharger
  (T-030). Le plantage lui-même reste à traiter (T-056).
- **Coller une capture ne gèle plus le composeur.** La lecture du presse-papier
  était une commande synchrone : elle tenait le fil principal — donc
  l'affichage et le clavier — pendant toute la négociation avec le presse-papier
  et l'encodage PNG. Elle travaille maintenant à l'écart, et la vignette
  s'affiche sans attendre l'encodage base64 (T-048).
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
- Reconstruction Rust ~30 % plus rapide et binaire de debug trois fois plus
  léger (243 → 80 Mo) : le debuginfo n'est plus recopié dans le binaire à
  l'édition de liens. Le réglage vit dans `.cargo/config.toml` et non dans le
  lanceur de développement — sinon `npm run verif` reconstruirait tout à chaque
  alternance (T-029).
- La suite de tests n'écrit plus dans le vrai dossier de données du poste
  (T-051), et la chaîne `journal → sidecar` de l'interface s'importe sous Node
  sans installer l'IPC par effet de bord — un rejet non géré faisait échouer
  la vérification avec 390 tests verts (T-055).
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
