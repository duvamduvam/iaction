/*
 * Modèle des conversations de projet : types, constructeurs, persistance,
 * migrations et réparations. Extrait d'AgentPage le 2026-08-08 (étape 8).
 *
 * ── Pourquoi ce module compte plus qu'un autre ──────────────────────────
 * Tout ce fichier travaille sur LES DONNÉES DE L'UTILISATEUR : ses sessions,
 * leurs titres, leurs tours. Un défaut ici ne s'affiche pas mal — il PERD
 * quelque chose. Les migrations (deux générations de formes persistées), la
 * réparation de routage et la déduplication d'identifiants de tours sont
 * précisément les endroits où une régression silencieuse coûte le plus.
 * C'est aussi ici que vit la leçon des ids en collision (2026-08-04) : des
 * UUID partout, JAMAIS un compteur, et une réparation globale au chargement.
 *
 * Règles de tolérance : une session inconnue est ÉCARTÉE (sanitize), mais une
 * valeur optionnelle hors vocabulaire est RÉPARÉE (withRoutingRepair) avant
 * validation — les deux lignes de défense en profondeur dans
 * hasCommonSessionFields ne doivent jamais invalider une session réelle.
 *
 * Feuille testable : imports de valeurs uniquement depuis d'autres feuilles
 * (agentTurns, sessionStore, protocole) ; tout ce qui vient de sidecar.ts ou
 * de composants est un import de TYPE, effacé à la compilation.
 */

import { nextId, type AgentTurn } from "./agentTurns";
import { toAttachmentRefs } from "./Attachments";
import type { OpenFileState } from "./FileEditor";
import type { AgentInfo, AgentScope } from "./orchestrationClient";
import { isRouteTier, toRouteTarget } from "./protocole";
import { capSessions, deriveTitleFromText, newSessionMeta } from "./sessionStore";
import type { DebordNotice } from "./debordNotice";
import type { RouteTarget, RouteTier } from "./sidecar";

export interface EngineConfig {
  providerId: string | null;
  model: string;
}

export function claudeEngine(): EngineConfig {
  return { providerId: null, model: "" };
}

/** Référence (nom + portée) vers un agent déclaré — voir orchestrationClient.ts. `null` = mode manuel. */
export interface AgentSelection {
  name: string;
  scope: AgentScope;
}

/**
 * Une session de conversation dans un projet donné : c'est le grain
 * persisté/basculé par le panneau « Sessions » (voir `SidebarSection`
 * « sessions » plus bas). `titleCustom` : `true` dès que l'utilisateur a
 * renommé la session — le titre auto (voir `deriveTitleFromText`,
 * sessionStore.ts) n'est alors plus jamais recalculé.
 *
 * `turns`/`sessionId` restent ici la dernière copie CONNUE (utile tant que la
 * conversation n'a jamais été ouverte cette exécution) — dès qu'elle est
 * ouverte, c'est son `ConvRuntime` (voir plus bas) qui fait foi, y compris en
 * arrière-plan ; `buildLiveSessions` recombine les deux à chaque sauvegarde.
 */
export interface ProjectSession {
  id: string;
  title: string;
  titleCustom: boolean;
  createdAt: string;
  updatedAt: string;
  turns: AgentTurn[];
  sessionId: string | null;
  engine: EngineConfig;
  /** Agent sélectionné pour cette session (sélecteur « LLM » → Agent), `null` = manuel. */
  selectedAgent: AgentSelection | null;
  /** R7 — plancher de session du mode Auto (relevé à la hausse uniquement) + dernière cible utilisée (`null` sinon). */
  routedTier: RouteTier | null;
  routedTarget: RouteTarget | null;
}

/**
 * État en mémoire d'un projet : toutes ses sessions, laquelle est « active »
 * (celle dont la config LLM s'affiche/s'édite dans le panneau « LLM »), et
 * les onglets affichés dans la barre principale. `openFiles`/`activeTab`
 * sont désormais PROJET (partagés entre toutes les conversations) — voir le
 * commentaire d'en-tête de fichier : la maquette mélange onglets de
 * conversation et onglets de fichier dans une même barre, ce qui n'aurait
 * aucun sens s'ils restaient dupliqués par session. `activeTab` vaut
 * `convTabId(id)` pour une conversation, ou un chemin de fichier.
 */
export interface ProjectState {
  sessions: ProjectSession[];
  activeId: string;
  openConversationIds: string[];
  openFiles: OpenFileState[];
  activeTab: string;
}

