/*
 * Persistance de la page Chat — la logique pure (validation défensive du
 * document lu du disque, sérialisation bornée), sortie de ChatPage.tsx
 * (T-209). Feuille : n'importe les types de ChatPage qu'en TYPE (pas de cycle
 * à l'exécution), comme chatTitres.ts. Le schéma est décrit au-dessus de
 * `ChatSession` dans ChatPage.tsx.
 */
import { toAttachmentRefs, type SentAttachment } from "./Attachments";
import type { ChatEntry, ChatSession, PersistedChatState } from "./ChatPage";
import { toChatCompaction } from "./chatCompaction";
import { titreSessionChat } from "./chatTitres";
import { withReveilsDefault } from "./reveil";
import { isRouteTier, toRouteTarget } from "./protocole";

export const MAX_PERSISTED_CHAT_ENTRIES = 200;
/** Seuil d'ARCHIVAGE des conversations du Chat (archivesChat.ts) — plus un plafond d'écriture (T-152). */
export const MAX_CHAT_SESSIONS = 30;

/**
 * Ids d'entrées : PERSISTÉS avec la session (clés React du fil, cibles des
 * patchs `withAppendedDelta`/`withEntryDone`) — un compteur de module
 * repartirait de zéro à chaque lancement/HMR et ferait entrer en collision
 * une entrée neuve avec une entrée persistée (même défaut que `nextId` côté
 * AgentPage.tsx, constaté le 2026-08-04). D'où l'UUID.
 */
export function nextEntryId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
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
    (v.compaction === null || toChatCompaction(v.compaction) !== null) &&
    // T-120 — même principe que `compaction` juste au-dessus (`withReveilsDefault` déjà passé).
    (v.reveils === undefined || Array.isArray(v.reveils)) &&
    (v.reveilsHistorique === undefined || Array.isArray(v.reveilsHistorique))
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
function withTitreIAAssaini(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (v.titreIA === undefined || (typeof v.titreIA === "string" && v.titreIA.trim() !== "")) return value;
  const { titreIA: _illisible, ...sans } = v; // T-197 : un titre IA illisible est ignoré, il n'invalide pas la session
  void _illisible;
  return sans;
}

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

export function sanitizeChatState(raw: unknown): PersistedChatState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (!Array.isArray(v.sessions) || v.sessions.length === 0) return null;
  const normalizedSessions = v.sessions
    .map(withWebSearchDefault)
    .map(withRoutingDefaults)
    .map(withCompactionDefault)
    .map(withTitreIAAssaini)
    .map(withReveilsDefault);
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

/**
 * Sérialise une session en vue de la persistance : borne aux 200 dernières
 * entrées, jamais un tour encore `streaming`, et — conformément au contrat —
 * les pièces jointes perdent leur aperçu (`toAttachmentRefs`) : seuls
 * `kind`/`name` survivent sur disque.
 */
export function buildPersistedChatSession(session: ChatSession): ChatSession {
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
    // `titreIA` voyage avec le `...session` ci-dessus ; le titre affiché suit la règle unique (T-197).
    title: titreSessionChat(session, persistableEntries),
  };
}

/**
 * Sérialise le document complet. AUCUN plafond ici (T-152) : toutes les
 * conversations vives sont écrites, sinon celles qui dépassaient le plafond
 * perdaient en silence leurs modifications. Ce qui dépasse `MAX_CHAT_SESSIONS`
 * est ARCHIVÉ par archivesChat.ts (restaurable), pas abandonné.
 * `openConversationIds` est filtré en cohérence (jamais une référence à une
 * session absente), avec un repli sur `[activeId]` si ce filtrage le viderait
 * entièrement (jamais zéro onglet persisté alors qu'une session active existe).
 */
export function buildPersistedChatState(state: PersistedChatState): PersistedChatState {
  const knownIds = new Set(state.sessions.map((s) => s.id));
  const openConversationIds = state.openConversationIds.filter((id) => knownIds.has(id));
  return {
    sessions: state.sessions.map(buildPersistedChatSession),
    activeId: state.activeId,
    openConversationIds: openConversationIds.length > 0 ? openConversationIds : [state.activeId],
  };
}
