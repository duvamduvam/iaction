# Revue d'architecture — 2026-08-15

*Passage complet selon `.claude/skills/revue-archi`, mesuré sur le code et le
journal réel du poste. Référence de comparaison : le relevé du 2026-08-08
(`architecture.md`, `etude-structure.md`). Les constats actionnables sont les
tickets T-057, T-058 et T-059 — le rapport pointe vers eux, pas l'inverse.*

---

## 1. Le relevé

| Indicateur | 2026-08-08 | 2026-08-15 | Sens |
|---|---:|---:|---|
| Dérogations du cliquet | 21 | **16** (24 608 lignes de budget) | ↓ bon |
| Copies d'`isNonEmptyString` | 19 | **3** (une par espace de travail) | ↓ bon |
| Copies de `toMessage` | 4 | **1** | ↓ bon |
| Tests d'interface (lignes) | 623 | **3 757** | ×6 bon |
| Ratio code/test interface | 1 : 50 | **1 : 9,5** (35 817 / 3 757) | ↓ bon |
| Ratio code/test sidecar | 1 : 1,7 | **1 : 1,6** (16 869 / 10 612) | = bon |
| Tests Rust `#[test]` | 50 | **74** | ↑ bon |
| Méthodes du protocole testées bout en bout | « ? » (jamais mesuré) | **47 / 69** | première mesure |
| Tickets ouverts / archivés | 17 / 31 (matin) | **6 / 50** (soir) | ↓ bon |
| Journal réel : part d'`error`+`fatal` | non mesuré | **85 %** (3 947 / 4 623 lignes) | **rouge** |

Les quatre indicateurs d'`etude-structure.md` §6 sont donc tous relevés, et le
quatrième pour la première fois. Trois vont dans le bon sens ; le journal est
le point noir, et il était invisible jusqu'à cette mesure.

---

## 2. Axe Simple — sain, deux restes tolérés

