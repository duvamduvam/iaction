# Spec R3 — Débord, plafond, encart « Routage » (Lot 14, phase R3)

Statut : **spec fermée, prête à déléguer** (2026-07-27). Dépend de R1 (R2
souhaitable). Cadre : `docs/etude-routage-llm.md` §6 (débord auto + bandeau,
plafond mensuel + coupure) et §9 (défauts). Taille : ½ lot.

## Objectif

Le routeur tient compte de l'**état des fenêtres d'abonnement** : cible abo
saturée → débord vers une cible payante déclarée, plafonné au mois ; l'UI
l'affiche (bandeau) ; Supervision gagne un encart « Routage ».

## 1. Config routage étendue (`"routing"` UI + `router.set`)

```ts
debord: {
  target: RouteTarget;          // défaut : neutral · openrouter · "deepseek/deepseek-chat"
  seuilPct: number;             // défaut 90 (fenêtre 5 h)
  plafondEurosMois: number | null; // défaut 10 ; null = pas de plafond
} 
```

Éditable dans la section « Routage automatique » de Configuration (champ
cible + seuil + plafond, aide en français). L'aide précise : « le plafond
s'appuie sur les coûts réels historisés — activer “Comptabilité d'usage”
sur le fournisseur de débord » (R0).

## 2. Sidecar

### 2.1 Lecture des fenêtres (usageStats.ts)

Exporter une fonction interne `readLatestClaudeWindows(): Promise<{
fiveHourPct: number | null, sevenDayPct: number | null } | null>` (dernier
instantané de claude-windows.jsonl, lecture tolérante existante).

### 2.2 Dépense débord du mois (usageStats.ts)

Exporter `autoDebordCostUsdThisMonth(): Promise<number>` : somme des
`costUsd` des événements du mois calendaire courant portant
`routeDebord: true` (nouveau champ meta persisté, comme `routeTier`).
Conversion €/$ : NON — le plafond est comparé en USD et le libellé UI dit
« $ » (renommer le champ config `plafondUsdMois` partout ; l'étude parlait
d'euros, on grave USD = la devise d'OpenRouter, plus honnête sans taux de
change).

### 2.3 Décision de débord (router.ts)

Dans `router.route` (et la résolution interne), quand la cible du tier est
`engine: "claude"` :

1. `readLatestClaudeWindows()` ; si `fiveHourPct >= seuilPct` :
   - si `plafondUsdMois` non atteint → `target = debord.target`,
     `done` gagne `debord: { active: true, fiveHourPct }` ; l'UI passera
     `meta.routeDebord: true` sur ce tour ;
   - si plafond atteint → repli **local** : `target = table.trivial`,
     `done.debord = { active: false, blocked: true, fiveHourPct }`.
2. Pas d'instantané disponible → pas de débord (comportement R1).

### 2.4 Encart « Routage » (usage.stats)

Étendre l'agrégat `usage.stats` (période déjà gérée) avec :

```ts
routage: {
  parTier: Record<string, { tours: number }>;        // routeTier des événements
  toursAuto: number;                                  // événements avec routeTier
  partCoutNulPct: number | null;                      // (engine claude + providers locaux) / total
  mixAbo: Array<{ model: string, tours: number }>;    // engine claude par modèle
  debordMoisUsd: number;                              // somme costUsd routeDebord du mois
}
```

« Provider local » = même heuristique que `scripts/usage-baseline.mjs`
(id contenant ollama/local/lmstudio) — factoriser la règle dans
usageStats.ts, le script peut rester autonome.

## 3. UI

- **Bandeau** (ChatPage + AgentPage, patron des bandeaux existants) :
  - `debord.active` → « ⚠ Mode débord : abonnement saturé (fenêtre 5 h à
    N %) — tour envoyé sur <modèle payant> » ;
  - `debord.blocked` → « ⛔ Plafond débord atteint (N $/mois) — repli sur le
    modèle local ».
  - Le bandeau apparaît au tour concerné et disparaît quand le routage
    redevient normal.
- `meta.routeDebord: true` passé sur les tours débordés.
- **SupervisionPage** : nouvel encart « Routage » — part des tours auto,
  répartition par tier, part à coût nul, mix intra-abo (modèles), dépense
  débord du mois vs plafond. Rappel affiché : « estimations d'après le
  journal local » (règle BENCH_DISCLAIMER).

## 4. Tests

1. Fenêtre 5 h ≥ seuil (instantané forgé dans un HOME de test) → cible =
   débord, `debord.active`.
2. Plafond atteint (événements forgés `routeDebord`+`costUsd`) → repli
   trivial, `debord.blocked`.
3. Pas d'instantané → routage R1 inchangé.
4. `usage.stats` : agrégat `routage` correct sur événements forgés
   (tiers, part coût nul, mix abo, somme débord).

## 5. Critères d'acceptation

- [ ] `npm run sidecar:test` + `npm run ui:build` verts.
- [ ] Le payant choisi MANUELLEMENT n'est jamais bloqué ni bandeau-isé
      (le plafond ne concerne que le débord automatique).
- [ ] `docs/protocol.md` à jour (config débord, done router.route,
      usage.stats étendu, meta.routeDebord).
- [ ] Cible chiffrée : à fixer après 2 semaines de relevés post-R1
      (hors code — rappel étude §7).
