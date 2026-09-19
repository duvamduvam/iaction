/*
 * usage.claude — module autonome (étape 9 de docs/etude-structure.md).
 *
 * Sorti de la fermeture createClaudeEngine. Le SEUL état partagé avec
 * handleClaudeStart est l'instantané `lastUsageSnapshot` (le start le
 * capture en fin de tour, usage.claude le sert, usage.claude.init le
 * rafraîchit) : il reste la propriété de la fermeture, exposé ici par un
 * dépôt lire/ecrire injecté — c'était le point identifié comme risque n°1
 * du découpage (deux instances = deux relevés silencieusement divergents).
 *
 * RÈGLE du module, posée par T-087 : ce qui sort d'ici est un relevé ou
 * `null`, jamais un entre-deux. Un instantané « disponible » mais sans une
 * seule fenêtre chiffrée n'est pas une mesure — et comme il est accepté
 * partout où l'est un vrai relevé, il efface le dernier connu au lieu de
 * l'attendre. Voir `releveExploitable`.
 */

import os from "node:os";
import { isPlainObject } from "./base.js";
import { recordClaudeWindowsSnapshot } from "./fenetresAbonnement.js";
import type { EngineEmitter } from "./engine.js";
import type { ClaudeQuery, ClaudeQueryFn } from "./claude.js";
import { parseRefusSaturation, type RefusSaturation } from "./claudeSaturation.js";
import { decorerErreurClaude } from "./diagnosticErreurClaude.js";
import { log } from "./journal.js";
import {
  apresSaturationInit,
  apresSondeInit,
  doitSonderInit,
  etatInitialInit,
  type EtatCadenceInit,
} from "./cadenceSondesConso.js";

/** Accès à l'instantané partagé avec handleClaudeStart — voir l'en-tête. */
export interface DepotUsageClaude {
  lire(): ClaudeUsageSnapshot | null;
  ecrire(snapshot: ClaudeUsageSnapshot): void;
}

// ---------------------------------------------------------------------------
// usage.claude — instantané des limites d'abonnement (mini-tranche du Lot 8)
// ---------------------------------------------------------------------------

export interface ClaudeUsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface ClaudeUsageSnapshot {
  available: boolean;
  subscriptionType: string | null;
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  /**
   * Fenêtres CHIFFRÉES de `rate_limits` (clé brute → fenêtre), y compris
   * celles spécifiques à un modèle : soit par leur clé (`seven_day_opus`…),
   * soit par leur nom d'affichage quand elles arrivent dans `model_scoped`
   * (`Fable`). Le nommage peut évoluer — l'API est expérimentale, on relaie
   * sans présumer. `fiveHour`/`sevenDay` restent extraits à part pour
   * compatibilité. Jamais vide : voir `releveExploitable`.
   */
  windows: Record<string, ClaudeUsageWindow>;
  capturedAt: string;
}

const USAGE_CAPTURE_TIMEOUT_MS = 3000;

/**
 * Clés de `rate_limits` qui portent une `utilization` numérique SANS être une
 * fenêtre de quota. `extra_usage` mesure la part dépensée du crédit de
 * dépassement (des euros) : relayée dans `windows`, elle pouvait être choisie
 * par l'encart comme « fenêtre hebdo du modèle » et afficher un pourcentage
 * qui ne mesure pas ce que l'étiquette annonce.
 */
const CLES_HORS_FENETRES = new Set(["extra_usage", "spend"]);

function extractUsageWindow(value: unknown): ClaudeUsageWindow | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return {
    utilization: typeof value.utilization === "number" ? value.utilization : null,
    resetsAt: typeof value.resets_at === "string" ? value.resets_at : null,
  };
}

/**
 * Fenêtres exploitables d'un `rate_limits` brut : clé de l'API → fenêtre, et
 * SEULEMENT celles qui portent une utilisation numérique — une fenêtre sans
 * chiffre n'est pas un relevé, c'est une case vide de la réponse.
 *
 * Deux sources, la seconde ajoutée le 2026-08-21 (T-087) : les clés directes
 * (`five_hour`, `seven_day`, `seven_day_opus`…) et le tableau `model_scoped`,
 * où l'API range désormais les fenêtres hebdo par modèle avec leur nom
 * d'affichage. Sans ce second passage, la fenêtre hebdo de Fable relevée à
 * 49 % n'existait nulle part dans l'application.
 */
