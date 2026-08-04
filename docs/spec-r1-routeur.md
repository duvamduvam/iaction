# Spec R1 — Routeur heuristique + `model: auto` au Chat (Lot 14, phase R1)

Statut : **spec fermée, prête à déléguer** (2026-07-27).
Cadre : `docs/etude-routage-llm.md` §6 (table « Local d'abord », `auto`
défaut au Chat, badge + override, affinité de session). Taille : 1 lot.

## Objectif

Un module de routage dans le sidecar qui classe une requête en **tier de
complexité** (heuristique pure, zéro appel réseau) et renvoie la cible
moteur/modèle d'après une **table configurable** ; la page Chat passe en
`Auto (routeur)` par défaut pour les **nouvelles** conversations, avec badge
du choix et override.

Hors périmètre R1 (rappel) : classificateur LLM (R2), surcharge par projet
(R2), débord/fenêtres/plafond (R3), page Projets (R2, opt-in).

## 1. Sidecar — nouveau module `sidecar/src/router.ts`

Patron général : même style que `engine.ts` (état en mémoire, validation
souple, erreurs françaises lisibles, `EngineEmitter`).

### 1.1 Tiers et table

```ts
export type RouteTier = "trivial" | "simple" | "moyen" | "complexe";
export interface RouteTarget {
  engine: "claude" | "neutral";
  providerId?: string;   // requis si engine === "neutral"
  model: string;
}
export type RoutingTable = Record<RouteTier, RouteTarget>;
```

**Table par défaut codée en dur** (utilisée tant que `router.set` n'a pas
été appelé, et pour compléter un tier manquant) :

| tier | cible |
|---|---|
| trivial | neutral · ollama · `qwen3.5:4b` |
| simple | claude · `claude-haiku-4-5` |
| moyen | claude · `claude-sonnet-5` |
| complexe | claude · `claude-fable-5` |

### 1.2 Méthode `router.set`

`params: { table: Partial<RoutingTable> }` — validation souple par tier
(entrée invalide → tier ignoré avec repli sur le défaut, PAS d'erreur
globale) ; `done: { count }` (nb de tiers valides retenus). Remplace la
table courante (fusion avec les défauts, comme `providers.set` remplace la
table providers).

### 1.3 Classification — fonction pure exportée

```ts
export interface ClassifyInput {
  text: string;
  historyTurns?: number;      // tours déjà dans la conversation
  attachmentsCount?: number;
}
export function classify(input: ClassifyInput): { tier: RouteTier; score: number; reasons: string[] }
```

