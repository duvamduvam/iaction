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

**Règle : tout dysfonctionnement CONSTATÉ produit un ticket.** Constat utilisateur, erreur
récurrente dans `logs/app.jsonl`, incident en cours de développement : ça se consigne ici,
avec la date et l'observation brute, même si la cause n'est pas comprise. Corrigé dans la
foulée ? Le ticket se crée quand même et se ferme aussitôt — le backlog est la mémoire des
pannes, pas seulement la liste du travail restant (voir T-005/T-006, constatés et clos le
même jour). Un dysfonctionnement sans ticket est un échec muet de plus, exactement ce que
la doctrine d'observabilité interdit.

Ce fichier est **reflété en issues GitHub** à chaque publication qui le touche
(`.github/workflows/tickets.yml`) : issue créée à l'ouverture, fermée à
l'archivage. Le fichier reste la seule source de vérité — une issue ouverte à
la main sur le dépôt public (retour de visiteur) se transcrit ici pour entrer
au backlog, jamais l'inverse (voir `docs/github.md` §5).

## Ouverts

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-114 | bug  | P1   | fait   | `search_chat` ne voit plus AUCUNE conversation depuis T-061 : le sidecar lit un monolithe que l'UI a renommé et que plus personne n'écrit |
| T-115 | bug  | P1   | fait   | Le RAG ne fonctionne pas en pratique : sa mise à jour dépend d'un bouton que l'utilisateur ne clique jamais, faute de savoir quand ni pourquoi — 3 index sur 4 datent d'un mois |
| T-118 | bug  | P1   | fait   | Windows : l'application ne peut pas joindre l'API Claude — « API Error: Unable to connect to API », app inutilisable sur ce poste |
| T-116 | tech | P3   | fait   | En session de développement, chaque rechargement HMR bancal finit en « rendu React interrompu : Can't find variable » au niveau `error` — ~80 occurrences en un mois, invisible en version empaquetée |
| T-102 | bug  | P1   | fait   | Un sous-agent (`Agent`) a tourné 38 min sans UN signe dans le fil ni le journal, le tour s'est clos en « arrêt demandé » sans que l'utilisateur le demande, et le modèle a ensuite affirmé que rien n'avait bloqué |
| T-101 | feat | P3   | fait   | Les actions discrètes du fil (recherche web, compaction, débordement, voix) ne disent pas À QUELLE HEURE elles ont eu lieu |
| T-100 | bug  | P3   | fait   | La barre hebdo d'abonnement reste calée sur la semaine ISO (lundi→dimanche), décalée de deux jours du cycle réel `resetsAt` (samedi 20:00) |
| T-103 | bug  | P2   | fait   | Le garde-fou du port 1420 propose un remède qui ne libère pas le port : Vite survit à l'arrêt de `tauri dev` |
| T-113 | bug  | P3   | ouvert | Le dernier bloc d'un tour en streaming est recopié dans un objet neuf à chaque rendu : son `memo` ne sert à rien, et son Markdown est reparsé même quand le texte n'a pas bougé |
| T-111 | bug  | P2   | fait   | `npm run verif` tue la session de développement en cours : la vérification et l'app se disputent le répertoire de compilation |
| T-112 | bug  | P1   | fait   | L'application peut disparaître sans laisser UNE SEULE ligne dans `app.jsonl` — l'échec le plus muet du projet |
| T-095 | bug  | P1   | fait   | La frappe traîne toujours (4ᵉ signalement) : la webview tourne en rendu logiciel imposé, et c'est le plafond que T-031 et T-083 ont approché sans pouvoir le franchir |
| T-086 | bug  | P1   | fait   | Depuis T-062, chaque fenêtre relance les jauges pour son compte : deux fenêtres = deux fois les sondes, dont un VRAI micro-tour Claude sur un abonnement saturé |
| T-085 | bug  | P2   | fait   | `usage.credits` échoue en boucle sur un certificat qui ne correspond pas — 1 371 lignes `error` en 4 h, et aucune ne dit quel hôte |
| T-057 | bug  | P2   | fait   | Le journal réel est à 85 % d'erreurs : les jauges périodiques crient en boucle des états nominaux |
| T-026 | feat | P3   | ouvert | Recherche web : sur une question d'actualité, le moteur rend des pages de rubrique, pas des articles |
| T-029 | tech | P2   | en cours | Démarrage long : aucun budget mesuré entre le lancement et la première image |
| T-056 | bug  | P2   | ouvert | Le process de contenu WebKit plante par intermittence (greffon PipeWire de GStreamer), 4 fois en 6 jours |
| T-048 | bug  | P2   | en cours | Coller une capture fige le composeur ~5 s : ni vignette, ni frappe prise en compte pendant la lecture du presse-papier |
| T-117 | bug  | P2   | fait   | Badge « Session 5h saturée » ne se réinitialise pas quand la fenêtre expire (compte à rebours ≤ 0) : affichage trompe l'utilisateur sur le statut réel |
| T-119 | bug  | P2   | fait   | Un DOSSIER cité dans le fil répond « introuvable dans le projet » alors qu'il existe : la résolution ne sonde que des fichiers, et la barre finale vide le nom cherché |
| T-120 | feat | P2   | fait   | Une conversation ne peut pas se programmer : session saturée, machine libre, heures creuses perdues faute de pouvoir dire « reprends à 3 h » |
| T-121 | feat | P2   | ouvert | Le réveil ne vaut que l'application ouverte : la reprise programmée devrait continuer « headless » sur le serveur, poste éteint |
| T-122 | feat | P2   | fait   | Onze onglets ouverts, aucun moyen de retrouver le bon : trois titres commencent par les mêmes mots et la troncature emporte justement ce qui les distingue |
| T-123 | bug  | P1   | fait   | Le mot-clé d'envoi vocal est inutilisable : « transmets » ressort de la transcription en « très prends ce mail », « transmettre », « je transmets » — quatre tentatives, zéro envoi |
| T-124 | bug  | P1   | fait   | Repliement spectral à la capture : le ré-échantillonnage 48→16 kHz n'a AUCUN filtre anti-repliement, un 20 kHz arrive intact dans la bande vocale et détruit les consonnes |
| T-125 | tech | P1   | fait   | Toute la chaîne voix est muette dans le journal : ni segment transcrit, ni verdict du mot-clé, ni issue d'envoi — un échec de dictée est indiagnosticable |
| T-126 | bug  | P1   | fait   | Le mot-clé d'envoi est bien ENTENDU mais mal orthographié (« Banana », « Benen ») : le matcher comparait des lettres, il compare désormais le squelette consonantique |
| T-127 | bug  | P1   | fait   | L'application ne compile plus dès que cargo rejoue le build script : `build/sidecar-bundle/`, ressource déclarée dans `tauri.conf.json`, n'existe qu'après un empaquetage — jamais en développement |
| T-128 | bug  | P1   | ouvert | La source du canal système est figée au démarrage et ne suit pas la sortie réelle. **La jauge de l'encart ment aussi** : l'application relance ses sondes sur la source figée, elle affiche −99 dB pendant que le fichier, lui, enregistre correctement |
| T-129 | bug  | P2   | fait   | L'encart GPU disparaît en silence : `nvidia-smi` échoue 12 fois/min sans journalisation |
| T-130 | bug  | P1   | fait   | « Reprise à heure inconnue » alors que le fil dit « resets 6pm » : le parseur du refus exige des minutes que le SDK omet sur une heure pleine |
| T-131 | bug  | P2   | ouvert | Un tour s'est clos en « arrêt demandé » sans que personne ne le demande (2026-08-29) : la cause n'a jamais été élucidée, et le journal de l'époque ne portait pas encore le champ qui l'aurait nommée |
| T-132 | doc  | P3   | fait   | Les notes de version de la 0.5.0 renvoyaient à des tickets qui ne sont pas les siens — trois références fausses dans un document public, mis en miroir en issues GitHub |
| T-133 | bug  | P1   | fait   | Un test du réveil dépendait du fuseau de la machine sans le dire : vert sur ce poste (Europe/Paris), rouge sur les runners (UTC) — les DEUX constructions de la 0.6.0 sont tombées dessus |
| T-134 | bug  | P1   | fait   | Un test exige le mode POSIX 0600 sur le coffre de secrets : Windows ignore les modes et rend 666, la construction NSIS tombait — et au passage, sur Windows le coffre n'a AUCUNE protection par mode |
| T-135 | bug  | P1   | fait   | `new URL(import.meta.url).pathname` rend « /D:/a/… » sous Windows : la doublure d'un test n'était jamais trouvée, troisième échec d'affilée de la construction NSIS |
| T-136 | tech | P1   | fait   | La CI ne savait pas dire ce qui avait cassé : « échec sans ligne reconnaissable », parce qu'elle ne garde que 60 lignes — celles du tableau récapitulatif, jamais celles du message |
| T-137 | bug  | P1   | fait   | `claude.sessionTitles` promet « jamais bloquant » mais attend `listSessions` sans aucune borne : une LENTEUR (et non une panne) laisse la requête sans réponse pour toujours |
| T-138 | bug  | P1   | fait   | Un test Rust affirmait que le processus courant est vivant — or hors Linux la détection répond « mort » PAR CONCEPTION : le test contredisait le code qu'il gardait |

### T-138 — Un test qui contredit la conception qu'il garde

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-19 · **Clos** 2026-09-19

Cinquième passage du portique de la 0.6.0. Les tests du sidecar passent enfin sous Windows ;
l'échec se déplace côté **Rust** :

```
session_vie::tests::le_processus_courant_est_vivant --- FAILED
```

**Ce n'est pas une panne, c'est une contradiction.** `processus_vivant()` interroge `/proc/<pid>`
sous Linux et, ailleurs, **répond « mort » par conception** — sa documentation le dit :
« le pire cas est une ligne de journal en trop, jamais une ligne manquante ». Le test, lui,
affirmait que le processus courant est vivant. Sur Windows, il demandait donc au code de faire
l'inverse de ce que la conception prescrit.

**Corrigé le 2026-09-19** — le test est restreint à Linux (`#[cfg(target_os = "linux")]`), même
traitement que `mem_totale_plausible` (`system_probe.rs`), qui porte déjà une note sur le runner
Windows. Et **un test symétrique le remplace hors Linux** : le verdict « mort » y est ATTENDU.
Restreindre sans rien mettre à la place aurait laissé la dégradation invérifiable — et le jour
où quelqu'un portera la détection sous Windows, c'est ce test-là qui lui dira qu'il a réussi.

**Ce que ça révèle sur la fonctionnalité, et qui mérite d'être su** : le garde-fou de T-112 — « la
session précédente s'est arrêtée sans laisser de trace » — est **aveugle sous Windows**. La
détection n'y distingue pas une session encore vivante d'une session morte : elle dit toujours
« morte ». Le cas nominal reste correct (une sortie propre efface son propre témoin, donc rien
n'est signalé), mais une seconde instance réellement en cours serait déclarée morte. Le poste
Windows est précisément celui dont on a le moins de retours (T-118). À instruire si le besoin
s'en fait sentir — `OpenProcess`/`GetExitCodeProcess` est la réponse naturelle, au prix d'une
dépendance Windows.

**Vérifié au passage, parce qu'une extraction est l'occasion typique de le perdre** : la parade de
T-096 (la sonde GPU qui faisait clignoter une console sous Windows) a bien survécu au découpage
de `system_probe.rs` vers `gpu_probe.rs` — `hide_console_window` y est toujours appelé avant le
lancement de `nvidia-smi`.

**Cinquième de la série**, et la plus révélatrice : T-133 (fuseau), T-134 (mode POSIX),
T-135 (forme des chemins), T-137 (délai), T-138 (conception multiplateforme). Cinq passages de
CI pour une release. Aucun n'est une régression du produit : ce sont cinq présupposés sur
l'environnement, accumulés en trois semaines de développement sur un seul poste, et révélés d'un
coup par les deux premières machines différentes qui ont exécuté ce code.

### T-137 — « Jamais bloquant » ne valait que pour les pannes, pas pour la lenteur

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-19 · **Clos** 2026-09-19

Constaté le 2026-09-19, quatrième passage du portique de la 0.6.0 — et **premier échec que
l'annotation a su nommer toute seule**, grâce à T-136 corrigé au tour précédent :

```
━━━ claudeCommandesEtTitres.test.js ━━━
✗ claude.commands / claude.sessionTitles — timeout en attendant
  claude.sessionTitles st2 (cwd sans session connue)
```

**Cause, et elle est dans le code de production, pas dans le test.**
`handleClaudeSessionTitles` fait `await sdk.listSessions({ dir: cwd })` **sans aucune borne**,
sous un `try/catch` global. Le module annonce pourtant, en toutes lettres dans son en-tête et
dans `docs/protocol.md`, qu'il est « best effort » et « ne lève jamais ». C'était vrai pour les
EXCEPTIONS — SDK absent, `cwd` inconnu, aucune session — et faux pour la **lenteur** : une
réponse qui tarde laissait la requête sans réponse **indéfiniment**.

Sur les runners Windows, `st2` est le premier appel qui importe réellement le SDK ; entre
l'import dynamique et le balayage du dossier de sessions, les 5 s du test sont dépassées. `st1`
passait parce qu'il court-circuite avant l'import.

**Ce que ça aurait donné dans l'application** — et c'est pour ça que c'est P1 et pas un
ajustement de test : l'enrichissement des titres du panneau Sessions serait resté en suspens,
sans réponse, **sans que rien ne le dise**. Facultatif, donc invisible ; invisible, donc jamais
signalé. Exactement la famille d'échec muet que T-057, T-112 et T-125 documentent.

**Corrigé le 2026-09-19** — l'attente est bornée à **8 s**, au-delà desquelles la réponse est le
même `{titles: []}`. Le repli reste silencieux pour l'utilisateur, mais **plus pour le journal** :
le dépassement écrit une ligne `warn` avec le `cwd` et le délai. Sans elle, on ne pourrait pas
distinguer « ce projet n'a pas de titres » de « le SDK n'a jamais répondu » — deux situations qui
s'affichent pareil.

**Le test PROUVE la borne au lieu de l'espérer.** `IACTION_SESSION_TITLES_TIMEOUT_MS` la ramène à
1 ms : le SDK ne peut pas répondre plus vite, donc c'est le repli qui est exercé, à coup sûr et
en quelques millisecondes (`sessionTitlesBorne.test.js`). Un test qui se contenterait d'attendre
une lenteur réelle ne prouverait rien et serait lent. Les budgets de `st2`/`st3` sont portés
au-delà de la borne de production, pour qu'un dépassement reste distinguable d'un blocage.

**Ce qu'on ne sait toujours pas, et qu'il faut assumer** : POURQUOI `listSessions` dépasse
plusieurs secondes sur Windows. La borne rend le contrat vrai quelle qu'en soit la raison, et la
ligne de journal rendra la lenteur visible si elle se produit chez un utilisateur — mais elle ne
l'explique pas. C'est un choix : rendre la promesse honnête d'abord, comprendre ensuite, avec
une trace pour le faire.

**Quatrième de la série** (T-133 fuseau, T-134 mode POSIX, T-135 forme des chemins, T-137 délai).
Les trois premiers étaient des tests qui présumaient de leur environnement ; celui-ci est
différent et plus grave — c'est le CODE qui présumait que « rapide » allait de soi.

### T-136 — La CI dit qu'elle a échoué, pas ce qui a échoué

**Type** tech · **Prio** P1 · **Statut** fait · **Créé** 2026-09-19 · **Clos** 2026-09-19

Constaté le 2026-09-19, troisième passage du portique de la 0.6.0. L'annotation remontée par
`version.yml` disait, en tout et pour tout :

```
échec sans ligne reconnaissable
```

Deux défauts se cumulaient dans la même étape :

1. **Le résumé cherchait les mauvais motifs.** `grep -aE "ECHEC|AssertionError|Error:"` sur la
   sortie entière ; le rapport du lanceur nomme pourtant les fichiers fautifs sous la forme
   `KO(n)  fichier.test.js`, motif que rien ne cherchait.
2. **Le repli affichait les 60 DERNIÈRES lignes** — or ces 60 lignes sont exactement le tableau
   récapitulatif des 51 fichiers, qui s'achève par « 1 en échec ». Le message d'échec, lui, vit
   dans la section du fichier concerné, des centaines de lignes plus haut. Le repli ne pouvait
   structurellement pas montrer la cause.

**Ce que ça a coûté** : un aller-retour complet de CI (~8 min) pour apprendre le nom du fichier
fautif, puis un second pour la cause — sur une release qui en a déjà demandé trois. Et sans les
droits sur les journaux de run, l'information était simplement inaccessible : c'est
précisément le scénario que la doctrine « les échecs voyagent par annotations »
(`docs/github.md` §2) existe pour éviter. L'annotation était là, elle ne disait rien.

**Corrigé le 2026-09-19** — l'étape nomme désormais le ou les fichiers fautifs (`KO(n)`), remonte
**leur section** (40 lignes à partir de l'en-tête du fichier) plutôt qu'une queue arbitraire, et
garde un repli large si le format du rapport changeait un jour. Le titre de l'annotation porte le
nom du fichier, le corps porte la ligne `ECHEC:` elle-même.

**Vérifié sur un échec RÉEL**, pas sur une lecture : un test témoin volontairement cassé a été
ajouté puis retiré, et la logique d'extraction rejouée sur sa sortie rend bien
`zzTemoinEchec.test.js` en titre et « ECHEC: témoin : ceci doit apparaître dans l'annotation »
en corps. Une remontée d'erreur qu'on n'a jamais vue fonctionner sur une vraie erreur n'est
qu'une intention.

**Ce qui reste** : les deux autres étapes (`cargo`, construction) remontent encore une queue
brute (`tail -30`, `tail -40`). C'est moins grave — leurs sorties finissent par l'erreur, là où
le lanceur du sidecar finit par un tableau — mais le jour où l'une d'elles mentira, ce sera pour
la même raison. À reprendre sur constat.

### T-135 — « /D:/a/… » : un chemin Windows fabriqué à la main

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-19 · **Clos** 2026-09-19

Troisième échec d'affilée de la construction NSIS de la 0.6.0, après T-133 (le fuseau) et
T-134 (le mode du coffre). Même famille, troisième variante :

```js
path.join(path.dirname(new URL(import.meta.url).pathname), "fakeClaudeCommands.mjs")
```

`URL.pathname` rend, sous Windows, `/D:/a/iaction/iaction/sidecar/test` — **une barre oblique en
tête**, une lettre de lecteur, des séparateurs POSIX. `path.join` en tire un chemin qui n'existe
pas ; la doublure du CLI n'était jamais trouvée, et `claudeCommandesEtTitres.test.js` échouait.
Sur Linux les deux formes coïncident exactement, d'où un test vert ici depuis toujours.

Signature à retenir : le test mettait **5,2 s** sur le runner contre **0,6 s** une fois corrigé —
il s'épuisait à attendre un processus qui ne pouvait pas démarrer. Une durée anormale est un
indice de chemin invalide.

**Corrigé le 2026-09-19** par `fileURLToPath(import.meta.url)`, l'outil prévu pour cette
conversion, que le reste de la suite utilise déjà (`harness.mjs`). Le motif fautif a été cherché
dans tout le dépôt : **une seule occurrence**, celle-ci.

**Trois pour trois.** T-133, T-134 et T-135 sont le même défaut sous trois habits : un test qui
présume de son environnement — fuseau, système de fichiers, forme des chemins — sans l'écrire.
Tous trois ont été ajoutés APRÈS la dernière release, donc n'avaient jamais tourné ailleurs que
sur ce poste. La leçon n'est pas « mieux relire » : c'est qu'un test multiplateforme ne se vérifie
que sur plusieurs plateformes, et que le portique de PR est le seul endroit où ça arrive. Il a
fait son travail trois fois.

### T-134 — Le coffre de secrets, le mode 0600, et Windows qui n'en a rien à faire

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-19 · **Clos** 2026-09-19

Constaté le 2026-09-19, deuxième passage du portique de la **0.6.0** : l'AppImage passe
désormais, l'installeur NSIS tombe, sur une seule ligne :

```
ECHEC: set1 : le coffre doit être en mode 0600, reçu 666
```

**Cause.** `mcpCatalogueEtSecrets.test.js` vérifie que `mcp-secrets.json` est écrit en 0600.
Windows n'applique pas les modes POSIX : `fs.stat().mode` y rend 666 quoi qu'on demande. Le test
a été écrit le **2026-08-29** (T-058), c'est-à-dire APRÈS la dernière release — il n'avait donc
jamais tourné sur un runner Windows. Sa première exécution est celle qui a cassé la
construction.

**Le code de production, lui, savait déjà** : `writeSecrets` (`mcpSecrets.ts`) fait
`fsp.chmod(tmp, 0o600).catch(() => {})` — le `.catch()` est là exprès pour Windows. C'est le
test qui était aveugle à la plateforme, pas le code.

**Corrigé le 2026-09-19** — l'exigence reste **entière** sur POSIX ; sur Windows le test vérifie
l'existence du fichier et DIT que le mode est sans objet, plutôt que de sauter en silence. Un
test qui s'esquive sans le dire est un test qu'on croit avoir.

**Ce que ce ticket met au jour, et qui vaut plus que le correctif** : sur Windows, le coffre de
secrets MCP — qui porte des jetons d'API — **n'a aucune protection par mode**. Sa confidentialité
y repose entièrement sur les ACL du profil utilisateur (`%APPDATA%`), c'est-à-dire sur le fait
qu'un autre compte de la machine n'y accède pas par défaut. C'est probablement suffisant sur un
poste personnel ; ça ne l'est pas forcément sur un poste d'entreprise partagé ou administré. Le
commentaire du code (« le fichier ne doit jamais être lisible par le groupe, même une fraction de
seconde ») décrit donc une garantie qui **n'existe pas sur Windows**, et rien ne le disait.

À instruire séparément si le besoin se présente : soit poser une ACL explicite sur Windows, soit
écrire noir sur blanc dans la documentation que la protection du coffre est dépendante de la
plateforme. Le pire des trois états — croire la garantie acquise partout — est au moins levé.

**Leçon commune avec T-133, constatée le même jour** : deux tests ajoutés après la dernière
release ont cassé la première construction qui les exécutait sur une autre machine. Ils testaient
l'OS sans l'annoncer — un fuseau, puis un système de fichiers. La chaîne locale ne peut pas voir
cette classe de défaut ; seul le portique multi-plateforme le peut, ce qui est exactement sa
raison d'être (`docs/github.md` §1, T-011).

### T-133 — Un test vert ici, rouge sur les runners : le fuseau n'était écrit nulle part

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-19 · **Clos** 2026-09-19

Constaté le 2026-09-19 à la publication de la **0.6.0** : `npm run verif` venait de passer en
entier sur ce poste, application fermée, code de sortie 0 — et les **deux** constructions de la
pull request ont échoué, Linux comme Windows, sur la même ligne :

```
ui/src/reveil.test.ts:140
AssertionError: expected 84600000 to be 81000000
```

L'écart vaut **exactement 3 600 000 ms — une heure**.

**Cause.** Le test vérifie qu'une heure de mur est préservée au passage à l'heure d'été : le
28 mars 2026 à 23:30, la prochaine occurrence de 23:00 tombe 22 h 30 plus tard et non 23 h 30,
parce qu'une heure saute cette nuit-là. C'est vrai **en Europe**. Les runners GitHub tournent en
**UTC**, où aucune nuit ne saute : l'écart y vaut 23 h 30, et l'assertion tombe. Rien dans le
test n'annonçait cette dépendance — il lisait le fuseau de la machine par `new Date(...)` sans
jamais le nommer.

**Pourquoi la chaîne locale ne pouvait PAS l'attraper.** Ce poste est en Europe/Paris. Le test y
est vert par coïncidence géographique. Aucune quantité de `npm run verif` local ne l'aurait
révélé — c'est précisément le rôle que `docs/github.md` assigne à la PR (« le poste local peut
mentir par omission », T-011), et le portique a fait son travail. À noter pour la suite : ce
n'est pas un oubli de vérification, c'est une classe de défaut que seule une machine différente
peut voir.

**Corrigé le 2026-09-19** — le fuseau des tests est **figé** à `Europe/Paris`
(`ui/vite.config.ts`, `test.env.TZ`). Le choix n'est pas arbitraire et mérite d'être justifié :
figer à **UTC** aurait aussi rendu la suite reproductible, mais la transition que ce test exerce
n'existe pas en UTC — il aurait alors passé **sans plus rien vérifier**, ce qui est pire qu'un
échec. On fige donc au fuseau où les bascules ont lieu.

Et pour que le réglage ne puisse pas sauter en silence, le test porte désormais **sa propre
garde** : une assertion vérifie que le décalage de janvier diffère de celui de juillet. Si un
jour la suite retombait sous UTC, elle le dirait au lieu de devenir vacante.

Vérifié en rejouant toute la chaîne avec `TZ=UTC` dans l'environnement — le réglage de la
configuration l'emporte, 797 tests au vert, ce qui reproduit la condition exacte du runner.

**Le code de production ne présume d'aucun fuseau** : il lit toujours celui du poste. Ce ticket
ne concerne que la reproductibilité des tests.

### T-132 — Les notes de version renvoient à des tickets qui ne sont pas les leurs

**Type** doc · **Prio** P3 · **Statut** fait · **Créé** 2026-09-19 · **Clos** 2026-09-19

Constaté le 2026-09-19 en préparant la 0.6.0, en relisant le gabarit de l'entrée précédente.
L'entrée **[0.5.0]** du `CHANGELOG.md` portait trois références, toutes fausses :

| Ce que décrit l'entrée | Ticket cité | Ce qu'est réellement ce ticket |
|---|---|---|
| « L'application dit qu'une version existe » | T-056 | le process WebKit qui plante (PipeWire) |
| « Les panneaux latéraux se replient » | T-057 | le journal à 85 % d'erreurs |
| « Arrêter passe au-dessus d'Envoyer » | T-057 | idem |

Les bons numéros sont **T-097** et **T-084** ; le troisième changement ne correspond à aucun
ticket retrouvable, ni par titre ni par corps.

**Pourquoi ce n'est pas cosmétique.** `CHANGELOG.md` est publié, et `docs/tickets.md` est mis en
miroir en issues GitHub (`.github/workflows/tickets.yml`) : une note de version qui renvoie au
mauvais ticket envoie un lecteur — utilisateur, contributeur, ou nous-mêmes dans six mois — lire
un dossier sans rapport, et lui fait croire qu'il n'a pas compris. C'est le même défaut que
T-103 sur un autre support : un pointeur faux coûte plus cher qu'un pointeur absent, parce qu'on
le suit.

**Corrigé le 2026-09-19** : T-056 → T-097, T-084 pour les panneaux, et la troisième référence
est **retirée** plutôt que devinée. Écrire un numéro dont on n'est pas sûr, c'est refaire
exactement le défaut qu'on corrige.

**Angle mort qui reste, et c'est le vrai enseignement** : rien ne vérifie ces références. Le
projet a un test de miroir des tickets (`refleter-tickets.test.mjs`) et un audit de publication,
mais aucun ne relit le `CHANGELOG`. Un contrôle serait pourtant trivial — tout `T-NNN` cité dans
`CHANGELOG.md` doit exister en section de `docs/tickets.md` — et il aurait attrapé ces trois-là
à la publication de la 0.5.0. À instruire quand le besoin se représentera ; consigné ici pour
qu'il ne se reperde pas.

### T-131 — « Arrêt demandé » que personne n'a demandé : la cause reste à prendre sur le fait

**Type** bug · **Prio** P2 · **Statut** ouvert · **Créé** 2026-09-19

Détaché de **T-102** le 2026-09-19, dont c'était le dernier volet. T-102 portait quatre
questions ; trois demandaient du travail et sont faites. Celle-ci n'en demande pas : elle
attend une récidive. Les tenir ensemble aurait laissé un ticket « ouvert » sur lequel il n'y
avait plus rien à faire.

**Le fait.** Le 2026-08-29 à 16:20:18, un tour s'est clos sur « tour Claude interrompu …
cause: interrompu: arrêt demandé » (`error_during_execution`), après 38 minutes de sous-agent.
**L'utilisateur dit avoir attendu, pas arrêté.** À l'époque, `handleClaudeAbort` ne journalisait
rien : impossible de savoir si le bouton « Arrêter » avait été pressé, ou si l'indicateur
d'abandon avait été posé par un autre chemin.

**Pourquoi la question ne peut pas se trancher rétrospectivement.** T-102 a ajouté depuis une
ligne `info` à chaque `claude.abort`, avec son demandeur (`orchestration` — timeout de run,
`orch.abort` — ou `protocole` — appel direct). Ce champ n'existait pas le 2026-08-29. Le journal
de l'incident ne peut donc pas dire lequel des deux chemins a tiré. Aucune quantité d'analyse ne
créera une donnée qui n'a pas été écrite.

**Ce qui a été cherché, et n'a rien donné** (lecture de code du 2026-09-19, rien modifié) :

- `handleAbort` (`AgentPage.tsx` ~1787, `ChatPage.tsx` ~1783) sont les seuls appelants client de
  `claudeAbort`/`neutralAbort`, et tous deux sont exclusivement câblés sur un `onClick`. Aucun
  raccourci clavier, aucun minuteur, aucun effet de démontage ne les invoque ;
- aucun `AbortController` partagé dans `claude.ts` : `query.interrupt()` passe toujours par
  `run.query`, scopé par `RunState`, unique par `targetId` ;
- **le seul chemin non-clic trouvé** : `orchestrator.ts` ~1156 appelle `handleClaudeAbort`
  directement en interne (timeout de run, `orch.abort`). C'est le suspect qui reste, et c'est
  exactement celui que le champ `demandeur` nomme désormais.

**Relevé annexe, à traiter à part si ça gêne** : `identifiantFenetre`
(`ui/src/sidecar.ts` ~104) est un `Math.random().toString(36).slice(2, 8)` régénéré à chaque
chargement du module, et non dérivé du label de fenêtre Tauri. La collision est négligeable,
mais ce préfixe ne permet pas de recorréler un `reqId` du journal à une fenêtre physique
identifiable — ce qui a manqué précisément pendant l'enquête T-086.

**Ce que ce ticket attend** : la prochaine occurrence. Elle portera cette fois `demandeur`, et
la question se réglera en une ligne de journal. S'il n'y en a pas d'ici plusieurs mois d'usage,
ce ticket se ferme sur ce constat — un incident unique, non reproduit, désormais instrumenté.

### T-130 — « Reprise à heure inconnue » alors que le fil affiche l'heure

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-18 · **Clos** 2026-09-18

Constat utilisateur du 2026-09-18, capture à l'appui : « l'heure de reprise de sessions a
disparu ». Le badge d'en-tête affiche **« Session saturé, reprise à heure inconnue »** pendant
que le fil, quelques lignes plus bas, porte le message du refus en toutes lettres :

    You've hit your session limit · resets 6pm (Europe/Paris)

L'information était donc là, reçue et affichée à l'écran — c'est l'application qui n'a pas su
la lire.

**Cause.** `RE_HEURE_FUSEAU` (`sidecar/src/claudeSaturation.ts`, T-059) exigeait les minutes :
`/resets\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i`. Or **le SDK les omet quand la
réinitialisation tombe pile sur l'heure** : il écrit « resets 6pm », pas « resets 6:00pm ». Le
motif ne matchait pas, `extraireResetsAt` rendait `null`, et `libelleSaturation` tombait sur sa
branche d'aveu — « reprise à heure inconnue ».

Le format daté avait exactement la même faille (« resets Oct 9, 7pm »).

**Ce qui rend ce défaut coûteux, au-delà du libellé** : `resetsAt` à `null` n'est pas seulement
une heure manquante à l'écran, c'est la valeur dont dépendent trois mécanismes.

1. La péremption du badge (T-117) traite `null` comme un aveu d'ignorance et garde donc l'état
   saturé **indéfiniment** — le badge ne peut plus retomber tout seul, ce que T-117 venait
   précisément de corriger.
2. Le réveil « reprends dès que le quota rouvre » (T-120, point 5) n'a plus d'instant à viser.
3. Le silence commandé à la sonde retombe sur son défaut de 30 min au lieu de viser la
   réouverture réelle.

Un seul groupe de deux chiffres absent, et trois fonctionnalités se dégradent en silence.

**Corrigé le 2026-09-18** — les minutes deviennent optionnelles dans les deux motifs
(`(?::(\d{2}))?`), et leur absence se lit « heure pleine » (`Number(mm ?? 0)`), jamais `NaN`.
Deux tests ajoutés (`sidecar/test/claudeSaturation.test.js`), écrits AVANT le correctif et
vérifiés en échec contre l'ancien motif : « resets 6pm (Europe/Paris) » doit rendre 18:00 heure
de Paris, « resets Oct 9, 7pm » le 9 octobre à 19:00 locale. 45 fichiers de la suite sidecar au
vert.

**Leçon, et elle vaut au-delà de ce motif** : le format n'a pas changé, c'est notre échantillon
qui était partiel. T-059 a été écrit sur un message réel — « resets 7:10pm » — et le motif a été
taillé à sa mesure, minutes comprises, sans se demander ce qui se passerait sur une heure ronde.
Une expression régulière calquée sur un seul exemple observé est une hypothèse déguisée en
certitude. Le symptôme est resté invisible tant que les réinitialisations tombaient à 7:10 ou
12:40 ; il est apparu le jour où l'une d'elles est tombée à 18:00 pile.

**À surveiller** : le même raisonnement s'applique au reste du message. Rien ne garantit
aujourd'hui que « resets » soit toujours suivi d'un format connu — le repli (`resetsAt` à `null`,
fenêtre reconnue quand même) est correct, mais il est MUET : aucune ligne de journal ne dit
qu'un message de refus a été reconnu sans qu'on sache le dater. C'est le trou par lequel ce
défaut a vécu depuis T-059. À instruire.

Fichiers : [claudeSaturation.ts](../sidecar/src/claudeSaturation.ts) · [claudeSaturation.test.js](../sidecar/test/claudeSaturation.test.js)

### T-123 — Le mot-clé d'envoi vocal ne part jamais : on a choisi un verbe

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-06 · **Clos** 2026-09-06

Constaté le 2026-09-06, signalé « je galère à envoyer ». Relevé MOT POUR MOT dans le
brouillon du composeur et dans l'historique de conversation, sur quatre tentatives
successives du même mot prononcé :

- « …fais des réponses très courtes, **très Prends ce mail. Prons-moi.** »
- « **Je remets transmettre, transmettre**, j'aimerais transmettre. **Prends-moi.** »
- « **Je transmets, je transmets, je transmet** »
- « fais des réponses beaucoup plus courtes, **transmettre**. qu'on se met. »

Aucun envoi. Trois causes, toutes issues d'un seul choix de conception : **le mot-clé était
un verbe** (`transmets`, précédé de `envoie`, déjà abandonné pour les mêmes raisons).

1. Un verbe se conjugue, et le modèle de transcription choisit la forme au hasard du
   contexte : `transmettre`, `transmet`, `je remets`.
2. Un verbe appelle un pronom, que le modèle ajoute de lui-même (« Je transmets »). Le
   garde-fou grammatical de `sendKeyword.ts` bloquait alors l'envoi — précisément celui que
   l'utilisateur venait de demander. Le faux blocage était documenté comme « rare » : il
   était en réalité systématique.
3. Le modèle de langue réécrit un mot peu probable vers un mot plus probable dans la
   phrase : `transmets` → `très prends`.

**Corrigé** — le défaut devient **« banane »**. Un nom commun ne se conjugue pas, n'appelle
aucun pronom, et son absurdité en fin de consigne garantit qu'il n'apparaîtra jamais par
accident dans un vrai prompt ; ses trois syllabes aux voyelles nettes n'ont aucun voisin
phonétique. Le module a été durci en même temps : les répétitions du mot-clé (réflexe de
l'utilisateur qui n'est pas entendu) sont TOUTES retirées du corps, et le garde-fou
pronom/déterminant ne s'applique plus qu'au fil d'une phrase — « Je transmets. » lancé seul
ou après une phrase close envoie désormais. La famille « envoie », trop proche du français
courant, garde son garde-fou strict. 19 tests dans `ui/src/sendKeyword.test.ts`.

### T-124 — Repliement spectral à la capture : le ré-échantillonnage ne filtrait rien

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-06 · **Clos** 2026-09-06

Constaté le 2026-09-06 en cherchant pourquoi la transcription rendait des mots mutilés
(T-123). Le micro capture au taux natif (48 kHz) et la chaîne ramène à 16 kHz pour Whisper,
par **interpolation linéaire** — commentée à l'époque « suffit amplement pour de la parole ».
C'est faux pour une décimation : diviser la bande par trois exige de supprimer tout ce qui
dépasse 8 kHz AVANT de jeter deux échantillons sur trois, sinon ces fréquences se replient
dans la bande utile.

Mesuré sur sinusoïdes pures, ancienne chaîne, RMS en sortie (amplitude d'entrée 1) :

| Entrée | 1 kHz | 4 kHz | 6 kHz | 12 kHz | 15 kHz | 20 kHz |
|--------|-------|-------|-------|--------|--------|--------|
| RMS    | 0,707 | 0,707 | 0,707 | 0,707  | 0,707  | 0,707  |

Atténuation nulle sur TOUTE la bande : un 20 kHz arrivait intact dans le flux 16 kHz. Or
c'est au-dessus de 8 kHz que vivent les fricatives et les sifflantes — [s], [ʃ], [f], [t] —
donc exactement les consonnes qui distinguent deux mots proches. Elles étaient remplacées
par du bruit large bande, et le modèle, privé de ces indices, complétait par sa statistique.
Cela explique la signature du symptôme : des phrases globalement justes (les voyelles
passaient) mais des mots-clés détruits, et une pluie d'hallucinations sur les silences.

**Corrigé** — `resampleLinear` devient `resamplePcm` : sinc fenêtré par une Hann (12 lobes),
qui fait le passe-bas et l'interpolation d'un seul noyau, coefficients normalisés à chaque
échantillon pour un gain unitaire jusqu'aux bords. Après correction : 1 kHz conservé à
0,707, 12 kHz et 15 kHz sous 0,02. Le coût CPU est négligeable devant l'appel réseau de
transcription qui suit. Tests dans `ui/src/audioCapture.test.ts`. Au passage, les politesses
et hésitations produites sur du blanc (« Merci. », « Mmm. ») rejoignent la liste
d'hallucinations de `transcriptFilter.ts`, où elles manquaient.

### T-126 — Le mot-clé est bien entendu, mais jamais deux fois écrit pareil

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-06 · **Clos** 2026-09-06

Constaté le 2026-09-06, juste après T-123 : le mot-clé passé au nom commun « banane » est
correctement reconnu à l'oreille, et l'envoi ne part toujours pas. Relevé dans le composeur,
sur un mot prononcé clairement à chaque fois :

- « … Bye, non. **Banane.** Prends ce mail. transmettre » — bonne graphie, mais suivie
  d'échos qui repoussent le mot-clé loin de la fin du segment ;
- « … mes ressorts psychologiques de tout ça. **Benen.** » — voyelles remplacées ;
- « … je ne vois pas bien **Banana. Banana.** » — orthographe **anglaise**.

Trois graphies pour un seul mot. Les consonnes, elles, sont identiques dans les trois cas :
c'est cohérent avec ce qu'est un modèle acoustique — les consonnes sont des événements brefs
et marqués, les voyelles un continuum que le modèle de langue rhabille selon ce qu'il croit
lire. Le matcher, lui, comparait des chaînes de caractères : il ratait deux fois sur trois.

**Corrigé** — à défaut d'égalité exacte (tolérance du « s » final incluse), `genericCut`
compare le **squelette consonantique** du dernier mot à celui du mot-clé, à longueur voisine
(± 2 lettres) : voyelles, « h », « s » final et consonnes doublées retirés. « banane »,
« banana », « benen », « bananne » se ramènent tous à « bn ». Cas limite assumé et documenté :
un mot du texte au même squelette et à la même longueur déclenche l'envoi (« bonne ») — c'est
la philosophie du module, un envoi un peu tôt coûte moins cher qu'un utilisateur qui répète
dans le vide. Tests dans `ui/src/sendKeyword.test.ts`.

**Reste à faire** (ne touche pas l'UI, demande une recompilation du sidecar donc une app
arrêtée — cf. T-111) : la requête de transcription n'envoie que `file`, `model` et
`language`. Le paramètre `prompt` de l'API, qui biaise le vocabulaire et l'orthographe du
modèle, n'est pas utilisé. Y placer le mot-clé configuré stabiliserait sa graphie à la
source, au lieu de la rattraper après coup. Les « échos » (« Prends ce mail. transmettre »
réapparus longtemps après avoir été prononcés) restent inexpliqués et ne pourront s'instruire
qu'une fois T-125 fait.

### T-127 — L'application ne compile plus : une ressource que seul l'empaquetage produit

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-09 · **Clos** 2026-09-10

Constaté le 2026-09-09 au matin, signalé « ia studio ne lance pas ». Aucune fenêtre, aucune
ligne dans `logs/coquille.jsonl` — le dernier jalon de démarrage datait de la veille 19:06.
Le journal du lanceur, lui, part dans `/tmp` : il avait disparu avec le redémarrage du poste
(09:05), donc l'échec était **muet des deux côtés**.

La cause est dans la compilation Rust, jamais arrivée à son terme :

    error: failed to run custom build command for `iaction v0.5.0`
      resource path `../build/sidecar-bundle` doesn't exist

`tauri.conf.json` déclare `../build/sidecar-bundle/` en ressource. Ce dossier n'est produit
que par `scripts/preparer-bundle.sh`, appelé par `beforeBuildCommand` — donc **uniquement à
l'empaquetage**. Il est dans `.gitignore`, un clone ne l'a pas, et `scripts/dev.sh` ne le
crée pas : la session de développement le contourne volontairement par `IACTION_SIDECAR`
(T-020), qui pointe `sidecar/dist-dev/`.

Tant qu'un binaire compilé traînait dans `target/debug/`, cargo ne rejouait pas le build
script et l'absence restait invisible. Le répertoire de compilation ayant été reconstruit ce
matin-là (`target/debug/` entièrement réécrit à 09:25), le build script a été rejoué — et
l'application est devenue **inconstructible sur un poste de développement**, alors que rien
dans le code n'avait bougé. Toute machine neuve rencontre la même chose au premier
`tauri dev`, y compris sans le moindre nettoyage.

Symptôme trompeur au passage : la compilation avortée avait tout de même recopié le runtime
Node dans `target/debug/node`, horodaté de la minute — de quoi croire qu'une construction
progressait alors qu'elle échouait en boucle.

**Remise en marche du poste** — `npm run preparer-bundle` (139 Mo, 40 s, aucun
téléchargement : le runtime Node était déjà là) puis `cargo build`, qui produit le binaire en
25 s. Le lancement redevient possible.

**Correctif à faire** — la cause tient, et elle se redéclenchera au prochain nettoyage de
`target/`. Deux voies, non exclusives :

1. `scripts/dev.sh` s'assure que `build/sidecar-bundle/` existe avant d'appeler `tauri dev`,
   au minimum en dossier vide — le sidecar exécuté en dev vient de `dist-dev/`, la ressource
   n'a besoin d'exister que pour satisfaire le build script ;
2. l'échec de compilation doit rester lisible **là où on lance** : lancé par l'icône du
   bureau, stderr part dans un fichier de `/tmp` que personne ne lit et que le redémarrage
   efface. C'est le même angle mort que T-060, sur un autre chemin.

**Corrigé le 2026-09-10 — voie 1.** `scripts/assurer-bundle-dev.mjs` : appelé par `dev.sh`
juste avant `tauri dev`, il crée `build/sidecar-bundle/` s'il est absent OU vide et y dépose un
seul fichier témoin, `CECI-N-EST-PAS-LE-BUNDLE.txt`, qui dit en toutes lettres ce qu'il n'est
pas — le sidecar exécuté en développement vient de `IACTION_SIDECAR`/`sidecar/dist-dev/`
(T-020), et `npm run preparer-bundle` produit le vrai bundle. Un dossier déjà rempli n'est
JAMAIS touché : un empaquetage précédent survit intact. La ressource n'a besoin d'exister que
pour satisfaire le build script de cargo — rien n'est recopié, aucune seconde perdue.

La garde est un script Node et non trois lignes de shell précisément pour être TESTABLE :
`scripts/assurer-bundle-dev.test.mjs`, 13 vérifications, dont deux qui échouent contre l'ancien
`dev.sh` (« dev.sh invoque le garde-fou », « … AVANT `tauri dev` ») — vérifié en remisant le
seul `dev.sh`. Le test est raccroché à `npm run verif` par `npm run bundledev:test` : un
garde-fou qu'aucune chaîne n'exerce n'en est pas un.

**Reste ouvert, à instruire ailleurs** — la voie 2 : lancé par l'icône du bureau, stderr part
dans un fichier de `/tmp` que personne ne lit et que le redémarrage efface. C'est l'angle mort
T-060 sur un autre chemin, et il déborde de ce ticket.

**Note, même matin, cause distincte, écartée pour CE constat** (il n'y avait pas de binaire à
lancer) mais à retenir, car elle peut produire une fenêtre blanche : `unattended-upgrade` a
remplacé le pilote NVIDIA de 580.173.02 par 580.178.04 à 09:42, soit **après** le démarrage
du poste (09:05). DKMS a bien construit et installé le nouveau module pour les trois noyaux
présents — mais celui qui tourne en mémoire reste l'ancien. Bibliothèques en 580.178, module
noyau en 580.173 : `nvidia-smi` répond « Driver/library version mismatch ».

Ce qu'il faut en retenir pour l'application :

- l'écran externe (DP-2) est branché sur la **carte NVIDIA**, l'écran interne (eDP-2) sur
  l'Intel ; le compositeur tient des poignées ouvertes sur les deux ;
- les processus lancés **avant** 09:42 gardent leur poignée et continuent de fonctionner ;
  tout processus lancé **après** échoue à l'initialisation NVIDIA, ce que `nvidia-smi`
  démontre. Une session IAction démarrée maintenant, avec le rendu GPU devenu le défaut
  (T-095), est donc exposée ;
- le seul remède est un redémarrage du poste : le module ne peut pas être rechargé à chaud,
  la session graphique s'appuie dessus.

Deux silences à corriger côté système, pas côté projet. D'abord, ce pilote vient de
`-updates`, pas de `-security` : la configuration Ubuntu par défaut ne l'aurait pas installé,
c'est la surcharge locale `/etc/apt/apt.conf.d/52unattended-upgrades-local` (ajoutée pour les
« corrections non-sécurité + noyaux », reboot laissé manuel) qui ouvre cette porte, avec une
`Package-Blacklist` vide. Ensuite, rien n'a signalé l'incohérence : `/var/run/reboot-required`
n'a pas été posé, aucune notification n'a été émise. Un poste peut donc rester des jours dans
cet état sans que rien ne le dise — la panne n'apparaît qu'au premier programme graphique
lancé ensuite.

### T-125 — La chaîne voix n'écrit pas une ligne dans le journal

**Type** tech · **Prio** P1 · **Statut** fait · **Créé** 2026-09-06 · **Clos** 2026-09-10

Constaté le 2026-09-06 en instruisant T-123. Devant un « ça n'envoie pas », il a fallu
reconstituer la panne à partir du texte resté dans le composeur et des fichiers
`chatconv-*.json` de l'état, faute de mieux : `useVoiceComposer.ts`, `speechAdmin.ts` et
`voiceConversation.ts` ne contiennent **aucun appel de journalisation**. Ni le segment
transcrit, ni le verdict du mot-clé, ni l'état du brouillon, ni l'issue de l'envoi.

C'est l'échec muet type que la doctrine d'observabilité interdit (T-057, T-112) : la seule
fonctionnalité pilotée à la voix, donc sans trace écrite de l'intention de l'utilisateur,
est aussi la seule dont on ne garde rien. À instruire : journaliser par segment le texte
reconnu, la décision du mot-clé (déclenché / bloqué et POURQUOI — pronom, graphie, milieu de
phrase), la longueur du brouillon et le résultat de l'envoi. Un seul raté doit alors suffire
à désigner le maillon fautif, au lieu d'une enquête.

**Corrigé le 2026-09-10.** Dix-neuf points de journal sur le canal `speech`, posés aux
frontières du trajet réel d'un segment (capture → transcription → filtre → mot-clé → brouillon
→ envoi) et pas ailleurs : segment transcrit (texte, longueur, durée, verdict), décision du
mot-clé, issue de l'envoi (`parti`/`refuse`/`vide`), et les vraies pannes — transcription en
échec, micro refusé, exception d'envoi.

**Le vrai travail était dans `sendKeyword.ts`**, pas dans les appels de journal. Le module
rendait `{ body, send }` : un booléen ne dit pas POURQUOI. Le ticket exigeait la raison, et
une raison devinée à l'appel aurait été une reconstruction, pas une observation. Le type de
retour porte donc désormais `reason` — `absent`, `declenche`, `declenche-graphie-approchee`,
`bloque-pronom-devant`, `bloque-usage-grammatical` — calculée DANS le module de décision. Les
cinq valeurs sont testées. C'est ce champ qui aurait résolu T-123 en une lecture au lieu d'une
enquête : il distingue « le mot-clé n'a pas été entendu » de « il a été entendu et j'ai refusé
d'envoyer », les deux pannes qu'on ne pouvait pas séparer.

**Niveaux (contrainte inverse, T-057)** : `info` pour tout le nominal — un segment, une
décision, un envoi qui part ou qu'on refuse — parce que ces événements sont bornés par la
parole réelle et un geste explicite, jamais par un minuteur périodique ; un flux de dictée ne
peut donc pas produire de boucle. `error` réservé aux pannes, chacune rattachée à un segment ou
à un geste précis. `debug` a été écarté : il n'est pas écrit par défaut (`IACTION_LOG_LEVEL`),
et une trace qu'il faut penser à activer AVANT la panne ne sert à rien contre un raté de dictée.

**Découpage, dans le même geste.** L'instrumentation coûtait +96 lignes à `useVoiceComposer.ts`,
déjà exactement à son plafond de dérogation — le cliquet a refusé, et sa réponse attendue est de
découper. Le vocabulaire de journal est donc sorti dans `ui/src/journalVoix.ts` (10 fonctions
nommées d'après l'ÉVÉNEMENT, pas d'après le niveau, 13 tests) : le canal, le niveau, le libellé
et la forme des champs vivent en un seul endroit, là où ils étaient éparpillés sur deux fichiers
sans rien pour empêcher deux appels de nommer différemment le même événement. Reste +31 et +6
lignes de câblage irréductible, consignés en dérogation (`useVoiceComposer.ts` 894 → 925,
`voiceConversation.ts` 985 → 991).

**À trancher, et volontairement laissé en l'état** : le texte transcrit est journalisé
VERBATIM. C'est ce que le ticket demande — sans lui on ne peut pas voir « très prends » à la
place de « transmets », et T-123 aurait été indiagnosticable une fois de plus. Mais le projet a
par ailleurs pour règle de ne journaliser d'un message que sa longueur, jamais son contenu
(T-102, dépôt d'un push). La voix est donc aujourd'hui la seule chaîne dont le contenu part au
journal. C'est défendable — le journal est local, mono-utilisateur — mais c'est une exception à
une règle, et elle doit se voir plutôt que de s'installer en silence.

**Non couvert** : `voiceConversation.ts` et `useVoiceComposer.ts` n'ont toujours aucun test
unitaire — ils dépendent d'`AudioContext`/`MediaStream`, qu'aucune infrastructure du projet ne
simule. Les points de journal y sont vérifiés par lecture, pas par test. La synthèse vocale
(lecture de la réponse) reste hors du trajet instrumenté.

### T-122 — Une barre de onze onglets où aucun titre ne distingue rien

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-09-05 · **Clos** 2026-09-10

Constat utilisateur du 2026-09-05, capture à l'appui : onze conversations ouvertes sur la
page Projets, réparties sur deux rangées, dont **trois** affichent un titre commençant par
les mêmes mots. Retrouver la bonne conversation demande de survoler les onglets un par un
et d'attendre l'infobulle native.

Trois défauts indépendants, qui se cumulent :

1. **La troncature coupe du mauvais côté.** Le titre auto est le *début* du premier message
   (`deriveTitleFromText`, 40 caractères, [sessionStore.ts:105](../ui/src/sessionStore.ts#L105)),
   puis le CSS coupe encore par la droite (`text-overflow: ellipsis`, `max-width: 200px`,
   `.agent-tab__name`). Deux troncatures par la fin — alors que dans une barre, l'information
   utile est ce qui **diffère** des voisins, et que le début est justement ce qu'ils partagent.
2. **L'onglet actif ne se voit pas.** Il passe d'un fond transparent (`--bg-0 #0d0a1f`) à
   `--bg-1 #150f2b` : rapport de contraste **1,05 : 1**. Restent un liseré cyan de 2 px et un
   texte à peine plus clair (`--text-1` → `--text-0`), sans changement de graisse.
3. **Aucun repère de position.** Onze onglets de largeur identique, sans numéro ni couleur :
   l'œil doit *lire* pour retrouver, et il relit toute la barre à chaque fois. Le seul accès
   clavier est Ctrl+Tab, de proche en proche.

**Étude et maquette** : [maquette-onglets.html](maquette-onglets.html) — barre reproduite à
l'identique, puis quatre leviers activables un par un sur la même barre pour juger sur pièce.

Leviers retenus (A, B, C) :

- **A — titre discriminant** : avant affichage, le titre est comparé aux autres onglets
  *ouverts* ; le plus long préfixe partagé (sur frontière de mot, 2 mots minimum) est replié
  en « … » et la place gagnée montre la suite. Fonction pure et testée à côté
  (`ui/src/titresOnglets.ts`), sur le modèle de `fermetureOnglets.ts`. Le titre stocké ne
  change pas : l'infobulle et la liste des sessions gardent le titre complet.
- **B — état actif franc** : les inactifs reculent, l'actif avance (fond `--bg-2`, texte
  `--text-0` en gras, coiffe cyan 3 px), et il gagne le droit d'afficher son nom en entier
  (300 px contre 170 px). CSS seul.
- **C — numéro d'onglet + Alt+1…Alt+9** : ancrage spatial, et accès direct au clavier.
  Alt et non Ctrl : Ctrl+1 à Ctrl+6 servent déjà la navigation entre pages
  (`raccourcisClavier.ts`), et sur ce poste GNOME s'est approprié Ctrl+Alt. À vérifier à
  l'implémentation qu'Alt+chiffre n'ouvre pas un menu de la webview.

Levier **D — teinte stable par conversation** (filet coloré dérivé de l'id) : proposé dans la
maquette, **pas recommandé par défaut**. La palette porte déjà du sens — le cyan est la
conversation et le tour en cours, le magenta le fichier modifié — et huit teintes arbitraires
de plus feraient lire un sens là où il n'y en a pas.

Aucun levier ne touche à la persistance ni au modèle de session.

**Fait le 2026-09-05 — levier A.** `ui/src/titresOnglets.ts` (fonction pure `titresDistinctifs`,
9 tests) et son branchement dans `ui/src/BarreOnglets.tsx`. Le repli se calcule au rendu sur les
onglets ouverts à cet instant : rien n'est persisté, l'infobulle et la liste des sessions gardent
le titre entier, et un onglet replié porte le titre complet en `aria-label` pour que le lecteur
d'écran n'annonce pas justement la partie coupée.

**Fait le 2026-09-10 — leviers B et C. Le ticket est soldé.**

**B — état actif franc.** Les inactifs reculent (`max-width` 200 → 170 px), l'actif avance :
fond `--bg-2`, texte `--text-0` en gras, coiffe cyan portée à 3 px, et le droit d'afficher son
nom sur 300 px. Mesure faite, et elle mérite d'être consignée parce qu'elle corrige l'intention
du ticket : passer le fond de `--bg-1` à `--bg-2` ne fait monter le rapport que de **1,05 : 1 à
1,15 : 1**. Un contraste de FOND, dans cette palette, ne peut pas porter la distinction — c'est
le texte qui la porte : `--text-0` sur `--bg-2` donne **14,3 : 1** (AAA) contre 6,7 : 1 pour un
inactif. La graisse et la coiffe font le reste. Conclusion à retenir pour les prochains
états actif/inactif de l'application : ne jamais miser sur le seul fond dans un thème sombre à
faible étagement.

**C — numéro d'onglet + Alt+1…Alt+9.** Convention de Chrome et Firefox, retenue parce qu'elle est
déjà dans les doigts : Alt+1…Alt+8 vont à la position, **Alt+9 va toujours au DERNIER onglet** —
ce qui couvre justement le cas du ticket, où il y en avait onze. Alt et non Ctrl (Ctrl+1..6
servent la navigation entre pages) ni Ctrl+Alt (accaparé par GNOME sur ce poste).

- Logique pure et testée à côté (`raccourciOnglets.ts`, 9 tests) : `ongletPourChiffre` (touche →
  index) et `raccourciDeLaPosition` (index → libellé), sur le modèle de `titresOnglets.ts`.
- Le numéro affiché suit la POSITION, pas l'identité de la conversation, et reste discret
  (`--text-2`, 0,68 rem) : il ne reprend pas la place que le levier A vient de gagner.
- Découvrable : le raccourci est dans le `title` et l'`aria-label` de chaque onglet, et une
  ligne le documente dans l'écran Configuration → Clavier (`raccourcisClavier.ts`).
- `e.code` (`Digit`/`Numpad`) comme les raccourcis existants, `preventDefault()` dès qu'une cible
  est résolue, et `ctrlKey`/`metaKey`/`shiftKey` exclus — ce qui écarte au passage AltGr, souvent
  rapporté avec `ctrlKey` actif sur les claviers européens : la frappe des caractères spéciaux
  n'est pas cassée.
- **Piège évité, à retenir** : les deux pages restent MONTÉES en permanence (`.page-slot--hidden`,
  `display:none`). Sans garde, la barre de la page qu'on ne regarde pas répondrait aussi à
  Alt+chiffre. La garde lit `offsetParent === null` sur le conteneur, plutôt que de faire
  descendre un prop `pageVisible` depuis les deux pages — moins de câblage pour la même certitude.

**Levier D (teinte par conversation) : abandonné**, conformément à l'étude — la palette porte
déjà du sens, huit teintes arbitraires en feraient lire là où il n'y en a pas.

**Reste à confirmer à l'usage** (invérifiable sans lancer l'application) : qu'aucun raccourci de
la webview ou de GNOME ne s'interpose avant l'écouteur Alt+chiffre, et le rendu visuel réel des
largeurs et du numéro.

### T-121 — Le réveil s'arrête avec l'application : le continuer headless sur le serveur

**Type** feat · **Prio** P2 · **Statut** ouvert · **Créé** 2026-09-04

La V1 du réveil (T-120, [spec-reveil.md](spec-reveil.md)) ne fonctionne **que si l'application
est ouverte**. C'est utile — on arme et on va se coucher, la machine reste allumée — mais ça
rate la moitié du gain : une fenêtre de quota qui se rouvre à 3 h du matin sur un poste éteint
reste une occasion perdue, et c'est précisément le cas que la fonctionnalité existe pour
traiter.

**Ce qui est déjà là, et qui rend le chantier raisonnable** :

- le **runner serveur D1 est déployé et validé** depuis le 2026-08-13 ([etude-remote.md](etude-remote.md) §10) :
  image `ia-runner` sur OVH, synchro descendante/montante, crontab généré, heartbeat — et
  surtout un **jeton d'abonnement fonctionnel en headless**, vérifié par le témoin ;
- le **canal « lancer puis éteindre »** est déjà conçu ([etude-remote.md](etude-remote.md) §6) :
  fichier + synchro, `demandes/<uuid>.yaml` d'un côté, `demandes-etat/` de l'autre. Aucune API
  réseau à inventer ;
- côté poste, la **planification** est résolue de longue date par les timers systemd des tâches
  (`sidecar/src/tachesTimers.ts`, `Persistent=true` pour rattraper un réveil manqué) ;
- la **décision temporelle** du réveil est déjà une feuille pure sans React ni horloge
  (`ui/src/reveil.ts`) : elle se réutilise telle quelle côté serveur.

**Le vrai obstacle n'est donc pas la planification, c'est l'ÉTAT.** Les conversations vivent
dans `state/chatconv-<id>.json` et `project-conversations`, dont le schéma appartient à l'UI et
que l'UI réécrit intégralement. Un runner qui écrirait dedans deviendrait un **second
écrivain** : l'application ouverte ensuite écraserait son travail sans le voir. C'est la raison
pour laquelle la V1 a été volontairement bornée à l'application ouverte, et non un renoncement
de commodité.

**Piste à instruire** (pas une décision) : une boîte de dépôt plutôt qu'une écriture
concurrente — le serveur écrit ce qu'il a fait dans SA zone, l'UI l'absorbe à l'ouverture,
exactement le motif `demandes/` + `demandes-etat/` déjà retenu au §6.

**Questions à trancher avant d'écrire une ligne** :

1. **Reprendre LA conversation, ou en ouvrir une neuve ?** Le sidecar sait reprendre une
   session (`options.resume`, `sidecar/src/claude.ts`), mais l'historique vit dans la session
   du SDK, côté poste. Reprendre le même fil sur le serveur suppose de synchroniser aussi cet
   état-là — à vérifier avant de le promettre. Une reprise « à froid », avec un contexte
   reconstitué depuis les tours persistés, est peut-être le bon compromis.
2. **Qui arbitre si les deux réveils partent ?** Poste allumé ET serveur armé : il faut un
   garde-fou anti-double-déclenchement, du même genre que celui avancé de D3 à D1 pour les
   tâches (§3 bis).
3. **Quel périmètre de permissions** pour un agent qui repart sans personne devant l'écran ?
   La question ne se pose pas en V1 (l'utilisateur est là) ; elle devient centrale ici.
4. **Windows** : sans systemd, le volet « poste » sera de toute façon différent. Le volet
   serveur, lui, est indifférent au poste.

**Piste évaluée le 2026-09-04 — les « Managed Agents » d'Anthropic (bêta).**

C'est la troisième surface de l'API : Anthropic héberge la **boucle d'agent ET le bac à sable**
(un conteneur par session), avec des configurations d'agent persistées et versionnées. Et
surtout, elle porte des **déploiements planifiés** : un objet `deployment` avec un cron et un
fuseau IANA déclenche une session tout seul, avec enregistrement par déclenchement et
pause/reprise/archivage. C'est littéralement un réveil, sans serveur à soi.

Ce qu'elle apporterait ici :

- **plus de runner à héberger** pour ce cas — ni OVH, ni systemd, ni synchro de fichiers ;
- **planification native** : cron + fuseau, `upcoming_runs_at` pour vérifier ce qu'on a écrit,
  états de cycle de vie ;
- **budget par déploiement**, recopié sur chaque session : un plafond DUR en dollars, ce que
  ni le poste ni le runner OVH ne savent faire aujourd'hui ;
- sessions longues, historique et bac à sable **préservés** entre les tours.

**Mais elle ne règle pas le point qui bloque, et elle change la nature économique du projet.**
Quatre réserves, dans l'ordre d'importance :

1. **Facturation API, pas abonnement.** Une session CMA se paie aux tarifs publics par token,
   plus **0,08 $/heure de session**. Or tout l'intérêt du réveil est de consommer
   l'ABONNEMENT pendant les heures creuses — et D1 avait justement prouvé qu'un jeton
   d'abonnement fonctionne en headless (2026-08-13). Basculer sur CMA, c'est déplacer la
   dépense vers l'API payante : ce n'est pas un détail d'implémentation, c'est un changement
   de modèle de coût.
2. **Ce n'est pas le même produit que le SDK Agent.** IAction pilote le **Claude Agent SDK**
   (harnais local, `options.resume` par `sessionId`) ; les Managed Agents sont une surface
   distincte avec leur propre magasin de sessions. On ne peut donc pas reprendre une
   conversation IAction dans une session CMA. La question n°1 ci-dessus — « reprendre LA
   conversation ou en ouvrir une neuve ? » — reste entière, et CMA impose de fait la réponse
   « une neuve ».
3. **Le contexte local n'y est pas.** Le bac à sable ne voit pas le projet du poste : il
   faudrait monter le dépôt (ressources `github_repository` / `file`), ce qui rouvre la
   question de la synchro que le runner OVH avait déjà tranchée.
4. **Détails qui comptent pour un réveil de nuit** : bêta (`managed-agents-2026-04-01`) ; le
   déclenchement est **gigué** (jusqu'à 15 % de l'intervalle, plafonné à 9 min) ; et au
   changement d'heure une heure de mur inexistante est **sautée**, une heure doublée **tire
   deux fois** — la documentation recommande explicitement d'éviter la fenêtre 1 h-3 h locale,
   ce qui est précisément celle qu'on vise.

**Conclusion provisoire** : CMA est un excellent candidat pour les **tâches** (agents
récurrents autonomes qui n'ont pas besoin du contexte d'une conversation, ni de l'abonnement) —
il mériterait son propre ticket de ce côté-là. Pour le réveil d'une conversation de projet, il
ne remplace pas le runner OVH : il ne sait ni reprendre la session, ni dépenser l'abonnement.
À rouvrir si Anthropic adosse un jour les Managed Agents à l'abonnement.

**Note de méthode** : ne pas commencer par le code. Ce ticket appelle d'abord une décision sur
le point 1, qui détermine tout le reste — et une V1 mal cadrée ici coûterait plus cher que
l'attente.

### T-120 — Une conversation ne peut pas se programmer : les heures creuses sont perdues

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-09-04 · **Clos** 2026-09-10

Une session saturée s'arrête net (« You've hit your session limit · resets 7:10pm ») et plus
rien ne repart avant que l'utilisateur ne revienne cliquer. Le travail est prêt, la machine
est libre, la fenêtre de 5 h se rouvre à 3 h du matin — et l'occasion passe. Rien dans l'app
ne permet de dire « reprends ce travail à telle heure ».

**Ce qui manque est petit**, parce que l'essentiel existe déjà : l'envoi différé est le
mécanisme des prompts mis en file pendant un streaming (`ConvRuntime.queuedPrompts`, drainé
en fin de tour par un effet jumeau dans les deux pages), et l'instant de réouverture de la
fenêtre saturée est déjà connu et partagé (`silenceActifJusqua`, armé par le refus — T-059).
Un réveil n'est donc **pas un second moteur d'envoi** : c'est une retenue dans le temps, qui
verse ses prompts dans la file existante à l'échéance et laisse le chemin nominal faire le
reste.

Spécifié dans [spec-reveil.md](spec-reveil.md). V1 volontairement bornée à
l'**application ouverte** : le réveil app fermée (timer systemd, comme les tâches) bute non
pas sur la planification — déjà résolue par `tachesTimers.ts` — mais sur l'état, puisque les
conversations vivent dans `state/chatconv-<id>.json`, dont le schéma appartient à l'UI ; un
réveil headless qui y écrit en fait un second écrivain, et l'UI ouverte ensuite écrase. Ça se
traite à part.

**Fait le 2026-09-04 (V1, application ouverte)** : module pur `ui/src/reveil.ts` (décision
temporelle, heure de mur locale, anti-double-tir, rattrapage borné à 6 h), versement partagé
`ui/src/reveilRuntime.ts`, battement partagé `ui/src/useReveil.ts` (un hook, pas deux effets
jumeaux), contrôle `ui/src/ReveilControl.tsx`, persistance dans `ChatSession` et
`ProjectSession`, canal de journal `reveil`.

**Défaut trouvé à la vérification, et corrigé** : verser dans `queuedPrompts` ne suffisait
PAS à faire partir un tour — le drainage ne draine que la conversation ACTIVE. Un réveil armé
puis un changement d'onglet et la promesse tombait. Remède : bascule sur la conversation
concernée à l'échéance (une seule par battement, jamais sur un abandon). Voir
[spec-reveil.md](spec-reveil.md) §5.1.

**Vérifié le 2026-09-10, ticket clos.** Le dernier maillon manquant — `cargo test` — est passé
au vert : **90 tests, 0 échec, code de sortie 0**. Le garde-fou T-111 interdisait de le lancer
tant qu'une session de développement tourne ; la parade est de compiler AILLEURS
(`CARGO_TARGET_DIR` dans un répertoire jetable), ce qui laisse `src-tauri/target/` — celui de
la session en cours — intact. À retenir : le refus de T-111 protège un répertoire, pas une
commande. Le reste de la chaîne était déjà au vert : typecheck, lint, tests UI, casse, bundle,
routage, audit, tickets, version, cliquet.

**Défauts trouvés à l'usage, corrigés au fil de l'eau** :

1. **Un réveil armé ne survivait pas à un rechargement de l'UI.** Armer n'écrivait que le
   runtime ; la persistance des pages n'a lieu qu'aux gestes qui la déclenchent déjà (envoi,
   bascule de conversation, suppression), et armer n'en était pas un. Le réveil disparaissait
   donc **sans un mot** — c'est ainsi qu'un réveil de test n'a pas fonctionné. Corrigé par
   `gererReveils` (reveilRuntime.ts), qui prend le `persister` DANS SA SIGNATURE : enregistrer
   ou supprimer écrit le runtime ET le disque, dans le même geste. Voir
   [spec-reveil.md](spec-reveil.md) §3.1.
2. **Impossible d'armer sans le deviner.** Heure tapée, message écrit, bouton « Armer » grisé :
   le champ exigeait un clic sur « Ajouter » que rien n'annonçait, et le motif de refus restait
   générique. Corrigé : la saisie en cours compte (`heuresAvecSaisie`), « Ajouter » ne sert
   plus qu'à une seconde heure, et le refus nomme la cause exacte.
3. **L'UI ne montrait pas l'état armé, et un réveil ne se reprenait pas.** Le bouton repliait
   l'état avec le reste : armé ressemblait à absent. Et un seul réveil par conversation, ses
   heures partageant un unique message, sans identité — on ne pouvait que supprimer.
   Corrigé : bannière d'état permanente (pastille, nombre, prochaine échéance), et une LISTE
   de réveils, chacun son message, chacun modifiable (`Reveil.id`). Relecture tolérante de
   l'ancienne forme au singulier — aucun réveil déjà armé n'est perdu.

4. **Un réveil se ré-armait tout seul pour le lendemain.** Ayant sonné à 11:18, il repartait
   pour le 11:18 suivant — un travail relancé sans qu'on le demande, dont le contexte a
   changé. Un réveil est une promesse DATÉE : déclenché ou abandonné, il est désormais
   consommé, retiré des armés et versé à `reveilsHistorique` (plafond 20), consultable dans
   le panneau — un réveil abandonné y figure au même titre qu'un réveil parti, marqué comme
   tel. Sans cette trace, un réveil disparaîtrait de l'écran sitôt son travail fait.

5. **La reprise « dès que le quota rouvre » ne pouvait pas s'armer.** L'en-tête affichait
   « ⚠ Session 5h saturée — réinitialisation dans 2h », la case était cochée, et « Armer » se
   refusait en prétendant qu'aucune saturation n'était connue. Cause : le réveil lisait
   `silenceActifJusqua`, armé au seul REFUS de la sonde (T-059) — or au moment où l'on veut
   armer une reprise, on n'a justement pas encore été refusé, on voit venir la saturation.
   L'application savait, le réveil regardait ailleurs. Corrigé par `reouvertureQuota.ts`, qui
   mémorise le `resetsAt` du relevé chiffré (la source du badge lui-même) et retombe sur le
   silence d'un refus à défaut. Magasin SÉPARÉ du silence, jamais fusionné : celui-ci commande
   à la sonde de se taire, et armer un réveil ne doit pas museler la mesure.

   **Deuxième passe, même jour** : le premier remède plaçait la mémorisation dans
   `traiterReponseInit` seulement — or le relevé entre par CINQ chemins dans l'encart, et
   c'est le cache relu au démarrage qui alimentait le badge (la sonde se tait pendant la
   saturation). Remplacé par un effet sur l'état rendu, qui couvre toutes les portes. Le
   contrôle bat en outre toutes les 30 s : sans re-rendu, un panneau ouvert avant l'arrivée du
   relevé restait grisé alors que l'app savait répondre.

   **Troisième passe — la vraie cause.** Même avec la bonne source, le réveil « au reset » ne
   partait pas et s'affichait « inerte » : la source BOUGE. Elle ne rend l'instant que tant
   qu'il est futur, alors que l'échéance visée est `réouverture + 60 s`, toujours postérieure —
   au moment précis où elle devient due, la source s'est tue. Et si un relevé frais arrive
   entre-temps, la date saute à la réouverture suivante, cinq heures plus loin : le moment visé
   est enjambé sans jamais avoir été observé. Le remède n'est pas de mieux lire mais de NE PLUS
   RELIRE : `Reveil.cibleReouverture` fige l'instant à l'armement, le battement ne fait plus
   que comparer des dates. Ironie consignée : ce piège était décrit mot pour mot dans l'en-tête
   de `reveil.ts` dès la première version, avec un remède (« à l'appelant de conserver la
   dernière valeur ») qui n'a jamais été implémenté — et qui était de toute façon plus fragile
   que de figer la cible.

6. **« Ça prend un bandeau pour rien. »** (2026-09-05, après une nuit de fonctionnement réussie
   — réveil de 04:00 déclenché, reprise effective.) Le bouton « ⏰ Réveil » occupait une ligne
   entière du composeur en permanence, y compris quand aucun réveil n'était armé, c'est-à-dire
   la plupart du temps. Descendu dans la COLONNE d'icônes du composeur, avec le trombone et le
   micro, où vivent les actions secondaires ; le panneau s'ouvre en flottant au-dessus. Le
   bandeau d'état est conservé mais n'apparaît QUE lorsqu'un réveil est armé. Deux composants
   exportés (`ReveilBanniere`, `ReveilControl`) parce qu'ils vivent à deux endroits du DOM.

**Dérogations de taille relevées** (choix explicite, comme le cliquet le demande) :
`AgentPage.tsx` 2843 → 2896, `ChatPage.tsx` 2603 → 2673. Ce qui reste dans les pages est du
câblage irréductible (champs de type, validation, rendu) ; le mécanisme, lui, est sorti.

### T-119 — Un dossier cité dans le fil est déclaré « introuvable » alors qu'il existe

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-09-02 · **Clos** 2026-09-02

Constat utilisateur du 2026-09-02, capture à l'appui : une réponse cite
`plans/supports/support-camera-csi/`, le texte est bien habillé en bouton, et le clic (comme le
clic droit) répond **« "plans/supports/support-camera-csi/" introuvable dans le projet. »** —
alors que le dossier est là. C'est très exactement le mensonge que
[refFichier.ts](../ui/src/refFichier.ts) existe pour empêcher : une promesse (un bouton) que
l'action ne tient pas.

**Cause, en deux morceaux.**

1. La cascade de résolution ne sondait que des **fichiers** : `lireFichier` (`fs_read_file`)
   échoue sur un répertoire, et rien ensuite ne demandait « et si c'était un dossier ? ».
   Aucun état de `ResolutionReference` ne pouvait d'ailleurs le dire.
2. La **barre finale** vidait le nom de base : `nomDeBase("a/b/c/")` rend `""`, donc le repli
   `nom || developpe` faisait chercher le chemin ENTIER comme nom de fichier. Le dernier
   recours (recherche par nom) était donc condamné d'avance.

**Réalisé.**

- `classerReference` retire la barre finale avant de classer, mais la **mémorise** : c'est le
  seul indice de forme qui dise « dossier », et il suffit à faire d'un `photos/` un chemin à
  tenter sous la racine plutôt qu'un nom à chercher partout.
- Nouvel état `{ etat: "dossier" }` dans `ResolutionReference`, et nouvelle sonde
  `ContexteOuverture.listerDossier` (`fs_list_dir`) — on **demande au disque** au lieu de lire
  la forme du nom (`Makefile` n'a pas de point, `v1.2` en a un). Elle est interrogée aux quatre
  endroits de la cascade : absolu du projet, absolu hors projet, relatif sous la racine, relatif
  sous chaque répertoire vu dans le fil (T-105).
- Ouverture : un dossier n'a qu'une voie, l'ouvreur du **système** — le gestionnaire de fichiers.
  Ni registre d'applications (indexé par extension) ni éditeur interne (il ouvre des fichiers) ;
  `forcer` n'a donc rien à imposer.
- Menu contextuel du fil ([menuReference.tsx](../ui/src/menuReference.tsx)) : « Ouvrir le
  dossier » + « Copier le chemin ». Pour un FICHIER l'item vise toujours le dossier parent,
  pour un dossier résolu il vise le dossier lui-même.
- Menu contextuel de l'arbre ([FileTree.tsx](../ui/src/FileTree.tsx)) : un clic droit sur un
  répertoire ne proposait que « Renommer » / « Supprimer » ; il propose désormais « Ouvrir le
  dossier ».

Couverture : 8 cas dans `refFichier.test.ts` (barre finale et sans, segment unique, absolu
dans et hors projet, base du fil, ouverture système jamais éditeur, et « ni fichier ni dossier
reste introuvable »), 1 cas dans `menuReference.test.ts`. Aucun changement côté Rust :
`open_external` ouvre déjà un chemin quelconque.

### T-114 — `search_chat` répond « aucun historique » alors que 58 conversations sont sur le disque

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-01 · **Clos** 2026-09-02

Constat brut, reproduit le 2026-09-01 depuis un tour du projet orgaia-fond :
l'appel `search_chat` avec la requête « mémoire » renvoie

```
aucun historique de Chat sur ce poste (fichier d'état absent)
```

alors que `~/.local/share/net.duvam.iaction/state/` contient **58 fichiers
`chatconv-*.json`** et un `chat-index.json`.

Cause apparente à la lecture du code : `chatConversationsPath()`
(`sidecar/src/chatHistory.ts:30-32`) construit le chemin
`<globalDataRoot>/state/chat-conversations.json` — le **monolithe historique**.
Or le passage à l'état éclaté (T-061) a renommé ce fichier en
`chat-conversations-avant-eclatement.json` et écrit désormais une conversation
par fichier (`ui/src/etatEclate.ts:56-58, 226-241`). Le sidecar lit donc un
chemin que plus personne n'alimente. Sur ce poste, `chat-conversations.json`
n'existe pas : la branche « fichier d'état absent » (`chatHistory.ts:115`) est
prise à chaque appel.

C'est le mode d'échec déjà décrit en commentaire dans `appPaths.ts:104` (« le
sidecar lisait un dossier que personne n'écrivait, `search_chat` répondait… ») —
la même panne, revenue par une autre porte après T-061.

Gravité : `search_chat` est **le seul pont** entre l'historique de conversations
et un agent de projet. Il est exposé en permanence (contrairement à
`search_knowledge`, conditionné à l'existence d'un index,
`knowledge.ts:562-564, 594-596`), donc il est proposé au modèle à chaque tour et
répond faux — un échec muet du point de vue de l'agent, qui conclut « pas
d'historique » au lieu de « je ne sais pas lire ».

À corriger : lire `chat-index.json` + les `chatconv-*.json`, en gardant la
lecture tolérante actuelle (aucune exception, message français). Prévoir le
repli sur `chat-conversations-avant-eclatement.json` pour ne pas perdre
l'antériorité — les conversations d'avant l'éclatement (460 Ko) ne sont dans
aucun `chatconv-*.json`.

À vérifier au passage : un test qui fait échouer la version actuelle sur un
`state/` au format éclaté. La panne est passée inaperçue parce que rien ne
distingue « aucun résultat » de « je n'ai pas su lire ».

**Corrigé le 2026-09-02.** Prémisse du ticket vérifiée sur les données réelles AVANT de
spécifier (leçon T-106/T-107), et elle était fausse sur deux points qui ont changé le
correctif :

- `chat-index.json` n'énumère PAS les conversations (il ne porte que `activeId` et les
  onglets ouverts) — la lecture LISTE donc le répertoire (`chatconv-*.json`) au lieu de lire
  l'index ;
- le repli sur `chat-conversations-avant-eclatement.json` était inutile : recoupé sur le
  poste, les 30 sessions du monolithe ont TOUTES été recopiées en fichiers `chatconv-*` par
  la migration T-061 (0 absente). La sauvegarde n'est pas lue.

`searchChatHistory` (sidecar/src/chatHistory.ts) énumère les fichiers éclatés, lit chaque
conversation avec la tolérance d'origine (fichier illisible ou JSON invalide SAUTÉ, la
recherche continue), et ne se rabat sur le monolithe `chat-conversations.json` que si aucun
fichier éclaté n'existe (poste jamais migré). « Fichier d'état absent » ne sort plus que si
ni l'un ni l'autre n'existe. Tests : un `state/` éclaté sans monolithe (échoue contre
l'ancienne implémentation), un fichier corrompu sauté, les cas monolithe relibellés en tests
du repli.

Fichiers : [chatHistory.ts](../sidecar/src/chatHistory.ts), [chatHistory.test.js](../sidecar/test/chatHistory.test.js).

### T-115 — Le RAG dépend d'un bouton que personne ne clique : « je ne sais pas quand le faire et pourquoi »

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-01 · **Clos** 2026-09-02

Constat utilisateur, verbatim, 2026-09-01 :

> en fait je ne clique jamais sur indexer maintenant, ce n'est pas du tout
> intuitif, je ne sais pas quand le faire et pourquoi

Constat machine du même jour : sur 13 projets du dossier de développement, **4 ont un
index** `.iaction/connaissances-index/`, et **3 de ces 4 datent du
2026-07-31** — un mois. Un seul est à jour, et seulement parce qu'il a été
réindexé à la main ce jour-là.

Ce n'est donc pas un manque de confort, c'est la fonctionnalité qui **ne
fonctionne pas en usage réel** : le RAG répond, mais sur l'état du projet d'il y
a un mois. D'où le type `bug` plutôt que `feat`.

Cause : `knowledgeIndex()` n'a qu'un seul appelant, le bouton « Indexer
maintenant » (`ui/src/useConnaissances.ts:135-153`, exposé
`ui/src/agentSidebarDroit.tsx:561`). Aucun déclenchement à l'ouverture de
projet, en fin de tour, par timer ni par surveillance de fichiers.

**Le bouton demande à l'utilisateur une information qu'il n'a pas.** Savoir
quand réindexer suppose de savoir quelles sources sont indexées, lesquelles ont
bougé depuis le dernier passage, et ce que le modèle perd en attendant — trois
choses que l'app connaît et que l'humain ne connaît pas. L'app calcule même déjà
un drapeau `stale` (`handleKnowledgeStatus`, `knowledge.ts:772-805`), rafraîchi
au montage (`useConnaissances.ts:126-133`) : l'information existe, elle n'est
suivie d'aucun effet.

**Et ce bouton garde une opération gratuite.** Les embeddings sont calculés en
local par Ollama (`nomic-embed-text` par défaut, `router.ts:109`). Aucun jeton
payant, aucun appel réseau sortant. Il n'y a donc aucune raison économique de
mettre une confirmation humaine devant. Le seul coût est du temps CPU/GPU, qui a
sa place en tâche de fond, pas dans une décision.

**Cible : l'index s'entretient tout seul, le bouton devient un outil de
réparation.** Dans l'ordre, du moins cher au plus complet :

1. **Réindexer en fond dès que `stale`, à l'ouverture du projet**, sans rien
   demander et sans bloquer. L'indexation est déjà incrémentale par mtime
   (`knowledge.ts:674-677`) : sur un projet inchangé elle ne réembarque rien, le
   coût est une comparaison de mtimes. C'est probablement suffisant à soi seul.
2. **Dater le résultat de recherche.** `formatSearchResults`
   (`knowledge.ts:545-550`) n'affiche que le fichier et le score. Ajouter l'âge
   de l'index à l'en-tête rendu : un index périmé cesse d'être un **échec muet**
   même quand il n'a pas pu être reconstruit — le modèle sait qu'il lit du vieux
   et peut le dire.
3. **Réindexer en fin de tour** si le tour a écrit dans une source indexée
   (point d'accroche : la persistance de fin de tour, `ui/src/envoiProjet.ts`).
4. **Ne garder le bouton que comme réparation** — « Reconstruire l'index »,
   forçage complet, pour le cas où le modèle d'embeddings change ou l'index est
   corrompu. Une action qu'on comprend quand on la voit, au lieu d'une routine
   qu'il faut savoir déclencher.

À noter pour le point 1 : l'incrémentalité repose sur `mtimeMs`, pas sur une
empreinte de contenu — un contenu changé à mtime préservé (restauration,
synchronisation Nextcloud) laisserait un chunk faux. Au moins un commentaire
dans le code, sinon un ticket séparé.

Critère de réussite : sur un poste où personne ne clique jamais, aucun index
n'a plus d'un jour de retard sur ses sources.

**Corrigé le 2026-09-02 — points 1, 2 et 4 du plan ; le point 3 (fin de tour) attendra un
constat.**

1. **L'index se répare seul** : dès que `knowledge.status` répond `exists && stale`, l'UI
   relance l'indexation incrémentale en fond, sans confirmation ni blocage
   (ui/src/useConnaissances.ts). Trois garde-fous, chacun contre un mode de panne nommé : au
   plus UNE tentative par projet et par session (Ollama arrêté = « fetch failed » ne doit pas
   boucler — la garde est atomique, testée), jamais pendant une indexation en cours, et un
   échec DISCRET (ligne `debug`, pas de bandeau — doctrine T-057). Un index inexistant ne
   déclenche rien : la création initiale reste un choix.
2. **Les résultats de recherche sont datés** : `formatSearchResults` ouvre par « Index
   construit le … (il y a N j) » et ajoute « sources modifiées depuis » quand l'index est
   périmé — un agent qui lit du vieux le sait et peut le dire. Appliqué aux deux moteurs
   (outil MCP `search_knowledge` et moteur neutre).
3. **Le bouton devient une réparation** : « Reconstruire l'index », qui passe `force: true` —
   `knowledge.index` ignore alors la réutilisation par mtime et ré-embarque tout (documenté
   dans docs/protocol.md). C'est aussi la réparation de l'angle mort du mtime (contenu changé
   à mtime préservé — restauration, synchro Nextcloud), désormais commenté dans knowledge.ts.

Tests : auto-déclenchement, non-déclenchement sur index absent, garde une-tentative-par-cwd,
échec discret (ui/src/connaissances.test.ts) ; `force` ré-embarque à mtime inchangé, en-tête
daté (sidecar/test/knowledge.test.js, protocol.test.js). Le critère de réussite se
constatera à l'usage : les index suivront désormais l'ouverture des projets.

Fichiers : [useConnaissances.ts](../ui/src/useConnaissances.ts), [knowledge.ts](../sidecar/src/knowledge.ts), [sidecar.ts](../ui/src/sidecar.ts), [agentSidebarDroit.tsx](../ui/src/agentSidebarDroit.tsx), [protocol.md](protocol.md).

### T-118 — Windows : « API Error: Unable to connect to API », l'app ne sert à rien sur ce poste

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-09-02 · **Clos** 2026-09-19

Constat utilisateur du 2026-09-02, verbatim (rapporté depuis le poste Windows, message
probablement tronqué) : « l'application ne marche pas sur le windows […] j'ai api error:
unable to connect API ».

**Ce qu'on sait.** « API Error: Unable to connect to API » est un message du **CLI Claude**
(la même famille que le second témoin de T-085 : `API Error: Unable to connect to API: SSL
certificate hostname mismatch`, 234 occurrences sur le poste Linux en août, vers
`api.anthropic.com`). Le moteur Claude de l'app passe par le CLI : ce message dit que le CLI
n'atteint pas l'API — il ne dit pas encore POURQUOI.

**Ce qu'on ne sait pas, et qui décide de tout** : la fin du message. Trois suffixes possibles,
trois causes différentes :

- `SSL certificate hostname mismatch` → interception TLS sur le chemin réseau (antivirus
  Windows qui inspecte le HTTPS, proxy, portail captif) — la piste T-085, jamais tranchée ;
- un timeout / `ECONNREFUSED` → réseau, pare-feu, proxy non configuré pour le CLI ;
- un message d'authentification → le CLI de ce poste n'est simplement pas connecté.

**À relever sur le poste Windows avant tout geste** (vérité terrain avant opinion) :

1. le journal de l'app : `%APPDATA%\net.duvam.iaction\logs\app.jsonl`, les lignes du jour —
   elles portent le message COMPLET, avec le suffixe qui tranche ;
2. le CLI seul, hors de l'app, dans un terminal : `claude --version` puis `claude -p "ok"` —
   si le CLI échoue seul, la panne n'est pas dans l'application ;
3. si le suffixe est TLS : quel antivirus/proxy tourne sur ce poste (l'inspection HTTPS des
   antivirus Windows produit exactement ce symptôme).

À noter : ce poste est aussi un débouché de l'empaquetage NSIS (voir T-097, T-096) — si la
cause est locale au poste (réseau, antivirus, CLI non connecté), le ticket devra dire ce que
l'APP aurait dû afficher de mieux qu'une erreur brute de CLI : c'est le volet qui nous
appartient quelle que soit la cause.

**Diagnostic du 2026-09-02, mené À DISTANCE sur le poste Région** (via le relais
`region.py ask` du projet rpsl, worker Windows natif — aucun accès manuel au poste). La
vérité terrain écarte l'hypothèse TLS de départ :

- **Message COMPLET du journal** (`%APPDATA%\net.duvam.iaction\logs\app.jsonl`) : « API Error:
  Unable to connect to API **(ConnectionRefused)** » sur `usage.claude.init`, en rafale toutes
  les 10 min de **10:32 à 11:22**, plus un `UND_ERR_CONNECT_TIMEOUT` sur `models.detail`. Ce
  n'est PAS « SSL certificate hostname mismatch » : la piste T-085 est écartée pour ce poste.
- **Le réseau et le TLS sont sains** : `curl.exe` vers l'API Claude en HTTPS direct depuis le
  poste **répond** (connexion établie, TLS schannel négocié, HTTP 404 attendu sur `GET /`). La
  route par défaut sort par la box du réseau local, **aucun tun/VPN ne capture la route** —
  l'inverse du cas seedbox diagnostiqué le matin même sur le PC PERSO.
- **Le CLI Claude lui-même atteint l'API** : le worker distant, qui tourne précisément par
  `claude -p`, a exécuté les commandes de diagnostic en direct — donc le CLI natif du poste
  parle à l'API à l'instant du relevé.
- **Ni proxy ni base URL détournée** : `HTTP(S)_PROXY` vides, `ProxyEnable=0` au registre,
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_URL` vides, `~/.claude/settings.json` propre.

**Conclusion provisoire** : `ConnectionRefused` sur une fenêtre bornée (10:32→11:22) alors
que le direct et le CLI fonctionnent au relevé = incident TRANSITOIRE de connexion sur ce
poste, résorbé depuis. La cause n'est ni dans l'app, ni dans un certificat, ni dans un proxy.
Reste plausible : une bascule de chemin réseau (VPN Région qui reconnecte — le poste est censé
sortir par lui, il était en direct-box au relevé) qui a refusé les connexions le temps d'une
fenêtre. Non prouvable sans l'historique VPN du poste.

**Reste dû, et ce qui appartient à l'app** : (1) que David relance IAction maintenant — si
l'init passe, l'incident était bien transitoire et le ticket se ferme sur ce constat ; s'il
échoue encore, refaire une capture du message EN DIRECT. (2) Quoi qu'il arrive, le volet
nôtre : l'app affiche le message brut du CLI (`ConnectionRefused`) sans le situer — elle
devrait distinguer « API injoignable (réseau/VPN) » de « CLI non connecté » et le dire en
clair, au lieu de laisser l'utilisateur conclure « l'application ne marche pas ». C'est le
seul correctif de code que ce ticket porte encore.

**Corrigé le 2026-09-19 — le volet qui nous appartient.** `sidecar/src/diagnosticErreurClaude.ts`
classe désormais un message d'erreur du moteur en **quatre** familles, là où il n'y en avait que
deux (`decorateAuthError` : abonnement, authentification — le reste passait brut). Chacune porte
UN geste, et un seul :

| famille | ce que l'utilisateur doit faire |
|---|---|
| `abonnement` | attendre la réinitialisation — jauge d'en-tête |
| `tls` | l'HTTPS est intercepté : antivirus, proxy d'entreprise, portail captif |
| `reseau` | l'API est injoignable : réseau, VPN, pare-feu — **les identifiants ne sont pas en cause** |
| `authentification` | `claude login` ou une clé API dans Fournisseurs |

**L'ordre de classement EST la fonction**, parce qu'un même message porte souvent le vocabulaire
de plusieurs familles : abonnement d'abord (conseiller une reconnexion à un compte à quota épuisé
l'envoie déboguer le mauvais problème) ; TLS avant réseau, car le message d'août —
« Unable to connect to API: SSL certificate hostname mismatch » — appartient aux deux et seul le
geste TLS est utile ; réseau avant authentification, car « Unable to connect to API » ne dit
rien d'un défaut d'identifiants. C'est exactement la confusion qui a coûté ce ticket.

Un message qu'on ne sait pas classer est rendu **tel quel** — T-103 : « un conseil faux est pire
qu'un conseil absent, il fait conclure que le problème est ailleurs ». Et le message brut reste
toujours en tête : c'est la vérité terrain, le conseil ne fait que la suivre.

**Un test existant verrouillait le défaut** et a dû être retourné, ce qui vaut d'être noté :
`claudePur.test.js` affirmait « `ECONNREFUSED 127.0.0.1:443` — message hors des deux familles :
rendu tel quel ». C'était le comportement même dont T-118 est la plainte, inscrit comme une
garantie. Il vérifie maintenant que cette erreur est nommée, et sans conseil de reconnexion.
Six cas dédiés dans `sidecar/test/diagnosticErreurClaude.test.js`, dont celui du poste Windows
mot pour mot. 46 fichiers de la suite sidecar au vert.

**L'incident lui-même est clos sur le diagnostic** : `ConnectionRefused` sur une fenêtre bornée
(10:32→11:22) alors que `curl` en direct, le CLI natif et le TLS répondaient tous au relevé.
Ni l'application, ni un certificat, ni un proxy. Si le symptôme revient sur ce poste, ce sera un
FAIT NOUVEAU et un ticket neuf — avec, cette fois, un message qui dit de quelle famille il
relève au lieu d'un « API Error » brut.

**Raccordé dans la foulée** : le micro-tour d'initialisation (`claudeUsage.ts`) rendait encore
« échec du micro-tour d'initialisation : <message brut> ». C'est précisément le chemin qui criait
en rafale sur le poste Windows — il passe désormais par le classement lui aussi. 51 fichiers de
la suite sidecar au vert.

### T-116 — Les artefacts HMR du développement crient en `error` dans le journal

**Type** tech · **Prio** P3 · **Statut** fait · **Créé** 2026-09-02 · **Clos** 2026-09-10

Constaté le 2026-09-02 en mesurant le journal pour clore T-057. Environ 80 lignes
`rendu React interrompu : Can't find variable: <X>` (ou « Cannot access before
initialization », « Rendered fewer hooks than expected ») depuis le 2026-08-03, au niveau
`error`. Corrélation nette : chaque `<X>` est un symbole du module en cours d'édition ce
jour-là (`useComposerLiveDraft` le 05/08, `splitFeatured` le 12/08, `closeFileTab` le
30/08…) — c'est Vite qui sert un graphe HMR périmé après une édition, et l'error boundary
qui fait son travail. La version empaquetée ne peut pas produire ces lignes.

Ce n'est donc pas une panne du produit, mais c'est du bruit au niveau `error` dans le
fichier qu'on ouvre quand ça va mal (doctrine T-057), et 7 des 20 erreurs des 12 derniers
jours sont de cette famille. À instruire, sans urgence : soit marquer ces interruptions
comme artefact de développement quand la page tourne sous Vite (champ dédié ou niveau
`warn`), soit vérifier si l'interaction pages paresseuses (T-029) × HMR peut être adoucie.
Ne PAS les taire : un vrai crash de rendu en version empaquetée doit rester une `error`.

**Corrigé le 2026-09-10 — première voie, et rien de plus.** La règle tient en une ligne dans
`ErrorBoundary.tsx` : `niveau = (import.meta.env.DEV && estArtefactHmr(message)) ? "warn" :
"fatal"`, la ligne portant en outre `artefactHmr: true` dans ce seul cas. Deux conditions, et
il FAUT les deux : hors développement, un message de la même famille reste `fatal` — c'est la
garantie que le ticket exigeait. La condition de développement est lue par `import.meta.env.DEV`,
propre à Vite, et non devinée sur l'URL ou le port.

La reconnaissance de la famille est une fonction pure isolée, `ui/src/artefactHmr.ts`
(`estArtefactHmr`), parce qu'un crash de rendu qui N'EST PAS un artefact HMR doit continuer de
crier même en développement. Elle couvre les deux moteurs système de Tauri, dont les libellés
diffèrent pour la même faute : WebKitGTK dit « Can't find variable: X » là où Chromium/WebView2
dit « X is not defined » — n'en couvrir qu'un aurait laissé le bruit intact sur Windows. S'y
ajoutent la zone morte temporelle (« … before initialization », V8 et SpiderMonkey) et
« Rendered fewer hooks than expected », dont le nombre de hooks change quand HMR remplace un
composant édité.

La ligne n'est pas TUE : elle garde son message, sa pile JS et sa pile de composants, et le
champ `artefactHmr` la rend filtrable — on peut la retrouver, on ne la confond plus avec une
panne. 13 tests (`artefactHmr.test.ts`, `ErrorBoundary.test.ts`), dont les négatifs qui
verrouillent l'essentiel : crash hors famille en développement ⇒ `fatal` ; famille HMR hors
développement ⇒ `fatal`.

La seconde voie évoquée au ticket (adoucir l'interaction pages paresseuses T-029 × HMR) n'a pas
été suivie : elle traite la CAUSE du rechargement bancal, pas le bruit au journal, et relève de
T-029.

### T-102 — 38 minutes de sous-agent muet, puis un « arrêt demandé » que personne n'a demandé

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-09-19

Constat utilisateur du 2026-08-29, capture à l'appui (projet Didier, session
`a6947ce2-33c2-41c4-8634-9de5ecd1e715`, tour `req-7jxf0i-420`, moteur Claude, mode Autonome).

**Chronologie (journal `~/.config/net.duvam.iaction/logs/app.jsonl`, l. 8144–8154).**

1. 15:41:58 — le tour démarre (« serveurs MCP du tour »). Le fil dit : « je délègue
   l'implémentation … » et lance l'outil `Agent` (« Écrire le .scad du support micro »).
2. 15:41:58 → 16:20:18 — **rien**. Pas une ligne de journal pour ce `reqId` pendant 38 minutes.
   Les seules entrées de l'intervalle concernent une AUTRE fenêtre (`main-2`, projet ia-news).
   Dans le fil : le seul retour visible est la ligne d'appel `Agent` ; aucun outil, aucun
   texte — conséquence directe de T-092, qui a (à raison) sorti les outils des sous-agents
   du fil sans rien mettre à la place.
3. Pendant l'attente, l'utilisateur glisse « alors ? » (bulle « en cours de tour », T-087).
   Aucun point d'injection n'arrive : le fil ne reprend jamais la main tant que le sous-agent
   tourne. Aucune trace non plus (`poussesEnAttente.ts` ne journalise que le push PERDU, pas
   le push en attente).
4. 16:20:18 — « tour Claude interrompu … cause: interrompu: arrêt demandé »
   (`error_during_execution`). L'utilisateur dit avoir ATTENDU, pas arrêté ; `handleClaudeAbort`
   ne journalise rien, donc impossible de savoir si le bouton « Arrêter » a été pressé ou si
   l'indicateur d'abandon a été posé par un autre chemin.
5. L'UI affiche « Le tour s'est terminé anormalement (error_during_execution) » + « L'agent a
   terminé sans produire de réponse (résultat vide du moteur) » — une PANNE — alors que le
   journal classe la même fin en INTERRUPTION (`info`, `abandon`). Les deux couches ne disent
   pas la même chose du même événement.
6. Tour suivant (« c'est vraiment super long c'est bloqué ? ») : le modèle répond « Non, rien
   ne tourne — le lancement de l'agent a été annulé (par ton interruption) et rien n'était
   bloqué depuis : j'attendais ta main ». Faux sur toute la ligne : un sous-agent a occupé
   38 minutes, et « attendre la main » n'a jamais été proposé à l'écran. Le modèle n'a aucune
   information sur ce qui est arrivé à son sous-agent (le `tool_result` de l'`Agent` annulé ne
   lui dit ni la durée ni la cause) et comble le trou.

**Ce que ça viole.** La doctrine d'observabilité, trois fois : un travail de 38 min sans un
signe (ni fil, ni journal), une fin de tour attribuée à l'utilisateur sans preuve, et deux
libellés contradictoires pour une même fin. Le pire n'est pas le blocage, c'est que
l'utilisateur n'a eu AUCUN moyen de le distinguer d'un vrai travail en cours — et qu'à la
question directe, l'application (via le modèle) a répondu à côté.

**Ouvertures à instruire (pas encore tranché).**

- *Battement du sous-agent.* Le SDK transmet les `tool_use`/`tool_result` des sous-agents
  précisément « pour un compteur de battement » (cf. T-092). Les reverser en ligne discrète
  sous l'appel `Agent` — « sous-agent : 12 outils · dernier Bash il y a 40 s » — plutôt que
  les jeter. Avec l'heure (T-101).
- *Journal.* Une ligne `info` au lancement et à la fin de chaque sous-agent (id, description,
  durée, nombre d'outils, issue) ; une ligne `info` sur `claude.abort` (qui, quand) ; une
  ligne au dépôt d'un push, pas seulement à sa perte.
- *Cause réelle de l'abandon.* Vérifier si l'indicateur `abandon` peut être posé sans clic
  « Arrêter » (fermeture/rechargement de fenêtre, seconde fenêtre `main-2` ouverte à 16:07
  — T-086 sur les jauges partagées entre fenêtres est un suspect naturel, un `AbortController`
  partagé en serait un autre). Si oui, c'est un bug distinct à cracher au journal avec sa
  cause.
- *Un seul libellé.* `agentTurns.ts` (l. 242) et `agentTranscript.tsx` (l. 237) affichent une
  panne quand `claudeFinDeTour.ts` a classé une interruption : faire remonter la classe
  (`abandon`/`refus`/panne) jusqu'à l'UI au lieu de la déduire du seul `subtype`.
- *Push pendant un sous-agent.* Un message glissé pendant qu'un sous-agent tourne n'a pas de
  point d'injection avant des dizaines de minutes : au minimum le dire dans la bulle
  (« en attente — un sous-agent occupe le tour »), au mieux offrir l'arrêt du seul
  sous-agent.
- *Ce que le modèle sait.* Après une interruption, le prochain tour devrait recevoir un
  rappel système factuel (« ton outil `Agent` X a été annulé après N min, cause : … ») pour
  qu'il n'invente pas une version.

**Point du 2026-09-02 — le volet observabilité est posé ; les décisions d'UI restent à
instruire.** Quatre des ouvertures, celles qui ne demandaient aucun arbitrage, sont
implémentées :

1. **Le journal voit les sous-agents** : ligne `info` au lancement (id, type, description) et
   à la fin (durée, nombre d'outils observés via `parent_tool_use_id`, issue ok/erreur/annulé)
   — 38 minutes de sous-agent ne peuvent plus être 38 minutes de silence
   (sidecar/src/claude.ts).
2. **`claude.abort` laisse une trace** : ligne `info` à chaque réception, avec le tour visé et
   le demandeur (interne — timeout, orchestrateur — ou appel protocolaire direct). Un « arrêt
   demandé » dit désormais par qui.
3. **Le dépôt d'un push est journalisé** (sidecar/src/poussesEnAttente.ts), plus seulement sa
   perte — méthode, longueur, jamais le contenu.
4. **Un seul libellé pour une même fin** : sur un abandon explicite, le `done` du tour porte
   `aborted` au lieu du `error_during_execution` brut — l'UI, qui savait déjà afficher une
   interruption, cesse d'annoncer une panne pour un arrêt. Volontairement borné à l'abandon :
   un refus de permission garde son subtype technique (test `cl2` le verrouille).

**Soldé le 2026-09-19 — les trois volets d'UI.**

**1. Le sous-agent bat dans le fil.** Nouveau chunk `sous_agent_battement` : à chaque outil vu
chez un sous-agent, le sidecar émet le compteur cumulé et le dernier outil — **jamais la liste**,
que T-092 avait retirée à raison. `sousAgentsJournal.ts` les comptait déjà pour le journal ; ils
remontent maintenant jusqu'au fil au lieu d'être jetés. Côté UI, `withSousAgentBattement`
(fonction pure, `agentTurns.ts`) retrouve le bloc par `toolUseId` et une ligne discrète s'affiche
sous l'appel `Agent`, visible même bloc replié, puis disparaît dès l'arrivée du `tool_result`.
L'heure vient de `heureDiscrete.tsx` (T-101) et est prise à la SOURCE — le sidecar horodate à
l'émission — donc « il y a 40 s » ne dérive pas au re-rendu. 38 minutes de sous-agent ne peuvent
plus être 38 minutes d'écran immobile.

**2. Le message glissé est annoncé.** `sousAgentOccupaitLeTour` lit le tour clos par l'injection
et reconnaît un bloc `Task`/`Agent` sans résultat : la bulle devient « en attente — un sous-agent
occupe le tour ». Aucun état supplémentaire côté sidecar.

**L'option « au mieux » du ticket — offrir l'arrêt du SEUL sous-agent — est écartée**, et c'est
un constat, pas un renoncement de confort : le SDK n'expose aucun mécanisme d'abandon partiel.
Interrompre un sous-agent, aujourd'hui, c'est interrompre le tour.

**3. Le modèle ne comble plus le trou.** `rappelInterruption.ts` : à la clôture d'un tour
abandonné alors que des sous-agents étaient en vol, un rappel FACTUEL est mis de côté, puis
consommé une seule fois en tête du prompt du tour suivant. `run.abortDemandeur` capture au
passage qui a demandé l'arrêt (`orchestration` / `protocole`). C'est ce qui a le plus coûté à
l'utilisateur le 2026-08-29 : le modèle, n'ayant AUCUNE information sur le sort de son
sous-agent, a répondu « rien ne tournait, j'attendais ta main » — faux sur toute la ligne.

Tests : chaque volet a son test en échec contre le code d'origine, vérifié par remisage — dont
un bout en bout (`sousAgentBattementEtRappel.test.js` + sa doublure) qui lance un `Agent`,
observe deux battements cumulés, abandonne, et vérifie que le rappel est préfixé au tour suivant
puis consommé une seule fois. 51 fichiers sidecar, 791 tests UI, 0 échec.

**Un mot sur le câblage, parce qu'il a failli manquer** : le chunk et la fonction pure étaient
prêts et testés, mais l'entrée dans `CLAUDE_CHUNK_HANDLERS` (`sidecar.ts`) et l'appel dans
`envoiProjet.ts` restaient à poser — sans eux la ligne n'apparaît nulle part. Une fonctionnalité
testée de bout en bout des deux côtés et non raccordée au milieu reste une fonctionnalité
absente. Branché, et le Chat est hors sujet (il n'a pas d'outils) : un seul point de câblage.
Dérogation de taille consignée : `sidecar.ts` 1073 → 1092, du câblage protocolaire irréductible.

**Ce qui sort de ce ticket** : la cause réelle de l'abandon du 2026-08-29 n'est toujours pas
élucidée et ne peut pas l'être rétrospectivement — le journal de l'époque ne portait pas encore
le champ `demandeur` que ce ticket a ajouté. Elle part dans **T-131**, avec les chemins suspects
relevés en chemin, plutôt que de tenir ce ticket ouvert pour une question qui n'attend plus de
travail mais une récidive.

### T-101 — L'heure sur les principales actions discrètes

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-09-10

Demande utilisateur du 2026-08-29 : afficher l'heure sur les principales « fonctions
discrètes » — ces lignes non bloquantes qui informent sans interrompre le tour.

Aujourd'hui elles sont toutes muettes sur le QUAND :

- `ChatPage.tsx` : bandeau `agent-tabs__notice` de la recherche web (R9,
  `libelleAvancementWeb`) et du débordement (`libelleDebordNotice`) ;
- `chatTranscript.tsx` : l'indicateur « historique compacté (N messages résumés) » (R4) ;
- `VoiceControls.tsx` : erreur micro, progression de transcription, messages discrets du
  mode conversation.

Une ligne « Recherche web… » ou « historique compacté » lue dix minutes après coup ne dit pas
si elle date du dernier tour ou de la session d'hier — l'utilisateur ne peut pas la
rapprocher du journal (`logs/app.jsonl`, horodaté à la milliseconde) ni de la chronologie du
fil. C'est un trou dans la doctrine d'observabilité : l'événement est visible mais pas
situé.

Attendu : chaque ligne discrète porte l'heure de l'événement qu'elle décrit (`HH:MM`,
heure locale, en retrait et dans le même style discret — pas une bulle de plus), prise à
la SOURCE de l'événement (l'horodatage du signal côté sidecar/moteur quand il existe, sinon
l'instant de réception) et non au rendu, pour qu'un re-rendu ne la fasse pas dériver.
Périmètre : les quatre familles ci-dessus ; les bulles du fil ont déjà leur propre
horodatage et ne sont pas concernées. Format et placement à trancher avec l'utilisateur
sur une maquette HTML locale autonome versionnée dans `docs/` (même principe que `docs/maquette-supervision.html`) avant d'implémenter.

**Point du 2026-09-02 — la maquette est prête, à toi de trancher.**
[maquette-heures-discretes.html](maquette-heures-discretes.html) : les quatre familles, avec
pour chacune la ligne actuelle, trois variantes (heure en tête · en queue à droite · au
survol) et un choix recommandé argumenté. Recommandations posées : **en tête** pour les
bandeaux `agent-tabs__notice` (Chat comme Projets — même classe, même composant, et la queue
du bandeau « vidée » est occupée par ses boutons), **en queue** pour la compaction (rejoint le
compteur, le survol est déjà pris) et l'état vocal (le contenu de gauche bouge vite). Le
survol seul n'est retenu nulle part : invisible au tactile et à la relecture. Rien n'est
implémenté dans l'application — c'était la condition du ticket.

**Fait le 2026-09-10, sur les recommandations de la maquette** (en tête pour les bandeaux
`agent-tabs__notice`, en queue pour la compaction et l'état vocal ; le survol seul écarté
partout). Format `HH:MM`, heure locale, style discret — aucune bulle de plus.

Mécanisme dans `ui/src/heureDiscrete.tsx` : `formaterHeureDiscrete` (epoch ms ou ISO → `HH:MM`,
`null` si absent ou illisible — pas d'heure plutôt qu'une heure fausse), les deux composants de
placement `NoticeEnTete`/`NoticeEnQueue` partagés par les deux pages, et `suivreInstant`, le
repli « instant de réception ».

**Le point dur du ticket était la SOURCE de l'heure, et il a été traité famille par famille**,
parce qu'elles ne sont pas dans la même situation :

- **Compaction** (`chatTranscript.tsx`) — la meilleure des quatre : `ChatCompaction.at` existait
  déjà, posé à l'instant même où `messagesResumes` est calculé. Rien à capter, juste à faire
  descendre jusqu'à l'affichage.
- **Débord** (`ChatPage.tsx`) — l'instant est capté dans `applyDebordNotice` **avant** la lecture
  asynchrone du plafond : c'est l'heure de la DÉCISION de routage, pas celle, plus tardive, de
  l'affichage. La nuance est exactement ce que le ticket demandait.
- **Recherche web** (`ChatPage.tsx`) — le sidecar n'horodate pas ce signal : instant de réception
  du chunk, capté dans le callback. À améliorer le jour où le signal portera son heure.
- **État vocal** (`VoiceControls.tsx`) — même situation, instant de réception, une piste par
  ligne, ré-avancé à chaque nouvelle valeur.

Dans tous les cas l'instant est rangé DANS L'ÉTAT à côté du libellé, jamais lu au rendu :
`suivreInstant` ne bouge pas tant que la valeur ne change pas, donc un re-rendu (curseur,
battement de 5 s, tâche de fond) ne fait pas dériver l'heure. C'était la condition explicite du
ticket.

**Deux points relevés en passant, à ne pas perdre :**

1. Le bandeau de débord de la page Projets (`AgentPage.tsx`) n'est **plus jamais posé depuis
   T-080** — seulement effacé (voir le commentaire d'`envoiProjet.ts`). Il porte donc une heure
   qui n'a de sens qu'historiquement. Soit le signal doit revenir, soit le bandeau doit
   disparaître : en l'état c'est du code mort qui a l'air vivant.
2. Le `ConvRuntime` de la page Projets vient de `modeleProjet.ts` (partagé), là où celui du Chat
   est local : la même information s'est donc rangée à deux endroits différents. Ça a marché,
   mais c'est une asymétrie de plus entre deux pages qui font la même chose.

**Dérogations de taille consignées** (le mécanisme est sorti, seul le câblage reste) :
`ChatPage.tsx` 2673 → 2698, `AgentPage.tsx` 2895 → 2903.

### T-100 — La barre hebdo reste calée sur la semaine ISO

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-09-02

Reliquat de T-059 (volet 3) : les barres « utilisation hebdomadaire » agrègent par semaine ISO
(lundi→dimanche) alors que la fenêtre d'abonnement se réinitialise le samedi à 20:00 (lu dans
`resetsAt`). Deux jours de décalage : une barre peut mélanger deux fenêtres réelles.

Pourquoi ce n'est pas fait dans T-059 : `supervisionPeriode.ts` est l'arithmétique de dates
générique (buckets jour/semaine/mois) de TOUTE la page Supervision — il ne connaît ni
`resetsAt` ni la notion de cycle d'abonnement, et il n'offre aucune couture pour un calage
par fenêtre. Le faire proprement = faire remonter `resetsAt` jusqu'au découpage des périodes
de `SupervisionAbonnement.tsx` (sans toucher aux autres usages du module), et décider comment
nommer les barres (« S33 » n'a plus de sens pour un cycle samedi→samedi). Depuis T-059, la
barre d'une semaine amputée dit au moins « ≥ N % » : le défaut restant est le découpage, plus
le mensonge.

**Corrigé le 2026-09-02 — sans une ligne d'arithmétique de dates.** Chaque relevé porte déjà
`resetsAt`, l'échéance de la fenêtre d'abonnement en cours au moment du relevé : cette valeur
EST l'identifiant de la fenêtre. Le regroupement par semaine ISO (`summarizeByIsoWeek`) devient
un regroupement par valeur de `resetsAt` (`summarizeByResetWindow`) — deux relevés du même
`resetsAt` sont dans la même barre, quelle que soit la semaine ISO où ils tombent.
`supervisionPeriode.ts` n'est pas touché.

- Étiquette : « →JJ/MM » (date de clôture) ; tooltip : « fenêtre close le sam JJ/MM HH:MM —
  pic N % » ou « fenêtre en cours ».
- Le minorant T-059 (« ≥ ») se calcule désormais DIRECTEMENT : dernier relevé d'une fenêtre
  close à plus de 30 min de sa clôture ⇒ le pic n'a pas pu être vu (seuil documenté : cadence
  de relevé ~5 min, marge pour quelques relevés manqués). Plus simple et plus juste que la
  détection entre relevés consécutifs qu'il remplace.

Tests réécrits : deux `resetsAt` distincts dans la même semaine ISO donnent DEUX barres (le
cas échoue contre l'ancien code), minorant au seuil et de part et d'autre, fenêtre en cours
jamais marquée incertaine.

Fichiers : [SupervisionAbonnement.tsx](../ui/src/SupervisionAbonnement.tsx), [SupervisionAbonnement.test.ts](../ui/src/SupervisionAbonnement.test.ts).

### T-103 — Le refus du port 1420 propose un remède qui ne marche pas

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-28 · **Clos** 2026-08-28

Constaté le 2026-08-28 en tentant l'essai de T-095. L'utilisateur exécute la marche à suivre
affichée par le garde-fou (`pkill -f 'tauri dev' && pkill -f 'target/debug/iaction'`), relance,
et retombe sur **le même refus, mot pour mot**.

**Cause.** Vite est lancé par `tauri dev` comme processus séparé (`sh -c vite` → `node
…/node_modules/.bin/vite`) et ne descend pas avec lui. Après les deux `pkill`, il restait seul
en vie — vérifié : `ss -lptn 'sport = :1420'` désignait le PID de Vite, 2 h 31 d'existence,
plus aucun `tauri dev` ni `iaction`. Le garde-fou de T-028 refusait donc à juste titre, mais le
remède qu'il donnait ne pouvait pas fonctionner : un conseil faux est pire qu'un conseil
absent, il fait conclure que le problème est ailleurs.

**Correction.** La marche à suivre nomme les trois processus et le motif de Vite est **calculé**
depuis le répertoire du dépôt — le heredoc du message n'interpole rien (il contient des accents
graves), d'où un `echo` séparé ; un chemin en dur tuerait au passage le Vite d'un autre projet.

Fichiers : [dev.sh](../scripts/dev.sh).

### T-113 — Le `memo` du bloc en cours de streaming est annulé à chaque rendu

**Type** bug · **Prio** P3 · **Statut** ouvert · **Créé** 2026-08-30

Constaté par lecture pendant l'enquête T-095, dans `agentTranscript.tsx` :

```js
turn.status === "streaming"
  ? rawBlocks.map((b, i) =>
      i === rawBlocks.length - 1 && b.type === "text"
        ? { ...b, content: closeDanglingFence(b.content) }   // ← objet NEUF à chaque rendu
        : b)
  : rawBlocks
```

`AgentBlockView` est mémoïsé sur `block`. Recopier le dernier bloc dans un objet neuf change
son identité à chaque rendu : le `memo` ne peut jamais retenir, et le Markdown du bloc est
reparsé **même quand le texte n'a pas bougé** — donc sur les rendus déclenchés par autre chose
(curseur, tâches de fond, battement de 5 s). Les blocs précédents, eux, sont bien protégés :
ils sont rendus tels quels.

**Pourquoi seulement P3, et pas corrigé dans la foulée.** Une correction avait été écrite le
2026-08-30 (passer le bloc tel quel avec un booléen à côté, et descendre `closeDanglingFence`
dans le composant), puis RETIRÉE avec le reste du découpage de flux : elle avait été posée dans
un lot dont la mesure a montré qu'il visait à côté, et rien ne prouve que ce surcoût-ci se voie.
Le corriger sans mesure serait refaire exactement l'erreur que T-095 documente.

**À faire avant de corriger** : mesurer, sonde en main (`Ctrl+Maj+M`), la frappe pendant un tour
LONG en rendu GPU. Si `rendu` reste au niveau du repos (~49 ms), ce ticket peut rester ouvert
sans dommage — c'est une inefficacité réelle mais invisible. S'il remonte, la correction est
écrite d'avance, et elle est courte.

Fichiers : [agentTranscript.tsx](../ui/src/agentTranscript.tsx).

### T-111 — `npm run verif` tue la session de développement en cours

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-30 · **Clos** 2026-08-30

Constaté le 2026-08-30. `npm run verif` a été lancé pendant qu'une session `dev.sh` tournait,
avec l'app ouverte et utilisée. La vérification est passée (code de sortie 0, 44 fichiers de
test sidecar, 86 tests Rust). **À sa fin, plus aucun processus de l'application n'existait** :
ni `tauri dev`, ni `vite`, ni `target/debug/iaction`, ni `WebKitWebProcess`.

**Ce qui est établi.** Le binaire n'a PAS été recompilé (`mtime` inchangé, antérieur de plusieurs
heures), et `cargo test` n'a donc rien relié. Reste la piste du VERROU : `cargo test` prend le
verrou de `src-tauri/target`, que `tauri dev` utilise aussi pour ses reconstructions à chaud.
Une session qui ne peut plus reconstruire meurt, et emporte la fenêtre.

**Ce qui n'est pas établi.** La causalité. L'utilisateur peut avoir fermé l'application au même
moment ; rien ne permet de trancher, et c'est précisément l'objet de T-112.

**La piste du répertoire séparé est écartée PAR LA MESURE.** Supprimer la concurrence plutôt
que l'annoncer était la bonne idée ; `src-tauri/target` pèse **27 Go**. Un second répertoire
coûterait autant, plus une reconstruction complète à la première vérification. Le remède était
plus cher que le mal — et c'est le genre de chose qu'on ne sait qu'en mesurant avant d'écrire.

**Corrigé** : `verif` commence par `scripts/session-en-cours.mjs`, qui sonde le port 1420 et
REFUSE de démarrer si une session tourne. En tête de chaîne, avant les trois minutes de tests —
un garde-fou qui prévient après coup ne prévient de rien. Le refus nomme le risque, le ticket,
et l'échappatoire : `IACTION_VERIF_FORCE=1 npm run verif` passe outre en le disant (un forçage
silencieux ferait croire la vérification inoffensive).

La décision est séparée de la sonde réseau et testée pour elle-même (9 vérifications) : un
garde-fou dont on ne peut pas exercer la décision est un garde-fou qu'on n'ose pas modifier —
donc qu'on finit par désactiver.

**Ce ticket reste réversible sur preuve.** La causalité n'est toujours pas établie ; T-112 est
l'instrument qui la tranchera. Le jour où l'application dira elle-même comment elle s'est
arrêtée, ce refus sera levé ou confirmé sur constat, pas sur soupçon.

Fichiers : [session-en-cours.mjs](../scripts/session-en-cours.mjs), [session-en-cours.test.mjs](../scripts/session-en-cours.test.mjs), [package.json](../package.json).

### T-112 — L'application peut disparaître sans laisser une seule ligne au journal

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-30 · **Clos** 2026-08-30

Constaté le 2026-08-30, en cherchant la cause de T-111. L'application a cessé d'exister — les
cinq processus compris — et `app.jsonl` ne porte AUCUNE entrée après le dernier relevé de sonde.
Ni arrêt normal, ni erreur, ni trace de mort du WebKitWebProcess.

**Pourquoi c'est P1 malgré l'apparence anodine.** La doctrine du projet tient en une phrase :
*aucun échec muet*. Une application qui disparaît sans rien écrire est l'échec muet maximal —
il ne reste littéralement rien à lire. Et ce n'est pas théorique : c'est ce qui a empêché de
trancher T-111 le jour même, à deux mètres du clavier. Le même trou rendra indiagnosticable
n'importe quelle disparition future, y compris chez un utilisateur qui ne sait pas ce qu'est
un processus.

`webview_vie.rs` couvre déjà le cas du WebKitWebProcess qui meurt. Le cas non couvert est
l'inverse : la coquille elle-même s'arrête, normalement ou non.

**Corrigé — et pas seulement par une ligne à l'arrêt.** Une ligne écrite au moment de l'arrêt
ne couvre que les arrêts qui laissent le temps de l'écrire : `RunEvent::Exit` ne survient ni sur
`SIGKILL`, ni sur une coupure de courant, ni si la coquille plante — c'est-à-dire précisément
les cas où l'on a besoin de savoir. **On ne peut pas journaliser sa propre mort subite ; on peut
constater sa propre résurrection.**

D'où l'inversion : chaque session pose un TÉMOIN sur disque à son ouverture et le retire à sa
fermeture propre. Un témoin qui survit est la preuve d'un arrêt brutal, et il est trouvé au
démarrage suivant — sans qu'aucun code n'ait eu à s'exécuter au moment de la mort. Le journal
porte donc désormais trois lignes possibles : `session ouverte`, `session fermée`, et
`session précédente arrêtée sans trace` (avec le PID et l'heure d'ouverture de la morte).

Deux pièges traités, parce qu'un journal qui accuse à tort est pire qu'un journal muet — on
cesse de le croire :

- **un témoin par PROCESSUS** (`session-<pid>.json`), et non un fichier unique : deux instances
  peuvent coexister (constaté le même jour). Avec un fichier unique, la seconde écraserait le
  témoin de la première, dont la fermeture propre effacerait celui de la seconde, et le
  démarrage suivant accuserait un arrêt brutal qui n'a pas eu lieu ;
- **un témoin dont le processus vit encore n'est pas un cadavre** : c'est une autre session, on
  n'y touche pas. Détection par `/proc/<pid>`, qui n'envoie aucun signal — donc aucun effet de
  bord sur un processus qui ne nous appartient pas.

Écriture directe dans `coquille.jsonl` par le Rust, sans passer par le sidecar ni l'UI : au
moment où ces lignes comptent, ils peuvent être déjà morts.

Fichiers : [session_vie.rs](../src-tauri/src/session_vie.rs), [lib.rs](../src-tauri/src/lib.rs), [webview_vie.rs](../src-tauri/src/webview_vie.rs).

### T-095 — La frappe traîne toujours : le rendu logiciel ÉTAIT le plafond

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-28 · **Soldé** 2026-08-30

**Quatrième signalement** (2026-08-19 → T-083, puis relances ; à nouveau le 2026-08-28, capture
à l'appui : fenêtre plein écran sur le 4K, conversation VIDE, « c'est encore lent quand je
tape »). Deux tickets ont déjà été soldés sur ce symptôme — T-031 (tout coût JS par frappe
retiré) et T-083 (la couche plein écran à composer). Le symptôme revient : c'est que la cause
restante n'est pas dans l'application.

**Ce qui a été mesuré cette fois — l'environnement d'exécution, pas le code.**

- L'app qui tourne (PID vérifié le 2026-08-28, `target/debug/iaction`, lancée par
  `scripts/dev.sh`) porte `WEBKIT_DISABLE_DMABUF_RENDERER=1` dans son environnement. Le
  WebKitWebProcess rastérise donc **tout au processeur**, sur 3840 × 2109 px.
- Ce n'est pas propre à la session de développement : le lanceur du bureau
  (`~/.local/share/applications/iaction.desktop`) appelle `scripts/dev.sh`. L'app quotidienne
  est *toujours* en rendu logiciel.
- Le flag a été posé le **2026-07-31** contre une fenêtre blanche au lancement (crash dmabuf,
  pilotes NVIDIA). Or `libwebkit2gtk-4.1-0` est passé en **2.52.3 le 2026-08-06** (journal
  dpkg), soit **après** le crash. Personne n'a retenté le rendu GPU depuis.

Autrement dit : T-031 et T-083 ont retiré ce qui pouvait l'être *au-dessus* d'un plancher
imposé par une ligne de `dev.sh`. Tant que la peinture est au CPU sur un 4K, chaque nouvelle
surface ajoutée à l'écran rapproche du plafond, et le symptôme revient — d'où les quatre
signalements.

**Fait** — le repli devient une décision qu'on peut réexaminer sans éditer le script :
`IACTION_GPU=1 ./scripts/dev.sh` relance avec le rendu GPU. Le défaut ne change pas (une app
rapide qui ne démarre plus n'est pas un progrès) ; fenêtre blanche ⇒ le défaut est toujours là,
on relance sans la variable.

**Premier essai, le 2026-08-28 : il n'a pas eu lieu.** Retour utilisateur « j'ai passé le
script mais c'est toujours pareil ». Vérification par les processus : la fenêtre en service
datait de 1 h 47, portait toujours `WEBKIT_DISABLE_DMABUF_RENDERER=1`, et aucune autre instance
n'existait. Le garde-fou du port 1420 (T-028) avait refusé le lancement — une session tournait
déjà — et son message part sur stderr, invisible quand l'app vit dans le lanceur du bureau.
**Un essai demandé et refusé s'était lu comme un essai fait, et avait conclu.** Corrigé : le
refus nomme désormais ce qui n'a pas eu lieu (`dev.sh`, message et notification dédiés). La
règle de fond, encore : vérifier D'ABORD quel code s'exécute.

**Attendu de l'essai** (à faire par David, l'app ne se lance pas depuis un agent — et la session
en cours doit être ARRÊTÉE avant, sans quoi l'essai est refusé) : si la
fenêtre s'ouvre normalement, taper dans le composeur plein écran et comparer. Deux issues, les
deux utiles :

- fluide ⇒ la cause est identifiée et le repli n'a plus lieu d'être par défaut ; le ticket se
  ferme sur ce constat, et les mesures esthétiques prises en attendant (fonds `--bg-1/2/inset`
  opacifiés, dégradé du `body` remplacé par un aplat — posées dans l'arbre de travail sous le
  numéro **T-088, qui n'existe dans aucun backlog**) peuvent être annulées ;
- toujours lent, ou fenêtre blanche ⇒ la cause est ailleurs, et l'enquête reprend AVEC UN
  INSTRUMENT (latence frappe → frame, suspects isolables à chaud) plutôt qu'en relisant le CSS
  une quatrième fois. C'est la leçon explicite de T-031, réaffirmée par T-083.

**À noter pour la suite** : le numéro T-088 a été consommé par une mesure posée dans le code
(`ui/src/theme.css`, commentaire « MESURE T-088 ») sans qu'aucun ticket ne soit écrit. Une
enquête sans trace, c'est une enquête à refaire — et c'est une part de la raison pour laquelle
ce sujet paraît repartir de zéro à chaque signalement.

**Cinquième signalement, le 2026-08-30** — « c'est encore lent à taper, pas aussi lent
qu'avant mais quand même assez lent ». Deux faits, relevés sur les processus avant toute
lecture de code :

1. **L'essai GPU n'a toujours pas eu lieu.** La fenêtre en service (lancée depuis 2 h 06)
   porte encore `WEBKIT_DISABLE_DMABUF_RENDERER=1` dans son environnement, et c'est le seul
   `iaction` vivant. Le mieux constaté ne vient donc PAS d'un changement de renderer : il vient
   des mesures esthétiques posées entre-temps. Le plancher décrit plus haut est intact.
2. **Le « moins lent qu'avant » n'est chiffré nulle part.** C'est le cinquième tour de la même
   boucle : un ressenti entre, un ressenti sort, et la comparaison d'un signalement à l'autre
   repose sur la mémoire. C'est ce que le paragraphe précédent annonçait comme condition de
   reprise — reprendre AVEC UN INSTRUMENT.

**Fait le 2026-08-30 — l'instrument existe.** Sonde de latence de frappe, éteinte par défaut,
sans effet tant qu'elle n'est pas allumée (son seul coût permanent est un test `Ctrl+Alt` en
tête d'un écouteur `keydown`) :

- `Ctrl+Maj+M` allume la sonde et son afficheur. Elle sépare les deux moitiés du trajet, parce
  qu'elles n'accusent pas le même coupable : **attente** (horodatage système de la touche →
  entrée dans le JS : fil principal occupé, donc l'application) et **rendu** (JS → trame
  suivant la peinture, par double `requestAnimationFrame` : mise en page et rastérisation, donc
  le CSS ou le renderer). Médiane, p95 et maximum pour chacune.
- `Ctrl+Maj+D` (dénuder) retire les suspects d'affichage **à chaud**, par paliers cumulés (ombres et
  lueurs → + animations → + fonds et arrondis), sans relancer ni recompiler. Le palier qui fait
  chuter la ligne « rendu » nomme le coupable ; si aucun ne la fait chuter, le coût n'est pas
  dans la feuille de style, et l'enquête doit sortir de l'UI — ce qui clôt définitivement la
  série des relectures de CSS.
- `Ctrl+Maj+B` (bilan) consigne le relevé au journal applicatif AVANT de remettre à zéro. Une mesure
  sans trace est une mesure à refaire : c'est la cause explicite du sentiment de repartir de
  zéro à chaque signalement.

Protocole : allumer, taper une phrase entière (au moins 30 caractères), lire p95 ; changer UN
seul paramètre, `Ctrl+Maj+B`, retaper la MÊME phrase. Comparer des p95, jamais des impressions.

**Le même jour, une piste qui n'avait jamais été formulée.** Immédiatement après le
rechargement à chaud provoqué par la pose de la sonde, retour utilisateur : « mais là ça
fonctionne mieux, il y a eu une mise à jour ? ». Non — le code posé ce jour-là ne rend rien
plus rapide : la sonde était ÉTEINTE, aucun palier « nu » n'était appliqué, et elle *ajoute*
un écouteur `keydown`. La seule chose qui a changé pour cette fenêtre, c'est que **Vite a
rechargé la page**.

Si un simple rechargement rétablit la fluidité, alors le coût ne vient ni de la feuille de
style ni du renderer : il **s'accumule avec la durée de vie de la page**. Et cette hypothèse
explique d'un coup la forme entière du dossier — chacune des corrections précédentes a été
jugée juste après un relancement, donc sur une page neuve, donc au meilleur de sa forme ; le
symptôme « revenait » parce qu'il n'avait jamais été corrigé, seulement remis à zéro.

Vérification faite sur les minuteurs : rien qui s'accumule (battements bornés à 5 s sur des
composants isolés, écouteurs globaux installés une seule fois). L'hypothèse ne se tranche donc
pas par relecture — elle est INSTRUMENTÉE : l'afficheur porte désormais l'âge de la page et son
nombre de nœuds DOM, et le relevé journalisé aussi (`page_min`, `noeuds_dom`). Un p95 relevé à
5 min puis à 3 h sur la MÊME phrase confirme ou enterre.

**PREMIER RELEVÉ, le 2026-08-30 à 11 h 45 — et il renverse le dossier.** Page de 10 minutes,
mode « nu » sur *aucun*, fenêtre 5120 × 2786 px, 57 caractères mesurés :

| | p50 | p95 | max |
|---|---|---|---|
| **attente** (touche → JS) | **2 681 ms** | **4 739 ms** | — |
| **rendu** (JS → image peinte) | 306 ms | 343 ms | — |
| **total** | 2 993 ms | 5 082 ms | 5 269 ms |

Trois conclusions, toutes fermes :

1. **Le coût est dans le FIL PRINCIPAL, pas dans le dessin.** Une touche attend 2,7 s en
   médiane avant que le JavaScript ne la voie. Le rendu, lui, est dix fois moindre — et encore
   est-il lui-même gonflé par le même blocage, puisqu'un `requestAnimationFrame` est servi par
   ce fil saturé. Le CSS et le rendu logiciel ne peuvent pas expliquer 2,7 s : ils
   n'interviennent qu'APRÈS. **Quatre enquêtes ont donc cherché la cause dans la seule moitié
   du trajet qui était innocente.**
2. **L'hypothèse d'accumulation est enterrée le jour même où elle est née** : la page avait
   10 minutes et portait **450 nœuds DOM**. Ni le poids du document, ni l'âge de la page. Le
   mieux ressenti après le rechargement à chaud était une coïncidence — et sans l'instrument,
   c'est une cinquième piste qu'on aurait remontée pour rien.
3. **Le symptôme décrit correspond exactement au chiffre** : « ça continue à écrire » après
   avoir lâché le clavier, c'est une FILE qui se vide. Les touches s'empilent pendant que le
   fil est occupé ailleurs.

**RELEVÉ DE CONTRÔLE, 11 h 59 et 12 h 00 — la cause est nommée.** Même page, même journée :

| heure | contexte | attente p50 | rendu p50 | total p50 | n |
|---|---|---:|---:|---:|---:|
| 11 h 45 | un tour écrit | 2 681 ms | 306 ms | 2 993 ms | 57 |
| 11 h 59 | **au repos** | **3 ms** | **9 ms** | **13 ms** | 101 |
| 12 h 00 | un tour écrit | 2 630 ms | 302 ms | 2 929 ms | 39 |

**225× d'écart, reproductible à 2 %.** Au repos, l'application est irréprochable : 9 ms pour
peindre une frappe sur 5120 × 2786 px EN RENDU LOGICIEL. Le CSS est innocent, le rendu
logiciel est innocent, et l'essai `IACTION_GPU=1` — qui portait tout le ticket depuis le
2026-08-28 — n'aurait rien donné. Les mesures esthétiques prises « en attendant » (T-088)
soignaient un symptôme qui n'existait pas.

**Le mécanisme.** T-031 a plafonné la FRÉQUENCE des rendus pendant un flux (~12 images/s ; voir
`creerRythme` dans useConversationRuntime.ts). Il n'a pas touché au COÛT d'un rendu. Or à
chaque image, `chatTranscript.tsx:43` re-parse le message en cours DEPUIS LE DÉBUT
(`<Markdown content={closeDanglingFence(entry.content)} />`) : le coût croît avec la longueur
de la réponse, donc le coût total d'un tour croît avec son CARRÉ. 302 ms par rendu × 12 par
seconde = 3,6 s de travail par seconde : le fil principal est saturé à 360 %, et les touches
attendent leur tour dans la file du compositeur — d'où « ça continue d'écrire » quand on lâche
le clavier.

Ce mécanisme explique aussi la forme du dossier : plus les réponses s'allongent, plus c'est
lent, et personne n'avait jamais mesuré PENDANT un tour. La lenteur n'était pas dans
l'application au repos, qui est la seule chose que quatre enquêtes ont regardée.

**CORRIGÉ le 2026-08-30 — le texte déjà reçu cesse d'être reparsé.** Le texte déjà arrivé ne
change plus jamais : seule la fin bouge. La bulle en cours est donc coupée à la dernière
frontière de bloc (`couperFluxStreaming`, fluxIncremental.ts) et rendue en DEUX parts. La part
stable garde le même `content` d'une image à l'autre : le `memo` de `Markdown` la reconnaît et
ne la reparse pas. Seule la queue — le dernier bloc — est reparsée douze fois par seconde. Le
prix d'une image cesse de croître avec la réponse.

Trois précautions, chacune adressant un mode de panne précis :

- **Aucun changement visible.** Les deux parts partagent UN SEUL `div.md` (nouvelle option
  `enveloppe={false}` de `Markdown`) : deux enveloppes successives casseraient
  `.md > *:first-child { margin-top: 0 }` à la couture, et le texte se resserrerait pendant
  l'écriture avant de se ré-espacer à la fin. Le DOM produit est celui d'avant, à l'identique.
- **La coupe ne tombe jamais dans une clôture de code.** Une ligne vide au milieu d'un bloc
  ``` n'est pas une frontière : couper là donnerait deux fragments dont aucun n'est du Markdown
  valide, et le rendu changerait sous les yeux de l'utilisateur. `closeDanglingFence` ne
  s'applique donc qu'à la queue, seule part pouvant porter une clôture encore ouverte.
- **La coupe ne recule jamais.** C'est le mode de panne SILENCIEUX de cette correction : si la
  frontière reculait quand le message s'allonge, la part stable changerait à chaque image, le
  `memo` serait annulé, et la lenteur reviendrait sans que rien ne le signale — soit un sixième
  signalement. Deux tests tiennent cette propriété (monotonie de la coupe, et « la part stable
  est toujours un préfixe du message final »).

**RELEVÉ D'APRÈS CORRECTION, 14 h 41 — la correction ne touche PAS le coût dominant.**
Page de 2 minutes (application relancée par l'utilisateur à 14 h 40), 30 caractères :

| | attente p50 | **rendu p50** | total p50 |
|---|---:|---:|---:|
| avant correction (12 h 00) | 2 630 ms | **302 ms** | 2 929 ms |
| après correction (14 h 41) | 1 361 ms | **317 ms** | 1 663 ms |

`rendu` est INCHANGÉ. Or c'est lui qui mesure le prix d'une image. Le re-parse du Markdown
n'était donc pas le terme dominant : la corrélation « lent pendant un tour » était réelle, mais
l'explication qu'on en a tirée était fausse — et elle a été écrite en code avant d'être
vérifiée par la mesure, alors que l'instrument pour la vérifier existait déjà. **C'est la même
erreur de méthode que les quatre enquêtes précédentes, commise avec l'instrument sous la
main.**

Trois indices convergents disent où chercher, tous arrivés du même retour utilisateur :

1. `rendu` vaut ~300 ms quel que soit le contenu (302, 306, 317, 334 sur quatre relevés) : un
   coût FIXE par image, pas un coût proportionnel au texte.
2. `noeuds_dom` vaut ~455 dans TOUS les relevés, rapides comme lents. La transcription n'est
   donc pas ce qui coûte.
3. « Ça marche bien sur les fenêtres avec de l'historique mais très lent pour les nouvelles »,
   et « le clignotement dans Orchestration est encore plus lent ». Une animation qui ralentit,
   c'est une cadence d'images effondrée — donc un coût par image, cohérent avec (1).

**L'instrument mentait par omission — corrigé le 2026-08-30.** La première bissection est
revenue étiquetée `nu: aucun` (relevé de 14 h 48, n=125, `rendu p50` = 304 ms) alors que la
mesure avait selon toute vraisemblance été prise sous le palier 3 : le palier était lu au
moment du BILAN, pas au moment des mesures, et la consigne donnée invitait à rétablir
l'affichage avant de consigner. **Une mesure juste sous une étiquette fausse est pire qu'une
mesure absente** — elle se recopie dans un ticket et sert de preuve. Deux verrous posés, plutôt
qu'une consigne d'usage à retenir : changer de palier VIDE les compteurs (un registre
n'appartient qu'à un palier), et un bilan sans aucune mesure ne s'écrit pas au journal.

**Et le raccourci de bissection n'atteignait pas le code.** Deux relevés de suite sont revenus
`nu: aucun` APRÈS la pose des verrous — or changer de palier vide les compteurs, donc le palier
n'avait jamais changé. Rien dans l'application ne capte `Ctrl+Maj+D`, et l'écouteur de la sonde
passe avant React : la touche était donc avalée plus haut (bureau, WebKit), ou n'est pas
partie. Ce n'est pas vérifiable depuis le code, et ce n'est pas à l'utilisateur de refaire trois
fois la même manipulation pour en avoir le cœur net — c'est le troisième aller-retour perdu sur
une commande invisible (après `IACTION_GPU` refusé en silence et `Ctrl+Alt+M` capté par
Thunderbird). L'afficheur porte désormais TROIS BOUTONS (palier, bilan, fermer) : un bouton ne
peut être intercepté par personne, et il MONTRE l'état au lieu de le supposer. Le clic ne vole
pas le focus de la zone de frappe (`mousedown` annulé), sans quoi chaque étape de la bissection
commencerait par un clic au lieu d'une touche.

**BISSECTION FAITE, 15 h 04 — le CSS est innocent, et ce n'est plus une opinion.**

| | attente p50 | **rendu p50** | total p50 | n |
|---|---:|---:|---:|---:|
| palier 0 | 2 473 ms | **311 ms** | 2 784 ms | 28 |
| **palier 3** (ni ombres, ni lueurs, ni animations, ni fonds, ni arrondis) | 2 419 ms | **293 ms** | 2 717 ms | 45 |

6 % d'écart : du bruit. **Cinq enquêtes ont relu cette feuille de style ; elle n'y est pour
rien.** Le clignotement qui ralentit dans Orchestration est une victime, pas un coupable — une
cadence d'images effondrée se voit d'abord sur ce qui bouge.

**Ce qui reste, et pourquoi c'est cohérent.** `rendu` vaut ~300 ms sur SIX relevés (293, 302,
304, 306, 311, 317), quels que soient le contenu, la page, le nombre de nœuds et le palier. Un
coût fixe, insensible à tout ce que l'interface fait — c'est la signature d'un coût qui n'est
pas dans l'interface. Or la fenêtre fait 5120 × 2786 px, soit **14,3 Mpixels**, et la
rastérisation est intégralement au processeur (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, toujours
posé). Un repeint plein cadre à cette taille représente ~57 Mo à composer et écrire : l'ordre
de grandeur tombe pile sur les 300 ms mesurés. Et `attente` ≈ 2,5 s, c'est la file des touches
derrière quelques repeints de ce prix.

L'essai `IACTION_GPU=1`, réclamé par ce ticket depuis le 2026-08-28 et jamais réalisé (deux
refus silencieux), redevient **la seule piste** — mais cette fois avec une référence chiffrée
pour le juger : six relevés à ~300 ms de `rendu`, et un état au repos à 9 ms qui prouve que la
même fenêtre SAIT peindre vite.

**SOLDÉ le 2026-08-30 — le rendu GPU, et la mesure qui le prouve.** Essai enfin réalisé
(processus vérifié : PID lancé à 17 h 07, `IACTION_GPU=1`, plus aucun
`WEBKIT_DISABLE_DMABUF_RENDERER`, une seule instance). **La fenêtre s'est ouverte normalement**
— le crash dmabuf de juillet a bien été réglé par `libwebkit2gtk` 2.52.3 du 2026-08-06, et le
repli aura survécu 24 jours à sa raison d'être. Même fenêtre, même phrase, même sonde :

| | attente p50 | rendu p50 | **total p50** | n |
|---|---:|---:|---:|---:|
| rendu logiciel | 2 473 ms | 311 ms | **2 784 ms** | 28 |
| **rendu GPU** | **6 ms** | **49 ms** | **64 ms** | 182 |

**43 fois.** Le défaut de `dev.sh` change donc de camp : le GPU est le défaut, et le repli
logiciel reste accessible par `IACTION_CPU=1` pour le jour où un pilote régresse.

**Ce que ce ticket aura vraiment coûté, et pourquoi.** Cinq signalements, quatre enquêtes, deux
tickets soldés sur le mauvais coupable, et une correction (le découpage du flux Markdown)
écrite sur une corrélation avant d'être vérifiée. La cause tenait en UNE LIGNE d'un script de
lancement, posée contre un bug corrigé depuis. Trois causes racines de méthode, toutes
documentées ci-dessus :

1. **Personne ne mesurait.** Quatre enquêtes ont relu du CSS. La bissection au palier 3 a
   innocenté toute la feuille de style en une minute — elle aurait pu être faite le premier jour.
2. **Trois commandes ont échoué en SILENCE** : `IACTION_GPU=1` refusé deux fois par le garde-fou
   du port (message sur stderr, invisible), puis `Ctrl+Alt+M` capté par le lanceur GNOME, puis
   `Ctrl+Maj+D` avalé on ne sait où. Chaque fois, un essai demandé et non effectué s'est lu
   comme un essai fait, et a conclu. C'est la doctrine d'observabilité du projet prise à revers :
   les échecs muets ne sont pas seulement dans l'application, ils sont dans l'OUTILLAGE.
3. **On mesurait au mauvais endroit.** 95 % des interactions ont lieu sur la page Projets ; la
   première correction a été posée sur le Chat. Savoir où l'utilisateur passe son temps fait
   partie de la mesure.

**Reste ouvert, hors de ce ticket** : `rendu` vaut 49 ms en GPU, contre 9 ms relevés au repos en
logiciel. Un repeint plein cadre subsiste donc, simplement devenu indolore. Ce qui déclenche
l'invalidation totale n'est toujours pas identifié — à ouvrir en ticket propre si un écran plus
grand le fait ressortir. Quant au découpage du flux Markdown (`fluxIncremental.ts`), posé sur
une hypothèse fausse et jamais validé par une mesure, il a été **RETIRÉ le 2026-08-30** sur
décision de l'utilisateur — le commit 7f4c9b5 l'introduit, le suivant l'enlève. Il retirait un
coût réel (quadratique) et ses dix tests le tenaient, mais un dépôt se porte mieux sans une
correction que personne ne peut justifier : la mesure avait montré que `rendu` ne bougeait pas
(302 → 317 ms), donc que ce coût n'était pas le terme dominant. Ce qui reste de cette
exploration est consigné en T-113, à trancher par la mesure et non par l'intuition. Palier 3 d'abord
(tout retiré) : s'il ne fait pas chuter `rendu`, le CSS est entièrement innocent et la cause est
sous la webview.

**Reste à faire, et le ticket ne se ferme pas avant :** un relevé APRÈS correction, pendant un
tour, avec la sonde. C'est la seule chose qui distingue une correction d'une hypothèse — et
c'est exactement ce qui a manqué à T-031 et T-083, tous deux clos sur un ressenti. Attendu :
`attente` doit s'effondrer vers les 13 ms du repos. Si elle descend sans y arriver (par exemple
150 ms), il reste un coût par image, et la suite est connue : rendre la part stable comme une
LISTE de blocs mémoïsés un à un, ce qui rend le coût total linéaire au lieu de rester
quadratique en nombre de blocs.

**La page Projets était LA page concernée — corrigée dans la foulée.** Premier réflexe : ne pas
la toucher sans mesure, puisqu'elle rend déjà bloc par bloc. Erreur, corrigée par un retour
utilisateur : « c'est justement sur les projets que j'ai 95 % des interactions ». Vérification
faite plutôt que supposée — les deux relevés lents encadrent des lignes `serveurs MCP du tour`,
émises par `sidecar/src/claude.ts:922`, c'est-à-dire le moteur de la page **Projets**. La
correction avait donc atterri sur la page où le défaut n'avait PAS été mesuré. Leçon à ajouter
à celles de ce ticket : savoir OÙ l'utilisateur passe son temps fait partie de la mesure.

Le fil des Projets portait le même défaut, plus un second :

- même re-parse du bloc en cours depuis le début à chaque fragment — le découpage `enCours` y
  est appliqué à l'identique (dernier bloc texte d'un tour en streaming) ;
- **le `memo` d'`AgentBlockView` était annulé à tous les coups** : la liste recopiait le dernier
  bloc dans un objet NEUF à chaque rendu (`{ ...b, content: closeDanglingFence(b.content) }`),
  y compris quand le texte n'avait pas bougé et que le rendu venait d'ailleurs (curseur, tâches
  de fond, minuteur). Le bloc est désormais passé TEL QUEL, avec un booléen à côté ; la
  fermeture de clôture descend dans le composant, où elle ne s'applique qu'à la queue.

**Le namespace Ctrl+Alt est inutilisable sur ce poste** (constaté le 2026-08-30, à la première
tentative d'allumage : `Ctrl+Alt+M` a ouvert Thunderbird). GNOME en a fait son lanceur
d'applications — relevé dans `custom-keybindings` : t, k, m, w, z, v, c, s, e, b, f, i sont
tous pris, IAction elle-même y est sur `Ctrl+Alt+I`. Un raccourci capté par le bureau
n'atteint jamais la webview, et surtout **ça ne se voit pas** : la touche ne fait rien, ce qui
est indiscernable d'un instrument en panne. Les raccourcis sont passés en `Ctrl+Maj` (libre
côté GNOME, qui n'y réserve que des combinaisons à trois modificateurs ; l'application n'y
utilise que N, L, P, Z et Tab), et un repli sans aucun raccourci est exposé sur
`window.sondeFrappe` (`allumer()`, `eteindre()`, `denuder()`, `bilan()`).

Reste dû par le ticket, dans cet ordre : (0) **un relevé jeune puis un relevé vieux**, sur la
même phrase, sans rechargement entre les deux — c'est la piste la plus prometteuse, et la
moins coûteuse à écarter ; (1) un relevé de référence sur la fenêtre actuelle,
en rendu logiciel ; (2) la bissection par les paliers ; (3) l'essai `IACTION_GPU=1` — qui exige
l'arrêt de la session en cours, et un relevé avant/après avec la même phrase.

Fichiers : [fluxIncremental.ts](../ui/src/fluxIncremental.ts), [chatTranscript.tsx](../ui/src/chatTranscript.tsx), [agentTranscript.tsx](../ui/src/agentTranscript.tsx), [Markdown.tsx](../ui/src/Markdown.tsx), [sondeFrappe.ts](../ui/src/sondeFrappe.ts), [raccourcisClavier.ts](../ui/src/raccourcisClavier.ts), [dev.sh](../scripts/dev.sh), [App.css](../ui/src/App.css).

### T-086 — Deux fenêtres, deux fois les sondes

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-20 · **Clos** 2026-09-19

Constat utilisateur du 2026-08-20, capture du panneau Journal à l'appui : la même ligne, **en
double à la même seconde**, toutes les 5 minutes.

```
17:20:47  error  ui  échec du micro-tour d'initialisation : Claude Code returned an error
17:20:47  error  ui  échec du micro-tour d'initialisation : Claude Code returned an error
17:15:48  error  ui  … result: You've hit your session limit · resets 7:10pm (Europe/Paris)
17:15:47  error  ui  … result: You've hit your session limit · resets 7:10pm (Europe/Paris)
```

**Ce n'est pas un doublon d'affichage, ce sont deux appels.** Les `reqId` le prouvent : les
lignes du 2026-08-20 portent **deux préfixes de fenêtre distincts** — `req-zdwpg5-*` et
`req-qyy3jp-*` — c'est-à-dire le préfixe d'ids par fenêtre posé par T-062. Comptage sur
`app.jsonl` :

| Jour | Fenêtres | `usage.claude.init` en échec | `usage.credits` en échec (T-085) |
|---|---|---:|---:|
| 2026-08-18 | 1 (`y5rb4r`) | 41 | 611 |
| 2026-08-20 | 2 (`zdwpg5`, `qyy3jp`) | **50 + 50** | **684 + 687** |

Le facteur est exactement deux, sur les deux jauges, sans exception.

**Cause.** Le « cron » de l'encart conso vit dans un effet de `App.tsx`
([App.tsx:335](../ui/src/App.tsx#L335), `USAGE_REFRESH_INTERVAL_MS`) — donc **par fenêtre**.
Depuis T-062, une seconde fenêtre monte un second `App`, avec ses propres minuteurs. Les
garde-fous existants (`initInFlight`, `lastInitAt`, `CLAUDE_INIT_MIN_GAP_MS`) sont des variables
locales à l'effet : ils protègent contre la rafale **à l'intérieur d'une fenêtre**, et sont
structurellement incapables de dédoublonner entre fenêtres.

**Pourquoi c'est P1 et pas du simple bruit.** Le relevé d'abonnement n'est pas une lecture : le
micro-tour d'initialisation est un **vrai tour Claude** ([claudeUsage.ts](../sidecar/src/claudeUsage.ts),
voir T-059). La sonde qui mesure la saturation de l'abonnement **consomme la ressource qu'elle
mesure** — et elle le fait désormais deux fois par cycle, sur un compte qui, au moment du
constat, répondait précisément « You've hit your session limit ». Le bruit dans le journal
(T-057, T-085) n'est que la partie visible.

**À faire.** Le relevé est une donnée de PROCESSUS, pas de fenêtre : il doit remonter côté
sidecar (une seule cadence, un seul appel, diffusion à toutes les fenêtres — exactement la
propriété que T-062 revendiquait pour le statut du sidecar et l'encart d'usage), ou à défaut
être tenu par un verrou partagé entre fenêtres. Le corollaire vaut pour toute jauge périodique
future : **tout minuteur posé dans `App.tsx` est multiplié par le nombre de fenêtres**, et rien
aujourd'hui ne le rappelle à qui en ajoute une.

**Deux détails relevés au passage**, à corriger dans le même geste :

1. le commentaire du bloc dit « puis via le cron de 20 min » alors que `USAGE_REFRESH_INTERVAL_MS`
   vaut **5 min** — un commentaire faux sur la cadence d'une sonde, juste au-dessus du code qui
   la fixe ;
2. l'heure de réinitialisation est **connue et annoncée** par le message (« resets 7:10pm »), et
   pourtant la sonde repart toutes les 5 min jusque-là — ~24 tentatives par heure et par fenêtre
   dont l'échec est certain. C'est le volet « refus non entendus » de T-059, désormais daté.

**Corrigé le 2026-08-20 — un seul releveur, quel que soit le nombre de fenêtres.**

Le bail de cadence vit dans `localStorage` ([cadenceUsage.ts](../ui/src/cadenceUsage.ts)),
le seul canal que deux webviews du même processus partagent sans passer par le sidecar. Il
porte l'identité de fenêtre qui préfixe déjà les `reqId` — donc le journal dit lequel des
`req-xxxxxx-*` sondait, sans qu'on ait rien ajouté à la ligne.

- **Ce qui reste par fenêtre** : `usage.claude`, qui relit l'instantané déjà tenu par le
  sidecar. Aucun réseau, aucun quota — c'est ce qui garde les deux fenêtres justes sans les
  faire sonder. Les non-releveuses complètent avec le cache disque que la releveuse écrit.
- **Ce qui est réservé au releveur** : `usage.credits` (réseau) et le micro-tour
  `usage.claude.init` (vrai tour Claude).
- **Péremption plutôt que libération propre** : une fenêtre tuée (T-056) ne libère rien. Le
  battement est à 30 s, le bail expire à 90 s : la reprise coûte au pire une minute et demie
  de relevé figé. Une fenêtre promue relève immédiatement, sans attendre le cron.

Preuve : `ui/src/cadenceUsage.test.ts` — 10 cas, dont les deux qui comptent (« la seconde
fenêtre ne prend PAS le bail » et « une fenêtre morte SANS libérer le laisse périmer »).

Le cliquet a été payé par des EXTRACTIONS, pas par une dérogation : `App.tsx` rend son encart
conso (1 025 → 533 lignes, [encartConso.tsx](../ui/src/encartConso.tsx)), `sidecar.ts` rend ses
helpers conso ([consoClient.ts](../ui/src/consoClient.ts)), `engine.ts` rend `usage.credits`
([creditsFournisseur.ts](../sidecar/src/creditsFournisseur.ts)).

**Statut `en cours`, pour une raison précise et une seule** : que deux webviews Tauri partagent
bien `localStorage` n'a pas été VÉRIFIÉ dans l'application lancée — ce qui appartient à
l'utilisateur. Le repli est sûr (stockage indisponible ⇒ chaque fenêtre se croit seule, soit
exactement le comportement d'avant ce correctif, jamais pire), mais un repli silencieux qui
serait pris pour un correctif serait la faute que ce backlog reproche partout ailleurs.

**Comment le confirmer en un coup d'œil** : deux fenêtres ouvertes, puis dans le journal, les
lignes `usage.claude.init` ou `usage.credits` d'un même cycle doivent porter **un seul**
préfixe `req-xxxxxx-`. Deux préfixes = le bail n'est pas partagé, et il faut alors remonter la
cadence dans le sidecar comme envisagé plus haut.

**Clos le 2026-09-19 — en supprimant la question au lieu d'y répondre.**

D'abord, la mesure a été TENTÉE, et elle a échoué pour une raison instructive. Dépouillement de
`app.jsonl` (2 823 582 octets, du 18/08 au 19/09), minute par minute, en comptant les préfixes
de fenêtre qui émettent une sonde :

| jour | fenêtres | minutes de sonde | dont ≥ 2 fenêtres |
|---|---:|---:|---:|
| 2026-08-18 | 2 | 202 | 0 |
| 2026-08-19 | 1 | 6 | 0 |
| 2026-08-20 | 3 | 215 | **214** |

Le 20/08 montre le BUG dans toute sa netteté — 214 minutes sur 215 avec la sonde partant de
deux fenêtres. Mais après cette date, plus une seule ligne exploitable : T-057 a (à raison) fait
taire les sondes nominales, et il ne reste donc rien à compter. **Le correctif a rendu sa propre
vérification impossible.** À retenir : une preuve qui repose sur des lignes de journal
disparaît avec elles ; si une mesure doit survivre à un nettoyage du bruit, il faut la vouloir
explicitement.

Plutôt que d'instrumenter pour re-créer la preuve d'une hypothèse invérifiable — deux webviews
Tauri partagent-elles `localStorage` ? — la cadence est remontée **dans le sidecar**, ce que ce
ticket désignait dès l'origine comme la bonne réponse, le bail `localStorage` n'étant que le
« à défaut ». Il n'y a qu'un sidecar par processus : la question ne se pose plus.

- `sidecar/src/cadenceSondesConso.ts` — décisions temporelles PURES : « est-il l'heure de
  sonder ? », « faut-il se taire jusqu'à `resetsAt` ? » (silence T-059), « de combien reculer
  après un échec réseau ? » (recul exponentiel T-085). 12 cas.
- `claudeUsage.ts` et `creditsFournisseur.ts` **coalescent** les appels concurrents sur une
  promesse partagée : deux fenêtres qui demandent en même temps produisent UN micro-tour et
  UNE requête réseau, et reçoivent toutes deux la même réponse. La cadence des crédits est tenue
  par `providerId`.
- Aucun canal de diffusion nouveau : chaque fenêtre continue d'appeler à son rythme, le sidecar
  répond à chaque id avec le résultat de la sonde unique. Le transport n'a pas bougé.

Le test qui compte échouait contre l'ancien code, vérifié en le remisant : deux appels
concurrents donnaient **2** micro-tours et **2** requêtes réseau ; ils en donnent **1**
(`cadenceUsageCoalescee.test.js`). C'est la propriété du ticket, démontrée sans dépendre d'une
observation à deux fenêtres.

**Ce qui reste dans `ui/src/cadenceUsage.ts`** : le silence de saturation
(`armerSilence`/`silenceActifJusqua`/`libererSilence`) — SECOND consommateur légitime, lu par
`reouvertureQuota.ts` pour le réveil « au reset » (T-120). Le bail et le recul, eux, sont
partis avec la cadence. `encartConso.tsx` perd son élection de releveur et son cache de repli
(666 → 596 lignes).

**Dernière chose, et elle ferme la boucle du ticket** : le corollaire cité plus haut — « tout
minuteur posé dans `App.tsx` est multiplié par le nombre de fenêtres » — reste vrai pour les
minuteurs à venir. Ce qui change, c'est qu'aucune sonde COÛTEUSE ne peut plus l'être : le coût
est désormais gardé là où il n'existe qu'en un exemplaire.

### T-085 — Une jauge tape en boucle sur un certificat, et ne dit pas lequel

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-20 · **Clos** 2026-09-02

Constaté le 2026-08-20 en mesurant `app.jsonl` pour solder T-057. Depuis le **2026-08-17**, la
ligne la plus fréquente du journal est :

```
erreur réseau: fetch failed (ERR_TLS_CERT_ALTNAME_INVALID)   fields: { method: "usage.credits" }
```

**1 996 occurrences** en trois jours : 14 le 17, 611 le 18, **1 371 le 20** — ces dernières entre
08 h 05 et 12 h 21, soit 4 h 15 de fenêtre, **écart médian de 10,7 s** et 436 écarts sous 2 s.
Une jauge annoncée « toutes les 5 min » (T-057) tire donc ~6 fois par minute. Ce n'est plus une
sonde périodique, c'est une boucle de reprise qui ne s'arrête sur rien.

**Un second témoin, trouvé le 2026-08-20 en dépouillant les échecs du micro-tour d'abonnement.**
La même panne se voit depuis un client entièrement différent : sur 488 échecs de
`usage.claude.init`, **234 portent `API Error: Unable to connect to API: SSL certificate hostname
mismatch`** — message du **CLI Claude**, donc d'une autre pile TLS que le `fetch` de Node, vers
une autre destination (`api.anthropic.com`, pas un fournisseur déclaré). Et les jours coïncident :
2 le 17, 41 le 18, 86 le 20 — exactement ceux de la rafale `ERR_TLS_CERT_ALTNAME_INVALID`
(auxquels s'ajoutent des épisodes plus anciens : 29 le 03/08, 29 le 04/08, 47 le 11/08).

Deux piles TLS indépendantes qui annoncent le même défaut, le même jour, vers des hôtes
différents : la cause n'est vraisemblablement **pas** dans le certificat d'un fournisseur ni dans
notre code, mais dans le chemin réseau du poste ces jours-là — interception TLS, DNS détourné,
portail captif. C'est une piste, pas une conclusion : elle ne se vérifiera qu'avec le champ qui
manque (défaut 2 ci-dessous) et un relevé au moment de la panne.

**Deux défauts distincts, à ne pas confondre :**

1. **La reprise sans frein.** Un échec durable et reproductible (le certificat ne changera pas
   entre deux essais espacés de 700 ms) est réessayé indéfiniment, à pleine cadence. Il faut un
   recul exponentiel et un plafond — et, sur une cause aussi stable, un arrêt franc de la jauge
   jusqu'au prochain changement de configuration.
2. **La ligne ne dit pas SUR QUOI elle a échoué.** Les champs se réduisent à
   `{ method: "usage.credits" }` : ni `providerId`, ni URL, ni hôte. C'est exactement la faute
   que T-044 avait corrigée dans l'autre sens — la cause (`ERR_TLS_CERT_ALTNAME_INVALID`) est
   bien là, mais la CIBLE manque, et sans elle le message ne dit toujours pas quoi corriger.

Le second défaut est ce qui empêche de refermer le premier séance tenante : **le diagnostic
s'arrête ici**. Les trois fournisseurs déclarés dans `config.json` — `localhost:11434` (Ollama,
sans TLS), `openrouter.ai` et `graphql.swiftask.ai` — présentent tous, **vérifié depuis ce poste
le 2026-08-20**, un certificat qui couvre leur nom (`openssl s_client` + `subjectAltName`), et
`https://graphql.swiftask.ai/v1/credits` répond 404 sans redirection. L'hôte réellement contacté
au moment de l'échec n'est donc **pas déductible du journal** : il faut d'abord poser le champ,
puis relire.

**Cadence : cause trouvée dans le code, le 2026-08-20.** Ce n'est pas la jauge de 5 minutes qui
tire, c'est sa reprise : `USAGE_RETRY_DELAY_MS = 15_000` ([App.tsx:235](../ui/src/App.tsx#L235)),
un délai **fixe**, sans recul exponentiel ni plafond, armé depuis **trois** points du même effet
(instantané indisponible, exception du relevé Claude, échec de `usage.credits`). Un échec durable
— et un certificat qui ne correspond pas l'est par nature — se réessaie donc toutes les 15 s
jusqu'à la fermeture de la fenêtre. Multiplié par le nombre de fenêtres (T-086) : les 1 371
lignes du 2026-08-20 se répartissent en 684 pour `zdwpg5` et 687 pour `qyy3jp`, ce qui explique
l'écart médian mesuré de 10,7 s pour une reprise nominale de 15 s.

À faire : `providerId` et URL dans les champs de la ligne (au minimum l'hôte), recul exponentiel
+ plafond sur la reprise, et seulement ensuite l'identification de l'hôte fautif. Recoupe T-057
(une jauge qui journalise en `error` un état durable) et T-086 (chaque fenêtre a la sienne) : à
elle seule, cette boucle est **la première cause d'illisibilité du journal** aujourd'hui.

**Les deux défauts de l'application sont corrigés le 2026-08-20. La cause, elle, reste dehors.**

1. **La reprise a un frein** : `prochainDelaiReprise` ([cadenceUsage.ts](../ui/src/cadenceUsage.ts))
   remplace le délai fixe par un doublement plafonné — 15 s, 30 s, 1 min, 2 min, 4 min, puis
   5 min pour toujours, remis à zéro au premier succès. Un incident bref reste traité vite ; un
   état durable cesse de marteler. Le plafond est délibérément ≤ au cron de 5 min : au-delà, la
   reprise ne servirait plus à rien, et un recul sans plafond remplacerait une boucle par un
   abandon muet.
2. **La ligne nomme sa cible** : `usage.credits` répond désormais
   `erreur réseau: … [providerId · hôte]` ([creditsFournisseur.ts](../sidecar/src/creditsFournisseur.ts)).
   L'hôte SEUL, jamais l'URL complète — un chemin peut porter un identifiant.

S'y ajoute l'effet de T-086 : la reprise ne tourne plus que dans une fenêtre. Les 1 371 lignes
d'une journée deviennent, pour une panne durable identique, une douzaine.

**Ce qui reste, et qui n'est pas dans notre code** : l'hôte fautif. Le second témoin (le
`SSL certificate hostname mismatch` du CLI Claude, vers `api.anthropic.com`) dit que la panne
n'est probablement pas chez un fournisseur. Le ticket reste `en cours` jusqu'à la prochaine
occurrence : elle nommera l'hôte, et c'est ce nom qui tranchera entre interception TLS, DNS
détourné et portail captif. Tests : `sidecar/test/usageCredits.test.js` (4 cas) et
`ui/src/cadenceUsage.test.ts` (recul et plafond).

**Clos le 2026-09-02, sur constat d'extinction.** Mesuré sur `app.jsonl` : **zéro** ligne
`erreur réseau`/`usage.credits` du 2026-08-21 au 2026-09-01 (909 lignes sur la période). La
panne extérieure a disparu d'elle-même — cohérent avec l'hypothèse du chemin réseau du poste
(interception TLS, DNS, portail captif) plutôt que d'un fournisseur. L'hôte fautif n'aura
jamais pu être nommé, et attendre indéfiniment une récidive n'est pas un statut : les deux
défauts de l'application sont corrigés, et l'instrument est armé — si la panne revient, la
ligne portera l'hôte, et c'est un ticket NEUF qui l'accueillera, avec ce nom.

### T-057 — Le journal réel est à 85 % d'erreurs : les jauges crient des états nominaux

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-09-02

Mesuré pendant la revue d'architecture du 2026-08-15 sur `app.jsonl` du poste : 4 623 lignes
depuis le 2026-08-04, dont **3 947 en `error`/`fatal` (85 %)**. Décompte des meneurs :

| Occurrences | Message | État réel |
|---:|---|---|
| 2 125 | `erreur réseau: fetch failed` | fournisseur hors ligne (conteneur Ollama arrêté…) |
| 1 197 | `clé API manquante pour openrouter` | aucune clé configurée — état CHOISI |
| 246 | `échec du micro-tour d'initialisation` | hors ligne / non connecté |

Ces trois-là sont le même défaut que T-007, non refermé : des **jauges périodiques**
(`usage.credits` toutes les 5 min, micro-tour d'initialisation) qui journalisent en `error`
des états nominaux et durables, en boucle. « Pas de clé » n'est pas une panne : c'est un état
que l'utilisateur a choisi, redit 1 197 fois. La doctrine d'observabilité est trahie par son
propre outil : le fichier qu'on ouvre quand ça va mal est illisible, et la page Système
affiche des compteurs qui crient en permanence.

Le mécanisme du correctif EXISTE depuis T-007 : le drapeau `sonde` de `request()`
([sidecar.ts](../ui/src/sidecar.ts)), qui descend l'échec en `debug`. À faire :

1. `usage.credits` et le micro-tour d'initialisation passent en `sonde: true` — leur échec
   est une réponse (pas de clé, hors ligne), leur succès est l'événement ;
2. mieux : côté sidecar, « clé API manquante » devient une réponse `done` structurée
   (`{disponible: false, raison: "cle-absente"}`) plutôt qu'une `error` — l'absence de clé
   n'est pas un échec du protocole ;
3. après correctif, vérifier sur une session réelle que la part d'`error` du journal
   redevient interprétable (< 10 % en usage normal).

**Remesuré le 2026-08-20, et c'est PIRE.** `app.jsonl` du poste, 7 632 lignes du 2026-07-31 au
2026-08-20 : **6 599 en `error`/`fatal`, soit 86,5 %** — la revue du 2026-08-15 en comptait
85 %, rien n'a bougé. Le détail par jour dit d'ailleurs que la moyenne masque des pointes :
94,1 % le 18, **95,6 % le 20** (1 705 lignes sur 1 783).

Les meneurs ont changé de tête, pas de nature :

| Occurrences | Message | État réel |
|---:|---|---|
| 2 125 | `erreur réseau: fetch failed` | fournisseur hors ligne |
| 1 996 | `erreur réseau: fetch failed (ERR_TLS_CERT_ALTNAME_INVALID)` | **nouveau depuis le 2026-08-17 — voir T-085** |
| 1 197 | `clé API manquante pour openrouter` | état CHOISI |
| 488 | `échec du micro-tour d'initialisation` | hors ligne / non connecté |

Le nouveau venu pèse à lui seul **26 % de tout le journal**, produits en trois jours, et sort en
ticket propre (T-085) :
il ajoute au défaut de niveau (`error` pour un état durable) un défaut de cadence (une reprise
toutes les 10 s) et un défaut de champ (la ligne ne dit pas quel hôte). Le correctif de T-057
— `sonde: true` sur les jauges — reste entièrement à faire, et il ne suffira pas seul : une
sonde qui tire 6 fois par minute reste une sonde qui tire 6 fois par minute, `debug` ou non.

**Les deux correctifs demandés sont posés le 2026-08-20** — dans l'ordre du ticket :

1. **`sonde: true` sur les deux jauges périodiques** (`usage.credits` et le micro-tour
   `usage.claude.init`, [encartConso.tsx](../ui/src/encartConso.tsx)) : leur échec descend en
   `debug` par le mécanisme de T-007, qui existait et n'était pas utilisé. Rien n'est tu — la
   ligne est toujours écrite, elle cesse seulement de crier. Le bouton d'initialisation
   déclenché par l'utilisateur, lui, reste bruyant : une action explicite qui échoue doit se
   voir.
2. **« clé API manquante » n'est plus une erreur de protocole** : `usage.credits` répond
   `done {disponible: false, raison: "cle-absente"}`
   ([creditsFournisseur.ts](../sidecar/src/creditsFournisseur.ts), documenté dans
   `docs/protocol.md`). Conséquence voulue au-delà du journal : l'interface sait désormais que
   c'est un état CHOISI et **ne réessaie plus du tout** — une clé absente ne réapparaît pas
   toute seule.

Sur les meneurs mesurés le 2026-08-20, cela retire du niveau `error` : les 1 197 « clé API
manquante », les 1 996 lignes TLS de `usage.credits` (désormais sonde ET freinées, T-085) et
les 488 échecs du micro-tour. Reste le point 3 du ticket, qui n'appartient pas au code :
**vérifier sur une session réelle que la part d'`error` redevient interprétable (< 10 %)**.
Le ticket reste `en cours` pour ça, et pour rien d'autre — conclure de la lecture du code
qu'on a corrigé le journal serait exactement la faute que ce ticket dénonce.

**Clos le 2026-09-02, sur la mesure que le ticket exigeait.** `app.jsonl` du poste, du
2026-08-21 (lendemain des correctifs) au 2026-09-01 : **909 lignes, 20 en `error`/`fatal`,
soit 2,2 %** — contre 86,5 % au constat, et sous le seuil de 10 % fixé par le point 3. Aucun
jour de la période ne dépasse les 4 % hors deux journées quasi vides (1-2 erreurs sur une
poignée de lignes). Et les 20 erreurs restantes sont toutes SIGNIFIANTES : 13 refus du
garde-fou « sidecar PÉRIMÉ » (T-020, une erreur actionnable qui doit crier) et 7 interruptions
de rendu React en session de développement (artefacts HMR — consignés en T-116). Le journal
redit ce pour quoi il existe : une ligne `error` redevient un événement.

### T-026 — Recherche web : des pages de rubrique au lieu d'articles

**Type** feat · **Prio** P3 · **Statut** ouvert · **Créé** 2026-08-10

Constaté le 2026-08-10, au premier tour réel de R9 (`swiftask · deepseek-v3`,
« Donne les actualités en Amérique latine de ce mois »). Les 5 sources
remontées sont des **pages de rubrique** — `lemonde.fr/mexique/`,
`radiofrance.fr/monde/amerique-latine`, `tf1info.fr/actualite/amerique-du-sud` —
et non des articles datés. Le modèle a fait ce qu'il fallait : il a dit que
les extraits ne suffisaient pas. Mais l'utilisateur, lui, n'a pas sa réponse.

Ce n'est pas un défaut du mécanisme : c'est la requête qui part en recherche
GÉNÉRALE. Mesuré sur le même SearXNG, à question identique :

| Paramètres | Ce que ça remonte |
|---|---|
| défaut | 24 résultats, **pages de rubrique**, aucune date |
| `&categories=news` | 25 résultats, de vrais articles, mais du hors-sujet |
| `&categories=news&time_range=month` | 10 résultats, articles **récents et pertinents** |

Deux pistes, à ne pas confondre :

- **La petite** : router les questions d'actualité vers `categories=news` +
  `time_range`. Le coût réel n'est pas l'appel, c'est le CHOIX : décider
  qu'une question « porte sur l'actualité » à l'heuristique, c'est se
  tromper sur les cas limites, et se tromper en silence.
- **La grande** : la reformulation de requête par un LLM court, explicitement
  écartée de R9 (« à rouvrir sur constat, pas par anticipation »). Le constat
  est là. Elle réglerait aussi les questions mal formulées, au prix d'un
  appel de plus et d'une latence de plus.

Aucune des deux ne se décide sur un seul cas : à rouvrir quand plusieurs
tours réels auront montré le même défaut, avec leurs requêtes.

**Statut arrêté le 2026-08-15 : EN ATTENTE DE CONSTAT.** Un seul tour, une seule question. Les
deux pistes coûtent cher au bon endroit — l'heuristique « cette question porte sur
l'actualité » se trompe en silence sur les cas limites, la reformulation par LLM ajoute un
appel et une latence à chaque recherche. Trancher aujourd'hui, ce serait choisir sur un
échantillon de un ; c'est précisément l'erreur que T-012 et T-019 ont documentée dans ce même
fichier. Le ticket attend d'autres tours réels, avec leurs requêtes.

### T-029 — Démarrage long, et pas un chiffre pour le dire

**Type** tech · **Prio** P2 · **Statut** en cours · **Créé** 2026-08-11

Constat utilisateur du 2026-08-11 : « pourquoi le démarrage du logiciel est-il
si long ? ». Aucune réponse possible — le premier horodatage d'une session
était celui de `setup()`, c'est-à-dire déjà à l'intérieur du code applicatif.
Tout ce qui le précède et tout ce qui le suit côté webview était hors mesure.
Un budget de démarrage qu'on ne peut pas lire est un échec muet de plus.

**Ce que les étages déjà instrumentables ont répondu** (tous mesurés le
2026-08-11, aucun n'est en cause) : sidecar prêt en 0,25 s à froid ;
`cargo build` à blanc en 0,23 s ; les 6 Mo de `project-conversations.json`
relus et parsés en 32 ms (7 projets, 49 sessions, 834 tours) ; `usage.stats`,
`taches.list`, `tickets.list` et `knowledge.status` servis en 125–151 ms.

**Jalons posés** (`demarrage.rs` + `demarrage.ts`, voir `docs/protocol.md`
§ « Jalons de démarrage ») : `rust:setup`, `rust:boucle-evenements`,
`ui:script`, `ui:premier-rendu`, avec `avantMainMs` (lu dans `/proc` : le seul
segment qu'un `Instant` ne peut pas voir) et `pageMs` (l'horloge de la page,
qui sépare le démarrage du moteur web du chargement de l'interface). Méthode
recoupée sur un process vivant : `btime` + `starttime` redonnent l'heure du
`exec` à 60 ms près de ce que dit le journal.

**Premiers relevés, sur des relances déclenchées par `tauri dev` après
recompilation** :

| segment | valeur |
|---|---|
| avant `main()` | **4,8 s puis 10,4 s** |
| `main()` → `setup()` (GTK, fenêtre) | 317–389 ms |
| fenêtre → `ui:script` | 486 ms (dont 328 ms de page) |
| `ui:script` → première image | 780 ms |

L'application elle-même dessine donc **~1,6 s après `main()`**. Le poste
énorme est le « avant `main()` » — mais il n'est PAS intrinsèque au binaire :
lancé seul, sans affichage, le binaire va de l'`exec` à l'init GTK en
**109 ms** (et `ldd` résout les 124 bibliothèques en 24 ms, 18,5 Mo de
segments chargeables, sur NVMe). Ces 5 à 10 s appartiennent au contexte de la
relance : le process est créé pendant que la machine termine l'édition de
liens du binaire de debug (241 Mo, dont 233 Mo de debuginfo, sans `mold`).

**Lancement NORMAL** (`dev.sh` du 2026-08-11 22:14, binaire Rust inchangé —
`iaction` daté de 22:09, donc aucune recompilation) : la chaîne complète, du
lancement de la commande à la première image, tient en **~8,2 s**.

| étape | horodatage | durée |
|---|---|---|
| `tsc` du sidecar (dev.sh) | → 22:14:50,5 | ~2,5 s |
| `tauri dev`, puis Vite | 22:14:50 → 22:14:51 | 1 s |
| attente avant l'`exec` du binaire (fraîcheur cargo + Vite) | → 22:14:53,2 | ~2,3 s |
| avant `main()` | | 340 ms |
| `main()` → fenêtre (GTK) | → 22:14:53,95 | 383 ms |
| fenêtre → webview | | 175 ms |
| chargement + parse du JS (7 Mo non bundlés) | → 22:14:55,4 | **1 264 ms** |
| premier rendu React | → 22:14:56,2 | 800 ms |

L'application seule, de l'`exec` à la première image : **3,0 s**. Les 340 ms
d'avant-`main()` confirment que les 4,8 et 10,4 s relevés plus haut étaient le
contexte de recompilation, pas le binaire.

**Ce qui manque pour clore** : le même relevé en version empaquetée, où l'UI
n'est plus servie module par module (1,6 Mo bundlés contre 7 Mo) — les deux
plus gros postes du tableau y sont probablement absents. Les jalons y sont
aussi : ils s'écriront tout seuls.

**Fait le 2026-08-11, sur les deux plus gros postes actionnables :**

1. **`dev.sh` ne recompile plus le sidecar pour rien** (−2,5 s par lancement).
   `sidecar/scripts/a-jour.mjs` pose la question au code compilé lui-même, via
   `inspecterPeremption` — la MÊME empreinte que celle du garde-fou T-020, pas
   une seconde implémentation qui divergerait. Vérification : **148 ms**. Le
   doute fait toujours recompiler (dossier absent, témoin illisible,
   `hors-source`), et c'est ce que verrouille `sidecar/test/aJour.test.js` :
   sauter un `tsc` à tort, c'est refabriquer T-020.
2. **Les cinq pages non affichées ne sont plus chargées au démarrage**
   (`ui/src/pagesParesseuses.tsx`). Le graphe servi au lancement passe de
   **7 074 Ko / 119 modules à 5 434 Ko / 103 modules** (−23 %) ; en build
   empaqueté, 194 ko de chunks sortent du bundle principal (ChatPage,
   OrchestrationPage, ProvidersPage, SupervisionPage, SystemPage).
   `AgentPage` reste chargée d'emblée : c'est la page ouverte au démarrage.
   L'invariant qui justifiait les six pages montées en permanence est
   préservé et testé — **une page montée ne se démonte jamais**, seule sa
   première mise en mémoire est différée.

**Fait le 2026-08-16 — `split-debuginfo`, mesuré des deux côtés.**

`touch src/lib.rs` puis reconstruction, caches chauds, plusieurs relevés par configuration :

| configuration | reconstruction | binaire |
|---|---|---|
| défaut | 9,9 s et 11,4 s | 243 Mo |
| `split-debuginfo=unpacked` | **7,4 s** (× 3) | **80 Mo** |

Le debuginfo n'est plus recopié dans le binaire à l'édition de liens ; il reste dans les objets,
où le débogueur va le lire. Environ 30 % du temps de reconstruction, et trois fois moins à
écrire sur le disque.

Le réglage est posé dans [.cargo/config.toml](../.cargo/config.toml), **pas** dans `dev.sh`, et
c'est le point à retenir : un `RUSTFLAGS` posé par le seul lanceur de développement change
l'empreinte de compilation, donc `npm run verif` — qui appelle `cargo test` sans ce réglage —
reconstruirait tout l'arbre à chaque alternance. L'accélération se serait payée plusieurs fois.
Vérifié après coup : reconstruction 7,5 s depuis `src-tauri/`, puis `cargo test` depuis la
racine en 3,6 s, sans recompilation intermédiaire — une seule empreinte pour tout le monde.

Contrepartie assumée : le binaire n'est plus autonome pour le débogage. Copié ailleurs sans son
dossier `target/`, il a perdu ses symboles. Sans objet ici, où l'on débogue là où l'on compile.

**`mold` n'est PAS activé** : il n'est pas installé sur ce poste, donc rien n'a pu être mesuré,
et poser un linker absent casserait la compilation de quiconque ne l'a pas — CI comprise. Le
fichier porte la ligne à décommenter et la consigne : mesurer dans les mêmes conditions avant
d'y croire.

**Reste à faire** : comprendre les ~2,3 s entre `tauri dev` et l'`exec` du binaire, alors que
cargo à blanc répond en 0,23 s ; et le relevé en version empaquetée, où l'interface n'est plus
servie module par module (1,6 Mo bundlés contre 7 Mo) — les deux plus gros postes du tableau y
sont probablement absents. Les jalons y sont déjà : ils s'écriront tout seuls.

### T-056 — Le process de contenu WebKit plante par intermittence

**Type** bug · **Prio** P2 · **Statut** ouvert · **Créé** 2026-08-15

Sorti de [T-030](#t-030--la-fenêtre-gèle-au-démarrage-et-rien-ne-le-dit), qui portait deux
choses distinctes : notre mutisme face à la panne (corrigé) et la panne elle-même (ici).

Quatre occurrences en six jours sur ce poste — 2026-08-07 (14 h 31 et 18 h 17), 2026-08-08
(11 h 36), 2026-08-12 (17 h 25) — avec la même signature dans `journalctl` :
`segfault … in libgstpipewire.so`, le greffon PipeWire que GStreamer charge pour le moniteur de
périphériques média de WebKit. Le 2026-08-11 à 23 h 58, deux autres segfauts (`libwebkit2gtk`
puis `libnvidia-eglcore`) ont tué le même process : le mode de panne n'est donc pas propre à ce
greffon, et un correctif qui ne viserait que lui laisserait les autres.

Le plantage est dans une bibliothèque du SYSTÈME, pas dans notre code. Nos leviers sont
indirects, et c'est ce qui rend la mesure indispensable avant tout geste :

1. **Dégrader le greffon fautif au lancement** —
   `GST_PLUGIN_FEATURE_RANK=pipewiredeviceprovider:NONE` dans `scripts/dev.sh` et dans
   l'environnement de l'application empaquetée, pour retomber sur le fournisseur PulseAudio.
2. **Mesurer avant, et mesurer après.** La panne est intermittente : quelques lancements sans
   plantage ne prouvent rien. Depuis T-030, chaque occurrence laisse une ligne `fatal` dans
   `coquille.jsonl` et `app.jsonl` — c'est ce compteur, sur une période comparable, qui peut
   trancher. Sans lui, on croirait avoir corrigé au premier lancement qui passe.
3. Si le contournement tient, décider s'il devient permanent : désactiver un greffon média du
   système a un coût (détection de périphériques), qu'il faudra nommer plutôt que subir.

Ce ticket n'est pas urgent au sens où l'application ne ment plus : la fenêtre dit ce qui s'est
passé et propose de recharger. Il reste ouvert parce qu'une panne qu'on sait voir n'est pas une
panne réparée.

**Point du 2026-08-20, aucune action.** Dernière occurrence de la signature du ticket
(`libgstpipewire`) : le **2026-08-12 à 17 h 25**, celle déjà listée ci-dessus — huit jours sans
récidive, alors qu'**aucune des trois pistes n'a été appliquée** (le greffon n'est pas dégradé).
Il n'y a donc rien à conclure sinon que la panne est bien intermittente, comme annoncé.

Deux relevés qui comptent pour la suite : `journalctl` porte un segfault du **2026-08-19 à
16 h 37** dans `gstglcontext` / `libgallium` — encore la pile GStreamer/GL, encore une
bibliothèque du système, mais un TROISIÈME greffon. Le ticket disait déjà qu'un correctif visant
le seul `pipewiredeviceprovider` laisserait les autres : c'est confirmé, pas infirmé. Et côté
application, `coquille.jsonl` ne porte **aucune ligne au-dessus d'`info`** sur la période : le
process de contenu n'est pas mort DANS l'application depuis T-030, ce qui est cohérent avec les
huit jours calmes.

**Point du 2026-09-02, aucune action.** Une récidive dans `journalctl` depuis le point
précédent : le **2026-08-23 à 11 h 52**, à nouveau `gstglcontext` / `libgallium` — la signature
du 19/08, pas celle de PipeWire. Dix jours de calme depuis. Le constat du ticket tient : le
mode de panne se déplace de greffon en greffon dans la pile GStreamer/GL, et un correctif
ciblant `pipewiredeviceprovider` seul aurait déjà manqué les deux dernières occurrences.

### T-048 — Coller une capture fige le composeur ~5 s

**Type** bug · **Prio** P2 · **Statut** en cours · **Créé** 2026-08-14

Constat utilisateur du 2026-08-14 : « quand je colle une capture d'écran, ça prend 5 secondes
avant d'être pris en compte ». Pendant ce délai, **rien** : pas de vignette, et la question
tapée dans le composeur n'est pas prise en compte. Attendu : vignette et frappe immédiates,
les octets arrivant ensuite.

Ce qui rend le constat instructif, c'est que le repli natif a **déjà** été écrit pour ça. Le
handler `onPaste` ([AgentPage.tsx](../ui/src/AgentPage.tsx) ~2727, idem
[ChatPage.tsx](../ui/src/ChatPage.tsx)) crée une vignette « en chargement » de façon
SYNCHRONE (`beginImage`, [Attachments.tsx](../ui/src/Attachments.tsx) ~246) avant d'appeler
`readClipboardImage()`. Si la vignette n'apparaît pas, ce n'est donc pas qu'on l'affiche trop
tard : **c'est que rien n'est peint du tout** pendant ces secondes — et le clavier muet dit la
même chose. Le symptôme n'est pas « le collage est lent », c'est « l'interface est gelée ».

**Hypothèse principale, à MESURER avant de corriger** : `clipboard_read_image`
([clipboard.rs](../src-tauri/src/clipboard.rs) 29-42) est une commande Tauri **synchrone**
(`pub fn`, pas `async fn`). Sous Tauri 2, une commande synchrone s'exécute sur le fil
principal — celui qui porte la boucle GTK, donc l'affichage et les événements de la webview.
Tant qu'`arboard` négocie avec le propriétaire du presse-papier (X11/Wayland : le processus
qui a fait la capture doit répondre) puis qu'on encode le PNG, la boucle ne rend pas la main.
Le soin déjà pris côté performance (compression `Fast`, renvoi binaire plutôt que base64) ne
change rien à ça : ce n'est pas la durée qui gêne, c'est *où* elle est passée.

Suspect secondaire, côté interface : `resolveImage` relit ensuite les octets en **data URL
base64** (`FileReader.readAsDataURL`, [Attachments.tsx](../ui/src/Attachments.tsx) ~279) —
plusieurs Mo pour une capture plein écran, +33 % en base64, sur le fil de l'UI lui aussi.

**Mesure à faire avant tout correctif** (ne pas conclure d'une lecture de code, cf. T-012 et
T-019) — quatre segments à horodater sur un collage réel :

1. événement `paste` → vignette « en chargement » réellement peinte ;
2. `invoke` → retour de `clipboard_read_image` (et, dedans, `get_image()` vs `encode_png`) ;
3. taille et dimensions du PNG produit ;
4. `FileReader` → `dataUrl` posée, vignette pleine.

Sans ces chiffres on ne sait pas si les 5 s sont la négociation du presse-papier, l'encodage
PNG ou l'encodage base64 — trois correctifs différents.

**Pistes, dans l'ordre où elles deviendront pertinentes** :

- passer la commande en `async fn` (ou déporter le corps dans `spawn_blocking`) pour rendre la
  boucle GTK disponible : la vignette se peint et la frappe passe, même si la lecture prend
  plusieurs secondes ;
- afficher la vignette par `URL.createObjectURL(blob)` (instantané, aucune copie) et ne
  produire le base64 qu'au moment de l'envoi, où il est réellement exigé par le contrat ;
- si le poste reste lent après ça, dire l'attente (vignette « lecture du presse-papier… »)
  plutôt que la laisser deviner.

**Fait le 2026-08-15 — les deux correctifs qui valent QUELLE QUE SOIT la cause :**

1. **La commande passe en `async` + `spawn_blocking`**
   ([clipboard.rs](../src-tauri/src/clipboard.rs)). Ce n'est pas un pari sur le segment
   coupable : une commande Tauri synchrone tient le fil principal — donc la boucle GTK, donc
   l'affichage et le clavier — pendant TOUT son travail. Que les cinq secondes viennent de la
   négociation du presse-papier ou de l'encodage PNG, les tenir là est un défaut en soi. La
   fenêtre reste vivante pendant la lecture, et c'est précisément ce que décrivait le constat :
   pas « c'est lent », mais « c'est gelé ».
2. **La vignette ne dépend plus de la base64** ([Attachments.tsx](../ui/src/Attachments.tsx)).
   `URL.createObjectURL` publie une référence au tampon déjà en mémoire, sans copie ni
   encodage : l'aperçu peut être peint dès l'arrivée des octets. La data URL continue d'être
   produite en arrière-plan car elle EST la source de l'envoi (contrat du sidecar), et la pièce
   reste `loading` tant qu'elle manque — lever le drapeau sur la seule vignette autoriserait à
   envoyer une image vide.

**Ce qui reste dû, et pourquoi le ticket n'est PAS clos** : la mesure. Le ticket exigeait des
chiffres avant de conclure (cf. T-012 et T-019, deux conclusions tirées d'un examen partiel), et
aucun chiffre ne peut être produit sans un vrai collage dans l'application lancée — ce qui
appartient à l'utilisateur. Les deux jalons attendus sont désormais écrits au journal en
`debug` à chaque collage :

| Ligne (`app.jsonl`, niveau `debug`) | Ce qu'elle mesure |
|---|---|
| `collage : presse-papier lu` — `ms`, `octets` | négociation du presse-papier + encodage PNG natif, et la taille produite |
| `collage : image prête à l'envoi` — `base64Ms`, `octets` | l'encodage base64 côté interface (suspect secondaire du ticket) |

À la prochaine capture collée : si l'interface répond immédiatement et que `ms` reste élevé, la
cause était bien l'endroit et non la durée — le ticket se ferme. Si le gel persiste, ces deux
nombres disent lequel des trois segments accuser, ce qu'aucune lecture de code n'aurait tranché.

**Point du 2026-08-20 : toujours aucune mesure.** Les deux jalons attendus (`collage :
presse-papier lu`, `collage : image prête à l'envoi`) sont **absents du journal** — zéro
occurrence sur les 7 632 lignes conservées depuis le 2026-07-31. Aucune capture n'a donc été
collée dans l'application depuis le correctif du 2026-08-15. Le ticket reste `en cours` pour
exactement la raison qu'il énonce : ce qui manque n'est pas du travail, c'est un collage réel.

**Point du 2026-09-02 : idem.** Zéro jalon `collage` sur les 8 566 lignes du journal. Dix-huit
jours sans un collage d'image dans l'application — au prochain, les deux nombres trancheront.

**Point du 2026-09-19 — les deux relevés précédents étaient FAUX, et la cause est instructive.**

« Zéro occurrence donc aucune capture n'a été collée » : le raisonnement est invalide. Les deux
jalons étaient écrits au niveau **`debug`**, et `debug` n'est pas écrit par défaut —
`IACTION_LOG_LEVEL` vaut `info`, et sous ce seuil `log()` est un no-op TOTAL (`journal.ts`).
Vérification sur le journal réel du poste : **0 ligne `debug` sur 10 692**. Ces jalons ne
pouvaient donc pas apparaître, quel que soit le nombre de collages. On a lu une absence de
preuve comme une preuve d'absence, deux fois, à trois semaines d'intervalle, et on en a conclu
quelque chose sur le comportement de l'utilisateur.

La leçon dépasse ce ticket : **une instrumentation posée sous le seuil d'écriture n'est pas une
instrumentation**, et son silence ne dit rien. Toute mesure destinée à trancher une question
doit être écrite au niveau où on ira la lire — ou le ticket doit dire noir sur blanc quelle
variable d'environnement l'active. C'est le même angle mort que T-057 vu par l'autre bout : là
on criait trop, ici on ne dit rien du tout.

**Instrumentation refaite, en `info` cette fois**, et élargie aux QUATRE segments que le ticket
réclamait depuis le début (les deux jalons de 2026-08-15 n'en couvraient que deux) :

| segment | mesure | où |
|---|---|---|
| 1 | `paste` → vignette « en chargement » peinte (`peintureMs`) | ui |
| 2 | aller-retour `invoke` (`invokeMs`), et **séparément** `get_image()` vs `encode_png` | ui + rust |
| 3 | taille et dimensions du PNG (`octets`, `largeur`, `hauteur`) | ui |
| 4 | `FileReader` → data URL (`base64Ms`) | ui |

Une seule ligne récapitulative par collage et par processus — un collage ne doit pas produire
dix lignes (T-057). Le segment 3 lit l'en-tête `IHDR` du PNG sans décoder l'image. Le mécanisme
vit dans `ui/src/journalCollage.ts` et `collerImageDuPressePapierNatif`, point d'entrée unique
appelé à l'identique par les deux pages — qui **rétrécissent** au passage (`AgentPage` 2903 →
2900, `ChatPage` 2698 → 2695) au lieu de consommer de la dérogation.

**Limite de la mesure, dite explicitement** : `peintureMs` s'appuie sur deux
`requestAnimationFrame` imbriqués. Ça capture le moment où le navigateur a rendu et très
probablement peint la frame — bien au-delà d'un simple retour de `setState` — mais PAS la
garantie que les pixels ont atteint l'écran physique (la latence du compositeur et du pilote est
hors de portée du DOM). Une mesure dont on croirait à tort qu'elle prouve la peinture serait
pire que pas de mesure.

**Aucun comportement n'a changé**, conformément à la discipline du ticket : les deux correctifs
de 2026-08-15 (`async` + `spawn_blocking`, vignette par `createObjectURL`) étaient déjà en place
et n'ont pas été touchés ; aucun des correctifs candidats restants n'a été appliqué. Ce qui
manque reste **un collage réel dans l'application lancée** — mais cette fois, il écrira.

### T-117 — Badge « Session 5h saturée » reste affiché après expiration du compte à rebours

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-09-02 · **Clos** 2026-09-10

Constat brut, capture d'écran du bandeau d'IAction v0.5.0, 2026-09-02 :

Le bandeau d'état de session affiche **deux badges contradictoires** :
- Badge rouge : « ⚠ Session 5h saturée — réinitialisation dans **0** »
- Badge à droite : « Session **100%** · 0 »

Le compte à rebours est arrivé à **0** : la fenêtre de saturation de 5 h a expiré. Or dans
le même temps :

- L'agent **travaille normalement** : les appels d'outils s'enchaînent (`Bash`, `Read`,
  `mcp__studio__ask_user`), le champ de saisie affiche « L'agent travaille… »
- Le bouton « Arrêter » est actif
- L'API répond — il n'y a plus de limite active

Plus haut dans la même conversation, un tour précédent avait bien été coupé par « You've hit
your session limit · resets 12:40pm (Europe/Paris) ». C'est cette saturation-là qui a expiré ;
le badge n'a jamais été remis à zéro après le reset.

**Symptôme** : le badge « Session 5h saturée » et le compteur « 100% » ne se réinitialisent pas
quand la fenêtre de 5 h expire (compte à rebours ≤ 0), même quand des tours s'exécutent avec
succès après. Information trompeuse : l'utilisateur croit être bloqué alors que tout fonctionne.

**Piste** : l'état de saturation est posé à la réception de l'erreur de limite et n'est jamais
reconditionné ni par l'expiration du deadline (rebours ≤ 0) ni par le succès d'un tour
suivant. À vérifier dans le code du bandeau/état de session — le fichier concerné devrait
lire le reste de la fenêtre de 5 h et remettre le badge à zéro quand le délai a expiré, ou
le remettre à zéro dès qu'un appel d'outil réussit après la saturation.

**Corrigé le 2026-09-10.** La piste était juste, mais il y avait DEUX endroits, pas un — et
c'est pour ça que le badge tenait :

1. `pickSaturatedWindow` (`encartConso.tsx`) ne regardait que `utilization >= 98`, sans jamais
   consulter `resetsAt`. C'est lui qui produisait le badge exact de la capture ;
2. `ClaudeUsageBlock` forçait le donut saturé tant que `claudeSaturation` — posé au refus de
   la sonde (T-059) — restait non nul, sans vérifier que son échéance était encore à venir.

Corriger l'un sans l'autre n'aurait fait disparaître que la moitié de la contradiction.

Le verdict devient une fonction pure, `fenetreEncoreSaturee(fenêtre, maintenant, seuil)`
(`releveConso.ts`), que les deux chemins appellent : sous le seuil ⇒ jamais saturée ; au-dessus
⇒ saturée seulement tant que `resetsAt` est à venir. Un `resetsAt` absent ou illisible garde
l'état saturé — un aveu d'ignorance ne doit pas se lire comme un feu vert.

**Le troisième défaut, le moins visible** : même avec le bon calcul, rien ne rejouait le test.
La saturation n'expire pas sur un événement, elle expire sur le TEMPS QUI PASSE — sans
re-rendu, `Date.now()` n'est jamais relu et le badge d'un utilisateur qui ne touche à rien
reste faux indéfiniment. Le battement de cadence existant (30 s, T-086) porte désormais aussi ce
re-rendu : aucun second minuteur n'a été créé, ce qui aurait rouvert T-086.

« réinitialisation dans 0 » et les rebours négatifs ne peuvent plus s'afficher : passée
l'échéance, le libellé dit « réinitialisée ».

Ce qui n'a PAS bougé, volontairement : le silence commandé à la sonde (`cadenceUsage.ts`) et le
magasin de réouverture du réveil (`reouvertureQuota.ts`). Faire retomber un affichage ne doit
pas museler une mesure — les magasins restent séparés (T-120, point 5). Seule la LECTURE qu'en
fait le rendu a changé.

Test qui échouait avant : « au-delà du seuil, réouverture DÉJÀ PASSÉE ⇒ plus saturée »
(`releveConso.test.ts`), le cas de la capture, mot pour mot.

### T-128 — L'enregistrement capte le silence d'une carte muette pendant que la réunion sort sur le casque

**Type** bug · **Prio** P1 · **Statut** ouvert · **Créé** 2026-09-09 · **Rouvert** 2026-09-09

> Ticket clos trop vite le matin même : le remède était un geste manuel au terminal, pas une
> correction. La panne s'est reproduite à la réunion suivante, 1 h 30 plus tard. Il reste ouvert
> tant que l'application ne choisit pas sa source toute seule.

Constat utilisateur du 2026-09-09, en pleine réunion Teams, verbatim : « je suis en réunion
mais le système n'enregistre pas, le son sort sur mon casque ». Capture d'écran de l'encart
*Enregistrer* à l'appui : **00:00:40 écoulées, micro −87 dB, système −99 dB** — deux jauges
au plancher, aucune alerte, l'enregistrement continue comme si de rien n'était.

**Ce qui se passait.** `ffmpeg` tournait bien, avec deux entrées PulseAudio figées au
lancement :

- micro → `bluez_input.XX:…` (le micro du casque Bluetooth) — correct ;
- système → `alsa_output.usb-Generic_USB_Audio_…iec958-stereo.monitor`.

Or Firefox avait **deux** flux de sortie ouverts : un sur cette carte USB S/PDIF, silencieux,
et un second sur `bluez_output.XX:…` — le casque, là où l'audio de la réunion sortait
réellement. La capture système écoutait donc le moniteur de la carte muette. Mesure RMS sur
3 s, faite pendant la réunion :

| source | RMS | crête |
|--------|-----|-------|
| moniteur casque Bluetooth | −26,2 dB | −7,8 dB |
| micro du casque | −21,8 dB | −2,3 dB |
| moniteur USB S/PDIF (celle qui était captée) | −99,0 dB | −99,0 dB |

**Remède appliqué à chaud**, sans couper l'enregistrement : `pactl move-source-output` du
flux `ffmpeg` système *et* du `parec` qui alimente la jauge, vers le moniteur du casque. Les
segments du répertoire de captation en cours ont repris du son immédiatement. Les ~3 premières
minutes de la réunion restent muettes côté système — irrécupérables.

**Ce que le ticket laisse ouvert.** Le geste manuel a sauvé la séance, pas le mécanisme :

1. **Le choix de la source est un pari fait une fois.** Il faudrait viser le moniteur du sink
   qui porte effectivement l'audio (sink par défaut, ou celui dont un `sink-input` est actif
   et non silencieux), et non un nom mémorisé d'une session précédente.
2. **Un canal à −99 dB pendant que d'autres sinks tournent est un échec muet**, exactement ce
   que la doctrine d'observabilité interdit : au bout de quelques secondes de plancher, ça
   doit crier dans le journal *et* dans l'encart, pas attendre que l'utilisateur regarde la
   jauge.
3. **Rien ne permet de corriger depuis l'interface.** Un sélecteur de source système à chaud
   dans l'encart *Enregistrer*, à côté de celui du micro, aurait réglé l'incident en deux
   clics sans terminal.
4. **Un changement de sortie en cours de séance** (casque qui se connecte, se déconnecte,
   bascule A2DP↔HFP) reproduira le problème tant que la source ne suit pas.

**Deuxième occurrence — 2026-09-09, 11 h 32.** Nouvelle réunion Teams, constat identique :
« nouvelle réunion le son n'est pas enregistré ». Le matériel avait changé — casque **USB
Logitech** au lieu du Bluetooth — mais le schéma est mot pour mot le même : `ffmpeg` captait
`alsa_output.usb-Generic_USB_Audio_…iec958-stereo.monitor` pendant que Firefox jouait la
réunion sur `alsa_output.usb-Logitech_…analog-stereo`. Mesures RMS sur 3 s :

| source | RMS |
|--------|-----|
| moniteur casque Logitech | −16,5 dB |
| moniteur USB S/PDIF (celle qui était captée) | −99,0 dB |

Même remède manuel (`pactl move-source-output`), ~1 minute perdue cette fois. **La carte USB
S/PDIF est le point fixe de la panne** : elle reste `RUNNING` avec un flux Firefox ouvert en
permanence — donc elle a toujours l'air d'un candidat valable — mais elle ne porte jamais
l'audio de la réunion. C'est elle que la source mémorisée désigne à chaque démarrage.

**Garde-fou temporaire.** Un script hors dépôt (`garde-son.py`, dans le répertoire de travail
de la session) surveille le canal système toutes les 15 s et le rebranche sur le moniteur qui
porte réellement du son après 3 contrôles muets consécutifs. Deux leçons pour la version qui
entrera dans l'application :

- **une mesure d'une seconde ne vaut rien** : l'ouverture d'un flux `parec` commence par du
  silence de remplissage, et la première version du garde-fou a diagnostiqué à tort −99 dB
  sur un canal qui était à −16 dB. Il faut mesurer ~3 s et jeter la première moitié ;
- **il faut une hystérésis** : un blanc dans la conversation ne doit pas déclencher de
  bascule. Trois contrôles muets d'affilée, et un candidat qui dépasse largement le seuil.

**Troisième signalement — 2026-09-09, 11 h 38 : « toujours pas d'enregistrement système ».**
Cette fois le constat était FAUX, et c'est le plus instructif des trois. Mesure du fichier
réellement écrit, segment de 5 min terminé puis segment en cours :

| segment | piste micro | piste système |
|---------|-------------|---------------|
| `…_000.mkv` (5 min) | mean −21 dB | **mean −19,3 dB · max −0,1 dB** |
| `…_001.mkv` (3 min 19 en cours) | — | **mean −19,6 dB · max 0,0 dB** |

**L'enregistrement système fonctionnait depuis la redirection de 11 h 33.** Ce qui était muet,
c'est la **jauge** : l'application **relance périodiquement ses sondes `parec`** (relance
observée à 11 h 37 min 56, PID neufs) et chaque relance repart sur la source mémorisée — la
carte USB S/PDIF muette. La correction manuelle du canal `ffmpeg` tient ; celle de la jauge est
effacée à la relance suivante.

**Conséquence, et c'est le vrai défaut** : pendant une réunion, l'utilisateur n'a aucun moyen
de savoir si son enregistrement est bon. La seule chose qu'il voit — la jauge — est
précisément celle qui ment, et elle ment dans le sens le plus coûteux : elle annonce une
panne là où il n'y en a pas. Un utilisateur qui croit son enregistrement perdu prend des
notes en catastrophe, ou relance la capture, pendant que la réunion continue.

**Ce que la correction doit couvrir**, au-delà du choix de source déjà listé plus haut :

5. **La jauge et l'enregistrement doivent lire la MÊME source, par construction.** Deux
   chemins séparés vers le même réglage, c'est deux chances de diverger — ici la divergence
   transforme un enregistrement sain en fausse alerte.
6. **Une relance de sonde ne doit pas ressusciter un réglage périmé** : la source se
   redemande au moment de la relance, elle ne se recopie pas depuis la valeur de démarrage.
7. **La jauge devrait dire ce qu'elle écoute** — le nom du périphérique sous le niveau. Trois
   signalements auraient été un seul coup d'œil.

*Observation annexe, à surveiller sans en faire un ticket pour l'instant* : `max_volume` à
−0,1 puis 0,0 dB sur la piste système — la capture frôle l'écrêtage. À vérifier au calme sur
un enregistrement complet ; si c'est constant, un gain d'entrée est à revoir.

**Constat du 2026-09-10, en cherchant par où corriger : le code visé n'est PAS dans ce dépôt.**
Aucune occurrence de `ffmpeg`, `parec` ou `pactl` dans `ui/src`, `sidecar/src` ou `src-tauri/src`
(seul `docs/tickets.md` les mentionne, dans ce ticket) ; IAction n'a pas d'encart « Enregistrer »
ni de chaîne de captation de réunion. La panne est réelle et le dossier est excellent, mais les
sept points de correction portent sur l'application de captation, pas sur IAction — ce backlog ne
peut pas les solder. À déplacer vers le backlog de l'application concernée, en gardant ici, au
plus, le renvoi. Laissé OUVERT et non modifié tant que l'arbitrage n'est pas rendu : le supprimer
d'ici sans destination perdrait un dossier qui a coûté trois signalements et deux réunions.

Voir aussi T-056 (le greffon PipeWire de GStreamer plante par intermittence) : même couche
audio, même absence de retour quand elle décroche.

### T-129 — L'encart GPU disparaît en silence : `nvidia-smi` échoue 12 fois/min sans journalisation

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-09-09 · **Clos** 2026-09-10

Constat utilisateur du 2026-09-09 : « l'encart gpu a disparu » — capture de l'en-tête à l'appui. CPU 4 %, T.CPU 67°, RAM 61 % sont présents ; le groupe GPU/T.GPU a purement disparu.

**Cause racine : le pilote NVIDIA a été mis à jour par apt sans redémarrage depuis** ; l'ancien module reste chargé et NVML refuse de s'initialiser. Module noyau chargé (`/proc/driver/nvidia/version`) : **580.173.02** · Bibliothèque/paquets installés : **580.178.04** (`nvidia-driver-580-open`, `nvidia-dkms-580-open`, `nvidia-utils-580`, `libnvidia-ml.so.580.178.04`). Commande manuelle :

```
nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits
Failed to initialize NVML: Driver/library version mismatch
NVML library version: 580.178
```

Code de sortie : **18**. **Le code d'IAction n'est pas en cause pour la disparition elle-même** — c'est un problème de matériel/pilote qui demande un redémarrage du poste. Aucune entrée dans `~/.config/net.duvam.iaction/logs/app.jsonl` ni pour l'erreur NVML, ni pour la disparition de l'encart.

**Ce qui nous appartient — l'objet réel du ticket** : deux défauts dans le code.

1. **Échec muet.** `gpu_stats()` dans [system_probe.rs](../src-tauri/src/system_probe.rs) fait `if !output.status.success() { return (None, None, None, None) }` : le message stderr est jeté, rien n'est journalisé. Côté [App.tsx](../ui/src/App.tsx), `gpuPresent` passe à `false` et le groupe n'est pas rendu. L'utilisateur voit un encart qui s'évapore et n'a **aucun moyen depuis l'application** de savoir si sa carte est morte, si le pilote a bougé, ou si un bug d'affichage est apparu. C'est exactement ce que la doctrine d'observabilité interdit (cf. T-112, T-125, T-057).

2. **Boucle d'échec non amortie.** Le verrou `NVIDIA_SMI_INTROUVABLE` ne se ferme QUE sur `ErrorKind::NotFound`. Ici le binaire existe mais échoue avec un code non nul, donc il est relancé **à chaque tick de 5 s — 12 spawns par minute, indéfiniment**, pour le même verdict. Le commentaire justifie cette intention (« un pilote qui se recharge, une carte momentanément occupée, la sonde doit se rétablir toute seule ») ; malheureusement un mismatch NVML ne se résoudra jamais sans redémarrage. Il manque une position intermédiaire entre « on réessaie éternellement en silence » et « on abandonne ».

**Pistes de correction** (sans implémenter) :

- Lire `stderr` de `nvidia-smi` en cas d'échec et journaliser la cause **une fois** (au premier échec, et à chaque changement de message), pas à chaque tick — sinon on refait T-057.
- Faire remonter cette cause jusqu'à l'UI (un champ du `SystemStats`, par ex. `gpuIndisponible: Option<String>`) pour qu'un survol de l'en-tête ou une pastille GPU en état « muet » dise POURQUOI le GPU n'est plus mesuré au lieu de faire disparaître le groupe sans laisser de trace.
- Espacer les tentatives après N échecs consécutifs du même type (repli exponentiel plafonné) plutôt que de marteler toutes les 5 s.

**Corrigé le 2026-09-10** — les deux défauts qui nous appartenaient, pas la panne matérielle
(qui demande toujours un redémarrage du poste).

**Journalisation.** Au premier échec de `nvidia-smi` — binaire présent, code non nul, ou spawn
en échec pour une raison autre que `NotFound` — une ligne `error` part sur `app.jsonl` avec la
cause VERBATIM : stderr et code de sortie. Tant que la cause ne change pas, plus rien n'est
réécrit ; un changement de message rejournalise ; un retour au succès écrit une ligne `info`
« sonde GPU rétablie ». C'est la seule façon de tenir les deux exigences contraires du dossier :
T-129 veut qu'on sache, T-057 interdit qu'on crie 12 fois par minute.

**Repli.** Base 5 s (un échec isolé retente à la cadence normale — l'intention d'origine est
préservée), doublement à chaque échec consécutif, plafond 5 minutes. Un succès remet tout à
zéro : compteur, prochain essai, cause mémorisée. La sonde se rétablit donc toujours seule,
sans redémarrer l'application, mais un mismatch NVML ne coûte plus 12 spawns par minute
jusqu'au redémarrage du poste.

**L'encart ne s'évapore plus.** `SystemStats` porte `gpuIndisponible: string | null`, remonté
jusqu'à l'en-tête : quand la mesure manque MAIS qu'une cause est connue, le groupe GPU reste,
réduit à une pastille rouge « GPU ! » dont le survol donne « GPU non mesuré : <cause> ». Un GPU
simplement absent du poste laisse `gpuIndisponible` à `null` et le groupe disparaît comme avant
— l'absence de carte n'est pas une panne, et il ne fallait pas la transformer en alerte
permanente. Aucun bandeau, aucune ligne de CSS ajoutée.

**Effet de bord assumé — extraction.** Ajouter la logique de repli poussait `system_probe.rs`
à 818 lignes, au-dessus de la limite de 800 sans dérogation. Plutôt que d'ouvrir une
dérogation, toute la logique GPU est sortie dans `src-tauri/src/gpu_probe.rs` (424 lignes) ;
`system_probe.rs` retombe à 434. Le cliquet a servi à ce pour quoi il existe.

**Deux réserves consignées, honnêtement :**

1. `system_stats` prend désormais un `AppHandle` (il lui faut pour journaliser), et aucune
   infrastructure de test du projet n'en fournit un. Le test `stats_ne_paniquent_jamais` ne
   passe donc plus par la commande Tauri : il REJOUE son corps avec les fonctions pures qui la
   composent. La couverture des fonctions est intacte, mais le câblage de la commande
   elle-même n'est plus vérifié — si son corps dérive, le test ne le verra pas. À reprendre le
   jour où le projet se dote d'un `AppHandle` de test.
2. Aucun test ne verrouille la correspondance entre `docs/protocol.md` et les commandes Tauri
   « poste de travail » — `sidecar/test/protocol.test.js` couvre le protocole du sidecar, pas
   ce bloc-là. La documentation de `gpuIndisponible` est donc à jour aujourd'hui, sans rien
   pour l'empêcher de vieillir. Angle mort à traiter à part.

8 tests Rust ajoutés sur la logique pure du repli (deux échecs de même cause ⇒ une seule
ligne ; cause qui change ⇒ nouvelle ligne ; N échecs ⇒ intervalle croissant ; plafond jamais
dépassé ; succès ⇒ cadence nominale). **98 tests Rust au vert, code de sortie 0.**

[gpu_probe.rs](../src-tauri/src/gpu_probe.rs) · [system_probe.rs](../src-tauri/src/system_probe.rs) · [App.tsx](../ui/src/App.tsx) · [systemClient.ts](../ui/src/systemClient.ts) · [protocol.md](protocol.md)

## Archivés

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-110 | bug  | P2   | fait   | Fermer le DERNIER onglet de fichier laisse un panneau blanc : l'onglet visé (« conversation ») n'existe pas, ni éditeur ni fil ne s'affiche |
| T-109 | feat | P2   | fait   | Fermer un ENSEMBLE d'onglets d'un geste : clic droit (les autres / à droite / tous / les enregistrés) et clic milieu, comme partout ailleurs |
| T-108 | feat | P2   | fait   | Clic droit sur une référence du fil : le même menu que l'arbre de fichiers (ouvrir avec l'app déclarée, avec le système, dans l'éditeur, copier le chemin) |
| T-107 | bug  | P2   | fait   | Le fil exprime ses chemins en `~/…`, que l'interface refusait par principe de résoudre — or le système sait dire où est le dossier personnel |
| T-106 | bug  | P2   | fait   | « Constamment des liens non cliquables » : trois culs-de-sac sur le même trajet (absolu hors projet non cliquable, fichier rangé par une commande introuvable, type sans règle sans issue) |
| T-105 | bug  | P2   | fait   | Une référence relative citée par le modèle est cherchée SOUS LA RACINE DU PROJET seulement : « stl/PLATEAU-complet.stl » introuvable alors que le tour venait de l'écrire, ailleurs |
| T-104 | feat | P3   | fait   | Ouvrir une référence de fichier citée dans le fil AU SURVOL, sans clic (option, désactivée par défaut) |
| T-098 | doc  | P3   | fait   | `usage.stats` répond un champ `sobriete` que `docs/protocol.md` ne documente nulle part |
| T-074 | feat | P3   | fait   | Signal d'escalade : repérer les tours refaits par un modèle supérieur — la seule preuve qu'un routage est bon et pas seulement bon marché |
| T-059 | bug  | P2   | fait   | La jauge de session affichait 94 % pendant que l'abonnement était saturé : relevé sans âge, refus non entendus |
| T-063 | bug  | P3   | fait   | Panneau Sessions : les titres IA convergent — dix sessions indiscernables autour de la même tâche |
| T-076 | bug  | P2   | fait   | 17 des 38 tours en erreur n'ont aucun message de cause : un échec consigné sans sa raison reste un échec muet |
| T-099 | bug  | P2   | fait   | `FileEditor` appelait un composant jamais écrit : ouvrir un .html plantait la vue, et RIEN dans la chaîne ne type-checkait l'UI |
| T-072 | feat | P2   | fait   | Zone Abonnement : trois devises (quota, payé, équivalent API), rythme de combustion et projection de fin de fenêtre |
| T-071 | feat | P2   | fait   | Zone Sobriété : délégation, cache, concentration du coût et fiabilité, chacun apparié à un signal de qualité |
| T-064 | feat | P2   | fait   | Une image jointe ne peut pas partir pendant un tour : `claude.push` est texte seul, alors que l'entrée streamée sait porter une image |
| T-087 | bug  | P1   | fait   | Une demande glissée en cours de tour est perdue en silence quand le tour n'a plus d'outil à appeler : `claude.push` acquitte le dépôt, pas l'injection |
| T-058 | tech | P2   | fait   | 22 des 69 méthodes du protocole sans test de bout en bout — toutes concentrées sur `mcp.*` et `orch.*` |
| T-097 | feat | P2   | fait   | L'application dit qu'une version existe : la page Système compare à la dernière release publiée — descendu de la ligne publique v0.5.0 |
| T-096 | bug  | P2   | fait   | Windows : la sonde GPU faisait clignoter une console toutes les 5 s, et relançait sans fin un `nvidia-smi` absent — descendu de la ligne publique v0.4.1 |
| T-094 | feat | P3   | fait   | Sonde système : une pastille par organe (CPU, RAM, GPU), teintée, au lieu d'une bande de six anneaux indifférenciés |
| T-092 | bug  | P1   | fait   | Le fil mélange la parole du fil et le travail des sous-agents : un mot coupé en deux par leurs outils, et un paragraphe entier réémis par-dessus |
| T-093 | bug  | P3   | fait   | L'encart des tâches de fond affiche quinze lignes de shell : la description d'un `Bash` détaché est la commande entière |
| T-091 | bug  | P3   | fait   | L'encart « Sous-agents du dernier tour » parle au présent d'un tour vieux de plusieurs jours dès qu'on rouvre une conversation |
| T-090 | bug  | P2   | fait   | Un nom de domaine cité dans une réponse est pris pour un fichier : le clic répond « introuvable dans le projet » à propos d'un site web |
| T-089 | bug  | P1   | fait   | La modale de question couvre l'app : il faut trancher sur ce qu'on ne peut plus aller regarder |
| T-075 | feat | P3   | fait   | Comparaison à la période précédente, et dénominateur honnête sur l'encart Routage |
| T-073 | tech | P3   | fait   | `claude-windows.jsonl` : 17 917 instantanés et 3,5 Mo pour 1083 tours — revoir la cadence d'échantillonnage |
| T-070 | feat | P3   | fait   | Rien ne signale qu'une période est incomplète : le lundi, Semaine affiche les chiffres de Jour |
| T-069 | bug  | P3   | fait   | Étiquettes de courbe superposées quand les quatre séries convergent vers le bas de la fenêtre |
| T-068 | bug  | P2   | fait   | « Part à coût nul : 98 % » rassure pendant que la fenêtre 5 h sature — l'indicateur compte des dollars là où la rareté est un quota |
| T-067 | bug  | P2   | fait   | « Contexte moyen » a une médiane de 6 tokens : le KPI mesure `input_tokens` hors cache, pas le contexte |
| T-084 | feat | P2   | fait   | Panneaux latéraux rétractables : Ctrl+L dégage l'écran, la poignée les rend, et l'état survit au lancement |
| T-015 | bug  | P1   | fait   | Un tour Claude peut mourir sans laisser AUCUNE trace dans le journal |
| T-083 | bug  | P1   | fait   | La frappe traîne dans tout le composeur (Chat ET Projets) : le fond plein écran masqué faisait repeindre TOUT le viewport à chaque caractère |
| T-082 | bug  | P1   | fait   | « 26,1 % de tours en erreur » ne compte que des interruptions de l'utilisateur : le statut `aborted` n'est jamais écrit pour un tour de chat |
| T-081 | bug  | P2   | fait   | L'app lance des sous-agents qu'elle ne sait pas lister : `agents.list` ignore `~/.claude/agents`, que le SDK charge pourtant — leur modèle déclaré est invisible |
| T-080 | feat | P1   | fait   | Suppression du mode Auto des Projets, remplacé par un modèle par défaut réglable (opus-5) |
| T-079 | bug  | P2   | fait   | La stratégie « descendante » ne descend jamais et ne lit pas le prompt : le mode Auto des Projets n'arbitre rien |
| T-078 | tech | P1   | fait   | Le sommet de la table était `fable-5`, et la stratégie descendante y envoie TOUT : 23,8 % des tokens pour 39,3 % du coût |
| T-077 | feat | P2   | fait   | Mode Auto : le sélecteur disait « Auto » sans jamais dire sur QUOI le tour part, et la délégation n'était visible nulle part hors du transcript |
| T-066 | tech | P1   | fait   | Socle de supervision : la ventilation `modelUsage` était parsée puis jetée — le travail des sous-agents était rangé sous le modèle du fil |
| T-062 | feat | P2   | fait   | Deux fenêtres, un processus, un sidecar : travailler sur deux projets en même temps |
| T-065 | bug  | P1   | fait   | Le sélecteur de modèle tuait toute l'interface : l'événement lu DANS l'updater de `setState`, quand React l'a déjà vidé |
| T-009 | tech | P3   | fait   | Dev : la fenêtre s'ouvrait avant que vite soit chaud, l'IPC restait muet sans un mot |
| T-030 | bug  | P1   | fait   | La fenêtre gelait sans un mot quand le process de contenu WebKit mourait : les deux journaux le disent, et la fenêtre aussi |
| T-061 | tech | P2   | fait   | Un fichier d'état par projet et par conversation : les monolithes de 12 Mo et 467 Ko sont éclatés, sauvegardés, migrés |
| T-060 | bug  | P2   | fait   | Le refus d'une 2e session de dev (garde T-028) était invisible depuis l'icône : notification ajoutée |
| T-055 | bug  | P2   | fait   | Importer `./journal` sous Node faisait échouer la chaîne tests verts : l'IPC s'installait par effet de bord d'import |
| T-054 | tech | P2   | fait   | La protection de branche `main` promise par le script de publication n'existait pas : posée, à l'exact de la checklist |
| T-052 | bug  | P2   | fait   | Les tours de projet partaient avec un prompt système VIDE : le preset Claude Code est demandé explicitement |
| T-012 | tech | P1   | fait   | Dependabot : les quatre paquets réellement livrés sont montés, le reste ne part pas dans le produit |
| T-045 | tech | P2   | fait   | Réseau d'entreprise : un encart pour saisir proxy et autorité, et le PAC dit non lu |
| T-023 | tech | P2   | fait   | Profils de fournisseur : la gratuité et la jauge de solde sont déclarées, plus devinées |
| T-036 | bug  | P3   | fait   | Swiftask est structurellement muet sur le coût, et la recherche web n'a rien à facturer |
| T-053 | bug  | P2   | fait   | Le verrou du runner déclarait mort tout détenteur hors Linux : `/proc` sans repli, CI Windows rouge |
| T-025 | bug  | P2   | fait   | Agents `*-with-search` : la recherche faite deux fois cassait un tour sur cinq, R9 les écarte |
| T-019 | bug  | P1   | fait   | Les questions interactives n'étaient plus sollicitées : l'outil n'était annoncé que par une fiche de RAG |
| T-008 | bug  | P3   | fait   | `usage.openrouter` au démarrage : une course avec la poussée des fournisseurs, journalisée en erreur |
| T-007 | bug  | P2   | fait   | `ollama.ps` répondait une page web : une SONDE dont l'échec est nominal criait « error » 140 fois |
| T-049 | feat | P3   | fait   | Un HTML cité dans un rapport s'ouvrait dans l'éditeur interne, jamais dans le navigateur déclaré |
| T-024 | bug  | P3   | fait   | Un chemin hors projet cliqué dans une transcription annonçait « introuvable » alors qu'il existe |
| T-041 | tech | P3   | fait   | Empaquetage local : `target/release/sidecar/` reversait dans l'AppDir des fichiers disparus de la source |
| T-051 | bug  | P1   | fait   | La suite de tests travaillait dans le VRAI `~/.local/share`, et pouvait y déplacer des données |
| T-050 | bug  | P1   | fait   | Verrou orphelin : une modification de manifeste pendant une synchro bloquait toutes les suivantes |
| T-040 | bug  | P1   | fait   | L'image `ia-runner` ne se construisait plus : le Dockerfile ne copiait pas `sidecar/scripts/` |
| T-047 | tech | P2   | fait   | La table de routage par défaut était écrite deux fois, sans rien pour vérifier qu'elles concordent |
| T-046 | bug  | P2   | fait   | `claude-opus-5` absent des sélecteurs : la liste des modèles de l'abonnement était recopiée dans trois fichiers |
| T-034 | tech | P2   | fait   | Le cliquet de taille était rouge sur `master` : `src-tauri/src/sidecar.rs` à 807 lignes |
| T-043 | bug  | P1   | fait   | Poste d'entreprise : tous les fournisseurs en « erreur réseau », le fetch de Node ignorait le proxy |
| T-044 | bug  | P2   | fait   | « erreur réseau: fetch failed » sans le code de cause : quatre pannes, un seul message |
| T-042 | bug  | P1   | fait   | L'installeur n'embarquait pas la version testée : le bundle réinstallait ses dépendances sans verrou |
| T-038 | bug  | P1   | fait   | L'AppImage ne se construisait plus : linuxdeploy casse le CLI Claude avec `patchelf`, puis abandonne |
| T-039 | bug  | P1   | fait   | `ModelPicker.tsx` et `modelPicker.ts` : deux noms que Windows confond, l'installeur ne compilait plus |
| T-037 | bug  | P2   | fait   | Un test neuf construisait un chemin en `/D:/…` : la CI Windows échouait sur « sans-empreinte » |
| T-035 | bug  | P2   | fait   | La dépense réelle n'était affichée nulle part : « Débord du mois » ne compte que le routage auto |
| T-033 | bug  | P2   | fait   | Supervision : Jour et Semaine affichaient les mêmes KPI, et ◀ ▶ sautait d'un mois |
| T-032 | feat | P2   | fait   | Sélecteur de modèle illisible : 300 slugs bruts dans un `<select>`, favoris en double |
| T-031 | bug  | P1   | fait   | L'écriture dans le Chat traînait : un rendu de page complet par fragment reçu |
| T-021 | bug  | P2   | fait   | `models.list` ne montrait que 8 modèles là où le fournisseur en sert 142 |
| T-022 | bug  | P2   | fait   | Un usage à zéro était enregistré comme zéro, jamais comme « inconnu » |
| T-028 | bug  | P1   | fait   | Relancer `dev.sh` ouvre une fenêtre morte-née, sans sidecar |
| T-027 | bug  | P1   | fait   | L'avis « aucune donnée reçue du fournisseur » s'affichait à chaque réponse |
| T-010 | feat | P2   | fait   | Recherche web pour le moteur neutre (Chat) — aujourd'hui réservée à Claude |
| T-020 | bug  | P1   | fait   | En développement, l'application exécutait un sidecar périmé de trois jours |
| T-017 | bug  | P1   | fait   | La coquille journalisait le démarrage du sidecar, jamais sa mort |
| T-018 | bug  | P1   | fait   | Chat : le fournisseur choisi retombait silencieusement sur Claude |
| T-016 | bug  | P2   | fait   | Le sidecar annonçait la version 0.1.0, et un test verrouillait ce mensonge |
| T-014 | bug  | P1   | fait   | CI Windows en échec : un test construisait un chemin sans lettre de lecteur |
| T-013 | bug  | P2   | fait   | Le miroir des tickets déduisait le dépôt du remote : inutilisable en local |
| T-011 | bug  | P1   | fait   | L'audit de publication ne voyait pas les fichiers non suivis |
| T-005 | bug  | P1   | fait   | Le débord R3 ignore la fenêtre 7 jours : l'Auto route vers un abonnement saturé |
| T-006 | bug  | P1   | fait   | Tour abonnement muet : curseur infini au lieu d'un état « attente/limite atteinte » |
| T-004 | bug  | P1   | fait   | Le fil redescend tout seul pendant un streaming |
| T-003 | bug  | P1   | fait   | L'allowlist `tools:` d'un agent n'est pas appliquée (moteur claude) |
| T-002 | feat | P3   | fait   | Lien « dernier rapport qualité » dans la page Système |
| T-001 | feat | P3   | fait   | Page « Tickets » dans l'app |

---

### T-110 — Fermer le dernier onglet de fichier laissait un panneau blanc

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-30 · **Clos** 2026-08-30

Relevé en lisant le code de fermeture d'onglets pour T-109, pas en exploitation — mais il était
atteignable d'un clic : fermer le SEUL onglet de fichier ouvert, alors qu'il est actif.

`handleCloseTab` retombait alors sur `setActiveTab("conversation")`. Or depuis l'unification de
la barre, un onglet de conversation s'appelle `conv:<id>` (`CONV_TAB_PREFIX`, voir
[modeleProjet.ts](../ui/src/modeleProjet.ts)) : la chaîne « conversation » n'est donc ni un
onglet de conversation (`isConvTab` répond non) ni un chemin de fichier ouvert. Le corps de la
page (`agent-tabs__body`) affiche le fil dans le premier cas, l'éditeur dans le second, et
**rien** ici : panneau vide, jusqu'à ce que l'utilisateur reclique un onglet. Vestige d'avant les
onglets de conversation, que personne n'a suivi.

**Corrigé** avec T-109 : la nouvelle fermeture d'onglets de fichiers vise le voisin de gauche
encore ouvert et, à défaut, la conversation courante — `convTabId(activeSessionId)`, un onglet
qui existe. `EMPTY_TAB` ne reste que pour le cas où il n'y a plus aucune session.

### T-109 — Fermer un ensemble d'onglets d'un geste

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-30 · **Clos** 2026-08-30

Demande utilisateur du 2026-08-30 : « j'aimerais bien de la gestion d'onglets pour pouvoir fermer
rapidement un ensemble d'onglets ». La barre ne savait fermer qu'UN onglet à la fois (le « × »,
ou Ctrl+Suppr sur l'actif) : une session de travail un peu longue laissait dix onglets à fermer
un par un.

**Le standard, d'abord.** VS Code, Chrome, Firefox et IntelliJ proposent tous le même noyau au
clic droit — « les autres », « à droite », « tout » — plus le clic milieu pour fermer. VS Code et
IntelliJ y ajoutent « les enregistrés » / « les non modifiés ». C'est ce noyau qui est repris,
avec les libellés du projet.

**Ce qui est fait.** Clic droit sur un onglet : « Fermer », « Fermer les autres … », « Fermer les
… à droite », « Fermer toutes les conversations » / « Fermer tous les fichiers », et « Fermer les
fichiers enregistrés » sur un onglet de fichier. Les actions restent cantonnées à la FAMILLE de
l'onglet cliqué (conversations, fichiers) : « à droite » à cheval sur les deux n'aurait aucun
sens dans une barre qui les mélange. Un item sans cible est grisé, jamais masqué — la position
des items ne bouge pas d'un clic droit à l'autre. Clic milieu = fermer, par le même chemin que le
« × » (mêmes garde-fous).

**Un lot ne force jamais la main.** Deux onglets refusent d'être emportés en masse : une
conversation dont le tour STREAME (la fermer perdrait le tour de vue — c'était déjà le refus du
« × ») et un fichier NON ENREGISTRÉ. Ni cinq confirmations natives d'affilée, ni cinq éditions
avalées : ces onglets restent, et le bandeau sous la barre dit lesquels et pourquoi (« 4 onglets
fermés · 2 conservés : 1 tour en cours, 1 fichier non enregistré. »). Un survivant muet aurait
été un échec muet de plus.

**Où ça vit.** La décision — quels onglets ce clic ferme, lesquels survivent, quel onglet devient
actif ensuite — est PURE et testée sans DOM ([fermetureOnglets.ts](../ui/src/fermetureOnglets.ts),
24 tests). Le rendu de la barre, jusque-là dupliqué à 99 % dans deux fichiers de ~2 800 lignes,
est extrait dans [BarreOnglets.tsx](../ui/src/BarreOnglets.tsx), partagé par Projets et Chat :
AgentPage.tsx perd 25 lignes et ChatPage.tsx 26, alors que la fonctionnalité, elle, grandit.

**Le piège qui a dicté la forme du code.** Les pages ne bouclent pas sur leur fermeture unitaire
pour traiter un lot : chaque passage lirait `openConversationIds`/`activeSessionId` dans l'état
React, figé jusqu'au rendu suivant — le deuxième onglet du lot rouvrirait le premier. Un lot se
décide donc en une seule passe, et le choix de l'onglet suivant doit sauter les voisins de gauche
fermés du même coup (`ongletApresFermeture`, testé sur ce cas précis).

### T-108 — Clic droit sur une référence du fil

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-08-30

Demande utilisateur du 2026-08-29, dans la foulée de T-104→T-107 : « on pourrait l'avoir en clic
droit ? »

Le clic gauche applique UNE politique : règle déclarée, sinon éditeur interne dans le projet,
sinon l'ouvreur du système. C'est le bon défaut, mais il ne laisse aucun choix — alors que
l'arbre de fichiers, lui, propose déjà ce choix au clic droit depuis le Lot 5 (« Ouvrir avec
KiCad », « Ouvrir avec l'application système », « Ouvrir dans l'éditeur »). Deux endroits qui
désignent le même fichier, deux libertés différentes : c'est la référence du fil qui est en
retard.

**Ce que ça demande, au-delà du menu.** Le clic gauche RÉSOUT et OUVRE d'un seul geste. Un menu a
besoin de la résolution SEULE, avant d'agir : pour savoir s'il faut proposer « Ouvrir avec Cura »
(règle déclarée pour ce fichier), s'il faut proposer l'éditeur interne (le fichier est-il sous la
racine du projet ?), et pour dire franchement « introuvable » dans le menu plutôt qu'après coup.
`ouvrirReference` mêle aujourd'hui les deux ; il faut les séparer — la résolution d'un côté,
l'action de l'autre, la seconde restant seule maîtresse de la politique par défaut.

**Réalisé.** `ouvrirReference` est désormais la composition de deux moitiés :
`resoudreReference` (dossier personnel, classement, racine du projet, bases du fil, recherche par
nom) rend un `ResolutionReference` — `fichier` (avec `sousProjet`, qui décide de l'éditeur
interne), `distant`, ou `impossible` avec sa raison — et l'action s'applique dessus. Preuve que
le refactor ne dévie pas : les 63 tests d'ouverture existants passent **sans une modification**.

Le menu ([menuReference.tsx](../ui/src/menuReference.tsx)) résout la référence à l'ouverture,
affiche « Résolution… » pendant l'attente, puis propose « Ouvrir avec <l'app déclarée> » (si une
règle s'applique), « Ouvrir avec l'application système », « Ouvrir dans l'éditeur » (seulement
sous le projet), « Copier le chemin » et « Ouvrir le dossier ». Une résolution impossible affiche
sa raison DANS le menu, au lieu d'un avis distant qui arrive après coup.

**Une seule politique d'ouverture.** Les items ne réimplémentent rien : ils rappellent le même
`ouvrirReference` que le clic gauche, avec un `forcer: "app" | "systeme" | "editeur"`. Deux
chemins d'ouverture qui divergent, c'est exactement la dette qui a produit les quatre défauts de
T-105/T-106/T-107 — le ticket se garde d'en créer une nouvelle.

Ce que le menu propose vit dans une fonction PURE (`itemsDuMenu`), pas dans le composant : le
projet n'a pas d'environnement DOM en test, donc une décision laissée dans le JSX serait une
décision que rien ne surveille. Mécanique de fermeture (clic ailleurs, Échap), positionnement et
classes CSS repris de `FileTree.tsx` à l'identique — aucun style nouveau, même famille visuelle,
et le menu se recale s'il déborde de la fenêtre.

Relecture d'intégration : le message de refus de l'éditeur portait « (T-024) », un numéro de
ticket dans un texte destiné à un humain — aucun autre avis du produit n'en porte. Reformulé
(« L'éditeur interne n'ouvre que les fichiers du projet. Hors du projet : … »), test aligné.

Le clic droit n'interfère pas avec l'ouverture au survol de T-104 : son `pointerdown` annule
l'armement en cours, comme le clic gauche.

Effet de bord bienvenu : la liste des tours, jusqu'ici en JSX inline dans `AgentPage.tsx`, est
devenue un composant `AgentTranscript` — le fichier-dieu passe de 2879 à **2869** lignes, budget
resserré d'autant.

### T-107 — `~/…` : une devinette refusée là où il suffisait de demander au système

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-08-29

Trouvé en vérifiant l'hypothèse de T-106 sur la transcription réelle de la session concernée,
plutôt qu'en la supposant. Les commandes qui ont rangé puis exploité le PDF ne contiennent
**aucun chemin absolu** — elles s'écrivent toutes ainsi :

```
cd ~/Nextcloud/administratif/impôts/2024/rectification && pdftotext … <fichier>.pdf
```

Le correctif de T-106 (élargir l'extraction à tout jeton ABSOLU d'une commande) n'aurait donc
rien trouvé dans ce fil : il n'y a rien d'absolu à y trouver. Le modèle écrit en `~`, et c'est
son droit — c'est la façon normale d'écrire un chemin personnel dans un shell.

**La doctrine à corriger.** L'en-tête de [refFichier.ts](../ui/src/refFichier.ts) affirme depuis
T-024 : « Il ne développe pas `~`. L'interface ne connaît pas le dossier personnel, et l'inventer
serait une devinette de plus. » La première phrase est un choix, la seconde est une erreur de
fait : personne n'a besoin d'INVENTER quoi que ce soit, le système sait répondre. `homeDir()` de
`@tauri-apps/api/path` (déjà couvert par la permission `core:default` du manifeste, aucune
capacité à ajouter) rend le dossier personnel réel. Refuser de le demander, c'était refuser une
information disponible — et faire porter le refus à l'utilisateur, à qui l'on répondait
« introuvable » à propos d'un fichier qui existe.

Trois conséquences en cascade, toutes constatées : `~/…` n'est pas cliquable ; `cd ~/…` ne
produit aucune base de résolution ; et un fichier cité par son seul nom, rangé sous un chemin
en `~`, reste introuvable.

**Réalisé.** Un module [dossierPersonnel.ts](../ui/src/dossierPersonnel.ts) demande le dossier
personnel au système UNE fois (`homeDir()`, cache module-scope + bus + hook, patron de
`survolReference.ts`) et ne jette jamais : sans réponse, le comportement reste EXACTEMENT celui
d'avant. `developperTilde` (pure) développe la référence avant tout classement ; un `~/…` sous la
racine du projet devient un chemin de projet ordinaire, ailleurs un absolu réel — plus un libellé
qu'on ne sait pas ouvrir. `basesDuFil` développe aussi les `~` des commandes : c'est ce qui rend
enfin utilisable un `cd ~/…`, la forme que le modèle emploie réellement.

`estReferenceCliquable` n'accepte `~/…` **que si le dossier personnel est connu** : la promesse ne
dépasse jamais ce qu'on sait tenir. Et le seul cas qui se NOMME encore au lieu de s'ouvrir est
celui-là — tilde non développé faute de réponse du système. La doctrine T-024 n'a pas été levée,
elle a été rendue exacte : on ne devine pas, on demande.

Câblage : `ContexteOuverture` prend désormais `turns` (et un `home` injectable pour les tests) au
lieu d'un tableau de bases pré-calculé — `ouvrirReference` résout le dossier personnel puis calcule
les bases lui-même, ce qui évite de faire porter un appel asynchrone à l'appelant. Une seule ligne
change dans `AgentPage.tsx`, dont le budget de cliquet est saturé.

**Vérité terrain.** Le cas exact de la capture a été rejoué contre le VRAI disque et le VRAI
dossier personnel (test temporaire, `fs.readFile`, commandes copiées de la transcription) : le PDF
cité par son SEUL NOM, rangé sous `~/Nextcloud/administratif/impôts/2024/rectification`, est
résolu et part vers l'ouvreur système — qui, sur ce poste, ouvre les PDF avec Papers. Figé en test
permanent avec une racine neutre. `refFichier.test.ts` + `dossierPersonnel.test.ts` : 69 cas,
`npm run verif` vert en entier.

### T-106 — « Constamment des liens non cliquables » : trois culs-de-sac sur le même trajet

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-08-29

Constat utilisateur du 2026-08-29, capture à l'appui, juste après T-105 (l'application n'avait
pas encore été relancée, le correctif n'était donc pas en service) : projet « OrgaIA », clic sur
`2026-08-17_formulaire-4805-difficultes-paiement.pdf` → « introuvable dans le projet », avec ce
commentaire qui élargit le sujet — « pareil pour le pdf, j'ai constamment des liens non
cliquables ».

Le fichier existe, vérifié : `…/Nextcloud/administratif/impôts/2024/rectification/` — le tour
l'avait rangé là quelques minutes plus tôt, hors du projet.

Trois défauts DISTINCTS se relaient sur ce trajet, et c'est leur enchaînement qui donne
l'impression de « constamment » :

**1. La résolution ne lit que les `cd`.** `basesDuFil` (T-105) tire les répertoires du fil des
cibles de `cd` et des `file_path` des `Read`/`Edit`. Or un fichier RANGÉ l'est par une commande
— `mv … /chemin/destination/`, `cp`, une redirection, un `-o` — dont le chemin absolu n'est
capté par aucune des deux règles. Le répertoire était écrit noir sur blanc dans le fil, et la
résolution passait à côté.

**2. Un chemin ABSOLU hors projet n'est pas cliquable du tout.** `estReferenceCliquable` le
refuse dès que la racine du projet est connue. C'est le point différé en clôture de T-105, et
c'est très probablement le cœur du « constamment » : le modèle cite le plus souvent des chemins
COMPLETS, et hors du projet ouvert ils ne deviennent même pas des puces. Le refus datait d'une
époque où la seule ouverture possible était l'éditeur interne, borné au projet ; depuis T-105
une application déclarée s'applique où qu'elle soit, la raison du refus est donc tombée.

**3. Un type sans règle déclarée n'a AUCUNE issue.** Le registre de l'utilisateur ne déclare rien
pour `pdf`. Dans le projet, l'éditeur interne affiche « Fichier binaire (…) » — un cul-de-sac.
Hors du projet, l'avis dit « hors du projet » et s'arrête là. Pourtant l'ouvreur du système
(`open_external` avec `command: null`, déjà câblé côté Rust et utilisé pour les liens) sait
ouvrir un PDF sans qu'aucune règle n'ait à être déclarée. L'interface avait la solution sous la
main et ne s'en servait que pour les URL.

**Réalisé.** Les trois, dans l'ordre où ils se débloquent :

3. `ouvrirSelonRegistre` ferme sa cascade sur l'**ouvreur du système** (`ouvrirDansApp(chemin,
   null)`, déjà câblé côté Rust) au lieu de s'arrêter sur un avis. Règle déclarée → l'application ;
   sinon, sous la racine → éditeur interne ; sinon → le système. **Il n'existe plus de type de
   fichier sans issue.** C'est ce point qui débloque le suivant.
2. `estReferenceCliquable` cesse de refuser les absolus hors projet. Ce refus datait d'une époque
   où la seule ouverture possible était l'éditeur interne : montrer un bouton qu'aucune voie ne
   pouvait honorer aurait été le mensonge que ce module existe pour empêcher. Depuis que le
   système ferme la cascade, la promesse tient — le refus n'avait plus de raison d'être.
1. L'extraction des répertoires du fil passe des seules cibles de `cd` à **tout jeton absolu**
   d'une commande (destination d'un `mv`/`cp`, redirection `>`, `-o`…), avec la règle « dernier
   segment pointé = fichier, on prend son parent ». Un motif `sed 's/a/b/'` ou un `2>&1` ne
   produit rien : seul un jeton commençant par `/`, guillemets retirés, compte.

**3 bis** — le panneau « Fichier binaire » de l'éditeur interne était lui aussi un cul-de-sac : un
PDF du projet s'y arrêtait net. Il porte désormais un bouton « Ouvrir avec l'application
système », factorisé avec la barre HTML de T-090 qui faisait déjà exactement ce geste
([FileEditor.tsx](../ui/src/FileEditor.tsx)).

`refFichier.test.ts` passe de 42 à 50 cas. À noter : l'invariant historique « tout ce qui est
cliquable se classe en quelque chose d'ouvrable » a dû être resserré sur le seul cul-de-sac qui
subsiste (`~/…` sans dossier personnel connu) — voir T-107, qui l'a fait tomber à son tour.

### T-105 — « introuvable dans le projet » : une référence relative n'est cherchée qu'à la racine du projet

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-08-29

Constat utilisateur du 2026-08-29, capture à l'appui, immédiatement après la mise en service de
T-104 : clic sur la puce `stl/PLATEAU-complet.stl` → bandeau
« « stl/PLATEAU-complet.stl » introuvable dans le projet. », alors que Cura est bien déclaré
pour `stl` dans le registre et que le tour VENAIT d'écrire ce fichier.

**Cause, vérifiée sur le disque.** Le projet ouvert (« Didier ») a pour racine
`…/dev/didier/python/dadou_robot_ros`. Le fichier, lui, est à
`…/dev/didier/plans/supports/support-respeaker-xvf3800/stl/PLATEAU-complet.stl`
— une AUTRE branche de `didier/`, hors de la racine du projet. `classerReference` range
`stl/PLATEAU-complet.stl` en `candidat`, tente `<racine>/stl/PLATEAU-complet.stl` (absent),
puis se rabat sur la recherche par nom de base SOUS LA RACINE (rien). D'où le message.

Le message n'est pas faux — le fichier n'est effectivement pas dans le projet — mais la
conclusion est mauvaise, et l'information manquante était SOUS LES YEUX de l'interface : le
même tour contient `cd …/support-respeaker-xvf3800` dans ses appels `Bash` et des
`file_path` absolus dans ses `Read`/`Edit`. Le modèle travaillait ailleurs, et l'a dit.

**Ce qui est faux, précisément.** Deux choses, et la seconde compte autant que la première :

1. une référence RELATIVE n'est résolue que depuis la racine du projet, alors qu'elle est
   relative au répertoire de travail du modèle au moment où il l'écrit ;
2. même résolue, elle aurait été REFUSÉE : la règle « un chemin hors projet ne s'ouvre pas »
   (T-024) a été écrite pour l'éditeur INTERNE, qui est à juste titre borné au projet. Elle
   n'a aucune raison de valoir quand l'utilisateur a lui-même déclaré l'application qui doit
   ouvrir ce type de fichier — passer un `.stl` à Cura ne concerne pas l'éditeur interne.

**Réalisé.** Deux correctifs, un par point, tous deux dans
[refFichier.ts](../ui/src/refFichier.ts) :

1. `basesDuFil(turns)` — fonction pure qui tire du fil les répertoires absolus que le modèle a
   lui-même montrés : cibles de `cd` dans ses `Bash` (y compris au milieu d'une chaîne `&&`,
   guillemets tolérés, `cd` relatifs ignorés — on ne devine pas d'où ils partent) et répertoires
   parents des `file_path`/`path`/`notebook_path` absolus de ses `Read`/`Edit`/`Write`. Ordre du
   plus récent au plus ancien, dédoublonné, plafonné à 12. `ouvrirReference` sonde ces bases
   après la racine du projet, pour un `candidat` comme pour une `recherche` par nom nu, avant de
   conclure « introuvable ».
2. `ouvrirSelonRegistre` devient la porte unique : une règle d'application DÉCLARÉE s'applique où
   que soit le fichier sur le disque ; l'éditeur interne, lui, reste borné au projet ; sans règle
   applicable, un chemin hors projet se NOMME toujours, comme avant. La branche `hors-projet`
   passe par cette même porte au lieu de refuser en bloc — un seul endroit décide, plus de
   divergence possible.

Une exception explicite y a été ajoutée à la relecture : un `~/…` n'est JAMAIS tendu à une
application. Le tilde n'est pas développé ici (l'interface ne devine pas le dossier personnel) —
le tendre à Cura ou à un lecteur PDF lui ferait chercher un dossier nommé « ~ » et échouer sur un
message à lui, obscur. Un chemin qu'on sait ne pas savoir résoudre se nomme : doctrine T-024,
inchangée. Test dédié.

**Vérité terrain.** Le scénario de la capture a été rejoué contre le VRAI disque (test temporaire,
`lireFichier` = `fs.readFile`) : `stl/PLATEAU-complet.stl` se résout bien via le `cd` vu dans le
tour et part vers Cura. Le cas est aussi figé en test permanent, racine neutralisée pour la
publication. `refFichier.test.ts` passe de 26 à 42 cas ; `npm run verif` est vert en entier.

**Effet de bord constaté et corrigé hors code.** La règle Cura du registre déclarait la commande
`cura`, absente du `PATH` : Cura est installé sous `~/Softs` (lien vers l'AppImage 5.10.2), qui
n'est ajouté au `PATH` par aucun profil shell. Même résolue, la référence aurait échoué juste
après, sur « application introuvable ». Règle corrigée en chemin complet (comme celle de FreeCAD),
config sauvegardée avant modification. Les cinq autres règles pointent sur des commandes qui
existent — vérifié.

**Non fait, délibérément.** Une référence ABSOLUE hors projet reste non cliquable
(`estReferenceCliquable` la refuse quand la racine est connue) : la rendre cliquable demanderait
le registre d'applications au moment du RENDU, sinon le bouton promettrait ce que le clic ne tient
pas — c'est la doctrine de T-024, et ça mérite son propre ticket le jour où le cas se présente.

### T-104 — Ouvrir une référence de fichier au survol, sans clic

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-08-29

Demande utilisateur du 2026-08-29, capture à l'appui : dans le fil de la page Projets, le
modèle cite `stl/PLATEAU-complet.stl`, la puce est bien cliquable (T-024/T-049) et l'infobulle
« Ouvrir « stl/PLATEAU-complet.stl » » s'affiche sous le curseur — mais il faut encore cliquer.
« J'aimerais beaucoup avoir la possibilité d'ouvrir directement au survol, au moins avoir une
option qui le propose. »

**Ce que ça change.** Une puce de référence (et elle seule — voir `estReferenceCliquable`)
s'arme au survol souris et s'ouvre toute seule au bout d'un délai réglable. L'ouverture
elle-même ne bouge pas d'un octet : c'est le même `ouvrirReference` que le clic, registre
d'applications compris.

**Pourquoi une option, et désactivée par défaut.** Ouvrir sans clic est une action à effet de
bord (un onglet d'éditeur, voire le lancement d'une application externe) déclenchée par un
geste qu'on fait sans intention — lire une réponse en promenant la souris. Le défaut reste donc
le clic ; qui veut le survol l'active, et choisit son délai. Trois garde-fous découlent de là :
le survol ne s'arme qu'au pointeur SOURIS (le tactile n'a pas de survol, une pression longue ne
doit rien ouvrir), le délai est visible pendant qu'il court (la puce se remplit — on voit venir
et on peut fuir), et sortir de la puce annule.

**Réglage** — Configuration → Applications, clé de config `ouvertureAuSurvol`
(`{ actif, delaiMs }`), défaut `{ actif: false, delaiMs: 700 }`, délai borné à [250, 5000] ms.
La page Configuration et le fil vivant dans la même fenêtre, la bascule s'applique
immédiatement (bus module-scope, même patron que `providersBus`) ; les AUTRES fenêtres
(« Nouvelle fenêtre ») la reprennent à leur prochain montage.

**Réalisé.** Un module [survolReference.ts](../ui/src/survolReference.ts) porte le réglage
(normalisation défensive du document de config, cache module-scope + bus d'abonnés façon
`providersBus`, hook `useDelaiSurvol`), et l'armement vit dans `MarkdownInlineCode`
([Markdown.tsx](../ui/src/Markdown.tsx)) : `pointerenter` arme un minuteur, `pointerleave`,
`pointerdown` et le démontage l'annulent. Le chemin sans survol — option éteinte, page Chat —
est inchangé à l'octet près : aucun gestionnaire de pointeur n'est même posé sur le bouton.

La décision d'armer est SORTIE du gestionnaire d'événement (`doitArmerSurvol`) : le projet n'a
pas d'environnement DOM en test, donc un garde-fou laissé au fond d'un `onPointerEnter` serait
un garde-fou que rien ne surveille. Les trois sont désormais couverts par
`survolReference.test.ts` (12 cas) — option éteinte, pointeur non-souris, pas de réarmement
avant d'être ressorti.

Retour visuel : la puce se remplit sur la durée exacte du délai réglé
(`--md-survol-delai`, [App.css](../ui/src/App.css)), neutralisé sous `prefers-reduced-motion`.
L'infobulle devient « Ouvrir « … » — s'ouvre au survol » : elle ne promet que ce qui va
vraiment se produire.

Réglage dans **Configuration → Applications**. Comme `ProvidersPage.tsx` était à son plafond de
cliquet (2996 lignes, il ne pouvait plus que rétrécir), la section « Applications » est sortie
dans [SectionApplications.tsx](../ui/src/SectionApplications.tsx), qui héberge aussi la nouvelle
section : −233 lignes dans le fichier-dieu, budget resserré à 2763.

Un défaut a été attrapé à l'intégration : le champ « délai » bornait et écrivait la config à
CHAQUE frappe — taper « 1000 » était impossible (le « 1 » était aussitôt ramené à la borne
basse 250), et chaque touche écrivait le fichier. La saisie est désormais en texte libre, bornée
et enregistrée à la validation (perte du focus ou Entrée).

**Non couvert** : le geste lui-même (survoler à la souris) n'a aucun test automatisé — il
n'existe pas d'environnement DOM en test dans le projet. `npm run verif` passe en entier ;
la première vérification à l'écran revient à l'utilisateur.

### T-098 — Le protocole ne documente pas le champ `sobriete` de `usage.stats`

**Type** doc · **Prio** P3 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-08-29

Constaté le 2026-08-29 pendant le chantier T-071/T-072 : l'exemple JSON du § `usage.stats` de
`docs/protocol.md` s'arrête à `parProjet` et ne mentionne jamais `sobriete`, servi pourtant
depuis T-071. Une dérive doc/code sur le protocole est exactement ce que les tests de T-058
verrouillent ailleurs. À corriger avec le branchement de T-074, qui étendra le même paragraphe.

**Soldé le 2026-08-29, avec le branchement de T-074** : le § `usage.stats` documente désormais
`sobriete` (les trois familles, leurs périmètres — tout l'historique vs tours ventilés T-066 —
et les pièges vécus : minorant de la part déléguée, causes absentes avant le 2026-08-01) et le
nouveau champ `escaladeTours` (la projection minimale et pourquoi ce n'est pas un pré-calcul).

### T-074 — Signal d'escalade

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-29

Repérer les tours où un petit modèle a été essayé puis refait par un plus gros. C'est la
*routing optimality* de RouterArena : la seule mesure qui prouve qu'un routage est BON et pas
seulement BON MARCHÉ. Sans elle, la pyramide de délégation invite à descendre sans jamais dire
ce que la descente coûte.

**Avancé le 2026-08-29** — le calcul est prêt et testé, pas encore branché.
[escaladeSignal.ts](../ui/src/escaladeSignal.ts) (8 cas) ne compte que l'escalade
INCONTESTABLE : un tour en ERREUR suivi, dans la même conversation, d'un tour sur un tier
strictement supérieur (hiérarchie réutilisée de `routerAdmin.ts`, pas recopiée) ; l'escalade
« qualité insuffisante sans erreur » n'est pas mesurable sans juge, et l'encart devra le DIRE.
Reste le branchement : aucune méthode de protocole ne sert les tours ordonnés par conversation
avec modèle + statut — il faut étendre `usage.stats` (ou une méthode dédiée), documenter le
champ (voir T-098), puis câbler l'encart.

**Soldé le 2026-08-29** — le signal est branché de bout en bout, et il reste honnête.
`events.jsonl` porte un `conversationId` par événement : l'agrégat
[usageEscalade.ts](../sidecar/src/usageEscalade.ts) projette le minimum nécessaire
({conversationId, ts, model, erreur} — un événement sans conversation ou sans date est écarté,
un modèle manquant est gardé en « (inconnu) » pour ne pas rompre l'adjacence), `usage.stats`
répond `escaladeTours` (documenté au protocole, T-098), et l'encart de la zone Sobriété
applique la règle unique de [escaladeSignal.ts](../ui/src/escaladeSignal.ts) — une seule
implémentation, testée des deux côtés. L'encart DIT sa limite à l'écran : seule l'escalade sur
ÉCHEC est comptée ; un tour jugé insuffisant sans erreur n'entre jamais dans ce chiffre, faute
d'un juge pour le décider.

### T-059 — La jauge de session affichait 94 % pendant la saturation réelle

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-29

Constat utilisateur du 2026-08-15, capture à l'appui, tombé pendant la revue d'architecture :
l'en-tête affiche « Session 94 % · 9min » alors que l'abonnement est réellement saturé — les
tours partent et se font refuser. La jauge promettait 6 % de marge qui n'existaient pas.

Cause tracée (voir [revue-archi-2026-08-15.md](revue-archi-2026-08-15.md) §3) :

1. **Le relevé vient des tours de l'app** ([claude.ts](../sidecar/src/claude.ts) ~826 et
   ~1146) et d'un cron de 5 minutes ([App.tsx](../ui/src/App.tsx) ~48). La consommation faite
   HORS de l'app — Claude Code sur le même abonnement, cas quotidien sur ce poste — est
   invisible entre deux relevés. Un abonnement peut passer de 94 à 100 % sans qu'aucun
   événement ne l'apprenne à la jauge.
2. **L'âge de la donnée n'apparaît qu'en infobulle** (`capturedAt`, App.tsx ~141). À l'écran,
   un relevé de 5 minutes et un relevé de la seconde ont la même autorité.
3. **Le seuil d'alerte (98 %, App.tsx ~110) suppose une donnée fraîche** : à 94 % affiché,
   aucune alerte, alors que la réalité est au-delà du seuil.

Même famille que T-024 et T-035 : une affordance qui affirme ce qu'elle ne sait pas. Pistes,
dans l'ordre de valeur :

- **Entendre les refus** : un tour refusé pour limite atteinte (le signal existe — T-006 a
  créé l'état « attente/limite ») doit IMMÉDIATEMENT rafraîchir le relevé et, en attendant,
  forcer l'état saturé de la jauge. C'est l'information la plus fraîche qui existe, et elle
  est aujourd'hui jetée.
- **Dire l'âge quand il compte** : au-delà de quelques minutes, afficher « il y a Nmin » à
  côté du pourcentage — pas en infobulle.
- Ne PAS raccourcir le cron en dessous de 5 min : le micro-tour coûte, et la fraîcheur
  par les refus est gratuite.

**Preuve directe, relevée le jour même dans `app.jsonl`** : à 15:31:09Z puis 15:36:09Z,
« échec du micro-tour d'initialisation : Claude Code returned an error result: **You've hit
yo**[ur limit…] ». L'application a REÇU deux fois le message de saturation — et l'a journalisé
comme un échec générique de micro-tour, puis jeté, pendant que la jauge affichait 94 %.
L'information la plus fraîche qui existe traversait déjà l'application ; elle n'était
simplement pas écoutée. (Ces deux lignes sont aussi un cas de plus pour T-057 : un refus
d'abonnement n'est pas un « échec du micro-tour », c'est une DONNÉE.)

**Suite du 2026-08-17 — le trou ne se referme jamais : l'HISTORIQUE garde la valeur fausse.**
Constat utilisateur sur l'encart « Abonnement Claude — utilisation hebdomadaire » : la barre
S33 affichait 95 % alors que la semaine avait bel et bien atteint 99 %. La barre est un
`Math.max` sur les relevés de la semaine ISO ([SupervisionPage.tsx](../ui/src/SupervisionPage.tsx)
~437) — elle ne peut donc que SOUS-estimer, et elle sous-estime exactement quand ça compte.
Reconstitution dans `claude-windows.jsonl` et `app.jsonl` du 2026-08-15 :

| heure locale | fenêtre 7 j | ce qui se passe |
|---|---|---|
| 18:41 | 95 % | dernier relevé capturé |
| 18:45 → 23:10 | *aucun relevé* | session 5 h saturée : les 26 micro-tours `usage.claude.init` sont refusés (« You've hit your session limit · resets 11:10pm ») |
| 20:00 | remise à zéro | la fenêtre 7 jours se réinitialise PENDANT l'aveuglement |
| 23:13 | 0 % | relevés reprennent, la semaine est effacée |

Trois choses s'ajoutent à ce qui est déjà écrit ci-dessus :

1. **La sonde meurt de ce qu'elle doit mesurer.** Le relevé est un vrai micro-tour Claude
   ([claudeUsage.ts](../sidecar/src/claudeUsage.ts) ~125) : un compte bloqué le refuse. Plus on
   approche de la saturation, moins on mesure — 238 refus de ce type dans `app.jsonl` sur
   4 semaines, dont un épisode de 7 h le 2026-08-08.
2. **L'échec est muet côté écran** : le `.catch()` de [App.tsx](../ui/src/App.tsx) ~351 avale
   l'erreur avec le commentaire « hors ligne / non connecté ». Rien ne signale que la jauge
   ni la barre ne sont plus alimentées.
3. **La perte devient définitive après la remise à zéro** — contrairement à la jauge live, qui
   se répare au relevé suivant. Aucune correction automatique n'est possible a posteriori :
   l'API ne rend que la fenêtre courante.

Pistes propres à ce volet, en plus de celles ci-dessus : marquer la barre comme incertaine
(hachures + « ≥ 95 % ») quand le dernier relevé de la fenêtre précède sa remise à zéro de plus
de quelques minutes ; et caler les barres sur le cycle réel (samedi 20:00 → samedi 20:00, lu
dans `resetsAt`) plutôt que sur la semaine ISO lundi→dimanche, décalée de deux jours.

**Réparation ponctuelle appliquée le 2026-08-17** : point de correction ajouté à la main dans
`claude-windows.jsonl` (`ts` 2026-08-15T17:30Z, `seven_day` 99 %, champ `correction` explicatif)
pour que S33 affiche la valeur réellement observée. C'est une saisie manuelle, pas une mesure —
le champ `correction` est là pour qu'on ne s'y trompe pas en relisant le fichier.

**Remesuré le 2026-08-20, sur constat utilisateur.** Les refus de la sonde ne sont plus 238 mais
**252** (167 « session limit » + 85 « limite hebdo ») sur les 488 échecs du micro-tour — le
point 1 ci-dessus s'aggrave au lieu de se résorber. Les 236 autres échecs ne sont pas des refus
mais des erreurs TLS, et ils appartiennent à T-085. La capture du
jour montre en plus ce que « refus non entendus » veut dire concrètement : le message de refus
**porte l'heure de réinitialisation** (« You've hit your session limit · resets 7:10pm
(Europe/Paris) ») et la sonde repart quand même toutes les 5 minutes jusque-là, chaque tentative
étant vouée à l'échec par construction. La donnée pour se taire est dans la réponse, personne ne
la lit. À rapprocher de T-086 : depuis deux fenêtres, ces refus sont produits en double.

**Soldé le 2026-08-29** — la jauge cesse d'affirmer ce qu'elle ne sait pas, par les trois
volets du ticket :

1. **Les refus sont entendus** : `parseRefusSaturation`
   ([claudeSaturation.ts](../sidecar/src/claudeSaturation.ts), testé sur les deux formats
   d'heure du constat) reconnaît le refus de limite et `usage.claude.init` répond une DONNÉE
   (`done {available:false, saturation:{fenetre, resetsAt}}`, documentée au protocole) au lieu
   d'une erreur — même doctrine que « cle-absente » (T-057). L'encart force aussitôt l'état
   saturé (« saturé, reprise à HH:MM ») et la sonde SE TAIT jusqu'à `resetsAt` (échéance de
   silence partagée entre fenêtres dans `cadenceUsage.ts` ; 30 min par défaut si l'heure
   manque) — les ~24 tentatives/heure vouées à l'échec disparaissent, et le volet « refus en
   double » de T-086 avec elles.
2. **L'âge s'affiche** dès 5 minutes (« il y a Nmin ») à côté du pourcentage, plus seulement
   en infobulle.
3. **La barre hebdo dit son incertitude** : quand le dernier relevé d'une fenêtre précède sa
   remise à zéro de plus de 10 min, la semaine affiche « ≥ N % » — le cas du 2026-08-15
   (95 % affiché pour un vrai 99 %) est reconstitué en test.

**Restes consignés** : le calage des barres sur le cycle réel `resetsAt` (au lieu de la
semaine ISO décalée de deux jours) sort en [T-100](#t-100--la-barre-hebdo-reste-calée-sur-la-semaine-iso) —
`supervisionPeriode.ts` n'offre aucune couture propre et l'introduire dépasse une correction
ponctuelle. Cas rare non traité : deux fenêtres saturées en même temps, l'alerte 98 % de la
fenêtre chiffrée s'efface derrière l'état forcé de l'autre.

### T-063 — Le panneau Sessions devient illisible : les titres IA convergent

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-29

Constat utilisateur du 2026-08-15, capture à l'appui : dans le panneau Sessions du projet
OrgaIA, « énormément [de sessions] ont le même nom » — une dizaine d'entrées quasi identiques
autour de « Déployer n8n sur OVH » (parfois en anglais, parfois en français), dont deux
STRICTEMENT identiques datées de la même heure.

Mécanique identifiée ([AgentPage.tsx](../ui/src/AgentPage.tsx) ~877) : `claude.sessionTitles`
remplace le titre local (48 premiers caractères du premier message — DISTINCTIFS par
construction) par le titre IA calculé par le CLI. Or des sessions successives sur la MÊME
tâche reçoivent des titres IA qui convergent vers la même formule ; et une conversation
REPRISE (resume) partage son `sessionId` serveur avec sa devancière — deux entrées du panneau
reçoivent alors le titre identique du même id. Vérifié dans `projet-orgaia.json` : aucun
doublon strict persisté parmi les 28 sessions — les doublons apparaissent à l'ENRICHISSEMENT,
puis sont persistés à la sauvegarde suivante.

Le titre IA est meilleur qu'un tronçon de message — quand il distingue. Quand il ne distingue
plus, il est pire : dix sessions indiscernables, c'est un panneau qui ne sert plus à choisir.

Piste (petite, à valider) : ne remplacer le titre local que si le titre IA n'est pas DÉJÀ
porté par une autre session du projet — à collision, garder le repli local, qui distingue par
construction. Ne touche ni au CLI, ni aux titres personnalisés (`titleCustom`), ni au cas
nominal.

**Soldé le 2026-08-29** — la piste du ticket, ni plus ni moins : `appliquerTitresIA`
(feuille pure dans [modeleProjet.ts](../ui/src/modeleProjet.ts), 7 cas testés) tient le
multi-ensemble des titres du projet ; la première session à revendiquer un titre IA le gagne,
les suivantes gardent leur repli local — distinctif par construction. Les deux causes du
constat (titres convergents, reprise partageant le `sessionId`) passent par le même chemin et
sont couvertes. `titleCustom` n'est jamais écrasé, le cas nominal ne change pas.

### T-076 — Des échecs sans cause

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-29

Sur 38 tours en erreur de l'historique, **17 n'ont aucun `errorMessage`**. Un échec consigné
sans sa raison est exactement l'échec muet que la doctrine d'observabilité interdit — et il
est d'autant plus trompeur qu'il est compté dans le taux d'erreur sans rien en dire.

L'agrégat de fiabilité leur donne désormais leur propre classe (« aucune cause enregistrée »)
pour qu'ils soient VUS plutôt que fondus dans « autres ». Reste à trouver quel chemin de code
écrit un `status: error` sans message.

**Enquête du 2026-08-29 — la question d'origine est close, cinq défauts résiduels tombent.**
Mesuré sur `events.jsonl` (5 580 événements) : les 17 erreurs sans cause datent TOUTES du
20–31 juillet, AVANT l'introduction du champ `errorMessage` (commit `a5435c6`, 2026-08-01) —
la clé n'existe même pas dans leur JSON. Depuis le 2026-08-02 : zéro erreur sans cause.
L'historique est immuable ; la classe « aucune cause enregistrée » est le bon traitement, à
dater (« antérieur au 2026-08-01 ») pour ne plus suggérer un défaut courant.

L'enquête a par contre trouvé des trous VIVANTS, par ordre de rendement : (1) les abandons
écrits sans cause — `neutralAgent.ts` ~1242 (5 occurrences réelles) et `engine.ts` ~577, le
moteur neutre n'a jamais reçu l'équivalent de T-082 ; (2) `claude.ts` ~1169, une exception au
message vide devient un événement muet ; (3) `ui/sidecar.ts` ~147, la garde laisse passer un
`message: ""` ; (4) le plafond de silence (`claudeFinDeTour.ts` ~71) n'écrit AUCUN événement
d'usage — un tour mort de silence est absent du taux d'erreur ; (5) `orchestrator.ts` ~1247,
`aborted` sans `message`. Correctifs en cours.

**Soldé le 2026-08-29** — les cinq trous vivants sont bouchés, chacun testé : les abandons du
moteur neutre et de `chat.abort` portent le libellé d'interruption partagé (exporté de
`claudeFinDeTour.ts`, propriétaire du vocabulaire T-082, réutilisé, pas recopié) ; une
exception au message vide a un repli (« exception sans message ») ; la garde UI refuse la
chaîne vide ; le plafond de silence écrit désormais SON événement d'usage (« tour interrompu
par le plafond de silence de N s ») — un tour mort de silence entre enfin dans le taux
d'erreur, écrit une seule fois, vérifié par test ; et la branche `aborted` de l'orchestrateur
pose son message comme `failed`. La classe « aucune cause enregistrée » est datée
(« antérieur au 2026-08-01 ») : elle décrit un historique immuable, plus un défaut courant.

### T-099 — `FileEditor` appelait un composant jamais écrit, et la chaîne ne pouvait pas le voir

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-08-29

Constaté le 2026-08-29 par un chantier parallèle (typecheck manuel) : le commit `170ee14`
embarquait dans [FileEditor.tsx](../ui/src/FileEditor.tsx) un appel à `HtmlFileView` — composant
annoncé par le commentaire d'en-tête (« source + Ouvrir dans le navigateur », préparé jusqu'au
CSS `file-editor__hint`) mais jamais écrit. Ouvrir un fichier `.html` dans l'éditeur jetait un
`ReferenceError` à l'exécution.

**Le second défaut est le plus grave** : `npm run verif` est passé VERT sur cette casse —
eslint ne résout pas les identifiants TS, vitest ne type-checke pas, et le bundle esbuild non
plus. Toute erreur de typage UI traversait donc la chaîne en silence.

**Corrigé le 2026-08-29** : `HtmlFileView` écrit (source + barre « Ouvrir dans le navigateur »
via le registre d'applications, échec d'ouverture affiché dans la barre — pas de bouton qui
échoue en silence), et surtout `ui:typecheck` (`tsc --noEmit`) inséré dans `npm run verif`,
avant les tests UI : la classe de panne entière est verrouillée, pas l'instance.

### T-072 — Zone Abonnement : trois devises, rythme et projection

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-29

Quota consommé, dépense réellement payée, et coût équivalent API — jamais additionnés, jamais
confondus. Plus le rythme de combustion et la projection de fin de fenêtre : « est-ce que je
tape le mur avant ce soir ». Aucun outil de l'état de l'art ne réunit les trois (§5.2 de
l'étude) ; nous avons les trois sources en même temps.

**Soldé le 2026-08-29** — la zone Abonnement porte les trois devises, jamais additionnées,
chacune avec son mode de calcul DIT à l'écran : quota des fenêtres 5 h/7 j (la rareté),
dépense réelle (« prix remonté par la source »), coût équivalent API (« recalculé au tarif
catalogue », avec le dénominateur `toursAvecCout` affiché pour ne pas cacher le minorant —
leçon T-035). S'y ajoutent rythme et projection ([rythmeQuota.ts](../ui/src/rythmeQuota.ts),
7 cas de test) : points de quota/minute sur la fenêtre 5 h en cours et heure de mur extrapolée.
Décision documentée dans le fichier : le rythme se mesure sur `utilization` — la seule série
que l'API publie — faute de tokens horodatés dans la fenêtre ; et la projection REFUSE
d'extrapoler (en le disant) sur un seul relevé, des relevés trop rapprochés, un rythme nul ou
une fenêtre déjà saturée.

### T-071 — Zone Sobriété

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-29

Quatre encarts neufs (`SupervisionSobriete.tsx`) et l'agrégat `usageSobriete.ts` : délégation
et cache, concentration du coût, fiabilité, activité. La page est réorganisée par question
plutôt que par source de données — l'abonnement, seule ressource qui sature, passe en tête.

Règle de conception, héritée de RouteLLM : **jamais un coût sans un signal de qualité en
regard**. Chez nous elle tranche — 3,6 % d'erreurs sur le haut de table contre 0 % sur sonnet.

Reste à faire : la pyramide de délégation pondérée par le coût (et non par les tokens — écart
mesuré de 61/39 à 99,4/0,6), et les bornes cibles, à relire en coût. Le « coût par tâche
réussie » est délibérément RETENU : il n'existe ni notion de tâche ni de réussite, et l'app
serait juge et partie. Voir `docs/etude-supervision.md` §7.

**Soldé le 2026-08-29** — la pyramide manquante est posée, pondérée par le COÛT équivalent
([pyramideDelegation.ts](../ui/src/pyramideDelegation.ts), feuille pure testée — 6 cas dont la
reproduction de l'écart 61 %→99,4 % mesuré par l'étude §7.1). L'étage d'un modèle se déduit de
son taux réel observé ($/Mtok sur la période), jamais de son nom — deux modèles au même tarif
sont au même étage, quoi qu'en disent leurs versions. Les bornes cibles existantes sont
désormais comparées à la part de COÛT. Le panneau rappelle le taux d'erreur global en regard
(règle RouteLLM) et DIT qu'un taux d'erreur par étage n'est pas calculable aujourd'hui —
l'agrégat de fiabilité ne relie pas une panne à son modèle — plutôt que de l'inventer.
Le « coût par tâche réussie » reste retenu, comme décidé (§7.5).

### T-064 — Une image jointe ne peut pas partir pendant un tour

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-16 · **Clos** 2026-08-29

Constat utilisateur du 2026-08-16, capture à l'appui : « je n'arrive plus à joindre d'image
pendant la conversation ». La pièce est bien dans le tiroir du composeur
(`capture-collée.png`, 2,2 Mo) ; c'est l'ENVOI qui la laisse derrière, avec l'avis
« Pièces jointes conservées : elles ne partent pas avec un message envoyé pendant un tour ».

Ce n'est pas une régression — le comportement est identique avant l'extraction de `handleSend`
(vérifié sur `eecc306^`). C'est la limite de S3 : pendant un tour, `Entrée` n'ouvre pas un
nouveau tour, elle GLISSE la demande dans le tour en cours (`claude.push`), et ce chemin est
texte seul.

**Ce qui rend le ticket légitime, c'est que la limite n'est pas de nature.**
`docs/protocol.md` en documente deux qui le sont — un tour sans appel d'outil n'offre aucun
point d'injection, et le moteur neutre n'a pas d'entrée streamée à alimenter. Celle-ci est
d'implémentation, et elle tient en une ligne
([claude.ts](../sidecar/src/claude.ts) ~373) :

```ts
queued.push(buildUserMessage(text, []));   // ← le tableau vide, c'est tout le sujet
```

`buildUserMessage` sait DÉJÀ produire un contenu multi-blocs avec des images en base64 : c'est
la même fonction qui construit le premier message du tour, pièces jointes comprises. L'entrée
streamée accepte donc un message utilisateur complet ; rien ne s'oppose structurellement à ce
qu'il porte une image.

À faire, trois couches et un garde-fou :

1. **Protocole** : `claude.push` accepte `attachments`, même forme et même validation que
   `claude.start` (`validateAttachments`). Documenter dans `docs/protocol.md`, où la phrase
   « `content` est texte seul » devient fausse.
2. **Sidecar** : `push(text, attachments)` → `buildUserMessage(text, attachments)`.
3. **Interface** : passer les pièces jointes à `claudePush`, vider le tiroir au succès, et
   afficher la vignette dans la bulle « en cours de tour » comme pour un message normal.
4. **Le repli reste texte seul** : si le tour est déjà clos, le message retombe dans la file
   d'attente, qui ne transporte rien (`overrideContent` est une chaîne). Deux options —
   étendre la file, ou garder l'avis actuel POUR CE CAS SEULEMENT. La seconde suffit, à
   condition que le message dise « le tour s'est terminé » et non « pendant un tour ».

Limite qui subsistera, et qu'il faut dire à l'utilisateur plutôt que découvrir : une image
poussée n'est vue qu'au **prochain retour d'outil**. Dans un tour qui n'appelle aucun outil,
elle ne sera lue qu'au tour suivant — c'est la limite de nature, inchangée.

**Soldé le 2026-08-29, dans le même geste que T-087** (même chemin de code). `claude.push`
accepte `attachments`, mêmes forme et validation que `claude.start` (`validateAttachments`) ;
le tableau vide de `queued.push(buildUserMessage(text, []))` porte désormais les pièces ; l'UI
passe le tiroir à `claudePush`, le vide au succès, affiche la vignette dans la bulle « en cours
de tour », et garde une copie locale des pièces poussées jusqu'à la fin du tour — c'est elle
qui permet la restauration sur `push_perdu` (T-087). Le repli « tour déjà clos » reste texte
seul, avec un libellé corrigé qui dit « le tour s'est terminé ». La limite de nature est
documentée au protocole : une image poussée n'est vue qu'au prochain retour d'outil ; sans
outil, elle revient par `push_perdu` au lieu de disparaître.

### T-087 — Une demande glissée en cours de tour est perdue en silence quand le tour n'a plus d'outil à appeler

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-25 · **Clos** 2026-08-29

Constat utilisateur du 2026-08-25, capture à l'appui. Pendant un tour de recherche (sorties
autour de Cholet), demande glissée dans le composeur : « créer un repertoire Rose dans cet
espace pour consigner les notes ». La bulle « en cours de tour » s'affiche, le brouillon est
purgé — tout dit que le message est parti. L'agent termine sa réponse sur les sorties, le tour
se clôt sur son pied de page d'usage (`12 in / 5427 out`), et **le répertoire n'est jamais
créé**. Aucun avertissement, aucune ligne de journal, aucune reprise au tour suivant : le
message a disparu.

**Cause.** Elle est dans la chaîne d'acquittement, pas dans le transport.

1. [claude.ts:1345](../sidecar/src/claude.ts#L1345) — `claude.push` répond `{pushed: true}` dès
   que le texte est **empilé** dans `queued`, jamais quand il est **injecté**. C'est un accusé
   de dépôt vendu pour un accusé de réception.
2. [envoiProjet.ts:363-369](../ui/src/envoiProjet.ts#L363-L369) — l'UI lit ce `pushed: true`
   comme « livré » : elle ouvre la bulle « en cours de tour » et ne repose rien en file. Le
   repli existe (`queuedPrompts`) mais n'est armé que par `pushed: false`.
3. Le CLI n'injecte un message de l'entrée streamée **qu'à un retour d'outil**. Poussé pendant
   la rédaction du texte final — c'est le cas ici, la recherche web était finie — il n'a plus
   aucun point d'injection.
4. [claude.ts:1156](../sidecar/src/claude.ts#L1156) — le `result` sort de la boucle, et
   `nettoyerFinDeTour` ([claude.ts:807](../sidecar/src/claude.ts#L807)) ferme l'entrée puis tue
   le process CLI. Ce qui n'a pas été injecté meurt là.

La documentation ment sur ce point : `docs/protocol.md` § `claude.push` annonce qu'un tour sans
point d'injection fait que « le message ne sera vu qu'au tour suivant ». Faux — il n'est vu par
personne. Le tour suivant est un `claude.start` neuf sur une session reprise ; rien dans
IAction ne rejoue le message.

Gravité : c'est un **échec muet sur une instruction utilisateur**, la classe de panne que la
doctrine d'observabilité interdit en premier. Pire qu'une erreur affichée, parce que l'interface
affirme le contraire de ce qui s'est passé — l'utilisateur croit sa demande prise en compte et
ne la reformule pas.

**Piste.** Le signal manquant existe déjà dans le flux : le sidecar sait si un `tool_result` est
passé **après** le push. Aucun retour d'outil entre le push et le `result` ⇒ le message n'a pas
pu être injecté.

1. **Sidecar** : mémoriser les push non acquittés du tour ; tout `tool_result` reçu après un
   push l'acquitte. À la clôture, les push restants sortent en chunk `push_perdu`
   (`{contenu}`) + une ligne de journal `warn`.
2. **UI** : sur `push_perdu`, reposer le texte dans `queuedPrompts` — le chemin d'auto-envoi de
   fin de tour existe déjà et le renverra tout seul — et marquer la bulle « en cours de tour »
   comme reportée plutôt que de la laisser mentir.
3. **Protocole** : corriger le § `claude.push` (le message n'est PAS vu au tour suivant, il est
   repris explicitement) et documenter le chunk.
4. **Couverture** : `sidecar/test/claudeTours.test.js` — un faux moteur qui pousse sans jamais
   rappeler d'outil doit produire `push_perdu`.

À voir aussi : `case "user"` ([claude.ts:1022](../sidecar/src/claude.ts#L1022)) ignore tout bloc
qui n'est pas un `tool_result`. Si le SDK renvoie l'écho du message injecté, c'est un
acquittement DIRECT, plus solide que le proxy ci-dessus — à mesurer sur le vrai moteur avant de
choisir.

Voisin de T-064 (le même chemin, côté pièces jointes).

**Soldé le 2026-08-29** — l'acquittement dit désormais la vérité, et ce qui n'est pas vu est
repris au lieu de mourir.

- **Sidecar** : registre des pushes non acquittés
  ([poussesEnAttente.ts](../sidecar/src/poussesEnAttente.ts), où tout le handler `claude.push`
  a été extrait pour tenir le cliquet — `claude.ts` passe de 1486 à 1473 lignes). Tout
  `tool_result` du FIL (les sous-agents sont écartés par `origineMessage`, T-092) acquitte les
  pushes antérieurs ; à la clôture du tour — `result` final, exception ou clôture anormale —
  chaque push restant sort en chunk `push_perdu` {contenu, avaitPieces} AVANT le `done`/`error`,
  plus une ligne `warn` au journal.
- **UI (page Projets)** : sur `push_perdu`, le texte est reposé dans `queuedPrompts` (le chemin
  d'auto-envoi de fin de tour le renvoie tout seul), la bulle « en cours de tour » est marquée
  reportée au lieu de continuer à mentir (`AgentTurn.reporte`,
  [agentTurns.ts](../ui/src/agentTurns.ts)), et les pièces jointes sont restaurées dans le
  tiroir depuis la copie locale gardée pendant le tour — ou un avis explicite le dit quand la
  restauration est impossible.
- **Protocole** : le § `claude.push` cesse de promettre qu'un message non injecté « sera vu au
  tour suivant » ; le chunk `push_perdu` et la reprise sont documentés.
- **Couverture** : [claudeTours.test.js](../sidecar/test/claudeTours.test.js) (faux moteur qui
  pousse sans jamais rappeler d'outil → `push_perdu` ; avec rappel d'outil → pas de chunk ;
  push avec pièces), [poussesEnAttente.test.js](../sidecar/test/poussesEnAttente.test.js),
  et 6 cas ajoutés à `agentTurns.test.ts`.

**Décisions consignées** : l'acquittement par écho direct du message injecté (`case "user"`
non-`tool_result`) reste NON implémenté — il exige une mesure sur le vrai moteur, à faire
avant d'en décider. La page Chat n'est pas touchée : vérification faite, elle n'appelle jamais
`claude.push` pendant un tour (tout part en file), le chunk ne peut pas s'y produire.

### T-058 — 22 méthodes du protocole sans test de bout en bout, toutes sur `mcp.*` et `orch.*`

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-29

Première mesure de l'indicateur n°4 d'[etude-structure.md](etude-structure.md) §6, pendant la
revue d'architecture du 2026-08-15 : **47 des 69 méthodes** dispatchées par
[index.ts](../sidecar/src/index.ts) sont traversées par au moins un test de protocole. Les 22
restantes ne sont pas dispersées : elles couvrent **deux familles entières** — `mcp.add`,
`mcp.remove`, `mcp.catalog`, `mcp.secrets`, `mcp.secretSet`, `mcp.secretDelete`, et le gros
des `orch.*` (`orch.list`, `orch.delete`, `orch.abort`, `orch.permission`…), plus
`claude.commands` et `claude.sessionTitles`.

Ce qui rend ce trou plus grave que sa taille : `orch.*` est la partie la plus AUTONOME de
l'application — l'orchestration tourne la nuit, en `bypassPermissions`, sur le poste et sur
le VPS, sans humain devant l'écran. Et les parseurs de l'interface sont tolérants par
conception : une rupture de contrat n'y produit pas d'erreur, seulement une fonctionnalité
qui disparaît en silence (pathologie 2.3 d'`etude-structure.md`, jamais refermée sur ces
familles). Le filet est le plus mince exactement là où personne ne regarde.

À faire : un fichier de test de protocole par famille, sur le modèle des 21 existants (vrai
sidecar en sous-processus, cas nominal + un cas d'erreur par méthode). Commencer par `orch.*`
— c'est la famille sans humain. La liste exacte des 22 se régénère par la commande du rapport
de revue (dispatch vs occurrences dans `sidecar/test/`).

**Soldé le 2026-08-29** — cinq fichiers de tests de protocole neufs, tous par le VRAI chemin
(sidecar en sous-processus, dispatch d'`index.ts`, JSON Lines), cas nominal + cas d'erreur :
[orchestrateurCycleVie.test.js](../sidecar/test/orchestrateurCycleVie.test.js) (`orch.read`,
`orch.delete`, `orch.abort` — ce dernier n'était exercé nulle part par le dispatch),
[mcpCatalogueEtSecrets.test.js](../sidecar/test/mcpCatalogueEtSecrets.test.js) (les six
`mcp.*`), [claudeCommandesEtTitres.test.js](../sidecar/test/claudeCommandesEtTitres.test.js)
(+ module factice injectable `fakeClaudeCommands.mjs`),
[tachesProtocole.test.js](../sidecar/test/tachesProtocole.test.js) (les neuf `taches.*` — le
`taches.test.js` historique importait les handlers sans passer par le protocole),
[projectDocEtUsageHistorique.test.js](../sidecar/test/projectDocEtUsageHistorique.test.js)
(`project.ensureDoc`, `usage.claude.history`). Aucun bug débusqué.

La liste du ticket avait dérivé : au recomptage du 2026-08-29, `orch.list/write/run/permission`
étaient déjà couverts, et le vrai trou était `taches.*` (9 méthodes) plus trois isolées. Les
méthodes qui n'ont volontairement PAS de branche d'erreur (`mcp.catalog`, `mcp.secrets`,
`claude.sessionTitles` best-effort, `usage.claude.history` tolérante) sont testées sur leur
chemin de tolérance, documenté dans chaque test.

**Restes assumés, non testables sans couture d'injection** : les chemins nominaux des timers
`taches.timer*` (vrai `systemctl --user` et vrai `$HOME` — tester l'OS est le piège documenté
du projet) et `maj.verifier` (fetch global vers api.github.com, sans couture ; sa logique pure
est couverte par `maj.test.js`). Poser ces coutures serait un ticket à part si le besoin naît.

### T-097 — L'application dit qu'une version existe

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-08-29

Travail réalisé sur la **ligne publique GitHub** (commit `914f6d0`, release v0.5.0 du
2026-08-26, T-056 de la numérotation publique) depuis un autre poste, et **descendu ici le
2026-08-29** à la demande de l'utilisateur (« mets à jour l'application avec les modifications
GitHub, passe à la version 0.5 en local »). Les deux numérotations de tickets sont
indépendantes : le T-056 public n'est pas le T-056 local (process WebKit).

La page Système compare la version installée à la dernière release publiée, montre les
nouveautés et ouvre la page de téléchargement dans le navigateur déclaré. Rien n'est téléchargé
ni installé automatiquement. La sonde `maj.verifier` vit côté sidecar : un fetch depuis la
webview ne franchirait ni le proxy ni l'autorité déclarés (T-043, T-045) et annoncerait
« à jour » sans avoir rien vérifié. Aucun sondage périodique — un bouton. `PingPanel` sort de
`SystemPage.tsx` dans le même geste (budget de taille).

**Périmètre exact de la descente** (v0.4.1 + v0.5.0 publiques → local, avec les cinq porteurs
de version passés à 0.5.0 par `scripts/versionner.mjs` et le CHANGELOG repris verbatim) :

- **porté** : T-054 public (voir [T-096](#t-096--windows--la-sonde-gpu-faisait-clignoter-une-console))
  et T-056 public (ce ticket) ;
- **non porté, déjà couvert localement** : T-055 public (garde « clé enregistrée » dans
  `providersBus`) — le local règle le même défaut par la réponse structurée
  `{disponible: false, raison: "cle-absente"}` de `usage.credits`, qui arrête toute reprise
  (T-057 local) ; T-057 public (panneaux repliables + « Arrêter » empilé) — ≡ T-084 local
  (`panneauxLateraux.ts`, version plus complète avec Ctrl+L) et la pile de boutons déjà en
  place ;
- **non porté, divergence assumée** : l'extraction `SystemStatsWidget` hors d'`App.tsx`
  (v0.4.1 publique) — l'`App.tsx` local a été réorganisé autrement (pastilles par organe,
  T-094) ; extraire reste souhaitable mais c'est un choix de découpe à refaire d'ici, pas à
  recopier.

Fichiers : [maj.ts](../sidecar/src/maj.ts), [maj.test.js](../sidecar/test/maj.test.js),
[MajPanel.tsx](../ui/src/MajPanel.tsx), [PingPanel.tsx](../ui/src/PingPanel.tsx),
[majClient.ts](../ui/src/majClient.ts), [SystemPage.tsx](../ui/src/SystemPage.tsx),
`docs/protocol.md` § `maj.verifier`.

### T-096 — Windows : la sonde GPU faisait clignoter une console

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-29 · **Clos** 2026-08-29

Même provenance que T-097 : ligne publique GitHub (commit `8da8a18`, release v0.4.1 du
2026-08-26, T-054 de la numérotation publique), descendu le 2026-08-29. Constaté sur le poste
Windows : une fenêtre de terminal apparaissait et se refermait toutes les cinq secondes tant
que l'application tournait — la sonde GPU relançait `nvidia-smi`, programme console à qui
Windows alloue d'office une fenêtre, sans la masquer.

`CREATE_NO_WINDOW` cesse d'être une ligne perdue dans le lancement du sidecar :
`hide_console_window()` ([open_external.rs](../src-tauri/src/open_external.rs)) est partagé
entre le sidecar et la sonde ([system_probe.rs](../src-tauri/src/system_probe.rs)). Au passage,
une machine sans carte NVIDIA cesse de relancer un binaire absent toutes les 5 s : le premier
« introuvable » verrouille la sonde pour la session.

### T-094 — Sonde système : une pastille par organe, teintée

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-08-27 · **Clos** 2026-08-27

Demande utilisateur du 2026-08-27 : « mieux séparer les indications de RAM, CPU et GPU avec des
cadres et des couleurs différenciés ». L'en-tête alignait cinq à six anneaux — CPU, T.CPU, RAM,
T.RAM, GPU, T.GPU — dans un cadre unique : une bande indifférenciée où il fallait relire chaque
étiquette pour savoir de quel organe parlait un chiffre.

**Correction.** `.system-stats` cesse d'être une pastille pour devenir une rangée : une pastille
par organe (`.system-stats__organe--cpu|ram|gpu`), chacune regroupant sa charge et sa
température, avec sa teinte de cadre et d'étiquettes — cyan pour le processeur, magenta pour la
mémoire, violet pour la carte graphique. Un organe sans aucune sonde n'est pas rendu : un cadre
vide dirait « rien à signaler » là où il n'y a rien à dire.

**La règle qui tient tout ça** — une couleur, une information. La teinte dit **de qui** parle le
chiffre ; elle ne dit jamais **comment il va**. L'anneau reste coloré par `usageLevel`
(ok/warn/error, `Donut.tsx`) : le recolorer par organe aurait supprimé la seule alerte visuelle
du bandeau, et un GPU à 95 °C serait devenu aussi violet qu'un GPU au repos.

Fichiers : [App.tsx](../ui/src/App.tsx), [App.css](../ui/src/App.css).

### T-092 — Le fil mélange sa propre parole et le travail de ses sous-agents

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-27 · **Clos** 2026-08-27

Constat utilisateur du 2026-08-27, capture à l'appui, sur une conversation où seize sous-agents
avaient travaillé au tour précédent et six au tour en cours. Deux dégâts visibles dans la
transcription :

- un mot du fil coupé en deux par des appels d'outils qu'il n'a pas passés — « … des médecins
  ont pro » [WebSearch] [WebSearch] [Bash] « posé une unité de douleur… » ;
- un paragraphe entier du fil réinséré **au milieu d'un autre mot** — « On s » + « Bien noté. Je
  poursuis avec la section 1 (prioritaire)… » + « ait qu'il y a ~610 lieux-dits "Paradis" ».

**Cause.** Le Claude Agent SDK marque tout ce qu'un sous-agent produit d'un `parent_tool_use_id`
(l'id du `Task` lanceur) — c'est la raison d'être du champ, porté par les messages `assistant`,
`user` et `stream_event`. Par défaut le SDK ne transmet que les `tool_use`/`tool_result` des
sous-agents (« enough for a heartbeat counter », cf. `forwardSubagentText` dans `sdk.d.ts`),
mais il les transmet — et `sidecar/src/claude.ts` ne lisait ce champ **nulle part**. Trois
conséquences, toutes constatées :

1. les outils d'un sous-agent étaient versés dans la transcription du fil, au milieu d'une
   phrase, qu'ils coupaient en deux ;
2. `sawTextDeltaForCall` — le drapeau anti-doublon qui distingue « ce texte est déjà parti en
   deltas » de « ce message n'a jamais été streamé » — était remis à zéro à la fin de CHAQUE
   message assistant, y compris celui d'un sous-agent. Le message suivant du fil était alors
   réémis en entier par-dessus ses propres deltas : c'est le paragraphe recopié ;
3. l'`usage` d'un message de sous-agent servait de mesure d'occupation du contexte
   (`lastContextTokens`) : la jauge du fil affichait le contexte de quelqu'un d'autre.

**Correction.** `origineMessage()` (module `claudeSousAgents.ts`) répond « fil » ou
« sous-agent », et `claude.ts` s'en sert à quatre endroits : les deltas, le texte non streamé,
les `tool_use`/`tool_result`, et le cycle du drapeau anti-doublon avec la mesure de contexte.
La tolérance est **dissymétrique par choix** : tout ce qui n'est pas une marque de sous-agent
franche est traité comme venant du fil — laisser passer un message non marqué revient au
comportement d'avant, alors que faire disparaître du contenu du fil serait une perte muette.

**Ce qui n'est pas perdu.** Les appels MCP d'un sous-agent restent chronométrés et journalisés :
seule leur émission vers la transcription est retirée. Le panneau « Sous-agents » (T-077) montre
toujours qui travaille — il se déduit des blocs `Task` du fil, qui sont bien à lui.

**Ce qui l'est.** Le détail des recherches d'un sous-agent, qu'on voyait passer mal attribué.
Le rendre correctement demande une transcription imbriquée et l'option `forwardSubagentText` du
SDK — c'est un autre travail (non ouvert à ce jour), pas une régression de celui-ci.

Fichiers : [claudeSousAgents.ts](../sidecar/src/claudeSousAgents.ts), [claude.ts](../sidecar/src/claude.ts),
[claudePur.test.js](../sidecar/test/claudePur.test.js).

### T-093 — L'encart des tâches de fond déverse la commande shell entière

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-27 · **Clos** 2026-08-27

Même capture que T-092 : « Tour terminé — en attente des rapports de 7 tâche(s) de fond… »
suivi de quinze lignes de shell — un `curl` avec heredoc `EOF`, une requête Overpass, un
`python3 -c` complet — et le bouton « Rendre la main » noyé au milieu du pavé.

**Cause.** Les descriptions relayées par `background_wait` viennent du SDK : pour un `Bash`
lancé en arrière-plan, la description **est** la commande, retours à la ligne compris. L'UI les
joignait telles quelles (`descriptions.join(" · ")`) dans une note d'une ligne.

**Correction.** `resumerTachesDeFond()` aplatit les blancs, coupe à 60 caractères, nomme les
trois premières et **compte** le reste (« +4 autres ») — une liste tronquée en silence se lit
comme une liste complète. L'encart répond à « qu'est-ce qui tourne encore ? » ; le détail exact
reste dans le bloc d'outil correspondant, plus haut dans la transcription.

Fichiers : [agentTurns.ts](../ui/src/agentTurns.ts), [agentTranscript.tsx](../ui/src/agentTranscript.tsx),
[agentTurns.test.ts](../ui/src/agentTurns.test.ts).

### T-091 — L'encart « Sous-agents du dernier tour » ne dit pas l'âge de ce qu'il montre

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-27 · **Clos** 2026-08-27

Constat utilisateur du 2026-08-27, capture à l'appui : « pourquoi les sous-agents restent
affichés ? » — panneau LLM, « SOUS-AGENTS DU DERNIER TOUR · 16 », tous cochés terminés, alors
que l'onglet actif était un fichier et qu'aucun tour ne tournait. La question EST le défaut :
un encart dont il faut dater le contenu de tête ne se lit plus comme un état.

**Cause.** T-077 déduit la liste de `vif.turns`, donc de tours **persistés** : `sousAgentsVifs`
remonte au dernier tour assistant de la conversation, quel que soit son âge. Rouvrir une
conversation d'il y a trois jours réaffiche donc ses 16 sous-agents au présent. Rien n'était
faux au sens strict — le titre dit bien « du dernier tour » — mais rien ne distinguait « vient
de tourner » de « a tourné la semaine dernière ».

**Correction** (choix utilisateur parmi trois : dater le titre / retenir quelques minutes /
n'afficher que pendant le tour) — **la rétention**. `useSousAgentsRecents` : pendant le tour, et
5 minutes après. Le compte à rebours part d'une fin de tour **observée dans la fenêtre**, pas
d'un horodatage stocké dans le tour — `AgentTurn` n'en porte pas, et surtout c'est la bonne
sémantique : ce que l'encart annonce, c'est « ça vient de tourner sous tes yeux ». Une
conversation rechargée du disque n'a rien fait tourner, elle n'affiche donc rien, ce qui règle
précisément le cas constaté. Changer de conversation remet le compteur à zéro ; `streaming`
prime toujours, le délai ne peut donc jamais masquer un travail en cours.

Fichiers : [useSousAgentsRecents.ts](../ui/src/useSousAgentsRecents.ts),
[useSousAgentsRecents.test.ts](../ui/src/useSousAgentsRecents.test.ts),
[agentSidebarDroit.tsx](../ui/src/agentSidebarDroit.tsx).

### T-090 — Un nom de domaine cité dans une réponse est pris pour un fichier

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-27 · **Clos** 2026-08-27

Constat utilisateur du 2026-08-27, capture à l'appui : l'encart d'avis de la page Projets
affiche « `secure.exemple.fr` introuvable dans le projet. » (le domaine réel est anonymisé
ici et dans les tests — c'était un service personnel). L'agent avait cité le site dans un `code`
inline ; le texte est devenu un bouton, et le clic est parti chercher un fichier.

**Cause.** `estReferenceCliquable` clôt sur `/\.[^./\s]{1,8}$/` — « ça finit par un point suivi
d'un suffixe court, donc c'est un nom de fichier ». `.fr` passe ce test, comme `.com`, `.org`
ou `.net`. `classerReference` classait donc l'hôte en `recherche`, et la seule branche qui sait
conclure « introuvable » concluait — sur un site web. Le bouton avait raison d'exister, c'est sa
**destination** qui était fausse : le module a été écrit (T-024) pour qu'aucun bouton ne mente,
et il en restait un.

**Correction.** `estNomDHote` reconnaît un hôte cité sans schéma (`secure.exemple.fr`,
`www.exemple.com/aide`) et `classerReference` le rend `distant` avec `https://` — il part donc
au navigateur déclaré dans le registre d'applications, comme une URL complète depuis T-049.

Départager un hôte d'un fichier sur la forme seule est impossible : `notes.md` et `exemple.fr`
ont la même. On tranche sur une liste courte de domaines de premier niveau dont **aucune
extension de fichier courante ne porte le nom** ; hors liste — `.ai` d'Illustrator, `.sh`,
`.rs`, `.py`, tous TLD par ailleurs — le fichier garde la priorité et le comportement d'avant
tient. Un faux négatif coûte un lien non cliquable, un faux positif enverrait un fichier du
projet sur le web : l'asymétrie décide de la liste.

**Second défaut, révélé par la même capture.** L'avis était encore affiché au-dessus d'une
conversation qui n'avait rien demandé : `openFilesNotice` appartient à la PAGE, et changer
d'onglet de conversation ne l'effaçait pas. Un message qui commente un geste devient alors un
état de la conversation regardée. `selectConversation` le remet à `null`.

Fichiers : [refFichier.ts](../ui/src/refFichier.ts), [refFichier.test.ts](../ui/src/refFichier.test.ts),
[AgentPage.tsx](../ui/src/AgentPage.tsx).

### T-089 — La modale de question couvre l'app : il faut trancher sur ce qu'on ne peut plus aller regarder

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-27 · **Clos** 2026-08-27

Constat utilisateur du 2026-08-27, capture à l'appui : « je dois faire des choix de choses que
je n'ai pas eu le temps de voir ». Trois questions posées ensemble pendant une réorganisation
de workspace — dont « `art-de-rue/amaclone/` : 589 Mo, 3 fichiers .mov à noms d'UUID. C'est
quoi ? ». Pour répondre il faudrait ouvrir le dossier, ou au minimum relire le plan que l'agent
venait d'écrire. Les deux sont **derrière** la modale.

**Cause.** `.permission-overlay` est un `position: fixed; inset: 0` au fond opaque
(`#05070cd9`) : il masque le fil, l'arborescence et les fichiers ouverts, et capte tous les
clics. Les seules sorties du panneau sont « Répondre » et « Ignorer la question » — les deux
terminent la demande. Il n'existait aucun geste pour « attends, je vais voir ». Fréquence :
à chaque question portant sur un objet du projet, c'est-à-dire la plupart.

Ce n'est pas qu'un inconfort. Le dispositif pousse à répondre au jugé ou à ignorer une question
que l'agent a posée parce qu'elle conditionne la suite — dans les deux cas l'agent repart sur
une base fausse, et personne ne le sait.

**Correction** — trois leviers, les trois retenus par l'utilisateur :

1. **Panneau non bloquant** — `.permission-overlay--flottant` : ni voile, ni capture des clics
   (`pointer-events: none`, rendu aux enfants). L'app reste utilisable pendant que l'agent
   attend. Les deux autres usages de `.permission-overlay` (confirmation de suppression dans
   `FileTree`, permission d'orchestration dans `orchRuns`) gardent le voile : eux n'ont rien à
   consulter derrière.
2. **Déplaçable et mis de côté** — la barre de titre est une poignée (`useDeplacement`,
   pointer capture, position bornée à l'écran) ; un bouton « Mettre de côté » replie le panneau
   en pastille. Mettre de côté ne répond ni n'ignore : l'agent attend toujours, le composant
   reste monté donc les choix déjà cochés survivent, et la pastille rappelle l'attente. La
   position déplacée est conservée d'une demande à l'autre, le repli non (une nouvelle question
   se montre).
3. **L'agent joint de quoi trancher** — champ `context` par question dans `mcp__studio__ask_user`
   (chaîne préformatée : listing, tailles, dates, extrait), affiché au-dessus des choix. La
   description de l'outil en fait une obligation dès que la question porte sur ce que
   l'utilisateur n'a pas sous les yeux, et la limite à du mesuré. Le parseur reste défensif :
   absent ou difforme, le champ est ignoré.

Fichiers : [PermissionModal.tsx](../ui/src/PermissionModal.tsx),
[questionsAgent.ts](../ui/src/questionsAgent.ts), [App.css](../ui/src/App.css),
[askUser.ts](../sidecar/src/askUser.ts), `docs/protocol.md` § Questions interactives.

### T-038 — L'AppImage ne se construit plus, et l'échec est muet

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13 en livrant la 0.3.1 : le portique de la PR échoue sur
`construire (ubuntu-latest)`, à l'étape `tauri build` :

```
Bundling IAction_0.3.1_amd64.AppImage (…/bundle/appimage/IAction_0.3.1_amd64.AppImage)
failed to bundle project: `failed to run linuxdeploy`
```

**Trente secondes, puis cette seule ligne.** L'outil qui a échoué n'a laissé aucune trace :
Tauri n'affiche pas la sortie de `linuxdeploy` quand il tombe, et l'étape « Construire » était
la seule de la chaîne à ne pas recopier son échec en annotation — les journaux de run étant
réservés aux administrateurs du dépôt, la cause est donc restée invisible depuis l'extérieur.
Le défaut d'observabilité est ici plus grave que la panne : on ne peut pas corriger ce qu'on
ne voit pas.

Ce qui rend le cas déroutant : la **même image de runner** (`ubuntu-24.04`, version
`20260720.247.2`) et le même workflow avaient produit l'AppImage sans broncher le 2026-08-09.
Aucun `.rs`, aucun fichier d'empaquetage n'a bougé entre les deux. Suspect principal : les
binaires que Tauri télécharge à chaque run ne sont pas figés —
`linuxdeploy-plugin-appimage` vient de l'étiquette **`continuous`** du dépôt amont, qui bouge
sous nos pieds. Une dépendance de construction non épinglée est une panne qui attend son jour.

Premier geste, posé le 2026-08-13 : l'étape « Construire » capture sa sortie, en recopie les
40 dernières lignes en annotation et en affiche 25 dans le journal, comme le font déjà les
tests du sidecar et `cargo test`. `APPIMAGE_EXTRACT_AND_RUN=1` est posé au passage (linuxdeploy
et son greffon sont eux-mêmes des AppImages : sans FUSE sur le runner, ils doivent s'extraire
pour tourner) — remède à la cause la plus courante, pas un diagnostic.

**Cause trouvée le 2026-08-13**, dès que `--verbose` a fait parler le sous-processus :

```
[gtk/stdout] Deploying dependencies for ELF file …/IAction.AppDir/usr/lib/IAction/
             sidecar/node_modules/@anthropic-ai/cla…
[gtk/stderr] terminate called after throwing an instance of 'std::runtime_error'
[gtk/stderr]   what():  Failed to run ldd: exited with code 1
ERROR: Failed to run plugin: gtk (exit code: 134)
```

`linuxdeploy` parcourt TOUS les fichiers ELF de l'AppDir pour en déployer les dépendances. Il
tombe sur le **CLI Claude embarqué**, lance `ldd` dessus, `ldd` sort en 1 — et linuxdeploy ne
traite pas cet échec comme un avertissement : il **abandonne** (code 134, `SIGABRT`).

Et le suspect « outil amont non épinglé » était le mauvais : **c'est notre bundle qui a
changé**, pas le runner. Les annotations d'inventaire le disent au octet près :

| | 2026-08-09 (vert) | 2026-08-13 (rouge) |
|---|---|---|
| CLI Claude (Linux) | `claude` = 297 831 432 o | (non atteint) |
| CLI Claude (Windows) | `claude.exe` = 287 053 472 o | `claude.exe` = 307 186 848 o |

Le CLI a pris ~20 Mo entre les deux, d'où une première conclusion — « le SDK a été résolu dans
une version plus récente » — **qui est fausse, vérification faite le 2026-08-13** :

- `package-lock.json` n'a pas bougé d'une ligne entre les deux runs (`git diff c6a461a HEAD --
  package-lock.json` est vide) ;
- le SDK y est figé à **0.3.214**, et ses huit binaires par plateforme le sont aussi,
  version exacte, y compris `claude-agent-sdk-win32-x64` ;
- la CI installe par `npm ci`, qui ne s'écarte pas du verrou ;
- le paquet de plateforme ne porte aucun `postinstall` : le binaire vient du tarball, pas d'un
  téléchargement à l'installation.

Deux tailles différentes pour un tarball npm immuable : **l'observation et l'explication ne
se rejoignent pas**, et le ticket ne prétendra pas le contraire.

La seconde hypothèse — « le binaire est lié statiquement, d'où `ldd` en échec » — **tombe
aussi**, mesurée sur le poste le 2026-08-13 :

```
$ file node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
ELF 64-bit LSB executable, x86-64, dynamically linked,
interpreter /lib64/ld-linux-x86-64.so.2, …, not stripped
$ ldd … ; echo $?
librt.so.1 => … libc.so.6 => … libpthread.so.0 => …
0
```

Binaire **dynamique**, `ldd` sort en **0**, six bibliothèques listées. Le binaire tel que npm
le livre n'a donc rien qui explique l'échec.

Ce qui reste établi tient au journal, et à lui seul : dans l'AppDir, `ldd` sort en 1 sur ce
fichier, et linuxdeploy en fait un abandon au lieu d'un avertissement. La différence entre les
deux situations n'est pas le binaire d'origine mais **ce que linuxdeploy en a fait avant de
l'interroger** : il copie, puis `strip` et `patchelf` les ELF déployés. Un `patchelf` sur un
exécutable de 265 Mo qui traîne une charge utile en queue de fichier est un candidat sérieux à
la corruption — après quoi `ldd` échoue légitimement. **À vérifier, pas à conclure.**

**La cause, établie par reproduction locale le 2026-08-13.** Trois copies du même fichier :

| copie | taille | `ldd` |
|---|---|---|
| npm, dans le dépôt | 265 210 864 | 0 |
| `build/sidecar-bundle` | 265 210 864 | 0 |
| **AppDir, après linuxdeploy** | 265 214 960 (+4 096) | **1** |

Même BuildID, 4 096 octets de plus, un `RUNPATH [$ORIGIN]` ajouté : **linuxdeploy réécrit le
binaire avec `patchelf`, le casse, puis lui reproche d'être cassé** en lançant `ldd` dessus.
Le CLI Claude porte une charge utile collée en queue de fichier, que la réécriture ELF ne
survit pas. Ni la version ni la taille n'y sont pour quelque chose : le binaire de 265 Mo
subit le sort du binaire de 311 Mo. `NO_STRIP=true` ne change rien — c'est `patchelf`, pas
`strip`.

**Corrigé** en soustrayant le CLI au balayage, faute de pouvoir demander à linuxdeploy de
l'épargner :

1. `preparer-bundle.sh` range le CLI **compressé** dans le paquet Linux (253 → 90 Mo). Un
   `.gz` n'est pas un ELF : linuxdeploy passe devant sans le voir.
2. [cliClaude.ts](../sidecar/src/cliClaude.ts) le détend au premier lancement dans
   `<données>/bin/claude-<empreinte>` et aiguille le SDK dessus
   (`pathToClaudeCodeExecutable`). Une AppImage étant en lecture seule, il n'y avait de toute
   façon aucun autre endroit où poser un exécutable. Écriture sous nom provisoire puis
   renommage atomique ; complétude vérifiée par la taille inscrite dans le pied du gzip, pour
   qu'une extraction interrompue soit refaite au lieu d'être crue sur parole ; échec
   journalisé et main rendue au SDK, jamais d'exception au démarrage.
3. L'aiguillage est posé dans `resolveQueryFn()`, seul endroit qui lance le CLI — `claude.ts`,
   `claudeUsage.ts` et `claudeCommands.ts` composent chacun leurs options, et une consigne à
   recopier dans trois fichiers est une consigne qu'on oubliera au quatrième.

Sept cas de test ([cliClaude.test.js](../sidecar/test/cliClaude.test.js)) sur un chemin de code
qui ne s'exécute QUE dans le paquet Linux : sans eux, personne ne l'aurait jamais fait tourner
avant l'utilisateur. **AppImage produite en local : 222 Mo, construction verte.**

Reste dû, et consigné à part : la CI ne dit toujours pas ce que produit une construction
réussie côté ELF, et le résidu d'empaquetage qui m'a fait lire trois fois le même échec est
devenu [T-041](#t-041--lempaquetage-local-ressuscite-les-fichiers-supprimés).

Note de parcours, parce qu'elle se reproduira : le premier jet de `cliClaude.test.js` vérifiait
le bit d'exécution sans condition, et **le runner Windows l'a rejeté** (`vu 666`). NTFS n'a pas
ce bit ; `chmod` n'y bascule que « lecture seule ». Le test accusait le code d'un défaut du
système — le piège déjà consigné dans `docs/plan-de-test.md`. La bascule reste vérifiée là où
elle existe : sans elle, l'AppImage lancerait un fichier non exécutable.

À trancher pour la suite (aucune de ces pistes n'est encore posée) :

1. soustraire le CLI au balayage de linuxdeploy — le stocker compressé dans l'AppImage et le
   détendre au premier lancement, ce qui le retire de l'AppDir en tant qu'ELF ;
2. épingler `linuxdeploy` et ses greffons dans `~/.cache/tauri/` sur des versions connues, en
   les pré-déposant avant la construction (Tauri ne télécharge que ce qui manque) — à ceci
   près que le greffon GTK vient de `master` et le greffon AppImage de `continuous` : ce sont
   des cibles mouvantes, indépendamment de la panne du jour ;
3. ~~figer la version de `@anthropic-ai/claude-agent-sdk`~~ — sans objet : elle l'est déjà.

**L'installeur Windows, lui, se construit** : il est déposé en artefact par son propre job,
que le job Linux tombe ou non. La release **étiquetée**, elle, reste bloquée — `publier`
dépend des deux plateformes (`needs: construire`), et c'est très bien ainsi : livrer une
version en taisant qu'une plateforme n'a pas été produite serait l'échec muet dans sa forme la
plus coûteuse.

### T-075 — Comparaison de période et dénominateurs honnêtes

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-20

Aucune comparaison à la période précédente n'existe (trou constaté chez tous les outils
comparés). Et l'encart Routage décrit **4,3 % des tours** en laissant croire qu'il décrit le
tout : il doit afficher son dénominateur.

**Fait le 2026-08-20.** Les deux moitiés du ticket, et la seconde a changé la première.

**Dénominateurs** : « Répartition par tier » annonce « — 35 tours routés sur 812 », et « Mix
intra-abonnement » la part d'abonnement des tours de la période. Les deux listes décrivaient
une fraction en laissant lire un tout.

**Comparaison** : chaque KPI porte son écart à la période précédente. Le piège, et la raison
d'une fonction dédiée plutôt qu'un `shiftAnchor(-1)` : comparer une semaine entamée depuis
trois jours à une semaine complète produit un « −57 % » qui ne dit rien d'autre que « il reste
quatre jours ». `periodePrecedenteComparable` **tronque donc la période précédente au même
nombre de jours écoulés**, et le libellé le dit (« à ce stade »). C'est T-070 vu par l'autre
bout : une comparaison fausse est pire que pas de comparaison.

Ni vert ni rouge sur ces écarts : plus de tours n'est pas « bien », moins n'est pas « mal ».
La couleur trancherait une question que la page ne pose pas. Onze cas testés, dont
« +∞ % depuis zéro » qui rend `null` plutôt qu'un chiffre inventé, et la troncature qui ne
fabrique pas un 31 février.

### T-073 — Cadence d'échantillonnage des fenêtres d'abonnement

**Type** tech · **Prio** P3 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-20

`claude-windows.jsonl` porte 17 917 instantanés et 3,5 Mo pour 1083 tours — soit une quinzaine
de relevés par tour. L'historique est précieux (c'est la seule trace de la ressource qui
sature), la cadence l'est moins.

**Fait le 2026-08-20 — et la mesure a trouvé mieux que ce que le ticket demandait.**

Dépouillement du fichier réel (22 324 instantanés, 4,3 Mo) : **72,7 % répètent l'utilisation du
précédent**, écart médian **4,9 s**. Mais surtout, le piège qu'aucune lecture de code n'aurait
donné : `resetsAt` porte des **microsecondes qui changent à chaque lecture**
(`23:09:59.811629` puis `23:09:59.557394` pour la MÊME fenêtre). Une déduplication naïve sur
l'objet brut n'aurait jamais rien dédoublonné — et serait passée pour un correctif.

L'instantané n'est donc écrit que si sa **signature** change (utilisations + `resetsAt` tronqué
à la minute : assez fin pour voir une fenêtre se réinitialiser, assez grossier pour ignorer le
bruit), ou si **15 minutes** ont passé. Le battement n'est pas décoratif : sans lui, un long
plateau deviendrait indiscernable d'une absence de relevé — la confusion même que T-059
reproche à la jauge de session.

L'historique DÉJÀ écrit n'est pas touché : il est la seule trace de la ressource qui sature, et
on n'allège pas un journal en le réécrivant. Le fichier cesse de grossir pour rien, il ne perd
rien. Le cliquet a été payé par une extraction : `usageStats.ts` rend tout ce qui touche aux
fenêtres d'abonnement ([fenetresAbonnement.ts](../sidecar/src/fenetresAbonnement.ts)) — elles
n'avaient en commun avec les statistiques d'usage que le dossier où elles sont rangées.

### T-070 — Une période en cours ne dit pas qu'elle est incomplète

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-20

Constat utilisateur du 2026-08-17 : le lundi, la vue Semaine affiche exactement les chiffres
de la vue Jour. Le calcul est juste (la fenêtre est tronquée à aujourd'hui), mais rien ne le
dit, et l'égalité se lit comme une panne. Afficher « jour 1/7 », « jour 17/31 ».

**Fait le 2026-08-20.** Le sélecteur de période affiche « · jour 3/7 » tant que la période
court, en gris de label et non en alerte : les chiffres ne sont pas faux, il leur manque des
jours qui ne sont pas encore arrivés.

`avancementPeriode` ([supervisionPeriode.ts](../ui/src/supervisionPeriode.ts)) rend
`{ecoules, total}` plutôt qu'un pourcentage — « jour 3/7 » se lit sans calcul, et surtout ne
suggère pas une proportion des CHIFFRES (43 % de la semaine écoulée ne veut pas dire 43 % de
son activité). Un jour seul n'affiche rien : « jour 1/1 » serait du bruit. Six cas testés,
dont le dernier jour d'une période, qui la laisse EN COURS — la déclarer révolue le dimanche
ferait disparaître l'avertissement le jour où il reste le plus à venir.

### T-069 — Étiquettes de courbe superposées

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-20

`desempiler` pousse chaque étiquette vers le bas puis la borne à `max` : quand les quatre
séries convergent vers le bas de la fenêtre, plusieurs atterrissent sur la même ligne et
deviennent illisibles. Le cas se produit à chaque début de période. Le désempilement doit
refluer vers le haut quand la place manque en bas.

**Fait le 2026-08-20.** `desempiler` fait désormais DEUX passes : la descendante, qui suffit
tant qu'il reste de la place en bas, puis un **reflux vers le haut** quand elle a buté sur
`max`. Les étiquettes restaient « dans le cadre » — donc l'invariant testé était vert — mais
empilées sur la même ligne, ce que ce même invariant ne voyait pas.

Trois cas ajoutés à `ui/src/supervisionCourbesCalc.test.ts`, dont le cas d'origine (quatre
séries convergeant vers le bas, chaque début de période) et la limite de nature : quand le
cadre entier ne suffit pas, l'empilement revient — en haut du cadre, et le test le dit plutôt
que de laisser croire à une solution générale.

### T-068 — « Part à coût nul » compte des dollars, la rareté est un quota

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-20

`applyRoutageEvent` classe tout tour `engine: claude` comme « coût nul ». Vrai pour le
portefeuille, faux pour la ressource : l'indicateur affiche 98 % de gratuité pendant que la
fenêtre 5 h sature (pic mesuré à **104 %**, 13 jours sur 30 au-dessus de 80 %). Un indicateur
qui rassure à tort est pire qu'un indicateur absent.

**Fait le 2026-08-20.** Le chiffre n'était pas faux, il était partiel — et c'est ce qui le
rendait dangereux : personne ne se méfie d'un 98 %.

Trois changements, tous dans le même geste :

1. **Nommé pour ce qu'il mesure** : « Part à coût nul » devient « Part hors facturation ».
2. **Ventilé en ses deux moitiés**, qui ne coûtent pas la même chose : `partAbonnementPct` et
   `partLocalPct` (servis par `usage.stats`, documentés). Le sous-titre lit désormais
   « abonnement 96 % (quota) · local 2 % » — l'abonnement est gratuit en dollars et se paie en
   quota, le local ne se paie ni en l'un ni en l'autre.
3. **Mis en face de ce qu'il masquait** : le **pic de la fenêtre 5 h sur la période affichée**
   s'affiche sous lui, en ambre au-delà de 80 %. Pic et non moyenne : c'est le pic qui
   déclenche les refus. Pas de rouge — saturer un abonnement PAYÉ n'est pas une panne, c'est
   une limite atteinte.

C'est la règle de T-071 appliquée : jamais un coût sans un signal de qualité en regard.
L'historique des fenêtres, jusqu'ici chargé deux fois par deux panneaux qui s'ignoraient, est
chargé une fois par la page et distribué ([SupervisionAbonnement.tsx](../ui/src/SupervisionAbonnement.tsx),
extrait pour payer le cliquet).

### T-067 — « Contexte moyen » ne mesure rien

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-20

Le KPI retombe sur `promptTokens`, c'est-à-dire `input_tokens` du SDK — qui EXCLUT le cache.
Médiane mesurée sur 1031 tours : **6 tokens**. `extractContextTokens` calcule le contexte réel
depuis toujours et son résultat était abandonné ; T-066 l'enregistre enfin (`contextTokens`),
et l'encart Activité l'affiche en médiane et P90. Reste à retirer l'ancien KPI.

**Fait le 2026-08-20.** L'ancien KPI ne mesurait pas la mauvaise chose *en plus* du reste : il
ne mesurait rien. Il est remplacé, pas retiré — un trou dans la grille aurait été un aveu sans
information.

`avgPromptTokens` disparaît de `usage.stats` (agrégat, buckets, protocole) au profit de
`contexteMedian` : la MÉDIANE de `contextTokens`, l'occupation réelle de la fenêtre (cache
compris) que T-066 enregistre enfin. Médiane et non moyenne, pour la raison qui rendait le
premier chiffre absurde : la distribution est trop étalée pour qu'une moyenne décrive un tour
réel. La carte s'appelle « Contexte médian », la courbe suit.

Deux pièges tenus par `sidecar/test/statsContexte.test.js` : un contexte **absent ou nul** est
un tour non relevé, pas un contexte de zéro — le compter tirerait la médiane vers le bas ; et
l'absence totale de mesure rend `null`, jamais `0`, pour que la courbe s'interrompe au lieu de
plonger.

### T-084 — Les panneaux latéraux ne se replient pas

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-20 · **Clos** 2026-08-20

Ticket écrit APRÈS le code, le 2026-08-20, en soldant le backlog : le travail était livré
(commit `aa1ca85`) et le backlog n'en portait pas trace. Un `feat` sans ticket n'est pas un
échec muet au sens de la doctrine — rien n'est en panne — mais c'est un trou dans la mémoire du
projet, et il se comble au même endroit que le reste.

**Besoin.** Les deux pages de conversation encadrent le composeur de deux panneaux permanents.
Sur un écran étroit, ou simplement pour lire une réponse longue, ils prennent la place sans
qu'on puisse les écarter.

**Réalisé** : repli par la poignée verticale collée au bord de chaque panneau, ou par **Ctrl+L**
pour les deux d'un coup ([panneauxLateraux.ts](../ui/src/panneauxLateraux.ts),
[SidebarSection.tsx](../ui/src/SidebarSection.tsx)).

Trois décisions qui valaient d'être prises explicitement :

1. **La règle de Ctrl+L quand un seul panneau est replié** : un « et » naïf ferait OUVRIR le
   manquant, alors que la frappe demande de dégager l'écran. Il en reste un ouvert → tout se
   replie ; les deux repliés → tout revient. C'est ce cas, invisible au typecheck et à la
   relecture d'un `!` isolé, qui justifie une feuille pure et testée.
2. **Un panneau replié est DÉMONTÉ, pas caché** : ni son contenu ni ses requêtes ne tournent
   pour rien, et le cycle F6 / Alt+flèches l'ignore sans qu'aucun sélecteur de `focusZones.ts`
   ait à le savoir. La poignée, elle, reste toujours montée — repliée, elle est le seul chemin
   de retour à la souris, donc elle reste visible en permanence dans cet état.
3. **Ctrl+L a été repris** à « placer le curseur dans la zone de saisie », qui passe en
   Ctrl+Maj+L : dégager l'écran est demandé bien plus souvent que reposer un curseur que la
   page place déjà d'elle-même à l'arrivée, après un vidage et après une nouvelle conversation.
   Le changement est daté dans la palette des raccourcis, qui l'annonce plutôt que de laisser
   l'ancien geste échouer en silence.

Persistance en `localStorage` (`iaction:panneau:<côté>`), même convention que `SidebarSection`.
Défaut « visible » : un panneau replié est une décision de l'utilisateur, jamais un état initial
subi. Toute lecture/écriture est enveloppée — `window` n'existe pas sous vitest, et le mode
privé strict peut refuser l'écriture.

### T-015 — Un tour Claude peut mourir sans aucune trace dans le journal

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-09 · **Clos** 2026-08-20

Constaté le 2026-08-09 vers 12h44 (projet Rdpl, moteur Claude abonnement).
Deux faits distincts, le second bien plus grave :

**1. Le tour affiché en erreur.** La bulle « Le tour s'est terminé
anormalement (error_during_execution) » que montre l'écran n'est PAS récente :
elle rejoue une conversation enregistrée. L'événement correspondant est daté du
**2026-08-08T22:07:31** (2 jetons en entrée, 479 en sortie, `claude-fable-5`) —
identifié par recoupement exact dans `usage/events.jsonl`. Ce sous-type est
apparu **8 fois depuis le 2026-08-02**, sur les deux modèles, toujours sur des
tours longs ou utilisant une compétence (ici `grill-me`).

**2. Le tour muet — le vrai défaut.** Ce même jour, deux messages envoyés
(12h38 et 12h44) n'ont produit aucune bulle de réponse. Le journal montre
pourtant qu'un tour a **démarré** (`serveurs MCP du tour`, 12h40:46) : il n'a
jamais rendu ni résultat, ni erreur, et aucun processus Claude n'était vivant
au moment du constat. Entre le démarrage du tour et le silence, `app.jsonl` ne
contient **rien**.

Ce qui manque précisément : `recordUsageEvent` consigne bien l'échec dans le
magasin d'usage (`errorMessage: "résultat Claude: <subtype>"`,
`sidecar/src/claude.ts` ~1115), mais **le journal applicatif, lui, ne reçoit
aucune ligne de niveau `error`**. Or c'est lui que lit la page Système, et
c'est lui qu'on ouvre quand quelque chose cloche. Un tour peut donc échouer
sans que l'observabilité en garde la moindre trace — exactement ce que la
doctrine interdit.

Pistes : journaliser en `error` au même endroit que l'événement d'usage (avec
sous-type, session, modèle, et l'outil ou la compétence en cours) ; et prévoir
un garde-fou côté tour — si le processus meurt sans `result`, émettre une
erreur explicite plutôt que laisser l'interface attendre indéfiniment.

**Observation décisive du 2026-08-09 à 13h46**, application FRAÎCHEMENT
redémarrée, tour relancé par l'utilisateur (« enregistre ce note ») :

- le tour est journalisé au départ — `serveurs MCP du tour`, 5 serveurs
  connectés, 39 outils, 1,5 s ;
- **le sidecar est vivant mais n'a AUCUN processus enfant** (`ps --ppid`,
  `pstree`) : le CLI Claude n'a jamais été lancé, alors que son binaire est
  bien présent dans le bundle exécuté (295 Mo, vérifié) ;
- rien après, ni résultat, ni erreur, ni exception ;
- l'interface attend indéfiniment.

Ce n'est donc PAS « le flux se referme sans résultat » : c'est `query()` qui ne
rend jamais son PREMIER message. Aucun garde-fou n'existait pour ce cas — les
deux minuteurs de `claude.ts` ne s'arment qu'APRÈS un `result`.

**Réalisé le 2026-08-09** : journal `error` sur tout tour terminé en erreur
(sous-type, session, modèle — jamais le corps de la réponse), sur toute
exception du flux (avec la pile), et sur un flux qui se referme sans `result`
— ce dernier cas rend désormais une erreur explicite à l'interface au lieu
d'un `done` muet. S'y ajoute un **plafond de silence au démarrage** : aucun
message du SDK dans le délai imparti ⇒ erreur journalisée et remontée, plutôt
qu'une attente infinie.

Reste ouvert : la CAUSE du non-lancement du CLI. Les garde-fous ci-dessus la
rendront visible à la prochaine occurrence — c'est tout leur objet.

**Statut arrêté le 2026-08-15 : EN ATTENTE DE CONSTAT, pas en attente de travail.** Tout ce
qui pouvait être écrit sans revoir la panne l'a été le 2026-08-09 — journal d'erreur sur tout
tour terminé anormalement, sur toute exception du flux, sur un flux qui se referme sans
`result`, et plafond de silence au démarrage. Écrire davantage maintenant reviendrait à coder
contre une hypothèse, puis à présenter l'absence de récidive comme une preuve. Ce ticket se
fermera le jour où la panne reviendra **avec sa trace** — ou, si elle ne revient plus, par une
décision de l'utilisateur, pas par un correctif de plus.

**Fermé le 2026-08-20, sur la mesure et non sur un correctif** — c'est la clause que le ticket
s'était donnée le 2026-08-15 (« ce ticket se fermera le jour où la panne reviendra avec sa
trace — ou, si elle ne revient plus, par une décision de l'utilisateur »).

La mesure : **zéro occurrence** du plafond de silence (« Le moteur Claude n'a donné aucun signe
de vie en … s ») dans `app.jsonl` sur toute la période conservée, du 2026-07-31 au 2026-08-20 —
et zéro dans `coquille.jsonl`, qui ne porte aucune ligne au-dessus d'`info`. Onze jours d'usage
depuis les garde-fous du 2026-08-09, sans une seule récidive.

Ce n'est pas une preuve que la cause a disparu, et le ticket ne prétend pas le contraire : c'est
la constatation qu'il n'y a plus rien à écrire tant que la panne ne se remontre pas. Les
garde-fous restent en place et la rendront datée et bruyante le jour où elle reviendra — sa
réouverture ne coûtera qu'une ligne, avec enfin une trace à lire.

### T-083 — La frappe traîne : un caractère tapé repeignait tout l'écran

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-19 · **Clos** 2026-08-20

Constat utilisateur du 2026-08-19 : « c'est encore super lent de taper dans le chat » —
capture à l'appui, conversation VIDE, fenêtre plein écran sur un 4K. Suite directe de T-031,
qui avait supprimé tout coût JS par frappe : la relecture le confirme, une touche ne
déclenche aujourd'hui **aucun rendu React** (écriture silencieuse du brouillon,
`brouillonVide` ne bascule qu'au premier/dernier caractère), aucun écouteur clavier global ne
travaille, rien n'est persisté par touche. Le coût restant n'était donc plus dans le calcul,
mais dans la **peinture**.

**Trois observations discriminantes** (la leçon de T-031 : mesurer plutôt que relire le code
une quatrième fois) :

- fenêtre réduite au quart de l'écran : **nettement plus fluide** → le coût est proportionnel
  à la SURFACE peinte ;
- composeur de la page **Projets** : **aussi lent** → ce n'est pas du code propre au Chat,
  c'est global à l'application ;
- session lancée par `scripts/dev.sh` → la webview tourne en **renderer logiciel**
  (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, posé le 2026-07-31 contre le crash dmabuf des pilotes
  NVIDIA) : tout est rastérisé au CPU.

Les trois convergent : le rectangle sale d'un caractère tapé ne coûtait pas ce qu'il mesure,
il coûtait un écran entier — ~8 Mpx au processeur, à chaque touche.

**Cause.** Le fond « courbure d'espace-temps » est posé sur `.app-shell::before`, un
pseudo-élément `position: fixed` plein viewport, et il portait DEUX propriétés qui en font une
couche à composer plutôt qu'une image à recopier : `opacity: 0.55` et
`mask-image: linear-gradient(...)`. Un masque ne s'applique pas par rectangle sale mais à la
couche ENTIÈRE : toute invalidation qui la touche — donc chaque caractère tapé, chaque
clignotement de curseur — la faisait re-rastériser en entier, SVG vectoriel compris (53
polylignes, 46 ko), sans bénéfice de cache. Avec le GPU, le compositeur absorbe ce genre de
faute ; en rendu logiciel, elle se paie comptant. C'est aussi pourquoi le symptôme grandit
avec la fenêtre et suit l'application, pas la page.

**Corrigé** — l'atténuation et le fondu du haut sont **cuits dans le SVG** plutôt que posés en
CSS ([gen-horizon-grid.py](../scripts/gen-horizon-grid.py) : groupe `opacity="0.55"` +
masque de luminance interne ; image régénérée dans `ui/public/horizon-grid.svg`). La règle CSS
([App.css](../ui/src/App.css)) ne garde plus qu'un `background-image` : la couche redevient une
image ordinaire, rastérisée une fois et mise en cache, et la frappe ne salit plus que sa ligne
de texte. Le rendu visuel est identique à quelques pixels de rognage près — le fondu est
désormais exprimé dans l'espace de l'IMAGE (16/9, `background-size: cover`) et non du viewport,
donc il suit le dessin plutôt que la fenêtre.

Garde-fou posé en commentaire dans la règle : **pas de `mask-image`, `opacity`, `filter` ni
`backdrop-filter` sur les grandes surfaces fixes**. C'est la troisième fois que la famille
mord (`backdrop-filter` plein écran faisait déjà crasher le renderer logiciel, voir
`.modal-dialog::backdrop`) — le prix ne se voit jamais au repos, il se paie à chaque frappe.

**Confirmé par l'usage le 2026-08-20** : la frappe est fluide en plein écran sur le 4K, en
rendu logiciel. Le ticket se ferme sur ce constat, comme il l'annonçait.

Restent en réserve, jamais mesurés parce que devenus inutiles : la translucidité des surfaces
(`--bg-1/2/inset` en rgba, qui oblige à recomposer la pile sous chaque rectangle sale) et les
lueurs (`box-shadow`/`drop-shadow`) du composeur. Si un jour la frappe retraîne, c'est là
qu'il faut regarder — et en MESURANT, pas en relisant le code (leçon de T-031).

### T-082 — Le taux d'erreur ne compte que des interruptions volontaires

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-19

L'encart Fiabilité affiche **26,1 % de tours en erreur** (6 sur 23) pour le 2026-08-17, tous
sous la cause `error_during_execution`, à côté d'un **0,0 % d'abandons**. Recoupement des 6
`sessionId` avec les transcripts du SDK : **les 6 sont des interruptions de l'utilisateur** —
3 refus de permission d'outil, 3 `[Request interrupted by user]`. Zéro panne technique.
Le KPI le plus alarmant de la page mesure donc un usage normal, et le KPI voisin qui devrait
le porter reste à zéro.

Deux défauts qui se composent, dans `claude.ts` :

1. `const resultStatus = resultSubtype === "success" ? "done" : "error"` verse tout
   non-succès dans l'erreur. Or le SDK rend `error_during_execution` **aussi** quand le tour
   est coupé. `handleClaudeAbort` pose pourtant `run.aborted = true` — l'indicateur existe,
   il n'est simplement jamais lu au moment d'écrire l'événement d'usage.
2. Le refus de permission (`handleClaudePermission`, branche `deny`) ne pose **aucun**
   indicateur : le tour meurt côté CLI et rien ne le distingue d'une vraie panne.

Conséquence : `status: "aborted"` n'est jamais écrit pour un tour de chat — la seule
occurrence du code est côté orchestrateur. `agg.toursAbandon` est structurellement mort.

À faire : poser un indicateur d'interruption sur les deux chemins (abort explicite ET refus
de permission), le lire à l'enregistrement de l'usage pour émettre `aborted` plutôt que
`error`, et distinguer les deux causes à l'affichage (« interrompu » n'est pas « en panne »).
Rapproche aussi T-076 : une partie des « erreurs sans cause » pourrait être de la même
famille.

**Confirmé sur la semaine entière (2026-08-19)** — le recoupement a été refait sur S34 complète :
**11 tours en erreur sur 82**, tous `error_during_execution`, et **11 sur 11** portent un
`[Request interrupted by user]` dans le transcript du SDK à la milliseconde de l'événement
d'usage (3 en variante « for tool use » = refus de permission). Toujours **0 abandon**. Aucune
panne technique dans le lot. Le diagnostic ci-dessus tient tel quel ; seule l'ampleur change.

**Corrigé le 2026-08-19.** Un indicateur `interruption` (`"abandon" | "refus" | null`) est posé
sur `RunState` par les deux chemins qui coupent un tour — `handleClaudeAbort` et la branche
`deny` de `handleClaudePermission` — et LU à la clôture. La décision « panne ou interruption »
est descendue dans une fonction pure unique, `classerIssueDeTour` (`claudeFinDeTour.ts`) :
les trois chemins de fin de tour la partagent, alors qu'ils portaient chacun leur copie du
même mauvais classement. Le `result` final a suivi (`enregistrerResultatFinal`), ce qui sort
de `claude.ts` la trentaine de lignes qui n'y avaient rien à faire.

Trois conséquences visibles :

1. une interruption s'écrit `status: "aborted"` avec sa raison, et se journalise en `info`
   plutôt qu'en `error` — un usage normal cesse d'encombrer le journal des pannes, sans pour
   autant devenir muet ;
2. `usageSobriete` ventile les interruptions dans `parCauseAbandon`, à côté de `parCause` et
   jamais dedans ; l'encart Fiabilité affiche désormais « Tours en panne » et « Tours
   interrompus », chacun avec sa ventilation ;
3. l'historique écrit avant ce correctif reste lisible : un abandon sans cause tombe dans
   la classe explicite `(aucune cause enregistrée)` de T-076, jamais dans une cause inventée.

**Limite assumée**, écrite dans le code : un refus de permission ne coupe pas toujours le tour
— le modèle peut l'encaisser et continuer. L'indicateur `refus` est donc effacé dès que le
modèle reparle (cas `assistant`), sans quoi une panne survenant plus tard dans le même tour
serait maquillée en interruption. `abandon` ne s'efface jamais : `claude.abort` interrompt
le CLI, c'est définitif.

Preuve : `sidecar/test/finDeTour.test.js` — 5 blocs, dont le lot réel de S34 en miniature
(8 arrêts + 3 refus + 1 panne) qui vérifie que les deux ventilations ne se contaminent pas.

### T-081 — L'app lance des sous-agents qu'elle ne sait pas lister

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-17

Constaté le 2026-08-17 en cherchant à afficher, à côté de chaque sous-agent lancé (T-077), le
modèle sur lequel il tourne. La donnée existe : les manifestes déclarent `model:` en
frontmatter (aujourd'hui `implementeur: sonnet`, `relecteur: opus`, `explorateur` ·
`verificateur` · `declarant` · `trieur-local: haiku`).

**Asymétrie constatée.** Le moteur projet passe `settingSources: ["user","project","local"]`
([claude.ts:665](../sidecar/src/claude.ts#L665)) : le SDK charge donc les agents du POSTE
(`~/.claude/agents`) et peut les lancer. Mais `agents.list` ne parcourt que
`<projet>/.claude/agents` ([orchestrator.ts:411](../sidecar/src/orchestrator.ts#L411)) : les
six agents du poste sont **invisibles à l'app**. Elle sait les exécuter, pas les nommer — donc
l'affichage du modèle déclaré est vide là où il compte, et le sélecteur d'agent ne les propose
pas non plus alors qu'ils sont utilisables.

**Corrige aussi une inexactitude de l'étude.** [etude-supervision.md §2.1](etude-supervision.md)
affirme « IAction ne passe jamais l'option `agents` au SDK […] il n'y a donc rien d'autre à voir
que le modèle du fil ». C'est faux dans les deux moitiés : les manifestes du poste déclarent
déjà des modèles, et ils sont chargés. Le vrai manque n'est pas la déclaration mais le fait que
l'app délègue peu — l'orchestrateur fait le travail lui-même en haut de table (mesuré le
2026-08-17 sur 1085 tours : opus-4-8 640, fable-5 201, opus-5 105, **sonnet-5 44**, haiku-4-5 35).

**Un troisième défaut, trouvé par le test qui devait valider le reste.** `buildImportedAgent`
**jetait le `model:` du frontmatter** (`model: null` en dur) : même une fois les manifestes
listés, l'app affichait l'agent sans savoir sur quoi il tourne. Un champ lu puis jeté, comme
`modelUsage` avant T-066 — c'est la deuxième fois en deux tickets, la forme mérite d'être
retenue.

**Réalisé** (fermé le 2026-08-17) :

1. `claudeUserAgentsDir` ([appPaths.ts](../sidecar/src/appPaths.ts)) — `~/.claude/agents`, avec
   `CLAUDE_CONFIG_DIR` honoré (la variable du CLI : si le poste a déplacé son dossier, lire
   `~/.claude` serait lire un dossier vide). Le foyer vient de `PathEnv`, jamais de
   `os.homedir()` en dur — les deux plateformes se testent depuis n'importe quelle machine.
2. `agents.list` ajoute ces agents au scope `claude-code` existant, **précédence du SDK
   respectée** : à nom égal, le manifeste du projet gagne et celui du poste est écarté (un
   doublon dont une moitié n'est jamais exécutée mentirait). Zéro plomberie UI, zéro ligne
   dans `AgentPage.tsx` — déjà en dépassement de cliquet à cause du travail T-062 en cours.
3. `model:` enfin lu, alias comme id complet, sans traduction de l'un vers l'autre.
4. Affichage `explorateur · haiku` dans la liste des sous-agents vifs
   ([agentSidebarDroit.tsx](../ui/src/agentSidebarDroit.tsx)), la feuille pure
   `modeleSousAgentDeclare` ([agentTurns.ts](../ui/src/agentTurns.ts)) faisant la jonction.
   L'infobulle dit « modèle **déclaré** » : c'est une intention, pas une mesure, et elle ne se
   somme JAMAIS avec la ventilation `modelUsage` de T-066 (même règle que T-035).
5. Trois cas distincts, aucun deviné : modèle déclaré → affiché ; manifeste sans `model` →
   « hérite du fil » ; type inconnu (agents intégrés du SDK, `general-purpose`…) → rien
   d'affiché plutôt qu'un modèle inventé.

Le harness de test impose un `CLAUDE_CONFIG_DIR` jetable, pour la même raison que les deux
défauts XDG avant lui : sans ça, la suite lirait les agents RÉELS du poste et un test qui les
compte serait vert ou rouge selon la machine.

Au passage, le cliquet a fait son travail : +22 lignes sur `orchestrator.ts`, déjà en
dérogation. Le bloc d'import `.claude/agents` en est sorti dans
[agentsImportes.ts](../sidecar/src/agentsImportes.ts) — 97 lignes déjà autonomes, aucun
comportement changé (`baseNameNoExt` est repris à l'identique, regex comprise, plutôt que
« amélioré » en `path.extname` qui traite les fichiers cachés autrement). Bilan : 1802 → 1743.

### T-080 — Le mode Auto des Projets est supprimé

**Type** feat · **Prio** P1 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-17

Décision de l'utilisateur après le constat de T-079 : un mode automatique qui n'arbitre rien
est pire qu'un choix explicite, parce qu'il fait croire à un arbitrage. Il est donc retiré
des Projets et remplacé par ce qu'il faisait réellement — partir sur un modèle fixe — mais
dit à voix haute et réglable.

Périmètre tranché avec l'utilisateur : **Projets seulement** (le Chat garde sa stratégie
montante, qui elle classe réellement le prompt) · **pas de débord** sur le chemin modèle
fixe (il reste vivant côté Chat) · **réglage global**, pas par projet.

Ce qui disparaît : la sentinelle `AUTO_MODEL`, l'option muette « (défaut) » du sélecteur,
`resoudreRouteDescendante` et ses tests, la branche de routage d'`envoiProjet` (affinité de
session, badge « ⚡ auto », bandeau de débord, méta `routeTier`/`routeDebord`), et la ligne
« modèle réellement routé » de T-077 — devenue sans objet, le sélecteur affichant désormais
le modèle réel. Bilan : **−93 lignes** dans `envoiProjet.ts`, −83 dans `routageAuto.ts`.

Ce qui arrive : `modeleDefaut.ts` (feuille pure, 7 tests) et le réglage
`ModeleDefautProjets.tsx` dans la page Configuration. Défaut d'usine `claude-opus-5` (T-078).

**Migration des sessions existantes** — le point qui aurait mordu : 30 conversations
portaient `model: "__auto__"`, d'autres `""`. `resoudreModeleSession` préfère TOUJOURS la
cible réellement routée (`routedTarget`) pour une session qui a déjà tourné : la rouvrir
sur le nouveau défaut lui ferait changer de modèle en cours de route, en silence. Sans
cible connue, défaut configuré. Les deux cas sont testés.

`AgentPage.tsx` et `ProvidersPage.tsx` étant tous deux à leur plafond de cliquet, le
réglage est un composant à part et la copie de la section « Routage automatique » a été
resserrée — elle ne concerne plus que le Chat, ce qu'elle prétendait déjà à tort.

### T-079 — La stratégie « descendante » ne descend jamais

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-17 ·
**Résolu par** T-080 (suppression du mode, décision utilisateur)

Constat utilisateur : « je viens de poser une question simple, pourquoi je n'ai pas eu de
descente ? ». Il n'y en a pas, et ce n'est pas un raté d'exécution — c'est le contrat
actuel :

- `routageAuto.ts` impose `complexe` au premier tour, **« aucune classification du
  prompt »** (le barème de scoring de `router.ts` ne sert qu'au Chat, stratégie montante) ;
- les gardes ne replient qu'en **remontant** la table (`gardesRoutage.ts`) ;
- l'affinité de session rejoue le tier imposé à chaque tour, sans re-classification.

L'infobulle du sélecteur le dit d'ailleurs : « descendre est un choix manuel ». Sauf que
descendre à la main **sort du mode Auto** — d'où la question légitime : à quoi sert un
mode automatique qui n'arbitre rien ? Ce qu'il apporte réellement aujourd'hui se réduit au
débord R3 (bascule quand la fenêtre d'abonnement sature) et aux gardes de cible
injoignable. C'est utile, mais ce n'est pas du routage.

T-078 rend le défaut défendable (le sommet imposé est maintenant le modèle qu'on voudrait
par défaut de toute façon), il ne règle pas ça : une question triviale dans un projet part
toujours sur opus-5.

**Et les deux gardes sont inatteignables dans la configuration par défaut.**
`estCibleUtilisable` (`routageAuto.ts:73`) rend vrai dès que `engine === "claude"` : la
table par défaut étant à 100 % sur l'abonnement, la garde « cible injoignable » ne peut pas
se déclencher. La garde « débord vers fournisseur non déclaré » teste la cible de débord —
openrouter par défaut, et openrouter est déclaré ici. Deux branches mortes tant qu'aucun
tier ne pointe vers un fournisseur neutre. Ce qui reste réellement vivant dans le mode
Auto se réduit donc au **débord lui-même**, dont le signal déclencheur porte déjà un
ticket ouvert (T-059 : jauge à 94 % pendant que l'abonnement était saturé).

Pistes, à trancher — aucune n'est évidente :

1. **Classifier aussi côté Projets**, avec un plancher (jamais sous `moyen`) : le risque
   d'une mauvaise classification vers le bas sur du code est réel, c'est la raison d'être
   du choix d'origine.
2. **Descente autorisée sur signal fort seulement** (message court, sans pièce jointe,
   sans fichier ouvert), et jamais après le premier tour de travail.
3. **Assumer et renommer** : « Sommet de table (+ débord) » plutôt qu'« Auto (descendant) »
   — un nom honnête vaut mieux qu'une intelligence promise et absente.

Dépend de T-074 (signal d'escalade) pour mesurer si une descente coûterait de la qualité.

### T-078 — Le sommet de la table recevait tout le trafic

**Type** tech · **Prio** P1 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-17

Table par défaut : `complexe → claude-fable-5`. Or la stratégie descendante des Projets
(R7 §C) impose le tier `complexe` au **premier tour, sans lire le prompt**
(`routageAuto.ts`), et l'affinité de session gèle ensuite la cible. Le sommet de la table
n'était donc pas « ce qu'on sort pour les tâches dures » : c'était **ce sur quoi tout
tournait**, y compris une question d'une ligne.

Relevé du 2026-08-17 sur 1 034 tours d'abonnement (`usage/events.jsonl`) :

| modèle | tours | sortie/tour | éq. API | part tokens | part coût |
|--------|-------|-------------|---------|-------------|-----------|
| opus-4-8 | 640 | 5 329 | 85,39 $ | 60,7 % | 50,0 % |
| **fable-5** | **200** | **6 697** | **67,03 $** | **23,8 %** | **39,3 %** |
| opus-5 | 104 | 5 889 | 15,36 $ | 10,9 % | 9,0 % |

**0,335 $ le tour fable contre 0,148 $ le tour opus-5 — 2,3×.** Deux facteurs qui se
multiplient : le tarif (10/50 $ par MTok contre 5/25, soit le double) et le volume, la
réflexion étant **toujours active** sur Fable et non désactivable (`thinking: disabled`
renvoie un 400). Latence relevée : médiane 53 s par tour.

Corrigé en portant `complexe` sur `claude-opus-5` — qui est aussi le modèle par défaut
recommandé pour le travail agentique. Fable reste épinglé dans le sélecteur : il se choisit
désormais **à la main**, ce qui était l'intention d'origine. Les DEUX déclarations sont
changées (`sidecar/src/router.ts` et `ui/src/routerAdmin.ts`) — `npm run routage` existe
précisément pour interdire qu'elles divergent (leçon de la revue du 2026-08-07).

Réserve assumée sur le chiffrage : `promptTokens` exclut le cache (T-067), donc les coûts
absolus sont sous-estimés pour tous les modèles. Les rapports entre modèles tiennent.

### T-077 — Le mode Auto ne disait pas ce qu'il faisait

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-17

En mode Auto, la section LLM des Projets affichait « Auto (descendant) » et rien d'autre :
le modèle réellement routé par R7 existait pourtant (encart Contexte de l'en-tête, ligne
« ⚡ auto : … » de chaque tour), mais pas **là où l'on arbitre**. Choisir un modèle est
arbitrer un coût ; taire celui qui est en vigueur au moment du choix est un échec muet.

Deux lignes neuves sous le sélecteur (`agentSidebarDroit.tsx`) :

- **le modèle réel** — `activeRuntime.routedTarget`, avec son tier, parce que c'est le tier
  qui l'explique. Tant que rien n'a été routé, on l'écrit (« aucun modèle routé pour
  l'instant ») plutôt que d'afficher un défaut qui n'a pas encore été choisi ;
- **les sous-agents du dernier tour** — `sousAgentsVifs`, feuille pure testée
  (`agentTurns.ts`). Aucun canal neuf côté sidecar : la trace était DÉJÀ dans les blocs du
  tour (outil de délégation portant `subagent_type`), reçue depuis toujours et jamais
  totalisée. Chaque puce distingue *en cours* / *terminé* / *terminé en erreur* /
  *interrompu* — hors tour, un lancement sans résultat n'est pas vivant, il est interrompu,
  et le dire évite un point qui pulse pour rien.

Périmètre assumé : ceci dit **qui a été lancé**, pas sur quel modèle il tourne — le SDK ne
l'annonce pas au lancement. Le modèle par délégation reste l'affaire de la ventilation
T-066 et de son minorant. Deux mesures distinctes, jamais fondues en une.

`AgentPage.tsx` étant à son plafond de cliquet au trait près, la prop `sessionId` est
devenue `vif` (session + modèle routé + tours) : un seul objet « ce que la session fait
vraiment », zéro ligne ajoutée au fichier-dieu.

Reste ouvert : le Chat (stratégie montante) n'a pas d'équivalent — même besoin, autre page.

### T-066 — La ventilation par modèle était parsée puis jetée

**Type** tech · **Prio** P1 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-17

Un tour n'émettait qu'UN événement d'usage, portant `lastModel` et le cumul de tokens du
process entier. Quand le tour déléguait, le travail des sous-agents était bien compté — mais
rangé sous le modèle du fil. La page ne ratait donc pas la délégation : elle la déguisait.
Mesure du jour : 60,9 % des tokens en haut de table, mais **99,4 % du coût équivalent API**.

`modelUsage` du message `result` portait exactement ce qui manquait (tokens, cache, coût et
fenêtre par modèle) et était parsé puis jeté. Corrigé par `claudeVentilation.ts` — feuille
pure, testée — et trois champs nouveaux sur l'événement : `ventilation`, `contextTokens`
(déjà calculé, jamais écrit) et `durationMs` (jamais mesuré).

L'événement reste à UN par tour, la ventilation est imbriquée : émettre une ligne par modèle
aurait gonflé le compte de `tours` de tous les agrégats existants. Un socle ne casse pas ce
qu'il porte.

Limite assumée et écrite dans le code : `modelUsage` est indexé par modèle, pas par agent —
un sous-agent tournant sur le même modèle que le fil est indiscernable et compte comme fil.
La part déléguée est un MINORANT tant que les sous-agents ne sont pas déclarés avec leur
propre modèle (option `agents` du SDK). Voir `docs/etude-supervision.md` §6.

### T-062 — Deux fenêtres, un processus, un sidecar

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-17

Lot 2 d'[etude-deux-projets.md](etude-deux-projets.md), décisions utilisateur du 2026-08-15 :
une seule fenêtre par projet (ouvrir un projet déjà ouvert BASCULE sur sa fenêtre), et la
deuxième fenêtre porte TOUT — même application, autre fenêtre. Dépend de T-061, **fait**.

**Deux blocants de plus, trouvés le 2026-08-17 en instruisant le lot** — l'inventaire de
l'étude ne les portait pas, et le premier aurait coûté une session :

6. **Fermer N'IMPORTE QUELLE fenêtre tue le sidecar** (`lib.rs:166`) : `CloseRequested` appelle
   `request_shutdown` sans regarder combien de fenêtres restent. Avec deux fenêtres, fermer la
   seconde couperait le moteur de la première — en plein tour. L'arrêt doit être conditionné à
   la DERNIÈRE fenêtre.
7. **Micro et surveillance de la webview sont câblés en dur sur `"main"`** (`lib.rs:29`,
   `webview_vie.rs:121`) : la deuxième fenêtre n'aurait pas la dictée vocale, et la mort de son
   process de contenu (T-030 — quatre fois en six jours) passerait sans une ligne de journal.
   Les deux fonctions doivent prendre une fenêtre en paramètre, pas la chercher par son nom.

À faire, dans l'ordre :

1. **Préfixe d'identifiants par fenêtre** (`ui/src/sidecar.ts:96,219`) : chaque fenêtre compte
   ses requêtes depuis zéro et les événements du sidecar sont diffusés à toutes
   (`sidecar.rs:665`) — sans préfixe, deux fenêtres se volent leurs réponses. Un préfixe
   aléatoire au chargement du module suffit.
2. **« Nouvelle fenêtre »** (bouton + raccourci `Ctrl+Maj+N`) : commande Rust
   `fenetre_ouvrir` qui construit `main-2`, `main-3`… sur la même page, et leur câble micro et
   surveillance (blocant 7). Capacités élargies à `main-*` (`capabilities/default.json:5` ne
   connaît que `main` : sans cette entrée la seconde fenêtre n'a AUCUNE permission, pas même
   d'`invoke` — elle s'ouvrirait vivante et sourde).
3. **Une fenêtre par projet** : registre `projet → fenêtre` dans la coquille, seule à voir
   toutes les fenêtres. Revendiquer avant de basculer ; si une autre fenêtre le porte, elle
   passe devant et la bascule n'a pas lieu. Le registre est libéré à la fermeture de la
   fenêtre.
4. **`last-project` par fenêtre** (`state/last-project.json` est aujourd'hui un singleton) :
   `main` garde la clé historique, les autres prennent `last-project-<étiquette>`. Au
   démarrage, une fenêtre qui trouve son dernier projet déjà porté ailleurs ouvre le premier
   projet libre — jamais un écran vide sans explication.
5. Ce qui est DIFFUSÉ reste diffusé — statut du sidecar, encart d'usage, jauges : juste dans
   toutes les fenêtres par construction.

**Limite assumée, écrite ici pour ne pas être découverte plus tard** : le registre protège les
PROJETS, pas les conversations du Chat. Deux fenêtres ouvrant la MÊME conversation de Chat
peuvent encore s'écraser — T-061 a éclaté le fichier par conversation, donc le risque est borné
à une conversation ouverte deux fois, au lieu des 467 Ko d'avant. À traiter par le même patron
de registre le jour où le cas se présente.

Hors contrat, écrit dans l'étude : deux processus séparés (voie B, écartée tant qu'un constat
ne la réclame pas) ; T-028 reste tel quel — il garde le port de dev, pas le produit.

**Fait le 2026-08-17.** Côté coquille, [fenetres.rs](../src-tauri/src/fenetres.rs) : un `Registre`
pur `projet → fenêtre` (7 tests, dont celui qui compte — une entrée laissée par une fenêtre
MORTE n'interdit pas le projet pour toujours), les quatre commandes, des étiquettes `main-2`,
`main-3` jamais réutilisées. `autoriser_micro_webkit` et `webview_vie::surveiller` prennent
désormais la fenêtre en paramètre et sont câblées sur chaque nouvelle (blocant 7) ; l'arrêt du
sidecar est conditionné à la dernière fenêtre (blocant 6) ; capacités passées à `main-*`.
Côté interface, deux feuilles neuves : [fenetreProjet.ts](../ui/src/fenetreProjet.ts) (pur,
10 tests — clé de mémoire par fenêtre et choix du projet au démarrage) et
[fenetreClient.ts](../ui/src/fenetreClient.ts) (les `invoke` du registre, au patron de
`stateClient.ts`). Préfixe d'ids par fenêtre dans `sidecar.ts`, « Nouvelle fenêtre » en barre
et sur `Ctrl+Maj+N`.

**Le cliquet a été payé par deux extractions, pas par du rabotage** : `App.tsx` (1 005 → 916)
a rendu sa barre de navigation à [barreNavigation.tsx](../ui/src/barreNavigation.tsx), et les
appels à la coquille sont sortis d'`AgentPage.tsx` vers `fenetreClient.ts`. Les deux fichiers
repassent sous leur plafond sans dérogation nouvelle.

**Vérifié : 427 tests UI, 85 Rust, 30 fichiers sidecar, lint, typecheck, les neuf contrôles du
dépôt — tous à 0. NON vérifié : le comportement à deux fenêtres n'a jamais été exécuté**, la
consigne étant que l'application soit lancée par l'utilisateur. Premier essai à faire :
`Ctrl+Maj+N`, choisir un AUTRE projet dans la nouvelle fenêtre, lancer un tour de chaque côté,
puis fermer la seconde — le sidecar de la première doit survivre (c'est le blocant 6).

### T-065 — Le sélecteur de modèle tuait toute l'interface

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-17 · **Clos** 2026-08-17

Constat utilisateur du 2026-08-17, capture à l'appui : l'application n'affiche plus que
l'écran de secours, « L'INTERFACE S'EST INTERROMPUE — `null is not an object (evaluating
'e.currentTarget.value')` ». Le constat est venu en travaillant sur le fournisseur Swiftask,
mais rien dans la panne ne lui est propre : c'est le sélecteur de modèle, et son catalogue de
~130 entrées invite justement à taper dans le champ de recherche.

Le journal applicatif tenait la réponse entière — c'est exactement ce pour quoi il existe
(`logs/app.jsonl`, 22:15:26, niveau `fatal`) :

```
@…/src/ModelPicker.tsx:235:84
updateReducerImpl@…/react-dom_client.js:5943      ← évalué PENDANT le rendu
useState@…
ModelPicker@…
```

**La cause.** L'événement était lu à l'intérieur de l'updater fonctionnel passé à `setState` :

```tsx
onChange={(e) => setFiltre((f) => ({ ...f, recherche: e.currentTarget.value }))}
```

React remet `currentTarget` à `null` dès que le gestionnaire rend la main — la propriété n'a de
sens que pendant la propagation. Or l'updater `(f) => …` n'est pas exécuté là : React le garde
en file et l'évalue au rendu suivant, quand `e.currentTarget` vaut déjà `null`. La frappe fait
donc planter le rendu, et l'`ErrorBoundary` remplace toute l'application.

**Pourquoi ça n'a pas été vu plus tôt.** React possède une optimisation dite *eager state* :
quand la file de mises à jour est VIDE, il exécute l'updater tout de suite, dans le gestionnaire
— où `currentTarget` est encore valide. Le code marchait donc la plupart du temps, et ne
plantait que lorsqu'une autre mise à jour était déjà en attente. Un plantage intermittent, sur
un chemin très fréquenté, qu'aucun test manuel n'attrape de façon fiable.

**Corrigé** en lisant la valeur AVANT l'appel, et en ne passant que la valeur. Quatre sites
portaient la même faute, tous trouvés par le même motif :
[ModelPicker.tsx](../ui/src/ModelPicker.tsx) (recherche et tri — le site du plantage),
[McpPanel.tsx](../ui/src/McpPanel.tsx), [orchOrchestrations.tsx](../ui/src/orchOrchestrations.tsx).

**Garde-fou.** `eslint.config.mjs` s'ouvrait sur « on élargira si un autre incident le
justifie » : c'en est un, et la deuxième règle est posée — `no-restricted-syntax` refuse tout
accès à `currentTarget` sous une fonction passée à un `setX(…)`. Vérifiée en réintroduisant la
faute d'origine avant de la retirer : la règle la signale, et le lint reste vert sans elle.
Un typecheck ne pouvait rien voir ici (`e.currentTarget` est bien typé, c'est sa DURÉE DE VIE
qui est en cause) et les tests du front tournent sans DOM : l'analyse statique était le seul
filet possible.

### T-009 — Dev : fenêtre ouverte avant que vite soit chaud

Incident du 2026-08-08, 11h36 : `dev.sh` relancé, vite démarré à 11:36:53,
fenêtre ouverte à 11:36:55 — le webview a chargé la page pendant la
ré-optimisation à froid de vite. Résultat : interface rendue mais greffe IPC
jamais initialisée — `config_read` sans réponse, « Aucun projet » alors que
la config est intacte, **zéro trafic pendant 13 minutes** sans le moindre
message d'erreur. Un simple rechargement du webview répare. Pistes (dev
uniquement) : garde-fou au boot de l'UI — si les invocations de démarrage
n'ont pas répondu après quelques secondes, bandeau « recharger » (voire
rechargement automatique une fois), plutôt qu'une page qui a l'air saine.

**Type** tech · **Prio** P3 · **Statut** fait · **Clos** 2026-08-16

**Corrigé le 2026-08-16.** Un bandeau apparaît quand la coquille n'a rien répondu dans les six
secondes suivant l'ouverture de l'interface, avec un bouton « Recharger la page » — le remède
constaté, celui qui réparait tout.

Trois choix méritent d'être dits, chacun ayant été tentant dans l'autre sens :

1. **La sonde est `fetchStatus`, pas `config_read`.** C'est la commande la plus élémentaire de
   la coquille, et elle répond même quand le sidecar est mort. Si ELLE se tait, ce n'est donc
   pas le moteur qui manque : c'est la greffe IPC qui ne s'est jamais établie — le cas constaté.
   Une réponse en ERREUR suffit à éteindre la garde : c'est le silence qu'on traque, pas
   l'échec.
2. **Aucun rechargement automatique**, alors que le ticket l'envisageait (« voire rechargement
   automatique une fois »). Il effacerait ce que l'utilisateur est en train de taper, et surtout
   rendrait la panne invisible une seconde fois — exactement le travers qu'on corrige. On
   propose, l'utilisateur décide.
3. **Le bandeau ne s'efface pas** si une réponse finit par arriver. La greffe rétablie ne rend
   pas les treize minutes perdues, et l'utilisateur doit pouvoir lire ce qui s'est passé. Il
   disparaît au rechargement, qui est le remède.

La garde vit dans [gardeBoot.ts](../ui/src/gardeBoot.ts), séparée de son affichage et donc
testable : six cas, dont les trois qui comptent — jamais d'avis après une réponse, jamais deux
avis, jamais d'avis après démontage. Un bandeau qui apparaîtrait sur une application qui marche
détruirait la confiance qu'il cherche à établir.

Le ticket disait « dev uniquement ». La garde tourne pourtant partout : une greffe IPC muette
n'a rien de spécifique au développement, et un bandeau qui ne s'affiche que lorsque plus rien ne
répond ne peut nuire nulle part. Effet de bord du cliquet, qui a refusé les deux lignes
ajoutées à `App.tsx` : les deux bandeaux de la coquille sortent dans
[bandeaux.tsx](../ui/src/bandeaux.tsx) — ils répondent à la même famille de panne, un étage sous
l'interface a lâché. `App.tsx` : 1 022 → 965 lignes.

### T-030 — La fenêtre gèle au démarrage, et rien ne le dit

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-12 · **Clos** 2026-08-15

Constaté le 2026-08-12 à 17h25 : application « complètement bloquée au lancement ».
La coquille allait bien — c'est le **process de contenu WebKit qui était mort**, la
fenêtre affichant sa dernière image pour toujours.

Relevé brut :

- `coquille.jsonl` va jusqu'au bout (`ui:premier-rendu` à 15:25:45.720Z), donc la page
  a bien été peinte ;
- `ps --ppid <iaction>` ne montre plus que `WebKitNetworkProcess` — **plus de
  `WebKitWebProcess`** ; `iaction` et le sidecar sont vivants, à 0 % de CPU ;
- `journalctl` : `pipewire-main-l[1745939]: segfault at 18 … in libgstpipewire.so`
  à 17:25:49, soit ~3 s après la première image. Le plantage est **dans une
  bibliothèque système** (greffon PipeWire de GStreamer, que WebKit charge pour le
  moniteur de périphériques média), pas dans notre code ;
- même signature 3 fois avant : 2026-08-07 14:31 et 18:17, 2026-08-08 11:36. Le
  déclencheur exact n'est pas compris — la plupart des lancements passent.
  (Le 2026-08-11 23:58, un couple d'autres segfaults, `libwebkit2gtk` puis
  `libnvidia-eglcore`, a tué le même process : le mode de panne « la webview meurt »
  n'est pas propre à PipeWire.)

Le vrai défaut est le nôtre : **`app.jsonl` ne contient pas une ligne** sur cet
événement, l'utilisateur n'a aucun message, et la fenêtre reste ouverte, figée,
impossible à distinguer d'une lenteur. C'est exactement l'échec muet que la doctrine
d'observabilité interdit — la coquille sait pourtant journaliser la mort du sidecar
(T-017), elle doit savoir journaliser la mort de sa webview.

À faire :

1. brancher le signal `web-process-terminated` de WebKitGTK (raison : plantage /
   dépassement mémoire / tué), écrire une ligne `error` dans `app.jsonl` et un jalon
   dans `coquille.jsonl` ;
2. afficher un état franc dans la fenêtre plutôt qu'une image morte, avec un bouton
   « recharger » (la coquille peut recréer la webview sans relancer le process) ;
3. seulement ensuite, chercher à éviter le plantage lui-même — piste à tester,
   dégrader le greffon fautif au lancement (`GST_PLUGIN_FEATURE_RANK=pipewiredeviceprovider:NONE`
   dans `scripts/dev.sh` et dans l'environnement de l'app empaquetée) pour retomber
   sur le fournisseur PulseAudio. À confirmer par un relevé : la panne est
   intermittente, une absence de plantage sur quelques lancements ne prouvera rien.

**Corrigé le 2026-08-15 — les points 1 et 2. Le 3 devient [T-056](#t-056--le-process-de-contenu-webkit-plante-par-intermittence).**

Le signal `web-process-terminated` de WebKitGTK est branché sur la fenêtre principale
([webview_vie.rs](../src-tauri/src/webview_vie.rs)), et il écrit dans les DEUX journaux.

Le point qui a demandé le plus de réflexion n'est pas le branchement, c'est **par où faire
passer la trace**. `log_app` route vers l'interface (`app:log` → `log.append`) : or l'interface
est précisément ce qui vient de mourir. La ligne aurait été perdue à l'instant exact où elle
compte le plus — même piège que T-017, où la coquille journalisait la naissance du sidecar mais
jamais sa mort. On écrit donc sans elle : `coquille.jsonl` directement, et `app.jsonl` en
s'adressant au sidecar, qui, lui, est toujours vivant. Deux chemins, aucun ne dépend de ce qui
vient de tomber.

À l'écran, la fenêtre n'affiche plus son dernier dessin pour toujours : une page d'interruption
prend sa place, dit ce qui s'est passé, précise que le moteur de tâches tourne toujours, et
propose de recharger. Cette page est **autonome par construction** — WebKit relance bien un
process de contenu pour l'afficher, mais celui-ci ne porte plus le pont IPC de Tauri : tout
`invoke` y serait mort-né, donc le bouton est un simple lien vers l'adresse de l'application,
lue AVANT de remplacer la page. Sans adresse connue, on ne promet pas un rechargement : on dit
de relancer l'application. Trois tests couvrent ces cas, dont l'échappement de l'adresse — elle
vient du moteur, mais elle entre dans du HTML écrit à la main.

**Ce qui n'est délibérément PAS fait** : dégrader le greffon PipeWire
(`GST_PLUGIN_FEATURE_RANK`). Le ticket le disait lui-même — la panne est intermittente, une
absence de plantage sur quelques lancements ne prouverait rien. Poser ce contournement
maintenant supprimerait surtout la panne qu'on vient enfin de rendre visible, avant d'avoir pu
la mesurer.

### T-061 — Un fichier d'état par projet, au lieu de deux monolithes réécrits en entier

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Lot 1 d'[etude-deux-projets.md](etude-deux-projets.md) — le socle sans lequel une deuxième
fenêtre perdrait des données en silence, et qui a de la valeur même seul.

L'état des conversations vit dans deux monolithes réécrits EN ENTIER à chaque sauvegarde :
`state/project-conversations.json` (**12 Mo**, tous les projets, trois sites d'écriture du
document complet — `AgentPage.tsx:992,1033,1117`) et `state/chat-conversations.json` (467 Ko,
toutes les conversations du Chat). Deux fenêtres — même sur des projets DIFFÉRENTS —
s'écraseraient mutuellement : perte d'historique garantie, silencieuse.

À faire :

1. **Projets** : un fichier par projet (`state/projets/<slug>.json`), migration du monolithe
   au premier chargement (le monolithe est renommé, pas supprimé — on ne détruit pas la seule
   copie d'un historique), écriture bornée au projet touché.
2. **Chat** : même patron (décision utilisateur du 2026-08-15, conséquence de « la deuxième
   fenêtre porte tout ») — par conversation ou par petit groupe, au choix de l'implémentation,
   pourvu que deux fenêtres n'écrivent jamais le même fichier.
3. La logique de rangement en **feuille pure testée** (patron du dépôt) : découpage, slugs,
   migration, fusion de lecture — testables sans fenêtre.

Bénéfices au-delà des fenêtres : chaque sauvegarde passe de 12 Mo au poids d'un projet ; le
démarrage ne relit plus que ce qu'il affiche (T-029 avait mesuré le parse du monolithe) ; un
fichier corrompu ne coûte plus que SON projet.

**Contrainte d'exécution : application FERMÉE** — la migration change le format du fichier que
l'application ouverte réécrit en continu ; la faire pendant qu'elle tourne recréerait le
monolithe à côté de la migration (même famille de piège que T-012/`npm install`).

**Fait le 2026-08-15.** Deux primitives Rust (`state_list`, `state_rename` — qui REFUSE
d'écraser sa cible : renommer n'est jamais un moyen détourné de détruire), une feuille pure
[etatEclate.ts](../ui/src/etatEclate.ts) (13 cas de test : migration idempotente, rien n'est
jamais détruit, une sauvegarde n'écrit que ce qui a changé), câblage des deux pages, et le
lecteur du sidecar ([usageProjets.ts](../sidecar/src/usageProjets.ts)) qui comprend le nouveau
rangement avec repli monolithe pour un poste pas encore migré.

**La contrainte « application fermée » n'a pas tenu, et c'est instructif** : l'utilisateur a
relancé l'application en plein chantier, et le HMR a servi le code à moitié câblé. La
migration s'est exécutée EN RÉEL à 19:18 — proprement : monolithe de 12 Mo sauvegardé sous
`-avant-eclatement`, huit fichiers par projet créés, et la session en cours écrivait déjà son
seul fichier (`projet-orgaia.json`, horodatages vérifiés). Le site d'écriture restant (la
suppression de projet) n'a pas eu l'occasion de ressusciter le monolithe — chance, pas
garantie : il a été converti dans l'heure. La migration idempotente a fait exactement ce pour
quoi elle était conçue.

Un débord d'extraction a été ANNULÉ en cours de route : sortir la persistance du Chat de
`ChatPage.tsx` tirait un sous-graphe de types trop profond pour un correctif de cliquet, et
chaque état intermédiaire cassé était servi à l'application en marche. Retour au fichier
commité, ré-application des seules modifications fonctionnelles, cliquet payé en compactant —
2 629/2 631 et 2 896/2 896. L'extraction de cette persistance reste une bonne idée : pour un
jour où l'application est fermée.


### T-060 — Le refus d'une seconde session de dev était invisible depuis l'icône

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Constat utilisateur : « on ne peut plus lancer plusieurs instances ». Instruit en direct, et
la cause est un garde-fou LÉGITIME devenu muet par son canal de lancement :

1. **Le refus est volontaire, et c'est T-028** (2026-08-11) : relancer `dev.sh` pendant
   qu'une session écoute le port 1420 produisait une fenêtre morte-née — l'interface s'affiche
   (servie par le Vite de l'AUTRE session), mais `tauri dev` avorte et tue le sidecar de la
   première au passage. Depuis T-028, `dev.sh` refuse et explique sur stderr.
2. **Mais l'icône du bureau lance `dev.sh` avec stderr redirigé vers un fichier**
   (`Exec=bash -c ".../dev.sh >>/tmp/iaction.log 2>&1"`). Un clic sur l'icône pendant qu'une
   session tourne = rien à l'écran, l'explication dans un log que personne ne lit. Un refus
   juste, exécuté en silence : l'échec muet DE FAIT, la seule chose que la doctrine interdit.
3. Erreur de la première rédaction de ce ticket, corrigée : « deux instances ont tourné
   ensemble à 15:22Z et 15:26Z » était FAUX — c'était un redémarrage de `tauri dev` (la
   session parallèle a modifié `src-tauri/` à 15:25, `tauri dev` recompile et relance). Le
   multi-instance réel dev + version installée n'a pas été observé aujourd'hui.

**Corrigé** : la garde de `dev.sh` envoie désormais une **notification de bureau**
(`notify-send`, seulement si un affichage est présent) en plus du message stderr. Vérifié en
direct : garde déclenchée, exit 1, notification affichée. Le garde-fou reste exactement le
même — il est juste devenu visible là où on clique.

**Suite le jour même** : l'utilisateur a réagi — le mono-instance n'a jamais été son souhait,
et travailler sur deux projets en même temps est un besoin réel. Le sujet a changé de nature :
ce n'est plus un correctif, c'est un choix de produit. Il est instruit dans
[etude-deux-projets.md](etude-deux-projets.md) — inventaire mesuré des blocants (collision des
ids de requête, `project-conversations.json` monolithique de 12 Mo réécrit en entier), trois
voies chiffrées, recommandation en deux lots (éclater l'état par projet, puis deux fenêtres
sur un seul processus). Les tickets viendront quand l'utilisateur aura tranché les décisions
ouvertes de l'étude.

### T-055 — Importer le journal hors webview faisait échouer la chaîne, tests verts

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Constaté le 2026-08-15 par la session qui instrumente T-048, en ajoutant un simple `logUi`
dans un module feuille : `sidecar.ts` exécutait `setupListeners()` **au chargement du
module** — donc `listen()` de Tauri, donc `window`, absent sous Node. Tout test unitaire qui
importait `./journal` tirait la chaîne et produisait `ReferenceError: window is not defined`
en **rejet non géré** : les 390 tests passaient, la chaîne sortait en échec, et le message ne
désignait pas la cause. Le pire des trois mondes — un échec qui n'est ni muet, ni attribuable.

Le défaut n'était pas l'import : c'est qu'un module d'IPC **s'installait par effet de bord
d'import**. Hors webview, il n'y a rien à écouter, et un module doit rester importable par un
test sans rien déclencher.

**Corrigé** dans [sidecar.ts](../ui/src/sidecar.ts) : les écouteurs ne s'installent que si
`window` existe (`typeof window === "undefined" ? Promise.resolve() : setupListeners()`).
Le fichier étant à l'exact de sa dérogation de cliquet, les lignes du correctif ont été payées
en compactant un commentaire — le budget ne se relâche pas pour trois lignes.

Test de non-régression ([journalImportable.test.ts](../ui/src/journalImportable.test.ts)) :
importer la chaîne `journal → sidecar` sous Node en capturant les `unhandledRejection` — la
liste doit rester vide. C'est le rejet qu'on verrouille, pas le résultat des tests, puisque
c'est lui qui échappait au compte.

Constat et correctif à deux sessions : l'une a trouvé et diagnostiqué (les deux sens vérifiés
— sans l'import zéro erreur, avec l'import une erreur quel que soit le fichier déclencheur),
l'autre a corrigé dans sa zone. Le partage par zone a tenu.

### T-054 — La protection de branche promise par le script de publication n'existait pas

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Constaté le 2026-08-15 en répondant à la question « tous les outils de qualité GitHub
sont-ils activés ? ». L'en-tête de `scripts/publier-instantane.sh` affirme : « La protection
de branche (docs/github.md) rend ce détour [la PR] obligatoire ». Vérification par l'API :
`GET /branches/main/protection` → **404 Branch not protected**, et aucun ruleset. Le portique
à deux plateformes était donc **volontaire** — un `git push` direct sur `main` l'aurait
contourné sans un mot, et le commentaire du script était un vœu de plus qui se prenait pour
un invariant (même famille que le « identique aux défauts du sidecar » de T-047).

La case de la checklist `docs/github.md` §7 n'avait simplement jamais été cochée — les checks
`construire (…)` n'apparaissent dans la liste de GitHub qu'après un premier run sur PR, ce qui
explique probablement l'oubli initial.

**Corrigé dans la foulée** (`gh api PUT /branches/main/protection`), à l'exact de ce que la
checklist prescrit : PR obligatoire, 0 approbation (le portique est la CI, pas une revue à
deux — il n'y a qu'un mainteneur), et les deux checks `construire (ubuntu-latest…)` et
`construire (windows-latest…)` requis. `enforce_admins` reste désactivé : le mainteneur garde
une porte de secours, assumée.

Relevé complet du même passage, pour mémoire — tout le reste était conforme à la doctrine
de `docs/github.md` §7 : alertes Dependabot **actives**, security updates **désactivées**
(voulu : pas de PR de bot sur un dépôt-miroir), secret scanning + push protection **actifs**,
code scanning « default setup » **non configuré** (voulu : `codeql.yml` fait foi, et le
workflow CodeQL est actif), les trois workflows Version/Tickets/CodeQL **actifs**.

### T-052 — Les tours Claude tournent sans instruction système, et personne ne l'a décidé

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Trouvé le 2026-08-15 en instruisant [T-019](#t-019--les-questions-interactives-ne-sont-plus-sollicitées),
dans le SDK réellement installé (`@anthropic-ai/claude-agent-sdk` 0.3.214, `sdk.mjs`) :

```js
if (i === undefined) f = "";            // systemPrompt absent  → prompt système VIDE
else if (typeof i === "string") f = i;  // chaîne              → REMPLACE le preset
else if (i.type === "preset") { … }     // preset              → prompt Claude Code + append
```

Deux conséquences, aucune décidée :

1. **Un tour sans agent sélectionné part avec un prompt système vide.** Pas le prompt de
   Claude Code, pas un prompt réduit : rien. C'est le cas de la majorité des tours du Chat et
   des tours de projet sans agent.
2. **Un agent avec instructions REMPLACE** le prompt de Claude Code au lieu de s'y ajouter.
   Ce qui est peut-être voulu — mais nulle part écrit.

Le SDK **agent** diffère ici du SDK Claude Code historique, où le preset était le défaut. Le
passage de l'un à l'autre a donc changé le comportement en silence, et rien dans le dépôt n'en
parle.

Pourquoi P2 et pas P1 : l'application marche, les outils sont déclarés par l'API quoi qu'il
arrive, et beaucoup de tours n'ont besoin de rien de plus. Mais « le modèle reçoit-il des
instructions ? » ne devrait pas être une question à laquelle on répond en lisant le bundle
minifié d'une dépendance.

À faire — et c'est un ARBITRAGE, pas un correctif évident :

- mesurer d'abord : un tour identique avec et sans `{type:"preset", preset:"claude_code"}`,
  sur une tâche outillée, pour voir ce que le preset change réellement ici ;
- puis décider explicitement, et l'écrire dans `docs/protocol.md` : preset + `append` (le
  modèle hérite des conventions de Claude Code), ou prompt propre à IAction (on assume de
  tout dire soi-même). Le pire état est celui d'aujourd'hui : ni l'un ni l'autre, par défaut
  d'une dépendance.
- garder à l'esprit T-019 : l'annonce de l'outil de question devra suivre le choix retenu.

**Tranché et livré le 2026-08-15**, sur décision de l'utilisateur.

| Tour | Ce qui part maintenant |
|---|---|
| **Projet** (outils intégrés armés) | `{type: "preset", preset: "claude_code", append}` |
| **Chat pur** (`tools: []`) | inchangé — la chaîne de l'appelant, ou rien |

Le raisonnement tient en une phrase : les outils intégrés de Claude Code
(Read/Write/Edit/Bash/Grep) ont été conçus pour être pilotés par ce prompt-là. Les servir sans
lui était l'anomalie, pas l'inverse. Le chat pur, lui, n'a aucun outil : lui imposer un prompt
de copilote de code serait le défaut symétrique.

Second effet, aussi important que le premier : **l'instruction d'un agent s'AJOUTE désormais au
preset au lieu de l'effacer**. Un agent « relecteur méticuleux » conservait jusqu'ici les outils
de Claude Code… en ayant supprimé les instructions qui les décrivent.

**Ce choix est raisonné, pas mesuré, et il faut le dire.** Le ticket réclamait une mesure
préalable ; elle suppose des tours réels sur des tâches outillées, donc de la dépense
d'abonnement, et l'arbitrage a été rendu sans elle. Deux garde-fous en tiennent lieu : le retour
arrière tient en un booléen (`composerInstructionSysteme`), et quatre cas de test verrouillent
les deux régimes — dont « le preset n'est jamais remplacé par l'instruction de l'agent ». Si le
preset se révélait nuisible sur des tours réels, ce sera un ticket de plus, avec sa trace — pas
une découverte dans le bundle minifié d'une dépendance.

### T-012 — 24 alertes Dependabot, dont cinq dépendances livrées

**Type** tech · **Prio** P1 · **Statut** fait · **Créé** 2026-08-09 · **Clos** 2026-08-15

**Fait le 2026-08-15, application FERMÉE** (la condition que le ticket posait : `npm install`
perturbe le vite en cours).

**Racine : 12 vulnérabilités → 5.** Les quatre paquets que le ticket avait identifiés comme
**réellement livrés** sont tous montés :

| Paquet | Avant → après |
|---|---|
| `ip-address` (SSRF) | 10.2.0 → 10.5.0 |
| `fast-uri` | 3.1.3 → 3.1.5 |
| `hono` | 4.12.30 → 4.13.2 |
| `@hono/node-server` | 1.19.14 → 1.19.17 |

S'y ajoutent `nanoid`, `postcss` et `tar`, qui ne partent pas dans le produit (outil de
construction, pile de voix) mais ne coûtaient rien à monter.

**`tools/mcp-imap` : 4 → 0.** Les quatre PR Dependabot ouvertes sur le dépôt public restent à
**fermer**, pas à fusionner : l'instantané remplace l'arbre entier, une PR fusionnée sur `main`
serait silencieusement annulée à la publication suivante (`docs/github.md` §4).

**Les 5 qui restent sont exactement la pile de voix locale** — `sharp`, `adm-zip`,
`onnxruntime-node`, `@huggingface/transformers`, `kokoro-js` — c'est-à-dire ce que le ticket
avait déjà classé « ne part pas » : ces modules sont EXCLUS du bundle
(`scripts/preparer-bundle.sh`), l'application les charge par `import()` dynamique et fonctionne
sans eux. Elles ne concernent que le poste de développement et l'utilisateur qui installe la
voix locale à la main. Aucune n'a de correctif amont disponible.

**La dépendance Rust `glib` (1 moyenne) n'est pas corrigeable de notre côté** : la 0.18.5 est
tirée transitivement par `gtk 0.18` ← `muda` ← `tauri 2.11.5`, et l'avis est réglé en 0.19,
qui suppose une montée de Tauri. `cargo update -p glib` ne trouve rien de compatible. Même
famille que les paquets transitifs sous le SDK Claude : la correction dépend de la montée de
l'amont, pas d'un forçage local — et forcer une résolution désalignerait la coquille de ce que
Tauri a testé.

Chaîne de vérification complète repassée au vert avec les nouvelles versions avant commit.


> **Correction du 2026-08-09** (`gh` installé, alertes lues par l'API au lieu
> d'être devinées) : la première rédaction de ce ticket concluait « une seule
> dépendance vulnérable part réellement dans le produit ». **C'était faux** —
> je n'avais dépouillé que les paquets cités par `npm audit` en tête de
> sortie. Le décompte exact figure ci-dessous ; la conclusion rassurante ne
> tenait qu'à un examen partiel. Leçon : ne pas conclure d'un échantillon
> quand l'inventaire complet est interrogeable.

**Décompte réel** (`gh api /repos/…/dependabot/alerts`, 24 ouvertes) :

| Manifeste | Alertes | Livré ? |
|---|---|---|
| `package-lock.json` (racine) | 5 hautes, 8 moyennes, 1 basse | partiellement |
| `src-tauri/Cargo.lock` | 1 moyenne (`glib`) | **oui** — la coquille Linux |
| `tools/mcp-imap/package-lock.json` | 2 hautes, 6 moyennes, 1 basse | non (outil hors app) |

**Ce qui part réellement chez l'utilisateur** — vérifié fichier par fichier
dans `build/sidecar-bundle/node_modules` :

- `ip-address` (1 haute + 2 moyennes, SSRF) — SDK Claude → SDK MCP → `express-rate-limit` ;
- `fast-uri` (2 hautes) — SDK Claude → SDK MCP → `ajv` ;
- `hono` (3 moyennes + 1 basse) et `@hono/node-server` (1 moyenne) — même chaîne ;
- `glib` (1 moyenne) — dépendance Rust de la coquille, donc du binaire lui-même.

**Ce qui ne part pas** : `sharp`, `tar`, `adm-zip` (pile de voix locale, EXCLUE
du bundle — `scripts/preparer-bundle.sh`), `postcss` (vite, construction
seule), et tout `tools/mcp-imap` (outil MCP de courriel, hors application).

La plupart des paquets livrés sont **transitifs sous le SDK Claude** : la
correction dépend de la montée du SDK, pas d'un `npm audit fix` local. À
qualifier au cas par cas, et à ne pas forcer par des `overrides` qui
désaligneraient le SDK de ce qu'il a testé.

Constaté le 2026-08-09 en publiant l'instantané : GitHub annonce « 23
vulnerabilities (7 high, 14 moderate, 2 low) » sur la branche par défaut.
Dépouillement local (`npm audit`, `npm ls`) — le chiffre brut est trompeur,
trois familles très inégales :

- **`sharp`, `tar` (7 hautes)** — tirées par `@huggingface/transformers` et
  `kokoro-js`, c'est-à-dire la pile de **voix locale**, explicitement EXCLUE
  du bundle livré (`EXCLUES` dans `scripts/preparer-bundle.sh`, voir
  `docs/empaquetage.md` §2). Vérifié : `build/sidecar-bundle/node_modules` ne
  les contient pas. Elles ne concernent que le poste de développement — et
  l'utilisateur qui installe la voix locale à la main.
- **`nanoid`, `postcss`** — dépendances de `vite`, donc outil de construction
  seulement, absentes du produit.
- **`ip-address` (3 avis SSRF, modérés)** — la SEULE présente dans le bundle
  livré. Chaîne : `@anthropic-ai/claude-agent-sdk` →
  `@modelcontextprotocol/sdk` → `express-rate-limit` → `ip-address@10.2.0`.
  Exploitabilité à qualifier : ce limiteur ne sert que si un serveur MCP HTTP
  écoute, ce qui n'est pas le mode nominal — mais la correction est triviale.

**Second manifeste, découvert dans la foulée** : `tools/mcp-imap` a son propre
`package-lock.json` (outil MCP de courriel, hors bundle de l'application).
Dependabot y avait déjà ouvert **quatre PR** — `ip-address` 10.4.0, `fast-uri`,
`hono`, `@hono/node-server` + SDK MCP. Elles sont à **fermer**, pas à
fusionner : l'instantané remplace l'arbre entier, donc une PR fusionnée sur
`main` serait silencieusement annulée à la publication suivante (voir
`docs/github.md` §4). Les mêmes montées se font ici.

À faire, **application fermée** (`npm install` perturbe le vite en cours) :
`npm audit fix` à la racine (monte `ip-address`, 10.4.0 satisfait le `^10.2.0`
demandé) **et** dans `tools/mcp-imap`, puis `npm run verif` et instantané. Les
autres attendent leurs amonts ; ne pas forcer de résolution sur une pile qu'on
ne livre pas.

Décision de fond consignée : les **PR automatiques de Dependabot restent
désactivées** (elles modifieraient le dépôt public, qui n'est pas la source de
vérité) — les alertes seules sont voulues, et ce ticket est la façon dont
elles entrent dans le backlog. Voir `docs/github.md` §4.

### T-045 — La traversée de proxy n'est ni configurable, ni documentée

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-15

**Corrigé le 2026-08-15 — les trois trous, dont un par l'aveu.**

**Trou 2, le plus bête et le plus coûteux : il n'y avait aucun endroit où saisir un proxy.**
Encart **Configuration → Réseau** : proxy, hôtes en direct, autorité de certification, et
lecture du magasin du système. La coquille les pose sur l'environnement du sidecar au moment
de le lancer (`src-tauri/src/reseau.rs`) — c'est là que ça doit se faire, `--use-env-proxy`
étant lu par Node au démarrage du process et non à chaque requête. « Enregistrer et relancer
le moteur » est donc le geste complet, et l'encart le dit plutôt que de laisser croire à un
effet immédiat.

**Trou 3 : le certificat d'inspection TLS.** `NODE_EXTRA_CA_CERTS` (fichier PEM) et
`--use-system-ca` sont posés depuis l'encart. Le poste qui tombera sur
`SELF_SIGNED_CERT_IN_CHAIN` a désormais où répondre.

**Trou 1, le PAC : non corrigé, et DIT.** Nous n'interprétons pas `AutoConfigURL`. Un poste
qui n'a que ça doit saisir son proxy à la main — c'est écrit dans l'encart et dans
`docs/empaquetage.md`. Prétendre le contraire aurait été pire que le trou lui-même : un
utilisateur qui croit le PAC lu ne cherchera pas pourquoi rien ne passe.

L'invariant tenu de bout en bout, et testé des deux côtés : **rien de saisi = rien de changé**.
Une clé `reseau` absente, vide, ou d'un mauvais type laisse l'environnement du moteur
identique à l'octet près (6 tests Rust, 10 tests d'interface, plus deux tests de coquille sur
la position des drapeaux — Node ne traite ses options qu'AVANT le nom du script, une option
placée après serait ignorée en silence, exactement le piège de T-043).

Effet de bord du cliquet, et il avait raison : les 240 lignes du tableau des raccourcis
clavier sortent de `ProvidersPage.tsx` (3 207 → 2 996 lignes) dans
[raccourcisClavier.ts](../ui/src/raccourcisClavier.ts). C'est de la documentation pure au
milieu d'un fichier qui fait tourner fournisseurs, modèles, voix et applications ; elle n'avait
aucune raison d'y vivre, et c'est le refus de l'encart « Réseau » qui a posé la question.


**Type** tech · **Prio** P2 · **Statut** ouvert · **Créé** 2026-08-13

[T-043](#t-043--tous-les-fournisseurs-en--erreur-réseau--sur-un-poste-dentreprise) a réparé le
cas courant — un proxy déclaré dans l'environnement — d'une ligne. Il laisse trois trous, et
les nommer vaut mieux que de croire le sujet clos :

1. **Le PAC est ignoré.** Le poste concerné déclare aussi un `AutoConfigURL` dans le registre. `--use-env-proxy` ne lit que les variables ; un poste qui
   n'aurait QUE le PAC resterait en panne, avec le même message pour l'utilisateur.
2. **Aucun réglage dans l'application.** Si les variables ne sont pas posées pour la session
   graphique — cas fréquent sous Windows, où elles vivent souvent dans le profil du terminal —
   l'utilisateur n'a aucun endroit où saisir son proxy. Il faut passer par `setx`, ce qu'aucune
   documentation ne dit.
3. **Le certificat d'inspection TLS n'est pas traité.** Ce poste-ci coupe avant le handshake,
   donc la question ne s'est pas posée. Le poste suivant, derrière un proxy MITM, tombera sur
   `SELF_SIGNED_CERT_IN_CHAIN` — Node n'utilise pas le magasin de certificats de Windows.
   Le remède existe (`--use-system-ca`, `NODE_EXTRA_CA_CERTS`), il n'est pas posé.

À faire : un encart « Réseau » dans la configuration (proxy explicite, autorité
supplémentaire), et une section dans `docs/empaquetage.md` sur l'usage en entreprise. Tant que
ce n'est pas fait, l'application est **utilisable au bureau par accident**, pas par
conception.

### T-023 — Isoler la plomberie spécifique à un fournisseur

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-15

**R8-A était déjà livré** (`catalogUrl`, `catalogShape`, `usageTrustworthy`, `bodyExtras`, le
profil traversant les couches, le préréglage Swiftask), et avait fermé T-021 et T-022.
**R8-B est livré le 2026-08-15**, avec la retenue que le ticket lui-même prescrivait.

**La devinette nommée dans le ticket a disparu du chemin nominal.** `usageStats.ts` déduisait
la gratuité d'un fournisseur par sous-chaîne de son identifiant — « la ligne la plus parlante »,
disait le ticket. C'est désormais un trait `billing: "free" | "paid"`, déclaré, et inscrit sur
l'événement d'usage **au moment du tour** : la facturation est un fait du fournisseur, et la
relire plus tard verrait une configuration qui a pu changer.

La devinette n'est pas SUPPRIMÉE, et c'est délibéré : sans trait, le comportement reste celui
d'avant à l'octet près (discipline R0). La retirer d'un coup ferait basculer en « payant » tout
fournisseur pas encore déclaré, et fausserait l'historique. Elle disparaîtra quand les profils
seront déclarés — pas avant, et le commentaire du code le dit à celui qui passera après.

**Une méthode du protocole perd son nom de marque.** `usage.openrouter` devient
**`usage.credits`**, et le chemin de la jauge devient le trait `creditsPath` (défaut `credits`).
`usage.openrouter` **reste accepté comme alias** : renommer une méthode ne doit pas casser une
interface qui tourne, et le test de protocole exerce volontairement les DEUX noms — le nouveau
sur le chemin nominal, l'ancien sur le cas d'erreur. L'ancien nom partira quand plus rien ne
l'appellera.

S'y ajoute `coutRemonte` (T-036) : « ce fournisseur ne remonte jamais de coût », déclaré au lieu
d'être compté comme une mesure manquante.

**Ce qui reste hors périmètre, et le ticket le disait déjà** : `nativeApi` (les trois méthodes
`ollama.*` gardent leur nom — le code marche et ne gêne personne tant qu'il n'y a qu'un cas ;
T-007 a montré au passage que la SONDE, elle, mérite d'être déclarée un jour) et la cible de
débord de `debord.ts`, qui relève de R3. Le compte des « quinze sites » n'est donc pas tombé à
zéro : il est tombé sur les deux familles que le ticket avait explicitement mises de côté.


Constat de structure, posé le 2026-08-10 en cherchant où brancher T-021.
L'hypothèse fondatrice du moteur neutre — « un fournisseur, c'est une `baseUrl`
compatible OpenAI et une clé » — a déjà cédé **quinze fois**, sans qu'aucun
endroit ne le déclare :

| Où | Spécificité codée en dur |
|---|---|
| [engine.ts](../sidecar/src/engine.ts) ~735-830 | `ollamaNativeBase()` + API native `/api/ps`, `/api/generate` |
| [engine.ts](../sidecar/src/engine.ts) ~651-680 | `GET /credits` — solde, propre à OpenRouter |
| [engine.ts](../sidecar/src/engine.ts) ~467-475 | corps R0 : `models`, `provider.sort`, `usage.include` |
| [usageStats.ts](../sidecar/src/usageStats.ts) ~51 | « ce fournisseur est-il gratuit ? » deviné par `id.includes("ollama")` |
| [debord.ts](../sidecar/src/debord.ts) ~34 | cible de débord `openrouter · deepseek-chat` |
| [router.ts](../sidecar/src/router.ts) ~90, ~103 | classificateur et embeddings sur `ollama` |
| [routerAdmin.ts](../ui/src/routerAdmin.ts) ~55-65 | les mêmes valeurs, redéclarées côté interface |
| [App.tsx](../ui/src/App.tsx) ~304 | `usageOpenrouter("openrouter")` — id littéral |
| [providerAdmin.ts](../ui/src/providerAdmin.ts) ~30-44 | en-têtes `HTTP-Referer` / `X-Title` d'OpenRouter |
| [ProvidersPage.tsx](../ui/src/ProvidersPage.tsx) ~85, ~1993-2014 | `OPENROUTER_PROVIDER_ID`, préréglages `openrouter`/`groq` |
| [protocol.md](protocol.md) | **4 méthodes portent un nom de fournisseur** : `usage.openrouter`, `ollama.ps`, `ollama.load`, `ollama.unload` |

La ligne la plus parlante est `usageStats.ts` : la gratuité d'un fournisseur y
est **devinée par sous-chaîne de son identifiant**. Un fournisseur local nommé
autrement est facturé à tort ; un fournisseur payant contenant « local » est
compté gratuit. C'est le symptôme, pas la cause : faute d'endroit où déclarer
un trait, chaque besoin s'est résolu par un `if` là où il tombait.

**Direction proposée — spec R8, « profils de fournisseur ».** La spécificité
devient une **donnée portée par le fournisseur**, pas une branche de code,
selon la discipline déjà écrite en R0 (*champ absent → comportement
d'aujourd'hui, à l'octet près*) :

```ts
interface ProviderTraits {
  catalogUrl?: string;              // T-021 — remplace GET {baseUrl}/models
  catalogShape?: "openai" | "slugs";// {data:[{id}]} vs [{slug,name}]
  creditsPath?: string;             // "credits" — absent : pas de jauge de solde
  nativeApi?: "ollama";             // ps / load / unload
  usageTrustworthy?: boolean;       // T-022 — false : les zéros valent null
  billing?: "free" | "paid";        // remplace la devinette sur l'id
  bodyExtras?: Record<string, unknown>; // ex. {stateless: true} chez Swiftask
  noReasoningEffort?: boolean;      // passerelle qui rejette le champ en 400
}
```

Les deux derniers champs sortent de l'observation du client officiel de
Swiftask le 2026-08-10 : il envoie `stateless: true` (champ non standard) et a
**désactivé `reasoning_effort` en commentaire** — « HTTP 400 reasoning_effort
is not allowed ». Deux quirks qu'aucun `if (providerId === …)` ne doit porter,
et la démonstration que la liste des traits ne se devine pas à l'avance : elle
doit être *ouverte*, d'où `bodyExtras` en dictionnaire libre plutôt qu'un
énième booléen nommé.

Le champ voyage comme les trois réglages R0 : config non-secrète →
`pushProviders` → `providers.set` → `Provider` du sidecar. **Le sidecar ne
porte donc aucune table de fournisseurs** — il lit ce qu'on lui pousse, et
reste ignorant des marques. La table des profils connus (Swiftask, OpenRouter,
Ollama, « OpenAI strict ») vit côté interface, à côté de `DEFAULT_PROVIDERS`,
comme simple **aide de saisie** du formulaire — même patron que les
préréglages STT/TTS déjà en place. Une seule déclaration a un consommateur à
l'exécution : pas de cinquième vérité à faire diverger (cf. 0.3.0).

Périmètre et coût estimés — à découper en deux, la première moitié seule
débloque Swiftask :

- **R8-A (¼ lot)** : `catalogUrl` + `catalogShape` + `usageTrustworthy`, le
  profil traversant les couches, préréglage Swiftask, tests de protocole.
  Ferme T-021 et T-022.
- **R8-B (¼ lot)** : `creditsPath` et `billing` — c'est-à-dire dé-nommer
  `usage.openrouter` et retirer la devinette d'`usageStats`. Touche le
  protocole, donc à faire seul et documenté.

Restent volontairement hors périmètre : `nativeApi` (le code Ollama existant
marche et ne gêne personne tant qu'il n'y a qu'un cas) et la cible de débord de
`debord.ts`, qui relève de R3.

### T-036 — Des tours payants ne remontent aucun coût

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-15

**Instruit le 2026-08-15 — les deux questions du ticket ont une réponse, et ce ne sont pas
les mêmes.**

**1. Swiftask est structurellement muet, et l'option `usageAccounting` n'y peut rien.** Le
`costUsd` de nos événements vient de `usage.cost` ; `usageAccounting` pose `usage.include`.
Ces deux champs sont des **extensions OpenRouter**, pas du dialecte OpenAI. Un fournisseur
qui ne les implémente pas ne les servira jamais, quelle que soit la case cochée. Cocher la
comptabilité d'usage sur Swiftask n'aurait donc rien changé — et c'était précisément la
question du ticket.

**2. La recherche web n'a rien à facturer, et son absence de `events.jsonl` est correcte.**
R9 interroge un **SearXNG auto-hébergé** en HTTP simple : aucun appel de modèle, aucune API
payante, donc aucun événement d'usage à écrire. Son coût réel existe, mais il est **indirect
et déjà compté** : les sources injectées gonflent le prompt du tour qui suit, et ce tour-là
porte sa propre consommation. Il n'y a donc pas de trou ici — il y avait une attente fausse.

**Corrigé** : le trait `coutRemonte: false` (déclaré sur le préréglage Swiftask) inscrit
`coutIndisponible: true` sur les événements concernés, au moment du tour — c'est un fait du
FOURNISSEUR, et le relire plus tard verrait une configuration qui a pu changer. La carte
« Dépense de la période » distingue désormais deux minorants qui n'appellent pas la même
chose :

- « N tours sans coût remonté » — le fournisseur pourrait, et ne l'a pas fait : **il y a une
  comptabilité d'usage à cocher** ;
- « N tours chez un fournisseur qui n'en remonte jamais » — **rien à chercher**.

Les confondre, c'était envoyer l'utilisateur chercher un réglage qui n'existe pas. Quatre cas
de test sur le libellé, dont celui où les deux coexistent.

Reste vrai, et assumé : la dépense Swiftask demeure inconnue. Aucun correctif de notre côté ne
la fera apparaître — seul le fournisseur le peut. Ce que le ticket demandait était de le DIRE
plutôt que de compter zéro ; c'est fait.


**Type** bug · **Prio** P3 · **Statut** ouvert · **Créé** 2026-08-13

Relevé en instruisant [T-035](#t-035--la-dépense-réelle-nétait-affichée-nulle-part), sur
`usage/events.jsonl` du poste, mois d'août 2026 :

| moteur / fournisseur | tours | `costUsd` cumulé |
|---|---|---|
| claude (abonnement)  | 546 | 0 (normal : coût nul) |
| neutral / openrouter |  16 | 2,4327 $ |
| neutral / ollama     |  11 | 0 (normal : local) |
| neutral / swiftask   |   7 | **0, alors que le fournisseur est payant** |

Les 7 tours Swiftask ne portent pas de `costUsd`. Depuis T-035 la carte « Dépense de la
période » le signale (« au moins — N tours payants sans coût remonté ») plutôt que de laisser
lire un total faux, mais le trou reste : on ne sait pas ce que ces tours ont coûté.

À instruire : le fournisseur ne renvoie-t-il pas d'usage, ou bien l'option `usageAccounting`
n'est-elle pas cochée sur son profil ? Même question pour la recherche web, dont les appels
n'apparaissent pas du tout dans `events.jsonl`. Si le fournisseur est structurellement muet, le
dire dans son profil vaut mieux que de compter zéro.

### T-053 — Le verrou du runner déclarait mort tout détenteur, hors de Linux

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Constaté le 2026-08-15 sur le portique de la 0.3.3 : la PR publique est rouge sur **Windows**,
verte sur Linux. `runner.test.js` échoue sur une seule assertion — « le processus courant doit
être vu vivant ».

La cause est dans le correctif de [T-050](#t-050--un-verrou-survivait-à-son-détenteur-et-gelait-toutes-les-synchros),
écrit le matin même : `detenteurVivant()` teste `/proc/<pid>`. **Il n'y a pas de `/proc` sous
Windows** — donc un détenteur bien vivant y est déclaré mort, et son verrou volé. Le choix de
`/proc` était pourtant motivé et reste bon sur Linux : lui seul distingue « mort » de « vivant
mais appartenant à un autre utilisateur » (EPERM), ce qui compte dans un conteneur où le
planificateur et les runs partagent l'espace de PID.

Ce que ce ticket corrige n'est donc pas le choix, c'est son **absence de repli**. Le runner ne
tourne que dans un conteneur Linux, et on aurait pu se contenter de garder le test par
plateforme — c'est-à-dire faire taire le messager. Une fonction qui répond faux hors de son
habitat est un piège en attente, pas une limite acceptable : `/proc` d'abord, `process.kill(pid, 0)`
en repli, EPERM traité comme vivant. La prudence d'origine est préservée de bout en bout — ce
qu'on ne sait pas trancher est réputé vivant.

Troisième fois que la CI Windows attrape ce que le poste Linux ne peut pas voir (T-014, T-037,
puis ici) — et la première où c'est le CODE, pas le test, qui décrivait la machine qui l'exécute.

### T-025 — Un échec du fournisseur arrive comme une réponse réussie

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-15

**Corrigé le 2026-08-15 par le correctif « non listé » du ticket lui-même** — celui que la
mesure du 2026-08-11 avait fait apparaître, et qui est le seul à viser la cause : quand R9 est
active, les agents `*-with-search` ne sont plus proposés. La recherche est alors faite deux
fois — une fois par nous, avec nos sources citées, une fois par l'agent — et c'est la seconde
qui casse (`gemini-pro-with-search` : 2 échecs sur 6 à requête identique, contre 0 sur 6 pour
le modèle brut).

Les trois autres pistes restent écartées, pour les raisons que le ticket avait déjà établies :
valider les modèles par un appel court ne rattrape pas un modèle qui répond 9 fois sur 10 ; la
consommation à zéro ne distingue pas le tour échoué du tour réussi ; et le discriminant
`total_tokens: 1` est un comportement non documenté qu'on refuse d'inscrire dans le code.

Deux règles de non-perte, testées, parce qu'un filtre qui escamote est un défaut de plus :

1. **Le modèle SÉLECTIONNÉ n'est jamais masqué** — sinon le sélecteur afficherait « — » sur
   une conversation qui tourne. Même règle que pour les variantes (T-032).
2. **L'écart se DIT** : le popover annonce combien d'agents sont masqués et pourquoi. Un
   modèle qui disparaît sans un mot est un mensonge par omission.

La reconnaissance se fait sur l'id (`…-with-search`), faute de mieux : aucun fournisseur
n'expose un trait disant « cet agent cherche ». C'est exactement la devinette que
[T-023](#t-023--isoler-la-plomberie-spécifique-à-un-fournisseur) doit supprimer — en attendant
elle est à UN seul endroit, nommée et testée, au lieu d'être un `if` au fil de l'eau. Quatre
cas de test, dont celui qui compte : le modèle courant survit au filtre.

Ce que ce ticket ne prétend toujours pas régler : `llama31`, muet (≈ 2 caractères de contenu),
qui n'est pas un agent de recherche et reste proposé. Il relève de la validation de catalogue,
donc de T-021/T-023, pas d'ici.


Constaté le 2026-08-10, premier tour Swiftask réel dans le Chat (modèle
`gemini-pro-with-search`). L'écran affiche, dans une bulle d'assistant
normale : *« Sorry, An error occurred. If the problem persists, please contact
us. »* — suivi de `0 + 0 tokens`. Aucun bandeau d'erreur, aucune entrée au
journal : pour l'application, **ce tour a réussi**.

Vu du protocole, en effet, rien ne le distingue d'une réponse légitime :

```
HTTP 200 · finish_reason: "stop" · contenu = le texte d'erreur
usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 1}
```

Le fournisseur encode donc sa panne **dans le corps de la réponse**, pas dans
son statut. Deux modèles sur les huit proposés par le sélecteur sont dans ce
cas — `gemini-pro-with-search` (phrase d'erreur) et `llama31` (contenu
littéralement `""`, encore plus muet) —, les six autres répondent
correctement. Un quart du catalogue offert est mort, et l'app le présente
comme vivant.

**Ce qu'on ne peut pas faire** : détecter la phrase. Filtrer sur un texte
anglais dans une réponse d'assistant condamnerait des réponses légitimes ; ce
serait remplacer un faux positif par un faux négatif.

**Ce qu'on peut faire**, par ordre de solidité :

1. **Écarter les modèles morts du sélecteur** — c'est le vrai correctif, et il
   rejoint T-021 : tant que le catalogue vient d'une liste figée non vérifiée,
   il proposera des entrées non servies. Un « Rafraîchir les modèles » qui
   VALIDE (un appel court par modèle, en tâche de fond, résultat mémorisé)
   coûte peu et rend la liste honnête.
2. **Signaler la consommation nulle** — une réponse non vide facturée
   `0 + 0` est au minimum suspecte. Une fois T-022 en place (zéro → `null`),
   l'affichage dirait « consommation inconnue », ce qui est déjà moins
   trompeur que `0 + 0 tokens`.
3. Le discriminant observé (`total_tokens: 1` sur les tours en échec contre
   ~1200 sur les tours réussis) est **volontairement écarté** : c'est un
   comportement non documenté d'un fournisseur, exactement le genre de
   devinette que T-023 cherche à éliminer, pas à multiplier.

Ce ticket ne dit pas que l'app est fautive : le défaut est chez le
fournisseur. Il est ouvert parce qu'une panne invisible reste une panne
invisible, quelle que soit son origine — et parce que le choix du modèle,
lui, est bien de notre côté.

**Mesure du 2026-08-11 — le modèle n'est PAS mort, il est INTERMITTENT.**
Deux nouvelles occurrences constatées dans le Chat (mêmes conditions :
`swiftask · gemini-pro-with-search`, recherche web R9 activée), dont un
deuxième tour dans une conversation dont le premier avait parfaitement
répondu. Rejeu direct sur l'API, hors application :

| Envoi rejoué | Résultat |
|---|---|
| 10 requêtes **identiques**, message unique, `gemini-pro-with-search` | **1 échec / 10** |
| 10 requêtes identiques, `gemini-3-pro` (modèle brut) | 0 échec / 10 |
| 6 formes de conversation (avec/sans historique, avec/sans bloc web) | échec sur une forme, réussite au rejeu de la même |

L'échec ne dépend donc **ni de l'historique, ni du bloc système injecté par
R9, ni de la taille du corps** : à requête strictement identique, la même
question réussit ou échoue. C'est une panne aléatoire de l'agent Swiftask
`*-with-search` (~10 %), pas un slug non servi.

Balayage des **8 slugs effectivement proposés** par le sélecteur, 6 requêtes
identiques chacun, même jour :

| Slug | Réponses exploitables |
|---|---|
| `deepseek-r1`, `swiftask`, `agentreact`, `mistralmedium`, `deepseek-v3`, `o3-mini` | 6/6 |
| `gemini-pro-with-search` | **4/6** (2 fois la phrase d'erreur) |
| `llama31` | 6/6 en apparence, mais **~2 caractères** de contenu — muet |

Six des huit sont donc sains ; le catalogue offert n'est pas « mort au quart »,
il porte un modèle muet et un modèle instable.

Trois conséquences pour le plan ci-dessus :

- La piste 1 (**valider les modèles par un appel court**) ne rattrape pas ce
  cas : un modèle qui répond 9 fois sur 10 passera la validation, et
  échouera quand même un tour sur dix. Elle reste bonne pour `llama31`
  (mort franc), pas pour celui-ci.
- La piste 2 (**consommation inconnue**, T-022) devient le seul signal
  disponible côté app, et n'en est pas un : le tour échoué et le tour réussi
  annoncent tous deux `0 + 0`.
- Il reste donc un correctif non listé, et c'est le plus simple : **ne pas
  proposer les agents `*-with-search` quand R9 est activée**. La recherche
  est faite deux fois (une fois par nous, une fois par l'agent), et la
  seconde est celle qui casse — voir la spec R9, §Pourquoi une capacité
  locale. Un modèle brut (`gemini-3-pro`) rend le même service, avec nos
  sources citées et sans cet aléa.

### T-019 — Les questions interactives ne sont plus sollicitées

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-09 · **Clos** 2026-08-15

**Fait le 2026-08-15 — les deux étapes que le ticket réclamait, dans l'ordre qu'il fixait.**

**1. Le fait devient lisible.** La ligne « serveurs MCP du tour » nomme désormais les serveurs
avec leur compte d'outils (`studio:1, iaction:3, imap:12`) et surtout porte un champ
`questionInteractive` — vrai ou faux, explicitement. C'était la condition posée par le ticket :
« sans cela le ticket ne peut se fermer que par supposition ». Les 39 noms d'outils ne sont
PAS déversés dans le journal : ce serait illisible, et l'information utile n'y gagnerait rien.

**2. L'outil est annoncé par l'instruction système**, et seulement quand le serveur est
réellement armé (`interactive`) — annoncer dans un tour headless serait un mensonge, et le
modèle poserait une question que personne ne verrait. L'annonce est formulée comme une
capacité assortie d'un critère d'emploi, pas comme un ordre : « tu DOIS utiliser cet outil »
produirait des questions là où le modèle devait décider seul, c'est-à-dire le défaut inverse.
L'instruction de l'agent, quand il y en a une, n'est jamais écrasée — l'annonce s'y ajoute.

**Découverte au passage, plus lourde que le ticket** : en lisant le SDK installé (0.3.214,
`sdk.mjs`) pour savoir comment ajouter proprement au prompt système, on trouve
`if (i === undefined) f = ""` — **sans `systemPrompt`, le SDK agent n'envoie pas le prompt
système de Claude Code : il en envoie un VIDE.** Tous les tours sans agent tournaient donc
sans aucune instruction système. C'est peut-être une cause du défaut constaté ici, et ça
dépasse largement ce ticket : [T-052](#t-052--les-tours-claude-tournent-sans-instruction-système-et-personne-ne-la-décidé).
Le correctif ci-dessus se garde bien de « régler » ça au passage — passer au preset
`claude_code` changerait le comportement de tous les tours, ce que personne n'a décidé.

Ce qui n'est PAS démontré, et le sera au prochain tour interactif réel : que l'outil figure
effectivement dans la palette. Le ticket restait ouvert faute de pouvoir trancher ; il se
ferme parce que la question est désormais **posée au journal**, pas parce qu'on y a répondu.
Si `questionInteractive:false` apparaît, la cause est côté armement du serveur et un nouveau
ticket le dira — avec, cette fois, la ligne qui le prouve.


Constaté le 2026-08-09 à 12h58 : l'agent écrit lui-même « vu que les questions
interactives ne passent pas ici, questionnaire texte » et pose ses questions en
prose. Dernier appel RÉUSSI à `mcp__studio__ask_user` : **2026-08-07 12:48**.
Depuis, plus un seul appel dans `app.jsonl` — pas même en échec. L'outil n'est
donc pas cassé : il n'est plus SOLLICITÉ.

> **Correction de la première rédaction (même jour).** J'avais conclu que la
> cause était l'absence de migration du projet vers `.iaction/`, en me fiant au
> commentaire d'en-tête de `projectDoc.ts` (« uniquement si `.iaction/`
> existe »). **C'était faux** : `projectDir()` (`sidecar/src/appPaths.ts`
> 224-232) retombe sur `.iadadou/` quand `.iaction/` est absent, et la fiche
> est bien déposée. Elle datait du 2026-08-07 non par panne mais parce que le
> dépôt est adressé par CONTENU — réécrit seulement quand le texte change.
> Deuxième fois dans la même session que je conclus d'un examen partiel (voir
> T-012) : lire le code, pas le commentaire qui le décrit.

**Ce qui est établi** :

- l'outil INTÉGRÉ `AskUserQuestion` est délibérément interdit
  (`options.disallowedTools`, `sidecar/src/claude.ts` ~672) — or c'est le seul
  nom que le modèle connaît nativement ;
- son remplaçant `mcp__studio__ask_user` n'est armé que si le tour porte
  `interactive: true` ; la page Projets l'envoie sans condition
  (`ui/src/envoiProjet.ts:231`) ;
- `buildAskUserMcpServer` journalise un `warn` s'il échoue : aucun dans le
  journal, donc le serveur se construit ;
- l'outil n'est documenté au modèle que par la fiche `connaissances/iaction.md`
  — une SOURCE DE RAG, qu'il faut chercher pour lire, pas une instruction
  système qui part à chaque tour.

**Ce qui reste inconnu** : si `mcp__studio__ask_user` figure réellement dans la
palette annoncée au modèle. La ligne `serveurs MCP du tour` compte serveurs et
outils (`connectes:5, outils:39`) mais **ne les nomme pas** : impossible de
trancher a posteriori. C'est le premier correctif — journaliser les noms, ou au
moins la présence du serveur `studio`. Sans cela le ticket ne peut se fermer
que par supposition.

Ensuite, selon la réponse : faire connaître l'outil par l'INSTRUCTION SYSTÈME
du tour (qui part toujours) plutôt que par une fiche qu'il faut chercher —
plus robuste que le RAG pour une capacité aussi structurante.

### T-008 — `usage.openrouter` : « fournisseur inconnu » au démarrage

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-08 · **Clos** 2026-08-15

4 occurrences le 2026-08-08, toutes dans les secondes qui suivent un
lancement : l'encart d'usage interroge `usage.openrouter` AVANT que la
poussée des fournisseurs (providersBus) n'ait atteint le sidecar, qui répond
« fournisseur inconnu: openrouter ». Transitoire et auto-réparé, mais c'est
une erreur journalisée à chaque démarrage pour une simple course. Piste :
l'encart attend le signal « providers poussés » avant sa première requête —
ou le sidecar distingue « pas encore déclaré » (silencieux) d'« inconnu ».

**Corrigé le 2026-08-15** par la première des deux pistes — l'encart attend le signal, plutôt
que le sidecar n'invente une nuance entre « pas encore déclaré » et « inconnu ». La seconde
aurait mis dans le protocole une distinction que seul l'appelant peut faire : lui seul sait
s'il est en train de démarrer.

Le bus « fournisseurs poussés » existait déjà et servait exactement à ça — sa propre
documentation le disait, l'encart d'usage ne s'en servait pas. Mais un abonnement seul
n'aurait pas suffi, et c'est le vrai enseignement du ticket : **un signal n'apprend rien du
passé**. Qui se branche après la poussée n'en verra jamais l'écho, et attendrait un événement
déjà survenu. La correction ajoute donc une mémoire (`providersDejaPousses()`) à côté de
l'abonnement : on interroge l'état, puis on écoute la suite.

Cinq cas de test, dont celui qui aurait manqué : *un abonné tardif ne reçoit pas l'écho du
passé*. C'est la moitié du défaut, et c'est celle qu'un correctif hâtif aurait réintroduite
dans l'autre sens — une requête qui ne part jamais au lieu d'une requête qui part trop tôt.

Deux extractions au passage, imposées par le cliquet de taille sur `App.tsx` et bienvenues :
les ~240 lignes de navigation au clavier (F6, Alt + flèches) sortent dans
[focusZones.ts](../ui/src/focusZones.ts) — elles ne touchent ni à l'état, ni à React —, et la
table des six pages dans [navigation.ts](../ui/src/navigation.ts), pour que la navigation
connaisse les pages sans dépendre du composant racine. `App.tsx` passe de 1 262 à 1 022 lignes.

### T-007 — `ollama.ps` répond 404 avec une page web

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-08 · **Clos** 2026-08-15

24 occurrences dans le journal du seul 2026-08-08 : la requête `ollama.ps`
reçoit un **404 HTML d'une plateforme d'hébergement web** (page Vercel), pas
une réponse Ollama. L'hôte configuré pour ce fournisseur pointe donc vers un
site web, pas vers un serveur Ollama (URL de tunnel expirée ? mauvaise
adresse enregistrée ?) — à distinguer du cas connu « fetch failed »
(conteneur Docker arrêté). Deux choses à corriger :

- diagnostiquer/corriger l'adresse enregistrée du fournisseur concerné ;
- côté journal, TRONQUER le corps HTML et dire la cause probable
  (« la réponse n'est pas un serveur Ollama ») — aujourd'hui chaque
  occurrence colle une page HTML entière dans `app.jsonl`.


> **La prémisse de ce ticket était fausse, et c'est le plus intéressant.** « L'hôte configuré
> pointe vers un site web » supposait une adresse à corriger — tunnel expiré, mauvaise saisie.
> Vérification faite le 2026-08-15 : **aucune adresse enregistrée n'est fautive**
> (`ollama → http://localhost:11434/v1`, plus deux fournisseurs distants légitimes). Le 404
> vient d'ailleurs, et il ne s'est jamais arrêté — 140 occurrences du 2026-08-04 au
> 2026-08-15, la dernière le matin même de la clôture.

**La vraie mécanique** : `OllamaPanel` sonde `ollama.ps` sur le fournisseur **sélectionné,
quel qu'il soit**, toutes les dix secondes, et c'est délibéré — c'est ainsi que l'interface
décide de s'afficher ou non (« ceci est un Ollama » / « ceci n'en est pas un »). Interroger
`/api/ps` sur un fournisseur distant hébergé sur une plateforme web rend donc une page de 404,
et c'est le **fonctionnement nominal**. L'échec n'était pas dans l'adresse : il était dans le
fait de journaliser en `error` une réponse attendue.

Coût réel du défaut, mesuré : 140 lignes `error` en onze jours, deux kilo-octets de balises
chacune, dans le fichier même qu'on ouvre quand quelque chose cloche. C'est l'échec muet par
son autre bout — non pas le silence, mais un bruit assez régulier pour qu'on cesse de le lire.
Une vraie panne d'Ollama serait passée là-dedans sans se distinguer.

**Corrigé, en trois gestes :**

1. **La sonde est déclarée comme telle** (`sonde: true`, [sidecar.ts](../ui/src/sidecar.ts)) :
   son échec descend en `debug`. Rien n'est tu — la ligne existe toujours — mais elle cesse de
   crier au loup. Le signal visible reste le panneau qui ne s'affiche pas ; une vraie panne du
   fournisseur, elle, se dit au premier tour envoyé, avec son propre message.
2. **Une page web reçue au lieu d'une API est résumée, pas recopiée**
   ([base.ts](../sidecar/src/base.ts), `resumerCorpsHttp`) : titre de la page quand il existe —
   « 404: NOT_FOUND » nomme souvent l'hébergeur, donc la nature de la méprise — et taille, qui
   dit que quelque chose a bien répondu. Le reste part. Le correctif vaut pour **tous** les
   points d'appel qui lisent un corps d'erreur, pas seulement `ollama.ps` : un portail de proxy
   qui répond à la place d'une API tombe dans le même cas (voir T-045).
3. **L'erreur nomme le fournisseur.** Le journal montrait un 404 sans dire à quelle adresse ; il
   fallait deviner lequel des trois. C'est ce qui a rendu ce diagnostic-ci plus long qu'il
   n'aurait dû l'être.

Ce qui n'est PAS couvert par un test, et il vaut mieux l'écrire que le laisser croire : le
drapeau `sonde` lui-même. Le tester supposerait de simuler la couche Tauri, machinerie que les
tests d'interface n'ont pas et qui coûterait plus que le risque couvert. La logique de résumé,
elle, l'est (trois cas, dont le JSON qui contient du HTML sans être une page).

Reste hors de portée d'un correctif : que la sonde parle à des fournisseurs qui n'ont rien
d'Ollama est un symptôme de [T-023](#t-023--isoler-la-plomberie-spécifique-à-un-fournisseur) —
avec un trait `nativeApi` porté par le fournisseur, on ne sonderait que ceux qui l'annoncent.

### T-049 — Un HTML cité dans un rapport ne s'ouvre pas dans Firefox

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-08-14 · **Clos** 2026-08-15

Demande utilisateur du 2026-08-14 : qu'une référence de fichier HTML citée dans un rapport ou
une réponse — **local ou distant** — s'ouvre **dans Firefox** au clic.

Trois chemins de code aujourd'hui, trois comportements, aucun ne fait ça :

| Ce qui est cité | Ce qui se passe |
|---|---|
| `rapports/2026-08-14.html` en `code` inline | bouton → `handleFileRef` ([AgentPage.tsx](../ui/src/AgentPage.tsx) ~2079) → **onglet éditeur interne**, source HTML brute |
| `[rapport](https://…/x.html)` (lien Markdown) | `MarkdownLink` ([Markdown.tsx](../ui/src/Markdown.tsx) ~27) → `openExternal(href)` sans commande → **navigateur par défaut du système** (`xdg-open`), pas forcément Firefox |
| `https://…/x.html` en `code` inline | rien : `looksLikeFileRef` exclut explicitement `http(s)://` — texte inerte |

Le registre d'applications existe pourtant déjà (Configuration → Applications, clé `apps`,
`extension → commande`, `findAppForExtension` + `openExternal`, [appsAdmin.ts](../ui/src/appsAdmin.ts))
— mais **`handleFileRef` ne le consulte jamais** : seul [FileTree.tsx](../ui/src/FileTree.tsx)
s'en sert. C'est le manque principal, et il est plus large que le HTML : un fichier ouvert
depuis l'arbre respecte la règle de l'utilisateur, le MÊME fichier cliqué dans la transcription
l'ignore.

À faire, du plus petit au plus discutable :

1. **Router `handleFileRef` par le registre d'apps.** Une fois le chemin résolu (les trois
   branches actuelles : absolu sous `cwd`, `cwd/ref`, recherche par nom de base), interroger
   `findAppForExtension` ; règle trouvée ⇒ `openExternal(path, command)` au lieu de
   `handleOpenFile`. Règle le HTML local, et gratuitement tout ce que l'utilisateur a déclaré
   (pdf, odt, kicad…).
2. **Une règle `html`/`htm` → `firefox`** dans `DEFAULT_APPS`. Attention : les défauts ne sont
   semés qu'au **premier lancement** (clé `apps` absente) et il n'y a **pas de re-seed** — sur
   un poste déjà configuré, la règle est à ajouter à la main dans Configuration → Applications.
   Ne pas « réparer » ça en re-semant : respecter les suppressions de l'utilisateur est un
   invariant écrit.
3. **Le distant.** Le registre est indexé par extension : il ne sait rien d'une URL. Deux
   options — (a) un réglage « navigateur » explicite, utilisé à la fois par `MarkdownLink` et
   par le cas HTML local, repli `xdg-open` si vide ; (b) laisser `xdg-open` et régler le
   navigateur par défaut au niveau du système. (b) ne coûte rien mais ne tient pas la demande
   dès que le défaut du poste n'est pas Firefox — c'est précisément le cas visé ici.
4. *Optionnel, à décider séparément* : rendre cliquable une URL citée en `code` inline
   (assouplir `looksLikeFileRef`). C'est l'affordance, pas l'ouverture — et
   [T-024](#t-024--un-chemin-hors-projet-annonce--introuvable--alors-quil-existe) rappelle
   qu'un bouton incapable d'ouvrir quoi que ce soit ment à l'utilisateur.

Point d'attention à assumer, pas à découvrir : router le `.html` vers le navigateur retire la
possibilité d'ouvrir la SOURCE dans l'éditeur interne **depuis la transcription**. L'arbre de
fichiers garde l'ouverture en éditeur, donc rien n'est perdu — mais c'est un arbitrage, et il
se dit.

**Réalisé le 2026-08-15** — les points 1, 2 et 4 ; le 3 (« le distant ») autrement que prévu.

1. **`handleFileRef` passe par le registre** ([refFichier.ts](../ui/src/refFichier.ts),
   `ouvrirReference`) : règle trouvée ⇒ `openExternal(chemin, commande)`, sinon éditeur interne
   comme avant. Le manque principal est donc comblé, et il l'est pour tout ce que l'utilisateur
   a déclaré — pdf, odt, kicad — pas seulement pour le HTML.
2. **Règle `html`/`htm`/`xhtml` → `firefox`** dans `DEFAULT_APPS`. Le ticket avertissait :
   pas de re-seed, donc **sur ce poste-ci la règle est à ajouter à la main** dans
   Configuration → Applications. Ne pas « réparer » ça en re-semant : respecter les
   suppressions de l'utilisateur reste un invariant.
3. **Le distant** — ni réglage « navigateur » séparé, ni abandon à `xdg-open` : `MarkdownLink`
   interroge le MÊME registre, par l'extension portée par l'URL. Un `https://…/rapport.html`
   part donc dans Firefox, et une URL sans extension retombe sur l'ouvreur du système,
   c'est-à-dire le comportement d'avant. L'option (a) créait une seconde déclaration du même
   choix, à faire diverger un jour (0.3.0, T-047) ; celle-ci n'en crée aucune. Piège écarté au
   passage : le nom est pris sur le dernier segment du CHEMIN, sinon `https://exemple.com`
   livrerait l'extension « com » et déclencherait une règle qui ne le vise pas.
4. **URL en `code` inline** : rendues cliquables, puisqu'elles s'ouvrent maintenant.

Le point d'attention annoncé est bien réel et assumé : un `.html` cliqué dans la transcription
ne s'ouvre plus en SOURCE dans l'éditeur interne. L'arbre de fichiers, lui, garde l'ouverture en
éditeur — rien n'est perdu, mais l'arbitrage se dit.

### T-024 — Un chemin hors projet annonce « introuvable » alors qu'il existe

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-15

Constaté le 2026-08-10 : un tour a rempli un PDF déposé dans `~/Téléchargements` et l'a cité
dans sa réponse. Le chemin, rendu en `code` inline, devient un bouton cliquable
([Markdown.tsx](../ui/src/Markdown.tsx) `looksLikeFileRef`) — mais `handleFileRef`
([AgentPage.tsx](../ui/src/AgentPage.tsx)) n'ouvre que ce qui est sous `cwd` : une référence
commençant par `~` n'est ni absolue (pas de `/` initial) ni résoluble depuis la racine, donc
elle tombe dans la recherche par nom de base et se solde par
« « ~/Téléchargements/… » introuvable dans le projet. »

Deux défauts distincts, aucun bloquant :

1. **Message trompeur** — le fichier existe, il est simplement hors projet. Un `~/…` mérite la
   même notice que le cas absolu (« Fichier hors du projet : … »), pas un « introuvable » qui
   laisse croire à une erreur de l'agent. Détecter le préfixe `~/` avant la branche
   « contient un `/` » suffit.
2. **Lien promis pour rien** — tout `code` inline ressemblant à un chemin devient un bouton,
   y compris quand rien ne pourra s'ouvrir. Piste : n'habiller en bouton que ce qui est
   plausiblement dans le projet (rejeter `~/` et les absolus hors `cwd` côté rendu), pour que
   l'affordance ne mente pas.

Le versant agent est traité : le guide d'intégration déposé dans chaque projet
([projectDoc.ts](../sidecar/src/projectDoc.ts), § « Fichiers produits ou modifiés ») impose
désormais d'écrire le livrable dans le projet, de copier avant d'éditer une source externe, et
de ne jamais citer un chemin hors projet en `code` inline. Ce ticket ne couvre que le versant
app : ne pas mentir sur ce qui est cliquable.

**Corrigé le 2026-08-15**, avec T-049 — les deux ticket décrivaient la même absence de
décision partagée, et les corriger séparément aurait été les recorriger deux fois.

Toute la décision vit désormais dans [refFichier.ts](../ui/src/refFichier.ts) : le rendu et
l'ouverture posent la MÊME question et lisent la même réponse. C'était le fond du défaut — une
heuristique d'affichage au fond de `Markdown.tsx` et cinquante lignes de branches au milieu
d'`AgentPage.tsx`, qui ne se consultaient jamais.

1. **Message trompeur** — `~/…` est classé « hors projet », comme un absolu qui sort de la
   racine, et l'avis le NOMME au lieu de prétendre l'avoir cherché. Le dossier personnel n'est
   volontairement pas développé : l'interface ne le connaît pas, et l'inventer serait une
   devinette de plus.
2. **Lien promis pour rien** — le rendu reçoit maintenant le `cwd`, donc un absolu hors projet
   et un `~/…` restent du `code` inerte. Ils ne mentent plus, faute de promettre.

L'invariant est tenu par un test qui ne dépend d'aucun cas particulier : *tout ce qui est
cliquable se classe en quelque chose d'ouvrable*. Sept autres tests couvrent le parcours
complet, monde extérieur simulé (registre, disque, recherche), là où la logique n'était jusque-là
pas testable du tout — elle vivait dans un composant de 2 900 lignes.

Effet de bord bienvenu : `AgentPage.tsx` passe de 2 926 à 2 895 lignes, sous son budget de
cliquet.

### T-041 — L'empaquetage local ressuscite les fichiers supprimés

**Type** tech · **Prio** P3 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-15

Constaté en corrigeant [T-038](#t-038--lappimage-ne-se-construit-plus-et-léchec-est-muet) :
Tauri met les ressources en scène dans `src-tauri/target/release/sidecar/` (puis
`bundle/appimage_deb/…`) et **n'y supprime jamais ce qui a disparu de la source**. Le CLI
Claude non compressé, retiré du bundle par le correctif, y dormait encore et se recopiait dans
l'AppDir à chaque construction — faisant échouer un build que le correctif venait pourtant de
réparer.

Coût réel : trois constructions lues comme trois échecs différents alors que c'était le même
fichier périmé. La CI n'est pas concernée (machine vierge à chaque run) ; c'est un piège de
poste de développement, du même genre que T-020 — **du code qu'on croit exécuter et qui n'est
pas celui qu'on a écrit**, ici transposé aux ressources.

**Corrigé le 2026-08-15** : `preparer-bundle.sh` purge les deux dossiers de mise en scène
avant tout assemblage, en respectant `CARGO_TARGET_DIR`. Le ticket offrait l'alternative
« documenter la purge » — elle est écartée pour la raison qu'il énonçait lui-même : une
consigne qu'il faut se rappeler n'est pas un garde-fou. `docs/empaquetage.md` la mentionne
quand même, mais comme description de ce que fait le script, pas comme geste à faire.

Le test ([preparer-bundle.test.mjs](../scripts/preparer-bundle.test.mjs), branché dans
`npm run verif` et dans la CI) est **textuel**, et c'est un choix assumé : exercer le script
pour de vrai coûterait une construction complète de l'interface et le téléchargement d'un
runtime Node. Il verrouille ce qui casserait en silence — la purge existe, elle vise les deux
dossiers, et surtout elle s'exécute AVANT l'assemblage. Purger après aurait effacé le travail
du script, et aucun test de présence seule ne l'aurait vu. Même patron que le test de position
du drapeau proxy (T-043).

### T-051 — La suite de tests travaillait dans le vrai dossier de données

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Constaté le 2026-08-15 en passant `npm run verif` avant de livrer la 0.3.3 : `logs.test.js`
échoue — 8 entrées lues là où le test en attend 7. La huitième est « données rapatriées depuis
l'ancien nommage », émise par le sidecar **au démarrage**, que le test ne compte pas.

Le test n'est pas le défaut, il est le témoin. Le harnais impose un `XDG_CONFIG_HOME` jetable
(`harness.mjs`) mais **pas** `XDG_DATA_HOME`. Non défini — le cas normal d'un terminal Linux —
`dataBase()` retombe sur `~/.local/share` ([appPaths.ts](../sidecar/src/appPaths.ts) 109-117),
le vrai. Or `migrerDepuisAncienNom()` tourne à chaque démarrage et **déplace** ce qui reste
sous `net.duvam.ia-studio` vers `net.duvam.iaction`. Autrement dit : lancer la suite de tests
pouvait remuer les données réelles de la machine. Le test rouge est la conséquence bénigne
d'une porte ouverte qui ne l'était pas.

Ce qui a caché le défaut est aussi instructif que le défaut : le terminal de VSCode installé
par **Snap** définit `XDG_DATA_HOME` vers son bac à sable. La suite était donc isolée *par
accident d'environnement*, et verte, sur le poste où on la lance le plus souvent. Vérifié dans
les deux sens avant correction — `node test/logs.test.js` sort en 0 avec la variable, en 1 sans
elle. Même famille que T-014 et T-037 : un test qui décrit la machine qui le lance, pas le
produit.

**Corrigé** dans [harness.mjs](../sidecar/test/harness.mjs) : un `XDG_DATA_HOME` jetable est
imposé au même endroit et pour la même raison que le `XDG_CONFIG_HOME` — avant qu'un seul test
ne démarre un sidecar, donc hérité par tous les spawns. `logs.test.js` passe désormais avec et
sans la variable dans l'environnement.

Dégât constaté sur ce poste : **aucun**. Les six entrées de l'ancien dossier existent des deux
côtés, et la migration ne s'autorise jamais d'écrasement — elle les a comptées en « conflits »
et n'a rien déplacé (horodatages de `~/.local/share/net.duvam.ia-studio` inchangés depuis le
7 août). C'est une chance, pas une garantie : sur un poste où l'ancien dossier contient une
entrée absente du nouveau, un simple `npm test` l'aurait déménagée.

### T-050 — Un verrou survivait à son détenteur et gelait toutes les synchros

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13 à 23 h, sept minutes après l'installation de deux tâches de veille et
trois heures avant qu'elles ne doivent tourner pour la première fois.

Séquence exacte, lue dans les journaux du conteneur :

```
21:01:38  une synchro périodique prend le verrou (pid 20522)
21:01:46  manifestes modifiés : régénération du crontab et relance
21:03:51  synchro périodique reportée — verrou occupé, pid 20522
21:05:51  synchro périodique reportée — verrou occupé, pid 20522
21:07:52  synchro périodique reportée — verrou occupé, pid 20522
```

Le processus 20522 était mort (`/proc/20522` absent) mais son verrou subsistait. Toutes les
synchros suivantes étaient sautées, et les deux veilles planifiées à 02 h 30 et 03 h 15
auraient été « reportées » sans jamais s'exécuter — un échec silencieux à retardement, dont
rien n'aurait signalé la cause au matin.

Cause : `entrypoint.sh` se relance **lui-même** (`exec supercronic`) dès qu'un manifeste
change, ce qui tue les processus en cours. Le commentaire de `prendreVerrou` tablait sur
l'inverse — « le verrou vit dans un dossier VOLATILE (/tmp) : au redémarrage du conteneur il
disparaît de lui-même, puisqu'un éventuel détenteur est mort avec lui ». C'est vrai d'un
redémarrage du **conteneur**, faux d'une relance **interne**, qui est le cas courant : chaque
édition de manifeste depuis le poste la déclenche.

Correction (`docker/ia-runner/bin/run-tache.mjs`) : sur `EEXIST`, la fiche `detenteur.json`
est lue et l'existence de `/proc/<pid>` vérifiée. Détenteur mort → le verrou est repris, avec
une ligne de journal en niveau erreur. Prudence délibérée dans l'autre sens : fiche absente,
illisible ou sans pid numérique ⇒ détenteur **réputé vivant**, car mieux vaut une synchro
reportée qu'un verrou volé à un run qui travaille.

Test ajouté (`sidecar/test/runner.test.js`, section 5) : les cinq cas — processus courant,
pid inexistant, fiche absente, pid non numérique, JSON invalide. Le verrou n'était couvert par
aucun test jusque-là, alors qu'il est le garant de l'exécution séquentielle.

### T-040 — L'image du runner serveur ne se construisait plus, et rien ne pouvait le dire

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13, au premier déploiement réel de `ia-runner` sur le VPS (tranche D1 de
[etude-remote.md](etude-remote.md)) : `docker compose build` échoue à l'étape de compilation du
sidecar.

```
Error: Cannot find module '/app/sidecar/scripts/empreinte.mjs'
npm error command sh -c tsc && node scripts/empreinte.mjs dist
```

Cause : le script `build` du sidecar ne se résume plus à `tsc` — il enchaîne sur
`node scripts/empreinte.mjs dist` depuis le commit a0d50ec (T-032). Le Dockerfile, lui, ne
copiait dans l'étape de build que `sidecar/tsconfig.json` et `sidecar/src` : le dossier
`sidecar/scripts/` n'arrivait jamais dans le contexte.

L'image n'avait plus été construite depuis a0d50ec — elle l'avait été une seule fois, le
2026-08-05, à la livraison de D1, puis supprimée localement. Elle était donc **cassée depuis
plusieurs jours sans que rien ne l'indique**.

Correction : `COPY sidecar/scripts sidecar/scripts` dans l'étape `build`, avec un commentaire
qui dit pourquoi — toute nouvelle étape du script de build sidecar doit vérifier que ses
fichiers arrivent dans l'image.

**Ce que ce ticket a en commun avec [T-039](#t-039--deux-fichiers-que-linux-distingue-et-que-windows-confond)
et [T-038](#t-038--lappimage-ne-se-construit-plus-et-léchec-est-muet)** : un artefact de build
que la CI ne construit pas pourrit en silence. Trois occurrences en une semaine, sur trois
artefacts différents (AppImage, installeur Windows, image Docker). Le motif n'est plus une
coïncidence — il désigne un trou de couverture, pas trois bugs indépendants.

**Piste (à instruire, hors périmètre de ce ticket)** : faire construire l'image `ia-runner` par
la CI, au moins sur les PR qui touchent `docker/`, `sidecar/` ou les manifestes npm. Un build
Docker sans push coûte quelques minutes et aurait attrapé les trois.

---

### T-047 — Deux tables de routage, aucune garantie qu'elles disent la même chose

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Trouvé en retirant `claude-opus-4-8` du sélecteur ([T-046](#t-046--un-modèle-manquant-parce-que-la-liste-vivait-en-trois-exemplaires)) :
le palier `moyen` pointait dessus, et il fallait le corriger **dans deux fichiers** —
[router.ts](../sidecar/src/router.ts), qui route réellement, et
[routerAdmin.ts](../ui/src/routerAdmin.ts), qui affiche les défauts et préremplit les réglages.
Le commentaire de l'UI disait déjà « identique aux défauts codés en dur du sidecar » : un vœu,
que rien ne vérifiait.

Ce que coûterait l'oubli d'une des deux : l'écran des réglages annonce un modèle, le routeur
en appelle un autre, et **rien ne le signale**. Même famille que T-016, où le sidecar
annonçait une version fausse — la panne n'est pas le mauvais modèle, c'est l'écart muet entre
ce qu'on montre et ce qu'on fait.

**Corrigé** par [routage-defauts.mjs](../scripts/routage-defauts.mjs), sur le modèle du garde
de version (« cinq déclarations, une vérité ») : il extrait `DEFAULT_ROUTING_TABLE` des deux
fichiers et refuse le moindre écart, palier par palier, en nommant qui route et qui affiche.
La lecture est textuelle et non par import — le module du sidecar tire un moteur entier
derrière lui, et une comparaison de source ne peut pas exécuter de code au passage. Branché
dans `npm run verif` et dans la CI ; 9 cas de test, dont la divergence exercée sur un faux
dépôt et le dépôt réel vérifié.

### T-046 — Un modèle manquant, parce que la liste vivait en trois exemplaires

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constat utilisateur du 2026-08-13, capture à l'appui : « toujours pas d'opus 5 ». Le sélecteur
de modèle propose `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-8` et `claude-haiku-4-5`
— **`claude-opus-5` n'y est pas**, alors que le modèle est disponible et que c'est l'Opus
courant.

L'abonnement Claude n'expose aucun catalogue interrogeable : contrairement aux fournisseurs
neutres, le CLI ne rend pas la liste des modèles auxquels l'abonnement donne droit. La liste
est donc tenue à la main — ce qui est assumé. Ce qui ne l'était pas : elle était **recopiée
dans trois fichiers**, [agentSidebarDroit.tsx](../ui/src/agentSidebarDroit.tsx) (sélecteur des
projets), [ChatPage.tsx](../ui/src/ChatPage.tsx) (sélecteur du Chat) et
[contextBus.ts](../ui/src/contextBus.ts) (table des fenêtres de contexte). Trois endroits à
mettre à jour, aucun rappel : le modèle est sorti, personne n'a fait le tour.

**Corrigé** par une liste unique,
[modelesAbonnementClaude.ts](../ui/src/modelesAbonnementClaude.ts), dont les trois
consommateurs dérivent — et `claude-opus-5` y est ajouté, avec une note par modèle affichée en
infobulle du sélecteur. Cinq cas de test
([modelesAbonnementClaude.test.ts](../ui/src/modelesAbonnementClaude.test.ts)) ; celui qui
compte n'est pas « l'id est présent » mais **« chaque modèle de la liste a une fenêtre de
contexte connue »**, car c'est la propriété qui traverse deux fichiers et que rien ne
vérifiait. Un id à suffixe de date est refusé au passage : les identifiants de l'API sont
complets tels quels, y accoler une date donne un 404 au premier tour.

Suite décidée dans la foulée : `claude-opus-4-8` est **retiré** du sélecteur — même tarif
qu'Opus 5 pour une génération de moins — et le palier `moyen` de la table de routage
automatique passe donc à `claude-opus-5`, dans les deux fichiers qui la déclarent (c'est ce
retrait qui a fait surgir [T-047](#t-047--deux-tables-de-routage-aucune-garantie-quelles-disent-la-même-chose)).
Le palier `complexe` reste sur `claude-fable-5` : choix de coût, pas un oubli. Un fil déjà
épinglé sur 4.8 continue de tourner et affiche son id — il ne peut simplement plus être
resélectionné.

### T-034 — Le cliquet de taille est rouge sur `master`

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13 en lançant `npm run verif` avant de livrer T-033 :
`node scripts/cliquet-taille.mjs` sort en **échec** sur `master` propre —
[src-tauri/src/sidecar.rs](../src-tauri/src/sidecar.rs), 807 lignes, plafond 800. Le
dépassement n'a rien à voir avec le ticket en cours (aucun `.rs` touché) : il est déjà là,
poussé tel quel.

Ce n'est pas la taille du fichier qui est le vrai défaut, c'est qu'un garde-fou rouge en
permanence **cesse d'être un garde-fou** : la commande de vérification échoue toujours, on
prend l'habitude de lire au-delà, et le jour où le cliquet signale une vraie dérive personne
ne le distingue du bruit. Même mécanique que l'échec muet, à l'envers.

À faire : découper `sidecar.rs` (la réponse attendue par le cliquet), ou consigner une
dérogation explicite et datée dans `scripts/cliquet-taille.json` si la taille se justifie.
Puis vérifier que `npm run verif` repasse au vert de bout en bout — c'est le seul état
acceptable pour la commande qui garde la porte.

**Dérogation posée le 2026-08-13** — `"src-tauri/src/sidecar.rs": 807` dans
`scripts/cliquet-taille.json`, pour livrer la 0.3.1 sur une chaîne verte. Le fichier de
référence est du JSON : il ne porte pas de commentaire, la date et le motif vivent donc ici.
Ce n'était **pas** la clôture du ticket : la dérogation gèle la taille (le fichier ne peut
plus que rétrécir) mais ne découpe rien.

**Clos le 2026-08-13, par la bande.** En corrigeant [T-043](#t-043--tous-les-fournisseurs-en--erreur-réseau--sur-un-poste-dentreprise),
le cliquet a refusé les 27 lignes que j'ajoutais à un fichier qui n'avait le droit que de
maigrir. Plutôt que de relâcher son budget deux fois dans la même journée — ce qui aurait vidé
le garde-fou de son sens — les deux modules de test sont sortis dans
[src-tauri/src/sidecar/tests.rs](../src-tauri/src/sidecar/tests.rs) (`#[path]`, ils restent des
tests unitaires du module). `sidecar.rs` passe de 807 à **794 lignes** : sous la limite, et
donc HORS dérogation.

Honnêteté sur ce qu'on a fait : c'est la coupe la plus franche, pas la plus profonde. Aucune
logique n'a été redécoupée — seulement les tests, qui ne tenaient au reste que par `super`. Le
fichier reste dense, mais il n'a plus de traitement de faveur, et c'est ce que le cliquet
demandait.

### T-043 — Tous les fournisseurs en « erreur réseau » sur un poste d'entreprise

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constat utilisateur du 2026-08-13, sur un **poste d'entreprise** fraîchement passé en 0.3.1 :
Swiftask configuré à la main, et « erreur réseau » à chaque appel. Depuis le poste Linux, le
même service répond (`/public/bots` → 200, `/v1/models` → 200, `POST /v1/chat/completions`
sans clé → 401) : le défaut était donc local à ce poste.

Diagnostic mené **à distance**, par un agent tournant sur le poste lui-même — la machine
n'ouvre aucun port entrant. Quatre mesures faites sur place :

| mesure | résultat |
|---|---|
| `curl.exe https://graphql.swiftask.ai/public/bots` | **200** |
| Node embarqué, `fetch()` sur la même URL | **`UND_ERR_CONNECT_TIMEOUT`** |
| `HTTPS_PROXY` / `HTTP_PROXY` | un proxy d'entreprise, port 8080 |
| WinHTTP / WinINET | direct / PAC `…/proxy.pac` |

La cause tient à un écart de comportement qui n'a rien d'évident : **`curl` honore
`HTTPS_PROXY`, le `fetch` de Node non.** Sur un réseau d'entreprise à egress contrôlé,
l'application tente une connexion directe qui expire, pendant que le navigateur d'à côté
fonctionne parfaitement. `UND_ERR_CONNECT_TIMEOUT`
tombe **avant** la négociation TLS : ce n'est pas un problème de certificat.

**Corrigé** en une ligne : la coquille lance le sidecar avec `--use-env-proxy`. Le Node
embarqué (v22.22.1) sait honorer les variables d'environnement, il suffisait de le lui
demander — pas de dépendance `undici` à ajouter. Le drapeau est **inconditionnel** : sans
variable posée il ne fait rien, et une détection maison ferait moins bien que Node.

Un test Rust verrouille la présence du drapeau **et sa position avant le script** : Node ne
traite ses propres options qu'avant le nom du fichier à exécuter. Placé après, il partirait
au sidecar comme un argument quelconque, ignoré en silence — la panne reviendrait sans un mot
dans le journal.

Fausse piste écartée en chemin, et il faut le dire : le poste portait un `err.txt` rempli
d'erreurs `EISDIR: lstat 'C:'`, celles du sidecar mort-né du 7 août. Le fichier **datait du 7
août** (mesuré : 4 804 octets, jamais réécrit depuis) et notre code n'écrit plus ce fichier.
Le sidecar tournait (PID actif, « sidecar à jour » au démarrage). Un vestige de diagnostic
laissé sur un poste est un faux coupable qui attend son heure.

### T-044 — Quatre pannes réseau, un seul message

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Trouvé en instruisant [T-043](#t-043--tous-les-fournisseurs-en--erreur-réseau--sur-un-poste-dentreprise).
Le journal du poste ne portait que ceci, douze fois :

```json
{"level":"error","scope":"ui","msg":"erreur réseau: fetch failed","stack":null}
```

Le `fetch` de Node rend **toujours** le même message et range la vraie cause dans
`err.cause.code`. Nos cinq points de capture prenaient `err.message` et jetaient la cause.
Résultat : un proxy, un certificat non reconnu, un DNS muet et un service éteint produisent
la même ligne — quatre pannes, quatre remèdes, un seul message.

Le coût s'est mesuré le jour même : il a fallu **piloter la machine à distance** pour obtenir
`UND_ERR_CONNECT_TIMEOUT`, c'est-à-dire un mot que le journal avait sous la main et n'écrivait
pas. C'est la doctrine d'observabilité prise en défaut sur son propre terrain : le message
existait, il était juste inexploitable.

**Corrigé** par `avecCause()` / `messageReseau()` dans [base.ts](../sidecar/src/base.ts),
utilisés aux cinq sites d'`engine.ts` — y compris celui du Chat, le plus visible, qui rendait
`fetch failed` tout court. Le code n'est ajouté que s'il n'est pas déjà dans le message.
Six cas de test ([messageReseau.test.js](../sidecar/test/messageReseau.test.js)), dont celui
qui compte vraiment : **quatre causes doivent donner quatre messages distincts**.

### T-042 — L'installeur n'embarquait pas la version testée

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Trouvé le 2026-08-13 en instruisant [T-038](#t-038--lappimage-ne-se-construit-plus-et-léchec-est-muet),
et **plus grave que lui** : il touche les paquets déjà livrés, sur les deux plateformes.

`preparer-bundle.sh` fabrique le paquet du sidecar en régénérant un `package.json` réduit,
puis en lançant `npm install` dans ce dossier. Or ce manifeste reprenait les **plages** de
versions du sidecar (`^0.3.214`), et ce dossier n'a pas de verrou : npm y résolvait donc la
version **la plus récente du jour**, pas celle que la chaîne de tests venait de valider.

Mesuré sur le poste :

| | version | CLI Claude |
|---|---|---|
| dépôt (verrou, testé) | 0.3.214 | 265 210 864 o |
| **paquet livré** | **0.3.231** | **311 175 440 o** |

46 Mo d'écart, et une version que **personne n'avait jamais exécutée** — ni les tests, ni le
poste, ni la CI. C'est aussi l'explication du CLI Windows passé de 287 à 307 Mo entre le 9 et
le 13 août à verrou identique, anomalie que je n'expliquais pas le matin même. L'installeur
Windows de la 0.3.1 déjà distribué porte donc le CLI 0.3.231.

Livrer autre chose que ce qu'on a testé est un échec muet de plus : rien ne le signale, et
l'écart ne se découvre qu'en panne, chez l'utilisateur. Même famille que T-020 (le sidecar
périmé) — on croit exécuter ce qu'on a écrit.

**Corrigé** : le manifeste du paquet est écrit avec les versions **exactement installées**
dans le dépôt, c'est-à-dire l'image du verrou. Un paquet manquant fait échouer la construction
avec le geste à faire (`npm ci`) plutôt que de résoudre dans le vide. Et le journal
d'empaquetage annonce désormais les versions, pas seulement les noms :

```
dépendances embarquées : @anthropic-ai/claude-agent-sdk@0.3.214, yaml@2.9.0, zod@4.4.3
```

Restent flottantes les dépendances **transitives** du paquet : les figer demanderait un verrou
propre au bundle. Le risque est moindre — les gros binaires sont des dépendances directes —
mais il n'est pas nul, et ce n'est pas fait.

### T-039 — Deux fichiers que Linux distingue et que Windows confond

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13, au deuxième passage du portique de la 0.3.1 : une fois
[T-037](#t-037--un-test-neuf-construisait-un-chemin-que-windows-ne-relit-pas) corrigé, le job
Windows va plus loin et tombe à l'étape suivante, `preparer-bundle` → `tsc` :

```
File name '…/ui/src/modelPicker.ts' differs from already included file name
          '…/ui/src/ModelPicker.ts' only in casing.
Module '"./ModelPicker"' has no exported member 'ModelPicker'.
```

Le dépôt porte deux paires de fichiers dont les noms ne diffèrent que par leur initiale :

| composant | logique pure |
|---|---|
| `ui/src/ModelPicker.tsx` | `ui/src/modelPicker.ts` |
| `ui/src/ProviderForm.tsx` | `ui/src/providerForm.ts` |

Sous Linux ce sont quatre fichiers. Sous Windows, le système de fichiers est **insensible à la
casse** : `import { ModelPicker } from "./ModelPicker"` se résout sur `modelPicker.ts`, qui
n'exporte évidemment pas de composant. `tsc` voit alors deux fois le même fichier sous deux
graphies et refuse de compiler. L'installeur Windows **ne pouvait pas se construire**.

Ce qui rend le défaut coûteux, ce n'est pas la faute de frappe — c'est qu'**aucun garde-fou ne
pouvait l'attraper depuis le poste de développement**. Chaîne complète verte en local, trois
publications passées, et la panne n'apparaît qu'au moment le plus cher : la construction de la
version que l'utilisateur attend. Troisième défaut Windows-seulement de la journée, après
T-014 (avril) et T-037 le matin même.

**Corrigé** en deux temps :

1. Renommage des feuilles de logique en `modelPickerCalc.ts` et `providerFormCalc.ts` (suffixe
   `Calc`, déjà la convention du dépôt — voir `supervisionCourbesCalc.ts`), imports et
   références de documentation suivis.
2. **Un garde-fou pour que ça ne revienne pas** :
   [collisions-casse.mjs](../scripts/collisions-casse.mjs), branché dans `npm run verif` et
   dans la CI. Il refuse deux chemins qui ne diffèrent que par la casse (sur un système
   insensible, un seul survit à l'extraction du dépôt) et deux modules du même dossier dont le
   nom, extension retirée, ne diffère que par la casse (l'import devient ambigu). Ses tests
   ([collisions-casse.test.mjs](../scripts/collisions-casse.test.mjs), 11 cas) contiennent le
   cas T-039 lui-même, et vérifient qu'un module et son `.test.ts`, ou un composant et sa
   feuille de style, ne déclenchent pas de fausse alerte.

### T-037 — Un test neuf construisait un chemin que Windows ne relit pas

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13 sur le portique de la 0.3.1 : `construire (windows-latest)` échoue aux
tests du sidecar, l'annotation dit

```
ECHEC: la compilation de test doit se déclarer à jour, vu « sans-empreinte »
       (/D:/a/iaction/iaction/sidecar/dist-verif)
```

Le chemin porte la réponse : **`/D:/…`**, une barre oblique avant la lettre de lecteur.
[peremption.test.js](../sidecar/test/peremption.test.js) dérivait le dossier compilé par
`new URL(moduleCompile("peremption.js")).pathname`, qui rend cette forme sous Windows. Node ne
la relit pas : `empreinte.json` paraissait absent, le statut tombait à « sans-empreinte », et
le test — dont le métier est justement de vérifier que le témoin est déposé — accusait la
compilation.

Deux choses valent d'être notées :

- **Rien n'était cassé côté produit.** L'empreinte était bien écrite ; c'est le test qui
  regardait au mauvais endroit. Le garde-fou de T-020 tient toujours.
- **Le fichier est neuf** (créé le 2026-08-13, commit `a0d50ec`) : aucun runner Windows ne
  l'avait jamais exécuté avant ce portique. C'est exactement le scénario de
  [T-014](#t-014--ci-windows--un-test-construisait-un-chemin-sans-lettre-de-lecteur), au mot
  près — et la démonstration que la CI à deux plateformes gagne son coût sur un seul cas.

**Corrigé** par `fileURLToPath()`, la conversion qui tient sur les deux systèmes. C'était déjà
la règle du dépôt : [mcpCatalog.ts](../sidecar/src/mcpCatalog.ts) porte le commentaire qui met
en garde contre `new URL(...).pathname`. Le grep de vérification ne trouve plus aucune autre
occurrence de ce motif dans le code de chemins.

### T-035 — La dépense réelle n'était affichée nulle part

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constat utilisateur du 2026-08-13 : « le débord du mois n'affiche rien alors que j'ai utilisé
OpenRouter et une recherche ». Vérifié sur `usage/events.jsonl` du poste : **16 tours
OpenRouter en août 2026, 2,43 $ dépensés, et `routeDebord` sur zéro d'entre eux**.

La carte n'était donc pas en panne — elle affichait fidèlement `0.00 $`, parce que
`debordMoisUsd` ne somme que les tours portant `routeDebord: true`, c'est-à-dire ceux que le
ROUTEUR AUTOMATIQUE a fait déborder vers le payant quand l'abonnement était saturé. Une cible
payante choisie à la main ne porte jamais ce marqueur : c'est écrit dans la spec R3, et c'est
volontaire — le plafond mensuel ne doit pas se remplir de dépenses que l'utilisateur a
décidées lui-même.

Le vrai défaut est ailleurs, et il est plus grave : **la page ne montrait la dépense réelle
nulle part.** `costUsd` est pourtant enregistré sur chaque événement depuis R0. On pouvait donc
dépenser 2,43 $ sans qu'un seul écran de l'application ne l'affiche — un angle mort de la
comptabilité, dans la page dont c'est justement le métier.

**Corrigé** en ajoutant l'agrégat manquant plutôt qu'en dénaturant le débord :

- `usage.stats` rend désormais `coutPeriodeUsd` (somme de TOUS les `costUsd` de la période
  `from`/`to`, débord automatique ET choix manuel) et `coutInconnuTours`
  ([usageStats.ts](../sidecar/src/usageStats.ts), [protocol.md](protocol.md)) ;
- l'encart « Routage » gagne une carte **« Dépense de la période »**, à côté du débord dont le
  sous-titre précise maintenant « routage auto seulement » — les deux chiffres répondent à deux
  questions différentes, et rien ne le disait ;
- `coutInconnuTours` compte les tours sur cible payante **sans coût remonté**. Tant qu'il est
  non nul, la carte affiche « au moins — N tours payants sans coût remonté » : une somme
  partielle présentée comme un total serait un échec muet de plus (voir [T-036](#t-036--des-tours-payants-ne-remontent-aucun-coût),
  ouvert sur les 7 tours Swiftask concernés).

Extraction imposée par le cliquet de taille et bonne en soi :
[usageProjets.ts](../sidecar/src/usageProjets.ts) — `usageStats.ts` mélangeait trois métiers
(écrire le journal d'usage, l'agréger, résoudre l'appartenance d'un tour à un projet) ; le
troisième part dans son module. Le fichier passe de 869 à 662 lignes, **sous sa dérogation
de 842**, qui est resserrée d'autant.

### T-033 — Supervision : les KPI ne suivaient ni la granularité, ni la période

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constat utilisateur du 2026-08-13 : « les KPI ne s'adaptent pas au changement jour, semaine,
mois, ni avec le sélecteur de semaine ». Vérifié : exact, et pour une cause unique.

`bucket` n'était traité que comme **granularité de l'histogramme**, jamais comme période
d'analyse. `windowSpan()` rendait la même fenêtre de 30 jours pour `day` et pour `week` :

- **Jour et Semaine envoyaient à `usage.stats` un `from`/`to` identique.** Cartes KPI, Modèles,
  Usage par projet et Routage étaient donc rigoureusement les mêmes dans les deux modes — seul
  l'histogramme se re-regroupait. Mois bougeait, mais pour la mauvaise raison : c'est la
  fenêtre qui passait à 6 mois, pas la période qui devenait un mois.
- **Le ◀ ▶ décalait de 30 jours entiers** en mode Semaine. Il ne sélectionnait donc jamais une
  semaine : il reculait d'un mois, et les KPI continuaient d'agréger 30 jours. D'où « ni avec
  le sélecteur de semaine ».

Le sidecar était hors de cause : `handleUsageStats` filtre correctement sur `from`/`to`
([usageStats.ts](../sidecar/src/usageStats.ts)). Le défaut était entièrement dans
[SupervisionPage.tsx](../ui/src/SupervisionPage.tsx), et le protocole n'a pas bougé.

**Corrigé** en faisant de la sélection la période, comme le libellé le promet :

- **la période EST la sélection** — un jour, la semaine ISO (lundi→dimanche), ou le mois
  calendaire de l'ancre. Tous les encarts (KPI, modèles, projets, routage) portent sur elle
  seule, donc les trois granularités donnent trois chiffres différents ;
- **◀ ▶ avance d'UNE période** (un jour, une semaine, un mois), avec des libellés accordés
  (« Semaine précédente », « Ce mois-ci »). Le décalage part du **début** de période, pas de
  l'ancre : sinon « 31 mars − 1 mois » retombe sur le 3 mars et la navigation dérive au fil des
  mois courts ;
- **l'histogramme cède la place à un graphique de courbes** des quatre mêmes indicateurs
  ([SupervisionCourbes.tsx](../ui/src/SupervisionCourbes.tsx)), tracé sur le **cran de période
  au-dessus** de la sélection : jour → sa semaine, semaine → son mois, mois → son année. On lit
  donc toujours la période choisie dans le contexte qui la contient, et la bande claire sous les
  courbes marque celle que décrivent les cartes. Second appel `usage.stats` : les buckets de
  cette fenêtre ne suffisent pas aux encarts, ils ne portent ni modèles, ni projets, ni routage.
  Deux règles de non-tromperie dans le découpage : les bornes sont étendues aux **buckets
  entiers** (une semaine coupée par le bord du mois dessinerait un creux qui n'existe pas) et
  **tronquées à la période en cours** (sinon l'année courante traînerait quatre mois vides) ;
- **un seul axe, jamais deux échelles.** Les quatre séries vont de la dizaine de conversations
  au million de tokens : en valeurs absolues, trois courbes s'écraseraient sur zéro, et un
  second axe ferait mentir les croisements. Chacune est donc **indexée sur son propre maximum**
  de la fenêtre — l'axe se lit « % du pic de la série », les valeurs réelles sont dans la
  légende (le pic), au survol et dans un tableau dépliable. Le contexte moyen s'interrompt là
  où aucun token n'a été compté : une moyenne absente n'est pas une moyenne nulle. La palette
  (`#1478ff` `#aa6900` `#c800b9` `#ff0069`) est **vérifiée par calcul** contre la surface sombre
  de l'app — bande de clarté, plancher de chroma, séparation daltonisme toutes paires (ΔE ≥ 8,9),
  contraste ≥ 3,66:1 — et non choisie à l'œil ; l'identité ne repose jamais sur la seule
  couleur (légende + étiquette en bout de courbe + tableau) ;
- **mise en page à deux colonnes** : les courbes prennent toute la largeur, puis Usage par
  projet / Modèles sur une ligne, Routage / Abonnement Claude sur la suivante ;
- **l'ancre est conservée en changeant de granularité** (le 3 juillet en « Jour » → la semaine
  du 3 juillet), au lieu de sauter à aujourd'hui et de faire perdre l'endroit qu'on lisait ;
- **`atToday`** regarde désormais la fin de période et non l'ancre — un mois entamé est la
  dernière période navigable, ▶ ne propose plus un clic sans effet.

L'arithmétique de période est sortie dans
[supervisionPeriode.ts](../ui/src/supervisionPeriode.ts) et testée sans monter le composant
([supervisionPeriode.test.ts](../ui/src/supervisionPeriode.test.ts), 13 cas) : semaine ISO
dimanche compris, février bissextile, non-dérive sur quatre mois enchaînés, aller-retour ◀ ▶
idempotent, pas de navigation dans le futur, extension aux semaines entières, troncature à la
période en cours. C'est là que les régressions sont silencieuses.

### T-032 — Sélecteur de modèle illisible

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-12 · **Clos** 2026-08-12

Constat utilisateur du 2026-08-12, capture à l'appui : « c'est le bordel ». Le sélecteur de
modèle du Chat déroulait plusieurs centaines de slugs bruts (`bytedance-seed/seed-2-1-turbo`),
dans l'ordre où OpenRouter les sert, sans prix ni taille de contexte, avec les dix favoris
listés **deux fois** (leur groupe « Mis en avant », puis « Tous les modèles »). Même chose dans
la barre latérale de Projets. Cinq défauts, une cause commune : les deux pages appelaient
`models.list`, qui ne rend **que des ids** — alors que `models.detail`, servi par la MÊME
requête au fournisseur, porte déjà nom, tarifs et contexte, et que la page Configuration s'en
sert depuis R8-A. Le confort n'est pas décoratif ici : choisir un modèle, c'est arbitrer un coût.

**Corrigé** en sortant du `<select>` natif — il ne se filtre pas, et son popup est rendu par le
système (ni colonne, ni badge, ni étoile) :

- **[modelPickerCalc.ts](../ui/src/modelPickerCalc.ts)** — toute la décision (filtres, groupes, ordre),
  sans DOM, donc testée sans fenêtre ([modelPickerCalc.test.ts](../ui/src/modelPickerCalc.test.ts)) ;
- **[ModelPicker.tsx](../ui/src/ModelPicker.tsx)** — bouton + popover : recherche floue sur le
  nom ET l'id, tri (nom / prix / contexte), puces « Gratuit » et « Variantes », étoile de favori
  posée sur la ligne, prix et contexte en badges, id toujours visible sous le nom commercial.
  **Groupé par éditeur** (`anthropic · 28`, `openai · 94`…), en-têtes collants pendant le
  défilement, **repliés par défaut** — le catalogue OpenRouter sert 410 modèles de 59 éditeurs
  (relevé du 2026-08-12), et l'ouvrir à plat était le reproche d'origine. Trois exceptions au
  repli, toutes là pour ne rien cacher qui soit demandé : une recherche en cours déplie tout
  (sinon elle semblerait ne rien trouver), le groupe du modèle SÉLECTIONNÉ s'ouvre, et un
  fournisseur dont les ids ne nomment pas d'éditeur (Ollama) n'est jamais replié — ça
  cacherait tout le catalogue derrière une ligne. Les favoris ne se replient pas non plus ;
- **ordre des éditeurs = part de trafic** ([`RANG_EDITEURS`](../ui/src/modelPickerCalc.ts)), relevé
  OpenRouter de juin 2026 : deepseek, anthropic, google, openai, xiaomi, minimax, tencent, qwen,
  moonshotai. Les cinquante autres éditeurs du catalogue passent **après, par ordre
  alphabétique** : les classer au jugé serait inventer une hiérarchie que rien ne mesure. Table
  figée et datée, avec sa provenance affichée en pied de liste (même doctrine que
  `BENCH_DISCLAIMER`) — ce classement bouge vite : entre les relevés d'avril et juin 2026,
  xiaomi passe de 22,3 % à 8,3 % et deepseek de 6,8 % à 17,6 %. Deux ordres, deux
  responsabilités : « chez qui » vient du trafic, « lequel » du tri choisi — si bien que
  changer de tri ne fait jamais sauter les éditeurs de place sous le curseur ;
  Rendu par PORTAIL : `.sidebar-section` porte `overflow: hidden`, un popover en `absolute` y
  serait coupé. Un seul composant sert le Chat et Projets — les modèles de l'abonnement Claude y
  entrent comme options « épinglées », au même titre que la sentinelle « Auto » ;
- **variantes masquées par défaut** (`…:free`, `…:thinking`) avec un compteur cliquable, jamais
  en silence. Deux règles de non-perte : une variante n'est masquée que si son modèle de base
  est présent au catalogue (`liquid/lfm-2.5-2.6b:free` n'a pas d'équivalent payant — le masquer
  retirerait le modèle, pas son doublon), et le modèle SÉLECTIONNÉ y échappe toujours ;
- **`models.list` → `models.detail`** dans les deux pages : même requête réseau, simplement lue
  en entier. Un fournisseur muet (Ollama) rend toujours au moins les ids, et le sélecteur
  n'affiche alors ni ligne de tarif ni « — / — » — rien plutôt qu'une colonne de tirets ;
- **plus jamais de doublon** : les favoris sont retirés du groupe « Tous les modèles ».

Deux extractions au passage, imposées par le cliquet de taille et bonnes en soi :
[fuzzy.ts](../ui/src/fuzzy.ts) (le filtre flou était privé de `CommandPalette`, il sert
maintenant aux deux) et [useFavorisModeles.ts](../ui/src/useFavorisModeles.ts) (Chat et Projets
tenaient chacun leur copie du cycle lecture/bascule des favoris). ChatPage et AgentPage
ressortent **plus courts** qu'avant le ticket.

Non fait, volontairement : la section « Récents » (derniers modèles utilisés) évoquée au
cadrage — les favoris manuels suffisaient, et l'ajouter se fera sans toucher au composant.

### T-031 — L'écriture dans le Chat traîne

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-12 · **Clos** 2026-08-12

Constat utilisateur du 2026-08-12 : « l'écriture dans la partie chat est très lente ». Deux
symptômes de la même cause — la réponse qui s'écrit par à-coups, et la frappe qui redevient
poussive dès qu'on tape pendant qu'un tour répond.

**Cause — deux, trouvées dans cet ordre.**

*Piste 1 (réelle, mais pas celle du constat).* Chaque fragment de réponse arrive comme un
événement Tauri distinct, et chacun passait par `depot.ecrire`
([useConversationRuntime.ts](../ui/src/useConversationRuntime.ts)), qui demandait aussitôt un
rendu COMPLET de la page — trente à cent fois par seconde selon le fournisseur. À chaque rendu :
toute la transcription reparcourue, le Markdown de la bulle en cours reparsé en entier (coût qui
croît avec la réponse), et le recollage en bas qui force une remise en page du fil. Corrigé, mais
l'utilisateur a rapporté « ça n'a pas beaucoup changé, c'est exclusivement dans la partie chat » :
le moteur étant PARTAGÉ avec Projets, une correction qui n'améliore que le Chat ne pouvait pas
être là.

*Piste 2 (la bonne).* Trois questions ont suffi à la cerner : lent **même dans une conversation
vide**, les **lettres traînent derrière le clavier**, **quel que soit le fournisseur**. Donc un
coût par FRAPPE, indépendant du fil et du catalogue de modèles. Il restait un re-rendu de page
débouncé à 250 ms après chaque frappe, dans
[useComposerLiveDraft.ts](../ui/src/useComposerLiveDraft.ts) — le « rattrapage » des états dérivés
du brouillon. Or l'inventaire de ces états en donne UN SEUL, dans les deux pages : le bouton
« Envoyer » grisé quand il n'y a rien à envoyer. Un rendu de page complet quatre fois par seconde
pour un booléen — et il tombait au pire moment, pendant les micro-pauses entre deux mots, juste
quand la frappe reprend.

Pourquoi le Chat et pas Projets : le mécanisme est le même, le PRIX du rendu ne l'est pas. La page
Projets est déjà découpée en modules mémoïsés (`agentSidebarDroit`, `agentTranscript`, `FileTree`) ;
le Chat rendait encore tout en ligne, dans une seule fonction de 2 700 lignes.

**Corrigé** en trois temps, aucun ne touchant à la donnée — elle reste écrite immédiatement et
intégralement, seul l'AFFICHAGE est concerné :

- **la frappe ne rend plus rien** : `useComposerLiveDraft` expose `brouillonVide`, qui ne change
  qu'au FRANCHISSEMENT de la frontière vide/non-vide — deux rendus par message au lieu de quatre
  par seconde, et zéro en tapant au milieu d'une phrase. Le minuteur de rattrapage disparaît, donc
  aussi la course entre le `blur` du champ et le `click` du bouton qu'il fallait contourner ;
- **cadence de rendu du streaming** (`creerRythme`, ~80 ms, front montant) : les rafales de
  fragments sont regroupées en ~12 images/s, ce que l'œil lit comme du texte qui coule, tandis
  qu'une écriture isolée s'affiche sans délai. Profite aux deux pages ;
- **fil du Chat extrait et mémoïsé** ([chatTranscript.tsx](../ui/src/chatTranscript.tsx), [agentTranscript.tsx](../ui/src/agentTranscript.tsx)), et
  options du sélecteur de modèle mémoïsées — OpenRouter en publie plusieurs centaines, elles
  étaient reconstruites à chaque rendu.

**Leçon.** Le premier diagnostic était cohérent mais invérifié : le symptôme « c'est lent » avait
été rattaché au coût le plus VISIBLE dans le code, pas au coût mesuré. Ce qui a tranché, c'est
d'avoir demandé trois observations discriminantes plutôt qu'une quatrième lecture du code.

### T-021 — `models.list` peut ne montrer qu'une fraction des modèles servis

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-11

Constaté le 2026-08-10 en évaluant l'ajout de Swiftask comme fournisseur
neutre. `GET https://graphql.swiftask.ai/v1/models` renvoie **8 slugs figés**
(`llama31`, `mistralmedium`, `o3-mini`…), avec ou sans clé. Le catalogue réel
du même fournisseur est ailleurs — `GET /public/bots` renvoie **142 entrées**
(`claude-opus-5`, `gpt-5.6-terra`, `gemini-3.6-flash`, `grok-4.3`, plus image
et vidéo). Preuve que `/v1/models` n'est pas la source de vérité : un appel
réel sur `claude-sonnet-4-6` — **absent de `/v1/models`** — a répondu 200 et
streamé normalement.

Conséquence dans l'application : `fetchRawModels` tape en dur
`{baseUrl}/models` ([engine.ts](../sidecar/src/engine.ts) ~195), et les
sélecteurs de modèles sont des `<select>` fermés sur cette liste
([ChatPage.tsx](../ui/src/ChatPage.tsx) ~2141, [AgentPage.tsx](../ui/src/AgentPage.tsx)
~696). L'utilisateur ne peut donc **ni voir ni saisir** les 134 modèles
manquants : le fournisseur est utilisable mais amputé, sans le moindre message.

Ce n'est pas un défaut propre à Swiftask, c'est une hypothèse non écrite du
moteur neutre : « tout endpoint compatible OpenAI expose son catalogue complet
sur `/models` ». Correctif attendu : une **source de catalogue déclarée par
fournisseur** (URL + forme de la réponse), traitée en T-023. Repli minimal
acceptable en attendant : autoriser la saisie libre d'un slug quand le
catalogue est vide ou suspect.

**Le catalogue n'est pas homogène** (mesuré le 2026-08-10 sur les 142 entrées) :
132 se déclarent `isChatLMM: true`, 10 non (transcription, export Excel/Sheets,
vidéo Veo3, automatisation de navigateur). Et parmi les « chat », une soixantaine
seulement sont des modèles d'éditeur ; le reste sont des agents préconfigurés
(« Expert RH France », « Knowledge assistant - RAG », « Le Maestro »). Trois
natures derrière un seul champ `model`, dont deux dégradent silencieusement :
`excel_export` interrogé par `/v1/chat/completions` répond comme un chatbot
générique — sa fonction d'export est perdue, sans erreur — et
`languagecorrector` a perdu sa consigne de correcteur. Un sélecteur qui
listerait les 142 à plat laisserait donc choisir « Excel Export » comme
cerveau d'un agent. **Le correctif ne se réduit pas à changer d'URL : il faut
CLASSER** (au minimum `isChatLMM`, et distinguer modèle brut d'agent
préconfiguré).

**Corroboré le 2026-08-10** par lecture de l'extension VSCode officielle
(`Swiftask.swiftask-chat` 0.1.3, dont le paquet publie ses sources d'origine
via son source map) : leur propre client nomme le champ `defaultBotSlug` et le
règle sur `claude-sonnet-4-5` — **absent de `/v1/models`**. L'éditeur lui-même
ne traite donc pas `/v1/models` comme son catalogue. L'hypothèse est bien
fausse, pas seulement inadaptée.

**Clos le 2026-08-11 par R8-A** (`traits.catalogUrl` + `traits.catalogShape`,
voir [spec-r8-profils-fournisseur.md](spec-r8-profils-fournisseur.md) §2 et
`sidecar/src/catalogue.ts`). Vérifié sur la réponse réelle de
`/public/bots` : **142 entrées → 132 modèles** conservés, `claude-opus-4-8` et
`gemini-3-pro` présents, `excel_export` et `whisperx` écartés par le filtre
`isChatLMM`. Le sidecar ne porte aucune table de marques : le profil vient de
la config, poussé par `providers.set`.

### T-022 — Un usage à zéro est enregistré comme zéro, jamais comme « inconnu »

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-11

Constaté le 2026-08-10, même campagne de mesure. Dernier événement SSE d'un
tour Swiftask réussi (2 tokens de réponse) :

```
data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":7744}}
```

`extractUsage` ([engine.ts](../sidecar/src/engine.ts) ~310) ne garde que
`prompt_tokens` / `completion_tokens` et n'accepte que `typeof === "number"` :
`0` est un nombre, donc **`0` est enregistré comme une mesure valide**. La
jauge de contexte affichera « 0 token » sur une conversation qui en consomme,
les compteurs de la page Supervision agrégeront des zéros, et le plafond de
débord R3 — qui se compte sur l'usage — resterait aveugle sur ce fournisseur.

C'est exactement le défaut « jauge de contexte figée à zéro », déjà corrigé
deux fois dans l'interface (voir [architecture.md](architecture.md) §7), qui
reviendrait cette fois par la porte du fournisseur. La distinction manquante
est **« zéro mesuré » ≠ « pas de mesure »** : `null` existe déjà dans le type
`Usage`, il n'est simplement jamais produit quand le champ est présent et nul.

Correctif attendu : un tour qui a produit du contenu et annonce
`prompt_tokens: 0` déclare `null`, pas `0` — et le journalise une fois, pour
que l'absence de comptabilité soit un fait visible et non un silence. À écrire
avec un cas de test dédié dans `protocol.test.js` (faux serveur renvoyant des
zéros).

**Deux vérifications faites le 2026-08-10, qui ferment les échappatoires** :

- le champ non standard `stateless: true` — envoyé par le client officiel de
  l'éditeur — **ne change rien** : `{prompt_tokens: 0, completion_tokens: 0,
  total_tokens: 1197}` avec comme sans, sur deux modèles. Ce n'est pas un
  réglage qui nous manque, la passerelle ne compte simplement pas ;
- le client officiel **a exactement le même angle mort** : son parseur SSE
  écrit `promptTokens: chunk.usage.prompt_tokens ?? 0`. Personne ne corrigera
  cela en amont ; c'est à nous de distinguer « zéro mesuré » de « pas de
  mesure ».

**Clos le 2026-08-11 par R8-A** (`traits.usageTrustworthy: false`, voir
`sidecar/src/profilFournisseur.ts`). Un compteur annoncé à `0` devient `null`,
et le sidecar journalise un `warn` une fois par fournisseur et par processus —
l'absence de comptabilité est un fait visible, pas un silence. Sans le trait,
un vrai zéro reste un zéro (cas de test 7).

### T-028 — Relancer `dev.sh` ouvre une fenêtre morte-née, sans sidecar

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-11 · **Clos** 2026-08-11

Constat utilisateur : « la fenêtre répond `Erreur : sidecar indisponible : stdin absent` », puis
« redémarré, idem » — trois fois de suite.

Une session `tauri dev` tournait depuis 5 h et tenait le port 1420. Chaque relance de
`scripts/dev.sh` (par raccourci clavier GNOME, `gsd-media-keys`) déroulait alors :
`Running target/debug/iaction` → `Error: Port 1420 is already in use` →
`The "beforeDevCommand" terminated with a non-zero status code`. Autrement dit **la fenêtre est
lancée AVANT l'échec** : `tauri dev` avorte, le sidecar meurt avec lui, mais la fenêtre survit,
orpheline (reparentée à systemd). Pire, elle n'en a pas l'air — son webview charge le Vite de
l'AUTRE session, donc l'interface s'affiche, avec les conversations relues du disque. Le défaut
ne se voit qu'à l'envoi. Chaque relance empilait une fenêtre morte de plus.

Second défaut, révélé par le premier : côté [sidecar.rs](../src-tauri/src/sidecar.rs), la mort du
child laissait `child`/`stdin` à `None` **sans faire tomber l'état**, resté `Running`. D'où ce
message d'entrailles au lieu d'un « redémarrage en cours ». Même trou dans `request_shutdown`.

**Réalisé** :

- [scripts/dev.sh](../scripts/dev.sh) refuse de démarrer si le port 1420 est déjà pris, et dit
  quoi faire (basculer sur la fenêtre ouverte, ou `pkill -f 'tauri dev'`). Le garde-fou est
  placé AVANT la compilation du sidecar : plus rien n'est touché sur un lancement refusé ;
- l'état passe à `Restarting` au moment même où `stdin` disparaît (`emit_status` compris), et à
  `Dead` dans `request_shutdown` ; le message résiduel de `sidecar_request` devient « le
  processus vient de s'arrêter, redémarrage en cours ».

Reste ouvert et distinct : [T-009](#t-009--dev--fenêtre-ouverte-avant-que-vite-soit-chaud)
(fenêtre ouverte avant que Vite soit chaud, session unique).

### T-010 — Recherche web pour le moteur neutre (Chat)

Constaté le 2026-08-09, 00h07 (Chat · OpenRouter · ling-3.0) : interrogé sur
des vidéos IA récentes, le modèle invente des références périmées
(« janvier 2025 » présenté comme récent) avant d'admettre qu'il ne peut pas
naviguer. La case « Recherche web » du Chat n'existe que pour le fournisseur
Claude (`claude.start` + outils WebSearch/WebFetch du SDK) ; le moteur neutre
est une complétion pure (`chat.send`), sans aucun outil — et rien dans
l'interface ne prévient que ces modèles répondent de mémoire.

Deux pistes, cumulables :

- **OpenRouter d'abord (petit pas)** : OpenRouter sait faire la recherche web
  côté plateforme (suffixe `:online` sur l'id du modèle, ou champ `plugins`) —
  la case « Recherche web » pourrait s'activer pour ces fournisseurs sans
  boucle d'outils à écrire. Coût facturé par OpenRouter : à afficher.
- **Cas général (plus gros)** : boucle d'appels d'outils pour le chat neutre
  avec un outil de recherche local (SearXNG…) — le moteur neutre AGENTIQUE
  (Projets) a déjà une boucle d'outils, le Chat n'en a pas.

En attendant : au minimum, un indicateur discret « ce modèle répond de
mémoire, sans accès au web » quand le fournisseur est neutre — l'honnêteté
d'abord, la fonctionnalité ensuite.

**Second cas vérifié le 2026-08-10 (Swiftask), qui déplace la conception.**
Swiftask sait chercher côté plateforme : le bot `perplexityonline`, interrogé
sur l'actualité de la semaine, renvoie un titre réel daté avec son URL source
— aucune boucle d'outils de notre côté. Mais la commande ne prend PAS la même
forme que chez OpenRouter :

| Fournisseur | Comment on demande la recherche |
|---|---|
| OpenRouter | **même modèle** + suffixe `:online` (ou champ `plugins`) |
| Swiftask | **un autre modèle** (`perplexityonline`, `webreporter`, `google-search`) |
| Claude | outils `WebSearch`/`WebFetch` du SDK, déjà en place |

Trois grammaires pour une seule intention. Une case « Recherche web » unique
ne peut donc pas les couvrir sans un `if` par fournisseur — c'est-à-dire
exactement ce que T-023 cherche à supprimer. **La case doit être pilotée par
un trait** (« comment ce fournisseur active la recherche »), pas par une
condition sur l'id. T-010 dépend donc de R8, et ne devrait pas être traité
avant.

À noter aussi : `gemini-pro-with-search`, seul modèle du sélecteur dont le nom
promet la recherche, est l'un des deux modèles morts de T-025. L'utilisateur
qui le choisit croit activer une capacité et reçoit une phrase d'erreur
présentée comme une réponse.

**Réalisé le 2026-08-10** — spec [R9](spec-r9-recherche-web.md), par
l'INJECTION et non par une boucle d'outils : `chat.send` accepte
`webSearch: true`, le sidecar interroge SearXNG, récupère et classe les pages
(mêmes primitives que le RAG R5), puis préfixe un bloc système ÉPHÉMÈRE au
seul tour en cours. Conséquence directe : la capacité vaut pour **100 % des
modèles**, y compris ceux qui ne savent pas appeler une fonction, et aucune
des trois grammaires de fournisseur (`:online`, `perplexityonline`, outils du
SDK) n'a eu à être implémentée. La case n'est donc plus conditionnée au
fournisseur.

Trois garanties tenues par des tests (`webSearchPur`, `webSearchChat`,
`rechercheWeb.test.ts`) : sans `webSearch`, le tour est identique à l'octet
près et n'émet AUCUNE requête sortante ; un moteur en panne produit un tour
réussi qui ORDONNE au modèle de dire qu'il n'a pas vérifié ; les URL de
résultat sont refusées avant tout accès réseau si elles visent le réseau
privé du poste.

Vérifié en réel le 2026-08-10 sur `swiftask · deepseek-v3` : 5 sources
remontées et citées, et le modèle a explicitement refusé de conclure sur des
extraits insuffisants plutôt que d'inventer — c'est exactement le
comportement que ce ticket réclamait. La qualité des résultats sur une
question d'actualité reste perfectible : voir T-026.

### T-027 — L'avis d'attente s'affichait alors que le fournisseur répondait

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-10

**Constat (2026-08-10).** « J'ai encore ça à chaque nouvelle réponse, c'est très chiant » :
l'avis `⏳ Aucune donnée reçue du fournisseur` de T-006 s'affiche sous une bulle vide, dans un
fil où la réponse précédente est complète et visible juste au-dessus, sur une session dont
l'en-tête indique 12 % de fenêtre consommée — rien n'est saturé, et le fournisseur répond.

**Cause.** L'avis ne mesurait pas « le fournisseur se tait » mais « cette bulle-ci est encore
vide ». Deux choses très différentes dès qu'un tour dure, et deux faux positifs distincts :

- **le seuil.** 10 s était calibré sur un tour court. Le temps jusqu'au premier octet croît avec
  le contexte envoyé : à ~100 k tokens (cas courant ici — l'en-tête affiche le compteur), il
  dépasse régulièrement 10 s sans que rien n'aille mal ;
- **la portée.** Une bulle assistant ouverte au MILIEU d'un tour vivant — message glissé par
  l'utilisateur (S3, `claude.push`), que le modèle ne prendra en compte qu'au prochain outil —
  est vide par construction, parfois plusieurs minutes.

Gravité réelle malgré l'apparence cosmétique : un avertissement qui se déclenche en
fonctionnement NORMAL n'avertit plus de rien. On apprend à ne plus le lire — et il ne servira
pas le jour où le tour est vraiment mort, ce pour quoi il avait été écrit. C'est la panne de
T-006 qui revient par la porte de derrière.

**Réalisé.** Seuil porté à 45 s dans [useAttenteFournisseur.ts](../ui/src/useAttenteFournisseur.ts) —
franchement au-dessus de la latence normale d'un gros contexte, franchement en dessous du
plafond de silence du sidecar (120 s, `SILENCE_DEMARRAGE_TIMEOUT_MS`), qui prend le relais et
transforme l'attente en échec daté. La règle « quand a-t-on le droit d'avertir » devient une
fonction pure unique, `enAttenteDuPremierOctet`, partagée par les deux fils (Projets et Chat) :
elle était auparavant recopiée dans deux JSX, ce qui est exactement la forme du défaut. Les
bulles de poursuite portent `suiteDeTour` ([agentTurns.ts](../ui/src/agentTurns.ts),
[envoiProjet.ts](../ui/src/envoiProjet.ts)) et n'affichent jamais l'avis. Le message annonce
désormais le délai réellement attendu, dérivé de la constante — pas un nombre recopié.
Couverture : [useAttenteFournisseur.test.ts](../ui/src/useAttenteFournisseur.test.ts).

### T-020 — L'application de dev exécutait un sidecar du 7 août

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-10

**Constat (2026-08-10, 09h17).** L'interface affiche encore
« ⏳ Aucune donnée reçue du fournisseur » sur un tour parti à 09h15 — le symptôme que T-015
était censé avoir supprimé la veille. Le journal confirme le trou noir : dernière ligne
`serveurs MCP du tour` à 07h15:13 Z, puis plus rien ; aucun `error`, et aucun processus
`claude` correspondant à ce tour dans `ps` (un seul, celui du tour précédent de 09h12). Le
plafond de silence de T-015 (120 s) aurait dû déclarer l'échec à 07h17:13 Z. Il ne l'a pas fait.

**Cause.** Le garde-fou n'était pas dans le programme en train de tourner. `claudeFinDeTour.js`
était purement et simplement ABSENT de `src-tauri/target/debug/sidecar/`, le dossier désigné
par le journal de coquille comme point d'entrée du sidecar. Ce dossier est la recopie de la
ressource Tauri `build/sidecar-bundle/`, que seul `scripts/preparer-bundle.sh`
(`beforeBuildCommand`) reconstruit — jamais `tauri dev`, dont le `beforeDevCommand` ne bâtit
que l'interface. Le bundle datait du **7 août 15h33**. L'application exécutait donc trois jours
de code périmé : T-015, T-017, T-019, la température GPU, tout ce qui touchait le sidecar avait
été compilé, testé, commité — et jamais exécuté une seule fois.

**Pourquoi personne ne l'a vu.** Trois écrans successifs :

- les tests compilent leur PROPRE sortie (`dist-verif/`, voir `test/harness.mjs`) : ils
  passaient au vert sur du code que l'application n'utilisait pas ;
- `sidecar/dist/` existait, à jour au 8 août, et n'était lu par personne — de quoi croire le
  contraire en le regardant ;
- les dates de fichiers MENTAIENT : la recopie du bundle portait le 9 août 18h37, postérieure
  aux sources qu'elle ignorait (`claudeFinDeTour.ts`, 9 août 14h19). Une date dit quand on a
  touché un fichier, jamais ce qu'il contient.

Coût réel : on corrige des bugs déjà corrigés, avec pour seule preuve un symptôme qui persiste.
C'est l'échec muet le plus cher du projet à ce jour, parce qu'il invalide silencieusement tout
diagnostic bâti sur l'application lancée.

**Réalisé — la cause, puis le garde-fou.**

1. [scripts/dev.sh](../scripts/dev.sh) compile le sidecar et DÉSIGNE le résultat par
   `IACTION_SIDECAR`, première branche de `sidecar_entry`
   ([src-tauri/src/sidecar.rs](../src-tauri/src/sidecar.rs)) : la boucle de développement ne
   passe plus par le bundle de livraison, donc plus par une copie qui peut vieillir en silence.
2. Sortie DÉDIÉE `dist-dev/` (script `build:dev`), et non `dist/` : réécrire le dossier
   qu'exécute l'application tue son sidecar — constaté quatre fois les 7 et 8 août, d'où
   `dist-verif/` pour les tests. Trois sorties, trois usages : `dist/` l'empaquetage,
   `dist-verif/` les tests, `dist-dev/` la session lancée. Aucune n'écrit sous les pieds
   d'une autre.
3. [sidecar/src/peremption.ts](../sidecar/src/peremption.ts) : le code compilé emporte
   l'EMPREINTE sha256 des sources dont il est issu (`empreinte.json`, déposé par
   `npm run build -w sidecar`). Au démarrage, le sidecar la recompare et journalise —
   `perime` en `error`, `sans-empreinte` en `warn` (le cas du bundle du 7 août), `a-jour` et
   `hors-source` en `info`, avec dans TOUS les cas le chemin du code réellement exécuté :
   l'unique information qui aurait désigné le coupable en dix secondes.

Empreinte de CONTENU et de NOMS, jamais de dates — un module absent change l'empreinte à
contenu constant, et une date de recopie n'aurait rien vu. Couverture :
[peremption.test.js](../sidecar/test/peremption.test.js) (les quatre statuts, les deux
dispositions de dossier, le témoin corrompu, et le câblage réel de la compilation).

### T-017 — La coquille journalisait la naissance du sidecar, jamais sa mort

Constaté le 2026-08-09 en enquêtant sur T-015 : `logs/coquille.jsonl` ne
contient qu'une seule et même ligne, `démarrage de la supervision du sidecar`,
répétée à chaque lancement — jamais de code de sortie, jamais de signal,
jamais la moindre ligne de `stderr` du processus mort.

Conséquence concrète : le sidecar a redémarré **deux fois pendant une session
de travail** (12h22 et 12h33, chacune suivie de la signature de T-008), et il
est impossible de dire si c'est un plantage, une relance de `tauri dev` ou un
geste de l'utilisateur. Une supervision qui note la naissance sans jamais noter
la mort ne supervise pas : elle compte.

À faire : journaliser la FIN du processus surveillé (code de sortie ou signal,
durée de vie, dernières lignes de stderr), et distinguer un premier démarrage
d'une relance après mort — c'est cette distinction qui aurait répondu à la
question en une seconde.

**Réalisé** (fermé le 2026-08-09, même session) : la coquille tient un tampon
circulaire des 30 dernières lignes de stderr et journalise en `error`, à
chaque mort du process, la cause (code de sortie ou signal nommé), la durée de
vie et ce résumé de stderr. La ligne de naissance dit désormais s'il s'agit du
premier démarrage ou d'une relance après mort — c'est cette distinction qui
manquait pour répondre « plantage ou geste volontaire ? ». Six tests couvrent
les parties pures (cause avec et sans signal, éviction du tampon, troncature
UTF-8, borne du résumé) ; le câblage lui-même exige un vrai process, il n'est
pas testé — assumé et dit.

Le piège évité, déjà documenté dans `sidecar.rs` : ne jamais journaliser
depuis le relais de stderr LIGNE À LIGNE, sous peine de boucle
stderr → `app:log` → `log.append` → stderr. Le journal de mort est un
événement UNIQUE par process : c'est ce qui le rend permis.

### T-018 — Chat : le fournisseur choisi retombait sur Claude sans rien dire

Constaté le 2026-08-09 à 12h49 : OpenRouter + Gemini sélectionnés, la
conversation part sur `Claude (abonnement)` et le badge du tour affiche
`auto : simple → claude-sonnet-5`. L'historique le confirme visuellement — les
conversations précédentes portent « OpenRouter », la nouvelle « Claude
(abonnement) ».

**Mécanisme identifié** (`ui/src/ChatPage.tsx:1067-1072`) :

```tsx
const ids = [...providers.map((p) => p.id), CLAUDE_PROVIDER_ID];
if (!ids.includes(providerId)) {
  setProviderId(ids[0]);   // ← réécrit le choix de l'utilisateur
}
```

`ChatPage` ne reçoit que la LISTE des fournisseurs, jamais son état de
chargement (`ProvidersLoadState` existe pourtant dans `useProviders.ts`) : elle
ne peut donc pas distinguer « pas encore chargés » de « vraiment disparus ».
Pendant la fenêtre où la table est vide — au démarrage, et à chaque
redémarrage du sidecar, dont l'erreur `usage.openrouter` de T-008 est la
signature — `ids` se réduit à `["claude"]`, la condition est vraie, et le
choix de l'utilisateur est remplacé par Claude. Quand les fournisseurs
reviennent, **rien ne le rétablit** : un repli transitoire devient définitif.

Aggravant : le modèle d'une conversation neuve repart sur `Auto (montant)`, et
en mode Auto le routeur choisit LUI-MÊME la cible — le fournisseur affiché
n'est alors plus une consigne mais un résultat. Les deux effets se cumulent et
donnent l'impression que la sélection est ignorée.

Pistes : mémoriser le choix EXPLICITE de l'utilisateur et le rétablir dès que
son fournisseur réapparaît ; ne jamais replier tant que la liste n'est pas
chargée (passer `loadState` à `ChatPage`) ; et rendre visible qu'en mode Auto
la cible est décidée par le routeur, pas par le sélecteur. À couvrir par un
test : liste vide puis peuplée ⇒ le choix survit.

**Réalisé** (fermé le 2026-08-09, même session) : la logique de repli sort dans
un module feuille pur, `ui/src/choixFournisseur.ts`. Trois règles — une liste
VIDE ne décide de rien (c'est une absence d'information, pas une disparition) ;
le choix explicite mémorisé est RÉTABLI dès que son fournisseur réapparaît ;
sinon seulement, repli sur le premier. Six tests, dont le scénario complet :
choix « openrouter », table vidée par un redémarrage du sidecar, table
repeuplée — le choix survit.

### T-016 — Le sidecar annonçait 0.1.0, et un test verrouillait ce mensonge

Constaté le 2026-08-09 en cherchant où vivait le numéro de version pour
l'afficher dans l'en-tête : `sidecar/src/index.ts` portait
`const VERSION = "0.1.0"` alors que les cinq autres déclarations du dépôt
(package.json racine, ui, sidecar, `tauri.conf.json`, `Cargo.toml`) étaient
passées à 0.2.0. L'événement `ready` annonçait donc une version fausse depuis
le passage de version — invisible, puisque rien ne l'affichait encore.

Le détail qui compte : le test protocole assertait `=== "0.1.0"`. Il ne
dormait pas, il **verrouillait la désynchronisation comme comportement voulu**
— le même piège que l'ancien test de périmètre de l'audit (T-011). Un test
peut être vert et garder la porte du mauvais côté.

**Réalisé** (fermé le 2026-08-09, même session) : la version est LUE dans le
`package.json` du sidecar (qui voyage avec lui dans le bundle), avec repli
« inconnue » plutôt qu'un numéro inventé ; le test compare désormais au
`package.json`, plus à un littéral.

### T-014 — CI Windows : un test construisait un chemin sans lettre de lecteur

Constaté le 2026-08-09 sur la **toute première PR** (#5) : le job
`construire (windows-latest)` échoue aux tests du sidecar, l'annotation
donnant la cause sans droits d'administration —
`ECHEC: chemin relatif sain accepté, reçu {"ok":true,"abs":"D:\projet\demo\src\main.ts"}`.
Le job Linux, lui, passe entièrement (AppImage de 205 Mo construite).

**Le code n'était pas en cause.** `neutralAgentPur.test.js` construisait son
répertoire d'essai par `path.join(path.sep, "projet", "demo")`, soit
`\projet\demo` sous Windows : une forme que Windows ne tient pas pour
pleinement qualifiée, et à laquelle `path.resolve` ajoute le lecteur courant.
Le test comparait donc deux écritures du même chemin. La garde
`resolveSafePath` est correcte — elle résout `cwd` avant toute comparaison, y
compris pour le piège du frère préfixé.

Deux enseignements, plus utiles que le correctif :

- c'est le **piège des tests qui testent l'OS**, déjà connu : une assertion
  sur une forme de chemin mesure la plateforme, pas le produit ;
- le test datait de l'étape 6, **jamais publiée**. Aucun runner Windows ne
  l'avait donc jamais exécuté. C'est exactement le trou que le portique par
  PR vient combler : sans lui, ce défaut serait apparu à la prochaine
  release, au pire moment.

**Réalisé** (fermé le 2026-08-09, même session) : le `cwd` d'essai part de la
racine réelle de la plateforme (`path.parse(path.resolve(path.sep)).root`),
soit `/` sous Linux et le lecteur courant sous Windows.

### T-013 — Le miroir des tickets déduisait le dépôt du remote

Constaté le 2026-08-09, dès le premier lancement réel (`npm run tickets:miroir`,
possible seulement une fois `gh` installé) : `gh` répond « none of the git
remotes configured for this repository point to a known GitHub host » et le
script meurt. En local, `origin` est la forge privée — GitHub n'y figure pas,
le script de publication nommant son URL en clair.

Ce qui rend le cas instructif : **la CI ne l'aurait jamais montré**, son
checkout installant un `origin` GitHub. Le défaut ne vivait que là où le
script sert d'abord — sur le poste, en prévisualisation avant d'appliquer. Et
les tests ne pouvaient pas le voir : ils couvrent la logique pure, sans
réseau ni `gh`. Rappel utile — un test vert ne dit rien de l'environnement.

**Réalisé** (fermé le 2026-08-09, même session) : le dépôt cible est désormais
NOMMÉ (`depotCible()`, surchargeable par `GH_REPO` pour un fork ou un dépôt
d'essai) et passé en `--repo` à chaque appel, jamais déduit. Deux tests
couvrent la valeur par défaut et la surcharge.

### T-011 — L'audit de publication ne voyait pas les fichiers non suivis

Constaté le 2026-08-09, ~00h50 : l'audit lancé AVANT `git add` du gabarit
NSIS neuf a rendu vert, puis rouge une fois le fichier commité —
`fichiersSuivis()` reposait sur `git ls-files` seul, donc un fichier neuf
échappait à l'audit au moment exact où il compte (juste avant de le
committer). Un ancien test verrouillait même ce comportement comme voulu
(« un fichier non suivi est hors périmètre »).

**Réalisé** (fermé le 2026-08-09, même session) : `git ls-files --cached
--others --exclude-standard` — les fichiers non suivis entrent dans le
périmètre, les fichiers IGNORÉS restent dehors (`.audit-motifs` en dépend).
Contrat de test inversé + cas nouveau ; au passage, trois hôtes publics du
gabarit NSIS rejoignent la liste relue (go.microsoft.com,
nsis.sourceforge.io, source.chromium.org).

### T-005 — Le débord R3 ignore la fenêtre 7 jours

Constaté le 2026-08-08, 12h03 : bandeau « Fenêtre 7 jours saturée —
réinitialisation dans 8 h » (Semaine 99 %), et pourtant un tour Auto du Chat
part vers `claude-sonnet-5` (abonnement) et reste suspendu. La règle de
débord (`router.route`, R3) ne regarde que `fiveHourPct` — à 79 % ce
jour-là, donc sous le seuil — alors que la fenêtre HEBDOMADAIRE était morte.
L'application SAIT que la semaine est saturée (elle l'affiche en rouge dans
l'en-tête) mais le routeur ne consomme pas cette information.

Piste : ajouter la fenêtre 7 jours aux entrées de la décision de débord
(même source que le bandeau, `usage/claude-windows.jsonl`), avec la même
mécanique que le seuil 5 h — et les mêmes gardes R3 existantes en aval
(cible déclarée, plafond mensuel). Les deux stratégies en profitent :
`resoudreRouteMontante`/`resoudreRouteDescendante` reçoivent déjà le débord
résolu par le sidecar, rien à changer côté feuilles.

**Réalisé** (fermé le 2026-08-09) : `applyDebord` déclenche sur la saturation
de L'UNE OU L'AUTRE fenêtre (même seuil), la décision transporte
`sevenDayPct`, et raisons/badge/bandeau nomment la fenêtre réellement
saturée. Le bloc débord est sorti dans `sidecar/src/debord.ts` (module dédié
à la règle qui parle d'argent — router.ts repasse d'ailleurs sous les 800
lignes) ; scénario rd2c dans routageDebord.test.js : 5 h à 50 %, 7 jours à
100 % → débord actif, raison « 7 jours à 100 % ».

### T-006 — Tour abonnement muet : curseur infini

Même incident : le tour vers l'abonnement saturé n'affiche AUCUN état — pas
d'erreur, pas de « limite atteinte », un curseur qui clignote sans fin (le
SDK réessaie en silence). C'est exactement « l'échec muet » que la doctrine
d'observabilité interdit. Un tour qui n'a reçu aucun octet après un délai
raisonnable doit le dire dans la bulle (« en attente du fournisseur… », puis
« limite d'abonnement atteinte » quand la cause est connue), en laissant
« Arrêter » faire son travail.

**Réalisé** (fermé le 2026-08-09) : `useAttenteFournisseur` — une bulle
assistant en streaming qui n'a RIEN reçu après 10 s affiche « ⏳ Aucune donnée
reçue du fournisseur… », dans les deux pages ; l'avis disparaît au premier
octet (texte, raisonnement ou outil). La variante « cause connue » (limite
atteinte) devient largement théorique une fois T-005 en place : le routeur
n'envoie plus vers un abonnement saturé.

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
