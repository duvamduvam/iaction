# Tâche `qualite-iaction` — gabarit

Gabarit **versionné** de la tâche planifiée qui ferme la boucle
d'amélioration continue décrite dans [docs/etude-logs.md](../../../docs/etude-logs.md)
§ 2.7 (tranche L5) : *erreur vécue → ligne structurée → agrégat → rapport
hebdo → ticket → correction*.

Ce dossier n'est **pas** une tâche installée : rien ici n'est lu par
l'application tant que vous ne l'avez pas copié dans l'espace des tâches. Il
est livré **désarmé** (`enabled: false`) et sans timer systemd.

## À quoi elle sert

Une fois par semaine (lundi 09h00 par défaut), un agent lit les journaux
**locaux** de l'application :

- `~/.config/net.duvam.iaction/logs/app.jsonl` (+ `.1`) — journal applicatif ;
- `~/.config/net.duvam.iaction/usage/events.jsonl` (+ `.1`) — un événement
  par tour LLM, avec `errorMessage` depuis la tranche L4.

et rend `rapports/<date>.md` : top des erreurs de la semaine, nouveautés par
rapport à la semaine précédente, régressions, scopes les plus fragiles, taux
d'échec par moteur/fournisseur, angles morts — puis une section **« Tickets
proposés »** rédigée au format exact de [docs/tickets.md](../../../docs/tickets.md)
(ligne de tableau + section détaillée, identifiants laissés en `T-XXX`).

Deux principes non négociables, écrits dans le prompt de l'agent :

- **Local-first, aucune sortie réseau.** Pas de recherche web, pas de `curl`,
  rien ne quitte le poste. Les journaux contiennent des chemins de projets.
- **Rapport seul.** L'agent ne modifie jamais `docs/tickets.md`, ni aucun
  fichier : il propose, l'humain attribue les IDs et décide.

L'allowlist `tools: [Read, Grep, Glob, Bash]` de l'agent est **appliquée par le
moteur** depuis le 2026-08-07 ([T-003](../../../docs/tickets.md)) : Write et
Edit ne lui sont pas exposées, quel que soit le `permissionMode`. C'est ce qui
tient la « lecture seule », le prompt n'étant pas une frontière de sécurité.

> ⚠️ Bash reste dans la liste (agrégation `grep`/`awk`/`jq` sur du JSONL) — et
> Bash peut écrire comme sortir sur le réseau. Sur ces deux points, seul le
> prompt garde : une tâche planifiée tourne forcément en
> `permissionMode: bypassPermissions` (le runner headless n'a personne pour
> répondre au flux de permission). Raison de plus pour **roder en rapport
> seul** et relire les premiers rapports avant d'armer le timer.

## Installation

1. **Copier le gabarit** dans l'espace des tâches :

   ```sh
   cp -r assets/taches/qualite-iaction \
     "${XDG_CONFIG_HOME:-$HOME/.config}/net.duvam.iaction/taches/qualite-iaction"
   ```

   (Le `.iaction/` du gabarit part avec — c'est lui qui porte l'orchestration
   et l'agent de la tâche.)

2. Dans l'app : **Orchestration → Tâches**. La tâche `qualite-iaction`
   apparaît, **Désarmée**. Ouvrir sa fiche pour vérifier le manifeste, et
   renseigner si vous le souhaitez l'entrée `depot` avec le chemin absolu du
   dépôt iaction — l'agent y relit `docs/tickets.md` en lecture seule pour
   éviter de proposer un doublon d'un ticket déjà ouvert.

3. Le sélecteur de contexte de la page Orchestration gagne une entrée
   « Tâches → qualite-iaction » : c'est là qu'on relit ou ajuste l'agent
   `analyste-qualite` et l'orchestration `qualite-iaction` du dossier.

Variante sans copie de fichiers, entièrement depuis l'UI : créer la tâche via
**Tâches → Nouvelle tâche**, onglet YAML, en collant `tache.yaml` ; puis, une
fois la tâche sélectionnée dans le sélecteur de contexte, créer l'agent et
l'orchestration en collant les deux autres YAML de ce dossier.

## Rodage — rapport seul avant tout armement

Même cycle de confiance que les autres tâches du projet (voir
[docs/etude-taches.md](../../../docs/etude-taches.md) § 1) : **on rode en
rapport seul, on arme ensuite**.

1. Laisser `enabled: false`. Lancer la tâche à la main avec **« Lancer
   maintenant »**, une fois par semaine, pendant deux ou trois semaines.
2. Lire chaque rapport dans l'onglet **Rapports** de la fiche : les agrégats
   sont-ils justes ? les tickets proposés sont-ils actionnables, ou du bruit ?
   Ajuster le prompt de `analyste-qualite` tant que la réponse est « du bruit ».
3. Seulement quand deux rapports d'affilée sont exploitables : basculer
   l'interrupteur **Armée** sur la fiche de la tâche — l'app écrit alors les
   unités systemd et active le timer hebdomadaire.

Rien à faire côté écriture de tickets : l'agent ne touchera jamais
`docs/tickets.md`, c'est vous qui collez ce qui mérite de l'être.
