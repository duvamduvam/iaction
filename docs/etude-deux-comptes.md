# Étude — Utiliser deux comptes Claude dans IAction

> Rédigée le 2026-11-05, **non grillée**. Aucun code modifié. **P0 réalisée le
> même jour avec le vrai second compte : concluante (§ 7 bis).** Les conditions
> d'Anthropic ont été lues le même jour ; ce qui en est dit ici est une lecture,
> pas un avis juridique.

## 0. La réponse courte

**Techniquement oui, et sans gros chantier.** Claude Code documente lui-même
le multi-compte : un dossier de configuration par compte (`CLAUDE_CONFIG_DIR`).
IAction lance déjà le CLI avec un environnement qu'il compose, et le sidecar
naît d'un seul point (`commande_sidecar`, `src-tauri/src/sidecar.rs:215`).

**La vraie question est l'usage, pas la technique :**

| Pourquoi deux comptes ? | Verdict |
|---|---|
| Séparer deux activités (pro / perso), chacun ses limites et sa facture | Propre : c'est le cas que la doc décrit |
| Additionner deux quotas, en choisissant le compte par projet | Zone grise : rien ne l'interdit nommément, rien ne l'autorise |
| Basculer **automatiquement** sur le compte 2 quand le 1 sature | **À écarter** : c'est la forme qui ressemble le plus à un contournement des limites |
| Utiliser le compte d'une autre personne | **Interdit** : partage d'identifiants (Consumer Terms) |

Recommandation : voie A (§ 3), choix **manuel** du compte, jamais de bascule
automatique, et IAction ne touche jamais aux identifiants.

## 1. État constaté

**Le poste.** Un compte `claude.ai`, abonnement Max, palier
`default_claude_max_5x`. CLI global 2.1.304, CLI embarqué par le SDK 2.1.292
(SDK 0.3.292).

**Tests du 2026-11-05** (`claude auth status`, aucune requête modèle) :

- `CLAUDE_CONFIG_DIR` vers un dossier vide → `loggedIn: false`, identifiants
  **et** `projectsDirectory` déplacés. Le CLI embarqué se comporte pareil.
- `CLAUDE_CODE_OAUTH_TOKEN` factice → `authMethod: oauth_token`, le dossier de
  configuration reste `~/.claude`. Le statut ne valide pas le jeton : ce test
  ne prouve que la lecture de la variable.

**Le code : ce qui suppose un compte unique.**

| Endroit | Hypothèse | Conséquence à deux comptes |
|---|---|---|
| `sidecar/src/claude.ts:547` | Env du tour = `process.env` + clé API | Point d'injection du compte, par tour |
| `sidecar/src/claudeCommands.ts:98` | Idem | Menu « / » à aligner sur le compte du tour |
| `sidecar/src/claudeUsage.ts:293` | Micro-tour sans `env` | Sonde toujours le compte du processus |
| `sidecar/src/claudeSessionTitles.ts:95` | `listSessions()` n'a pas d'option de dossier de config : il suit l'env du sidecar | Ne voit que les sessions du dossier du sidecar |
| `sidecar/src/sessionsDistantes.ts:66` | Jeton lu dans le dossier du sidecar | Sessions distantes d'un seul compte |
| `sidecar/src/fenetresAbonnement.ts:23` | Un seul `claude-windows.jsonl`, sans clé de compte | **Historiques mélangés** |
| `sidecar/src/debord.ts:81` | Lit le dernier relevé, quel qu'il soit | **Décide sur les limites du mauvais compte** |
| `ui/src/encartConso.tsx` | Une seule jauge | Affiche un compte sans dire lequel |

`sessionsDistantes.ts`, `appPaths.ts` et les agents honorent déjà
`CLAUDE_CONFIG_DIR`. La clé API existe côté sidecar (`claude.configure`), mais
`claudeConfigure` n'a aucun appelant dans `ui/src` : ce chemin est mort
aujourd'hui.

## 2. Ce que `CLAUDE_CONFIG_DIR` emporte avec lui

C'est le piège de la voie documentée. Le dossier ne contient pas que le compte :
il contient aussi tout ce qu'IAction hérite du poste.

