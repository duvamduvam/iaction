# Étude — Accéder à tous mes projets depuis le téléphone (Android)

> Rédigée le 2026-10-03, **non grillée**. Reprend le point laissé « pour plus
> tard » du cap du 2026-08-05 (`docs/etude-remote.md` §1 : « l'app Android,
> parler avec mes projets, exigerait une surface réseau applicative — à
> regriller le jour venu »). Le jour est venu : premier cas d'usage, le
> chantier de la maison ; mais le besoin est **générique** — demain un autre
> projet, un autre lieu.

## 0. Le besoin, en une phrase

Depuis le téléphone, **sans repasser par le PC** : choisir n'importe lequel
de mes espaces, lui poser une question sur ce qu'il sait, lui parler comme
dans l'app, et y déposer des photos ou des notes qui arrivent au bon endroit.

Ce que « mes espaces » veut dire ici : les projets déclarés dans IAction
(`~/.config/net.duvam.iaction/config.json`, 10 aujourd'hui, professionnels
et personnels), plus les dossiers de travail qui n'y sont pas encore déclarés
(`~/Nextcloud/projets/maison/`, qui a son propre `CLAUDE.md`, son `.mcp.json`
et son RAG). Tout vit sous `~/Nextcloud/`.

Réussi quand : depuis le chantier, en 4G, je prends une photo d'un raccord,
je demande « c'est conforme à ce qu'on a prévu ? », la réponse cite le plan
de plomberie, et la photo est rangée dans le projet avec un nom lisible —
puis la même chose, le lendemain, pour un tout autre projet, sans rien
configurer de plus.

## 1. Ce que le téléphone doit savoir faire (et rien d'autre)

| # | Besoin | Aujourd'hui |
|---|---|---|
| M1 | **Choisir un projet** parmi les miens | palette Ctrl+K au PC |
| M2 | **Demander** : question sur la connaissance du projet, réponse sourcée | `knowledge.search` + outil `mcp__iaction__search_knowledge`, PC seulement |
| M3 | **Converser** avec l'agent du projet (streaming, outils), y compris reprendre une conversation commencée au PC | `claude.start` / `claude.push`, état des conversations dans `~/.local/share/net.duvam.iaction/state/` |
| M4 | **Déposer** une photo, un fichier, une note, **dans le projet**, au bon endroit, bien nommé | copie manuelle ; le protocole accepte déjà des pièces jointes (`attachments`, ≤ 8 Mo, ≤ 8 par message) mais ne les **range** pas |
| M5 | **Répondre** aux questions et permissions de l'agent (modale `permission_request`) sinon le tour reste bloqué | `PermissionModal` au PC |
| M6 | **Être prévenu** quand un tour long finit ou bloque | rien (ntfy prévu en D2, inerte) |
| M7 | **Parler** plutôt que taper (chantier, mains sales) | module `speech` (STT/TTS) déjà dans la config |
| M8 | Fonctionner **PC éteint** pour les projets éligibles | `ia-runner` sur le VPS (D1 validé le 2026-08-13) |

Hors périmètre, volontairement : éditer du code, l'arborescence, la
configuration, les tâches planifiées, les orchestrations. Le téléphone
**regarde, demande, capture** ; le PC pilote.

## 2. Ce que l'architecture actuelle permet (mesuré le 2026-10-03)

**Le transport est le point le plus favorable.** Toute la sémantique
UI ⇄ sidecar passe par **une seule commande** Tauri (`sidecar_request`) et
**un seul écouteur** (`sidecar:event`), encapsulés dans `ui/src/sidecar.ts`
(`request()` l. 230). Les 117 méthodes du protocole (JSON Lines corrélées
par `id`, `docs/protocol.md`) ne connaissent pas Tauri. Remplacer ce
transport par un WebSocket revient à toucher **un fichier côté UI**, et à
ajouter côté machine un serveur qui pousse les mêmes lignes au sidecar.

