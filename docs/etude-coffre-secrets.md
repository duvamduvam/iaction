# Étude — Un coffre de secrets déverrouillé par mot de passe à l'ouverture

> Rédigée le 2026-11-18, **grillée le même jour** : les décisions sont arrêtées
> (§ 0 et § 10). Aucun code modifié. Déclencheur : un agent, faute de trouver le
> format du coffre MCP, a posé un jeton d'API dans un `.env` à côté d'un script,
> au milieu d'un projet synchronisé (T-220).

## 0. La réponse courte

**Objectif** : livrer en **0.8.0**, d'un seul tenant, un coffre chiffré par
poste, déverrouillé par mot de passe au lancement, **et** des agents qui ne
peuvent plus écrire de jeton ailleurs.

**C'est réussi quand** il ne reste aucun secret en clair sur le disque (ni
`mcp-secrets.json`, ni `.env` de projet), et que les agents passent par le
coffre sans qu'on le leur rappelle, parce que l'autre voie leur est fermée.

**Menace prioritaire : la lecture passive sur le poste du bureau**, un
poste Windows administré : sauvegardes du profil, antivirus ou EDR qui remontent
des fichiers, migration de poste, et surtout **la clé de secours DPAPI du
domaine**, qui permet à la DSI de déchiffrer le Credential Manager, donc le
trousseau actuel. Un coffre chiffré par **ton** mot de passe échappe à tout cela.
Il ne prétend pas résister à un administrateur actif sur la machine en marche.

