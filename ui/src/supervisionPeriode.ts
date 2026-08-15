/*
 * Arithmétique de période de la page Supervision : dates locales `YYYY-MM-DD`
 * (aucune dépendance date), semaines ISO (lundi), navigation ◀ ▶ d'une période.
 *
 * Extrait de SupervisionPage.tsx pour être testable sans monter le composant —
 * c'est la partie où une régression est silencieuse (dérive des mois courts,
 * semaine ISO à cheval sur deux années). Voir T-033.
 */
import type { UsageBucketKind } from "./usageStatsClient";

/* ---------- Dates locales YYYY-MM-DD ---------- */

export function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayLocalStr(): string {
  return formatLocalDate(new Date());
}

export function addDaysStr(s: string, days: number): string {
  const d = parseLocalDate(s);
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

export function addMonthsStr(s: string, months: number): string {
  const d = parseLocalDate(s);
  d.setMonth(d.getMonth() + months);
  return formatLocalDate(d);
}

export function firstOfMonthStr(s: string): string {
  const d = parseLocalDate(s);
  return formatLocalDate(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function lastOfMonthStr(s: string): string {
  const d = parseLocalDate(s);
  return formatLocalDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/** Lundi ISO de la semaine contenant `s`. */
export function mondayOfWeekStr(s: string): string {
  const d = parseLocalDate(s);
  const dow = d.getDay(); // 0 = dimanche
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  return formatLocalDate(d);
}

/** Semaine ISO (lundi) d'une date : `{année, semaine}`. */
export function isoWeekInfo(d: Date): { year: number; week: number } {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (date.getDay() + 6) % 7; // lundi = 0
  date.setDate(date.getDate() - dayNum + 3); // jeudi de cette semaine
  const firstThursday = new Date(date.getFullYear(), 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { year: date.getFullYear(), week };
}

export function isoWeekKey(d: Date): string {
  const { year, week } = isoWeekInfo(d);
  return `${year}-S${String(week).padStart(2, "0")}`;
}

/* ---------- Période analysée = LA sélection (un jour, une semaine ISO, un mois) ----------
 *
 * Le bucket n'est pas qu'une granularité d'histogramme : c'est la période sur
 * laquelle portent les KPI, les modèles, les projets et le routage. « Semaine »
 * = la semaine ISO de l'ancre, pas trente jours regroupés par semaine — sans
 * quoi Jour et Semaine affichaient les mêmes chiffres et ◀ ▶ sautait d'un mois
 * (T-033).
 */

export interface Periode {
  from: string;
  to: string;
}

export function periodRange(bucket: UsageBucketKind, anchor: string): Periode {
  if (bucket === "day") return { from: anchor, to: anchor };
  if (bucket === "month") return { from: firstOfMonthStr(anchor), to: lastOfMonthStr(anchor) };
  const lundi = mondayOfWeekStr(anchor);
  return { from: lundi, to: addDaysStr(lundi, 6) };
}

/**
 * Navigation ◀ ▶ d'UNE période. Le décalage part du DÉBUT de la période (1er du
 * mois, lundi) : ajouter des mois à une ancre du 31 dériverait au fil des mois
 * courts (31 mars − 1 mois = 3 mars). Plafonné à `today` — on ne navigue pas
 * dans le futur.
 */
export function shiftAnchor(
  bucket: UsageBucketKind,
  anchor: string,
  dir: 1 | -1,
  today: string = todayLocalStr(),
): string {
  const { from } = periodRange(bucket, anchor);
  let shifted: string;
  if (bucket === "month") shifted = addMonthsStr(from, dir);
  else if (bucket === "week") shifted = addDaysStr(from, dir * 7);
  else shifted = addDaysStr(from, dir);
  return shifted > today ? today : shifted;
}

/**
 * Cran AU-DESSUS de la sélection : jour → sa semaine, semaine → son mois,
 * mois → son année. C'est la fenêtre du graphique de courbes — on regarde
 * toujours la période choisie dans le contexte qui la contient.
 *
 * Les bornes sont étendues aux BUCKETS ENTIERS (semaine → lundi..dimanche
 * débordant du mois) : une semaine tronquée par le bord du mois dessinerait un
 * creux d'activité qui n'existe pas.
 */
export function superRange(bucket: UsageBucketKind, anchor: string): Periode {
  if (bucket === "day") return periodRange("week", anchor);
  if (bucket === "week") {
    const mois = periodRange("month", anchor);
    return { from: mondayOfWeekStr(mois.from), to: addDaysStr(mondayOfWeekStr(mois.to), 6) };
  }
  const an = parseLocalDate(anchor).getFullYear();
  return { from: `${an}-01-01`, to: `${an}-12-31` };
}

/**
 * Fenêtre effectivement tracée : le cran au-dessus, TRONQUÉ à la période en
 * cours. Sans cette coupe, la semaine en cours traînerait trois jours à zéro et
 * l'année courante quatre mois vides — un effondrement d'activité purement
 * optique, sur des périodes qui ne sont pas encore arrivées.
 */
export function trendRange(bucket: UsageBucketKind, anchor: string, today: string = todayLocalStr()): Periode {
  const zone = superRange(bucket, anchor);
  const finCourante = periodRange(bucket, today).to;
  const to = zone.to > finCourante ? finCourante : zone.to;
  return { from: zone.from, to: to < zone.from ? zone.from : to };
}

export function formatPeriodLabel(bucket: UsageBucketKind, periode: Periode): string {
  const d = parseLocalDate(periode.from);
  if (bucket === "day") {
    return d.toLocaleDateString("fr-FR", { weekday: "short", day: "2-digit", month: "long", year: "numeric" });
  }
  if (bucket === "month") {
    return d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  }
  const fin = parseLocalDate(periode.to);
  const jour = (x: Date) => x.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
  return `S${isoWeekInfo(d).week} · ${jour(d)} — ${jour(fin)} ${fin.getFullYear()}`;
}

/**
 * Sous-titre de la carte « Dépense de la période » (T-035, précisé par T-036).
 *
 * ── Pourquoi deux compteurs et pas un ───────────────────────────────────
 * Un total qui ne compte pas tout est un minorant, et le dire vaut mieux que
 * de laisser lire un total faux — c'était T-035. Mais « on ne sait pas » et
 * « il n'y a rien à savoir » ne demandent pas la même chose au lecteur :
 *
 * - `inconnus` : le fournisseur POURRAIT remonter un coût et ne l'a pas fait.
 *   Il y a une comptabilité d'usage à cocher — c'est actionnable.
 * - `nonRemontes` : le fournisseur ne remonte jamais de coût, par construction
 *   (`usage.cost` est une extension OpenRouter). Aucun réglage n'y changera
 *   rien, et l'utilisateur n'a rien à chercher.
 *
 * Les confondre, c'était envoyer chercher un réglage qui n'existe pas.
 */
export function libelleDepense(inconnus: number, nonRemontes: number): string {
  const parts: string[] = [];
  if (inconnus > 0) {
    parts.push(`${inconnus} tour${inconnus > 1 ? "s" : ""} sans coût remonté`);
  }
  if (nonRemontes > 0) {
    parts.push(
      `${nonRemontes} tour${nonRemontes > 1 ? "s" : ""} chez un fournisseur qui n'en remonte jamais`,
    );
  }
  return parts.length > 0 ? `au moins — ${parts.join(", ")}` : "tout le payant, débord et choix manuel";
}