| Contenu | Un dossier neuf le perd ? | Traitement proposé |
|---|---|---|
| `.credentials.json` | Oui, c'est le but | **Propre au compte** |
| `.claude.json` (compte, confiance, MCP de portée utilisateur) | Oui | **Propre au compte**, ne pas lier |
| `skills/`, `commands/`, `agents/`, `hooks/`, `plugins/`, `settings.json` | Oui | Lien symbolique vers `~/.claude` |
| `projects/` (transcripts **et mémoire automatique**) | Oui | Lien symbolique vers `~/.claude` |
| `history.jsonl`, `sessions/`, `session-env/`, `file-history/`, `ide/`, caches | Oui | Propre au compte : état vif, ne pas partager |

Sans ces liens, le compte 2 repart sans skills, sans agents, sans mémoire et sans
historique. Avec eux, il ne reste de séparé que le compte.

Lier `projects/` règle aussi `listSessions()` : les conversations des deux
comptes vivent au même endroit. Sous Windows, un lien symbolique demande le mode
développeur ou une jonction : à traiter si le besoin y va.

## 3. Les deux voies

### Voie A — un dossier par compte (recommandée)

Le second compte se connecte une fois, dans un terminal, par le flux d'Anthropic :

```bash
CLAUDE_CONFIG_DIR=<dossier-compte-2> claude auth login
```

IAction ne voit jamais de jeton. Il passe seulement `CLAUDE_CONFIG_DIR` au CLI.

