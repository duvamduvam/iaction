#!/usr/bin/env bash
#
# Publication d'un instantané vers le dépôt public — PAR PULL REQUEST.
#
# ── Pourquoi un instantané, et jamais la branche ────────────────────────
# L'historique local est antérieur au nettoyage du 2026-08-07 : ses messages
# et ses diffs portent des traces personnelles. Il ne part JAMAIS. Ce script
# fabrique UN commit (`git commit-tree`) qui porte l'arbre de travail complet,
# avec pour seul parent le `main` public — l'écart entier tient dans ce commit,
# sans rien raconter du chemin local.
#
# ── Pourquoi une pull request, et plus une poussée directe ──────────────
# La PR est le portique : `version.yml` vérifie l'instantané sur DEUX machines
# vierges (Linux + Windows) avant qu'il touche `main`. Le poste local peut
# mentir par omission — un fichier jamais `git add` passait l'audit et les
# tests locaux (T-011) ; une machine vierge, elle, ne connaît que l'instantané.
# La protection de branche (docs/github.md) rend ce détour obligatoire.
#
# ── Identité ────────────────────────────────────────────────────────────
# Le commit est signé avec l'identité PUBLIQUE du produit, jamais la config
# git du poste : celle-ci porte une adresse nominative (c'est précisément le
# genre de trace que l'audit existe pour retenir — vérifié le 2026-08-09).
#
# ── Usage ───────────────────────────────────────────────────────────────
#   npm run verif                                  # application FERMÉE (cargo)
#   scripts/publier-instantane.sh --verif-fait "Titre de l'instantané"
#
# Le drapeau --verif-fait est exigé : ce script ne relance pas la chaîne
# complète (elle exige l'application fermée, lui ne peut pas le vérifier) —
# le drapeau atteste qu'elle vient de passer. L'audit, lui, est relancé ici
# quoi qu'il arrive : c'est la barrière de dernière position.

set -euo pipefail

DEPOT_PUBLIC="git@github.com:duvamduvam/iaction.git"
URL_PR="https://github.com/duvamduvam/iaction/compare/main...instantane?expand=1"
IDENTITE_NOM="duvamduvam"
IDENTITE_ADRESSE="duvamduvam@users.noreply.github.com"

VERIF_FAIT=0
TITRE=""
for arg in "$@"; do
  case "$arg" in
    --verif-fait) VERIF_FAIT=1 ;;
    -*) echo "option inconnue : $arg" >&2; exit 2 ;;
    *) TITRE="$arg" ;;
  esac
done

cd "$(dirname "$0")/.."

if [ "$VERIF_FAIT" -ne 1 ]; then
  echo "Refus : lancer d'abord « npm run verif » (application FERMÉE — cargo" >&2
  echo "recompile la coquille), puis relancer avec --verif-fait." >&2
  exit 2
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Refus : l'arbre de travail n'est pas propre — committer d'abord." >&2
  echo "L'instantané publie l'ARBRE : ce qui n'est pas commité partirait aussi." >&2
  exit 2
fi

[ -n "$TITRE" ] || TITRE="Instantané du $(date +%F)"

# Dernière position : même fraîchement passé dans verif, l'audit retourne ici,
# au moment exact où quelque chose s'apprête à partir.
npm run audit

echo "== Dépôt public =="
git fetch "$DEPOT_PUBLIC" main
PARENT="$(git rev-parse FETCH_HEAD)"
ARBRE="$(git rev-parse 'HEAD^{tree}')"

if [ "$(git rev-parse "${PARENT}^{tree}")" = "$ARBRE" ]; then
  echo "Rien à publier : l'arbre local est identique au main public."
  exit 0
fi

SHA="$(GIT_AUTHOR_NAME="$IDENTITE_NOM" GIT_AUTHOR_EMAIL="$IDENTITE_ADRESSE" \
  GIT_COMMITTER_NAME="$IDENTITE_NOM" GIT_COMMITTER_EMAIL="$IDENTITE_ADRESSE" \
  git commit-tree "$ARBRE" -p "$PARENT" -m "$TITRE")"
echo "Instantané : $SHA — « $TITRE »"

# La branche `instantane` est JETABLE : écrasée à chaque publication, elle ne
# vit que le temps d'une PR. La seule branche durable du dépôt public est main.
git push --force "$DEPOT_PUBLIC" "$SHA:refs/heads/instantane"

echo
echo "Poussé. Ouvrir la pull request (le portique de vérification part seul) :"
echo "  $URL_PR"
echo
echo "Fusionner par « Rebase and merge » (historique public = une ligne"
echo "d'instantanés, sans commits de fusion). Pour livrer ensuite une version :"
echo "  git push $DEPOT_PUBLIC <sha-fusionné>:refs/tags/vX.Y.Z"
