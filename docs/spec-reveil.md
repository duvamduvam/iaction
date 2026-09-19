# Spec — Réveil d'une conversation (V1, application ouverte)

Statut : implémentée (V1, application ouverte). Ticket [T-120](tickets.md#t-120).

## 1. Le besoin

Une session saturée s'arrête net : « You've hit your session limit · resets
7:10pm ». Le travail est prêt, la machine est libre, et pourtant plus rien ne
part avant que l'utilisateur ne revienne cliquer. Les heures creuses (nuit,
réinitialisation de la fenêtre de 5 h à 3 h du matin) sont perdues une par une.

Le réveil règle exactement ça : **« reprends ce travail à telle heure »**,
attaché à une conversation, avec la ou les heures que l'utilisateur choisit.

## 2. Le principe : un réveil ne fait qu'UNE chose

Le mécanisme d'envoi différé existe déjà et il est éprouvé : les prompts mis en
file pendant un streaming (`ConvRuntime.queuedPrompts`) partent un par un à la
fin de chaque tour, via un effet jumeau dans les deux pages
([ChatPage.tsx:1638](../ui/src/ChatPage.tsx#L1638),
[AgentPage.tsx:1716](../ui/src/AgentPage.tsx#L1716)).

Un réveil n'ajoute donc **aucun chemin d'envoi**. Il fait une seule chose :

> à l'échéance, il verse ses prompts dans `queuedPrompts`, puis il est
> RETIRÉ des armés et versé à l'historique.

Le drainage existant s'occupe du reste — c'est lui qui appelle `handleSend`,
lui qui gère le streaming, le routage, l'abandon. Toute la logique déjà
validée reste sur le chemin nominal ; le réveil n'est qu'une **retenue dans le
temps**, pas un second moteur.

C'est la contrainte de conception principale de cette spec : si
l'implémentation finit par dupliquer un envoi, elle a manqué la cible.

### 2.1 Un réveil ne sert qu'une fois — et laisse une trace

Le premier jet gardait armé un réveil doté d'heures : ayant sonné à 11:18, il
se réarmait pour le lendemain 11:18. Constat du 2026-09-04 : ce n'est pas ce
qu'on demande à un réveil de travail. « Reprends CE travail à telle heure »
est une **promesse datée**, pas un abonnement — la relancer chaque jour ferait
repartir, sans le demander, un travail dont le contexte a changé.

Déclenché **ou abandonné**, un réveil est donc consommé : retiré de la liste
des armés, écrit dans `reveilsHistorique`.

L'historique n'est pas un ornement. Sans lui, un réveil disparaîtrait de
l'écran sitôt son travail fait, et l'utilisateur qui revient au matin n'aurait
aucun moyen de savoir ce qui est parti, ni quand, ni si quelque chose a été
abandonné. La ligne posée dans le fil (§6) le dit pour la conversation active
à l'instant T ; elle est éphémère. L'historique reste, plafonné à
`HISTORIQUE_REVEILS_MAX` (20) — c'est une trace de travail, pas une archive,
et elle voyage dans le document de session.

Un réveil **abandonné** y figure au même titre qu'un réveil parti, marqué
comme tel : c'est même l'information la plus utile des deux.


## 3. Modèle de données

Une conversation porte une **LISTE** de réveils, persistée à côté de
`claudeSessionId` — `ChatSession` et `ProjectSession` gagnent le même champ :

```ts
/** Réveils armés sur cette conversation. Voir docs/spec-reveil.md. */
reveils: Reveil[];
/** Réveils déjà passés (déclenchés ou abandonnés), plafonnés à 20. */
reveilsHistorique: ReveilHistorise[];
```

```ts
export interface Reveil {
  /** Identité stable — c'est elle qui permet de MODIFIER un réveil au lieu de le remplacer. */
  id: string;
  /** Heures de mur locales « HH:MM », récurrentes chaque jour. Peut être vide si `surResetQuota`. */
  heures: string[];
  /** Réveil supplémentaire dès que la fenêtre de quota se rouvre (voir §4.2). */
  surResetQuota: boolean;
  /** Instant (ISO) de réouverture VISÉ, figé à l'armement — `null` si aucune n'était connue. */
  cibleReouverture: string | null;
  /** Ce qui partira au réveil. Vide = réveil sans effet, donc refusé à l'armement. */
  prompts: string[];
  /** Dernier déclenchement effectif (ISO) — anti-double-tir et rattrapage, voir §4.3. */
  dernierDeclenchement: string | null;
}
```

**Une liste, et pas un réveil unique — corrigé après usage.** Le premier jet
n'en portait qu'un par conversation, ses heures partageant un unique message.
Constat du 2026-09-04 : on veut « à 03:00 reprends le chantier A, à 07:00
lance le bilan B » — deux promesses différentes, pas deux horaires d'une même
promesse. Et sans `id`, revenir sur un réveil était impossible : on ne pouvait
que le détruire.

`heures` reste au pluriel DANS un réveil : « le même message à 03:00 et à
08:00 » est un besoin réel (les fenêtres de quota se rouvrent toutes les 5 h),
et l'exprimer par deux réveils jumeaux serait une duplication à maintenir à la
main.

**Pourquoi `prompts` ici et pas dans `queuedPrompts`** : les deux files n'ont
pas la même durée de vie. `queuedPrompts` est vif, intra-tour, jamais persisté
— il est correct qu'il disparaisse au rechargement. Le contenu d'un réveil
armé pour 3 h du matin doit au contraire survivre, sinon la fonctionnalité est
un piège : l'utilisateur se couche en croyant le travail programmé, et ne
trouve rien au matin. Deux durées de vie, deux champs.

### 3.1 Un réveil n'existe que persisté — le défaut du 2026-09-04

Le paragraphe ci-dessus décrivait le piège ; le premier jet est tombé dedans.
Armer un réveil n'écrivait que le **runtime**. Or la persistance des pages n'a
lieu qu'aux gestes qui la déclenchent déjà (envoi, bascule de conversation,
suppression) — armer un réveil n'en était pas un. Résultat : un réveil armé
disparaissait au moindre rechargement de l'UI, **sans un mot**. C'est
précisément ainsi qu'un réveil de test n'a pas fonctionné.

D'où `gererReveils` (`reveilRuntime.ts`), qui prend un `persister` **dans sa
signature** plutôt que de laisser chaque page se souvenir de l'appeler :
enregistrer ou supprimer un réveil écrit le runtime ET le disque, dans le même
geste.

**Relecture tolérante** : `toReveils` accepte encore l'ancienne forme au
singulier (`reveil: Reveil | null`), et donne un `id` neuf à un réveil qui n'en
a pas. Un réveil armé par quelqu'un ne disparaît pas parce que le format a
changé.

## 4. Le module pur `ui/src/reveil.ts`

Toute la décision temporelle vit dans une feuille pure, testable sans React et
sans horloge réelle (`maintenant` toujours passé en paramètre — même
convention que [cadenceUsage.ts](../ui/src/cadenceUsage.ts) et
[rythmeQuota.ts](../ui/src/rythmeQuota.ts)).

### 4.1 `prochaineEcheance(reveil, maintenant): number | null`

Le plus proche instant futur parmi :

- pour chaque `HH:MM` de `heures`, la prochaine occurrence de cette heure de
  mur **locale** (aujourd'hui si elle n'est pas passée, demain sinon) ;
- si `surResetQuota` et `cibleReouverture` est posée :
  `cibleReouverture + MARGE_RESET_MS`.

`null` si le réveil n'a aucune échéance calculable — c'est le cas d'un réveil
« au reset » armé alors qu'aucune réouverture n'était connue (§4.2), que l'UI
signale comme **inerte, à réarmer**.

Aucune source extérieure n'entre dans cette fonction : tout ce dont elle a
besoin est DANS le réveil. C'est ce qui la rend testable sans horloge ni
magasin, et c'est ce qui a réglé le défaut de la §4.2.

**Heure de mur locale, et pas un délai** : « 3 h du matin » doit rester 3 h du
matin au changement d'heure. Le calcul passe donc par les composants de date
locale (`setHours` sur une date du jour), jamais par une addition de
millisecondes sur un repère de la veille.

**`MARGE_RESET_MS` = 60 s** : `resetsAt` est l'instant annoncé de
réinitialisation ; repartir à la seconde près expose à un refus immédiat, qui
consommerait le réveil pour rien. Une minute de marge est invisible pour
l'utilisateur et suffit.

### 4.2 La réouverture du quota : une cible FIGÉE à l'armement

**Aucune sonde nouvelle** — la mesurer coûterait la ressource qu'on cherche à
ménager. Et, depuis la troisième passe, **aucune lecture pendant le
battement** non plus : chaque réveil porte sa propre cible.

À l'armement, `instantReouvertureQuota`
([reouvertureQuota.ts](../ui/src/reouvertureQuota.ts)) répond, dans l'ordre :

1. le **dernier `resetsAt` du relevé chiffré** (`fiveHour`), mémorisé par
   l'encart de conso — saturé ou non, disponible en permanence ;
2. à défaut, le **silence armé par un refus** (`silenceActifJusqua`, T-059).

Cet instant est alors **copié dans le réveil** (`Reveil.cibleReouverture`) et
n'en bouge plus.

#### Pourquoi figer — trois passes pour comprendre

**Passe 1.** Le réveil lisait `silenceActifJusqua`, armé au seul REFUS de la
sonde. Or quand on veut armer une reprise, on n'a pas encore été refusé : on
VOIT venir la saturation. L'en-tête affichait « ⚠ Session 5h saturée —
réinitialisation dans 2h » et « Armer » prétendait qu'aucune saturation
n'était connue. L'application savait ; le réveil regardait ailleurs.

**Passe 2.** La bonne source (le relevé chiffré) fut branchée — mais dans
`traiterReponseInit` seulement, alors que le relevé entre par **cinq** chemins
dans l'encart, et que c'est le cache relu au démarrage qui alimentait le badge
(la sonde se tait pendant la saturation). Remplacé par un **effet sur l'état
rendu** : toutes les portes couvertes, y compris la sixième qu'on ajoutera.

**Passe 3 — la vraie cause.** Même avec la bonne source, un réveil « au
reset » ne pouvait pas partir, et s'affichait « inerte ». Deux raisons, et
elles tiennent toutes deux à ce que la source **bouge** :

- elle ne rend l'instant que tant qu'il est FUTUR, alors que l'échéance du
  réveil est `réouverture + MARGE_RESET_MS`, toujours postérieure. Au moment
  précis où l'échéance devient due, la source s'est déjà tue ;
- et si un relevé frais arrive entre-temps, la date saute à la réouverture
  SUIVANTE — cinq heures plus loin. Le moment visé est enjambé sans avoir
  jamais été observé.

Le remède n'est pas de mieux lire, c'est de **ne plus relire** : une promesse
porte sa propre échéance. `cibleReouverture` est capturée à l'armement, le
battement ne fait plus que comparer des dates — ce qui le rend au passage
testable sans horloge ni magasin.

Un réveil « au reset » armé alors qu'aucune réouverture n'était connue n'a
donc pas de cible : il est **inerte**, et l'UI le dit en toutes lettres avec
la marche à suivre (le réarmer), plutôt que de le laisser attendre un
événement qui ne viendra pas.

### 4.3 `estDu(reveil, silenceJusqua, maintenant): boolean`

Vrai quand une échéance est **passée** et n'a pas déjà été honorée.

Deux garde-fous, tous deux dans le module pur :

1. **Anti-double-tir** — une échéance antérieure ou égale à
   `dernierDeclenchement` ne redéclenche pas. Sans ça, un réveil récurrent
   partirait à chaque battement d'horloge pendant toute la minute concernée.
2. **Rattrapage borné** — `RATTRAPAGE_MAX_MS` = 6 h. Une échéance manquée
   (portable en veille, app fermée quelques heures) déclenche au premier
   battement qui suit, à la façon du `Persistent=true` des timers systemd des
   tâches. Au-delà de 6 h elle est abandonnée : rouvrir l'app une semaine plus
   tard ne doit pas lâcher d'un coup un travail dont le contexte n'a plus de
   sens.

## 5. Câblage dans les pages

Un battement unique par page — `setInterval` à 30 s, même valeur que
`BATTEMENT_CADENCE_MS` : la précision utile est la minute, un battement plus
fin ne gagnerait rien et ferait rendre la page pour rien.

Ce battement vit dans un hook PARTAGÉ (`ui/src/useReveil.ts`), appelé en une
ligne par chacune des deux pages, et non dans deux effets jumeaux. Écrit
d'abord en double — à l'image des autres jumeaux de ces fichiers — puis
extrait : c'est le même mécanisme aux deux endroits, donc deux endroits où le
prochain défaut devrait être corrigé, ce que l'en-tête de
`useConversationRuntime.ts` raconte déjà au passé. Le cliquet de taille l'a
signalé au même moment et pour la même raison.

À chaque battement, pour **chaque conversation ouverte** (pas seulement
l'active — un réveil armé sur un onglet d'arrière-plan doit partir) :

```
si reveil !== null et estDu(reveil, silenceActifJusqua(now), now) :
    queuedPrompts ← [...queuedPrompts, ...reveil.prompts]
    reveil.dernierDeclenchement ← now
    si reveil.heures est vide et surResetQuota :  reveil ← null   (réveil à un coup)
    sinon                                      :  reveil.prompts conservés (récurrent)
    marquer la conversation (§6) et journaliser
```

Le versement se fait par `ecrire()` du dépôt de runtimes
([useConversationRuntime.ts](../ui/src/useConversationRuntime.ts)), pas par
`poser()` : le point « ● » de l'onglet et l'affichage de la file doivent
bouger.

Un réveil qui tombe **pendant un streaming** ne pose aucun problème : ses
prompts entrent dans la file et partent à la fin du tour en cours, exactement
comme un message tapé pendant que l'assistant travaille.

### 5.1 La bascule — corrigée après mesure

La première rédaction de cette spec affirmait que verser dans `queuedPrompts`
suffisait à faire partir le tour. **C'est faux**, et la vérification l'a
montré : l'effet de drainage ne draine que la conversation **ACTIVE**
(`getRuntime(activeSessionId).queuedPrompts[0]`, ChatPage.tsx et AgentPage.tsx).
La limite est ancienne et assumée — son commentaire l'explique : `handleSend`
fige sa cible sur la conversation active et lit les réglages du composeur de
la page (modèle, agent, mode de permission) ; envoyer « à distance »
exigerait de capturer tout ça par conversation.

Laissée telle quelle, la fonctionnalité tenait donc l'inverse de sa promesse :
un réveil armé puis un changement d'onglet, et à 3 h les prompts entraient en
file pour y rester jusqu'au retour de l'utilisateur.

**Remède retenu** : à l'échéance, la page rend la conversation concernée
active (`selectChatSession` / `selectSession`, les fonctions de bascule
existantes — rien de neuf), et le drainage existant fait le reste. Deux
bornes :

- **une seule bascule par battement** — si deux réveils tombent ensemble, le
  second reste en file et partira quand on ira le voir ; basculer deux fois ne
  voudrait rien dire, et le journal garde la trace des deux ;
- **jamais sur un abandon** — une échéance abandonnée n'a rien versé ; voler
  l'onglet actif pour annoncer qu'il ne se passe rien serait pire que le
  silence.

Le vol d'onglet est assumé : à 3 h il n'y a personne pour être dérangé, et si
quelqu'un est là, la bascule est visible, tracée dans le fil et journalisée.

L'alternative — rendre `handleSend` capable de cibler une conversation
d'arrière-plan avec SES réglages — reste la vraie réponse, et reste un
chantier à part entière.

## 6. Le compte rendu

L'utilisateur choisit un réveil pour ne PAS être devant l'écran ; il doit
donc trouver au matin de quoi savoir ce qui s'est passé, sans relire tout le
fil :

- **dans la conversation** : une action discrète horodatée « Réveil de 03:00 —
  reprise », posée à l'instant du versement, au même titre que les actions
  discrètes existantes (recherche web, compaction, débord) ;
- **sur l'onglet** : le point « ● » d'activité en arrière-plan, déjà en place,
  fait office de badge « non lu » ;
- **au journal** : une ligne `info` de canal `reveil` (conversation, échéance
  honorée, nombre de prompts versés). Un réveil qui ne part pas — échéance
  abandonnée par le rattrapage borné — écrit lui aussi sa ligne : un réveil
  silencieusement perdu serait exactement l'échec muet que la doctrine
  d'observabilité interdit.

## 7. L'UI

Le réveil est une action **secondaire** : on l'arme rarement, on la consulte
encore moins. Il vit donc là où vivent les autres actions secondaires du
composeur — la **colonne d'icônes** à gauche de la zone de saisie, avec le
trombone et le micro (`chat-composer__tools`). Une icône ⏰, zéro ligne
consommée.

Trois éléments, et chacun n'apparaît que s'il a quelque chose à dire :

- **l'icône**, toujours là, discrète. Quand un réveil est armé, elle porte une
  pastille qui bat, et son infobulle donne la prochaine échéance en clair ;
- **le bandeau d'état**, en haut du composeur, **absent tant que rien n'est
  armé** : pastille, nombre de réveils, prochaine échéance ;
- **le panneau**, flottant au-dessus de l'icône (il ne déforme donc ni la
  colonne ni le composeur) : la liste des réveils armés — heures, message,
  prochaine échéance, **Modifier** et **Supprimer** —, le formulaire, et
  l'historique replié.

Le formulaire : heures `HH:MM` (la saisie en cours compte, voir §7.1), case
« et dès que la fenêtre de quota se rouvre », et le message — prérempli avec
le brouillon en cours pour un réveil neuf, puisque c'est le geste attendu :
« ce que je viens d'écrire, envoie-le à 3 h ».

Armement refusé si le message est vide ou si aucune échéance n'est calculable
— avec le motif exact affiché, jamais un bouton qui ne fait rien.

### 7.1 Trois constats d'usage, et ce qu'ils ont changé

1. **« On ne voit pas bien quand c'est armé. »** (2026-09-04) Le bouton
   repliait tout, état compris : armé ressemblait à absent. D'où le bandeau et
   la pastille. Une promesse qu'on ne voit pas est une promesse qu'on ne croit
   pas.

2. **« On ne peut pas revenir sur l'autre à part pour supprimer. »**
   (2026-09-04) Un seul réveil par conversation, ses heures partageant un
   unique message, sans identité. D'où la liste, les `id`, et « Modifier ».

3. **« Ça prend un bandeau pour rien. »** (2026-09-05) Le bouton occupait une
   ligne entière du composeur **en permanence**, y compris — surtout — quand
   aucun réveil n'était armé. D'où la descente dans la colonne d'icônes, et un
   bandeau d'état qui n'apparaît que lorsqu'il a quelque chose à annoncer.

Le fil de ces trois constats dit la même chose sous trois angles : **la place
qu'une fonctionnalité occupe à l'écran doit être proportionnelle à ce qu'elle
a à dire à cet instant** — ni moins quand elle tient une promesse, ni plus
quand elle dort.

Conséquence de structure : deux composants exportés plutôt qu'un
(`ReveilBanniere` en haut du composeur, `ReveilControl` dans la colonne), parce
qu'ils vivent à deux endroits du DOM. Un portail aurait coûté plus cher à lire
qu'à écrire.

## 8. Tests

`ui/src/reveil.test.ts`, sur le module pur uniquement :

- prochaine occurrence d'une heure déjà passée aujourd'hui → demain ;
- plusieurs heures → la plus proche gagne ;
- `surResetQuota` avec et sans silence actif, marge appliquée ;
- anti-double-tir sur une même échéance à deux battements consécutifs ;
- rattrapage d'une échéance manquée de 2 h, abandon à 7 h ;
- heure de mur préservée de part et d'autre d'un changement d'heure.

## 9. Hors périmètre de la V1 — ce qui vient après

- **Réveil application fermée / continuation headless sur le serveur** — ticket
  [T-121](tickets.md#t-121). Le blocage
  n'est pas la planification, qui est déjà résolue par
  [tachesTimers.ts](../sidecar/src/tachesTimers.ts), mais l'ÉTAT : les
  conversations vivent dans `state/chatconv-<id>.json`, dont le schéma
  appartient à l'UI. Un réveil headless qui y écrit crée un second écrivain
  sur ces fichiers, et l'UI ouverte ensuite écrase. Ça se traite, mais ça se
  traite à part — probablement par une boîte de dépôt lue par l'UI à
  l'ouverture, jamais par une écriture concurrente.
- **Windows** : sans systemd, la V2 y sera de toute façon différente. La V1,
  elle, y fonctionne telle quelle (elle est entièrement dans l'UI).
- **Rapport Markdown daté** : c'est le contrat de sortie des tâches, pas d'une
  conversation. Il n'aurait de sens qu'avec la V2 headless.
