/*
 * Supervision — encarts de SOBRIÉTÉ (T-071, voir docs/etude-supervision.md §6).
 *
 * ── Pourquoi un fichier à part ──────────────────────────────────────────
 * SupervisionPage.tsx approchait déjà les 700 lignes et le cliquet de taille
 * veille. Ces encarts ne partagent aucun état avec la page : ils reçoivent
 * l'agrégat `sobriete` et rendent. Feuille pure, testable sans monter la page.
 *
 * ── La règle qui gouverne tout ce fichier ───────────────────────────────
 * JAMAIS un coût sans un signal de qualité en regard (RouteLLM, §5.3 de
 * l'étude). Un tableau de bord qui n'affiche que l'économie invite à
 * descendre partout ; apparié au taux d'erreur, il montre ce que la descente
 * coûte réellement — chez nous, rien.
 *
 * ── Et la règle qui gouverne les vides ──────────────────────────────────
 * Tout ce qui vient de la ventilation T-066 n'existe QUE pour les tours
 * enregistrés depuis. Un encart sans données ne se cache pas et n'affiche pas
 * zéro : il DIT qu'il attend, et pourquoi. Un zéro et une absence de mesure
 * ne se confondent jamais (leçon T-035/T-036).
 */
import { calculerSignalEscalade, type TourPourEscalade } from "./escaladeSignal";
import { formatTokens } from "./fableUsage";
import { calculerPyramide, LIBELLE_ETAGE } from "./pyramideDelegation";
import type { UsageSobriete } from "./usageStatsClient";

/** Barre nommée réutilisant le vocabulaire visuel des « modèles les plus utilisés ». */
function Barre({
  nom,
  detail,
  pct,
  valeur,
}: Readonly<{ nom: string; detail?: string; pct: number; valeur: string }>) {
  return (
    <div className="supervision-model-row">
      <div className="supervision-model-name" title={detail ? `${nom} — ${detail}` : nom}>
        <span className="supervision-model-name__label">{nom}</span>
        {detail && <span className="supervision-model-name__engine">{detail}</span>}
      </div>
      <div className="supervision-model-bar-track">
        <div className="supervision-model-bar-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
      <div className="supervision-model-metrics">{valeur}</div>
    </div>
  );
}

function pct(part: number, tout: number): number {
  return tout > 0 ? (part / tout) * 100 : 0;
}

/* ---------- Fiabilité — le contrepoids du coût ---------- */

/**
 * Se calcule sur TOUT l'historique : `status` était enregistré depuis toujours
 * et n'était agrégé nulle part. Un tour pouvait échouer sans que la page de
 * supervision en porte la moindre trace.
 */
