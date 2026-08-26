import { useEffect, useRef, useState } from "react";
import "./App.css";
import { AgentPage, type AgentPageHandle } from "./AgentPage";
import type { ChatPageHandle } from "./ChatPage";
import { CommandPalette } from "./CommandPalette";
// Les cinq autres pages n'arrivent qu'à leur première visite, et ne repartent
// jamais ensuite — voir pagesParesseuses.tsx (T-029).
import { ChatPage, OrchestrationPage, ProvidersPage, SlotPage, SupervisionPage, SystemPage } from "./pagesParesseuses";
import {
  subscribeReady,
  fetchStatus,
  restartSidecar,
  subscribeStatus,
  usageClaude,
  usageClaudeInit,
  usageCredits,
  type ClaudeUsageSnapshot,
  type ClaudeUsageWindow,
  type OpenrouterUsage,
} from "./sidecar";
import {
  COMPACT_BUTTON_MIN_TOKENS,
  COMPACT_BUTTON_RATIO,
  contextWindowFor,
  formatTokens,
  readCompactHandler,
  readContext,
  subscribeContext,
  type ContextSource,
} from "./contextBus";
import { initRoutingPush } from "./routerAdmin";
import { tachesList, tachesReports } from "./tachesClient";
import { stateRead, stateWrite } from "./stateClient";
import { openTerminal } from "./systemClient";
import { SystemStatsWidget } from "./SystemStatsWidget";
import { cleConfigureePour, providersDejaPousses, subscribeProvidersPushed } from "./providersBus";
import { subscribeUsageChanged } from "./usageBus";
import { useProjects } from "./useProjects";
import { useProviders } from "./useProviders";
import { useRovingFocus } from "./useRovingFocus";
import { useSpeech } from "./useSpeech";
import { Donut } from "./Donut";
import { NAV_ITEMS, type PageId } from "./navigation";
import { handleFocusCycleKey, handleZoneArrowKey } from "./focusZones";

/* ---------- Encart conso ---------- */

/** « Cron » de l'encart conso : relevé actif (micro-tour compris) toutes les 5 min. */
const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Garde anti-rafale du micro-tour d'initialisation (ready + statut + cron). */
const CLAUDE_INIT_MIN_GAP_MS = 60 * 1000;

function formatResetTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * Temps restant avant une réinitialisation, compact : « 3h » / « 45min »
 * (mode heures — fenêtre session) ou « 6j » / « 12h » (mode jours — hebdo).
 */
