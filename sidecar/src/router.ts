/**
 * Routeur heuristique — Lot 14, phases R1 + R2.
 *
 * Classe une requête en tier de complexité (heuristique pure) et renvoie la
 * cible moteur/modèle d'après une table configurable poussée par l'UI via
 * `router.set` (voir docs/protocol.md, section « Méthodes R1/R2/R3 — routage »).
 * Même patron que engine.ts : état en mémoire, validation souple, erreurs
 * françaises lisibles, EngineEmitter.
 *
 * R2 (docs/spec-r2-classificateur.md) ajoute :
 * - un classificateur LLM local (complétion NON streamée via un provider
 *   d'engine.ts), consulté SEULEMENT quand le score heuristique est à ±1
 *   d'une frontière de tier — timeout 3 s, repli heuristique silencieux :
 *   le routeur ne doit JAMAIS ralentir sensiblement un envoi ;
 * - la surcharge par projet `<cwd>/.iaction/routage.yaml` (lecture tolérante
 *   à chaque appel, fusion défauts ← table globale ← table projet) ;
 * - `resolveRoute`, la résolution interne réutilisée par orchestrator.ts
 *   (agents `engine: auto`) sans aller-retour protocole.
 *
 * R7 (docs/spec-r7-topdown.md) ajoute le routage DESCENDANT :
 * - mapping score→tier inversé (simple ≤ 2 · moyen 3-6 · complexe ≥ 7),
 *   `trivial` réservé aux preuves positives (TRIVIAL_PATTERNS) ;
 * - `minTier` (plancher de session poussé par l'UI) : le tier effectif ne
 *   descend jamais sous le plancher (ordre TIER_ORDER).
 *
 * Le routeur ne vérifie JAMAIS la disponibilité d'un provider : c'est l'UI
 * qui connaît la table des fournisseurs déclarés et applique le repli.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { buildHeaders, getProvider, joinUrl, type EngineEmitter } from "./engine.js";
import { autoDebordCostUsdThisMonth, isLocalProviderId, readLatestClaudeWindows } from "./usageStats.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouteTier = "trivial" | "simple" | "moyen" | "complexe";

export interface RouteTarget {
  engine: "claude" | "neutral";
  /** Requis si engine === "neutral". */
  providerId?: string;
  model: string;
}

export type RoutingTable = Record<RouteTier, RouteTarget>;

export const ROUTE_TIERS: readonly RouteTier[] = ["trivial", "simple", "moyen", "complexe"];

/**
 * R7 — ordre des tiers pour le plancher de session (docs/spec-r7-topdown.md
 * §B.1) : trivial < simple < moyen < complexe. Le tier effectif d'un
 * `router.route` avec `minTier` est le max des deux selon cet ordre.
 */
export const TIER_ORDER: Record<RouteTier, number> = {
  trivial: 0,
  simple: 1,
  moyen: 2,
  complexe: 3,
};

/**
 * Table par défaut codée en dur (docs/spec-r1-routeur.md §1.1) : utilisée
 * tant que `router.set` n'a pas été appelé, et pour compléter tout tier
 * manquant ou invalide d'un `router.set` partiel.
 */
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  trivial: { engine: "claude", model: "claude-haiku-4-5" },
  simple: { engine: "claude", model: "claude-sonnet-5" },
  moyen: { engine: "claude", model: "claude-opus-4-8" },
  complexe: { engine: "claude", model: "claude-fable-5" },
};

/** R2 — classificateur LLM local : provider (résolu via engine.ts) + modèle. `null` = désactivé.
 * Depuis 2026-07-29, le DÉFAUT effectif est « désactivé » (heuristique seule) : la table
 * par défaut étant entièrement sur l'abonnement, une misclassification ne coûte rien,
 * et un classificateur local à froid pénalisait chaque message ambigu. DEFAULT_CLASSIFIER
 * reste exporté comme SUGGESTION de préremplissage pour l'UI. */
export interface ClassifierConfig {
  providerId: string;
  model: string;
}

/** Défaut du classificateur (docs/spec-r2-classificateur.md §1) — remplacé par `router.set`, `null` = off. */
export const DEFAULT_CLASSIFIER: ClassifierConfig = { providerId: "ollama", model: "qwen3.5:4b" };

