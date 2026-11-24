# Étude — Deux IAction qui dialoguent en autonomie par le relais

> Rédigée le 2026-11-20, **grillée le même jour** : les décisions sont
> arrêtées (§ 0 et § 5). Implémentation : § 3.6. Déclencheur : remplacer par
> IAction un ancien outil séparé, qui traitait sur un poste les demandes
> venues d'un autre.

## 0. La réponse courte

**Objectif** : un IAction (la maison) confie une tâche à l'autre (le bureau)
par le relais ; celui-ci la traite **sans personne devant l'écran** et
répond par le même relais ; la conversation peut continuer en plusieurs
allers-retours. Plus d'outil séparé.

**Premier usage visé** (V1) : la maison demande la **publication du site de
documentation** ; le bureau pousse sur la forge interne et suit la CI, seul.

**C'est réussi quand** une demande de publication partie de la maison revient
traitée **sans aucun geste sur le poste du bureau** (IAction y étant
simplement ouvert), que chaque échange est journalisé des deux côtés, et
qu'aucun message ne peut faire faire au bureau plus que ce que son projet
dédié autorise. **Échéance : cette semaine** (essai réel avant le 27/11).

| Décision | En une ligne |
|---|---|
| Où vit le veilleur | dans le **sidecar**, actif tant que l'app est ouverte et le coffre ouvert (pas de planificateur Windows) |
| Disponibilité au bureau | **IAction ouvert en permanence** pendant les heures ; rien la nuit / le week-end en V1 (mode service = chantier séparé) |
| Déclenchement | relève de la boîte toutes les **30 s** ; un message = un tour d'agent |
| Émetteurs écoutés | **la maison seule** ; tout autre jeton est laissé en boîte, journalisé, jamais exécuté |
| Compte au bureau | **perso** (jamais Teams) ; le débord vers un autre compte reste interdit |
| Outils au bureau | **Bash complet** dans le projet dédié (publication = push + CI) ; garde-fous par les § 2 et § 3.5, pas par la liste d'outils |
| Contexte | **une session Claude par fil** : les allers-retours d'un même fil gardent leur contexte |
| Dialogue autonome | jusqu'à **6 allers-retours** sans humain par fil ; au-delà, le fil s'arrête et attend |
| Plafonds | **5 $/message**, **100 tours/jour**, **tour borné à 20 min** |
| Retour à la maison | **bulle dans la conversation d'origine** |
| Jeton de la maison | **versé au coffre** ; les `.env` en clair de l'ancien outil sont supprimés |
| Format | un fichier `msg-<id>.md` à en-tête (fil, type, profondeur) ; les pièces jointes restent des **données** |

## 1. Ce qui existe déjà

- **Relais entre studios** (0.8.0) : boîtes aux lettres `/boites` du broker,
  un jeton par studio, dépôt chez l'autre, lecture de sa seule boîte. Le
  broker note l'expéditeur (`de`) d'après le jeton : un studio ne peut pas se
  faire passer pour un autre. Réception dans `relais-recu/`, secrets refusés,
  fichiers de consignes renommés `.recu`.
- **Coffre** (0.8.0) : le jeton du relais n'est servi qu'au serveur MCP
  déclaré ; au bureau, le coffre s'ouvre par mot de passe (T-225 : jamais
  d'ouverture automatique sur un poste joint à un domaine).
- **Tours sans fenêtre** : orchestrations et tâches lancent déjà des tours
  Claude depuis le sidecar. Les tâches planifiées passent par des timers
  systemd : **indisponibles sous Windows**, d'où le choix d'un veilleur dans
  l'app ouverte.
- **Ce qui disparaît** : l'ancien outil séparé (file `/jobs`, tampon
  `/buffer` du broker) et son client. Ces routes restent tant qu'un autre
  usage en dépend.

## 2. Le renversement à assumer

Jusqu'ici, ce qui arrive par le relais est **une donnée, jamais une
consigne**. Le veilleur fait d'un message une consigne exécutée sans humain,
et le bureau dispose de **Bash complet**. C'est assumé, mais seulement
encadré ainsi :

