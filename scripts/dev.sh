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

# Le panneau « Tickets » lit `<config>/tickets.md` — le carnet de l'UTILISATEUR.
# En développement, on veut voir le backlog VERSIONNÉ du dépôt : on le désigne
# explicitement, plutôt que de le faire deviner à l'application (c'est
# exactement la confusion qu'on vient de retirer du produit).
export IACTION_TICKETS_MD="$PWD/docs/tickets.md"

exec npm run dev "$@"
