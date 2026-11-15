# Étude — tirer parti de la mémoire automatique dans IAction

*Note du 2026-11-07 — état des lieux, rien n'est encore décidé ni codé.*

## Question

La plupart des assistants IA mettent leur mémoire à jour tout seuls. Comment
IAction peut-il en profiter ?

## Constat : IAction en profite déjà, en partie et sans le savoir

En mode projet, le moteur Claude utilise le prompt système standard de Claude
Code (`{ type: "preset", preset: "claude_code" }`, voir
`sidecar/src/paletteTour.ts`, `composerInstructionSysteme`) et charge tous les
réglages (`settingSources: ["user", "project", "local"]`,
`sidecar/src/claude.ts`). Ce prompt standard contient la consigne de mémoire
automatique : l'agent lit et écrit dans
`~/.claude/projects/<projet>/memory/` (un fichier par fait, plus l'index
`MEMORY.md`), exactement comme dans VSCode.

Mesure sur les 400 dernières sessions : 14 des 396 sessions lancées par le SDK
(donc par IAction) lisent ou écrivent ces fichiers de mémoire. Comme
`~/.claude-compte2/projects` est un lien symbolique vers `~/.claude/projects`,
les deux comptes partagent ces mémoires.

## Ce qui manque

1. **Deux mémoires concurrentes.** Le guide envoyé aux agents
   (`sidecar/src/projectDoc.ts`, rubrique « De la mémoire durable ») leur dit
   d'écrire dans `.claude/memory/*.md`, à l'intérieur du projet. C'est
   l'ancienne convention, qu'un seul autre projet utilise encore. La mémoire automatique,
   elle, écrit dans `~/.claude/projects/<projet>/memory/`. L'agent reçoit donc
   deux consignes contradictoires.
2. **Le RAG n'indexe pas la vraie mémoire.** `collectSources`
   (`sidecar/src/knowledge.ts`) lit seulement `.claude/memory/`. Les mémoires
   automatiques n'y sont pas, alors que certains projets en ont des dizaines
   (66 pour robot-ros, 51 pour orgaia).
3. **La mémoire est invisible.** Rien dans l'interface ne montre ce que
   l'agent a retenu, et le journal ne trace aucune écriture. Ça va contre
   l'objectif « aucun échec muet » : une mémoire fausse influence tous les tours
   suivants sans que personne ne le voie.
4. **Certains modes en sont privés.** Le chat pur n'a pas d'outils et pas le
   prompt standard, donc pas de mémoire. Le moteur neutre (Ollama,
   OpenRouter) n'a rien non plus.
5. **Index trop gros.** Le `MEMORY.md` de robot-ros pèse 19 Ko. Claude Code ne
   charge que le début de ce fichier : au-delà d'une certaine taille, les
   dernières entrées sont ignorées sans aucun message.
6. **Pas de synchro entre postes.** Ces mémoires sont dans `~/.claude`, pas dans
   git. La synchro du contexte (D1) ne les transporte pas.

## Pistes, par rapport gain/effort

| # | Action | Effort |
|---|---|---|
| A | Aligner le guide de `projectDoc.ts` sur la mémoire automatique, et migrer celle de cet autre projet | très faible |
| B | Ajouter le dossier de mémoire automatique du projet aux sources du RAG (ça couvre aussi le moteur neutre) | faible |
| C | Afficher les mémoires dans le panneau latéral : liste, ouverture, suppression, alerte si l'index est trop gros. Signaler chaque écriture dans le fil du tour et dans le journal | moyen |
| D | Mémoire propre à chaque rôle d'agent d'orchestration : le SDK propose une option `memory` (`'user' \| 'project' \| 'local'`) qui range les fichiers dans `agent-memory/<agent>/`. Un « relecteur » accumulerait ainsi ses propres leçons | moyen, à étudier |
| E | Faire suivre ces dossiers dans la synchro multi-poste | dépend de D1 |

Recommandation : A et B tout de suite (quelques lignes chacune, et elles
suppriment l'incohérence). C a le plus de valeur pour l'objectif
d'observabilité. D et E demandent un vrai arbitrage avant d'être lancés.
