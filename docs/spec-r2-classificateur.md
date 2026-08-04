# Spec R2 — Classificateur local + `auto` partout + surcharge projet (Lot 14, phase R2)

Statut : **spec fermée, prête à déléguer** (2026-07-27). Dépend de R1.
Cadre : `docs/etude-routage-llm.md` §6. Taille : ½ lot.

## Objectif

1. **Classificateur LLM local** pour les cas où l'heuristique hésite.
2. **`model: auto` étendu** : page Projets (opt-in), agents YAML, tâches
   planifiées.
3. **Surcharge de la table par projet** (`.iaction/routage.yaml`).

## 1. Classificateur LLM (sidecar/src/router.ts)

- Config du routeur étendue (via `router.set`, et config UI `"routing"`) :
  `classifier: { providerId: string, model: string } | null` — défaut
  `{ providerId: "ollama", model: "qwen3.5:4b" }` ; `null` = désactivé.
- **Déclenchement** : seulement quand le score heuristique est à ±1 d'une
  frontière de tier (2, 5, 8) — sinon l'heuristique suffit.
- **Appel** : complétion NON streamée via le provider résolu par
  `getProvider()` (helpers `joinUrl`/`buildHeaders` exportés d'engine.ts) ;
  prompt système court : classer le message en un seul mot parmi
  `trivial|simple|moyen|complexe` (prompt en français, température 0,
  `max_tokens` ~4). Réponse illisible ou hors liste → tier heuristique.
- **Timeout 3 s** (`AbortSignal.timeout`) → repli heuristique silencieux
  (le routeur ne doit JAMAIS ralentir sensiblement un envoi).
- `router.route` : `done` gagne `method: "heuristique" | "llm"` ; nouveau
  param optionnel `allowLlm?: boolean` (défaut true ; false = tests et
  appels internes pressés).

## 2. Surcharge par projet

- Fichier `<projet>/.iaction/routage.yaml` (parseur `yaml` déjà en
  dépendance) :

```yaml
table:            # tiers partiels acceptés — le reste hérite du global
  trivial: { engine: neutral, providerId: ollama, model: qwen3.5:4b }
  complexe: { engine: claude, model: claude-fable-5 }
classifier: { providerId: ollama, model: qwen3.5:4b }   # optionnel
```

- `router.route` gagne `cwd?: string` : si fourni et que le fichier existe,
  fusion `défauts ← table globale ← table projet` (lecture à chaque appel,
  tolérante : YAML invalide → ignoré + `reasons` mentionne « routage.yaml
  invalide » ; fichier petit, pas de cache).
- L'UI passe `cwd` quand un projet est actif (Projets) ; le Chat global n'en
  passe pas.

## 3. `auto` étendu

### Page Projets (AgentPage) — opt-in
- Le sélecteur de modèle gagne « Auto (routeur) » (sentinelle `"__auto__"`),
  **jamais défaut**. Routage au premier envoi de la session sur le texte du
  prompt (+ `cwd` du projet), affinité de session, badge et
  `meta.routeTier` : mêmes règles que ChatPage en R1 (§3.4 de la spec R1).

### Agents YAML (`.iaction/agents/*.yaml`)
- `engine: auto` accepté (le champ `model` peut alors être omis ou `auto`).
- À l'exécution (orchestrator.ts, et exécution d'agent seul), la résolution
  appelle le routeur en interne (fonction exportée de router.ts, pas un
  aller-retour protocole) sur le texte de la tâche de l'étape, avec le `cwd`
  du run — un `engine`/`model` explicites priment toujours (décision grill).
- Validation `agents.*` : accepter la nouvelle valeur ; documentation du
  format mise à jour (protocol.md et étude si besoin).

### Tâches planifiées (taches.ts)
- Même principe : un LLM déclaré `auto` dans `tache.yaml` est résolu via le
  routeur au lancement du run (texte = prompt de la tâche, `cwd` = dossier
  de la tâche). Suivre le format LLM existant du manifeste (lire taches.ts)
  et n'ajouter que la valeur `auto`.

## 4. Traçabilité

`router.route` (et la résolution interne) renvoient toujours
`method`/`tier` ; tous les chemins passent `meta.routeTier` (déjà persisté
depuis R1).

## 5. Tests

1. Ambiguïté : score à ±1 d'une frontière + faux serveur classificateur qui
   répond « complexe » → tier `complexe`, `method: "llm"`.
2. Classificateur en panne/timeout → tier heuristique, `method:
   "heuristique"`, pas d'erreur.
3. `routage.yaml` projet : surcharge partielle fusionnée ; YAML invalide →
   table globale + mention dans `reasons`.
4. Agent YAML `engine: auto` : l'orchestrateur route l'étape (faux serveurs
   des deux moteurs, vérifier la cible choisie).

## 6. Critères d'acceptation

- [ ] `npm run sidecar:test` + `npm run ui:build` verts.
- [ ] Un envoi Chat/Projets n'est jamais retardé de plus de ~3 s par le
      classificateur (timeout démontré par test).
- [ ] `engine: auto` fonctionne dans une orchestration réelle de test.
- [ ] `docs/protocol.md` à jour (router.route étendu, formats YAML).