/** Préfixe distinguant un onglet de conversation d'un chemin de fichier dans `activeTab`/`openConversationIds`. */
export const CONV_TAB_PREFIX = "conv:";
export function convTabId(sessionId: string): string {
  return `${CONV_TAB_PREFIX}${sessionId}`;
}
export function isConvTab(tab: string): boolean {
  return tab.startsWith(CONV_TAB_PREFIX);
}
export function convIdOfTab(tab: string): string {
  return tab.slice(CONV_TAB_PREFIX.length);
}
/** Onglet « vide » : dernier onglet de conversation ET dernier onglet fichier fermés (voir `closeConversationTab`). */
export const EMPTY_TAB = "";


export function freshSession(): ProjectSession {
  return {
    ...newSessionMeta(),
    turns: [],
    sessionId: null,
    engine: claudeEngine(),
    selectedAgent: null,
    routedTier: null,
    routedTarget: null,
  };
}

export function emptyProjectState(): ProjectState {
  const session = freshSession();
  return { sessions: [session], activeId: session.id, openConversationIds: [session.id], openFiles: [], activeTab: convTabId(session.id) };
}

/* ---------- Persistance (Lot 3, étendu Lot Sessions) ---------- */

export const CONVERSATIONS_STATE_KEY = "project-conversations";
/** Dernier projet ouvert : réouvert au démarrage suivant (voir l'effet de sélection initiale). */
export const LAST_PROJECT_STATE_KEY = "last-project";
export const MAX_PERSISTED_TURNS = 200;
export const MAX_SESSIONS_PER_PROJECT = 30;
export const SAVE_DEBOUNCE_MS = 1500;

/** Forme persistée d'une session — les CHEMINS des fichiers ouverts vivent désormais au niveau PROJET, voir `PersistedProjectEntry`. */
export interface PersistedSession {
  id: string;
  title: string;
  titleCustom: boolean;
  createdAt: string;
  updatedAt: string;
  turns: AgentTurn[];
  sessionId: string | null;
  /** Absent (sessions antérieures au Lot 6) = Claude (abonnement), voir `sessionStateFromPersisted`. */
  engine?: EngineConfig;
  /** Absent (sessions antérieures à la phase O2) = mode manuel, voir `sessionStateFromPersisted`. */
  selectedAgent?: AgentSelection | null;
  /** R2 — absents (sessions antérieures) = aucune affinité de routage, voir `sessionStateFromPersisted`. */
  routedTier?: RouteTier | null;
  routedTarget?: RouteTarget | null;
}

/**
 * Forme persistée d'un projet (Lot Onglets multiples) : plusieurs sessions +
 * laquelle est active, plus les onglets réellement affichés — `openFilePaths`/
 * `activeTab` étaient PAR SESSION avant ce lot (voir `OldMultiSessionEntry`
 * ci-dessous, migrée transparemment par `migrateOldMultiSessionEntry`).
 */
export interface PersistedProjectEntry {
  sessions: PersistedSession[];
  activeId: string;
  /** Sessions ouvertes en onglet (voir `openConversationIds` de `ProjectState`). */
  openConversationIds: string[];
  openFilePaths: string[];
  activeTab: string;
}

export type PersistedConversations = Record<string, PersistedProjectEntry>;

/**
 * Ancienne forme (avant le Lot Sessions) : UNE seule conversation par projet,
 * pas de tableau `sessions` — voir `migrateLegacyProjectState`, appelée par
 * `sanitizePersistedConversations` pour migrer transparemment au chargement.
 */
export interface LegacyPersistedProjectState {
  turns: AgentTurn[];
  sessionId: string | null;
  openFilePaths: string[];
  activeTab: string;
  updatedAt: string;
  engine?: EngineConfig;
}

/**
 * Forme intermédiaire (Lot Sessions, avant le Lot Onglets multiples) :
 * plusieurs sessions, mais `openFilePaths`/`activeTab` PAR SESSION plutôt que
 * par projet — voir `migrateOldMultiSessionEntry`.
 */
export interface OldPersistedSession {
  id: string;
  title: string;
  titleCustom: boolean;
  createdAt: string;
  updatedAt: string;
  turns: AgentTurn[];
  sessionId: string | null;
  openFilePaths: string[];
  activeTab: string;
  engine?: EngineConfig;
  selectedAgent?: AgentSelection | null;
}

export interface OldMultiSessionEntry {
  sessions: OldPersistedSession[];
  activeId: string;
}