- **seul le corps du fichier `msg-<id>.md`** devient la consigne ; les autres
  fichiers reçus restent des données (même règle qu'aujourd'hui, rappelée à
  l'agent dans la consigne de tour) ;
- **la maison seule est écoutée** ; le broker prouve l'émetteur par son jeton,
  un message d'un autre studio est laissé en boîte et journalisé ;
- le tour tourne **dans le projet dédié**, jamais ailleurs ;
- **toute la sécurité du bureau tient alors au jeton de la maison** : qui le
  détient obtient un shell sur le poste du bureau. Ce jeton est donc **versé au
  coffre** de la maison, et les copies en clair (`.env` de l'ancien outil)
  supprimées. C'est une condition de mise en service, pas une option.

## 3. Conception

### 3.1 Activation (par poste, par projet)

`<projet>/.iaction/veilleur.json`, écrit par l'interface, jamais par un agent
(ajouté à la garde d'écriture des fichiers sensibles) :

```json
{ "actif": true, "expediteurs": ["maison"], "agent": null,
  "compte": "perso",
  "modele": "claude-opus-5-5", "effort": "medium",
  "permission": "bypassPermissions", "bash": true,
  "plafonds": { "toursParJour": 100, "coutParMessage": 5.0, "profondeur": 6, "dureeMin": 20 },
  "cadenceSec": 30, "url": "https://…", "jetonSecret": "relais.jeton" }
```

Un seul projet veilleur par poste (V1). L'en-tête de l'app affiche
« Veilleur actif · <projet> » (ou l'état qui le bloque) ; un clic ouvre la
section « Veilleur » de la page Projets, où « Désactiver » le coupe.
L'enregistrement depuis l'interface SCELLE la config (§ 3.6, écarts).

### 3.2 Le message

```
---
fil: 7c1e…            # identifiant de conversation inter-studios
id: 4b09…             # identifiant du message
type: demande | reponse | info
profondeur: 2         # allers-retours sans humain dans ce fil
en_reponse_a: 91aa…
pieces: [rapport.json]
---
<consigne ou réponse, en texte>
```

Les pièces jointes partent en fichiers distincts préfixés de l'`id`, comme
aujourd'hui.

### 3.3 Le cycle au bureau

1. Relève (`GET /boites`) toutes les 30 s ; message de la maison →
   récupération dans `relais-recu/<fil>/`.
2. Tour Claude dans le projet dédié, **sur le compte perso**, **en reprenant
   la session du fil** (un fil = une session, mémoire dans
   `.iaction/veilleur-fils.json`). Tour borné à 20 min.
3. La réponse finale de l'agent devient `msg-<id>.md` de type `reponse`,
   déposé chez la maison avec les fichiers que l'agent désigne.
4. Seulement ensuite, suppression du message de la boîte. Un `id` déjà traité
   (journal local) n'est jamais rejoué : au pire une réponse en double, jamais
   une action en double.

### 3.4 Le cycle à la maison

- **Outil `relais_demander`** (`destinataire`, `consigne`, `fichiers?`,
  `fil?`, `attendre?`) : dépose une demande ; avec `attendre`, l'appel
  attend la réponse (relève toutes les 15 s, borne `MCP_TOOL_TIMEOUT`), sinon
  rend l'`id` et le fil.
- **La réponse du bureau revient dans la conversation IAction d'origine**
  (bulle « réponse du bureau »), repérée par le `fil`. Le veilleur de la
  maison ne relance un tour que si le fil est marqué « dialogue autonome » et
  que la profondeur reste sous 6.

### 3.5 Garde-fous

| Risque | Parade |
|---|---|
| Boucle sans fin entre les deux agents | `profondeur` incrémentée à chaque réponse, **plafond 6** par fil ; au plafond, le message part en `info` et le fil s'arrête |
| Dépense qui s'emballe | **5 $/message**, **100 tours/jour** ; au-delà, refus répondu à la maison, avis dans l'app |
| Message piégé, Bash complet | **maison seule** écoutée (jeton prouvé) ; corps seul = consigne, pièces = données ; projet dédié ; `CLAUDE.md` reçus renommés |
| Jeton de la maison détient tout | jeton **au coffre**, `.env` en clair supprimés (§ 2) ; condition de mise en service |
| Fuite d'un secret dans une réponse | contrôle de dépôt existant (valeurs du coffre, clés, jetons de forme connue) |
| Un tour qui ne finit pas | **20 min** ; au-delà, interruption et réponse « délai dépassé » |
| Personne ne sait ce qui s'est passé | événement `relais` au journal pour chaque relève, tour, réponse, refus ; page Supervision |
| Coffre fermé (veille) | veilleur suspendu, repris à l'ouverture ; rien n'est perdu (les messages attendent 7 jours au broker) |

## 3.6 Avancement

- **Cœur + plomberie codés** (2026-11-20, T-227) : six feuilles, ~53 cas de
  test, sans moteur ni UI.
  - `veilleurMessage.ts` : format du message `msg-<id>.md`, lecture stricte.
  - `veilleurPolitique.ts` : garde-fous purs (maison seule, dédoublonnage,
    profondeur, quota ; refus silencieux vs répondu).
  - `veilleurCycle.ts` : une relève, dépendances injectées, **ordre sûr**
    (marquer l'`id` avant l'effet de bord ; dépôt avant suppression).
  - `veilleurBoite.ts` : client HTTP réel des boîtes (requête injectable).
  - `veilleurEtat.ts` : ids traités (purge 8 j) et quota/jour, persistés.
  - `veilleurConfig.ts` : `.iaction/veilleur.json` lu et validé strictement ;
    écriture interdite aux agents (`estConfigVeilleur`, fichiersSecrets.ts).
- **Moteur, outils et interface codés** (2026-11-20, T-227, second lot) :
  - `relaisFichiers.ts` : règles de dépôt et de réception du relais,
    sorties de `relaisServeur.ts` et partagées avec le veilleur ;
  - `veilleurLanceur.ts` : tour headless dans le projet dédié, compte perso
    imposé, session par fil (`veilleurFils.ts`), borne de durée, refus des
    permissions, corps d'échec lisible ;
  - `veilleurService.ts` : boucle de relève dans le sidecar (coffre ouvert,
    jeton résolu au coffre, une relève à la fois), redémarrage au lancement,
    états et journal `relais` ; `veilleurProtocole.ts` : méthodes
    `veilleur.*` et événement `veilleur` ;
  - `outilsRelaisVeilleur.ts` : outils `relais_demander` (avec attente) et
    `relais_reponse` ;
  - interface : section « Veilleur » de la page Projets, indicateur
    d'en-tête.
- **Reste** : l'essai réel encadré (§ 4, V1) ; les deux relectures adverses
  sont passées (2026-11-20).

### Écarts constatés à l'implémentation

- **`bypassPermissions` imposé par Bash** : sans humain, tout autre mode
  bloquerait le tour sur la première commande. La config le rend obligatoire
  avec Bash (`acceptEdits` sans Bash) ; le § 3.1 montrait à l'origine
  `acceptEdits` avec Bash, combinaison désormais refusée (exemple corrigé).
- **Coût constaté après coup ⇒ suspension** : le coût d'un tour n'est connu
  qu'à sa fin, il ne peut pas être refusé d'avance. Au-delà du plafond, la
  réponse part avec une ligne qui le dit, puis le veilleur est suspendu
  jusqu'à ce qu'un humain le réactive.
- **Seules les `demande` s'exécutent** : une `reponse` ou une `info` reçue
  reste en boîte pour l'outil qui l'attend. Sans cela, deux veilleurs se
  répondraient sans fin.
- **Retour à la maison** : la « bulle dans la conversation d'origine » est
  rendue par l'attente de `relais_demander` (la réponse revient dans le tour
  qui a demandé). La bulle automatique hors tour est reportée.
- **Pièces préfixées de l'id** : une pièce du message `<id>` voyage sous
  `<id>-<nom>` ; elle n'est acceptée que si le même émetteur l'a déposée.
- **Mémoire des fils hors projet** : `fils.json` vit sous la config de
  l'application, pas dans `.iaction/` (§ 3.3), comme `poste.json` et l'état :
  un agent ne peut ainsi ni lire ni réécrire les sessions des fils.
- **Pas d'outils `relais_*` dans un tour du veilleur** : un tour lancé par un
  message ne relance pas lui-même un autre studio. Sinon deux veilleurs
  pourraient s'entretenir sans fin par fils neufs, que la profondeur (comptée
  par fil) ne borne pas.
- **Permission demandée pendant un tour : refusée aussitôt**, sinon elle
  bloquerait le tour jusqu'à sa borne de durée.
- **Pièces dans la réponse du veilleur (T-230)** : chaque demande a un dossier
  de sortie `relais-envoi/<empreinte de l'id de la demande>/` (exclu de git), créé vide avant
  le tour et dit à l'agent dans la consigne. Après le tour, seuls les fichiers
  réguliers posés à plat dedans (20 au plus, 200 Mo cumulés) sont collectés,
  chacun passé au contrôle de dépôt du relais (nom sensible, consignes,
  `msg-*.md`, secret du coffre ou du jeton dans le contenu, aussi en UTF-16) ;
  sous-dossiers et liens symboliques sont refusés, un ZIP n'est accepté que si
  les noms de ses entrées le sont, tout autre conteneur est refusé. Les pièces sont déposées sous
  `<id de la réponse>-<nom>` AVANT le message, qui les annonce (`pieces`) et
  liste en fin de corps celles qui n'ont pas pu partir. Leur contenu n'entre
  jamais dans l'état : une reprise redépose le message seul. Réponse retenue
  pour secret, tour interrompu ou `info` : aucune pièce. Le dossier est
  supprimé après le dépôt du message. L'outil `relais_reponse` les reçoit déjà
  dans `relais-recu/<fil>/`.

Après relecture adverse (même jour) :

- **Config scellée, par l'enregistrement** : avec Bash, un agent peut
  réécrire `veilleur.json` (adresse, nom du secret envoyé en jeton,
  émetteurs, plafonds). La config n'est donc jamais crue sur parole :
  « Enregistrer et approuver » dans l'interface (`veilleur.configurer`) range
  au coffre l'empreinte SHA-256 de la config normalisée, liée au chemin réel du
  projet, sous un secret propre au projet (`veilleur.empreinte.<projet>`). Le
  veilleur (chaque battement) et les outils `relais_demander` /
  `relais_reponse` (chaque appel) la recalculent avant toute requête ;
  différente ou absente, rien ne part. `activer` exige une config approuvée,
  `desactiver` re-scelle `actif: false` sans retirer l'approbation, `oublier`
  supprime config et scellé. Le scellé n'est lu que dans le coffre ouvert,
  jamais dans l'ancien fichier de secrets en clair.
- **La garde d'écriture est une barrière contre la maladresse, pas contre un
  agent déterminé** : avec Bash, `cp`, `mv`, un interpréteur passent. Elle
  refuse en plus, dans un tour du veilleur, `.mcp.json`,
  `.claude/settings*.json` et tout `.iaction/`, sur des chemins normalisés
  (séparateurs, casse, points et espaces finaux de Windows). C'est le scellé
  qui protège la config — pas la disponibilité (voir plus bas).
- **Bornes réelles, aucun « 0 = illimité »** : allers-retours 1–20, tours
  1–500 par jour, coût plus de 0 et au plus 50 $ par message, durée 1–120 min,
  cadence 10–600 s. Le plafond de coût est passé au moteur
  (`maxBudgetUsd`) ; un coût inconnu après une interruption compte comme un
  dépassement. Avec une session par fil, le moteur rend le cumul de la
  session : le coût d'un message est l'écart avec le cumul précédent.
- **Périmètre du tour** : ni Claude in Chrome, ni serveur MCP du projet ou
  du poste (MCP strict, `mcp: false`), ni réglages utilisateur du poste
  (`settingSources` réduit au projet), ni outils `relais_*`, ni sessions
  distantes (une sortie vers une autre machine). Restent chargés : `CLAUDE.md`
  et `.claude/settings*.json` du projet, et les deux serveurs in-process
  d'IAction — `studio` (noms des secrets) et `iaction` (recherche dans le
  Chat, consommation de l'abonnement, connaissances du projet si l'index
  existe).
- **État `arret-en-cours`** : un arrêt n'affiche plus `inactif` tant que le
  tour interrompu n'a pas rendu la main ; le moteur n'est jamais lancé si
  l'arrêt est déjà demandé, et l'interruption est réessayée tant qu'il ne
  connaît pas encore le tour.
- **Une demande ne disparaît jamais sans réponse** : la réponse est gardée
  dans l'état jusqu'à son dépôt et redéposée à la relève suivante ; un tour
  interrompu par l'arrêt de l'application reçoit une `info` qui le dit (pas de
  ré-exécution). L'état illisible arrête le veilleur au lieu d'oublier ce qui
  a été traité.
- **Contenu vérifié inchangé** : le broker écrase un fichier de même nom ;
  après lecture d'un message ou d'une pièce, la boîte est relistée et la même
  entrée (émetteur, taille, date de dépôt) exigée, sinon rien ne s'exécute.
  Un émetteur non écouté n'est même pas lu. Une réponse qui porterait une
  valeur du coffre est retenue.
- **Limite résiduelle de la substitution** : le broker rend la date de dépôt
  à la seconde ; une substitution de même taille dans la même seconde ne
  serait pas vue. La fermer demande au broker de refuser l'écrasement du
  fichier d'un autre émetteur.

Après la seconde relecture adverse (verdict : essai encadré possible, pas de
service sans surveillance) :

- **Ce que le scellé protège, et ce qu'il ne protège pas.** Un agent ne peut
  pas forger l'approbation : elle n'est acceptée que de la classe `coffre`
  (chiffrée). La coquille transmet la classe de chaque secret (`nomsCoffre`) ;
  un scellé servi par le trousseau `sans-fenetre`, par l'ancien fichier en
  clair ou par une coquille ancienne (sans classe) ne compte pas. Côté
  coquille, un nom `veilleur.empreinte…` n'est jamais lu ni poussé depuis
  `sans-fenetre`, ne peut pas y être reclassé, ne s'importe pas à la
  migration, et va toujours au coffre chiffré à l'écriture. L'empreinte
  couvre l'adresse, le nom du secret, les émetteurs, les plafonds, l'agent et
  le CONTENU de son fichier, l'autorité de certification et le contenu de son
  fichier. Elle ne protège pas la DISPONIBILITÉ : un tour avec Bash peut
  écrire `etat.json`, `fils.json` et `poste.json` — remettre à zéro le quota
  et la suspension, perdre les sessions des fils, ou relancer au démarrage le
  veilleur d'un projet déjà approuvé.
- **Enregistrer n'approuve que ce qui est affiché** : le formulaire montre
  l'agent et l'état actif/inactif qui seront scellés ; une config non
  approuvée n'en reprend rien en silence (`actif` non, aucun agent), et un
  encart dit les champs qui diffèrent de la dernière version approuvée.
- **Périmètre constaté, pas supposé** : à l'`init` d'un tour du veilleur, un
  serveur MCP autre que les deux serveurs internes, ou un outil de
  navigateur, interrompt le tour avant toute action et suspend le veilleur.
  Le navigateur est éteint deux fois : drapeau `--no-chrome` et
  `CLAUDE_CODE_ENABLE_CFC=0` dans l'environnement du tour. Sans Bash, tout
  `.claude/` et `CLAUDE.md` sont aussi protégés en écriture, et la liste
  d'outils est positive (celle de l'agent réduite aux outils permis).
