# Empaquetage — AppImage (Linux) et installeur Windows

> Mis en place le 2026-08-07. Objectif : une application **autonome** (ni Node
> ni dépendance à installer) et, sous Windows, **sans droits d'administration**.

## 0. En pratique : ne construisez rien à la main

`.github/workflows/version.yml` construit les DEUX installeurs à chaque
étiquette de version et les attache à une release. Le circuit complet —
instantané, pull request, fusion, puis :

```bash
git push git@github.com:duvamduvam/iaction.git <sha-fusionné>:refs/tags/vX.Y.Z
```

— est décrit dans `docs/github.md` §1.

Un runner Ubuntu produit l'AppImage, un runner `windows-latest` l'installeur
NSIS. C'est ce qui répond au vrai problème — Tauri ne compilant pas Windows
depuis Linux, chaque version réclamerait sinon d'allumer un PC Windows. Gratuit
sur un dépôt public.

Le reste de ce document décrit la construction LOCALE, utile pour mettre au
point ou dépanner. La CI ne fait rien d'autre : mêmes commandes, même script.

## 1. Une commande par plateforme

```bash
npm run build:linux     # → AppImage
npm run build:windows   # → installeur NSIS (à lancer SUR Windows)
```

Les deux passent par `scripts/preparer-bundle.sh`
(`beforeBuildCommand` de `src-tauri/tauri.conf.json`), qui construit l'interface,
compile le sidecar, assemble ses dépendances d'exécution et télécharge le
runtime Node. Rien à faire à la main.

Il commence par **purger la mise en scène de la construction précédente**
(`target/release/sidecar`, `target/release/bundle`). Tauri y copie les
ressources mais n'y supprime jamais ce qui a disparu de la source : sans cette
purge, un fichier retiré du bundle continue d'être livré, et fait échouer — ou
pire, réussir — une construction qui ne correspond plus à ce qu'on a écrit
(T-041). La CI ne voit pas ce piège, ses machines sont vierges à chaque *run* ;
il n'existe que sur un poste de développement.

**Tauri ne compile pas Windows depuis Linux** : l'installeur `.exe` se construit
sur une machine Windows (ou un *runner* `windows-latest` en CI). Le reste du
dépôt est identique — c'est la même commande.

## Usage en réseau d'entreprise

Derrière un proxy obligatoire, le `fetch` de Node n'honore pas
`HTTP_PROXY`/`HTTPS_PROXY` par défaut, contrairement à curl ou à un navigateur :
tous les appels sortants expirent en `UND_ERR_CONNECT_TIMEOUT` pendant que le
navigateur d'à côté fonctionne (T-043). L'application lance donc son moteur avec
`--use-env-proxy`, ce qui suffit **si les variables sont posées pour la session
graphique**.

Elles ne le sont pas toujours — sous Windows elles vivent souvent dans le profil
du terminal, pas dans la session de bureau. D'où l'encart **Configuration →
Réseau** (T-045) :

| Champ | Ce qu'il pose | Quand il sert |
|---|---|---|
| **Proxy** | `HTTP(S)_PROXY`, dans les deux casses | Aucune variable posée sur le poste |
| **Sans proxy** | `NO_PROXY` | Ollama local, intranet à joindre en direct |
| **Autorité de certification** | `NODE_EXTRA_CA_CERTS` | Proxy qui inspecte le TLS (`SELF_SIGNED_CERT_IN_CHAIN`) |
| **Certificats du système** | `--use-system-ca` | Idem, quand l'autorité est déjà installée sur le poste |

Trois choses à savoir, et elles sont dites dans l'encart :

1. **Les réglages s'appliquent au (re)démarrage du moteur**, pas à la seconde où
   on les enregistre : `--use-env-proxy` et `--use-system-ca` sont lus par Node
   au lancement du process. Le bouton « Enregistrer et relancer le moteur » fait
   les deux.
2. **Le PAC n'est pas lu.** Un poste qui déclare un `AutoConfigURL` dans le
   registre et rien d'autre doit saisir l'adresse du proxy ici, à la main. Nous
   n'interprétons pas le fichier de configuration automatique, et le prétendre
   serait pire que de l'avouer.