export function isEngineConfig(value: unknown): value is EngineConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (typeof v.providerId === "string" || v.providerId === null) && typeof v.model === "string";
}

export function isAgentSelection(value: unknown): value is AgentSelection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    !!v.name &&
    (v.scope === "project" || v.scope === "global" || v.scope === "claude-code")
  );
}

/**
 * Valide une sélection d'agent persistée contre la liste vivante du même
 * projet (bascule ENTRE SESSIONS d'un même projet — `list` déjà à jour dans
 * ce cas, contrairement à une bascule de projet où `loadProjectAgents`
 * s'en charge de façon asynchrone). Agent introuvable → retombe sur `null`.
 */
export function resolveAgentSelection(key: AgentSelection | null, list: AgentInfo[]): AgentSelection | null {
  if (!key) return null;
  return list.some((a) => a.name === key.name && a.scope === key.scope) ? key : null;
}

/** Valeur d'`<option>` encodant portée + nom (un nom peut se répéter entre portées). */
export function agentOptionValue(a: { scope: AgentScope; name: string }): string {
  return `${a.scope}::${a.name}`;
}

/** Champs communs id/titre/tours/agent aux trois formes de session persistée (nouvelle et ancienne). */
export function hasCommonSessionFields(v: Record<string, unknown>): boolean {
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.titleCustom === "boolean" &&
    typeof v.createdAt === "string" &&
    typeof v.updatedAt === "string" &&
    Array.isArray(v.turns) &&
    (typeof v.sessionId === "string" || v.sessionId === null) &&
    (v.engine === undefined || isEngineConfig(v.engine)) &&
    (v.selectedAgent === undefined || v.selectedAgent === null || isAgentSelection(v.selectedAgent)) &&
    // R2 — affinité de routage : optionnelle, et RÉPARÉE en amont par
    // `withRoutingRepair` (une valeur hors vocabulaire est retirée avant
    // d'arriver ici — ces deux lignes ne restent que par défense en
    // profondeur, elles ne doivent JAMAIS invalider une session réelle).
    (v.routedTier === undefined || v.routedTier === null || isRouteTier(v.routedTier)) &&
    (v.routedTarget === undefined || v.routedTarget === null || toRouteTarget(v.routedTarget) !== null)
  );
}

export function isPersistedSession(value: unknown): value is PersistedSession {
  if (typeof value !== "object" || value === null) return false;
  return hasCommonSessionFields(value as Record<string, unknown>);
}

export function isOldPersistedSession(value: unknown): value is OldPersistedSession {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    hasCommonSessionFields(v) &&
    Array.isArray(v.openFilePaths) &&
    v.openFilePaths.every((p) => typeof p === "string") &&
    typeof v.activeTab === "string"
  );
}

/** Forme ACTUELLE (Lot Onglets multiples) : onglets au niveau projet, distingués de l'ancienne forme par leur présence. */
export function isPersistedProjectEntry(value: unknown): value is PersistedProjectEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.sessions) &&
    v.sessions.length > 0 &&
    v.sessions.every(isPersistedSession) &&
    typeof v.activeId === "string" &&
    Array.isArray(v.openConversationIds) &&
    v.openConversationIds.every((id) => typeof id === "string") &&
    Array.isArray(v.openFilePaths) &&
    v.openFilePaths.every((p) => typeof p === "string") &&
    typeof v.activeTab === "string"
  );
}

/** Forme intermédiaire (Lot Sessions) : onglets encore PAR SESSION, pas de champs projet — voir `migrateOldMultiSessionEntry`. */
export function isOldMultiSessionEntry(value: unknown): value is OldMultiSessionEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.sessions) && v.sessions.length > 0 && v.sessions.every(isOldPersistedSession) && typeof v.activeId === "string";
}

export function isLegacyPersistedProjectState(value: unknown): value is LegacyPersistedProjectState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.turns) &&
    (typeof v.sessionId === "string" || v.sessionId === null) &&
    Array.isArray(v.openFilePaths) &&
    v.openFilePaths.every((p) => typeof p === "string") &&
    typeof v.activeTab === "string" &&
    typeof v.updatedAt === "string" &&
    (v.engine === undefined || isEngineConfig(v.engine))
  );
}

/** Titre auto d'une session depuis ses tours (premier message utilisateur, voir sessionStore.ts). */
export function deriveSessionTitle(turns: AgentTurn[]): string {
  const firstUser = turns.find((t) => t.role === "user");
  return deriveTitleFromText(firstUser?.displayContent ?? firstUser?.content ?? "");
}

