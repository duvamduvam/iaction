# IAction — tickets

> Backlog du projet : corrections à venir et nouvelles fonctionnalités.
> Fichier versionné : un ticket = une entrée du tableau + une section détaillée.

## Convention

- **ID** : `T-001`, incrémental, jamais réutilisé (un ticket fermé garde son numéro).
- **Type** : `bug` (correction) · `feat` (fonctionnalité) · `tech` (dette technique, refacto,
  outillage) · `doc`.
- **Prio** : `P1` (bloquant / à faire ensuite) · `P2` (important, pas urgent) · `P3` (confort,
  un jour).
- **Statut** : `ouvert` → `en cours` → `fait`, ou `abandonné`.
- Les tickets `fait`/`abandonné` descendent dans « Archivés » avec la date de clôture.

Pour ajouter un ticket : prendre le prochain ID libre, ajouter une ligne au tableau **et** une
section détaillée. Le corps peut rester d'une ligne — mieux vaut un ticket court qu'un oubli.

**Règle : tout dysfonctionnement CONSTATÉ produit un ticket.** Constat utilisateur, erreur
récurrente dans `logs/app.jsonl`, incident en cours de développement : ça se consigne ici,
avec la date et l'observation brute, même si la cause n'est pas comprise. Corrigé dans la
foulée ? Le ticket se crée quand même et se ferme aussitôt — le backlog est la mémoire des
pannes, pas seulement la liste du travail restant (voir T-005/T-006, constatés et clos le
même jour). Un dysfonctionnement sans ticket est un échec muet de plus, exactement ce que
la doctrine d'observabilité interdit.

Ce fichier est **reflété en issues GitHub** à chaque publication qui le touche
(`.github/workflows/tickets.yml`) : issue créée à l'ouverture, fermée à
l'archivage. Le fichier reste la seule source de vérité — une issue ouverte à
la main sur le dépôt public (retour de visiteur) se transcrit ici pour entrer
au backlog, jamais l'inverse (voir `docs/github.md` §5).

## Ouverts

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-009 | tech | P3   | ouvert | Dev : fenêtre ouverte avant que vite soit chaud → page à moitié chargée, IPC muet |
| T-015 | bug  | P1   | ouvert | Un tour Claude peut mourir sans laisser AUCUNE trace dans le journal |
| T-026 | feat | P3   | ouvert | Recherche web : sur une question d'actualité, le moteur rend des pages de rubrique, pas des articles |
| T-029 | tech | P2   | en cours | Démarrage long : aucun budget mesuré entre le lancement et la première image |
| T-030 | bug  | P1   | ouvert | La fenêtre gèle au démarrage quand le process WebKit meurt, sans une ligne de journal |
| T-048 | bug  | P2   | ouvert | Coller une capture fige le composeur ~5 s : ni vignette, ni frappe prise en compte pendant la lecture du presse-papier |

### T-009 — Dev : fenêtre ouverte avant que vite soit chaud

Incident du 2026-08-08, 11h36 : `dev.sh` relancé, vite démarré à 11:36:53,
fenêtre ouverte à 11:36:55 — le webview a chargé la page pendant la
ré-optimisation à froid de vite. Résultat : interface rendue mais greffe IPC
jamais initialisée — `config_read` sans réponse, « Aucun projet » alors que
la config est intacte, **zéro trafic pendant 13 minutes** sans le moindre
message d'erreur. Un simple rechargement du webview répare. Pistes (dev
uniquement) : garde-fou au boot de l'UI — si les invocations de démarrage
n'ont pas répondu après quelques secondes, bandeau « recharger » (voire
rechargement automatique une fois), plutôt qu'une page qui a l'air saine.

### T-015 — Un tour Claude peut mourir sans aucune trace dans le journal

Constaté le 2026-08-09 vers 12h44 (projet Rdpl, moteur Claude abonnement).
Deux faits distincts, le second bien plus grave :

**1. Le tour affiché en erreur.** La bulle « Le tour s'est terminé
anormalement (error_during_execution) » que montre l'écran n'est PAS récente :
elle rejoue une conversation enregistrée. L'événement correspondant est daté du
**2026-08-08T22:07:31** (2 jetons en entrée, 479 en sortie, `claude-fable-5`) —
identifié par recoupement exact dans `usage/events.jsonl`. Ce sous-type est
apparu **8 fois depuis le 2026-08-02**, sur les deux modèles, toujours sur des
tours longs ou utilisant une compétence (ici `grill-me`).

**2. Le tour muet — le vrai défaut.** Ce même jour, deux messages envoyés
(12h38 et 12h44) n'ont produit aucune bulle de réponse. Le journal montre
pourtant qu'un tour a **démarré** (`serveurs MCP du tour`, 12h40:46) : il n'a
jamais rendu ni résultat, ni erreur, et aucun processus Claude n'était vivant
au moment du constat. Entre le démarrage du tour et le silence, `app.jsonl` ne
contient **rien**.

Ce qui manque précisément : `recordUsageEvent` consigne bien l'échec dans le
magasin d'usage (`errorMessage: "résultat Claude: <subtype>"`,
`sidecar/src/claude.ts` ~1115), mais **le journal applicatif, lui, ne reçoit
aucune ligne de niveau `error`**. Or c'est lui que lit la page Système, et
c'est lui qu'on ouvre quand quelque chose cloche. Un tour peut donc échouer
sans que l'observabilité en garde la moindre trace — exactement ce que la
doctrine interdit.

Pistes : journaliser en `error` au même endroit que l'événement d'usage (avec
sous-type, session, modèle, et l'outil ou la compétence en cours) ; et prévoir
un garde-fou côté tour — si le processus meurt sans `result`, émettre une
erreur explicite plutôt que laisser l'interface attendre indéfiniment.

**Observation décisive du 2026-08-09 à 13h46**, application FRAÎCHEMENT
redémarrée, tour relancé par l'utilisateur (« enregistre ce note ») :

- le tour est journalisé au départ — `serveurs MCP du tour`, 5 serveurs
  connectés, 39 outils, 1,5 s ;
- **le sidecar est vivant mais n'a AUCUN processus enfant** (`ps --ppid`,
  `pstree`) : le CLI Claude n'a jamais été lancé, alors que son binaire est
  bien présent dans le bundle exécuté (295 Mo, vérifié) ;
- rien après, ni résultat, ni erreur, ni exception ;
- l'interface attend indéfiniment.

Ce n'est donc PAS « le flux se referme sans résultat » : c'est `query()` qui ne
rend jamais son PREMIER message. Aucun garde-fou n'existait pour ce cas — les
deux minuteurs de `claude.ts` ne s'arment qu'APRÈS un `result`.

**Réalisé le 2026-08-09** : journal `error` sur tout tour terminé en erreur
(sous-type, session, modèle — jamais le corps de la réponse), sur toute
exception du flux (avec la pile), et sur un flux qui se referme sans `result`
— ce dernier cas rend désormais une erreur explicite à l'interface au lieu
d'un `done` muet. S'y ajoute un **plafond de silence au démarrage** : aucun
message du SDK dans le délai imparti ⇒ erreur journalisée et remontée, plutôt
qu'une attente infinie.

Reste ouvert : la CAUSE du non-lancement du CLI. Les garde-fous ci-dessus la
rendront visible à la prochaine occurrence — c'est tout leur objet.

**Statut arrêté le 2026-08-15 : EN ATTENTE DE CONSTAT, pas en attente de travail.** Tout ce
qui pouvait être écrit sans revoir la panne l'a été le 2026-08-09 — journal d'erreur sur tout
tour terminé anormalement, sur toute exception du flux, sur un flux qui se referme sans
`result`, et plafond de silence au démarrage. Écrire davantage maintenant reviendrait à coder
contre une hypothèse, puis à présenter l'absence de récidive comme une preuve. Ce ticket se
fermera le jour où la panne reviendra **avec sa trace** — ou, si elle ne revient plus, par une
décision de l'utilisateur, pas par un correctif de plus.

### T-026 — Recherche web : des pages de rubrique au lieu d'articles

Constaté le 2026-08-10, au premier tour réel de R9 (`swiftask · deepseek-v3`,
« Donne les actualités en Amérique latine de ce mois »). Les 5 sources
remontées sont des **pages de rubrique** — `lemonde.fr/mexique/`,
`radiofrance.fr/monde/amerique-latine`, `tf1info.fr/actualite/amerique-du-sud` —
et non des articles datés. Le modèle a fait ce qu'il fallait : il a dit que
les extraits ne suffisaient pas. Mais l'utilisateur, lui, n'a pas sa réponse.

Ce n'est pas un défaut du mécanisme : c'est la requête qui part en recherche
GÉNÉRALE. Mesuré sur le même SearXNG, à question identique :

| Paramètres | Ce que ça remonte |
|---|---|
| défaut | 24 résultats, **pages de rubrique**, aucune date |
| `&categories=news` | 25 résultats, de vrais articles, mais du hors-sujet |
| `&categories=news&time_range=month` | 10 résultats, articles **récents et pertinents** |

Deux pistes, à ne pas confondre :

- **La petite** : router les questions d'actualité vers `categories=news` +
  `time_range`. Le coût réel n'est pas l'appel, c'est le CHOIX : décider
  qu'une question « porte sur l'actualité » à l'heuristique, c'est se
  tromper sur les cas limites, et se tromper en silence.
- **La grande** : la reformulation de requête par un LLM court, explicitement
  écartée de R9 (« à rouvrir sur constat, pas par anticipation »). Le constat
  est là. Elle réglerait aussi les questions mal formulées, au prix d'un
  appel de plus et d'une latence de plus.

Aucune des deux ne se décide sur un seul cas : à rouvrir quand plusieurs
tours réels auront montré le même défaut, avec leurs requêtes.

**Statut arrêté le 2026-08-15 : EN ATTENTE DE CONSTAT.** Un seul tour, une seule question. Les
deux pistes coûtent cher au bon endroit — l'heuristique « cette question porte sur
l'actualité » se trompe en silence sur les cas limites, la reformulation par LLM ajoute un
appel et une latence à chaque recherche. Trancher aujourd'hui, ce serait choisir sur un
échantillon de un ; c'est précisément l'erreur que T-012 et T-019 ont documentée dans ce même
fichier. Le ticket attend d'autres tours réels, avec leurs requêtes.

### T-029 — Démarrage long, et pas un chiffre pour le dire

Constat utilisateur du 2026-08-11 : « pourquoi le démarrage du logiciel est-il
si long ? ». Aucune réponse possible — le premier horodatage d'une session
était celui de `setup()`, c'est-à-dire déjà à l'intérieur du code applicatif.
Tout ce qui le précède et tout ce qui le suit côté webview était hors mesure.
Un budget de démarrage qu'on ne peut pas lire est un échec muet de plus.

