/*
 * Page « Chat » : conversation multi-fournisseur streamée. Disposition
 * « zen » alignée sur la page Projets (voir AgentPage.tsx) : panneau latéral
 * gauche à sections dépliantes (SidebarSection.tsx) — « LLM » (fournisseur/
 * modèle/prompt système) et « Historique » (sessions) — la zone principale
 * ne gardant que le fil de conversation et la zone de saisie. La mise en
 * page plein-viewport/défilement interne (`.agent-page`/`.agent-layout`/
 * `.agent-sidebar`), la liste de sessions (`.session-list`/`.session-item`)
 * et la barre d'onglets de conversations (`.agent-tabs`/`.agent-tab`) sont
 * RÉUTILISÉES telles quelles depuis AgentPage.tsx/App.css plutôt que
 * dupliquées — voir les commentaires correspondants dans App.css. Fil de
 * conversation avec bulles néon (utilisateur/assistant), auto-scroll
 * intelligent, streaming avec bouton d'arrêt (`chat.abort`), affichage de
 * l'usage token quand fourni. La taille de contexte du fil est publiée vers
 * l'encart « Contexte » de l'en-tête (voir contextTokens et contextBus.ts).
 *
 * Onglets multiples (portage du Lot Onglets multiples de AgentPage.tsx) :
 * plusieurs conversations peuvent être ouvertes en onglets au-dessus de la
 * transcription, chacune avec son runtime vif (`ConvRuntime`) — un tour peut
 * ainsi continuer de streamer dans un onglet d'arrière-plan pendant qu'on
 * lit ou écrit dans un autre. Voir le commentaire détaillé au-dessus de
 * `runtimesRef` dans le composant.
 */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  AttachmentPickerButton,
  AttachmentTray,
  filesFromClipboard,
  filesFromDrop,
  SentAttachments,
  toAttachmentRefs,
  toContractAttachments,
  toSentAttachments,
  useAttachmentDraft,
  type SentAttachment,
} from "./Attachments";
import { readClipboardImage } from "./clipboardClient";
import { closeDanglingFence, Markdown } from "./Markdown";
import { Modal } from "./Modal";
import { readFeatured, splitFeatured } from "./modelCatalog";
import { OllamaPanel } from "./OllamaPanel";
import { capSessions, deriveTitleFromText, formatRelativeDate, newSessionMeta, sortByRecent } from "./sessionStore";
import { SidebarSection } from "./SidebarSection";
import { useComposerLiveDraft } from "./useComposerLiveDraft";
import { useComposerUndo } from "./useComposerUndo";
import { useRovingFocus } from "./useRovingFocus";
import { useStickToBottom } from "./useStickToBottom";
import {
  DEFAULT_CLASSIFIER,
  maxRouteTier,
  mergeRoutingTable,
  readRoutingClassifier,
  readRoutingDebord,
  readRoutingSummarizer,
  readRoutingTable,
  ROUTE_TIERS,
} from "./routerAdmin";
import {
  chatAbort,
  chatSend,
  claudeAbort,
  claudePermission,
  claudeStart,
  contextCompact,
  isRouteTier,
  modelsDetail,
  modelsList,
  parseChatDone,
  parseClaudeDone,
  routerRoute,
  toRouteTarget,
  type ChatAttachment,
  type ChatMessage,
  type ChatUsage,
  type ModelInfo,
  type RequestMeta,
  type RouteDebord,
  type RouteTarget,
  type RouteTier,
} from "./sidecar";
import type { ProviderConfig } from "./providerAdmin";
import { stateRead, stateWrite } from "./stateClient";
import { TtsButton, VoiceButtons, VoiceStatus } from "./VoiceControls";
import {
  DEFAULT_CONVERSATION_SETTINGS,
  useVoiceComposer,
  type ConversationSettings,
} from "./useVoiceComposer";
import { recordModelUsage } from "./fableUsage";
import { subscribeProvidersPushed } from "./providersBus";
import { publishContext, registerCompactHandler } from "./contextBus";
import { notifyUsageChanged } from "./usageBus";

/*
 * Fournisseur spécial « Claude (abonnement) » : il ne passe pas par le moteur
 * neutre (chat.send) mais par le moteur Agent SDK en mode chat pur
 * (claude.start + chatOnly : tous les outils désactivés côté SDK).
 * L'historique vit dans la session SDK (resume), pas dans le payload.
 */
const CLAUDE_PROVIDER_ID = "claude-abonnement";
const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-fable-5" },
  { id: "claude-sonnet-5" },
  { id: "claude-opus-4-8" },
  { id: "claude-haiku-4-5" },
];

/*
 * R1/R7 — « Auto (routeur) » : valeur sentinelle du sélecteur de modèle,
 * DÉFAUT des NOUVELLES conversations. CHAQUE tour est classé par le routeur
 * du sidecar (router.route), sous un PLANCHER de session (`routedTier`) qui
 * ne descend jamais — le modèle ne change qu'à la hausse (voir
 * resolveAutoRoute) — un modèle explicite choisi = comportement strictement
 * inchangé.
 */
const AUTO_MODEL = "__auto__";

/*
 * R4 — économie de contexte du moteur NEUTRE (docs/spec-r4-contexte.md) : sur
 * les longues conversations, les anciens tours sont remplacés à l'envoi par un
 * résumé produit par un modèle local (`context.compact`), sans jamais toucher
 * à la transcription AFFICHÉE. Côté Claude : rien (compaction SDK existante).
 * Constantes et logique identiques à sidecar/src/context.ts, où les fonctions
 * pures (`shouldCompact`, `buildCompactedMessages`) sont testées — même
 * duplication assumée que la table de routage par défaut (routerAdmin.ts).
 */
/** Compacter dès que les tours non couverts par le résumé dépassent ce nombre. */
const COMPACT_UNCOVERED_TURNS_MAX = 30;
/** …ou dès que la taille estimée dépasse cette fraction du contexte du modèle. */
const COMPACT_CONTEXT_RATIO = 0.6;
/** Estimation grossière ~4 caractères par token (suffisante pour un seuil). */
const COMPACT_CHARS_PER_TOKEN = 4;
/** Les N derniers tours de la transcription restent TOUJOURS intacts. */
const COMPACT_KEEP_LAST = 10;
/** Préfixe du message-résumé injecté en tête de l'historique envoyé. */
const COMPACT_SUMMARY_PREFIX = "[Résumé de la conversation antérieure]";

/** R4 — état de compaction persisté d'une conversation (spec §2.1). */
interface ChatCompaction {
  summary: string;
  /** Le résumé couvre les tours [0, upToIndex) de la transcription. */
  upToIndex: number;
  /** Date ISO de la (re)compaction. */
  at: string;
}

/** Parsing défensif d'une compaction persistée — null si absente/corrompue. */
function toChatCompaction(value: unknown): ChatCompaction | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== "string" || !v.summary) return null;
  if (typeof v.upToIndex !== "number" || !Number.isFinite(v.upToIndex) || v.upToIndex <= 0) return null;
  return {
    summary: v.summary,
    upToIndex: Math.floor(v.upToIndex),
    at: typeof v.at === "string" ? v.at : "",
  };
}

/** R4 — décision de compaction : miroir de `shouldCompact` (sidecar/src/context.ts, testé là-bas). */
function shouldCompactChat(
  uncoveredTurns: number,
  estimatedChars: number,
  contextLength: number | null,
): boolean {
  if (uncoveredTurns > COMPACT_UNCOVERED_TURNS_MAX) return true;
  if (contextLength !== null && contextLength > 0) {
    return estimatedChars / COMPACT_CHARS_PER_TOKEN > COMPACT_CONTEXT_RATIO * contextLength;
  }
  return false;
}

type EntryStatus = "streaming" | "done" | "error" | "aborted";

interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: EntryStatus;
  errorMessage?: string;
  usage?: ChatUsage | null;
  /**
   * Occupation de la fenêtre de contexte au dernier appel API (moteur Claude) —
   * sert la jauge « Contexte ». Distincte de `usage`, qui ne porte que l'input
   * frais (hors cache) : la jauge s'appuie donc dessus en priorité. `null` côté
   * neutre ou pour les entrées d'avant ce champ.
   */
  contextTokens?: number | null;
  /** Pièces jointes du message utilisateur (voir Attachments.tsx). `previewUrl` absent après rechargement. */
  attachments?: SentAttachment[];
  /** R1 — tier du routeur quand ce tour a été envoyé en « Auto » (badge ⚡). */
  routeTier?: RouteTier;
  /** R1 — modèle cible du routage (badge) et raisons du classement (infobulle). */
  routeModel?: string;
  routeReasons?: string[];
}

/**
 * Ids d'entrées : PERSISTÉS avec la session (clés React du fil, cibles des
 * patchs `withAppendedDelta`/`withEntryDone`) — un compteur de module
 * repartirait de zéro à chaque lancement/HMR et ferait entrer en collision
 * une entrée neuve avec une entrée persistée (même défaut que `nextId` côté
 * AgentPage.tsx, constaté le 2026-08-04). D'où l'UUID.
 */
function nextEntryId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Construit le fil complet pour `chat.send`. Ordre STABLE, cache-friendly
 * (voir docs/protocol.md, `chat.send`) : system → résumé de compaction (R4,
 * s'il existe) → tours depuis `upToIndex` → nouveau message — les blocs
 * stables précèdent toujours les blocs variables. Sans compaction (`null`),
 * comportement strictement inchangé (conversations courtes, moteur Claude).
 * Miroir de `buildCompactedMessages` (sidecar/src/context.ts, testé là-bas).
 */
function toApiMessages(
  entries: ChatEntry[],
  systemPrompt: string,
  newUserContent: string,
  compaction: ChatCompaction | null = null,
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const trimmedSystem = systemPrompt.trim();
  if (trimmedSystem) messages.push({ role: "system", content: trimmedSystem });
  if (compaction) {
    messages.push({ role: "user", content: `${COMPACT_SUMMARY_PREFIX}\n${compaction.summary}` });
  }
  const turns = compaction ? entries.slice(compaction.upToIndex) : entries;
  for (const entry of turns) {
    if (entry.status === "error") continue;
    messages.push({ role: entry.role, content: entry.content });
  }
  messages.push({ role: "user", content: newUserContent });
  return messages;
}

// Helpers purs (hors du composant) pour garder les callbacks peu imbriqués,
// même esprit que withAppendedChunk/withStatus dans SystemPage.tsx.
function withAppendedDelta(entries: ChatEntry[], id: string, delta: string): ChatEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, content: e.content + delta } : e));
}

function withEntryDone(
  entries: ChatEntry[],
  id: string,
  aborted: boolean,
  usage: ChatUsage | null,
  contextTokens: number | null = null,
): ChatEntry[] {
  return entries.map((e) =>
    e.id === id ? { ...e, status: aborted ? "aborted" : "done", usage, contextTokens } : e,
  );
}

/**
 * Taille du contexte de la conversation, en tokens : prompt + complétion du
 * DERNIER tour ayant remonté un usage. Le prompt d'un tour contient déjà tout
 * l'historique envoyé (voir toApiMessages) — additionner les tours compterait
 * donc plusieurs fois les mêmes messages. `null` tant qu'aucun usage n'est
 * connu (fournisseur muet, session rechargée avant le premier tour).
 */
function contextTokens(entries: ChatEntry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    // Priorité à l'occupation réelle mesurée côté sidecar (moteur Claude, voir
    // ChatEntry.contextTokens) ; repli sur prompt + complétion (moteur neutre,
    // ou entrées d'avant ce champ).
    // Un total nul n'est pas une mesure (fournisseur muet, tour sans appel
    // modèle) : on continue de remonter plutôt que d'afficher une jauge à 0 %.
    if (typeof entry.contextTokens === "number" && entry.contextTokens > 0) return entry.contextTokens;
    if (entry.usage) {
      const total = (entry.usage.promptTokens ?? 0) + (entry.usage.completionTokens ?? 0);
      if (total > 0) return total;
    }
  }
  return null;
}

function withEntryError(entries: ChatEntry[], id: string, errorMessage: string): ChatEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, status: "error", errorMessage } : e));
}

/* ---------- Historique de sessions (Lot Sessions) ---------- */
/*
 * Persistance de la page Chat : clé dédiée `chat-conversations`, nouvelle
 * (la page ne persistait rien avant ce lot — pas de migration nécessaire,
 * contrairement à `project-conversations` côté AgentPage.tsx). Schéma :
 * `{ sessions: ChatSession[], activeId, openConversationIds }`, un seul
 * document (le Chat n'est pas scopé par projet). `openConversationIds`
 * (Lot Onglets multiples) : les conversations ouvertes en onglet, dans
 * l'ordre de la barre — les documents antérieurs à ce champ retombent sur
 * `[activeId]` (voir `sanitizeChatState`). `titleCustom` : `true` dès que
 * l'utilisateur a renommé la session — le titre auto (premier message
 * utilisateur) n'est alors plus jamais recalculé.
 */
const CHAT_STATE_KEY = "chat-conversations";
const MAX_PERSISTED_CHAT_ENTRIES = 200;
const MAX_CHAT_SESSIONS = 30;
const CHAT_SAVE_DEBOUNCE_MS = 1500;

interface ChatSession {
  id: string;
  title: string;
  titleCustom: boolean;
  createdAt: string;
  updatedAt: string;
  entries: ChatEntry[];
  providerId: string;
  model: string;
  systemPrompt: string;
  /** Session Agent SDK (fournisseur Claude (abonnement) uniquement) — `null` sinon/pas encore initialisée. */
  claudeSessionId: string | null;
  /** Recherche web (fournisseur Claude (abonnement) uniquement, voir docs/protocol.md `claude.start`). */
  webSearch: boolean;
  /** R7 — plancher de session du mode Auto (relevé à la hausse uniquement) + dernière cible utilisée (`null` sinon). */
  routedTier: RouteTier | null;
  routedTarget: RouteTarget | null;
  /** R4 — résumé de compaction du moteur neutre (`null` = envoi intégral). */
  compaction: ChatCompaction | null;
}

