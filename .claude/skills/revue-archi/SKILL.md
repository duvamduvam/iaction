---
name: revue-archi
description: Revue d'architecture d'IAction — un passage complet, mesuré sur le code, pour rapprocher l'application de la meilleure forme possible VU SON BESOIN (locale, mono-utilisateur, observable) selon quatre axes — simple, robuste, efficace, malléable. Invoquer quand l'utilisateur demande une « revue archi », un « passage de revue », un état des lieux de l'architecture, ou s'inquiète d'une complexité qui monte. Produit un rapport daté dans docs/ et des tickets dans docs/tickets.md — jamais de refonte pendant la revue.
---

# Revue d'architecture — IAction

## Le juge de paix : le besoin, pas l'idéal

La question de la revue n'est jamais « est-ce une belle architecture ? » mais
« est-ce la meilleure application possible **vu le besoin** ? ». Le besoin
d'IAction est écrit et il est étroit :

- **locale et mono-utilisateur** — pas de serveur, pas de multi-tenant, pas de
  montée en charge. Toute complexité qui prépare l'un de ces trois est une
  complexité que le besoin ne paie pas ;
- **observabilité maximale** — aucun échec muet, journal consolidé, la doctrine
  du dépôt. Un défaut qui ne laisse pas de trace est plus grave qu'un défaut
  bruyant ;
- **local-first** — les seules sorties réseau sont celles que l'utilisateur
  demande.

Ce cadrage tranche les débats avant qu'ils ne commencent : une abstraction qui
servirait « si un jour on a plusieurs utilisateurs » est à refuser, pas à
discuter. Inversement, une redondance qui sert l'observabilité (journal en
double : stdout ET fichier) n'est pas une dette — elle est le besoin.

## Trois règles absolues du passage

1. **Mesurer avant de conclure.** Ce dépôt s'est déjà brûlé deux fois en
   concluant d'un examen partiel (corrections en tête de T-012 et T-019, dans
   `docs/tickets.md` — les lire). Chaque constat de la revue porte un chiffre,
   une commande, ou une citation de code avec `fichier:ligne`. Une impression
   n'est pas un constat.
2. **Constat = ticket, jamais de refonte pendant la revue.** La revue produit
   des tickets (`docs/tickets.md`, convention en tête de fichier), pas des
   commits de correction. Exception : une trouvaille dont le correctif tient en
   quelques lignes ET dont le ticket documente la clôture immédiate — le patron
   « créé et clos le même jour » que le backlog pratique déjà. Une réécriture
   générale est interdite : le chemin du dépôt est « par valeur décroissante,
   sans réécriture » (`docs/etude-structure.md` §5).
3. **Une revue qui ne trouve rien doit le dire.** Un axe sain est un résultat,
   pas un échec de la revue. Ne pas fabriquer de constat pour remplir le
   rapport.

## Étape 0 — Relire avant de regarder

Dans cet ordre, en diagonale mais en entier :

| Document | Ce qu'on y cherche |
|---|---|
| `docs/architecture.md` | l'état DÉCRIT — la revue mesure l'écart entre lui et le code |
| `docs/etude-structure.md` §2 et §6 | les pathologies déjà nommées et les 4 indicateurs de progrès |
| `docs/tickets.md` — tableau des ouverts + 5 derniers archivés | ce qui est déjà su, pour ne pas le « redécouvrir » |
| `docs/plan.md` | où va le produit — une dette sur un chemin abandonné ne vaut rien |

## Étape 1 — Le relevé chiffré

Toutes ces commandes sont sûres (lecture seule). Les lancer AVANT d'ouvrir un
seul fichier de code, et coller les chiffres en tête du rapport :

```bash
npm run cliquet                     # fichiers-dieux : combien, lesquels, tendance
node -e "const d=require('./scripts/cliquet-taille.json').derogations; \
  console.log(Object.keys(d).length,'dérogations,',Object.values(d).reduce((a,b)=>a+b,0),'lignes')"
# Ratio code/test par couche (le déséquilibre est LE fait, architecture.md §8) :
find ui/src -name '*.test.ts*' | xargs wc -l | tail -1
find ui/src -name '*.ts' -o -name '*.tsx' | grep -v test | xargs wc -l | tail -1
find sidecar/src -name '*.ts' | xargs wc -l | tail -1
find sidecar/test -name '*.js' -o -name '*.mjs' | xargs wc -l | tail -1
# Tickets : volume, âge, et ce que les archivés récents disent des pannes réelles
grep -c '| ouvert\||en cours' docs/tickets.md; grep -c '| fait\||abandonné' docs/tickets.md
# Bruit du journal réel (la crédibilité d'app.jsonl est un actif, T-007/T-008) :
node -e "const l=require('fs').readFileSync(process.env.HOME+'/.config/net.duvam.iaction/logs/app.jsonl','utf8').trim().split('\n');
  const n={};for(const x of l){try{const j=JSON.parse(x);n[j.level]=(n[j.level]||0)+1}catch{}};console.log(l.length,'lignes',n)"
npm audit 2>/dev/null | tail -3   # SANS npm install — jamais app ouverte
```

