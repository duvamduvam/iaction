# Spec R0 — Réglages OpenRouter du moteur neutre (Lot 14, phase R0)

Statut : **spec fermée, prête à déléguer** (2026-07-27).
Cadre : `docs/etude-routage-llm.md` §6-§7 (option C — fonctions natives
OpenRouter). Taille : ¼ lot.

## Objectif

Trois réglages opt-in, par fournisseur, dans le moteur neutre :

1. **Modèles de secours** (`models` OpenRouter) : fallback automatique en cas
   de rate-limit / contexte dépassé / indisponibilité.
2. **Tri par prix** (`provider: {sort: "price"}`) : router chaque appel vers
   l'endpoint le moins cher du modèle.
3. **Comptabilité d'usage** (`usage: {include: true}`) : récupérer coût réel
   et tokens servis depuis le cache, et les historiser (préparation de
   l'encart « Routage » de R3).

Le tout sans rien casser pour les fournisseurs non-OpenRouter : **chaque
champ est optionnel et absent par défaut** ; un provider sans ces champs
produit exactement les requêtes actuelles (aucun champ nouveau dans le
body). Aucun de ces réglages ne s'applique au moteur Claude.

## Périmètre des fichiers

| Fichier | Nature du changement |
|---|---|
| `sidecar/src/engine.ts` | corps de requête `chat.send`, parsing SSE/usage |
| `sidecar/src/usageStats.ts` | 3 champs optionnels de l'événement d'usage |
| `sidecar/test/protocol.test.js` | cas de test (voir §Tests) |
| `ui/src/providerAdmin.ts` | `ProviderConfig` étendu (config non-secrète) |
| `ui/src/sidecar.ts` | `ProviderPayload` étendu + type retour `chat.send` |
| `ui/src/ProvidersPage.tsx` | formulaire fournisseur : 3 champs opt-in |
| `docs/protocol.md` | sections `providers.set`, `chat.send`, événement S1 |

Interdits (déjà en vigueur) : jamais de clé API loguée/écrite ; l'UI ne
parle qu'au protocole ; zéro dépendance runtime nouvelle.

## 1. Modèle de données

### `ProviderConfig` (ui/src/providerAdmin.ts) — champs optionnels ajoutés

```ts
export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  headers?: Record<string, string>;
  /** R0 — ids de modèles de secours, dans l'ordre d'essai (OpenRouter `models`). */
  fallbackModels?: string[];
  /** R0 — router chaque appel vers l'endpoint le moins cher (OpenRouter `provider.sort`). */
  priceSort?: boolean;
  /** R0 — demander coût réel + tokens cachés dans l'usage (OpenRouter `usage.include`). */
  usageAccounting?: boolean;
}
```

- `isProviderConfig` ne change pas (les nouveaux champs ne sont pas
  requis) ; validation souple : `fallbackModels` gardé seulement si tableau
  de chaînes non vides, booléens gardés seulement si `typeof === "boolean"`.
- `pushProviders` relaie les trois champs dans `ProviderPayload`.
- `DEFAULT_PROVIDERS` : inchangé (opt-in pur).

### `providers.set` (sidecar/src/engine.ts, interface `Provider`)

Mêmes trois champs optionnels, même validation souple dans
`handleProvidersSet` (un champ mal formé est ignoré, pas d'erreur).

## 2. Corps de requête `chat.send` (engine.ts)

Après la construction actuelle du `body`, si le provider résolu porte les
champs :

```ts
if (provider.fallbackModels?.length) {
  // modèle demandé en tête, secours ensuite, sans doublon
  body.models = [model, ...provider.fallbackModels.filter((m) => m !== model)];
}
if (provider.priceSort) {
  body.provider = { sort: "price" };
}
if (provider.usageAccounting) {
  body.usage = { include: true };
}
```

Notes de conformité OpenRouter :
- quand `models` est présent, OpenRouter ignore `model` — on l'envoie quand
  même (inoffensif, et les endpoints OpenAI-compatibles stricts qui ignorent
  `models` continuent de fonctionner) ;
- `:floor` (suffixe de slug) N'est PAS implémenté : `priceSort` couvre le
  besoin sans verrouiller un endpoint unique.

## 3. Parsing SSE et usage (engine.ts)

### Modèle réellement utilisé

Les objets SSE OpenRouter portent un champ `model` (slug effectivement
servi, qui peut différer du demandé quand `models` a joué). Dans
`dispatchEvent` : si `isNonEmptyString(obj.model)`, mémoriser dans une
variable `modelUsed` (dernière valeur vue).

### Usage étendu

```ts
interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;        // usage.cost (nombre) — OpenRouter usage accounting
  cachedTokens: number | null;   // usage.prompt_tokens_details.cached_tokens
}
```

`extractUsage` lit les deux nouveaux champs quand présents et bien typés
(`number` fini), `null` sinon. Aucun champ n'est requis : les fournisseurs
qui ne les envoient pas produisent `null` (comportement identique à
aujourd'hui).

### `done` enrichi

`emitter.done(id, { finishReason, usage, modelUsed })` — `modelUsed: string
| null` (null si jamais vu dans le flux). Le cas `aborted` envoie
`modelUsed` aussi (l'info est déjà connue), `usage: null` inchangé.

## 4. Événement d'usage (usageStats.ts)

`RecordUsageEventInput` et l'événement écrit gagnent trois champs optionnels
(défaut `null`) :

```ts
modelUsed?: string | null;   // slug réellement servi si différent/connu
costUsd?: number | null;     // coût réel remonté par le fournisseur
cachedTokens?: number | null;
```

`recordChatSendUsage` (engine.ts) les remplit depuis `usage`/`modelUsed`.
Les agrégats existants (`usage.stats`) ne changent pas dans R0 — les champs
sont historisés pour l'encart « Routage » de R3. `claude.ts` et
`neutralAgent.ts` ne passent pas ces champs (ils restent `null`).

## 5. UI — ProvidersPage.tsx

Dans le formulaire d'édition d'un fournisseur (fournisseurs neutres
uniquement), une sous-section « Routage OpenRouter (optionnel) » :

- **Modèles de secours** : champ texte, ids séparés par des virgules ou
  retours ligne → `fallbackModels` (trim, vides retirés ; champ vide →
  propriété absente). Aide : « Essayés dans l'ordre si le modèle demandé est
  indisponible (rate-limit, contexte, panne). »
- **Trier par prix** : case à cocher → `priceSort` (décochée → propriété
  absente). Aide : « Chaque appel part vers l'endpoint le moins cher du
  modèle. »
- **Comptabilité d'usage** : case à cocher → `usageAccounting`. Aide :
  « Historise le coût réel et les tokens servis depuis le cache
  (Supervision). »

Libellés en français, patron visuel des champs existants de la page. Pas de
condition sur l'id du provider : les champs sont proposés pour tout
fournisseur neutre (un serveur OpenAI-compatible strict qui rejetterait ces
champs → l'utilisateur ne les coche simplement pas ; documenter cette limite
dans l'aide de la sous-section).

## 6. docs/protocol.md

- `providers.set` : documenter les trois champs optionnels du provider.
- `chat.send` : documenter l'effet des trois champs sur le body, et le
  `done` enrichi (`modelUsed`).
- Section S1 (événement d'usage) : les trois champs optionnels.

## 7. Tests (sidecar/test/protocol.test.js, faux serveur existant)

1. **Body sans réglages** : provider sans les champs → body strictement
   identique à aujourd'hui (ni `models`, ni `provider`, ni `usage`).
2. **Body avec réglages** : provider avec `fallbackModels: ["b", "a"]`,
   `priceSort: true`, `usageAccounting: true`, modèle demandé `"a"` →
   `models = ["a", "b"]` (dédupliqué, demandé en tête),
   `provider = {sort:"price"}`, `usage = {include:true}`.
3. **`modelUsed` capturé** : flux SSE dont les chunks portent
   `model: "b"` → `done.modelUsed === "b"`.
4. **Usage étendu** : dernier chunk avec
   `usage: {prompt_tokens, completion_tokens, cost,
   prompt_tokens_details: {cached_tokens}}` → `done.usage` complet et
   événement JSONL avec `costUsd`/`cachedTokens` remplis.
5. **Validation providers.set** : `fallbackModels` mal formé (pas un
   tableau de chaînes) → ignoré sans erreur, le provider reste utilisable.

## 8. Critères d'acceptation

- [ ] `npm run sidecar:test` passe (nouveaux cas inclus).
- [ ] Un provider sans les nouveaux champs produit un body octet pour octet
      identique à l'actuel (test 1).
- [ ] Les trois réglages sont éditables dans Configuration, persistés dans
      la config non-secrète, et survivent à un redémarrage (push au boot).
- [ ] Aucune clé API dans les logs ni dans la config non-secrète.
- [ ] `docs/protocol.md` à jour.
- [ ] Vérification manuelle sur OpenRouter réel (un appel avec
      `usageAccounting` → `costUsd` non nul dans `events.jsonl`) — à faire
      par l'utilisateur, l'app n'est jamais lancée par l'agent.

## Hors périmètre R0 (rappel)

- `cache_control` Anthropic via OpenRouter (ordonnancement cache-friendly) → R4.
- Choix automatique du modèle (`model: auto`, tiers) → R1/R2.
- Encart « Routage » dans Supervision, plafond de débord → R3.
