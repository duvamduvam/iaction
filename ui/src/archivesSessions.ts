/*
 * ARCHIVAGE des sessions hors plafond d'un projet (T-151).
 *
 * ── Le défaut que ce module supprime ────────────────────────────────────
 * `projet-<id>.json` est plafonné à 30 sessions (taille : 6,6 Mo pour 30,
 * réécrit en entier à chaque sauvegarde). Avant ce module, la 31ᵉ session
 * faisait SORTIR la plus ancienne du fichier, sans trace ni message : tout
 * l'historique « robot » d'un projet a ainsi disparu au redémarrage suivant.
 * C'était l'inverse de la règle 2 d'etatEclate.ts (« rien ne détruit un
 * historique »). Le plafond reste — c'est le sort des sessions qui en sortent
 * qui change : elles sont ARCHIVÉES, chargées à la demande.
 *
 * ── Le rangement ────────────────────────────────────────────────────────
 * - `projarch-<idSession>` : UNE session archivée, complète, avec l'id du projet.
 * - `archives-<idProjet>`  : l'index des archives d'UN projet, métadonnées de
 *   liste seulement. Par projet : deux fenêtres sur des projets différents
 *   n'écrivent jamais le même fichier (règle 1 d'etatEclate.ts).
 * Aucun des deux préfixes ne commence par `projet-` : `chargerProjets` fait
 * `lister("projet-")` et prendrait sinon une archive pour un projet.
 *
 * ── Les invariants ──────────────────────────────────────────────────────
 * 1. Une session ne quitte le fichier projet que si son archive ET l'index
 *    qui la rend retrouvable sont écrits. Sinon elle y reste (quitte à
 *    dépasser le plafond) et l'échec est journalisé.
 * 2. La session active et les sessions ouvertes en onglet ne sont jamais
 *    archivées.
 * 3. Le vif fait foi : une entrée d'index dont l'id existe en vif est ignorée
 *    (et retirée de l'index) — un plantage entre l'écriture de l'archive et
 *    la réécriture du fichier projet laisse la session aux deux endroits.
 * 4. Une archive inchangée n'est pas réécrite (empreinte, comme `sauverChat`).
 * Rien n'est jamais supprimé : la corbeille met de côté sous `retire-…`.
 *
 * Toute la décision est ici, IO injectable, testée sans fenêtre.
 */

import { nomPour, type IoEtat } from "./etatEclate";
import {
  isPersistedSession,
  MAX_SESSIONS_PER_PROJECT,
  type PersistedProjectEntry,
  type PersistedSession,
} from "./modeleProjet";
import { capSessions, sortByRecent } from "./sessionStore";

export const PREFIXE_ARCHIVE = "projarch-";
export const PREFIXE_INDEX_ARCHIVES = "archives-";
/** Même préfixe de mise de côté que etatEclate.ts (`retirerProjet`). */
const PREFIXE_RETIRE = "retire-";
/** Contrainte du magasin Rust : `[a-z0-9-]{1,64}` (state_store.rs). */
const NOM_MAX = 64;

/** Ce que la liste « Archives » affiche d'une session : pas ses tours. */
export interface EntreeArchive {
  id: string;
  title: string;
  titleCustom: boolean;
  createdAt: string;
  updatedAt: string;
  nbTours: number;
}

/** Contenu d'un fichier `projarch-…` : la session complète et le projet d'où elle vient. */
interface FichierArchive {
  projetId: string;
  session: PersistedSession;
}

/** Journal injecté (le module n'importe pas le journal : il reste testable sans sidecar). */
export type Journaliser = (niveau: "warn" | "error", msg: string, fields: Record<string, unknown>) => void;

export const nomArchive = (idSession: string): string => nomPour(PREFIXE_ARCHIVE, idSession);
export const nomIndexArchives = (projetId: string): string => nomPour(PREFIXE_INDEX_ARCHIVES, projetId);

/** Les métadonnées d'une session archivée. */
export function resumer(session: PersistedSession): EntreeArchive {
  return {
    id: session.id,
    title: session.title,
    titleCustom: session.titleCustom,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    nbTours: session.turns.length,
  };
}