**Ce qui ne passe pas par le sidecar** : 12 commandes Rust appelées depuis
8 fichiers (`fs_*`, `state_write`/`state_rename`, `config_write`,
`secret_set`/`secret_delete`, `demarrage_jalon`, `open_external`,
`sidecar_restart`). Un client distant n'en a besoin que de deux familles :
**l'état des conversations** (`state_*`, pour reprendre un fil) et **l'écriture
de fichiers** (`fs_write_file`, pour déposer une photo). Les secrets et la
config restent au PC.

**L'interface de bureau n'est pas réutilisable sur un téléphone** : 51
composants, 24 600 lignes de `.tsx`, 8 règles `@media` en tout. Une
interface mobile est un **client nouveau et petit**, pas une adaptation.

**Déjà là et réutilisable tel quel** :

- pièces jointes images dans `chat.send` / `claude.start` / `claude.push` ;
- recherche de connaissances par projet (`knowledge.search`, index
  `.iaction/connaissances-index/` présent sur 6 projets) ;
- questions et permissions de l'agent : canal `permission_request` ⇄
  `claude.permission` (askUser.ts), à rendre sur mobile ;
- un seul sidecar pour tous les projets (`cwd` par requête, T-062) ;
- `.mcp.json` du projet chargé par `claude.start` : déclarer
  `projets/maison` comme projet IAction lui donne son RAG `maison-rag` sans
  rien écrire ;
- `ia-runner` sur le VPS : même sidecar, projets en liste blanche
  synchronisés, jeton d'abonnement en `.env`.

**Contraintes de doctrine** :

- « aucun envoi hors de l'infra personnelle » (postes + OVH) ;
- « pas de mise en ligne de l'app, aucune API réseau applicative »
  (2026-08-05) — **c'est cette décision que la présente étude demande de
  rouvrir**, sous une forme restreinte : une surface réseau **privée**
  (VPN), jamais exposée sur Internet ;
- trousseau OS indisponible hors session graphique (secrets par env) ;
- isolation entre apps : rien ici ne touche orgaia ni le site `maison.local`.

## 3. Options

| | Couvre | Dév. | PC éteint | Verdict |
|---|---|---|---|---|
| **O0 — Claude Code Remote Control** : l'app Claude Android pilote une session `claude` ouverte sur le PC (skills globaux, `.mcp.json` du cwd, disque, photos déposées dans `~/.claude/uploads/`) | M1 (par session ou `--add-dir`), M2 partiel, M3 (hors fils IAction), M4 (avec une règle de rangement), M5 | **0** | non | **à faire aujourd'hui** |
| **O1 — IAction « accès distant »** : transport WebSocket + jeton sur le poste, **client mobile dédié** (PWA) joignable par VPN | M1-M7 | ~10 j | non | **cible** |
| **O2 — même client servi par `ia-runner`** sur le VPS pour les projets en liste blanche | M1-M5, M8 | +3-5 j après O1 | **oui** | phase suivante |
| O3 — Coquille Tauri 2 Android autour du client O1 (feuille de partage « envoyer vers IAction », notifications natives) | M4 M6 plus confortables | +3 j | — | option tardive |
| O4 — Application Android native (Kotlin) | idem | ×3 | — | **non** : rien n'exige du natif |
| O5 — App Nextcloud Android seule | M4 brut (tout `~/Nextcloud` est déjà accessible en lecture/écriture depuis le téléphone) | 0 | oui | **complément** immédiat pour les fichiers en masse |
| O6 — Interface de bureau servie telle quelle sur le réseau | M1-M5 | 2 j | non | non : inutilisable sur 6 pouces, et expose toute l'admin |

Ce que O0 ne donne pas, et qui justifie O1 : les conversations et le RAG
**d'IAction** (le serveur MCP `iaction` est in-process dans le sidecar, un
CLI ne le voit pas), les agents et profils du projet, la sobriété du routage
(un tour Remote Control = le gros modèle du CLI), la reprise d'un fil
commencé au PC, et une interface pensée pour une main. O0 est un pont, pas
la cible — mais un pont immédiat.

## 4. Recommandation : trois paliers, chacun utile seul

### P0 — Aujourd'hui, sans code

