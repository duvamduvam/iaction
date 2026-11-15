/*
 * Câblage React de l'archivage des conversations du Chat (T-152) : l'état de la
 * liste « Archives » et les gestes — charger, archiver, restaurer, mettre de
 * côté. Toute la décision vit dans archivesChat.ts (IO injectable, testée sans
 * fenêtre) ; ce hook tient l'état d'affichage et sérialise l'archivage.
 */

import { useRef, useState } from "react";

import {
  archiverChat,
  chargerIndexArchivesChat,
  choisirArchivablesChat,
  mettreDeCoteChat,
  restaurerChat,
} from "./archivesChat";
import { sansVifs, type EntreeArchive, type Journaliser } from "./archivesSessions";
import type { ChatSession, PersistedChatState } from "./ChatPage";
import { IO_ETAT } from "./etatEclate";
import { logUi } from "./journal";

const journaliser: Journaliser = (niveau, msg, fields) => logUi(niveau, "ui", `archives du Chat : ${msg}`, { fields });

export interface ArchivesChat {
  archives: EntreeArchive[];
  /** À appeler une fois les conversations vives chargées : lit l'index. Tant qu'il n'est pas lu (ou s'il est illisible), rien n'est archivé. */
  charger: (idsVifs: ReadonlySet<string>) => Promise<void>;
  /** À appeler APRÈS l'écriture des conversations vives : archive ce qui dépasse le seuil. */
  archiverHorsPlafond: (etat: PersistedChatState) => Promise<void>;
  restaurer: (idSession: string, inserer: (session: ChatSession) => boolean) => Promise<boolean>;
  mettreDeCote: (idSession: string) => Promise<void>;
}

/**
 * @param idsVifs         ids des conversations vives (le vif fait foi sur l'archive)
 * @param retirerDeLaVue  retire de la vue les conversations archivées ; rend les ids réellement retirés
 * @param retirerFichierVif met de côté le fichier vif `chatconv-…` d'une conversation retirée de la vue
 */
export function useArchivesChat(
  idsVifs: () => ReadonlySet<string>,
  retirerDeLaVue: (ids: string[]) => string[],
  retirerFichierVif: (id: string) => Promise<void>,
): ArchivesChat {
  const [archives, setArchivesState] = useState<EntreeArchive[]>([]);
  const indexRef = useRef<EntreeArchive[]>([]);
  const fiableRef = useRef(false);
  const enCours = useRef(false);

  function poser(index: EntreeArchive[]) {
    indexRef.current = index;
    setArchivesState(index);
  }

  async function charger(vifs: ReadonlySet<string>) {
    const r = await chargerIndexArchivesChat(IO_ETAT, vifs, journaliser);
    fiableRef.current = r.fiable;
    poser(r.index);
  }

  async function archiverHorsPlafond(etat: PersistedChatState) {
    if (!fiableRef.current || enCours.current) return;
    const aArchiver = choisirArchivablesChat(etat);
    if (aArchiver.length === 0) return;
    enCours.current = true;
    try {
      const r = await archiverChat(IO_ETAT, aArchiver, indexRef.current, journaliser);
      if (r.archivees.length === 0) return;
      for (const id of retirerDeLaVue(r.archivees)) await retirerFichierVif(id);
      // Une conversation rouverte pendant l'écriture reste vive : elle n'a rien à faire dans la liste.
      poser(sansVifs(r.index, idsVifs()));
    } finally {
      enCours.current = false;
    }
  }

  async function restaurer(idSession: string, inserer: (session: ChatSession) => boolean) {
    const r = await restaurerChat(IO_ETAT, idSession, indexRef.current, inserer, journaliser);
    if (!r) return false;
    poser(r.index);
    return true;
  }

  async function mettreDeCote(idSession: string) {
    poser(await mettreDeCoteChat(IO_ETAT, idSession, indexRef.current, journaliser));
  }

  return { archives, charger, archiverHorsPlafond, restaurer, mettreDeCote };
}
