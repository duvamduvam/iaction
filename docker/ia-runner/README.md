# `ia-runner` — exécuteur de tâches côté serveur

Conteneur qui exécute les tâches d'agent iaction **pendant que le PC est
éteint**, puis renvoie ses rapports au poste par Nextcloud. C'est le socle de
la tranche **D1** de [docs/etude-remote.md](../../docs/etude-remote.md) ; lisez
l'étude d'abord si vous voulez le pourquoi, ce fichier ne donne que le comment.

Ce que fait le conteneur, en boucle :

1. **descend** (rclone/WebDAV) les tâches et les projets de la liste blanche
   depuis le Nextcloud du serveur de stockage vers `/data` ;
2. **planifie** (supercronic) les tâches dont le manifeste dit
   `lieu: serveur` et `enabled: true` ;
3. **exécute** au moment venu, séquentiellement, via le runner headless
   `scripts/orch-run-headless.mjs` — le même que les timers systemd du poste ;
4. **remonte** rapports, journal et état vers Nextcloud.

> **Règle d'or** : le serveur n'écrit QUE dans ses zones (rapports, journal,
> état, index). Une tâche serveur ne modifie jamais les sources d'un projet —
> elle produit des rapports. C'est ce qui rend les conflits de synchro
> structurellement impossibles.

---

## 1. Prérequis

**Sur le serveur** (cible : VPS OVH `automatisation`, Ubuntu, Docker 28) :

- Docker ≥ 24 avec le plugin `compose` v2, utilisable sans `sudo` ;
- **~4 Go de disque libre** pour l'image et le cache de build, **plus** la
  taille des projets de la liste blanche. La machine n'a que 24 Go de libre :
  vérifiez avec `df -h /` avant de commencer, et videz le cache de build après
  (`docker builder prune -f`, cf. § 6) ;
- accès sortant HTTPS (registre npm, GitHub, API Anthropic, WebDAV du Nextcloud).

**Sur le poste** : le dépôt iaction et le CLI `claude` connecté à votre
abonnement (pour fabriquer le jeton, § 3).

**Côté Nextcloud** (serveur `cloud.example.net`) : deux dossiers à créer, qui
seront les racines synchronisées :

```
iaction/serveur/taches/     ← manifestes des tâches serveur + leurs rapports
iaction/serveur/projets/    ← projets de la liste blanche
```

> ⚠️ **Les tâches ne vivent pas dans les projets.** Sur le poste, elles sont
> dans `~/.config/net.duvam.iaction/taches/`, qui n'est PAS synchronisé.
> `iaction/serveur/taches/` est une **seconde racine**, celle du serveur —
> voir § 3 bis de l'étude. En D1, on la peuple à la main.

---

## 2. Récupérer le dépôt sur le serveur

Au choix, dans le répertoire de travail de l'utilisateur Docker (ex. `~/apps`) :

```bash
git clone <url-du-dépôt> iaction     # depuis Gitea ou GitHub
# ou, depuis le poste, sans dépôt distant :
rsync -a --exclude node_modules --exclude src-tauri/target \
      ~/Nextcloud/dev/iaction/ automatisation:~/apps/iaction/
```

Tout ce qui suit se passe dans `iaction/docker/ia-runner/`.

---

## 3. Jeton Claude (`claude setup-token`)

Le trousseau du système n'existe pas en headless : l'authentification du
serveur passe par un **jeton d'abonnement**, à fabriquer **sur le poste** :

```bash
claude setup-token
```

La commande ouvre le navigateur, vous confirmez, et elle affiche un jeton
`sk-ant-oat01-…`. Copiez-le dans `CLAUDE_CODE_OAUTH_TOKEN` du `.env` (§ 5).

À savoir :

- ce jeton **consomme les fenêtres 5 h / hebdomadaire de votre abonnement** :
  ce que le serveur brûle la nuit, vous ne l'avez plus le matin. C'est la
  raison d'être de la remontée d'usage prévue en D2 ;
- sa durée de vie exacte reste une inconnue de D1 : si les tâches se mettent à
  échouer sur une erreur d'authentification, régénérez-le et relancez
  (`docker compose up -d`, § 6) ;
- si une tâche s'avère trop gourmande, on bascule au cas par cas vers une clé
  API plafonnée (`ANTHROPIC_API_KEY` dans le `.env`, à la place du jeton).

---

## 4. Remote rclone vers le Nextcloud

Le remote est décrit **entièrement par des variables d'environnement** — pas de
`rclone.conf` à monter, donc un seul endroit où vivent les secrets.

> **Ordre pratique** : les commandes ci-dessous s'exécutent *dans* l'image, il
> faut donc un `.env` existant (§ 5, même incomplet) et l'image construite
> (§ 6). Enchaînement : copier le `.env` → `docker compose build` → revenir
> ici obscurcir le mot de passe et tester → `docker compose up -d`.

1. Dans Nextcloud (Paramètres → Sécurité), créez un **mot de passe
   d'application** dédié à `ia-runner` (révocable sans toucher au compte).