export function FiabilitePanel({
  sobriete,
  totalTours,
}: Readonly<{ sobriete: UsageSobriete | null; totalTours: number }>) {
  if (!sobriete) {
    return (
      <section className="panel">
        <div className="panel__title">Fiabilité</div>
        <p className="empty-hint">Indisponible (sidecar antérieur ?).</p>
      </section>
    );
  }
  const tauxErreur = pct(sobriete.toursErreur, totalTours);
  const tauxAbandon = pct(sobriete.toursAbandon, totalTours);
  const maxCause = sobriete.parCause.reduce((m, c) => Math.max(m, c.tours), 0);
  const maxAbandon = sobriete.parCauseAbandon.reduce((m, c) => Math.max(m, c.tours), 0);
  // T-076 — les échecs sans cause ont leur propre classe pour être VUS.
  const sansCause = sobriete.parCause.find((c) => c.cause.startsWith("(aucune cause"));
  return (
    <section className="panel">
      <div className="panel__title">Fiabilité</div>
      <div className="supervision-kpi-grid">
        <div className="supervision-kpi-card">
          <div className="panel__title">Tours en panne</div>
          <div className="supervision-kpi-value">{totalTours > 0 ? `${tauxErreur.toFixed(1)} %` : "—"}</div>
          <div className="supervision-kpi-sub">{sobriete.toursErreur} sur {totalTours}</div>
        </div>
        <div className="supervision-kpi-card">
          <div className="panel__title">Tours interrompus</div>
          <div className="supervision-kpi-value">{totalTours > 0 ? `${tauxAbandon.toFixed(1)} %` : "—"}</div>
          <div className="supervision-kpi-sub">{sobriete.toursAbandon} arrêt(s) volontaire(s)</div>
        </div>
      </div>
      {sobriete.parCause.length === 0 ? (
        <p className="empty-hint">Aucune panne sur cette période.</p>
      ) : (
        <div className="supervision-models-list">
          {sobriete.parCause.map((c) => (
            <Barre key={c.cause} nom={c.cause} pct={pct(c.tours, maxCause)} valeur={String(c.tours)} />
          ))}
        </div>
      )}
      {sansCause && (
        <p className="empty-hint empty-hint--error">
          {sansCause.tours} échec(s) sans cause enregistrée : un tour qui rate sans dire pourquoi reste un
          échec muet (T-076).
        </p>
      )}
      {/* T-082 — les interruptions sont montrées, jamais fondues dans les
          pannes : jusqu'au 2026-08-19 elles gonflaient le taux d'erreur (11
          tours sur 11 la semaine du 17 août) pendant que ce compteur-ci
          restait à zéro. Deux listes séparées, deux lectures différentes. */}
      {sobriete.parCauseAbandon.length > 0 && (
        <>
          <div className="panel__title panel__title--sub">Interruptions — usage normal</div>
          <div className="supervision-models-list">
            {sobriete.parCauseAbandon.map((c) => (
              <Barre key={c.cause} nom={c.cause} pct={pct(c.tours, maxAbandon)} valeur={String(c.tours)} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/* ---------- Signal d'escalade — la seule preuve qu'un routage est BON ---------- */

/**
 * T-074 — tours où un petit modèle a été essayé puis refait par un plus gros
 * (RouterArena, « routing optimality », §5.3/§7.7 de l'étude). Sans elle, la
 * pyramide de délégation (ci-dessus) invite à descendre sans jamais dire ce
 * que la descente coûte.
 *
 * ── Ce qui est compté, et ce qui NE L'EST PAS ─────────────────────────────
 * Décision d'arbitrage POUR RESTER HONNÊTE : seule l'escalade INCONTESTABLE
 * est comptée — un tour en ERREUR suivi IMMÉDIATEMENT (le tour suivant de la
 * MÊME conversation) par un tour sur un tier STRICTEMENT supérieur. Une
 * « qualité insuffisante » sans erreur n'est PAS mesurable sans juge (§7.5) —
 * l'encart le DIT, plutôt que de laisser croire qu'il voit plus qu'il ne voit.
 *
 * Le calcul (`escaladeSignal.ts`) est PUR et TESTÉ ; ce composant se borne à
 * le nourrir de la projection minimale servie par `usage.stats`.
 */
export function EscaladePanel({ escaladeTours }: Readonly<{ escaladeTours: TourPourEscalade[] | null }>) {
  if (!escaladeTours) {
    return (
      <section className="panel">
        <div className="panel__title">Signal d'escalade</div>
        <p className="empty-hint">Indisponible (sidecar antérieur ?).</p>
      </section>
    );
  }
  const signal = calculerSignalEscalade(escaladeTours);
  return (
    <section className="panel">
      <div className="panel__title">Signal d'escalade</div>
      {signal.toursErreurComparables === 0 ? (
        <p className="empty-hint">
          Aucune paire comparable sur cette période — ni erreur suivie d'un tour dont le modèle est connu du
          barème de routage, ni conversation avec plusieurs tours consécutifs.
        </p>
      ) : (
        <div className="supervision-kpi-grid">
          <div className="supervision-kpi-card">
            <div className="panel__title">Escalades sur échec</div>
            <div className="supervision-kpi-value">{signal.toursEscalade}</div>
            <div className="supervision-kpi-sub">sur {signal.toursErreurComparables} panne(s) comparable(s)</div>
          </div>
          <div className="supervision-kpi-card">
            <div className="panel__title">Conversations concernées</div>
            <div className="supervision-kpi-value">{signal.conversationsAvecEscalade}</div>
          </div>
        </div>
      )}
      <p className="empty-hint">
        Seule l'escalade sur ÉCHEC est comptée — un tour jugé insuffisant SANS erreur n'entre jamais dans ce
        chiffre, faute d'un juge pour le décider (§7.5).
      </p>
    </section>
  );
}

/* ---------- Délégation et cache — issus de la ventilation T-066 ---------- */

/**
 * `toursVentiles` est le dénominateur, et il est AFFICHÉ. Sans lui, une part
 * déléguée calculée sur trois tours aurait exactement l'allure d'une part
 * calculée sur mille.
 *
 * Rappel de la limite assumée (claude.ts, `extractModelUsage`) : un sous-agent
 * tournant sur le MÊME modèle que le fil est indiscernable et compte comme
 * fil. La part déléguée est donc un MINORANT, et l'encart le dit.
 */
export function DelegationPanel({ sobriete }: Readonly<{ sobriete: UsageSobriete | null }>) {
  if (!sobriete) {
    return (
      <section className="panel">
        <div className="panel__title">Délégation</div>
        <p className="empty-hint">Indisponible (sidecar antérieur ?).</p>
      </section>
    );
  }
  if (sobriete.toursVentiles === 0) {
    return (
      <section className="panel">
        <div className="panel__title">Délégation</div>
        <p className="empty-hint">
          Aucun tour ventilé sur cette période. La ventilation par modèle (T-066) n'existe que pour les
          tours enregistrés depuis sa mise en place — l'historique antérieur ne portait qu'un modèle par
          tour.
        </p>
      </section>
    );
  }
  const total = sobriete.tokensFil + sobriete.tokensDelegue + sobriete.tokensRoleInconnu;
  const maxModele = sobriete.parModeleReel.reduce((m, x) => Math.max(m, x.tokens), 0);
  return (
    <section className="panel">
      <div className="panel__title">Délégation</div>
      <div className="supervision-kpi-grid">
        <div className="supervision-kpi-card">
          <div className="panel__title">Part déléguée</div>
          <div className="supervision-kpi-value">{`${Math.round(pct(sobriete.tokensDelegue, total))} %`}</div>
          <div className="supervision-kpi-sub">des tokens · minorant</div>
        </div>
        <div className="supervision-kpi-card">
          <div className="panel__title">Tours ayant délégué</div>
          <div className="supervision-kpi-value">{sobriete.toursAvecDelegation}</div>
          <div className="supervision-kpi-sub">sur {sobriete.toursVentiles} tour(s) ventilé(s)</div>
        </div>
        <div className="supervision-kpi-card">
          <div className="panel__title">Taux de cache</div>
          <div className="supervision-kpi-value">
            {sobriete.cacheHitPct !== null ? `${sobriete.cacheHitPct} %` : "—"}
          </div>
          <div className="supervision-kpi-sub">{formatTokens(sobriete.cacheReadTokens)} relus</div>
        </div>
      </div>
      <div className="supervision-models-list">
        {sobriete.parModeleReel.map((m) => (
          <Barre
            key={m.model}
            nom={m.model}
            detail={m.toursDelegue > 0 ? `délégué ${m.toursDelegue}×` : "fil"}
            pct={pct(m.tokens, maxModele)}
            valeur={`${formatTokens(m.tokens)}${m.costUsd > 0 ? ` · ${m.costUsd.toFixed(2)} $` : ""}`}
          />
        ))}
      </div>
      <p className="empty-hint">
        Un sous-agent tournant sur le même modèle que le fil est indiscernable et compte comme fil : la
        part déléguée est un minorant. Elle deviendra exacte quand les sous-agents seront déclarés avec
        leur propre modèle.
      </p>
    </section>
  );
}

/* ---------- Pyramide de délégation, pondérée par le COÛT ---------- */

/**
 * T-071, « reste à faire » (docs/etude-supervision.md §7.1) : la part de
 * chaque étage {gros, petit payant, mécanique, local} dans le COÛT équivalent
 * API, pas dans les tokens. Mesuré sur l'historique complet : une pyramide en
 * tokens annonçait 61 % de gros modèles là où le coût en dit 99,4 % — un
 * token de gros modèle vaut 15 à 75× un token de mécanique, et le tiers
 * gratuit qui donnait l'air d'un équilibre pèse exactement zéro dans la
 * facture. Basculer une tâche vers un étage inférieur ne se juge JAMAIS sur
 * les tokens déplacés : c'est le coût qui bouge, et il bouge bien plus.
 *
 * L'étage se déduit du TAUX RÉEL du modèle sur la période (`pyramideDelegation.ts`),
 * jamais de son nom — un catalogue par nom pourrit à chaque sortie de modèle.
 *
 * Doctrine (jamais un coût sans qualité en regard) : le détail du taux
 * d'erreur PAR ÉTAGE n'existe pas encore — l'agrégat de fiabilité ne relie
 * pas une panne à son modèle. Le taux GLOBAL est rappelé ici en attendant,
 * avec un renvoi explicite vers le panneau Fiabilité pour le détail.
 */
export function PyramidePanel({
  sobriete,
  totalTours,
}: Readonly<{ sobriete: UsageSobriete | null; totalTours: number }>) {
  if (!sobriete || sobriete.toursVentiles === 0) {
    return (
      <section className="panel">
        <div className="panel__title">Pyramide de délégation</div>
        <p className="empty-hint">
          Aucun tour ventilé sur cette période — la pyramide (T-066) n'existe que pour les tours enregistrés
          depuis sa mise en place.
        </p>
      </section>
    );
  }
  const pyramide = calculerPyramide(sobriete.parModeleReel);
  if (!pyramide) {
    return (
      <section className="panel">
        <div className="panel__title">Pyramide de délégation</div>
        <p className="empty-hint">Aucun modèle avec des tokens comptés sur cette période.</p>
      </section>
    );
  }
  const tauxErreur = pct(sobriete.toursErreur, totalTours);
  const maxPct = pyramide.lignes.reduce((m, l) => Math.max(m, l.pctCout), 0);
  return (
    <section className="panel">
      <div className="panel__title">Pyramide de délégation</div>
      <p className="empty-hint">
        Part de chaque étage dans le coût équivalent API de la période ({pyramide.coutTotalUsd.toFixed(2)} $) —
        PAS dans les tokens, qui flattent (§7.1 : 61 % de gros modèles en tokens, 99,4 % en coût, mesuré).
      </p>
      <div className="supervision-models-list">
        {pyramide.lignes.map((l) => (
          <Barre
            key={l.etage}
            nom={LIBELLE_ETAGE[l.etage]}
            detail={`cible ${l.borne.min}-${l.borne.max} %${l.dansLaBorne ? " · dans la cible" : ""}`}
            pct={maxPct > 0 ? (l.pctCout / maxPct) * 100 : 0}
            valeur={`${Math.round(l.pctCout)} % · ${l.costUsd.toFixed(2)} $`}
          />
        ))}
      </div>
      <p className="empty-hint">
        Taux d'erreur global de la période :{" "}
        {totalTours > 0 ? `${tauxErreur.toFixed(1)} %` : "—"} — jamais un coût sans un signal de qualité en
        regard (détail par cause dans le panneau Fiabilité ; pas encore de détail PAR ÉTAGE, l'agrégat ne relie
        pas une panne à son modèle).
      </p>
    </section>
  );
}

/* ---------- Concentration du coût — dit OÙ agir ---------- */

/**
 * 41 % du coût dans 10 % des tours (mesure du 2026-08-17) : optimiser « en
 * moyenne » ne touche que la moitié la moins chère du problème. C'est le seul
 * indicateur de la page qui désigne une STRATÉGIE plutôt qu'un état.
 */
export function ConcentrationPanel({ sobriete }: Readonly<{ sobriete: UsageSobriete | null }>) {
  if (!sobriete || sobriete.toursAvecCout === 0) {
    return (
      <section className="panel">
        <div className="panel__title">Concentration du coût</div>
        <p className="empty-hint">
          Aucun coût par tour sur cette période — la ventilation T-066 le porte, l'historique antérieur
          non.
        </p>
      </section>
    );
  }
  const usd = (v: number | null) => (v !== null ? `${v.toFixed(2)} $` : "—");
  return (
    <section className="panel">
      <div className="panel__title">Concentration du coût</div>
      <div className="supervision-kpi-grid">
        <div className="supervision-kpi-card">
          <div className="panel__title">Les 10 % les plus chers</div>
          <div className="supervision-kpi-value">
            {sobriete.concentrationTop10Pct !== null ? `${sobriete.concentrationTop10Pct} %` : "—"}
          </div>
          <div className="supervision-kpi-sub">du coût de la période</div>
        </div>
        <div className="supervision-kpi-card">
          <div className="panel__title">Tour médian</div>
          <div className="supervision-kpi-value">{usd(sobriete.coutTourMedianUsd)}</div>
          <div className="supervision-kpi-sub">sur {sobriete.toursAvecCout} tour(s)</div>
        </div>
        <div className="supervision-kpi-card">
          <div className="panel__title">Tour le plus cher</div>
          <div className="supervision-kpi-value">{usd(sobriete.coutTourMaxUsd)}</div>
          <div className="supervision-kpi-sub">total {usd(sobriete.coutVentileUsd)}</div>
        </div>
      </div>
    </section>
  );
}

/* ---------- Activité : heures, contexte, durée ---------- */

/**
 * Le contexte affiché ici est le RÉEL (entrée fraîche + cache relu + cache
 * créé), pas `promptTokens` — dont la médiane était de 6 tokens parce que le
 * SDK en exclut le cache. L'ancien KPI « Contexte moyen » ne mesurait rien.
 */
export function ActivitePanel({ sobriete }: Readonly<{ sobriete: UsageSobriete | null }>) {
  if (!sobriete) {
    return (
      <section className="panel">
        <div className="panel__title">Activité</div>
        <p className="empty-hint">Indisponible (sidecar antérieur ?).</p>
      </section>
    );
  }
  const maxH = sobriete.heures.reduce((m, h) => Math.max(m, h), 0);
  const heurePic = sobriete.heures.indexOf(maxH);
  const secondes = (ms: number | null) => (ms !== null ? `${(ms / 1000).toFixed(1)} s` : "—");
  const toks = (t: number | null) => (t !== null ? formatTokens(t) : "—");
  // SVG plutôt qu'une grille CSS : même parti pris que SupervisionCourbes, et
  // aucune règle de style nouvelle à maintenir.
  const L = 24 * 14;
  return (
    <section className="panel">
      <div className="panel__title">Activité</div>
      <div className="supervision-kpi-grid">
        <div className="supervision-kpi-card">
          <div className="panel__title">Contexte réel médian</div>
          <div className="supervision-kpi-value">{toks(sobriete.contexteMedian)}</div>
          <div className="supervision-kpi-sub">P90 {toks(sobriete.contexteP90)}</div>
        </div>
        <div className="supervision-kpi-card">
          <div className="panel__title">Durée de tour médiane</div>
          <div className="supervision-kpi-value">{secondes(sobriete.dureeMedianeMs)}</div>
          <div className="supervision-kpi-sub">P90 {secondes(sobriete.dureeP90Ms)}</div>
        </div>
      </div>
      {maxH === 0 ? (
        <p className="empty-hint">Aucun tour sur cette période.</p>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${L} 60`}
            width="100%"
            height="60"
            role="img"
            aria-label={`Tours par heure locale, pic à ${heurePic} h avec ${maxH} tours`}
          >
            {sobriete.heures.map((h, i) => {
              const hauteur = Math.max(1, (h / maxH) * 46);
              return (
                <rect
                  key={i}
                  x={i * 14 + 2}
                  y={50 - hauteur}
                  width={10}
                  height={hauteur}
                  rx={2}
                  fill={i === heurePic ? "#ff0069" : "#1478ff"}
                />
              );
            })}
          </svg>
          <p className="empty-hint">
            Heure locale · pic à {heurePic} h ({maxH} tour{maxH > 1 ? "s" : ""}).
          </p>
        </>
      )}
    </section>
  );
}