- **Pour :** voie documentée. Toutes les portées sont conservées, donc le relevé
  de limites et les sessions distantes devraient marcher (à prouver). Le CLI gère
  seul le rafraîchissement du jeton. Des dossiers séparés évitent aussi la course
  au rafraîchissement signalée entre sessions concurrentes (issue #54443).
- **Contre :** les liens du § 2 à poser et à entretenir.

### Voie B — un jeton `setup-token` par compte (écartée)

`CLAUDE_CODE_OAUTH_TOKEN` dans l'env du tour, jeton d'un an rangé au trousseau.
Simple en apparence, car `~/.claude` reste en place. Trois raisons de refuser :

1. **Le mauvais compte, en silence.** L'issue #68241 rapporte qu'un
   `.credentials.json` peut masquer la variable, à l'inverse de l'ordre documenté.
   Ici, ce fichier est celui du compte 1, et il est valide : un tour « compte 2 »
   pourrait consommer le compte 1 sans le moindre signal. L'issue est close sans
   réponse d'Anthropic, et rien ne dit que c'est corrigé en 2.1.292.
2. **Conso aveugle.** La doc dit que ce jeton « can only make model requests ».
   Le relevé de limites risque de ne plus répondre, et le débord avec lui. Les
   sessions distantes sont exclues pour la même raison.
3. **Conditions.** La page légale dit que les développeurs ne peuvent pas
   « collect, store, or intermediate Claude.ai credentials or session tokens ».
   Faire stocker le jeton par IAction est précisément ce geste.

Le runner Docker garde son jeton : c'est son usage prévu (`docker/ia-runner`), et
il n'a pas de compte concurrent sur la machine.

## 4. Ce que disent les conditions d'Anthropic

Texte lu le 2026-11-05. **Les Consumer Terms ont été lus via un résumé
automatique**, et l'Usage Policy affichait une date d'effet au 12 novembre 2026 :
à relire en direct avant de s'y appuyer.

- **Plusieurs comptes :** aucune interdiction ni autorisation générale trouvée.
  La seule mention de l'Usage Policy vise les comptes multiples créés pour éviter
  la détection ou contourner des garde-fous, et le contournement d'un bannissement.
- **Partage :** « You may not share your Account login information […] with
  anyone else. »
- **Limites :** les plans « assume ordinary, individual usage of Claude Code and
  the Agent SDK ». Les Consumer Terms interdisent de contourner « any of our
  systems or protective measures ». Rien ne nomme le cumul de deux abonnements.
- **Applications tierces :** les développeurs ne peuvent pas offrir le login
  claude.ai dans leur produit, ni router des requêtes via ces plans « on behalf
  of their users ». Anthropic se réserve d'agir « without prior notice ».

**Ce que j'en conclus.** L'usage personnel d'IAction avec son propre abonnement
n'est tranché par aucun texte lu ; il existe déjà aujourd'hui et le second compte
ne le change pas. Deux choses aggraveraient le risque : la bascule automatique,
et un sélecteur de compte dans la **version publiée**, qui ressemblerait à une
offre de login dans un produit distribué. Avoir deux comptes à soi et choisir
lequel utiliser n'a rien de fautif dans les textes lus. Les mesures « without
prior notice » visent les contournements : c'est une raison d'écarter la bascule
automatique, pas une menace sur le choix manuel.

**Pour lever le doute :** poser la question au support d'Anthropic, par écrit,
avant d'acheter un second abonnement pour cumuler.

**Si le but est juste d'avoir plus de quota**, deux options sans aucune zone grise :
le palier Max supérieur (le poste est en 5x ; tarif à vérifier), ou une clé API
plafonnée, déjà prévue côté sidecar. Le débord vers OpenRouter couvre déjà une
partie du besoin.

## 5. Quel commutateur : global ou par projet ?

| | **Global** (un compte actif) | **Par projet** |
|---|---|---|
| Mécanisme | Variable posée sur le sidecar, qui redémarre | `env` composé à chaque tour |
| Code | Petit : un point, tout le sidecar suit | Les sites du § 1, un par un |
| Tours en cours | **Coupés au changement** | Intacts |
| Tâches de fond | Suivent le compte actif | Suivent leur projet |
| Deux comptes en même temps | Non | Oui |
| Adapté à | Basculer de temps en temps | Séparation pro / perso stable |

**Dès aujourd'hui, sans code :** lancer IAction avec `CLAUDE_CONFIG_DIR` posé
donne déjà le commutateur global, puisque le sidecar hérite de l'environnement.
Seul défaut : l'historique de conso se mélange.

**Choix de l'utilisateur (2026-11-05) : un sélecteur de compte dans le moteur**,
et les jauges suivent le compte sélectionné. Ni redémarrage du sidecar, ni
attribut de projet : le compte part avec le tour, comme le modèle. Les tours en
cours ne sont donc pas coupés. Forme retenue : une entrée de plus dans la liste
« Moteur » du panneau LLM, à côté de « Claude (abonnement) », plutôt qu'une
nouvelle liste.

Changer de compte ne demande pas de reconnexion : chaque dossier garde la sienne,
et le CLI la rafraîchit seul. **Limite à prouver :** le fichier d'identifiants
porte un `refreshTokenExpiresAt`, à environ 8 jours le 2026-11-05 (une seule
observation). Si ce délai repart à chaque usage, un compte inutilisé plus de 8
jours redemandera `claude auth login`. La sonde de conso du compte non sélectionné,
nécessaire aux jauges, le garderait peut-être actif. Dans tous les cas, IAction
doit annoncer un compte déconnecté avec la commande à lancer (§ 6).

Un module unique `compteClaude.ts` rendrait l'env d'un compte, comme
`aiguillerVersCliEmballe` centralise déjà l'exécutable, pour ne pas recopier la
règle dans chaque site.

## 6. Ce qu'il faut changer quel que soit le commutateur

- **Conso par compte.** Dépôt d'usage indexé par compte, champ `compte` dans
  `claude-windows.jsonl` ; les lignes anciennes valent compte principal.
  L'historique « ne se reconstitue pas » : ce point passe **avant** le premier
  usage réel du compte 2 dans l'application.
- **Débord.** Décider sur les fenêtres du compte du tour, jamais sur le dernier
  relevé venu. Module qui parle d'argent : revue dédiée. Le débord reste vers la
  cible payante déclarée, pas vers l'autre compte.
- **Aucun échec muet.** Chaque tour journalise son compte. Au démarrage, comparer
  le compte attendu à `claude auth status`, et refuser le tour si le dossier est
  déconnecté, plutôt que d'échouer plus loin en erreur d'authentification.
- **Interface.** Le nom du compte visible à côté de la jauge et dans le pied de
  conversation.
- **Conversations.** Enregistrer le compte qui a servi. Changer de compte en
  cours de conversation perd le cache de prompt : le contexte entier est relu et
  décompté. Si P0 montre que la reprise croisée échoue, la conversation reste
  attachée à son compte.

## 7. Découpage

| Phase | Contenu | Prérequis |
|---|---|---|
| **P0 — preuve** | Sans code. Second compte connecté, liens du § 2. Prouver : tour réel, `resume` d'une session du compte 1 depuis le compte 2 (signatures de réflexion ?), relevé de limites, `projects/` en lien symbolique, deux tours simultanés | Un second compte ; lancement par l'utilisateur |
| **P1 — conso fiable** | Dépôt, historique et débord par compte, compte journalisé | P0 concluant |
| **P2 — sélecteur** | `compteClaude.ts`, sélecteur de compte dans le moteur, jauges qui suivent le compte, compte des tâches de fond | P1 |
| **P3 — préparation guidée** | Script qui pose les liens du § 2 et affiche la commande de connexion (qui reste celle du CLI) | Si le besoin dure |

La fonction reste hors de la version publiée, au moins jusqu'à la réponse du
support (§ 4).

## 7 bis. Résultats de P0 (2026-11-05)

Compte 1 : Max 5x. Compte 2 : **Team**, autre adresse, autre organisation.
Dossier `~/.claude-compte2`, liens du § 2. Tours lancés par le SDK 0.3.292 et le
CLI embarqué 2.1.292, avec `CLAUDE_CONFIG_DIR` passé dans `options.env`, comme le
ferait IAction.

| Test | Résultat |
|---|---|
| Tour réel sur le compte 2 | OK, `apiKeySource: none` |
| Deux tours simultanés, un par compte | OK, aucun des deux comptes déconnecté |
| Relevé de limites par compte | OK : Max 48 % / 69 %, Team 0 % / 0 % (5 h / 7 j), `subscription_type` juste |
| Agents | 12 des deux côtés |
| Skills | 35 / 31 : le compte Team n'a pas `built-in-browser`, `chrome-browser`, `computer-use` ni `deep-research` (skills `anthropic-skills:`, liés au compte) |
| `projects/` en lien symbolique | OK, les deux comptes lisent le même transcript |
| Reprise compte 1 → 2 → 1, sans réflexion | OK, le contexte est retrouvé |
| Reprise compte 1 → 2 avec bloc de réflexion signé | OK, sur un seul bloc |
| Cache au changement de compte | Perdu (`cache_read` à 0) ; retrouvé en revenant au compte 1 dans la foulée |

Conséquences : **le changement de compte en pleine conversation est possible**, le
repli « conversation attachée à son compte » du § 6 n'est pas nécessaire. Le
sélecteur peut donc rester libre, avec le coût du cache comme seul prix.

**Non prouvé :** la tenue dans la durée (expiration à 8 jours, § 5), les sessions
distantes sur le compte 2, une longue conversation réelle avec de nombreux blocs de
réflexion.

**Un compte Team change le § 4.** Il relève des Commercial Terms, non lus pour
cette étude. L'organisation peut pousser des réglages et des limites : le CLI a
déposé `remote-settings.json` (vide) et `policy-limits.json`, qui porte
`allow_remote_control: false` : **pas de Remote Control sur ce compte**, à prendre
en compte pour `docs/etude-mobile.md`. Si
l'organisation n'est pas celle de l'utilisateur, y mettre des projets personnels
relève aussi de ses règles.

## 8. Questions à trancher

1. **Pourquoi deux comptes ?** Séparation ou quota ? Cette réponse décide de tout
   le reste (§ 0).
2. ~~Le second compte existe-t-il ?~~ **Oui, abonnement Team d'une organisation
   tierce, l'employeur ou le client de l'utilisateur (2026-11-05).** L'usage visé
   est donc la séparation : le travail pour cette organisation sur son compte, le
   reste sur le compte perso. Reste à vérifier auprès d'elle que ce compte peut
   passer par un outil personnel comme IAction, sur ce poste.
3. ~~Quel compte pour les tâches de fond ?~~ **Le compte principal, y compris pour
   le projet de travail (2026-11-05) :** l'utilisateur juge que le siège Team standard ne suffira
   pas pour avancer.
4. ~~Une même conversation peut-elle changer de compte ?~~ **Oui, prouvé en P0.**
5. Windows est-il concerné (liens symboliques) ?
6. Les tâches de nuit et le runner Docker doivent-ils changer de compte ?

## 9. Sources (consultées le 2026-11-05)

Officielles :

- [Authentication — Claude Code Docs](https://code.claude.com/docs/en/authentication)
  (multi-compte, `setup-token`, ordre de priorité)
- [Explore the .claude directory](https://code.claude.com/docs/en/claude-directory)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) <!-- audit-publication:ok -->
- [Usage Policy](https://www.anthropic.com/legal/aup) <!-- audit-publication:ok -->
- [Use Claude Code with your plan](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) <!-- audit-publication:ok -->

Anecdotiques (issues closes sans réponse d'Anthropic) :

- [#54443](https://github.com/anthropics/claude-code/issues/54443) — course au
  rafraîchissement entre sessions concurrentes, cause non confirmée
- [#68241](https://github.com/anthropics/claude-code/issues/68241) —
  `CLAUDE_CODE_OAUTH_TOKEN` masqué par un `.credentials.json` périmé
