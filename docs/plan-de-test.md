# Plan de test

> Rédigé le 2026-08-07. Il manquait : le projet avait des tests, pas de
> stratégie — donc personne ne savait ce qui était couvert, ni qui teste quoi.

## 1. Le principe : qui peut prouver quoi

Chaque niveau existe parce qu'il prouve quelque chose que les autres **ne
peuvent pas** prouver. Un test placé au mauvais niveau coûte cher et rassure à
tort.

| Niveau | Prouve | Ne peut PAS prouver | Coût |
|---|---|---|---|
| **Unitaire** (vitest, cargo) | qu'une règle métier est juste, dans tous ses cas limites | que les morceaux se parlent | ms |
| **Protocole** (`sidecar/test/*.test.js`) | que le contrat JSON-Lines tient de bout en bout | que l'écran affiche la bonne chose | s |
| **Construction** (CI, sur PR) | que ça compile et s'empaquette sur les deux plateformes, depuis une machine VIERGE | que ça démarre | min |
| **Analyse statique** (CodeQL) | que des formes dangereuses connues sont absentes | qu'il n'y en a pas d'autres | min |
| **Humain** (toi) | que l'application EST utilisable | rien d'automatisable | ta soirée |

La ligne « machine vierge » n'est pas décorative : depuis le 2026-08-09, la
publication passe par une pull request, et la chaîne rejoue là où rien ne
traîne. Le poste, lui, ment par omission — un fichier jamais `git add` (T-011),
un test que Windows seul contredit (T-014). Les deux ont été trouvés par ce
niveau-là, pas par les précédents.

**Règle qui découle du reste** : ne jamais demander à un humain ce qu'une
machine peut vérifier. Ton temps est la ressource rare, il va aux quatre choses
qu'aucune machine ici ne sait faire (§4).

## 2. Où on en est (mesuré le 2026-08-09)

| Couche | Code | Tests | Verdict |
|---|---|---|---|
| `sidecar/src` | 14 829 lignes | 21 fichiers, ~660 assertions | solide |
| `src-tauri/src` | 2 806 lignes | 50 tests unitaires | correct |
| `ui/src` | 34 776 lignes | 19 fichiers, 233 tests | en cours de comblement |

L'interface est passée de 64 à **233 tests** (2 231 lignes de test), soit un
rapport de 1 pour 16 contre 1 pour 50 le 2026-08-07 — le sidecar reste à 1 pour
1,7. Ce n'est pas de la bonne volonté : c'est l'étude de structure, soldée
17/17, qui l'a rendu possible. Un module pur se teste, un fichier dieu de 5 000
lignes ne se teste pas. AgentPage est passé de 5 558 à 2 936 lignes, et chaque
extraction s'est terminée par un fichier de test — jamais l'inverse.

Reste vrai malgré tout : les fichiers en dérogation de cliquet n'ont pas de
tests propres, et n'en auront pas tels qu'ils sont (voir
`docs/etude-structure.md`).

## 3. Ce que la machine fait, sans toi

À chaque poussée sur `main`, sur **Ubuntu ET Windows** :

```
lint (rules-of-hooks) → cliquet de taille → audit de publication
  → tests UI → tests sidecar → bundle → tests Rust → build
```

Les vérifications rapides d'abord : un hook conditionnel casse la chaîne en
30 secondes plutôt qu'après 15 minutes de compilation.

En local, avant de pousser : **`npm run verif`** — la même séquence.

Pour ne relancer qu'une partie de la suite du sidecar :
`node sidecar/test/tous.mjs orchestr`. Et pour la lancer pendant que
l'application tourne, sans écraser `dist/` — donc sans tuer le sidecar de la
session en cours :

```
npx tsc -p sidecar/tsconfig.json --outDir sidecar/dist-verif
IACTION_TEST_ENTRY=$PWD/sidecar/dist-verif/index.js node sidecar/test/tous.mjs
```

### Deux barrières qui ne testent pas le produit

Elles gardent le dépôt, pas le logiciel — mais elles échouent de la même façon,
par code de sortie, et pour la même raison : ce qu'on ne vérifie pas
mécaniquement finit par dépendre de la vigilance de quelqu'un.

- **Le cliquet de taille** (`npm run cliquet`) refuse tout fichier neuf
  au-dessus de 800 lignes, et toute croissance des 21 déjà au-dessus.
- **L'audit de publication** (`npm run audit`) refuse de laisser partir un
  chemin personnel, une adresse nominative, un hôte inconnu, une IP publique ou
  un jeton. Il existe parce que le dépôt local est devenu le produit public le
  2026-08-07 : la séparation qui protégeait par construction a disparu.

  Ses règles *structurelles* sont publiables et tournent aussi en CI. Ses
  motifs *littéraux* — noms de clients, domaines privés — vivent dans
  `scripts/.audit-motifs`, jamais versionné : l'inscrire dans le dépôt public
  reviendrait à publier exactement ce qu'il sert à retenir. L'audit refuse
  d'ailleurs de publier ce fichier s'il devenait suivi par git, et c'est
  vérifié par un test.

Les deux ont leurs propres tests, lancés avant elles. Une barrière qu'on ne
peut pas faire échouer volontairement n'est pas une barrière : on saurait
seulement qu'elle est silencieuse, pas qu'elle veille.

### Ce que cette chaîne a déjà attrapé

Ce n'est pas de la théorie ; en une journée d'existence, elle a trouvé :