function extraireFenetres(rateLimits: Record<string, unknown> | null): Record<string, ClaudeUsageWindow> {
  const windows: Record<string, ClaudeUsageWindow> = {};
  if (!rateLimits) {
    return windows;
  }
  for (const [key, value] of Object.entries(rateLimits)) {
    if (CLES_HORS_FENETRES.has(key)) {
      continue;
    }
    const window = extractUsageWindow(value);
    if (window && window.utilization !== null) {
      windows[key] = window;
    }
  }
  if (Array.isArray(rateLimits.model_scoped)) {
    for (const entree of rateLimits.model_scoped) {
      if (!isPlainObject(entree) || typeof entree.display_name !== "string") {
        continue;
      }
      const window = extractUsageWindow(entree);
      if (window && window.utilization !== null) {
        windows[entree.display_name] = window;
      }
    }
  }
  return windows;
}

/**
 * Un instantané SANS la moindre fenêtre chiffrée n'est PAS un relevé.
 *
 * Constaté le 2026-08-21 (T-087) : au démarrage, la méthode d'usage répond
 * `rate_limits_available: true`, `subscription_type: "max"` et
 * `rate_limits` vide — l'abonnement s'applique, le point d'usage n'a pas
 * encore répondu. Pris pour un relevé, cet instantané écrasait le dernier
 * relevé réel partout à la fois : le dépôt du sidecar, le cache disque de
 * l'encart (qui repassait à « Claude : — »), l'historique
 * `claude-windows.jsonl` (8 lignes `{"windows":{}}`) et, par lui, l'entrée
 * du routeur pour la décision de débord.
 */
export function releveExploitable(snapshot: ClaudeUsageSnapshot | null): boolean {
  return snapshot !== null && snapshot.available && Object.keys(snapshot.windows).length > 0;
}

/**
 * Capture défensive de l'instantané d'usage via la méthode expérimentale du
 * SDK. Ne lève jamais : indisponibilité, forme inattendue, lenteur (>3s) ou
 * réponse sans une seule fenêtre chiffrée (T-087) renvoient simplement `null`
 * sans perturber la fin du tour claude.start.
 */
