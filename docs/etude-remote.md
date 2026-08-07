# Étude — Exécution distante (OVH) & multi-poste Windows/Linux

> Rédigée le 2026-08-05, **validée au grill le 2026-08-05**.
> Sujet : exécuter des tâches d'agent sur le serveur OVH pendant que le PC est
> éteint, et utiliser l'app sur Windows et Linux avec le même contexte projet.
> **Sans mise en ligne de l'application** : aucun mode serveur du sidecar,
> aucune API réseau applicative.

## 1. Objectif & réussite

- **Réussi quand (jalon)** : les deux volets opérationnels —
  1. une tâche réelle s'exécute sur OVH à l'heure prévue, PC éteint, et son
     rapport apparaît dans l'app au rallumage ;
  2. l'app tourne sous Windows (installeur) avec le même contexte `.iaction/`
     que le poste Linux.
- L'app Android (« parler avec mes projets ») est **hors périmètre** de cette
  étude ; elle exigerait une surface réseau applicative — à regriller le jour
  venu.

## 2. Périmètre (axe 1, tranché 2026-08-05)

**Déclencheurs couverts côté serveur** (les quatre retenus) :

| Déclencheur | Description |
|---|---|
| Planifié (cron) | tâches récurrentes type ménage-mails, rapports |
| « Lancer puis éteindre » | une tâche soumise depuis l'app part sur OVH ; on peut éteindre le PC |
| Indexation RAG | le serveur maintient `connaissances-index/` des projets éligibles |
| Externe | **webhooks** (GitHub, etc.) + **conditions périodiques** (fichier, RSS, page web) — pas de déclencheur mail entrant ni bot de messagerie |

- **Projets : liste blanche explicite.** Seuls les projets déclarés
  « éligibles serveur » sont synchronisés sur OVH. Ajout au cas par cas.
- **Multi-poste Windows : le contexte partagé = `.iaction/` uniquement**
  (agents, orchestrations, connaissances, index RAG, tâches, rapports) — déjà
  couvert par la synchro Nextcloud des postes. Les conversations et sessions
  Claude restent propres à chaque poste (les sessions du CLI sont indexées par
  chemin absolu du cwd : non transposables entre `/home/...` et `D:\...`).

## 3. Synchro du contexte (axe 2, tranché 2026-08-05)

- **Nextcloud est hébergé chez un fournisseur tiers**, sur le serveur `cloud.example.net`
  (relevé 2026-08-05 : installation native nginx + php-fpm + MariaDB + Redis,
  `/var/www/nextcloud`). `ia-runner` tournant sur le VPS `automatisation`
  (§4), la synchro est du **WebDAV inter-serveurs OVH** — pas « quasi locale »
  comme supposé au grill, mais latence réseau OVH↔OVH faible ; à mesurer en D1.
- **Mécanisme** : client Nextcloud headless (`nextcloudcmd` en boucle ou
  `rclone bisync` WebDAV) sur les seuls dossiers de la liste blanche.
- **Contenu** : le **dossier projet complet** (les tâches et l'indexation
  voient le même monde qu'en local : sources, `CLAUDE.md`, `.claude/`,
  `.mcp.json`).
- **Règle d'or anti-conflits : zones d'écriture disjointes.** Le serveur
  n'écrit QUE dans ses zones (`.iaction/rapports/`, journal, index RAG, état
  des demandes, événements d'usage) ; l'utilisateur n'édite pas ces zones.
  **Conséquence assumée** : une tâche serveur ne modifie jamais les sources du
  projet — elle produit des rapports.

### 3 bis. Les tâches ne vivent pas dans le projet (découvert en D1)

Le grill supposait que les tâches suivaient les projets. **Elles n'y sont
pas** : `sidecar/src/taches.ts:61` les place dans la configuration GLOBALE de
la machine — `${XDG_CONFIG_HOME:-~/.config}/net.duvam.iaction/taches/<nom>/`
— avec un champ `cwd` qui pointe le projet. Cette racine n'est donc pas
synchronisée, et les rapports, qui vivent à côté du manifeste
(`<tacheDir>/rapports/`), ne le sont pas davantage.

Conséquences pour D1 :

- **Une seconde racine, synchronisée, pour les tâches serveur** :
  `IA_RUNNER_TACHES_DIR`, dossier Nextcloud dédié. Les rapports y étant écrits
  par construction, ils redescendent seuls jusqu'au poste — la mécanique
  d'affichage de l'app (`taches.reports` lit des fichiers) n'a rien à savoir.
