#!/usr/bin/env bash
# Lance `npm run dev` (tauri dev) avec un environnement débarrassé de la pollution
# Snap (terminal VSCode installé via snap). Sans ce nettoyage, le binaire Tauri
# crashe au lancement : « symbol lookup error: /snap/core20/... GLIBC_PRIVATE ».
# Même piège que pour le spawn d'apps externes (docs/plan.md, axe 5).
set -euo pipefail

# Variables injectées par le wrapper snap de VSCode qui cassent GTK/WebKit.
unset LD_LIBRARY_PATH GTK_PATH GTK_EXE_PREFIX GTK_IM_MODULE_FILE \
  GDK_PIXBUF_MODULE_FILE GDK_PIXBUF_MODULEDIR GIO_MODULE_DIR \
  GSETTINGS_SCHEMA_DIR LOCPATH 2>/dev/null || true

# VSCode snap sauvegarde les valeurs d'origine sous *_VSCODE_SNAP_ORIG.
if [ -n "${XDG_DATA_DIRS_VSCODE_SNAP_ORIG:-}" ]; then
  export XDG_DATA_DIRS="$XDG_DATA_DIRS_VSCODE_SNAP_ORIG"
fi
if [ -n "${XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG:-}" ]; then
  export XDG_CONFIG_DIRS="$XDG_CONFIG_DIRS_VSCODE_SNAP_ORIG"
fi
case "${XDG_DATA_HOME:-}" in */snap/*) unset XDG_DATA_HOME ;; esac

# Fenêtre BLANCHE au lancement (constaté le 2026-07-31) : le WebKitWebProcess
# crashe sans trace journal — problème connu webkit2gtk + rendu GPU dmabuf
# (pilotes NVIDIA). Le repli logiciel du renderer suffit et n'affecte que la
# webview de CETTE app.
export WEBKIT_DISABLE_DMABUF_RENDERER=1

cd "$(dirname "$0")/.."

# ── Une seule session à la fois (T-028) ────────────────────────────────────
# Relancer ce script alors qu'une session tourne déjà produit une fenêtre
# MORTE-NÉE, et qui n'en a pas l'air : `tauri dev` lance d'abord la fenêtre,
# puis échoue sur `beforeDevCommand` (Vite ne peut pas reprendre le port
# 1420), avorte, et tue le sidecar au passage — mais la fenêtre, elle,
# survit, orpheline. Elle affiche même l'interface, servie par le Vite de
# l'AUTRE session : tout paraît normal jusqu'au premier envoi, qui tombe sur
# « sidecar indisponible : stdin absent ». Constaté le 2026-08-11, trois
# fenêtres empilées à coups de raccourci clavier.
#
# On refuse donc de démarrer, avec la marche à suivre — plutôt que de laisser
# l'utilisateur diagnostiquer une coquille vide.
if (exec 3<>/dev/tcp/127.0.0.1/1420) 2>/dev/null; then
  exec 3<&- 3>&-
  cat >&2 <<'FIN'
==> Une session de développement écoute déjà sur le port 1420.

    Démarrer par-dessus ouvrirait une fenêtre SANS sidecar (« sidecar
    indisponible : stdin absent ») : Vite ne peut pas reprendre le port, et
    `tauri dev` avorte après avoir lancé la fenêtre.

    Bascule sur la fenêtre déjà ouverte, ou arrête la session en cours :

        pkill -f 'tauri dev' && pkill -f 'target/debug/iaction'
FIN
  exit 1
fi

# Le panneau « Tickets » lit `<config>/tickets.md` — le carnet de l'UTILISATEUR.
# En développement, on veut voir le backlog VERSIONNÉ du dépôt : on le désigne
# explicitement, plutôt que de le faire deviner à l'application (c'est
# exactement la confusion qu'on vient de retirer du produit).
export IACTION_TICKETS_MD="$PWD/docs/tickets.md"

# ── Le sidecar exécuté doit être celui du dépôt (T-020) ────────────────────
# `tauri dev` ne bâtit QUE l'interface (`beforeDevCommand`). Le sidecar, lui,
# arrive par les ressources Tauri, recopiées de `build/sidecar-bundle/` — un
# dossier que seul `scripts/preparer-bundle.sh` reconstruit, donc jamais en
# développement. Résultat constaté le 2026-08-10 : l'application tournait sur
# un sidecar du 7 août, et trois jours de correctifs compilés, testés et
# commités n'avaient tout simplement jamais été exécutés.
#
# On compile, et on DÉSIGNE explicitement le résultat : `IACTION_SIDECAR` est
# la première branche de `sidecar_entry` (src-tauri/src/sidecar.rs), avant
# toute ressource. Plus de bundle intermédiaire dans la boucle de dev, donc
# plus de copie silencieusement périmée.
#
# Sortie DÉDIÉE (`dist-dev/`), et surtout pas `dist/` : réécrire le dossier que
# l'application est en train d'exécuter tue son sidecar — constaté quatre fois
# les 7 et 8 août, d'où la séparation déjà en place pour les tests
# (`dist-verif/`, voir sidecar/test/harness.mjs). Trois sorties, trois usages :
# `dist/` l'empaquetage, `dist-verif/` les tests, `dist-dev/` la session
# lancée. Aucune commande courante n'écrit sous les pieds d'une autre.
#
# On ne recompile toutefois QUE si c'est nécessaire (T-029). La mesure du
# 2026-08-11 met ce `tsc` à 2,5 s sur les ~8,2 s qui séparent cette commande
# de la première image — payées à chaque lancement, y compris quand aucune
# source n'a bougé. `a-jour.mjs` pose la question au code compilé lui-même,
# via l'empreinte que le sidecar utilise déjà au démarrage pour signaler sa
# péremption : une seule vérité sur « ce code vient-il de ces sources ? ».
# Au moindre doute (dossier absent, témoin illisible), il répond « recompiler ».
if node sidecar/scripts/a-jour.mjs dist-dev; then
  echo "==> Sidecar déjà à jour — compilation sautée"
else
  echo "==> Sidecar (tsc) — sans quoi l'application tournerait sur un binaire périmé"
  npm run build:dev -w sidecar
fi
export IACTION_SIDECAR="$PWD/sidecar/dist-dev/index.js"

exec npm run dev "$@"
