#!/usr/bin/env bash
#
# Prépare tout ce que `tauri build` doit embarquer. Appelé automatiquement par
# `beforeBuildCommand` (src-tauri/tauri.conf.json) — donc aussi par
# `npm run build:linux` / `build:windows`.
#
# Produit deux choses :
#
#   1. `build/sidecar-bundle/`  — le sidecar compilé + SES SEULES dépendances
#      d'exécution, embarqué en ressource Tauri (résolu par `sidecar_entry`,
#      src-tauri/src/sidecar.rs) ;
#   2. `src-tauri/binaries/node-<triple>` — le runtime Node livré à côté de
#      l'exécutable (résolu par `node_program`), pour que l'application soit
#      autonome : ni Node à installer, ni droits d'administration.
#
# Ce qui n'est VOLONTAIREMENT pas embarqué : la voix locale
# (`kokoro-js`, `@huggingface/transformers`, et l'`onnxruntime-node` natif
# qu'ils tirent) — 1,2 Go à eux seuls. Ils sont chargés par `import()`
# DYNAMIQUE dans sidecar/src/speech.ts : absents, la synthèse/reconnaissance
# locale est indisponible et le reste de l'application fonctionne. Les moteurs
# de voix distants, eux, ne dépendent de rien de tout cela.

set -euo pipefail
cd "$(dirname "$0")/.."

RACINE="$PWD"
BUNDLE="$RACINE/build/sidecar-bundle"
NODE_VERSION="${NODE_VERSION:-v22.22.1}"

# Dépendances d'exécution EXCLUES du bundle (voir en-tête).
EXCLUES='["kokoro-js","@huggingface/transformers"]'

# ── Purge de la mise en scène précédente (T-041) ────────────────────────
# Tauri COPIE les ressources dans `target/release/sidecar/`, puis dans
# `bundle/appimage_deb/…` — et n'y supprime jamais ce qui a disparu de la
# source. Un fichier retiré du bundle continuait donc d'être recopié dans
# l'AppDir à chaque construction : le 2026-08-13, le CLI Claude non compressé
# retiré par le correctif T-038 y dormait encore et faisait échouer un build que
# ce correctif venait de réparer. Trois constructions lues comme trois échecs
# différents, pour un seul fichier périmé.
#
# C'est la même famille que T-020 : du code (ici des ressources) qu'on croit
# livrer et qui n'est pas celui qu'on a écrit. La CI ne voit rien — machine
# vierge à chaque run —, c'est donc un piège de poste de développement, et une
# consigne qu'il faut se rappeler n'aurait pas été un garde-fou.
CIBLE="${CARGO_TARGET_DIR:-$RACINE/src-tauri/target}"
for scene in "$CIBLE/release/sidecar" "$CIBLE/release/bundle"; do
  if [ -e "$scene" ]; then
    echo "==> Purge de la mise en scène précédente : $scene"
    rm -rf "$scene"
  fi
done

echo "==> Interface (vite build)"
npm run build -w ui

echo "==> Sidecar (tsc)"
npm run build -w sidecar

echo "==> Assemblage de $BUNDLE"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE"
cp -a sidecar/dist/. "$BUNDLE/"

