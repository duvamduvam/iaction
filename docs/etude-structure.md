# Étude — Fichiers-dieux et cohérence de la structure

> Rédigée le 2026-08-07, après une revue multi-angles ayant produit 20 constats
> confirmés. Motif : « on va vers l'usine à gaz ».
> Aucun besoin urgent — c'est précisément le bon moment.

## 1. Le constat, chiffré

| Couche | Fichiers | Lignes | Moyenne |
|---|---|---|---|
| `ui/src` | 59 | 31 080 | 526 |
| `sidecar/src` | 24 | 14 714 | 613 |
| `src-tauri/src` | 10 | 2 806 | 280 |

**48 600 lignes.** La coquille Rust est saine (280 lignes de moyenne, découpée
par responsabilité). Le problème est ailleurs.

### Les fichiers-dieux

| Fichier | Lignes | `useState` | `useEffect` | Composants |
|---|---|---|---|---|
| `AgentPage.tsx` | 5 558 | 49 | 33 | 10 |
| `ProvidersPage.tsx` | 3 400 | 67 | 13 | 26 |
| `OrchestrationPage.tsx` | 3 161 | 88 | 12 | 23 |
| `ChatPage.tsx` | 2 721 | 24 | 12 | 8 |
| `claude.ts` | 1 832 | — | — | — |
| `orchestrator.ts` | 1 812 | — | — | — |
| `sidecar.ts` (client UI) | 1 383 | — | — | 85 exports |

**Quatre fichiers concentrent 14 840 lignes — près de la moitié de l'interface.**
`OrchestrationPage` porte 88 `useState` dans une seule page.

### Ce qui est déjà arrivé à cause de ça

Ce n'est pas une inquiétude théorique. Le 2026-08-07, dans la même journée :

- un `return` placé au milieu des hooks d'`AgentPage` a tué **toute**
  l'interface au démarrage (« Rendered fewer hooks than expected ») — invisible
  au typecheck comme au build, trouvé en 30 s par `rules-of-hooks` une fois
  l'outil installé ;
- le même bug de file d'attente existait **en double**, dans `AgentPage` et
  `ChatPage`, parce que la seconde est un « portage direct » de la première
  (le commentaire le dit tel quel) ;
