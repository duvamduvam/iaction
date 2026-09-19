/*
 * Encart conso de l'en-tête : abonnement Claude (fenêtres 5 h / 7 j) et
 * crédits OpenRouter, plus le battement qui les rafraîchit.
 *
 * Sorti d'`App.tsx` en T-086, où il pesait 470 des 1 025 lignes du fichier —
 * la moitié d'un fichier « application » consacrée à une seule vignette de
 * l'en-tête. L'extraction est ce qui a payé le cliquet de taille du lot, et
 * elle range au même endroit les deux choses qui ne se comprennent
 * qu'ensemble : ce qui est affiché, et à quel rythme c'est relevé.
 *
 * ── T-086, deuxième round : la cadence a quitté cette fenêtre ────────────
 * Jusqu'ici, CE fichier décidait QUI, parmi les fenêtres ouvertes, avait le
 * droit de jouer le micro-tour Claude (`usage.claude.init`) et d'appeler
 * `usage.credits` — un bail dans `localStorage` (`cadenceUsage.ts`), reposant
 * sur une hypothèse jamais vérifiée dans l'application lancée (le partage de
 * `localStorage` entre webviews Tauri). Depuis, c'est le SIDECAR qui tient
 * cette cadence (`sidecar/src/cadenceSondesConso.ts`) : un seul processus
 * reçoit toutes les requêtes, quel que soit le nombre de fenêtres qui les
 * envoient, donc la question du partage de stockage cesse d'exister.
 *
 * Conséquence directe sur ce composant : PLUS de leadership à élire, plus de
 * cache disque à relire pour les non-releveuses (T-086, disparu), plus de
 * recul de reprise local (T-085, remonté côté sidecar pour `usage.credits`).
 * Chaque fenêtre appelle simplement `usage.claude`, `usage.claude.init` et
 * `usage.credits` à SON propre battement — c'est le sidecar qui décide si un
 * appel coûteux a réellement lieu, ou s'il rend le dernier résultat connu.
 *
 * Ce qui reste ici, dans `cadenceUsage.ts` : le silence de saturation (T-059)
 * — pas pour s'en servir comme garde (le sidecar la tient désormais), mais
 * pour continuer à l'ANNONCER dans `localStorage`, où `reouvertureQuota.ts`
 * (réveil « au reset », T-120) va le lire. Voir l'en-tête de ce module.
 *
 * Même traitement pour les règles de LECTURE, parties dans `releveConso.ts`
 * après T-087 : ce qui compte comme un relevé, et sous quel nom une fenêtre
 * s'affiche.
 */
import { useEffect, useState } from "react";
import { subscribeReady, subscribeStatus } from "./sidecar";
import {
  releveIndisponible,
  usageClaude,
  usageClaudeInit,
  usageCredits,
  type ClaudeUsageSnapshot,
  type OpenrouterUsage,
  type RefusSaturationClaude,
} from "./consoClient";
import { stateRead, stateWrite } from "./stateClient";
import { providersDejaPousses, subscribeProvidersPushed } from "./providersBus";
import { subscribeUsageChanged } from "./usageBus";
import { Donut } from "./Donut";
import { armerSilence, libererSilence } from "./cadenceUsage";
import { memoriserReouverture } from "./reouvertureQuota";
import {
  cleFenetreSaturee,
  etiquetteFenetreModele,
  fenetreEncoreSaturee,
  libelleAge,
  libelleSaturation,
  releveUtilisable,
  trouverFenetreModele,
} from "./releveConso";

/**
 * Battement de l'encart : cheap (`usage.claude`) comme coûteux
 * (`usage.claude.init`, `usage.credits`) sont demandés à ce rythme par
 * CHAQUE fenêtre — c'est le sidecar qui gate le coût réel (T-086), pas cette
 * fenêtre. Même valeur que l'ancien battement du bail, dont T-117 réutilise
 * aussi le passage pour laisser retomber le badge « saturée » de lui-même.
 */
