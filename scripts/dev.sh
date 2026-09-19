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

# ── Rendu GPU par défaut depuis le 2026-08-30 (T-095) ─────────────────────
#
# Histoire de cette ligne, parce qu'elle a coûté cinq signalements.
#
# Le 2026-07-31, une fenêtre BLANCHE au lancement (WebKitWebProcess qui crashe
# sans trace — bug connu webkit2gtk + dmabuf, pilotes NVIDIA) a fait poser un
# repli : tout rastériser au processeur. Le repli marchait, il est resté.
#
# Il se payait à CHAQUE CARACTÈRE TAPÉ. Sur le 4K de ce poste — 5120 × 2786,
# soit 14,3 Mpixels — un repeint plein cadre au processeur coûte ~300 ms.
# Quatre enquêtes (T-031, T-083, et deux relances) ont cherché la cause dans
# l'application, et retiré du vrai coût, sans jamais atteindre ce plancher.
# webkit2gtk est passé en 2.52.3 le 2026-08-06, APRÈS le crash qui avait motivé
# le repli, et personne n'a retenté : le repli a survécu 24 jours à sa raison
# d'être.
#
# Mesuré le 2026-08-30, même fenêtre, même phrase, sonde de frappe
# (ui/src/sondeFrappe.ts), latence médiane touche → image :
#
#     rendu logiciel     2 784 ms   (six relevés entre 2 717 et 2 993)
#     rendu GPU             64 ms   (n=182)
#
# 43 fois. Le défaut change donc de camp : le GPU est le défaut, et le repli
# logiciel reste accessible pour le jour où un pilote régresse.
#
#     IACTION_CPU=1 ./scripts/dev.sh    # repli logiciel, si fenêtre blanche
#
if [ "${IACTION_CPU:-0}" = "1" ]; then
  echo "==> Repli LOGICIEL demandé (IACTION_CPU=1) : la frappe sera lente sur grand écran (T-095)." >&2
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi

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
  # Lancé par l'icône du bureau, stderr part dans un fichier que personne ne
  # lit : le refus était un échec muet DE FAIT (T-060). Une notification rend
  # le garde-fou visible là où on clique ; le détail reste sur stderr.
  if command -v notify-send >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    notify-send "IAction" "Une session de développement tourne déjà — bascule sur la fenêtre ouverte." || true
  fi
  # T-095 — un lancement demandé et refusé se lit comme un lancement FAIT :
  # constaté le 2026-08-28, où le rendu GPU a été « essayé » sans que la fenêtre
  # change, puis conclu sans effet — deux fois. Un refus doit donc nommer ce qui
  # n'a PAS eu lieu, et pas seulement ce qu'il faut faire.
  if [ "${IACTION_CPU:-0}" = "1" ]; then
    echo "==> Le changement de rendu N'A PAS EU LIEU : la fenêtre ouverte garde le sien (voir ci-dessous)." >&2
    if command -v notify-send >/dev/null 2>&1 && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
      notify-send "IAction" "Changement de rendu non effectué : une session tourne déjà, il faut l'arrêter d'abord." || true
    fi
  fi
  cat >&2 <<'FIN'
==> Une session de développement écoute déjà sur le port 1420.

    Démarrer par-dessus ouvrirait une fenêtre SANS sidecar (« sidecar
    indisponible : stdin absent ») : Vite ne peut pas reprendre le port, et
    `tauri dev` avorte après avoir lancé la fenêtre.

    Bascule sur la fenêtre déjà ouverte, ou arrête la session en cours — les
    TROIS processus. Vite compris : il ne descend PAS avec `tauri dev`, et il
    garde le port à lui seul (T-103, constaté le 2026-08-28 — les deux pkill
    d'avant laissaient donc le refus se répéter à l'identique).
FIN
  # Motif calculé plutôt que recopié : le heredoc ci-dessus n'interpole rien
  # (et ne doit pas : il contient des accents graves), et un chemin en dur
  # tuerait le Vite d'un autre dépôt.
  echo >&2
  echo "        pkill -f 'tauri dev'; pkill -f 'target/debug/iaction'; pkill -f '$PWD/node_modules/.bin/vite'" >&2
  echo >&2
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

# ── La ressource que seul l'empaquetage produit (T-127) ────────────────────
# `tauri.conf.json` déclare `../build/sidecar-bundle/` en ressource Tauri, et
# `tauri dev` compile aussi le binaire Rust : son build script vérifie que la
# ressource existe, MÊME si rien en développement ne lit son contenu (le
# sidecar vient de `IACTION_SIDECAR`, juste au-dessus). Ce dossier est dans
# `.gitignore` et seul `scripts/preparer-bundle.sh` (empaquetage, 139 Mo, 40 s)
# le construit pour de vrai : au premier `target/` reconstruit — nettoyage,
# clone neuf —, la compilation échoue avec « resource path ... doesn't exist »
# et l'application devient inconstructible en développement, sans qu'aucun
# code n'ait bougé.
#
# On se contente donc de garantir l'EXISTENCE, pas le contenu : un dossier
# vide avec un témoin explicatif suffit à cargo. `assurer-bundle-dev.mjs` ne
# touche à rien si un vrai bundle est déjà là (`npm run preparer-bundle` déjà
# passé) — voir sa documentation.
node scripts/assurer-bundle-dev.mjs

exec npm run dev "$@"
