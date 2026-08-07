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
| **Construction** (CI) | que ça compile et s'empaquette sur les deux plateformes | que ça démarre | min |
| **Humain** (toi) | que l'application EST utilisable | rien d'automatisable | ta soirée |

**Règle qui découle du reste** : ne jamais demander à un humain ce qu'une
machine peut vérifier. Ton temps est la ressource rare, il va aux quatre choses
qu'aucune machine ici ne sait faire (§4).

## 2. Où on en est (mesuré le 2026-08-07)

| Couche | Code | Tests | Verdict |
|---|---|---|---|
| `sidecar/src` | 14 714 lignes | 7 660 lignes, 661 assertions | solide |
| `src-tauri/src` | 2 806 lignes | 50 tests unitaires | correct |
| `ui/src` | 31 080 lignes | 64 tests unitaires | **le trou** |

Les 64 tests de l'interface couvrent 5 modules purs sur 59 fichiers. Les sept
fichiers de plus de 1 000 lignes n'en ont aucun — **et ne peuvent pas en avoir
tels qu'ils sont** (voir `docs/etude-structure.md`). C'est pourquoi le plan
ci-dessous lie la couverture de l'UI à l'avancement du découpage : promettre des
tests d'interface avant d'extraire serait promettre du vide.

## 3. Ce que la machine fait, sans toi

À chaque poussée sur `main`, sur **Ubuntu ET Windows** :

```
lint (rules-of-hooks) → tests UI → tests sidecar → bundle → tests Rust → build
```

Les vérifications rapides d'abord : un hook conditionnel casse la chaîne en
30 secondes plutôt qu'après 15 minutes de compilation.

En local, avant de pousser : **`npm run verif`** — la même séquence.

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
