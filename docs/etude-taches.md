# Étude — Tâches planifiées (agents récurrents)

Statut : étude, en attente de validation. Rien d'implémenté hors du
précurseur « ménage-mails » (timer systemd artisanal, hors UI).

## 1. Le constat

La tâche ménage-mails a montré le motif complet d'un agent récurrent :

- un **espace propre** (`~/.config/net.duvam.iaction/taches/menage-mails/`)
  avec ses agents/orchestrations `.iaction/`, son `.mcp.json`, ses secrets au
  trousseau ;
- une **planification** (timer systemd user, 08h15) ;
- des **rapports datés** (`rapports/<date>.md`, écrits par le runner via
  `--save-output`) ;
- un **cycle de confiance** (rodage rapport-seul → armement réel).

Mais l'UI ne connaît que deux portées (projet déclaré, global) : la tâche est
invisible dans la vue Orchestration. La question n'est pas « comment déclarer
ce dossier comme projet ? » mais « quel est le bon citoyen de première
classe ? ».

**Projet** = un répertoire de travail où l'on développe (l'humain pilote).
**Tâche** = un agent qui travaille seul, à heure fixe, et rend des comptes.
Les confondre polluerait le registre de projets et masquerait ce qui compte
pour une tâche : cadence, dernier run, dernier rapport, état d'armement.

## 2. Les tâches envisagées (cahier des charges implicite)

| Tâche | Cadence | Il lui faut | Sortie |
|---|---|---|---|
| **ménage-mails** (existe) | quotidien | MCP IMAP, trousseau | rapport + corbeille |
| **suggestion-llm** | mensuel | web (catalogue OpenRouter/Ollama), *données d'usage locales* (quels modèles, quels volumes, quels usages) | rapport de recommandations |
| **veille** | hebdo (par thème ?) | recherche web ; thèmes configurables (géopolitique, IA, …) | digest par thème |
| **maj-iaction** | hebdo/mensuel | lire le dépôt iaction, web (versions Tauri/React/SDK, nouvelles technos) | rapport d'obsolescence + pistes |
| **bourse** | quotidien/hebdo | données de marché (source à choisir), profil de placement | analyse/alertes — **jamais d'ordre passé** : rapport seul, décision humaine |

Enseignements transverses :

- Toutes produisent des **rapports Markdown datés** → il faut une « boîte de
  réception des agents » dans l'UI, pas juste des fichiers.
- Trois sur cinq exigent la **recherche web** → le moteur `claude` l'offre via
  le SDK (WebSearch) ; le moteur neutre non. Premier critère de choix de
  moteur par tâche.
- `suggestion-llm` a besoin des **données d'usage d'iaction** (state store :
  compteurs de modèles, fable-usage) → prévoir un accès lecture (export JSON
  dans l'espace tâche avant le run, plutôt qu'un accès direct au state store).
- `maj-iaction` travaille sur un dépôt → c'est la seule qui ressemble à un
  projet ; elle restera une tâche dont le `cwd` de run pointe vers le dépôt.
- `bourse` impose une règle d'architecture : une tâche peut être
  **structurellement bornée au rapport** (pas d'outil d'action du tout), pas
  seulement par un flag readonly.

## 3. Architecture proposée

### 3.1 Le manifeste `tache.yaml`

Chaque tâche = un dossier `~/.config/net.duvam.iaction/taches/<nom>/` :

```yaml
# tache.yaml — manifeste de la tâche (source de vérité)
name: menage-mails
description: Ménage quotidien de la boîte mail.
orchestration: menage-mails      # .iaction/orchestrations/<nom>.yaml du dossier
schedule: "*-*-* 08:15"          # syntaxe OnCalendar systemd
inputs:                          # gabarit d'inputs ; {{today}} résolu au lancement
  date: "{{today}}"
report: "rapports/{{today}}.md"  # --save-output, résolu pareil
enabled: true                    # armé (timer actif) ou non
```

Le dossier garde `.iaction/` (agents + orchestrations), `.mcp.json`,
`rapports/`. Aucun secret dans le manifeste (trousseau uniquement).

### 3.2 Planification : systemd reste l'exécutant, l'app devient le pilote

L'app ne réinvente pas un démon : elle **génère et pilote** les unités
systemd user depuis le manifeste (`iaction-tache-<nom>.{service,timer}`,
`systemctl --user enable/disable/start`). Avantages : les tâches tournent
sans l'app (Persistent=true rattrape les réveils manqués), et l'app affiche
l'état réel (`list-timers`). Le runner headless existant est l'ExecStart —
il est déjà validé.

### 3.3 UI : sous-onglet « Tâches » dans Orchestration

Quatrième pilule à côté d'Agents / Orchestrations / Exécutions :

- **Liste des tâches** : nom, cadence, prochain run (list-timers), dernier
  run (statut + date), interrupteur Armée/Désarmée, bouton « Lancer
  maintenant » (réutilise la vue Exécutions live).
- **Fiche tâche** : manifeste éditable (formulaire ↔ YAML comme le reste),
  accès aux agents/orchestrations du dossier (le sélecteur de contexte de la
  vue Orchestration gagne une portée « tâche » à côté de projet/global).
- **Rapports** : liste datée + rendu Markdown (composant existant) ; badge
  « non lu » sur l'onglet quand un rapport est arrivé depuis la dernière
  visite — c'est la « boîte de réception des agents ».

### 3.4 Sidecar / protocole

Nouvelles méthodes (mêmes conventions que O1) : `taches.list`, `taches.read`,
`taches.write`, `taches.delete`, `taches.reports` ; côté Rust, une commande
`systemd_timer` (status/enable/disable — liste blanche stricte de la forme
des noms d'unité `iaction-tache-*`). Résolution `{{today}}` au lancement,
partagée entre UI et runner.

## 4. Phasage

- **T1 — Tâches visibles** : manifeste `tache.yaml`, méthodes `taches.*`,
  sous-onglet (liste + rapports + lancer maintenant). Migration de
  ménage-mails (écrire son manifeste, rien d'autre ne bouge).
- **T2 — Planification pilotée** : génération des unités systemd depuis le
  manifeste, interrupteur Armée/Désarmée, prochain/dernier run affichés.
- **T3 — Nouvelles tâches** : veille (hebdo, thèmes en inputs), puis
  suggestion-llm (mensuel, avec export JSON d'usage), puis maj-iaction.
- **T4 — bourse** : après choix d'une source de données ; rapport seul par
  construction.

## 5. Décisions à valider

1. La portée « tâche » comme 3ᵉ citoyen (projet / tâche / global) — plutôt
   que déclarer les tâches comme projets.
2. systemd user comme unique planificateur (pas de scheduler interne à
   l'app).
3. Les rapports comme contrat de sortie universel (`--save-output` par le
   runner) + boîte de réception dans l'UI.
4. Tâche `bourse` : strictement analyse/rapport, aucune capacité d'action.