/**
 * Les sessions de l'entrée persistée qui dépassent le plafond : celles que
 * `capSessions` ne garde pas, SAUF la session active et les onglets ouverts
 * (invariant 2), et sauf une session qui porte un réveil ARMÉ : archivée, elle
 * ne serait plus chargée et son réveil ne sonnerait jamais. L'ordre rendu est
 * celui du fichier.
 */
export function choisirArchivables(entree: PersistedProjectEntry, max = MAX_SESSIONS_PER_PROJECT): PersistedSession[] {
  const gardees = new Set(capSessions(entree.sessions, entree.activeId, max).map((s) => s.id));
  const ouvertes = new Set(entree.openConversationIds);
  return entree.sessions.filter(
    (s) => !gardees.has(s.id) && s.id !== entree.activeId && !ouvertes.has(s.id) && (s.reveils?.length ?? 0) === 0,
  );
}

/** L'index sans les sessions vives (invariant 3), de la plus récente à la plus ancienne. */
export function sansVifs(index: readonly EntreeArchive[], idsVifs: ReadonlySet<string>): EntreeArchive[] {
  return sortByRecent(index.filter((e) => !idsVifs.has(e.id)));
}

function estEntreeArchive(v: unknown): v is EntreeArchive {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.title === "string" &&
    typeof e.createdAt === "string" &&
    typeof e.updatedAt === "string"
  );
}

/**
 * Charge l'index d'archives d'un projet. Les entrées dont l'id existe en vif
 * sont ignorées et l'index nettoyé est réécrit aussitôt : sans cela, une
 * session supprimée ensuite par l'utilisateur ressusciterait ici sous la
 * forme de son ancien instantané. Un index illisible ou absent donne une
 * liste vide — l'échec de lecture, lui, est journalisé.
 */
export async function chargerIndexArchives(
  io: IoEtat,
  projetId: string,
  idsVifs: ReadonlySet<string>,
  journaliser: Journaliser,
): Promise<EntreeArchive[]> {
  const brut = await io.lire(nomIndexArchives(projetId)).catch((err: unknown) => {
    journaliser("error", "index d'archives illisible", { projetId, erreur: String(err) });
    return null;
  });
  const entrees = Array.isArray((brut as { archives?: unknown } | null)?.archives)
    ? ((brut as { archives: unknown[] }).archives.filter(estEntreeArchive) as EntreeArchive[])
    : [];
  const propre = sansVifs(entrees, idsVifs);
  if (propre.length !== entrees.length) {
    await ecrireIndex(io, projetId, propre).catch((err: unknown) => {
      journaliser("warn", "nettoyage de l'index d'archives impossible", { projetId, erreur: String(err) });
    });
  }
  return propre;
}

function ecrireIndex(io: IoEtat, projetId: string, index: readonly EntreeArchive[]): Promise<void> {
  return io.ecrire(nomIndexArchives(projetId), { projetId, archives: index });
}

/**
 * Archive `aArchiver` et rend les ids dont l'archivage est ACQUIS (fichier
 * écrit + index écrit) : seuls ceux-là peuvent quitter le fichier projet
 * (invariant 1). `dejaEcrit` (id → empreinte) évite de réécrire une archive
 * inchangée (invariant 4) ; il n'est mis à jour qu'après une écriture réussie.
 * L'index rendu est celui du disque : inchangé si son écriture a échoué.
 */