# package.json réduit : les dépendances du sidecar, moins les exclusions, et
# figées à la version RÉELLEMENT INSTALLÉE dans le dépôt.
#
# On repart du manifeste réel plutôt que d'une liste recopiée, pour qu'une
# dépendance ajoutée demain se retrouve dans le bundle sans qu'on y pense.
#
# ── Pourquoi des versions EXACTES (T-042) ──────────────────────────────
# Le manifeste du sidecar porte des plages (`^0.3.214`), et ce dossier n'a pas
# de verrou : `npm install` y résolvait donc la version la plus récente du jour,
# pas celle que la chaîne de tests venait de valider. Le 2026-08-13, le paquet
# livré embarquait le CLI Claude 0.3.231 alors que tout avait été testé en
# 0.3.214 — 46 Mo d'écart, et une version que personne n'avait jamais exécutée.
# Livrer autre chose que ce qu'on a testé est un échec muet : il ne se voit
# qu'après, chez l'utilisateur. On fige donc sur l'installé, qui est l'image du
# verrou du dépôt.
node -e '
const fs = require("fs");
const src = JSON.parse(fs.readFileSync("sidecar/package.json", "utf8"));
const exclues = new Set('"$EXCLUES"');
const versionInstallee = (nom) => {
  const chemin = "node_modules/" + nom + "/package.json";
  if (!fs.existsSync(chemin)) {
    console.error("   ÉCHEC : " + nom + " n’est pas installé — lancer npm ci avant de construire.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(chemin, "utf8")).version;
};
const deps = Object.fromEntries(
  Object.keys(src.dependencies || {})
    .filter((nom) => !exclues.has(nom))
    .map((nom) => [nom, versionInstallee(nom)]),
);
fs.writeFileSync(process.argv[1] + "/package.json", JSON.stringify({
  name: "iaction-sidecar-bundle",
  private: true,
  type: src.type ?? "module",
  dependencies: deps,
}, null, 2) + "\n");
const rendu = Object.entries(deps).map(([n, v]) => n + "@" + v).join(", ");
console.log("   dépendances embarquées :", rendu);
console.log("   exclues (voix locale)  :", [...exclues].join(", "));
' "$BUNDLE"

echo "==> Dépendances d'exécution du bundle"
# `--omit=dev` et pas de scripts d'installation : on ne veut que des fichiers.
# npm ne pose que les binaires optionnels de LA plateforme courante — c'est ce
# qui fait qu'un bundle Windows n'embarque pas le CLI Claude de Linux.
(cd "$BUNDLE" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --silent)

# ... sauf sur Linux, où « la plateforme courante » couvre DEUX variantes de
# libc : npm pose `linux-x64` (glibc) ET `linux-x64-musl`, soit 282 Mo de
# binaire `claude` livré en double. On ne garde que celle du système visé.
echo "==> Élagage des variantes de libc inutiles"
node -e '
const fs = require("fs"), path = require("path"), cp = require("child_process");
const dir = path.join(process.argv[1], "node_modules", "@anthropic-ai");
if (!fs.existsSync(dir)) process.exit(0);
// musl ? La sortie de `ldd --version` le dit ; en cas de doute on suppose
// glibc, de très loin le cas courant sur un poste de bureau.
let musl = false;
try { musl = /musl/i.test(cp.execSync("ldd --version 2>&1 || true").toString()); } catch {}
const garder = process.platform === "linux"
  ? (musl ? (n) => n.endsWith("-musl") : (n) => !n.endsWith("-musl"))
  : () => true;
for (const nom of fs.readdirSync(dir)) {
  if (!nom.startsWith("claude-agent-sdk-")) continue;
  if (garder(nom)) { console.log("   gardé  :", nom); continue; }
  fs.rmSync(path.join(dir, nom), { recursive: true, force: true });
  console.log("   retiré :", nom, "(libc non visée)");
}
' "$BUNDLE"

# ── Le CLI Claude ne survit pas à linuxdeploy (T-038) ──────────────────
# L'AppImage se fabrique avec linuxdeploy, qui parcourt TOUS les ELF de
# l'AppDir, leur réécrit leur RUNPATH avec `patchelf`, puis interroge `ldd`.
# Le CLI Claude porte une charge utile collée en queue de fichier : la
# réécriture le CASSE, `ldd` sort en 1 sur le fichier que linuxdeploy vient
# lui-même d'abîmer, et il abandonne (SIGABRT). Mesuré le 2026-08-13 : même
# BuildID, 4 096 octets de plus, `ldd` qui passe de 0 à 1.
#
# On le soustrait donc au balayage en le rangeant COMPRESSÉ : un `.gz` n'est
# pas un ELF, linuxdeploy passe devant sans le voir. Le sidecar le détend au
# premier lancement dans un dossier inscriptible (cliClaude.ts) — une AppImage
# étant une image en lecture seule, il n'y a de toute façon pas d'autre endroit
# où poser un exécutable.
#
# Uniquement sur Linux : Windows et macOS n'ont pas linuxdeploy dans la chaîne,
# et un détour par une extraction leur coûterait un premier démarrage pour rien.
if [ "$(uname -s)" = "Linux" ]; then
  echo "==> Mise à l'abri du CLI Claude (linuxdeploy le casserait)"
  node -e '
const fs = require("fs"), path = require("path"), zlib = require("zlib");
const dir = path.join(process.argv[1], "node_modules", "@anthropic-ai");
if (!fs.existsSync(dir)) process.exit(0);
for (const nom of fs.readdirSync(dir)) {
  if (!nom.startsWith("claude-agent-sdk-linux")) continue;
  const cli = path.join(dir, nom, "claude");
  if (!fs.existsSync(cli)) continue;
  const brut = fs.readFileSync(cli);
  // Niveau 1 : le CLI est surtout du JavaScript, il se comprime déjà de plus
  // de moitié, et chaque cran supplémentaire coûte des dizaines de secondes
  // sur 265 Mo — à chaque construction, sur chaque runner.
  fs.writeFileSync(cli + ".gz", zlib.gzipSync(brut, { level: 1 }));
  fs.rmSync(cli);
  const mo = (n) => Math.round(n / 1048576);
  console.log(`   ${nom}/claude : ${mo(brut.length)} Mo → ${mo(fs.statSync(cli + ".gz").size)} Mo compressé`);
}
' "$BUNDLE"
fi

echo "==> Runtime Node livré"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
mkdir -p src-tauri/binaries
case "$(uname -s)" in
  Linux)  ARCHIVE="node-$NODE_VERSION-linux-x64.tar.xz"; CIBLE="src-tauri/binaries/node-$TRIPLE" ;;
  Darwin) ARCHIVE="node-$NODE_VERSION-darwin-arm64.tar.xz"; CIBLE="src-tauri/binaries/node-$TRIPLE" ;;
  *)      ARCHIVE="node-$NODE_VERSION-win-x64.zip"; CIBLE="src-tauri/binaries/node-$TRIPLE.exe" ;;