interface PersistedChatState {
  sessions: ChatSession[];
  activeId: string;
  /** Sessions ouvertes en onglet, dans l'ordre d'affichage de la barre. */
  openConversationIds: string[];
}

/**
 * État VIF d'une conversation ouverte en onglet — portage direct du
 * `ConvRuntime` de AgentPage.tsx, adapté aux champs du Chat. Ce qui était
 * mono-valué quand une seule conversation vivait à la fois (`entries`,
 * `claudeSessionId`, `streaming`, `draft`, `queuedPrompts`…) est désormais
 * porté ici, une instance par conversation ouverte : c'est ce qui permet à
 * un onglet d'arrière-plan de continuer à streamer pendant qu'on lit ou
 * qu'on écrit dans un autre.
 *
 * `activeIsClaude` fige le moteur RÉELLEMENT utilisé par le tour en cours :
 * le sélecteur de fournisseur ne concerne que la conversation active, mais
 * l'abandon (`handleAbort`) doit rester routé vers le bon moteur
 * (claude.abort vs chat.abort) même après une bascule d'onglet.
 */
interface ConvRuntime {
  entries: ChatEntry[];
  /** Id de session Agent SDK (`null` tant qu'aucun tour Claude n'a été envoyé). */
  claudeSessionId: string | null;
  streaming: boolean;
  /** Id de requête protocolaire du tour en cours (abandon), `null` hors streaming. */
  activeRequestId: string | null;
  activeIsClaude: boolean;
  /** Brouillon du composeur — par conversation : on peut taper dans l'une pendant que l'autre travaille. */
  draft: string;
  /** Prompts mis en file pendant un streaming, envoyés un par un (ordre d'arrivée) à la fin de chaque tour. */
  queuedPrompts: string[];
  /** R7 — plancher de session du mode Auto (miroir vif de `ChatSession.routedTier`/`routedTarget`). */
  routedTier: RouteTier | null;
  routedTarget: RouteTarget | null;
  /** Raisons du classement (infobulle des tours suivants) — non persistées. */
  routedReasons: string[] | null;
  /** R4 — compaction du moteur neutre (miroir vif de `ChatSession.compaction`). */
  compaction: ChatCompaction | null;
  /**
   * R3 — bandeau de débord du DERNIER tour envoyé (éphémère, jamais
   * persisté) : posé quand le tour a été débordé (`blocked: false`) ou bloqué
   * par le plafond (`blocked: true`), effacé dès qu'un tour part normalement.
   */
  debordNotice: DebordNotice | null;
  /**
   * « Arrêter » cliqué pendant la phase de PRÉ-ENVOI (routage Auto,
   * compaction — avant tout chat.send/claude.start) : le point de contrôle
   * de `handleSend` abandonne alors le tour proprement, sans envoi.
   */
  preSendAbort: boolean;
}

/** R3 — contenu du bandeau de débord (voir docs/spec-r3-debord.md §3). */
interface DebordNotice {
  blocked: boolean;
  fiveHourPct: number | null;
  /** Modèle payant réellement utilisé quand le débord est actif. */
  model: string;
  /** Plafond configuré (affiché quand le débord est bloqué), `null` = sans plafond. */
  plafondUsdMois: number | null;
  /** Vrai = cible de débord non déclarée dans la table des fournisseurs : tour resté sur l'abonnement. */
  unconfigured?: boolean;
}

function freshRuntime(
  entries: ChatEntry[] = [],
  claudeSessionId: string | null = null,
  routedTier: RouteTier | null = null,
  routedTarget: RouteTarget | null = null,
  compaction: ChatCompaction | null = null,
): ConvRuntime {
  return {
    entries,
    claudeSessionId,
    streaming: false,
    activeRequestId: null,
    activeIsClaude: false,
    draft: "",
    queuedPrompts: [],
    routedTier,
    routedTarget,
    routedReasons: null,
    compaction,
    debordNotice: null,
    preSendAbort: false,
  };
}

function freshChatSession(providerId: string): ChatSession {
  return {
    ...newSessionMeta(),
    entries: [],
    providerId,
    // R1 — « Auto (routeur) » par défaut pour toute NOUVELLE conversation ;
    // les conversations existantes conservent leur choix persisté.
    model: AUTO_MODEL,
    systemPrompt: "",
    claudeSessionId: null,
    // Défaut activé pour les nouvelles conversations (voir docs/protocol.md `claude.start`).
    webSearch: true,
    routedTier: null,
    routedTarget: null,
    compaction: null,
  };
}

/** `{kind,name}` seulement (voir `toAttachmentRefs`) — un `previewUrl` persisté par erreur reste toléré (ignoré à l'affichage). */
function isAttachmentRef(value: unknown): value is SentAttachment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.kind === "image" || v.kind === "text") && typeof v.name === "string";
}

function isChatEntry(value: unknown): value is ChatEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.role === "user" || v.role === "assistant") &&
    typeof v.content === "string" &&
    (v.status === "streaming" || v.status === "done" || v.status === "error" || v.status === "aborted") &&
    (v.attachments === undefined || (Array.isArray(v.attachments) && v.attachments.every(isAttachmentRef)))
  );
}

function isChatSession(value: unknown): value is ChatSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.titleCustom === "boolean" &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string" &&
    Array.isArray(v.entries) &&
    v.entries.every(isChatEntry) &&
    typeof v.providerId === "string" &&
    typeof v.model === "string" &&
    typeof v.systemPrompt === "string" &&
    (typeof v.claudeSessionId === "string" || v.claudeSessionId === null) &&
    typeof v.webSearch === "boolean" &&
    (v.routedTier === null || isRouteTier(v.routedTier)) &&
    (v.routedTarget === null || toRouteTarget(v.routedTarget) !== null) &&
    (v.compaction === null || toChatCompaction(v.compaction) !== null)
  );
}

/**
 * Complète `webSearch` (défaut `true`) sur une session brute qui ne l'a pas
 * encore (sessions persistées avant l'ajout de ce champ) — appliqué AVANT
 * `isChatSession`, qui lui exige le champ.
 */
function withWebSearchDefault(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (typeof v.webSearch === "boolean") return value;
  return { ...v, webSearch: true };
}

/**
 * R1 — complète/assainit `routedTier`/`routedTarget` (sessions persistées
 * avant ces champs, ou valeurs corrompues → `null`) — appliqué AVANT
 * `isChatSession`, même principe que `withWebSearchDefault`.
 */
function withRoutingDefaults(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  return {
    ...v,
    routedTier: isRouteTier(v.routedTier) ? v.routedTier : null,
    routedTarget: toRouteTarget(v.routedTarget),
  };
}

/**
 * R4 — complète/assainit `compaction` (sessions persistées avant ce champ, ou
 * valeur corrompue → `null` = envoi intégral, comportement d'avant) — appliqué
 * AVANT `isChatSession`, même principe que `withRoutingDefaults`.
 */
function withCompactionDefault(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  return { ...v, compaction: toChatCompaction(v.compaction) };
}

/**
 * Valide défensivement le document lu du disque — `null` si absent/corrompu
 * (première exécution après ce lot). `openConversationIds` : les documents
 * antérieurs au Lot Onglets multiples ne l'ont pas → `[activeId]` (une seule
 * conversation ouverte, comme avant) ; les références à des sessions
 * disparues (tombées hors plafond) sont filtrées, avec le même repli. La
 * session active est toujours garantie ouverte en onglet (le Chat n'a pas
 * d'onglets fichier : une active sans onglet n'aurait aucun sens ici).
 */
/**
 * Réattribue un id frais aux entrées dont l'id est déjà porté par une entrée
 * vue avant — `seen` est PARTAGÉ sur toutes les sessions du document (même
 * réparation inter-sessions que `dedupeTurnIds` côté AgentPage.tsx : le fil
 * rend toutes les conversations dans le même composant, une clé partagée
 * entre deux conversations fait réutiliser le DOM au changement d'onglet).
 * Ne réordonne ni ne supprime rien : les index restent stables, la
 * compaction (`upToIndex`) n'est pas affectée.
 */
function dedupeEntryIds(entries: ChatEntry[], seen: Set<string>): ChatEntry[] {
  return entries.map((e) => {
    const entry = seen.has(e.id) ? { ...e, id: nextEntryId(e.role === "user" ? "u" : "a") } : e;
    seen.add(entry.id);
    return entry;
  });
}

function sanitizeChatState(raw: unknown): PersistedChatState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (!Array.isArray(v.sessions) || v.sessions.length === 0) return null;
  const normalizedSessions = v.sessions
    .map(withWebSearchDefault)
    .map(withRoutingDefaults)
    .map(withCompactionDefault);
  if (!normalizedSessions.every(isChatSession) || typeof v.activeId !== "string") {
    return null;
  }
  const activeId = normalizedSessions.some((s) => s.id === v.activeId) ? v.activeId : normalizedSessions[0].id;
  const rawOpen =
    Array.isArray(v.openConversationIds) && v.openConversationIds.every((id): id is string => typeof id === "string")
      ? v.openConversationIds
      : [activeId];
  const knownOpen = rawOpen.filter((id) => normalizedSessions.some((s) => s.id === id));
  const openConversationIds = knownOpen.length > 0 ? knownOpen : [activeId];
  // Unicité GLOBALE des ids d'entrées, toutes sessions confondues (voir dedupeEntryIds).
  const seenEntryIds = new Set<string>();
  return {
    sessions: normalizedSessions.map((s) => ({ ...s, entries: dedupeEntryIds(s.entries, seenEntryIds) })),
    activeId,
    openConversationIds: openConversationIds.includes(activeId)
      ? openConversationIds
      : [...openConversationIds, activeId],
  };
}

/** Titre auto depuis le premier message utilisateur d'une session (voir sessionStore.ts). */
function deriveChatSessionTitle(entries: ChatEntry[]): string {
  const firstUser = entries.find((e) => e.role === "user");
  return deriveTitleFromText(firstUser?.content ?? "");
}

/**
 * Sérialise une session en vue de la persistance : borne aux 200 dernières
 * entrées, jamais un tour encore `streaming`, et — conformément au contrat —
 * les pièces jointes perdent leur aperçu (`toAttachmentRefs`) : seuls
 * `kind`/`name` survivent sur disque.
 */
function buildPersistedChatSession(session: ChatSession): ChatSession {
  const nonStreaming = session.entries.filter((e) => e.status !== "streaming");
  const persistableEntries = nonStreaming
    .slice(-MAX_PERSISTED_CHAT_ENTRIES)
    .map((e) => (e.attachments ? { ...e, attachments: toAttachmentRefs(e.attachments) } : e));
  // R4 — la troncature aux 200 dernières entrées décale les index de la
  // transcription : `upToIndex` est réaligné (et borné) pour que le résumé
  // couvre toujours les MÊMES tours après rechargement ; s'il ne couvre plus
  // rien (tours résumés tous tombés hors plafond), la compaction est oubliée.
  let compaction = session.compaction;
  if (compaction) {
    const dropped = nonStreaming.length - persistableEntries.length;
    const upToIndex = Math.min(compaction.upToIndex - dropped, persistableEntries.length);
    compaction = upToIndex > 0 ? { ...compaction, upToIndex } : null;
  }
  return {
    ...session,
    entries: persistableEntries,
    compaction,
    title: session.titleCustom ? session.title : deriveChatSessionTitle(persistableEntries),
  };
}

/**
 * Sérialise le document complet : plafonne le nombre de sessions conservées
 * (voir `capSessions`, sessionStore.ts) — `openConversationIds` est filtré en
 * cohérence (jamais une référence à une session tombée hors plafond), avec un
 * repli sur `[activeId]` si ce filtrage le viderait entièrement (jamais zéro
 * onglet persisté alors qu'une session active existe).
 */
function buildPersistedChatState(state: PersistedChatState): PersistedChatState {
  const keptSessions = capSessions(state.sessions, state.activeId, MAX_CHAT_SESSIONS);
  const keptIds = new Set(keptSessions.map((s) => s.id));
  const openConversationIds = state.openConversationIds.filter((id) => keptIds.has(id));
  return {
    sessions: keptSessions.map(buildPersistedChatSession),
    activeId: state.activeId,
    openConversationIds: openConversationIds.length > 0 ? openConversationIds : [state.activeId],
  };
}

/** Mémoïsé : seules les entrées dont l'objet change re-rendent (le brouillon
    du composeur vit dans l'état de la page — sans memo, chaque frappe
    re-rendait toutes les bulles, markdown compris). */
const ChatBubble = memo(function ChatBubble({ entry }: Readonly<{ entry: ChatEntry }>) {
  const roleClass = entry.role === "user" ? "chat-bubble--user" : "chat-bubble--assistant";
  return (
    <div className={`chat-bubble ${roleClass}`}>
      <div className="chat-bubble__content">
        {/* Rendu Markdown pour l'assistant uniquement — l'utilisateur reste en
            texte brut pre-wrap. En streaming, une fence de code encore ouverte
            est refermée pour le rendu (stabilité du parse — voir Markdown.tsx). */}
        {entry.role === "assistant" ? (
          <Markdown content={entry.status === "streaming" ? closeDanglingFence(entry.content) : entry.content} />
        ) : (
          entry.content
        )}
        {entry.status === "streaming" && <span className="cursor" />}
      </div>
      {entry.attachments && entry.attachments.length > 0 && <SentAttachments items={entry.attachments} />}
      {entry.status === "error" && (
        <div className="chat-bubble__error">Erreur : {entry.errorMessage}</div>
      )}
      {entry.status === "aborted" && <div className="chat-bubble__note">Réponse interrompue.</div>}
      {entry.status === "done" && entry.usage && (
        <div className="chat-bubble__usage">
          {entry.usage.promptTokens ?? "?"} + {entry.usage.completionTokens ?? "?"} tokens
        </div>
      )}
      {/* R1 — badge des tours envoyés en « Auto » : tier → modèle, raisons en infobulle. */}
      {entry.routeTier && entry.routeModel && (
        <div className="chat-bubble__route" title={(entry.routeReasons ?? []).join(" · ")}>
          ⚡ auto : {entry.routeTier} → {entry.routeModel}
        </div>
      )}
      {entry.role === "assistant" && entry.status === "done" && entry.content.trim() && (
        <TtsButton text={entry.content} />
      )}
    </div>
  );
});