function remainingUntil(iso: string, mode: "hours" | "days"): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "0";
  if (mode === "hours") {
    if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}min`;
    return `${Math.ceil(ms / 3_600_000)}h`;
  }
  if (ms < 86_400_000) return `${Math.ceil(ms / 3_600_000)}h`;
  return `${Math.ceil(ms / 86_400_000)}j`;
}

/**
 * Fenêtre spécifique à un modèle (hebdo Opus/Fable…) : toute fenêtre relayée
 * par le sidecar qui n'est ni la session 5h ni l'hebdo globale. Le nommage de
 * cette API expérimentale n'étant pas garanti, on privilégie une clé évoquant
 * un modèle, sinon la première venue.
 */
function findModelWindow(
  windows: Record<string, ClaudeUsageWindow>,
): ClaudeUsageWindow | null {
  const entries = Object.entries(windows).filter(([k]) => k !== "five_hour" && k !== "seven_day");
  if (entries.length === 0) return null;
  const preferred = entries.find(([k]) => /opus|fable|sonnet|model/i.test(k)) ?? entries[0];
  return preferred[1];
}

function ClaudeInitButton({
  initializing,
  onInit,
}: Readonly<{ initializing: boolean; onInit: () => void }>) {
  return (
    <span className="usage-widget__placeholder">
      {"Claude : — "}
      <button
        type="button"
        className="usage-widget__init"
        disabled={initializing}
        onClick={onInit}
        title="Initialiser le relevé d'abonnement (micro-tour Claude économique)"
        aria-label="Initialiser le relevé d'abonnement Claude"
      >
        {initializing ? "…" : "↻"}
      </button>
    </span>
  );
}

/** Seuil à partir duquel une fenêtre est considérée saturée (plus de marge utile). */
const USAGE_SATURATED_PCT = 98;

/** Première fenêtre saturée, session (5h) d'abord — `null` si tout va bien. */
function pickSaturatedWindow(
  snapshot: ClaudeUsageSnapshot,
): { label: string; resetsAt: string; mode: "hours" | "days" } | null {
  if (snapshot.fiveHour && snapshot.fiveHour.utilization >= USAGE_SATURATED_PCT) {
    return { label: "Session 5h", resetsAt: snapshot.fiveHour.resetsAt, mode: "hours" };
  }
  if (snapshot.sevenDay && snapshot.sevenDay.utilization >= USAGE_SATURATED_PCT) {
    return { label: "Fenêtre 7 jours", resetsAt: snapshot.sevenDay.resetsAt, mode: "days" };
  }
  return null;
}

function ClaudeUsageBlock({
  snapshot,
  initializing,
  onInit,
}: Readonly<{ snapshot: ClaudeUsageSnapshot | null; initializing: boolean; onInit: () => void }>) {
  const modelWindow = snapshot?.available ? findModelWindow(snapshot.windows) : null;
  const hasAny = snapshot?.available && (snapshot.fiveHour || snapshot.sevenDay || modelWindow);
  if (!snapshot?.available || !hasAny) {
    return <ClaudeInitButton initializing={initializing} onInit={onInit} />;
  }
  // Seuil d'alerte : la session (5h) prime sur l'hebdo si les deux saturent —
  // c'est elle qui débloque le plus vite.
  const saturated = pickSaturatedWindow(snapshot);
  return (
    <div
      className="usage-widget__claude"
      title={snapshot.capturedAt ? `Dernier relevé : ${formatResetTime(snapshot.capturedAt)}` : undefined}
    >
      {snapshot.fiveHour && (
        <Donut
          label="Session"
          pct={snapshot.fiveHour.utilization}
          text={`${Math.round(snapshot.fiveHour.utilization)}% · ${remainingUntil(snapshot.fiveHour.resetsAt, "hours")}`}
          title={`Fenêtre 5h — réinitialisation : ${formatResetTime(snapshot.fiveHour.resetsAt)}`}
        />
      )}
      {snapshot.sevenDay && (
        <Donut
          label="Semaine"
          pct={snapshot.sevenDay.utilization}
          text={`${Math.round(snapshot.sevenDay.utilization)}% · ${remainingUntil(snapshot.sevenDay.resetsAt, "days")}`}
          title={`Fenêtre 7 jours — réinitialisation : ${formatResetTime(snapshot.sevenDay.resetsAt)}`}
        />
      )}
      {modelWindow && (
        <Donut
          label="Fable"
          pct={modelWindow.utilization}
          title={`Fenêtre hebdo du modèle — réinitialisation : ${formatResetTime(modelWindow.resetsAt)}`}
        />
      )}
      {/* Fenêtre saturée : la jauge seule passait inaperçue — on le dit en
          toutes lettres, avec le temps restant avant réinitialisation. */}
      {saturated && (
        <span className="usage-widget__alert" title={`Réinitialisation : ${formatResetTime(saturated.resetsAt)}`}>
          ⚠ {saturated.label} saturée — réinitialisation dans {remainingUntil(saturated.resetsAt, saturated.mode)}
        </span>
      )}
    </div>
  );
}

/**
 * Référence de « réservoir » OpenRouter : le solde disponible constaté juste
 * après la dernière recharge. total_credits/total_usage de l'API étant des
 * cumuls à vie du compte, leur ratio tend vers 100 % pour toujours — jauger
 * là-dessus affiche un badge éternellement plein. On jauge donc la
 * consommation du réservoir courant, réamorcé à chaque recharge.
 */
interface OpenrouterRef {
  peakRemaining: number;
  totalCredits: number;
}

function nextOpenrouterRef(prev: OpenrouterRef | null, usage: OpenrouterUsage): OpenrouterRef {
  // Recharge (total_credits a monté) ou solde au-dessus du pic connu : le
  // réservoir repart de ce solde. Sinon la référence ne bouge pas.
  if (!prev || usage.totalCredits > prev.totalCredits || usage.remaining > prev.peakRemaining) {
    return { peakRemaining: Math.max(usage.remaining, 0), totalCredits: usage.totalCredits };
  }
  return prev;
}

function OpenrouterUsageBlock({
  usage,
  refPoint,
  error,
}: Readonly<{ usage: OpenrouterUsage | null; refPoint: OpenrouterRef | null; error: boolean }>) {
  if (error || !usage) {
    return (
      <span className="usage-widget__placeholder" title="Aucune clé OpenRouter configurée, ou erreur réseau">
        OR : —
      </span>
    );
  }
  // Camembert : part consommée du réservoir courant (solde depuis la dernière
  // recharge). Sans référence (premier relevé), rien n'a été consommé depuis.
  const peak = refPoint?.peakRemaining ?? 0;
  const pct = peak > 0 ? ((peak - usage.remaining) / peak) * 100 : 0;
  return (
    <Donut
      label="OR"
      pct={pct}
      text={`reste ${usage.remaining.toFixed(2)}$`}
      title={`Depuis la dernière recharge : consommé ${Math.max(peak - usage.remaining, 0).toFixed(2)} $ sur ${peak.toFixed(2)} $ (${Math.round(Math.min(100, Math.max(0, pct)))} %) · Reste ${usage.remaining.toFixed(2)} $ · Historique du compte : ${usage.totalUsage.toFixed(2)} $ consommés sur ${usage.totalCredits.toFixed(2)} $ chargés`}
    />
  );
}

/**
 * Dernier relevé conso persisté sur disque (state store) : affiché dès le
 * lancement, avant qu'un tour Claude n'ait produit un instantané frais ou que
 * le moteur soit prêt à interroger OpenRouter.
 */
interface UsageCache {
  claude: ClaudeUsageSnapshot | null;
  openrouter: OpenrouterUsage | null;
  openrouterRef?: OpenrouterRef | null;
}

const USAGE_RETRY_DELAY_MS = 15_000;

/** Seul fournisseur dont l'encart de conso lit le crédit (endpoint `/credits`). */
const OPENROUTER_PROVIDER_ID = "openrouter";

function UsageWidget() {
  const [claudeSnapshot, setClaudeSnapshot] = useState<ClaudeUsageSnapshot | null>(null);
  const [openrouterUsage, setOpenrouterUsage] = useState<OpenrouterUsage | null>(null);
  const [openrouterRef, setOpenrouterRef] = useState<OpenrouterRef | null>(null);
  const [openrouterError, setOpenrouterError] = useState(false);
  const [claudeInitializing, setClaudeInitializing] = useState(false);

  function handleClaudeInit() {
    if (claudeInitializing) return;
    setClaudeInitializing(true);
    usageClaudeInit()
      .then((snap) => {
        if (!snap.available) return;
        setClaudeSnapshot(snap);
        // Persistance : fusion avec le cache existant (l'OpenRouter éventuel y reste).
        stateRead<Partial<UsageCache>>("usage-cache")
          .catch(() => ({}) as Partial<UsageCache>)
          .then((cache) => stateWrite("usage-cache", { ...cache, claude: snap }))
          .catch(() => {
            /* best effort */
          });
      })
      .catch(() => {
        /* micro-tour en échec (hors ligne, non connecté…) : l'encart reste à « — » */
      })
      .finally(() => setClaudeInitializing(false));
  }

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Relais vers le cache disque : on ne réécrit que ce qui a été rafraîchi
    // avec succès (l'autre moitié garde sa dernière valeur connue).
    const cacheRef: UsageCache = { claude: null, openrouter: null, openrouterRef: null };

    function persistCache() {
      stateWrite("usage-cache", cacheRef).catch(() => {
        /* best effort : l'encart reste fonctionnel sans persistance */
      });
    }

    function scheduleRetry() {
      if (cancelled || retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        refresh();
      }, USAGE_RETRY_DELAY_MS);
    }

    function refresh() {
      usageClaude()
        .then((snap) => {
          if (cancelled) return;
          // Un instantané « indisponible » (aucun tour Claude joué depuis le
          // démarrage du sidecar) ne doit pas écraser le dernier relevé réel
          // (frais ou restauré du cache disque).
          setClaudeSnapshot((prev) => {
            if (snap.available) {
              cacheRef.claude = snap;
              persistCache();
              return snap;
            }
            return prev?.available ? prev : (prev ?? snap);
          });
          if (!snap.available) scheduleRetry();
        })
        .catch(() => {
          if (!cancelled) scheduleRetry();
        });
      // T-008 — ne RIEN demander au sujet d'un fournisseur tant que la table
      // n'a pas atteint le sidecar : sinon il répond « fournisseur inconnu »,
      // ligne d'erreur à chaque démarrage pour une simple course. L'abonnement
      // ci-dessous relance dès que la poussée a lieu.
      if (!providersDejaPousses()) return;
      // Aucune clé OpenRouter enregistrée : l'appel ne peut QUE répondre « clé
      // API manquante ». Le retenter toutes les 15 s remplissait le journal
      // d'erreurs pour une configuration parfaitement volontaire (l'utilisateur
      // n'a simplement pas de compte OpenRouter). L'encart affiche le même
      // « OR : — » qu'avant, et l'abonnement `providers.set` relancera tout
      // seul la sonde à la seconde où une clé sera saisie.
      if (!cleConfigureePour(OPENROUTER_PROVIDER_ID)) {
        setOpenrouterUsage((prev) => {
          if (!prev) setOpenrouterError(true);
          return prev;
        });
        return;
      }
      usageCredits(OPENROUTER_PROVIDER_ID)
        .then((usage) => {
          if (cancelled) return;
          const nextRef = nextOpenrouterRef(cacheRef.openrouterRef ?? null, usage);
          setOpenrouterUsage(usage);
          setOpenrouterRef(nextRef);
          setOpenrouterError(false);
          cacheRef.openrouter = usage;
          cacheRef.openrouterRef = nextRef;
          persistCache();
        })
        .catch(() => {
          if (cancelled) return;
          // Pas de clé/erreur réseau : on garde l'éventuel relevé restauré
          // du cache plutôt que de basculer sur « — », et on retentera.
          setOpenrouterUsage((prev) => {
            if (!prev) setOpenrouterError(true);
            return prev;
          });
          scheduleRetry();
        });
    }

    // Récupération ACTIVE du relevé d'abonnement (micro-tour économique, voir
    // usage.claude.init) : au démarrage dès que le sidecar est prêt, puis via
    // le cron de 20 min. Garde anti-rafale (ready + statut + cron peuvent se
    // chevaucher) et une seule requête en vol.
    let initInFlight = false;
    let lastInitAt = 0;
    function autoInit() {
      if (cancelled || initInFlight) return;
      if (Date.now() - lastInitAt < CLAUDE_INIT_MIN_GAP_MS) return;
      initInFlight = true;
      lastInitAt = Date.now();
      usageClaudeInit()
        .then((snap) => {
          if (cancelled || !snap.available) return;
          setClaudeSnapshot(snap);
          cacheRef.claude = snap;
          persistCache();
        })
        .catch(() => {
          /* hors ligne / non connecté : le prochain passage du cron retentera */
        })
        .finally(() => {
          initInFlight = false;
        });
    }

    // Restauration du dernier relevé connu, puis premier rafraîchissement.
    stateRead<Partial<UsageCache>>("usage-cache")
      .then((cache) => {
        if (cancelled || !cache) return;
        if (cache.claude?.available) {
          cacheRef.claude = cache.claude;
          setClaudeSnapshot((prev) => prev ?? cache.claude ?? null);
        }
        if (cache.openrouter && typeof cache.openrouter.remaining === "number") {
          cacheRef.openrouter = cache.openrouter;
          setOpenrouterUsage((prev) => prev ?? cache.openrouter ?? null);
          setOpenrouterError(false);
        }
        if (cache.openrouterRef && typeof cache.openrouterRef.peakRemaining === "number") {
          cacheRef.openrouterRef = cache.openrouterRef;
          setOpenrouterRef((prev) => prev ?? cache.openrouterRef ?? null);
        }
      })
      .catch(() => {
        /* pas de cache : l'encart démarre à « — » comme avant */
      })
      .finally(() => {
        if (cancelled) return;
        refresh();
        // Couvre le cas où le sidecar était déjà prêt avant nos abonnements
        // (rechargement à chaud) : aucun event ready/statut ne viendra.
        autoInit();
      });

    const interval = setInterval(() => {
      refresh();
      autoInit();
    }, USAGE_REFRESH_INTERVAL_MS);
    const offUsageChanged = subscribeUsageChanged(refresh);
    const offProviders = subscribeProvidersPushed(refresh);
    // Le premier essai part souvent avant que le sidecar ne soit joignable :
    // on relance dès qu'il annonce « ready » (ou repasse « running »), avec la
    // récupération active du relevé d'abonnement au passage.
    const offReady = subscribeReady(() => {
      refresh();
      autoInit();
    });
    const offStatus = subscribeStatus((s) => {
      if (s.state === "running") {
        refresh();
        autoInit();
      }
    });

    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      clearInterval(interval);
      offUsageChanged();
      offProviders();
      offReady();
      offStatus();
    };
  }, []);

  return (
    <div className="usage-widget" title="Consommation">
      <ClaudeUsageBlock snapshot={claudeSnapshot} initializing={claudeInitializing} onInit={handleClaudeInit} />
      <OpenrouterUsageBlock usage={openrouterUsage} refPoint={openrouterRef} error={openrouterError} />
    </div>
  );
}

/* ---------- Encart contexte ---------- */

/**
 * Contexte consommé par le fil de la page visible, en camembert comme les
 * autres encarts : « Contexte 34 k/200 k ». `source` désigne la page affichée
 * (voir contextBus.ts) — `null` sur les pages sans conversation, l'encart
 * disparaît alors plutôt que d'afficher un chiffre périmé.
 */
function ContextWidget({ source }: Readonly<{ source: ContextSource | null }>) {
  const [info, setInfo] = useState(() => (source ? readContext(source) : null));
  // Action « Compacter » enregistrée par la page visible (null = indisponible).
  const [onCompact, setOnCompact] = useState(() => (source ? readCompactHandler(source) : null));

  useEffect(() => {
    setInfo(source ? readContext(source) : null);
    setOnCompact(() => (source ? readCompactHandler(source) : null));
    if (!source) return;
    return subscribeContext(() => {
      setInfo(readContext(source));
      setOnCompact(() => readCompactHandler(source));
    });
  }, [source]);

  if (!info) return null;
  const max = contextWindowFor(info.model, info.usedTokens);
  const used = formatTokens(info.usedTokens);
  // Fenêtre inconnue (modèle hors table) : on montre les tokens consommés
  // sans inventer de pourcentage.
  if (max === null) {
    return (
      <div className="context-widget" title={`Contexte : ${info.usedTokens} tokens · fenêtre du modèle inconnue`}>
        <span className="usage-donut usage-donut--ok">
          <span className="usage-donut__label">Contexte</span>
          <span className="usage-donut__text">{used}</span>
        </span>
      </div>
    );
  }
  const pct = (info.usedTokens / max) * 100;
  return (
    <div className="context-widget">
      <Donut
        label="Contexte"
        pct={pct}
        text={`${Math.round(pct)}% · ${used}/${formatTokens(max)}`}
        title={`Contexte : ${info.usedTokens} tokens sur ${max} (${info.model})`}
      />
      {/* Contexte élevé : proposer la compaction du fil courant (l'action vit
          dans la page — Projets : « /compact » au CLI ; Chat : recompaction R4). */}
      {(pct >= COMPACT_BUTTON_RATIO * 100 || info.usedTokens >= COMPACT_BUTTON_MIN_TOKENS) && onCompact && (
        <button
          type="button"
          className="context-widget__compact"
          onClick={onCompact}
          title="Contexte élevé — compacter le fil : l'historique ancien est résumé, la conversation continue avec un contexte réduit"
        >
          Compacter
        </button>
      )}
    </div>
  );
}

/** Page visible → fil dont l'encart contexte parle (`null` = aucun). */
function contextSourceFor(page: PageId): ContextSource | null {
  if (page === "projects") return "agent";
  if (page === "chat") return "chat";
  return null;
}

/* ---------- Navigation ---------- */



/** Clé localStorage : mtime du dernier rapport de tâche « vu » (l'ouverture d'Orchestration marque vu). */
const TACHE_REPORTS_SEEN_KEY = "iastudio.tacheReportsSeenMs";

function Nav({
  active,
  onSelect,
  onOpenTerminal,
  orchestrationAlert,
}: Readonly<{
  active: PageId;
  onSelect: (id: PageId) => void;
  onOpenTerminal: () => void;
  /** Libellé du dernier rapport de tâche non vu (null = rien à signaler) — pastille sur l'onglet Orchestration. */
  orchestrationAlert: string | null;
}>) {
  // Roving tabindex : ←/→ (et Début/Fin) parcourent la barre, Entrée ou Espace
  // active — se DÉPLACER ne change pas de page (activation manuelle, APG). Le
  // bouton « Terminal » fait partie du parcours : il est dans la barre, et
  // l'en sortir laisserait un arrêt de tabulation isolé au bout du menu.
  const roving = useRovingFocus<HTMLElement>({ selector: ".nav-item", orientation: "horizontal" });
  return (
    <nav
      className="app-nav"
      aria-label="Navigation principale"
      ref={roving.containerRef}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      {NAV_ITEMS.map((item) => {
        const alerted = item.id === "orchestration" && orchestrationAlert !== null;
        return (
          <button
            key={item.id}
            type="button"
            className={`nav-item${active === item.id ? " nav-item--active" : ""}${alerted ? " nav-item--alert" : ""}`}
            onClick={() => onSelect(item.id)}
            aria-current={active === item.id ? "page" : undefined}
            tabIndex={active === item.id ? 0 : -1}
            title={alerted ? `Nouveau rapport de tâche : ${orchestrationAlert}` : undefined}
          >
            {item.label}
          </button>
        );
      })}
      {/* Action (pas un onglet) : lance un terminal système — dans le projet
          en cours quand la vue Projets est active, sinon dans le home. */}
      <button
        type="button"
        className="nav-item nav-item--action"
        onClick={onOpenTerminal}
        tabIndex={-1}
        title="Ouvrir un terminal (dans le projet en cours depuis la vue Projets)"
      >
        Terminal
      </button>
    </nav>
  );
}

/*
 * En-tête + navigation principale : la barre d'onglets (Projets/Chat/
 * Configuration/Système) est intégrée à l'en-tête (rangée sous la marque),
 * plutôt qu'une colonne latérale verticale — libère toute la largeur pour le
 * contenu (voir App.css § En-tête / Navigation horizontale).
 */
function Header({
  page,
  onSelectPage,
  onOpenTerminal,
  orchestrationAlert,
}: Readonly<{
  page: PageId;
  onSelectPage: (id: PageId) => void;
  onOpenTerminal: () => void;
  orchestrationAlert: string | null;
}>) {
  return (
    <header className="app-header">
      <div className="app-header__top">
        <div className="brand">
          <div className="brand__title">
            IA <em>STUDIO</em>
            {/* Injectée à la compilation (ui/vite.config.ts) : pas d'attente,
                pas d'état d'échec à dessiner, et la même valeur qu'affiche
                l'installeur. */}
            <span className="brand__version" title={`IAction ${__VERSION_APPLICATION__}`}>
              v{__VERSION_APPLICATION__}
            </span>
          </div>
          <div className="brand__subtitle">Chat multi-fournisseur</div>
        </div>
        <div className="app-header__right">
          <ContextWidget source={contextSourceFor(page)} />
          <SystemStatsWidget />
          <UsageWidget />
        </div>
      </div>
      <Nav active={page} onSelect={onSelectPage} onOpenTerminal={onOpenTerminal} orchestrationAlert={orchestrationAlert} />
    </header>
  );
}

/* ---------- App ---------- */

/* ---------- Bannière « sidecar mort » ---------- */

/**
 * Bandeau global proposant de relancer le sidecar quand il est mort.
 *
 * L'état `dead` (cinq échecs rapprochés) n'offrait aucune issue dans
 * l'application : il fallait la quitter entièrement — donc perdre fenêtre,
 * onglets et session en cours — pour une panne le plus souvent passagère
 * (sidecar recompilé sous les pieds de l'application, par exemple). La
 * bannière est volontairement au niveau de la coquille : le sidecar sert
 * TOUTES les pages, l'information n'appartient à aucune.
 */
function SidecarMortBanner() {
  const [dead, setDead] = useState(false);
  const [relance, setRelance] = useState(false);
  const [erreur, setErreur] = useState("");

  useEffect(() => {
    fetchStatus()
      .then((s) => setDead(s.state === "dead"))
      .catch(() => {});
    return subscribeStatus((s) => {
      setDead(s.state === "dead");
      if (s.state !== "dead") {
        setRelance(false);
        setErreur("");
      }
    });
  }, []);

  if (!dead) return null;
  return (
    <div className="sidecar-dead-banner">
      <span>
        Le moteur de l'application (sidecar) s'est arrêté après plusieurs échecs. Les conversations
        enregistrées sont intactes.
      </span>
      <button
        type="button"
        className="btn"
        disabled={relance}
        onClick={() => {
          setRelance(true);
          setErreur("");
          restartSidecar().catch((err) => {
            setRelance(false);
            setErreur(err instanceof Error ? err.message : String(err));
          });
        }}
      >
        {relance ? "Relance…" : "Relancer le moteur"}
      </button>
      {erreur && <span className="sidecar-dead-banner__error">{erreur}</span>}
    </div>
  );
}

function App() {
  const [page, setPage] = useState<PageId>("projects");
  // Pastille « nouveau rapport de tâche » sur l'onglet Orchestration (c'est là
  // que vivent les tâches et leur lecteur de rapports) : sonde légère (liste
  // des tâches + mtime des rapports, toutes les 60 s), comparée au dernier
  // « vu » (localStorage). Ouvrir Orchestration marque vu.
  const [tacheAlert, setTacheAlert] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function checkTacheReports() {
      try {
        const taches = await tachesList();
        let latestMs = 0;
        let latestLabel = "";
        for (const t of taches) {
          const reports = await tachesReports(t.name).catch(() => []);
          for (const r of reports) {
            if (r.mtimeMs > latestMs) {
              latestMs = r.mtimeMs;
              latestLabel = `${t.name} · ${r.file}`;
            }
          }
        }
        const seenMs = Number(localStorage.getItem(TACHE_REPORTS_SEEN_KEY) ?? "0");
        if (!cancelled) setTacheAlert(latestMs > seenMs ? latestLabel : null);
      } catch {
        // sidecar pas prêt / erreur passagère : pas de pastille, on retentera.
      }
    }
    void checkTacheReports();
    const interval = setInterval(() => void checkTacheReports(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  useEffect(() => {
    if (page === "orchestration" && tacheAlert !== null) {
      localStorage.setItem(TACHE_REPORTS_SEEN_KEY, String(Date.now()));
      setTacheAlert(null);
    }
  }, [page, tacheAlert]);
  const providerAdmin = useProviders();
  const projectAdmin = useProjects();
  // R1 — push de la table de routage (« model: auto ») au sidecar, accroché
  // au signal « providers poussés » : même cycle de vie que la table des
  // fournisseurs (démarrage, ready du sidecar, modifications dans l'admin).
  useEffect(() => initRoutingPush(), []);
  // Config voix (dictée/synthèse) : poussée au sidecar au démarrage et à
  // chaque changement, même cycle de vie que les fournisseurs.
  const speechAdmin = useSpeech();
  // Bascule imperative depuis la palette Ctrl+Maj+P — voir le commentaire
  // d'architecture en tête de CommandPalette.tsx : AgentPage garde la
  // propriété du projet sélectionné, App ne détient qu'un `ref` pour lui
  // demander une bascule (et savoir si elle a été acceptée).
  const agentPageRef = useRef<AgentPageHandle>(null);
  // Même principe pour la page Chat (Ctrl+N/Ctrl+K, voir l'écouteur clavier
  // global ci-dessous) : ChatPage garde la pleine propriété de son état.
  const chatPageRef = useRef<ChatPageHandle>(null);
  // Ctrl+K est destructif : la touche mémorise seulement la page ciblée, le

  function handlePaletteSelectProject(id: string): boolean {
    const ok = agentPageRef.current?.requestSelectProject(id) ?? false;
    if (ok) setPage("projects");
    return ok;
  }

  function handleOpenTerminal() {
    // Vue Projets → terminal dans le projet en cours ; ailleurs → home.
    const projectPath = page === "projects" ? (agentPageRef.current?.getSelectedProjectPath() ?? null) : null;
    openTerminal(projectPath).catch(() => {
      /* aucun émulateur trouvé : rien à afficher de plus utile ici */
    });
  }

  /*
   * Raccourcis clavier globaux (liste complète : page « Raccourcis » de
   * Configuration, voir ProvidersPage.tsx) — UN SEUL écouteur `keydown` ici,
   * plutôt qu'un par page ; chaque page n'expose que l'action via son `ref`
   * impératif (même patron que la palette de projets ci-dessus).
   *
   * Focus dans un champ de saisie : Ctrl+P/Ctrl+H restent actifs (simple
   * navigation, sans risque) ; Ctrl+N/Ctrl+K aussi — les bloquer pendant la
   * frappe d'un message serait frustrant — donc aucun garde de focus n'est
   * nécessaire pour ces 4 raccourcis. Ce qui reste bloquant : un streaming en
   * cours — `newSession`/`clearConversation` (AgentPageHandle/ChatPageHandle)
   * s'y refusent déjà d'eux-mêmes (silencieux, comme les boutons
   * correspondants), et `isStreaming` sert de garde ici même AVANT d'ouvrir
   * la confirmation de Ctrl+K (sinon une modale s'afficherait pour rien).
   *
   * `preventDefault` est systématique : Ctrl+P déclencherait sinon
   * l'impression, Ctrl+N une nouvelle fenêtre côté webview, Ctrl+H/Ctrl+K des
   * raccourcis navigateur (historique / barre de recherche).
   */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // F6 / Shift+F6 : cycle de focus entre les grandes zones de la page
      // active (voir PAGE_ZONES et cycleFocusZone).
      if (handleFocusCycleKey(e, page)) return;

      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();

      // Ctrl+Maj+P : palette de bascule de projet, gérée par son propre
      // écouteur (CommandPalette.tsx) — surtout ne pas AUSSI aller à Projets.
      if (key === "p" && e.shiftKey) return;

      if (key === "p") {
        e.preventDefault();
        setPage("projects");
        return;
      }
      if (key === "h") {
        e.preventDefault();
        setPage("chat");
        return;
      }
      if (key === "n") {
        e.preventDefault();
        if (page === "projects") agentPageRef.current?.newSession();
        else if (page === "chat") chatPageRef.current?.newSession();
        return;
      }
      if (key === "t") {
        e.preventDefault();
        handleOpenTerminal();
        return;
      }

      // Ctrl+L : ramener le curseur dans la zone de saisie (sans effet hors
      // des pages de conversation, qui seules en possèdent une).
      if (key === "l") {
        e.preventDefault();
        if (page === "projects") agentPageRef.current?.focusComposer();
        else if (page === "chat") chatPageRef.current?.focusComposer();
        return;
      }

      // Ctrl+1..6 : navigation directe entre les pages, sans souris. On lit
      // `e.code` (Numpad1 / Digit1) plutôt que `e.key` : sur le pavé
      // numérique, `key` vaut "End"/"ArrowDown"… quand le verrouillage
      // numérique est éteint, alors que `code` reste stable.
      const navMatch = /^(?:Numpad|Digit)([1-9])$/.exec(e.code);
      if (navMatch) {
        const index = Number(navMatch[1]) - 1;
        const target = NAV_ITEMS[index];
        if (target) {
          e.preventDefault();
          setPage(target.id);
        }
        return;
      }
      if (key === "k") {
        e.preventDefault();
        // Vidage immédiat, sans confirmation : la page affiche un bandeau
        // « Annuler » qui restaure la conversation (voir clearConversation).
        if (page === "projects") agentPageRef.current?.clearConversation();
        else if (page === "chat") chatPageRef.current?.clearConversation();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [page]);

  /*
   * Alt+flèches (zone voisine) : écouteur DÉDIÉ, en phase de CAPTURE. Le
   * raccourci vaut jusque dans les champs de saisie et l'éditeur de code, or
   * ceux-ci ont leurs propres liaisons Alt+flèche — le keymap par défaut de
   * CodeMirror y met le déplacement de ligne (Alt+↑/↓) et le saut de nœud
   * syntaxique (Alt+←/→), et le webview peut lire Alt+←/→ comme
   * précédent/suivant dans l'historique. En bouillonnement, l'écouteur global
   * passerait APRÈS eux, trop tard. En capture il passe AVANT : quand le
   * déplacement a lieu, `preventDefault` + `stopPropagation` (voir
   * handleZoneArrowKey) empêchent l'événement de jamais leur parvenir. Sans
   * déplacement (aucune zone de ce côté, modale ouverte), rien n'est consommé
   * et la touche suit son cours normal.
   */
  useEffect(() => {
    function onKeyDownCapture(e: KeyboardEvent) {
      handleZoneArrowKey(e, page);
    }
    window.addEventListener("keydown", onKeyDownCapture, true);
    return () => window.removeEventListener("keydown", onKeyDownCapture, true);
  }, [page]);

  // Arrivée sur une page de conversation : le curseur va directement dans le
  // composeur (on tape sans cliquer). Les pages restent montées en permanence
  // (slots masqués), d'où ce déclenchement au changement de `page` plutôt
  // qu'un `autoFocus` qui ne jouerait qu'au tout premier montage.
  useEffect(() => {
    if (page === "projects") agentPageRef.current?.focusComposer();
    else if (page === "chat") chatPageRef.current?.focusComposer();
  }, [page]);

  return (
    <div className="app-shell">
      <Header page={page} onSelectPage={setPage} onOpenTerminal={handleOpenTerminal} orchestrationAlert={tacheAlert} />
      <SidecarMortBanner />
      <main className="app-content">
        {/*
          Une page reste montée une fois visitée (masquée via CSS) pour ne pas
          perdre la conversation en cours ou les logs quand on change d'onglet.
          Ce qui est différé, c'est seulement sa PREMIÈRE mise en mémoire —
          voir pagesParesseuses.tsx.
        */}
        <SlotPage active={page === "projects"}>
          <AgentPage
            ref={agentPageRef}
            projects={projectAdmin.projects}
            projectsLoadState={projectAdmin.loadState}
            providers={providerAdmin.providers}
            onGoToConfig={() => setPage("config")}
            micDeviceId={speechAdmin.config.stt.inputDeviceId}
            conversationConfig={speechAdmin.config.conversation}
            pageVisible={page === "projects"}
          />
        </SlotPage>
        <SlotPage active={page === "chat"}>
          <ChatPage
            ref={chatPageRef}
            providers={providerAdmin.providers}
            micDeviceId={speechAdmin.config.stt.inputDeviceId}
            conversationConfig={speechAdmin.config.conversation}
            pageVisible={page === "chat"}
          />
        </SlotPage>
        <SlotPage active={page === "orchestration"}>
          <OrchestrationPage projects={projectAdmin.projects} providers={providerAdmin.providers} />
        </SlotPage>
        <SlotPage active={page === "supervision"}>
          <SupervisionPage />
        </SlotPage>
        <SlotPage active={page === "config"}>
          <ProvidersPage
            providers={providerAdmin.providers}
            keyStatus={providerAdmin.keyStatus}
            loadState={providerAdmin.loadState}
            errorMessage={providerAdmin.errorMessage}
            onSaveProvider={providerAdmin.saveProvider}
            onDeleteProvider={providerAdmin.deleteProvider}
            onSaveKey={providerAdmin.saveKey}
            onClearKey={providerAdmin.clearKey}
            projects={projectAdmin.projects}
            projectsLoadState={projectAdmin.loadState}
            projectsErrorMessage={projectAdmin.errorMessage}
            onAddProject={projectAdmin.addProject}
            onUpdateProject={projectAdmin.updateProject}
            onDeleteProject={projectAdmin.deleteProject}
            speechConfig={speechAdmin.config}
            speechKeyStatus={speechAdmin.keyStatus}
            speechKeyOrigin={speechAdmin.keyOrigin}
            speechErrorMessage={speechAdmin.errorMessage}
            onSaveSpeechConfig={speechAdmin.saveConfig}
            onSaveSpeechKey={speechAdmin.saveKey}
            onClearSpeechKey={speechAdmin.clearKey}
          />
        </SlotPage>
        <SlotPage active={page === "system"}>
          <SystemPage />
        </SlotPage>
      </main>
      <CommandPalette projects={projectAdmin.projects} onSelectProject={handlePaletteSelectProject} />
    </div>
  );
}

export default App;