- **Champ `lieu: local | serveur`** dans `tache.yaml` (défaut `local`). Le
  runner n'exécute que les tâches `serveur` **et** `enabled: true`. C'est le
  garde-fou anti-double-déclenchement, avancé de D3 à D1 parce que le
  planificateur du serveur en a besoin dès le premier run.
- **Le `cwd` absolu du poste n'existe pas sur le serveur.** Le runner résout
  le projet sous `IA_RUNNER_PROJETS_DIR` (par nom de dossier, ou via un champ
  `projet` prioritaire) et **échoue explicitement** s'il ne trouve pas —
  jamais de repli silencieux sur un autre répertoire.
- **Reste à faire (D3)** : côté UI, savoir lire/écrire les deux racines et
  afficher le lieu d'exécution. En D1 la racine serveur se peuple à la main.

## 4. Serveur & exécuteur (axe 3, tranché 2026-08-05)

- Machines candidates (relevé du 2026-08-05, deux serveurs déjà en service) :
  - un **serveur de stockage** portant le Nextcloud en natif : beaucoup de
    disque, peu de RAM, Docker trop ancien et sans droits pour l'utilisateur
    non privilégié — écarté ;
  - un **VPS d'automatisation** : Docker récent et utilisable sans privilèges,
    RAM confortable, nginx hôte déjà en reverse proxy TLS, sous-domaine dédié
    déjà pointé dessus.
- **Machine retenue pour `ia-runner` : le VPS d'automatisation** — c'est le seul
  des deux où Docker est utilisable, et sa vocation est déjà celle-là.
  ⚠️ Disque : la place libre est le point à surveiller, selon la taille des
  projets en liste blanche.
- Forme : **conteneur permanent `ia-runner`** dans le docker-compose existant,
  image versionnée dans le dépôt iaction. Il embarque :
  - `node` + `sidecar/dist` + le runner headless (réutilisation directe de
    `scripts/orch-run-headless.mjs`, déjà éprouvé par les timers systemd T2) ;
  - **supercronic** pour le planifié (lecture des `tache.yaml`) ;
  - une boucle de surveillance des **fichiers de demande** (§6) ;
  - le récepteur **webhook** (derrière le reverse proxy, §8) et l'évaluateur
    de **conditions périodiques**.
- **Garde-fous** : exécution **séquentielle** (une tâche à la fois, file
  d'attente), **timeout 30 min** hérité du runner, surchargable par tâche dans
  son manifeste.

## 5. Auth & secrets (axe 4, tranché 2026-08-05)

- **LLM : jeton d'abonnement Claude** (`claude setup-token`), coût marginal
  nul. ⚠️ Les tâches serveur consomment les fenêtres 5 h / hebdo de
  l'abonnement — surveillance via la remontée d'usage (§7) ; si une tâche
  s'avère gourmande, bascule possible vers une clé API plafonnée (décision
  reportée, cas par cas).
- **Secrets serveur** (jeton Claude, secret webhook HMAC, IMAP du
  ménage-mails, identifiants WebDAV) : **fichier `.env` chmod 600** à côté du
  compose, hors dépôt et hors Nextcloud. Le trousseau OS n'existe pas en
  headless ; les replis env existent déjà (`ANTHROPIC_API_KEY` hérité,
  `IMAP_PASSWORD`).

## 6. Canal « lancer puis éteindre » (design proposé, à valider en phase D4)

Aucune API réseau : le canal est **fichier + synchro**.

- L'app dépose `.iaction/taches/demandes/<uuid>.yaml` (tâche ou orchestration,
  inputs, timeout) → synchro Nextcloud → le runner la détecte (< 1-2 min),
  l'exécute, écrit `etat: en-cours|fini|echec` dans **sa** zone
  (`demandes-etat/`), plus rapport et journal habituels.
- L'app affiche l'état de la demande dans l'onglet Tâches (badge comme les
  rapports non lus). PC rallumé = état à jour par simple synchro.

## 7. Observabilité (axe 6, tranché 2026-08-05)

Application du principe « aucun échec muet » (cf. `etude-logs.md`) :

- **Rapports + journal** synchronisés comme aujourd'hui (zones serveur).
- **Notification push d'échec** via **ntfy auto-hébergé** (service dans le
  même compose, app ntfy sur le téléphone). Échecs seulement, pas de bruit.
