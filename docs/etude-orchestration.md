# Étude — menu « Orchestration » (agents & configurations d'orchestration)

Statut : **étude, à valider au grill** (demandée le 2026-07-19). Couvre et
précise les Lots 7 (agents YAML) et 9 (éditeur visuel) du plan, et ajoute la
partie « exécution orchestrée » qui n'était qu'esquissée.

## 1. Vision

Un onglet de premier niveau **Orchestration** (entre Chat et Configuration)
où l'on peut :

- **voir et éditer les agents** déclarés (par projet et globaux) ;
- **composer des orchestrations** : des enchaînements d'agents (séquence,
  parallèle, superviseur → travailleurs) déclarés en YAML ;
- **lancer et suivre les exécutions** : quel agent tourne, sur quel modèle,
  ce qu'il consomme, ce qu'il produit.

Principe directeur (déjà appliqué au reste de l'app) : **« tous agents à
égalité »** — un agent se définit indépendamment de son moteur (Claude
abonnement, Ollama, OpenRouter), et les orchestrations peuvent mélanger les
moteurs (ex. superviseur Claude + travailleurs qwen locaux gratuits).

## 2. Existant sur lequel on s'appuie

| Brique | État | Réutilisation |
|---|---|---|
| Moteur Claude (`claude.start`) | livré | exécution d'une étape d'agent |
| Moteur neutre (`neutral.start`, palette d'outils) | livré | idem, modèles locaux/OpenRouter |
| Sessions persistées par projet | livré | un run d'orchestration = une session traçable |
| `.iaction/` par projet | livré (créé à la déclaration) | siège des fichiers agents/orchestrations |
| `.claude/agents/*.md` (Claude Code) | détecté (badge) | source d'import (lecture seule) |
| MCP `.mcp.json` | livré (moteur Claude) | outils des agents |
| Connaissances épinglées | livré | contexte injectable par agent |
| Permissions (default/acceptEdits/plan/bypass) | livré | mode par agent/étape |

Conformité axe 8 (isolation totale entre apps) : les agents et orchestrations
sont des **fichiers dans le projet** — pont autorisé (fichiers agents), aucun
couplage runtime avec d'autres applications.

## 3. Concepts et vocabulaire

- **Agent** : définition déclarative réutilisable — « qui je suis, sur quel
  moteur/modèle je tourne, avec quelles instructions, quels outils, quelles
  permissions ». Ne contient PAS de tâche : la tâche vient de l'orchestration
  (ou de l'utilisateur).
- **Orchestration** : composition nommée d'étapes. Chaque étape référence un
  agent, lui donne une tâche (prompt template), et déclare ses dépendances.
- **Exécution (run)** : instance datée d'une orchestration (ou d'un agent
  seul) sur un projet, avec journal, statuts par étape et consommation.

## 4. Formats de fichiers (source de vérité : le disque, pas l'app)

### 4.1 Agent — `.iaction/agents/<nom>.yaml`

```yaml
name: relecteur-rust            # [a-z0-9-], unique dans son répertoire
description: Relit les diffs Rust et signale les pièges unsafe/perf.
engine: claude                  # claude | neutral
provider: null                  # neutral : id fournisseur (ollama, openrouter…)
model: claude-fable-5           # ou qwen3.5:4b, etc.
permissionMode: acceptEdits     # default | acceptEdits | plan (claude) | bypassPermissions
instructions: |                 # system prompt (markdown multi-lignes)
  Tu es relecteur. Réponds en français. …
tools:                          # optionnel — allowlist ; absent = palette complète
  - read_file
  - search
mcp: true                       # hérite du .mcp.json du projet (claude ; neutre en v2)
knowledge:                      # optionnel — chemins injectés au 1er tour
  - docs/conventions.md
maxTurns: 12                    # garde-fou
```

Points tranchés proposés :
- **YAML et non JSON** : lisible/diffable, commentaires possibles (le plan
  l'annonçait dès l'axe 7). Parseur : `yaml` (npm, ~0 dépendance transitive)
  côté sidecar uniquement — l'UI passe par le protocole.
- **Portée** : agents de projet (`<projet>/.iaction/agents/`) + agents
  globaux (`~/.config/net.duvam.iaction/agents/`). Même format ; en cas de
  collision de nom, le projet gagne.
- **Import Claude Code** : les `.claude/agents/*.md` (frontmatter name/
  description/tools + corps = instructions) sont AFFICHÉS en lecture seule
  (badge « importé ») et exécutables sur le moteur Claude ; bouton
  « Convertir en .iaction » pour les éditer. Aucune écriture dans `.claude/`.

### 4.2 Orchestration — `.iaction/orchestrations/<nom>.yaml`

```yaml
name: revue-complete
description: Relecture parallèle puis synthèse.
inputs:                          # variables demandées au lancement
  - name: cible
    label: "Fichier ou dossier à relire"
    default: ""                  # optionnel — valeur si non fourni au lancement
                                 # (chaîne vide permise) ; absent = input REQUIS.
                                 # Nécessaire aux tâches planifiées (aucune saisie).
steps:
  - id: relecture-rust
    agent: relecteur-rust        # nom d'agent (projet puis global)
    task: "Relis {{cible}} et liste les problèmes."
  - id: relecture-securite
    agent: auditeur-securite
    task: "Audite {{cible}} (secrets, injections, permissions)."
  - id: synthese
    agent: synthetiseur
    needs: [relecture-rust, relecture-securite]   # DAG par dépendances
    task: |
      Synthétise ces relectures en un rapport unique :
      {{steps.relecture-rust.output}}
      {{steps.relecture-securite.output}}
limits:
  maxParallel: 2                 # étapes simultanées (défaut 2)
  maxDurationMin: 30             # coupe-circuit global
```

- **DAG par `needs`** (pas de graphe séparé) : simple à écrire à la main, et
  l'éditeur visuel (Lot 9, xyflow) se contentera de générer/lire ce format.
- **Templating minimal** : `{{input}}` et `{{steps.<id>.output}}` uniquement
  (pas de langage de template complet). `output` = texte final de l'étape.
- Une étape échoue → les étapes qui en dépendent sont annulées, les autres
  branches continuent ; le run est marqué « partiel ».

### 4.3 Exécutions — journal

`{app_data_dir}/state/orchestration-runs.json` (state store existant) pour la
v1 : liste bornée (50 derniers runs) de méta-données + statuts par étape +
usage. Le TEXTE des étapes vit dans la session de conversation créée pour le
run (réutilise l'historique de sessions livré au Lot 11 t2) — pas de double
stockage. L'historisation SQLite fine reste au Lot 8.

## 5. UI — onglet « Orchestration »

Navigation principale : `Projets · Chat · Orchestration · Configuration ·
Système`. Sous-navigation en pilules (même patron que Configuration) :

1. **Agents** — grille de cartes (nom, description, moteur+modèle, portée
   projet/global/importé, badges outils/MCP/connaissances). Actions : créer
   (formulaire ↔ YAML brut synchronisés, validation à la volée), dupliquer,
   supprimer, **« Essayer »** (ouvre la page Projets avec cet agent armé sur
   la session courante — v1 du « dry run »).
2. **Orchestrations** — liste + éditeur : v1 = formulaire d'étapes (agent,
   tâche, needs) avec aperçu du DAG en liste indentée ; v2 (Lot 9) = graphe
   xyflow. Bouton « Lancer » → choix du projet + saisie des `inputs`.
3. **Exécutions** — tableau des runs (orchestration, projet, départ, durée,
   statut, coût/usage par moteur) ; détail d'un run = frise des étapes avec
   statut, agent, modèle, extrait de sortie, lien « ouvrir la session ».

Le sélecteur d'agent apparaît AUSSI dans la page Projets (section LLM du
panneau) : choisir un agent y préconfigure moteur/modèle/instructions — un
agent est utilisable seul, sans orchestration.

## 6. Exécution — architecture

Tout dans le **sidecar** (nouveau module `orchestrator.ts`), qui réutilise
les moteurs existants comme des briques internes :

- Nouvelles méthodes protocole :
  - `agents.list` / `agents.read` / `agents.write` / `agents.delete`
    (portée projet|global ; validation YAML côté sidecar, erreurs lisibles) ;
  - `orch.list` / `orch.read` / `orch.write` / `orch.delete` ;
  - `orch.run {orchestration, projectId/cwd, inputs}` → chunks streamés :
    `run_started`, `step_started`, `step_chunk` (relais des chunks moteur,
    taggés `stepId`), `step_done`, `step_failed`, `run_done` ;
  - `orch.abort` (annule les étapes en cours et à venir).
- **Permissions** : chaque étape hérite du `permissionMode` de son agent ;
  les `permission_request` remontent taggées `stepId` et s'affichent dans le
  suivi de run (une orchestration en mode `default` reste interactive).
- **Parallélisme** : pool borné (`maxParallel`), les moteurs savent déjà
  gérer plusieurs sessions simultanées (état par `id` de requête).
- **Consommation** : usage par étape déjà remonté par les moteurs → agrégé
  par run et par moteur ; l'encart conso global en profite sans changement.

Écarté : processus orchestrateur séparé (complexité sans bénéfice à cette
échelle) ; exécution côté UI (la webview ne doit pas porter de logique
longue durée) ; DSL de workflow riche (boucles/conditions) en v1 — le DAG +
templating couvre les cas réels de départ, on itérera sur besoin.

## 7. Phasage proposé

| Phase | Contenu | Taille |
|---|---|---|
| **O1** | Formats YAML + méthodes `agents.*`/`orch.*` (CRUD + validation), onglet Orchestration (Agents + Orchestrations en éditeur formulaire/YAML), import lecture seule `.claude/agents` | 1 lot |
| **O2** | Exécution d'un agent seul depuis la page Projets (sélecteur d'agent, section LLM) | ½ lot |
| **O3** | `orch.run` (DAG, parallélisme borné, templating), sous-onglet Exécutions, sessions liées | 1 lot |
| **O4** | Éditeur visuel xyflow (Lot 9) au-dessus du même format | 1 lot |
| **O5** | Confort : agents globaux partagés, conversion `.claude/agents`, pont MCP moteur neutre pour les agents | ½ lot |

## 8. Risques & garde-fous

- **Emballement de coûts** : `maxTurns` par agent, `maxDurationMin` et
  `maxParallel` par orchestration, affichage du coût en direct dans le run.
- **Permissions en parallèle** : plusieurs `permission_request` simultanées —
  l'UI les met en file (une modale à la fois, taggée par étape).
- **YAML invalide** : validation sidecar avec messages précis (ligne/champ) ;
  l'UI n'écrit jamais un fichier qui ne re-parse pas.
- **Compat future Claude Code** : on lit leur format d'agent mais on n'écrit
  que le nôtre — aucune dépendance à leur évolution.

## 9. Décisions à trancher au grill

1. Valider le **format agent** (§4.1) et le **format orchestration** (§4.2).
2. Agents globaux : dossier `~/.config/net.duvam.iaction/agents/` — OK ?
3. Phasage O1→O5 — ordre et découpage OK ?
4. Nom de l'onglet : « Orchestration » (retenu ici) vs « Agents ».
