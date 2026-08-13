# Journal des versions

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
versions selon [SemVer](https://semver.org/lang/fr/).

> Ce journal est tenu à la main, et c'est voulu : l'historique public est fait
> d'instantanés (un commit par publication, voir `docs/github.md`), donc des
> notes de version générées depuis les messages de commit ne diraient rien.
> Les entrées commencent à la 0.3.0 ; les versions antérieures ne sont pas
> reconstituées après coup.

## [0.3.1] — 2026-08-13

### Ajouté

- **Sélecteur de modèle lisible** : les fournisseurs qui servent des centaines
  de références ne déversent plus leurs slugs bruts dans une liste déroulante —
  recherche, regroupement et favoris sans doublon (T-032).
- **Supervision — carte « Dépense de la période »** : la dépense RÉELLE de la
  période, tous tours payants confondus, à côté du « Débord du mois » qui ne
  compte que le routage automatique. On pouvait dépenser sans qu'aucun écran ne
  l'affiche (T-035). Tant que des tours payants ne remontent pas de coût, la
  carte annonce un minorant explicite plutôt qu'un faux total (T-036).
- **Supervision — graphique de courbes** des quatre indicateurs, tracé sur le
  cran de période au-dessus de la sélection (jour → sa semaine, semaine → son
  mois, mois → son année), séries indexées sur leur propre pic pour tenir sur un
  axe unique, palette vérifiée par calcul (contraste et séparation daltonisme).

### Corrigé

- **Supervision : Jour et Semaine affichaient les mêmes chiffres.** La
  granularité ne pilotait que l'histogramme, jamais la période d'analyse : les
  deux modes interrogeaient la même fenêtre de 30 jours, et ◀ ▶ sautait d'un
  mois entier en mode Semaine. La sélection EST désormais la période — un jour,
  la semaine ISO, le mois calendaire — et ◀ ▶ avance d'une période (T-033).

### Interne

- `usage.stats` rend `coutPeriodeUsd` et `coutInconnuTours` (`docs/protocol.md`).
- La résolution « à quel projet appartient ce tour » sort de `usageStats.ts`
  dans `usageProjets.ts` : 869 → 662 lignes, sous sa dérogation de taille.
- Cliquet de taille : dérogation datée pour `src-tauri/src/sidecar.rs` (807
  lignes) afin que `npm run verif` cesse d'être rouge en permanence — le
  découpage réel reste dû (T-034). Gains verrouillés sur cinq autres fichiers.
- CI : un test neuf construisait un chemin en `/D:/…` et ne tombait que sur le
  runner Windows (T-037) ; l'étape de construction recopie désormais son échec
  en annotation, seule sortie lisible sans droits d'administration (T-038).
- **L'installeur Windows ne compilait plus** : `ModelPicker.tsx` et
  `modelPicker.ts` sont quatre fichiers sous Linux, deux sous Windows. Feuilles
  de logique renommées en `…Calc.ts`, et un garde-fou (`npm run casse`) refuse
  désormais toute collision de casse depuis n'importe quel système (T-039).
- **Le paquet livré n'embarquait pas la version testée.** Le manifeste du
  bundle reprenait des plages de versions et se réinstallait sans verrou : la
  0.3.1 Windows distribuée porte le CLI Claude 0.3.231 là où toute la chaîne a
  été validée en 0.3.214. Les versions sont désormais figées sur l'installé, et
  le journal d'empaquetage les annonce (T-042).
- **L'AppImage Linux ne se construisait plus** : linuxdeploy réécrit le CLI
  Claude avec `patchelf`, le casse, puis abandonne en lui reprochant de l'être.
  Le CLI voyage maintenant compressé dans le paquet (253 → 90 Mo) et se détend
  au premier lancement dans un dossier inscriptible (T-038).

## [0.3.0] — 2026-08-09

### Ajouté

- **Températures dans les indicateurs de l'en-tête** : processeur (lecture
  `/sys/class/hwmon`, puces `coretemp`/`k10temp`/`zenpower`, `acpitz` en
  dernier recours) et carte graphique (même requête `nvidia-smi` que les
  autres champs GPU). Une sonde mémoire existe mais reste muette faute de
  capteur sur la plupart des machines. Aucune dépendance ajoutée.
- **Version de l'application dans l'en-tête**, injectée à la compilation
  depuis le `package.json` racine — la même valeur que l'installeur.
- **Publication par pull request** (`npm run publier`) : l'instantané passe
  par un portique qui rejoue la chaîne complète sur deux machines vierges,
  Linux et Windows, avant toute fusion.
- **Analyse CodeQL** (TypeScript, Rust et les workflows) à chaque poussée et
  chaque semaine.
- **Miroir des tickets vers les issues GitHub** : `docs/tickets.md` reste la
  source de vérité, les issues en sont la vitrine.
- **Garde de cohérence des versions** (`npm run version:verifier`) : les cinq
  déclarations du dépôt doivent concorder, sous peine d'échec de `verif`.
- **Installeur Windows** : la mise à jour ne désinstalle plus par défaut
  (gabarit NSIS désormais possédé par le dépôt).

### Corrigé

- Le débord d'abonnement ignorait la fenêtre 7 jours et pouvait router vers un
  abonnement saturé (T-005).
- Un tour d'abonnement en attente affichait un curseur infini sans rien dire
  (T-006).
- Le « ne plus demander » des permissions fuyait d'un projet à l'autre.
- L'audit de publication ne voyait pas les fichiers non suivis par git (T-011).
- Le sidecar annonçait une version fausse ; elle est désormais lue, plus
  recopiée (T-016).
- Le fournisseur choisi dans le Chat retombait silencieusement sur Claude
  quand la table des fournisseurs était momentanément vide, sans jamais être
  rétabli (T-018).

### Observabilité

- Un tour qui échoue écrit désormais dans le journal applicatif : sous-type,
  session, modèle, et la pile en cas d'exception — jamais le corps de la
  réponse (T-015).
- **Plafond de silence au démarrage d'un tour** : sans le moindre message du
  moteur dans le délai imparti, le tour devient un échec daté au lieu d'une
  attente infinie.
- La coquille journalise la **mort** du sidecar — cause, signal, durée de vie,
  dernières lignes de sa sortie d'erreur — et distingue un premier démarrage
  d'une relance (T-017).

### Interne

- Étude de structure soldée : `AgentPage` 5 558 → 2 936 lignes, `claude.ts`
  1 826 → 1 497, registre de permissions par couche, `sidecar.rs` sorti des
  dérogations de taille.
- Couverture de l'interface portée de 64 à 239 tests — conséquence du
  découpage, pas d'un effort séparé.
