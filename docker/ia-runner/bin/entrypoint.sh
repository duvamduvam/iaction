#!/bin/sh
# ia-runner — point d'entrée du conteneur (tranche D1, docs/etude-remote.md § 4).
#
# Déroulé : synchro initiale → génération du crontab depuis les manifestes
# synchronisés → boucle de synchro périodique en fond → `exec supercronic`.
#
# Choix notables :
#
# - **La synchro initiale doit réussir.** Démarrer sur un volume vide ou périmé,
#   c'est planifier le monde d'hier ; on préfère un conteneur qui refuse de
#   démarrer, bruyamment (ntfy), à un conteneur qui tourne pour rien (§ 7).
#
# - **Un crontab partiellement généré est conservé.** `plan-cron.mjs` sort en
#   code 1 dès qu'une tâche est refusée, mais il a déjà écrit les lignes des
#   tâches valides et notifié pour les autres : tout arrêter priverait les
#   tâches saines à cause d'un manifeste fautif. On journalise, et on continue.
#
# - **Régénération du crontab** : la boucle de synchro compare une empreinte du
#   CONTENU des manifestes ; s'il a changé, elle réécrit le crontab puis
#   termine le processus principal. Le conteneur redémarre alors proprement —
#   c'est la « relance simple » retenue pour D1 ; elle suppose une politique
#   `restart: unless-stopped` côté compose.
#
# - **Heartbeat** : une entrée cron horodate `IA_RUNNER_ETAT_DIR/heartbeat.json`,
#   remonté par sync-up.sh. C'est le seul témoin du cas « rien ne s'est passé »
#   (conteneur mort, synchro cassée, serveur éteint) — l'app alerte si le
#   fichier est trop vieux (§ 7).

set -eu
# `pipefail` n'existe pas dans tous les /bin/sh (dash) : activé s'il existe.
(set -o pipefail 2>/dev/null) && set -o pipefail || true

BIN="$(cd "$(dirname "$0")" && pwd)"

export IA_RUNNER_TACHES_DIR="${IA_RUNNER_TACHES_DIR:-/data/taches}"
export IA_RUNNER_PROJETS_DIR="${IA_RUNNER_PROJETS_DIR:-/data/projets}"
export IA_RUNNER_ETAT_DIR="${IA_RUNNER_ETAT_DIR:-/data/etat}"
export IA_RUNNER_SYNC_INTERVAL_SEC="${IA_RUNNER_SYNC_INTERVAL_SEC:-120}"
IA_RUNNER_HEARTBEAT_MIN="${IA_RUNNER_HEARTBEAT_MIN:-5}"
CRONTAB="${IA_RUNNER_CRONTAB:-/tmp/ia-runner.crontab}"

# PID du shell courant : `exec supercronic` le conservera, c'est donc aussi le
# PID du processus à terminer pour provoquer la relance du conteneur.
PID_PRINCIPAL=$$

