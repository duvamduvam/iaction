/*
 * Abonnement Claude — utilisation hebdomadaire, et le PIC de saturation dont
 * le reste de la page a besoin.
 *
 * Sorti de `SupervisionPage.tsx` en T-068 : la page passait sous le cliquet de
 * taille, et surtout l'encart Routage avait besoin de la même donnée. Elle est
 * désormais chargée UNE fois par la page et distribuée, au lieu d'être lue
 * deux fois par deux panneaux qui s'ignorent.
 *
 * La distinction qui structure ce fichier : la fenêtre 7 jours est une donnée
 * d'HABITUDE (l'ai-je bien utilisé cette semaine ?), la fenêtre 5 h est une
 * donnée de RARETÉ (suis-je en train de saturer maintenant ?). Elles ne se
 * lisent pas dans le même sens — 40 % sur 7 jours est un sous-usage, 40 % sur
 * 5 h est un début d'alerte — et c'est pourquoi elles ne sont pas fondues en
 * un seul chiffre.
 */
import { useEffect, useMemo, useState } from "react";

import { calculerRythmeQuota, type RythmeQuota } from "./rythmeQuota";
import { usageClaudeHistory, type ClaudeWindowSnapshot, type UsageRoutage, type UsageSobriete } from "./usageStatsClient";
import type { Periode } from "./supervisionPeriode";

/** Profondeur d'historique chargée par la page (une seule requête pour tous). */
export const CLAUDE_HISTORY_DAYS = 180;

/**
 * Charge l'historique des fenêtres d'abonnement, une fois pour la page.
 * `null` tant que la réponse n'est pas là ; `errored` distingue « pas encore »
 * de « pas possible » — les deux affichaient le même vide auparavant.
 */
