# syntax=docker/dockerfile:1.7
#
# Image du conteneur `ia-runner` — tranche D1 de docs/etude-remote.md.
#
# Ce qu'elle embarque, et RIEN d'autre :
#   - Node 22 + le sidecar compilé (`/app/sidecar/dist`) ;
#   - le runner headless `/app/scripts/orch-run-headless.mjs`, qui résout le
#     sidecar en relatif (`../sidecar/dist/index.js`) — d'où l'obligation de
#     conserver l'arborescence `/app/{scripts,sidecar,node_modules}` ;
#   - `rclone` (synchro WebDAV vers le Nextcloud du serveur de stockage) et `supercronic`
#     (planification, lecture des `tache.yaml`) ;
#   - les scripts d'exploitation `/app/docker/ia-runner/bin/`.
#
# Choix structurants (le « pourquoi ») :
#
# 1. **Build multi-étapes.** L'étape `build` compile le TypeScript avec les
#    devDependencies ; l'étape `deps` installe l'arbre de production seul.
#    L'image finale ne reçoit que le résultat : ni TypeScript, ni sources .ts.
#
# 2. **Pas de voix dans le runner.** `@huggingface/transformers` et
#    `kokoro-js` sont des dépendances de production du sidecar mais pèsent
#    ~1,3 Go (onnxruntime, sharp, libvips) ET téléchargent des modèles au
#    premier usage. Le runner n'a pas de micro ni de haut-parleur : ces
#    paquets sont ÉLAGUÉS de l'image (étape `deps`). C'est sans risque parce
#    que `sidecar/src/speech.ts` ne les charge qu'en `import()` dynamique, à
#    l'intérieur des handlers `speech.*` — un runner headless n'en appelle
#    aucun. Si l'un l'était malgré tout, l'échec serait franc (module
#    introuvable, journalisé) plutôt qu'un téléchargement silencieux de
#    plusieurs centaines de Mo sur un disque de 24 Go.
#    Ceinture et bretelles : `XDG_CACHE_HOME` pointe sous `/data` (cf. plus
#    bas), donc même un téléchargement accidentel resterait visible, borné et
#    supprimable — jamais caché dans la couche d'écriture du conteneur.
#
# 3. **Binaires externes épinglés + vérifiés.** Aucun `curl | sh` : version
#    figée, somme SHA-256 contrôlée avant utilisation (voir les ARG plus bas).
#
# 4. **Utilisateur non-root** (uid/gid 10001) et `/data` créé dans l'image :
#    un volume nommé Docker hérite du contenu ET des droits du répertoire de
#    l'image lors de sa première création — le conteneur peut donc écrire dans
#    son volume sans passer par root. (Pour un bind mount, c'est à l'hôte de
#    faire le `chown` : voir README.md.)
#
# Architecture : amd64 uniquement (cible = VPS OVH `automatisation`). Un autre
# arc exigerait de relever les sommes de contrôle amont correspondantes.

# Base épinglée à une version précise : « node:22-slim » suit la distribution
# Debian par défaut, qui change sans préavis (bookworm → trixie).
ARG IMAGE_NODE=node:22.23.2-bookworm-slim

# ⚠️ Ces variables NE commencent PAS par `RCLONE_` — et ce n'est pas un
# caprice de nommage : rclone lit chacune de ses options dans la variable
# d'environnement `RCLONE_<OPTION>`. Un `ARG RCLONE_VERSION=1.75.0` est donc
# compris comme `--version=1.75.0` et fait échouer rclone au démarrage
# (constaté au build). Les noms sans collision possible sont inversés.

# rclone 1.75.0 — somme officielle https://downloads.rclone.org/v1.75.0/SHA256SUMS
ARG VERSION_RCLONE=1.75.0
ARG SHA256_RCLONE=aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa

# supercronic 0.2.48 — l'amont publie un SHA-1
# (016b7c9aebfc8d9fd9526e8ba33b191fc524485f) ; on vérifie ici le SHA-256 du
# MÊME binaire, relevé après contrôle du SHA-1 amont.
ARG VERSION_SUPERCRONIC=0.2.48
ARG SHA256_SUPERCRONIC=88c1b66b94c486f972fdd1a4d1f901e3e75ff04f749cddd60c5db573e3a33c6c


