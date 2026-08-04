/**
 * Guide d'intégration IAction distribué DANS chaque projet — la « base
 * documentaire » que les agents (Claude Code, moteur projet, sous-agents)
 * peuvent lire sans jamais dépendre du code d'iaction (isolation totale :
 * les ponts autorisés sont les fichiers déposés dans le projet et le MCP).
 *
 * Source de vérité : la constante PROJECT_DOC_CONTENT ci-dessous, versionnée
 * avec le sidecar. `ensureProjectDoc(cwd)` la dépose/rafraîchit en
 * `<projet>/.iaction/connaissances/iaction.md` :
 *  - uniquement si `<projet>/.iaction/` existe déjà (vrai projet IAction —
 *    jamais de création de dossier dans un cwd quelconque) ;
 *  - écrasement UNIQUEMENT si le fichier porte le marqueur « généré » (un
 *    fichier édité à la main n'est jamais clobbé) ;
 *  - idempotent (aucune écriture si le contenu est déjà à jour).
 *
 * Le fichier vit dans `connaissances/` (sources « Automatiques » du panneau
 * Connaissances) : il est donc indexé dans le RAG local au prochain
 * `knowledge.index` et interrogeable via `mcp__iaction__search_knowledge`.
 * Appelé best effort par claude.ts en début de tour projet (pas par
 * knowledge.index : les tests d'indexation comptent des sources exactes, et
 * un tour projet précède toujours l'usage réel du panneau Connaissances).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import * as journal from "./journal.js";

/** Première ligne du fichier : le marqueur qui autorise le rafraîchissement. */
const PROJECT_DOC_MARKER = "<!-- généré par IAction — NE PAS ÉDITER : mis à jour automatiquement -->";

export const PROJECT_DOC_FILENAME = "iaction.md";

