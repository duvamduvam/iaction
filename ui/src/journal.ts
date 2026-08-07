/*
 * Point d'entrée UNIQUE de la journalisation côté UI — tranche L2 du journal
 * applicatif consolidé (voir docs/etude-logs.md § 2.3 et docs/protocol.md
 * § « Méthodes L1 — journal applicatif (logs) »).
 *
 * POURQUOI ce module : l'UI n'écrivait strictement rien nulle part
 * (etude-logs.md § 1.2). Chaque appelant affichait son erreur dans son coin
 * puis l'oubliait ; le seul filet global était `devErrorProbe.ts`, qui postait
 * sur un collecteur local que personne n'écoute. Résultat : aucune erreur
 * d'interface ne survivait au rechargement, et rien ne pouvait être agrégé.
 *
 * Deux destinations, l'une n'attend jamais l'autre :
 * - un tampon circulaire en mémoire (affichage immédiat, page Système), avec
 *   `subscribeJournal` sur le modèle EXACT des abonnements de `sidecar.ts`
 *   (`Set` + add/remove synchrones : sûrs même avec le double montage des
 *   effets en StrictMode) ;
 * - le sidecar, via `log.append`, en best-effort — c'est lui le seul écrivain
 *   du fichier `app.jsonl`.
 *
 * RÈGLE ABSOLUE : ce module est un CHEMIN DE GESTION D'ERREUR, il ne doit
 * jamais pouvoir en créer une.
 * - aucun appel ne lève, jamais (sidecar mort compris) ;
 * - aucune promesse rejetée n'est propagée — sans quoi le rejet remonterait à
 *   `unhandledrejection`, qui rappellerait `logUi`, qui… ;
 * - GARDE ANTI-BOUCLE : l'échec d'un `log.append` n'est JAMAIS journalisé
 *   (ni ici, ni dans `sidecar.ts`, qui ignore les erreurs de protocole dont la
 *   méthode est `log.append`) ;
 * - ANTI-INONDATION : un même message en rafale n'est envoyé au sidecar
 *   qu'une fois par seconde, les répétitions étant comptées. Une boucle de
 *   rendu React en erreur ne doit pas saturer le disque.
 */
import { request } from "./sidecar";

/** Niveaux du contrat, du plus grave au plus bavard. */
export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug";

/** Énumération FERMÉE des scopes (docs/protocol.md) — c'est ce qui rend l'agrégation possible. */
export const LOG_SCOPES = [
  "sidecar",
  "rust",
  "ui",
  "claude",
  "neutral",
  "orchestrator",
  "taches",
  "knowledge",
  "speech",
  "router",
  "usage",
  "mcp",
] as const;

export type LogScope = (typeof LOG_SCOPES)[number];

/** Valeurs admises dans `fields` : objet PLAT, scalaires uniquement. */
export type LogField = string | number | boolean | null;

export interface LogOptions {
  /** Objet plat de contexte technique — jamais de secret, de prompt ni de contenu de fichier. */
  fields?: Record<string, unknown>;
  stack?: string | null;
  /** Corrélation avec une requête du protocole (`req-42`). */
  reqId?: string | null;
}

/** Une entrée telle que conservée dans le tampon mémoire (même forme que la ligne JSONL). */
export interface JournalEntry {
  ts: string;
  level: LogLevel;
  scope: LogScope;
  msg: string;
  reqId: string | null;
  fields: Record<string, LogField>;
  stack: string | null;
}

/** Taille du tampon circulaire d'affichage immédiat. */
const TAILLE_TAMPON = 300;
/** Fenêtre de coalescence des messages identiques avant envoi au sidecar. */
const FENETRE_COALESCENCE_MS = 1000;
/** Garde-fou mémoire sur la table de coalescence (élaguée au-delà). */
const MAX_CLES_COALESCENCE = 200;
/** Longueurs maximales — une entrée est un libellé technique, pas de la donnée. */
const MAX_MSG = 500;
const MAX_FIELD = 200;
const MAX_STACK = 4000;

/** Méthode du protocole utilisée pour écrire : sert de garde anti-récursion partout. */
export const LOG_APPEND_METHOD = "log.append";

const tampon: JournalEntry[] = [];
const journalSubscribers = new Set<(entry: JournalEntry) => void>();

const NIVEAUX: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug"];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (NIVEAUX as readonly string[]).includes(value);
}

export function isLogScope(value: unknown): value is LogScope {
  return typeof value === "string" && (LOG_SCOPES as readonly string[]).includes(value);
}

/** Une entrée = une ligne JSONL : les sauts de ligne deviennent des espaces. */
function normaliserMsg(value: unknown): string {
  const brut = typeof value === "string" ? value : String(value ?? "");
  const uneLigne = brut.replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (!uneLigne) return "(sans message)";
  return uneLigne.length > MAX_MSG ? `${uneLigne.slice(0, MAX_MSG)}…` : uneLigne;
}