## Étape 2 — Les quatre axes

Passer les axes **dans cet ordre** : un défaut de simplicité produit des faux
constats sur les trois autres.

### Axe 1 — Simple

La simplicité d'IAction a une définition opérationnelle : **une vérité par
donnée, une déclaration par fait, chaque chose au seul endroit qui peut la
faire.**

- **Vérités multiples.** Chercher les données déclarées à plusieurs endroits
  sans garde qui les confronte. Précédents : la version (5 fichiers →
  `versionner.mjs`), la table de routage (2 fichiers → `routage-defauts.mjs`),
  la liste des modèles d'abonnement (3 fichiers → `modelesAbonnementClaude.ts`).
  Le patron de correction est toujours le même : une source dont les
  consommateurs dérivent, OU un garde dans `npm run verif` qui refuse l'écart.
  Un commentaire « identique à X » sans garde est un vœu, pas un invariant.
- **Devinettes.** Chercher les `includes(`, les regex sur identifiants, les
  comportements déduits d'un nom (`id.includes("ollama")` était l'exemple
  canonique, remplacé par le trait `billing`). Une devinette tolérée doit être
  à UN endroit, nommée, testée, avec le ticket qui prévoit sa disparition.
- **Fichiers-dieux.** `npm run cliquet` donne la carte. La question de revue
  n'est pas « lesquels » (le cliquet le sait) mais « lesquels ont GROSSI en
  dérogation depuis la dernière revue, et pourquoi » — `git log --stat` sur les
  fichiers en dérogation.
- **Couches.** Chaque couche fait-elle encore uniquement ce qu'elle seule peut
  faire (tableau d'`architecture.md` §1) ? Signaux d'alerte : de la décision
  métier dans un composant React, du rendu dans le sidecar, un secret qui
  transite hors de la coquille.
- **Complexité que le besoin ne paie pas.** Abstractions à un seul
  consommateur, options jamais utilisées, généricité « au cas où ». Le test :
  si on supprimait ceci, quel besoin ÉCRIT serait perdu ?

### Axe 2 — Robuste

La robustesse d'IAction se juge à une aune : **aucun échec muet** — et son
symétrique, découvert par T-007 : **aucun bruit qui rende le journal
illisible**.

- **Échecs muets.** Suivre les chemins d'erreur : un `catch` vide, un
  `.catch(() => {})` sans commentaire qui justifie le silence, un état qui
  attend sans plafond, un process enfant dont la mort n'est pas journalisée.
  Précédents : T-015 (tour mort sans trace), T-017 (mort du sidecar), T-030
  (mort de la webview — vérifier où il en est).
- **Bruit.** Une erreur journalisée en boucle pour un état nominal use la
  crédibilité du fichier qu'on ouvre quand ça va mal (T-007 : 140 lignes pour
  une sonde). Vérifier la densité relevée à l'étape 1 : les `error` du journal
  réel sont-ils des erreurs ?
- **Affordances honnêtes.** Tout ce qui a l'air cliquable doit pouvoir tenir sa
  promesse ; tout ce qui affiche un total doit dire s'il est minorant
  (précédents : T-024 boutons menteurs, T-035/T-036 dépense minorée). Chercher
  les endroits où l'interface affirme ce qu'elle ne sait pas.
- **Discipline R0.** Tout réglage ou champ ABSENT doit produire le comportement
  d'avant, à l'octet près. C'est ce qui permet d'ajouter sans casser. Vérifier
  que les ajouts récents la respectent (forme écrite omise et non vide,
  spread conditionnel dans les événements).
- **Habitat.** Le code qui décrit sa machine casse ailleurs : chemins Linux en
  dur, `/proc`, casse de fichiers, séparateurs. Trois précédents (T-014, T-037,
  T-053) — la CI Windows est le seul œil qui les voit, vérifier qu'elle couvre
  le code nouveau.