3. **Un proxy avec mot de passe est stocké en clair** dans la configuration non
   secrète, comme le serait une variable d'environnement — pas dans le
   trousseau. L'encart le signale dès que l'adresse en contient un.

Rien de saisi = rien de changé : l'environnement du moteur reste exactement
celui du poste, et c'est vérifié côté coquille (`src-tauri/src/reseau.rs`).

### Prérequis du poste Windows (pour CONSTRUIRE)

À ne pas confondre avec les prérequis pour *utiliser* l'application, qui sont
nuls — c'est tout l'objet de l'empaquetage.

| Outil | Pourquoi |
|---|---|
| **Git for Windows** | fournit le Bash qui exécute `preparer-bundle.sh` — et, séparément, le shell dont Claude Code se sert pour l'outil `Bash` |
| **Node.js ≥ 22** | construit l'interface et le sidecar |
| **Rust** (`rustup`, cible MSVC) | compile la coquille Tauri |
| **Visual Studio Build Tools**, charge « Développement Desktop en C++ » | l'éditeur de liens MSVC dont Rust a besoin |

Le script se débrouille du reste : il télécharge le `node.exe` correspondant
(somme SHA-256 officielle vérifiée) et npm n'installe que le CLI Claude de
Windows.

> Détail qui a failli coûter une session : l'archive Node de Windows est un
> `.zip`, et Git for Windows ne fournit **ni `unzip` ni un `tar` capable de lire
> un zip**. L'extraction passe donc par `Expand-Archive` de PowerShell, présent
> d'origine sur Windows 10 et suivants.

## 2. Ce qui est embarqué, et pourquoi

| Élément | Poids | Rôle |
|---|---|---|
| Binaire `claude` (CLI) | 282 Mo | moteur Claude, via le SDK Agent |
| Runtime Node | 119 Mo | exécute le sidecar sans Node installé |
| Sidecar + dépendances | ~46 Mo | le code métier et `yaml`/`zod` |

AppImage produite : **201 Mo** (le contenu est compressé).

### Ce qui est volontairement EXCLU

La pile de **voix locale** — `kokoro-js`, `@huggingface/transformers` et
l'`onnxruntime-node` natif qu'ils tirent — pèse à elle seule 1,2 Go, soit plus
que tout le reste réuni. Elle est chargée par `import()` dynamique
(`sidecar/src/speech.ts`) : absente, la dictée et la synthèse LOCALES sont
indisponibles et tout le reste fonctionne, y compris les moteurs de voix
distants. L'utilisateur reçoit alors un message explicite, pas une erreur de
module (voir `importVoixLocale`).

Pour l'inclure malgré tout dans le paquet, retirer les deux modules de la liste
`EXCLUES` en tête de `scripts/preparer-bundle.sh`.

### Ajouter la voix locale APRÈS installation (sans repackager)

L'application la cherche à deux endroits : son propre `node_modules` (cas du
dépôt en développement) puis un dossier **de l'utilisateur**, inscriptible —
ce qui compte, une AppImage étant une image en lecture seule.

```bash
# Linux — le chemin exact est rappelé dans Configuration → Voix
mkdir -p ~/.local/share/net.duvam.iaction/voix-locale
cd ~/.local/share/net.duvam.iaction/voix-locale
npm init -y
npm install kokoro-js @huggingface/transformers
```

```powershell
# Windows
mkdir "$env:LOCALAPPDATA\net.duvam.iaction\voix-locale"
cd "$env:LOCALAPPDATA\net.duvam.iaction\voix-locale"
npm init -y
npm install kokoro-js @huggingface/transformers
```

Redémarrer l'application : le micro et le mode conversation réapparaissent. Les
**modèles** (Whisper, Kokoro) ne sont pas dans ces paquets — ils se téléchargent
au premier usage dans `~/.cache/iaction/models`, exactement comme depuis les
sources.

Tant que la pile est absente **et** qu'un mode local est choisi, les boutons
micro et conversation ne sont pas affichés du tout (`VoiceControls`), et
Configuration → Voix explique pourquoi avec la commande à lancer. Un bouton
grisé invite à chercher ; un bouton absent n'appelle rien.

### Élagage par libc (Linux)