- les deux copies avaient déjà **divergé** (le brouillon est vidé d'un côté,
  pas de l'autre).

## 2. Les quatre pathologies, par ordre de gravité

### 2.1 La duplication défensive — le signal le plus net

| Helper | Copies | Où |
|---|---|---|
| `isNonEmptyString` | **19** | tout `sidecar/src` |
| `isPlainObject` | **17** | tout `sidecar/src` |
| `errMessage` | 4 | orchestrator, taches, tachesTimers, jsonlStore |
| `toMessage` | 4 | useSpeech, useProjects, useProviders, OrchestrationPage |
| `asRecord` | 3 | mcpClient, agentTurns, speechAdmin |

Dix-neuf définitions de la même fonction de trois lignes. Chacune est correcte ;
le problème n'est pas là. Le problème est qu'elles **divergent sans qu'on le
voie** : `asRecord` acceptait les tableaux dans une copie et pas dans les
autres — défaut trouvé en écrivant son premier test, ce soir.

C'est le symptôme le plus lisible de l'usine à gaz : personne n'a jamais décidé
de dupliquer, chaque copie était l'option la plus rapide **localement**.

### 2.2 L'état sans propriétaire

`OrchestrationPage` : 88 `useState`. `ProvidersPage` : 67. `AgentPage` : 49,
plus 29 `useRef`.

Aucun de ces états n'est nommé comme appartenant à un domaine. Ils cohabitent
dans une fermeture de plusieurs milliers de lignes où **n'importe lequel peut
en toucher un autre**. C'est la définition opérationnelle du fichier-dieu : non
pas « long », mais « sans frontière interne ».

### 2.3 Le contrat inter-couches tenu par des commentaires

Le protocole fait **69 méthodes** dispatchées, **21 commandes Tauri**, **39
fonctions** de client côté UI. Il est décrit dans `docs/protocol.md` et
implémenté deux fois — émetteurs côté sidecar, parseurs tolérants côté UI —
**sans aucun type partagé**.

Conséquences déjà observées :

- `contextTokens` émis par le sidecar, consommé par l'UI, **absent de la doc** ;
- `parseChatDone` exigeait deux champs que le sidecar émet nullables : le coût
  réel d'un tour n'était jamais affiché ;
- `appPaths.ts` devait être « le miroir exact » de `app_data_dir` de Tauri — la
  branche Windows ne l'était pas, et l'historique de Chat répondait vide.

Les parseurs sont **tolérants par conception** (un champ absent devient `null`).
C'est une bonne propriété pour la robustesse, et une catastrophe pour la
détection : une rupture de contrat ne produit jamais d'erreur, seulement une
fonctionnalité qui disparaît en silence.

### 2.4 Le déséquilibre des tests

| Couche | Lignes de code | Lignes de test |
|---|---|---|
| `sidecar/src` | 14 714 | 7 660 |
| `ui/src` | 31 080 | 563 |
| `src-tauri/src` | 2 806 | 50 tests |

**Le double du code, le quinzième des tests.** Et les sept fichiers de plus de
1 000 lignes de l'interface n'en ont aucun :

```
AgentPage.tsx (5 558)  ProvidersPage.tsx (3 400)  OrchestrationPage.tsx (3 161)
ChatPage.tsx (2 721)   sidecar.ts (1 383)         App.tsx (1 261)
SystemPage.tsx (1 157)
```

Ce n'est pas une négligence : **on ne peut pas tester ces fichiers tels
qu'ils sont**. Le manque de tests est une CONSÉQUENCE du découpage, pas une
cause. C'est pourquoi extraire vient avant tester.

## 3. Ce qui ne va pas mal

Il faut le dire, sinon l'étude oriente vers une réécriture injustifiée.

- **La coquille Rust est exemplaire** : 10 fichiers, une responsabilité chacun,
  280 lignes de moyenne, 50 tests unitaires.
- **Les couches sont justes.** UI / protocole JSON-Lines / sidecar est une bonne
  architecture : elle isole les moteurs IA, permet le headless, survit au crash
  d'un côté. Rien à revoir là.
- **Les modules récents sont bien taillés** : `appPaths.ts` (200 lignes),
  `sendKeyword.ts` (185), `transcriptFilter.ts` (111), `agentTurns.ts` (298).
  Quand une frontière est nommée, elle tient.
- **Les écritures JSONL sont toutes sérialisées**, les registres de runs ont
  leurs délétions, les spawns ont des timeouts. Le soin est réel.

**Le diagnostic n'est donc pas « le code est mauvais » mais « le code n'a pas de
frontières internes ».** Ce qui a été conçu comme un module l'est bien ; ce qui
a poussé dans une page y est resté.

## 4. La cible

Trois règles, pas une architecture nouvelle.

### R1 — Un fichier, une raison de changer

Plafond indicatif : **800 lignes** pour un module, **400** pour un composant.
Ce n'est pas une métrique à respecter mais un déclencheur de question : au-delà,
on cherche la couture. Elle existe presque toujours — dans `AgentPage`, le
modèle de tours était déjà 271 lignes contiguës de fonctions pures.

### R2 — Le socle avant la feuille

Un helper utilisé par plus de deux modules descend dans un socle :
`sidecar/src/base.ts` et `ui/src/base.ts`. Cela supprime d'un coup les 36
copies d'`isNonEmptyString`/`isPlainObject`.

### R3 — Le contrat au-dessus des implémentations

Les types du protocole vivent dans **un seul endroit**, importé par les deux
côtés. À défaut d'un paquet partagé (lourd pour ce projet), des **fixtures
dorées** : les mêmes lignes JSON consommées par les tests du sidecar ET de l'UI.
Un champ renommé casse alors un test, au lieu de disparaître de l'écran.

## 5. Le chemin — par valeur décroissante, sans réécriture

Chaque étape est **mécanique** (déplacement, pas refonte), livrable seule, et
vérifiable par la CI existante.

| # | Action | Gain | Risque | État |
|---|---|---|---|---|
| 0 | `agentTurns.ts` extrait d'`AgentPage` | Répétition générale | Nul | **fait** |
| 1 | Socle `base.ts` par couche, 43 copies supprimées | Élimine une classe entière de divergence | Nul (déplacement pur) | **fait** |
| 2 | Cliquet de taille en CI | Empêche que les gains soient reperdus | Nul | **fait** |
| 3 | Découper `protocol.test.js` (6 000 lignes, un seul `main`) par domaine | Un échec ne masque plus les suivants ; la couverture devient consultable | Nul | **fait** |
| 4a | Dépôt de runtimes partagé (`useConversationRuntime`) | Le cœur du moteur : une seule Map, un seul tick, 30 accès directs supprimés | Moyen — c'est du comportement | **fait** |
| 4b | Bandeau de débord et cycle d'onglets partagés | Deux logiques 100 % dupliquées, dont une qui parle de facturation | Faible | **fait** |
| 4c | Gardes R3 du routage partagées ; le reste de la divergence est VOULU (spec R7) | Les gardes parlent d'argent : une seule copie | Faible | **fait** — voir ci-dessous |
| 5 | `ProvidersPage` : sortir validation et catalogue de modèles | Logique pure, donc directement testable | Faible | **fait** (première tranche : catalogue + contrat fournisseur, 23 tests) |
| 6 | Couvrir `claude.ts`, `orchestrator.ts`, `neutralAgent.ts` | Les trois plus gros modules du sidecar | Faible | **fait** (8 blocs unitaires ; orchestrator déjà couvert par la découpe de l'étape 3) |
| 7 | `OrchestrationPage` → fichiers-sections | 3 159 → **640**, six modules tous sous 800 | Le plus élevé (88 `useState`) | **fait** — et sortie des dérogations |
| 8 | `AgentPage` : extraire modale de permissions, persistance, connaissances | 5 558 → ~2 500 | Faible (blocs contigus) | **fait** — blocs, envoi/moteurs (4b-bis) et JSX scindés : 5 558 → **2 936** |
| 4b-bis | Envoi/moteurs hors d'`AgentPage` (`envoiProjet.ts`) ; les DEUX stratégies R7 en feuille testée (`routageAuto.ts`) | Le chemin chaud devient un module nommé ; le routage facturé gagne ses 15 premiers tests | Le plus élevé restant (handleSend, 346 lignes) | **fait** — AgentPage 4 293 → **3 569**, reste le JSX (~960), voir ci-dessous |
| 9 | `claude.ts` : sortir usage, commands, sessionTitles de la fermeture | Rend le fichier découpable | Moyen | **fait** — 1 826 → 1 512, trois modules aux attaches explicites |
| 10 | Échantillons témoins du protocole | Rupture de contrat détectée au lieu d'être silencieuse | Faible | **fait** (corpus vérifié des DEUX côtés, régénérable) |
| 11 | Registre de permissions unique (5 implémentations aujourd'hui) | Un correctif de sécurité s'applique une fois | Moyen | **fait** — permissions.ts par couche ; le « ne plus demander » devient PAR PROJET |
| 12 | Installeur Windows : « ne pas désinstaller » par défaut | Mise à jour en une passe | Faible, mais 977 lignes de gabarit à maintenir | **fait** — gabarit possédé (src-tauri/nsis/), UNE modification documentée ; à valider à la prochaine release Windows |

L'ordre a changé le 2026-08-08 : le cliquet et la découpe des tests sont passés
devant le moteur de conversation partagé. Non parce qu'ils valent plus, mais
parce qu'ils **rendent le reste mesurable et sans risque de rechute** — et
qu'ils ne coûtent rien. On ne commence pas par l'étape délicate quand deux
étapes gratuites la sécurisent.

### Ce que l'étape 4b-bis a effectivement produit

L'envoi et les moteurs — tout ce qui se passe entre « Envoyer » et la fin du
tour — sortent d'`AgentPage` (4 293 → 3 569) vers deux modules aux rôles
opposés :

- **`routageAuto.ts`** (feuille, 15 tests) : les DEUX stratégies R7 côte à
  côte, montante (Chat) et descendante (Projets), dépendances injectées. Ce
  code décide où part une requête FACTURÉE et n'avait aucun test ; les cas
  fixent le tier `complexe` imposé au premier tour descendant, la
  re-vérification du débord à chaque tour, et `pendingAffinity: false` sur
  tout tour débordé. `ChatPage` y gagne au passage : sa stratégie montante
  appelle la même feuille (2 667 → 2 636).
- **`envoiProjet.ts`** (câblage, 700 lignes) : `creerEnvoiProjet(deps)` —
  la fabrique est rappelée à chaque rendu, comme l'étaient les fonctions
  qu'elle remplace, et son interface `DepsEnvoiProjet` (~35 entrées) rend
  VISIBLE la surface de couplage réelle du chemin chaud. Ce module importe
  les clients sidecar en valeur, donc ne se teste pas unitairement : la
  logique testable vit dans les feuilles qu'il appelle (routageAuto,
  gardesRoutage, connaissances, agentTurns, debordNotice).

Deux fonctions pures ont rejoint `agentTurns.ts` avec leurs tests
(`buildNeutralMessages` : blocs texte seuls, tours en erreur sautés ;
`withAgentSystemPrompt` : jamais deux messages `system`), et
`ConvRuntime`/`freshRuntime`/`AUTO_MODEL` ont rejoint `modeleProjet.ts`.
Méthode inchangée : découpe par script à assertions, cinq substitutions
comptées une à une, bilan des 13 déclarations refait à l'arrivée. Reste dans
`AgentPage` : l'état, les handlers de page et le JSX (~960 lignes) — la
dernière tranche avant les ~2 500 visés.

### Ce que les étapes finales (nuit du 2026-08-09) ont effectivement produit

**Étape 8, dernière tranche** : le JSX d'AgentPage se scinde en
`agentTranscript.tsx` (les quatre composants mémoïsés des tours) et
`agentSidebarDroit.tsx` (Sessions, LLM, Connaissances — l'état reste à la
page, les props disent la surface de couplage). AgentPage finit à **2 936
lignes** — l'objectif ~2 500 n'est pas atteint au chiffre près : ce qui
reste est le composeur, les onglets et le câblage d'état, et les découper
davantage serait le « découpage esthétique » que ce document interdit.

**Étape 9** : la fermeture `createClaudeEngine` ne garde que ce qu'elle
possède. `claudeSessionTitles.ts` (aucun couplage), `claudeCommands.ts`
(queryFn/apiKey injectés), `claudeUsage.ts` (l'instantané partagé passe par
un dépôt lire/ecrire — c'était le risque n°1 : deux instances, deux relevés
divergents). L'instance moteur reste unique. claude.ts : 1 826 → 1 512.

**Étape 11** : le relevé a compté cinq implémentations de la logique de
permission et SEPT copies du repli « plan n'existe pas côté neutre ».
`permissions.ts` existe maintenant dans chaque couche (les deux ne partagent
pas de code — une adresse par couche, même contrat) : la règle mode × outil
du moteur neutre, le repli unique, la coercition d'entrée, la liste des
modes des sélecteurs. Les divergences VOULUES sont documentées dans
l'en-tête plutôt qu'unifiées de force : la règle Claude appartient au SDK,
le chat pur refuse tout par convention, l'orchestration n'a pas de mémoire
d'autorisation. Le correctif de sécurité du relevé est appliqué : le « ne
plus demander » était mémorisé par nom d'outil nu, tous projets confondus —
la clé est désormais projet+outil, et la demande voyage avec le projet
propriétaire du tour.

**Étape 12** : le gabarit NSIS de Tauri v2.11.4 est désormais possédé
(`src-tauri/nsis/installer.nsi`, branché par `bundle.windows.nsis.template`)
avec UNE modification, encadrée de commentaires : lors d'une mise à jour, le
défaut du dialogue devient « Ne pas désinstaller » (le gabarit d'origine
transformait chaque mise à jour en désinstallation+réinstallation — constat
utilisateur du 2026-08-08). Même version et retour arrière gardent le défaut
d'origine. Coût assumé : à chaque montée de version du CLI Tauri, comparer
le gabarit amont et reporter la modification. Validation : la prochaine
release Windows (la CI construit l'installeur, pas le poste Linux).

### Ce que l'étape 7 a effectivement produit

Le diagnostic des 88 `useState` s'est retourné en bonne nouvelle : ils étaient
déjà RÉPARTIS dans des sections indépendantes (RunsSection 23, AgentEditor 17,
TacheEditor 14…). Le fichier-dieu était un problème de taille, pas
d'enchevêtrement — le découpage était donc du déplacement pur.

Six fichiers : `orchCommun` (socle, fonctions pures testées), `orchAgents`,
`orchOrchestrations`, `orchTaches` + `orchTacheEditeur`, `orchRuns`. La page
passe de 3 159 à 640 lignes et SORT des dérogations du cliquet — premier
fichier dieu réhabilité.

Trois choses à retenir de l'exécution :

- **Le bilan comptable a servi** : 92 déclarations avant, 92 après, zéro
  perdue — vérifié par script, pas à l'œil. Une interface (`RunStepMeta`)
  avait bien été égarée en route ; c'est le compilateur qui l'a signalée, et
  le bilan qui a confirmé qu'elle était la seule.
- **Le cliquet a mordu son auteur** : `orchTaches` est né à 836 lignes, refusé.
  La réponse attendue était de découper, pas de déroger pour 36 lignes — d'où
  `orchTacheEditeur`. La barrière fonctionne aussi contre celui qui l'a posée,
  c'est même à ça qu'on la reconnaît.
- **13 tests** sur le socle commun, dont `computeDagOrder` (l'ordre que
  l'utilisateur lit avant de lancer un run : un cycle ne gèle jamais la page,
  la profondeur est le max des chemins) et `yamlScalar` (« true » nu
  deviendrait un booléen dans le manifeste relu par le sidecar).

### Étape 8, seconde tranche : la modale de permissions

Le bloc s'est scindé selon la règle des feuilles : `questionsAgent.ts` (160
lignes, la logique pure — parseur défensif des questions, composition des
réponses, titres) et `PermissionModal.tsx` (370 lignes, uniquement du rendu).

Seize tests fixent l'enjeu réel : ce que l'utilisateur coche repart vers
l'agent comme résultat d'outil. Une réponse mal composée n'est pas un bug
d'affichage — c'est l'agent qui comprend autre chose que ce que l'utilisateur
a dit. Sont épinglés : la réponse libre REMPLACE le choix en question simple
mais S'AJOUTE en choix multiple ; la clé présente vide signifie « champ libre
ouvert », pas « rien » ; `isPicked` teste l'appartenance, pas la sous-chaîne ;
le message multi-questions rattache chaque réponse à son en-tête.

### Étape 8, première tranche : le modèle de projet (persistance)

`ui/src/modeleProjet.ts` (534 lignes) : types, constructeurs, formes
persistées sur deux générations, migrations, réparation de routage,
déduplication d'identifiants. C'est le morceau d'`AgentPage` qui travaille sur
LES DONNÉES de l'utilisateur — un défaut là ne s'affiche pas mal, il perd
quelque chose.

Dix-sept tests fixent notamment : le tour en streaming n'est jamais persisté ;
la troncature garde les tours les plus RÉCENTS ; un `routedTier` hors
vocabulaire est réparé sans écarter la session ; les ids en collision entre
projets sont réparés au chargement (la leçon du 2026-08-04 — des UUID, jamais
un compteur) ; l'aller-retour persistance ⇄ session est sans perte.

Au passage, `isRouteTier`/`toRouteTarget` — des fonctions pures coincées dans
`sidecar.ts` — ont rejoint `protocole.ts`, la feuille du protocole.
`AgentPage` : 5 510 → 5 027 lignes.

### Ce que l'étape 10 a effectivement produit

`fixtures/protocole/` contient des événements ENREGISTRÉS, émis par le vrai
sidecar sous faux SDK et faux fournisseur — déterministes au champ près, y
compris le coût. Deux suites les confrontent :

- `sidecar/test/temoins.test.js` rejoue les échanges contre un sidecar réel et
  exige l'**égalité stricte** (clés triées) avec le témoin : un champ renommé,
  disparu ou ajouté casse côté émetteur. La tolérance est le rôle des parseurs
  UI, pas du témoin.
- `ui/src/protocole.test.ts` donne les mêmes fichiers aux parseurs et exige
  l'extraction attendue — plus des cas défensifs écrits à la main, dont LA
  régression historique : un usage avec coût seul, sans compteurs de tokens,
  doit survivre au parsing.

Le JSON est le point de rencontre : modifier le contrat exige de régénérer
(`node sidecar/test/temoins.test.js --capturer`), et **la revue du diff du
témoin est la revue du contrat**. La barrière est prouvée mordante : un témoin
faussé fait échouer la suite (vérifié, puis restauré).

Effet de bord structurel : les trois parseurs (`parseChatDone`,
`parseClaudeDone`, `parseNeutralDone`) sont descendus dans une feuille
(`ui/src/protocole.ts`) — `sidecar.ts` s'abonne à Tauri au chargement et reste
donc intestable. `sidecar.ts` ré-exporte tout : aucun appelant modifié, et le
client passe de 1 383 à 1 275 lignes.

### Ce que l'étape 6 a effectivement produit

Le constat initial (« les trois plus gros modules, non couverts ») demandait
une mise à jour : depuis la découpe de l'étape 3, `orchestrator.ts` est bien
exercé — CRUD, ordonnanceur DAG, routage auto, via ses propres fichiers de
test. Le vrai trou était UNITAIRE : la logique pure enfouie dans les
fermetures de `claude.ts` et `neutralAgent.ts`, que les tests de protocole
traversent sans jamais la fixer.

Huit fonctions exportées (le mot-clé, rien déplacé), deux fichiers de test :

- **`claudePur.test.js`** — la famille du bug le plus visible du produit :
  `extractContextTokens` (un usage à zéros n'est pas une mesure ; la sortie ne
  compte jamais dans la fenêtre d'entrée, sous peine de jauge à 140 %),
  `extractUsage` (traduction snake_case, cache opt-in), `decorateAuthError`
  (limite d'abonnement ≠ défaut d'authentification — conseiller « claude
  login » à un quota épuisé fait déboguer le mauvais problème),
  `summarizeToolResult`, `isFallbackTitle`.
- **`neutralAgentPur.test.js`** — les trois GARDES du moteur neutre :
  `resolveSafePath` (dont le piège du frère préfixé : `/projet/demo-evil`
  commence par `/projet/demo` et passerait sans le séparateur dans la
  comparaison), `resolveAllowedTools` (fermé par défaut : un nom inconnu ne
  donne jamais la palette complète), `needsPermission` (acceptEdits libère
  l'écriture mais JAMAIS le shell).

Un défaut dans ces trois gardes n'est pas un bug d'affichage — c'est un agent
qui lit hors du projet. C'est le genre de contrat qui doit casser un test, pas
attendre une revue.

### Ce que l'étape 5 (première tranche) a effectivement produit

Deux extractions, choisies parce qu'elles portent des contrats et non de la
plomberie :

- **Le catalogue de modèles** rejoint `modelCatalog.ts`, qui existait déjà —
  pas de fichier nouveau pour rien. Le contrat épinglé : trié « prix
  croissant », un modèle **sans prix va en fin de liste** — un modèle sans prix
  n'est pas un modèle gratuit, et le catalogue ne doit pas recommander en tête
  ce dont on ne sait rien. Au passage, `splitFeatured` et `matchBenchNote`, qui
  vivaient là sans test, en ont reçu.
- **Le contrat R0 du formulaire fournisseur** (`providerFormCalc.ts`) : champ vide
  → propriété **absente**, jamais `false` ni `[]`. `fallbackModels: []` et
  « pas de fallbackModels » ne sont pas la même chose une fois chez OpenRouter,
  et cet écart ne fait de bruit dans aucune couche.

Une leçon confirmée : le foyer « naturel » du contrat aurait été
`providerAdmin.ts`, mais il importe `sidecar.ts` en valeur — qui s'abonne aux
événements Tauri au chargement. Même piège que `debordNotice` la veille, évité
cette fois AVANT d'écrire le test. La règle qui s'en dégage : **la logique pure
vit dans des feuilles** (imports de types seulement), le câblage vit dans les
modules d'application. C'est la même règle que `base.ts`, vue depuis l'autre
bout.

Reste dans `ProvidersPage` (3 348 lignes) : les sections Routage, Voix et
Raccourcis, qui sont surtout du formulaire — extraction moins rentable, à
reprendre quand le besoin s'en fera sentir.

### Étape 4c — pourquoi elle n'est pas un simple déplacement

La mesure de similarité, fonction par fonction, sépare nettement deux familles :

| Fonction | AgentPage | ChatPage | Similarité |
|---|---:|---:|---:|
| `applyDebordNotice` | 30 | 30 | **100 %** |
| `removeQueuedPrompt`, `getLiveDraft`, `focusComposer`, `isUsableTarget` | 3–7 | 3–7 | **100 %** |
| `commitEditSessionTitle`, `cancelEditSessionTitle` | 12 / 4 | 12 / 4 | **100 %** |
| `cycleConversation` | 7 | 7 | 99 % |
| `closeConversationTab` | 60 | 59 | 80 % |
| `handleAbort` | 25 | 27 | 80 % |
| `resolveAutoRoute` | 108 | 60 | **58 %** |
| `buildLiveSessions` | 28 | 23 | **35 %** |

Les 100 % sont du déplacement : c'est l'étape 4b, faite. Les autres **ont
divergé**, et c'est là que le raisonnement change.

- `resolveAutoRoute` : 108 lignes contre 60, et des sémantiques différentes —
  « affinité de session » d'un côté, « plancher » de l'autre. Les unifier, ce
  n'est pas ranger du code, c'est **décider laquelle des deux règles est la
  bonne**. Cela ne se tranche pas en refactorisant.
- `handleAbort` : l'écart n'est que du commentaire et une représentation
  (`activeEngine: "neutral"` contre `activeIsClaude: boolean`). Divergence
  accidentelle, unifiable — mais elle touche le chemin chaud et mérite d'être
  vérifiée à l'écran juste après.
- `buildLiveSessions` à 35 % : les deux pages ne construisent pas la même
  chose. Probablement légitime.

**Résolution (2026-08-08)** : la divergence de `resolveAutoRoute` n'était pas
un accident à arbitrer — c'est le TITRE de la spec R7 : « Deux stratégies de
routage : montante (Chat) et descendante (Projets) ». Les 58 % de similarité
mesuraient deux conceptions voulues. La leçon de méthode : mesurer la
similarité signale les candidats, mais seule la spec dit si un écart est une
dette ou une décision.

Ce qui devait être partagé l'est : les **gardes R3** (`gardesRoutage.ts`),
identiques mot pour mot dans les deux pages — jamais d'envoi vers un
fournisseur non déclaré, repli en REMONTANT la table, jamais en descendant.
Elles décident où part une requête facturée : sept tests les fixent, dont le
cas « aucun repli possible » et la garantie que le cas nominal ne lit pas la
table (pas d'aller-retour disque par tour pour rien).

`handleAbort` (80 %) reste volontairement en l'état : son écart n'est que de
la représentation (`activeEngine` vs `activeIsClaude`), à résorber le jour où
les deux `ConvRuntime` fusionneront — pas avant.

### Ce que l'étape 4a a effectivement produit

Le relevé qui a précédé l'extraction est sans appel : **106 identifiants
portent le même nom** dans `AgentPage` et `ChatPage`. Les quatre fonctions du
runtime y étaient structurellement identiques, ne différant que par la charge
utile — `turns: AgentTurn[]` d'un côté, `entries: ChatEntry[]` de l'autre.

`ui/src/useConversationRuntime.ts` les remplace par un dépôt générique, et les
deux pages y passent : 30 accès directs à la `Map` ont disparu.

Deux décisions valent d'être notées :

- **Le dépôt est séparé du hook.** L'interface n'a pas de bibliothèque de rendu
  pour ses tests ; en ajouter une pour vérifier une `Map` aurait coûté cher
  pour un besoin qui n'existe pas. La logique sort de React, se teste avec un
  compteur d'appels (18 cas), et le hook ne fait plus qu'une chose : relier la
  notification à un `setState`.
- **La distinction `ecrire` / `poser` est devenue explicite.** Elle existait
  déjà, mais implicitement, dans le choix entre appeler `updateRuntime()` ou
  écrire soi-même dans la `Map` — un piège invisible à la relecture. `ecrire`
  déclenche un rendu, `poser` non ; deux noms plutôt qu'un drapeau, et un test
  pour chacun.

Reste l'étape 4b, la plus délicate : envoi, interruption, file d'attente et
gestion des onglets sont toujours écrits deux fois.

### Ce que l'étape 3 a effectivement produit

`protocol.test.js` passe de 6 000 à 2 660 lignes. Douze fichiers par domaine en
sortent, tous sous 800 lignes, tous lançables seuls. Le harnais commun
(`sidecar/test/harness.mjs`) explique au passage pourquoi le fichier était si
gros : **il n'y avait pas de socle**, donc tout nouveau test devait naître à
côté des précédents pour profiter du leur. La taille était la conséquence, pas
la cause.

Deux effets de bord acquis : le lanceur découvre les fichiers au lieu de les
énumérer — un test neuf ne peut plus être oublié sans que rien ne le signale —
et toute la suite peut viser une compilation à part (`IACTION_TEST_ENTRY`),
ce qui permet enfin de vérifier son travail sans tuer le sidecar de la session
en cours.

### Ce qu'il ne faut PAS faire

- **Pas de réécriture.** Le comportement de ces pages encode des années
  d'usage réel (les commentaires du code en témoignent : recollages Whisper,
  pièges Snap, courses de streaming). Le réécrire, c'est le reperdre.
- **Pas de framework d'état** (Redux, Zustand…). Le problème n'est pas le
  mécanisme d'état, c'est l'absence de frontières. Un framework ajouterait une
  couche sans en retirer une.
- **Pas de découpage esthétique.** Un fichier de 900 lignes cohérent vaut mieux
  que trois de 300 qui se rappellent en boucle.

## 6. Comment savoir qu'on progresse

Quatre indicateurs mesurables, à relever à chaque étape :

1. **Copies d'un même helper** : 43 au relevé → **0** (étape 1, faite).
2. **Fichiers en dérogation de taille** : 21 au 2026-08-08, et le cliquet
   garantit que ce nombre ne peut que baisser. `npm run cliquet` le relève.
3. **Lignes de test de l'interface** : 623 aujourd'hui → suit mécaniquement
   l'extraction, puisque c'est elle qui rend testable.
4. **Contrats non couverts** : les 66 méthodes du protocole, combien traversées
   par un test de bout en bout ?

Ces chiffres se relèvent en une commande ; ils valent mieux qu'une impression.
Le deuxième n'est plus seulement un indicateur : c'est une barrière, et elle
est elle-même testée (`npm run cliquet:test`).

## 7. Conclusion

L'application ne va pas « vers l'usine à gaz » par excès d'ambition — elle y va
par **absence de frontières internes**, et uniquement dans l'interface. Les
couches sont justes, la coquille est propre, le sidecar est testé.

Le remède ne demande aucune décision d'architecture : déplacer ce qui est déjà
séparable, dans l'ordre du tableau ci-dessus, en vérifiant à chaque pas. La
première étape supprime 36 duplications sans aucun risque ; la dernière n'est
pas urgente et pourrait ne jamais être faite.