export interface ChatPageHandle {
  /**
   * Raccourci global Ctrl+N (voir App.tsx) : nouvelle conversation. Renvoie
   * `false` si refusée — l'appelant reste alors silencieux, comme le bouton
   * correspondant. (Avec les onglets multiples, créer une conversation
   * pendant qu'une autre streame est désormais permis.)
   */
  newSession: () => boolean;
  /**
   * Raccourci global Ctrl+K (voir App.tsx) : vide les messages de la session
   * ACTIVE sans en créer de nouvelle. Renvoie `false` si refusée (run en
   * cours) — la confirmation destructive est à la charge de l'appelant.
   */
  clearConversation: () => boolean;
  /**
   * Un tour est-il en cours dans la conversation ACTIVE ? Consultée par
   * App.tsx AVANT d'afficher la confirmation de Ctrl+K — un run en cours
   * doit rester un no-op totalement silencieux (aucune modale), pas juste
   * un clic sans effet.
   */
  isStreaming: () => boolean;
  /** Place le curseur dans le composeur (arrivée sur la page, vidage, nouvelle conversation). */
  focusComposer: () => void;
}

export const ChatPage = forwardRef<
  ChatPageHandle,
  Readonly<{
    providers: ProviderConfig[];
    /** Micro choisi dans Configuration › Dictée (vide = défaut système). */
    micDeviceId?: string;
    /** Réglages « Mode conversation » de la config voix (défauts si absents). */
    conversationConfig?: ConversationSettings;
    /**
     * Cette page est-elle celle affichée ? Les six pages restent montées en
     * permanence (voir App.tsx) : la voix a besoin de savoir qu'on l'a quittée
     * pour refermer le micro (voir useVoiceComposer.ts), et l'écouteur clavier
     * local des onglets (Ctrl+Tab/Ctrl+Suppr) ne doit réagir que quand cette
     * page est visible.
     */
    pageVisible?: boolean;
  }>