| Décision | En une ligne |
|---|---|
| Format | fichier **`age`** (ChaCha20-Poly1305), sa clé elle-même chiffrée par le mot de passe (scrypt) ; déchiffrable à la main avec l'outil `age` si IAction casse |
| Gardien | la **coquille Rust** : seule à connaître la clé, seule à déchiffrer |
| Postes | **un coffre par poste**, jamais synchronisé ; **mots de passe distincts** (règle d'usage) |
| Contenu | clés des fournisseurs, clés de la voix, secrets MCP, jetons des scripts de projet |
| Sortie des jetons | **uniquement vers un serveur MCP** déclaré ; pas de `iaction exec` |
| Tâches sans fenêtre | deux classes, `coffre` et `sans-fenetre`, cette dernière autorisée partout, avec avertissement sur un Windows joint à un domaine |
| Verrouillage | à la mise en veille et au verrouillage de session, **après** la fin des tours en cours |
| Secours | clé de secours sur **chaque** poste, rangée dans un gestionnaire de mots de passe personnel |
| Agents | écriture de `.env`, `*.pem`, `*.key` **bloquée** dans les projets ; inventaire et migration guidée des `.env` existants |

## 1. État constaté (2026-11-18)

| Où | Quoi | Protection réelle |
|---|---|---|
| Trousseau de l'OS, service `iaction` (`src-tauri/src/secrets.rs`) | clés des fournisseurs, de la voix | ouvert à la connexion : **tout processus du compte** le lit (Secret Service par D-Bus, Credential Manager sous Windows) ; sous Windows joint à un domaine, déchiffrable par la DSI (DPAPI) |
| `<config>/mcp-secrets.json` (`sidecar/src/mcpSecrets.ts`) | jetons des serveurs MCP, injectés par `${SECRET:nom}` | **en clair**, mode 0600 sous Linux ; **aucun** mode sous Windows (T-134) |
| `.env` éparpillés dans les projets | jetons posés par les agents ou à la main | en clair, **synchronisés par Nextcloud** quand le projet y vit |

Trajet actuel des clés de fournisseur : l'interface lit le trousseau
(`secret_get`, `ui/src/providerAdmin.ts:104`) et passe la clé au sidecar en
paramètre de chaque tour (`params.apiKey`, `sidecar/src/claude.ts:204`).

Défaut d'**accessibilité**, cause directe du déclencheur : rien n'indique à un
agent qu'un coffre existe, ni comment y référencer un secret. Le cas du
déclencheur était pourtant un **serveur MCP** (script déclaré dans
`.mcp.json`) : `${SECRET:nom}` suffisait.

## 2. Contre quoi le coffre protège — et contre quoi non

| Menace | Aujourd'hui | Avec le coffre |
|---|---|---|
| **Lecture passive au bureau** : sauvegarde, EDR, migration, DPAPI du domaine | **exposé** | **protégé** (cible prioritaire) |
| Copie du disque, vol du portable | trousseau : protégé par la session ; `mcp-secrets.json` : exposé | protégé |
| Synchronisation Nextcloud d'un `.env` de projet | exposé | protégé : plus de `.env` (§ 6) |
| Lecture opportuniste par un agent (`cat`, `secret-tool lookup`) | exposé | protégé au repos |
| Secret de classe `sans-fenetre` | — | **exposé comme aujourd'hui**, par choix, secret par secret |
| Programme sous ton compte, coffre **ouvert** | exposé | **exposé aussi** (voir ci-dessous) |
| Administrateur actif sur la machine en marche | exposé | exposé : **hors objectif, assumé** |
| Agent autonome qui écrit une entrée `.mcp.json` pour faire sortir un `${SECRET:…}` (dans `command`, `args` ou `url` d'un serveur à lui) | exposé | **exposé, assumé** (décision du 2026-11-18) |

Point le moins visible : un serveur MCP reçoit son jeton par variable
d'environnement. Sous Linux, un processus du même compte lit l'environnement
d'un processus frère (`/proc/<pid>/environ`) ; `ptrace_scope` ne l'en empêche
pas. Un agent autonome muni de `Bash` peut donc lire un jeton **en cours
d'usage**. Le fermer demanderait un bac à sable pour l'agent : hors périmètre.

**Agent qui réécrit `.mcp.json`** (décision du 2026-11-18, à l'origine un
constat de la relecture adverse du coffre) : un agent autonome peut lister les
noms (`secrets_lister`), écrire une entrée `.mcp.json` qui référence n'importe
quel `${SECRET:…}`, et en lire la valeur au tour suivant. C'est **assumé** :
le coffre protège de la lecture passive au repos, pas de l'agent déterminé —
même logique que la limite de la détection Bash (§ 6.3). Lier chaque secret
aux serveurs approuvés a été écarté.

**Hors périmètre assumé** : le jeton d'abonnement Claude
(`~/.claude/.credentials.json`, en clair, y compris au bureau). IAction ne
touche jamais aux identifiants du CLI (`docs/etude-deux-comptes.md`). Le coffre
n'y change rien ; c'est à savoir, pas à corriger ici.

## 3. Les options écartées

| | Option | Pourquoi écartée |
|---|---|---|
| A | Verser les secrets MCP dans le trousseau | ne protège pas du DPAPI du domaine, donc pas de la menace prioritaire |
| C | Gestionnaire externe (KeePassXC, Bitwarden en ligne de commande) | installation souvent refusée sur un poste administré ; comportement différent selon l'OS |
| D | Clé du coffre mémorisée dans le trousseau | la remet à portée du DPAPI : annule le gain au bureau. **Rouverte le 2026-11-19 pour les postes hors domaine, au choix par poste (T-225)** : toujours refusée sur un Windows joint à un domaine ou de jonction indéterminée |

Retenue : **B**, coffre `age` intégré. `age` plutôt qu'un format maison : format
public et relu, crate Rust pure, et **récupérable sans IAction** (`age -d`).

## 4. Conception

### 4.1 Fichiers

Deux niveaux, parce que `age` **interdit** de mêler une phrase de passe et un
autre destinataire dans un même fichier :

- `<config>/coffre.age` : chiffré pour une **identité X25519** tirée au hasard à
  la création ;
- `<config>/coffre.cle.age` : cette identité, chiffrée par le mot de passe
  (scrypt).

Changer de mot de passe ne réécrit que `coffre.cle.age`. Contenu déchiffré :

```json
{ "version": 1,
  "secrets": {
    "provider:openrouter": { "valeur": "…", "cree": "2026-11-18", "classe": "coffre" },
    "mcp:relais":          { "valeur": "…", "cree": "2026-11-18", "classe": "coffre" } } }
```

Écriture atomique (fichier temporaire puis renommage) et **copie de la version
précédente** (`coffre.age.prec`) : une écriture interrompue ne coûte jamais tous
les secrets. `<config>` n'est pas dans Nextcloud : rien n'est synchronisé.

### 4.2 Qui détient quoi

```
saisie du mot de passe (interface)
        │  une seule fois, effacée du champ aussitôt
        ▼
coquille Rust ── déchiffre ── garde la table en mémoire (zeroize)
        │                          │
        │ secret_get/set/delete    │ au déverrouillage ET à chaque
        │ (signatures inchangées)  │ (re)naissance du sidecar
        ▼                          ▼
interface                    sidecar : table MCP en mémoire,
                             jamais sur le disque
```

- `secret_get` / `secret_set` / `secret_delete` gardent leur signature : seul
  le dorsal Rust change (coffre, ou trousseau pour la classe `sans-fenetre`).
- Le sidecar ne lit plus `mcp-secrets.json` : la coquille lui **pousse** la
  table au déverrouillage, et de nouveau quand elle le relance.
  `mcp.secretSet` passe par la coquille, qui réécrit le coffre.
- `resolveSecretRefs` et `${SECRET:nom}` ne changent pas : les `.mcp.json`
  existants restent valides. **C'est la seule sortie d'un jeton** : vers
  l'environnement d'un serveur MCP déclaré. Il n'y aura pas de `iaction exec`,
  qui serait une porte de sortie pour l'agent. Un script qui a besoin d'un jeton
  devient un serveur MCP.

### 4.3 Déverrouillage et verrouillage

- **À l'ouverture** : fenêtre modale, mot de passe, bouton « Plus tard ». Sans
  coffre ouvert, l'application reste utilisable (modèles locaux, historique) ;
  un tour qui a besoin d'un secret échoue avec un message clair (« coffre
  verrouillé : le serveur MCP `relais` est écarté »), jamais en silence.
- **Fermeture automatique** à la **mise en veille** et au **verrouillage de
  session** (Win+L, écran de verrouillage sous Linux). Pas de minuteur
  d'inactivité.
- **Tours en cours** : la fermeture **attend la fin du dernier tour**. Pendant
  ce délai, l'en-tête affiche « fermeture du coffre en attente : N tours en
  cours ». Conséquence acceptée : une orchestration de nuit garde ses secrets
  ouverts jusqu'à la fin du lot, écran verrouillé. L'attente **n'a pas de
  plafond**, y compris quand un tour attend une réponse humaine (permission,
  question) ou que la machine se met en veille : le coffre reste alors ouvert
  jusqu'à la fin du tour. Conséquence acceptée le 2026-11-18, après que la
  relecture adverse du coffre l'a relevée ; le verrouillage manuel reste
  immédiat.
- **Bouton** de verrouillage manuel dans l'en-tête, à côté des jauges.
- **Tentatives** : délai croissant après trois échecs.
- **Déverrouillage automatique** (option D, rouverte le 2026-11-19 pour les
  postes hors domaine, au choix par poste — T-225) : case « Déverrouiller
  automatiquement sur ce poste ». L'identité du coffre va au trousseau du
  système ; au lancement, le coffre s'ouvre sans mot de passe, et la veille
  comme le verrouillage de session ne le ferment plus (le trousseau le
  rouvrirait). Refusée, et toute entrée retirée au lancement, sur un Windows
  joint à un domaine ou de jonction indéterminée : le poste du bureau reste au
  mot de passe.
- **Journal** : ouverture, fermeture (et sa cause), échec, secret posé, retiré
  ou reclassé, avec le **nom** seulement. La valeur ne sort jamais.

### 4.4 Clé de secours

Proposée à la création, **sur chaque poste**. IAction affiche l'identité
(`AGE-SECRET-KEY-1…`) une seule fois et demande d'en recopier un fragment pour
confirmer qu'elle est rangée. Rangement décidé : **gestionnaire de mots de
passe personnel**, jamais sur le poste lui-même. Elle ouvre le coffre sans le
mot de passe, y compris par `age -d -i` hors d'IAction.

### 4.5 Mots de passe

Deux postes, deux coffres, **deux mots de passe différents** : un mot de passe
saisi au bureau ne doit pas ouvrir la maison. Rien ne peut l'imposer entre deux
postes qui ne se parlent pas ; c'est une **règle d'usage**, rappelée en une
phrase à la création du coffre.

## 5. Les tâches qui tournent sans fenêtre

Le minuteur du matin et le fond de nuit démarrent **sans** la coquille Rust.
Décision : **deux classes de secrets**, visibles dans l'écran des secrets.

- `coffre` (par défaut) : dans le coffre chiffré, disponible seulement quand
  IAction est ouvert et déverrouillé.
- `sans-fenetre` : reste au trousseau de l'OS, lisible par les tâches de fond.
  L'écran dit en toutes lettres qu'il est lisible par tout programme de la
  session.

La classe `sans-fenetre` est **autorisée sur tous les postes**, bureau compris.
Sur un Windows **joint à un domaine**, la reclasser affiche un avertissement
explicite : « ce secret sera déchiffrable par les administrateurs du domaine ».
C'est la tension assumée entre la menace prioritaire et la souplesse voulue.

Le runner Docker distant n'est pas concerné : il lit son `.env` de serveur
(`docs/etude-remote.md` § 5).

## 6. Agents disciplinés

1. **Consigne** dans le prompt système : un secret se déclare au coffre et se
   référence `${SECRET:nom}` dans `.mcp.json` ; jamais de `.env`.
2. **Outil `iaction`** qui liste les **noms** des secrets du poste (jamais les
   valeurs), pour qu'un agent sache quoi référencer.
3. **Blocage** : un contrôle sur `Write` et `Edit` refuse dans un projet
   l'écriture de `.env`, `.env.*` (sauf `.env.example`), `*.pem`, `*.key`, avec
   un message qui renvoie au coffre. **Limite connue** : `echo … > .env` par
   `Bash` passe. Une détection sur `Bash` est ajoutée, mais elle reste
   contournable ; elle protège de la négligence, pas de l'agent déterminé.
4. **`.env` existants** : inventaire des projets ouverts, puis **migration
   guidée** : pour chaque jeton, IAction propose de le verser au coffre et de
   réécrire le `.mcp.json` concerné. Il ne supprime le `.env` qu'après ta
   confirmation.

## 7. Migration

Au premier lancement de la 0.8.0 :

1. « Créer le coffre » : mot de passe deux fois, clé de secours (§ 4.4).
2. Import du trousseau `iaction` et de `mcp-secrets.json`, **classement
   proposé** : tout en `coffre`, sauf les secrets qu'une tâche programmée
   référence, proposés en `sans-fenetre`. Tu valides la liste avant toute
   écriture.
3. Suppression des originaux **après** une relecture réussie du coffre, jamais
   avant, et sans filet en double (leçon du renommage `ia-studio` → `iaction`).
4. Inventaire des `.env` (§ 6.4).

## 8. Livraison

**Tout ensemble en 0.8.0** : coffre, classes de secrets, migration, inventaire,
consigne, outil et blocage. Une seule livraison cohérente, plus facile à relire.

**Risque accepté** : d'ici la 0.8.0, un agent peut encore écrire un `.env`
(T-220 reste ouvert jusque-là).

Ordre de construction interne : coffre Rust et commandes `secret_*` → poussée
au sidecar et fin de `mcp-secrets.json` → modale et verrouillage → classes et
écran des secrets → consigne, outil, blocage → migration et inventaire.

Exécution : code de sécurité, donc ni Sonnet ni Haiku. Le sous-agent
`implementeur` sur Opus, avec cette étude pour spécification.

## 9. Vérification avant livraison

Les quatre conditions sont **requises**, aucune n'est facultative :

1. **Tests automatiques**, sur les runners Linux **et** Windows : coffre écrit
   puis relu à l'identique, mauvais mot de passe refusé, écriture interrompue
   sans perte (`coffre.age.prec`), changement de mot de passe, ouverture par la
   clé de secours, aucune valeur dans le journal ni dans une réponse RPC,
   blocage de l'écriture d'un `.env`.
2. **Recherche de secrets en clair** : un script cherche les **valeurs**
   connues dans la config, l'état, les journaux et les projets ouverts ;
   zéro résultat exigé après migration.
3. **Relecture adverse** du diff par le sous-agent `relecteur`, sur Fable, avant
   la mise en service.
4. **Essai sur le poste du bureau** : création, Win+L pendant un tour (la
   fermeture attend), déverrouillage, migration réelle, puis ouverture du
   coffre par `age -d` avec la clé de secours, hors IAction.

## 10. Inconnues à lever pendant la construction

- **Détection du verrouillage de session** : Tauri ne l'expose pas à notre
  connaissance. Il faudra l'écouter nous-mêmes (`WTS_SESSION_LOCK` sous
  Windows ; `LockedHint` de logind ou le signal de l'économiseur sous Linux).
  À vérifier avant de promettre le comportement.
- **Point d'accroche du blocage** : vérifier que le contrôle des outils
  (`canUseTool` ou un crochet `PreToolUse` du SDK) voit bien le chemin cible
  de `Write`/`Edit` en mode autonome, où rien n'est validé à la main.
- **Joint à un domaine** : comment le détecter de façon fiable sous Windows
  pour l'avertissement du § 5.
- **Tâches programmées → secrets référencés** : la migration suppose qu'on sait
  lister les `${SECRET:…}` des `.mcp.json` de chaque tâche ; à confirmer sur
  `sidecar/src/taches.ts`.
