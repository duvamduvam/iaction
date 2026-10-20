# Étude — Travailler sur deux projets en même temps

*Ouverte le 2026-08-15 sur demande explicite de l'utilisateur, après le constat
T-060. Mesurée sur le code avant d'être écrite ; chaque blocant porte son
`fichier:ligne`.*

## 1. Le besoin, et une mise au point

Le besoin exprimé : **deux projets ouverts et visibles en même temps** — deux
fenêtres, typiquement deux écrans, chacune sur son projet, avec des tours qui
avancent des deux côtés.

La mise au point qui s'impose : la limite actuelle n'a **jamais été une
décision produit**. T-028 (2026-08-11) est un garde-fou de développement —
relancer `dev.sh` pendant qu'une session tourne produisait une fenêtre
morte-née qui tuait le sidecar de la première ; le script refuse donc, et il a
raison. Mais personne n'a jamais décidé que travailler sur deux projets à la
fois était hors périmètre. Le poste utilise la session de dev comme application
quotidienne (l'icône du bureau lance `dev.sh`), donc la limite de dev est
devenue, de fait, la limite du produit. Cette étude répare ça : elle part du
besoin, pas du garde-fou.

## 2. Ce qui existe déjà — et ce qui manque vraiment

L'application sait déjà **faire avancer plusieurs conversations en même
temps** :

- le sidecar gère des tours concurrents par construction (`claude.ts:466`,
  `const runs = new Map<string, RunState>()`) — plusieurs projets peuvent
  avoir un tour en cours simultanément ;
- l'interface le sait : « une conversation dont l'onglet n'est pas affiché
  continue de travailler — un point cyan sur son onglet signale qu'un tour est
  en cours » (aide clavier, `raccourcisClavier.ts`) ;
- la bascule de projet est à un `Ctrl+K`.

Ce qui manque n'est donc **pas la concurrence : c'est la visibilité
simultanée**. Aujourd'hui, travailler sur deux projets = alterner. Le besoin
est de ne plus alterner.

## 3. L'inventaire des blocants, mesuré

Pourquoi une deuxième fenêtre (ou instance) ne marche pas aujourd'hui :

| # | Blocant | Où | Gravité |
|---|---|---|---|
| 1 | **Collision d'identifiants de requête.** Chaque fenêtre démarre `requestCounter = 0` et génère `req-1`, `req-2`… Les événements du sidecar sont diffusés à TOUTES les fenêtres (`app.emit`, `sidecar.rs:665`) et triés par id (`sidecar.ts:96,219`) : deux fenêtres se voleraient leurs réponses. | `ui/src/sidecar.ts` | Certaine, **correctif trivial** (préfixe aléatoire par fenêtre) |
| 2 | **`project-conversations.json` : un seul document pour tous les projets, réécrit EN ENTIER.** 12 Mo aujourd'hui, trois sites d'écriture du document complet (`AgentPage.tsx:992,1033,1117`). Deux fenêtres — même sur des projets DIFFÉRENTS — s'écraseraient mutuellement : perte d'historique garantie, silencieuse. | `ui/src/modeleProjet.ts:128`, state | **Le blocant structurel** |
| 3 | Capacités Tauri limitées à la fenêtre `main` (`capabilities/default.json:5`). | src-tauri | Triviale (une entrée) |
| 4 | États annexes partagés à écrivain-document : `last-project.json`, `usage-cache.json`… | state/ | Faible (dernier écrit gagne, acceptable ou trivialement scopé) |
| 5 | *(instances séparées seulement)* Données WebKit partagées (`cookies`, SQLite), DEUX sidecars donc deux gestionnaires des timers systemd (`tachesTimers.ts`), config en dernier-écrivain-gagne. | net.duvam.iaction/ | Sérieuse, propre à la voie B |

Le point 2 est le cœur. Il a un bénéfice caché : ces 12 Mo sont **relus et
réécrits en entier** à chaque sauvegarde — l'éclater sert aussi le démarrage
(T-029 avait mesuré son parse) et borne le coût d'écriture par la taille du
projet, plus du poste entier.

## 4. Les trois voies

### Voie A — Deux fenêtres, un seul processus, un seul sidecar ★

Tauri 2 sait ouvrir plusieurs fenêtres du même processus. Chaque fenêtre porte
sa webview (son arbre React), le sidecar reste UNIQUE — donc un seul CLI
Claude, un seul gestionnaire de timers, une seule configuration, aucun des
blocants du point 5.

À faire : le socle du §5, plus — préfixe d'ids par fenêtre (blocant 1), une
commande « Nouvelle fenêtre » (menu ou raccourci) qui ouvre `main-2` sur le
sélecteur de projet, l'entrée de capacités (blocant 3), et scoper
`last-project` par fenêtre (blocant 4). Les événements diffusés à toutes les
fenêtres deviennent une PROPRIÉTÉ : le statut sidecar, l'encart d'usage et les
jauges sont naturellement justes partout.

**Coût estimé : le socle + un lot moyen.** Aucune réécriture ; c'est le chemin
« par valeur décroissante » du dépôt.

### Voie B — Deux processus (dev + version installée, ou deux installées)

Tout ce que demande A, PLUS le blocant 5 : données WebKit SQLite en accès
concurrent (fragile, hors de notre contrôle), deux sidecars qui régénèrent les
mêmes unités systemd, deux CLIs Claude en mémoire (~600 Mo), configuration en
dernier-écrivain-gagne. Un mode « profil » (`--profil x` suffixant les
dossiers) isolerait tout — mais isole AUSSI ce qu'on veut partager : projets
déclarés, clés, réglages, à reconfigurer deux fois.

**Coût supérieur à A, bénéfices inférieurs.** À ne retenir que pour le cas
« tester l'installée pendant que dev tourne » — qui est un besoin de
développeur, ponctuel, et que la garde T-028 n'empêche pas (elle ne garde que
le port 1420).

