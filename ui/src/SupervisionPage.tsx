/*
 * Page « Supervision » (Lot 8, tranche 1) : usage local agrégé (tours,
 * conversations, tokens, modèles) via `usage.stats`, et suivi de la fenêtre
 * d'abonnement Claude 7 jours via `usage.claude.history` — voir
 * docs/protocol.md § « Méthodes S1 — supervision d'usage ». Tout est calculé
 * côté sidecar depuis l'historique JSONL local ; cette page ne fait que
 * mettre en forme.
 */
import { useEffect, useMemo, useState } from "react";
import { formatTokens } from "./fableUsage";
import { readRoutingDebord } from "./routerAdmin";
import {
  usageClaudeHistory,
  usageStats,
  type ClaudeWindowSnapshot,
  type UsageBucket,
  type UsageBucketKind,
  type UsageRoutage,
  type UsageStats,
} from "./usageStatsClient";
import { useRovingFocus } from "./useRovingFocus";

/* ---------- Dates locales YYYY-MM-DD (pas de dépendance date) ---------- */

function parseLocalDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayLocalStr(): string {
  return formatLocalDate(new Date());
}

function addDaysStr(s: string, days: number): string {
  const d = parseLocalDate(s);
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

function addMonthsStr(s: string, months: number): string {
  const d = parseLocalDate(s);
  d.setMonth(d.getMonth() + months);
  return formatLocalDate(d);
}

function firstOfMonthStr(s: string): string {
  const d = parseLocalDate(s);
  return formatLocalDate(new Date(d.getFullYear(), d.getMonth(), 1));
}

function formatRangeLabel(from: string, to: string): string {
  const fmt = (s: string) =>
    parseLocalDate(s).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
  return `${fmt(from)} — ${fmt(to)}`;
}

/** Semaine ISO (lundi) d'une date : `{année, semaine}`. */
function isoWeekInfo(d: Date): { year: number; week: number } {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNum = (date.getDay() + 6) % 7; // lundi = 0
  date.setDate(date.getDate() - dayNum + 3); // jeudi de cette semaine
  const firstThursday = new Date(date.getFullYear(), 0, 4);
  const firstDayNum = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return { year: date.getFullYear(), week };
}

function isoWeekKey(d: Date): string {
  const { year, week } = isoWeekInfo(d);
  return `${year}-S${String(week).padStart(2, "0")}`;
}

/* ---------- Fenêtre affichée : 30 derniers jours (jour/semaine), 6 derniers mois (mois) ---------- */

function windowSpan(bucket: UsageBucketKind): { unit: "days" | "months"; amount: number } {
  return bucket === "month" ? { unit: "months", amount: 6 } : { unit: "days", amount: 30 };
}

function computeFrom(bucket: UsageBucketKind, to: string): string {
  const span = windowSpan(bucket);
  if (span.unit === "months") return firstOfMonthStr(addMonthsStr(to, -(span.amount - 1)));
  return addDaysStr(to, -(span.amount - 1));
}

/** Navigation ◀ ▶ par plage entière, plafonnée à aujourd'hui. */
function shiftAnchor(bucket: UsageBucketKind, to: string, dir: 1 | -1): string {
  const span = windowSpan(bucket);
  const shifted = span.unit === "months" ? addMonthsStr(to, dir * span.amount) : addDaysStr(to, dir * span.amount);
  const today = todayLocalStr();
  return shifted > today ? today : shifted;
}

/* ---------- Sélecteur de période ---------- */

const BUCKET_ITEMS: { id: UsageBucketKind; label: string }[] = [
  { id: "day", label: "Jour" },
  { id: "week", label: "Semaine" },
  { id: "month", label: "Mois" },
];

function PeriodSelector({
  bucket,
  onBucket,
  from,
  to,
  onPrev,
  onNext,
  onToday,
  atToday,
}: Readonly<{
  bucket: UsageBucketKind;
  onBucket: (b: UsageBucketKind) => void;
  from: string;
  to: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  atToday: boolean;
}>) {
  // Sélecteur aux flèches, activation manuelle (Entrée / Espace) — voir Nav dans App.tsx.
  const roving = useRovingFocus<HTMLElement>({
    selector: ".config-subnav__item:not(:disabled)",
    orientation: "horizontal",
  });
  return (
    <div className="supervision-toolbar">
      <nav
        className="config-subnav"
        aria-label="Granularité de la période"
        ref={roving.containerRef}
        onKeyDown={roving.onKeyDown}
        onFocus={roving.onFocus}
      >
        {BUCKET_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`config-subnav__item${bucket === item.id ? " config-subnav__item--active" : ""}`}
            onClick={() => onBucket(item.id)}
            aria-current={bucket === item.id ? "true" : undefined}
            tabIndex={bucket === item.id ? 0 : -1}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="supervision-range-nav">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onPrev}
          title="Plage précédente"
          aria-label="Plage précédente"
        >
          ◀
        </button>
        <span className="supervision-range-label">{formatRangeLabel(from, to)}</span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onNext}
          disabled={atToday}
          title="Plage suivante"
          aria-label="Plage suivante"
        >
          ▶
        </button>
        <button type="button" className="btn btn--ghost" onClick={onToday} disabled={atToday}>
          Aujourd'hui
        </button>
      </div>
    </div>
  );
}

