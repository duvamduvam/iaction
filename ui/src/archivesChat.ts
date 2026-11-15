/*
 * ARCHIVAGE des conversations de la page Chat au-delà du plafond (T-152) —
 * même doctrine que archivesSessions.ts (T-151), appliquée au rangement du
 * Chat : un fichier `chatconv-<id>` par conversation, un index `chat-index`.
 *
 * ── Le défaut que ce module supprime ────────────────────────────────────
 * `buildPersistedChatState` ne gardait que les 30 conversations les plus
 * récentes : `sauverChat` n'écrivait QUE celles-là. Une conversation hors
 * plafond revenait au redémarrage telle qu'à sa dernière écriture, mais tout
 * ce qu'on y changeait entre-temps (renommage, nouveau message) n'était plus
 * écrit, donc perdu — sans message. Le plafond ne bornait d'ailleurs plus rien
 * (52 fichiers pour un plafond de 30).
 *
 * ── Le rangement ────────────────────────────────────────────────────────
 * - Toutes les conversations vives sont écrites, sans plafond.
 * - Celles qui dépassent le plafond sont ARCHIVÉES : `chatarch-<id>` (la
 *   conversation complète) + une entrée dans `chat-index-archives` (liste).
 *   `chargerChat` ne liste que `chatconv-` : une archive ne revient pas dans
 *   le vif au redémarrage, elle se restaure d'un clic.
 * - Rien n'est détruit : la corbeille met de côté sous `retire-…`.
 *
 * ── Les invariants (ceux de T-151) ──────────────────────────────────────
 * 1. Une conversation ne quitte le vif que si son archive ET l'index qui la
 *    rend retrouvable sont écrits. Sinon elle y reste et l'échec est journalisé.
 * 2. La conversation active, celles ouvertes en onglet et celles qui portent
 *    un réveil armé ne sont jamais archivées.
 * 3. Le vif fait foi : une entrée d'index dont l'id existe en vif est ignorée
 *    (et retirée de l'index) — un plantage entre l'écriture de l'archive et la
 *    mise de côté du fichier vif laisse la conversation aux deux endroits.
 * 4. Un index illisible SUSPEND l'archivage (journalisé) au lieu d'être réécrit
 *    à partir d'une liste vide, ce qui rendrait les archives introuvables.
 *
 * Toute la décision est ici, IO injectable, testée sans fenêtre.
 */

import { sansVifs, type EntreeArchive, type Journaliser } from "./archivesSessions";
import type { ChatSession, PersistedChatState } from "./ChatPage";
import { MAX_CHAT_SESSIONS, sanitizeChatState } from "./chatPersistance";
import { nomPour, PREFIXE_CHAT_CONV, type IoEtat } from "./etatEclate";
import { capSessions, sortByRecent } from "./sessionStore";

export const PREFIXE_ARCHIVE_CHAT = "chatarch-";
export const INDEX_ARCHIVES_CHAT = "chat-index-archives";
const PREFIXE_RETIRE = "retire-";
/** Contrainte du magasin Rust : `[a-z0-9-]{1,64}` (state_store.rs). */
const NOM_MAX = 64;

export const nomArchiveChat = (idSession: string): string => nomPour(PREFIXE_ARCHIVE_CHAT, idSession);

