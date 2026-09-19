/*
 * T-071 — agrégat « sobriété » de `usage.stats` (docs/etude-supervision.md §6).
 *
 * Module à part, même patron que `usageProjets.ts` (S2) et pour la même
 * raison : usageStats.ts dépassait le cliquet de taille, et découper est la
 * réponse attendue. Feuille PURE — l'accumulateur entre, l'objet sort, aucune
 * E/S.
 */
import { isNonEmptyString, isPlainObject } from "./base.js";

/* ---------------------------------------------------------------------------
 * T-066/T-071 — agrégat « sobriété » (docs/etude-supervision.md §6).
 *
 * Trois familles, réunies ici parce qu'elles partagent le même balayage :
 * FIABILITÉ (le contrepoids honnête du coût — jamais un coût sans qualité en
 * regard), DÉLÉGATION et CACHE (issus de la ventilation T-066), et les
 * DISTRIBUTIONS (contexte, durée, concentration du coût).
 *
 * Toutes les grandeurs qui viennent de la ventilation portent leur propre
 * dénominateur (`toursVentiles`) : l'historique écrit avant T-066 n'en a pas,
 * et une part calculée sur un dénominateur muet est un chiffre faux qui a
 * l'air juste. Voir T-035 — un minorant se DIT.
 * ------------------------------------------------------------------------- */

export interface SobrieteAgg {
  toursErreur: number;
  toursAbandon: number;
  parCause: Map<string, number>;
  /** T-082 — les interruptions ont leur propre ventilation : les fondre dans
      `parCause` remettrait un usage normal dans la colonne des pannes, ce que
      cette correction vient précisément d'arrêter. */
  parCauseAbandon: Map<string, number>;
  toursVentiles: number;
  toursAvecDelegation: number;
  tokensParRole: { fil: number; delegue: number; inconnu: number };
  parModeleReel: Map<string, { tokens: number; costUsd: number; toursDelegue: number }>;
  cacheRead: number;
  cacheCreation: number;
  entreeFraiche: number;
  coutsParTour: number[];
  contextes: number[];
  durees: number[];
  heures: number[];
}

export function newSobrieteAgg(): SobrieteAgg {
  return {
    toursErreur: 0,
    toursAbandon: 0,
    parCause: new Map(),
    parCauseAbandon: new Map(),
    toursVentiles: 0,
    toursAvecDelegation: 0,
    tokensParRole: { fil: 0, delegue: 0, inconnu: 0 },
    parModeleReel: new Map(),
    cacheRead: 0,
    cacheCreation: 0,
    entreeFraiche: 0,
    coutsParTour: [],
    contextes: [],
    durees: [],
    heures: new Array<number>(24).fill(0),
  };
}

/** Cause d'échec regroupée : le `subtype` du SDK, ou la classe HTTP. Jamais le corps. */
function classerCause(ev: Record<string, unknown>): string {
  const brut = typeof ev.errorMessage === "string" ? ev.errorMessage.trim() : "";
  if (brut.length === 0) {
    // T-076 — enquête du 2026-08-29 : les 17 occurrences mesurées datent
    // TOUTES du 20-31 juillet, avant l'introduction du champ `errorMessage`
    // (commit a5435c6, 2026-08-01) — la clé n'existe même pas dans leur JSON.
    // La classe est datée pour dire que c'est de l'HISTOIRE, pas un défaut
    // courant : depuis le 2026-08-02, zéro nouvelle occurrence.
    return "(aucune cause enregistrée, antérieur au 2026-08-01)";
  }
  const sdk = /résultat Claude:\s*(\S+)/.exec(brut);
  if (sdk) return sdk[1];
  const http = /^HTTP (\d{3})/.exec(brut);
  if (http) return `HTTP ${http[1]}`;
  return brut.length > 60 ? `${brut.slice(0, 60)}…` : brut;
}