**Ce que les étages déjà instrumentables ont répondu** (tous mesurés le
2026-08-11, aucun n'est en cause) : sidecar prêt en 0,25 s à froid ;
`cargo build` à blanc en 0,23 s ; les 6 Mo de `project-conversations.json`
relus et parsés en 32 ms (7 projets, 49 sessions, 834 tours) ; `usage.stats`,
`taches.list`, `tickets.list` et `knowledge.status` servis en 125–151 ms.

**Jalons posés** (`demarrage.rs` + `demarrage.ts`, voir `docs/protocol.md`
§ « Jalons de démarrage ») : `rust:setup`, `rust:boucle-evenements`,
`ui:script`, `ui:premier-rendu`, avec `avantMainMs` (lu dans `/proc` : le seul
segment qu'un `Instant` ne peut pas voir) et `pageMs` (l'horloge de la page,
qui sépare le démarrage du moteur web du chargement de l'interface). Méthode
recoupée sur un process vivant : `btime` + `starttime` redonnent l'heure du
`exec` à 60 ms près de ce que dit le journal.

**Premiers relevés, sur des relances déclenchées par `tauri dev` après
recompilation** :

| segment | valeur |
|---|---|
| avant `main()` | **4,8 s puis 10,4 s** |
| `main()` → `setup()` (GTK, fenêtre) | 317–389 ms |
| fenêtre → `ui:script` | 486 ms (dont 328 ms de page) |
| `ui:script` → première image | 780 ms |

L'application elle-même dessine donc **~1,6 s après `main()`**. Le poste
énorme est le « avant `main()` » — mais il n'est PAS intrinsèque au binaire :
lancé seul, sans affichage, le binaire va de l'`exec` à l'init GTK en
**109 ms** (et `ldd` résout les 124 bibliothèques en 24 ms, 18,5 Mo de
segments chargeables, sur NVMe). Ces 5 à 10 s appartiennent au contexte de la
relance : le process est créé pendant que la machine termine l'édition de
liens du binaire de debug (241 Mo, dont 233 Mo de debuginfo, sans `mold`).

**Lancement NORMAL** (`dev.sh` du 2026-08-11 22:14, binaire Rust inchangé —
`iaction` daté de 22:09, donc aucune recompilation) : la chaîne complète, du
lancement de la commande à la première image, tient en **~8,2 s**.

| étape | horodatage | durée |
|---|---|---|
| `tsc` du sidecar (dev.sh) | → 22:14:50,5 | ~2,5 s |
| `tauri dev`, puis Vite | 22:14:50 → 22:14:51 | 1 s |
| attente avant l'`exec` du binaire (fraîcheur cargo + Vite) | → 22:14:53,2 | ~2,3 s |
| avant `main()` | | 340 ms |
| `main()` → fenêtre (GTK) | → 22:14:53,95 | 383 ms |
| fenêtre → webview | | 175 ms |
| chargement + parse du JS (7 Mo non bundlés) | → 22:14:55,4 | **1 264 ms** |
| premier rendu React | → 22:14:56,2 | 800 ms |

L'application seule, de l'`exec` à la première image : **3,0 s**. Les 340 ms
d'avant-`main()` confirment que les 4,8 et 10,4 s relevés plus haut étaient le
contexte de recompilation, pas le binaire.

**Ce qui manque pour clore** : le même relevé en version empaquetée, où l'UI
n'est plus servie module par module (1,6 Mo bundlés contre 7 Mo) — les deux
plus gros postes du tableau y sont probablement absents. Les jalons y sont
aussi : ils s'écriront tout seuls.

**Fait le 2026-08-11, sur les deux plus gros postes actionnables :**

1. **`dev.sh` ne recompile plus le sidecar pour rien** (−2,5 s par lancement).
   `sidecar/scripts/a-jour.mjs` pose la question au code compilé lui-même, via
   `inspecterPeremption` — la MÊME empreinte que celle du garde-fou T-020, pas
   une seconde implémentation qui divergerait. Vérification : **148 ms**. Le
   doute fait toujours recompiler (dossier absent, témoin illisible,
   `hors-source`), et c'est ce que verrouille `sidecar/test/aJour.test.js` :
   sauter un `tsc` à tort, c'est refabriquer T-020.
2. **Les cinq pages non affichées ne sont plus chargées au démarrage**
   (`ui/src/pagesParesseuses.tsx`). Le graphe servi au lancement passe de
   **7 074 Ko / 119 modules à 5 434 Ko / 103 modules** (−23 %) ; en build
   empaqueté, 194 ko de chunks sortent du bundle principal (ChatPage,
   OrchestrationPage, ProvidersPage, SupervisionPage, SystemPage).
   `AgentPage` reste chargée d'emblée : c'est la page ouverte au démarrage.
   L'invariant qui justifiait les six pages montées en permanence est
   préservé et testé — **une page montée ne se démonte jamais**, seule sa
   première mise en mémoire est différée.

**Reste à faire** : `mold` + `split-debuginfo` (ne pèse que quand un `.rs`
change, mais c'est alors le poste dominant) ; comprendre les ~2,3 s entre
`tauri dev` et l'`exec` du binaire, alors que cargo à blanc répond en 0,23 s ;
et le relevé en version empaquetée.

### T-030 — La fenêtre gèle au démarrage, et rien ne le dit

**Type** bug · **Prio** P1 · **Statut** ouvert · **Créé** 2026-08-12

Constaté le 2026-08-12 à 17h25 : application « complètement bloquée au lancement ».
La coquille allait bien — c'est le **process de contenu WebKit qui était mort**, la
fenêtre affichant sa dernière image pour toujours.

Relevé brut :

- `coquille.jsonl` va jusqu'au bout (`ui:premier-rendu` à 15:25:45.720Z), donc la page
  a bien été peinte ;
- `ps --ppid <iaction>` ne montre plus que `WebKitNetworkProcess` — **plus de
  `WebKitWebProcess`** ; `iaction` et le sidecar sont vivants, à 0 % de CPU ;
- `journalctl` : `pipewire-main-l[1745939]: segfault at 18 … in libgstpipewire.so`
  à 17:25:49, soit ~3 s après la première image. Le plantage est **dans une
  bibliothèque système** (greffon PipeWire de GStreamer, que WebKit charge pour le
  moniteur de périphériques média), pas dans notre code ;
- même signature 3 fois avant : 2026-08-07 14:31 et 18:17, 2026-08-08 11:36. Le
  déclencheur exact n'est pas compris — la plupart des lancements passent.
  (Le 2026-08-11 23:58, un couple d'autres segfaults, `libwebkit2gtk` puis
  `libnvidia-eglcore`, a tué le même process : le mode de panne « la webview meurt »
  n'est pas propre à PipeWire.)

Le vrai défaut est le nôtre : **`app.jsonl` ne contient pas une ligne** sur cet
événement, l'utilisateur n'a aucun message, et la fenêtre reste ouverte, figée,
impossible à distinguer d'une lenteur. C'est exactement l'échec muet que la doctrine
d'observabilité interdit — la coquille sait pourtant journaliser la mort du sidecar
(T-017), elle doit savoir journaliser la mort de sa webview.

À faire :

1. brancher le signal `web-process-terminated` de WebKitGTK (raison : plantage /
   dépassement mémoire / tué), écrire une ligne `error` dans `app.jsonl` et un jalon
   dans `coquille.jsonl` ;
2. afficher un état franc dans la fenêtre plutôt qu'une image morte, avec un bouton
   « recharger » (la coquille peut recréer la webview sans relancer le process) ;
3. seulement ensuite, chercher à éviter le plantage lui-même — piste à tester,
   dégrader le greffon fautif au lancement (`GST_PLUGIN_FEATURE_RANK=pipewiredeviceprovider:NONE`
   dans `scripts/dev.sh` et dans l'environnement de l'app empaquetée) pour retomber
   sur le fournisseur PulseAudio. À confirmer par un relevé : la panne est
   intermittente, une absence de plantage sur quelques lancements ne prouvera rien.

### T-048 — Coller une capture fige le composeur ~5 s

**Type** bug · **Prio** P2 · **Statut** ouvert · **Créé** 2026-08-14

Constat utilisateur du 2026-08-14 : « quand je colle une capture d'écran, ça prend 5 secondes
avant d'être pris en compte ». Pendant ce délai, **rien** : pas de vignette, et la question
tapée dans le composeur n'est pas prise en compte. Attendu : vignette et frappe immédiates,
les octets arrivant ensuite.

Ce qui rend le constat instructif, c'est que le repli natif a **déjà** été écrit pour ça. Le
handler `onPaste` ([AgentPage.tsx](../ui/src/AgentPage.tsx) ~2727, idem
[ChatPage.tsx](../ui/src/ChatPage.tsx)) crée une vignette « en chargement » de façon
SYNCHRONE (`beginImage`, [Attachments.tsx](../ui/src/Attachments.tsx) ~246) avant d'appeler
`readClipboardImage()`. Si la vignette n'apparaît pas, ce n'est donc pas qu'on l'affiche trop
tard : **c'est que rien n'est peint du tout** pendant ces secondes — et le clavier muet dit la
même chose. Le symptôme n'est pas « le collage est lent », c'est « l'interface est gelée ».

**Hypothèse principale, à MESURER avant de corriger** : `clipboard_read_image`
([clipboard.rs](../src-tauri/src/clipboard.rs) 29-42) est une commande Tauri **synchrone**
(`pub fn`, pas `async fn`). Sous Tauri 2, une commande synchrone s'exécute sur le fil
principal — celui qui porte la boucle GTK, donc l'affichage et les événements de la webview.
Tant qu'`arboard` négocie avec le propriétaire du presse-papier (X11/Wayland : le processus
qui a fait la capture doit répondre) puis qu'on encode le PNG, la boucle ne rend pas la main.
Le soin déjà pris côté performance (compression `Fast`, renvoi binaire plutôt que base64) ne
change rien à ça : ce n'est pas la durée qui gêne, c'est *où* elle est passée.

Suspect secondaire, côté interface : `resolveImage` relit ensuite les octets en **data URL
base64** (`FileReader.readAsDataURL`, [Attachments.tsx](../ui/src/Attachments.tsx) ~279) —
plusieurs Mo pour une capture plein écran, +33 % en base64, sur le fil de l'UI lui aussi.

**Mesure à faire avant tout correctif** (ne pas conclure d'une lecture de code, cf. T-012 et
T-019) — quatre segments à horodater sur un collage réel :

1. événement `paste` → vignette « en chargement » réellement peinte ;
2. `invoke` → retour de `clipboard_read_image` (et, dedans, `get_image()` vs `encode_png`) ;
3. taille et dimensions du PNG produit ;
4. `FileReader` → `dataUrl` posée, vignette pleine.

Sans ces chiffres on ne sait pas si les 5 s sont la négociation du presse-papier, l'encodage
PNG ou l'encodage base64 — trois correctifs différents.

**Pistes, dans l'ordre où elles deviendront pertinentes** :

- passer la commande en `async fn` (ou déporter le corps dans `spawn_blocking`) pour rendre la
  boucle GTK disponible : la vignette se peint et la frappe passe, même si la lecture prend
  plusieurs secondes ;
- afficher la vignette par `URL.createObjectURL(blob)` (instantané, aucune copie) et ne
  produire le base64 qu'au moment de l'envoi, où il est réellement exigé par le contrat ;
- si le poste reste lent après ça, dire l'attente (vignette « lecture du presse-papier… »)
  plutôt que la laisser deviner.

### T-038 — L'AppImage ne se construit plus, et l'échec est muet

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13 en livrant la 0.3.1 : le portique de la PR échoue sur
`construire (ubuntu-latest)`, à l'étape `tauri build` :

```
Bundling IAction_0.3.1_amd64.AppImage (…/bundle/appimage/IAction_0.3.1_amd64.AppImage)
failed to bundle project: `failed to run linuxdeploy`
```

**Trente secondes, puis cette seule ligne.** L'outil qui a échoué n'a laissé aucune trace :
Tauri n'affiche pas la sortie de `linuxdeploy` quand il tombe, et l'étape « Construire » était
la seule de la chaîne à ne pas recopier son échec en annotation — les journaux de run étant
réservés aux administrateurs du dépôt, la cause est donc restée invisible depuis l'extérieur.
Le défaut d'observabilité est ici plus grave que la panne : on ne peut pas corriger ce qu'on
ne voit pas.

Ce qui rend le cas déroutant : la **même image de runner** (`ubuntu-24.04`, version
`20260720.247.2`) et le même workflow avaient produit l'AppImage sans broncher le 2026-08-09.
Aucun `.rs`, aucun fichier d'empaquetage n'a bougé entre les deux. Suspect principal : les
binaires que Tauri télécharge à chaque run ne sont pas figés —
`linuxdeploy-plugin-appimage` vient de l'étiquette **`continuous`** du dépôt amont, qui bouge
sous nos pieds. Une dépendance de construction non épinglée est une panne qui attend son jour.

Premier geste, posé le 2026-08-13 : l'étape « Construire » capture sa sortie, en recopie les
40 dernières lignes en annotation et en affiche 25 dans le journal, comme le font déjà les
tests du sidecar et `cargo test`. `APPIMAGE_EXTRACT_AND_RUN=1` est posé au passage (linuxdeploy
et son greffon sont eux-mêmes des AppImages : sans FUSE sur le runner, ils doivent s'extraire
pour tourner) — remède à la cause la plus courante, pas un diagnostic.

**Cause trouvée le 2026-08-13**, dès que `--verbose` a fait parler le sous-processus :

```
[gtk/stdout] Deploying dependencies for ELF file …/IAction.AppDir/usr/lib/IAction/
             sidecar/node_modules/@anthropic-ai/cla…
[gtk/stderr] terminate called after throwing an instance of 'std::runtime_error'
[gtk/stderr]   what():  Failed to run ldd: exited with code 1
ERROR: Failed to run plugin: gtk (exit code: 134)
```

`linuxdeploy` parcourt TOUS les fichiers ELF de l'AppDir pour en déployer les dépendances. Il
tombe sur le **CLI Claude embarqué**, lance `ldd` dessus, `ldd` sort en 1 — et linuxdeploy ne
traite pas cet échec comme un avertissement : il **abandonne** (code 134, `SIGABRT`).

Et le suspect « outil amont non épinglé » était le mauvais : **c'est notre bundle qui a
changé**, pas le runner. Les annotations d'inventaire le disent au octet près :

| | 2026-08-09 (vert) | 2026-08-13 (rouge) |
|---|---|---|
| CLI Claude (Linux) | `claude` = 297 831 432 o | (non atteint) |
| CLI Claude (Windows) | `claude.exe` = 287 053 472 o | `claude.exe` = 307 186 848 o |

Le CLI a pris ~20 Mo entre les deux, d'où une première conclusion — « le SDK a été résolu dans
une version plus récente » — **qui est fausse, vérification faite le 2026-08-13** :

- `package-lock.json` n'a pas bougé d'une ligne entre les deux runs (`git diff c6a461a HEAD --
  package-lock.json` est vide) ;
- le SDK y est figé à **0.3.214**, et ses huit binaires par plateforme le sont aussi,
  version exacte, y compris `claude-agent-sdk-win32-x64` ;
- la CI installe par `npm ci`, qui ne s'écarte pas du verrou ;
- le paquet de plateforme ne porte aucun `postinstall` : le binaire vient du tarball, pas d'un
  téléchargement à l'installation.

Deux tailles différentes pour un tarball npm immuable : **l'observation et l'explication ne
se rejoignent pas**, et le ticket ne prétendra pas le contraire.

La seconde hypothèse — « le binaire est lié statiquement, d'où `ldd` en échec » — **tombe
aussi**, mesurée sur le poste le 2026-08-13 :

```
$ file node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude
ELF 64-bit LSB executable, x86-64, dynamically linked,
interpreter /lib64/ld-linux-x86-64.so.2, …, not stripped
$ ldd … ; echo $?
librt.so.1 => … libc.so.6 => … libpthread.so.0 => …
0
```

Binaire **dynamique**, `ldd` sort en **0**, six bibliothèques listées. Le binaire tel que npm
le livre n'a donc rien qui explique l'échec.

Ce qui reste établi tient au journal, et à lui seul : dans l'AppDir, `ldd` sort en 1 sur ce
fichier, et linuxdeploy en fait un abandon au lieu d'un avertissement. La différence entre les
deux situations n'est pas le binaire d'origine mais **ce que linuxdeploy en a fait avant de
l'interroger** : il copie, puis `strip` et `patchelf` les ELF déployés. Un `patchelf` sur un
exécutable de 265 Mo qui traîne une charge utile en queue de fichier est un candidat sérieux à
la corruption — après quoi `ldd` échoue légitimement. **À vérifier, pas à conclure.**

**La cause, établie par reproduction locale le 2026-08-13.** Trois copies du même fichier :

| copie | taille | `ldd` |
|---|---|---|
| npm, dans le dépôt | 265 210 864 | 0 |
| `build/sidecar-bundle` | 265 210 864 | 0 |
| **AppDir, après linuxdeploy** | 265 214 960 (+4 096) | **1** |

Même BuildID, 4 096 octets de plus, un `RUNPATH [$ORIGIN]` ajouté : **linuxdeploy réécrit le
binaire avec `patchelf`, le casse, puis lui reproche d'être cassé** en lançant `ldd` dessus.
Le CLI Claude porte une charge utile collée en queue de fichier, que la réécriture ELF ne
survit pas. Ni la version ni la taille n'y sont pour quelque chose : le binaire de 265 Mo
subit le sort du binaire de 311 Mo. `NO_STRIP=true` ne change rien — c'est `patchelf`, pas
`strip`.

**Corrigé** en soustrayant le CLI au balayage, faute de pouvoir demander à linuxdeploy de
l'épargner :

1. `preparer-bundle.sh` range le CLI **compressé** dans le paquet Linux (253 → 90 Mo). Un
   `.gz` n'est pas un ELF : linuxdeploy passe devant sans le voir.
2. [cliClaude.ts](../sidecar/src/cliClaude.ts) le détend au premier lancement dans
   `<données>/bin/claude-<empreinte>` et aiguille le SDK dessus
   (`pathToClaudeCodeExecutable`). Une AppImage étant en lecture seule, il n'y avait de toute
   façon aucun autre endroit où poser un exécutable. Écriture sous nom provisoire puis
   renommage atomique ; complétude vérifiée par la taille inscrite dans le pied du gzip, pour
   qu'une extraction interrompue soit refaite au lieu d'être crue sur parole ; échec
   journalisé et main rendue au SDK, jamais d'exception au démarrage.
3. L'aiguillage est posé dans `resolveQueryFn()`, seul endroit qui lance le CLI — `claude.ts`,
   `claudeUsage.ts` et `claudeCommands.ts` composent chacun leurs options, et une consigne à
   recopier dans trois fichiers est une consigne qu'on oubliera au quatrième.

Sept cas de test ([cliClaude.test.js](../sidecar/test/cliClaude.test.js)) sur un chemin de code
qui ne s'exécute QUE dans le paquet Linux : sans eux, personne ne l'aurait jamais fait tourner
avant l'utilisateur. **AppImage produite en local : 222 Mo, construction verte.**

Reste dû, et consigné à part : la CI ne dit toujours pas ce que produit une construction
réussie côté ELF, et le résidu d'empaquetage qui m'a fait lire trois fois le même échec est
devenu [T-041](#t-041--lempaquetage-local-ressuscite-les-fichiers-supprimés).

Note de parcours, parce qu'elle se reproduira : le premier jet de `cliClaude.test.js` vérifiait
le bit d'exécution sans condition, et **le runner Windows l'a rejeté** (`vu 666`). NTFS n'a pas
ce bit ; `chmod` n'y bascule que « lecture seule ». Le test accusait le code d'un défaut du
système — le piège déjà consigné dans `docs/plan-de-test.md`. La bascule reste vérifiée là où
elle existe : sans elle, l'AppImage lancerait un fichier non exécutable.

À trancher pour la suite (aucune de ces pistes n'est encore posée) :

1. soustraire le CLI au balayage de linuxdeploy — le stocker compressé dans l'AppImage et le
   détendre au premier lancement, ce qui le retire de l'AppDir en tant qu'ELF ;
2. épingler `linuxdeploy` et ses greffons dans `~/.cache/tauri/` sur des versions connues, en
   les pré-déposant avant la construction (Tauri ne télécharge que ce qui manque) — à ceci
   près que le greffon GTK vient de `master` et le greffon AppImage de `continuous` : ce sont
   des cibles mouvantes, indépendamment de la panne du jour ;
3. ~~figer la version de `@anthropic-ai/claude-agent-sdk`~~ — sans objet : elle l'est déjà.

**L'installeur Windows, lui, se construit** : il est déposé en artefact par son propre job,
que le job Linux tombe ou non. La release **étiquetée**, elle, reste bloquée — `publier`
dépend des deux plateformes (`needs: construire`), et c'est très bien ainsi : livrer une
version en taisant qu'une plateforme n'a pas été produite serait l'échec muet dans sa forme la
plus coûteuse.

## Archivés

| ID    | Type | Prio | Statut | Titre |
|-------|------|------|--------|-------|
| T-054 | bug  | P1   | fait   | Windows : une console noire clignotait toutes les 5 s — la sonde GPU relançait `nvidia-smi` sans masquer sa fenêtre |
| T-055 | bug  | P2   | fait   | Sans clé OpenRouter, l'encart de conso réclamait le crédit toutes les 15 s et journalisait le refus en `error` |
| T-052 | bug  | P2   | fait   | Les tours de projet partaient avec un prompt système VIDE : le preset Claude Code est demandé explicitement |
| T-012 | tech | P1   | fait   | Dependabot : les quatre paquets réellement livrés sont montés, le reste ne part pas dans le produit |
| T-045 | tech | P2   | fait   | Réseau d'entreprise : un encart pour saisir proxy et autorité, et le PAC dit non lu |
| T-023 | tech | P2   | fait   | Profils de fournisseur : la gratuité et la jauge de solde sont déclarées, plus devinées |
| T-036 | bug  | P3   | fait   | Swiftask est structurellement muet sur le coût, et la recherche web n'a rien à facturer |
| T-053 | bug  | P2   | fait   | Le verrou du runner déclarait mort tout détenteur hors Linux : `/proc` sans repli, CI Windows rouge |
| T-025 | bug  | P2   | fait   | Agents `*-with-search` : la recherche faite deux fois cassait un tour sur cinq, R9 les écarte |
| T-019 | bug  | P1   | fait   | Les questions interactives n'étaient plus sollicitées : l'outil n'était annoncé que par une fiche de RAG |
| T-008 | bug  | P3   | fait   | `usage.openrouter` au démarrage : une course avec la poussée des fournisseurs, journalisée en erreur |
| T-007 | bug  | P2   | fait   | `ollama.ps` répondait une page web : une SONDE dont l'échec est nominal criait « error » 140 fois |
| T-049 | feat | P3   | fait   | Un HTML cité dans un rapport s'ouvrait dans l'éditeur interne, jamais dans le navigateur déclaré |
| T-024 | bug  | P3   | fait   | Un chemin hors projet cliqué dans une transcription annonçait « introuvable » alors qu'il existe |
| T-041 | tech | P3   | fait   | Empaquetage local : `target/release/sidecar/` reversait dans l'AppDir des fichiers disparus de la source |
| T-051 | bug  | P1   | fait   | La suite de tests travaillait dans le VRAI `~/.local/share`, et pouvait y déplacer des données |
| T-050 | bug  | P1   | fait   | Verrou orphelin : une modification de manifeste pendant une synchro bloquait toutes les suivantes |
| T-040 | bug  | P1   | fait   | L'image `ia-runner` ne se construisait plus : le Dockerfile ne copiait pas `sidecar/scripts/` |
| T-047 | tech | P2   | fait   | La table de routage par défaut était écrite deux fois, sans rien pour vérifier qu'elles concordent |
| T-046 | bug  | P2   | fait   | `claude-opus-5` absent des sélecteurs : la liste des modèles de l'abonnement était recopiée dans trois fichiers |
| T-034 | tech | P2   | fait   | Le cliquet de taille était rouge sur `master` : `src-tauri/src/sidecar.rs` à 807 lignes |
| T-043 | bug  | P1   | fait   | Poste d'entreprise : tous les fournisseurs en « erreur réseau », le fetch de Node ignorait le proxy |
| T-044 | bug  | P2   | fait   | « erreur réseau: fetch failed » sans le code de cause : quatre pannes, un seul message |
| T-042 | bug  | P1   | fait   | L'installeur n'embarquait pas la version testée : le bundle réinstallait ses dépendances sans verrou |
| T-038 | bug  | P1   | fait   | L'AppImage ne se construisait plus : linuxdeploy casse le CLI Claude avec `patchelf`, puis abandonne |
| T-039 | bug  | P1   | fait   | `ModelPicker.tsx` et `modelPicker.ts` : deux noms que Windows confond, l'installeur ne compilait plus |
| T-037 | bug  | P2   | fait   | Un test neuf construisait un chemin en `/D:/…` : la CI Windows échouait sur « sans-empreinte » |
| T-035 | bug  | P2   | fait   | La dépense réelle n'était affichée nulle part : « Débord du mois » ne compte que le routage auto |
| T-033 | bug  | P2   | fait   | Supervision : Jour et Semaine affichaient les mêmes KPI, et ◀ ▶ sautait d'un mois |
| T-032 | feat | P2   | fait   | Sélecteur de modèle illisible : 300 slugs bruts dans un `<select>`, favoris en double |
| T-031 | bug  | P1   | fait   | L'écriture dans le Chat traînait : un rendu de page complet par fragment reçu |
| T-021 | bug  | P2   | fait   | `models.list` ne montrait que 8 modèles là où le fournisseur en sert 142 |
| T-022 | bug  | P2   | fait   | Un usage à zéro était enregistré comme zéro, jamais comme « inconnu » |
| T-028 | bug  | P1   | fait   | Relancer `dev.sh` ouvre une fenêtre morte-née, sans sidecar |
| T-027 | bug  | P1   | fait   | L'avis « aucune donnée reçue du fournisseur » s'affichait à chaque réponse |
| T-010 | feat | P2   | fait   | Recherche web pour le moteur neutre (Chat) — aujourd'hui réservée à Claude |
| T-020 | bug  | P1   | fait   | En développement, l'application exécutait un sidecar périmé de trois jours |
| T-017 | bug  | P1   | fait   | La coquille journalisait le démarrage du sidecar, jamais sa mort |
| T-018 | bug  | P1   | fait   | Chat : le fournisseur choisi retombait silencieusement sur Claude |
| T-016 | bug  | P2   | fait   | Le sidecar annonçait la version 0.1.0, et un test verrouillait ce mensonge |
| T-014 | bug  | P1   | fait   | CI Windows en échec : un test construisait un chemin sans lettre de lecteur |
| T-013 | bug  | P2   | fait   | Le miroir des tickets déduisait le dépôt du remote : inutilisable en local |
| T-011 | bug  | P1   | fait   | L'audit de publication ne voyait pas les fichiers non suivis |
| T-005 | bug  | P1   | fait   | Le débord R3 ignore la fenêtre 7 jours : l'Auto route vers un abonnement saturé |
| T-006 | bug  | P1   | fait   | Tour abonnement muet : curseur infini au lieu d'un état « attente/limite atteinte » |
| T-004 | bug  | P1   | fait   | Le fil redescend tout seul pendant un streaming |
| T-003 | bug  | P1   | fait   | L'allowlist `tools:` d'un agent n'est pas appliquée (moteur claude) |
| T-002 | feat | P3   | fait   | Lien « dernier rapport qualité » dans la page Système |
| T-001 | feat | P3   | fait   | Page « Tickets » dans l'app |

---

### T-054 — Une console noire clignote toutes les 5 secondes sous Windows

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-26 · **Clos** 2026-08-26

Signalé le 2026-08-26 depuis un poste Windows 11 22621 (0.4.0 installée, RTX 4060 Laptop) :
une fenêtre de console noire apparaît et se referme aussitôt, en boucle, tant qu'IAction
tourne. Le rapport ne s'est pas arrêté au symptôme — il apporte la preuve, et elle est nette.
Traçage des créations de process sur 20 secondes :

```
=== Parents de nvidia-smi capturés (20 s) ===
   5x  iaction.exe | C:\Users\utilisateur\AppData\Local\IAction\iaction.exe
```

Cinq `nvidia-smi.exe` en vingt secondes, tous enfants d'`iaction.exe`, et autant de
`conhost.exe` créés dans la foulée. C'est ce conhost qui est la fenêtre visible.

La cause : `nvidia-smi.exe` est un programme **console**. Lancé depuis une application
graphique, Windows lui alloue d'office une console — la même mécanique que celle déjà
rencontrée pour `node.exe` au premier lancement Windows de la 0.1.1, où la fenêtre du sidecar
restait affichée toute la session. Le drapeau `CREATE_NO_WINDOW` la supprime, et rien d'autre :
la sortie de `nvidia-smi` reste capturée par `output()`, la sonde continue de mesurer.

Le correctif ne se contente pas de poser le drapeau à l'endroit qui manquait, il **supprime la
raison pour laquelle il pouvait manquer** : le masquage était écrit en dur au milieu de
`commande_sidecar`, invisible depuis `system_probe.rs`. Il devient `hide_console_window()` dans
`open_external.rs`, aux côtés de `prepare_detached()` — le module où vit déjà l'hygiène de
spawn partagée. Le prochain process console lancé par la coquille trouvera la fonction plutôt
que d'avoir à redécouvrir la constante.

Deuxième défaut, révélé par le même rapport : sur une machine **sans** carte NVIDIA — la
majorité des postes — la sonde tentait quand même de lancer un binaire absent toutes les cinq
secondes, pour le même verdict à chaque fois. Un pilote n'apparaît pas en cours de session :
l'échec de spawn en `NotFound` verrouille désormais la sonde pour de bon. Le verrou ne se pose
**que** sur `NotFound` : un `nvidia-smi` présent mais en échec (pilote qui se recharge, carte
occupée) reste réinterrogé, la sonde doit se rétablir toute seule.

Le rapport suggérait aussi d'espacer le sondage (5 s → 15-30 s) et de rendre la surveillance
GPU désactivable. Les deux sont écartés ici, et c'est un choix, pas un oubli : la fenêtre
supprimée, il ne reste qu'un process court toutes les cinq secondes, ce qui est le prix normal
d'une jauge vivante ; et un réglage pour éteindre une sonde devenue silencieuse n'aurait plus
de client. Si le coût CPU se mesure un jour, il fera son propre ticket, avec son chiffre.

Rien dans `logs/app.jsonl` ne mentionnait `nvidia` : la sonde GPU vit entièrement côté Rust et
ne journalise pas. Le diagnostic a dû passer par le traçage de process — c'est une limite
d'observabilité constatée, pas corrigée ici.

### T-055 — Le crédit OpenRouter réclamé en boucle alors qu'aucune clé n'est configurée

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-26 · **Clos** 2026-08-26

Relevé en annexe du rapport de [T-054](#t-054--une-console-noire-clignote-toutes-les-5-secondes-sous-windows) :
`logs/app.jsonl` porte, toutes les quinze secondes, une ligne

```
error … "clé API manquante pour openrouter"   (method: usage.credits)
```

Le poste n'a pas de compte OpenRouter. Ce n'est donc pas une panne — c'est une configuration
parfaitement volontaire, et l'application la journalisait en `error`, indéfiniment. Même
maladie que [T-007](#t-007--ollamaps-répondait-une-page-web--une-sonde-dont-léchec-est-nominal-criait-error-140-fois),
qui avait déjà noyé le journal sous 140 lignes attendues : un journal qui crie à chaque
réponse normale n'est plus lisible, et c'est la VRAIE panne qui s'y perd.

Deux causes, deux correctifs :

1. **On demandait ce qu'on savait déjà.** `pushProviders` connaît, fournisseur par fournisseur,
   si une clé est enregistrée — il rend ce booléen depuis toujours, mais seule la page
   Configuration le lisait. Il voyage maintenant avec `notifyProvidersPushed()` sur le bus des
   fournisseurs (`cleConfigureePour()`), et l'encart de conso s'abstient d'interroger un
   fournisseur dont il sait qu'il refusera. **Le statut seul, jamais la valeur** : la clé ne
   quitte pas le trousseau. Rien ne change à l'écran — l'encart affichait déjà « OR : — », avec
   l'infobulle qui dit « aucune clé configurée, ou erreur réseau » — et la sonde repart d'elle
   même à la seconde où une clé est saisie, l'abonnement `providers.set` étant déjà branché.
2. **L'échec restant est une réponse.** Hors ligne, endpoint indisponible : `usage.credits` est
   une SONDE au sens de T-007, appelée en boucle, dont le refus renseigne. Elle passe en
   `sonde: true` et sa ligne descend en `debug`. Rien n'est tu — la ligne existe toujours.

La boucle de relance de 15 s, elle, n'est pas touchée : elle sert au relevé d'abonnement Claude,
qui a de bonnes raisons de retenter.

---

### T-052 — Les tours Claude tournent sans instruction système, et personne ne l'a décidé

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Trouvé le 2026-08-15 en instruisant [T-019](#t-019--les-questions-interactives-ne-sont-plus-sollicitées),
dans le SDK réellement installé (`@anthropic-ai/claude-agent-sdk` 0.3.214, `sdk.mjs`) :

```js
if (i === undefined) f = "";            // systemPrompt absent  → prompt système VIDE
else if (typeof i === "string") f = i;  // chaîne              → REMPLACE le preset
else if (i.type === "preset") { … }     // preset              → prompt Claude Code + append
```

Deux conséquences, aucune décidée :

1. **Un tour sans agent sélectionné part avec un prompt système vide.** Pas le prompt de
   Claude Code, pas un prompt réduit : rien. C'est le cas de la majorité des tours du Chat et
   des tours de projet sans agent.
2. **Un agent avec instructions REMPLACE** le prompt de Claude Code au lieu de s'y ajouter.
   Ce qui est peut-être voulu — mais nulle part écrit.

Le SDK **agent** diffère ici du SDK Claude Code historique, où le preset était le défaut. Le
passage de l'un à l'autre a donc changé le comportement en silence, et rien dans le dépôt n'en
parle.

Pourquoi P2 et pas P1 : l'application marche, les outils sont déclarés par l'API quoi qu'il
arrive, et beaucoup de tours n'ont besoin de rien de plus. Mais « le modèle reçoit-il des
instructions ? » ne devrait pas être une question à laquelle on répond en lisant le bundle
minifié d'une dépendance.

À faire — et c'est un ARBITRAGE, pas un correctif évident :

- mesurer d'abord : un tour identique avec et sans `{type:"preset", preset:"claude_code"}`,
  sur une tâche outillée, pour voir ce que le preset change réellement ici ;
- puis décider explicitement, et l'écrire dans `docs/protocol.md` : preset + `append` (le
  modèle hérite des conventions de Claude Code), ou prompt propre à IAction (on assume de
  tout dire soi-même). Le pire état est celui d'aujourd'hui : ni l'un ni l'autre, par défaut
  d'une dépendance.
- garder à l'esprit T-019 : l'annonce de l'outil de question devra suivre le choix retenu.

**Tranché et livré le 2026-08-15**, sur décision de l'utilisateur.

| Tour | Ce qui part maintenant |
|---|---|
| **Projet** (outils intégrés armés) | `{type: "preset", preset: "claude_code", append}` |
| **Chat pur** (`tools: []`) | inchangé — la chaîne de l'appelant, ou rien |

Le raisonnement tient en une phrase : les outils intégrés de Claude Code
(Read/Write/Edit/Bash/Grep) ont été conçus pour être pilotés par ce prompt-là. Les servir sans
lui était l'anomalie, pas l'inverse. Le chat pur, lui, n'a aucun outil : lui imposer un prompt
de copilote de code serait le défaut symétrique.

Second effet, aussi important que le premier : **l'instruction d'un agent s'AJOUTE désormais au
preset au lieu de l'effacer**. Un agent « relecteur méticuleux » conservait jusqu'ici les outils
de Claude Code… en ayant supprimé les instructions qui les décrivent.

**Ce choix est raisonné, pas mesuré, et il faut le dire.** Le ticket réclamait une mesure
préalable ; elle suppose des tours réels sur des tâches outillées, donc de la dépense
d'abonnement, et l'arbitrage a été rendu sans elle. Deux garde-fous en tiennent lieu : le retour
arrière tient en un booléen (`composerInstructionSysteme`), et quatre cas de test verrouillent
les deux régimes — dont « le preset n'est jamais remplacé par l'instruction de l'agent ». Si le
preset se révélait nuisible sur des tours réels, ce sera un ticket de plus, avec sa trace — pas
une découverte dans le bundle minifié d'une dépendance.

### T-012 — 24 alertes Dependabot, dont cinq dépendances livrées

**Type** tech · **Prio** P1 · **Statut** fait · **Créé** 2026-08-09 · **Clos** 2026-08-15

**Fait le 2026-08-15, application FERMÉE** (la condition que le ticket posait : `npm install`
perturbe le vite en cours).

**Racine : 12 vulnérabilités → 5.** Les quatre paquets que le ticket avait identifiés comme
**réellement livrés** sont tous montés :

| Paquet | Avant → après |
|---|---|
| `ip-address` (SSRF) | 10.2.0 → 10.5.0 |
| `fast-uri` | 3.1.3 → 3.1.5 |
| `hono` | 4.12.30 → 4.13.2 |
| `@hono/node-server` | 1.19.14 → 1.19.17 |

S'y ajoutent `nanoid`, `postcss` et `tar`, qui ne partent pas dans le produit (outil de
construction, pile de voix) mais ne coûtaient rien à monter.

**`tools/mcp-imap` : 4 → 0.** Les quatre PR Dependabot ouvertes sur le dépôt public restent à
**fermer**, pas à fusionner : l'instantané remplace l'arbre entier, une PR fusionnée sur `main`
serait silencieusement annulée à la publication suivante (`docs/github.md` §4).

**Les 5 qui restent sont exactement la pile de voix locale** — `sharp`, `adm-zip`,
`onnxruntime-node`, `@huggingface/transformers`, `kokoro-js` — c'est-à-dire ce que le ticket
avait déjà classé « ne part pas » : ces modules sont EXCLUS du bundle
(`scripts/preparer-bundle.sh`), l'application les charge par `import()` dynamique et fonctionne
sans eux. Elles ne concernent que le poste de développement et l'utilisateur qui installe la
voix locale à la main. Aucune n'a de correctif amont disponible.

**La dépendance Rust `glib` (1 moyenne) n'est pas corrigeable de notre côté** : la 0.18.5 est
tirée transitivement par `gtk 0.18` ← `muda` ← `tauri 2.11.5`, et l'avis est réglé en 0.19,
qui suppose une montée de Tauri. `cargo update -p glib` ne trouve rien de compatible. Même
famille que les paquets transitifs sous le SDK Claude : la correction dépend de la montée de
l'amont, pas d'un forçage local — et forcer une résolution désalignerait la coquille de ce que
Tauri a testé.

Chaîne de vérification complète repassée au vert avec les nouvelles versions avant commit.


> **Correction du 2026-08-09** (`gh` installé, alertes lues par l'API au lieu
> d'être devinées) : la première rédaction de ce ticket concluait « une seule
> dépendance vulnérable part réellement dans le produit ». **C'était faux** —
> je n'avais dépouillé que les paquets cités par `npm audit` en tête de
> sortie. Le décompte exact figure ci-dessous ; la conclusion rassurante ne
> tenait qu'à un examen partiel. Leçon : ne pas conclure d'un échantillon
> quand l'inventaire complet est interrogeable.

**Décompte réel** (`gh api /repos/…/dependabot/alerts`, 24 ouvertes) :

| Manifeste | Alertes | Livré ? |
|---|---|---|
| `package-lock.json` (racine) | 5 hautes, 8 moyennes, 1 basse | partiellement |
| `src-tauri/Cargo.lock` | 1 moyenne (`glib`) | **oui** — la coquille Linux |
| `tools/mcp-imap/package-lock.json` | 2 hautes, 6 moyennes, 1 basse | non (outil hors app) |

**Ce qui part réellement chez l'utilisateur** — vérifié fichier par fichier
dans `build/sidecar-bundle/node_modules` :

- `ip-address` (1 haute + 2 moyennes, SSRF) — SDK Claude → SDK MCP → `express-rate-limit` ;
- `fast-uri` (2 hautes) — SDK Claude → SDK MCP → `ajv` ;
- `hono` (3 moyennes + 1 basse) et `@hono/node-server` (1 moyenne) — même chaîne ;
- `glib` (1 moyenne) — dépendance Rust de la coquille, donc du binaire lui-même.

**Ce qui ne part pas** : `sharp`, `tar`, `adm-zip` (pile de voix locale, EXCLUE
du bundle — `scripts/preparer-bundle.sh`), `postcss` (vite, construction
seule), et tout `tools/mcp-imap` (outil MCP de courriel, hors application).

La plupart des paquets livrés sont **transitifs sous le SDK Claude** : la
correction dépend de la montée du SDK, pas d'un `npm audit fix` local. À
qualifier au cas par cas, et à ne pas forcer par des `overrides` qui
désaligneraient le SDK de ce qu'il a testé.

Constaté le 2026-08-09 en publiant l'instantané : GitHub annonce « 23
vulnerabilities (7 high, 14 moderate, 2 low) » sur la branche par défaut.
Dépouillement local (`npm audit`, `npm ls`) — le chiffre brut est trompeur,
trois familles très inégales :

- **`sharp`, `tar` (7 hautes)** — tirées par `@huggingface/transformers` et
  `kokoro-js`, c'est-à-dire la pile de **voix locale**, explicitement EXCLUE
  du bundle livré (`EXCLUES` dans `scripts/preparer-bundle.sh`, voir
  `docs/empaquetage.md` §2). Vérifié : `build/sidecar-bundle/node_modules` ne
  les contient pas. Elles ne concernent que le poste de développement — et
  l'utilisateur qui installe la voix locale à la main.
- **`nanoid`, `postcss`** — dépendances de `vite`, donc outil de construction
  seulement, absentes du produit.
- **`ip-address` (3 avis SSRF, modérés)** — la SEULE présente dans le bundle
  livré. Chaîne : `@anthropic-ai/claude-agent-sdk` →
  `@modelcontextprotocol/sdk` → `express-rate-limit` → `ip-address@10.2.0`.
  Exploitabilité à qualifier : ce limiteur ne sert que si un serveur MCP HTTP
  écoute, ce qui n'est pas le mode nominal — mais la correction est triviale.

**Second manifeste, découvert dans la foulée** : `tools/mcp-imap` a son propre
`package-lock.json` (outil MCP de courriel, hors bundle de l'application).
Dependabot y avait déjà ouvert **quatre PR** — `ip-address` 10.4.0, `fast-uri`,
`hono`, `@hono/node-server` + SDK MCP. Elles sont à **fermer**, pas à
fusionner : l'instantané remplace l'arbre entier, donc une PR fusionnée sur
`main` serait silencieusement annulée à la publication suivante (voir
`docs/github.md` §4). Les mêmes montées se font ici.

À faire, **application fermée** (`npm install` perturbe le vite en cours) :
`npm audit fix` à la racine (monte `ip-address`, 10.4.0 satisfait le `^10.2.0`
demandé) **et** dans `tools/mcp-imap`, puis `npm run verif` et instantané. Les
autres attendent leurs amonts ; ne pas forcer de résolution sur une pile qu'on
ne livre pas.

Décision de fond consignée : les **PR automatiques de Dependabot restent
désactivées** (elles modifieraient le dépôt public, qui n'est pas la source de
vérité) — les alertes seules sont voulues, et ce ticket est la façon dont
elles entrent dans le backlog. Voir `docs/github.md` §4.

### T-045 — La traversée de proxy n'est ni configurable, ni documentée

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-15

**Corrigé le 2026-08-15 — les trois trous, dont un par l'aveu.**

**Trou 2, le plus bête et le plus coûteux : il n'y avait aucun endroit où saisir un proxy.**
Encart **Configuration → Réseau** : proxy, hôtes en direct, autorité de certification, et
lecture du magasin du système. La coquille les pose sur l'environnement du sidecar au moment
de le lancer (`src-tauri/src/reseau.rs`) — c'est là que ça doit se faire, `--use-env-proxy`
étant lu par Node au démarrage du process et non à chaque requête. « Enregistrer et relancer
le moteur » est donc le geste complet, et l'encart le dit plutôt que de laisser croire à un
effet immédiat.

**Trou 3 : le certificat d'inspection TLS.** `NODE_EXTRA_CA_CERTS` (fichier PEM) et
`--use-system-ca` sont posés depuis l'encart. Le poste qui tombera sur
`SELF_SIGNED_CERT_IN_CHAIN` a désormais où répondre.

**Trou 1, le PAC : non corrigé, et DIT.** Nous n'interprétons pas `AutoConfigURL`. Un poste
qui n'a que ça doit saisir son proxy à la main — c'est écrit dans l'encart et dans
`docs/empaquetage.md`. Prétendre le contraire aurait été pire que le trou lui-même : un
utilisateur qui croit le PAC lu ne cherchera pas pourquoi rien ne passe.

L'invariant tenu de bout en bout, et testé des deux côtés : **rien de saisi = rien de changé**.
Une clé `reseau` absente, vide, ou d'un mauvais type laisse l'environnement du moteur
identique à l'octet près (6 tests Rust, 10 tests d'interface, plus deux tests de coquille sur
la position des drapeaux — Node ne traite ses options qu'AVANT le nom du script, une option
placée après serait ignorée en silence, exactement le piège de T-043).

Effet de bord du cliquet, et il avait raison : les 240 lignes du tableau des raccourcis
clavier sortent de `ProvidersPage.tsx` (3 207 → 2 996 lignes) dans
[raccourcisClavier.ts](../ui/src/raccourcisClavier.ts). C'est de la documentation pure au
milieu d'un fichier qui fait tourner fournisseurs, modèles, voix et applications ; elle n'avait
aucune raison d'y vivre, et c'est le refus de l'encart « Réseau » qui a posé la question.


**Type** tech · **Prio** P2 · **Statut** ouvert · **Créé** 2026-08-13

[T-043](#t-043--tous-les-fournisseurs-en--erreur-réseau--sur-un-poste-dentreprise) a réparé le
cas courant — un proxy déclaré dans l'environnement — d'une ligne. Il laisse trois trous, et
les nommer vaut mieux que de croire le sujet clos :

1. **Le PAC est ignoré.** Le poste concerné déclare aussi un `AutoConfigURL` dans le registre. `--use-env-proxy` ne lit que les variables ; un poste qui
   n'aurait QUE le PAC resterait en panne, avec le même message pour l'utilisateur.
2. **Aucun réglage dans l'application.** Si les variables ne sont pas posées pour la session
   graphique — cas fréquent sous Windows, où elles vivent souvent dans le profil du terminal —
   l'utilisateur n'a aucun endroit où saisir son proxy. Il faut passer par `setx`, ce qu'aucune
   documentation ne dit.
3. **Le certificat d'inspection TLS n'est pas traité.** Ce poste-ci coupe avant le handshake,
   donc la question ne s'est pas posée. Le poste suivant, derrière un proxy MITM, tombera sur
   `SELF_SIGNED_CERT_IN_CHAIN` — Node n'utilise pas le magasin de certificats de Windows.
   Le remède existe (`--use-system-ca`, `NODE_EXTRA_CA_CERTS`), il n'est pas posé.

À faire : un encart « Réseau » dans la configuration (proxy explicite, autorité
supplémentaire), et une section dans `docs/empaquetage.md` sur l'usage en entreprise. Tant que
ce n'est pas fait, l'application est **utilisable au bureau par accident**, pas par
conception.

### T-023 — Isoler la plomberie spécifique à un fournisseur

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-15

**R8-A était déjà livré** (`catalogUrl`, `catalogShape`, `usageTrustworthy`, `bodyExtras`, le
profil traversant les couches, le préréglage Swiftask), et avait fermé T-021 et T-022.
**R8-B est livré le 2026-08-15**, avec la retenue que le ticket lui-même prescrivait.

**La devinette nommée dans le ticket a disparu du chemin nominal.** `usageStats.ts` déduisait
la gratuité d'un fournisseur par sous-chaîne de son identifiant — « la ligne la plus parlante »,
disait le ticket. C'est désormais un trait `billing: "free" | "paid"`, déclaré, et inscrit sur
l'événement d'usage **au moment du tour** : la facturation est un fait du fournisseur, et la
relire plus tard verrait une configuration qui a pu changer.

La devinette n'est pas SUPPRIMÉE, et c'est délibéré : sans trait, le comportement reste celui
d'avant à l'octet près (discipline R0). La retirer d'un coup ferait basculer en « payant » tout
fournisseur pas encore déclaré, et fausserait l'historique. Elle disparaîtra quand les profils
seront déclarés — pas avant, et le commentaire du code le dit à celui qui passera après.

**Une méthode du protocole perd son nom de marque.** `usage.openrouter` devient
**`usage.credits`**, et le chemin de la jauge devient le trait `creditsPath` (défaut `credits`).
`usage.openrouter` **reste accepté comme alias** : renommer une méthode ne doit pas casser une
interface qui tourne, et le test de protocole exerce volontairement les DEUX noms — le nouveau
sur le chemin nominal, l'ancien sur le cas d'erreur. L'ancien nom partira quand plus rien ne
l'appellera.

S'y ajoute `coutRemonte` (T-036) : « ce fournisseur ne remonte jamais de coût », déclaré au lieu
d'être compté comme une mesure manquante.

**Ce qui reste hors périmètre, et le ticket le disait déjà** : `nativeApi` (les trois méthodes
`ollama.*` gardent leur nom — le code marche et ne gêne personne tant qu'il n'y a qu'un cas ;
T-007 a montré au passage que la SONDE, elle, mérite d'être déclarée un jour) et la cible de
débord de `debord.ts`, qui relève de R3. Le compte des « quinze sites » n'est donc pas tombé à
zéro : il est tombé sur les deux familles que le ticket avait explicitement mises de côté.


Constat de structure, posé le 2026-08-10 en cherchant où brancher T-021.
L'hypothèse fondatrice du moteur neutre — « un fournisseur, c'est une `baseUrl`
compatible OpenAI et une clé » — a déjà cédé **quinze fois**, sans qu'aucun
endroit ne le déclare :

| Où | Spécificité codée en dur |
|---|---|
| [engine.ts](../sidecar/src/engine.ts) ~735-830 | `ollamaNativeBase()` + API native `/api/ps`, `/api/generate` |
| [engine.ts](../sidecar/src/engine.ts) ~651-680 | `GET /credits` — solde, propre à OpenRouter |
| [engine.ts](../sidecar/src/engine.ts) ~467-475 | corps R0 : `models`, `provider.sort`, `usage.include` |
| [usageStats.ts](../sidecar/src/usageStats.ts) ~51 | « ce fournisseur est-il gratuit ? » deviné par `id.includes("ollama")` |
| [debord.ts](../sidecar/src/debord.ts) ~34 | cible de débord `openrouter · deepseek-chat` |
| [router.ts](../sidecar/src/router.ts) ~90, ~103 | classificateur et embeddings sur `ollama` |
| [routerAdmin.ts](../ui/src/routerAdmin.ts) ~55-65 | les mêmes valeurs, redéclarées côté interface |
| [App.tsx](../ui/src/App.tsx) ~304 | `usageOpenrouter("openrouter")` — id littéral |
| [providerAdmin.ts](../ui/src/providerAdmin.ts) ~30-44 | en-têtes `HTTP-Referer` / `X-Title` d'OpenRouter |
| [ProvidersPage.tsx](../ui/src/ProvidersPage.tsx) ~85, ~1993-2014 | `OPENROUTER_PROVIDER_ID`, préréglages `openrouter`/`groq` |
| [protocol.md](protocol.md) | **4 méthodes portent un nom de fournisseur** : `usage.openrouter`, `ollama.ps`, `ollama.load`, `ollama.unload` |

La ligne la plus parlante est `usageStats.ts` : la gratuité d'un fournisseur y
est **devinée par sous-chaîne de son identifiant**. Un fournisseur local nommé
autrement est facturé à tort ; un fournisseur payant contenant « local » est
compté gratuit. C'est le symptôme, pas la cause : faute d'endroit où déclarer
un trait, chaque besoin s'est résolu par un `if` là où il tombait.

**Direction proposée — spec R8, « profils de fournisseur ».** La spécificité
devient une **donnée portée par le fournisseur**, pas une branche de code,
selon la discipline déjà écrite en R0 (*champ absent → comportement
d'aujourd'hui, à l'octet près*) :

```ts
interface ProviderTraits {
  catalogUrl?: string;              // T-021 — remplace GET {baseUrl}/models
  catalogShape?: "openai" | "slugs";// {data:[{id}]} vs [{slug,name}]
  creditsPath?: string;             // "credits" — absent : pas de jauge de solde
  nativeApi?: "ollama";             // ps / load / unload
  usageTrustworthy?: boolean;       // T-022 — false : les zéros valent null
  billing?: "free" | "paid";        // remplace la devinette sur l'id
  bodyExtras?: Record<string, unknown>; // ex. {stateless: true} chez Swiftask
  noReasoningEffort?: boolean;      // passerelle qui rejette le champ en 400
}
```

Les deux derniers champs sortent de l'observation du client officiel de
Swiftask le 2026-08-10 : il envoie `stateless: true` (champ non standard) et a
**désactivé `reasoning_effort` en commentaire** — « HTTP 400 reasoning_effort
is not allowed ». Deux quirks qu'aucun `if (providerId === …)` ne doit porter,
et la démonstration que la liste des traits ne se devine pas à l'avance : elle
doit être *ouverte*, d'où `bodyExtras` en dictionnaire libre plutôt qu'un
énième booléen nommé.

Le champ voyage comme les trois réglages R0 : config non-secrète →
`pushProviders` → `providers.set` → `Provider` du sidecar. **Le sidecar ne
porte donc aucune table de fournisseurs** — il lit ce qu'on lui pousse, et
reste ignorant des marques. La table des profils connus (Swiftask, OpenRouter,
Ollama, « OpenAI strict ») vit côté interface, à côté de `DEFAULT_PROVIDERS`,
comme simple **aide de saisie** du formulaire — même patron que les
préréglages STT/TTS déjà en place. Une seule déclaration a un consommateur à
l'exécution : pas de cinquième vérité à faire diverger (cf. 0.3.0).

Périmètre et coût estimés — à découper en deux, la première moitié seule
débloque Swiftask :

- **R8-A (¼ lot)** : `catalogUrl` + `catalogShape` + `usageTrustworthy`, le
  profil traversant les couches, préréglage Swiftask, tests de protocole.
  Ferme T-021 et T-022.
- **R8-B (¼ lot)** : `creditsPath` et `billing` — c'est-à-dire dé-nommer
  `usage.openrouter` et retirer la devinette d'`usageStats`. Touche le
  protocole, donc à faire seul et documenté.

Restent volontairement hors périmètre : `nativeApi` (le code Ollama existant
marche et ne gêne personne tant qu'il n'y a qu'un cas) et la cible de débord de
`debord.ts`, qui relève de R3.

### T-036 — Des tours payants ne remontent aucun coût

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-15

**Instruit le 2026-08-15 — les deux questions du ticket ont une réponse, et ce ne sont pas
les mêmes.**

**1. Swiftask est structurellement muet, et l'option `usageAccounting` n'y peut rien.** Le
`costUsd` de nos événements vient de `usage.cost` ; `usageAccounting` pose `usage.include`.
Ces deux champs sont des **extensions OpenRouter**, pas du dialecte OpenAI. Un fournisseur
qui ne les implémente pas ne les servira jamais, quelle que soit la case cochée. Cocher la
comptabilité d'usage sur Swiftask n'aurait donc rien changé — et c'était précisément la
question du ticket.

**2. La recherche web n'a rien à facturer, et son absence de `events.jsonl` est correcte.**
R9 interroge un **SearXNG auto-hébergé** en HTTP simple : aucun appel de modèle, aucune API
payante, donc aucun événement d'usage à écrire. Son coût réel existe, mais il est **indirect
et déjà compté** : les sources injectées gonflent le prompt du tour qui suit, et ce tour-là
porte sa propre consommation. Il n'y a donc pas de trou ici — il y avait une attente fausse.

**Corrigé** : le trait `coutRemonte: false` (déclaré sur le préréglage Swiftask) inscrit
`coutIndisponible: true` sur les événements concernés, au moment du tour — c'est un fait du
FOURNISSEUR, et le relire plus tard verrait une configuration qui a pu changer. La carte
« Dépense de la période » distingue désormais deux minorants qui n'appellent pas la même
chose :

- « N tours sans coût remonté » — le fournisseur pourrait, et ne l'a pas fait : **il y a une
  comptabilité d'usage à cocher** ;
- « N tours chez un fournisseur qui n'en remonte jamais » — **rien à chercher**.

Les confondre, c'était envoyer l'utilisateur chercher un réglage qui n'existe pas. Quatre cas
de test sur le libellé, dont celui où les deux coexistent.

Reste vrai, et assumé : la dépense Swiftask demeure inconnue. Aucun correctif de notre côté ne
la fera apparaître — seul le fournisseur le peut. Ce que le ticket demandait était de le DIRE
plutôt que de compter zéro ; c'est fait.


**Type** bug · **Prio** P3 · **Statut** ouvert · **Créé** 2026-08-13

Relevé en instruisant [T-035](#t-035--la-dépense-réelle-nétait-affichée-nulle-part), sur
`usage/events.jsonl` du poste, mois d'août 2026 :

| moteur / fournisseur | tours | `costUsd` cumulé |
|---|---|---|
| claude (abonnement)  | 546 | 0 (normal : coût nul) |
| neutral / openrouter |  16 | 2,4327 $ |
| neutral / ollama     |  11 | 0 (normal : local) |
| neutral / swiftask   |   7 | **0, alors que le fournisseur est payant** |

Les 7 tours Swiftask ne portent pas de `costUsd`. Depuis T-035 la carte « Dépense de la
période » le signale (« au moins — N tours payants sans coût remonté ») plutôt que de laisser
lire un total faux, mais le trou reste : on ne sait pas ce que ces tours ont coûté.

À instruire : le fournisseur ne renvoie-t-il pas d'usage, ou bien l'option `usageAccounting`
n'est-elle pas cochée sur son profil ? Même question pour la recherche web, dont les appels
n'apparaissent pas du tout dans `events.jsonl`. Si le fournisseur est structurellement muet, le
dire dans son profil vaut mieux que de compter zéro.

### T-053 — Le verrou du runner déclarait mort tout détenteur, hors de Linux

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Constaté le 2026-08-15 sur le portique de la 0.3.3 : la PR publique est rouge sur **Windows**,
verte sur Linux. `runner.test.js` échoue sur une seule assertion — « le processus courant doit
être vu vivant ».

La cause est dans le correctif de [T-050](#t-050--un-verrou-survivait-à-son-détenteur-et-gelait-toutes-les-synchros),
écrit le matin même : `detenteurVivant()` teste `/proc/<pid>`. **Il n'y a pas de `/proc` sous
Windows** — donc un détenteur bien vivant y est déclaré mort, et son verrou volé. Le choix de
`/proc` était pourtant motivé et reste bon sur Linux : lui seul distingue « mort » de « vivant
mais appartenant à un autre utilisateur » (EPERM), ce qui compte dans un conteneur où le
planificateur et les runs partagent l'espace de PID.

Ce que ce ticket corrige n'est donc pas le choix, c'est son **absence de repli**. Le runner ne
tourne que dans un conteneur Linux, et on aurait pu se contenter de garder le test par
plateforme — c'est-à-dire faire taire le messager. Une fonction qui répond faux hors de son
habitat est un piège en attente, pas une limite acceptable : `/proc` d'abord, `process.kill(pid, 0)`
en repli, EPERM traité comme vivant. La prudence d'origine est préservée de bout en bout — ce
qu'on ne sait pas trancher est réputé vivant.

Troisième fois que la CI Windows attrape ce que le poste Linux ne peut pas voir (T-014, T-037,
puis ici) — et la première où c'est le CODE, pas le test, qui décrivait la machine qui l'exécute.

### T-025 — Un échec du fournisseur arrive comme une réponse réussie

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-15

**Corrigé le 2026-08-15 par le correctif « non listé » du ticket lui-même** — celui que la
mesure du 2026-08-11 avait fait apparaître, et qui est le seul à viser la cause : quand R9 est
active, les agents `*-with-search` ne sont plus proposés. La recherche est alors faite deux
fois — une fois par nous, avec nos sources citées, une fois par l'agent — et c'est la seconde
qui casse (`gemini-pro-with-search` : 2 échecs sur 6 à requête identique, contre 0 sur 6 pour
le modèle brut).

Les trois autres pistes restent écartées, pour les raisons que le ticket avait déjà établies :
valider les modèles par un appel court ne rattrape pas un modèle qui répond 9 fois sur 10 ; la
consommation à zéro ne distingue pas le tour échoué du tour réussi ; et le discriminant
`total_tokens: 1` est un comportement non documenté qu'on refuse d'inscrire dans le code.

Deux règles de non-perte, testées, parce qu'un filtre qui escamote est un défaut de plus :

1. **Le modèle SÉLECTIONNÉ n'est jamais masqué** — sinon le sélecteur afficherait « — » sur
   une conversation qui tourne. Même règle que pour les variantes (T-032).
2. **L'écart se DIT** : le popover annonce combien d'agents sont masqués et pourquoi. Un
   modèle qui disparaît sans un mot est un mensonge par omission.

La reconnaissance se fait sur l'id (`…-with-search`), faute de mieux : aucun fournisseur
n'expose un trait disant « cet agent cherche ». C'est exactement la devinette que
[T-023](#t-023--isoler-la-plomberie-spécifique-à-un-fournisseur) doit supprimer — en attendant
elle est à UN seul endroit, nommée et testée, au lieu d'être un `if` au fil de l'eau. Quatre
cas de test, dont celui qui compte : le modèle courant survit au filtre.

Ce que ce ticket ne prétend toujours pas régler : `llama31`, muet (≈ 2 caractères de contenu),
qui n'est pas un agent de recherche et reste proposé. Il relève de la validation de catalogue,
donc de T-021/T-023, pas d'ici.


Constaté le 2026-08-10, premier tour Swiftask réel dans le Chat (modèle
`gemini-pro-with-search`). L'écran affiche, dans une bulle d'assistant
normale : *« Sorry, An error occurred. If the problem persists, please contact
us. »* — suivi de `0 + 0 tokens`. Aucun bandeau d'erreur, aucune entrée au
journal : pour l'application, **ce tour a réussi**.

Vu du protocole, en effet, rien ne le distingue d'une réponse légitime :

```
HTTP 200 · finish_reason: "stop" · contenu = le texte d'erreur
usage: {prompt_tokens: 0, completion_tokens: 0, total_tokens: 1}
```

Le fournisseur encode donc sa panne **dans le corps de la réponse**, pas dans
son statut. Deux modèles sur les huit proposés par le sélecteur sont dans ce
cas — `gemini-pro-with-search` (phrase d'erreur) et `llama31` (contenu
littéralement `""`, encore plus muet) —, les six autres répondent
correctement. Un quart du catalogue offert est mort, et l'app le présente
comme vivant.

**Ce qu'on ne peut pas faire** : détecter la phrase. Filtrer sur un texte
anglais dans une réponse d'assistant condamnerait des réponses légitimes ; ce
serait remplacer un faux positif par un faux négatif.

**Ce qu'on peut faire**, par ordre de solidité :

1. **Écarter les modèles morts du sélecteur** — c'est le vrai correctif, et il
   rejoint T-021 : tant que le catalogue vient d'une liste figée non vérifiée,
   il proposera des entrées non servies. Un « Rafraîchir les modèles » qui
   VALIDE (un appel court par modèle, en tâche de fond, résultat mémorisé)
   coûte peu et rend la liste honnête.
2. **Signaler la consommation nulle** — une réponse non vide facturée
   `0 + 0` est au minimum suspecte. Une fois T-022 en place (zéro → `null`),
   l'affichage dirait « consommation inconnue », ce qui est déjà moins
   trompeur que `0 + 0 tokens`.
3. Le discriminant observé (`total_tokens: 1` sur les tours en échec contre
   ~1200 sur les tours réussis) est **volontairement écarté** : c'est un
   comportement non documenté d'un fournisseur, exactement le genre de
   devinette que T-023 cherche à éliminer, pas à multiplier.

Ce ticket ne dit pas que l'app est fautive : le défaut est chez le
fournisseur. Il est ouvert parce qu'une panne invisible reste une panne
invisible, quelle que soit son origine — et parce que le choix du modèle,
lui, est bien de notre côté.

**Mesure du 2026-08-11 — le modèle n'est PAS mort, il est INTERMITTENT.**
Deux nouvelles occurrences constatées dans le Chat (mêmes conditions :
`swiftask · gemini-pro-with-search`, recherche web R9 activée), dont un
deuxième tour dans une conversation dont le premier avait parfaitement
répondu. Rejeu direct sur l'API, hors application :

| Envoi rejoué | Résultat |
|---|---|
| 10 requêtes **identiques**, message unique, `gemini-pro-with-search` | **1 échec / 10** |
| 10 requêtes identiques, `gemini-3-pro` (modèle brut) | 0 échec / 10 |
| 6 formes de conversation (avec/sans historique, avec/sans bloc web) | échec sur une forme, réussite au rejeu de la même |

L'échec ne dépend donc **ni de l'historique, ni du bloc système injecté par
R9, ni de la taille du corps** : à requête strictement identique, la même
question réussit ou échoue. C'est une panne aléatoire de l'agent Swiftask
`*-with-search` (~10 %), pas un slug non servi.

Balayage des **8 slugs effectivement proposés** par le sélecteur, 6 requêtes
identiques chacun, même jour :

| Slug | Réponses exploitables |
|---|---|
| `deepseek-r1`, `swiftask`, `agentreact`, `mistralmedium`, `deepseek-v3`, `o3-mini` | 6/6 |
| `gemini-pro-with-search` | **4/6** (2 fois la phrase d'erreur) |
| `llama31` | 6/6 en apparence, mais **~2 caractères** de contenu — muet |

Six des huit sont donc sains ; le catalogue offert n'est pas « mort au quart »,
il porte un modèle muet et un modèle instable.

Trois conséquences pour le plan ci-dessus :

- La piste 1 (**valider les modèles par un appel court**) ne rattrape pas ce
  cas : un modèle qui répond 9 fois sur 10 passera la validation, et
  échouera quand même un tour sur dix. Elle reste bonne pour `llama31`
  (mort franc), pas pour celui-ci.
- La piste 2 (**consommation inconnue**, T-022) devient le seul signal
  disponible côté app, et n'en est pas un : le tour échoué et le tour réussi
  annoncent tous deux `0 + 0`.
- Il reste donc un correctif non listé, et c'est le plus simple : **ne pas
  proposer les agents `*-with-search` quand R9 est activée**. La recherche
  est faite deux fois (une fois par nous, une fois par l'agent), et la
  seconde est celle qui casse — voir la spec R9, §Pourquoi une capacité
  locale. Un modèle brut (`gemini-3-pro`) rend le même service, avec nos
  sources citées et sans cet aléa.

### T-019 — Les questions interactives ne sont plus sollicitées

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-09 · **Clos** 2026-08-15

**Fait le 2026-08-15 — les deux étapes que le ticket réclamait, dans l'ordre qu'il fixait.**

**1. Le fait devient lisible.** La ligne « serveurs MCP du tour » nomme désormais les serveurs
avec leur compte d'outils (`studio:1, iaction:3, imap:12`) et surtout porte un champ
`questionInteractive` — vrai ou faux, explicitement. C'était la condition posée par le ticket :
« sans cela le ticket ne peut se fermer que par supposition ». Les 39 noms d'outils ne sont
PAS déversés dans le journal : ce serait illisible, et l'information utile n'y gagnerait rien.

**2. L'outil est annoncé par l'instruction système**, et seulement quand le serveur est
réellement armé (`interactive`) — annoncer dans un tour headless serait un mensonge, et le
modèle poserait une question que personne ne verrait. L'annonce est formulée comme une
capacité assortie d'un critère d'emploi, pas comme un ordre : « tu DOIS utiliser cet outil »
produirait des questions là où le modèle devait décider seul, c'est-à-dire le défaut inverse.
L'instruction de l'agent, quand il y en a une, n'est jamais écrasée — l'annonce s'y ajoute.

**Découverte au passage, plus lourde que le ticket** : en lisant le SDK installé (0.3.214,
`sdk.mjs`) pour savoir comment ajouter proprement au prompt système, on trouve
`if (i === undefined) f = ""` — **sans `systemPrompt`, le SDK agent n'envoie pas le prompt
système de Claude Code : il en envoie un VIDE.** Tous les tours sans agent tournaient donc
sans aucune instruction système. C'est peut-être une cause du défaut constaté ici, et ça
dépasse largement ce ticket : [T-052](#t-052--les-tours-claude-tournent-sans-instruction-système-et-personne-ne-la-décidé).
Le correctif ci-dessus se garde bien de « régler » ça au passage — passer au preset
`claude_code` changerait le comportement de tous les tours, ce que personne n'a décidé.

Ce qui n'est PAS démontré, et le sera au prochain tour interactif réel : que l'outil figure
effectivement dans la palette. Le ticket restait ouvert faute de pouvoir trancher ; il se
ferme parce que la question est désormais **posée au journal**, pas parce qu'on y a répondu.
Si `questionInteractive:false` apparaît, la cause est côté armement du serveur et un nouveau
ticket le dira — avec, cette fois, la ligne qui le prouve.


Constaté le 2026-08-09 à 12h58 : l'agent écrit lui-même « vu que les questions
interactives ne passent pas ici, questionnaire texte » et pose ses questions en
prose. Dernier appel RÉUSSI à `mcp__studio__ask_user` : **2026-08-07 12:48**.
Depuis, plus un seul appel dans `app.jsonl` — pas même en échec. L'outil n'est
donc pas cassé : il n'est plus SOLLICITÉ.

> **Correction de la première rédaction (même jour).** J'avais conclu que la
> cause était l'absence de migration du projet vers `.iaction/`, en me fiant au
> commentaire d'en-tête de `projectDoc.ts` (« uniquement si `.iaction/`
> existe »). **C'était faux** : `projectDir()` (`sidecar/src/appPaths.ts`
> 224-232) retombe sur `.iadadou/` quand `.iaction/` est absent, et la fiche
> est bien déposée. Elle datait du 2026-08-07 non par panne mais parce que le
> dépôt est adressé par CONTENU — réécrit seulement quand le texte change.
> Deuxième fois dans la même session que je conclus d'un examen partiel (voir
> T-012) : lire le code, pas le commentaire qui le décrit.

**Ce qui est établi** :

- l'outil INTÉGRÉ `AskUserQuestion` est délibérément interdit
  (`options.disallowedTools`, `sidecar/src/claude.ts` ~672) — or c'est le seul
  nom que le modèle connaît nativement ;
- son remplaçant `mcp__studio__ask_user` n'est armé que si le tour porte
  `interactive: true` ; la page Projets l'envoie sans condition
  (`ui/src/envoiProjet.ts:231`) ;
- `buildAskUserMcpServer` journalise un `warn` s'il échoue : aucun dans le
  journal, donc le serveur se construit ;
- l'outil n'est documenté au modèle que par la fiche `connaissances/iaction.md`
  — une SOURCE DE RAG, qu'il faut chercher pour lire, pas une instruction
  système qui part à chaque tour.

**Ce qui reste inconnu** : si `mcp__studio__ask_user` figure réellement dans la
palette annoncée au modèle. La ligne `serveurs MCP du tour` compte serveurs et
outils (`connectes:5, outils:39`) mais **ne les nomme pas** : impossible de
trancher a posteriori. C'est le premier correctif — journaliser les noms, ou au
moins la présence du serveur `studio`. Sans cela le ticket ne peut se fermer
que par supposition.

Ensuite, selon la réponse : faire connaître l'outil par l'INSTRUCTION SYSTÈME
du tour (qui part toujours) plutôt que par une fiche qu'il faut chercher —
plus robuste que le RAG pour une capacité aussi structurante.

### T-008 — `usage.openrouter` : « fournisseur inconnu » au démarrage

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-08 · **Clos** 2026-08-15

4 occurrences le 2026-08-08, toutes dans les secondes qui suivent un
lancement : l'encart d'usage interroge `usage.openrouter` AVANT que la
poussée des fournisseurs (providersBus) n'ait atteint le sidecar, qui répond
« fournisseur inconnu: openrouter ». Transitoire et auto-réparé, mais c'est
une erreur journalisée à chaque démarrage pour une simple course. Piste :
l'encart attend le signal « providers poussés » avant sa première requête —
ou le sidecar distingue « pas encore déclaré » (silencieux) d'« inconnu ».

**Corrigé le 2026-08-15** par la première des deux pistes — l'encart attend le signal, plutôt
que le sidecar n'invente une nuance entre « pas encore déclaré » et « inconnu ». La seconde
aurait mis dans le protocole une distinction que seul l'appelant peut faire : lui seul sait
s'il est en train de démarrer.

Le bus « fournisseurs poussés » existait déjà et servait exactement à ça — sa propre
documentation le disait, l'encart d'usage ne s'en servait pas. Mais un abonnement seul
n'aurait pas suffi, et c'est le vrai enseignement du ticket : **un signal n'apprend rien du
passé**. Qui se branche après la poussée n'en verra jamais l'écho, et attendrait un événement
déjà survenu. La correction ajoute donc une mémoire (`providersDejaPousses()`) à côté de
l'abonnement : on interroge l'état, puis on écoute la suite.

Cinq cas de test, dont celui qui aurait manqué : *un abonné tardif ne reçoit pas l'écho du
passé*. C'est la moitié du défaut, et c'est celle qu'un correctif hâtif aurait réintroduite
dans l'autre sens — une requête qui ne part jamais au lieu d'une requête qui part trop tôt.

Deux extractions au passage, imposées par le cliquet de taille sur `App.tsx` et bienvenues :
les ~240 lignes de navigation au clavier (F6, Alt + flèches) sortent dans
[focusZones.ts](../ui/src/focusZones.ts) — elles ne touchent ni à l'état, ni à React —, et la
table des six pages dans [navigation.ts](../ui/src/navigation.ts), pour que la navigation
connaisse les pages sans dépendre du composant racine. `App.tsx` passe de 1 262 à 1 022 lignes.

### T-007 — `ollama.ps` répond 404 avec une page web

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-08 · **Clos** 2026-08-15

24 occurrences dans le journal du seul 2026-08-08 : la requête `ollama.ps`
reçoit un **404 HTML d'une plateforme d'hébergement web** (page Vercel), pas
une réponse Ollama. L'hôte configuré pour ce fournisseur pointe donc vers un
site web, pas vers un serveur Ollama (URL de tunnel expirée ? mauvaise
adresse enregistrée ?) — à distinguer du cas connu « fetch failed »
(conteneur Docker arrêté). Deux choses à corriger :

- diagnostiquer/corriger l'adresse enregistrée du fournisseur concerné ;
- côté journal, TRONQUER le corps HTML et dire la cause probable
  (« la réponse n'est pas un serveur Ollama ») — aujourd'hui chaque
  occurrence colle une page HTML entière dans `app.jsonl`.


> **La prémisse de ce ticket était fausse, et c'est le plus intéressant.** « L'hôte configuré
> pointe vers un site web » supposait une adresse à corriger — tunnel expiré, mauvaise saisie.
> Vérification faite le 2026-08-15 : **aucune adresse enregistrée n'est fautive**
> (`ollama → http://localhost:11434/v1`, plus deux fournisseurs distants légitimes). Le 404
> vient d'ailleurs, et il ne s'est jamais arrêté — 140 occurrences du 2026-08-04 au
> 2026-08-15, la dernière le matin même de la clôture.

**La vraie mécanique** : `OllamaPanel` sonde `ollama.ps` sur le fournisseur **sélectionné,
quel qu'il soit**, toutes les dix secondes, et c'est délibéré — c'est ainsi que l'interface
décide de s'afficher ou non (« ceci est un Ollama » / « ceci n'en est pas un »). Interroger
`/api/ps` sur un fournisseur distant hébergé sur une plateforme web rend donc une page de 404,
et c'est le **fonctionnement nominal**. L'échec n'était pas dans l'adresse : il était dans le
fait de journaliser en `error` une réponse attendue.

Coût réel du défaut, mesuré : 140 lignes `error` en onze jours, deux kilo-octets de balises
chacune, dans le fichier même qu'on ouvre quand quelque chose cloche. C'est l'échec muet par
son autre bout — non pas le silence, mais un bruit assez régulier pour qu'on cesse de le lire.
Une vraie panne d'Ollama serait passée là-dedans sans se distinguer.

**Corrigé, en trois gestes :**

1. **La sonde est déclarée comme telle** (`sonde: true`, [sidecar.ts](../ui/src/sidecar.ts)) :
   son échec descend en `debug`. Rien n'est tu — la ligne existe toujours — mais elle cesse de
   crier au loup. Le signal visible reste le panneau qui ne s'affiche pas ; une vraie panne du
   fournisseur, elle, se dit au premier tour envoyé, avec son propre message.
2. **Une page web reçue au lieu d'une API est résumée, pas recopiée**
   ([base.ts](../sidecar/src/base.ts), `resumerCorpsHttp`) : titre de la page quand il existe —
   « 404: NOT_FOUND » nomme souvent l'hébergeur, donc la nature de la méprise — et taille, qui
   dit que quelque chose a bien répondu. Le reste part. Le correctif vaut pour **tous** les
   points d'appel qui lisent un corps d'erreur, pas seulement `ollama.ps` : un portail de proxy
   qui répond à la place d'une API tombe dans le même cas (voir T-045).
3. **L'erreur nomme le fournisseur.** Le journal montrait un 404 sans dire à quelle adresse ; il
   fallait deviner lequel des trois. C'est ce qui a rendu ce diagnostic-ci plus long qu'il
   n'aurait dû l'être.

Ce qui n'est PAS couvert par un test, et il vaut mieux l'écrire que le laisser croire : le
drapeau `sonde` lui-même. Le tester supposerait de simuler la couche Tauri, machinerie que les
tests d'interface n'ont pas et qui coûterait plus que le risque couvert. La logique de résumé,
elle, l'est (trois cas, dont le JSON qui contient du HTML sans être une page).

Reste hors de portée d'un correctif : que la sonde parle à des fournisseurs qui n'ont rien
d'Ollama est un symptôme de [T-023](#t-023--isoler-la-plomberie-spécifique-à-un-fournisseur) —
avec un trait `nativeApi` porté par le fournisseur, on ne sonderait que ceux qui l'annoncent.

### T-049 — Un HTML cité dans un rapport ne s'ouvre pas dans Firefox

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-08-14 · **Clos** 2026-08-15

Demande utilisateur du 2026-08-14 : qu'une référence de fichier HTML citée dans un rapport ou
une réponse — **local ou distant** — s'ouvre **dans Firefox** au clic.

Trois chemins de code aujourd'hui, trois comportements, aucun ne fait ça :

| Ce qui est cité | Ce qui se passe |
|---|---|
| `rapports/2026-08-14.html` en `code` inline | bouton → `handleFileRef` ([AgentPage.tsx](../ui/src/AgentPage.tsx) ~2079) → **onglet éditeur interne**, source HTML brute |
| `[rapport](https://…/x.html)` (lien Markdown) | `MarkdownLink` ([Markdown.tsx](../ui/src/Markdown.tsx) ~27) → `openExternal(href)` sans commande → **navigateur par défaut du système** (`xdg-open`), pas forcément Firefox |
| `https://…/x.html` en `code` inline | rien : `looksLikeFileRef` exclut explicitement `http(s)://` — texte inerte |

Le registre d'applications existe pourtant déjà (Configuration → Applications, clé `apps`,
`extension → commande`, `findAppForExtension` + `openExternal`, [appsAdmin.ts](../ui/src/appsAdmin.ts))
— mais **`handleFileRef` ne le consulte jamais** : seul [FileTree.tsx](../ui/src/FileTree.tsx)
s'en sert. C'est le manque principal, et il est plus large que le HTML : un fichier ouvert
depuis l'arbre respecte la règle de l'utilisateur, le MÊME fichier cliqué dans la transcription
l'ignore.

À faire, du plus petit au plus discutable :

1. **Router `handleFileRef` par le registre d'apps.** Une fois le chemin résolu (les trois
   branches actuelles : absolu sous `cwd`, `cwd/ref`, recherche par nom de base), interroger
   `findAppForExtension` ; règle trouvée ⇒ `openExternal(path, command)` au lieu de
   `handleOpenFile`. Règle le HTML local, et gratuitement tout ce que l'utilisateur a déclaré
   (pdf, odt, kicad…).
2. **Une règle `html`/`htm` → `firefox`** dans `DEFAULT_APPS`. Attention : les défauts ne sont
   semés qu'au **premier lancement** (clé `apps` absente) et il n'y a **pas de re-seed** — sur
   un poste déjà configuré, la règle est à ajouter à la main dans Configuration → Applications.
   Ne pas « réparer » ça en re-semant : respecter les suppressions de l'utilisateur est un
   invariant écrit.
3. **Le distant.** Le registre est indexé par extension : il ne sait rien d'une URL. Deux
   options — (a) un réglage « navigateur » explicite, utilisé à la fois par `MarkdownLink` et
   par le cas HTML local, repli `xdg-open` si vide ; (b) laisser `xdg-open` et régler le
   navigateur par défaut au niveau du système. (b) ne coûte rien mais ne tient pas la demande
   dès que le défaut du poste n'est pas Firefox — c'est précisément le cas visé ici.
4. *Optionnel, à décider séparément* : rendre cliquable une URL citée en `code` inline
   (assouplir `looksLikeFileRef`). C'est l'affordance, pas l'ouverture — et
   [T-024](#t-024--un-chemin-hors-projet-annonce--introuvable--alors-quil-existe) rappelle
   qu'un bouton incapable d'ouvrir quoi que ce soit ment à l'utilisateur.

Point d'attention à assumer, pas à découvrir : router le `.html` vers le navigateur retire la
possibilité d'ouvrir la SOURCE dans l'éditeur interne **depuis la transcription**. L'arbre de
fichiers garde l'ouverture en éditeur, donc rien n'est perdu — mais c'est un arbitrage, et il
se dit.

**Réalisé le 2026-08-15** — les points 1, 2 et 4 ; le 3 (« le distant ») autrement que prévu.

1. **`handleFileRef` passe par le registre** ([refFichier.ts](../ui/src/refFichier.ts),
   `ouvrirReference`) : règle trouvée ⇒ `openExternal(chemin, commande)`, sinon éditeur interne
   comme avant. Le manque principal est donc comblé, et il l'est pour tout ce que l'utilisateur
   a déclaré — pdf, odt, kicad — pas seulement pour le HTML.
2. **Règle `html`/`htm`/`xhtml` → `firefox`** dans `DEFAULT_APPS`. Le ticket avertissait :
   pas de re-seed, donc **sur ce poste-ci la règle est à ajouter à la main** dans
   Configuration → Applications. Ne pas « réparer » ça en re-semant : respecter les
   suppressions de l'utilisateur reste un invariant.
3. **Le distant** — ni réglage « navigateur » séparé, ni abandon à `xdg-open` : `MarkdownLink`
   interroge le MÊME registre, par l'extension portée par l'URL. Un `https://…/rapport.html`
   part donc dans Firefox, et une URL sans extension retombe sur l'ouvreur du système,
   c'est-à-dire le comportement d'avant. L'option (a) créait une seconde déclaration du même
   choix, à faire diverger un jour (0.3.0, T-047) ; celle-ci n'en crée aucune. Piège écarté au
   passage : le nom est pris sur le dernier segment du CHEMIN, sinon `https://exemple.com`
   livrerait l'extension « com » et déclencherait une règle qui ne le vise pas.
4. **URL en `code` inline** : rendues cliquables, puisqu'elles s'ouvrent maintenant.

Le point d'attention annoncé est bien réel et assumé : un `.html` cliqué dans la transcription
ne s'ouvre plus en SOURCE dans l'éditeur interne. L'arbre de fichiers, lui, garde l'ouverture en
éditeur — rien n'est perdu, mais l'arbitrage se dit.

### T-024 — Un chemin hors projet annonce « introuvable » alors qu'il existe

**Type** bug · **Prio** P3 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-15

Constaté le 2026-08-10 : un tour a rempli un PDF déposé dans `~/Téléchargements` et l'a cité
dans sa réponse. Le chemin, rendu en `code` inline, devient un bouton cliquable
([Markdown.tsx](../ui/src/Markdown.tsx) `looksLikeFileRef`) — mais `handleFileRef`
([AgentPage.tsx](../ui/src/AgentPage.tsx)) n'ouvre que ce qui est sous `cwd` : une référence
commençant par `~` n'est ni absolue (pas de `/` initial) ni résoluble depuis la racine, donc
elle tombe dans la recherche par nom de base et se solde par
« « ~/Téléchargements/… » introuvable dans le projet. »

Deux défauts distincts, aucun bloquant :

1. **Message trompeur** — le fichier existe, il est simplement hors projet. Un `~/…` mérite la
   même notice que le cas absolu (« Fichier hors du projet : … »), pas un « introuvable » qui
   laisse croire à une erreur de l'agent. Détecter le préfixe `~/` avant la branche
   « contient un `/` » suffit.
2. **Lien promis pour rien** — tout `code` inline ressemblant à un chemin devient un bouton,
   y compris quand rien ne pourra s'ouvrir. Piste : n'habiller en bouton que ce qui est
   plausiblement dans le projet (rejeter `~/` et les absolus hors `cwd` côté rendu), pour que
   l'affordance ne mente pas.

Le versant agent est traité : le guide d'intégration déposé dans chaque projet
([projectDoc.ts](../sidecar/src/projectDoc.ts), § « Fichiers produits ou modifiés ») impose
désormais d'écrire le livrable dans le projet, de copier avant d'éditer une source externe, et
de ne jamais citer un chemin hors projet en `code` inline. Ce ticket ne couvre que le versant
app : ne pas mentir sur ce qui est cliquable.

**Corrigé le 2026-08-15**, avec T-049 — les deux ticket décrivaient la même absence de
décision partagée, et les corriger séparément aurait été les recorriger deux fois.

Toute la décision vit désormais dans [refFichier.ts](../ui/src/refFichier.ts) : le rendu et
l'ouverture posent la MÊME question et lisent la même réponse. C'était le fond du défaut — une
heuristique d'affichage au fond de `Markdown.tsx` et cinquante lignes de branches au milieu
d'`AgentPage.tsx`, qui ne se consultaient jamais.

1. **Message trompeur** — `~/…` est classé « hors projet », comme un absolu qui sort de la
   racine, et l'avis le NOMME au lieu de prétendre l'avoir cherché. Le dossier personnel n'est
   volontairement pas développé : l'interface ne le connaît pas, et l'inventer serait une
   devinette de plus.
2. **Lien promis pour rien** — le rendu reçoit maintenant le `cwd`, donc un absolu hors projet
   et un `~/…` restent du `code` inerte. Ils ne mentent plus, faute de promettre.

L'invariant est tenu par un test qui ne dépend d'aucun cas particulier : *tout ce qui est
cliquable se classe en quelque chose d'ouvrable*. Sept autres tests couvrent le parcours
complet, monde extérieur simulé (registre, disque, recherche), là où la logique n'était jusque-là
pas testable du tout — elle vivait dans un composant de 2 900 lignes.

Effet de bord bienvenu : `AgentPage.tsx` passe de 2 926 à 2 895 lignes, sous son budget de
cliquet.

### T-041 — L'empaquetage local ressuscite les fichiers supprimés

**Type** tech · **Prio** P3 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-15

Constaté en corrigeant [T-038](#t-038--lappimage-ne-se-construit-plus-et-léchec-est-muet) :
Tauri met les ressources en scène dans `src-tauri/target/release/sidecar/` (puis
`bundle/appimage_deb/…`) et **n'y supprime jamais ce qui a disparu de la source**. Le CLI
Claude non compressé, retiré du bundle par le correctif, y dormait encore et se recopiait dans
l'AppDir à chaque construction — faisant échouer un build que le correctif venait pourtant de
réparer.

Coût réel : trois constructions lues comme trois échecs différents alors que c'était le même
fichier périmé. La CI n'est pas concernée (machine vierge à chaque run) ; c'est un piège de
poste de développement, du même genre que T-020 — **du code qu'on croit exécuter et qui n'est
pas celui qu'on a écrit**, ici transposé aux ressources.

**Corrigé le 2026-08-15** : `preparer-bundle.sh` purge les deux dossiers de mise en scène
avant tout assemblage, en respectant `CARGO_TARGET_DIR`. Le ticket offrait l'alternative
« documenter la purge » — elle est écartée pour la raison qu'il énonçait lui-même : une
consigne qu'il faut se rappeler n'est pas un garde-fou. `docs/empaquetage.md` la mentionne
quand même, mais comme description de ce que fait le script, pas comme geste à faire.

Le test ([preparer-bundle.test.mjs](../scripts/preparer-bundle.test.mjs), branché dans
`npm run verif` et dans la CI) est **textuel**, et c'est un choix assumé : exercer le script
pour de vrai coûterait une construction complète de l'interface et le téléchargement d'un
runtime Node. Il verrouille ce qui casserait en silence — la purge existe, elle vise les deux
dossiers, et surtout elle s'exécute AVANT l'assemblage. Purger après aurait effacé le travail
du script, et aucun test de présence seule ne l'aurait vu. Même patron que le test de position
du drapeau proxy (T-043).

### T-051 — La suite de tests travaillait dans le vrai dossier de données

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-15 · **Clos** 2026-08-15

Constaté le 2026-08-15 en passant `npm run verif` avant de livrer la 0.3.3 : `logs.test.js`
échoue — 8 entrées lues là où le test en attend 7. La huitième est « données rapatriées depuis
l'ancien nommage », émise par le sidecar **au démarrage**, que le test ne compte pas.

Le test n'est pas le défaut, il est le témoin. Le harnais impose un `XDG_CONFIG_HOME` jetable
(`harness.mjs`) mais **pas** `XDG_DATA_HOME`. Non défini — le cas normal d'un terminal Linux —
`dataBase()` retombe sur `~/.local/share` ([appPaths.ts](../sidecar/src/appPaths.ts) 109-117),
le vrai. Or `migrerDepuisAncienNom()` tourne à chaque démarrage et **déplace** ce qui reste
sous `net.duvam.ia-studio` vers `net.duvam.iaction`. Autrement dit : lancer la suite de tests
pouvait remuer les données réelles de la machine. Le test rouge est la conséquence bénigne
d'une porte ouverte qui ne l'était pas.

Ce qui a caché le défaut est aussi instructif que le défaut : le terminal de VSCode installé
par **Snap** définit `XDG_DATA_HOME` vers son bac à sable. La suite était donc isolée *par
accident d'environnement*, et verte, sur le poste où on la lance le plus souvent. Vérifié dans
les deux sens avant correction — `node test/logs.test.js` sort en 0 avec la variable, en 1 sans
elle. Même famille que T-014 et T-037 : un test qui décrit la machine qui le lance, pas le
produit.

**Corrigé** dans [harness.mjs](../sidecar/test/harness.mjs) : un `XDG_DATA_HOME` jetable est
imposé au même endroit et pour la même raison que le `XDG_CONFIG_HOME` — avant qu'un seul test
ne démarre un sidecar, donc hérité par tous les spawns. `logs.test.js` passe désormais avec et
sans la variable dans l'environnement.

Dégât constaté sur ce poste : **aucun**. Les six entrées de l'ancien dossier existent des deux
côtés, et la migration ne s'autorise jamais d'écrasement — elle les a comptées en « conflits »
et n'a rien déplacé (horodatages de `~/.local/share/net.duvam.ia-studio` inchangés depuis le
7 août). C'est une chance, pas une garantie : sur un poste où l'ancien dossier contient une
entrée absente du nouveau, un simple `npm test` l'aurait déménagée.

### T-050 — Un verrou survivait à son détenteur et gelait toutes les synchros

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13 à 23 h, sept minutes après l'installation de deux tâches de veille et
trois heures avant qu'elles ne doivent tourner pour la première fois.

Séquence exacte, lue dans les journaux du conteneur :

```
21:01:38  une synchro périodique prend le verrou (pid 20522)
21:01:46  manifestes modifiés : régénération du crontab et relance
21:03:51  synchro périodique reportée — verrou occupé, pid 20522
21:05:51  synchro périodique reportée — verrou occupé, pid 20522
21:07:52  synchro périodique reportée — verrou occupé, pid 20522
```

Le processus 20522 était mort (`/proc/20522` absent) mais son verrou subsistait. Toutes les
synchros suivantes étaient sautées, et les deux veilles planifiées à 02 h 30 et 03 h 15
auraient été « reportées » sans jamais s'exécuter — un échec silencieux à retardement, dont
rien n'aurait signalé la cause au matin.

Cause : `entrypoint.sh` se relance **lui-même** (`exec supercronic`) dès qu'un manifeste
change, ce qui tue les processus en cours. Le commentaire de `prendreVerrou` tablait sur
l'inverse — « le verrou vit dans un dossier VOLATILE (/tmp) : au redémarrage du conteneur il
disparaît de lui-même, puisqu'un éventuel détenteur est mort avec lui ». C'est vrai d'un
redémarrage du **conteneur**, faux d'une relance **interne**, qui est le cas courant : chaque
édition de manifeste depuis le poste la déclenche.

Correction (`docker/ia-runner/bin/run-tache.mjs`) : sur `EEXIST`, la fiche `detenteur.json`
est lue et l'existence de `/proc/<pid>` vérifiée. Détenteur mort → le verrou est repris, avec
une ligne de journal en niveau erreur. Prudence délibérée dans l'autre sens : fiche absente,
illisible ou sans pid numérique ⇒ détenteur **réputé vivant**, car mieux vaut une synchro
reportée qu'un verrou volé à un run qui travaille.

Test ajouté (`sidecar/test/runner.test.js`, section 5) : les cinq cas — processus courant,
pid inexistant, fiche absente, pid non numérique, JSON invalide. Le verrou n'était couvert par
aucun test jusque-là, alors qu'il est le garant de l'exécution séquentielle.

### T-040 — L'image du runner serveur ne se construisait plus, et rien ne pouvait le dire

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13, au premier déploiement réel de `ia-runner` sur le VPS (tranche D1 de
[etude-remote.md](etude-remote.md)) : `docker compose build` échoue à l'étape de compilation du
sidecar.

```
Error: Cannot find module '/app/sidecar/scripts/empreinte.mjs'
npm error command sh -c tsc && node scripts/empreinte.mjs dist
```

Cause : le script `build` du sidecar ne se résume plus à `tsc` — il enchaîne sur
`node scripts/empreinte.mjs dist` depuis le commit a0d50ec (T-032). Le Dockerfile, lui, ne
copiait dans l'étape de build que `sidecar/tsconfig.json` et `sidecar/src` : le dossier
`sidecar/scripts/` n'arrivait jamais dans le contexte.

L'image n'avait plus été construite depuis a0d50ec — elle l'avait été une seule fois, le
2026-08-05, à la livraison de D1, puis supprimée localement. Elle était donc **cassée depuis
plusieurs jours sans que rien ne l'indique**.

Correction : `COPY sidecar/scripts sidecar/scripts` dans l'étape `build`, avec un commentaire
qui dit pourquoi — toute nouvelle étape du script de build sidecar doit vérifier que ses
fichiers arrivent dans l'image.

**Ce que ce ticket a en commun avec [T-039](#t-039--deux-fichiers-que-linux-distingue-et-que-windows-confond)
et [T-038](#t-038--lappimage-ne-se-construit-plus-et-léchec-est-muet)** : un artefact de build
que la CI ne construit pas pourrit en silence. Trois occurrences en une semaine, sur trois
artefacts différents (AppImage, installeur Windows, image Docker). Le motif n'est plus une
coïncidence — il désigne un trou de couverture, pas trois bugs indépendants.

**Piste (à instruire, hors périmètre de ce ticket)** : faire construire l'image `ia-runner` par
la CI, au moins sur les PR qui touchent `docker/`, `sidecar/` ou les manifestes npm. Un build
Docker sans push coûte quelques minutes et aurait attrapé les trois.

---

### T-047 — Deux tables de routage, aucune garantie qu'elles disent la même chose

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Trouvé en retirant `claude-opus-4-8` du sélecteur ([T-046](#t-046--un-modèle-manquant-parce-que-la-liste-vivait-en-trois-exemplaires)) :
le palier `moyen` pointait dessus, et il fallait le corriger **dans deux fichiers** —
[router.ts](../sidecar/src/router.ts), qui route réellement, et
[routerAdmin.ts](../ui/src/routerAdmin.ts), qui affiche les défauts et préremplit les réglages.
Le commentaire de l'UI disait déjà « identique aux défauts codés en dur du sidecar » : un vœu,
que rien ne vérifiait.

Ce que coûterait l'oubli d'une des deux : l'écran des réglages annonce un modèle, le routeur
en appelle un autre, et **rien ne le signale**. Même famille que T-016, où le sidecar
annonçait une version fausse — la panne n'est pas le mauvais modèle, c'est l'écart muet entre
ce qu'on montre et ce qu'on fait.

**Corrigé** par [routage-defauts.mjs](../scripts/routage-defauts.mjs), sur le modèle du garde
de version (« cinq déclarations, une vérité ») : il extrait `DEFAULT_ROUTING_TABLE` des deux
fichiers et refuse le moindre écart, palier par palier, en nommant qui route et qui affiche.
La lecture est textuelle et non par import — le module du sidecar tire un moteur entier
derrière lui, et une comparaison de source ne peut pas exécuter de code au passage. Branché
dans `npm run verif` et dans la CI ; 9 cas de test, dont la divergence exercée sur un faux
dépôt et le dépôt réel vérifié.

### T-046 — Un modèle manquant, parce que la liste vivait en trois exemplaires

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constat utilisateur du 2026-08-13, capture à l'appui : « toujours pas d'opus 5 ». Le sélecteur
de modèle propose `claude-fable-5`, `claude-sonnet-5`, `claude-opus-4-8` et `claude-haiku-4-5`
— **`claude-opus-5` n'y est pas**, alors que le modèle est disponible et que c'est l'Opus
courant.

L'abonnement Claude n'expose aucun catalogue interrogeable : contrairement aux fournisseurs
neutres, le CLI ne rend pas la liste des modèles auxquels l'abonnement donne droit. La liste
est donc tenue à la main — ce qui est assumé. Ce qui ne l'était pas : elle était **recopiée
dans trois fichiers**, [agentSidebarDroit.tsx](../ui/src/agentSidebarDroit.tsx) (sélecteur des
projets), [ChatPage.tsx](../ui/src/ChatPage.tsx) (sélecteur du Chat) et
[contextBus.ts](../ui/src/contextBus.ts) (table des fenêtres de contexte). Trois endroits à
mettre à jour, aucun rappel : le modèle est sorti, personne n'a fait le tour.

**Corrigé** par une liste unique,
[modelesAbonnementClaude.ts](../ui/src/modelesAbonnementClaude.ts), dont les trois
consommateurs dérivent — et `claude-opus-5` y est ajouté, avec une note par modèle affichée en
infobulle du sélecteur. Cinq cas de test
([modelesAbonnementClaude.test.ts](../ui/src/modelesAbonnementClaude.test.ts)) ; celui qui
compte n'est pas « l'id est présent » mais **« chaque modèle de la liste a une fenêtre de
contexte connue »**, car c'est la propriété qui traverse deux fichiers et que rien ne
vérifiait. Un id à suffixe de date est refusé au passage : les identifiants de l'API sont
complets tels quels, y accoler une date donne un 404 au premier tour.

Suite décidée dans la foulée : `claude-opus-4-8` est **retiré** du sélecteur — même tarif
qu'Opus 5 pour une génération de moins — et le palier `moyen` de la table de routage
automatique passe donc à `claude-opus-5`, dans les deux fichiers qui la déclarent (c'est ce
retrait qui a fait surgir [T-047](#t-047--deux-tables-de-routage-aucune-garantie-quelles-disent-la-même-chose)).
Le palier `complexe` reste sur `claude-fable-5` : choix de coût, pas un oubli. Un fil déjà
épinglé sur 4.8 continue de tourner et affiche son id — il ne peut simplement plus être
resélectionné.

### T-034 — Le cliquet de taille est rouge sur `master`

**Type** tech · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13 en lançant `npm run verif` avant de livrer T-033 :
`node scripts/cliquet-taille.mjs` sort en **échec** sur `master` propre —
[src-tauri/src/sidecar.rs](../src-tauri/src/sidecar.rs), 807 lignes, plafond 800. Le
dépassement n'a rien à voir avec le ticket en cours (aucun `.rs` touché) : il est déjà là,
poussé tel quel.

Ce n'est pas la taille du fichier qui est le vrai défaut, c'est qu'un garde-fou rouge en
permanence **cesse d'être un garde-fou** : la commande de vérification échoue toujours, on
prend l'habitude de lire au-delà, et le jour où le cliquet signale une vraie dérive personne
ne le distingue du bruit. Même mécanique que l'échec muet, à l'envers.

À faire : découper `sidecar.rs` (la réponse attendue par le cliquet), ou consigner une
dérogation explicite et datée dans `scripts/cliquet-taille.json` si la taille se justifie.
Puis vérifier que `npm run verif` repasse au vert de bout en bout — c'est le seul état
acceptable pour la commande qui garde la porte.

**Dérogation posée le 2026-08-13** — `"src-tauri/src/sidecar.rs": 807` dans
`scripts/cliquet-taille.json`, pour livrer la 0.3.1 sur une chaîne verte. Le fichier de
référence est du JSON : il ne porte pas de commentaire, la date et le motif vivent donc ici.
Ce n'était **pas** la clôture du ticket : la dérogation gèle la taille (le fichier ne peut
plus que rétrécir) mais ne découpe rien.

**Clos le 2026-08-13, par la bande.** En corrigeant [T-043](#t-043--tous-les-fournisseurs-en--erreur-réseau--sur-un-poste-dentreprise),
le cliquet a refusé les 27 lignes que j'ajoutais à un fichier qui n'avait le droit que de
maigrir. Plutôt que de relâcher son budget deux fois dans la même journée — ce qui aurait vidé
le garde-fou de son sens — les deux modules de test sont sortis dans
[src-tauri/src/sidecar/tests.rs](../src-tauri/src/sidecar/tests.rs) (`#[path]`, ils restent des
tests unitaires du module). `sidecar.rs` passe de 807 à **794 lignes** : sous la limite, et
donc HORS dérogation.

Honnêteté sur ce qu'on a fait : c'est la coupe la plus franche, pas la plus profonde. Aucune
logique n'a été redécoupée — seulement les tests, qui ne tenaient au reste que par `super`. Le
fichier reste dense, mais il n'a plus de traitement de faveur, et c'est ce que le cliquet
demandait.

### T-043 — Tous les fournisseurs en « erreur réseau » sur un poste d'entreprise

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constat utilisateur du 2026-08-13, sur un **poste d'entreprise** fraîchement passé en 0.3.1 :
Swiftask configuré à la main, et « erreur réseau » à chaque appel. Depuis le poste Linux, le
même service répond (`/public/bots` → 200, `/v1/models` → 200, `POST /v1/chat/completions`
sans clé → 401) : le défaut était donc local à ce poste.

Diagnostic mené **à distance**, par un agent tournant sur le poste lui-même — la machine
n'ouvre aucun port entrant. Quatre mesures faites sur place :

| mesure | résultat |
|---|---|
| `curl.exe https://graphql.swiftask.ai/public/bots` | **200** |
| Node embarqué, `fetch()` sur la même URL | **`UND_ERR_CONNECT_TIMEOUT`** |
| `HTTPS_PROXY` / `HTTP_PROXY` | un proxy d'entreprise, port 8080 |
| WinHTTP / WinINET | direct / PAC `…/proxy.pac` |

La cause tient à un écart de comportement qui n'a rien d'évident : **`curl` honore
`HTTPS_PROXY`, le `fetch` de Node non.** Sur un réseau d'entreprise à egress contrôlé,
l'application tente une connexion directe qui expire, pendant que le navigateur d'à côté
fonctionne parfaitement. `UND_ERR_CONNECT_TIMEOUT`
tombe **avant** la négociation TLS : ce n'est pas un problème de certificat.

**Corrigé** en une ligne : la coquille lance le sidecar avec `--use-env-proxy`. Le Node
embarqué (v22.22.1) sait honorer les variables d'environnement, il suffisait de le lui
demander — pas de dépendance `undici` à ajouter. Le drapeau est **inconditionnel** : sans
variable posée il ne fait rien, et une détection maison ferait moins bien que Node.

Un test Rust verrouille la présence du drapeau **et sa position avant le script** : Node ne
traite ses propres options qu'avant le nom du fichier à exécuter. Placé après, il partirait
au sidecar comme un argument quelconque, ignoré en silence — la panne reviendrait sans un mot
dans le journal.

Fausse piste écartée en chemin, et il faut le dire : le poste portait un `err.txt` rempli
d'erreurs `EISDIR: lstat 'C:'`, celles du sidecar mort-né du 7 août. Le fichier **datait du 7
août** (mesuré : 4 804 octets, jamais réécrit depuis) et notre code n'écrit plus ce fichier.
Le sidecar tournait (PID actif, « sidecar à jour » au démarrage). Un vestige de diagnostic
laissé sur un poste est un faux coupable qui attend son heure.

### T-044 — Quatre pannes réseau, un seul message

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Trouvé en instruisant [T-043](#t-043--tous-les-fournisseurs-en--erreur-réseau--sur-un-poste-dentreprise).
Le journal du poste ne portait que ceci, douze fois :

```json
{"level":"error","scope":"ui","msg":"erreur réseau: fetch failed","stack":null}
```

Le `fetch` de Node rend **toujours** le même message et range la vraie cause dans
`err.cause.code`. Nos cinq points de capture prenaient `err.message` et jetaient la cause.
Résultat : un proxy, un certificat non reconnu, un DNS muet et un service éteint produisent
la même ligne — quatre pannes, quatre remèdes, un seul message.

Le coût s'est mesuré le jour même : il a fallu **piloter la machine à distance** pour obtenir
`UND_ERR_CONNECT_TIMEOUT`, c'est-à-dire un mot que le journal avait sous la main et n'écrivait
pas. C'est la doctrine d'observabilité prise en défaut sur son propre terrain : le message
existait, il était juste inexploitable.

**Corrigé** par `avecCause()` / `messageReseau()` dans [base.ts](../sidecar/src/base.ts),
utilisés aux cinq sites d'`engine.ts` — y compris celui du Chat, le plus visible, qui rendait
`fetch failed` tout court. Le code n'est ajouté que s'il n'est pas déjà dans le message.
Six cas de test ([messageReseau.test.js](../sidecar/test/messageReseau.test.js)), dont celui
qui compte vraiment : **quatre causes doivent donner quatre messages distincts**.

### T-042 — L'installeur n'embarquait pas la version testée

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Trouvé le 2026-08-13 en instruisant [T-038](#t-038--lappimage-ne-se-construit-plus-et-léchec-est-muet),
et **plus grave que lui** : il touche les paquets déjà livrés, sur les deux plateformes.

`preparer-bundle.sh` fabrique le paquet du sidecar en régénérant un `package.json` réduit,
puis en lançant `npm install` dans ce dossier. Or ce manifeste reprenait les **plages** de
versions du sidecar (`^0.3.214`), et ce dossier n'a pas de verrou : npm y résolvait donc la
version **la plus récente du jour**, pas celle que la chaîne de tests venait de valider.

Mesuré sur le poste :

| | version | CLI Claude |
|---|---|---|
| dépôt (verrou, testé) | 0.3.214 | 265 210 864 o |
| **paquet livré** | **0.3.231** | **311 175 440 o** |

46 Mo d'écart, et une version que **personne n'avait jamais exécutée** — ni les tests, ni le
poste, ni la CI. C'est aussi l'explication du CLI Windows passé de 287 à 307 Mo entre le 9 et
le 13 août à verrou identique, anomalie que je n'expliquais pas le matin même. L'installeur
Windows de la 0.3.1 déjà distribué porte donc le CLI 0.3.231.

Livrer autre chose que ce qu'on a testé est un échec muet de plus : rien ne le signale, et
l'écart ne se découvre qu'en panne, chez l'utilisateur. Même famille que T-020 (le sidecar
périmé) — on croit exécuter ce qu'on a écrit.

**Corrigé** : le manifeste du paquet est écrit avec les versions **exactement installées**
dans le dépôt, c'est-à-dire l'image du verrou. Un paquet manquant fait échouer la construction
avec le geste à faire (`npm ci`) plutôt que de résoudre dans le vide. Et le journal
d'empaquetage annonce désormais les versions, pas seulement les noms :

```
dépendances embarquées : @anthropic-ai/claude-agent-sdk@0.3.214, yaml@2.9.0, zod@4.4.3
```

Restent flottantes les dépendances **transitives** du paquet : les figer demanderait un verrou
propre au bundle. Le risque est moindre — les gros binaires sont des dépendances directes —
mais il n'est pas nul, et ce n'est pas fait.

### T-039 — Deux fichiers que Linux distingue et que Windows confond

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13, au deuxième passage du portique de la 0.3.1 : une fois
[T-037](#t-037--un-test-neuf-construisait-un-chemin-que-windows-ne-relit-pas) corrigé, le job
Windows va plus loin et tombe à l'étape suivante, `preparer-bundle` → `tsc` :

```
File name '…/ui/src/modelPicker.ts' differs from already included file name
          '…/ui/src/ModelPicker.ts' only in casing.
Module '"./ModelPicker"' has no exported member 'ModelPicker'.
```

Le dépôt porte deux paires de fichiers dont les noms ne diffèrent que par leur initiale :

| composant | logique pure |
|---|---|
| `ui/src/ModelPicker.tsx` | `ui/src/modelPicker.ts` |
| `ui/src/ProviderForm.tsx` | `ui/src/providerForm.ts` |

Sous Linux ce sont quatre fichiers. Sous Windows, le système de fichiers est **insensible à la
casse** : `import { ModelPicker } from "./ModelPicker"` se résout sur `modelPicker.ts`, qui
n'exporte évidemment pas de composant. `tsc` voit alors deux fois le même fichier sous deux
graphies et refuse de compiler. L'installeur Windows **ne pouvait pas se construire**.

Ce qui rend le défaut coûteux, ce n'est pas la faute de frappe — c'est qu'**aucun garde-fou ne
pouvait l'attraper depuis le poste de développement**. Chaîne complète verte en local, trois
publications passées, et la panne n'apparaît qu'au moment le plus cher : la construction de la
version que l'utilisateur attend. Troisième défaut Windows-seulement de la journée, après
T-014 (avril) et T-037 le matin même.

**Corrigé** en deux temps :

1. Renommage des feuilles de logique en `modelPickerCalc.ts` et `providerFormCalc.ts` (suffixe
   `Calc`, déjà la convention du dépôt — voir `supervisionCourbesCalc.ts`), imports et
   références de documentation suivis.
2. **Un garde-fou pour que ça ne revienne pas** :
   [collisions-casse.mjs](../scripts/collisions-casse.mjs), branché dans `npm run verif` et
   dans la CI. Il refuse deux chemins qui ne diffèrent que par la casse (sur un système
   insensible, un seul survit à l'extraction du dépôt) et deux modules du même dossier dont le
   nom, extension retirée, ne diffère que par la casse (l'import devient ambigu). Ses tests
   ([collisions-casse.test.mjs](../scripts/collisions-casse.test.mjs), 11 cas) contiennent le
   cas T-039 lui-même, et vérifient qu'un module et son `.test.ts`, ou un composant et sa
   feuille de style, ne déclenchent pas de fausse alerte.

### T-037 — Un test neuf construisait un chemin que Windows ne relit pas

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constaté le 2026-08-13 sur le portique de la 0.3.1 : `construire (windows-latest)` échoue aux
tests du sidecar, l'annotation dit

```
ECHEC: la compilation de test doit se déclarer à jour, vu « sans-empreinte »
       (/D:/a/iaction/iaction/sidecar/dist-verif)
```

Le chemin porte la réponse : **`/D:/…`**, une barre oblique avant la lettre de lecteur.
[peremption.test.js](../sidecar/test/peremption.test.js) dérivait le dossier compilé par
`new URL(moduleCompile("peremption.js")).pathname`, qui rend cette forme sous Windows. Node ne
la relit pas : `empreinte.json` paraissait absent, le statut tombait à « sans-empreinte », et
le test — dont le métier est justement de vérifier que le témoin est déposé — accusait la
compilation.

Deux choses valent d'être notées :

- **Rien n'était cassé côté produit.** L'empreinte était bien écrite ; c'est le test qui
  regardait au mauvais endroit. Le garde-fou de T-020 tient toujours.
- **Le fichier est neuf** (créé le 2026-08-13, commit `a0d50ec`) : aucun runner Windows ne
  l'avait jamais exécuté avant ce portique. C'est exactement le scénario de
  [T-014](#t-014--ci-windows--un-test-construisait-un-chemin-sans-lettre-de-lecteur), au mot
  près — et la démonstration que la CI à deux plateformes gagne son coût sur un seul cas.

**Corrigé** par `fileURLToPath()`, la conversion qui tient sur les deux systèmes. C'était déjà
la règle du dépôt : [mcpCatalog.ts](../sidecar/src/mcpCatalog.ts) porte le commentaire qui met
en garde contre `new URL(...).pathname`. Le grep de vérification ne trouve plus aucune autre
occurrence de ce motif dans le code de chemins.

### T-035 — La dépense réelle n'était affichée nulle part

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constat utilisateur du 2026-08-13 : « le débord du mois n'affiche rien alors que j'ai utilisé
OpenRouter et une recherche ». Vérifié sur `usage/events.jsonl` du poste : **16 tours
OpenRouter en août 2026, 2,43 $ dépensés, et `routeDebord` sur zéro d'entre eux**.

La carte n'était donc pas en panne — elle affichait fidèlement `0.00 $`, parce que
`debordMoisUsd` ne somme que les tours portant `routeDebord: true`, c'est-à-dire ceux que le
ROUTEUR AUTOMATIQUE a fait déborder vers le payant quand l'abonnement était saturé. Une cible
payante choisie à la main ne porte jamais ce marqueur : c'est écrit dans la spec R3, et c'est
volontaire — le plafond mensuel ne doit pas se remplir de dépenses que l'utilisateur a
décidées lui-même.

Le vrai défaut est ailleurs, et il est plus grave : **la page ne montrait la dépense réelle
nulle part.** `costUsd` est pourtant enregistré sur chaque événement depuis R0. On pouvait donc
dépenser 2,43 $ sans qu'un seul écran de l'application ne l'affiche — un angle mort de la
comptabilité, dans la page dont c'est justement le métier.

**Corrigé** en ajoutant l'agrégat manquant plutôt qu'en dénaturant le débord :

- `usage.stats` rend désormais `coutPeriodeUsd` (somme de TOUS les `costUsd` de la période
  `from`/`to`, débord automatique ET choix manuel) et `coutInconnuTours`
  ([usageStats.ts](../sidecar/src/usageStats.ts), [protocol.md](protocol.md)) ;
- l'encart « Routage » gagne une carte **« Dépense de la période »**, à côté du débord dont le
  sous-titre précise maintenant « routage auto seulement » — les deux chiffres répondent à deux
  questions différentes, et rien ne le disait ;
- `coutInconnuTours` compte les tours sur cible payante **sans coût remonté**. Tant qu'il est
  non nul, la carte affiche « au moins — N tours payants sans coût remonté » : une somme
  partielle présentée comme un total serait un échec muet de plus (voir [T-036](#t-036--des-tours-payants-ne-remontent-aucun-coût),
  ouvert sur les 7 tours Swiftask concernés).

Extraction imposée par le cliquet de taille et bonne en soi :
[usageProjets.ts](../sidecar/src/usageProjets.ts) — `usageStats.ts` mélangeait trois métiers
(écrire le journal d'usage, l'agréger, résoudre l'appartenance d'un tour à un projet) ; le
troisième part dans son module. Le fichier passe de 869 à 662 lignes, **sous sa dérogation
de 842**, qui est resserrée d'autant.

### T-033 — Supervision : les KPI ne suivaient ni la granularité, ni la période

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-13 · **Clos** 2026-08-13

Constat utilisateur du 2026-08-13 : « les KPI ne s'adaptent pas au changement jour, semaine,
mois, ni avec le sélecteur de semaine ». Vérifié : exact, et pour une cause unique.

`bucket` n'était traité que comme **granularité de l'histogramme**, jamais comme période
d'analyse. `windowSpan()` rendait la même fenêtre de 30 jours pour `day` et pour `week` :

- **Jour et Semaine envoyaient à `usage.stats` un `from`/`to` identique.** Cartes KPI, Modèles,
  Usage par projet et Routage étaient donc rigoureusement les mêmes dans les deux modes — seul
  l'histogramme se re-regroupait. Mois bougeait, mais pour la mauvaise raison : c'est la
  fenêtre qui passait à 6 mois, pas la période qui devenait un mois.
- **Le ◀ ▶ décalait de 30 jours entiers** en mode Semaine. Il ne sélectionnait donc jamais une
  semaine : il reculait d'un mois, et les KPI continuaient d'agréger 30 jours. D'où « ni avec
  le sélecteur de semaine ».

Le sidecar était hors de cause : `handleUsageStats` filtre correctement sur `from`/`to`
([usageStats.ts](../sidecar/src/usageStats.ts)). Le défaut était entièrement dans
[SupervisionPage.tsx](../ui/src/SupervisionPage.tsx), et le protocole n'a pas bougé.

**Corrigé** en faisant de la sélection la période, comme le libellé le promet :

- **la période EST la sélection** — un jour, la semaine ISO (lundi→dimanche), ou le mois
  calendaire de l'ancre. Tous les encarts (KPI, modèles, projets, routage) portent sur elle
  seule, donc les trois granularités donnent trois chiffres différents ;
- **◀ ▶ avance d'UNE période** (un jour, une semaine, un mois), avec des libellés accordés
  (« Semaine précédente », « Ce mois-ci »). Le décalage part du **début** de période, pas de
  l'ancre : sinon « 31 mars − 1 mois » retombe sur le 3 mars et la navigation dérive au fil des
  mois courts ;
- **l'histogramme cède la place à un graphique de courbes** des quatre mêmes indicateurs
  ([SupervisionCourbes.tsx](../ui/src/SupervisionCourbes.tsx)), tracé sur le **cran de période
  au-dessus** de la sélection : jour → sa semaine, semaine → son mois, mois → son année. On lit
  donc toujours la période choisie dans le contexte qui la contient, et la bande claire sous les
  courbes marque celle que décrivent les cartes. Second appel `usage.stats` : les buckets de
  cette fenêtre ne suffisent pas aux encarts, ils ne portent ni modèles, ni projets, ni routage.
  Deux règles de non-tromperie dans le découpage : les bornes sont étendues aux **buckets
  entiers** (une semaine coupée par le bord du mois dessinerait un creux qui n'existe pas) et
  **tronquées à la période en cours** (sinon l'année courante traînerait quatre mois vides) ;
- **un seul axe, jamais deux échelles.** Les quatre séries vont de la dizaine de conversations
  au million de tokens : en valeurs absolues, trois courbes s'écraseraient sur zéro, et un
  second axe ferait mentir les croisements. Chacune est donc **indexée sur son propre maximum**
  de la fenêtre — l'axe se lit « % du pic de la série », les valeurs réelles sont dans la
  légende (le pic), au survol et dans un tableau dépliable. Le contexte moyen s'interrompt là
  où aucun token n'a été compté : une moyenne absente n'est pas une moyenne nulle. La palette
  (`#1478ff` `#aa6900` `#c800b9` `#ff0069`) est **vérifiée par calcul** contre la surface sombre
  de l'app — bande de clarté, plancher de chroma, séparation daltonisme toutes paires (ΔE ≥ 8,9),
  contraste ≥ 3,66:1 — et non choisie à l'œil ; l'identité ne repose jamais sur la seule
  couleur (légende + étiquette en bout de courbe + tableau) ;
- **mise en page à deux colonnes** : les courbes prennent toute la largeur, puis Usage par
  projet / Modèles sur une ligne, Routage / Abonnement Claude sur la suivante ;
- **l'ancre est conservée en changeant de granularité** (le 3 juillet en « Jour » → la semaine
  du 3 juillet), au lieu de sauter à aujourd'hui et de faire perdre l'endroit qu'on lisait ;
- **`atToday`** regarde désormais la fin de période et non l'ancre — un mois entamé est la
  dernière période navigable, ▶ ne propose plus un clic sans effet.

L'arithmétique de période est sortie dans
[supervisionPeriode.ts](../ui/src/supervisionPeriode.ts) et testée sans monter le composant
([supervisionPeriode.test.ts](../ui/src/supervisionPeriode.test.ts), 13 cas) : semaine ISO
dimanche compris, février bissextile, non-dérive sur quatre mois enchaînés, aller-retour ◀ ▶
idempotent, pas de navigation dans le futur, extension aux semaines entières, troncature à la
période en cours. C'est là que les régressions sont silencieuses.

### T-032 — Sélecteur de modèle illisible

**Type** feat · **Prio** P2 · **Statut** fait · **Créé** 2026-08-12 · **Clos** 2026-08-12

Constat utilisateur du 2026-08-12, capture à l'appui : « c'est le bordel ». Le sélecteur de
modèle du Chat déroulait plusieurs centaines de slugs bruts (`bytedance-seed/seed-2-1-turbo`),
dans l'ordre où OpenRouter les sert, sans prix ni taille de contexte, avec les dix favoris
listés **deux fois** (leur groupe « Mis en avant », puis « Tous les modèles »). Même chose dans
la barre latérale de Projets. Cinq défauts, une cause commune : les deux pages appelaient
`models.list`, qui ne rend **que des ids** — alors que `models.detail`, servi par la MÊME
requête au fournisseur, porte déjà nom, tarifs et contexte, et que la page Configuration s'en
sert depuis R8-A. Le confort n'est pas décoratif ici : choisir un modèle, c'est arbitrer un coût.

**Corrigé** en sortant du `<select>` natif — il ne se filtre pas, et son popup est rendu par le
système (ni colonne, ni badge, ni étoile) :

- **[modelPickerCalc.ts](../ui/src/modelPickerCalc.ts)** — toute la décision (filtres, groupes, ordre),
  sans DOM, donc testée sans fenêtre ([modelPickerCalc.test.ts](../ui/src/modelPickerCalc.test.ts)) ;
- **[ModelPicker.tsx](../ui/src/ModelPicker.tsx)** — bouton + popover : recherche floue sur le
  nom ET l'id, tri (nom / prix / contexte), puces « Gratuit » et « Variantes », étoile de favori
  posée sur la ligne, prix et contexte en badges, id toujours visible sous le nom commercial.
  **Groupé par éditeur** (`anthropic · 28`, `openai · 94`…), en-têtes collants pendant le
  défilement, **repliés par défaut** — le catalogue OpenRouter sert 410 modèles de 59 éditeurs
  (relevé du 2026-08-12), et l'ouvrir à plat était le reproche d'origine. Trois exceptions au
  repli, toutes là pour ne rien cacher qui soit demandé : une recherche en cours déplie tout
  (sinon elle semblerait ne rien trouver), le groupe du modèle SÉLECTIONNÉ s'ouvre, et un
  fournisseur dont les ids ne nomment pas d'éditeur (Ollama) n'est jamais replié — ça
  cacherait tout le catalogue derrière une ligne. Les favoris ne se replient pas non plus ;
- **ordre des éditeurs = part de trafic** ([`RANG_EDITEURS`](../ui/src/modelPickerCalc.ts)), relevé
  OpenRouter de juin 2026 : deepseek, anthropic, google, openai, xiaomi, minimax, tencent, qwen,
  moonshotai. Les cinquante autres éditeurs du catalogue passent **après, par ordre
  alphabétique** : les classer au jugé serait inventer une hiérarchie que rien ne mesure. Table
  figée et datée, avec sa provenance affichée en pied de liste (même doctrine que
  `BENCH_DISCLAIMER`) — ce classement bouge vite : entre les relevés d'avril et juin 2026,
  xiaomi passe de 22,3 % à 8,3 % et deepseek de 6,8 % à 17,6 %. Deux ordres, deux
  responsabilités : « chez qui » vient du trafic, « lequel » du tri choisi — si bien que
  changer de tri ne fait jamais sauter les éditeurs de place sous le curseur ;
  Rendu par PORTAIL : `.sidebar-section` porte `overflow: hidden`, un popover en `absolute` y
  serait coupé. Un seul composant sert le Chat et Projets — les modèles de l'abonnement Claude y
  entrent comme options « épinglées », au même titre que la sentinelle « Auto » ;
- **variantes masquées par défaut** (`…:free`, `…:thinking`) avec un compteur cliquable, jamais
  en silence. Deux règles de non-perte : une variante n'est masquée que si son modèle de base
  est présent au catalogue (`liquid/lfm-2.5-2.6b:free` n'a pas d'équivalent payant — le masquer
  retirerait le modèle, pas son doublon), et le modèle SÉLECTIONNÉ y échappe toujours ;
- **`models.list` → `models.detail`** dans les deux pages : même requête réseau, simplement lue
  en entier. Un fournisseur muet (Ollama) rend toujours au moins les ids, et le sélecteur
  n'affiche alors ni ligne de tarif ni « — / — » — rien plutôt qu'une colonne de tirets ;
- **plus jamais de doublon** : les favoris sont retirés du groupe « Tous les modèles ».

Deux extractions au passage, imposées par le cliquet de taille et bonnes en soi :
[fuzzy.ts](../ui/src/fuzzy.ts) (le filtre flou était privé de `CommandPalette`, il sert
maintenant aux deux) et [useFavorisModeles.ts](../ui/src/useFavorisModeles.ts) (Chat et Projets
tenaient chacun leur copie du cycle lecture/bascule des favoris). ChatPage et AgentPage
ressortent **plus courts** qu'avant le ticket.

Non fait, volontairement : la section « Récents » (derniers modèles utilisés) évoquée au
cadrage — les favoris manuels suffisaient, et l'ajouter se fera sans toucher au composant.

### T-031 — L'écriture dans le Chat traîne

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-12 · **Clos** 2026-08-12

Constat utilisateur du 2026-08-12 : « l'écriture dans la partie chat est très lente ». Deux
symptômes de la même cause — la réponse qui s'écrit par à-coups, et la frappe qui redevient
poussive dès qu'on tape pendant qu'un tour répond.

**Cause — deux, trouvées dans cet ordre.**

*Piste 1 (réelle, mais pas celle du constat).* Chaque fragment de réponse arrive comme un
événement Tauri distinct, et chacun passait par `depot.ecrire`
([useConversationRuntime.ts](../ui/src/useConversationRuntime.ts)), qui demandait aussitôt un
rendu COMPLET de la page — trente à cent fois par seconde selon le fournisseur. À chaque rendu :
toute la transcription reparcourue, le Markdown de la bulle en cours reparsé en entier (coût qui
croît avec la réponse), et le recollage en bas qui force une remise en page du fil. Corrigé, mais
l'utilisateur a rapporté « ça n'a pas beaucoup changé, c'est exclusivement dans la partie chat » :
le moteur étant PARTAGÉ avec Projets, une correction qui n'améliore que le Chat ne pouvait pas
être là.

*Piste 2 (la bonne).* Trois questions ont suffi à la cerner : lent **même dans une conversation
vide**, les **lettres traînent derrière le clavier**, **quel que soit le fournisseur**. Donc un
coût par FRAPPE, indépendant du fil et du catalogue de modèles. Il restait un re-rendu de page
débouncé à 250 ms après chaque frappe, dans
[useComposerLiveDraft.ts](../ui/src/useComposerLiveDraft.ts) — le « rattrapage » des états dérivés
du brouillon. Or l'inventaire de ces états en donne UN SEUL, dans les deux pages : le bouton
« Envoyer » grisé quand il n'y a rien à envoyer. Un rendu de page complet quatre fois par seconde
pour un booléen — et il tombait au pire moment, pendant les micro-pauses entre deux mots, juste
quand la frappe reprend.

Pourquoi le Chat et pas Projets : le mécanisme est le même, le PRIX du rendu ne l'est pas. La page
Projets est déjà découpée en modules mémoïsés (`agentSidebarDroit`, `agentTranscript`, `FileTree`) ;
le Chat rendait encore tout en ligne, dans une seule fonction de 2 700 lignes.

**Corrigé** en trois temps, aucun ne touchant à la donnée — elle reste écrite immédiatement et
intégralement, seul l'AFFICHAGE est concerné :

- **la frappe ne rend plus rien** : `useComposerLiveDraft` expose `brouillonVide`, qui ne change
  qu'au FRANCHISSEMENT de la frontière vide/non-vide — deux rendus par message au lieu de quatre
  par seconde, et zéro en tapant au milieu d'une phrase. Le minuteur de rattrapage disparaît, donc
  aussi la course entre le `blur` du champ et le `click` du bouton qu'il fallait contourner ;
- **cadence de rendu du streaming** (`creerRythme`, ~80 ms, front montant) : les rafales de
  fragments sont regroupées en ~12 images/s, ce que l'œil lit comme du texte qui coule, tandis
  qu'une écriture isolée s'affiche sans délai. Profite aux deux pages ;
- **fil du Chat extrait et mémoïsé** ([chatTranscript.tsx](../ui/src/chatTranscript.tsx)), et
  options du sélecteur de modèle mémoïsées — OpenRouter en publie plusieurs centaines, elles
  étaient reconstruites à chaque rendu.

**Leçon.** Le premier diagnostic était cohérent mais invérifié : le symptôme « c'est lent » avait
été rattaché au coût le plus VISIBLE dans le code, pas au coût mesuré. Ce qui a tranché, c'est
d'avoir demandé trois observations discriminantes plutôt qu'une quatrième lecture du code.

### T-021 — `models.list` peut ne montrer qu'une fraction des modèles servis

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-11

Constaté le 2026-08-10 en évaluant l'ajout de Swiftask comme fournisseur
neutre. `GET https://graphql.swiftask.ai/v1/models` renvoie **8 slugs figés**
(`llama31`, `mistralmedium`, `o3-mini`…), avec ou sans clé. Le catalogue réel
du même fournisseur est ailleurs — `GET /public/bots` renvoie **142 entrées**
(`claude-opus-5`, `gpt-5.6-terra`, `gemini-3.6-flash`, `grok-4.3`, plus image
et vidéo). Preuve que `/v1/models` n'est pas la source de vérité : un appel
réel sur `claude-sonnet-4-6` — **absent de `/v1/models`** — a répondu 200 et
streamé normalement.

Conséquence dans l'application : `fetchRawModels` tape en dur
`{baseUrl}/models` ([engine.ts](../sidecar/src/engine.ts) ~195), et les
sélecteurs de modèles sont des `<select>` fermés sur cette liste
([ChatPage.tsx](../ui/src/ChatPage.tsx) ~2141, [AgentPage.tsx](../ui/src/AgentPage.tsx)
~696). L'utilisateur ne peut donc **ni voir ni saisir** les 134 modèles
manquants : le fournisseur est utilisable mais amputé, sans le moindre message.

Ce n'est pas un défaut propre à Swiftask, c'est une hypothèse non écrite du
moteur neutre : « tout endpoint compatible OpenAI expose son catalogue complet
sur `/models` ». Correctif attendu : une **source de catalogue déclarée par
fournisseur** (URL + forme de la réponse), traitée en T-023. Repli minimal
acceptable en attendant : autoriser la saisie libre d'un slug quand le
catalogue est vide ou suspect.

**Le catalogue n'est pas homogène** (mesuré le 2026-08-10 sur les 142 entrées) :
132 se déclarent `isChatLMM: true`, 10 non (transcription, export Excel/Sheets,
vidéo Veo3, automatisation de navigateur). Et parmi les « chat », une soixantaine
seulement sont des modèles d'éditeur ; le reste sont des agents préconfigurés
(« Expert RH France », « Knowledge assistant - RAG », « Le Maestro »). Trois
natures derrière un seul champ `model`, dont deux dégradent silencieusement :
`excel_export` interrogé par `/v1/chat/completions` répond comme un chatbot
générique — sa fonction d'export est perdue, sans erreur — et
`languagecorrector` a perdu sa consigne de correcteur. Un sélecteur qui
listerait les 142 à plat laisserait donc choisir « Excel Export » comme
cerveau d'un agent. **Le correctif ne se réduit pas à changer d'URL : il faut
CLASSER** (au minimum `isChatLMM`, et distinguer modèle brut d'agent
préconfiguré).

**Corroboré le 2026-08-10** par lecture de l'extension VSCode officielle
(`Swiftask.swiftask-chat` 0.1.3, dont le paquet publie ses sources d'origine
via son source map) : leur propre client nomme le champ `defaultBotSlug` et le
règle sur `claude-sonnet-4-5` — **absent de `/v1/models`**. L'éditeur lui-même
ne traite donc pas `/v1/models` comme son catalogue. L'hypothèse est bien
fausse, pas seulement inadaptée.

**Clos le 2026-08-11 par R8-A** (`traits.catalogUrl` + `traits.catalogShape`,
voir [spec-r8-profils-fournisseur.md](spec-r8-profils-fournisseur.md) §2 et
`sidecar/src/catalogue.ts`). Vérifié sur la réponse réelle de
`/public/bots` : **142 entrées → 132 modèles** conservés, `claude-opus-4-8` et
`gemini-3-pro` présents, `excel_export` et `whisperx` écartés par le filtre
`isChatLMM`. Le sidecar ne porte aucune table de marques : le profil vient de
la config, poussé par `providers.set`.

### T-022 — Un usage à zéro est enregistré comme zéro, jamais comme « inconnu »

**Type** bug · **Prio** P2 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-11

Constaté le 2026-08-10, même campagne de mesure. Dernier événement SSE d'un
tour Swiftask réussi (2 tokens de réponse) :

```
data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":7744}}
```

`extractUsage` ([engine.ts](../sidecar/src/engine.ts) ~310) ne garde que
`prompt_tokens` / `completion_tokens` et n'accepte que `typeof === "number"` :
`0` est un nombre, donc **`0` est enregistré comme une mesure valide**. La
jauge de contexte affichera « 0 token » sur une conversation qui en consomme,
les compteurs de la page Supervision agrégeront des zéros, et le plafond de
débord R3 — qui se compte sur l'usage — resterait aveugle sur ce fournisseur.

C'est exactement le défaut « jauge de contexte figée à zéro », déjà corrigé
deux fois dans l'interface (voir [architecture.md](architecture.md) §7), qui
reviendrait cette fois par la porte du fournisseur. La distinction manquante
est **« zéro mesuré » ≠ « pas de mesure »** : `null` existe déjà dans le type
`Usage`, il n'est simplement jamais produit quand le champ est présent et nul.

Correctif attendu : un tour qui a produit du contenu et annonce
`prompt_tokens: 0` déclare `null`, pas `0` — et le journalise une fois, pour
que l'absence de comptabilité soit un fait visible et non un silence. À écrire
avec un cas de test dédié dans `protocol.test.js` (faux serveur renvoyant des
zéros).

**Deux vérifications faites le 2026-08-10, qui ferment les échappatoires** :

- le champ non standard `stateless: true` — envoyé par le client officiel de
  l'éditeur — **ne change rien** : `{prompt_tokens: 0, completion_tokens: 0,
  total_tokens: 1197}` avec comme sans, sur deux modèles. Ce n'est pas un
  réglage qui nous manque, la passerelle ne compte simplement pas ;
- le client officiel **a exactement le même angle mort** : son parseur SSE
  écrit `promptTokens: chunk.usage.prompt_tokens ?? 0`. Personne ne corrigera
  cela en amont ; c'est à nous de distinguer « zéro mesuré » de « pas de
  mesure ».

**Clos le 2026-08-11 par R8-A** (`traits.usageTrustworthy: false`, voir
`sidecar/src/profilFournisseur.ts`). Un compteur annoncé à `0` devient `null`,
et le sidecar journalise un `warn` une fois par fournisseur et par processus —
l'absence de comptabilité est un fait visible, pas un silence. Sans le trait,
un vrai zéro reste un zéro (cas de test 7).

### T-028 — Relancer `dev.sh` ouvre une fenêtre morte-née, sans sidecar

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-11 · **Clos** 2026-08-11

Constat utilisateur : « la fenêtre répond `Erreur : sidecar indisponible : stdin absent` », puis
« redémarré, idem » — trois fois de suite.

Une session `tauri dev` tournait depuis 5 h et tenait le port 1420. Chaque relance de
`scripts/dev.sh` (par raccourci clavier GNOME, `gsd-media-keys`) déroulait alors :
`Running target/debug/iaction` → `Error: Port 1420 is already in use` →
`The "beforeDevCommand" terminated with a non-zero status code`. Autrement dit **la fenêtre est
lancée AVANT l'échec** : `tauri dev` avorte, le sidecar meurt avec lui, mais la fenêtre survit,
orpheline (reparentée à systemd). Pire, elle n'en a pas l'air — son webview charge le Vite de
l'AUTRE session, donc l'interface s'affiche, avec les conversations relues du disque. Le défaut
ne se voit qu'à l'envoi. Chaque relance empilait une fenêtre morte de plus.

Second défaut, révélé par le premier : côté [sidecar.rs](../src-tauri/src/sidecar.rs), la mort du
child laissait `child`/`stdin` à `None` **sans faire tomber l'état**, resté `Running`. D'où ce
message d'entrailles au lieu d'un « redémarrage en cours ». Même trou dans `request_shutdown`.

**Réalisé** :

- [scripts/dev.sh](../scripts/dev.sh) refuse de démarrer si le port 1420 est déjà pris, et dit
  quoi faire (basculer sur la fenêtre ouverte, ou `pkill -f 'tauri dev'`). Le garde-fou est
  placé AVANT la compilation du sidecar : plus rien n'est touché sur un lancement refusé ;
- l'état passe à `Restarting` au moment même où `stdin` disparaît (`emit_status` compris), et à
  `Dead` dans `request_shutdown` ; le message résiduel de `sidecar_request` devient « le
  processus vient de s'arrêter, redémarrage en cours ».

Reste ouvert et distinct : [T-009](#t-009--dev--fenêtre-ouverte-avant-que-vite-soit-chaud)
(fenêtre ouverte avant que Vite soit chaud, session unique).

### T-010 — Recherche web pour le moteur neutre (Chat)

Constaté le 2026-08-09, 00h07 (Chat · OpenRouter · ling-3.0) : interrogé sur
des vidéos IA récentes, le modèle invente des références périmées
(« janvier 2025 » présenté comme récent) avant d'admettre qu'il ne peut pas
naviguer. La case « Recherche web » du Chat n'existe que pour le fournisseur
Claude (`claude.start` + outils WebSearch/WebFetch du SDK) ; le moteur neutre
est une complétion pure (`chat.send`), sans aucun outil — et rien dans
l'interface ne prévient que ces modèles répondent de mémoire.

Deux pistes, cumulables :

- **OpenRouter d'abord (petit pas)** : OpenRouter sait faire la recherche web
  côté plateforme (suffixe `:online` sur l'id du modèle, ou champ `plugins`) —
  la case « Recherche web » pourrait s'activer pour ces fournisseurs sans
  boucle d'outils à écrire. Coût facturé par OpenRouter : à afficher.
- **Cas général (plus gros)** : boucle d'appels d'outils pour le chat neutre
  avec un outil de recherche local (SearXNG…) — le moteur neutre AGENTIQUE
  (Projets) a déjà une boucle d'outils, le Chat n'en a pas.

En attendant : au minimum, un indicateur discret « ce modèle répond de
mémoire, sans accès au web » quand le fournisseur est neutre — l'honnêteté
d'abord, la fonctionnalité ensuite.

**Second cas vérifié le 2026-08-10 (Swiftask), qui déplace la conception.**
Swiftask sait chercher côté plateforme : le bot `perplexityonline`, interrogé
sur l'actualité de la semaine, renvoie un titre réel daté avec son URL source
— aucune boucle d'outils de notre côté. Mais la commande ne prend PAS la même
forme que chez OpenRouter :

| Fournisseur | Comment on demande la recherche |
|---|---|
| OpenRouter | **même modèle** + suffixe `:online` (ou champ `plugins`) |
| Swiftask | **un autre modèle** (`perplexityonline`, `webreporter`, `google-search`) |
| Claude | outils `WebSearch`/`WebFetch` du SDK, déjà en place |

Trois grammaires pour une seule intention. Une case « Recherche web » unique
ne peut donc pas les couvrir sans un `if` par fournisseur — c'est-à-dire
exactement ce que T-023 cherche à supprimer. **La case doit être pilotée par
un trait** (« comment ce fournisseur active la recherche »), pas par une
condition sur l'id. T-010 dépend donc de R8, et ne devrait pas être traité
avant.

À noter aussi : `gemini-pro-with-search`, seul modèle du sélecteur dont le nom
promet la recherche, est l'un des deux modèles morts de T-025. L'utilisateur
qui le choisit croit activer une capacité et reçoit une phrase d'erreur
présentée comme une réponse.

**Réalisé le 2026-08-10** — spec [R9](spec-r9-recherche-web.md), par
l'INJECTION et non par une boucle d'outils : `chat.send` accepte
`webSearch: true`, le sidecar interroge SearXNG, récupère et classe les pages
(mêmes primitives que le RAG R5), puis préfixe un bloc système ÉPHÉMÈRE au
seul tour en cours. Conséquence directe : la capacité vaut pour **100 % des
modèles**, y compris ceux qui ne savent pas appeler une fonction, et aucune
des trois grammaires de fournisseur (`:online`, `perplexityonline`, outils du
SDK) n'a eu à être implémentée. La case n'est donc plus conditionnée au
fournisseur.

Trois garanties tenues par des tests (`webSearchPur`, `webSearchChat`,
`rechercheWeb.test.ts`) : sans `webSearch`, le tour est identique à l'octet
près et n'émet AUCUNE requête sortante ; un moteur en panne produit un tour
réussi qui ORDONNE au modèle de dire qu'il n'a pas vérifié ; les URL de
résultat sont refusées avant tout accès réseau si elles visent le réseau
privé du poste.

Vérifié en réel le 2026-08-10 sur `swiftask · deepseek-v3` : 5 sources
remontées et citées, et le modèle a explicitement refusé de conclure sur des
extraits insuffisants plutôt que d'inventer — c'est exactement le
comportement que ce ticket réclamait. La qualité des résultats sur une
question d'actualité reste perfectible : voir T-026.

### T-027 — L'avis d'attente s'affichait alors que le fournisseur répondait

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-10

**Constat (2026-08-10).** « J'ai encore ça à chaque nouvelle réponse, c'est très chiant » :
l'avis `⏳ Aucune donnée reçue du fournisseur` de T-006 s'affiche sous une bulle vide, dans un
fil où la réponse précédente est complète et visible juste au-dessus, sur une session dont
l'en-tête indique 12 % de fenêtre consommée — rien n'est saturé, et le fournisseur répond.

**Cause.** L'avis ne mesurait pas « le fournisseur se tait » mais « cette bulle-ci est encore
vide ». Deux choses très différentes dès qu'un tour dure, et deux faux positifs distincts :

- **le seuil.** 10 s était calibré sur un tour court. Le temps jusqu'au premier octet croît avec
  le contexte envoyé : à ~100 k tokens (cas courant ici — l'en-tête affiche le compteur), il
  dépasse régulièrement 10 s sans que rien n'aille mal ;
- **la portée.** Une bulle assistant ouverte au MILIEU d'un tour vivant — message glissé par
  l'utilisateur (S3, `claude.push`), que le modèle ne prendra en compte qu'au prochain outil —
  est vide par construction, parfois plusieurs minutes.

Gravité réelle malgré l'apparence cosmétique : un avertissement qui se déclenche en
fonctionnement NORMAL n'avertit plus de rien. On apprend à ne plus le lire — et il ne servira
pas le jour où le tour est vraiment mort, ce pour quoi il avait été écrit. C'est la panne de
T-006 qui revient par la porte de derrière.

**Réalisé.** Seuil porté à 45 s dans [useAttenteFournisseur.ts](../ui/src/useAttenteFournisseur.ts) —
franchement au-dessus de la latence normale d'un gros contexte, franchement en dessous du
plafond de silence du sidecar (120 s, `SILENCE_DEMARRAGE_TIMEOUT_MS`), qui prend le relais et
transforme l'attente en échec daté. La règle « quand a-t-on le droit d'avertir » devient une
fonction pure unique, `enAttenteDuPremierOctet`, partagée par les deux fils (Projets et Chat) :
elle était auparavant recopiée dans deux JSX, ce qui est exactement la forme du défaut. Les
bulles de poursuite portent `suiteDeTour` ([agentTurns.ts](../ui/src/agentTurns.ts),
[envoiProjet.ts](../ui/src/envoiProjet.ts)) et n'affichent jamais l'avis. Le message annonce
désormais le délai réellement attendu, dérivé de la constante — pas un nombre recopié.
Couverture : [useAttenteFournisseur.test.ts](../ui/src/useAttenteFournisseur.test.ts).

### T-020 — L'application de dev exécutait un sidecar du 7 août

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-10 · **Clos** 2026-08-10

**Constat (2026-08-10, 09h17).** L'interface affiche encore
« ⏳ Aucune donnée reçue du fournisseur » sur un tour parti à 09h15 — le symptôme que T-015
était censé avoir supprimé la veille. Le journal confirme le trou noir : dernière ligne
`serveurs MCP du tour` à 07h15:13 Z, puis plus rien ; aucun `error`, et aucun processus
`claude` correspondant à ce tour dans `ps` (un seul, celui du tour précédent de 09h12). Le
plafond de silence de T-015 (120 s) aurait dû déclarer l'échec à 07h17:13 Z. Il ne l'a pas fait.

**Cause.** Le garde-fou n'était pas dans le programme en train de tourner. `claudeFinDeTour.js`
était purement et simplement ABSENT de `src-tauri/target/debug/sidecar/`, le dossier désigné
par le journal de coquille comme point d'entrée du sidecar. Ce dossier est la recopie de la
ressource Tauri `build/sidecar-bundle/`, que seul `scripts/preparer-bundle.sh`
(`beforeBuildCommand`) reconstruit — jamais `tauri dev`, dont le `beforeDevCommand` ne bâtit
que l'interface. Le bundle datait du **7 août 15h33**. L'application exécutait donc trois jours
de code périmé : T-015, T-017, T-019, la température GPU, tout ce qui touchait le sidecar avait
été compilé, testé, commité — et jamais exécuté une seule fois.

**Pourquoi personne ne l'a vu.** Trois écrans successifs :

- les tests compilent leur PROPRE sortie (`dist-verif/`, voir `test/harness.mjs`) : ils
  passaient au vert sur du code que l'application n'utilisait pas ;
- `sidecar/dist/` existait, à jour au 8 août, et n'était lu par personne — de quoi croire le
  contraire en le regardant ;
- les dates de fichiers MENTAIENT : la recopie du bundle portait le 9 août 18h37, postérieure
  aux sources qu'elle ignorait (`claudeFinDeTour.ts`, 9 août 14h19). Une date dit quand on a
  touché un fichier, jamais ce qu'il contient.

Coût réel : on corrige des bugs déjà corrigés, avec pour seule preuve un symptôme qui persiste.
C'est l'échec muet le plus cher du projet à ce jour, parce qu'il invalide silencieusement tout
diagnostic bâti sur l'application lancée.

**Réalisé — la cause, puis le garde-fou.**

1. [scripts/dev.sh](../scripts/dev.sh) compile le sidecar et DÉSIGNE le résultat par
   `IACTION_SIDECAR`, première branche de `sidecar_entry`
   ([src-tauri/src/sidecar.rs](../src-tauri/src/sidecar.rs)) : la boucle de développement ne
   passe plus par le bundle de livraison, donc plus par une copie qui peut vieillir en silence.
2. Sortie DÉDIÉE `dist-dev/` (script `build:dev`), et non `dist/` : réécrire le dossier
   qu'exécute l'application tue son sidecar — constaté quatre fois les 7 et 8 août, d'où
   `dist-verif/` pour les tests. Trois sorties, trois usages : `dist/` l'empaquetage,
   `dist-verif/` les tests, `dist-dev/` la session lancée. Aucune n'écrit sous les pieds
   d'une autre.
3. [sidecar/src/peremption.ts](../sidecar/src/peremption.ts) : le code compilé emporte
   l'EMPREINTE sha256 des sources dont il est issu (`empreinte.json`, déposé par
   `npm run build -w sidecar`). Au démarrage, le sidecar la recompare et journalise —
   `perime` en `error`, `sans-empreinte` en `warn` (le cas du bundle du 7 août), `a-jour` et
   `hors-source` en `info`, avec dans TOUS les cas le chemin du code réellement exécuté :
   l'unique information qui aurait désigné le coupable en dix secondes.

Empreinte de CONTENU et de NOMS, jamais de dates — un module absent change l'empreinte à
contenu constant, et une date de recopie n'aurait rien vu. Couverture :
[peremption.test.js](../sidecar/test/peremption.test.js) (les quatre statuts, les deux
dispositions de dossier, le témoin corrompu, et le câblage réel de la compilation).

### T-017 — La coquille journalisait la naissance du sidecar, jamais sa mort

Constaté le 2026-08-09 en enquêtant sur T-015 : `logs/coquille.jsonl` ne
contient qu'une seule et même ligne, `démarrage de la supervision du sidecar`,
répétée à chaque lancement — jamais de code de sortie, jamais de signal,
jamais la moindre ligne de `stderr` du processus mort.

Conséquence concrète : le sidecar a redémarré **deux fois pendant une session
de travail** (12h22 et 12h33, chacune suivie de la signature de T-008), et il
est impossible de dire si c'est un plantage, une relance de `tauri dev` ou un
geste de l'utilisateur. Une supervision qui note la naissance sans jamais noter
la mort ne supervise pas : elle compte.

À faire : journaliser la FIN du processus surveillé (code de sortie ou signal,
durée de vie, dernières lignes de stderr), et distinguer un premier démarrage
d'une relance après mort — c'est cette distinction qui aurait répondu à la
question en une seconde.

**Réalisé** (fermé le 2026-08-09, même session) : la coquille tient un tampon
circulaire des 30 dernières lignes de stderr et journalise en `error`, à
chaque mort du process, la cause (code de sortie ou signal nommé), la durée de
vie et ce résumé de stderr. La ligne de naissance dit désormais s'il s'agit du
premier démarrage ou d'une relance après mort — c'est cette distinction qui
manquait pour répondre « plantage ou geste volontaire ? ». Six tests couvrent
les parties pures (cause avec et sans signal, éviction du tampon, troncature
UTF-8, borne du résumé) ; le câblage lui-même exige un vrai process, il n'est
pas testé — assumé et dit.

Le piège évité, déjà documenté dans `sidecar.rs` : ne jamais journaliser
depuis le relais de stderr LIGNE À LIGNE, sous peine de boucle
stderr → `app:log` → `log.append` → stderr. Le journal de mort est un
événement UNIQUE par process : c'est ce qui le rend permis.

### T-018 — Chat : le fournisseur choisi retombait sur Claude sans rien dire

Constaté le 2026-08-09 à 12h49 : OpenRouter + Gemini sélectionnés, la
conversation part sur `Claude (abonnement)` et le badge du tour affiche
`auto : simple → claude-sonnet-5`. L'historique le confirme visuellement — les
conversations précédentes portent « OpenRouter », la nouvelle « Claude
(abonnement) ».

**Mécanisme identifié** (`ui/src/ChatPage.tsx:1067-1072`) :

```tsx
const ids = [...providers.map((p) => p.id), CLAUDE_PROVIDER_ID];
if (!ids.includes(providerId)) {
  setProviderId(ids[0]);   // ← réécrit le choix de l'utilisateur
}
```

`ChatPage` ne reçoit que la LISTE des fournisseurs, jamais son état de
chargement (`ProvidersLoadState` existe pourtant dans `useProviders.ts`) : elle
ne peut donc pas distinguer « pas encore chargés » de « vraiment disparus ».
Pendant la fenêtre où la table est vide — au démarrage, et à chaque
redémarrage du sidecar, dont l'erreur `usage.openrouter` de T-008 est la
signature — `ids` se réduit à `["claude"]`, la condition est vraie, et le
choix de l'utilisateur est remplacé par Claude. Quand les fournisseurs
reviennent, **rien ne le rétablit** : un repli transitoire devient définitif.

Aggravant : le modèle d'une conversation neuve repart sur `Auto (montant)`, et
en mode Auto le routeur choisit LUI-MÊME la cible — le fournisseur affiché
n'est alors plus une consigne mais un résultat. Les deux effets se cumulent et
donnent l'impression que la sélection est ignorée.

Pistes : mémoriser le choix EXPLICITE de l'utilisateur et le rétablir dès que
son fournisseur réapparaît ; ne jamais replier tant que la liste n'est pas
chargée (passer `loadState` à `ChatPage`) ; et rendre visible qu'en mode Auto
la cible est décidée par le routeur, pas par le sélecteur. À couvrir par un
test : liste vide puis peuplée ⇒ le choix survit.

**Réalisé** (fermé le 2026-08-09, même session) : la logique de repli sort dans
un module feuille pur, `ui/src/choixFournisseur.ts`. Trois règles — une liste
VIDE ne décide de rien (c'est une absence d'information, pas une disparition) ;
le choix explicite mémorisé est RÉTABLI dès que son fournisseur réapparaît ;
sinon seulement, repli sur le premier. Six tests, dont le scénario complet :
choix « openrouter », table vidée par un redémarrage du sidecar, table
repeuplée — le choix survit.

### T-016 — Le sidecar annonçait 0.1.0, et un test verrouillait ce mensonge

Constaté le 2026-08-09 en cherchant où vivait le numéro de version pour
l'afficher dans l'en-tête : `sidecar/src/index.ts` portait
`const VERSION = "0.1.0"` alors que les cinq autres déclarations du dépôt
(package.json racine, ui, sidecar, `tauri.conf.json`, `Cargo.toml`) étaient
passées à 0.2.0. L'événement `ready` annonçait donc une version fausse depuis
le passage de version — invisible, puisque rien ne l'affichait encore.

Le détail qui compte : le test protocole assertait `=== "0.1.0"`. Il ne
dormait pas, il **verrouillait la désynchronisation comme comportement voulu**
— le même piège que l'ancien test de périmètre de l'audit (T-011). Un test
peut être vert et garder la porte du mauvais côté.

**Réalisé** (fermé le 2026-08-09, même session) : la version est LUE dans le
`package.json` du sidecar (qui voyage avec lui dans le bundle), avec repli
« inconnue » plutôt qu'un numéro inventé ; le test compare désormais au
`package.json`, plus à un littéral.

### T-014 — CI Windows : un test construisait un chemin sans lettre de lecteur

Constaté le 2026-08-09 sur la **toute première PR** (#5) : le job
`construire (windows-latest)` échoue aux tests du sidecar, l'annotation
donnant la cause sans droits d'administration —
`ECHEC: chemin relatif sain accepté, reçu {"ok":true,"abs":"D:\projet\demo\src\main.ts"}`.
Le job Linux, lui, passe entièrement (AppImage de 205 Mo construite).

**Le code n'était pas en cause.** `neutralAgentPur.test.js` construisait son
répertoire d'essai par `path.join(path.sep, "projet", "demo")`, soit
`\projet\demo` sous Windows : une forme que Windows ne tient pas pour
pleinement qualifiée, et à laquelle `path.resolve` ajoute le lecteur courant.
Le test comparait donc deux écritures du même chemin. La garde
`resolveSafePath` est correcte — elle résout `cwd` avant toute comparaison, y
compris pour le piège du frère préfixé.

Deux enseignements, plus utiles que le correctif :

- c'est le **piège des tests qui testent l'OS**, déjà connu : une assertion
  sur une forme de chemin mesure la plateforme, pas le produit ;
- le test datait de l'étape 6, **jamais publiée**. Aucun runner Windows ne
  l'avait donc jamais exécuté. C'est exactement le trou que le portique par
  PR vient combler : sans lui, ce défaut serait apparu à la prochaine
  release, au pire moment.

**Réalisé** (fermé le 2026-08-09, même session) : le `cwd` d'essai part de la
racine réelle de la plateforme (`path.parse(path.resolve(path.sep)).root`),
soit `/` sous Linux et le lecteur courant sous Windows.

### T-013 — Le miroir des tickets déduisait le dépôt du remote

Constaté le 2026-08-09, dès le premier lancement réel (`npm run tickets:miroir`,
possible seulement une fois `gh` installé) : `gh` répond « none of the git
remotes configured for this repository point to a known GitHub host » et le
script meurt. En local, `origin` est la forge privée — GitHub n'y figure pas,
le script de publication nommant son URL en clair.

Ce qui rend le cas instructif : **la CI ne l'aurait jamais montré**, son
checkout installant un `origin` GitHub. Le défaut ne vivait que là où le
script sert d'abord — sur le poste, en prévisualisation avant d'appliquer. Et
les tests ne pouvaient pas le voir : ils couvrent la logique pure, sans
réseau ni `gh`. Rappel utile — un test vert ne dit rien de l'environnement.

**Réalisé** (fermé le 2026-08-09, même session) : le dépôt cible est désormais
NOMMÉ (`depotCible()`, surchargeable par `GH_REPO` pour un fork ou un dépôt
d'essai) et passé en `--repo` à chaque appel, jamais déduit. Deux tests
couvrent la valeur par défaut et la surcharge.

### T-011 — L'audit de publication ne voyait pas les fichiers non suivis

Constaté le 2026-08-09, ~00h50 : l'audit lancé AVANT `git add` du gabarit
NSIS neuf a rendu vert, puis rouge une fois le fichier commité —
`fichiersSuivis()` reposait sur `git ls-files` seul, donc un fichier neuf
échappait à l'audit au moment exact où il compte (juste avant de le
committer). Un ancien test verrouillait même ce comportement comme voulu
(« un fichier non suivi est hors périmètre »).

**Réalisé** (fermé le 2026-08-09, même session) : `git ls-files --cached
--others --exclude-standard` — les fichiers non suivis entrent dans le
périmètre, les fichiers IGNORÉS restent dehors (`.audit-motifs` en dépend).
Contrat de test inversé + cas nouveau ; au passage, trois hôtes publics du
gabarit NSIS rejoignent la liste relue (go.microsoft.com,
nsis.sourceforge.io, source.chromium.org).

### T-005 — Le débord R3 ignore la fenêtre 7 jours

Constaté le 2026-08-08, 12h03 : bandeau « Fenêtre 7 jours saturée —
réinitialisation dans 8 h » (Semaine 99 %), et pourtant un tour Auto du Chat
part vers `claude-sonnet-5` (abonnement) et reste suspendu. La règle de
débord (`router.route`, R3) ne regarde que `fiveHourPct` — à 79 % ce
jour-là, donc sous le seuil — alors que la fenêtre HEBDOMADAIRE était morte.
L'application SAIT que la semaine est saturée (elle l'affiche en rouge dans
l'en-tête) mais le routeur ne consomme pas cette information.

Piste : ajouter la fenêtre 7 jours aux entrées de la décision de débord
(même source que le bandeau, `usage/claude-windows.jsonl`), avec la même
mécanique que le seuil 5 h — et les mêmes gardes R3 existantes en aval
(cible déclarée, plafond mensuel). Les deux stratégies en profitent :
`resoudreRouteMontante`/`resoudreRouteDescendante` reçoivent déjà le débord
résolu par le sidecar, rien à changer côté feuilles.

**Réalisé** (fermé le 2026-08-09) : `applyDebord` déclenche sur la saturation
de L'UNE OU L'AUTRE fenêtre (même seuil), la décision transporte
`sevenDayPct`, et raisons/badge/bandeau nomment la fenêtre réellement
saturée. Le bloc débord est sorti dans `sidecar/src/debord.ts` (module dédié
à la règle qui parle d'argent — router.ts repasse d'ailleurs sous les 800
lignes) ; scénario rd2c dans routageDebord.test.js : 5 h à 50 %, 7 jours à
100 % → débord actif, raison « 7 jours à 100 % ».

### T-006 — Tour abonnement muet : curseur infini

Même incident : le tour vers l'abonnement saturé n'affiche AUCUN état — pas
d'erreur, pas de « limite atteinte », un curseur qui clignote sans fin (le
SDK réessaie en silence). C'est exactement « l'échec muet » que la doctrine
d'observabilité interdit. Un tour qui n'a reçu aucun octet après un délai
raisonnable doit le dire dans la bulle (« en attente du fournisseur… », puis
« limite d'abonnement atteinte » quand la cause est connue), en laissant
« Arrêter » faire son travail.

**Réalisé** (fermé le 2026-08-09) : `useAttenteFournisseur` — une bulle
assistant en streaming qui n'a RIEN reçu après 10 s affiche « ⏳ Aucune donnée
reçue du fournisseur… », dans les deux pages ; l'avis disparaît au premier
octet (texte, raisonnement ou outil). La variante « cause connue » (limite
atteinte) devient largement théorique une fois T-005 en place : le routeur
n'envoie plus vers un abonnement saturé.

### T-004 — Le fil redescend tout seul pendant un streaming

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-08-07 · **Clos** 2026-08-07

Constaté sur une réponse longue streamée par un modèle rapide (Gemini via OpenRouter, page
Projets) : impossible de remonter dans le fil, la vue « redescend toute seule » à chaque delta.

Cause : l'état « collé en bas » était déduit de la SEULE position au moment de l'événement
`scroll`, avec un seuil de 48 px (`stickToBottomRef`, dupliqué dans `AgentPage.tsx` et
`ChatPage.tsx`). Or le recollage repose le scroll au fond à chaque delta, et l'événement
`scroll` arrive après le geste : une molette de moins de 48 px laissait `stick` à vrai, le
delta suivant redescendait, et rien ne permettait de s'échapper — sauf à jeter la molette d'un
coup sec, hors de la zone.

**Réalisé** : logique sortie dans [ui/src/useStickToBottom.ts](../ui/src/useStickToBottom.ts),
partagée par les deux pages. L'INTENTION prime désormais sur la position — molette vers le
haut, ou `scrollTop` qui recule (ascenseur, PagePrec, tactile), décolle immédiatement quelle
que soit la distance ; et on ne se recolle qu'une fois vraiment au fond (≤ 4 px), pas dès qu'on
repasse sous 48 px. Le recollage en `useLayoutEffect` (correction du 2026-08-04) est conservé.

### T-003 — L'allowlist `tools:` d'un agent n'est pas appliquée (moteur claude)

**Type** bug · **Prio** P1 · **Statut** fait · **Créé** 2026-07-31 · **Clos** 2026-08-07

[protocol.md](protocol.md) § O1 documente `tools: null` = palette complète, « sinon allowlist de
noms d'outils ». Pour une étape d'orchestration portée par un agent `engine: claude`, cette
allowlist **n'est jamais appliquée** : `buildStepStartParams` ([orchestrator.ts:1263-1271](../sidecar/src/orchestrator.ts))
ne transmet que `cwd`, `prompt`, `model`, `permissionMode`, `systemPrompt`, `chatOnly` — jamais
`tools` ; et côté [claude.ts:694](../sidecar/src/claude.ts), `options.tools` n'est posé que sur la
branche `chatOnly` (WebSearch/WebFetch). Le champ est donc purement **déclaratif** : l'agent
reçoit la palette complète quoi qu'il déclare.

Gravité : les tâches planifiées tournent en `permissionMode: bypassPermissions` (obligatoire en
headless — aucun humain pour répondre au flux de permission), donc un agent qui déclare
`tools: [Read, Grep, Glob]` dispose en réalité de Write, Edit et Bash sans aucune barrière. Le
seul garde-fou effectif aujourd'hui est le **prompt** de l'agent, ce qui n'est pas une frontière
de sécurité. Découvert le 2026-07-31 en écrivant l'agent `analyste-qualite` (lecture seule
voulue), dont le README avertit du problème en attendant.

**Réalisé** — `buildStepStartParams` transmet désormais `agent.tools` aux DEUX moteurs, et :

- côté [claude.ts](../sidecar/src/claude.ts), l'allowlist devient `options.tools` (base d'outils
  intégrés exposée au modèle) et **non** `options.allowedTools` comme envisagé à l'ouverture du
  ticket : ce dernier ne fait qu'auto-approuver sans rien retirer de la palette, donc n'aurait
  rien restreint précisément sur les tours `bypassPermissions` visés. Les noms `mcp__*` sont
  écartés de la liste : les outils MCP entrent par `mcpServers` et se gouvernent par le champ
  `mcp` du manifeste — `mcp__studio__ask_user` et `mcp__iaction__*` restent donc disponibles
  quelle que soit l'allowlist ;
- symptôme confirmé côté moteur neutre : `TOOLS` était bien une constante. Les outils sont
  maintenant filtrés à la déclaration ET refusés à l'exécution. Comme les noms neutres ne sont
  pas ceux de Claude Code et qu'un agent `engine: auto` ignore où il tombera, les noms Claude
  sont acceptés et traduits (`Read` → `read_file`…) ; `search_knowledge` (RAG, lecture seule)
  échappe à l'allowlist comme le MCP côté Claude ;
- l'allowlist s'applique aussi aux tours lancés depuis la page Projets avec un agent
  sélectionné, où le champ était tout aussi décoratif.

Fermé par défaut : une allowlist qui ne désigne aucun outil connu laisse l'agent SANS outil,
jamais avec la palette complète. Contrat dans [protocol.md](protocol.md) (`claude.start`,
`neutral.start`, « Forme d'un agent »), couverture dans `protocol.test.js` (cas `mcp-e3`/`mcp-e4`).

### T-002 — Lien « dernier rapport qualité » dans la page Système

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-07-31 · **Clos** 2026-08-07

Dernier point du § 2.6 de [etude-logs.md](etude-logs.md), non fait en L5 : le panneau
« Journal » de la page Système doit exposer un lien vers le **dernier rapport** de la tâche
`qualite-iaction` (`taches.reports` + `taches.reportRead`, rendu par le composant `Markdown`
existant), pour que la boucle *journal → rapport hebdo → ticket* se voie depuis l'endroit où
l'on constate les erreurs. Discret et tolérant : la tâche n'est pas forcément installée — sans
rapport, pas de lien, pas d'erreur affichée.

**Réalisé** : bouton « ▤ Dernier rapport qualité · <date> » dans les actions du panneau Journal
([SystemPage.tsx](../ui/src/SystemPage.tsx)), qui ouvre le rapport dans une modale rendue par
`Markdown`. Aucune méthode nouvelle. Tolérance : toute erreur de `taches.reports` (tâche
absente, sidecar sans `taches.*`) se solde par l'absence du bouton, jamais par un message
d'erreur dans un panneau qui parle d'autre chose.

### T-001 — Page « Tickets » dans l'app

**Type** feat · **Prio** P3 · **Statut** fait · **Créé** 2026-07-22 · **Clos** 2026-07-31

Exposer ce backlog dans l'UI (page dédiée façon `OrchestrationPage`, méthodes `tickets.*` côté
sidecar) au lieu d'éditer le markdown à la main. Nécessite : `ui/src/TicketsPage.tsx`,
`ui/src/ticketsClient.ts`, `sidecar/src/tickets.ts`, et la section correspondante dans
[docs/protocol.md](protocol.md).

À ne lancer que si le fichier montre ses limites (trop de tickets, suivi pénible).

**Réalisé** sous la forme d'un panneau « Tickets » de la page Système en **lecture seule**
(méthode `tickets.list`, voir [protocol.md](protocol.md) § TK1), et non de la page dédiée avec
CRUD initialement envisagée : ce fichier reste édité à la main et versionné.
