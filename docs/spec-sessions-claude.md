# Spec — Panneau « Sessions Claude » (T-159)

> Rédigée le 2026-10-20. Origine : faire communiquer les sessions Claude entre
> elles et avec le poste Région sans passer par un relais maison (voir
> `docs/etude-mobile.md`, option O0 Remote Control).

## Besoin

Depuis IAction : **voir les sessions Claude Code ouvertes sur ce poste**,
**en reprendre une** dans IAction, et **accéder aux sessions des autres
machines** (Remote Control).

## Ce que la plateforme permet (vérifié le 2026-10-20, CLI 2.1.304)

- `claude agents --json` imprime les sessions actives **de ce poste**
  (interactives et d'arrière-plan) : `pid`, `cwd`, `kind`, `startedAt` (ms),
  `sessionId`, `name`, `status` (`busy`/`idle`…). `--all` ajoute les sessions
  d'arrière-plan terminées. Pas de TTY requis.
- Les sessions **d'autres machines** ne sont visibles que depuis une session
  connectée en Remote Control (`ListAgents`), et leur **prise de contrôle**
  n'existe que dans claude.ai/code ou l'app mobile Claude. Le SDK n'expose
  aucune méthode pour les lister ou s'y attacher : IAction ouvre donc
  claude.ai/code, il ne réimplémente pas Remote Control.
- Le SDK sait reprendre une session par `resume: <sessionId>` ; avec
  `forkSession: true` il en crée une **copie** au lieu d'écrire dans le
  transcript d'origine.

## Comportement attendu

1. **Liste** — un panneau « Sessions Claude » (accès depuis la barre de
   navigation) affiche les sessions : nom, projet (dernier segment du `cwd`,
   chemin complet au survol), type, état, démarrage (heure relative + absolue
   au survol). Bouton « Rafraîchir ». Option « Inclure les terminées » (`--all`).
2. **Reprendre dans IAction** — ouvre une nouvelle conversation IAction
   reprenant la session **en copie** (`resume` + `forkSession: true`), jamais
   en écriture dans la session d'origine (elle peut être vivante). Actif
   seulement si le `cwd` correspond à un projet connu d'IAction ; sinon bouton
   désactivé avec l'explication au survol. Si le modèle de conversation
   d'IAction ne permet pas cette reprise sans refonte, repli : « Copier la
   commande » (`cd <cwd> && claude --resume <id> --fork-session`) — et le
   signaler.
3. **Contrôle à distance** — bouton d'en-tête « Sessions des autres machines »
   qui ouvre `https://claude.ai/code` (voie `ouvrirLienExterne`), avec une
   ligne d'aide : « lancer `/remote-control` dans la session à piloter ».
4. **Copier l'identifiant** de session (pour `SendMessage`, `claude attach`…).

## Exigences

- **Aucun échec muet** : CLI `claude` introuvable, délai dépassé (15 s), JSON
  invalide, code de sortie non nul → message clair dans le panneau ET entrée
  au journal. Résolution du binaire : réutiliser celle qui existe déjà dans le
  sidecar s'il y en a une, sinon `claude` du PATH ; sous Windows, penser au
  binaire de l'extension VSCode si le PATH n'en a pas.
- Le sidecar porte l'appel (le front ne lance pas de processus) ; nouveau
  message de protocole documenté dans `docs/protocol.md`.
- Tests : analyse du JSON (champs manquants tolérés), binaire absent, délai,
  calcul du libellé de projet — attendus calculés avec `path.*`, jamais de
  chemin absolu en dur (piège Windows).
