#!/bin/sh
# ia-runner — synchro DESCENDANTE (Nextcloud/WebDAV → conteneur) via rclone.
#
# Tranche D1 de docs/etude-remote.md. Ce script ramène ce que le POSTE écrit :
# les manifestes de tâches et les dossiers de projets de la liste blanche.
#
# Ce qu'il ne ramène JAMAIS (règle d'or « zones d'écriture disjointes », § 3) :
#   - `<tache>/rapports/**` : écrit par le serveur. Le redescendre risquerait
#     d'écraser un rapport tout juste produit et pas encore remonté.
#   - `**/.iaction/connaissances-index/**` : l'index RAG est maintenu par le
#     serveur (§ 2, déclencheur « indexation RAG »).
#   - la zone d'état `IA_RUNNER_ETAT_DIR`, qui n'est jamais descendue du tout.
#
# `rclone copy` (et non `sync`) : aucune suppression locale. Un fichier retiré
# côté poste subsiste donc ici jusqu'à la reconstruction du volume — compromis
# assumé en D1, où l'on préfère un surplus à une destruction accidentelle.
#
# Échec = bruyant (message + notification ntfy + code non nul). Un run sur des
# données périmées en silence est exactement ce que l'étude interdit (§ 7).

set -eu
# `pipefail` n'existe pas dans tous les /bin/sh (dash) : activé s'il existe.
(set -o pipefail 2>/dev/null) && set -o pipefail || true

: "${IA_RUNNER_TACHES_DIR:=/data/taches}"
: "${IA_RUNNER_PROJETS_DIR:=/data/projets}"

BIN="$(cd "$(dirname "$0")" && pwd)"

notifier() {
  [ -n "${NTFY_URL:-}" ] && [ -n "${NTFY_TOPIC:-}" ] || return 0
  # `node` est garanti par l'image, `curl` NON (Dockerfile : seuls
  # ca-certificates, git et tzdata sont installés). On passe donc par le relais
  # `run-tache.mjs --notifier`, qui gère aussi les accents de l'en-tête Title.
  if command -v node >/dev/null 2>&1; then
    node "$BIN/run-tache.mjs" --notifier "$1" "$2" ||
      printf '[%s] notification ntfy impossible\n' "sync-down" >&2
  elif command -v curl >/dev/null 2>&1; then
    curl -fsS -m 10 -H "Priority: high" -H "Title: $1" -d "$2" "${NTFY_URL%/}/${NTFY_TOPIC}" >/dev/null 2>&1 ||
      printf '[%s] notification ntfy impossible\n' "sync-down" >&2
  else
    printf '[%s] ni node ni curl : notification ntfy impossible\n' "sync-down" >&2
  fi
}

echouer() {
  printf '[sync-down] ERREUR %s\n' "$1" >&2
  notifier "ia-runner : sync-down en echec" "Synchro descendante en échec : $1"
  exit 1
}

command -v rclone >/dev/null 2>&1 || echouer "rclone introuvable dans le conteneur"

# Variables obligatoires : `${VAR:?}` interrompt avec un message explicite.
: "${RCLONE_REMOTE:?doit nommer le remote rclone (ex. nextcloud ou nextcloud:)}"
: "${RCLONE_CHEMIN_TACHES:?doit donner le chemin des tâches sur le remote}"
: "${RCLONE_CHEMIN_PROJETS:?doit donner le chemin des projets sur le remote}"

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

mkdir -p "$IA_RUNNER_TACHES_DIR" "$IA_RUNNER_PROJETS_DIR"

printf '[sync-down] tâches : %s -> %s\n' "$(joindre_remote "$RCLONE_CHEMIN_TACHES")" "$IA_RUNNER_TACHES_DIR"
# shellcheck disable=SC2086
rclone copy "$(joindre_remote "$RCLONE_CHEMIN_TACHES")" "$IA_RUNNER_TACHES_DIR" \
  --exclude "/*/rapports/**" \
  --exclude "/_etat-serveur/**" \
  $OPTIONS_RCLONE ${RCLONE_OPTIONS:-} ||
  echouer "rclone copy des tâches (${RCLONE_CHEMIN_TACHES})"

printf '[sync-down] projets : %s -> %s\n' "$(joindre_remote "$RCLONE_CHEMIN_PROJETS")" "$IA_RUNNER_PROJETS_DIR"
# `node_modules` est exclu par défaut : inutile à une tâche qui produit des
# rapports, et le VPS n'a que ~24 Go libres (docs/etude-remote.md § 4).
# `RCLONE_EXCLUSIONS_PROJETS` permet d'en ajouter (ex. --exclude "*.iso").
# shellcheck disable=SC2086
rclone copy "$(joindre_remote "$RCLONE_CHEMIN_PROJETS")" "$IA_RUNNER_PROJETS_DIR" \
  --exclude ".iaction/connaissances-index/**" \
  --exclude "node_modules/**" \
  $OPTIONS_RCLONE ${RCLONE_EXCLUSIONS_PROJETS:-} ${RCLONE_OPTIONS:-} ||
  echouer "rclone copy des projets (${RCLONE_CHEMIN_PROJETS})"

printf '[sync-down] terminé.\n'