export async function archiver(
  io: IoEtat,
  projetId: string,
  aArchiver: readonly PersistedSession[],
  index: readonly EntreeArchive[],
  dejaEcrit: Map<string, string>,
  journaliser: Journaliser,
): Promise<{ archivees: string[]; index: EntreeArchive[] }> {
  const ecrites: PersistedSession[] = [];
  for (const session of aArchiver) {
    const empreinte = JSON.stringify(session);
    if (dejaEcrit.get(session.id) !== empreinte) {
      const fichier: FichierArchive = { projetId, session };
      try {
        await io.ecrire(nomArchive(session.id), fichier);
        dejaEcrit.set(session.id, empreinte);
      } catch (err) {
        journaliser("error", "archivage d'une session impossible : elle reste dans le fichier projet", {
          projetId,
          sessionId: session.id,
          erreur: String(err),
        });
        continue;
      }
    }
    ecrites.push(session);
  }
  if (ecrites.length === 0) return { archivees: [], index: [...index] };

  const resumes = new Map(ecrites.map((s) => [s.id, resumer(s)]));
  const suivant = sortByRecent([...index.filter((e) => !resumes.has(e.id)), ...resumes.values()]);
  if (JSON.stringify(suivant) !== JSON.stringify(sortByRecent([...index]))) {
    try {
      await ecrireIndex(io, projetId, suivant);
    } catch (err) {
      journaliser("error", "index d'archives non écrit : les sessions restent dans le fichier projet", {
        projetId,
        nombre: ecrites.length,
        erreur: String(err),
      });
      return { archivees: [], index: [...index] };
    }
  }
  return { archivees: ecrites.map((s) => s.id), index: suivant };
}

/**
 * Restaure une archive : lit le fichier, le valide, puis laisse l'appelant
 * l'insérer dans les sessions vives via `inserer` (qui rend `false` pour
 * renoncer — projet quitté entre-temps). Ce n'est qu'APRÈS l'insertion que
 * l'id sort de l'index : une session n'est jamais absente des deux endroits.
 * Si le retrait de l'index échoue, l'archive y reste mais le vif fait foi
 * (invariant 3), le journal le dit. Le fichier d'archive reste sur le disque.
 * Rend `null` si rien n'a été restauré (lecture ratée, fichier invalide, renoncement).
 */
export async function restaurer(
  io: IoEtat,
  projetId: string,
  idSession: string,
  index: readonly EntreeArchive[],
  dejaEcrit: Map<string, string>,
  inserer: (session: PersistedSession) => boolean,
  journaliser: Journaliser,
): Promise<{ session: PersistedSession; index: EntreeArchive[] } | null> {
  let brut: unknown;
  try {
    brut = await io.lire(nomArchive(idSession));
  } catch (err) {
    journaliser("error", "archive illisible", { projetId, sessionId: idSession, erreur: String(err) });
    return null;
  }
  const session = (brut as Partial<FichierArchive> | null)?.session;
  if (!isPersistedSession(session) || session.id !== idSession) {
    journaliser("error", "archive invalide ou absente", { projetId, sessionId: idSession });
    return null;
  }
  if (!inserer(session)) return null;
  // Une restaurée qui sera réarchivée plus tard sera peut-être modifiée : plus d'empreinte.
  dejaEcrit.delete(idSession);
  const suivant = index.filter((e) => e.id !== idSession);
  await ecrireIndex(io, projetId, suivant).catch((err: unknown) => {
    journaliser("warn", "retrait de l'index d'archives impossible (le vif fait foi)", {
      projetId,
      sessionId: idSession,
      erreur: String(err),
    });
  });
  return { session, index: suivant };
}

/**
 * Corbeille d'une archive : MISE DE CÔTÉ sous `retire-…`, jamais détruite.
 * L'index d'abord : un échec ici laisse tout en place (fichier compris) ; un
 * renommage raté ensuite laisse seulement un fichier non référencé, inoffensif,
 * et le journal le dit.
 */
export async function retirerArchive(
  io: IoEtat,
  projetId: string,
  idSession: string,
  index: readonly EntreeArchive[],
  dejaEcrit: Map<string, string>,
  journaliser: Journaliser,
): Promise<EntreeArchive[]> {
  const suivant = index.filter((e) => e.id !== idSession);
  try {
    await ecrireIndex(io, projetId, suivant);
  } catch (err) {
    journaliser("error", "mise de côté d'une archive impossible (index non écrit)", {
      projetId,
      sessionId: idSession,
      erreur: String(err),
    });
    return [...index];
  }
  dejaEcrit.delete(idSession);
  const nom = nomArchive(idSession);
  await io.renommer(nom, `${PREFIXE_RETIRE}${nom}`.slice(0, NOM_MAX)).catch((err: unknown) => {
    journaliser("warn", "fichier d'archive non renommé sous retire-…", { projetId, sessionId: idSession, erreur: String(err) });
  });
  return suivant;
}
