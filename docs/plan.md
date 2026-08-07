# IAction — plateforme lourde de développement IA (plan)

> Nom de travail : **iaction** (nom définitif = décision ouverte).
> Dépôt dédié créé le 2026-07-18. Document-plan du projet.

## Pitch

Application **lourde (desktop)**, **rétro-futuriste néon**, pour piloter le développement
assisté par IA à travers **plusieurs fournisseurs** (abonnement Claude, OpenRouter, Ollama,
API à venir), organisée **par projets liés à un répertoire**, avec :

- arborescence de fichiers à gauche façon VSCode ;
- ouverture de fichiers par **application associée** (registre d'apps par extension) ;
- **espace de config par projet** (doc IA, skills, RAG) ;
- **changement rapide de projet** ;
- **page de suivi de performance IA** (taux d'usage abo Claude, conso OpenRouter/Ollama,
  contexte moyen, nb de conversations, nb d'agents par conversation) ;
- **éditeur no-code type n8n** pour composer agents/skills, simple mais efficace.

Base d'inspiration : orchestrateur Pays de la Loire (http://localhost:8002/agent/orchestrateur).

## Cadrage (validé au grill 2026-07-18)

- **Emplacement du plan** : nouveau dépôt dédié `~/Nextcloud/dev/iaction`.
- **Ambition** : produit **diffusable** à terme (⇒ archi propre, doc, packaging dès le départ).
- **Réussi quand (jalon 1)** : ouvrir un projet lié à un dossier et **discuter avec Claude
  ET Ollama ET OpenRouter** depuis la même UI. C'est le socle.

## Axes du grill (à trancher)

1. Périmètre MVP vs vision — quoi dans la v1, quoi hors v1
2. Stack technique (app lourde : Tauri/Electron ? langage ? UI néon)
3. Multi-fournisseurs — branchement Claude abo / OpenRouter / Ollama (auth, le piège de l'abo)
4. Concept « projet » + config par répertoire (structure du dossier de config)
5. Ouverture de fichiers / registre d'apps par extension
6. Page de perf / observabilité (d'où viennent les métriques)
7. Éditeur no-code n8n-like (agents/skills)
8. Réutilisation de l'existant (orchestrateur maison antérieur, Agent SDK, briques déjà écrites)
9. Risques, inconnues, build vs buy

---

## Décisions & notes (remplies au fil du grill)

### Axe 1 — Périmètre (tranché 2026-07-18)

- **Jalon 1 (socle)** : ouvrir un projet lié à un dossier + **chat multi-fournisseur**
  (Claude abo, Ollama, OpenRouter dans la même UI).
- **2ᵉ pilier v1** : **arborescence VSCode-like + ouverture de fichiers** (registre
  d'apps par extension). Rend l'outil utilisable au quotidien.
- **Nature de l'IA en v1 : agent qui ÉDITE + outils**, avec **diff à valider** avant
  application. C'est le vrai « IDE pour agents », pas un chat lecture seule.
  ⚠️ Conséquence : il faut un **moteur d'outils + permissions + diff/undo**. C'est
  gros — voir axe 8 (réutiliser Claude Agent SDK plutôt que réécrire ?).
- **Repoussé explicitement en v2+** : config projet (doc IA / skills / RAG),
  page de perf IA, éditeur no-code n8n.

**Angle mort relevé** : « produit diffusable » + « agent qui édite from scratch » +
solo = énorme. À réconcilier à l'axe 8 (build vs réutiliser un agent existant).
→ Réconcilié à l'axe 2 : le moteur d'agent n'est PAS réécrit (sidecar Agent SDK).

### Axe 2 — Stack technique (tranché 2026-07-18)

- **Coquille : Tauri (Rust)** — binaire léger, distribution 3 OS propre.
- **UI : React** (décision par défaut, non débattue) — motifs : xyflow (éditeur
  n8n-like v2) et Monaco/CodeMirror sont React-first ; thème néon = CSS libre.
- **Moteur d'agent : sidecar Node embarquant le Claude Agent SDK.**
  La boucle agentique, les outils fichiers/bash, les permissions, MCP sont
  fournis par le SDK — on ne réécrit pas le morceau le plus cher.
  Le Rust de Tauri reste mince : fenêtre, FS-watch, spawn/supervision du sidecar.
- Architecture : UI React ⇄ (IPC Tauri) ⇄ cœur Rust mince ⇄ sidecar Node
  (Agent SDK, providers) ; communication UI↔sidecar en streaming (WS ou stdio relayé).
- ⚠️ Inconnue portée à l'axe 3 : le Agent SDK est Anthropic-centrique — comment
  brancher OpenRouter/Ollama dessus (et l'abonnement Claude) reste À VÉRIFIER.
  → Tranché axe 3 : deux moteurs, le problème du proxy disparaît.

### Axe 3 — Multi-fournisseurs (tranché 2026-07-18)

- **Ambition : tous les fournisseurs sont des agents à égalité** (pas de
  hiérarchie Claude-agent / autres-chat).
- **Architecture : DEUX MOTEURS ASSUMÉS** :
  1. **Agent SDK (sidecar Node)** pour Claude — consomme l'**abonnement** via
     OAuth natif ; outils/permissions/MCP fournis.
  2. **Moteur neutre léger** (boucle tool-calling provider-agnostic dans le même
     sidecar) pour OpenRouter, Ollama et API futures — dialecte OpenAI.
- Égalité fonctionnelle approximative acceptée ; en échange, chaque chemin reste
  simple et débogable. Le moteur neutre implémente la **même palette minimale
  d'outils** : lire, éditer-avec-diff, bash, recherche (défaut posé, non débattu).
- **Clés API dans le trousseau OS** (plugin Tauri), jamais en clair (défaut posé).
- Un « fournisseur à venir » = un endpoint OpenAI-compatible à déclarer dans
  l'admin → aucun code, par construction du moteur neutre.
- ⚠️ **Inconnues** :
  - Conditions Anthropic sur les apps tierces utilisant l'abonnement de
    l'utilisateur (des apps ont été bloquées) — à vérifier AVANT diffusion ;
    sans impact pour l'usage perso.
  - Qualité réelle de l'agentique avec petits modèles locaux (Ollama) : à
    étalonner, ne pas promettre l'égalité de résultat, seulement d'accès.

### Axe 4 — Projet & config par répertoire (tranché 2026-07-18)

- **Un projet = un répertoire**, config dans un dossier propre **`.iaction/`**
  (nom de dossier choisi par Dadou — versionnable dans git, suit le projet).
- Contenu cible (v2 pour l'essentiel) : doc IA, skills, RAG, fournisseurs
  préférés, registre d'apps par extension (surcharge locale du registre global).
- **Interop Claude : lecture + synchronisation** — `.iaction/` est la source de
  vérité ; à l'ouverture, l'app détecte `CLAUDE.md` / `.claude/` existants et les
  référence (lien/import) ; pour le moteur Claude, l'app génère/synchronise ce
  que le Agent SDK attend. Aucune double saisie ; Claude Code reste utilisable
  à côté ; les 10+ projets déjà documentés marchent dès le jour 1.
- **Changement rapide de projet** (défaut posé) : registre des projets récents +
  palette de bascule (Ctrl+K), même fenêtre ; l'état de conversation par projet
  est persisté. Multi-fenêtres = plus tard si besoin.

### Axe 5 — Ouverture de fichiers & registre d'apps (tranché 2026-07-18)

- **Texte dedans, reste dehors** : code/texte/markdown dans un éditeur intégré
  (CodeMirror) — nécessaire pour lire/valider les diffs de l'agent ; aperçu
  simple des images ; tout le reste (KiCad, FreeCAD, PDF…) part vers l'app
  externe du registre.
- **Registre d'apps** : global dans l'admin, surchargeable par projet via
  `.iaction/` ; repli `xdg-open` si aucune règle.
- ⚠️ Piège connu (mémoire projet) : env Snap polluée casse le lancement des GUI
  (KiCad…) → le spawn externe doit nettoyer l'environnement (`setsid env -i`).

### Axe 6 — Page de perf / observabilité (tranché 2026-07-18 ; livraison v2)

- **Principe : voies officielles + HISTORISATION.** Chaque relevé est horodaté
  en base locale (SQLite) ; la page montre des courbes dans le temps, pas un
  simple instantané.
- Sources par métrique :
  - **Abonnement Claude** : infos de limites renvoyées par la chaîne Claude
    Code/Agent SDK (fenêtre 5 h, hebdo) + comptage local de tokens ; la jauge
    dit « estimé » quand c'est estimé. Pas de scraping ni d'endpoint non
    documenté (dette interdite pour un produit diffusable).
  - **OpenRouter** : API crédits/usage officielle.
  - **Ollama** : local, gratuit → métriques volume + latence.
  - **Contexte moyen, nb conversations, agents/conversation** : télémétrie
    locale de l'app (chaque appel LLM journalisé en SQLite).

### Axe 7 — Éditeur no-code (v2, mais format engagé dès v1)

- **Modèle de données : agents déclarés + enchaînements.** Une boîte = un agent
  (prompt système + modèle + outils autorisés + skills) ; les flèches = qui
  délègue à qui / ordre. Format **YAML dans `.iaction/agents/`**.
- Proche du modèle sous-agents du Agent SDK → exécutable par les deux moteurs.
- **La v1 lit déjà ce format** (exécution d'agents déclarés, sans éditeur
  graphique) ; l'éditeur xyflow de v2 n'est qu'une VUE sur ces fichiers.
- Explicitement rejeté : reconstruire un moteur de workflow n8n complet
  (déclencheurs, conditions, webhooks) — hors périmètre produit.

### Axe 8 — Réutilisation de l'existant (tranché 2026-07-18)

- **Un orchestrateur maison antérieur = inspiration + banc d'essai, AUCUN code
  repris.** Il sert de premier projet-test dans l'app.
- Exploration de son code faite (2026-07-18) — leçons à réutiliser comme
  **patterns** :
  - **Format d'agents** : `SKILL.md` frontmatter YAML (name, description, type,
    domain, allowed-tools, trigger) + corps Markdown = prompt. Scanner ~50
    lignes. Modèle direct pour `.iaction/agents/`.
  - **`delegation.yml`** : routage mots-clés + domain→worker + fallback LLM —
    modèle pour les enchaînements d'agents (axe 7).
  - **Schéma SQLite `usage_events`** (coût, tokens in/out/cache, turns, durée,
    par modèle) + page Usage (fenêtre 5 h/7 j, agents orphelins, cap budget) —
    préfigure la page de perf (axe 6).
  - **Routing par complexité** : pré-passe Haiku classe low/medium/high → choix
    du modèle. Transposable au moteur neutre.
- À NE PAS porter : tout le cœur d'exécution (wrapper subprocess `claude -p`,
  resume OAuth, lock CLI) — l'opposé du moteur neutre voulu ; l'endpoint OAuth
  de conso non documenté (dette exclue à l'axe 6) ; sa logique métier.
- **Principe d'isolation (ajouté 2026-07-18)** : **séparation technique TOTALE
  avec les autres applications** du poste. Aucun import de code,
  aucun lien symbolique, aucune base/service partagé, aucun appel direct entre
  apps. Les SEULS ponts autorisés :
  1. **mémoire** (fichiers de mémoire des sessions IA) ;
  2. **fichiers agents** (`SKILL.md`, `.iaction/`, `CLAUDE.md`/`.claude/`) —
     interop par lecture/sync de fichiers, jamais par API interne ;
  3. **MCP** (serveurs Model Context Protocol déclarés explicitement).
  Conséquence : si iaction doit un jour parler à cet orchestrateur ou à
  toute autre app, c'est via un serveur MCP dédié ou des fichiers d'agents
  partagés — jamais par couplage de code ou de schéma.

### Axe 9 — Posture produit, licence, rythme (tranché 2026-07-18)

- **Concurrence** : opcode/Claudia, Cherry Studio, LibreChat, Void… examinés en
  survol — aucun ne coche la combinaison. **Thèse produit assumée** : la
  différenciation = abo Claude + égalité fournisseurs + projets-répertoires +
  registre d'apps + orchestration visuelle simple, dans une UI néon.
- **Licence : open source (MIT ou Apache-2.0)** dès le début — norme de la
  catégorie ; monétisation éventuelle plus tard par services.
- **Rythme : projet de fond** (quelques h/semaine, derrière d'autres projets)
  → lots PETITS et indépendants, implémentation déléguée aux agents sur specs
  fermées ; socle v1 ≈ plusieurs mois, assumé.

---

## Feuille de route (lots calibrés « projet de fond »)

**v1 — socle (jalon 1 = fin du lot 3)**

- ✅ **Lot 0 — Squelette** (livré 2026-07-19, commit `ae174a6`) : app Tauri +
  React + sidecar Node supervisé, un flux streamé bout en bout (UI ⇄ Rust ⇄
  sidecar). Thème néon posé (tokens CSS). Protocole JSON Lines spécifié dans
  `docs/protocol.md`. Pièges d'env documentés (Snap VSCode, inotify/Nextcloud).
- ✅ **Lot 1 — Moteur neutre, chat seul** (livré 2026-07-19) : appels
  OpenAI-compatibles streaming vers Ollama + OpenRouter (+ endpoint custom
  déclarable), clés en trousseau OS. Pas d'outils encore.
- ✅ **Lot 2 — Claude via Agent SDK** (livré 2026-07-19, commit `cafc1c1`) :
  login abonnement (hérité du login Claude Code local ; clé API en repli),
  conversation agentique (outils SDK) dans un répertoire projet, diffs
  affichés et validés dans l'UI (modale de permission). Vérifié en session
  réelle (permission Write → allow → fichier écrit).
- ✅ **Lot 3 — Projets** (livré 2026-07-19, commits `66f5963` + `4b22d90`) :
  registre de projets déclarés (nom + répertoire, page Configuration),
  `.iaction/` initialisé à la déclaration, badges de détection
  `CLAUDE.md`/`.claude/`, palette de bascule Ctrl+K, persistance des
  conversations par projet. En bonus : mode de permission « Autonome » et
  mémoire « ne plus demander pour cet outil ».
  → **✅ JALON 1 ATTEINT (2026-07-19) : un projet ouvert, chat Claude
  (abonnement) + Ollama + OpenRouter dans la même UI.**
- ✅ **Lot 4 — Arbo + éditeur** (livré 2026-07-19, commit `b6c3000`) :
  arborescence VSCode-like, CodeMirror intégré, aperçu images. En bonus :
  encart conso (jauges abonnement 5h/7j + crédits OpenRouter).
- ✅ **Lot 5 — Registre d'apps externes** (livré 2026-07-19) : admin
  extension→app (défauts KiCad/LibreOffice/Inkscape/VLC), spawn env propre
  (piège Snap), repli xdg-open, menu contextuel dans l'arbre. Surcharge par
  projet : reportée v2.
- ✅ **Lot 6 — Outils du moteur neutre** (livré 2026-07-19) : palette
  read_file/list_dir/search/write_file/edit_file/bash avec permissions et
  garde anti-traversée, sélecteur de moteur par projet →
  **« tous agents à égalité » effectif**. Étalonnage petits modèles :
  qwen3.5:4b réussit les tâches d'agent simples (write_file + permission).
  → **V1 SOCLE COMPLÈTE (2026-07-19).**

**v2 — différenciation**

- 🔄 **Lot 11 — Page Projets « zen »** (démarré 2026-07-19) : toute la config
  dans un panneau gauche en sections dépliantes (Projet, LLM, Fichiers,
  Connaissances, MCP, Sessions), zone principale réservée à la conversation et
  à l'éditeur. Rendu Markdown des transcriptions (Projets + Chat), historique
  de sessions (liste/reprise/renommage/suppression), jauges conso harmonisées
  (OpenRouter en jauge comme Claude 5h/7j).
- 🔄 **Lot 12 — Connaissances & MCP v1** (démarré 2026-07-19) :
  documents épinglés par projet injectés au 1er tour de session ;
  `.mcp.json` à la racine du projet lu et passé au SDK Claude (outils
  `mcp__<serveur>__<outil>` soumis au flux de permission normal), section MCP
  en lecture (serveurs déclarés + compteurs d'utilisation).
- Lot 7 — Format agents YAML `.iaction/agents/` exécutable (sans GUI).
  → **Étude complète du menu « Orchestration » rédigée le 2026-07-19 :
  `docs/etude-orchestration.md`** (formats agents/orchestrations, UI en 3
  sous-onglets, exécution DAG dans le sidecar, phasage O1→O5) — à valider
  au grill (§9 de l'étude).
  🔄 O1 démarré (2026-07-19) : CRUD sidecar livré
  🔄 O3 démarré (2026-07-19) : moteur d'exécution sidecar livré
- Lot 8 — Page de perf : historisation + courbes (voies officielles).
  ✅ S1 livré (2026-07-19) : journal JSONL des tours côté sidecar (tokens,
  meta, marquage orchestration), instantanés abonnement, `usage.stats` /
  `usage.claude.history`, page « Supervision » (KPI, top modèles,
  histogramme, courbe abonnement 7j avec semaines saturées). Restant :
  migration SQLite si le JSONL montre ses limites, courbes de coûts
  OpenRouter, exports.
- Lot 9 — Éditeur visuel xyflow sur les agents YAML.
- Lot 10 — Config projet complète : doc IA, skills, RAG.
- Lot 13 — **Tâches planifiées** (agents récurrents : ménage-mails ✅ en
  précurseur hors UI, puis veille, suggestion-llm, maj-iaction, bourse).
  → **Étude rédigée le 2026-07-19 : `docs/etude-taches.md`** (manifeste
  `tache.yaml`, portée « tâche » aux côtés de projet/global, timers systemd
  pilotés par l'app, boîte de réception des rapports, phasage T1→T4) —
  validée le 2026-07-19.
  ✅ T1 livré (2026-07-19) : méthodes `taches.*` sidecar + sous-onglet
  « Tâches » (fiche, rapports Markdown, « Lancer maintenant », badge non-lu,
  portée tâche dans le contexte) ; menage-mails migrée (`tache.yaml`).
  ✅ T2 livré (2026-07-19) : timers systemd générés/pilotés par le sidecar
  (`taches.timer*`), interrupteur Armée/Désarmée, prochain/dernier run,
  LLM visibles par tâche, bouton Rapports direct ; menage-mails migrée aux
  unités générées et passe vérifiée dans le contexte systemd réel.
- Lot 14 — **Routage LLM & économie de tokens** (routeur natif sidecar,
  sans LiteLLM). → **Étude comparative validée au grill le 2026-07-27 :
  `docs/etude-routage-llm.md`** (orientation A+C+E, table « local
  d'abord » avec étage intra-abonnement Haiku→Sonnet→Fable/Opus,
  `model: auto` défaut au Chat, débord OpenRouter plafonné, phasage
  B0+R0→R5). Absorbe la piste flexibilité n° 2 (RAG local) en R5.
  ✅ B0 démarré (2026-07-27) : script `scripts/usage-baseline.mjs` livré ;
  1er relevé : coût nul 96 % mais mix intra-abo inversé (Opus+Fable = 90 %
  des tours abo, Haiku 8 %), local 0 %, fenêtre 5 h touchée à 100 %.
  ✅ R0 livré (2026-07-27, spec `docs/spec-r0-openrouter.md`) : fallback
  `models`, tri par prix, comptabilité d'usage (costUsd/cachedTokens,
  modelUsed) — opt-in par fournisseur.
  ✅ R1 livré (2026-07-27, spec `docs/spec-r1-routeur.md`) : `router.ts`
  (heuristique 4 tiers, table configurable), « Auto (routeur) » défaut des
  nouvelles conversations Chat, badge + affinité de session, `routeTier`
  historisé.
  ✅ R2 livré (2026-07-27, spec `docs/spec-r2-classificateur.md`) :
  classificateur qwen local sur cas ambigus (timeout 3 s), Auto opt-in page
  Projets, `engine: auto` dans les agents YAML/orchestrations (tâches via
  leurs agents), surcharge `.iaction/routage.yaml`.
  ✅ R3 livré (2026-07-27, spec `docs/spec-r3-debord.md`) : débord auto si
  fenêtre 5 h ≥ seuil (bandeau), plafond mensuel $ avec coupure, encart
  « Routage » dans Supervision.
  ✅ R4 livré (2026-07-27, spec `docs/spec-r4-contexte.md`) :
  `context.compact` (résumé local des longues conversations neutres,
  10 derniers tours intacts, résumé consultable), ordre des messages
  cache-friendly documenté.
  ✅ R5 livré (2026-07-28, spec `docs/spec-r5-rag.md`) : index embeddings
  local (`knowledge.*`, Ollama /api/embed, incrémental), outil
  `search_knowledge` dans les deux moteurs (palette neutre + MCP in-process
  Claude), mode connaissances injection/rag par projet.
  → **LOT 14 CODE COMPLET (2026-07-28)** — builds + tests verts.
  ⚠️ Vérifications manuelles en attente (app à lancer par l'utilisateur) :
  appel OpenRouter réel avec comptabilité d'usage, tour Auto de bout en
  bout (badge + affinité), bandeau de débord, indexation RAG réelle
  (nomic-embed-text à `ollama pull` si absent). Cible chiffrée : à fixer
  après 2 semaines de relevés (`scripts/usage-baseline.mjs`).

- Lot 15 — **Journal applicatif consolidé & amélioration continue**.
  → **Étude rédigée le 2026-07-31 : `docs/etude-logs.md`** (inventaire de
  l'existant, cinq défauts de fond, journal `logs/app.jsonl` à 5 niveaux de
  criticité, trois portes d'entrée, phasage L1→L5). Contrat protocolaire écrit
  le 2026-07-31 : `docs/protocol.md` § « Méthodes L1 — journal applicatif ».
  Motivation : l'observabilité maximale est un objectif de l'architecture
  cible — avant ce lot, le stderr était volatile, l'UI ne journalisait rien,
  et `events.jsonl` savait qu'un tour avait échoué sans jamais dire pourquoi.
  🔄 L1→L5 démarrés (2026-07-31) : socle sidecar + `errorMessage`, capture
  UI/Rust, panneau « Journal » par criticité dans Système, tâche hebdomadaire
  `qualite-iaction` qui propose des tickets (rapport seul, décision humaine).

- Lot 16 — **Exécution distante (OVH) & multi-poste Windows**.
  → **Étude validée au grill le 2026-08-05 : `docs/etude-remote.md`**
  (conteneur permanent `ia-runner` sur le dédié OVH — celui de Nextcloud —,
  synchro Nextcloud headless des projets en liste blanche, zones d'écriture
  disjointes, 4 déclencheurs : cron / « lancer puis éteindre » par fichier de
  demande / indexation RAG / webhooks + conditions, jeton d'abonnement +
  `.env` 600, ntfy auto-hébergé + heartbeat, phasage D1→D6 avec Windows en
  D6 : parité sauf planification locale, installeur). **Pas de mise en ligne
  de l'app** : aucune API réseau applicative ; amendement de doctrine
  « aucun envoi hors de l'infra personnelle ». L'app Android reste hors
  périmètre (regrill dédié le jour venu).

- **Dette de structure** (relevée après la revue complète du 2026-08-07)
  → **Étude rédigée le 2026-08-07 : `docs/etude-structure.md`** (quatre
  fichiers-dieux concentrant la moitié de l'interface, 36 copies des mêmes
  helpers défensifs, contrat inter-couches tenu par des commentaires, 563
  lignes de test pour 31 000 lignes d'interface). Diagnostic : le code n'a pas
  de frontières internes, et seulement dans l'UI — les couches sont justes, la
  coquille Rust est exemplaire. Remède en 8 étapes MÉCANIQUES (déplacement, pas
  réécriture), par valeur décroissante, chacune livrable seule. Étape 0 déjà
  faite (`agentTurns.ts`). **Ni réécriture, ni framework d'état** : le problème
  n'est pas le mécanisme mais l'absence de frontière.

- **Stratégie de test** (rédigée 2026-08-07 : `docs/plan-de-test.md`) — quel
  niveau prouve quoi, ce que la CI fait sans intervention, et les QUATRE
  domaines qui ne relèvent que de l'humain (recette de version en 10 minutes,
  matériel, intégrations réelles, jugement d'usage). Règle : tout défaut
  devient un test au niveau le PLUS BAS qui l'aurait attrapé, et ce qui n'est
  pas testé est écrit noir sur blanc.

**Pistes flexibilité (proposées 2026-07-19, à valider au grill)**

1. ✅ **Connaissances niveau 2 — dossier auto** (livré 2026-07-19) :
   `.iaction/connaissances/` chargé d'office, panneau en trois groupes
   (Épinglées / Automatiques / Détectées : CLAUDE.md + `.claude/memory/`).
2. **Connaissances niveau 3 — RAG indexé local** : embeddings via Ollama
   (`nomic-embed-text`) + index SQLite, exposé aux DEUX moteurs comme outil
   `search_knowledge` (le modèle interroge au lieu de tout injecter).
3. **Bases de connaissances globales** partagées entre projets par simple
   dossier (~/.iaction/connaissances/) — pont conforme à l'axe 8 (fichiers).
4. **MCP niveau 2** : éditeur graphique des serveurs (ajout/test/activation
   par projet, statut live), et **pont MCP → moteur neutre** (les outils MCP
   deviennent des outils de la palette neutre : vrais « tous agents à
   égalité »).
5. **Profils par projet** : presets nommés moteur+modèle+mode+instructions,
   bascule en 1 clic depuis le panneau LLM.
6. **Instructions projet éditables en place** : CLAUDE.md /
   `.iaction/instructions.md` créés/édités depuis le panneau (lus par les
   deux moteurs).
7. **Épinglage à chaud** : « joindre ce fichier au prochain message » depuis
   l'arbre (ponctuel, sans le déclarer connaissance durable).
8. **Bibliothèque de prompts** : modèles de prompts réutilisables avec
   variables (`{{fichier}}`, `{{projet}}`), globaux ou par projet.

## Décisions ouvertes / inconnues

| Sujet | État | Échéance |
|---|---|---|
| **Nom définitif** (iaction = nom de travail ; `.iaction/` est gravé) | ouvert | avant release publique |
| **MIT vs Apache-2.0** | ouvert (pencher Apache si brevets/produit) | avant 1er push public |
| **CGU Anthropic apps tierces sur abonnement** | **vérifié 2026-07-19** : la doc Agent SDK interdit aux apps tierces d'offrir le login claude.ai sans approbation Anthropic. Conséquence : usage perso via le login Claude Code local = OK ; pour la diffusion publique, l'app proposera la clé API par défaut et demandera l'approbation Anthropic pour le mode abonnement | avant diffusion (pas bloquant perso) |
| **Qualité agentique petits modèles Ollama** | à étalonner au lot 6 | lot 6 |
| **Format exact infos de limites côté Agent SDK** (pour la jauge abo) | à vérifier | lot 8 |