/** Migre une conversation « ancienne forme » (pré-Lot Sessions) en une session unique, ouverte en onglet — rien n'est perdu. */
export function migrateLegacyProjectState(legacy: LegacyPersistedProjectState): PersistedProjectEntry {
  const session: PersistedSession = {
    id: crypto.randomUUID(),
    title: deriveSessionTitle(legacy.turns),
    titleCustom: false,
    createdAt: legacy.updatedAt,
    updatedAt: legacy.updatedAt,
    turns: legacy.turns,
    sessionId: legacy.sessionId,
    engine: legacy.engine,
  };
  return {
    sessions: [session],
    activeId: session.id,
    openConversationIds: [session.id],
    openFilePaths: legacy.openFilePaths,
    activeTab: legacy.activeTab === "conversation" ? convTabId(session.id) : legacy.activeTab,
  };
}

/**
 * Migre une entrée « Lot Sessions » (onglets fichiers/actif PAR SESSION) vers
 * la forme actuelle (onglets au niveau PROJET) : on reprend les onglets
 * fichiers/l'onglet actif de la session qui était active — les onglets des
 * AUTRES sessions de l'ancienne forme sont perdus (ils dupliquaient de toute
 * façon rarement des fichiers différents en pratique), mais aucun TOUR n'est
 * perdu. Seule la session active rouvre en onglet ; les autres restent
 * consultables depuis le panneau « Sessions ».
 */
export function migrateOldMultiSessionEntry(old: OldMultiSessionEntry): PersistedProjectEntry {
  const activeSession = old.sessions.find((s) => s.id === old.activeId) ?? old.sessions[0];
  return {
    sessions: old.sessions.map(({ openFilePaths: _openFilePaths, activeTab: _activeTab, ...rest }) => rest),
    activeId: activeSession.id,
    openConversationIds: [activeSession.id],
    openFilePaths: activeSession.openFilePaths,
    activeTab: activeSession.activeTab === "conversation" ? convTabId(activeSession.id) : activeSession.activeTab,
  };
}

/**
 * RÉPARE les champs d'affinité de routage (R2) d'une session brute AVANT
 * validation — même principe que `withRoutingDefaults` côté ChatPage.tsx : une
 * valeur hors vocabulaire (document altéré, ancienne version) est simplement
 * RETIRÉE, la session est conservée SANS affinité. Sans cette réparation,
 * `hasCommonSessionFields` invalidait la session, et avec elle l'ENTRÉE
 * PROJET entière (historique perdu) — inacceptable pour des champs purement
 * optionnels.
 */
export function withRoutingRepair(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (v.routedTier === undefined && v.routedTarget === undefined) return value;
  return {
    ...v,
    routedTier: isRouteTier(v.routedTier) ? v.routedTier : null,
    routedTarget: toRouteTarget(v.routedTarget),
  };
}

/** Applique `withRoutingRepair` à chaque session d'une entrée projet brute (formes avec tableau `sessions`). */
export function withSessionsRoutingRepair(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.sessions)) return value;
  return { ...v, sessions: v.sessions.map(withRoutingRepair) };
}

/**
 * Valide défensivement le document lu du disque (peut être `{}`, absent, ou
 * corrompu) et MIGRE au passage toute entrée encore à une forme antérieure
 * (avant le Lot Sessions, ou avant le Lot Onglets multiples) — voir
 * `migrateLegacyProjectState`/`migrateOldMultiSessionEntry`. Une entrée qui
 * ne correspond à aucune forme connue est silencieusement ignorée (comme
 * avant ce lot). L'ordre des essais compte : la forme actuelle en premier
 * (le cas le plus fréquent une fois ce lot déployé), la plus ancienne en
 * dernier. Les champs d'affinité de routage sont RÉPARÉS avant validation
 * (voir `withRoutingRepair`) : jamais une invalidation d'entrée pour eux.
 */
/**
 * Réattribue un id frais à tout tour (et bloc) dont l'id est déjà porté par un
 * tour vu AVANT lui — dans la même session ou dans n'importe quelle autre :
 * `seenTurns`/`seenBlocks` sont PARTAGÉS sur tout le document, car les
 * doublons constatés (2026-08-04 : 122 ids partagés entre sessions de rdpl,
 * `u-1`/`a-2` dans presque chaque conversation) sont inter-sessions — le
 * compteur d'ids repartait de zéro à chaque lancement. Or le fil rend toutes
 * les conversations dans le MÊME composant : au changement d'onglet, React
 * réconcilie par clé, et deux tours de conversations différentes portant la
 * même clé se font « réutiliser » — c'est le fantôme d'une ancienne
 * conversation dans un onglet neuf. On répare à la lecture, une fois pour
 * toutes (la prochaine sauvegarde persiste les ids corrigés).
 */
