# Spec R9 — Recherche web pour tous les modèles

Statut : **RÉALISÉE — spec de référence, ne plus déléguer** (2026-08-10).
Implémentation le jour même : `sidecar/src/webSearch.ts`, branchement dans
`chat.send`, case du Chat pour tous les fournisseurs. Écarts assumés par
rapport à la spec, notés en §2 et §6.
Cadre : T-010 de [`tickets.md`](tickets.md). Taille : ½ lot.
Indépendante de [R8](spec-r8-profils-fournisseur.md) : aucune des deux
n'attend l'autre.

## Objectif

La case « Recherche web » du Chat n'existe que pour le fournisseur Claude
(`webSearch` n'est transmis qu'à `sendViaClaude`, `ChatPage.tsx` ~1577). Tout
modèle neutre répond **de mémoire**, sans que rien à l'écran ne le signale —
d'où le constat fondateur de T-010 : un modèle qui présente « janvier 2025 »
comme une actualité récente.

R9 donne la recherche à **tous les fournisseurs, présents et futurs**, par une
capacité que l'application possède au lieu de l'emprunter.

### Pourquoi l'injection, et pas un outil

Deux mécanismes existent. On choisit délibérément le premier :

| | Injection préalable (**retenu**) | Boucle d'appels d'outils |
|---|---|---|
| Modèles couverts | **100 %** | seulement ceux qui savent appeler une fonction |
| Boucle dans `chat.send` | aucune | à écrire — le cœur du moteur |
| Le modèle peut itérer | non (une passe) | oui |

La couverture décide : `chat.send` n'a **aucune** boucle d'outils aujourd'hui
(zéro occurrence de `tools` dans `engine.ts`), et l'appel de fonction n'est pas
universel. L'injection tient la promesse « tous les modèles » sans toucher au
moteur.

### Pourquoi une capacité locale, et pas le réglage du fournisseur

Trois fournisseurs, trois grammaires : suffixe `:online` chez OpenRouter, un
**autre modèle** (`perplexityonline`) chez Swiftask, les outils du SDK chez
Claude. Les suivre, c'est un `if` par marque — exactement la plomberie que
T-023 cherche à supprimer. Une capacité locale les rend tous **inutiles**, et
vaudra pour les fournisseurs qui n'existent pas encore.

## Périmètre des fichiers

| Fichier | Nature du changement |
|---|---|
| `sidecar/src/webSearch.ts` | **nouveau** — moteur, extraction, sélection, bloc injecté |
| `sidecar/src/knowledge.ts` | exporter un classement réutilisable (`classerExtraits`) |
| `sidecar/src/engine.ts` | `chat.send` : paramètre `webSearch`, injection, événement `web` |
| `sidecar/src/router.ts` | `router.set` : champ `webSearch: { baseUrl }` |
| `ui/src/ChatPage.tsx` | case visible pour TOUS les fournisseurs + rendu des sources |
| `ui/src/sidecar.ts` | `chatSend` relaie `webSearch`, expose les sources |
| `sidecar/test/webSearch.test.js` | logique pure (voir §7) |
| `sidecar/test/protocol.test.js` | bout en bout, faux moteur de recherche |
| `docs/protocol.md` | `chat.send`, `router.set`, forme du `chunk` |

Interdits (déjà en vigueur) : l'UI ne fait aucun accès réseau ; zéro
dépendance runtime nouvelle — **l'extraction de texte s'écrit à la main**, on
n'ajoute pas un paquet d'analyse HTML pour retirer des balises.

## 1. Le moteur : SearXNG, derrière une interface

SearXNG tourne déjà sur le poste (`127.0.0.1:8081`), et son API JSON répond
au format attendu :

```
GET {baseUrl}/search?q=<requête>&format=json&language=fr
→ { results: [ { title, url, content, publishedDate }, … ] }
```

C'est un **méta-moteur** : une seule intégration, des dizaines de sources en
dessous, aucune clé, aucune facture, aucun quota, tout en local — la doctrine
du projet appliquée telle quelle.

```ts
export interface ResultatWeb { titre: string; url: string; extrait: string; date?: string }
export interface MoteurRecherche { rechercher(q: string, n: number): Promise<ResultatWeb[]> }
```

L'implémentation SearXNG est la seule fournie. Passer à Brave ou Tavily plus
tard = une implémentation de plus derrière la même interface, **pas une
refonte**. `baseUrl` est configurable via `router.set` (défaut
`http://127.0.0.1:8081`), au même endroit que le classificateur et les
embeddings — aucune méthode nouvelle au protocole.