/** `fields` reste PLAT et scalaire : tout le reste est neutralisé, jamais rejeté. */
function normaliserFields(value: unknown): Record<string, LogField> {
  const out: Record<string, LogField> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [cle, brut] of Object.entries(value as Record<string, unknown>)) {
    if (brut === undefined) continue;
    if (brut === null) {
      out[cle] = null;
    } else if (typeof brut === "string") {
      out[cle] = brut.length > MAX_FIELD ? `${brut.slice(0, MAX_FIELD)}…` : brut;
    } else if (typeof brut === "number") {
      out[cle] = Number.isFinite(brut) ? brut : null;
    } else if (typeof brut === "boolean") {
      out[cle] = brut;
    }
    // Objets/tableaux/fonctions : ignorés (le contrat impose un objet plat).
  }
  return out;
}

function normaliserStack(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.length > MAX_STACK ? `${value.slice(0, MAX_STACK)}…` : value;
}

function pousserDansTampon(entry: JournalEntry): void {
  tampon.push(entry);
  if (tampon.length > TAILLE_TAMPON) tampon.splice(0, tampon.length - TAILLE_TAMPON);
  for (const cb of journalSubscribers) {
    try {
      cb(entry);
    } catch {
      // Un abonné qui lève ne doit pas empêcher les suivants d'être servis,
      // ni faire échouer la journalisation. Et surtout : on ne journalise PAS
      // cet échec (l'abonné est souvent un composant de la page Système, qui
      // relèverait aussitôt — boucle).
    }
  }
}

/**
 * Instantané du tampon mémoire (ordre chronologique) — sert à l'affichage
 * initial d'un panneau qui vient de s'abonner, sans attendre une nouvelle
 * entrée. Copie défensive : l'appelant ne peut pas altérer le tampon.
 */
export function journalSnapshot(): JournalEntry[] {
  return tampon.slice();
}

/**
 * Abonnement aux entrées du journal UI. Même contrat que `subscribeStatus` /
 * `subscribeLog` de `sidecar.ts` : add/remove synchrones dans un `Set`, donc
 * sûr avec le double montage des effets en StrictMode.
 */
export function subscribeJournal(cb: (entry: JournalEntry) => void): () => void {
  journalSubscribers.add(cb);
  return () => {
    journalSubscribers.delete(cb);
  };
}

/* ---------- Envoi au sidecar : best-effort, non bloquant, jamais récursif ---------- */