export function dedupeTurnIds(turns: AgentTurn[], seenTurns: Set<string>, seenBlocks: Set<string>): AgentTurn[] {
  return turns.map((t) => {
    let turn = seenTurns.has(t.id) ? { ...t, id: nextId(t.role === "user" ? "u" : "a") } : t;
    seenTurns.add(turn.id);
    if (turn.blocks) {
      turn = {
        ...turn,
        blocks: turn.blocks.map((b) => {
          const block = seenBlocks.has(b.id) ? { ...b, id: nextId("blk") } : b;
          seenBlocks.add(block.id);
          return block;
        }),
      };
    }
    return turn;
  });
}

/** Applique `dedupeTurnIds` aux sessions d'une entrée, avec les « déjà vus » du document entier. */
export function withDedupedTurnIds(
  entry: PersistedProjectEntry,
  seenTurns: Set<string>,
  seenBlocks: Set<string>,
): PersistedProjectEntry {
  return { ...entry, sessions: entry.sessions.map((s) => ({ ...s, turns: dedupeTurnIds(s.turns, seenTurns, seenBlocks) })) };
}

export function sanitizePersistedConversations(raw: unknown): PersistedConversations {
  if (typeof raw !== "object" || raw === null) return {};
  const out: PersistedConversations = {};
  // Unicité GLOBALE des ids de tours/blocs — voir dedupeTurnIds : les
  // collisions à réparer sont inter-sessions et inter-projets.
  const seenTurns = new Set<string>();
  const seenBlocks = new Set<string>();
  for (const [id, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const value = withSessionsRoutingRepair(rawValue);
    if (isPersistedProjectEntry(value)) {
      out[id] = withDedupedTurnIds(value, seenTurns, seenBlocks);
    } else if (isOldMultiSessionEntry(value)) {
      out[id] = withDedupedTurnIds(migrateOldMultiSessionEntry(value), seenTurns, seenBlocks);
    } else if (isLegacyPersistedProjectState(value)) {
      out[id] = withDedupedTurnIds(migrateLegacyProjectState(value), seenTurns, seenBlocks);
    }
  }
  return out;
}

/**
 * Sérialise une `ProjectSession` en vue de la persistance : borne aux 200
 * derniers tours, et exclut tout tour encore `streaming` (jamais persisté
 * dans cet état — un tour interrompu au milieu perd juste son contenu
 * partiel, les tours précédents restent intacts). Le titre auto est
 * recalculé à chaque sauvegarde tant qu'il n'a pas été personnalisé. Les
 * pièces jointes perdent leur aperçu (`toAttachmentRefs`) : conformément au
 * contrat, seuls `kind`/`name` survivent sur disque.
 */
export function buildPersistedSession(session: ProjectSession): PersistedSession {
  const persistableTurns = session.turns
    .filter((t) => t.status !== "streaming")
    .slice(-MAX_PERSISTED_TURNS)
    .map((t) => (t.attachments ? { ...t, attachments: toAttachmentRefs(t.attachments) } : t));
  return {
    id: session.id,
    title: session.titleCustom ? session.title : deriveSessionTitle(persistableTurns),
    titleCustom: session.titleCustom,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns: persistableTurns,
    sessionId: session.sessionId,
    engine: session.engine,
    selectedAgent: session.selectedAgent,
    routedTier: session.routedTier,
    routedTarget: session.routedTarget,
  };
}

/**
 * Sérialise un `ProjectState` complet : plafonne le nombre de sessions
 * conservées (voir `capSessions`, sessionStore.ts) — `openConversationIds`
 * est filtré en cohérence (jamais une référence à une session tombée hors
 * plafond), avec un repli sur `[activeId]` si ce filtrage le viderait
 * entièrement (jamais zéro onglet de conversation persisté alors qu'une
 * session active existe).
 */
export function buildPersistedEntry(state: ProjectState): PersistedProjectEntry {
  const keptSessions = capSessions(state.sessions, state.activeId, MAX_SESSIONS_PER_PROJECT);
  const keptIds = new Set(keptSessions.map((s) => s.id));
  const openConversationIds = state.openConversationIds.filter((id) => keptIds.has(id));
  return {
    sessions: keptSessions.map(buildPersistedSession),
    activeId: state.activeId,
    openConversationIds: openConversationIds.length > 0 ? openConversationIds : [state.activeId],
    openFilePaths: state.openFiles.map((f) => f.path),
    activeTab: state.activeTab,
  };
}

/** Reconstruit une `ProjectSession` en mémoire depuis une entrée persistée (tours/id de session serveur — plus d'onglets, désormais au niveau projet). */
export function sessionStateFromPersisted(entry: PersistedSession): ProjectSession {
  return {
    id: entry.id,
    title: entry.title,
    titleCustom: entry.titleCustom,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    turns: entry.turns,
    sessionId: entry.sessionId,
    engine: entry.engine ?? claudeEngine(),
    selectedAgent: entry.selectedAgent ?? null,
    // R2 — assainissement défensif (valeurs corrompues → aucune affinité).
    routedTier: isRouteTier(entry.routedTier) ? entry.routedTier : null,
    routedTarget: toRouteTarget(entry.routedTarget),
  };
}

/**
 * Reconstruit les onglets FICHIER (niveau projet) depuis leurs chemins
 * persistés : redeviennent des onglets à l'état `loading` (contenu vide, pas
 * encore lu), chemin ajouté à `pendingLazy` — c'est `triggerLazyLoad` (dans
 * le composant) qui déclenchera le `fsReadFile` réel, au moment où l'onglet
 * devient actif.
 */

/* ---------- État VIF d'une conversation ouverte (jamais persisté tel quel) ---------- */

/** Valeur sentinelle du sélecteur de modèle : « Auto (routeur) », voir R2/R7. */
export const AUTO_MODEL = "__auto__";

/**
 * État VIF d'une conversation ouverte en onglet. Ce qui était mono-valué
 * quand une seule conversation vivait à la fois (`turns`, `sessionId`,
 * `streaming`…) est désormais porté ici, une instance par conversation
 * ouverte : c'est ce qui permet à un onglet d'arrière-plan de continuer à
 * streamer pendant qu'on lit ou qu'on écrit dans un autre.
 *
 * `activeEngine` fige le moteur RÉELLEMENT utilisé par le tour en cours : le
 * sélecteur de moteur peut changer pendant un streaming, l'abandon
 * (`handleAbort`) doit rester routé vers le bon moteur.
 */
export interface ConvRuntime {
  turns: AgentTurn[];
  /** Id de session côté serveur Claude (`null` tant qu'aucun tour n'a été envoyé). */
  sessionId: string | null;
  streaming: boolean;
  /** Id de requête protocolaire du tour en cours (permissions/abandon), `null` hors streaming. */
  activeRequestId: string | null;
  activeEngine: "claude" | "neutral";
  /** Brouillon du composeur — par conversation : on peut taper dans l'une pendant que l'autre travaille. */
  draft: string;
  /** Prompts mis en file pendant un streaming, envoyés un par un (ordre d'arrivée) à la fin de chaque tour. */
  queuedPrompts: string[];
  mcpUsage: Record<string, { calls: number; lastTool: string }>;
  /** R7 — plancher de session du mode Auto (miroir vif de `ProjectSession.routedTier`/`routedTarget`). */
  routedTier: RouteTier | null;
  routedTarget: RouteTarget | null;
  /** Raisons du classement (infobulle des tours suivants) — non persistées. */
  routedReasons: string[] | null;
  /** R3 — bandeau de débord du DERNIER tour envoyé (éphémère, jamais persisté — voir ChatPage.tsx). */
  debordNotice: DebordNotice | null;
  /**
   * « Arrêter » cliqué pendant la phase de PRÉ-ENVOI (routage Auto, lecture
   * des connaissances — avant tout claude.start/neutral.start) : le point de
   * contrôle de `handleSend` abandonne alors le tour proprement, sans envoi.
   */
  preSendAbort: boolean;
}

export function freshRuntime(
  turns: AgentTurn[] = [],
  sessionId: string | null = null,
  routedTier: RouteTier | null = null,
  routedTarget: RouteTarget | null = null,
): ConvRuntime {
  return {
    turns,
    sessionId,
    streaming: false,
    activeRequestId: null,
    activeEngine: "claude",
    draft: "",
    queuedPrompts: [],
    mcpUsage: {},
    routedTier,
    routedTarget,
    routedReasons: null,
    debordNotice: null,
    preSendAbort: false,
  };
}
