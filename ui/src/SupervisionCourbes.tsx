/*
 * Supervision — graphique de courbes des quatre indicateurs de la page
 * (conversations, tours, contexte moyen, tokens totaux) sur le cran de période
 * AU-DESSUS de la sélection : jour → sa semaine, semaine → son mois,
 * mois → son année (voir supervisionPeriode.ts, `trendRange`).
 *
 * UN SEUL AXE, jamais deux échelles. Les quatre séries n'ont pas le même ordre
 * de grandeur (des dizaines de conversations, des millions de tokens) : sur un
 * axe en valeurs absolues, trois des quatre courbes s'écraseraient sur zéro, et
 * un second axe ferait mentir les croisements. Elles sont donc INDEXÉES, chacune
 * sur son propre maximum de la fenêtre — l'axe se lit « % du maximum de la
 * série », et les valeurs réelles se lisent dans la légende (le pic) et dans
 * l'infobulle (le point survolé). C'est une comparaison de FORMES, ce qui est
 * précisément ce qu'on cherche sur quatre indicateurs hétérogènes.
 *
 * Palette : quatre teintes vérifiées par calcul contre la surface sombre de
 * l'app (bande de clarté, plancher de chroma, séparation daltonisme toutes
 * paires, contraste) — ne pas les changer à l'œil. L'identité ne repose jamais
 * sur la seule couleur : légende, étiquette en bout de courbe, et tableau
 * dépliable sous le graphe.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatTokens } from "./fableUsage";
import type { UsageBucket, UsageBucketKind } from "./usageStatsClient";
import { isoWeekInfo, parseLocalDate } from "./supervisionPeriode";
import { desempiler, indexerSerie, segmenter } from "./supervisionCourbesCalc";

/* ---------- Séries ---------- */

interface Serie {
  key: string;
  label: string;
  color: string;
  /** Valeur brute d'un bucket ; `null` = pas de donnée (trou dans la courbe). */
  valeur: (b: UsageBucket) => number | null;
  format: (v: number) => string;
}

const SERIES: Serie[] = [
  {
    key: "conversations",
    label: "Conversations",
    color: "#1478ff",
    valeur: (b) => b.conversations,
    format: String,
  },
  { key: "tours", label: "Tours", color: "#ff0069", valeur: (b) => b.tours, format: String },
  {
    key: "contexte",
    label: "Contexte moyen",
    color: "#aa6900",
    // `null` quand aucun token n'a été compté : une MOYENNE absente n'est pas
    // une moyenne nulle — la courbe s'interrompt au lieu de plonger à zéro.
    valeur: (b) => b.avgPromptTokens,
    format: (v) => formatTokens(Math.round(v)),
  },
  {
    key: "tokens",
    label: "Tokens totaux",
    color: "#c800b9",
    valeur: (b) => b.totalTokens,
    format: (v) => formatTokens(v),
  },
];

/* ---------- Géométrie ---------- */

const H = 250;
const PAD_TOP = 14;
const PAD_BOTTOM = 28;
const PAD_LEFT = 38;
/** Colonne réservée aux étiquettes posées en bout de courbe. */
const PAD_RIGHT = 116;
const MIN_W = 420;

function bucketLabel(bucket: UsageBucketKind, start: string): string {
  const d = parseLocalDate(start);
  if (bucket === "day") return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  if (bucket === "week") return `S${isoWeekInfo(d).week}`;
  return d.toLocaleDateString("fr-FR", { month: "short" });
}

/** Largeur observée du conteneur : le graphe occupe toute la largeur du panneau. */
function useLargeur(): [(el: HTMLDivElement | null) => void, number] {
  const [largeur, setLargeur] = useState(MIN_W);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (!el) return;
    setLargeur(Math.max(MIN_W, el.clientWidth));
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setLargeur(Math.max(MIN_W, Math.round(w)));
    });
    ro.observe(el);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, largeur];
}

interface Point {
  x: number;
  y: number;
  i: number;
}

interface Trace {
  serie: Serie;
  /** Maximum de la série sur la fenêtre — dénominateur de l'indexation. */
  max: number;
  /** Tous les points mesurés, pour les pastilles et l'étiquette de bout. */
  points: Point[];
  /** Les mêmes, coupés à chaque trou : une polyligne par segment continu. */
  segments: Point[][];
}