export function applySobrieteEvent(agg: SobrieteAgg, ev: Record<string, unknown>, d: Date): void {
  agg.heures[d.getHours()] += 1;

  if (ev.status === "error") {
    agg.toursErreur += 1;
    const cause = classerCause(ev);
    agg.parCause.set(cause, (agg.parCause.get(cause) ?? 0) + 1);
  } else if (ev.status === "aborted") {
    agg.toursAbandon += 1;
    // T-082 — « arrêt demandé » et « permission refusée » ne se corrigent pas
    // de la même façon : les compter ensemble ne dirait rien à personne.
    // L'historique écrit avant T-082 n'a pas de cause : il tombe dans
    // `(aucune cause enregistrée)`, ce qui est exact et se voit.
    const cause = classerCause(ev);
    agg.parCauseAbandon.set(cause, (agg.parCauseAbandon.get(cause) ?? 0) + 1);
  }

  if (typeof ev.contextTokens === "number" && ev.contextTokens > 0) {
    agg.contextes.push(ev.contextTokens);
  }
  if (typeof ev.durationMs === "number" && ev.durationMs >= 0) {
    agg.durees.push(ev.durationMs);
  }

  if (!Array.isArray(ev.ventilation) || ev.ventilation.length === 0) {
    return;
  }
  agg.toursVentiles += 1;
  let coutDuTour = 0;
  let aDelegue = false;
  for (const brut of ev.ventilation) {
    if (!isPlainObject(brut) || !isNonEmptyString(brut.model)) {
      continue;
    }
    const nombre = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const tokens = nombre(brut.inputTokens) + nombre(brut.outputTokens);
    const role = brut.role === "fil" || brut.role === "delegue" ? brut.role : "inconnu";
    agg.tokensParRole[role] += tokens;
    if (role === "delegue") aDelegue = true;

    agg.cacheRead += nombre(brut.cacheReadTokens);
    agg.cacheCreation += nombre(brut.cacheCreationTokens);
    agg.entreeFraiche += nombre(brut.inputTokens);

    const cout = nombre(brut.costUsd);
    coutDuTour += cout;
    const m = agg.parModeleReel.get(brut.model) ?? { tokens: 0, costUsd: 0, toursDelegue: 0 };
    m.tokens += tokens;
    m.costUsd += cout;
    if (role === "delegue") m.toursDelegue += 1;
    agg.parModeleReel.set(brut.model, m);
  }
  if (aDelegue) agg.toursAvecDelegation += 1;
  if (coutDuTour > 0) agg.coutsParTour.push(coutDuTour);
}

/** Centile d'un échantillon déjà trié croissant ; `null` si vide. */
function centile(triees: number[], p: number): number | null {
  if (triees.length === 0) return null;
  const i = Math.min(triees.length - 1, Math.floor((triees.length - 1) * p));
  return triees[i];
}

export function finalizeSobriete(agg: SobrieteAgg): Record<string, unknown> {
  const contextes = [...agg.contextes].sort((a, b) => a - b);
  const durees = [...agg.durees].sort((a, b) => a - b);
  const couts = [...agg.coutsParTour].sort((a, b) => b - a); // décroissant
  const coutTotal = couts.reduce((s, c) => s + c, 0);
  const hautDeQueue = couts.slice(0, Math.max(1, Math.ceil(couts.length * 0.1)));
  const entreeTotale = agg.cacheRead + agg.cacheCreation + agg.entreeFraiche;

  return {
    // Fiabilité — calculable sur TOUT l'historique, sans le socle.
    toursErreur: agg.toursErreur,
    toursAbandon: agg.toursAbandon,
    parCause: [...agg.parCause.entries()]
      .map(([cause, tours]) => ({ cause, tours }))
      .sort((a, b) => b.tours - a.tours),
    parCauseAbandon: [...agg.parCauseAbandon.entries()]
      .map(([cause, tours]) => ({ cause, tours }))
      .sort((a, b) => b.tours - a.tours),

    // Délégation — dénominateur explicite : 0 tour ventilé = rien à dire.
    toursVentiles: agg.toursVentiles,
    toursAvecDelegation: agg.toursAvecDelegation,
    tokensFil: agg.tokensParRole.fil,
    tokensDelegue: agg.tokensParRole.delegue,
    tokensRoleInconnu: agg.tokensParRole.inconnu,
    parModeleReel: [...agg.parModeleReel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.tokens - a.tokens),

    // Cache — `null` tant qu'aucune entrée n'a été mesurée, jamais 0 %.
    cacheReadTokens: agg.cacheRead,
    cacheCreationTokens: agg.cacheCreation,
    cacheHitPct: entreeTotale > 0 ? Math.round((agg.cacheRead / entreeTotale) * 100) : null,

    // Concentration — dit OÙ agir : habitudes, ou poignée de tours.
    coutVentileUsd: coutTotal,
    toursAvecCout: couts.length,
    concentrationTop10Pct:
      coutTotal > 0 ? Math.round((hautDeQueue.reduce((s, c) => s + c, 0) / coutTotal) * 100) : null,
    coutTourMedianUsd: centile([...couts].reverse(), 0.5),
    coutTourMaxUsd: couts.length > 0 ? couts[0] : null,

    // Distributions — remplacent « Contexte moyen », dont la médiane était de 6.
    contexteMedian: centile(contextes, 0.5),
    contexteP90: centile(contextes, 0.9),
    dureeMedianeMs: centile(durees, 0.5),
    dureeP90Ms: centile(durees, 0.9),

    // Heures LOCALES — la grille d'activité.
    heures: agg.heures,
  };
}