2. Obscurcissez-le — rclone refuse un mot de passe en clair. Une fois l'image
   construite (§ 6) :

   ```bash
   docker compose run --rm --entrypoint rclone ia-runner obscure 'le-mot-de-passe'
   ```

3. Reportez le résultat dans `RCLONE_CONFIG_NEXTCLOUD_PASS`, avec l'URL et
   l'utilisateur (voir `.env.example`).
4. Vérifiez la liaison :

   ```bash
   docker compose run --rm --entrypoint rclone ia-runner lsd nextcloud:iaction/serveur
   ```

   Vous devez voir `taches` et `projets`. Une erreur 401 = mot de passe ou
   utilisateur ; un 404 = les dossiers ne sont pas créés côté Nextcloud.

> **Latence** : la synchro est du WebDAV entre deux machines OVH (VPS ↔
> serveur de stockage), pas un accès local. C'est l'une des inconnues à mesurer en D1 : si
> un projet volumineux met plusieurs minutes à descendre, réduisez la liste
> blanche plutôt que d'augmenter la cadence.

---

## 5. Le fichier `.env`

```bash
cd ~/apps/iaction/docker/ia-runner
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

`.env.example` documente chaque variable. Les impératifs :

- **chmod 600**, propriétaire = l'utilisateur qui lance `docker compose` ;
- **hors dépôt** (`.gitignore` le couvre) et **hors Nextcloud** : ce fichier
  porte le jeton Claude, le mot de passe WebDAV, et plus tard le secret HMAC du
  webhook et le mot de passe IMAP. Il ne se sauvegarde pas dans un dossier
  synchronisé — il se **régénère** (les secrets sont tous révocables) ;
- pas de guillemets autour des valeurs, `docker compose` les prendrait pour des
  caractères de la valeur.

---

## 6. Construire et lancer

```bash
cd ~/apps/iaction/docker/ia-runner
docker compose build          # ~5-10 min la première fois
docker compose up -d
docker builder prune -f       # libère le cache de build (~2 Go) : disque compté
```

Ce que le build fait, et pourquoi c'est un peu long : il compile le sidecar
TypeScript, installe l'arbre npm de production, puis **élague les dépendances
de voix** (`@huggingface/transformers`, `kokoro-js`, onnxruntime, sharp — env.
1,3 Go) qui ne servent qu'au micro et au haut-parleur de l'application de
bureau. Le runner n'a ni l'un ni l'autre, et surtout ces paquets téléchargent
des modèles de plusieurs centaines de Mo au premier usage : sur un disque de
24 Go, on ne prend pas ce risque. Le détail est commenté dans le `Dockerfile`.

**Taille attendue** (mesurée sur un build réel) : **~730 Mo** d'image, dont
311 Mo de `node_modules` (l'arbre npm fait 2,0 Go avant élagage), ~250 Mo pour
le binaire du CLI Claude embarqué par le SDK, le reste étant la base Node,
rclone et supercronic.

Le build vérifie tout seul trois choses avant de produire l'image : les sommes
de contrôle SHA-256 de rclone et supercronic, la présence des dépendances de
production après élagage, et un **test de fumée** — le sidecar élagué doit
démarrer et annoncer `ready`. Si l'un échoue, le build s'arrête ; il n'y a pas
de scénario où une image cassée arrive jusqu'au serveur.

### Stockage

Les données vivent dans le volume nommé `ia-runner_ia-runner-data`, monté sur
`/data` :

| Chemin | Contenu | Qui écrit |
|---|---|---|
| `/data/taches` | manifestes `tache.yaml` + `rapports/` | serveur (synchronisé) |
| `/data/projets` | projets de la liste blanche | poste (synchronisé) |
| `/data/etat` | journal, heartbeat, état des demandes, usage, caches | serveur |
| `/data/home` | état du CLI Claude (`~/.claude`) | serveur |

Le conteneur tourne en **utilisateur non-root** (uid/gid 10001). Un volume
nommé hérite automatiquement des bons droits. Si vous préférez un **bind
mount** (pour poser `/data` sur un autre disque), il faut le chowner
vous-même avant le premier démarrage :

```bash
sudo mkdir -p /srv/ia-runner/data
sudo chown -R 10001:10001 /srv/ia-runner/data
# puis, dans docker-compose.yml : - /srv/ia-runner/data:/data
```

---

## 7. Vérifier que ça tourne

```bash
docker compose ps                     # ia-runner « Up »
docker compose logs -f --tail=100     # boucle de synchro + planification
docker compose exec ia-runner date    # doit afficher l'heure de Paris
docker compose exec ia-runner ls -la /data/taches /data/projets
```

Signes de bonne santé : une passe de synchro qui se termine sans erreur, la
liste des tâches planifiées annoncée par le planificateur, et l'apparition des
dossiers de projets sous `/data/projets`.

Le vrai jalon de D1 reste **le rapport témoin qui apparaît dans l'app au
rallumage du poste** — voir le gabarit versionné
[`assets/taches/temoin-serveur/`](../../assets/taches/temoin-serveur/) et son
README : c'est la tâche à installer en premier.

---

## 8. Où sont les journaux

| Quoi | Où | Comment le lire |
|---|---|---|
| Sortie du conteneur (synchro, planification, runs) | journal Docker, plafonné à 3 × 10 Mo | `docker compose logs -f` |
| Journal applicatif du sidecar (`app.jsonl`) | `/data/etat/config/net.duvam.iaction/logs/app.jsonl` | `docker compose exec ia-runner tail -f …` |
| Rapports des tâches | `/data/taches/<tâche>/rapports/<date>.md`, redescendus dans Nextcloud | dans l'app, onglet Tâches |

Le journal applicatif suit le contrat de `docs/etude-logs.md` : une ligne JSON
par événement, jamais de secret ni de contenu de prompt.

---

## 9. Armer / désarmer une tâche

Une tâche n'est exécutée par le serveur que si son `tache.yaml`, **dans la
racine serveur** (`iaction/serveur/taches/<nom>/` côté Nextcloud), porte les
deux champs :

```yaml
lieu: serveur     # `local` (défaut) = le conteneur l'ignore
enabled: true     # désarmée tant que ce n'est pas vrai
schedule: "*-*-* 08:15"   # syntaxe OnCalendar systemd, convertie en cron
```

- **Armer** : passer `enabled: true`, attendre la prochaine passe de synchro
  (≤ `IA_RUNNER_SYNC_INTERVAL_SEC`, 2 min par défaut) — le planificateur
  recharge son plan tout seul.
- **Désarmer** : repasser `enabled: false` (ou `lieu: local`). Même délai.
- **Rodage** : ne jamais armer une tâche qui n'a pas produit au moins un
  rapport correct lancé à la main.

> ### 🚨 Garde-fou : jamais armée des deux côtés
>
> Une tâche ne doit **JAMAIS** être armée simultanément en timer systemd sur le
> poste et en `lieu: serveur` sur le conteneur : elle tournerait deux fois, avec
> deux rapports concurrents pour la même date, et consommerait le double
> d'abonnement. À chaque migration d'une tâche vers le serveur, **désarmez
> d'abord le timer local** :
>
> ```bash
> systemctl --user disable --now iaction-tache-<nom>.timer
> systemctl --user list-timers 'iaction-*'     # doit être vide pour cette tâche
> ```
>
> Le chemin inverse est le plan B officiel : en cas de panne serveur, on
> repasse `lieu: local` et on réarme le timer du poste.

---

## 10. En cas d'échec

| Symptôme | Piste |
|---|---|
| `docker compose up` refuse de démarrer : `.env` introuvable | vous n'êtes pas dans `docker/ia-runner/`, ou le fichier s'appelle encore `.env.example` |
| Le conteneur redémarre en boucle | `docker compose logs --tail=200` : presque toujours une variable manquante ou un remote rclone invalide |
| `401` / `403` sur la synchro | mot de passe d'application révoqué, ou `RCLONE_CONFIG_NEXTCLOUD_PASS` non obscurci (§ 4) |
| Aucune tâche planifiée | `lieu` absent ou `local`, `enabled: false`, ou `schedule` vide ; vérifiez que le manifeste est bien descendu : `docker compose exec ia-runner cat /data/taches/<nom>/tache.yaml` |
| Erreur d'authentification du modèle | jeton expiré → régénérer (§ 3), mettre à jour le `.env`, `docker compose up -d` |
| Le projet est introuvable au lancement d'une tâche | le `cwd` absolu du poste n'existe pas ici : renseignez le champ `projet` du manifeste, et vérifiez que le dossier est bien sous `/data/projets` (donc dans la liste blanche synchronisée) |
| Rapport produit mais invisible dans l'app | la remontée n'a pas eu lieu : regardez la dernière passe de synchro dans les logs, puis le dossier côté Nextcloud |
| Disque plein sur le VPS | `df -h /`, puis `docker builder prune -f`, `docker image prune -f` ; en dernier ressort, retirez un projet de la liste blanche |
| Rien du tout, pas même une erreur | c'est exactement le cas que le **heartbeat** de D2 doit couvrir. En attendant : `docker compose ps` et la date du dernier fichier écrit dans `/data/etat` |

Arrêt propre (laisse à un run en cours 60 s pour s'annuler) :

```bash
docker compose down
```

Mise à jour après un `git pull` :

```bash
docker compose build && docker compose up -d
```

Le volume `/data` survit à un `down`/`build`/`up` : seul
`docker compose down -v` le détruirait — ce qui effacerait les rapports non
encore remontés.

---

## 11. Ce qui n'est pas encore là

D1 pose le socle ; le reste est explicitement hors périmètre pour l'instant :

- **D2** — ntfy (notification d'échec sur le téléphone), heartbeat, remontée
  d'usage. L'emplacement du service ntfy est déjà réservé, en commentaire, dans
  `docker-compose.yml` ;
- **D4** — canal « lancer puis éteindre » (fichiers de demande) ;
- **D5** — webhooks : **rien n'écoute sur le réseau en D1**, aucun port n'est
  publié. Le jour venu, la surface entrante passera par le nginx de l'hôte
  (vhost `automatisation.example.net` + certificat Let's Encrypt à créer) avec
  vérification HMAC — jamais par une exposition directe du conteneur.