### Voie C — Vue scindée dans la fenêtre unique

Deux panneaux côte à côte dans la même fenêtre. Ne demande ni ids ni fenêtres —
mais tout le travail tombe dans `AgentPage.tsx` (2 895 lignes, dérogation du
cliquet), ne donne ni deux écrans ni deux positions de fenêtre, et double la
densité d'une interface déjà chargée. **La moins bonne réponse au besoin réel**
(deux projets = souvent deux moniteurs).

## 5. Le socle, quelle que soit la voie

**Éclater `project-conversations.json` en un fichier par projet**
(`state/projets/<slug>.json`), avec migration au premier chargement et
écrivain par projet. Ce socle :

- supprime le blocant 2 pour A ET pour B (deux fenêtres sur deux projets
  n'écrivent plus jamais le même fichier) ;
- borne chaque écriture à la taille d'UN projet au lieu de 12 Mo ;
- réduit d'autant la lecture au démarrage (T-029) ;
- est utile même si aucune voie n'est retenue — c'est de la dette qui
  disparaît, pas un pari.

Deux fenêtres sur le MÊME projet restent hors contrat au premier lot : la
fenêtre qui tente d'ouvrir un projet déjà ouvert bascule dessus (comme un
éditeur le fait pour un fichier) — honnête, simple, et le cas réel du besoin
est « deux projets DIFFÉRENTS ».

## 6. Recommandation

1. **Lot 1 — le socle** : éclatement par projet + migration + tests (patron
   « feuille pure » habituel). Valeur immédiate même sans fenêtres.
2. **Lot 2 — voie A** : préfixe d'ids, « Nouvelle fenêtre », capacités,
   `last-project` par fenêtre. Livrable : deux projets côte à côte, tours
   concurrents, un seul moteur.
3. **T-028 reste tel quel** — il garde le dev, pas le produit. L'icône du
   bureau, elle, devrait viser l'AppImage installée le jour où l'usage
   quotidien se sépare du développement ; c'est un choix d'usage, pas un
   correctif.
4. **Voie B : ne rien faire** tant qu'un constat réel ne la réclame pas.

## 7. Décisions — tranchées par l'utilisateur le 2026-08-15

1. **Une seule fenêtre par projet** : ouvrir un projet déjà ouvert ailleurs
   BASCULE sur la fenêtre qui le porte, comme un éditeur le fait pour un
   fichier déjà ouvert. Jamais deux fenêtres en écriture sur le même projet.
2. **La deuxième fenêtre porte tout** — Chat, Supervision, Configuration,
   Système : c'est la même application, seule la fenêtre change.
3. **Le Chat est traité dans le même lot** que les projets. Conséquence directe
   de la décision 2 : les deux fenêtres pouvant ouvrir le Chat, son fichier
   unique (`chat-conversations.json`) porte exactement le piège qu'on supprime
   côté projets — le livrer tel quel serait livrer un défaut connu.

Ces décisions sont mises en œuvre par T-061 (lot 1 — le socle de rangement) et
T-062 (lot 2 — la deuxième fenêtre), dans `docs/tickets.md`.

## 8. Deux blocants que le §3 avait manqués — 2026-08-17

Le lot 1 a été livré le 2026-08-15. Le lot 2 a été instruit le 2026-08-17, et
l'inventaire mesuré du §3 s'est révélé **incomplet sur la coquille Rust** : il
avait regardé l'interface et l'état sur disque, pas le cycle de vie des
fenêtres. Les deux manques sont écrits ici pour que le tableau du §3 cesse de
se lire comme exhaustif.

| # | Blocant | Où | Gravité |
|---|---------|-----|---------|
| 6 | **Fermer n'importe quelle fenêtre arrête le sidecar.** `on_window_event` appelle `request_shutdown` sur tout `CloseRequested`, sans compter les fenêtres restantes. Fermer la seconde fenêtre couperait le moteur de la première, en plein tour. | `src-tauri/src/lib.rs:166` | **Perte de travail en cours** — le plus grave du lot |
| 7 | **Micro et surveillance de la webview câblés en dur sur `"main"`.** La seconde fenêtre n'aurait pas la dictée vocale, et la mort de son process de contenu (T-030, quatre fois en six jours) ne laisserait aucune trace : l'échec muet, exactement ce que la doctrine interdit. | `lib.rs:29`, `webview_vie.rs:121` | Sérieuse, silencieuse |

La leçon vaut au-delà de ce lot : **une étude qui inventorie « ce qui empêche
d'ouvrir une seconde fenêtre » doit aussi inventorier ce qui se passe quand on
la FERME.** Le §3 avait mesuré l'ouverture et l'écriture concurrente ; la
fermeture, elle, n'avait été regardée nulle part.

S'y ajoute une limite assumée, écrite dans T-062 : le registre « une fenêtre par
projet » protège les projets, pas les conversations du Chat — deux fenêtres
ouvrant la même conversation de Chat peuvent encore s'écraser. Le risque est
borné par T-061 (un fichier par conversation) à cette seule conversation, au
lieu des 467 Ko du monolithe d'avant.