/* ---------- Cartes KPI ---------- */

function orchPct(totals: UsageStats["totals"]): number | null {
  if (totals.tours <= 0) return null;
  return (totals.orchTours / totals.tours) * 100;
}

function KpiCards({ totals }: Readonly<{ totals: UsageStats["totals"] }>) {
  const pct = orchPct(totals);
  return (
    <div className="supervision-kpi-grid">
      <div className="panel supervision-kpi-card">
        <div className="panel__title">Conversations</div>
        <div className="supervision-kpi-value">{totals.conversations}</div>
      </div>
      <div className="panel supervision-kpi-card">
        <div className="panel__title">Tours</div>
        <div className="supervision-kpi-value">{totals.tours}</div>
        <div className="supervision-kpi-sub">
          {pct !== null ? `dont orchestration : ${totals.orchTours} (${Math.round(pct)} %)` : "dont orchestration : —"}
        </div>
      </div>
      <div className="panel supervision-kpi-card">
        <div className="panel__title">Contexte moyen</div>
        <div className="supervision-kpi-value">
          {totals.avgPromptTokens !== null ? formatTokens(Math.round(totals.avgPromptTokens)) : "—"}
        </div>
      </div>
      <div className="panel supervision-kpi-card">
        <div className="panel__title">Tokens totaux</div>
        <div className="supervision-kpi-value">{formatTokens(totals.totalTokens)}</div>
      </div>
    </div>
  );
}

/* ---------- Modèles les plus utilisés ---------- */

