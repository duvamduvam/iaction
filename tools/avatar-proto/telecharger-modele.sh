#!/usr/bin/env bash
# Récupère les têtes d'essai (52 poses ARKit + visèmes). Jamais versionnées
# (voir .gitignore) : licences de tiers, usage local d'essai uniquement.
#   facecap  : exemple three.js
#   brunette : Ready Player Me, CC BY-NC 4.0 (via le dépôt TalkingHead)
#   avaturn  : Avaturn, usage non commercial (idem)
#   mpfb     : MakeHuman/MPFB, CC0 (idem) — 37 Mo
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p modeles
curl -fsSL -o modeles/facecap.glb \
  https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/facecap.glb
for m in brunette avaturn mpfb; do
  curl -fsSL -o "modeles/$m.glb" \
    "https://raw.githubusercontent.com/met4citizen/TalkingHead/main/avatars/$m.glb"
done
echo "OK : $(ls modeles)"
