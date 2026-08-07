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

# Déplace `src` vers `dst`. Si `dst` existe déjà, on FUSIONNE entrée par entrée
# plutôt que d'abandonner : le cas est la règle, pas l'exception — la coquille
# Tauri crée le dossier au nouveau nom dès le premier lancement, et
# l'application y écrit une configuration par défaut avant qu'on ait migré
# (c'est ce qui a fait « disparaître » 7 projets le 2026-08-07).
#
# Règle de fusion, volontairement conservatrice :
#   - entrée absente de `dst`           → on la déplace ;
#   - `.jsonl` présent des deux côtés   → concaténation ancien PUIS nouveau
#                                          (append-only, l'ordre chronologique
#                                          est préservé) ;
#   - autre collision                   → l'ANCIEN gagne, le nouveau est gardé
#                                          sous `.remplace-par-migration`.
deplacer() {
  local src="$1" dst="$2"
  if [ ! -e "$src" ]; then return 0; fi

  if [ ! -e "$dst" ]; then
    if [ "$APPLIQUER" -eq 1 ]; then
      mv "$src" "$dst"; echo "  ✔ $src → $dst"
    else
      echo "  · $src → $dst"
    fi
    return 0
  fi

  echo "  ⚠ $dst existe déjà — fusion entrée par entrée"
  local entree nom cible
  for entree in "$src"/* "$src"/.[!.]*; do
    [ -e "$entree" ] || continue
    nom="$(basename "$entree")"
    cible="$dst/$nom"
    if [ ! -e "$cible" ]; then
      if [ "$APPLIQUER" -eq 1 ]; then mv "$entree" "$cible"; echo "    ✔ $nom déplacé"; else echo "    · $nom → déplacé"; fi
    elif [ -d "$entree" ]; then
      deplacer "$entree" "$cible"
    elif [ "${nom##*.}" = "jsonl" ]; then
      if [ "$APPLIQUER" -eq 1 ]; then
        cat "$entree" "$cible" > "$cible.fusion" && mv "$cible.fusion" "$cible" && rm "$entree"
        echo "    ✔ $nom concaténé (ancien puis nouveau)"
      else
        echo "    · $nom → concaténé"
      fi
    else
      if [ "$APPLIQUER" -eq 1 ]; then
        mv "$cible" "$cible.remplace-par-migration"; mv "$entree" "$cible"
        echo "    ✔ $nom remplacé (le nouveau est gardé en .remplace-par-migration)"
      else
        echo "    · $nom → l'ancien remplace le nouveau"
      fi
    fi
  done
  if [ "$APPLIQUER" -eq 1 ]; then rmdir "$src" 2>/dev/null || true; fi
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
