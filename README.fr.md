# IAction — présentation française

Application desktop (Tauri) rétro-futuriste néon pour piloter le développement assisté par IA
à travers plusieurs fournisseurs (abonnement Claude, OpenRouter, Ollama, endpoints
OpenAI-compatibles), organisée par projets liés à un répertoire.

> Présentation détaillée des fonctionnalités : [README.md](README.md) (anglais).
> Plan produit complet : [docs/plan.md](docs/plan.md).
> Backlog (corrections et fonctionnalités à venir) : [docs/tickets.md](docs/tickets.md).

## Installation

**[⬇️ Télécharger la dernière version](https://github.com/duvamduvam/iaction/releases/latest)** — rien à compiler, ni Node ni Rust à installer.

| Plateforme | Fichier | À savoir |
|---|---|---|
| **Linux** | `IAction_<version>_amd64.AppImage` | `chmod +x` puis lancer. Autonome. |
| **Windows** | `IAction_<version>_x64-setup.exe` | Installation **pour l'utilisateur courant** (`%LOCALAPPDATA%`) — **aucun droit d'administration**. |

L'installeur Windows n'est pas signé : Windows affiche « Windows a protégé votre
ordinateur » au premier lancement. Choisir **Informations complémentaires →
Exécuter quand même**.

### Avant le premier tour d'agent

L'application démarre sans rien de tout cela ; c'est chaque moteur qui a ses exigences.

| Pour utiliser… | Il faut |
|---|---|
| **Claude (abonnement)** | [Claude Code](https://code.claude.com/docs/en/setup) installé et connecté (`claude login`) — c'est votre propre abonnement qui travaille. |
| **Des agents qui lancent des commandes** | Sous Windows : [Git for Windows](https://git-scm.com/download/win). Claude Code y prend le shell de son outil `Bash`, et le moteur neutre lance ses commandes par `sh`. |
| **OpenRouter / Ollama / endpoint OpenAI-compatible** | Une clé API (ou un Ollama qui tourne), à renseigner dans **Configuration → Fournisseurs**. |

### Facultatif : la voix locale

La dictée et la synthèse LOCALES ne sont **pas embarquées** — la pile
d'inférence pèse 1,2 Go, plus que tout le reste réuni. Elle s'installe une fois,
à côté des données de l'application :

```bash
# Linux — le chemin exact est rappelé dans Configuration → Voix
mkdir -p ~/.local/share/net.duvam.iaction/voix-locale && cd $_
npm init -y && npm install kokoro-js @huggingface/transformers
```

```powershell
# Windows
mkdir "$env:LOCALAPPDATA\net.duvam.iaction\voix-locale"; cd "$env:LOCALAPPDATA\net.duvam.iaction\voix-locale"
npm init -y; npm install kokoro-js @huggingface/transformers
```

Redémarrer l'application : les boutons micro et conversation apparaissent. Tant
qu'elle manque, ils restent **masqués** plutôt que de tomber en panne, et les
moteurs de voix distants fonctionnent quoi qu'il arrive. Les modèles se
téléchargent au premier usage dans `~/.cache/iaction/models`.

### État par plateforme

- **Linux** : plateforme de développement, utilisée quotidiennement.
- **Windows** : installeur construit par la CI, **exécution pas encore validée
  par un humain**. Toute la suite de tests passe sur un runner Windows et les
  chemins suivent `%APPDATA%`/`%LOCALAPPDATA%`. Les **tâches planifiées restent
  Linux** (timers systemd) — l'application le dit explicitement au lieu
  d'échouer.
- **macOS** : ni testé ni construit.

## Architecture

```
UI React (ui/)  ⇄  IPC Tauri  ⇄  cœur Rust mince (src-tauri/)  ⇄  stdio JSON Lines  ⇄  sidecar Node (sidecar/)
```

- **ui/** — front React + Vite, thème néon (tokens CSS).
- **src-tauri/** — coquille Tauri 2 : fenêtre, spawn/supervision du sidecar, relais du protocole.
- **sidecar/** — process Node : moteurs IA (Claude Agent SDK + moteur neutre OpenAI-compatible).
- Protocole UI⇄Rust⇄sidecar : [docs/protocol.md](docs/protocol.md).

## Prérequis (Linux)

- Node ≥ 22, Rust stable, et les dépendances système Tauri :

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
```

## Développement

Pour seulement UTILISER l'application, voir « Installation » ci-dessus — rien de
ce qui suit n'est nécessaire.

```bash
npm install            # workspaces ui + sidecar
npm run sidecar:build  # compile le sidecar (obligatoire avant le premier run)
npm run dev            # tauri dev (compile Rust, lance Vite + la fenêtre)
```

Tests du sidecar (sans Tauri) : `npm run sidecar:test`.

Produire les installeurs soi-même : `npm run build:linux` /
`npm run build:windows` (ce dernier doit tourner SUR Windows — Tauri ne compile
pas d'une plateforme à l'autre). Tout est détaillé dans
[docs/empaquetage.md](docs/empaquetage.md).

### Pièges d'environnement connus (Linux)

- **Terminal VSCode installé via Snap** : les variables injectées (`GTK_PATH`,
  `GDK_PIXBUF_MODULE_FILE`…) font crasher le binaire Tauri au lancement
  (`symbol lookup error: /snap/core20/... GLIBC_PRIVATE`). Utiliser
  `./scripts/dev.sh`, qui nettoie l'environnement avant `npm run dev`.
- **Repo dans un dossier synchronisé Nextcloud** : le client Nextcloud surveille
  `node_modules/` et `target/` et peut épuiser les watchers inotify
  (`OS file watch limit reached` au `tauri dev`). Correctifs :
  - relever la limite : `sudo sysctl fs.inotify.max_user_watches=1048576`
    (persister dans `/etc/sysctl.d/60-inotify.conf`) ;
  - et/ou exclure `node_modules`, `target`, `dist` de la synchro Nextcloud
    (paramètres du client → fichiers ignorés).
  - Contournement sans sudo : `CHOKIDAR_USEPOLLING=1 npx vite` dans `ui/` puis
    lancer `src-tauri/target/debug/iaction` directement (env nettoyée).
