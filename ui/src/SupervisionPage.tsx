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
  ActivitePanel,
  ConcentrationPanel,
  DelegationPanel,
  EscaladePanel,
  FiabilitePanel,
  PyramidePanel,
} from "./SupervisionSobriete";
import { SupervisionCourbes } from "./SupervisionCourbes";
import {
  avancementPeriode,
  formatPeriodLabel,
  formatVariation,
  parseLocalDate,
  periodePrecedenteComparable,
  periodRange,
  shiftAnchor,
  variationPct,
  todayLocalStr,
  trendRange,
  type Periode,
  libelleDepense,
} from "./supervisionPeriode";
import {
  usageStats,
  type UsageBucket,
  type UsageBucketKind,
  type UsageProjet,
  type UsageRoutage,
  type UsageStats,
} from "./usageStatsClient";
import { useRovingFocus } from "./useRovingFocus";
import {
  ClaudeSubscriptionPanel,
  RythmeQuotaPanel,
  TroisDevisesPanel,
  picFenetreSurPeriode,
  useHistoriqueAbonnement,
} from "./SupervisionAbonnement";


/* ---------- Sélecteur de période ---------- */

const BUCKET_ITEMS: { id: UsageBucketKind; label: string }[] = [
  { id: "day", label: "Jour" },
  { id: "week", label: "Semaine" },
  { id: "month", label: "Mois" },
];

/** Libellés de navigation, accordés à la période sélectionnée. */
const PERIOD_NOUN: Record<UsageBucketKind, { prev: string; next: string; today: string }> = {
  day: { prev: "Jour précédent", next: "Jour suivant", today: "Aujourd'hui" },
  week: { prev: "Semaine précédente", next: "Semaine suivante", today: "Cette semaine" },
  month: { prev: "Mois précédent", next: "Mois suivant", today: "Ce mois-ci" },
};

function PeriodSelector({
  bucket,
  onBucket,
  periode,
  onPrev,
  onNext,
  onToday,
  atToday,
}: Readonly<{
  bucket: UsageBucketKind;
  onBucket: (b: UsageBucketKind) => void;
  periode: Periode;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  atToday: boolean;
}>) {
  const noun = PERIOD_NOUN[bucket];
  const avancement = avancementPeriode(periode);
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
        <button type="button" className="btn btn--ghost" onClick={onPrev} title={noun.prev} aria-label={noun.prev}>
          ◀
        </button>
        <span className="supervision-range-label">
          {formatPeriodLabel(bucket, periode)}
          {/* T-070 — une période EN COURS le dit. Sans ça, le lundi, Semaine
              affiche les chiffres de Jour et l'égalité se lit comme une
              panne : le calcul était juste, c'est le silence qui trompait. */}
          {avancement !== null && (
            <span
              className="supervision-range-avancement"
              title={`Période en cours : ${avancement.ecoules} jour(s) sur ${avancement.total}. Les chiffres ne couvrent que la partie écoulée.`}
            >
              {` · jour ${avancement.ecoules}/${avancement.total}`}
            </span>
          )}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onNext}
          disabled={atToday}
          title={noun.next}
          aria-label={noun.next}
        >
          ▶
        </button>
        <button type="button" className="btn btn--ghost" onClick={onToday} disabled={atToday}>
          {noun.today}
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

/**
 * Zone de la page : un intertitre, une teinte, et les encarts qu'elle groupe.
 *
 * La page est organisée par QUESTION plutôt que par source de données — trois
 * zones, trois moments, trois budgets d'attention (docs/etude-supervision.md
 * §8.2). Sans ce groupement, six encarts de poids égal obligent à savoir déjà
 * ce qu'on cherche.
 *
 * La teinte est un repère de lecture, JAMAIS un porteur d'information : chaque
 * zone garde son intertitre écrit. Les trois valeurs vivent dans App.css, où
 * est aussi consigné leur passage au validateur de palette.
 */