>(function ChatPage(
  { providers, micDeviceId = "", conversationConfig = DEFAULT_CONVERSATION_SETTINGS, pageVisible = true },
  ref,
) {
  // Config LLM de la conversation ACTIVE (fournisseur/modèle/prompt système/
  // recherche web) : rechargée à chaque bascule d'onglet (voir
  // `selectChatSession`), verrouillée pendant que SA conversation streame —
  // les autres onglets restent librement consultables/éditables.
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsState, setModelsState] = useState<"idle" | "loading" | "error">("idle");
  const [modelsError, setModelsError] = useState("");
  // Favoris du fournisseur courant (fournisseurs neutres uniquement, voir modelCatalog.ts) :
  // remontés en tête du sélecteur de modèle, préfixés « ★ ».
  const [featuredIds, setFeaturedIds] = useState<string[]>([]);

  const [systemPrompt, setSystemPrompt] = useState("");
  // Recherche web (fournisseur Claude (abonnement) uniquement) — activée par
  // défaut pour les nouvelles conversations, persistée par session.
  const [webSearch, setWebSearch] = useState(true);

  // Sauvegarde de la dernière conversation vidée (Ctrl+K) + bandeau d'annulation.
  // `sessionUiId` identifie LA session vidée : « Annuler » restaure dans
  // celle-là précisément, jamais dans la session active du moment (qui a pu
  // changer entre-temps — vider puis créer une session neuve puis Annuler
  // réinjectait les anciens messages dans la neuve).
  const clearedBackupRef = useRef<{
    sessionUiId: string;
    entries: ChatEntry[];
    claudeSessionId: string | null;
    /** R1 — affinité de session du mode Auto, restaurée avec les messages. */
    routedTier: RouteTier | null;
    routedTarget: RouteTarget | null;
    /** R4 — compaction de la conversation vidée, restaurée avec les messages. */
    compaction: ChatCompaction | null;
  } | null>(null);
  const [clearedNotice, setClearedNotice] = useState(false);
  // Composeur : le curseur y est placé à l'arrivée sur la page, après un
  // vidage et après une nouvelle conversation (voir focusComposer).
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Historique de sessions (Lot Sessions) : `sessions` porte la dernière
  // copie CONNUE des champs lourds de chaque conversation ; les conversations
  // OUVERTES en onglet ont, elles, un runtime vif dans `runtimesRef` qui
  // prime — voir `buildLiveSessions`, qui recombine les deux à chaque
  // sauvegarde.
  const [sessions, setSessionsState] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string>("");
  /*
   * Miroirs SYNCHRONES (même patron qu'AgentPage) : `buildLiveSessions` les
   * lit au lieu de l'état fermé dans la closure. Sans cela, la sauvegarde de
   * fin de tour — qui s'exécute longtemps après son `handleSend` — repartait
   * d'un `sessions` PÉRIMÉ et le réécrivait : toute conversation créée
   * pendant le tour disparaissait de la liste, donc son ONGLET aussi.
   */
  const sessionsRef = useRef<ChatSession[]>([]);
  const activeSessionIdRef = useRef<string>("");
  function setSessions(next: ChatSession[] | ((prev: ChatSession[]) => ChatSession[])) {
    const value = typeof next === "function" ? next(sessionsRef.current) : next;
    sessionsRef.current = value;
    setSessionsState(value);
  }
  function setActiveSessionId(next: string) {
    activeSessionIdRef.current = next;
    setActiveSessionIdState(next);
  }
  const chatInitRef = useRef(false);
  const chatHydratedRef = useRef(false);

  /*
   * ---------- Runtime vif PAR CONVERSATION (Lot Onglets multiples) ----------
   *
   * `ConvRuntime` remplace les anciens `entries`/`claudeSessionRef`/
   * `streaming`/`activeRequestId`/`draft`/`queuedPrompts` mono-valués : chaque
   * conversation OUVERTE (voir `openConversationIds` plus bas) a désormais
   * son propre runtime, qui continue d'évoluer même quand son onglet n'est
   * pas affiché — c'est ce qui permet à un tour de streamer en arrière-plan.
   *
   * Stocké dans une Map en `ref` (pas en `useState`) : les callbacks de
   * streaming (`onDelta`, `onInit`… dans `handleSend`/`sendViaClaude`)
   * CAPTURENT l'id de la conversation par fermeture, exactement comme elles
   * capturent déjà `assistantId` — elles écrivent donc toujours dans la bonne
   * conversation via `updateRuntime(convId, …)`, quel que soit l'onglet
   * affiché au moment où le chunk arrive. `runtimeTick` est le seul bout
   * d'état React de ce mécanisme : il force un nouveau rendu à chaque
   * mutation (n'importe quelle conversation), pour que le point « ● » d'un
   * onglet en arrière-plan et le contenu affiché de la conversation active
   * restent à jour — la DONNÉE elle-même vit dans `runtimesRef.current`, lue
   * à chaque rendu (`getRuntime`), jamais dans un `useState` séparé (qui
   * imposerait de recréer la Map entière à chaque delta de streaming).
   */
  const runtimesRef = useRef<Map<string, ConvRuntime>>(new Map());
  const [runtimeTick, setRuntimeTick] = useState(0);

  /** Runtime vif d'une conversation — créé vierge à la volée si absent (première fois qu'on le lit). */
  function getRuntime(convId: string): ConvRuntime {
    let r = runtimesRef.current.get(convId);
    if (!r) {
      r = freshRuntime();
      runtimesRef.current.set(convId, r);
    }
    return r;
  }

  /**
   * Amorce le runtime d'une conversation depuis sa dernière copie connue
   * (`ChatSession.entries`/`claudeSessionId`) SI elle n'a encore jamais été
   * ouverte cette exécution — ne touche jamais un runtime déjà vivant (une
   * conversation en cours de streaming ne doit jamais être réinitialisée par
   * une réouverture de son onglet).
   */
  function ensureRuntime(
    session: Pick<
      ChatSession,
      "id" | "entries" | "claudeSessionId" | "routedTier" | "routedTarget" | "compaction"
    >,
  ) {
    if (!runtimesRef.current.has(session.id)) {
      runtimesRef.current.set(
        session.id,
        freshRuntime(
          session.entries,
          session.claudeSessionId,
          session.routedTier,
          session.routedTarget,
          session.compaction,
        ),
      );
    }
  }

  /** Écrit dans le runtime d'UNE conversation précise et force un nouveau rendu (voir le commentaire ci-dessus). */
  function updateRuntime(convId: string, updater: (prev: ConvRuntime) => ConvRuntime) {
    runtimesRef.current.set(convId, updater(getRuntime(convId)));
    setRuntimeTick((t) => t + 1);
  }

  /** Variante ciblée sur les entrées — remplace l'ancien `setEntries` mono-conversation, désormais paramétré par `convId`. */
  function updateEntriesFor(convId: string, updater: (prev: ChatEntry[]) => ChatEntry[]) {
    updateRuntime(convId, (r) => ({ ...r, entries: updater(r.entries) }));
  }

  // `runtimeTick` n'est lu nulle part d'autre : cette ligne est la SEULE
  // dépendance de rendu sur ce compteur, ce qui suffit à ce que React
  // reprogramme un rendu à chaque mutation de n'importe quel runtime.
  void runtimeTick;

  // Copie VIVE de la conversation ACTIVE (celle affichée/éditée) — dérivée du
  // runtime à CHAQUE rendu, plus un `useState` séparé : `activeSessionId`
  // pilote déjà le rendu, `runtimeTick` couvre les mutations de streaming.
  const activeRuntime = activeSessionId ? getRuntime(activeSessionId) : freshRuntime();
  const entries = activeRuntime.entries;
  const streaming = activeRuntime.streaming;
  const draft = activeRuntime.draft;
  const queuedPrompts = activeRuntime.queuedPrompts;
  // R3 — bandeau de débord de la conversation ACTIVE (voir DebordNotice).
  const debordNotice = activeRuntime.debordNotice;
  // R4 — compaction de la conversation ACTIVE (indicateur + modale du résumé).
  const activeCompaction = activeRuntime.compaction;

  /** Brouillon : toujours celui de la conversation ACTIVE — seule celle-ci a un composeur affiché. */
  function setDraft(value: string) {
    if (activeSessionId) updateRuntime(activeSessionId, (r) => ({ ...r, draft: value }));
  }
  /** Brouillon VIF de la conversation active (le runtime, jamais la valeur de rendu — voir useComposerLiveDraft.ts). */
  function getLiveDraft(): string {
    return activeSessionId ? getRuntime(activeSessionId).draft : "";
  }
  // Frappe fluide : écriture silencieuse dans le runtime + re-rendu de
  // rattrapage débouncé, au lieu d'un re-rendu de page par caractère.
  const { onComposerChange, onComposerBlur } = useComposerLiveDraft({
    textareaRef,
    draft,
    writeDraft: (value) => {
      if (activeSessionId) runtimesRef.current.set(activeSessionId, { ...getRuntime(activeSessionId), draft: value });
    },
    tick: () => setRuntimeTick((t) => t + 1),
  });
  // Ctrl+Z/Ctrl+Maj+Z dans le composeur : pile d'annulation maison, le natif
  // étant cassé par les écritures programmatiques du brouillon (voir useComposerUndo.ts).
  const { handleUndoKey } = useComposerUndo(activeSessionId, getLiveDraft, setDraft);
  /** File d'attente de la conversation ACTIVE : retire le message à l'index donné (pastille d'annulation). */
  function removeQueuedPrompt(index: number) {
    if (activeSessionId)
      updateRuntime(activeSessionId, (r) => ({
        ...r,
        queuedPrompts: r.queuedPrompts.filter((_, i) => i !== index),
      }));
  }

  // Miroir toujours à jour des entrées AFFICHÉES, pour les callbacks de la
  // voix (voir useVoiceComposer plus bas) : elles lisent le fil au moment où
  // elles s'exécutent, pas celui figé à la pose du hook.
  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  /** Conversations ouvertes en onglet, dans l'ordre d'affichage de la barre. */
  const [openConversationIds, setOpenConversationIdsState] = useState<string[]>([]);
  const openConversationIdsRef = useRef(openConversationIds);
  /**
   * Écrit l'état ET la ref de façon SYNCHRONE : `persistChatState` lit la ref
   * juste après l'appel (même tour de boucle), un miroir par `useEffect`
   * arriverait trop tard et persisterait la liste d'onglets d'AVANT la
   * fermeture/l'ouverture.
   */
  function setOpenConversationIds(next: string[] | ((prev: string[]) => string[])) {
    const value = typeof next === "function" ? next(openConversationIdsRef.current) : next;
    openConversationIdsRef.current = value;
    setOpenConversationIdsState(value);
  }

  // Messages de refus de la barre d'onglets (fermeture/vidage refusés pendant
  // un streaming…) : un refus silencieux au clavier serait invisible — même
  // rôle que `openFilesNotice` côté AgentPage.tsx.
  const [tabsNotice, setTabsNotice] = useState<string | null>(null);

  // R4 — modale du résumé de compaction (conversation ACTIVE uniquement) et
  // verrou du bouton « Recompacter » pendant qu'un résumé est en cours.
  const [compactionModalOpen, setCompactionModalOpen] = useState(false);
  const [recompacting, setRecompacting] = useState(false);

  // R4 — cache mémoire des `contextLength` connus, par fournisseur puis par
  // modèle (`models.detail`, best effort : un fournisseur muet — Ollama — ou
  // en erreur donne une table vide, le seuil tours s'applique alors seul).
  const contextLengthsRef = useRef<Map<string, Map<string, number>>>(new Map());

  // Pièces jointes du composeur (voir Attachments.tsx) — purgées DÈS L'ENVOI
  // (voir `handleSend`) et reposées si le tour échoue, pour éviter d'avoir à
  // tout rejoindre.
  const {
    attachments,
    addFiles,
    beginImage,
    resolveImage,
    removeAttachment,
    clear: clearAttachments,
    restore: restoreAttachments,
    error: attachmentsError,
    setError: setAttachmentsError,
  } = useAttachmentDraft();
  const [composerDragOver, setComposerDragOver] = useState(false);
  // Au moins une image collée encore en cours d'encodage : l'envoi doit attendre.
  const attachmentsPending = attachments.some((a) => a.loading);

  // Section « Historique » du panneau latéral (état ouvert/replié géré par
  // SidebarSection lui-même, persisté sous l'id "chat-history").
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionTitle, setEditingSessionTitle] = useState("");
  const sessionTitleSkipBlurRef = useRef(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const isClaude = providerId === CLAUDE_PROVIDER_ID;

  /**
   * Recombine les sessions avec les runtimes VIFS de toutes les conversations
   * ouvertes en onglet — plus seulement de l'active : avec les onglets
   * multiples, plusieurs conversations peuvent avoir avancé (streaming
   * d'arrière-plan) depuis la dernière sauvegarde, et les oublier ici
   * perdrait leurs messages. Les conversations sans runtime (jamais ouvertes
   * cette exécution) sont laissées telles quelles. La config LLM (fournisseur/
   * modèle/prompt système/recherche web) n'est éditable que pour la
   * conversation active : elle n'est écrasée que pour celle-là. Le titre auto
   * (non personnalisé) est recalculé au passage.
   */
  function buildLiveSessions(): ChatSession[] {
    // Lecture par REF (voir sessionsRef) : appelée depuis des callbacks longs,
    // cette fonction doit repartir de la liste À JOUR.
    const activeId = activeSessionIdRef.current;
    return sessionsRef.current.map((s) => {
      const runtime = runtimesRef.current.get(s.id);
      if (!runtime) return s;
      const merged: ChatSession = {
        ...s,
        entries: runtime.entries,
        claudeSessionId: runtime.claudeSessionId,
        // R1 — l'affinité de session vit dans le runtime (posée au premier
        // envoi routé, effacée par un override) : recopiée pour persistance.
        routedTier: runtime.routedTier,
        routedTarget: runtime.routedTarget,
        // R4 — la compaction vit aussi dans le runtime : recopiée pareil.
        compaction: runtime.compaction,
        ...(s.id === activeId ? { providerId, model, systemPrompt, webSearch } : {}),
        updatedAt: new Date().toISOString(),
      };
      return merged.titleCustom ? merged : { ...merged, title: deriveChatSessionTitle(merged.entries) };
    });
  }

  /** Écrit le document complet persisté (best effort, no-op tant que non hydraté). */
  function persistChatState(liveSessions: ChatSession[], activeId: string) {
    if (!chatHydratedRef.current) return;
    void stateWrite(
      CHAT_STATE_KEY,
      buildPersistedChatState({
        sessions: liveSessions,
        activeId,
        openConversationIds: openConversationIdsRef.current,
      }),
    ).catch(() => {
      // best effort : une écriture ratée ne bloque pas l'UI, la prochaine sauvegarde retentera.
    });
  }

  // Chargement du document persisté, une seule fois (StrictMode-safe, même
  // pattern que AgentPage.tsx). `null` (première exécution après ce lot, ou
  // document corrompu) : on démarre d'une session vierge plutôt que
  // d'attendre — rien à restaurer de toute façon. Les runtimes des
  // conversations ouvertes en onglet sont amorcés depuis leur copie persistée.
  useEffect(() => {
    if (chatInitRef.current) return;
    chatInitRef.current = true;
    const startFresh = () => {
      const fresh = freshChatSession(providerId);
      runtimesRef.current.set(fresh.id, freshRuntime());
      setSessions([fresh]);
      setActiveSessionId(fresh.id);
      setOpenConversationIds([fresh.id]);
      // R1 — nouvelle conversation = « Auto (routeur) » par défaut.
      setModel(AUTO_MODEL);
    };
    stateRead<unknown>(CHAT_STATE_KEY)
      .then((raw) => {
        const restored = sanitizeChatState(raw);
        if (restored) {
          const activeSession = restored.sessions.find((s) => s.id === restored.activeId) ?? restored.sessions[0];
          for (const s of restored.sessions) {
            if (restored.openConversationIds.includes(s.id)) ensureRuntime(s);
          }
          setSessions(restored.sessions);
          setActiveSessionId(activeSession.id);
          setOpenConversationIds(restored.openConversationIds);
          setProviderId(activeSession.providerId);
          setModel(activeSession.model);
          setSystemPrompt(activeSession.systemPrompt);
          setWebSearch(activeSession.webSearch);
        } else {
          startFresh();
        }
      })
      .catch(() => {
        startFresh();
      })
      .finally(() => {
        chatHydratedRef.current = true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sauvegarde débouncée (~1,5 s) après tout changement pertinent de la
  // conversation affichée (les conversations d'arrière-plan sont couvertes
  // par la sauvegarde immédiate de fin de tour dans `handleSend`).
  useEffect(() => {
    if (!activeSessionId) return;
    const timer = window.setTimeout(() => {
      const liveSessions = buildLiveSessions();
      setSessions(liveSessions);
      persistChatState(liveSessions, activeSessionId);
    }, CHAT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, entries, providerId, model, systemPrompt, webSearch, openConversationIds]);

  // Sélectionne (ou re-sélectionne si le fournisseur courant a disparu) un
  // fournisseur par défaut dès que la liste est disponible. « Claude
  // (abonnement) » est toujours proposé, même sans fournisseur configuré.
  useEffect(() => {
    const ids = [...providers.map((p) => p.id), CLAUDE_PROVIDER_ID];
    if (!ids.includes(providerId)) {
      setProviderId(ids[0]);
    }
  }, [providers, providerId]);

  /** Numéro du dernier chargement de modèles lancé — voir `loadModels`. */
  const dernierChargementModeles = useRef(0);

  const loadModels = useCallback(async (pid: string) => {
    if (!pid) return;
    if (pid === CLAUDE_PROVIDER_ID) {
      setModels(CLAUDE_MODELS);
      setModelsState("idle");
      setModelsError("");
      // R1 — la sentinelle « Auto » est toujours un choix valide, à préserver.
      setModel((prev) => (prev === AUTO_MODEL || CLAUDE_MODELS.some((m) => m.id === prev) ? prev : CLAUDE_MODELS[0].id));
      return;
    }
    setModelsState("loading");
    setModelsError("");
    // Marque de fraîcheur : seule la DERNIÈRE demande a le droit d'écrire.
    // Sans elle, deux chargements en vol se résolvaient dans l'ordre de leurs
    // réseaux, pas dans celui des clics : choisir Ollama (lent) puis
    // OpenRouter faisait arriver OpenRouter en premier, puis Ollama écrasait
    // la liste ET le modèle sélectionné. L'envoi suivant partait alors avec un
    // modèle inconnu du fournisseur choisi, et le sélecteur affichait la liste
    // d'un autre.
    const demande = ++dernierChargementModeles.current;
    const estPerimee = () => demande !== dernierChargementModeles.current;
    try {
      const list = await modelsList(pid);
      if (estPerimee()) return;
      setModels(list);
      setModelsState("idle");
      // R1 — même préservation de la sentinelle « Auto » que côté Claude.
      setModel((prev) => (prev === AUTO_MODEL || list.some((m) => m.id === prev) ? prev : (list[0]?.id ?? "")));
    } catch (err) {
      if (estPerimee()) return;
      setModels([]);
      setModelsState("error");
      setModelsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (providerId) void loadModels(providerId);
    // Relance quand la table des fournisseurs atteint (enfin) le sidecar : au
    // démarrage, ce premier chargement part souvent avant providers.set et
    // échoue en « fournisseur inconnu ».
    const off = subscribeProvidersPushed(() => {
      if (providerId) void loadModels(providerId);
    });
    return off;
  }, [providerId, loadModels]);

  // Favoris : indépendant du fournisseur Claude (abonnement), qui n'a pas de favoris.
  useEffect(() => {
    if (!providerId || isClaude) {
      setFeaturedIds([]);
      return;
    }
    readFeatured(providerId)
      .then(setFeaturedIds)
      .catch(() => setFeaturedIds([]));
  }, [providerId, isClaude]);

  const featuredModels = splitFeatured(models, featuredIds);

  // Recollage en bas du fil : voir useStickToBottom.ts (logique partagée avec
  // AgentPage — l'intention de l'utilisateur prime sur la position).
  const { scrollRef, scrollProps, collerEnBas } = useStickToBottom(entries);

  /**
   * Tour de chat via le moteur Agent SDK en mode chat pur (fournisseur
   * Claude). `convId` : conversation propriétaire du tour — tous les
   * callbacks écrivent dans SON runtime, jamais dans « l'active » (voir
   * `handleSend`).
   */
  function sendViaClaude(
    convId: string,
    content: string,
    onDelta: (delta: string) => void,
    attachments: ChatAttachment[] | undefined,
    webSearchEnabled: boolean,
    // R1 — modèle effectif du tour (celui du sélecteur, ou la cible routée en
    // mode Auto) et meta (porte routeTier quand le tour a été routé).
    modelId: string,
    meta: RequestMeta,
  ) {
    const handle = claudeStart(
      {
        prompt: content,
        chatOnly: true,
        webSearch: webSearchEnabled,
        // Session SDK de CETTE conversation (celle dérivée de l'active serait
        // la mauvaise si l'utilisateur a changé d'onglet).
        sessionId: getRuntime(convId).claudeSessionId,
        model: modelId,
        systemPrompt: systemPrompt.trim() || null,
        attachments,
        meta,
      },
      {
        onInit: (sessionId) => {
          updateRuntime(convId, (r) => ({ ...r, claudeSessionId: sessionId }));
        },
        onText: onDelta,
        // Recherche web active : accord automatique pour WebSearch/WebFetch
        // (seuls outils exposés côté SDK en mode chatOnly+webSearch) ; refus
        // automatique de tout le reste, comme avant (voir docs/protocol.md).
        onPermissionRequest: (permissionId, toolName) => {
          const allow = webSearchEnabled && (toolName === "WebSearch" || toolName === "WebFetch");
          if (allow) {
            void claudePermission(handle.id, permissionId, "allow");
          } else {
            void claudePermission(handle.id, permissionId, "deny", "Mode chat : outils désactivés");
          }
        },
      },
    );
    return handle;
  }

  /** R1 — cible utilisable : moteur Claude (toujours disponible) ou fournisseur déclaré. */
  function isUsableTarget(target: RouteTarget): boolean {
    return target.engine === "claude" || providers.some((p) => p.id === target.providerId);
  }

  /**
   * R1/R7 — résout la cible d'un tour « Auto » : CHAQUE tour est routé par
   * `router.route` (heuristique, ~0 ms), avec pour `minTier` le PLANCHER DE
   * SESSION (`routedTier`, absent au premier tour) — le tier effectif ne
   * descend jamais, il ne peut que monter (spec-r7-topdown §B). Le plancher
   * n'est relevé qu'au premier signe de succès du tour (`commitAffinity`,
   * voir `handleSend`). Repli si la cible neutre référence un fournisseur
   * absent de la table déclarée : tier supérieur (trivial→simple→moyen→
   * complexe), premier utilisable ; si aucun ne l'est, la cible d'origine est
   * gardée et l'erreur habituelle du moteur s'affichera dans la bulle.
   *
   * R3 — débord d'abonnement : re-vérifié à CHAQUE tour, par ce même appel
   * `router.route`. Un tour débordé/bloqué ne relève JAMAIS le plancher : la
   * conversation re-route normalement dès que la fenêtre se rouvre.
   */
  async function resolveAutoRoute(
    convId: string,
    content: string,
    historyEntries: ChatEntry[],
    attachmentsCount: number,
  ): Promise<{
    tier: RouteTier;
    target: RouteTarget;
    reasons: string[];
    debord: RouteDebord | null;
    /** Plancher à relever au PREMIER signe de succès du tour (voir `handleSend`) — jamais posé ici. */
    pendingAffinity: boolean;
    /** Débord annulé : sa cible référence un fournisseur non déclaré (bandeau dédié, tour sur l'abonnement). */
    debordUnconfigured: boolean;
  }> {
    // R7 — plancher de session : appliqué côté sidecar via `minTier`.
    const floorTier = getRuntime(convId).routedTier;
    const historyTurns = historyEntries.filter((e) => e.role === "user").length;
    const routed = await routerRoute({
      text: content,
      ...(historyTurns > 0 ? { historyTurns } : {}),
      ...(attachmentsCount > 0 ? { attachmentsCount } : {}),
      ...(floorTier ? { minTier: floorTier } : {}),
    });

    let tier = routed.tier;
    let target = routed.target;
    let debord = routed.debord;
    const reasons = [...routed.reasons];
    let debordUnconfigured = false;
    // Débord actif vers un fournisseur NON déclaré : jamais d'envoi vers un
    // provider inconnu — repli sur la cible abonnement d'origine (table du
    // tier), débord annulé, bandeau dédié.
    if (debord?.active && !isUsableTarget(target)) {
      target = mergeRoutingTable(await readRoutingTable())[tier];
      reasons.push("cible de débord non configurée : envoi sur l'abonnement");
      debord = null;
      debordUnconfigured = true;
    }
    // R3 — cible de débord/repli plafond : pas de repli tier supérieur (elle
    // ne vient pas de la table), l'erreur moteur habituelle s'afficherait.
    if (!debord && !isUsableTarget(target)) {
      const table = mergeRoutingTable(await readRoutingTable());
      for (let i = ROUTE_TIERS.indexOf(routed.tier) + 1; i < ROUTE_TIERS.length; i++) {
        const candidate = table[ROUTE_TIERS[i]];
        if (isUsableTarget(candidate)) {
          reasons.push(`repli : fournisseur « ${target.providerId ?? "?"} » absent`);
          tier = ROUTE_TIERS[i];
          target = candidate;
          break;
        }
      }
    }

    // R3/R7 — un tour débordé/bloqué ne relève PAS le plancher de session.
    // Un tour normal, lui, ne le relève pas ICI mais au premier signe de
    // succès (`pendingAffinity`, voir `handleSend`) — un tour routé qui
    // échoue (cible éteinte…) ne doit jamais relever le plancher pour rien.
    return { tier, target, reasons, debord, pendingAffinity: !debord, debordUnconfigured };
  }

  /**
   * R3 — pose/efface le bandeau de débord de la conversation d'après la
   * résolution du tour qui part ; le plafond configuré n'est lu (best effort)
   * que pour le libellé du bandeau « bloqué ». `unconfigured` : cible de
   * débord non déclarée — bandeau dédié, le tour part sur l'abonnement
   * (voir `resolveAutoRoute`).
   */
  async function applyDebordNotice(
    convId: string,
    debord: RouteDebord | null,
    model: string,
    unconfigured = false,
  ): Promise<void> {
    if (unconfigured) {
      updateRuntime(convId, (r) => ({
        ...r,
        debordNotice: { blocked: false, fiveHourPct: null, model, plafondUsdMois: null, unconfigured: true },
      }));
      return;
    }
    if (!debord) {
      updateRuntime(convId, (r) => (r.debordNotice ? { ...r, debordNotice: null } : r));
      return;
    }
    let plafondUsdMois: number | null = null;
    if (debord.blocked) {
      // `null` = bascule payante désactivée (le sidecar ne devrait alors
      // jamais signaler de débord, mais on reste défensif).
      plafondUsdMois = await readRoutingDebord()
        .then((d) => d?.plafondUsdMois ?? null)
        .catch(() => null);
    }
    updateRuntime(convId, (r) => ({
      ...r,
      debordNotice: { blocked: debord.blocked, fiveHourPct: debord.fiveHourPct, model, plafondUsdMois },
    }));
  }

  /* ---------- R4 — économie de contexte du moteur neutre ---------- */

  /** `contextLength` du modèle (tokens) via le cache `models.detail`, `null` si inconnu. */
  async function providerContextLength(pid: string, modelId: string): Promise<number | null> {
    let table = contextLengthsRef.current.get(pid);
    if (!table) {
      try {
        const details = await modelsDetail(pid);
        table = new Map(
          details
            .filter((d): d is typeof d & { contextLength: number } => d.contextLength !== undefined)
            .map((d) => [d.id, d.contextLength]),
        );
      } catch {
        // Fournisseur injoignable/muet : table vide mémorisée, seuil tours seul.
        table = new Map();
      }
      contextLengthsRef.current.set(pid, table);
    }
    return table.get(modelId) ?? null;
  }

  /**
   * R4 — cible du résumé (spec §2.2) : `routing.summarizer` prime — objet =
   * cible dédiée du résumeur, `null` = compaction automatique DÉSACTIVÉE
   * (aucun nouveau résumé ; un résumé existant reste appliqué/consultable),
   * absent = comportement historique (`routing.classifier` si défini, sinon
   * le défaut ollama·qwen3.5:4b — d'où ce réglage : un classificateur payant
   * ne doit pas recevoir les historiques complets sans choix explicite).
   * Provider absent de la table déclarée → `null` = pas de compaction
   * (silencieux, comportement actuel).
   */
  async function resolveCompactionTarget(): Promise<{ providerId: string; model: string } | null> {
    const summarizer = await readRoutingSummarizer().catch(() => undefined);
    if (summarizer === null) return null;
    if (summarizer) {
      return providers.some((p) => p.id === summarizer.providerId) ? summarizer : null;
    }
    const classifier = await readRoutingClassifier().catch(() => undefined);
    // `null` (classificateur de routage désactivé) ou `undefined` (non
    // configuré) = non défini pour la compaction → défaut.
    const target = classifier ?? DEFAULT_CLASSIFIER;
    return providers.some((p) => p.id === target.providerId) ? target : null;
  }

  /**
   * R4 — lance un `context.compact` couvrant les tours [0, longueur − 10) de
   * la transcription ; recompaction PAR-DESSUS : le résumé précédent est
   * fourni en tête des messages à résumer. Renvoie le nouvel état (posé dans
   * le runtime), ou `null` si pas de cible / rien de nouveau à couvrir /
   * échec — l'appelant garde alors l'état précédent : envoi selon l'existant,
   * jamais de tour perdu.
   */
  async function compactConversation(
    convId: string,
    historyEntries: ChatEntry[],
    current: ChatCompaction | null,
  ): Promise<ChatCompaction | null> {
    const target = await resolveCompactionTarget();
    if (!target) return null;
    const fromIndex = current?.upToIndex ?? 0;
    // Les COMPACT_KEEP_LAST derniers tours restent toujours intacts.
    const newUpToIndex = historyEntries.length - COMPACT_KEEP_LAST;
    if (newUpToIndex <= fromIndex) return null;
    const toSummarize: ChatMessage[] = [
      ...(current
        ? [{ role: "user" as const, content: `${COMPACT_SUMMARY_PREFIX}\n${current.summary}` }]
        : []),
      ...historyEntries
        .slice(fromIndex, newUpToIndex)
        .filter((e) => e.status !== "error")
        .map((e) => ({ role: e.role, content: e.content })),
    ];
    if (toSummarize.length === 0) return null;
    try {
      const { summary } = await contextCompact(target.providerId, target.model, toSummarize);
      const next: ChatCompaction = { summary, upToIndex: newUpToIndex, at: new Date().toISOString() };
      updateRuntime(convId, (r) => ({ ...r, compaction: next }));
      return next;
    } catch {
      // Erreur/timeout du résumeur : compaction non appliquée, silencieux.
      return null;
    }
  }

  /**
   * R4 — compaction éventuelle AVANT un envoi du moteur neutre : seuils de
   * `shouldCompactChat` (tours non couverts > 30, ou taille estimée > 60 % du
   * contexte du modèle quand `models.detail` le donne). Renvoie l'état à
   * utiliser pour CE tour : le nouveau si la compaction a réussi, sinon
   * l'existant (échec = envoi intégral selon l'état précédent).
   */
  async function maybeCompact(
    convId: string,
    historyEntries: ChatEntry[],
    systemPromptValue: string,
    newContent: string,
    sendProviderId: string,
    sendModel: string,
  ): Promise<ChatCompaction | null> {
    const current = getRuntime(convId).compaction;
    const uncoveredTurns = historyEntries.length - (current?.upToIndex ?? 0);
    // Taille (caractères) de l'envoi tel qu'il partirait avec l'état courant.
    const estimatedChars = toApiMessages(historyEntries, systemPromptValue, newContent, current).reduce(
      (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );
    const contextLength = await providerContextLength(sendProviderId, sendModel);
    if (!shouldCompactChat(uncoveredTurns, estimatedChars, contextLength)) return current;
    return (await compactConversation(convId, historyEntries, current)) ?? current;
  }

  /** R4 — « Recompacter » (modale) : refait le résumé par-dessus l'existant, tout de suite. */
  async function handleRecompact() {
    if (!activeSessionId || recompacting) return;
    setRecompacting(true);
    try {
      const runtime = getRuntime(activeSessionId);
      const next = await compactConversation(activeSessionId, runtime.entries, runtime.compaction);
      if (next) {
        const liveSessions = buildLiveSessions();
        setSessions(liveSessions);
        persistChatState(liveSessions, activeSessionId);
      }
    } finally {
      setRecompacting(false);
    }
  }

  /** R4 — « Oublier le résumé » (modale) : repasse à l'envoi de l'historique intégral. */
  function handleForgetCompaction() {
    if (!activeSessionId) return;
    updateRuntime(activeSessionId, (r) => ({ ...r, compaction: null }));
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    persistChatState(liveSessions, activeSessionId);
    setCompactionModalOpen(false);
  }

  async function handleSend(overrideContent?: string) {
    // Conversation À LAQUELLE ce tour appartient, figée ici : tout ce qui suit
    // (callbacks de streaming, fin de tour, sauvegarde) écrit dans CETTE
    // conversation via `convId`, jamais dans « l'active ». C'est ce qui permet
    // à l'utilisateur de changer d'onglet pendant qu'un tour tourne sans que
    // la réponse n'atterrisse dans la mauvaise conversation.
    const convId = activeSessionId;
    if (!convId) return;
    // Brouillon VIF du runtime — jamais `draft` (valeur de rendu) : la frappe
    // n'est répercutée au rendu que par un rattrapage débouncé (voir
    // useComposerLiveDraft.ts), un Entrée immédiat lirait un texte tronqué.
    const liveDraft = getRuntime(convId).draft;

    // Pendant un tour : on met le message en file (envoyé à la fin du tour,
    // voir l'effet d'auto-envoi). L'auto-envoi rappelle handleSend avec
    // `overrideContent` une fois `streaming` repassé à false.
    if (streaming && overrideContent === undefined) {
      const pending = liveDraft.trim();
      if (pending) {
        updateRuntime(convId, (r) => ({ ...r, queuedPrompts: [...r.queuedPrompts, pending], draft: "" }));
      }
      return;
    }

    // Chemin « file » (overrideContent) : texte seul, pas de pièces jointes.
    const usesComposer = overrideContent === undefined;
    const content = (overrideContent ?? liveDraft).trim();
    if (
      (!content && (!usesComposer || attachments.length === 0)) ||
      streaming ||
      !providerId ||
      !model
    )
      return;
    // Une image collée est encore en cours d'encodage : on attend.
    if (usesComposer && attachmentsPending) {
      setAttachmentsError("Image en cours de chargement… réessayez dans un instant.");
      return;
    }

    // Moteur du tour figé à l'envoi : le sélecteur de fournisseur est
    // verrouillé pendant le streaming de cette conversation, mais l'abandon
    // et le parsing du `done` doivent rester cohérents même après une
    // bascule d'onglet (voir `ConvRuntime.activeIsClaude`). En mode Auto
    // (R1), le moteur RÉEL n'est connu qu'après résolution de la cible —
    // `activeIsClaude` est alors réécrit juste avant l'envoi.
    const engineIsClaude = isClaude;
    const isAutoTurn = model === AUTO_MODEL;

    // Capturées avant tout envoi : ces variables locales restent valables même
    // si `attachments` change entre-temps. Le tiroir est vidé DÈS L'ENVOI (les
    // vignettes figurent alors dans le tour affiché ; les garder en bas
    // laissait croire qu'elles restaient à envoyer) et reposé si le tour
    // échoue (voir le `catch`).
    const contractAttachments = usesComposer ? toContractAttachments(attachments) : [];
    const sentAttachments = usesComposer ? toSentAttachments(attachments) : [];
    const sentDrafts = usesComposer ? attachments : [];

    // Historique pour `chat.send` (moteur neutre) : lu dans le runtime de
    // CETTE conversation, AVANT l'ajout du nouveau tour (toApiMessages
    // ajoute lui-même le nouveau message utilisateur).
    const historyEntries = getRuntime(convId).entries;

    const userEntry: ChatEntry = {
      id: nextEntryId("u"),
      role: "user",
      content,
      status: "done",
      ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
    };
    const assistantId = nextEntryId("a");
    // Le message part : le tiroir se vide ici, pas à la fin du tour (vidage
    // conditionné à ce qui est réellement parti).
    if (sentDrafts.length > 0) clearAttachments();

    // Verrouille l'envoi et pose les deux entrées d'un coup. `preSendAbort`
    // repart de zéro : c'est le drapeau de CE tour (voir `handleAbort` et le
    // point de contrôle plus bas). Chemin « file » : ne pas toucher au
    // brouillon (l'utilisateur a pu recommencer à taper le message suivant
    // pendant la fin du tour).
    updateRuntime(convId, (r) => ({
      ...r,
      streaming: true,
      preSendAbort: false,
      activeIsClaude: engineIsClaude,
      entries: [...r.entries, userEntry, { id: assistantId, role: "assistant", content: "", status: "streaming" }],
      ...(usesComposer ? { draft: "" } : {}),
    }));
    collerEnBas();

    // R6/R7 — plancher de session EN ATTENTE d'un tour Auto : relevé au
    // PREMIER signe de succès (premier chunk reçu, ou `done` sans erreur) —
    // un tour routé qui échoue (cible Ollama éteinte…) ne relève jamais le
    // plancher de la conversation. Armée plus bas, après résolution.
    let commitAffinity: (() => void) | null = null;

    const onDelta = (delta: string) => {
      commitAffinity?.();
      updateEntriesFor(convId, (prev) => withAppendedDelta(prev, assistantId, delta));
    };

    try {
      // R1 — mode Auto : résolution de la cible AVANT l'envoi (classement au
      // premier tour, cible mémorisée ensuite — affinité de session). Un
      // échec ici (sidecar injoignable…) marque le tour en erreur, comme
      // n'importe quel échec de moteur (voir le `catch`).
      let engineIsClaudeTurn = engineIsClaude;
      let sendProviderId = providerId;
      let sendModel = model;
      const meta: RequestMeta = { source: "chat", conversationId: convId };
      if (isAutoTurn) {
        const resolved = await resolveAutoRoute(convId, content, historyEntries, contractAttachments.length);
        engineIsClaudeTurn = resolved.target.engine === "claude";
        sendProviderId = resolved.target.providerId ?? "";
        sendModel = resolved.target.model;
        meta.routeTier = resolved.tier;
        // Plancher en attente : relevé au premier signe de succès (voir plus
        // haut). R7 — `routedTier` = plancher de session : commit à
        // max(plancher courant, tier utilisé), il ne descend JAMAIS ;
        // `routedTarget` garde la dernière cible utilisée (affichage/repli).
        if (resolved.pendingAffinity) {
          const { tier: usedTier, target: routedTarget, reasons: routedReasons } = resolved;
          commitAffinity = () => {
            commitAffinity = null;
            updateRuntime(convId, (r) => ({
              ...r,
              routedTier: maxRouteTier(r.routedTier, usedTier),
              routedTarget,
              routedReasons,
            }));
          };
        }
        // R3 — tour réellement débordé : marqué pour le plafond mensuel
        // (events.jsonl) ; le bandeau reflète l'état du tour qui part.
        if (resolved.debord?.active) meta.routeDebord = true;
        await applyDebordNotice(convId, resolved.debord, resolved.target.model, resolved.debordUnconfigured);
        // Badge « ⚡ auto : tier → modèle » porté par l'entrée assistant
        // (persisté avec elle — l'infobulle liste les raisons du classement).
        updateEntriesFor(convId, (prev) =>
          prev.map((e) =>
            e.id === assistantId
              ? { ...e, routeTier: resolved.tier, routeModel: resolved.target.model, routeReasons: resolved.reasons }
              : e,
          ),
        );
        // Moteur réel du tour, pour un abandon correctement routé.
        updateRuntime(convId, (r) => ({ ...r, activeIsClaude: engineIsClaudeTurn }));
      } else {
        // R3 — tour à modèle choisi MANUELLEMENT : jamais bloqué ni
        // bandeau-isé — un éventuel bandeau de débord précédent s'efface.
        updateRuntime(convId, (r) => (r.debordNotice ? { ...r, debordNotice: null } : r));
      }

      // R4 — moteur NEUTRE uniquement : compaction éventuelle de l'historique
      // AVANT l'envoi (les anciens tours partent en résumé, la transcription
      // affichée ne change pas ; échec = envoi intégral). Côté Claude : rien
      // (compaction SDK existante).
      const compaction = engineIsClaudeTurn
        ? null
        : await maybeCompact(convId, historyEntries, systemPrompt, content, sendProviderId, sendModel);

      // « Arrêter » cliqué pendant la phase de PRÉ-ENVOI ci-dessus (routage
      // Auto ≤ 3 s, compaction ≤ 60 s) : abandon propre AVANT tout envoi —
      // les deux bulles posées plus haut sont retirées (rien n'est parti vers
      // un moteur) et le message est reposé dans le composeur (devant ce que
      // l'utilisateur a pu retaper). Le `finally` remet `streaming` à false
      // et déclenche la sauvegarde habituelle.
      if (getRuntime(convId).preSendAbort) {
        updateRuntime(convId, (r) => ({
          ...r,
          preSendAbort: false,
          entries: r.entries.filter((e) => e.id !== userEntry.id && e.id !== assistantId),
          draft: r.draft ? `${content}\n${r.draft}` : content,
        }));
        return;
      }

      const { id, done } = engineIsClaudeTurn
        ? sendViaClaude(convId, content, onDelta, contractAttachments, webSearch, sendModel, meta)
        : chatSend(
            sendProviderId,
            sendModel,
            toApiMessages(historyEntries, systemPrompt, content, compaction),
            {},
            onDelta,
            contractAttachments,
            meta,
          );
      updateRuntime(convId, (r) => ({ ...r, activeRequestId: id }));

      const data = await done;
      // Tour terminé sans erreur (même sans chunk reçu) : second signe de
      // succès qui fixe l'affinité en attente (no-op si déjà fixée).
      commitAffinity?.();
      if (engineIsClaudeTurn) {
        const d = parseClaudeDone(data);
        const usage: ChatUsage | null = d.usage
          ? { promptTokens: d.usage.inputTokens, completionTokens: d.usage.outputTokens }
          : null;
        updateEntriesFor(convId, (prev) => withEntryDone(prev, assistantId, d.subtype === "aborted", usage, d.contextTokens));
        // Compteur local « conso hebdo Fable » (encart conso) — avant le
        // notifyUsageChanged() du finally, pour que l'encart lise à jour.
        await recordModelUsage(sendModel, d.usage);
      } else {
        const { finishReason, usage } = parseChatDone(data);
        updateEntriesFor(convId, (prev) => withEntryDone(prev, assistantId, finishReason === "aborted", usage));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateEntriesFor(convId, (prev) => withEntryError(prev, assistantId, message));
      // Tour échoué : les pièces jointes reviennent dans le composeur (retirées
      // à l'envoi) — pas question de les rejoindre à la main pour réessayer.
      restoreAttachments(sentDrafts);
    } finally {
      updateRuntime(convId, (r) => ({ ...r, streaming: false, activeRequestId: null }));
      // Fin de tour : la conso (Claude et/ou OpenRouter) a pu changer.
      notifyUsageChanged();
      // Fin de tour : sauvegarde immédiate (pas d'attente du debounce). Les
      // entrées/claudeSessionId sont relus dans le RUNTIME de cette
      // conversation (et non dans l'état React fermé à l'appel, périmé après
      // tout ce streaming) — l'utilisateur a pu changer d'onglet entre-temps,
      // donc on ne peut plus supposer que cette conversation est encore
      // l'active.
      const liveSessions = buildLiveSessions();
      setSessions(liveSessions);
      // Active par REF : ce callback peut s'exécuter longtemps après l'envoi,
      // l'utilisateur a pu changer d'onglet entre-temps.
      persistChatState(liveSessions, activeSessionIdRef.current);
    }
  }

  // Fin de tour : si des messages ont été mis en file pendant que l'assistant
  // travaillait, on envoie le PREMIER automatiquement — les suivants partiront
  // aux fins de tour suivantes, un par un (streaming vient de repasser à
  // false ; handleSend(override) ne re-file pas et lance le tour suivant).
  useEffect(() => {
    if (streaming || !activeSessionId) return;
    const pending = getRuntime(activeSessionId).queuedPrompts[0];
    if (!pending) return;
    updateRuntime(activeSessionId, (r) => ({ ...r, queuedPrompts: r.queuedPrompts.slice(1) }));
    void handleSend(pending);
    // Voir le jumeau dans AgentPage.tsx pour le raisonnement complet :
    // `streaming` seul perdait les files des onglets d'arrière-plan (un tour
    // qui finit ailleurs ne change pas le streaming de la conversation active,
    // et y revenir ne le change pas non plus). On réagit donc à toute écriture
    // de runtime et au changement d'onglet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, runtimeTick, activeSessionId]);

  /* ---------- Voix du composeur (voir useVoiceComposer.ts) ---------- */

  /*
   * Dictée ponctuelle et mode conversation vivent dans un hook partagé avec la
   * page Projets : le comportement décrit ici (envoi via `handleSend`, lecture
   * de la réponse, garde-fous) est celui d'origine, simplement déplacé. Tout
   * s'applique à la conversation ACTIVE (les onglets d'arrière-plan n'ont ni
   * composeur ni lecture).
   */
  const voice = useVoiceComposer({
    pageLabel: "Chat",
    pageVisible,
    micDeviceId,
    conversation: conversationConfig,
    // `handleSend` ne résout qu'à la fin du tour : c'est ce que le mode
    // conversation attend pour enchaîner lecture puis reprise de l'écoute.
    send: (text) => handleSend(text),
    isBusy: () => streaming,
    turnCount: () => entriesRef.current.length,
    lastReplyText: () => {
      const list = entriesRef.current;
      const last = list[list.length - 1];
      if (!last || last.role !== "assistant" || last.status !== "done") return null;
      return last.content.trim() ? last.content : null;
    },
    // Réponse EN COURS d'écriture : `entriesRef` est tenu à jour pendant tout le
    // stream, la bulle en construction est donc lisible sans aucun rendu ni
    // effet supplémentaire. Le statut « streaming » est ce qui distingue le tour
    // en cours de la réponse précédente déjà terminée.
    streamingReplyText: () => {
      const list = entriesRef.current;
      const last = list[list.length - 1];
      if (!last || last.role !== "assistant" || last.status !== "streaming") return null;
      return last.content || null;
    },
    notSentNotice: "Message non envoyé : vérifiez le fournisseur et le modèle.",
    appendToDraft: (text) => {
      if (activeSessionId) {
        updateRuntime(activeSessionId, (r) => ({ ...r, draft: r.draft ? `${r.draft} ${text}` : text }));
      }
    },
    // Envoi par mot-clé : le brouillon rendu est celui que l'utilisateur voit
    // (dicté ET tapé), et il est vidé — c'est lui qui part.
    takeDraft: () => {
      if (!activeSessionId) return "";
      const draft = getRuntime(activeSessionId).draft;
      if (draft) updateRuntime(activeSessionId, (r) => ({ ...r, draft: "" }));
      return draft;
    },
    focusComposer: () => focusComposer(),
  });

  async function handleAbort() {
    if (!activeSessionId) return;
    const runtime = getRuntime(activeSessionId);
    if (!runtime.streaming && !runtime.activeRequestId) return;
    // Arrêter = tout stopper : on abandonne aussi les messages en file.
    updateRuntime(activeSessionId, (r) => ({ ...r, queuedPrompts: [] }));
    // Tour encore en phase de PRÉ-ENVOI (routage Auto, compaction) : aucune
    // requête moteur à abandonner côté sidecar — on lève le drapeau, le point
    // de contrôle de `handleSend` annulera le tour avant tout envoi (message
    // reposé dans le composeur).
    if (!runtime.activeRequestId) {
      updateRuntime(activeSessionId, (r) => ({ ...r, preSendAbort: true }));
      return;
    }
    try {
      // Moteur du tour EN COURS (voir `ConvRuntime.activeIsClaude`), pas le
      // fournisseur affiché — verrouillé pendant le streaming, mais autant
      // rester routé sur la valeur figée à l'envoi.
      if (runtime.activeIsClaude) {
        await claudeAbort(runtime.activeRequestId);
      } else {
        await chatAbort(runtime.activeRequestId);
      }
    } catch {
      // best effort : le `done` du tour en cours gère l'état final de la bulle
    }
  }

  /**
   * Crée une nouvelle session d'historique, ouverte dans un NOUVEL onglet —
   * les conversations déjà ouvertes le restent (c'est tout l'objet des
   * onglets multiples ; créer pendant qu'une autre streame est permis).
   * Session active déjà vierge : on la réutilise (et on rouvre son onglet si
   * besoin) plutôt que d'empiler des « Nouvelle session » identiques. Voir
   * `ChatPageHandle.newSession` (raccourci global Ctrl+N).
   */
  function handleNewConversation(): boolean {
    const current = sessions.find((s) => s.id === activeSessionId);
    if (current && entries.length === 0 && !current.titleCustom) {
      // Son onglet a pu être fermé (Ctrl+Suppr) : il faut le rouvrir, sinon
      // « + »/Ctrl+N resteraient sans effet visible.
      if (!openConversationIds.includes(current.id)) {
        ensureRuntime(current);
        setOpenConversationIds((prev) => [...prev, current.id]);
      }
      // Réutilisation après un Ctrl+K : repartir « à neuf » implique de retirer
      // le bandeau d'annulation — un « Annuler » ici ressusciterait les anciens
      // messages dans ce que l'utilisateur considère comme une session vierge.
      setClearedNotice(false);
      clearedBackupRef.current = null;
      focusComposer();
      return true;
    }
    const liveSessions = buildLiveSessions();
    const fresh = freshChatSession(providerId);
    // Purge des conversations vides laissées par d'anciennes créations
    // répétées — en épargnant celles ouvertes en onglet (les fermer sous les
    // pieds de l'utilisateur serait brutal) et celles en cours de streaming.
    const kept = liveSessions.filter(
      (s) =>
        s.id === activeSessionId ||
        s.entries.length > 0 ||
        s.titleCustom ||
        openConversationIds.includes(s.id) ||
        runtimesRef.current.get(s.id)?.streaming === true,
    );
    const nextSessions = [...kept, fresh];
    runtimesRef.current.set(fresh.id, freshRuntime());
    setSessions(nextSessions);
    setActiveSessionId(fresh.id);
    // R1 — nouvelle conversation = « Auto (routeur) » par défaut (le reste de
    // la config LLM du panneau — fournisseur, prompt système — est conservé).
    setModel(AUTO_MODEL);
    setOpenConversationIds((prev) => [...prev, fresh.id]);
    setConfirmDeleteId(null);
    clearAttachments();
    setClearedNotice(false);
    persistChatState(nextSessions, fresh.id);
    focusComposer();
    return true;
  }

  /**
   * Vide les messages de la session ACTIVE, sans en créer de nouvelle — la
   * session garde son id, son titre et sa config (fournisseur/modèle/prompt
   * système). Utilisée par le raccourci global Ctrl+K (voir
   * `ChatPageHandle.clearConversation` dans App.tsx). Renvoie `false` si
   * refusée (run en cours dans CETTE conversation).
   */
  function clearChatConversation(): boolean {
    if (!activeSessionId) return false;
    if (streaming) {
      // Refus silencieux inacceptable au clavier (Ctrl+K) : sans retour
      // visible, l'utilisateur croit que « vider » est cassé (même principe
      // que closeConversationTab).
      setTabsNotice("Conversation en cours : arrêtez le tour avant de la vider.");
      return false;
    }
    // Vider écrase ET persiste : on garde l'état d'avant pour offrir une
    // annulation immédiate plutôt qu'une modale de confirmation.
    // `sessionUiId` : voir la déclaration de `clearedBackupRef`.
    clearedBackupRef.current = {
      sessionUiId: activeSessionId,
      entries: activeRuntime.entries,
      claudeSessionId: activeRuntime.claudeSessionId,
      routedTier: activeRuntime.routedTier,
      routedTarget: activeRuntime.routedTarget,
      compaction: activeRuntime.compaction,
    };
    // R1 — vider efface aussi l'affinité de session : le prochain envoi en
    // Auto re-classe la conversation repartie de zéro. R4 — le résumé de
    // compaction, qui couvrait des tours désormais vidés, part avec.
    updateRuntime(activeSessionId, (r) => ({
      ...r,
      entries: [],
      claudeSessionId: null,
      routedTier: null,
      routedTarget: null,
      routedReasons: null,
      compaction: null,
    }));
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    setConfirmDeleteId(null);
    persistChatState(liveSessions, activeSessionId);
    setClearedNotice(true);
    focusComposer();
    return true;
  }

  /**
   * Restaure la conversation vidée juste avant (bandeau « Annuler ») — DANS la
   * session d'origine (`backup.sessionUiId`), jamais dans une autre. Refus si
   * elle a été supprimée entre-temps, ou si un tour y a redémarré (écraser un
   * stream en cours serait pire que de perdre l'annulation). Le bandeau est
   * masqué à toute bascule de session, l'undo n'est donc atteignable en
   * pratique que depuis la session vidée elle-même.
   */
  function undoClearChatConversation() {
    const backup = clearedBackupRef.current;
    if (!backup) return;
    if (runtimesRef.current.get(backup.sessionUiId)?.streaming) return;
    clearedBackupRef.current = null;
    setClearedNotice(false);
    if (!sessions.some((s) => s.id === backup.sessionUiId)) return;
    updateRuntime(backup.sessionUiId, (r) => ({
      ...r,
      entries: backup.entries,
      claudeSessionId: backup.claudeSessionId,
      routedTier: backup.routedTier,
      routedTarget: backup.routedTarget,
      compaction: backup.compaction,
    }));
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    persistChatState(liveSessions, activeSessionId);
  }

  /**
   * Place le curseur dans le composeur. `requestAnimationFrame` : appelé juste
   * après un changement de page, le textarea peut ne pas être encore visible
   * (slot masqué) — un focus posé trop tôt serait ignoré.
   */
  function focusComposer() {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  useImperativeHandle(ref, () => ({
    newSession: () => handleNewConversation(),
    clearConversation: () => clearChatConversation(),
    isStreaming: () => streaming,
    focusComposer: () => focusComposer(),
  }));

  /**
   * Ouvre une session en onglet et l'active (ou la réactive si déjà ouverte).
   * Plus aucun verrou de streaming ici, contrairement à la version
   * mono-conversation : chaque conversation a son propre runtime, basculer
   * n'écrase donc plus l'état d'un tour en cours — c'est même l'intérêt des
   * onglets (partir écrire ailleurs pendant qu'un tour se termine). Les
   * champs de config LLM du panneau reflètent la nouvelle conversation active.
   */
  function selectChatSession(id: string) {
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    const target = liveSessions.find((s) => s.id === id);
    if (!target) return;
    // Amorce le runtime depuis la dernière copie connue UNIQUEMENT si cette
    // conversation n'a pas déjà un runtime vivant : réactiver l'onglet d'un
    // tour en cours ne doit jamais le réinitialiser.
    ensureRuntime(target);
    setActiveSessionId(id);
    setOpenConversationIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setProviderId(target.providerId);
    setModel(target.model);
    setSystemPrompt(target.systemPrompt);
    setWebSearch(target.webSearch);
    setConfirmDeleteId(null);
    clearAttachments();
    // Le bandeau « Conversation vidée / Annuler » parlait de la session qu'on
    // quitte : masqué à la bascule (l'undo, ciblé, refuse de toute façon).
    setClearedNotice(false);
    // R4 — la modale du résumé parlait aussi de la session qu'on quitte.
    setCompactionModalOpen(false);
    persistChatState(liveSessions, id);
    focusComposer();
  }

  /**
   * Ferme l'onglet d'une conversation SANS la supprimer (elle reste dans le
   * panneau « Historique »). Son runtime est abandonné : ses messages
   * viennent d'être recopiés dans `sessions` par `buildLiveSessions`. Un tour
   * en cours serait perdu de vue, donc on refuse tant qu'il streame.
   */
  function closeConversationTab(id: string) {
    if (runtimesRef.current.get(id)?.streaming) {
      // Refus silencieux inacceptable au clavier (Ctrl+Suppr) : l'utilisateur
      // ne verrait rien se passer. Le bouton « × » est lui déjà désactivé.
      setTabsNotice("Conversation en cours : arrêtez le tour avant de fermer son onglet.");
      return;
    }
    setTabsNotice(null);
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    runtimesRef.current.delete(id);
    const nextOpen = openConversationIds.filter((c) => c !== id);
    setOpenConversationIds(nextOpen);

    // Conversation qui devient active : inchangée si on ferme un AUTRE onglet,
    // sinon l'onglet voisin (le précédent, à défaut le premier restant).
    let nextActiveId = activeSessionId;
    if (activeSessionId === id) {
      // Bascule de conversation active : le bandeau « Conversation vidée /
      // Annuler » parlait de celle qu'on quitte (voir selectChatSession).
      setClearedNotice(false);
      const idx = openConversationIds.indexOf(id);
      const neighbour = nextOpen[Math.max(0, idx - 1)];
      const target = neighbour ? liveSessions.find((s) => s.id === neighbour) : undefined;
      if (target) {
        ensureRuntime(target);
        nextActiveId = target.id;
        setActiveSessionId(target.id);
        setProviderId(target.providerId);
        setModel(target.model);
        setSystemPrompt(target.systemPrompt);
        setWebSearch(target.webSearch);
      } else {
        // Dernier onglet de conversation fermé : on en rouvre aussitôt un
        // vierge plutôt que de laisser l'écran vide — même effet visible que
        // Ctrl+K, mais non destructif (la conversation fermée reste dans le
        // panneau « Historique »). Sans cela l'utilisateur se retrouvait sans
        // conversation ET sans moyen d'en rouvrir une.
        const fresh = freshChatSession(providerId);
        // Purge des sessions vides au passage (celle qu'on vient de fermer si
        // elle n'avait aucun message), comme le fait `handleNewConversation`.
        const kept = liveSessions.filter(
          (s) => s.entries.length > 0 || s.titleCustom || runtimesRef.current.get(s.id)?.streaming === true,
        );
        const withFresh = [...kept, fresh];
        runtimesRef.current.set(fresh.id, freshRuntime());
        setSessions(withFresh);
        setOpenConversationIds([fresh.id]);
        setActiveSessionId(fresh.id);
        // R1 — conversation neuve = « Auto (routeur) » par défaut.
        setModel(AUTO_MODEL);
        clearAttachments();
        persistChatState(withFresh, fresh.id);
        focusComposer();
        return;
      }
    }
    persistChatState(liveSessions, nextActiveId);
  }

  /** Conversation suivante/précédente dans la barre d'onglets (Ctrl+Tab / Ctrl+Maj+Tab). */
  function cycleConversation(direction: 1 | -1) {
    if (openConversationIds.length < 2) return;
    const idx = openConversationIds.indexOf(activeSessionId);
    const base = idx === -1 ? 0 : idx;
    const next = openConversationIds[(base + direction + openConversationIds.length) % openConversationIds.length];
    selectChatSession(next);
  }

  // Raccourcis d'ONGLETS de conversation, écouteur LOCAL à cette page —
  // même famille que celui d'AgentPage.tsx :
  //   Ctrl+Tab / Ctrl+Maj+Tab : conversation suivante / précédente
  //   Ctrl+Suppr             : ferme l'onglet courant (l'historique est
  //                            CONSERVÉ — la conversation reste dans le
  //                            panneau « Historique », seule sa suppression
  //                            définitive y est possible, avec confirmation)
  // Gardé par `pageVisible` : les six pages restent montées en permanence
  // (voir App.tsx), sans cette garde le Chat fermerait/cyclerait ses onglets
  // pendant qu'on regarde une autre page.
  useEffect(() => {
    // `globalThis.KeyboardEvent` : le `KeyboardEvent` non qualifié désigne
    // ici celui de React (importé en tête de fichier), incompatible avec
    // `addEventListener`.
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (!pageVisible) return;
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        cycleConversation(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "Delete" && !e.shiftKey && activeSessionId) {
        e.preventDefault();
        closeConversationTab(activeSessionId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Ces fonctions lisent `openConversationIds`/`activeSessionId` : on
    // réattache l'écouteur quand ils changent plutôt que de passer par des
    // refs, la liste d'onglets étant petite et rarement modifiée.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openConversationIds, activeSessionId, pageVisible]);

  /** Renomme une session (titre personnalisé — n'est plus jamais recalculé automatiquement). */
  function renameChatSession(id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    const liveSessions = buildLiveSessions().map((s) => (s.id === id ? { ...s, title: trimmed, titleCustom: true } : s));
    setSessions(liveSessions);
    persistChatState(liveSessions, activeSessionId);
  }

  /** Supprime une session (définitif — confirmation à la charge de l'appelant, voir le panneau « Historique »). */
  function deleteChatSession(id: string) {
    // Refus si CETTE conversation a un tour en cours (les autres peuvent
    // continuer de streamer sans que ça pose problème).
    if (runtimesRef.current.get(id)?.streaming) return;
    const liveSessions = buildLiveSessions();
    const remaining = liveSessions.filter((s) => s.id !== id);
    const finalSessions = remaining.length > 0 ? remaining : [freshChatSession(providerId)];
    runtimesRef.current.delete(id);
    setSessions(finalSessions);
    const nextOpen = openConversationIds.filter((c) => c !== id && finalSessions.some((s) => s.id === c));
    setOpenConversationIds(nextOpen);
    if (id === activeSessionId) {
      setClearedNotice(false);
      // La conversation active disparaît : on bascule vers le dernier onglet
      // encore ouvert, à défaut la première session restante (rouverte en
      // onglet dans ce cas).
      const nextActive = finalSessions.find((s) => s.id === nextOpen[nextOpen.length - 1]) ?? finalSessions[0];
      ensureRuntime(nextActive);
      setActiveSessionId(nextActive.id);
      setOpenConversationIds(nextOpen.includes(nextActive.id) ? nextOpen : [...nextOpen, nextActive.id]);
      setProviderId(nextActive.providerId);
      setModel(nextActive.model);
      setSystemPrompt(nextActive.systemPrompt);
      setWebSearch(nextActive.webSearch);
      persistChatState(finalSessions, nextActive.id);
    } else {
      persistChatState(finalSessions, activeSessionId);
    }
  }

  function startEditSessionTitle(session: ChatSession) {
    if (streaming) return;
    setEditingSessionId(session.id);
    setEditingSessionTitle(session.title);
  }

  function cancelEditSessionTitle() {
    sessionTitleSkipBlurRef.current = true;
    setEditingSessionId(null);
  }

  function commitEditSessionTitle() {
    if (sessionTitleSkipBlurRef.current) {
      // Provient du `blur` déclenché par le démontage du champ sur Échap : ignoré.
      sessionTitleSkipBlurRef.current = false;
      return;
    }
    if (!editingSessionId) return;
    const id = editingSessionId;
    const value = editingSessionTitle;
    setEditingSessionId(null);
    renameChatSession(id, value);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (handleUndoKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  /** Libellé affiché pour le fournisseur d'une session dans le panneau « Historique ». */
  function sessionProviderLabel(pid: string): string {
    if (pid === CLAUDE_PROVIDER_ID) return "Claude (abonnement)";
    return providers.find((p) => p.id === pid)?.label ?? pid;
  }

  // Écran étroit au premier affichage : les sections démarrent repliées
  // (même approche que la page Projets — voir AgentPage.tsx, `isCompactViewport`).
  const isCompactViewport = typeof window !== "undefined" && window.innerWidth <= 900;

  // Roving tabindex (WAI-ARIA APG) : onglets de conversation (←/→) et liste
  // de sessions (↑/↓) — un seul élément tabbable par collection.
  const tabsRoving = useRovingFocus<HTMLDivElement>({ selector: '[role="tab"]', orientation: "horizontal" });
  const sessionsRoving = useRovingFocus<HTMLUListElement>({ selector: ".session-item__title" });
  const sortedSessions = sortByRecent(sessions);
  const tabbableSessionId = sortedSessions.some((s) => s.id === activeSessionId)
    ? activeSessionId
    : sortedSessions[0]?.id;
  const contextSize = contextTokens(entries);
  // R1 — en Auto, l'encart contexte affiche le modèle routé dès qu'il est connu.
  const contextModel = model === AUTO_MODEL ? (activeRuntime.routedTarget?.model ?? "auto") : model;
  // Encart « Contexte » de l'en-tête (voir contextBus.ts) : publié tant que
  // cette page vit, effacé au démontage pour ne pas laisser un chiffre orphelin.
  useEffect(() => {
    publishContext("chat", contextSize === null ? null : { model: contextModel, usedTokens: contextSize });
    return () => publishContext("chat", null);
  }, [contextSize, contextModel]);

  // Bouton « Compacter » de l'encart contexte (voir contextBus.ts) : la
  // recompaction R4 existante (même action que « Recompacter » de la modale),
  // hors tour en cours. Ref pour garder le handler frais sans re-notifier.
  const compactNowRef = useRef<() => void>(() => {});
  compactNowRef.current = () => {
    // Garde anti-course : un tour a pu démarrer entre le rendu du bouton et le clic.
    if (!streaming) void handleRecompact();
  };
  useEffect(() => {
    const available = Boolean(activeSessionId) && !streaming;
    registerCompactHandler("chat", available ? () => compactNowRef.current() : null);
    return () => registerCompactHandler("chat", null);
  }, [activeSessionId, streaming]);

  return (
    <div className="page chat-page agent-page">
      <div className="agent-layout">
        <aside className="agent-sidebar agent-sidebar--left">
          <SidebarSection id="chat-llm" title="LLM" defaultOpen={!isCompactViewport}>
            {/* Champs de config verrouillés pendant le streaming de la
                conversation ACTIVE seulement : changer de fournisseur/modèle
                sous un tour en cours fausserait l'abandon et le tour suivant —
                les autres onglets, eux, restent librement modifiables une fois
                affichés (leur runtime est indépendant). */}
            <div className="field">
              <label htmlFor="chat-provider">Fournisseur</label>
              <select
                id="chat-provider"
                value={providerId}
                disabled={streaming}
                onChange={(e) => setProviderId(e.currentTarget.value)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                <option value={CLAUDE_PROVIDER_ID}>Claude (abonnement)</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="chat-model">Modèle</label>
              <select
                id="chat-model"
                value={model}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  setModel(value);
                  // R1/R7 — choisir un modèle explicite efface plancher et
                  // cible de session (override) ; revenir sur « Auto »
                  // repart SANS plancher (routedTier redevenu null).
                  if (value !== AUTO_MODEL && activeSessionId) {
                    updateRuntime(activeSessionId, (r) => ({
                      ...r,
                      routedTier: null,
                      routedTarget: null,
                      routedReasons: null,
                    }));
                  }
                }}
                // R1 — « Auto (routeur) » restant toujours proposé, le
                // sélecteur n'est plus verrouillé quand la liste est vide.
                disabled={streaming || modelsState === "loading"}
              >
                <option value={AUTO_MODEL} title="Commence bas et monte selon la complexité ; la session ne redescend jamais.">Auto (montant)</option>
                {models.length === 0 && model !== AUTO_MODEL && <option value="">—</option>}
                {featuredModels.length > 0 ? (
                  <>
                    <optgroup label="Mis en avant">
                      {featuredModels.map((m) => (
                        <option key={`fav-${m.id}`} value={m.id}>
                          ★ {m.id}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Tous les modèles">
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </optgroup>
                  </>
                ) : (
                  models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))
                )}
              </select>
            </div>

            {providerId && providerId !== CLAUDE_PROVIDER_ID && (
              <OllamaPanel providerId={providerId} selectedModel={model} />
            )}

            {isClaude && (
              <label className="field field--checkbox" htmlFor="chat-web-search">
                <input
                  id="chat-web-search"
                  type="checkbox"
                  checked={webSearch}
                  disabled={streaming}
                  onChange={(e) => setWebSearch(e.currentTarget.checked)}
                />
                <span>Recherche web</span>
              </label>
            )}

            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => providerId && void loadModels(providerId)}
              disabled={!providerId || modelsState === "loading"}
            >
              {modelsState === "loading" ? "Chargement…" : "Rafraîchir les modèles"}
            </button>

            {modelsState === "error" && (
              <div className="result-line result-line--error">Erreur modèles : {modelsError}</div>
            )}

            <div className="field">
              <label htmlFor="chat-system-prompt">Prompt système</label>
              <textarea
                id="chat-system-prompt"
                rows={4}
                value={systemPrompt}
                disabled={streaming}
                onChange={(e) => setSystemPrompt(e.currentTarget.value)}
                placeholder="Instructions système optionnelles…"
              />
            </div>
          </SidebarSection>

          <SidebarSection
            id="chat-history"
            title="Historique"
            defaultOpen={!isCompactViewport}
            badge={sessions.length > 0 ? <span className="sidebar-section__count">{sessions.length}</span> : undefined}
          >
            <button
              type="button"
              className="btn btn--ghost session-list__new"
              onClick={handleNewConversation}
              disabled={streaming}
            >
              Nouvelle conversation
            </button>

            {sessions.length === 0 ? (
              <p className="empty-hint">Aucune session.</p>
            ) : (
              <ul
                className="session-list"
                ref={sessionsRoving.containerRef}
                onKeyDown={sessionsRoving.onKeyDown}
                onFocus={sessionsRoving.onFocus}
              >
                {sortedSessions.map((s) => (
                  <li key={s.id} className={`session-item${s.id === activeSessionId ? " session-item--active" : ""}`}>
                    {editingSessionId === s.id ? (
                      <input
                        className="session-item__title-input"
                        value={editingSessionTitle}
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setEditingSessionTitle(e.currentTarget.value)}
                        onBlur={commitEditSessionTitle}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEditSessionTitle();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEditSessionTitle();
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="session-item__title"
                        title={s.title}
                        disabled={streaming}
                        tabIndex={s.id === tabbableSessionId ? 0 : -1}
                        onClick={() => selectChatSession(s.id)}
                      >
                        {s.title}
                      </button>
                    )}
                    <div className="session-item__meta">
                      <span className="session-item__date">{formatRelativeDate(s.updatedAt)}</span>
                      <span className="session-item__engine">{sessionProviderLabel(s.providerId)}</span>
                    </div>
                    {confirmDeleteId === s.id ? (
                      <div className="session-item__confirm">
                        Supprimer ?
                        <button type="button" className="btn btn--ghost" onClick={() => setConfirmDeleteId(null)}>
                          Non
                        </button>
                        <button
                          type="button"
                          className="btn btn--deny"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            deleteChatSession(s.id);
                          }}
                        >
                          Oui
                        </button>
                      </div>
                    ) : (
                      <div className="session-item__actions">
                        <button
                          type="button"
                          className="session-item__action"
                          title="Renommer"
                          aria-label={`Renommer ${s.title}`}
                          onClick={() => startEditSessionTitle(s)}
                        >
                          ✎
                        </button>
                        <button
                          type="button"
                          className="session-item__action"
                          title="Supprimer"
                          aria-label={`Supprimer ${s.title}`}
                          disabled={streaming}
                          onClick={() => setConfirmDeleteId(s.id)}
                        >
                          🗑
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SidebarSection>
        </aside>

        <div className="agent-main__content">
          {/* Barre d'onglets de conversations — mêmes classes que la page
              Projets (App.css). Le point « ● » signale un tour en cours dans
              un onglet (y compris d'arrière-plan) ; « × » est désactivé tant
              que SA conversation streame (fermer l'onglet perdrait le tour de
              vue) ; « + » ouvre une nouvelle conversation. */}
          <div
            className="agent-tabs"
            role="tablist"
            ref={tabsRoving.containerRef}
            onKeyDown={tabsRoving.onKeyDown}
            onFocus={tabsRoving.onFocus}
          >
            {openConversationIds.map((convId) => {
              const conv = sessions.find((s) => s.id === convId);
              if (!conv) return null;
              const isActive = convId === activeSessionId;
              const convStreaming = runtimesRef.current.get(convId)?.streaming === true;
              return (
                <div
                  key={convId}
                  className={`agent-tab agent-tab--conv${isActive ? " agent-tab--active" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  title={conv.title}
                  onClick={() => selectChatSession(convId)}
                  onKeyDown={(e) => {
                    // `target === currentTarget` : ne pas intercepter Entrée sur
                    // le bouton « × » interne (fermeture native du bouton).
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      selectChatSession(convId);
                    }
                  }}
                >
                  <span className="agent-tab__name">{conv.title}</span>
                  {convStreaming && (
                    <span
                      className="agent-tab__dot agent-tab__dot--streaming"
                      aria-label="Tour en cours"
                      title="Tour en cours"
                    />
                  )}
                  <button
                    type="button"
                    className="agent-tab__close"
                    aria-label={`Fermer l'onglet ${conv.title}`}
                    title={convStreaming ? "Impossible de fermer : tour en cours" : "Fermer l'onglet"}
                    disabled={convStreaming}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeConversationTab(convId);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="agent-tab agent-tab--new"
              onClick={() => handleNewConversation()}
              aria-label="Nouvelle conversation"
              title="Nouvelle conversation (Ctrl+N)"
            >
              +
            </button>
          </div>

          {tabsNotice && <div className="agent-tabs__notice">{tabsNotice}</div>}
          {clearedNotice && (
            <div className="agent-tabs__notice cleared-notice">
              Conversation vidée.
              <button type="button" className="btn btn--ghost cleared-notice__undo" onClick={undoClearChatConversation}>
                Annuler
              </button>
              <button
                type="button"
                className="cleared-notice__dismiss"
                onClick={() => setClearedNotice(false)}
                aria-label="Masquer"
                title="Masquer"
              >
                ×
              </button>
            </div>
          )}
          {/* R3 — bandeau de débord : posé au tour concerné, effacé dès que le
              routage redevient normal (voir applyDebordNotice). */}
          {debordNotice && (
            <div className={`agent-tabs__notice debord-notice${debordNotice.blocked ? " debord-notice--blocked" : ""}`}>
              {debordNotice.unconfigured
                ? "⚠ Cible de débord non configurée — tour envoyé sur l'abonnement"
                : debordNotice.blocked
                  ? `⛔ Plafond débord atteint (${debordNotice.plafondUsdMois ?? "?"} $/mois) — repli sur le modèle local`
                  : `⚠ Mode débord : abonnement saturé (fenêtre 5 h à ${Math.round(debordNotice.fiveHourPct ?? 0)} %) — tour envoyé sur ${debordNotice.model}`}
            </div>
          )}
          <div className="chat-log" ref={scrollRef} {...scrollProps}>
            {/* R4 — indicateur discret en tête de transcription : le résumé
                remplace les anciens tours À L'ENVOI seulement, la transcription
                affichée reste intégrale. Clic → modale (résumé consultable). */}
            {activeCompaction && (
              <button
                type="button"
                className="chat-compaction"
                onClick={() => setCompactionModalOpen(true)}
                title="Les anciens tours sont envoyés sous forme de résumé — cliquez pour le consulter"
              >
                {/* `upToIndex` compte des ENTRÉES de transcription (messages
                    utilisateur + assistant), pas des tours complets. */}
                historique compacté ({activeCompaction.upToIndex} messages résumés)
              </button>
            )}
            {entries.length === 0 && (
              <p className="empty-hint">Aucun message. Écrivez ci-dessous pour démarrer.</p>
            )}
            {entries.map((entry) => (
              <ChatBubble key={entry.id} entry={entry} />
            ))}
          </div>

          <div
            className={`chat-composer${composerDragOver ? " chat-composer--dragover" : ""}`}
            onDragOver={(e) => {
              if (streaming) return;
              e.preventDefault();
              setComposerDragOver(true);
            }}
            onDragLeave={() => setComposerDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setComposerDragOver(false);
              if (streaming) return;
              const files = filesFromDrop(e);
              if (files.length > 0) addFiles(files);
            }}
          >
            {queuedPrompts.map((prompt, index) => (
              <div
                key={`${index}-${prompt}`}
                className="composer-queued"
                title="Envoyé automatiquement à la fin du tour en cours, dans l'ordre de la file"
              >
                <span className="composer-queued__label">
                  {queuedPrompts.length > 1 ? `En file ${index + 1}/${queuedPrompts.length} :` : "En file :"}
                </span>
                <span className="composer-queued__text">{prompt}</span>
                <button
                  type="button"
                  className="composer-queued__cancel"
                  onClick={() => removeQueuedPrompt(index)}
                  aria-label="Retirer ce message de la file"
                  title="Retirer de la file"
                >
                  ×
                </button>
              </div>
            ))}
            <AttachmentTray items={attachments} onRemove={removeAttachment} />
            {attachmentsError && (
              <div className="result-line result-line--error">
                {attachmentsError}
                <button
                  type="button"
                  className="btn btn--ghost result-line__dismiss"
                  onClick={() => setAttachmentsError(null)}
                  aria-label="Masquer l'erreur"
                >
                  ×
                </button>
              </div>
            )}
            {/* Erreur micro, progression de transcription, état du mode
                conversation et messages discrets — voir VoiceControls.tsx. */}
            <VoiceStatus voice={voice} />
            <div className="chat-composer__row">
              {/* Icônes d'action empilées EN COLONNE à gauche du textarea : la
                  zone de saisie récupère ainsi toute la largeur. */}
              <div className="chat-composer__tools">
                <AttachmentPickerButton onFiles={(files) => addFiles(files)} disabled={streaming} />
                <VoiceButtons voice={voice} />
              </div>
              {/* Semi-non-contrôlé (defaultValue + ref) : la frappe n'impose
                  plus un re-rendu de page par caractère — voir
                  useComposerLiveDraft.ts, qui pousse aussi les écritures
                  programmatiques (dictée, vidage…) vers le DOM. */}
              <textarea
                ref={textareaRef}
                rows={5}
                defaultValue={draft}
                onChange={(e) => onComposerChange(e.currentTarget.value)}
                onBlur={onComposerBlur}
                onKeyDown={handleKeyDown}
                onPaste={(e) => {
                  const files = filesFromClipboard(e);
                  if (files.length > 0) {
                    e.preventDefault();
                    addFiles(files);
                    return;
                  }
                  // Repli natif : sous WebKitGTK (Tauri Linux), une capture
                  // d'écran n'apparaît PAS dans `clipboardData`. On ne tente le
                  // repli que sans texte (sinon collage de texte normal), avec
                  // une vignette « en chargement » affichée tout de suite.
                  if (e.clipboardData.getData("text/plain")) return;
                  const placeholderId = beginImage("capture-collée.png");
                  if (!placeholderId) return;
                  void readClipboardImage()
                    .then((bytes) => resolveImage(placeholderId, bytes))
                    .catch(() => resolveImage(placeholderId, null));
                }}
                placeholder={
                  streaming
                    ? "L'agent travaille… (Entrée met votre message en file, envoyé à la fin du tour)"
                    : "Écrivez un message… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)"
                }
              />
              <div className="actions">
                {streaming ? (
                  <>
                    {/* Même libellé qu'au repos (choix utilisateur 2026-08-04) :
                        la mise en file est un détail d'exécution, dit dans
                        l'infobulle et le placeholder — pas un bouton à part. */}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void handleSend()}
                      disabled={!draft.trim() || !providerId || !model}
                      title="Mettre en file : envoyé automatiquement à la fin du tour en cours"
                    >
                      Envoyer
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={() => void handleAbort()}>
                      Arrêter
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleSend()}
                    disabled={(!draft.trim() && attachments.length === 0) || attachmentsPending || !providerId || !model}
                    title={attachmentsPending ? "Image en cours de chargement…" : undefined}
                  >
                    Envoyer
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* R4 — modale du résumé de compaction : consulter, recompacter ou
          oublier (retour à l'envoi de l'historique intégral). */}
      {compactionModalOpen && activeCompaction && (
        <Modal label="Résumé de la conversation compactée" onClose={() => setCompactionModalOpen(false)}>
          <div className="compaction-modal">
            <div className="orch-modal__head">
              <h3>Historique compacté</h3>
            </div>
            <p className="compaction-modal__meta">
              {activeCompaction.upToIndex} messages résumés
              {activeCompaction.at ? ` · ${formatRelativeDate(activeCompaction.at)}` : ""}
            </p>
            <div className="compaction-modal__summary">{activeCompaction.summary}</div>
            <div className="actions orch-modal__actions">
              <button
                type="button"
                className="btn"
                onClick={() => void handleRecompact()}
                disabled={recompacting || streaming}
                title="Refaire le résumé par-dessus l'existant (garde les 10 derniers messages intacts)"
              >
                {recompacting ? "Recompaction…" : "Recompacter"}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={handleForgetCompaction}
                disabled={recompacting}
                title="Repasser à l'envoi de l'historique intégral"
              >
                Oublier le résumé
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setCompactionModalOpen(false)}>
                Fermer
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
});