function ModelsPanel({ models }: Readonly<{ models: UsageStats["models"] }>) {
  const max = models.reduce((m, x) => Math.max(m, x.tours), 0);
  return (
    <section className="panel">
      <div className="panel__title">Modèles les plus utilisés</div>
      {models.length === 0 ? (
        <p className="empty-hint">Aucun tour sur cette période.</p>
      ) : (
        <div className="supervision-models-list">
          {models.map((m) => (
            <div key={`${m.engine}:${m.model}`} className="supervision-model-row">
              <div className="supervision-model-name" title={`${m.model} — moteur ${m.engine}`}>
                <span className="supervision-model-name__label">{m.model}</span>
                <span className="supervision-model-name__engine">{m.engine}</span>
              </div>
              <div className="supervision-model-bar-track">
                <div
                  className="supervision-model-bar-fill"
                  style={{ width: max > 0 ? `${(m.tours / max) * 100}%` : "0%" }}
                />
              </div>
              <div className="supervision-model-metrics">
                {m.tours} tour{m.tours > 1 ? "s" : ""} · {formatTokens(m.totalTokens)}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- Histogramme des buckets ---------- */

function bucketLabel(bucket: UsageBucketKind, start: string): string {
  const d = parseLocalDate(start);
  if (bucket === "day") return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  if (bucket === "week") return `S${isoWeekInfo(d).week}`;
  return d.toLocaleDateString("fr-FR", { month: "short" });
}

const HIST_HEIGHT = 130;
const HIST_BAR_W = 20;
const HIST_GAP = 8;

function Histogram({ bucket, buckets }: Readonly<{ bucket: UsageBucketKind; buckets: UsageBucket[] }>) {
  const max = buckets.reduce((m, b) => Math.max(m, b.tours), 0);
  const width = Math.max(buckets.length * (HIST_BAR_W + HIST_GAP), 200);
  return (
    <section className="panel">
      <div className="panel__title">Tours par période</div>
      {buckets.length === 0 || max === 0 ? (
        <p className="empty-hint">Aucun tour sur cette période.</p>
      ) : (
        <>
          <div className="supervision-chart-wrap">
            <svg
              width={width}
              height={HIST_HEIGHT + 20}
              role="img"
              aria-label="Histogramme des tours par période, orchestration en segment contrasté"
            >
              {buckets.map((b, i) => {
                const x = i * (HIST_BAR_W + HIST_GAP);
                const totalH = (b.tours / max) * HIST_HEIGHT;
                const orchH = (b.orchTours / max) * HIST_HEIGHT;
                const y0 = HIST_HEIGHT;
                return (
                  <g key={b.start} transform={`translate(${x},0)`}>
                    <title>{`${b.start} — ${b.tours} tour(s), dont ${b.orchTours} en orchestration`}</title>
                    {totalH > 0 && (
                      <rect
                        x={0}
                        y={y0 - totalH}
                        width={HIST_BAR_W}
                        height={totalH}
                        rx={2}
                        style={{ fill: "var(--neon-cyan)" }}
                      />
                    )}
                    {orchH > 0 && (
                      <rect
                        x={0}
                        y={y0 - totalH}
                        width={HIST_BAR_W}
                        height={orchH}
                        rx={2}
                        style={{ fill: "var(--neon-magenta)" }}
                      />
                    )}
                    <text x={HIST_BAR_W / 2} y={HIST_HEIGHT + 14} textAnchor="middle" className="supervision-hist-label">
                      {bucketLabel(bucket, b.start)}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="supervision-hist-legend">
            <span>
              <i className="supervision-legend-dot supervision-legend-dot--cyan" /> Tours
            </span>
            <span>
              <i className="supervision-legend-dot supervision-legend-dot--magenta" /> dont orchestration
            </span>
          </div>
        </>
      )}
    </section>
  );
}

/* ---------- R3 — Encart « Routage » (spec docs/spec-r3-debord.md §2.4/§3) ---------- */

/** Ordre d'affichage des tiers (même ordre canonique que routerAdmin). */
const ROUTAGE_TIERS_ORDER = ["trivial", "simple", "moyen", "complexe"];

function formatUsd(v: number): string {
  return `${v.toFixed(2)} $`;
}

function RoutagePanel({ routage, totalTours }: Readonly<{ routage: UsageRoutage | null; totalTours: number }>) {
  // Plafond configuré (config locale, best effort) : `undefined` = pas encore
  // lu, `null` = sans plafond.
  const [plafond, setPlafond] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    readRoutingDebord()
      .then((d) => {
        // R6 — `d === null` = bascule payante désactivée : aucun plafond de
        // référence à afficher (le libellé reste « plafond : — »).
        if (!cancelled && d !== null) setPlafond(d.plafondUsdMois);
      })
      .catch(() => {
        // config illisible : la dépense s'affiche sans plafond de référence.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const autoPct = routage && totalTours > 0 ? Math.round((routage.toursAuto / totalTours) * 100) : null;
  let plafondLabel = "plafond : —";
  if (plafond === null) plafondLabel = "sans plafond";
  else if (plafond !== undefined) plafondLabel = `plafond : ${formatUsd(plafond)}/mois`;
  // Tiers dans l'ordre canonique, puis les inattendus (tolérance : le champ vient du journal).
  const tiers = routage
    ? [
        ...ROUTAGE_TIERS_ORDER.filter((t) => routage.parTier[t]),
        ...Object.keys(routage.parTier).filter((t) => !ROUTAGE_TIERS_ORDER.includes(t)),
      ]
    : [];

  return (
    <section className="panel">
      <div className="panel__title">Routage</div>
      {!routage ? (
        <p className="empty-hint">Statistiques de routage indisponibles (sidecar antérieur ?).</p>
      ) : (
        <>
          <div className="supervision-routage-grid">
            <div className="supervision-kpi-card">
              <div className="panel__title">Tours auto</div>
              <div className="supervision-kpi-value">{routage.toursAuto}</div>
              <div className="supervision-kpi-sub">
                {autoPct !== null ? `${autoPct} % des ${totalTours} tours` : "aucun tour sur la période"}
              </div>
            </div>
            <div className="supervision-kpi-card">
              <div className="panel__title">Part à coût nul</div>
              <div className="supervision-kpi-value">
                {routage.partCoutNulPct !== null ? `${Math.round(routage.partCoutNulPct)} %` : "—"}
              </div>
              <div className="supervision-kpi-sub">abonnement + modèles locaux</div>
            </div>
            <div className="supervision-kpi-card">
              <div className="panel__title">Débord du mois</div>
              <div className="supervision-kpi-value">{formatUsd(routage.debordMoisUsd)}</div>
              <div className="supervision-kpi-sub">{plafondLabel}</div>
            </div>
          </div>

          <div className="supervision-routage-lists">
            <div>
              <div className="panel__title">Répartition par tier</div>
              {tiers.length === 0 ? (
                <p className="empty-hint">Aucun tour routé sur la période.</p>
              ) : (
                <ul className="supervision-routage-list">
                  {tiers.map((tier) => (
                    <li key={tier}>
                      <span className="supervision-routage-list__label">{tier}</span>
                      <span>{routage.parTier[tier].tours} tour{routage.parTier[tier].tours > 1 ? "s" : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="panel__title">Mix intra-abonnement</div>
              {routage.mixAbo.length === 0 ? (
                <p className="empty-hint">Aucun tour abonnement sur la période.</p>
              ) : (
                <ul className="supervision-routage-list">
                  {routage.mixAbo.map((m) => (
                    <li key={m.model}>
                      <span className="supervision-routage-list__label">{m.model}</span>
                      <span>{m.tours} tour{m.tours > 1 ? "s" : ""}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <p className="empty-hint">Estimations d'après le journal local — rien n'est envoyé à l'extérieur.</p>
        </>
      )}
    </section>
  );
}

/* ---------- Abonnement Claude — fenêtre 7 jours ---------- */

interface SevenDayPoint {
  ts: string;
  pct: number;
}

function extractSevenDayPct(snap: ClaudeWindowSnapshot): number | null {
  // Le nommage de cette fenêtre n'est pas garanti à 100 % par l'API
  // expérimentale (voir docs/protocol.md § usage.claude) — la clé attendue
  // est `seven_day`, tolérance simple si absente.
  const w = snap.windows.seven_day;
  return w ? w.utilization : null;
}

interface WeekSummary {
  key: string;
  max: number;
  saturated: boolean;
}

function summarizeByIsoWeek(points: SevenDayPoint[]): WeekSummary[] {
  const map = new Map<string, number>();
  for (const p of points) {
    const d = new Date(p.ts);
    if (Number.isNaN(d.getTime())) continue;
    const key = isoWeekKey(d);
    map.set(key, Math.max(map.get(key) ?? 0, p.pct));
  }
  return Array.from(map.entries())
    .map(([key, max]) => ({ key, max, saturated: max >= 95 }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}

const LINE_W = 640;
const LINE_H = 130;
/** Plafond d'affichage au-delà de 100 % : un peu de marge visuelle pour la ligne repère. */
const LINE_CEIL = 120;

function ClaudeWindowChart({ points }: Readonly<{ points: SevenDayPoint[] }>) {
  const n = points.length;
  const stepX = n > 1 ? LINE_W / (n - 1) : 0;
  const yFor = (pct: number) => LINE_H - (Math.min(LINE_CEIL, Math.max(0, pct)) / LINE_CEIL) * LINE_H;
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${i * stepX},${yFor(p.pct)}`).join(" ");
  const y100 = yFor(100);
  return (
    <div className="supervision-chart-wrap">
      <svg
        width={n > 1 ? LINE_W : 40}
        height={LINE_H + 10}
        viewBox={`0 0 ${n > 1 ? LINE_W : 40} ${LINE_H + 10}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Pourcentage de la fenêtre d'abonnement 7 jours dans le temps"
      >
        <line x1={0} x2={n > 1 ? LINE_W : 40} y1={y100} y2={y100} className="supervision-line-ref" />
        <path d={pathD} className="supervision-line-path" fill="none" />
        {points.map((p, i) => (
          <circle key={p.ts} cx={i * stepX} cy={yFor(p.pct)} r={2.5} className="supervision-line-dot">
            <title>{`${new Date(p.ts).toLocaleString("fr-FR")} — ${Math.round(p.pct)} %`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

function ClaudeWeeklySummary({ weeks }: Readonly<{ weeks: WeekSummary[] }>) {
  return (
    <div className="supervision-claude-summary-grid">
      {weeks.map((w) => (
        <div key={w.key} className="supervision-week-card">
          <div className="supervision-week-card__label">{w.key}</div>
          <div className="supervision-week-card__value">{Math.round(w.max)} %</div>
          {w.saturated && <span className="supervision-badge supervision-badge--saturated">saturé</span>}
        </div>
      ))}
    </div>
  );
}

const CLAUDE_HISTORY_DAYS = 180;

function ClaudeSubscriptionPanel() {
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

  const points = useMemo(() => {
    if (!snapshots) return [];
    const out: SevenDayPoint[] = [];
    for (const s of snapshots) {
      const pct = extractSevenDayPct(s);
      if (pct !== null) out.push({ ts: s.ts, pct });
    }
    return out;
  }, [snapshots]);

  const weeks = useMemo(() => summarizeByIsoWeek(points), [points]);

  return (
    <section className="panel">
      <div className="panel__title">Abonnement Claude — fenêtre 7 jours</div>
      {snapshots === null && !errored && <p className="empty-hint">Chargement…</p>}
      {errored && <p className="empty-hint empty-hint--error">Historique indisponible (sidecar injoignable ?).</p>}
      {snapshots !== null && !errored && points.length === 0 && (
        <p className="empty-hint">Pas encore d'historique — il se construit au fil de l'usage.</p>
      )}
      {points.length > 0 && (
        <>
          <ClaudeWindowChart points={points} />
          <ClaudeWeeklySummary weeks={weeks} />
        </>
      )}
    </section>
  );
}

/* ---------- Page ---------- */

export function SupervisionPage() {
  const [bucket, setBucket] = useState<UsageBucketKind>("day");
  const [anchor, setAnchor] = useState<string>(todayLocalStr());
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [loadError, setLoadError] = useState(false);

  const from = useMemo(() => computeFrom(bucket, anchor), [bucket, anchor]);
  const to = anchor;
  const atToday = anchor >= todayLocalStr();

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    usageStats(from, to, bucket)
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [from, to, bucket]);

  function handleBucket(next: UsageBucketKind) {
    setBucket(next);
    setAnchor(todayLocalStr());
  }

  return (
    <div className="page supervision-page">
      <div className="page__intro">
        <h1 className="page__title">Supervision</h1>
        <p className="empty-hint">
          Usage local (conversations, tours, tokens) — historisé au fil de l'eau sur ce poste, rien n'est envoyé à
          l'extérieur.
        </p>
      </div>

      <PeriodSelector
        bucket={bucket}
        onBucket={handleBucket}
        from={from}
        to={to}
        onPrev={() => setAnchor((a) => shiftAnchor(bucket, a, -1))}
        onNext={() => setAnchor((a) => shiftAnchor(bucket, a, 1))}
        onToday={() => setAnchor(todayLocalStr())}
        atToday={atToday}
      />

      {loadError && <p className="empty-hint empty-hint--error">Statistiques indisponibles (sidecar injoignable ?).</p>}

      {stats && (
        <>
          <KpiCards totals={stats.totals} />
          <div className="panels">
            <ModelsPanel models={stats.models} />
            <Histogram bucket={bucket} buckets={stats.buckets} />
          </div>
          {/* R3 — encart « Routage » : part auto, tiers, coût nul, mix abo, débord vs plafond. */}
          <RoutagePanel routage={stats.routage} totalTours={stats.totals.tours} />
        </>
      )}

      <ClaudeSubscriptionPanel />
    </div>
  );
}