Barème (points cumulés ; les libellés `reasons` sont en français, courts,
ex. « bloc de code », « demande d'édition ») :

| Signal | Points |
|---|---|
| longueur > 400 caractères | +2 |
| longueur > 1500 caractères | +3 (cumulable avec le précédent) |
| code présent (``` ou ≥ 2 `…` inline ou motifs `foo(bar)` / chemin de fichier) | +2 |
| marqueur de raisonnement (« pourquoi », « explique », « analyse », « compare », « conçois », « architecture », « stratégie », « étape par étape », « plan », why/explain/analyze/design/plan) | +2 |
| demande d'édition/agentique (« modifie », « implémente », « corrige », « refactor », « crée », « écris le code », « ajoute la fonction », fix/implement/refactor/write) | +3 |
| pièce jointe | +1 chacune (plafond +3) |
| historique > 10 tours | +1 |

Seuils : score ≤ 1 → `trivial` · 2-4 → `simple` · 5-7 → `moyen` · ≥ 8 →
`complexe`. Détection insensible à la casse/accents (normaliser NFD). La
fonction est pure et exportée pour les tests unitaires ; les listes de
marqueurs sont des constantes du module (ajustables sans toucher la
logique).

### 1.4 Méthode `router.route`

`params: { text: string, historyTurns?: number, attachmentsCount?: number }`
→ `done: { tier, score, reasons, target: RouteTarget }`.

- `target` = table courante[tier].
- AUCUNE vérification de disponibilité du provider ici (c'est l'UI qui
  connaît la table des fournisseurs déclarés) — le routeur est pur.
- `text` manquant/vide → `error` « params.text manquant ou invalide ».

### 1.5 Branchement protocole

`sidecar/src/index.ts` : dispatch de `router.set` / `router.route` (même
patron que les méthodes engine).

## 2. Traçabilité — `meta.routeTier`

- `usageStats.ts` : `normalizeMeta` accepte et persiste un champ optionnel
  `routeTier: string | null` dans l'événement (défaut null). Prépare
  l'encart « Routage » de R3 — aucune agrégation nouvelle en R1.
- L'UI passe `meta.routeTier` dans `chat.send` et `claude.start` quand le
  tour a été routé (voir §3).

## 3. UI

### 3.1 `ui/src/routerAdmin.ts` (nouveau)

Patron `providerAdmin.ts`, en plus simple (aucun secret) :
- config non-secrète, clé racine `"routing"` = `{ table: Partial<RoutingTable> }`
  (lecture → fusion → écriture via `appConfig.ts`) ;
- `DEFAULT_ROUTING_TABLE` exportée (identique aux défauts sidecar §1.1) ;
- `readRoutingTable()` / `writeRoutingTable(table)` ;
- `pushRouting(table)` → wrapper `routerSet` de `sidecar.ts`.
- Push au démarrage et après chaque sauvegarde : même mécanique que les
  providers (`providersBus`/`useProviders`) — s'accrocher au même signal
  « sidecar prêt » ; suivre le patron existant sans le dupliquer inutilement.

### 3.2 `ui/src/sidecar.ts`

Wrappers typés `routerSet(table)` et `routerRoute({text, historyTurns,
attachmentsCount})` (mêmes conventions que l'existant).

### 3.3 Configuration — section « Routage automatique »

Dans `ProvidersPage.tsx` (page Configuration), nouvelle section
« Routage automatique (model: auto) » :
- 4 lignes (trivial/simple/moyen/complexe), chacune : sélecteur moteur
  (Claude abonnement / Fournisseur neutre), sélecteur de fournisseur (si
  neutre : parmi les providers déclarés), champ modèle (texte libre avec
  `datalist` des modèles connus du fournisseur quand disponible) ;
- bouton Enregistrer → `writeRoutingTable` + `pushRouting` ;
- texte d'aide : « Table du sélecteur “Auto” : chaque niveau de complexité
  part vers ce moteur/modèle. Un projet pourra la surcharger (à venir). » ;
- libellés français, patron visuel des sections existantes de la page.

### 3.4 ChatPage — `Auto (routeur)` par défaut

- Le sélecteur de modèle gagne une entrée **« Auto (routeur) »** en tête
  (valeur sentinelle `"__auto__"`).
- **Défaut pour toute NOUVELLE conversation** ; les conversations
  existantes conservent leur choix persisté (aucune migration).
- **Affinité de session** : au premier envoi d'une conversation en auto,
  l'UI appelle `router.route` puis mémorise la cible dans l'état persisté
  de la conversation (`routedTarget` + `routedTier`) ; les tours suivants
  réutilisent cette cible SANS re-router (préserve les caches). Repasser le
  sélecteur sur un modèle explicite efface `routedTarget` (override) ;
  revenir sur Auto re-route au prochain envoi.
- **Exécution** : cible `engine: "claude"` → chemin `claude.start` existant
  avec le `model` de la cible ; `engine: "neutral"` → `chat.send` avec
  `providerId`/`model` de la cible. `meta.routeTier` passé dans les deux cas.
- **Repli** : si la cible neutre référence un provider absent de la table
  déclarée, replier sur le tier supérieur (trivial→simple→moyen→complexe) ;
  si aucun utilisable, garder le comportement actuel du sélecteur manuel et
  afficher l'erreur habituelle. Pas de modale dédiée.
- **Badge** : chaque tour envoyé en auto affiche près des métadonnées du
  message le badge `⚡ auto : <tier> → <modèle>` avec, en infobulle
  (`title`), les `reasons` du classement. Patron visuel des badges/méta
  existants de la transcription.

## 4. docs/protocol.md

Nouvelle section « Méthodes R1 — routage » : `router.set`, `router.route`
(paramètres, done, erreurs, table par défaut), + mention de `meta.routeTier`
dans la section événement S1.

## 5. Tests (sidecar/test/protocol.test.js)

1. `classify` — cas unitaires (import direct du module compilé) :
   - « Salut, ça va ? » → trivial ;
   - « Explique pourquoi ce test échoue » (court, marqueur) → simple ;
   - texte > 400 chars avec bloc ``` et « implémente » → moyen ou complexe
     (fixer l'attendu exact d'après le barème) ;
   - > 1500 chars + code + édition + 2 pièces jointes → complexe.
2. `router.route` sans `router.set` → cible = défauts codés.
3. `router.set` partiel (un seul tier valide + un tier invalide) →
   fusion défauts, done.count = 1, le tier invalide reste au défaut.
4. `router.route` avec table poussée → cible poussée.
5. Événement d'usage : un `chat.send` avec `meta.routeTier: "simple"` →
   ligne JSONL avec `routeTier: "simple"` (étendre le cas S1 existant).

## 6. Critères d'acceptation

- [ ] `npm run sidecar:test` et `npm run ui:build` verts.
- [ ] Nouvelle conversation Chat = Auto par défaut ; badge tier→modèle sur
      les tours routés ; override à un clic ; conversations existantes
      intactes.
- [ ] Table éditable dans Configuration, persistée, poussée au boot.
- [ ] Un tour routé produit un événement d'usage avec `routeTier`.
- [ ] `docs/protocol.md` à jour.
- [ ] Aucun changement de comportement pour un utilisateur qui choisit un
      modèle explicite.