1. Sur le PC : `cd ~/Nextcloud/dev/orgaia-fond && claude --add-dir ~/Nextcloud/dev --add-dir ~/Nextcloud/projets` puis `/remote-control`. Le projet Pilotage est déjà « la fenêtre d'où parler de tous les projets » (`docs/etude-coordination.md`) ; les `--add-dir` ouvrent les autres espaces à la lecture et à l'écriture. Variante : une session par projet actif (le `.mcp.json` du cwd ne vaut que pour le cwd).
2. Sur le téléphone : app Claude → onglet Code → la session. Mode « Accept edits ».
3. Une règle **globale** de rangement, dans `~/.claude/skills/` (un skill `depot` ou un paragraphe de `CLAUDE.md` utilisateur) : « une pièce jointe reçue depuis le téléphone est déplacée depuis `~/.claude/uploads/` vers le projet concerné, sous `<dossier d'entrée du projet>/AAAA-MM-JJ_<sujet>/HHMM_<libellé>.<ext>`, et une ligne est ajoutée au journal du projet ». Le dossier d'entrée par projet est déclaré dans son `CLAUDE.md` (`travaux/` pour la maison, `.iaction/entrants/` par défaut).
4. Déclarer `~/Nextcloud/projets/maison` comme projet IAction (pour le jour où O1 arrive, et pour `maison-rag` dès maintenant dans l'app).
5. Pour les rafales de fichiers : app Nextcloud Android, « téléverser vers » le dossier du projet.

Limites assumées : PC allumé et session lancée avant de partir ; pas de
plans ni d'images rendus ; pas de hors-ligne ; chaque écriture est validée
depuis le téléphone.

### P1 — IAction « accès distant » (la cible, ~10 jours)

**Décision préalable à griller** : amender la doctrine — « aucune API réseau
applicative » devient « **une** surface réseau, sur le réseau privé
seulement (WireGuard ou Tailscale), authentifiée par jeton, jamais exposée
sur Internet, journalisée ». Sans cet amendement, P1 n'existe pas.

**Côté poste** (`src-tauri` ou sidecar, à trancher) :

- serveur WebSocket local `ws://<ip-vpn>:<port>` qui relaie **tel quel** le
  JSON Lines au sidecar (un client distant = une « fenêtre » de plus, même
  mécanique que T-062) ; jeton long dans le trousseau, saisi une fois sur le
  téléphone ;
- deux familles de méthodes nouvelles dans le sidecar, pour ce que Rust
  faisait : `etat.lire` / `etat.ecrire` (conversations, dossier `state/`) et
  `fichiers.deposer` (chemin **dans le projet** seulement, règle de nommage,
  refus explicite hors projet) ;
- notifications : push ntfy (auto-hébergé, prévu en D2) sur fin de tour,
  question posée, échec.

**Côté téléphone** : un client PWA dédié, `ui-mobile/` (même protocole,
mêmes types partagés, `sidecar.ts` remplacé par un transport WebSocket),
quatre écrans :

```
Projets ─► Projet
           ├─ Demander   (recherche connaissances, réponse + sources)
           ├─ Converser  (fils du projet, streaming, pièces jointes,
           │              questions/permissions rendues en cartes)
           └─ Déposer    (photo/fichier/note → fichiers.deposer)
```

- photo : prise par `<input capture>`, réduite à 2048 px dans le navigateur,
  envoyée **à la fois** comme pièce jointe du message (le modèle la voit) et
  par `fichiers.deposer` (elle est rangée) ;
- permissions : lecture auto-acceptée, écriture → carte à valider ; un tour
  bloqué notifie ;
- routage sobre par défaut sur mobile (petit modèle, « approfondir » sur
  demande) ;
- voix : réutiliser la config `speech` (STT distant via OpenRouter déjà
  déclaré) ;
- hors ligne : la PWA met en cache les écrans et file les dépôts ; pas de
  conversation hors ligne.

**Observabilité** : toute requête distante porte une origine `mobile` dans le
journal consolidé ; un échec de transport est affiché et journalisé, jamais
avalé (étude logs §2.3).

**Accès réseau** : WireGuard, serveur sur le PC (ou le routeur), client
Android ; alternative Tailscale si l'ouverture d'un port UDP est refusée.
Jamais de redirection de port vers l'app.

### P2 — PC éteint : le même client servi par `ia-runner` (+3 à 5 jours)

Le runner a déjà le sidecar, le jeton et les projets en liste blanche
synchronisés. Il manque : le serveur WebSocket (le même code), le service de
la PWA derrière le vhost `automatisation` avec basic auth (précédent : un
autre service déjà exposé de cette façon), et le respect des **zones d'écriture disjointes** :
`fichiers.deposer` n'écrit que dans la zone serveur du projet, qui redescend
par la synchro. Préalable matériel : 6 Go libres sur le VPS, à élargir.

### P3 — Confort (optionnel)

Coquille Tauri 2 Android : feuille de partage système (« partager vers
IAction » depuis la galerie), notifications natives, icône. Même client
dedans.

## 5. Architecture cible (P1 + P2)

```
Téléphone (PWA ui-mobile)
   │ WebSocket + jeton, via WireGuard               (P1)
   ▼
PC : serveur WS ──► sidecar (JSON Lines, 117 méthodes + etat.* + fichiers.deposer)
                      ├─ claude.start/push (pièces jointes, permissions)
                      ├─ knowledge.search (index .iaction/)
                      └─ fichiers.deposer → <projet>/<entrée>/AAAA-MM-JJ_<sujet>/…
   │ même code                                       (P2)
   ▼
VPS : ia-runner + serveur WS derrière nginx/basic auth, projets en liste blanche,
      écritures dans la zone serveur → synchro Nextcloud → poste
```

## 6. Risques et parades

| Risque | Parade |
|---|---|
| Rouvrir « pas de surface réseau » ouvre la porte à une app en ligne | Amendement écrit et borné : VPN seulement, jeton, journal ; l'exposition Internet reste interdite pour le poste |
| Un client distant écrit n'importe où | `fichiers.deposer` borné au projet et à son dossier d'entrée, liste blanche de caractères, refus explicite |
| Double écriture PC / téléphone sur le même fil | Un fil est ouvert par un seul client à la fois (registre des fenêtres T-062 étendu aux clients distants) |
| Tour bloqué sur une permission que personne ne voit | Notification ntfy + carte en tête de l'écran Converser |
| Coût de tokens depuis le mobile | Routage petit modèle par défaut, jauge visible, plafond journalier |
| PC en veille | Interdire la veille réseau quand un client distant est connecté ; message clair sinon |
| Photos qui gonflent Nextcloud et git | Réduction par défaut, original sur demande, dossiers d'entrée hors index RAG |

## 7. Questions à trancher au grill

1. **Amender la doctrine** « aucune API réseau applicative » en « surface
   privée VPN, jeton, journal » ?
2. VPN : WireGuard (port UDP à ouvrir) ou Tailscale (relais tiers, contraire
   à « rien hors infra perso » sauf en mode DERP auto-hébergé) ?
3. Le serveur WebSocket vit dans **Rust** (coquille, un client = une fenêtre)
   ou dans le **sidecar** (headless-compatible pour P2 sans coquille) ?
   Pressenti : sidecar, derrière une option explicite.
4. Déclarer `projets/maison` comme projet IAction ?
5. Dossier d'entrée par projet : convention unique (`.iaction/entrants/`)
   ou déclaré par projet dans son `CLAUDE.md` ?
6. P0 d'abord deux semaines pour apprendre, ou P1 tout de suite ?

## 8. Effort

| Palier | Effort | Livré |
|---|---|---|
| P0 | 1 h + une règle de rangement | tous les projets depuis l'app Claude, photos rangées |
| P1 | ~10 j : transport WS + jeton (2), `etat.*` et `fichiers.deposer` (2), PWA 4 écrans (4), ntfy + VPN + tests (2) | le vrai IAction mobile, sur le réseau privé |
| P2 | 3-5 j | PC éteint pour les projets en liste blanche |
| P3 | 3 j | partage système, notifications natives |

Décisions de non-faire : application native, interface de bureau servie
telle quelle, exposition Internet du poste, édition de code ou de
configuration depuis le téléphone.

Cas particulier documenté à part : le chantier de la maison
(`orgaia/docs/etude-app-chantier.md`), qui ajoute des besoins propres
(plans SVG tactiles, hors-ligne en cave) couverts par le site `maison.local`,
hors IAction.