export function useHistoriqueAbonnement(): {
  snapshots: ClaudeWindowSnapshot[] | null;
  errored: boolean;
} {
  const [snapshots, setSnapshots] = useState<ClaudeWindowSnapshot[] | null>(null);
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    usageClaudeHistory(CLAUDE_HISTORY_DAYS)
      .then((snaps) => {
        if (!cancelled) setSnapshots(snaps);
      })
      .catch(() => {
        if (!cancelled) setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { snapshots, errored };
}

/**
 * T-068 — pic d'utilisation d'une fenêtre d'abonnement SUR LA PÉRIODE affichée.
 *
 * C'est le signal de rareté qui manquait en face de « part à coût nul » : un
 * tour d'abonnement est gratuit pour le portefeuille et coûteux pour le quota,
 * et l'indicateur affichait 98 % de gratuité pendant que la fenêtre 5 h
 * saturait (pic mesuré à 104 %).
 *
 * PIC et non moyenne : c'est le pic qui déclenche le refus, et une moyenne
 * lissée sur la période dirait « 30 % » d'une journée où plus rien ne passait.
 */
export function picFenetreSurPeriode(
  snapshots: ClaudeWindowSnapshot[] | null,
  cle: string,
  periode: Periode,
): number | null {
  if (!snapshots) return null;
  let pic: number | null = null;
  for (const s of snapshots) {
    // `ts` est un ISO UTC, `periode` des dates LOCALES : la comparaison passe
    // par la date locale de l'instantané, sans quoi les relevés du soir
    // tomberaient dans la période suivante.
    const d = new Date(s.ts);
    if (Number.isNaN(d.getTime())) continue;
    const jour = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (jour < periode.from || jour > periode.to) continue;
    const w = s.windows[cle];
    if (!w) continue;
    pic = pic === null ? w.utilization : Math.max(pic, w.utilization);
  }
  return pic;
}

function formatUsd(v: number): string {
  return `${v.toFixed(2)} $`;
}

/**
 * T-072 — dernière utilisation CONNUE d'une fenêtre : l'INSTANT présent, pas
 * le pic sur une période (`picFenetreSurPeriode` répond à une autre question
 * — « ai-je saturé pendant CETTE période ? »). `null` si aucun instantané ne
 * porte cette fenêtre.
 */
function derniereUtilization(snapshots: ClaudeWindowSnapshot[] | null, cle: string): number | null {
  if (!snapshots) return null;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const w = snapshots[i].windows[cle];
    if (w) return w.utilization;
  }
  return null;
}

/**
 * T-072 — les trois devises de l'étude (§6.1), JAMAIS additionnées : le
 * quota d'abonnement (une RARETÉ, pas un prix), la dépense réellement payée
 * (le seul argent qui sort), et le coût équivalent API (ce que vaudrait
 * l'abonnement facturé à l'usage). Aucun outil de l'état de l'art ne les
 * réunit dans une seule vue (§5.2) — chacune garde ici sa PROPRE légende de
 * calcul : confondre « prix remonté par la source » et « recalculé au tarif
 * catalogue » serait retomber dans le minorant silencieux de T-035.
 *
 * Ne DOUBLONNE pas les encarts existants : le pic 5 h de la période vit dans
 * le panneau Routage, l'historique 7 j dans le graphe ci-dessus. Celui-ci
 * répond à une question que ni l'un ni l'autre ne pose seul : les trois
 * chiffres, CÔTE À CÔTE, au même instant.
 */
export function TroisDevisesPanel({
  snapshots,
  routage,
  sobriete,
}: Readonly<{
  snapshots: ClaudeWindowSnapshot[] | null;
  routage: UsageRoutage | null;
  sobriete: UsageSobriete | null;
}>) {
  const quotaCinqH = derniereUtilization(snapshots, "five_hour");
  const quotaSeptJ = derniereUtilization(snapshots, "seven_day");
  return (
    <section className="panel">
      <div className="panel__title">Trois devises, jamais additionnées</div>
      <div className="supervision-kpi-grid">
        <div className="supervision-kpi-card">
          <div className="panel__title" title="Relevé le plus récent de l'API Claude — une RARETÉ, pas un prix.">
            Quota d'abonnement
          </div>
          <div className="supervision-kpi-value">{quotaCinqH !== null ? `${Math.round(quotaCinqH)} %` : "—"}</div>
          <div className="supervision-kpi-sub">
            fenêtre 5 h · {quotaSeptJ !== null ? `${Math.round(quotaSeptJ)} % sur 7 j` : "7 j : —"} · relevé le
            plus récent
          </div>
        </div>
        <div className="supervision-kpi-card">
          <div
            className="panel__title"
            title="Prix REMONTÉ par la source (costUsd des fournisseurs payants) — le seul argent qui sort."
          >
            Dépense réelle
          </div>
          <div className="supervision-kpi-value">{routage ? formatUsd(routage.coutPeriodeUsd) : "—"}</div>
          <div className="supervision-kpi-sub">période affichée · prix remonté par la source</div>
        </div>
        <div className="supervision-kpi-card">
          <div
            className="panel__title"
            title="RECALCULÉ au tarif catalogue (modelUsage.costUSD, T-066) — ce que l'abonnement vaudrait facturé à l'usage."
          >
            Coût équivalent API
          </div>
          <div className="supervision-kpi-value">{sobriete ? formatUsd(sobriete.coutVentileUsd) : "—"}</div>
          <div className="supervision-kpi-sub">
            recalculé au tarif catalogue
            {sobriete && sobriete.toursAvecCout > 0 ? ` · sur ${sobriete.toursAvecCout} tour(s) ventilé(s)` : ""}
          </div>
        </div>
      </div>
      <p className="empty-hint">
        Trois grandeurs différentes, jamais additionnées : une rareté (le quota), un prix remonté par la source
        (la dépense réelle), et un prix recalculé au tarif catalogue (l'équivalent API). Voir
        docs/etude-supervision.md §6.1.
      </p>
    </section>
  );
}

/**
 * T-072 — une ligne de rythme pour une fenêtre : l'utilisation actuelle, le
 * rythme mesuré (points de quota/minute), et le mur projeté ou la raison de
 * son absence.
 */
function LigneRythme({ rythme, libelle }: Readonly<{ rythme: RythmeQuota | null; libelle: string }>) {
  if (!rythme) {
    return (
      <div className="supervision-kpi-card">
        <div className="panel__title">{libelle}</div>
        <div className="supervision-kpi-value">—</div>
        <div className="supervision-kpi-sub">Aucun relevé sur cette fenêtre.</div>
      </div>
    );
  }
  const heureMur = rythme.murIso
    ? new Date(rythme.murIso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <div className="supervision-kpi-card">
      <div className="panel__title">{libelle}</div>
      <div className="supervision-kpi-value">{Math.round(rythme.utilizationActuelle)} %</div>
      <div className="supervision-kpi-sub">
        {rythme.pctParMinute !== null ? `${rythme.pctParMinute.toFixed(2)} pt de quota/min` : "rythme non mesuré"}
      </div>
      <div className={`supervision-kpi-sub${heureMur ? " supervision-kpi-sub--alerte" : ""}`}>
        {heureMur ? `à ce rythme, mur vers ${heureMur}` : (rythme.raisonAbsence ?? "—")}
      </div>
    </div>
  );
}

/**
 * T-072 — rythme de combustion et projection de fin de fenêtre (§6.1 : « est-
 * ce que je tape le mur avant ce soir ? », ccusage blocks). Mesuré en POINTS
 * DE QUOTA PAR MINUTE, pas en tokens/minute — voir rythmeQuota.ts pour
 * pourquoi un tokens/min serait ici un chiffre inventé (l'API ne publie
 * jamais les tokens bruts consommés dans une fenêtre, seulement `utilization`).
 */
export function RythmeQuotaPanel({ snapshots }: Readonly<{ snapshots: ClaudeWindowSnapshot[] | null }>) {
  const rythmeCinqH = useMemo(
    () => (snapshots ? calculerRythmeQuota(snapshots, "five_hour") : null),
    [snapshots],
  );
  if (!snapshots) {
    return (
      <section className="panel">
        <div className="panel__title">Rythme de combustion — fenêtre 5 h</div>
        <p className="empty-hint">Chargement…</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <div className="panel__title">Rythme de combustion — fenêtre 5 h</div>
      <div className="supervision-kpi-grid">
        <LigneRythme rythme={rythmeCinqH} libelle="Fenêtre 5 h en cours" />
      </div>
      <p className="empty-hint">
        Points de quota par minute entre deux relevés de LA MÊME fenêtre. Une fenêtre presque vide, des relevés
        trop rapprochés, ou un rythme nul ou négatif ne s'extrapolent pas : la raison est dite plutôt qu'un mur
        inventé.
      </p>
    </section>
  );
}

interface SevenDayPoint {
  ts: string;
  pct: number;
  /**
   * `resetsAt` ANNONCÉ par CE relevé — c'est l'échéance de la fenêtre
   * d'abonnement en cours au moment du relevé, et donc la CLÉ qui identifie
   * cette fenêtre (T-100) : deux relevés qui partagent le même `resetsAt`
   * appartiennent à la même fenêtre, quelle que soit la semaine ISO où ils
   * tombent.
   */
  resetsAt: string;
}

function extractSevenDayPoint(snap: ClaudeWindowSnapshot): SevenDayPoint | null {
  // Le nommage de cette fenêtre n'est pas garanti à 100 % par l'API
  // expérimentale (voir docs/protocol.md § usage.claude) — la clé attendue
  // est `seven_day`, tolérance simple si absente.
  const w = snap.windows.seven_day;
  return w ? { ts: snap.ts, pct: w.utilization, resetsAt: w.resetsAt } : null;
}

export interface FenetreSummary {
  /** `resetsAt` de la fenêtre — identifiant du groupe ET date de sa clôture. */
  resetsAt: string;
  max: number;
  enCours: boolean;
  /** T-100 — le pic peut être un MINORANT (voir `SEUIL_MINORANT_MS`). */
  incertaine: boolean;
}

/**
 * T-100 — la barre d'une fenêtre est un `Math.max` sur les relevés qu'elle
 * contient : elle ne peut que SOUS-estimer, et sous-estime justement quand la
 * sonde s'est tue AVANT la remise à zéro de la fenêtre (panne, saturation qui
 * empêche la sonde elle-même de mesurer — voir T-059, T-085/T-086). Le
 * regroupement par `resetsAt` (et non plus par semaine ISO) permet de comparer
 * DIRECTEMENT le dernier relevé d'une fenêtre à SA propre clôture, sans passer
 * par une comparaison entre relevés consécutifs.
 *
 * Seuil à 30 min : la sonde relève environ toutes les 5 min (voir
 * `REPRISE_PLAFOND_MS` dans cadenceUsage.ts) — 30 min laisse la marge de
 * quelques relevés manqués d'affilée avant de déclarer le pic incertain, sans
 * réagir au moindre relevé simplement un peu en retard.
 */
export const SEUIL_MINORANT_MS = 30 * 60 * 1000;

/** T-100 — le dernier relevé d'une fenêtre close est trop loin de sa clôture : le pic enregistré est un minorant. */
function estMinorant(dernierTs: string, resetsAt: string): boolean {
  const finMs = new Date(resetsAt).getTime();
  const dernierMs = new Date(dernierTs).getTime();
  if (!Number.isFinite(finMs) || !Number.isFinite(dernierMs)) return false;
  return finMs - dernierMs > SEUIL_MINORANT_MS;
}

/**
 * Échelle de couleur INVERSÉE par rapport à une jauge de risque : la cible est
 * 100 % — l'abonnement est payé, le sous-consommer est le gaspillage. Rouge =
 * semaine très en dessous de la cible, turquoise = cible atteinte.
 */
function weekColor(pct: number): string {
  if (pct >= 90) return "var(--status-ok)";
  if (pct >= 70) return "var(--neon-cyan)";
  if (pct >= 40) return "var(--status-warn)";
  return "var(--status-error)";
}

/**
 * T-100 — regroupe les relevés par fenêtre d'ABONNEMENT, identifiée par la
 * valeur de `resetsAt` qu'ils annoncent, et non plus par semaine ISO : le
 * découpage ISO (lundi 00:00) n'a aucun rapport avec le cycle réel — la
 * fenêtre 7 jours se réinitialise le samedi à 20:00, et deux relevés du même
 * `resetsAt` appartiennent à la MÊME fenêtre quelle que soit la semaine ISO où
 * ils tombent (et une semaine ISO peut à l'inverse chevaucher deux fenêtres).
 *
 * `points` DOIT être trié chronologiquement — c'est l'ordre déjà rendu par
 * `usage.claude.history` (voir usageStatsClient.ts) : le dernier point vu pour
 * une fenêtre donnée est donc bien son dernier relevé.
 *
 * `maintenant` est un paramètre (et non `new Date()` en dur) pour rester
 * testable sans dépendre de l'horloge système, comme `avancementPeriode` dans
 * supervisionPeriode.ts.
 */
export function summarizeByResetWindow(
  points: SevenDayPoint[],
  maintenant: Date = new Date(),
): FenetreSummary[] {
  const groupes = new Map<string, { max: number; dernierTs: string }>();
  for (const p of points) {
    const g = groupes.get(p.resetsAt);
    if (g) {
      g.max = Math.max(g.max, p.pct);
      g.dernierTs = p.ts; // points triés chronologiquement : le dernier vu est le plus récent
    } else {
      groupes.set(p.resetsAt, { max: p.pct, dernierTs: p.ts });
    }
  }
  const fenetres = Array.from(groupes.entries()).sort(
    (a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime(),
  );
  const nowMs = maintenant.getTime();
  // Fenêtre en cours : la première dont la clôture est encore dans le futur —
  // à défaut (tout est déjà clos), la dernière fenêtre connue.
  let indexEnCours = fenetres.findIndex(([resetsAt]) => new Date(resetsAt).getTime() > nowMs);
  if (indexEnCours === -1) indexEnCours = fenetres.length - 1;
  return fenetres.map(([resetsAt, { max, dernierTs }], i) => {
    const enCours = i === indexEnCours;
    return { resetsAt, max, enCours, incertaine: !enCours && estMinorant(dernierTs, resetsAt) };
  });
}

const WEEK_H = 260;
const WEEK_BAR_W = 44;
const WEEK_GAP = 18;
/** Marge au-dessus des barres : la valeur en % s'y écrit. */
const WEEK_TOP = 26;
/** Marge sous les barres : l'étiquette de clôture de fenêtre s'y écrit. */
const WEEK_BOTTOM = 24;
/** Colonne de droite réservée à la légende « 100 % » de la ligne repère. */
const WEEK_AXIS_W = 52;
/** Plafond d'affichage au-delà de 100 % : un peu de marge visuelle pour la ligne repère. */
const WEEK_CEIL = 120;
/**
 * Largeur totale visée : celle de la légende sous le graphe — au-delà, on
 * n'affiche que les fenêtres les plus récentes plutôt que d'étaler l'encart.
 */
const WEEK_CHART_W = 620;
const WEEKS_SHOWN = Math.floor((WEEK_CHART_W - WEEK_AXIS_W + WEEK_GAP) / (WEEK_BAR_W + WEEK_GAP));

/**
 * T-100 — étiquette courte sous la barre : la date de CLÔTURE de la fenêtre
 * (son `resetsAt`), pas un numéro de semaine ISO qui n'a plus de sens pour un
 * cycle samedi→samedi.
 */
function etiquetteCloture(resetsAt: string): string {
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return "?";
  const jour = String(d.getDate()).padStart(2, "0");
  const mois = String(d.getMonth() + 1).padStart(2, "0");
  return `→${jour}/${mois}`;
}

/** Libellé long (title/tooltip) : jour, date et heure de clôture en français, ou fenêtre en cours. */
function libelleLongFenetre(f: FenetreSummary, valeur: string): string {
  if (f.enCours) return "fenêtre en cours";
  const d = new Date(f.resetsAt);
  const jourSemaine = d.toLocaleDateString("fr-FR", { weekday: "short" }).replace(/\.$/, "");
  const jourMois = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  const heure = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const base = `fenêtre close le ${jourSemaine} ${jourMois} ${heure} — pic ${valeur}`;
  return f.incertaine ? `${base} · minorant : le dernier relevé précède la clôture de plus de 30 min` : base;
}

function ClaudeWeeklyChart({ fenetres }: Readonly<{ fenetres: FenetreSummary[] }>) {
  const barsW = fenetres.length * (WEEK_BAR_W + WEEK_GAP) - WEEK_GAP;
  const width = Math.max(barsW, 160) + WEEK_AXIS_W;
  const yFor = (pct: number) =>
    WEEK_TOP + WEEK_H - (Math.min(WEEK_CEIL, Math.max(0, pct)) / WEEK_CEIL) * WEEK_H;
  const y100 = yFor(100);
  return (
    <div className="supervision-chart-wrap">
      <svg
        width={width}
        height={WEEK_TOP + WEEK_H + WEEK_BOTTOM}
        role="img"
        aria-label="Utilisation de l'abonnement Claude par fenêtre, en pourcentage de la fenêtre 7 jours"
      >
        <line x1={0} x2={width} y1={y100} y2={y100} className="supervision-line-ref" />
        <text x={width} y={y100 - 6} textAnchor="end" className="supervision-week-axis">
          cible 100 %
        </text>
        {fenetres.map((f, i) => {
          const y = yFor(f.max);
          // T-059/T-100 — le dernier relevé de la fenêtre précédait sa
          // clôture de plus de 30 min : le pic enregistré est un MINORANT,
          // pas une mesure. Pas de classe de hachures dans App.css : un
          // libellé suffisamment explicite plutôt qu'un style inventé pour
          // l'occasion.
          const valeur = f.incertaine ? `≥ ${Math.round(f.max)} %` : `${Math.round(f.max)} %`;
          const infobulle = libelleLongFenetre(f, valeur);
          return (
            <g key={f.resetsAt} transform={`translate(${i * (WEEK_BAR_W + WEEK_GAP)},0)`}>
              <title>{infobulle}</title>
              <rect
                x={0}
                y={y}
                width={WEEK_BAR_W}
                height={WEEK_TOP + WEEK_H - y}
                rx={3}
                style={{ fill: weekColor(f.max), opacity: f.enCours ? 0.55 : 1 }}
              />
              <text
                x={WEEK_BAR_W / 2}
                y={Math.max(16, y - 8)}
                textAnchor="middle"
                className="supervision-week-value"
                style={{ fill: weekColor(f.max) }}
              >
                {valeur}
              </text>
              <text
                x={WEEK_BAR_W / 2}
                y={WEEK_TOP + WEEK_H + 17}
                textAnchor="middle"
                className="supervision-week-label"
              >
                {etiquetteCloture(f.resetsAt)}
                {f.enCours ? " ·" : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function ClaudeSubscriptionPanel({
  snapshots,
  errored,
}: Readonly<{ snapshots: ClaudeWindowSnapshot[] | null; errored: boolean }>) {
  const points = useMemo(() => {
    if (!snapshots) return [];
    const out: SevenDayPoint[] = [];
    for (const s of snapshots) {
      const p = extractSevenDayPoint(s);
      if (p !== null) out.push(p);
    }
    return out;
  }, [snapshots]);

  const fenetres = useMemo(() => summarizeByResetWindow(points), [points]);

  return (
    <section className="panel">
      <div className="panel__title">Abonnement Claude — utilisation hebdomadaire</div>
      {snapshots === null && !errored && <p className="empty-hint">Chargement…</p>}
      {errored && <p className="empty-hint empty-hint--error">Historique indisponible (sidecar injoignable ?).</p>}
      {snapshots !== null && !errored && fenetres.length === 0 && (
        <p className="empty-hint">Pas encore d'historique — il se construit au fil de l'usage.</p>
      )}
      {fenetres.length > 0 && (
        <>
          <ClaudeWeeklyChart fenetres={fenetres.slice(-WEEKS_SHOWN)} />
          <div className="supervision-hist-legend">
            <span>
              <i className="supervision-legend-dot supervision-legend-dot--ok" /> ≥ 90 %
            </span>
            <span>
              <i className="supervision-legend-dot supervision-legend-dot--cyan" /> 70–89 %
            </span>
            <span>
              <i className="supervision-legend-dot supervision-legend-dot--warn" /> 40–69 %
            </span>
            <span>
              <i className="supervision-legend-dot supervision-legend-dot--error" /> &lt; 40 %
            </span>
          </div>
          <p className="empty-hint">
            Fenêtre = pic de la fenêtre glissante 7 jours, entre deux remises à zéro de l'abonnement (samedi 20:00) ;
            cible 100 % (l'abonnement est payé, le rouge signale le sous-usage). Fenêtre en cours (·) encore
            partielle, barre estompée.
          </p>
        </>
      )}
    </section>
  );
}