## 2. Le pipeline, et ses bornes

Chaque borne est là parce que sans elle un cas réel casse le tour.

| Étape | Règle | Borne |
|---|---|---|
| Requête | le **dernier message utilisateur, tel quel** | pas de reformulation (voir §8) |
| Recherche | `N = 5` résultats | délai 5 s ; échec → §4 |
| Extraction | les `3` premiers résultats récupérés en HTTP | 10 Ko de texte/page, 3 s/page, **une page en échec est sautée** |
| Sélection | découpe + classement par embeddings | ~4 Ko injectés au total |
| Injection | bloc système éphémère (§3) | jamais écrit dans l'historique |

**Extraction sans dépendance** : retirer `<script>`/`<style>` avec leur
contenu, remplacer les balises par un espace, décoder les entités usuelles,
réduire les blancs. Grossier et suffisant — on cherche du texte à donner à un
modèle, pas à rendre une page.

**Sélection** : `knowledge.ts` sait déjà découper (`chunkText`), plonger
(`embedTexts`, modèle `nomic-embed-text` sur Ollama) et classer
(`cosineSimilarity`, `rankChunks`). R9 n'en réécrit rien : on expose
`classerExtraits(requête, textes, topK)` dans `knowledge.ts` et on l'appelle.
La recherche web devient **le RAG existant avec une autre source**.

Si les embeddings sont indisponibles (Ollama arrêté — panne connue), on se
rabat sur les extraits renvoyés par le moteur, sans classement. Dégradé, pas
en panne.

## 3. Le bloc injecté

Ajouté **en tête des messages** du seul tour concerné, jamais persisté dans la
conversation : des résultats d'hier ne doivent pas polluer la question de
demain, et la jauge de contexte ne doit pas enfler tour après tour.

```
Résultats de recherche web du <date ISO>, pour répondre à la question ci-dessous.
Cite tes sources par leur numéro, sous la forme [1]. N'invente aucune source.
Si ces extraits ne suffisent pas, dis-le au lieu de compléter de mémoire.

[1] <titre> — <url> (<date si connue>)
<extrait retenu>

[2] …
```

## 4. Rien de muet

Le tour part quand même, mais **il le dit** — au modèle et à l'écran.

| Cas | Bloc injecté | Événement émis |
|---|---|---|
| Résultats trouvés | les sources (§3) | `web: { etat: "ok", sources }` |
| Zéro résultat | « La recherche n'a rien renvoyé. Réponds sans prétendre avoir consulté le web. » | `web: { etat: "vide" }` |
| Moteur injoignable | « La recherche web a échoué. Dis-le explicitement. » | `web: { etat: "echec", message }` |

L'échec est aussi journalisé (`warn`, une fois par processus). Une réponse qui
a l'air fraîche sans l'être est le défaut exact consigné dans T-010 : il n'est
pas remplacé par un silence d'un autre genre.

## 5. Protocole

`chat.send` gagne `webSearch?: boolean`. **Absent ou `false` → tour strictement
identique à aujourd'hui, à l'octet près** (aucune requête sortante
supplémentaire, aucun message ajouté).

Un `chunk` peut porter `web` **avant** le premier `delta` :

```ts
{ event: "chunk", id, data: { web: { etat: "recherche" | "ok" | "vide" | "echec",
                                    sources?: { n: number; titre: string; url: string }[],
                                    message?: string } } }
```

Le client actuel (`chatSend`, `ui/src/sidecar.ts` ~591) ne lit que
`data.delta` : un `chunk` sans `delta` est déjà ignoré sans erreur. La
compatibilité ascendante est donc acquise, l'UI ne fait que gagner un affichage.

## 6. UI — ChatPage.tsx

- la case « Recherche web » devient visible pour **tous** les fournisseurs
  (elle disparaît de sa condition « Claude uniquement ») ; **décochée par
  défaut** sur les fournisseurs neutres, l'actuel défaut coché de Claude est
  conservé ;
- pendant `etat: "recherche"`, une ligne discrète « Recherche web… » au-dessus
  de la réponse ;
- à la réception des sources, une liste numérotée **sous** la réponse, chaque
  entrée cliquable ;
- `etat: "echec"` ou `"vide"` : la même ligne le dit, en discret, sans
  bandeau d'erreur — le tour a bien eu lieu.