/**
 * R3 — débord d'abonnement (docs/spec-r3-debord.md §1) : quand la cible du
 * tier est le moteur claude et que la fenêtre 5 h dépasse `seuilPct`, le
 * tour part vers `target` (cible payante déclarée), tant que la dépense
 * mensuelle de débord reste sous `plafondUsdMois` (USD — devise
 * d'OpenRouter ; `null` = pas de plafond).
 */
export interface DebordConfig {
  target: RouteTarget;
  seuilPct: number;
  plafondUsdMois: number | null;
}

/** Défauts du débord (spec R3 §1) — remplacés par `router.set` (champ `debord`). */
export const DEFAULT_DEBORD: DebordConfig = {
  target: { engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat" },
  seuilPct: 90,
  plafondUsdMois: 10,
};

/**
 * R5 — modèle d'embeddings du RAG local (docs/spec-r5-rag.md §1) : provider
 * (résolu via engine.ts, API native `/api/embed`) + modèle. Même forme que le
 * classificateur ; consommé par knowledge.ts via `getEmbeddingsConfig()`.
 */
export interface EmbeddingsConfig {
  providerId: string;
  model: string;
}

/** Défaut des embeddings (spec R5 §1) — remplacé par `router.set` (champ `embeddings`). */
export const DEFAULT_EMBEDDINGS: EmbeddingsConfig = { providerId: "ollama", model: "nomic-embed-text" };

// ---------------------------------------------------------------------------
// État en mémoire
// ---------------------------------------------------------------------------

let routingTable: RoutingTable = { ...DEFAULT_ROUTING_TABLE };
let classifierConfig: ClassifierConfig | null = null;
/**
 * R6-A — `null` = débord DÉSACTIVÉ (`router.set` avec `debord: null`) :
 * jamais de bascule payante automatique. Distinct de « champ absent » dans
 * `router.set`, qui remet les DÉFAUTS (même distinction que le
 * classificateur).
 */
let debordConfig: DebordConfig | null = { ...DEFAULT_DEBORD, target: { ...DEFAULT_DEBORD.target } };
let embeddingsConfig: EmbeddingsConfig = { ...DEFAULT_EMBEDDINGS };

/** R5 — config d'embeddings courante (lecture seule), consommée par knowledge.ts. */
export function getEmbeddingsConfig(): EmbeddingsConfig {
  return { ...embeddingsConfig };
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Classification — fonction pure exportée (testable unitairement)
// ---------------------------------------------------------------------------

/**
 * Marqueurs de raisonnement (FR + EN) — comparés sur le texte normalisé
 * (minuscules, accents retirés via NFD), en mots entiers. Constantes du
 * module : ajustables sans toucher la logique.
 */
const REASONING_MARKERS: readonly string[] = [
  "pourquoi",
  "explique",
  "analyse",
  "compare",
  "concois", // « conçois » une fois les accents retirés
  "architecture",
  "strategie",
  "etape par etape",
  "plan",
  "why",
  "explain",
  "analyze",
  "design",
];

/** Marqueurs de demande d'édition/agentique (FR + EN), mêmes conventions. */
const EDIT_MARKERS: readonly string[] = [
  "modifie",
  "implemente",
  "corrige",
  "refactor",
  "cree", // « crée »/« créé » une fois les accents retirés
  "ecris le code",
  "ajoute la fonction",
  "fix",
  "implement",
  "write",
];

/**
 * R7 — motifs de trivialité PROUVÉE (docs/spec-r7-topdown.md §A.2) :
 * salutations/politesse, acquiescements courts, question factuelle d'une
 * phrase sans référence technique. Comparés en mots entiers sur le texte
 * normalisé (NFD/casse), comme les autres listes. Le tier `trivial` n'est
 * atteint QUE sur correspondance (score 0, texte ≤ 160 caractères, 0 pièce
 * jointe) : l'absence de signal ne suffit plus.
 */
const TRIVIAL_PATTERNS: readonly string[] = [
  // Salutations / politesse.
  "salut",
  "bonjour",
  "bonsoir",
  "bonne nuit",
  "coucou",
  "hello",
  "au revoir",
  "a plus",
  "a bientot",
  "bye",
  "merci",
  "thanks",
  "thank you",
  // Acquiescements courts.
  "ok",
  "oui",
  "non",
  "d'accord",
  "ca va",
  "parfait",
  "super",
  "genial",
  "bravo",
  "ca marche",
  // Question factuelle d'une phrase, sans référence technique.
  "quelle heure",
  "quel jour",
  "quelle date",
];

/** R7 — longueur maximale d'un texte candidat au tier trivial (preuve positive). */
const TRIVIAL_TEXT_MAX_CHARS = 160;

/** Minuscules + accents retirés (NFD) : détection insensible à la casse et aux accents. */
function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Au moins un marqueur présent en mot entier dans le texte normalisé. */
function hasAnyMarker(normalized: string, markers: readonly string[]): boolean {
  return markers.some((marker) => new RegExp(`\\b${escapeRegExp(marker)}\\b`).test(normalized));
}

/** R7 — premier motif de trivialité présent en mot entier — `null` si aucun. */
function findTrivialPattern(normalized: string): string | null {
  return (
    TRIVIAL_PATTERNS.find((motif) => new RegExp(`\\b${escapeRegExp(motif)}\\b`).test(normalized)) ??
    null
  );
}

/** Appel de fonction type `foo(bar)` : identifiant collé à une parenthèse. */
const FUNCTION_CALL_RE = /\b[A-Za-z_][\w$.]*\([^()\n]*\)/;

/**
 * Chemin de fichier : au moins un « / » entre segments, avec au moins une
 * lettre après le premier slash (écarte les dates type 27/07/2026).
 */
const FILE_PATH_RE = /(?:^|[\s"'`(=])(?:~|\.{1,2})?[\w.-]*\/[\w./-]*[A-Za-z][\w./-]*/;

/** Présence de code : bloc ```, ≥ 2 segments `…` inline, motif `foo(bar)` ou chemin de fichier. */
function hasCodeSignal(text: string): boolean {
  if (text.includes("```")) {
    return true;
  }
  const inlineCode = text.match(/`[^`\n]+`/g);
  if (inlineCode && inlineCode.length >= 2) {
    return true;
  }
  return FUNCTION_CALL_RE.test(text) || FILE_PATH_RE.test(text);
}

export interface ClassifyInput {
  text: string;
  /** Tours déjà dans la conversation. */
  historyTurns?: number;
  attachmentsCount?: number;
}

export interface ClassifyResult {
  tier: RouteTier;
  score: number;
  reasons: string[];
}

/** Plafond des points de pièces jointes (+1 chacune). */
const ATTACHMENTS_POINTS_CAP = 3;

/**
 * Classification heuristique pure : barème additif (docs/spec-r1-routeur.md
 * §1.3), mapping DESCENDANT (docs/spec-r7-topdown.md §A) : score ≤ 2 →
 * simple · 3-6 → moyen · ≥ 7 → complexe. `trivial` UNIQUEMENT sur preuve
 * positive (score 0, ≤ 160 caractères, 0 pièce jointe, motif de
 * TRIVIAL_PATTERNS) — l'absence de preuve de complexité n'est plus une
 * preuve de trivialité. Les libellés `reasons` sont français et courts.
 */
export function classify(input: ClassifyInput): ClassifyResult {
  const text = typeof input.text === "string" ? input.text : "";
  const normalized = normalizeText(text);
  let score = 0;
  const reasons: string[] = [];

  if (text.length > 400) {
    score += 2;
    reasons.push("message long (> 400 caractères)");
  }
  if (text.length > 1500) {
    // Cumulable avec le précédent (un texte > 1500 vaut +2 +3 = +5).
    score += 3;
    reasons.push("message très long (> 1500 caractères)");
  }
  if (hasCodeSignal(text)) {
    score += 2;
    reasons.push("bloc de code");
  }
  if (hasAnyMarker(normalized, REASONING_MARKERS)) {
    score += 2;
    reasons.push("marqueur de raisonnement");
  }
  if (hasAnyMarker(normalized, EDIT_MARKERS)) {
    score += 3;
    reasons.push("demande d'édition");
  }

  const attachmentsCount =
    typeof input.attachmentsCount === "number" && Number.isFinite(input.attachmentsCount)
      ? Math.max(0, Math.floor(input.attachmentsCount))
      : 0;
  if (attachmentsCount > 0) {
    score += Math.min(attachmentsCount, ATTACHMENTS_POINTS_CAP);
    reasons.push(attachmentsCount === 1 ? "pièce jointe" : `pièces jointes (${attachmentsCount})`);
  }

  const historyTurns =
    typeof input.historyTurns === "number" && Number.isFinite(input.historyTurns)
      ? input.historyTurns
      : 0;
  if (historyTurns > 10) {
    score += 1;
    reasons.push("historique long (> 10 tours)");
  }

  // R7 — barème descendant : sans signal, le tour part en `simple` ; le tier
  // `trivial` exige une preuve positive (motif + texte court + rien de joint).
  let tier: RouteTier;
  if (score === 0) {
    const motif =
      attachmentsCount === 0 && text.length <= TRIVIAL_TEXT_MAX_CHARS
        ? findTrivialPattern(normalized)
        : null;
    if (motif) {
      tier = "trivial";
      reasons.push(`trivialité prouvée : « ${motif} »`);
    } else {
      tier = "simple";
      reasons.push("aucun signal → simple (défaut descendant)");
    }
  } else if (score <= 2) {
    tier = "simple";
  } else if (score <= 6) {
    tier = "moyen";
  } else {
    tier = "complexe";
  }

  return { tier, score, reasons };
}

// ---------------------------------------------------------------------------
// router.set
// ---------------------------------------------------------------------------

/**
 * Validation souple d'une cible de tier : objet `{engine, providerId?, model}`
 * avec `engine` ∈ claude|neutral, `model` non vide, et `providerId` non vide
 * requis si neutral. Entrée invalide → null (le tier retombe sur le défaut).
 */
function sanitizeRouteTarget(value: unknown): RouteTarget | null {
  if (!isPlainObject(value)) {
    return null;
  }
  const engine = value.engine;
  if (engine !== "claude" && engine !== "neutral") {
    return null;
  }
  if (!isNonEmptyString(value.model)) {
    return null;
  }
  if (engine === "neutral") {
    if (!isNonEmptyString(value.providerId)) {
      return null;
    }
    return { engine, providerId: value.providerId, model: value.model };
  }
  return { engine, model: value.model };
}

/**
 * R2 — validation souple de la config classificateur : objet `{providerId,
 * model}` à chaînes non vides → config ; toute autre valeur → null (invalide).
 * Le `null` explicite (= désactivé) est géré par l'appelant.
 */
function sanitizeClassifier(value: unknown): ClassifierConfig | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (!isNonEmptyString(value.providerId) || !isNonEmptyString(value.model)) {
    return null;
  }
  return { providerId: value.providerId, model: value.model };
}

/**
 * R3 — validation souple de la config de débord, champ par champ : toute
 * valeur absente/invalide retombe sur son défaut (même philosophie que la
 * table). `plafondUsdMois: null` explicite = pas de plafond.
 */
function sanitizeDebord(value: unknown): DebordConfig {
  const next: DebordConfig = { ...DEFAULT_DEBORD, target: { ...DEFAULT_DEBORD.target } };
  if (!isPlainObject(value)) {
    return next;
  }
  const target = sanitizeRouteTarget(value.target);
  if (target) {
    next.target = target;
  }
  if (typeof value.seuilPct === "number" && Number.isFinite(value.seuilPct) && value.seuilPct > 0) {
    next.seuilPct = value.seuilPct;
  }
  if (value.plafondUsdMois === null) {
    next.plafondUsdMois = null;
  } else if (
    typeof value.plafondUsdMois === "number" &&
    Number.isFinite(value.plafondUsdMois) &&
    value.plafondUsdMois >= 0
  ) {
    next.plafondUsdMois = value.plafondUsdMois;
  }
  return next;
}

export function handleRouterSet(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): void {
  const raw = params.table;
  if (!isPlainObject(raw)) {
    emitter.error(id, "params.table doit être un objet");
    return;
  }

  // Remplace la table courante : fusion avec les défauts, un tier invalide
  // est simplement ignoré (repli sur son défaut), jamais d'erreur globale.
  const next: RoutingTable = { ...DEFAULT_ROUTING_TABLE };
  let count = 0;
  for (const tier of ROUTE_TIERS) {
    const target = sanitizeRouteTarget(raw[tier]);
    if (target) {
      next[tier] = target;
      count += 1;
    }
  }
  routingTable = next;

  // R2 — classificateur : `null` explicite = désactivé ; objet valide = config ;
  // absent ou invalide = retour au défaut (même logique « remplacement + repli
  // sur le défaut » que la table).
  if (params.classifier === null) {
    classifierConfig = null;
  } else {
    // Champ absent = défaut = désactivé (même sémantique que `null` depuis 2026-07-29).
    classifierConfig = sanitizeClassifier(params.classifier) ?? null;
  }

  // R3/R6-A — débord : `null` explicite = débord DÉSACTIVÉ (jamais de bascule
  // payante automatique — c'est l'état poussé par le runner headless quand la
  // config de l'app est illisible) ; sinon remplacement champ par champ, repli
  // sur les défauts (absent ou invalide = retour aux défauts, comme la table
  // et le classificateur).
  if (params.debord === null) {
    debordConfig = null;
  } else {
    debordConfig = sanitizeDebord(params.debord);
  }

  // R5 — embeddings du RAG local : même forme `{providerId, model}` que le
  // classificateur (validation réutilisée telle quelle), absent ou invalide =
  // retour au défaut. Pas de forme « désactivé » : l'indexation n'a lieu que
  // sur action explicite de l'utilisateur (knowledge.index).
  embeddingsConfig = sanitizeClassifier(params.embeddings) ?? { ...DEFAULT_EMBEDDINGS };

  emitter.done(id, { count });
}

// ---------------------------------------------------------------------------
// R2 — surcharge par projet : <cwd>/.iaction/routage.yaml
// ---------------------------------------------------------------------------

interface ProjectRouting {
  /** Tiers partiels valides du fichier projet (le reste hérite du global). */
  table: Partial<RoutingTable>;
  /** `undefined` = non précisé (hérite du global) ; `null` = désactivé pour ce projet. */
  classifier: ClassifierConfig | null | undefined;
  /** Vrai si le fichier existe mais est illisible/invalide (mention dans reasons). */
  invalid: boolean;
}

const NO_PROJECT_ROUTING: ProjectRouting = { table: {}, classifier: undefined, invalid: false };

/**
 * Lecture TOLÉRANTE de `<cwd>/.iaction/routage.yaml`, à chaque appel (fichier
 * petit, pas de cache — même patron qu'orchestrator.ts) : fichier absent →
 * aucune surcharge ; YAML invalide ou forme inattendue → ignoré, `invalid`
 * pour que `reasons` le mentionne ; chaque tier est validé individuellement.
 */
async function readProjectRouting(cwd: string): Promise<ProjectRouting> {
  const filePath = path.join(path.resolve(cwd), ".iaction", "routage.yaml");
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch {
    return NO_PROJECT_ROUTING;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return { ...NO_PROJECT_ROUTING, invalid: true };
  }
  if (!isPlainObject(parsed)) {
    return { ...NO_PROJECT_ROUTING, invalid: true };
  }

  const table: Partial<RoutingTable> = {};
  if (isPlainObject(parsed.table)) {
    for (const tier of ROUTE_TIERS) {
      const target = sanitizeRouteTarget(parsed.table[tier]);
      if (target) {
        table[tier] = target;
      }
    }
  }

  let classifier: ClassifierConfig | null | undefined;
  if (parsed.classifier === null) {
    classifier = null;
  } else if (parsed.classifier !== undefined) {
    // Invalide → undefined (hérite du global), jamais d'erreur.
    classifier = sanitizeClassifier(parsed.classifier) ?? undefined;
  }

  return { table, classifier, invalid: false };
}

// ---------------------------------------------------------------------------
// R2 — classificateur LLM local (complétion NON streamée, timeout 3 s)
// ---------------------------------------------------------------------------

/** Le classificateur ne doit JAMAIS retenir un envoi au-delà de ce délai. */
const CLASSIFIER_TIMEOUT_MS = 3000;
/** Un seul mot attendu (« complexe » = 3 tokens max sur les tokenizers usuels). */
const CLASSIFIER_MAX_TOKENS = 4;
/** Le classement n'a pas besoin de tout le message : borne le prompt utilisateur. */
const CLASSIFIER_TEXT_CAP = 4000;

const CLASSIFIER_SYSTEM_PROMPT =
  "Tu es un classificateur de complexité. Réponds par UN SEUL mot, en minuscules, " +
  "sans ponctuation, choisi parmi : trivial, simple, moyen, complexe. " +
  "Classe la demande de l'utilisateur selon l'effort de raisonnement qu'elle exige.";

/**
 * Frontières de tiers du barème descendant R7 (scores 3 et 7) : le LLM n'est
 * consulté qu'à ±1 de l'une d'elles — `trivial` n'étant plus atteignable par
 * score, la frontière basse a disparu.
 */
const TIER_BOUNDARY_SCORES: readonly number[] = [3, 7];

function isNearTierBoundary(score: number): boolean {
  return TIER_BOUNDARY_SCORES.some((boundary) => Math.abs(score - boundary) <= 1);
}

/** Extrait un tier du texte renvoyé par le LLM (normalisé, premier mot) — null si hors liste. */
function parseTierWord(content: string): RouteTier | null {
  const word = normalizeText(content).replace(/[^a-z]+/g, " ").trim().split(" ")[0] ?? "";
  return (ROUTE_TIERS as readonly string[]).includes(word) ? (word as RouteTier) : null;
}

/**
 * Appelle le classificateur LLM (complétion non streamée, température 0) via
 * le provider résolu par `getProvider()`. TOUT échec — provider inconnu,
 * réseau, HTTP non-2xx, timeout, réponse illisible ou hors liste — renvoie
 * `null` : repli heuristique silencieux, jamais d'erreur remontée.
 */
async function classifyWithLlm(text: string, config: ClassifierConfig): Promise<RouteTier | null> {
  const provider = getProvider(config.providerId);
  if (!provider) {
    return null;
  }
  try {
    const res = await fetch(joinUrl(provider.baseUrl, "chat/completions"), {
      method: "POST",
      headers: buildHeaders(provider, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: text.slice(0, CLASSIFIER_TEXT_CAP) },
        ],
        stream: false,
        temperature: 0,
        max_tokens: CLASSIFIER_MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as unknown;
    if (!isPlainObject(json) || !Array.isArray(json.choices) || !isPlainObject(json.choices[0])) {
      return null;
    }
    const message = json.choices[0].message;
    if (!isPlainObject(message) || typeof message.content !== "string") {
      return null;
    }
    return parseTierWord(message.content);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// R3 — décision de débord (docs/spec-r3-debord.md §2.3)
// ---------------------------------------------------------------------------

/**
 * État de débord d'une résolution : `{active: true}` = tour envoyé vers la
 * cible de débord ; `{active: false, blocked: true}` = plafond mensuel
 * atteint, repli sur la cible du tier trivial SI elle est locale (voir la
 * garde dans applyDebord), sinon cible claude d'origine conservée.
 */
export interface DebordDecision {
  active: boolean;
  blocked?: true;
  fiveHourPct: number;
}

/**
 * R6-A — âge maximal d'un instantané de fenêtres pour décider un débord :
 * un instantané est un relevé PONCTUEL de la fenêtre 5 h ; au-delà de 30 min
 * il ne dit plus rien de la saturation réelle (la fenêtre a pu se vider).
 * Plus vieux → comportement « pas d'instantané » (pas de débord).
 */
export const DEBORD_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Applique la règle de débord à une cible résolue : ne concerne QUE les
 * cibles `engine: "claude"` (l'abonnement), et seulement si le débord n'est
 * pas désactivé (`debord: null` de `router.set`). Sans instantané de
 * fenêtres (ou sans pourcentage 5 h, ou instantané plus vieux que
 * DEBORD_SNAPSHOT_MAX_AGE_MS) → comportement R1 inchangé (`debord: null`).
 * Lecture best effort : toute erreur laisse la cible telle quelle.
 */
async function applyDebord(
  target: RouteTarget,
  table: RoutingTable,
): Promise<{ target: RouteTarget; debord: DebordDecision | null }> {
  if (!debordConfig || target.engine !== "claude") {
    return { target, debord: null };
  }
  const windows = await readLatestClaudeWindows();
  if (!windows || windows.fiveHourPct === null || windows.fiveHourPct < debordConfig.seuilPct) {
    return { target, debord: null };
  }
  // R6-A — fraîcheur : instantané trop vieux (ou ts illisible) = ignoré.
  const snapshotTime = windows.ts !== null ? Date.parse(windows.ts) : Number.NaN;
  if (Number.isNaN(snapshotTime) || Date.now() - snapshotTime > DEBORD_SNAPSHOT_MAX_AGE_MS) {
    return { target, debord: null };
  }
  const fiveHourPct = windows.fiveHourPct;
  if (debordConfig.plafondUsdMois !== null) {
    const depenseMois = await autoDebordCostUsdThisMonth();
    if (depenseMois >= debordConfig.plafondUsdMois) {
      // Plafond atteint : repli LOCAL (cible du tier trivial), jamais de
      // payant auto. R6-A — garde : si le tier trivial a été reconfiguré vers
      // autre chose qu'un moteur neutre sur provider LOCAL (coût nul), ce
      // « repli local » routerait vers du payant ou vers l'abo saturé — on
      // conserve alors la cible claude d'origine.
      const trivial = table.trivial;
      const repliLocal = trivial.engine === "neutral" && isLocalProviderId(trivial.providerId);
      return {
        target: repliLocal ? trivial : target,
        debord: { active: false, blocked: true, fiveHourPct },
      };
    }
  }
  return { target: debordConfig.target, debord: { active: true, fiveHourPct } };
}

// ---------------------------------------------------------------------------
// R2 — résolution interne (réutilisée par router.route ET orchestrator.ts)
// ---------------------------------------------------------------------------

export interface RouteRequest {
  text: string;
  historyTurns?: number;
  attachmentsCount?: number;
  /** Projet courant : active la surcharge `<cwd>/.iaction/routage.yaml`. */
  cwd?: string;
  /** Défaut true ; false = pas d'appel au classificateur LLM (tests, appels pressés). */
  allowLlm?: boolean;
  /**
   * R3 — tier imposé : saute la classification (heuristique ET LLM) et résout
   * directement ce tier. Utilisé par l'UI pour re-vérifier le débord à chaque
   * tour d'une conversation à affinité de session (tier déjà mémorisé), sans
   * jamais re-classer.
   */
  tier?: RouteTier;
  /**
   * R7 — plancher de session (docs/spec-r7-topdown.md §B.1) : le tier
   * effectif est max(tier classé ou imposé, minTier) selon TIER_ORDER — il ne
   * descend jamais sous le plancher. Compatible avec `tier` (imposé R3) :
   * `tier` prime sur la classification, puis `minTier` s'applique aussi.
   */
  minTier?: RouteTier;
}

export interface RouteResolution {
  tier: RouteTier;
  score: number;
  reasons: string[];
  target: RouteTarget;
  method: "heuristique" | "llm";
  /** R3 — état de débord de la résolution (`null` = routage normal). */
  debord: DebordDecision | null;
}

/**
 * Résolution complète d'une route (spec R2) : heuristique, puis classificateur
 * LLM si le score hésite (±1 d'une frontière), fusion défauts ← table globale
 * ← table projet. Ne rejette jamais : tous les chemins d'échec (fichier projet
 * invalide, classificateur en panne/timeout) replient silencieusement.
 * Exportée pour orchestrator.ts (agents `engine: auto`) — pas d'aller-retour
 * protocole.
 */
export async function resolveRoute(req: RouteRequest): Promise<RouteResolution> {
  // R3 — tier imposé : aucune classification, la résolution ne fait que
  // fusionner les tables et appliquer la règle de débord.
  const imposedTier = req.tier && ROUTE_TIERS.includes(req.tier) ? req.tier : null;
  const { tier: heuristicTier, score, reasons } = imposedTier
    ? { tier: imposedTier, score: 0, reasons: ["tier imposé par l'appelant"] }
    : classify({
        text: req.text,
        historyTurns: req.historyTurns,
        attachmentsCount: req.attachmentsCount,
      });

  // Surcharge projet (routage.yaml) — `routingTable` contient déjà les défauts
  // fusionnés (voir handleRouterSet), la fusion projet s'empile par-dessus.
  const project = isNonEmptyString(req.cwd) ? await readProjectRouting(req.cwd) : NO_PROJECT_ROUTING;
  if (project.invalid) {
    reasons.push("routage.yaml invalide (ignoré)");
  }
  const table: RoutingTable = { ...routingTable, ...project.table };
  const classifier = project.classifier !== undefined ? project.classifier : classifierConfig;

  let tier = heuristicTier;
  let method: "heuristique" | "llm" = "heuristique";
  if (!imposedTier && req.allowLlm !== false && classifier && isNearTierBoundary(score)) {
    const llmTier = await classifyWithLlm(req.text, classifier);
    if (llmTier) {
      tier = llmTier;
      method = "llm";
      reasons.push(`classificateur LLM : ${llmTier}`);
    }
    // Échec/timeout/réponse hors liste : repli heuristique SILENCIEUX (spec R2 §1).
  }

  // R7 — plancher de session : appliqué APRÈS la classification (heuristique,
  // LLM ou tier imposé R3) — le tier effectif ne descend jamais sous minTier.
  const minTier = req.minTier && ROUTE_TIERS.includes(req.minTier) ? req.minTier : null;
  if (minTier && TIER_ORDER[minTier] > TIER_ORDER[tier]) {
    tier = minTier;
    reasons.push(`plancher de session : ${minTier}`);
  }

  // R3 — débord d'abonnement : la cible claude d'un tier saturé part vers la
  // cible de débord (ou replie en local si le plafond mensuel est atteint).
  const { target, debord } = await applyDebord(table[tier], table);
  if (debord) {
    let debordReason: string;
    if (debord.active) {
      debordReason = `débord : fenêtre 5 h à ${Math.round(debord.fiveHourPct)} %`;
    } else if (target.engine === "claude") {
      // R6-A — plafond atteint mais tier trivial non local : cible conservée.
      debordReason = "plafond débord atteint : cible abonnement conservée (tier trivial non local)";
    } else {
      debordReason = "plafond débord atteint : repli local";
    }
    reasons.push(debordReason);
  }

  return { tier, score, reasons, target, method, debord };
}

// ---------------------------------------------------------------------------
// router.route
// ---------------------------------------------------------------------------

export async function handleRouterRoute(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const text = params.text;
  if (!isNonEmptyString(text) || text.trim().length === 0) {
    emitter.error(id, "params.text manquant ou invalide");
    return;
  }

  const historyTurns =
    typeof params.historyTurns === "number" && Number.isFinite(params.historyTurns)
      ? params.historyTurns
      : undefined;
  const attachmentsCount =
    typeof params.attachmentsCount === "number" && Number.isFinite(params.attachmentsCount)
      ? params.attachmentsCount
      : undefined;
  const cwd = isNonEmptyString(params.cwd) ? params.cwd : undefined;
  const allowLlm = typeof params.allowLlm === "boolean" ? params.allowLlm : undefined;
  // R3 — tier imposé (revérification de débord sans re-classement, voir RouteRequest).
  const imposedTier =
    isNonEmptyString(params.tier) && (ROUTE_TIERS as readonly string[]).includes(params.tier)
      ? (params.tier as RouteTier)
      : undefined;
  // R7 — plancher de session (voir RouteRequest.minTier) : jamais en dessous.
  const minTier =
    isNonEmptyString(params.minTier) && (ROUTE_TIERS as readonly string[]).includes(params.minTier)
      ? (params.minTier as RouteTier)
      : undefined;

  const { tier, score, reasons, target, method, debord } = await resolveRoute({
    text,
    historyTurns,
    attachmentsCount,
    cwd,
    allowLlm,
    tier: imposedTier,
    minTier,
  });
  // R3 — `debord` seulement quand la règle a joué (actif ou bloqué), jamais `null`.
  emitter.done(id, { tier, score, reasons, target, method, ...(debord ? { debord } : {}) });
}