- un retour anticipé au milieu des hooks, qui tuait toute l'interface au
  démarrage (`rules-of-hooks`, invisible au typecheck et au build) ;
- quatre tests qui supposaient POSIX et tombaient sur le runner Windows ;
- une dépendance à l'environnement : `cargo test` échouait sur une machine
  neuve parce que le script de build de Tauri exige un binaire que seul
  l'empaquetage télécharge.

Aucun de ces défauts n'était visible sur le poste de développement.

## 4. Ce que toi seul peux faire

Quatre domaines, par ordre d'importance. **Rien d'autre ne devrait t'être
demandé.**

### 4.1 La recette de version (10 minutes, à chaque release)

À faire une fois par version publiée, sur le poste où tu l'utilises vraiment.
Si un point échoue : dis-le-moi avec ce que tu as vu, j'en fais un test au bon
niveau pour qu'il ne revienne jamais.

| # | Geste | Attendu |
|---|---|---|
| 1 | Installer par-dessus la version précédente | Réglages et conversations retrouvés |
| 2 | Ouvrir l'app | Aucune bannière d'erreur, aucun bandeau « moteur arrêté » |
| 3 | Un tour Claude dans un projet | Réponse streamée, coût affiché en bas de bulle |
| 4 | Changer d'onglet **pendant** le tour, revenir | La réponse est arrivée dans la BONNE conversation |
| 5 | Envoyer un second message pendant un tour | Part en file, puis s'envoie seul à la fin |
| 6 | Un tour avec un fournisseur distant (OpenRouter/Ollama) | Réponse, et clé API reconnue |
| 7 | Ouvrir un fichier du projet, le modifier, `Ctrl+S` | Enregistré ; et depuis une AUTRE page, `Ctrl+S` ne fait rien |
| 8 | Fermer l'app, la rouvrir | Onglets et historique restaurés |

### 4.2 Le matériel, que la CI n'a pas

- **La voix** : dictée, mode conversation, lecture des réponses. Il faut un
  micro, des haut-parleurs et une oreille — aucune machine ici ne peut juger
  qu'une voix est intelligible.
- **Le GPU** : la sonde `nvidia-smi`, les jauges système.
- **Le trousseau** : Secret Service sous Linux, Credential Manager sous Windows.
  Un runner CI n'a ni l'un ni l'autre.

### 4.3 Les vraies intégrations

- **Un tour Claude réel** consomme ton abonnement : la CI ne le fera jamais.
  Les tests utilisent un faux SDK (`sidecar/test/fakeClaude*.mjs`).
- **Les serveurs MCP** (IMAP, DAW…) parlent à des services et à ton matériel.
- **Les tâches planifiées** : le timer systemd ne se déclenche que chez toi.

### 4.4 Le jugement

Est-ce lisible ? Le message d'erreur dit-il quoi faire ? Le raccourci tombe-t-il
sous le doigt ? Aucun test ne répond à ça, et c'est souvent ce qui compte le
plus.

## 5. Comment on ajoute un test — la règle

**Tout défaut trouvé devient un test, au niveau le plus bas qui l'aurait
attrapé.** Pas au niveau où on l'a vu.

Exemples de cette journée :

| Défaut trouvé | Niveau qui l'aurait attrapé | Ce qui a été écrit |
|---|---|---|
| Jauge de contexte à 0 % après `/compact` | unitaire | 5 tests sur `contextTokens` |
| Chemin Windows en `\\?\` illisible par Node | unitaire | 3 tests sur les formes de chemin |
| Dossier de données divergent entre couches | unitaire | tests des DEUX plateformes, depuis Linux |
| Hooks derrière un retour anticipé | lint | `rules-of-hooks` en CI |
| Binaire manquant à la construction | CI | ordre des étapes corrigé |

Le tableau se lit dans l'autre sens aussi : si un défaut n'est attrapable qu'au
niveau humain, c'est souvent que le code n'est pas découpé — pas que le test
manque.

## 6. Ce qui n'est PAS testé, et pourquoi

Dit franchement, pour que personne ne se croie couvert :

- **Le rendu de l'interface** : aucun test de composant React. Il en faudra
  quand les pages seront découpées ; avant, ce serait tester des fichiers-dieux.
- **Les tours LLM réels** : par choix (coût, non-déterminisme). Le contrat avec
  le SDK est testé contre un faux.
- **macOS** : ni testé ni construit.
- **La migration entre versions** : couverte unitairement (dossiers, trousseau),
  jamais de bout en bout sur une vraie installation ancienne. C'est le point 1
  de ta recette.
- **La charge** : rien ne vérifie le comportement à 200 conversations ou 20 Mo
  de journal. Les bornes existent dans le code, leur effet n'est pas mesuré.

## 7. Objectifs, dans l'ordre

1. **Maintenir le vert.** Une CI rouge tolérée quelques jours ne sert plus à
   rien.
2. **Couvrir l'UI à mesure du découpage** : chaque module extrait arrive avec
   ses tests, comme `agentTurns.ts` (17 tests le jour de son extraction).
3. **Fixtures dorées du protocole** : les mêmes lignes JSON consommées par les
   tests du sidecar ET de l'UI, pour qu'un champ renommé casse un test au lieu
   de disparaître de l'écran.
4. **Tests de composants**, seulement une fois les pages découpées.

Rien de tout cela n'est urgent. L'ordre compte plus que le calendrier.