/** Les métadonnées d'une conversation archivée (`nbTours` = nombre d'entrées). */
export function resumerChat(session: ChatSession): EntreeArchive {
  return {
    id: session.id,
    title: session.title,
    titleCustom: session.titleCustom,
    ...(session.titreIA ? { titreIA: session.titreIA } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    nbTours: session.entries.length,
  };
}

/** Les conversations qui dépassent le plafond, hors active, onglets ouverts et réveils armés (invariant 2). */
export function choisirArchivablesChat(etat: PersistedChatState, max = MAX_CHAT_SESSIONS): ChatSession[] {
  const gardees = new Set(capSessions(etat.sessions, etat.activeId, max).map((s) => s.id));
  const ouvertes = new Set(etat.openConversationIds);
  return etat.sessions.filter(
    (s) => !gardees.has(s.id) && s.id !== etat.activeId && !ouvertes.has(s.id) && (s.reveils?.length ?? 0) === 0,
  );
}

function estEntree(v: unknown): v is EntreeArchive {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.title === "string" && typeof e.createdAt === "string" && typeof e.updatedAt === "string";
}

function ecrireIndex(io: IoEtat, index: readonly EntreeArchive[]): Promise<void> {
  return io.ecrire(INDEX_ARCHIVES_CHAT, { archives: index });
}

/**
 * Charge l'index. `fiable: false` si la lecture a ÉCHOUÉ (pas si l'index est
 * simplement absent) : l'appelant suspend alors l'archivage (invariant 4).
 * Les entrées dont l'id existe en vif sont retirées et l'index nettoyé réécrit
 * (invariant 3).
 */
export async function chargerIndexArchivesChat(
  io: IoEtat,
  idsVifs: ReadonlySet<string>,
  journaliser: Journaliser,
): Promise<{ index: EntreeArchive[]; fiable: boolean }> {
  let brut: unknown;
  try {
    brut = await io.lire(INDEX_ARCHIVES_CHAT);
  } catch (err) {
    journaliser("error", "index d'archives du Chat illisible : archivage suspendu", { erreur: String(err) });
    return { index: [], fiable: false };
  }
  const liste = (brut as { archives?: unknown } | null)?.archives;
  const entrees = Array.isArray(liste) ? (liste.filter(estEntree) as EntreeArchive[]) : [];
  const propre = sansVifs(entrees, idsVifs);
  if (propre.length !== entrees.length) {
    await ecrireIndex(io, propre).catch((err: unknown) => {
      journaliser("warn", "nettoyage de l'index d'archives du Chat impossible", { erreur: String(err) });
    });
  }
  return { index: propre, fiable: true };
}

/**
 * Archive `aArchiver` et rend les ids dont l'archivage est ACQUIS (fichier +
 * index écrits) : seuls ceux-là peuvent quitter le vif (invariant 1). L'index
 * rendu est celui du disque — inchangé si son écriture a échoué.
 */
export async function archiverChat(
  io: IoEtat,
  aArchiver: readonly ChatSession[],
  index: readonly EntreeArchive[],
  journaliser: Journaliser,
): Promise<{ archivees: string[]; index: EntreeArchive[] }> {
  const ecrites: ChatSession[] = [];
  for (const session of aArchiver) {
    try {
      await io.ecrire(nomArchiveChat(session.id), { session });
      ecrites.push(session);
    } catch (err) {
      journaliser("error", "archivage d'une conversation impossible : elle reste dans le vif", { sessionId: session.id, erreur: String(err) });
    }
  }
  if (ecrites.length === 0) return { archivees: [], index: [...index] };
  const resumes = new Map(ecrites.map((s) => [s.id, resumerChat(s)]));
  const suivant = sortByRecent([...index.filter((e) => !resumes.has(e.id)), ...resumes.values()]);
  try {
    await ecrireIndex(io, suivant);
  } catch (err) {
    journaliser("error", "index d'archives du Chat non écrit : les conversations restent dans le vif", { nombre: ecrites.length, erreur: String(err) });
    return { archivees: [], index: [...index] };
  }
  return { archivees: ecrites.map((s) => s.id), index: suivant };
}

/**
 * Restaure une archive : lit, valide (même assainissement qu'au chargement),
 * puis laisse l'appelant l'insérer dans le vif (`inserer` rend `false` pour
 * renoncer). L'id ne sort de l'index qu'APRÈS l'insertion : une conversation
 * n'est jamais absente des deux endroits. Le fichier d'archive reste sur le disque.
 */
export async function restaurerChat(
  io: IoEtat,
  idSession: string,
  index: readonly EntreeArchive[],
  inserer: (session: ChatSession) => boolean,
  journaliser: Journaliser,
): Promise<{ session: ChatSession; index: EntreeArchive[] } | null> {
  let brut: unknown;
  try {
    brut = await io.lire(nomArchiveChat(idSession));
  } catch (err) {
    journaliser("error", "archive du Chat illisible", { sessionId: idSession, erreur: String(err) });
    return null;
  }
  const session = sanitizeChatState({
    sessions: [(brut as { session?: unknown } | null)?.session],
    activeId: idSession,
    openConversationIds: [idSession],
  })?.sessions[0];
  if (!session || session.id !== idSession) {
    journaliser("error", "archive du Chat invalide ou absente", { sessionId: idSession });
    return null;
  }
  if (!inserer(session)) return null;
  const suivant = index.filter((e) => e.id !== idSession);
  await ecrireIndex(io, suivant).catch((err: unknown) => {
    journaliser("warn", "retrait de l'index d'archives du Chat impossible (le vif fait foi)", { sessionId: idSession, erreur: String(err) });
  });
  return { session, index: suivant };
}

/**
 * Corbeille : MISE DE CÔTÉ sous `retire-…`, jamais détruite. L'index d'abord :
 * un échec laisse tout en place ; un renommage raté laisse un fichier non
 * référencé, inoffensif, et le journal le dit.
 */
export async function mettreDeCoteChat(
  io: IoEtat,
  idSession: string,
  index: readonly EntreeArchive[],
  journaliser: Journaliser,
): Promise<EntreeArchive[]> {
  const suivant = index.filter((e) => e.id !== idSession);
  try {
    await ecrireIndex(io, suivant);
  } catch (err) {
    journaliser("error", "mise de côté d'une archive du Chat impossible (index non écrit)", { sessionId: idSession, erreur: String(err) });
    return [...index];
  }
  const nom = nomArchiveChat(idSession);
  await io.renommer(nom, `${PREFIXE_RETIRE}${nom}`.slice(0, NOM_MAX)).catch((err: unknown) => {
    journaliser("warn", "fichier d'archive du Chat non renommé sous retire-…", { sessionId: idSession, erreur: String(err) });
  });
  return suivant;
}

/** Nom du fichier VIF d'une conversation (pour le retirer une fois archivée). */
export const nomVifChat = (idSession: string): string => nomPour(PREFIXE_CHAT_CONV, idSession);