esac

if [ -f "$CIBLE" ]; then
  echo "   déjà présent : $CIBLE"
else
  TMP="$(mktemp -d)"
  echo "   téléchargement de $ARCHIVE"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$ARCHIVE" -o "$TMP/$ARCHIVE"
  # Somme officielle du même répertoire : on refuse un binaire non conforme
  # plutôt que de livrer n'importe quoi à l'intérieur de l'application.
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  (cd "$TMP" && grep " $ARCHIVE\$" SHASUMS256.txt | sha256sum -c -)
  case "$ARCHIVE" in
    *.tar.xz)
      tar -xJf "$TMP/$ARCHIVE" -C "$TMP"
      cp "$TMP/${ARCHIVE%.tar.xz}/bin/node" "$CIBLE"
      ;;
    *.zip)
      # PAS `unzip` : ce script tourne sous Git Bash quand la cible est
      # Windows, et Git for Windows ne fournit ni `unzip` ni un `tar` capable
      # de lire un zip. `Expand-Archive` de PowerShell, lui, est présent
      # d'origine sur Windows 10 et suivants.
      powershell.exe -NoProfile -NonInteractive -Command \
        "Expand-Archive -LiteralPath '$(cygpath -w "$TMP/$ARCHIVE" 2>/dev/null || echo "$TMP/$ARCHIVE")' -DestinationPath '$(cygpath -w "$TMP" 2>/dev/null || echo "$TMP")' -Force"
      cp "$TMP/${ARCHIVE%.zip}/node.exe" "$CIBLE"
      ;;
  esac
  chmod +x "$CIBLE"
  rm -rf "$TMP"
  echo "   posé : $CIBLE"
fi

echo
echo "Bundle prêt :"
du -sh "$BUNDLE" | sed 's/^/   /'
du -sh "$CIBLE" | sed 's/^/   /'