Sur Linux, npm installe **deux** variantes du CLI Claude — glibc et musl — soit
282 Mo livrés en double. Le script ne garde que celle du système visé (détection
par `ldd --version`).

## 3. Comment l'application se retrouve, une fois installée

Deux résolutions, toutes deux dans `src-tauri/src/sidecar.rs` :

- **`sidecar_entry`** — `IACTION_SIDECAR`, sinon la ressource embarquée
  `sidecar/index.js`, sinon le dépôt source (développement) ;
- **`node_program`** — `IACTION_NODE`, sinon le `node` livré à côté de
  l'exécutable, sinon celui du `PATH`.

Chaque candidat est vérifié sur le disque avant d'être retenu : une application
installée ne cherche jamais le dépôt, un dépôt en développement n'a pas de
ressource, et les deux échouent de façon explicite (journal `fatal`).

> **Piège Windows — le chemin « verbatim ».** Tauri résout ses ressources sous
> la forme `\\?\C:\…`, qui lève la limite de 260 caractères et que les API
> Windows acceptent. **Node ne la comprend pas** : son résolveur de module
> remonte les composants, prend `C:` pour la racine et meurt sur
> `EISDIR: illegal operation on a directory, lstat 'C:'`. Le sidecar était donc
> mort-né dans la v0.1.0 Windows — alors que le même `index.js`, lancé à la
> main avec le `node.exe` livré, fonctionnait parfaitement. `sans_prefixe_verbatim`
> retire ce préfixe avant tout passage à un programme tiers.
>
> Symptôme trompeur : l'installeur, l'application et le sidecar sont TOUS
> corrects — seule la forme du chemin qui les relie ne l'était pas.

## 4. Windows : sans droits d'administration

- **NSIS en `installMode: "currentUser"`** : installation dans `%LOCALAPPDATA%`,
  aucune élévation. Le MSI (WiX) est per-machine et exigerait l'administration :
  il n'est **pas** dans les cibles.
- **WebView2** est présent sur Windows 11 et les Windows 10 à jour. À défaut, le
  *bootstrapper* lancé sans élévation installe le runtime pour l'utilisateur
  seul.
- **Chemins** : la configuration va dans `%APPDATA%`, l'état dans
  `%LOCALAPPDATA%` (voir `sidecar/src/appPaths.ts`, testé pour les deux
  systèmes dans `sidecar/test/appPaths.test.js`).
- **Git for Windows est nécessaire à l'exécution des agents**, pas à
  l'installation :
  - Claude Code y prend le shell de son outil `Bash` (variable
    `CLAUDE_CODE_GIT_BASH_PATH` si le PATH ne suffit pas) ;
  - le moteur NEUTRE lance ses commandes par `sh -c`
    (`sidecar/src/neutralAgent.ts`), et `sh` vient de là.

  Sans lui, l'application s'installe et démarre, mais toute étape d'agent qui
  passe par le shell échoue.
- **Avertissement SmartScreen** : l'installeur n'est pas signé — l'écran
  apparaîtra tant qu'un certificat n'aura pas acquis de réputation. Il est
  contournable (« Informations complémentaires → Exécuter quand même »), et
  absent si l'installeur arrive autrement que par un téléchargement navigateur
  (synchro de fichiers, clé USB).

## 5. Pourquoi pas de paquet `.deb`

Tauri place les binaires externes à côté de l'exécutable, soit `/usr/bin/` pour
un `.deb` : le paquet livrerait donc un `/usr/bin/node`, en **conflit de fichier
avec le paquet `nodejs`** de la distribution. L'AppImage n'a pas ce problème
(tout vit dans son image). Un `.deb` demanderait de déplacer le runtime ailleurs
et d'adapter `node_program` — à faire le jour où il est réclamé.

## 6. Ce qui reste à faire

- Lancer `npm run build:windows` sur un poste Windows et vérifier l'installation
  per-user de bout en bout (première phase du D6 de `docs/etude-remote.md`).
- Gardes par système restantes : ouverture de fichiers hors Linux
  (`src-tauri/src/open_external.rs`, aujourd'hui `xdg-open`), sonde GPU
  `nvidia-smi` à dégrader proprement, et UI des timers locaux à griser hors
  Linux (la planification vit sur le serveur).
