/*
 * Connaissances de projet — l'état et les actions du panneau, sortis
 * d'AgentPage le 2026-08-08 (étape 8, 3/3). La logique pure vit dans
 * connaissances.ts ; ici, le câblage React : chargement du document épinglé,
 * mode injection/RAG par projet, état de l'index d'embeddings et indexation
 * à la demande. Le comportement est copié tel quel — seul le rangement change.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { readProjectKnowledgeMode, writeProjectKnowledgeMode, type KnowledgeMode } from "./projectAdmin";
import {
  KNOWLEDGE_STATE_KEY,
  mergeKnowledgeDocs,
  sanitizeKnowledgeDoc,
  type KnowledgeDoc,
  type PinnedDoc,
} from "./connaissances";
import { subscribeProvidersPushed } from "./providersBus";
import {
  knowledgeIndex,
  knowledgeStatus,
  type KnowledgeIndexProgress,
  type KnowledgeStatus,
} from "./sidecar";
import { stateRead, stateWrite } from "./stateClient";

export function useConnaissances(selectedProjectId: string | null, cwd: string) {
  // Connaissances (documents épinglés par projet, panneau latéral) : chargées
  // une seule fois au montage (StrictMode-safe, même famille de pattern que
  // le chargement de `project-conversations` ci-dessus) — le document COMPLET
  // (toutes projets) est gardé en state, la liste du projet courant en étant
  // simplement dérivée (`knowledgeDoc[selectedProjectId]`), pas de mirroring
  // supplémentaire à synchroniser au changement de projet.
  const knowledgeInitRef = useRef(false);
  const [knowledgeDoc, setKnowledgeDoc] = useState<KnowledgeDoc>({});
  useEffect(() => {
    if (knowledgeInitRef.current) return;
    knowledgeInitRef.current = true;
    stateRead<unknown>(KNOWLEDGE_STATE_KEY)
      .then((raw) => {
        const disk = sanitizeKnowledgeDoc(raw);
        // Fusion (jamais un écrasement) : voir le commentaire de `mergeKnowledgeDocs`.
        setKnowledgeDoc((local) => mergeKnowledgeDocs(disk, local));
      })
      .catch(() => {
        // best effort : sans document, la liste reste vide (aucune connaissance épinglée)
      });
  }, []);

  const pinnedKnowledge = selectedProjectId ? (knowledgeDoc[selectedProjectId] ?? []) : [];

  function pinKnowledge(path: string, name: string) {
    if (!selectedProjectId) return;
    setKnowledgeDoc((prev) => {
      const list = prev[selectedProjectId] ?? [];
      if (list.some((d) => d.path === path)) return prev; // pas de doublon (même chemin → ignoré)
      const next = { ...prev, [selectedProjectId]: [...list, { path, name }] };
      void stateWrite(KNOWLEDGE_STATE_KEY, next).catch(() => {
        // best effort : l'épinglage reste visible en mémoire même si l'écriture échoue
      });
      return next;
    });
  }

  function unpinKnowledge(path: string) {
    if (!selectedProjectId) return;
    setKnowledgeDoc((prev) => {
      const list = prev[selectedProjectId] ?? [];
      const next = { ...prev, [selectedProjectId]: list.filter((d) => d.path !== path) };
      void stateWrite(KNOWLEDGE_STATE_KEY, next).catch(() => {});
      return next;
    });
  }

  // R5 — mode connaissances du projet (injection intégrale / RAG, voir
  // RAG_SYSTEM_LINE) : relu depuis la config projet à chaque changement de
  // projet, écrit à la volée par le sélecteur du panneau. Best effort : une
  // config illisible retombe sur "injection" (comportement historique).
  const [knowledgeMode, setKnowledgeMode] = useState<KnowledgeMode>("injection");
  useEffect(() => {
    setKnowledgeMode("injection");
    if (!selectedProjectId) return;
    let cancelled = false;
    readProjectKnowledgeMode(selectedProjectId)
      .then((mode) => {
        if (!cancelled) setKnowledgeMode(mode);
      })
      .catch(() => {
        // config illisible : défaut "injection" déjà posé ci-dessus
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  function changeKnowledgeMode(mode: KnowledgeMode) {
    if (!selectedProjectId) return;
    setKnowledgeMode(mode);
    writeProjectKnowledgeMode(selectedProjectId, mode).catch(() => {
      // écriture config échouée : le mode reste appliqué pour la session en cours
    });
  }

  // R5 — état de l'index d'embeddings du projet (`knowledge.status`) +
  // indexation à la demande (`knowledge.index`, bouton « Indexer maintenant »
  // avec progression). Les chemins épinglés participent à l'index et au
  // calcul de `stale` — le sidecar collecte lui-même automatiques/détectées.
  const [knowledgeIdx, setKnowledgeIdx] = useState<KnowledgeStatus | null>(null);
  const [indexingKnowledge, setIndexingKnowledge] = useState(false);
  const [knowledgeIndexProgress, setKnowledgeIndexProgress] = useState<KnowledgeIndexProgress | null>(null);
  const [knowledgeIndexError, setKnowledgeIndexError] = useState("");
  const pinnedPathsKey = pinnedKnowledge.map((d) => d.path).join("\n");
  const refreshKnowledgeStatus = useCallback(async () => {
    if (!cwd) {
      setKnowledgeIdx(null);
      return;
    }
    try {
      const status = await knowledgeStatus(cwd, pinnedPathsKey.split("\n").filter(Boolean));
      setKnowledgeIdx(status);
    } catch {
      // sidecar pas prêt : pas d'état affiché, le prochain changement retentera
      setKnowledgeIdx(null);
    }
  }, [cwd, pinnedPathsKey]);
  useEffect(() => {
    void refreshKnowledgeStatus();
    // Le premier appel peut partir avant que le sidecar soit prêt (même motif
    // que loadNeutralModels) : re-tenté à chaque « providers poussés ».
    return subscribeProvidersPushed(() => {
      void refreshKnowledgeStatus();
    });
  }, [refreshKnowledgeStatus]);

  async function handleIndexKnowledge() {
    if (!cwd || indexingKnowledge) return;
    setIndexingKnowledge(true);
    setKnowledgeIndexError("");
    setKnowledgeIndexProgress(null);
    try {
      await knowledgeIndex(
        cwd,
        pinnedKnowledge.map((d) => d.path),
        (progress) => setKnowledgeIndexProgress(progress),
      );
      await refreshKnowledgeStatus();
    } catch (err) {
      setKnowledgeIndexError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexingKnowledge(false);
      setKnowledgeIndexProgress(null);
    }
  }

  /**
   * Maintenance depuis l'arbre de fichiers : un renommage réécrit les chemins
   * épinglés touchés, une suppression retire fichier ET descendants. Le
   * transformateur rend la NOUVELLE liste, ou `null` pour « rien à changer »
   * (aucune écriture disque, aucun rendu).
   */
  function reecrirePins(transformer: (list: PinnedDoc[]) => PinnedDoc[] | null) {
    if (!selectedProjectId) return;
    setKnowledgeDoc((prev) => {
      const list = prev[selectedProjectId];
      if (!list) return prev;
      const nextList = transformer(list);
      if (nextList === null) return prev;
      const next = { ...prev, [selectedProjectId]: nextList };
      void stateWrite(KNOWLEDGE_STATE_KEY, next).catch(() => {});
      return next;
    });
  }

  return {
    pinnedKnowledge,
    pinKnowledge,
    unpinKnowledge,
    knowledgeMode,
    changeKnowledgeMode,
    knowledgeIdx,
    indexingKnowledge,
    knowledgeIndexProgress,
    knowledgeIndexError,
    refreshKnowledgeStatus,
    handleIndexKnowledge,
    reecrirePins,
  };
}