- **État `bloque`** : un tour qui a accepté son interruption sans rendre la
  main après 60 s laisse le veilleur `bloque` ; plus aucun tour jusqu'au
  redémarrage de l'application. L'activation est refusée pendant un arrêt en
  cours ou un blocage. À la fermeture de l'application, le veilleur s'arrête
  et son tour est interrompu (10 s au plus) avant la sortie du sidecar.
- **Session par émetteur et par fil**, journal d'un message invalide ou d'un
  redépôt raté une fois par nom jusqu'au changement d'état, et
  `relais_supprimer` refuse de retirer un `msg-*.md`. À l'enregistrement,
  `.iaction/veilleur.json` et `relais-recu/` vont dans `.git/info/exclude`
  (jamais dans le `.gitignore` versionné).
- **Limite fonctionnelle, noir sur blanc** : sur un poste où le
  déverrouillage automatique du coffre est interdit, le coffre se ferme au
  verrouillage de session ; le veilleur passe alors en attente jusqu'au
  déverrouillage manuel. « Zéro geste » ne vaut que session ouverte.
- **Effet de bord assumé** : tout tour ordinaire d'un projet doté d'une
  config de veilleur reçoit les outils `relais_*` (ils refusent de partir si
  la config n'est pas approuvée).

## 4. Phasage

1. **V1 — le bureau publie** : veilleur, format, cycle § 3.3, outil
   `relais_demander` sans attente, interrupteur, journal, plafonds. Jeton de
   la maison versé au coffre, `.env` en clair supprimés. **Essai réel : la
   maison lance la publication du site, le bureau pousse et suit la CI seul.**
2. **V2 — attente et dialogue** : `attendre`, bulle de réponse à la maison,
   fils en dialogue autonome avec profondeur.
3. **V3 — retrait de l'ancien outil** : une fois V1 éprouvée, arrêt de
   l'ancien outil ; les routes `/jobs` et `/buffer` du broker suivent si plus
   rien ne les utilise.

## 5. Décisions arrêtées (grill du 2026-11-20)

Toutes reportées au § 0. En clair :

- **Usage V1** : publier le site de documentation ; **réussite** = zéro geste
  au bureau ; **échéance** = cette semaine.
- **Bash complet** au bureau, assumé, encadré par le § 2 et le § 3.5.
- **Maison seule** écoutée ; **compte perso** ; **IAction ouvert en
  permanence**.
- **Plafonds** : 6 allers-retours, 5 $/message, 100 tours/jour, 20 min/tour.
- **Retour** dans la conversation d'origine.
- **Jeton de la maison au coffre**, `.env` en clair supprimés — condition de
  mise en service.

### Reste à décider en codant

- **Cadence** : 30 s au bureau, 15 s en attente active — à confirmer si trop
  bavard sur le broker.
- **Mode service** au bureau (réponse la nuit / le week-end) : hors V1, à
  rouvrir si le besoin apparaît.