function Zone({
  ton,
  titre,
  quand,
  children,
}: Readonly<{
  ton: "sobriete" | "historique" | "abonnement";
  titre: string;
  quand: string;
  children: React.ReactNode;
}>) {
  return (
    <section className={`supervision-zone supervision-zone--${ton}`}>
      <div className="page__intro supervision-zone__titre">
        <h2 className="page__title">{titre}</h2>
        <p className="empty-hint">{quand}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * T-075 — delta par rapport à la période précédente comparable, ou rien.
 *
 * Le libellé porte TOUJOURS la nature de la référence (« vs 4 j précédents »
 * quand elle est tronquée) : un « +12 % » sans dénominateur est la faute même
 * que ce ticket corrige ailleurs.
 */
function Variation({
  actuel,
  precedent,
  tronquee,
}: Readonly<{ actuel: number; precedent: number | null; tronquee: boolean; jours?: number }>) {
  if (precedent === null) return null;
  const texte = formatVariation(variationPct(actuel, precedent));
  if (texte === null) return null;
  return (
    <div
      className="supervision-kpi-sub supervision-kpi-sub--variation"
      title={
        tronquee
          ? "Comparé à la MÊME fraction de la période précédente : comparer une période entamée à une période complète ne dirait que le temps restant."
          : "Comparé à la période précédente complète."
      }
    >
      {`${texte} vs période précédente${tronquee ? " (à ce stade)" : ""}`}
    </div>
  );
}

function KpiCards({
  totals,
  precedent,
  tronquee,
}: Readonly<{ totals: UsageStats["totals"]; precedent: UsageStats["totals"] | null; tronquee: boolean }>) {
  const pct = orchPct(totals);
  return (
    <div className="supervision-kpi-grid">
      <div className="panel supervision-kpi-card">
        <div className="panel__title">Conversations</div>
        <div className="supervision-kpi-value">{totals.conversations}</div>
        <Variation actuel={totals.conversations} precedent={precedent?.conversations ?? null} tronquee={tronquee} />
      </div>
      <div className="panel supervision-kpi-card">
        <div className="panel__title">Tours</div>
        <div className="supervision-kpi-value">{totals.tours}</div>
        <Variation actuel={totals.tours} precedent={precedent?.tours ?? null} tronquee={tronquee} />
        <div className="supervision-kpi-sub">
          {pct !== null ? `dont orchestration : ${totals.orchTours} (${Math.round(pct)} %)` : "dont orchestration : —"}
        </div>
      </div>
      <div className="panel supervision-kpi-card">
        {/* T-067 — MÉDIANE de l'occupation réelle du contexte, plus la moyenne
            des `promptTokens` du SDK : ceux-ci excluent le cache, et le KPI
            annonçait 6 tokens. Médiane et non moyenne : la distribution est
            trop étalée pour qu'une moyenne décrive un tour réel. */}
        <div className="panel__title" title="Médiane de l'occupation réelle de la fenêtre de contexte (cache compris)">
          Contexte médian
        </div>
        <div className="supervision-kpi-value">
          {totals.contexteMedian !== null ? formatTokens(totals.contexteMedian) : "—"}
        </div>
      </div>
      <div className="panel supervision-kpi-card">
        <div className="panel__title">Tokens totaux</div>
        <div className="supervision-kpi-value">{formatTokens(totals.totalTokens)}</div>
        <Variation actuel={totals.totalTokens} precedent={precedent?.totalTokens ?? null} tronquee={tronquee} />
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

/* ---------- S2 — Usage par projet (le Chat compte comme un projet) ---------- */

/**
 * Part d'un projet dans la période : en TOKENS (proxy le plus fidèle de la
 * consommation), avec repli sur les tours quand aucun token n'a été compté
 * sur la période — sans ce repli, l'encart serait vide alors que des tours
 * ont bien eu lieu (un fournisseur peut ne pas remonter d'usage).
 */
function projetShares(
  projets: UsageProjet[],
  totals: UsageStats["totals"],
): { parTokens: boolean; rows: Array<{ p: UsageProjet; pct: number; autonomePct: number }> } {
  const parTokens = totals.totalTokens > 0;
  const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
  const rows = projets.map((p) => ({
    p,
    pct: parTokens ? (p.partTokensPct ?? 0) : share(p.tours, totals.tours),
    autonomePct: parTokens ? (p.autonomePct ?? 0) : share(p.autonomeTours, p.tours),
  }));
  return { parTokens, rows };
}

function ProjetsPanel({
  parProjet,
  totals,
}: Readonly<{ parProjet: UsageProjet[] | null; totals: UsageStats["totals"] }>) {
  if (!parProjet) {
    return (
      <section className="panel">
        <div className="panel__title">Usage par projet</div>
        <p className="empty-hint">Répartition par projet indisponible (sidecar antérieur ?).</p>
      </section>
    );
  }
  const { parTokens, rows } = projetShares(parProjet, totals);
  return (
    <section className="panel">
      <div className="panel__title">Usage par projet</div>
      {rows.length === 0 ? (
        <p className="empty-hint">Aucun tour sur cette période.</p>
      ) : (
        <>
          <div className="supervision-models-list">
            {rows.map(({ p, pct, autonomePct }) => (
              <div key={p.projectId ?? "(non attribué)"} className="supervision-model-row">
                <div className="supervision-model-name" title={p.projectId ?? "sans projet identifiable"}>
                  <span className="supervision-model-name__label">{p.name}</span>
                  <span className="supervision-model-name__engine">
                    {p.tours} tour{p.tours > 1 ? "s" : ""} · {formatTokens(p.totalTokens)}
                  </span>
                </div>
                {/* Barre à l'échelle ABSOLUE (les parts se somment sur la largeur),
                    segment contrasté = part autonome, même code couleur que l'histogramme. */}
                <div className="supervision-model-bar-track">
                  <div className="supervision-model-bar-fill" style={{ width: `${Math.min(100, pct)}%` }}>
                    <div
                      className="supervision-projet-bar-autonome"
                      style={{ width: `${Math.min(100, autonomePct)}%` }}
                    />
                  </div>
                </div>
                <div className="supervision-model-metrics">
                  {Math.round(pct)} %
                  {p.autonomeTours > 0 ? ` · dont ${Math.round(autonomePct)} % autonome` : ""}
                </div>
              </div>
            ))}
          </div>
          <div className="supervision-hist-legend">
            <span>
              <i className="supervision-legend-dot supervision-legend-dot--cyan" />{" "}
              {parTokens ? "Part des tokens" : "Part des tours (aucun token compté)"}
            </span>
            <span>
              <i className="supervision-legend-dot supervision-legend-dot--magenta" /> dont autonome
              (orchestration)
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

/**
 * T-068 — les deux moitiés de la part hors facturation, nommées. « abonnement
 * + modèles locaux » laissait croire à deux gratuités équivalentes : la
 * première se paie en quota, la seconde ne se paie pas du tout.
 */
function libelleHorsFacturation(routage: UsageRoutage): string {
  const abo = routage.partAbonnementPct;
  const local = routage.partLocalPct;
  // Sidecar antérieur : les deux moitiés sont absentes, on garde l'ancien
  // libellé plutôt que d'afficher « 0 % » pour une donnée non servie.
  if (abo === null && local === null) return "abonnement + modèles locaux";
  return `abonnement ${Math.round(abo ?? 0)} % (quota) · local ${Math.round(local ?? 0)} %`;
}

/** Au-delà de 80 % de la fenêtre 5 h, la saturation cesse d'être théorique. */
function quotaAlerte(pct: number | null): boolean {
  return pct !== null && pct >= 80;
}

function RoutagePanel({
  routage,
  totalTours,
  picCinqHeuresPct,
}: Readonly<{ routage: UsageRoutage | null; totalTours: number; picCinqHeuresPct: number | null }>) {
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
            {/* T-068 — l'indicateur s'appelait « Part à coût nul » et comptait des
                DOLLARS : il affichait 98 % de gratuité pendant que la fenêtre 5 h
                saturait à 104 %. Un tour d'abonnement est gratuit pour le
                portefeuille et coûteux pour le quota — la seule ressource rare
                ici. Le chiffre reste (il n'est pas faux, il est partiel), mais il
                est nommé pour ce qu'il mesure, ventilé en ses deux moitiés, et
                mis EN FACE de la saturation qu'il masquait. */}
            <div className="supervision-kpi-card">
              <div
                className="panel__title"
                title="Tours sans facturation API : abonnement Claude et modèles locaux. Gratuit en dollars — l'abonnement, lui, se paie en quota."
              >
                Part hors facturation
              </div>
              <div className="supervision-kpi-value">
                {routage.partCoutNulPct !== null ? `${Math.round(routage.partCoutNulPct)} %` : "—"}
              </div>
              <div className="supervision-kpi-sub">{libelleHorsFacturation(routage)}</div>
              <div
                className={`supervision-kpi-sub${quotaAlerte(picCinqHeuresPct) ? " supervision-kpi-sub--alerte" : ""}`}
                title="Pic de la fenêtre 5 h sur la période affichée : c'est LUI qui déclenche les refus, pas la moyenne."
              >
                {picCinqHeuresPct !== null
                  ? `pic quota 5 h : ${Math.round(picCinqHeuresPct)} %`
                  : "pic quota 5 h : pas de relevé"}
              </div>
            </div>
            {/* S3 — la dépense RÉELLE de la période. « Débord du mois » ne compte
                que la fraction routée automatiquement : un tour OpenRouter choisi
                à la main n'y apparaît pas, et la page n'affichait alors AUCUNE
                dépense (T-035). */}
            <div className="supervision-kpi-card">
              <div className="panel__title">Dépense de la période</div>
              <div className="supervision-kpi-value">{formatUsd(routage.coutPeriodeUsd)}</div>
              <div className="supervision-kpi-sub">
                {libelleDepense(routage.coutInconnuTours, routage.coutNonRemonteTours)}
              </div>
            </div>
            <div className="supervision-kpi-card">
              <div className="panel__title">Débord du mois</div>
              <div className="supervision-kpi-value">{formatUsd(routage.debordMoisUsd)}</div>
              <div className="supervision-kpi-sub">
                {plafondLabel} · routage auto seulement
              </div>
            </div>
          </div>

          <div className="supervision-routage-lists">
            <div>
              {/* T-075 — le dénominateur, faute de quoi cette liste se lit
                  comme une description de TOUTE l'activité alors qu'elle ne
                  décrit que la fraction routée automatiquement (4,3 % des
                  tours au moment du constat). */}
              <div className="panel__title">
                Répartition par tier
                <span className="supervision-routage-denominateur">
                  {totalTours > 0
                    ? ` — ${routage.toursAuto} tour${routage.toursAuto > 1 ? "s" : ""} routé${routage.toursAuto > 1 ? "s" : ""} sur ${totalTours}`
                    : ""}
                </span>
              </div>
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
              <div className="panel__title">
                Mix intra-abonnement
                <span className="supervision-routage-denominateur">
                  {routage.partAbonnementPct !== null && totalTours > 0
                    ? ` — ${Math.round(routage.partAbonnementPct)} % des ${totalTours} tours`
                    : ""}
                </span>
              </div>
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

/* ---------- Page ---------- */

/**
 * Titre du graphe : il nomme la FENÊTRE tracée, pas la période sélectionnée —
 * c'est le cran au-dessus, et le dire évite de croire que les courbes et les
 * cartes couvrent la même chose.
 */
const COURBES_TITRE: Record<UsageBucketKind, (anchor: string) => string> = {
  day: (a) => `Les jours de la semaine ${formatPeriodLabel("week", periodRange("week", a))}`,
  week: (a) => `Les semaines de ${formatPeriodLabel("month", periodRange("month", a))}`,
  month: (a) => `Les mois de ${parseLocalDate(a).getFullYear()}`,
};

export function SupervisionPage() {
  const [bucket, setBucket] = useState<UsageBucketKind>("day");
  const [anchor, setAnchor] = useState<string>(todayLocalStr());
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [trend, setTrend] = useState<UsageBucket[]>([]);
  // T-075 — mêmes agrégats sur la période précédente COMPARABLE. `null` tant
  // qu'ils ne sont pas là, ou si la requête échoue : une comparaison absente
  // se tait, elle n'invente pas un « = ».
  const [precedent, setPrecedent] = useState<UsageStats | null>(null);
  const [loadError, setLoadError] = useState(false);

  const periode = useMemo(() => periodRange(bucket, anchor), [bucket, anchor]);
  const tendance = useMemo(() => trendRange(bucket, anchor), [bucket, anchor]);
  // ▶ et « Aujourd'hui » n'ont de sens que hors de la période en cours ; une
  // période qui court jusqu'à aujourd'hui (ou au-delà : mois entamé) est la
  // dernière navigable.
  const atToday = periode.to >= todayLocalStr();
  // Chargé UNE fois pour la page : l'encart Abonnement le dessine, l'encart
  // Routage en tire son signal de rareté (T-068).
  const histo = useHistoriqueAbonnement();
  const picCinqHeures = useMemo(
    () => picFenetreSurPeriode(histo.snapshots, "five_hour", periode),
    [histo.snapshots, periode],
  );

  // T-075 — la période précédente, tronquée à l'avancement de la courante :
  // comparer trois jours à sept produirait un « −57 % » qui ne dit rien.
  const comparable = useMemo(() => periodePrecedenteComparable(bucket, anchor), [bucket, anchor]);

  // Trois requêtes : la période sélectionnée porte TOUS les encarts (KPI,
  // modèles, projets, routage), la fenêtre du cran au-dessus ne sert qu'aux
  // courbes, la troisième ne sert qu'aux comparaisons. Les buckets de la
  // deuxième ne suffiraient pas aux encarts : ils ne portent ni modèles, ni
  // projets, ni routage.
  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    Promise.all([
      usageStats(periode.from, periode.to, bucket),
      usageStats(tendance.from, tendance.to, bucket),
    ])
      .then(([p, t]) => {
        if (cancelled) return;
        setStats(p);
        setTrend(t.buckets);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [periode, tendance, bucket]);

  // Requête SÉPARÉE, et c'est délibéré : l'échec d'une comparaison ne doit pas
  // vider la page. Elle se tait, le reste s'affiche.
  useEffect(() => {
    let cancelled = false;
    setPrecedent(null);
    usageStats(comparable.periode.from, comparable.periode.to, bucket)
      .then((p) => {
        if (!cancelled) setPrecedent(p);
      })
      .catch(() => {
        /* comparaison indisponible : les cartes s'affichent sans delta */
      });
    return () => {
      cancelled = true;
    };
  }, [comparable, bucket]);

  // L'ancre est CONSERVÉE en changeant de granularité : depuis le 3 juillet en
  // « Jour », « Semaine » montre la semaine du 3 juillet — pas un retour brutal
  // à aujourd'hui, qui ferait perdre l'endroit qu'on était en train de lire.
  function handleBucket(next: UsageBucketKind) {
    setBucket(next);
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
        periode={periode}
        onPrev={() => setAnchor((a) => shiftAnchor(bucket, a, -1))}
        onNext={() => setAnchor((a) => shiftAnchor(bucket, a, 1))}
        onToday={() => setAnchor(todayLocalStr())}
        atToday={atToday}
      />

      {loadError && <p className="empty-hint empty-hint--error">Statistiques indisponibles (sidecar injoignable ?).</p>}

      {stats && (
        <>
          {/* Neuf. Jamais un coût sans un signal de qualité en regard : la
              délégation et la concentration voisinent avec la fiabilité et le
              routage, pas avec des totaux. */}
          <Zone ton="sobriete" titre="Sobriété" quand="Une fois par semaine">
            <div className="panels">
              <PyramidePanel sobriete={stats.sobriete} totalTours={stats.totals.tours} />
              <DelegationPanel sobriete={stats.sobriete} />
              <ConcentrationPanel sobriete={stats.sobriete} />
            </div>
            <div className="panels">
              <FiabilitePanel sobriete={stats.sobriete} totalTours={stats.totals.tours} />
              {/* R3 — part auto, tiers, coût nul, mix abo, débord vs plafond. */}
              <RoutagePanel
                routage={stats.routage}
                totalTours={stats.totals.tours}
                picCinqHeuresPct={picCinqHeures}
              />
              {/* T-074 — la seule preuve qu'un routage est BON, pas seulement bon marché. */}
              <EscaladePanel escaladeTours={stats.escaladeTours} />
            </div>
          </Zone>

          {/* L'existant, réordonné. Rien n'y change de calcul. */}
          <Zone ton="historique" titre="Historique et répartitions" quand="À la demande">
            <KpiCards
              totals={stats.totals}
              precedent={precedent?.totals ?? null}
              tronquee={comparable.tronquee}
            />
            {/* Les quatre mêmes indicateurs, en courbes, sur le cran au-dessus. */}
            <SupervisionCourbes
              bucket={bucket}
              buckets={trend}
              highlight={periode.from}
              titre={COURBES_TITRE[bucket](anchor)}
            />
            <div className="panels">
              {/* S2 — répartition par projet (Chat compris), part autonome incluse. */}
              <ProjetsPanel parProjet={stats.parProjet} totals={stats.totals} />
              <ModelsPanel models={stats.models} />
            </div>
            <ActivitePanel sobriete={stats.sobriete} />
          </Zone>

          {/* L'abonnement ferme la page : c'est un état, pas une analyse — on y
              descend pour vérifier, pas pour comprendre. */}
          <Zone ton="abonnement" titre="Utilisation abonnement" quand="Pour vérifier">
            <div className="panels">
              {/* T-072 — les trois devises jamais additionnées, puis le rythme
                  de combustion : « est-ce que je tape le mur avant ce soir ? » */}
              <TroisDevisesPanel snapshots={histo.snapshots} routage={stats.routage} sobriete={stats.sobriete} />
              <RythmeQuotaPanel snapshots={histo.snapshots} />
            </div>
            <ClaudeSubscriptionPanel snapshots={histo.snapshots} errored={histo.errored} />
          </Zone>
        </>
      )}

      {/* Sans statistiques, l'encart abonnement reste seul : il ne dépend pas d'elles. */}
      {!stats && <ClaudeSubscriptionPanel snapshots={histo.snapshots} errored={histo.errored} />}
    </div>
  );
}
