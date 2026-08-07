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

echo "==> Interface (vite build)"
npm run build -w ui

echo "==> Sidecar (tsc)"
npm run build -w sidecar

echo "==> Assemblage de $BUNDLE"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE"
cp -a sidecar/dist/. "$BUNDLE/"

# package.json réduit : mêmes versions que le sidecar, moins les exclusions.
# On repart du manifeste réel plutôt que d'une liste recopiée, pour qu'une
# dépendance ajoutée demain se retrouve dans le bundle sans qu'on y pense.
node -e '
const fs = require("fs");
const src = JSON.parse(fs.readFileSync("sidecar/package.json", "utf8"));
const exclues = new Set('"$EXCLUES"');
const deps = Object.fromEntries(
  Object.entries(src.dependencies || {}).filter(([nom]) => !exclues.has(nom)),
);
fs.writeFileSync(process.argv[1] + "/package.json", JSON.stringify({
  name: "iaction-sidecar-bundle",
  private: true,
  type: src.type ?? "module",
  dependencies: deps,
}, null, 2) + "\n");
console.log("   dépendances embarquées :", Object.keys(deps).join(", "));
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
