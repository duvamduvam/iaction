#!/bin/sh
# ia-runner — synchro MONTANTE (conteneur → Nextcloud/WebDAV) via rclone.
#
# Tranche D1 de docs/etude-remote.md. Ce script ne remonte QUE les zones dont
# le serveur est propriétaire (règle d'or « zones d'écriture disjointes », § 3),
# et rien d'autre :
#
#   1. `<tache>/rapports/**` — rapports datés ET `journal.log` ;
#   2. `IA_RUNNER_ETAT_DIR` — état des exécutions et heartbeat (§ 7), déposé
#      dans un sous-dossier dédié du dossier des tâches (`_etat-serveur` par
#      défaut) pour rester visible de l'app sans nouvelle variable de synchro ;
#      ce nom sans `tache.yaml` est ignoré par `taches.list` côté sidecar ;
#   3. `**/.iaction/connaissances-index/**` — index RAG maintenu par le serveur.
#
# JAMAIS les sources d'un projet : une tâche serveur produit des rapports, elle
# ne modifie pas le projet (conséquence assumée, § 3 de l'étude). Le filtre est
# ici par liste blanche (`--include`), pas par exclusion : ce qui n'est pas
# explicitement autorisé ne monte pas.
#
# Échec = bruyant (message + ntfy + code non nul) : une synchro montante muette
# ferait disparaître les rapports sans que personne ne s'en aperçoive.

set -eu
# `pipefail` n'existe pas dans tous les /bin/sh (dash) : activé s'il existe.
(set -o pipefail 2>/dev/null) && set -o pipefail || true

: "${IA_RUNNER_TACHES_DIR:=/data/taches}"
: "${IA_RUNNER_PROJETS_DIR:=/data/projets}"
: "${IA_RUNNER_ETAT_DIR:=/data/etat}"

BIN="$(cd "$(dirname "$0")" && pwd)"

notifier() {
  [ -n "${NTFY_URL:-}" ] && [ -n "${NTFY_TOPIC:-}" ] || return 0
  # `node` est garanti par l'image, `curl` NON (Dockerfile : seuls
  # ca-certificates, git et tzdata sont installés). On passe donc par le relais
  # `run-tache.mjs --notifier`, qui gère aussi les accents de l'en-tête Title.
  if command -v node >/dev/null 2>&1; then
    node "$BIN/run-tache.mjs" --notifier "$1" "$2" ||
      printf '[%s] notification ntfy impossible\n' "sync-up" >&2
  elif command -v curl >/dev/null 2>&1; then
    curl -fsS -m 10 -H "Priority: high" -H "Title: $1" -d "$2" "${NTFY_URL%/}/${NTFY_TOPIC}" >/dev/null 2>&1 ||
      printf '[%s] notification ntfy impossible\n' "sync-up" >&2
  else
    printf '[%s] ni node ni curl : notification ntfy impossible\n' "sync-up" >&2
  fi
}

echouer() {
  printf '[sync-up] ERREUR %s\n' "$1" >&2
  notifier "ia-runner : sync-up en echec" "Synchro montante en échec : $1"
  exit 1
}

command -v rclone >/dev/null 2>&1 || echouer "rclone introuvable dans le conteneur"

: "${RCLONE_REMOTE:?doit nommer le remote rclone (ex. nextcloud ou nextcloud:)}"
: "${RCLONE_CHEMIN_TACHES:?doit donner le chemin des tâches sur le remote}"
: "${RCLONE_CHEMIN_PROJETS:?doit donner le chemin des projets sur le remote}"
: "${RCLONE_CHEMIN_ETAT:=${RCLONE_CHEMIN_TACHES%/}/_etat-serveur}"

# `nextcloud` ou `nextcloud:` + `iaction/taches` : le `:` final est ajouté
# s'il manque (le .env du serveur écrit le nom du remote SANS `:`) et le `/`
# initial du chemin est retiré. Sans ce soin, la concaténation donnerait
# `nextcloudiaction/...` — un chemin LOCAL, que rclone créerait sans broncher
# au lieu de parler au Nextcloud.
joindre_remote() {
  remote="$RCLONE_REMOTE"
  case "$remote" in
  *:) ;;
  *) remote="$remote:" ;;
  esac
  printf '%s%s' "$remote" "${1#/}"
}

OPTIONS_RCLONE="--retries 3 --low-level-retries 5 --timeout 5m --stats 0 --log-level NOTICE"

mkdir -p "$IA_RUNNER_TACHES_DIR" "$IA_RUNNER_PROJETS_DIR" "$IA_RUNNER_ETAT_DIR"

printf '[sync-up] rapports : %s -> %s\n' "$IA_RUNNER_TACHES_DIR" "$(joindre_remote "$RCLONE_CHEMIN_TACHES")"
# shellcheck disable=SC2086
rclone copy "$IA_RUNNER_TACHES_DIR" "$(joindre_remote "$RCLONE_CHEMIN_TACHES")" \
  --include "/*/rapports/**" \
  $OPTIONS_RCLONE ${RCLONE_OPTIONS:-} ||
  echouer "rclone copy des rapports (${IA_RUNNER_TACHES_DIR})"

printf '[sync-up] état : %s -> %s\n' "$IA_RUNNER_ETAT_DIR" "$(joindre_remote "$RCLONE_CHEMIN_ETAT")"
# Exclusions de la zone d'état :
#   - `cache/**` et `data/**` : le Dockerfile place XDG_CACHE_HOME et
#     XDG_DATA_HOME SOUS /data/etat. Ce sont des caches, parfois volumineux, que
#     le poste n'a aucune raison de recevoir — les remonter remplirait le
#     Nextcloud sans rien apporter. `config/**` reste remonté : c'est là que
#     vivent le journal applicatif et les événements d'usage (étude § 7).
#   - `verrou/**` : le verrou d'exécution vit hors de cette zone (/tmp), mais on
#     l'exclut au cas où quelqu'un le redirigerait ici via IA_RUNNER_VERROU.
# shellcheck disable=SC2086
rclone copy "$IA_RUNNER_ETAT_DIR" "$(joindre_remote "$RCLONE_CHEMIN_ETAT")" \
  --exclude "verrou/**" \
  --exclude "cache/**" \
  --exclude "data/**" \
  $OPTIONS_RCLONE ${RCLONE_OPTIONS:-} ||
  echouer "rclone copy de l'état (${IA_RUNNER_ETAT_DIR})"

printf '[sync-up] index RAG : %s -> %s\n' "$IA_RUNNER_PROJETS_DIR" "$(joindre_remote "$RCLONE_CHEMIN_PROJETS")"
# shellcheck disable=SC2086
rclone copy "$IA_RUNNER_PROJETS_DIR" "$(joindre_remote "$RCLONE_CHEMIN_PROJETS")" \
  --include "**/.iaction/connaissances-index/**" \
  $OPTIONS_RCLONE ${RCLONE_OPTIONS:-} ||
  echouer "rclone copy des index RAG (${IA_RUNNER_PROJETS_DIR})"

printf '[sync-up] terminé.\n'
