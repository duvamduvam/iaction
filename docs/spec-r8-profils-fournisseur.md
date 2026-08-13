# Spec R8-A — Profils de fournisseur : catalogue et comptabilité

Statut : **implémentée le 2026-08-11** — T-021 et T-022 clos. R8-B reste à faire.
Cadre : T-021, T-022, T-023 de [`tickets.md`](tickets.md). Taille : ¼ lot.

Où le code a atterri, le cliquet de taille ayant refusé d'agrandir `engine.ts`
(901 lignes) — ce qui était la bonne réponse, un profil de fournisseur n'étant
pas de la mécanique de flux SSE :

| Sujet | Fichier |
|---|---|
| Traits : validation souple, `bodyExtras`, comptabilité | `sidecar/src/profilFournisseur.ts` |
| Catalogue : cible, normalisation `openai`/`slugs`, détail | `sidecar/src/catalogue.ts` |
| Traits côté interface + table des profils connus | `ui/src/providerTraits.ts` |
| Formulaire (sorti de ProvidersPage, à son plafond) | `ui/src/ProviderForm.tsx` |
| « Tester » modèle par modèle | `ui/src/ProviderModelTester.tsx` |
| Cas 1 à 8 de §7 | `sidecar/test/profilFournisseur.test.js` |

Toutes les mesures citées ont été faites le 2026-08-10 sur l'API Swiftask
réelle et sur le code de son extension VSCode officielle (0.1.3, qui publie
ses sources d'origine via son source map).

## Objectif

Le moteur neutre repose sur une hypothèse non écrite : *« un fournisseur, c'est
une `baseUrl` compatible OpenAI et une clé »*. Elle a déjà cédé quinze fois en
`if` éparpillés (T-023). R8-A ne corrige pas les quinze : il pose **l'endroit
où les déclarer**, et s'en sert pour les deux défauts qui bloquent
aujourd'hui l'usage de Swiftask.

1. **Source de catalogue déclarée** — `GET {baseUrl}/models` n'est pas
   universel. Chez Swiftask il renvoie 8 slugs figés quand la plateforme en
   sert 142 ; le modèle sur lequel tourne leur propre extension
   (`claude-sonnet-4-5`) n'y figure pas.
2. **Comptabilité honnête** — un fournisseur qui répond
   `prompt_tokens: 0` sur un tour réel fait enregistrer `0` comme une mesure
   valide. Zéro mesuré et absence de mesure doivent cesser d'être le même
   chiffre.

**Contrat de non-régression, repris de R0 :** chaque champ est optionnel et
absent par défaut ; **un fournisseur sans `traits` produit une requête
strictement identique à l'actuelle, à l'octet près.** Rien de tout ceci ne
s'applique au moteur Claude.

## Périmètre des fichiers

| Fichier | Nature du changement |
|---|---|
| `ui/src/providerAdmin.ts` | `ProviderConfig.traits` + validation souple + relais dans `pushProviders` |
| `ui/src/providerFormCalc.ts` | construction des traits (champ vide → propriété absente) |
| `ui/src/ProvidersPage.tsx` | sous-section « Profil du fournisseur », préréglages, bouton « Tester » par modèle |
| `ui/src/sidecar.ts` | `ProviderPayload.traits` |
| `sidecar/src/engine.ts` | `Provider.traits`, `fetchRawModels`, corps de `chat.send`, `extractUsage` |
| `sidecar/test/protocol.test.js` | cas de test (voir §7) |
| `docs/protocol.md` | `providers.set`, `models.list`, `chat.send`, événement S1 |

Interdits (déjà en vigueur) : jamais de clé API loguée ou écrite sur disque ;
l'UI ne parle qu'au protocole ; zéro dépendance runtime nouvelle.

## 1. Modèle de données

### `ProviderTraits` — nouveau, optionnel

```ts
export interface ProviderTraits {
  /** T-021 — URL absolue du catalogue, à la place de `{baseUrl}/models`. */
  catalogUrl?: string;
  /** Forme de la réponse du catalogue. Défaut implicite : "openai". */
  catalogShape?: "openai" | "slugs";
  /** T-022 — `false` : les compteurs à zéro valent « inconnu » (`null`). */
  usageTrustworthy?: boolean;
  /** Champs non standard à fusionner dans le corps de `chat.send`. */
  bodyExtras?: Record<string, unknown>;
}
```

`bodyExtras` est un dictionnaire libre **délibérément** : la liste des
bizarreries d'un fournisseur ne se devine pas à l'avance. Swiftask en impose
déjà deux, découvertes dans le code de leur client : `stateless: true` est
envoyé à chaque requête, et `reasoning_effort` est refusé par la passerelle
(« HTTP 400, not allowed »). Un booléen nommé par quirk serait une dette dès
le troisième fournisseur.

### `ProviderConfig` (ui) et `Provider` (sidecar)

Les deux gagnent `traits?: ProviderTraits`. `isProviderConfig` ne change pas
(le champ n'est pas requis). Validation **souple**, comme les champs R0 : un
trait mal formé est retiré, jamais une erreur —

- `catalogUrl` gardé seulement si chaîne non vide commençant par `http://` ou
  `https://` ;
- `catalogShape` gardé seulement si `"openai"` ou `"slugs"` ;
- `usageTrustworthy` gardé seulement si `typeof === "boolean"` ;
- `bodyExtras` gardé seulement si objet simple ; les clés
  `model`, `messages`, `stream` et `stream_options` en sont **retirées** —
  un profil ne doit pas pouvoir détourner le cœur de la requête.

`pushProviders` relaie `traits` dans `ProviderPayload`. `DEFAULT_PROVIDERS`
reste **inchangé** : opt-in pur.

## 2. Résolution du catalogue (`fetchRawModels`, engine.ts)

```
url   = provider.traits?.catalogUrl ?? joinUrl(provider.baseUrl, "models")
shape = provider.traits?.catalogShape ?? "openai"
```

Le reste de la fonction (en-têtes, gestion d'erreur, filtre sur `id` non vide)
ne change pas. Seule la **normalisation** diffère :

| `shape` | Entrée acceptée | Normalisation |
|---|---|---|
| `"openai"` | `{data:[…]}` ou `[…]` | inchangée (comportement actuel) |
| `"slugs"` | `[…]` | `id ← slug`, `name ← name`, **et on ne garde que les entrées `isChatLMM === true`** |

Le filtre `isChatLMM` n'est pas cosmétique : sans lui, le sélecteur proposerait
`excel_export` ou `whisperx` comme cerveau d'un agent. Mesuré : interrogé par
`/v1/chat/completions`, `excel_export` répond *« Je suis un assistant IA conçu
pour répondre à vos questions »* — sa fonction d'export a disparu, sans erreur.

Une entrée sans `slug` non vide est ignorée, comme aujourd'hui une entrée sans
`id`.

## 3. Corps de requête (`chat.send`, engine.ts)

Après la construction actuelle du `body` et **avant** les réglages R0 :

```ts
if (provider.traits?.bodyExtras) {
  Object.assign(body, provider.traits.bodyExtras);
}
```

Placé là, un profil ne peut pas écraser les réglages R0 d'un même
fournisseur — R0 a le dernier mot, et les clés structurantes ont déjà été
retirées à la validation.

## 4. Usage : distinguer zéro d'inconnu (`extractUsage`, engine.ts)

Aujourd'hui `typeof usage.prompt_tokens === "number"` accepte `0`. Nouvelle
règle, **appliquée uniquement quand `traits.usageTrustworthy === false`** :

```ts
const zeroVautInconnu = provider.traits?.usageTrustworthy === false;
const lire = (v: unknown) =>
  typeof v === "number" && !(zeroVautInconnu && v === 0) ? v : null;
```

Un fournisseur sans le trait garde le comportement actuel, y compris pour un
vrai zéro. La première fois qu'un tour retourne `null` par cette règle, le
sidecar écrit **un `warn` au journal** (`« comptabilité non fournie par
<providerId> »`) — une fois par processus, pas par tour : l'absence de mesure
doit être un fait visible, pas un silence, sans pour autant inonder le journal.

L'événement d'usage porte `promptTokens: null`. L'interface affiche déjà
« — » sur `null` là où elle affichait `0 + 0 tokens`.

## 5. UI — ProvidersPage.tsx

**Sous-section « Profil du fournisseur (optionnel) »**, sous les réglages R0,
pour les fournisseurs neutres uniquement :

- **URL du catalogue** : texte, aide « Certaines plateformes publient leur
  catalogue ailleurs que sur `/models`. Vide = comportement standard. » ;
- **Forme du catalogue** : liste `Standard (OpenAI)` / `Liste de slugs` ;
- **Comptabilité fiable** : case **cochée par défaut** ; décochée →
  `usageTrustworthy: false`. Aide : « Décochez si ce fournisseur renvoie des
  compteurs de jetons à zéro : ils seront traités comme inconnus plutôt que
  comme une consommation nulle. » ;
- **Champs supplémentaires (JSON)** : zone de texte → `bodyExtras`. JSON
  invalide → le formulaire n'est pas soumissible, message sous le champ.
  Champ vide → propriété absente.

**Préréglage « Swiftask »** dans la liste des préréglages existante (même
patron que les préréglages STT/TTS), qui remplit :

```
baseUrl     https://graphql.swiftask.ai/v1
needsKey    oui
catalogUrl  https://graphql.swiftask.ai/public/bots
catalogShape  slugs
usageTrustworthy  false
bodyExtras  {"stateless": true}
```

Cette table de préréglages vit **côté interface uniquement** : c'est une aide
de saisie, pas une source d'exécution. Le sidecar ne connaît aucune marque, il
lit ce qu'on lui pousse. Une seule déclaration a un consommateur à l'exécution
— pas de cinquième vérité à faire diverger.

**Bouton « Tester » par modèle**, dans le catalogue de la page : envoie un tour
d'un jeton et affiche ✓ / ✗ / le message d'erreur. C'est la mitigation
assumée de T-025 : on ne tente PAS de valider automatiquement 132 modèles
(coût absurde), et on ne renifle PAS la phrase d'erreur (on condamnerait des
réponses légitimes). On donne le moyen de vérifier ; T-025 reste ouvert.

## 6. docs/protocol.md

- `providers.set` : documenter `traits` et sa validation souple ;
- `models.list` : documenter la résolution d'URL et les deux formes ;
- `chat.send` : documenter la fusion de `bodyExtras` et sa priorité ;
- section S1 : `promptTokens`/`completionTokens` peuvent valoir `null` quand
  le fournisseur ne fournit pas de comptabilité.

## 7. Tests (`sidecar/test/protocol.test.js`, faux serveur existant)

1. **Corps sans profil** : provider sans `traits` → corps strictement
   identique à aujourd'hui (aucun champ nouveau).
2. **Catalogue standard** : provider sans `catalogUrl` → `GET {baseUrl}/models`,
   comme aujourd'hui.
3. **Catalogue dérouté** : `catalogUrl` posé → la requête part sur cette URL,
   pas sur `{baseUrl}/models`.
4. **Forme `slugs`** : réponse `[{slug:"a",name:"A",isChatLMM:true},
   {slug:"b",isChatLMM:false},{name:"sans slug",isChatLMM:true}]` →
   `models === [{id:"a",name:"A"}]` (filtré ET normalisé).
5. **`bodyExtras` fusionné** : `{"stateless":true}` → présent dans le corps ;
   une clé interdite (`model`) dans `bodyExtras` → **retirée à la validation**,
   le `model` demandé reste intact.
6. **Zéro vaut inconnu** : `usageTrustworthy:false` + dernier chunk
   `{prompt_tokens:0, completion_tokens:0}` → `done.usage.promptTokens === null`
   et événement JSONL à `null`.
7. **Zéro reste zéro** : même flux, provider **sans** le trait → `0`, comme
   aujourd'hui.
8. **Validation souple** : `traits` mal formé (`catalogShape:"xxx"`,
   `catalogUrl:42`, `bodyExtras:"non"`) → traits retirés sans erreur, le
   provider reste utilisable.

## 8. Critères d'acceptation

- [x] `npm run verif` passe (le code de sortie fait foi, pas le compte de
      « OK »). **Réserve** : au 2026-08-11 le cliquet signale
      `src-tauri/src/sidecar.rs` à 807 lignes — dépassement SANS RAPPORT avec
      R8-A, venu d'un travail en cours sur la coquille.
- [x] Un fournisseur sans `traits` produit une requête et un catalogue
      identiques à l'actuel (tests 1, 2, 7).
- [x] Le préréglage Swiftask fait apparaître **~130 modèles** au lieu de 8,
      dont `claude-opus-4-8`, et **aucune** entrée non conversationnelle.
      Mesuré sur la réponse réelle de `/public/bots` : 142 entrées → **132
      retenues**, `excel_export` et `whisperx` écartés.
- [x] Un tour Swiftask affiche une consommation « inconnue », jamais `0 + 0`
      (test 6 ; test 7 pour la non-régression).
- [x] Les traits survivent à un redémarrage : ils vivent dans la config
      non-secrète, relus par `readProviders` et repoussés au démarrage.
- [x] Aucune clé API dans les journaux ni dans la config non-secrète.
- [x] `docs/protocol.md` à jour (`providers.set`, `models.list`, `chat.send`,
      section S1).
- [ ] Vérification manuelle par l'utilisateur (l'app n'est jamais lancée par
      l'agent) : appliquer le préréglage Swiftask sur le fournisseur existant,
      puis un tour sur `claude-opus-4-8` via le sélecteur.

## Hors périmètre R8-A

- **`creditsPath` et `billing`** → R8-B : dé-nommer `usage.openrouter` et
  supprimer la devinette `id.includes("ollama")` d'`usageStats.ts`. Touche le
  contrat, donc seul et documenté.
- **`nativeApi`** (les méthodes `ollama.*`) : le code existant fonctionne et
  ne gêne personne tant qu'il n'y a qu'un cas. On ne généralise pas sur un.
- **Cible de débord** codée en dur dans `debord.ts` : relève de R3. Rappel :
  Swiftask ne remontant aucun coût, il ne doit pas devenir cible de débord —
  le plafond mensuel ne pourrait pas le protéger.
- **Recherche web (T-010)** : délibérément exclu. Trois fournisseurs, trois
  grammaires (`:online` chez OpenRouter, un autre modèle chez Swiftask, les
  outils du SDK chez Claude) — mais si l'application se dote de sa PROPRE
  recherche (injection préalable, qui marche avec 100 % des modèles, ou boucle
  d'outils pour ceux qui l'acceptent), alors aucun trait n'est nécessaire.
  Trancher cette question AVANT d'ajouter quoi que ce soit ici.
- **Détection des modèles morts (T-025)** : hors périmètre au-delà du bouton
  « Tester ». Un fournisseur qui encode sa panne dans le corps d'une réponse
  HTTP 200 est indétectable par le protocole ; le reconnaître au texte serait
  échanger un faux négatif contre un faux positif.
