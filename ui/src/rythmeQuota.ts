/*
 * T-072 — rythme de combustion et projection de fin de fenêtre (docs/etude-
 * supervision.md §6.1 : « est-ce que je tape le mur avant ce soir ? »,
 * ccusage blocks). Feuille pure : les instantanés `usageClaudeHistory` sont
 * déjà chargés par la page, aucune E/S ici.
 *
 * ── Ce qu'on mesure, et ce qu'on ne prétend PAS mesurer ──────────────────
 * L'API Claude ne publie qu'un pourcentage d'utilisation (`utilization`) par
 * fenêtre, jamais de tokens bruts consommés DANS la fenêtre — la conversion
 * tokens → % est propriétaire (pondération par modèle inconnue de nous). Le
 * rythme est donc calculé en POINTS DE QUOTA PAR MINUTE (delta d'utilisation
 * / delta de temps entre deux instantanés de la MÊME fenêtre), pas en
 * tokens/minute : afficher un tokens/min inventé serait le même minorant
 * silencieux que celui corrigé en T-035.
 *
 * ── Ce qui ne s'extrapole pas ─────────────────────────────────────────────
 * Un seul relevé sur la fenêtre courante, des relevés trop rapprochés, ou un
 * rythme nul/négatif (repli, ou fenêtre qui vient de se réinitialiser) : la
 * projection reste absente et `raisonAbsence` le dit — un chiffre de mur
 * inventé sur une fenêtre presque vide serait pire que pas de chiffre du
 * tout.
 */
import type { ClaudeWindowSnapshot } from "./usageStatsClient";

export interface RythmeQuota {
  cle: string;
  utilizationActuelle: number;
  resetsAt: string;
  /** `null` tant qu'aucun rythme n'a pu être mesuré. */
  pctParMinute: number | null;
  /** ISO du mur estimé (utilisation à 100 %) — `null` si non extrapolable. */
  murIso: string | null;
  /** Pourquoi la projection est absente. Vide (`null`) quand `murIso` est renseigné. */
  raisonAbsence: string | null;
}

/**
 * Deux instantanés portent la MÊME fenêtre si leur `resetsAt` coïncide à la
 * minute (même tolérance que `fenetresAbonnement.ts` côté sidecar : `resetsAt`
 * porte des microsecondes qui bougent à chaque lecture pour une fenêtre
 * inchangée).
 */
function memeFenetre(a: string, b: string): boolean {
  return a.slice(0, 16) === b.slice(0, 16);
}

/**
 * `null` si aucun instantané ne porte la fenêtre `cle`. Sinon un rythme —
 * avec projection quand elle a un sens, sinon `raisonAbsence` expliqué.
 */
export function calculerRythmeQuota(
  snapshots: readonly ClaudeWindowSnapshot[],
  cle: string,
): RythmeQuota | null {
  const points = snapshots
    .filter((s) => s.windows[cle])
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (points.length === 0) return null;

  const dernier = points[points.length - 1];
  const fenetreDerniere = dernier.windows[cle];
  const memeGroupe = points.filter((s) => memeFenetre(s.windows[cle].resetsAt, fenetreDerniere.resetsAt));
  const premier = memeGroupe[0];

  const base: RythmeQuota = {
    cle,
    utilizationActuelle: fenetreDerniere.utilization,
    resetsAt: fenetreDerniere.resetsAt,
    pctParMinute: null,
    murIso: null,
    raisonAbsence: null,
  };

  if (memeGroupe.length < 2) {
    return { ...base, raisonAbsence: "Un seul relevé sur cette fenêtre — pas assez de recul pour un rythme." };
  }

  const minutes = (new Date(dernier.ts).getTime() - new Date(premier.ts).getTime()) / 60_000;
  if (!(minutes > 0)) {
    return { ...base, raisonAbsence: "Relevés trop rapprochés pour mesurer un rythme." };
  }

  const deltaUtil = fenetreDerniere.utilization - premier.windows[cle].utilization;
  const pctParMinute = deltaUtil / minutes;
  if (!(pctParMinute > 0)) {
    return { ...base, pctParMinute, raisonAbsence: "Rythme nul ou négatif sur cette fenêtre — rien à extrapoler." };
  }
  if (fenetreDerniere.utilization >= 100) {
    return { ...base, pctParMinute, raisonAbsence: "Fenêtre déjà saturée." };
  }

  const minutesRestantes = (100 - fenetreDerniere.utilization) / pctParMinute;
  const mur = new Date(new Date(dernier.ts).getTime() + minutesRestantes * 60_000);
  return { ...base, pctParMinute, murIso: mur.toISOString() };
}