/* ---------- Composant ---------- */

export function SupervisionCourbes({
  bucket,
  buckets,
  highlight,
  titre,
}: Readonly<{
  bucket: UsageBucketKind;
  buckets: UsageBucket[];
  /** Début de la période SÉLECTIONNÉE : la bande mise en avant sous les courbes. */
  highlight: string;
  titre: string;
}>) {
  const [conteneurRef, largeur] = useLargeur();
  const [survol, setSurvol] = useState<number | null>(null);

  const plotW = Math.max(60, largeur - PAD_LEFT - PAD_RIGHT);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const n = buckets.length;
  const xFor = (i: number) => PAD_LEFT + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (pct: number) => PAD_TOP + plotH - (Math.min(100, Math.max(0, pct)) / 100) * plotH;

  const traces = useMemo<Trace[]>(
    () =>
      SERIES.map((serie) => {
        const { max, pct } = indexerSerie(buckets.map((b) => serie.valeur(b)));
        const bruts = pct.map((p, i) => (p === null ? null : { x: xFor(i), y: yFor(p), i }));
        const segments = segmenter(bruts);
        return { serie, max, points: segments.flat(), segments };
      }),
    // xFor/yFor dépendent de la largeur et du nombre de points : recalcul à chaque
    // redimensionnement, c'est le prix d'un SVG en coordonnées absolues.
    [buckets, largeur],
  );

  const actives = traces.filter((t) => t.max > 0 && t.points.length > 0);

  // Étiquettes de bout de courbe : l'identité ne doit pas reposer sur la seule
  // couleur, et lire la légende puis revenir au graphe coûte un aller-retour.
  const boutsY = desempiler(
    actives.map((t) => t.points.at(-1)?.y ?? PAD_TOP),
    PAD_TOP + 4,
    PAD_TOP + plotH,
  );

  const iHighlight = buckets.findIndex((b) => b.start === highlight);
  const iInfo = survol ?? (iHighlight >= 0 ? iHighlight : null);

  if (n === 0) {
    return (
      <section className="panel">
        <div className="panel__title">{titre}</div>
        <p className="empty-hint">Aucune période à afficher.</p>
      </section>
    );
  }

  const rien = actives.length === 0;

  return (
    <section className="panel supervision-courbes">
      <div className="panel__title">{titre}</div>
      {rien ? (
        <p className="empty-hint">Aucun tour sur cette fenêtre.</p>
      ) : (
        <>
          <div className="supervision-courbes-wrap" ref={conteneurRef}>
            <svg
              width={largeur}
              height={H}
              role="img"
              aria-label={`Évolution de ${SERIES.map((s) => s.label.toLowerCase()).join(", ")}, chaque série ramenée à son propre maximum`}
            >
              {/* Grille : 0 / 50 / 100 % du maximum de chaque série. */}
              {[0, 50, 100].map((pct) => (
                <g key={pct}>
                  <line
                    x1={PAD_LEFT}
                    x2={PAD_LEFT + plotW}
                    y1={yFor(pct)}
                    y2={yFor(pct)}
                    className="supervision-courbes-grille"
                  />
                  <text x={PAD_LEFT - 7} y={yFor(pct) + 3} textAnchor="end" className="supervision-courbes-axe">
                    {pct} %
                  </text>
                </g>
              ))}

              {/* Bande de la période sélectionnée : le lien avec les cartes KPI. */}
              {iHighlight >= 0 && (
                <rect
                  x={xFor(iHighlight) - Math.min(18, plotW / Math.max(1, n) / 2 + 6)}
                  y={PAD_TOP}
                  width={Math.min(36, plotW / Math.max(1, n) + 12)}
                  height={plotH}
                  className="supervision-courbes-bande"
                />
              )}

              {/* Repère du point survolé. */}
              {iInfo !== null && (
                <line
                  x1={xFor(iInfo)}
                  x2={xFor(iInfo)}
                  y1={PAD_TOP}
                  y2={PAD_TOP + plotH}
                  className="supervision-courbes-curseur"
                />
              )}

              {actives.map((t, iTrace) => (
                <g key={t.serie.key}>
                  {/* Une polyligne par segment : le trait S'INTERROMPT sur les
                      périodes sans mesure, il ne les enjambe pas. */}
                  {t.segments.map((seg) => (
                    <polyline
                      key={seg[0].i}
                      points={seg.map((p) => `${p.x},${p.y}`).join(" ")}
                      fill="none"
                      stroke={t.serie.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ))}
                  {t.points.map((p) => (
                    <circle
                      key={p.i}
                      cx={p.x}
                      cy={p.y}
                      r={p.i === iInfo ? 4.5 : 3}
                      fill={t.serie.color}
                      // Anneau à la couleur du fond : deux points qui se croisent
                      // restent deux points, pas une tache.
                      stroke="var(--bg-0)"
                      strokeWidth={2}
                    />
                  ))}
                  <text
                    x={PAD_LEFT + plotW + 8}
                    y={boutsY[iTrace] + 3}
                    className="supervision-courbes-bout"
                    style={{ fill: t.serie.color }}
                  >
                    {t.serie.label}
                  </text>
                </g>
              ))}

              {/* Abscisses : la période sélectionnée en évidence. */}
              {buckets.map((b, i) => (
                <text
                  key={b.start}
                  x={xFor(i)}
                  y={H - 9}
                  textAnchor="middle"
                  className={`supervision-courbes-axe${i === iHighlight ? " supervision-courbes-axe--active" : ""}`}
                >
                  {bucketLabel(bucket, b.start)}
                </text>
              ))}

              {/* Zones de survol : plus larges que les points, comme il se doit. */}
              {buckets.map((b, i) => (
                <rect
                  key={b.start}
                  x={xFor(i) - plotW / Math.max(1, n) / 2 - 2}
                  y={PAD_TOP}
                  width={plotW / Math.max(1, n) + 4}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setSurvol(i)}
                  onMouseLeave={() => setSurvol(null)}
                />
              ))}
            </svg>
          </div>

          {/* Valeurs du point pointé : brutes, jamais indexées. */}
          {iInfo !== null && buckets[iInfo] && (
            <div className="supervision-courbes-info">
              <span className="supervision-courbes-info__date">
                {bucketLabel(bucket, buckets[iInfo].start)}
                {iInfo === iHighlight ? " · période affichée" : ""}
              </span>
              {SERIES.map((s) => {
                const v = s.valeur(buckets[iInfo]);
                return (
                  <span key={s.key} className="supervision-courbes-info__item">
                    <i className="supervision-legend-dot" style={{ background: s.color }} />
                    {s.label} <b>{v === null ? "—" : s.format(v)}</b>
                  </span>
                );
              })}
            </div>
          )}

          <div className="supervision-hist-legend">
            {traces.map((t) => (
              <span key={t.serie.key}>
                <i className="supervision-legend-dot" style={{ background: t.serie.color }} /> {t.serie.label}
                <span className="supervision-courbes-max">
                  {t.max > 0 ? ` — pic ${t.serie.format(t.max)}` : " — aucune donnée"}
                </span>
              </span>
            ))}
          </div>
          <p className="empty-hint">
            Chaque courbe est ramenée à SON propre maximum sur la fenêtre (axe en % de ce pic) : les ordres de grandeur
            n'ont rien à voir, ce graphe compare des formes, pas des quantités. Les valeurs réelles sont au survol et
            dans le tableau.
          </p>

          {/* Vue tabulaire : l'accès aux chiffres ne doit dépendre ni de la souris ni de la couleur. */}
          <details className="supervision-courbes-table">
            <summary>Voir les valeurs</summary>
            <div className="supervision-courbes-table__scroll">
              <table>
                <thead>
                  <tr>
                    <th>Période</th>
                    {SERIES.map((s) => (
                      <th key={s.key}>{s.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {buckets.map((b, i) => (
                    <tr key={b.start} className={i === iHighlight ? "supervision-courbes-table__actif" : undefined}>
                      <th scope="row">{b.start}</th>
                      {SERIES.map((s) => {
                        const v = s.valeur(b);
                        return <td key={s.key}>{v === null ? "—" : s.format(v)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