- **Le code qu'on croit exécuter.** Empreintes (`a-jour.mjs`, T-020), purge de
  mise en scène (T-041) : les garde-fous existent — vérifier qu'aucun chemin
  nouveau (script, CI, empaquetage) ne les contourne.

### Axe 3 — Efficace

Règle d'or du dépôt : **pas d'optimisation sans mesure, pas de conclusion sans
relevé** (T-029 : les jalons AVANT le remède ; T-048 : « mesurer avant de
corriger »).

- **Travail fait deux fois.** Précédent : la recherche web exécutée par nous
  puis par l'agent (T-025). Chercher les doublons de calcul, de fetch, de
  rendu — le re-parse Markdown à chaque frappe (résolu par `memo`) est le
  patron de ce qui peut revenir.
- **Budget de démarrage.** Les jalons existent (`demarrage.rs`/`.ts`). Les
  relever, comparer au dernier relevé de T-029, dire si ça dérive.
- **Poids embarqué.** Le bundle livré (`docs/empaquetage.md` §2) : rien n'y est
  entré sans raison ? Les exclusions (voix locale) tiennent-elles ?
- **Coût des tours.** Le routage par palier, le débord, la dépense de la
  période : les chiffres de Supervision reflètent-ils la réalité (minorants
  dits, coûts déclarés) ?
- **Ce qu'on ne mesure PAS encore** : le constat le plus utile de cet axe est
  souvent « tel coût est invisible » — c'est un ticket d'instrumentation, pas
  d'optimisation.

### Axe 4 — Malléable

Principe mesuré par ce dépôt : **les tests ne suivent pas la bonne volonté, ils
suivent la structure** (`architecture.md` §8). La malléabilité se lit donc dans
la structure, pas dans les intentions.

- **La décision est-elle extraite ?** Le patron gagnant du dépôt : une feuille
  pure, testable sans fenêtre ni process, consommée par le composant/moteur
  (`refFichier.ts`, `paletteTour.ts`, `modelPickerCalc.ts`,
  `supervisionPeriode.ts`…). Chercher la logique encore enfouie dans les
  fichiers en dérogation : c'est la prochaine extraction de valeur.
- **Ratio code/test par couche** (relevé de l'étape 1) : l'écart interface se
  resserre-t-il au fil des extractions ?
- **Les 4 indicateurs d'`etude-structure.md` §6** : copies de helpers,
  dérogations, lignes de test UI, méthodes du protocole couvertes bout en bout.
  Les relever tous les quatre, comparer au relevé précédent.
- **Coût de la prochaine feature.** Prendre 2 ou 3 évolutions plausibles du
  `plan.md` et tracer ce qu'elles toucheraient. Si l'une traverse un
  fichier-dieu ou exige une n-ième copie d'une vérité, c'est un constat.
- **Dérogations du cliquet = carte des dettes.** Leur nombre ne peut que
  baisser (le cliquet l'impose) ; la revue dit lesquelles gênent RÉELLEMENT et
  lesquelles peuvent attendre.

## Étape 3 — Le livrable

1. **Rapport** : `docs/revue-archi-AAAA-MM-JJ.md`, même ton que les études du
   dépôt — mesuré sur le code, français, chiffres en tête. Structure :
   - le relevé (étape 1), avec l'écart vs relevé précédent s'il existe ;
   - par axe : constats (chiffrés, `fichier:ligne`) ET ce qui est sain ;
   - le verdict : les 3 constats qui rapportent le plus, avec le coût de NE PAS
     les traiter — c'est ce coût qui justifie la priorité ;
   - ce que la revue n'a pas couvert, dit explicitement.
2. **Tickets** : chaque constat actionnable entre dans `docs/tickets.md`
   (convention du fichier : ligne de tableau + section, prio par coût du
   non-traitement). Le rapport pointe vers les tickets, pas l'inverse.
3. **Mise à jour d'`architecture.md`** seulement si la revue a montré que le
   document MENT (il décrit ce qui est — un écart constaté est soit un ticket
   sur le code, soit une correction du document).

## Précédent

La revue du 2026-08-07 a produit 20 constats, tous corrigés — ses leçons sont
dans la mémoire du projet et dans les tickets de l'époque. C'est le calibre :
des constats assez précis pour devenir des tickets le jour même, assez motivés
pour qu'on sache lesquels refuser.