# ---------------------------------------------------------------------------
# Étape 1 — outils externes (rclone, supercronic)
# Isolée pour que `curl`/`unzip` ne survivent pas dans l'image finale.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS outils
ARG VERSION_RCLONE
ARG SHA256_RCLONE
ARG VERSION_SUPERCRONIC
ARG SHA256_SUPERCRONIC

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    if [ "$arch" != "amd64" ]; then \
      echo "ia-runner : image prévue pour amd64 uniquement (détecté : $arch)." >&2; \
      echo "Relever les sommes de contrôle amont de l'architecture visée avant d'y toucher." >&2; \
      exit 1; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    rm -rf /var/lib/apt/lists/*; \
    mkdir -p /sortie/bin; \
    \
    # rclone : archive zip officielle, somme vérifiée AVANT extraction.
    curl -fsSL -o /tmp/rclone.zip \
      "https://downloads.rclone.org/v${VERSION_RCLONE}/rclone-v${VERSION_RCLONE}-linux-amd64.zip"; \
    echo "${SHA256_RCLONE}  /tmp/rclone.zip" | sha256sum -c -; \
    unzip -j /tmp/rclone.zip "rclone-v${VERSION_RCLONE}-linux-amd64/rclone" -d /sortie/bin; \
    rm -f /tmp/rclone.zip; \
    \
    # supercronic : binaire statique, somme vérifiée avant de le rendre exécutable.
    curl -fsSL -o /sortie/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/v${VERSION_SUPERCRONIC}/supercronic-linux-amd64"; \
    echo "${SHA256_SUPERCRONIC}  /sortie/bin/supercronic" | sha256sum -c -; \
    \
    chmod 0755 /sortie/bin/rclone /sortie/bin/supercronic; \
    /sortie/bin/rclone version | head -1; \
    /sortie/bin/supercronic -test /dev/null


# ---------------------------------------------------------------------------
# Étape 2 — compilation du sidecar (TypeScript → sidecar/dist)
# ---------------------------------------------------------------------------
FROM ${IMAGE_NODE} AS build
WORKDIR /app

# Manifestes d'abord : cette couche ne change qu'au gré des dépendances.
# `ui/package.json` est requis même sans construire l'UI — la racine déclare
# `workspaces: [ui, sidecar]` et `npm ci` refuse un workspace manquant.
COPY package.json package-lock.json ./
COPY ui/package.json ui/package.json
COPY sidecar/package.json sidecar/package.json

# `-w sidecar --include-workspace-root` : n'installe QUE la racine et le
# sidecar (209 paquets contre 456 avec l'UI). `npm ci` = arbre exact du
# package-lock.json, aucune résolution opportuniste.
RUN npm ci --no-audit --no-fund -w sidecar --include-workspace-root

COPY sidecar/tsconfig.json sidecar/tsconfig.json
COPY sidecar/src sidecar/src
RUN npm run build -w sidecar && test -f sidecar/dist/index.js


# ---------------------------------------------------------------------------
# Étape 3 — arbre de dépendances de PRODUCTION, élagué
# ---------------------------------------------------------------------------
FROM ${IMAGE_NODE} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY ui/package.json ui/package.json
COPY sidecar/package.json sidecar/package.json

RUN npm ci --omit=dev --no-audit --no-fund -w sidecar --include-workspace-root

# Élagage (voir le point 2 de l'en-tête). Les paquets listés sont, d'après le
# package-lock.json, atteignables UNIQUEMENT depuis @huggingface/transformers
# et kokoro-js : rien d'autre dans l'arbre de production ne les référence.
# Quelques orphelins minuscules subsistent (protobufjs & co, quelques Mo) :
# les supprimer n'apporterait rien et rendrait la liste plus fragile.
#
# Le variant musl du CLI Claude (248 Mo) est retiré lui aussi : l'image est
# basée sur Debian (glibc), npm devrait le filtrer via le champ `libc` du
# paquet mais ne le fait pas toujours selon sa version.
RUN set -eux; \
    cd /app/node_modules; \
    du -sh . | sed 's/^/[deps] avant élagage : /'; \
    rm -rf \
      @huggingface \
      kokoro-js \
      onnxruntime-node onnxruntime-web onnxruntime-common \
      sharp @img \
      phonemizer; \
    rm -rf @anthropic-ai/claude-agent-sdk-*-musl \
           @anthropic-ai/claude-agent-sdk-darwin-* \
           @anthropic-ai/claude-agent-sdk-win32-*; \
    du -sh . | sed 's/^/[deps] après élagage : /'

# Garde-fou : si l'élagage emportait une dépendance réellement utile, l'échec
# doit se produire ICI, au build, pas à 3 h du matin sur le serveur.
RUN set -eux; \
    test -x /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude; \
    test -f /app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs; \
    node --input-type=module \
      -e "await import('yaml'); await import('zod/v4');"; \
    ! test -d /app/node_modules/@huggingface/transformers


# ---------------------------------------------------------------------------
# Étape 4 — image finale
# ---------------------------------------------------------------------------
FROM ${IMAGE_NODE} AS runtime

ARG UID=10001
ARG GID=10001

LABEL org.opencontainers.image.title="ia-runner" \
      org.opencontainers.image.description="Exécuteur de tâches d'agent iaction (headless, serveur)" \
      org.opencontainers.image.source="https://github.com/duvamduvam/iaction"

# git : le moteur Claude inspecte les dépôts (statut, diff) des projets
# synchronisés. tzdata : sans lui, TZ=Europe/Paris est ignoré et les rapports
# datés partent à l'heure UTC. ca-certificates : HTTPS (API Anthropic, WebDAV).
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates git tzdata; \
    rm -rf /var/lib/apt/lists/*

COPY --from=outils /sortie/bin/rclone /sortie/bin/supercronic /usr/local/bin/

# Utilisateur non-root à uid/gid FIXES : un bind mount côté hôte se chowne
# alors de façon déterministe (`chown -R 10001:10001 …`, cf. README).
RUN set -eux; \
    groupadd --gid "${GID}" runner; \
    useradd --uid "${UID}" --gid "${GID}" --no-create-home --home-dir /data/home --shell /bin/bash runner

WORKDIR /app

# `package.json` (racine + sidecar) n'est pas décoratif : il porte
# `"type": "module"`, sans lequel Node refuserait de charger `sidecar/dist/*.js`.
COPY package.json ./package.json
COPY sidecar/package.json ./sidecar/package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/sidecar/dist ./sidecar/dist
COPY scripts/orch-run-headless.mjs ./scripts/orch-run-headless.mjs

# Test de fumée : le sidecar élagué doit démarrer et annoncer `ready`. C'est
# le filet qui rattraperait un élagage trop large (§ 2) — au build, pas à 3 h
# du matin. HOME/XDG déviés vers /tmp puis effacés : rien de ce que le sidecar
# écrit au démarrage ne doit se retrouver figé dans l'image (le journal de
# /data servirait ensuite de graine à tout volume neuf).
RUN set -eux; \
    export HOME=/tmp/fumee XDG_CONFIG_HOME=/tmp/fumee/config XDG_CACHE_HOME=/tmp/fumee/cache; \
    echo | timeout 30 node /app/sidecar/dist/index.js | head -1 | grep -q '"event":"ready"'; \
    rm -rf /tmp/fumee

# Scripts d'exploitation (entrypoint, synchro, planification, exécution).
# Écrits hors de ce fichier ; ils sont le point d'entrée du conteneur.
COPY docker/ia-runner/bin/ ./docker/ia-runner/bin/
RUN set -eux; \
    chmod 0755 /app/docker/ia-runner/bin/*; \
    test -x /app/docker/ia-runner/bin/entrypoint.sh

# --- Environnement ---------------------------------------------------------
# Tous ces chemins vivent sous /data (le volume) : rien d'important ne doit
# atterrir dans la couche d'écriture du conteneur, qui disparaît à chaque
# recréation et qu'aucune supervision ne regarde.
#   HOME            → état du CLI Claude (~/.claude) conservé entre recréations
#   XDG_CONFIG_HOME → journal applicatif (net.duvam.iaction/logs/app.jsonl),
#                     statistiques d'usage, config.json de routage éventuel
#   XDG_CACHE_HOME  → caches (dont l'emplacement des modèles de voix qui ne
#                     seront jamais téléchargés, cf. point 2 de l'en-tête)
ENV NODE_ENV=production \
    TZ=Europe/Paris \
    HOME=/data/home \
    XDG_CONFIG_HOME=/data/etat/config \
    XDG_CACHE_HOME=/data/etat/cache \
    XDG_DATA_HOME=/data/etat/data \
    IA_RUNNER_TACHES_DIR=/data/taches \
    IA_RUNNER_PROJETS_DIR=/data/projets \
    IA_RUNNER_ETAT_DIR=/data/etat \
    IA_RUNNER_SYNC_INTERVAL_SEC=120 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Créés DANS l'image, avec les bons droits : un volume nommé vide monté sur
# /data en hérite à sa création (cf. point 4 de l'en-tête).
RUN set -eux; \
    mkdir -p /data/taches /data/projets /data/etat /data/home; \
    chown -R "${UID}:${GID}" /data

USER runner

ENTRYPOINT ["/app/docker/ia-runner/bin/entrypoint.sh"]