- **Heartbeat** : le runner horodate un fichier d'état synchronisé toutes les
  N minutes ; au démarrage, l'app alerte si ce fichier est trop vieux (couvre
  conteneur mort, synchro cassée, serveur éteint — le cas qui ne produit même
  pas de rapport).
- **Usage** : le runner écrit ses événements d'usage (tours, tokens, fenêtres
  abo) dans une zone synchronisée pour que la page Supervision agrège la
  consommation serveur — sinon l'abonnement se vide « invisiblement » la nuit.

## 8. Risques & sécurité (axe 7, tranché 2026-08-05)

| Risque | Traitement |
|---|---|
| Webhook = seule surface réseau entrante | Passe par le **reverse proxy TLS existant**, sur l'adresse dédiée **`https://automatisation.example.net/`** (choisie le 2026-08-05 ; DNS déjà en place), chemin non devinable, **signature HMAC** vérifiée (GitHub signe nativement). Vhost + certificat Let's Encrypt à créer (le proxy répond aujourd'hui avec le certificat de `git.example.net`) |
| Jeton d'abonnement présent sur le serveur | `.env` 600, hors synchro ; révocable ; serveur déjà de confiance (il héberge Nextcloud) |
| Fenêtres d'abonnement vidées la nuit | remontée d'usage (§7) + bascule clé API plafonnée si besoin |
| Agent qui déborde côté serveur | confiné au conteneur ; zones d'écriture disjointes ; séquentiel + timeout |
| Conflits de synchro | zones disjointes (structurellement impossibles en marche normale) |
| Panne silencieuse | heartbeat + ntfy |
| Plan B | les timers systemd locaux (T2) sont **conservés** : toute tâche peut revenir en local en désarmant côté serveur et réarmant côté poste |

**Amendement de doctrine** : le principe « aucun envoi hors du poste »
(`etude-logs.md`) devient « aucun envoi hors de **l'infra personnelle**
(postes + serveur OVH) ». Aucun service tiers n'entre dans la boucle
(ntfy auto-hébergé inclus).

## 9. Portage Windows (axe 5, tranché 2026-08-05)

- **Ambition : parité complète sauf planification locale** — la planification
  vit sur OVH ; aucun équivalent Task Scheduler à écrire. La voix fonctionne
  (WebView2 gère `getUserMedia` ; STT/TTS sidecar = Node pur).
- **Cible : PC perso, via un vrai installeur** (MSI/NSIS `tauri build`) — ce
  qui tire le chantier packaging : embarquer `sidecar/dist` en ressource Tauri
  (aujourd'hui chemin figé à la compilation, TODO connu dans
  `src-tauri/src/sidecar.rs`).
- **Travaux identifiés** :
  1. corriger les deux recalculs XDG faits à la main — le Rust doit passer son
     `app_data_dir` au sidecar (`sidecar/src/chatHistory.ts:37`,
     `sidecar/src/usageStats.ts:93` liraient dans le vide sous Windows) ;
  2. remplacer le repli `xdg-open` (`src-tauri/src/open_external.rs`) ;
  3. cfg-gater le code webkit2gtk (autorisation micro) Linux-only ;
  4. vérifier trousseau (`windows-native` déjà activé) et presse-papier
     (arboard) ;
  5. griser l'UI des timers locaux hors Linux (tâches = serveur).

## 10. Phasage D1→D6 (axe 8 : OVH d'abord, Windows ensuite)

- **D1 — Socle serveur** : image `ia-runner` + compose + `.env` + synchro
  liste blanche + **tâche témoin** (rapport horodaté). Réussi quand le rapport
  témoin apparaît dans l'app au rallumage.
  ✅ **Code complet le 2026-08-05** — builds et tests verts, image construite
  localement puis supprimée. **Rien n'est déployé** : la mise en service est
  une décision de l'utilisateur (voir « Avant le premier lancement » ci-dessous).
  - `docker/ia-runner/` : image en 4 étapes (Node 22 épinglé, rclone et
    supercronic vérifiés en SHA-256, non-root uid 10001, **727 Mo** après
    élagage de la pile voix — inutile à un runner headless), compose
    (séquentiel, `mem_limit` 3 Go, `cap_drop: ALL`, logs plafonnés, aucun port
    publié), `.env.example` commenté, README de déploiement.
  - `bin/` : `plan-cron.mjs` (OnCalendar → cron), `run-tache.mjs` (verrou,
    sync, résolution projet, timeout, état, notification), `sync-down.sh` /
    `sync-up.sh` (filtres de zones), `entrypoint.sh` (crontab, boucle de
    synchro, heartbeat, `exec supercronic`).
  - `assets/taches/temoin-serveur/` : gabarit du cobaye — agent
    `claude-haiku-4-5` (le moins cher), lecture seule, verdict `OK`/`ANOMALIE`
    en première ligne. Livré désarmé.
  - Champ `lieu` **first-class** de bout en bout (sidecar, UI, protocole,
    tests) : un bug de perte silencieuse a été trouvé et corrigé au passage —
    le chemin d'écriture structuré de l'app re-sérialise le manifeste et
    aurait effacé `lieu: serveur` à la première édition, faisant cesser
    l'exécution serveur sans aucun signal.
  - Découverte intégrée : racine des tâches globale, d'où la seconde racine
    synchronisée (§ 3 bis).

  **Limites assumées de D1** (à lever en D2/D3) :
  - notifications ntfy écrites mais **inertes** (`NTFY_URL` vide) — le service
    arrive en D2 ; le chemin n'a donc jamais été éprouvé contre un vrai serveur ;
  - synchro montante en `rclone copy` et non `sync` : un fichier supprimé sur
    le poste **subsiste** côté serveur. Prudence délibérée pour un premier
    jet ; à revoir si les volumes dérivent ;
  - les fichiers d'état (`dernier/<nom>.json`, `executions/<nom>/<iso>.json`)
    ne sont lus par **aucun** code de l'app — c'est le travail de D2 ;
  - `node_modules/**` exclu de la descente des projets ; `.git` **ne l'est
    pas** — à trancher si les 24 Go du VPS deviennent justes ;
  - la racine serveur des tâches se peuple **à la main** (l'UI ne connaît
    qu'une racine : D3).

  **Avant le premier lancement** (actions utilisateur) : créer
  `iaction/serveur/{taches,projets}` dans Nextcloud ; `claude setup-token`
  sur le poste → `CLAUDE_CODE_OAUTH_TOKEN` ; mot de passe d'application
  Nextcloud → `rclone obscure` → `.env` en **chmod 600** ; sur le VPS
  `df -h /` (prévoir ~4 Go + les projets) puis `docker compose build && up -d` ;
  installer le témoin, le roder à la main, puis `enabled: true` ; enfin
  **désarmer le timer systemd local** de toute tâche migrée
  (`systemctl --user disable --now iaction-tache-<nom>.timer`).
- **D2 — Observabilité** : ntfy + heartbeat + remontée d'usage. Réussi quand
  un échec provoqué notifie le téléphone et qu'un arrêt du conteneur est
  signalé à l'ouverture de l'app.
- **D3 — Migration du planifié** : cobaye **indexation RAG** d'un projet de la
  liste blanche, puis **ménage-mails** ; champ « lieu d'exécution »
  (`local|serveur`) dans `tache.yaml` + UI ; désarmement du timer systemd
  local à la migration (jamais les deux armés).
- **D4 — « Lancer puis éteindre »** : fichiers de demande (§6) + suivi d'état
  dans l'onglet Tâches.
- **D5 — Déclencheurs externes** : webhook reverse proxy + HMAC, conditions
  périodiques.
- **D6 — Portage Windows** : travaux du §9, installeur, vérification du
  contexte partagé sur un projet réel.

## 11. Inconnues / à vérifier

| Sujet | Quand |
|---|---|
| ~~OS, Docker, reverse proxy, répartition des machines~~ **levé le 2026-08-05** (relevé SSH, voir §4) : deux machines, `ia-runner` sur le VPS `automatisation`, nginx hôte en reverse proxy | — |
| Latence/robustesse de la synchro WebDAV inter-serveurs (VPS ↔ serveur de stockage) | D1 |
| Espace disque du VPS (24 Go libres) vs taille des projets en liste blanche | D1 |
| Vhost + certificat Let's Encrypt pour `automatisation.example.net` (nginx répond aujourd'hui avec le certificat de `git.example.net`) | avant D5 (webhooks) |
| Latence et robustesse réelles de `nextcloudcmd`/`rclone bisync` en boucle | D1 |
| Durée de vie / renouvellement du jeton `claude setup-token` | D1 |
| CGU Anthropic : usage perso du jeton d'abonnement en headless (même question déjà tranchée « OK perso » pour le poste, à confirmer pour le serveur) | avant D3 |
| Consommation abo réelle des tâches nocturnes (relevés D2) | fin D3 |
