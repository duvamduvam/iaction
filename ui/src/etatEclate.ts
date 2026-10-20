/*
 * État ÉCLATÉ : un fichier par projet, un fichier par conversation de Chat
 * (T-061, lot 1 d'etude-deux-projets.md).
 *
 * ── Le défaut que ce module supprime ────────────────────────────────────
 * Tout l'état des conversations vivait dans deux monolithes réécrits EN ENTIER
 * à chaque sauvegarde : `project-conversations.json` (12 Mo, tous les projets,
 * trois sites d'écriture du document complet) et `chat-conversations.json`
 * (467 Ko). Deux fenêtres — même sur des projets DIFFÉRENTS — s'écraseraient
 * mutuellement : perte d'historique garantie, silencieuse. Et chaque
 * sauvegarde coûtait le poste entier au lieu du projet touché.
 *
 * ── Les règles du rangement ─────────────────────────────────────────────
 * 1. Deux fenêtres n'écrivent JAMAIS le même fichier de données (décision
 *    utilisateur du 2026-08-15). L'index du Chat (onglets ouverts, session
 *    active) reste partagé : c'est de l'état de FENÊTRE, que T-062 scopera.
 * 2. Rien ne détruit un historique : les monolithes migrés sont RENOMMÉS
 *    (`…-avant-eclatement`), un projet retiré du registre est mis de côté
 *    (`retire-…`), jamais supprimé — `state_rename` refuse d'ailleurs
 *    d'écraser sa cible.
 * 3. Toute la décision est ici, injectable et testée sans fenêtre ; les pages
 *    ne font qu'appeler.
 *
 * La migration est IDEMPOTENTE : si le renommage final échoue (cible déjà
 * présente d'une migration interrompue), le monolithe est re-éclaté au
 * prochain chargement — réécrire un fichier par projet à l'identique est
 * inoffensif, perdre l'un des deux ne l'est pas.
 */

import { stateList, stateRead, stateRename, stateWrite } from "./stateClient";

/** Ce que le rangement demande au monde extérieur — injectable pour les tests. */
export interface IoEtat {
  lire: (nom: string) => Promise<unknown>;
  ecrire: (nom: string, valeur: unknown) => Promise<void>;
  lister: (prefixe: string) => Promise<string[]>;
  renommer: (nom: string, nouveau: string) => Promise<void>;
}

/** L'implémentation réelle, branchée sur les commandes Tauri. */
export const IO_ETAT: IoEtat = {
  lire: stateRead,
  ecrire: stateWrite,
  lister: stateList,
  renommer: stateRename,
};

// ---------------------------------------------------------------------------
// Noms de fichiers
// ---------------------------------------------------------------------------

export const PREFIXE_PROJET = "projet-";
export const PREFIXE_CHAT_CONV = "chatconv-";
/** Préfixe des mises de côté : hors de portée des `lister()` de chargement. */
const PREFIXE_RETIRE = "retire-";
const MONOLITHE_PROJETS = "project-conversations";
const MONOLITHE_CHAT = "chat-conversations";
const SUFFIXE_SAUVEGARDE = "-avant-eclatement";
/** Contrainte du magasin Rust : `[a-z0-9-]{1,64}` (state_store.rs). */
const NOM_MAX = 64;

/**
 * Nom de fichier d'un id (projet ou conversation). Les ids du dépôt respectent
 * déjà la charte (slugs de projectAdmin, UUID minuscules) — la normalisation
 * ne fait donc RIEN sur les données réelles ; elle borne le cas hostile (id
 * hérité d'un vieux document, corrompu à la main) au lieu de le laisser
 * échouer dans la commande Rust avec un message qui ne nomme pas le projet.
 */