interface EtatCoalescence {
  /** Date du dernier envoi effectif au sidecar pour cette clé. */
  dernierEnvoiMs: number;
  /** Occurrences reçues depuis, en attente d'un envoi récapitulatif. */
  enAttente: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const coalescences = new Map<string, EtatCoalescence>();

/**
 * Garde de RÉENTRANCE : `envoyerAuSidecar` ne peut pas être rappelé pendant sa
 * propre partie synchrone. Ceinture et bretelles — `request()` ne lève pas
 * aujourd'hui, mais ce module ne doit dépendre d'aucune promesse de ce genre.
 */
let envoiEnCours = false;

function envoyerAuSidecar(entry: JournalEntry, repetitions: number): void {
  if (envoiEnCours) return;
  envoiEnCours = true;
  try {
    const fields =
      repetitions > 1 ? { ...entry.fields, repetitions } : entry.fields;
    const { done } = request(LOG_APPEND_METHOD, {
      level: entry.level,
      scope: entry.scope,
      msg: entry.msg,
      fields,
      ...(entry.stack ? { stack: entry.stack } : {}),
      ...(entry.reqId ? { reqId: entry.reqId } : {}),
    });
    // GARDE ANTI-BOUCLE : l'échec de l'écriture du journal n'est jamais
    // journalisé — il produirait un nouveau `log.append`, qui échouerait
    // pareil. Le rejet est avalé ici pour qu'il n'atteigne pas non plus
    // `unhandledrejection` (qui, lui, journalise).
    void done.catch(() => {});
  } catch {
    // Sidecar mort, listeners Tauri absents, contexte non-Tauri (tests) :
    // la journalisation échoue en silence, l'appelant n'en saura rien.
  } finally {
    envoiEnCours = false;
  }
}

/** Supprime les clés inactives quand la table grossit (rafales de messages tous différents). */
function elaguerCoalescences(maintenant: number): void {
  if (coalescences.size <= MAX_CLES_COALESCENCE) return;
  for (const [cle, etat] of coalescences) {
    if (etat.timer === null && maintenant - etat.dernierEnvoiMs >= FENETRE_COALESCENCE_MS) {
      coalescences.delete(cle);
    }
  }
}

/**
 * Anti-inondation : premier message envoyé tout de suite, puis au plus un
 * envoi par seconde et par message identique, les occurrences intermédiaires
 * étant comptées dans `fields.repetitions`.
 */
function planifierEnvoi(entry: JournalEntry): void {
  const cle = `${entry.level}::${entry.scope}::${entry.msg}`;
  const maintenant = Date.now();
  const etat = coalescences.get(cle);

  if (!etat || maintenant - etat.dernierEnvoiMs >= FENETRE_COALESCENCE_MS) {
    // Fenêtre écoulée : envoi immédiat. Si un récapitulatif était programmé
    // (timer en retard), ses occurrences sont reprises dans CET envoi plutôt
    // que perdues — le compte reste juste.
    if (etat?.timer) clearTimeout(etat.timer);
    const reprises = etat ? etat.enAttente : 0;
    coalescences.set(cle, { dernierEnvoiMs: maintenant, enAttente: 0, timer: null });
    elaguerCoalescences(maintenant);
    envoyerAuSidecar(entry, reprises + 1);
    return;
  }

  // Rafale : on compte, et on programme UN récapitulatif en fin de fenêtre.
  // Le récapitulatif porte l'entrée de la PREMIÈRE occurrence de la rafale
  // (même niveau/scope/message par construction ; `fields`/`stack` de la
  // première suffisent à qualifier la rafale).
  etat.enAttente += 1;
  if (etat.timer === null) {
    const restant = Math.max(0, FENETRE_COALESCENCE_MS - (maintenant - etat.dernierEnvoiMs));
    etat.timer = setTimeout(() => {
      const courant = coalescences.get(cle);
      if (!courant) return;
      const repetitions = courant.enAttente;
      courant.enAttente = 0;
      courant.timer = null;
      courant.dernierEnvoiMs = Date.now();
      if (repetitions > 0) envoyerAuSidecar(entry, repetitions);
    }, restant);
  }
}

/* ---------- API publique ---------- */

/**
 * Journalise une entrée UI : tampon mémoire (immédiat) + `log.append`
 * (best-effort). Ne lève jamais, ne rend jamais de promesse — l'appelant est
 * un chemin de gestion d'erreur, il n'a pas à gérer l'échec de sa propre
 * journalisation (voir docs/protocol.md, `log.append`).
 */
export function logUi(level: LogLevel, scope: LogScope, msg: string, opts: LogOptions = {}): void {
  try {
    const entry: JournalEntry = {
      ts: new Date().toISOString(),
      level: isLogLevel(level) ? level : "error",
      scope: isLogScope(scope) ? scope : "sidecar",
      msg: normaliserMsg(msg),
      reqId: typeof opts.reqId === "string" && opts.reqId ? opts.reqId : null,
      fields: normaliserFields(opts.fields),
      stack: normaliserStack(opts.stack),
    };
    pousserDansTampon(entry);
    planifierEnvoi(entry);
  } catch {
    // Dernier rempart : quoi qu'il arrive, journaliser ne casse rien.
  }
}

export function logFatal(scope: LogScope, msg: string, opts?: LogOptions): void {
  logUi("fatal", scope, msg, opts);
}

export function logError(scope: LogScope, msg: string, opts?: LogOptions): void {
  logUi("error", scope, msg, opts);
}

export function logWarn(scope: LogScope, msg: string, opts?: LogOptions): void {
  logUi("warn", scope, msg, opts);
}

export function logInfo(scope: LogScope, msg: string, opts?: LogOptions): void {
  logUi("info", scope, msg, opts);
}

export function logDebug(scope: LogScope, msg: string, opts?: LogOptions): void {
  logUi("debug", scope, msg, opts);
}

/* ---------- Capture globale (remplace `devErrorProbe.ts`) ---------- */

let captureInstallee = false;

/**
 * Branche `window.onerror` et `unhandledrejection` sur le journal. Reprend ce
 * que faisait la sonde temporaire `devErrorProbe.ts` (y compris
 * `filename:lineno:colno` et la stack), mais vers le journal applicatif au
 * lieu d'un collecteur HTTP inexistant. Idempotent : appelé au chargement du
 * module, sans effet si déjà installé.
 */
export function installerCaptureGlobale(): void {
  if (captureInstallee || typeof window === "undefined") return;
  captureInstallee = true;

  window.addEventListener("error", (evt: ErrorEvent) => {
    const erreur = evt.error instanceof Error ? evt.error : null;
    const message =
      (typeof evt.message === "string" && evt.message) || erreur?.message || "erreur non capturée";
    logUi("error", "ui", message, {
      fields: {
        filename: typeof evt.filename === "string" && evt.filename ? evt.filename : "(inconnu)",
        lineno: typeof evt.lineno === "number" ? evt.lineno : 0,
        colno: typeof evt.colno === "number" ? evt.colno : 0,
      },
      stack: erreur?.stack ?? null,
    });
  });

  window.addEventListener("unhandledrejection", (evt: PromiseRejectionEvent) => {
    const raison: unknown = evt.reason;
    const erreur = raison instanceof Error ? raison : null;
    const message = erreur
      ? erreur.message
      : typeof raison === "string" && raison
        ? raison
        : "motif non exploitable";
    logUi("error", "ui", `promesse rejetée non gérée : ${message}`, {
      stack: erreur?.stack ?? null,
    });
  });
}

installerCaptureGlobale();
