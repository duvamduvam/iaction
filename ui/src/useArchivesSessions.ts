/*
 * Câblage React de l'archivage des sessions (T-151) : l'état de la liste
 * « Archives » du projet affiché, et les quatre gestes — charger, archiver,
 * restaurer, mettre de côté. Toute la décision vit dans archivesSessions.ts
 * (IO injectable, testée sans fenêtre) ; ce hook ne fait que tenir l'état
 * d'affichage et garder contre les réponses tardives d'un projet quitté.
 */

import { useEffect, useRef, useState } from "react";

import {
  archiver,
  chargerIndexArchives,
  choisirArchivables,
  restaurer,
  retirerArchive,
  sansVifs,
  type EntreeArchive,
  type Journaliser,
} from "./archivesSessions";
import { IO_ETAT } from "./etatEclate";
import { logUi } from "./journal";
import type { PersistedProjectEntry, PersistedSession } from "./modeleProjet";

/** Le journal réel : canal `ui`, le projet et la session dans les champs. */
const journaliser: Journaliser = (niveau, msg, fields) => logUi(niveau, "ui", `archives de sessions : ${msg}`, { fields });

export interface ArchivesSessions {
  /** Archives du projet affiché, de la plus récente à la plus ancienne (jamais une session vive). */
  archives: EntreeArchive[];
  /**
   * À appeler après chaque écriture du fichier projet : archive ce qui dépasse
   * le plafond, puis demande à la page de le retirer de la vue (`retirerDeLaVue`
   * une session rouverte entre-temps reste vive).
   */
  archiverHorsPlafond: (projetId: string, entree: PersistedProjectEntry) => Promise<void>;
  /** Restaure une archive ; `inserer` la place dans les sessions vives (`false` = renoncer). Rend `true` si restaurée. */
  restaurerArchive: (idSession: string, inserer: (session: PersistedSession) => boolean) => Promise<boolean>;
  /** Corbeille : met l'archive de côté (`retire-…`), ne la détruit pas. */
  retirerUneArchive: (idSession: string) => Promise<void>;
}

/**
 * @param projetId      projet affiché (`null` = aucun)
 * @param pret          vrai quand le document des projets est chargé (les ids vifs sont alors connus)
 * @param idsVifs       ids des sessions vives d'un projet — le vif fait foi sur l'archive
 * @param retirerDeLaVue retire de la vue (et réécrit le fichier projet sans) les sessions archivées ; rend les ids retirés
 */
export function useArchivesSessions(
  projetId: string | null,
  pret: boolean,
  idsVifs: (projetId: string) => ReadonlySet<string>,
  retirerDeLaVue: (projetId: string, ids: string[]) => string[],
): ArchivesSessions {
  const [archives, setArchivesState] = useState<EntreeArchive[]>([]);
  // Miroir synchrone : les gestes lisent l'index COURANT, pas celui de leur closure.
  const indexRef = useRef<EntreeArchive[]>([]);
  const projetRef = useRef<string | null>(projetId);
  projetRef.current = projetId;
  const dejaEcrit = useRef(new Map<string, string>());
  /** Un archivage à la fois : les sauvegardes s'enchaînent toutes les 1,5 s pendant un tour. */
  const enCours = useRef(false);

  function poser(index: EntreeArchive[], pour: string) {
    if (projetRef.current !== pour) return; // réponse tardive d'un projet quitté
    indexRef.current = index;
    setArchivesState(index);
  }

  useEffect(() => {
    indexRef.current = [];
    setArchivesState([]);
    if (!projetId || !pret) return;
    void chargerIndexArchives(IO_ETAT, projetId, idsVifs(projetId), journaliser).then((index) => poser(index, projetId));
    // `idsVifs` est recréée à chaque rendu : seule l'identité du projet relance le chargement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projetId, pret]);

  async function archiverHorsPlafond(pour: string, entree: PersistedProjectEntry) {
    const aArchiver = choisirArchivables(entree);
    if (aArchiver.length === 0 || enCours.current || projetRef.current !== pour) return;
    enCours.current = true;
    try {
      const r = await archiver(IO_ETAT, pour, aArchiver, indexRef.current, dejaEcrit.current, journaliser);
      if (r.archivees.length === 0) return;
      retirerDeLaVue(pour, r.archivees);
      // Une session rouverte pendant l'écriture reste vive : elle n'a rien à faire dans la liste.
      poser(sansVifs(r.index, idsVifs(pour)), pour);
    } finally {
      enCours.current = false;
    }
  }

  async function restaurerArchive(idSession: string, inserer: (session: PersistedSession) => boolean) {
    const pour = projetRef.current;
    if (!pour) return false;
    const r = await restaurer(IO_ETAT, pour, idSession, indexRef.current, dejaEcrit.current, inserer, journaliser);
    if (!r) return false;
    poser(r.index, pour);
    return true;
  }

  async function retirerUneArchive(idSession: string) {
    const pour = projetRef.current;
    if (!pour) return;
    poser(await retirerArchive(IO_ETAT, pour, idSession, indexRef.current, dejaEcrit.current, journaliser), pour);
  }

  return { archives, archiverHorsPlafond, restaurerArchive, retirerUneArchive };
}
