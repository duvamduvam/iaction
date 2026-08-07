#!/usr/bin/env bash
#
# Migration d'un poste installé sous l'ancien nom (« IA Studio »,
# `net.duvam.ia-studio`, dossier projet `.iadadou/`) vers IAction.
#
# À LANCER APPLICATION ARRÊTÉE. Tant qu'il n'est pas passé, rien ne casse :
# le sidecar lit l'ancien emplacement quand le nouveau n'existe pas (voir
# sidecar/src/appPaths.ts) — ce script ne fait que rendre le poste cohérent
# avec le nouveau nom, une fois pour toutes.
#
# Usage :
#   scripts/migrer-vers-iaction.sh            # montre ce qui serait fait
#   scripts/migrer-vers-iaction.sh --appliquer
#
# Les projets sont cherchés en argument, sinon dans le dossier courant :
#   scripts/migrer-vers-iaction.sh --appliquer ~/dev/projet-a ~/dev/projet-b

set -euo pipefail

APPLIQUER=0
PROJETS=()
for arg in "$@"; do
  case "$arg" in
    --appliquer) APPLIQUER=1 ;;
    -*) echo "option inconnue : $arg" >&2; exit 2 ;;
    *) PROJETS+=("$arg") ;;
  esac
done
[ ${#PROJETS[@]} -eq 0 ] && PROJETS=(".")

ANCIEN_ID="net.duvam.ia-studio"
NOUVEAU_ID="net.duvam.iaction"

deplacer() {
  local src="$1" dst="$2"
  if [ ! -e "$src" ]; then return 0; fi
  if [ -e "$dst" ]; then
    echo "  ⚠ $dst existe déjà — $src laissé en place (fusion à faire à la main)"
    return 0
  fi
  if [ "$APPLIQUER" -eq 1 ]; then
    mv "$src" "$dst"
    echo "  ✔ $src → $dst"
  else
    echo "  · $src → $dst"
  fi
}

echo "== Données du poste =="
CONFIG_BASE="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_BASE="${XDG_DATA_HOME:-$HOME/.local/share}"
deplacer "$CONFIG_BASE/$ANCIEN_ID" "$CONFIG_BASE/$NOUVEAU_ID"
deplacer "$DATA_BASE/$ANCIEN_ID" "$DATA_BASE/$NOUVEAU_ID"

echo "== Dossiers de projets =="
for projet in "${PROJETS[@]}"; do
  deplacer "$projet/.iadadou" "$projet/.iaction"
done

# L'application n'est PAS relancée par ce script : c'est à l'utilisateur de le
# faire (le lancement de l'app ne s'automatise pas ici).
if [ "$APPLIQUER" -eq 0 ]; then
  echo
  echo "Simulation seule. Relancez avec --appliquer, application arrêtée."
fi