export async function captureUsageSnapshot(query: ClaudeQuery): Promise<ClaudeUsageSnapshot | null> {
  try {
    if (typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") {
      return null;
    }
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), USAGE_CAPTURE_TIMEOUT_MS);
    });
    const result = await Promise.race([
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      timeout,
    ]);
    if (!isPlainObject(result)) {
      return null;
    }
    const rateLimits = isPlainObject(result.rate_limits) ? result.rate_limits : null;
    const windows = extraireFenetres(rateLimits);
    const snapshot: ClaudeUsageSnapshot = {
      available: result.rate_limits_available === true,
      subscriptionType: typeof result.subscription_type === "string" ? result.subscription_type : null,
      // Extraits de `windows` et non du brut : les deux fenêtres nommées ne
      // peuvent pas dire autre chose que leur homonyme de la table générique.
      fiveHour: windows.five_hour ?? null,
      sevenDay: windows.seven_day ?? null,
      windows,
      capturedAt: new Date().toISOString(),
    };
    // Rien de chiffré : on ne rend PAS de relevé — l'appelant garde le sien.
    return releveExploitable(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

export function executerClaudeUsage(
  depot: DepotUsageClaude,
  id: string,
  _params: Record<string, unknown>,
  emitter: EngineEmitter,
): void {
  const lastUsageSnapshot = depot.lire();
  if (!lastUsageSnapshot) {
    emitter.done(id, { available: false });
    return;
  }
  emitter.done(id, { ...lastUsageSnapshot });
}

/**
 * usage.claude.init — initialise le relevé d'abonnement sans conversation :
 * micro-tour chat pur (haiku, prompt « ping », aucun outil) dont on ne garde
 * que l'instantané de limites capturé PENDANT le tour (voir le commentaire
 * de tryCaptureUsage dans handleClaudeStart : après le message result, la
 * requête de contrôle du SDK part dans le vide). Coût négligeable — mais
 * PAS nul : c'est un vrai tour Claude, voir la cadence ci-dessous.
 *
 * ── T-086 — cadence de PROCESSUS, pas de fenêtre ─────────────────────────
 * Avant ce module, chaque fenêtre relançait ce micro-tour sur son propre
 * cron : deux fenêtres = deux sondes par cycle, dont une strictement inutile.
 * `etatCadenceInit` / `sondeInitEnVol` sont de la mémoire de PROCESSUS (un
 * seul sidecar, quel que soit le nombre de fenêtres qui appellent) : elles
 * remplacent le bail `localStorage` d'`ui/src/cadenceUsage.ts`, qui reposait
 * sur une hypothèse jamais vérifiée (le partage de `localStorage` entre
 * webviews). Deux fenêtres qui appellent en même temps se voient répondre
 * par la MÊME sonde (`sondeInitEnVol`, coalescing) ; une fenêtre qui appelle
 * trop tôt après la précédente reçoit le dernier résultat connu
 * (`dernierResultatInit`), sans repartir en réseau ni consommer un tour
 * Claude. Voir `cadenceSondesConso.ts` pour les décisions temporelles PURES.
 */
type ResultatInit =
  | { type: "snapshot"; snapshot: ClaudeUsageSnapshot }
  | { type: "indisponible" }
  | { type: "saturation"; saturation: RefusSaturation }
  | { type: "erreur"; message: string };

let etatCadenceInit: EtatCadenceInit = etatInitialInit();
let dernierResultatInit: ResultatInit | null = null;
let sondeInitEnVol: Promise<ResultatInit> | null = null;

/** Test only : oublie la cadence/coalescing du micro-tour d'initialisation. */
export function reinitialiserCadenceUsageInit(): void {
  etatCadenceInit = etatInitialInit();
  dernierResultatInit = null;
  sondeInitEnVol = null;
}

/**
 * T-059 — un refus de la sonde pour cause de saturation n'est PAS un échec du
 * micro-tour : c'est le relevé le plus frais qui existe (« You've hit your
 * session limit · resets 7:10pm »), jeté jusqu'ici comme une exception
 * générique pendant que la sonde revenait quand même toutes les 5 minutes.
 * Rendu en résultat structuré (même doctrine que `usage.credits`, T-057) —
 * l'appelant (encartConso.tsx) force la jauge saturée et arme le silence
 * (`ui/src/cadenceUsage.ts`, lu par le réveil T-120). Un message qui n'est
 * PAS un refus de saturation garde le traitement d'erreur générique existant.
 */
function classerEchecMicroTour(err: unknown, maintenant: number): ResultatInit {
  const message = err instanceof Error ? err.message : String(err);
  const saturation = parseRefusSaturation(message);
  if (saturation) {
    if (saturation.resetsAt === null) {
      /*
       * T-130 — le refus est reconnu mais INDATABLE. Ce repli est correct
       * (on sait quelle fenêtre est pleine, on ne sait pas quand elle se
       * vide), mais il était MUET : c'est par ce trou qu'un format non
       * couvert a vécu depuis T-059, jusqu'à ce qu'un utilisateur constate
       * « reprise à heure inconnue » devant un message qui portait l'heure.
       * Le message brut est journalisé pour que le prochain format inconnu
       * se DÉSIGNE au lieu de se deviner. Niveau `warn` : ce n'est pas une
       * panne, la sonde se replie proprement, mais c'est une dégradation
       * silencieuse de trois mécanismes (badge, réveil, silence de sonde).
       */
      log("warn", "usage", "refus de saturation reconnu mais indatable", {
        fields: { fenetre: saturation.fenetre, message },
      });
    }
    etatCadenceInit = apresSaturationInit(saturation.resetsAt, maintenant);
    return { type: "saturation", saturation };
  }
  etatCadenceInit = apresSondeInit(maintenant);
  /*
   * T-118 — le message du CLI passait BRUT jusqu'ici. C'est ce chemin même qui
   * criait « API Error: Unable to connect to API (ConnectionRefused) » en
   * rafale sur le poste Windows, sans rien qui distingue « API injoignable »
   * de « CLI non connecté ». Le classement le situe désormais.
   */
  return {
    type: "erreur",
    message: `échec du micro-tour d'initialisation : ${decorerErreurClaude(message)}`,
  };
}

/**
 * Joue le VRAI micro-tour et met à jour la cadence de processus. Jamais
 * appelée directement : seule `executerClaudeUsageInit` décide s'il est
 * l'heure (`doitSonderInit`) et coalesce les appels concurrents.
 */
async function lancerMicroTour(
  deps: { queryFn: ClaudeQueryFn; depot: DepotUsageClaude },
  maintenant: number,
): Promise<ResultatInit> {
  const { queryFn, depot } = deps;
  let query: ClaudeQuery;
  try {
    query = queryFn({
      prompt: "ping",
      options: {
        cwd: os.homedir(),
        model: "claude-haiku-4-5",
        tools: [],
        permissionMode: "default",
      },
    });
  } catch (err) {
    return classerEchecMicroTour(err, maintenant);
  }

  try {
    let captured: ClaudeUsageSnapshot | null = null;
    for await (const message of query) {
      if (!captured && isPlainObject(message) && message.type === "assistant") {
        captured = await captureUsageSnapshot(query);
      }
    }
    // Filet pour les SDK/faux SDK qui ne passent pas par le transport
    // processus (la capture post-tour y fonctionne).
    captured ??= await captureUsageSnapshot(query);
    etatCadenceInit = apresSondeInit(maintenant);
    if (captured) {
      depot.ecrire(captured);
      recordClaudeWindowsSnapshot(captured.windows);
      return { type: "snapshot", snapshot: captured };
    }
    const connu = depot.lire();
    return connu ? { type: "snapshot", snapshot: connu } : { type: "indisponible" };
  } catch (err) {
    return classerEchecMicroTour(err, maintenant);
  }
}

function repondreResultatInit(id: string, emitter: EngineEmitter, resultat: ResultatInit | null): void {
  if (!resultat) {
    emitter.done(id, { available: false });
    return;
  }
  switch (resultat.type) {
    case "snapshot":
      emitter.done(id, { ...resultat.snapshot });
      return;
    case "indisponible":
      emitter.done(id, { available: false });
      return;
    case "saturation":
      emitter.done(id, { available: false, saturation: resultat.saturation });
      return;
    case "erreur":
      emitter.error(id, resultat.message);
      return;
  }
}

export async function executerClaudeUsageInit(
  deps: { queryFn: ClaudeQueryFn; depot: DepotUsageClaude },
  id: string,
  _params: Record<string, unknown>,
  emitter: EngineEmitter,
  maintenant: () => number = Date.now,
): Promise<void> {
  const now = maintenant();
  if (sondeInitEnVol) {
    // T-086 — une sonde est DÉJÀ en vol (deux fenêtres ont appelé avant que
    // la première n'ait eu sa réponse) : on attend CETTE MÊME sonde plutôt
    // que d'en lancer une seconde. Un seul micro-tour, deux réponses.
    const resultat = await sondeInitEnVol;
    repondreResultatInit(id, emitter, resultat);
    return;
  }
  if (!doitSonderInit(etatCadenceInit, now)) {
    // Trop tôt depuis la dernière sonde, ou silence de saturation actif
    // (T-059) : le dernier résultat connu répond, sans réseau ni tour Claude.
    repondreResultatInit(id, emitter, dernierResultatInit);
    return;
  }
  sondeInitEnVol = lancerMicroTour(deps, now);
  try {
    const resultat = await sondeInitEnVol;
    dernierResultatInit = resultat;
    repondreResultatInit(id, emitter, resultat);
  } finally {
    sondeInitEnVol = null;
  }
}
