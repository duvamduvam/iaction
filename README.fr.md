# IAction — présentation française

Application desktop (Tauri) rétro-futuriste néon pour piloter le développement assisté par IA
à travers plusieurs fournisseurs (abonnement Claude, OpenRouter, Ollama, endpoints
OpenAI-compatibles), organisée par projets liés à un répertoire.

> Présentation détaillée des fonctionnalités : [README.md](README.md) (anglais).
> Plan produit complet : [docs/plan.md](docs/plan.md).
> Backlog (corrections et fonctionnalités à venir) : [docs/tickets.md](docs/tickets.md).

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

```bash
npm install            # workspaces ui + sidecar
npm run sidecar:build  # compile le sidecar (obligatoire avant le premier run)
npm run dev            # tauri dev (compile Rust, lance Vite + la fenêtre)
```

Tests du sidecar (sans Tauri) : `npm run sidecar:test`.

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
