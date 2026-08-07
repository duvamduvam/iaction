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

| # | Action | Gain | Risque |
|---|---|---|---|
| 1 | Socle `base.ts` par couche, 36 copies supprimées | Élimine une classe entière de divergence | Nul (déplacement pur) |
| 2 | `useConversationRuntime` partagé entre Chat et Projets | Supprime la duplication qui a produit un bug en double | Moyen — c'est du comportement |
| 3 | Découper `protocol.test.js` (6 000 lignes, un seul `main`) par domaine | Un échec ne masque plus les suivants | Nul |
| 4 | `OrchestrationPage` → trois fichiers-sections (Agents, Orchestrations, Tâches) | 3 161 → ~1 000 chacun, sections déjà indépendantes | Faible |
| 5 | `AgentPage` : extraire modale de permissions, persistance, connaissances | 5 558 → ~2 500 | Faible (blocs contigus) |
| 6 | `claude.ts` : sortir usage, commands, sessionTitles de la fermeture | Rend le fichier découpable | Moyen |
| 7 | Fixtures dorées du protocole | Rupture de contrat détectée au lieu d'être silencieuse | Faible |
| 8 | Registre de permissions unique (5 implémentations aujourd'hui) | Un correctif de sécurité s'applique une fois | Moyen |

**Étape 0, déjà faite** : `agentTurns.ts` extrait d'`AgentPage` (271 lignes,
17 tests). Elle a servi de répétition et a confirmé que l'extraction mécanique
ne coûte rien — et révèle des défauts au passage (`asRecord`).

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

1. **Copies d'un même helper** : 36 aujourd'hui → 0 visé (étape 1).
2. **Fichiers > 1 500 lignes** : 7 aujourd'hui → 2 acceptés (étapes 4-6).
3. **Lignes de test de l'interface** : 563 aujourd'hui → suit mécaniquement
   l'extraction, puisque c'est elle qui rend testable.
4. **Contrats non couverts** : les 69 méthodes du protocole, combien traversées
   par un test de bout en bout ?

Ces chiffres se relèvent en une commande ; ils valent mieux qu'une impression.

## 7. Conclusion

L'application ne va pas « vers l'usine à gaz » par excès d'ambition — elle y va
par **absence de frontières internes**, et uniquement dans l'interface. Les
couches sont justes, la coquille est propre, le sidecar est testé.

Le remède ne demande aucune décision d'architecture : déplacer ce qui est déjà
séparable, dans l'ordre du tableau ci-dessus, en vérifiant à chaque pas. La
première étape supprime 36 duplications sans aucun risque ; la dernière n'est
pas urgente et pourrait ne jamais être faite.