journal() {
  printf '[entrypoint] %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

notifier() {
  [ -n "${NTFY_URL:-}" ] && [ -n "${NTFY_TOPIC:-}" ] || return 0
  # `node` est garanti par l'image, `curl` NON (Dockerfile : seuls
  # ca-certificates, git et tzdata sont installés). On passe donc par le relais
  # `run-tache.mjs --notifier`, qui gère aussi les accents de l'en-tête Title.
  if command -v node >/dev/null 2>&1; then
    node "$BIN/run-tache.mjs" --notifier "$1" "$2" ||
      printf '[%s] notification ntfy impossible\n' "entrypoint" >&2
  elif command -v curl >/dev/null 2>&1; then
    curl -fsS -m 10 -H "Priority: high" -H "Title: $1" -d "$2" "${NTFY_URL%/}/${NTFY_TOPIC}" >/dev/null 2>&1 ||
      printf '[%s] notification ntfy impossible\n' "entrypoint" >&2
  else
    printf '[%s] ni node ni curl : notification ntfy impossible\n' "entrypoint" >&2
  fi
}

echouer() {
  printf '[entrypoint] ERREUR %s\n' "$1" >&2
  notifier "ia-runner : demarrage impossible" "$1"
  exit 1
}

mkdir -p "$IA_RUNNER_TACHES_DIR" "$IA_RUNNER_PROJETS_DIR" "$IA_RUNNER_ETAT_DIR"

ecrire_heartbeat() {
  printf '{"horodatage":"%s","source":"ia-runner"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    >"$IA_RUNNER_ETAT_DIR/heartbeat.json"
}

# Mode heartbeat : c'est CE script que l'entrée cron rappelle (voir
# generer_crontab). Passer par lui plutôt que par une commande inline évite
# d'écrire un `%` dans le crontab — caractère que cron réserve historiquement
# (fin de commande + entrée standard) et dont le traitement varie d'un
# ordonnanceur à l'autre.
if [ "${1:-}" = "--heartbeat" ]; then
  ecrire_heartbeat
  exit 0
fi

command -v node >/dev/null 2>&1 || echouer "node introuvable dans le conteneur"
command -v supercronic >/dev/null 2>&1 || echouer "supercronic introuvable dans le conteneur"
[ -f "$BIN/../../../scripts/orch-run-headless.mjs" ] ||
  echouer "scripts/orch-run-headless.mjs introuvable : le dépôt n'est pas monté/copié comme prévu (attendu /app)"
[ -f "$BIN/../../../sidecar/dist/index.js" ] ||
  echouer "sidecar/dist/index.js introuvable : l'image n'embarque pas le sidecar compilé"

# Jeton d'abonnement Claude (§ 5) : son absence ne se voit qu'au premier run
# raté, plusieurs heures plus tard. On le dit tout de suite, sans bloquer le
# heartbeat (un conteneur vivant mais mal configuré reste préférable à un
# conteneur muet).
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  journal "ATTENTION : ni CLAUDE_CODE_OAUTH_TOKEN ni ANTHROPIC_API_KEY — les tâches échoueront."
  notifier "ia-runner : jeton Claude absent" "Le conteneur démarre sans CLAUDE_CODE_OAUTH_TOKEN : toute tâche échouera."
fi

# Empreinte du CONTENU des manifestes (et non de leurs dates) : rclone réécrit
# des fichiers identiques, une empreinte sur mtime relancerait le conteneur pour
# rien. `cksum` est POSIX, contrairement à `find -printf` ou `md5sum`.
# Le `|| printf` final est indispensable : avec `set -e` + `pipefail`, un `find`
# qui râle ferait avorter le script au moment de l'affectation `$(...)`.
empreinte_manifestes() {
  find "$IA_RUNNER_TACHES_DIR" -maxdepth 2 -name tache.yaml -type f -exec cat {} + 2>/dev/null | cksum ||
    printf 'empreinte-indisponible\n'
}

generer_crontab() {
  if node "$BIN/plan-cron.mjs" >"$CRONTAB.tmp"; then
    statut=0
  else
    statut=$?
  fi
  if [ ! -s "$CRONTAB.tmp" ]; then
    rm -f "$CRONTAB.tmp"
    return 1
  fi
  # Heartbeat : ajouté ICI et pas dans plan-cron.mjs, parce qu'il ne dépend
  # d'aucun manifeste — il doit battre même quand il n'y a aucune tâche.
  {
    printf '\n# Heartbeat — témoin de vie du conteneur (docs/etude-remote.md § 7).\n'
    printf '*/%s * * * * %s --heartbeat\n' "$IA_RUNNER_HEARTBEAT_MIN" "$BIN/entrypoint.sh"
  } >>"$CRONTAB.tmp"
  mv "$CRONTAB.tmp" "$CRONTAB"
  return "$statut"
}

# --- 1. Synchro initiale ----------------------------------------------------
journal "synchro descendante initiale…"
"$BIN/sync-down.sh" || echouer "synchro descendante initiale en échec — refus de démarrer sur des données périmées"

# --- 2. Crontab -------------------------------------------------------------
journal "génération du crontab…"
if generer_crontab; then
  journal "crontab généré : $CRONTAB"
else
  statut_plan=$?
  if [ -f "$CRONTAB" ]; then
    journal "ATTENTION : plan-cron.mjs a refusé au moins une tâche (code $statut_plan) — le crontab ne contient que les tâches valides."
  else
    echouer "génération du crontab impossible (plan-cron.mjs, code $statut_plan) — aucune ligne exploitable"
  fi
fi

EMPREINTE_INITIALE="$(empreinte_manifestes)"
ecrire_heartbeat
printf '{"horodatage":"%s","evenement":"demarrage"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  >"$IA_RUNNER_ETAT_DIR/demarrage.json"

# --- 3. Boucle de synchro périodique ---------------------------------------
boucle_sync() {
  empreinte="$EMPREINTE_INITIALE"
  while :; do
    sleep "$IA_RUNNER_SYNC_INTERVAL_SEC"
    # `--sync` prend le même verrou que les tâches, sans attendre : pas de
    # synchro sous les pieds d'une orchestration en cours.
    if ! node "$BIN/run-tache.mjs" --sync; then
      journal "ERREUR synchro périodique en échec (voir ci-dessus)"
    fi
    nouvelle="$(empreinte_manifestes)"
    if [ "$nouvelle" != "$empreinte" ]; then
      journal "manifestes modifiés : régénération du crontab et relance du conteneur."
      generer_crontab || journal "ATTENTION : régénération partielle du crontab (voir ci-dessus)."
      # Relance simple : terminer supercronic (PID conservé par le `exec`)
      # laisse Docker redémarrer le conteneur avec le nouveau crontab.
      kill -TERM "$PID_PRINCIPAL" 2>/dev/null || true
      return 0
    fi
  done
}
boucle_sync &

# --- 4. Ordonnanceur --------------------------------------------------------
journal "démarrage de supercronic sur $CRONTAB"
# shellcheck disable=SC2086
exec supercronic ${SUPERCRONIC_OPTIONS:-} "$CRONTAB"