export function nomPour(prefixe: string, id: string): string {
  const propre = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${prefixe}${propre || "sans-nom"}`.slice(0, NOM_MAX).replace(/-+$/, "");
}

/** L'id porté par un nom de fichier listé (inverse de `nomPour` pour nos préfixes). */
export function idDeNom(prefixe: string, nom: string): string {
  return nom.slice(prefixe.length);
}

function estObjetNonVide(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length > 0;
}

// ---------------------------------------------------------------------------
// Projets — Record<projectId, entrée> comme avant, mais un fichier par projet
// ---------------------------------------------------------------------------

/**
 * Migre le monolithe des projets s'il existe encore, puis charge tous les
 * fichiers `projet-*`. Rend le MÊME document en mémoire qu'avant l'éclatement
 * (`Record<projectId, entrée>`) : l'appelant garde sa validation et son
 * hydratation inchangées.
 */
export async function chargerProjets(io: IoEtat): Promise<Record<string, unknown>> {
  await migrerMonolithe(io, MONOLITHE_PROJETS, (id, entree) =>
    io.ecrire(nomPour(PREFIXE_PROJET, id), { id, entree }),
  );

  const doc: Record<string, unknown> = {};
  for (const nom of await io.lister(PREFIXE_PROJET)) {
    const brut = await io.lire(nom).catch(() => null);
    // Chaque fichier porte son id D'ORIGINE : le nom de fichier est normalisé
    // (charte Rust), l'id ne l'est pas — c'est lui qui fait foi.
    if (typeof brut === "object" && brut !== null && "entree" in brut) {
      const { id, entree } = brut as { id?: unknown; entree?: unknown };
      doc[typeof id === "string" && id ? id : idDeNom(PREFIXE_PROJET, nom)] = entree;
    }
  }
  return doc;
}

/** Écrit UN projet — c'est tout l'objet de l'éclatement. */
export async function sauverProjet(io: IoEtat, id: string, entree: unknown): Promise<void> {
  await io.ecrire(nomPour(PREFIXE_PROJET, id), { id, entree });
}

/**
 * Met de côté un projet disparu du registre. Non destructif : le fichier passe
 * sous `retire-…`, hors de portée du chargement. Une cible déjà prise (retiré
 * deux fois ?) fait échouer le renommage — on ignore : le fichier restera
 * listé et simplement re-filtré par l'appelant, comme avant l'éclatement.
 */
export async function retirerProjet(io: IoEtat, id: string): Promise<void> {
  const nom = nomPour(PREFIXE_PROJET, id);
  await io.renommer(nom, `${PREFIXE_RETIRE}${nom}`.slice(0, NOM_MAX)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Chat — un fichier par conversation, un index d'affichage
// ---------------------------------------------------------------------------

/** Index du Chat : l'état de FENÊTRE (session active, onglets), pas les données. */
export const INDEX_CHAT = "chat-index";

export interface IndexChat {
  activeId: string | null;
  openConversationIds: string[];
}

interface SessionChatMinimale {
  id: string;
  updatedAt?: string;
}

/**
 * Migre le monolithe du Chat s'il existe, puis charge toutes les conversations
 * et l'index. Les sessions sont rendues de la plus récemment modifiée à la
 * plus ancienne — l'ordre que la liste affiche.
 */
export async function chargerChat(io: IoEtat): Promise<{ sessions: unknown[]; index: IndexChat }> {
  await migrerMonolitheChat(io);

  const sessions: unknown[] = [];
  for (const nom of await io.lister(PREFIXE_CHAT_CONV)) {
    const brut = await io.lire(nom).catch(() => null);
    if (typeof brut === "object" && brut !== null && "id" in brut) sessions.push(brut);
  }
  sessions.sort((a, b) =>
    String((b as SessionChatMinimale).updatedAt ?? "").localeCompare(
      String((a as SessionChatMinimale).updatedAt ?? ""),
    ),
  );

  const brut = await io.lire(INDEX_CHAT).catch(() => null);
  const v = (typeof brut === "object" && brut !== null ? brut : {}) as Record<string, unknown>;
  return {
    sessions,
    index: {
      activeId: typeof v.activeId === "string" ? v.activeId : null,
      openConversationIds: Array.isArray(v.openConversationIds)
        ? v.openConversationIds.filter((x): x is string => typeof x === "string")
        : [],
    },
  };
}

/**
 * Sauvegarde du Chat : n'écrit QUE ce qui a changé depuis la dernière écriture
 * (empreinte JSON par conversation, tenue par appelant via `dejaEcrit`). Les
 * appels existants passent la liste complète — écrire N fichiers inchangés à
 * chaque frappe serait pire que le monolithe.
 */
export async function sauverChat(
  io: IoEtat,
  sessions: readonly SessionChatMinimale[],
  index: IndexChat,
  dejaEcrit: Map<string, string>,
): Promise<void> {
  for (const session of sessions) {
    const empreinte = JSON.stringify(session);
    if (dejaEcrit.get(session.id) === empreinte) continue;
    await io.ecrire(nomPour(PREFIXE_CHAT_CONV, session.id), session);
    dejaEcrit.set(session.id, empreinte);
  }
  await io.ecrire(INDEX_CHAT, index);
}

/** Conversation supprimée (ou élaguée par le plafond) : mise de côté, pas détruite. */
export async function retirerConversationChat(io: IoEtat, id: string, dejaEcrit: Map<string, string>): Promise<void> {
  const nom = nomPour(PREFIXE_CHAT_CONV, id);
  dejaEcrit.delete(id);
  await io.renommer(nom, `${PREFIXE_RETIRE}${nom}`.slice(0, NOM_MAX)).catch(() => {});
}

// ---------------------------------------------------------------------------
// Migration des monolithes
// ---------------------------------------------------------------------------

async function migrerMonolithe(
  io: IoEtat,
  cle: string,
  ecrireEntree: (id: string, entree: unknown) => Promise<void>,
): Promise<void> {
  const brut = await io.lire(cle).catch(() => null);
  if (!estObjetNonVide(brut)) return;
  for (const [id, entree] of Object.entries(brut)) {
    await ecrireEntree(id, entree);
  }
  // Renommage EN DERNIER : si quoi que ce soit a échoué avant, le monolithe
  // reste la vérité et la migration recommencera — idempotente par écriture.
  await io.renommer(cle, `${cle}${SUFFIXE_SAUVEGARDE}`).catch(() => {});
}

async function migrerMonolitheChat(io: IoEtat): Promise<void> {
  const brut = await io.lire(MONOLITHE_CHAT).catch(() => null);
  if (!estObjetNonVide(brut)) return;
  const v = brut as Record<string, unknown>;
  const sessions = Array.isArray(v.sessions) ? v.sessions : [];
  for (const session of sessions) {
    if (typeof session === "object" && session !== null && typeof (session as SessionChatMinimale).id === "string") {
      await io.ecrire(nomPour(PREFIXE_CHAT_CONV, (session as SessionChatMinimale).id), session);
    }
  }
  await io.ecrire(INDEX_CHAT, {
    activeId: typeof v.activeId === "string" ? v.activeId : null,
    openConversationIds: Array.isArray(v.openConversationIds) ? v.openConversationIds : [],
  });
  await io.renommer(MONOLITHE_CHAT, `${MONOLITHE_CHAT}${SUFFIXE_SAUVEGARDE}`).catch(() => {});
}