Le fournisseur Claude **garde ses outils natifs** (`WebSearch`/`WebFetch` du
SDK) : ils sont meilleurs et déjà payés par l'abonnement. Les deux chemins
produisent le même contrat — un bloc de sources —, et la dualité ne dépasse
jamais le sidecar.

## 7. Tests

**Unitaires** (`webSearch.test.js`, logique pure, sans réseau) :

1. extraction : `<script>`/`<style>` retirés avec leur contenu, balises
   remplacées, entités décodées, blancs réduits ;
2. troncature : une page de 100 Ko produit au plus 10 Ko ;
3. bloc injecté : numérotation `[1]`, `[2]`, URL et date présentes ;
4. zéro résultat et échec moteur : produisent le bloc de §4, jamais une
   exception ;
5. garde d'URL : `file://`, `ftp://`, `http://127.0.0.1`, `http://192.168.x.x`
   et `http://[::1]` sont **refusés** avant tout accès réseau.

**Protocole** (`protocol.test.js`, faux moteur de recherche local) :

6. `webSearch` absent → corps et messages strictement identiques à
   aujourd'hui, **aucune requête sortante** vers le moteur ;
7. `webSearch: true` → un `chunk` `web.etat === "ok"` précède le premier
   `delta`, et les messages envoyés au fournisseur portent le bloc ;
8. moteur qui répond 500 → tour **réussi**, `web.etat === "echec"`, bloc
   d'honnêteté injecté ;
9. le bloc n'est **pas** présent au tour suivant de la même conversation.

## 8. Critères d'acceptation

- [ ] `npm run verif` passe (le code de sortie fait foi).
- [ ] Case décochée → aucun appel au moteur, tour identique à l'actuel (test 6).
- [ ] Sur Ollama, OpenRouter **et** Swiftask, la même question d'actualité
      produit une réponse sourcée — la preuve que rien n'est spécifique à un
      fournisseur.
- [ ] Moteur arrêté (`docker stop searxng`) → le tour aboutit et annonce
      l'échec ; il ne répond jamais de mémoire en silence.
- [ ] Les sources affichées sont cliquables et correspondent aux `[n]` cités.
- [ ] `docs/protocol.md` à jour.
- [ ] Vérification manuelle par l'utilisateur (l'app n'est jamais lancée par
      l'agent).

## Écarts constatés à l'implémentation

Deux, tous deux dans le sens de la structure et non du raccourci :

1. **`classerExtraits` vit dans `webSearch.ts`, pas dans `knowledge.ts`.** La
   spec le logeait côté RAG ; le cliquet de taille a refusé la croissance de
   `knowledge.ts`, et il avait raison — le budget par source et le repli sont
   une POLITIQUE de recherche web, pas une primitive d'embeddings.
   `knowledge.ts` n'expose désormais que `embedTexts`/`rankChunks`.
2. **Le contrat côté interface vit dans `ui/src/rechercheWeb.ts`**, une
   feuille sans aucun import, que `sidecar.ts` ré-exporte. Motif identique à
   `providerFormCalc.ts` : un module qui s'abonne à Tauri au chargement n'est pas
   testable, une feuille l'est. `parseEtatWeb` et `libelleAvancementWeb` sont
   couverts par 10 tests.

La liste des sources a également été sortie de `ChatPage.tsx` vers
`ui/src/SourcesWeb.tsx` — même cause, même remède.

## Hors périmètre R9

- **Reformulation de la requête par un LLM** : tentant, mais c'est un appel de
  plus, une latence de plus et une source de bugs de plus, pour un gain non
  démontré. À rouvrir sur constat, pas par anticipation.
- **Boucle d'appels d'outils** (le modèle décide quand chercher, et itère) :
  meilleure qualité, mais réservée aux modèles outillés et bien plus lourde.
  R9 ne l'interdit pas — l'interface `MoteurRecherche` servira telle quelle le
  jour où on l'écrira.
- **PDF, images, vidéos** dans les résultats : texte HTML seulement.
- **Recherche dans les Projets** (moteur agentique) : le moteur neutre
  agentique a déjà une boucle d'outils et sept outils locaux ; lui ajouter un
  outil web est un autre chantier, qui réutilisera `webSearch.ts` sans le
  modifier.
- **Cache des résultats** : aucun en v1. À ajouter si le journal montre des
  requêtes répétées.