const USAGE_TICK_MS = 30_000;

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
  if (!Number.isFinite(ms)) return "0";
  // T-117 — un délai écoulé n'est pas « 0 min restantes » : c'est une
  // échéance déjà passée. Le badge « saturée » s'efface de son côté
  // (pickSaturatedWindow), mais cette formulation reste le filet — jamais un
  // rebours à zéro ou négatif, qui donnait l'impression d'un blocage figé.
  if (ms <= 0) return "réinitialisée";
  if (mode === "hours") {
    if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}min`;
    return `${Math.ceil(ms / 3_600_000)}h`;
  }
  if (ms < 86_400_000) return `${Math.ceil(ms / 3_600_000)}h`;
  return `${Math.ceil(ms / 86_400_000)}j`;
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

/*
 * Première fenêtre ENCORE saturée, session (5h) d'abord — `null` si tout va
 * bien. `maintenant` est un paramètre explicite (pas un `Date.now()` interne)
 * : c'est lui qui permet à `fenetreEncoreSaturee` de laisser retomber le
 * badge tout seul dès que l'échéance est dépassée (T-117), pour peu que le
 * composant soit re-rendu — voir le battement de `UsageWidget`.
 */
function pickSaturatedWindow(
  snapshot: ClaudeUsageSnapshot,
  maintenant: number,
): { label: string; resetsAt: string; mode: "hours" | "days" } | null {
  if (snapshot.fiveHour && fenetreEncoreSaturee(snapshot.fiveHour, maintenant, USAGE_SATURATED_PCT)) {
    return { label: "Session 5h", resetsAt: snapshot.fiveHour.resetsAt, mode: "hours" };
  }
  if (snapshot.sevenDay && fenetreEncoreSaturee(snapshot.sevenDay, maintenant, USAGE_SATURATED_PCT)) {
    return { label: "Fenêtre 7 jours", resetsAt: snapshot.sevenDay.resetsAt, mode: "days" };
  }
  return null;
}

/**
 * T-059 — pour la fenêtre que désigne un refus de saturation, quoi afficher :
 * TOUJOURS 100 % (le refus prime sur tout relevé chiffré, forcément plus
 * ancien) et le libellé de reprise, jamais le pourcentage/texte normaux.
 */
function DonutSature({
  label,
  saturation,
}: Readonly<{ label: string; saturation: RefusSaturationClaude }>) {
  return (
    <Donut
      label={label}
      pct={100}
      text={libelleSaturation(saturation.resetsAt)}
      title={
        saturation.resetsAt
          ? `Refus de la sonde — réinitialisation : ${formatResetTime(saturation.resetsAt)}`
          : "Refus de la sonde — heure de réinitialisation inconnue"
      }
    />
  );
}

function ClaudeUsageBlock({
  snapshot,
  saturation,
  initializing,
  onInit,
}: Readonly<{
  snapshot: ClaudeUsageSnapshot | null;
  saturation: RefusSaturationClaude | null;
  initializing: boolean;
  onInit: () => void;
}>) {
  /*
   * T-117 — même défaut que le relevé chiffré, côté refus : posé à la
   * réception de « You've hit your session limit », `saturation` n'était
   * jamais reconditionné par l'expiration de son échéance. Un refus est
   * une saturation à 100 % par construction ; on lui applique donc la même
   * règle de péremption qu'à une fenêtre chiffrée, avec un seuil de 100 —
   * `resetsAt` absent reste traité comme un aveu (toujours actif), jamais
   * comme une preuve de réouverture.
   */
  const saturationActive: RefusSaturationClaude | null =
    saturation && fenetreEncoreSaturee({ utilization: 100, resetsAt: saturation.resetsAt ?? "" }, Date.now(), 100)
      ? saturation
      : null;
  // T-059 — un refus de saturation est l'information la plus fraîche qui
  // existe : il prime même en l'absence de tout relevé chiffré préalable
  // (compte jamais mesuré depuis ce démarrage, mais déjà saturé).
  if (saturationActive && !releveUtilisable(snapshot)) {
    return (
      <div className="usage-widget__claude">
        <DonutSature
          label={saturationActive.fenetre === "session" ? "Session" : "Semaine"}
          saturation={saturationActive}
        />
      </div>
    );
  }
  if (!releveUtilisable(snapshot) || snapshot === null) {
    return <ClaudeInitButton initializing={initializing} onInit={onInit} />;
  }
  const modelWindow = trouverFenetreModele(snapshot.windows);
  // Seuil d'alerte : la session (5h) prime sur l'hebdo si les deux saturent —
  // c'est elle qui débloque le plus vite. `Date.now()` est lu ICI, au rendu :
  // le battement de `UsageWidget` (T-117) provoque un re-rendu périodique
  // pour que ce calcul se rejoue même sans nouveau relevé.
  const saturated = pickSaturatedWindow(snapshot, Date.now());
  // T-059 — la fenêtre visée par le refus REMPLACE son affichage normal,
  // même si le dernier relevé chiffré la disait encore sous le seuil : le
  // refus est plus frais, par construction (il vient d'être reçu). T-117 —
  // sauf si ce refus est lui-même périmé (`saturationActive`).
  const fenetreForcee = saturationActive ? cleFenetreSaturee(saturationActive.fenetre) : null;
  // T-059 — l'âge du relevé (au-delà de 5 min) doit rester lisible, mais il
  // encombrait la ligne de chaque jauge : « 27% (il y a 8min) · 3j ». Il vit
  // désormais dans l'infobulle du bloc, à côté de l'heure du dernier relevé.
  const age = libelleAge(snapshot.capturedAt, Date.now());
  const titreReleve = snapshot.capturedAt
    ? `Dernier relevé : ${formatResetTime(snapshot.capturedAt)}${age ? ` (${age})` : ""}`
    : undefined;
  return (
    <div
      className="usage-widget__claude"
      title={titreReleve}
    >
      {fenetreForcee === "fiveHour" && saturationActive ? (
        <DonutSature label="Session" saturation={saturationActive} />
      ) : (
        snapshot.fiveHour && (
          <Donut
            label="Session"
            pct={snapshot.fiveHour.utilization}
            text={`${Math.round(snapshot.fiveHour.utilization)}% · ${remainingUntil(snapshot.fiveHour.resetsAt, "hours")}`}
            title={`Fenêtre 5h — réinitialisation : ${formatResetTime(snapshot.fiveHour.resetsAt)}`}
          />
        )
      )}
      {fenetreForcee === "sevenDay" && saturationActive ? (
        <DonutSature label="Semaine" saturation={saturationActive} />
      ) : (
        snapshot.sevenDay && (
          <Donut
            label="Semaine"
            pct={snapshot.sevenDay.utilization}
            text={`${Math.round(snapshot.sevenDay.utilization)}% · ${remainingUntil(snapshot.sevenDay.resetsAt, "days")}`}
            title={`Fenêtre 7 jours — réinitialisation : ${formatResetTime(snapshot.sevenDay.resetsAt)}`}
          />
        )
      )}
      {modelWindow && (
        <Donut
          label={etiquetteFenetreModele(modelWindow.cle)}
          pct={modelWindow.fenetre.utilization}
          title={`Fenêtre hebdo « ${modelWindow.cle} » — réinitialisation : ${formatResetTime(modelWindow.fenetre.resetsAt)}`}
        />
      )}
      {/* Fenêtre saturée (seuil de 98 % sur un relevé chiffré) : la jauge
          seule passait inaperçue — on le dit en toutes lettres. Un refus
          FRAIS (ci-dessus) dit déjà la même chose, en mieux : pas besoin des
          deux à la fois. */}
      {!fenetreForcee && saturated && (
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

export function UsageWidget() {
  const [claudeSnapshot, setClaudeSnapshot] = useState<ClaudeUsageSnapshot | null>(null);
  // T-059 — dernier refus de saturation connu : distinct du relevé chiffré,
  // il force l'affichage de la fenêtre visée tant qu'il n'a pas été remplacé
  // par un relevé chiffré plus frais (voir `traiterReponseInit`).
  const [claudeSaturation, setClaudeSaturation] = useState<RefusSaturationClaude | null>(null);
  const [openrouterUsage, setOpenrouterUsage] = useState<OpenrouterUsage | null>(null);
  const [openrouterRef, setOpenrouterRef] = useState<OpenrouterRef | null>(null);
  const [openrouterError, setOpenrouterError] = useState(false);
  const [claudeInitializing, setClaudeInitializing] = useState(false);
  // T-117 — un compte à rebours qui atteint zéro n'est pas un état stable :
  // sans nouveau relevé, RIEN ne force React à re-rendre pour laisser
  // `pickSaturatedWindow`/`fenetreEncoreSaturee` rejouer leur calcul contre
  // l'heure actuelle. Ce compteur ne sert qu'à ça (sa valeur est ignorée) —
  // il est incrémenté par le battement (`USAGE_TICK_MS`) qui existe déjà plus
  // bas pour interroger le sidecar, plutôt que d'en ouvrir un second.
  const [, forcerRerendu] = useState(0);

  /**
   * T-059 — ce que fait l'encart d'une réponse `usage.claude.init`, qu'elle
   * vienne du bouton ↻ ou de la sonde automatique : un refus de saturation
   * ARME le silence partagé (toutes fenêtres) et force l'affichage tout de
   * suite ; un relevé chiffré normal EFFACE un refus qui serait resté affiché
   * (l'abonnement a repris avant même l'échéance du silence).
   */
  function traiterReponseInit(snap: ClaudeUsageSnapshot): void {
    if (snap.saturation) {
      setClaudeSaturation(snap.saturation);
      armerSilence(snap.saturation.resetsAt, Date.now());
      return;
    }
    if (!releveUtilisable(snap)) return;
    setClaudeSnapshot(snap);
    setClaudeSaturation(null);
    libererSilence();
    // Persistance : fusion avec le cache existant (l'OpenRouter éventuel y reste).
    stateRead<Partial<UsageCache>>("usage-cache")
      .catch(() => ({}) as Partial<UsageCache>)
      .then((cache) => stateWrite("usage-cache", { ...cache, claude: snap }))
      .catch(() => {
        /* best effort */
      });
  }

  /*
   * T-120 — mémorise pour le réveil la date de réouverture de la fenêtre 5 h.
   *
   * Un EFFET, et pas un appel à côté de chaque `setClaudeSnapshot` : il y en a
   * cinq (sonde, cache au démarrage, mises à jour…), le premier correctif n'en
   * a couvert qu'un seul, et le réveil est resté inarmable — constat du
   * 2026-09-04, deuxième passe. Ici, la source est l'ÉTAT rendu : quelle que
   * soit la porte par laquelle le relevé est entré, sa date est vue. Un
   * sixième point d'entrée serait couvert sans rien y penser.
   *
   * Le refus prime quand il existe : il est plus frais que tout relevé
   * chiffré (T-059). `memoriserReouverture` ignore d'elle-même une valeur
   * absente, donc aucune garde ici.
   */
  useEffect(() => {
    memoriserReouverture(claudeSaturation?.resetsAt ?? claudeSnapshot?.fiveHour?.resetsAt);
  }, [claudeSaturation?.resetsAt, claudeSnapshot?.fiveHour?.resetsAt]);

  function handleClaudeInit() {
    if (claudeInitializing) return;
    setClaudeInitializing(true);
    usageClaudeInit()
      .then(traiterReponseInit)
      .catch(() => {
        /* micro-tour en échec (hors ligne, non connecté…) : l'encart reste à « — » */
      })
      .finally(() => setClaudeInitializing(false));
  }

  useEffect(() => {
    let cancelled = false;
    // Relais vers le cache disque : on ne réécrit que ce qui a été rafraîchi
    // avec succès (l'autre moitié garde sa dernière valeur connue). Utile au
    // démarrage suivant de l'application, plus pour dédoublonner entre
    // fenêtres (T-086) — chacune écrit désormais ce qu'elle reçoit.
    const cacheRef: UsageCache = { claude: null, openrouter: null, openrouterRef: null };

    function persistCache() {
      stateWrite("usage-cache", cacheRef).catch(() => {
        /* best effort : l'encart reste fonctionnel sans persistance */
      });
    }

    function refresh() {
      // `usage.claude` relit l'instantané que le sidecar tient déjà : aucun
      // réseau, aucun quota. Toutes les fenêtres le demandent sans se gêner.
      usageClaude()
        .then((snap) => {
          if (cancelled) return;
          // Un instantané qui n'est pas un relevé — indisponible (aucun tour
          // Claude joué depuis le démarrage du sidecar) ou « disponible » mais
          // sans une seule fenêtre (T-087) — ne doit pas écraser le dernier
          // relevé réel, frais ou restauré du cache disque.
          const utilisable = releveUtilisable(snap);
          setClaudeSnapshot((prev) => {
            if (!utilisable) return prev;
            cacheRef.claude = snap;
            persistCache();
            return snap;
          });
        })
        .catch(() => {
          /* le prochain battement retentera */
        });
      // T-008 — ne RIEN demander au sujet d'un fournisseur tant que la table
      // n'a pas atteint le sidecar : sinon il répond « fournisseur inconnu »,
      // ligne d'erreur à chaque démarrage pour une simple course. L'abonnement
      // ci-dessous relance dès que la poussée a lieu.
      if (!providersDejaPousses()) return;
      // T-057 — SONDE : l'échec d'une jauge périodique est une réponse (pas de
      // clé, hors ligne, certificat), pas une panne du protocole. Il descend en
      // `debug` et cesse d'écraser le journal, sans rien taire. T-086 — le
      // recul après échec (T-085) est désormais tenu par le sidecar, une
      // entrée par fournisseur : cette fenêtre demande à chaque battement,
      // c'est lui qui décide si un appel réseau a réellement lieu.
      usageCredits("openrouter", { sonde: true })
        .then((releve) => {
          if (cancelled) return;
          if (releveIndisponible(releve)) {
            // T-057 — état CHOISI (pas de clé) : l'encart le dit, sans retenter
            // plus vite qu'un autre battement — une clé absente ne réapparaît
            // pas toute seule ; la poussée de la table des fournisseurs
            // relancera le relevé.
            setOpenrouterUsage((prev) => {
              if (!prev) setOpenrouterError(true);
              return prev;
            });
            return;
          }
          const usage = releve;
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
          // Pas de clé/erreur réseau : on garde l'éventuel relevé restauré du
          // cache plutôt que de basculer sur « — » ; le prochain battement
          // retentera, au rythme que le sidecar autorise (T-085/T-086).
          setOpenrouterUsage((prev) => {
            if (!prev) setOpenrouterError(true);
            return prev;
          });
        });
    }

    /*
     * Récupération ACTIVE du relevé d'abonnement (micro-tour économique, voir
     * usage.claude.init) : au démarrage dès que le sidecar est prêt, puis à
     * chaque battement. T-086 — plus de garde de leadership ni de silence
     * local ici : le sidecar gate LUI-MÊME la cadence (une seule sonde par
     * cycle, quel que soit le nombre de fenêtres qui appellent) et le silence
     * de saturation (T-059). Cette fenêtre peut appeler à chaque battement
     * sans jamais déclencher plus d'un vrai micro-tour par cycle.
     */
    function autoInit() {
      if (cancelled) return;
      // T-057 — sonde : « limite de session atteinte » ou « non connecté » est
      // une réponse attendue d'une jauge périodique, pas une panne.
      usageClaudeInit({ sonde: true })
        .then((snap) => {
          if (cancelled) return;
          // T-059 — le refus PORTE la donnée : jauge forcée + silence armé
          // dans `localStorage` (lu par le réveil, `reouvertureQuota.ts`), au
          // lieu d'un échec générique jeté (voir claudeUsage.ts, sidecar).
          if (snap.saturation) {
            setClaudeSaturation(snap.saturation);
            armerSilence(snap.saturation.resetsAt, Date.now());
            return;
          }
          if (!releveUtilisable(snap)) return;
          setClaudeSnapshot(snap);
          setClaudeSaturation(null);
          libererSilence();
          cacheRef.claude = snap;
          persistCache();
        })
        .catch(() => {
          /* hors ligne / non connecté : le prochain battement retentera */
        });
    }

    // Restauration du dernier relevé connu, puis premier rafraîchissement.
    stateRead<Partial<UsageCache>>("usage-cache")
      .then((cache) => {
        if (cancelled || !cache) return;
        if (releveUtilisable(cache.claude ?? null) && cache.claude) {
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

    // Un seul battement pour tout : lecture cheap, sondes coûteuses (gatées
    // côté sidecar) et re-rendu périodique (T-117, badge « saturée » qui
    // retombe de lui-même quand son échéance passe pendant un silence armé).
    const tick = setInterval(() => {
      refresh();
      autoInit();
      forcerRerendu((n) => n + 1);
    }, USAGE_TICK_MS);
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
      clearInterval(tick);
      offUsageChanged();
      offProviders();
      offReady();
      offStatus();
    };
  }, []);

  return (
    <div className="usage-widget" title="Consommation">
      <ClaudeUsageBlock
        snapshot={claudeSnapshot}
        saturation={claudeSaturation}
        initializing={claudeInitializing}
        onInit={handleClaudeInit}
      />
      <OpenrouterUsageBlock usage={openrouterUsage} refPoint={openrouterRef} error={openrouterError} />
    </div>
  );
}