**Sain.** Les trois patrons de « vérités multiples » corrigés cette semaine
(version, table de routage, modèles d'abonnement) tiennent par des gardes dans
`npm run verif` — plus aucun « identique à X » sans garde n'a été trouvé. Les
couches font chacune ce qu'elle seule peut faire ; aucun secret ne transite
hors de la coquille ; aucune abstraction « au cas où » flagrante — le besoin
écrit (locale, mono-utilisateur, **diffusable**) couvre ce qui existe.

**Restes, tolérés et bornés :**

- `usageStats.ts:73` — la devinette `includes("ollama")` subsiste, mais
  SUBORDONNÉE au trait `billing` déclaré, à un seul endroit, avec sa
  disparition planifiée par écrit (clôture de T-023). Conforme à la règle.
- `contextBus.ts:121` — `id.includes("claude") ? 1_000_000` : une devinette de
  fenêtre de contexte, à un endroit, non nommée comme telle. Mineure (un repli
  d'affichage), signalée ici sans ticket : la corriger coûterait plus que ce
  qu'elle risque.

---

## 3. Axe Robuste — le constat central de la revue

**Le journal applicatif réel est à 85 % d'erreurs, et l'écrasante majorité
décrit des états NOMINAUX.** Décompte des messages `error`/`fatal`
(`app.jsonl` du poste, 4 623 lignes depuis le 2026-08-04) :

| Occurrences | Message | État réel |
|---:|---|---|
| 2 125 | `erreur réseau: fetch failed` | fournisseur local/distant hors ligne — état durable connu |
| 1 197 | `clé API manquante pour openrouter` | aucune clé configurée — état choisi par l'utilisateur |
| 246 | `échec du micro-tour d'initialisation` | hors ligne / non connecté — la jauge retentera |
| 129 | `fournisseur inconnu: openrouter` | course au démarrage (corrigée par T-008, historique) |
| ~96 | `HTTP 404 <!DOCTYPE html>` | sonde sur un non-Ollama (corrigée par T-007, historique) |

T-007 a créé le bon mécanisme — le drapeau `sonde`, dont l'échec se journalise
en `debug` — mais ne l'a appliqué qu'à `ollama.ps`. Les jauges périodiques
(`usage.credits` toutes les 5 min, micro-tour d'initialisation) crient encore
en boucle. **La doctrine fondatrice du dépôt est trahie par son propre outil :
le fichier qu'on ouvre quand ça va mal est illisible.** → **T-057** (P2).

**Constat utilisateur, tombé pendant la revue : la jauge de session affichait
94 % pendant que l'abonnement était réellement saturé.** Cause tracée : le
relevé vient des tours de l'app (`claude.ts:826,1146`) et d'un cron de 5 min
(`App.tsx:48`), la consommation faite HORS de l'app (Claude Code sur le même
abonnement) est invisible entre deux relevés, l'âge de la donnée n'apparaît
qu'en infobulle (`App.tsx:141`), et le seuil d'alerte à 98 % (`App.tsx:110`)
suppose une donnée fraîche. La jauge affirme ce qu'elle ne sait pas — même
famille que T-024 et T-035. → **T-059** (P2).

**Sain par ailleurs :** la discipline R0 est tenue par tous les ajouts récents
(clé `reseau` : « rien de saisi = rien de changé », testé des deux côtés) ;
l'habitat est traité (repli `/proc`, T-053) ; les garde-fous « le code qu'on
croit exécuter » (empreintes, purge de mise en scène) ne sont contournés par
aucun chemin nouveau.

---

## 4. Axe Efficace — rien de rouge, un manque déjà ticketé

- Le relevé de démarrage en version **empaquetée** manque toujours — c'est
  exactement le reste de T-029, ouvert et en cours. Pas de nouveau ticket.
- Aucun travail-fait-deux-fois détecté après T-025 ; le re-parse Markdown reste
  contenu par `memo` (vérifié en corrigeant T-024, où le contexte a été
  mémoïsé pour préserver cette propriété).
- Le bundle tient ses exclusions (voix locale absente, vérifié via T-012 : les
  5 vulnérabilités restantes sont précisément cette pile, hors bundle).
- Les minorants de coût sont désormais DITS (T-035/T-036) — l'axe est passé de
  « des chiffres faux » à « des chiffres honnêtes sur leurs limites ».

---

## 5. Axe Malléable — la structure suit, un angle mort nommé

Le patron « feuille pure testable sans fenêtre » a produit cette seule journée
`refFichier.ts`, `paletteTour.ts`, `reseauAdmin.ts`, `focusZones.ts`,
`raccourcisClavier.ts` — et le ratio de tests interface a suivi mécaniquement
(×6 depuis le 8 août). La théorie du dépôt — les tests suivent la structure —
se vérifie une seconde fois.

**L'angle mort : 22 des 69 méthodes du protocole ne sont traversées par aucun
test de bout en bout, et elles se concentrent sur deux familles entières —
`mcp.*` (6 méthodes) et `orch.*`.** Or ce sont précisément les méthodes de la
partie la plus AUTONOME de l'application : l'orchestration tourne la nuit, en
`bypassPermissions`, sur le poste et sur le VPS, sans humain pour remarquer
qu'un contrat a glissé. Le filet est le plus mince là où personne ne regarde.
→ **T-058** (P2).

Prochaine extraction de valeur (sans nouveau ticket, déjà au plan
d'`etude-structure.md` §5) : `OrchestrationPage` (88 `useState`, 0 test) —
c'est le plus gros état-sans-propriétaire restant.

---

## 6. Verdict — les trois constats qui rapportent le plus

1. **T-057 — faire taire les jauges qui crient** (P2). Coût de ne pas le
   faire : la prochaine vraie panne sera invisible dans un journal à 85 % de
   faux positifs, et c'est le défaut que la doctrine du dépôt juge le plus
   grave. Le mécanisme existe (`sonde`), il reste à l'appliquer partout où un
   échec est une réponse.
2. **T-059 — une jauge de session qui dit son âge et entend les refus** (P2).
   Coût : l'utilisateur lance des tours voués au refus en croyant avoir 6 % de
   marge — constaté aujourd'hui même.
3. **T-058 — un filet sous `mcp.*` et `orch.*`** (P2). Coût : une rupture de
   contrat sur la partie qui tourne sans humain ne produirait AUCUN signal —
   les parseurs tolérants transformeraient la panne en fonctionnalité qui
   disparaît en silence (pathologie 2.3 d'`etude-structure.md`, jamais refermée
   sur ces familles).

## 7. Ce que la revue n'a pas couvert

- La coquille Rust ligne à ligne (74 tests, mais pas de relecture exhaustive) ;
- l'accessibilité de l'interface au-delà de ce que les tests existants
  couvrent ;
- les zones en travaux de la session parallèle (T-048, T-030, T-009, T-029) —
  exclues par le partage de zones ;
- `architecture.md` : ses chiffres datent du 2026-08-08 et l'écart est
  désormais notable (tests ×6, dérogations −5). Le document s'annonce comme un
  relevé daté, il ne ment donc pas — mais un rafraîchissement de ses §7-§8
  vaudrait la peine à la prochaine évolution structurelle.