export const PROJECT_DOC_CONTENT = `${PROJECT_DOC_MARKER}

# IAction — guide d'intégration du projet

Ce projet est ouvert dans **IAction** (app de bureau de chat/agents
multi-fournisseur). Ce fichier décrit le contrat entre l'app et le projet :
ce qu'elle lit ici, ce qu'elle expose aux agents, et comment ajouter une
capacité — sans jamais avoir besoin de lire le code source d'iaction.

## Ce qu'IAction lit dans le projet

- \`CLAUDE.md\` — instructions projet du moteur Claude (chargées à chaque tour).
- \`.claude/\` — réglages locaux (\`settings.local.json\`), skills du projet
  (\`.claude/skills/\`), mémoire agent (\`.claude/memory/*.md\`). Les skills et
  réglages GLOBAUX (\`~/.claude/\`) ne sont PAS hérités (isolation par projet).
- \`.mcp.json\` — serveurs MCP du projet (stdio ou http), chargés par le moteur
  projet. Jamais en mode « chat pur » (page Chat, aucun outil).
- \`.iaction/\` — dossier d'IAction dans le projet :
  - \`project.json\` : identité du projet dans l'app ;
  - \`connaissances/\` : documents sources du RAG local (« Automatiques ») —
    fichiers texte/markdown, les liens symboliques sont suivis, > 1 Mo ignoré ;
  - \`connaissances-index/\` : index d'embeddings GÉNÉRÉ (chunks.jsonl +
    meta.json) — ne pas éditer, ne pas committer (gitignoré).

## Ce qu'IAction expose aux agents du projet

- **RAG local** : quand l'index existe, l'outil MCP
  \`mcp__iaction__search_knowledge\` (serveur in-process \`iaction\`) répond aux
  recherches sémantiques sur les connaissances du projet. Sources indexées :
  documents épinglés dans le panneau Connaissances, \`.iaction/connaissances/\`,
  \`CLAUDE.md\`, \`.claude/memory/*.md\`. Embeddings locaux via Ollama
  (\`nomic-embed-text\` par défaut). Indexation : panneau Connaissances.
- **Moteurs** : Claude (abonnement ou clé API) et moteur neutre
  (Ollama local / OpenRouter), avec routage automatique possible.
- **Orchestration** : enchaînements d'étapes multi-agents (page Orchestration),
  chaque étape pouvant cibler un moteur/modèle différent. Définis PAR FICHIERS
  dans le projet (voir ci-dessous) : un agent du projet peut donc en créer.
- **Tâches de fond** : un tour dont le modèle a fini mais dont des tâches de
  fond (commandes longues, sous-agents) vivent encore reste ouvert pour
  recevoir leurs rapports — plafonné (10 min par défaut), bouton « Rendre la
  main » dans l'UI pour clore sans attendre.

## Ajouter une capacité au projet

- **Un outil autonome** (serveur, script, API) → le déclarer dans
  \`.mcp.json\` ; préférer un outil générique par-projet plutôt que codé en dur.
- **De la connaissance** (docs de référence, notes) → déposer ou symlinker des
  \`.md\` dans \`.iaction/connaissances/\` puis relancer l'indexation.
- **Un savoir-faire agent** (workflow outillé, checklist) → un skill dans
  \`.claude/skills/\`.
- **De la mémoire durable** → \`.claude/memory/*.md\` (indexée dans le RAG).
- **Un agent réutilisable** (rôle nommé pour l'orchestration) →
  \`.iaction/agents/<nom>.yaml\` :

  \`\`\`yaml
  name: relecteur            # [a-z0-9-], unique
  description: Relit les pages et signale les problèmes.
  engine: claude             # claude | neutral | auto (routeur)
  provider: null             # neutral : ollama, openrouter…
  model: claude-fable-5      # ou qwen3:8b, etc. (null en auto)
  permissionMode: default    # default | acceptEdits | plan | bypassPermissions
  instructions: |
    Tu es relecteur. Réponds en français.
  mcp: true                  # hérite du .mcp.json du projet
  maxTurns: 12
  \`\`\`

  (Les \`.claude/agents/*.md\` de Claude Code sont aussi visibles, en lecture
  seule.)
- **Un enchaînement d'orchestration** (visible et lançable dans l'onglet
  Orchestration) → \`.iaction/orchestrations/<nom>.yaml\` :

  \`\`\`yaml
  name: revue-docs
  description: Contrôle puis synthèse.
  inputs:                    # variables demandées au lancement
    - name: cible
      label: "Page ou dossier à contrôler"
      default: ""            # utilisé si non fourni (chaîne vide permise) ;
                             # sans default, l'input est REQUIS — une tâche
                             # planifiée échouerait au lancement
  steps:
    - id: controle
      agent: relecteur       # nom d'agent (projet, puis global)
      task: "Contrôle {{cible}} et liste les problèmes."
    - id: synthese
      agent: relecteur
      needs: [controle]      # DAG par dépendances
      task: "Synthétise : {{steps.controle.output}}"
  limits:
    maxParallel: 2
    maxDurationMin: 30
  \`\`\`

  Portée globale possible (tous projets) dans
  \`~/.config/net.duvam.iaction/agents/\` et \`orchestrations/\` ; en cas de
  collision de nom, le projet gagne.
- **Une tâche récurrente** (exécution planifiée d'une orchestration) : un
  agent PEUT la créer en écrivant le manifeste
  \`~/.config/net.duvam.iaction/taches/<nom>/tache.yaml\` — c'est la SEULE
  écriture autorisée hors du projet (zone de contrat de l'app), et
  UNIQUEMENT avec \`enabled: false\` : l'armement du timer systemd reste un
  acte de l'utilisateur (bascule « Armée » dans la page Orchestration, où la
  tâche apparaît dès le fichier écrit). Format :

  \`\`\`yaml
  name: revue-hebdo            # [a-z0-9-], = nom du dossier
  description: Revue hebdomadaire de la doc.
  orchestration: revue-hebdo   # nom d'orchestration
  schedule: "Mon *-*-* 08:00"  # OnCalendar systemd
  inputs: {}                   # gabarit {{today}} disponible
  report: rapports/{{today}}.md
  enabled: false               # TOUJOURS false — l'utilisateur arme dans l'app
  cwd: /chemin/absolu/du/projet  # fait résoudre l'orchestration dans le repo
  \`\`\`

  Poser l'orchestration versionnée dans \`.iaction/orchestrations/\` du
  projet et la référencer via \`cwd\`. Faire aussi écrire le rapport dans le
  repo par la dernière étape de l'orchestration le rend versionnable et
  interrogeable.

## Règles

- Le projet ne doit JAMAIS dépendre du code d'iaction (chemins, imports) :
  le contrat, c'est ce fichier + les emplacements ci-dessus.
- Ce fichier est déposé et mis à jour par IAction. Pour le compléter,
  utiliser un autre fichier de \`connaissances/\` — toute édition ici sera
  écrasée à la prochaine mise à jour de l'app.
`;

/**
 * Dépose/rafraîchit le guide dans `<cwd>/.iaction/connaissances/` — best
 * effort, jamais d'exception (un échec d'écriture ne doit pas bloquer un tour).
 */
export async function ensureProjectDoc(cwd: string): Promise<void> {
  try {
    const iactionDir = path.join(path.resolve(cwd), ".iaction");
    const stat = await fsp.stat(iactionDir).catch(() => null);
    if (!stat?.isDirectory()) {
      return; // pas un projet IAction : on ne crée rien.
    }
    const target = path.join(iactionDir, "connaissances", PROJECT_DOC_FILENAME);
    const existing = await fsp.readFile(target, "utf8").catch(() => null);
    if (existing === PROJECT_DOC_CONTENT) {
      return; // déjà à jour.
    }
    if (existing !== null && !existing.startsWith(PROJECT_DOC_MARKER)) {
      return; // fichier édité à la main : on ne clobbe jamais.
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, PROJECT_DOC_CONTENT, "utf8");
    await fsp.rename(tmp, target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `warn` : le guide d'intégration est un confort, son absence ne casse
    // aucun tour — l'agent démarre normalement sans lui.
    journal.warn("knowledge", "dépôt du guide d'intégration impossible", {
      fields: { erreur: message },
    });
  }
}
