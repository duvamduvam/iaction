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
import { logDebug } from "./journal";
import { subscribeProvidersPushed } from "./providersBus";
import {
  knowledgeIndex,
  knowledgeStatus,
  type KnowledgeIndexProgress,
  type KnowledgeStatus,
} from "./connaissancesClient";
import { stateRead, stateWrite } from "./stateClient";

/**
 * Faut-il déclencher l'auto-réindexation (T-115) pour cet état d'index ?
 * Fonction pure, testée sans React (voir connaissances.test.ts) : un index
 * INEXISTANT (`exists: false`) ne déclenche RIEN — la création initiale reste
 * un choix de l'utilisateur (le bouton « Reconstruire l'index »). Seul un
 * index qui EXISTE et est `stale` mérite une réparation silencieuse.
 */
export function fautAutoIndexer(status: KnowledgeStatus | null): boolean {
  return status !== null && status.exists && status.stale;
}

/**
 * Garde-fou « au plus une tentative par `cwd` et par session UI » : marque et
 * autorise en un seul geste ATOMIQUE (pas de fenêtre entre « vérifier » et
 * « marquer » où un second appel s'engagerait aussi) — sans ça,
 * `refreshKnowledgeStatus` étant rappelé à chaque « providers poussés »,
 * l'auto-indexation pourrait repartir en boucle si Ollama est arrêté (panne
 * « fetch failed » connue, voir la mémoire du projet).
 */
export function marquerTenteSiNouveau(tried: Set<string>, cwd: string): boolean {
  if (tried.has(cwd)) return false;
  tried.add(cwd);
  return true;
}

/**
 * Tente une auto-réindexation en fond (T-115). Contrairement au bouton
 * (`handleIndexKnowledge`), un échec reste DISCRET — doctrine T-057, une
 * routine qui échoue en boucle ne doit pas crier : pas de bandeau d'erreur
 * UI, une simple ligne `debug` si la journalisation existe. Dépendances
 * injectées pour rester testable sans React ni sidecar réel.
 */
export async function autoIndexerConnaissances(
  cwd: string,
  pinned: string[],
  deps: {
    indexer: (cwd: string, pinned: string[]) => Promise<unknown>;
    journaliser: (msg: string, fields: Record<string, unknown>) => void;
  },
): Promise<boolean> {
  try {
    await deps.indexer(cwd, pinned);
    return true;
  } catch (err) {
    deps.journaliser("auto-indexation des connaissances échouée", {
      cwd,
      erreur: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

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
  // indexation (`knowledge.index`, avec progression). T-115 : l'indexation
  // n'est plus SEULEMENT à la demande — un index existant et périmé se
  // répare seul en fond (voir `fautAutoIndexer` plus bas) ; le bouton
  // « Reconstruire l'index » reste le seul moyen de CRÉER un index et de le
  // forcer (`force: true`, ignore la réutilisation par mtime). Les chemins
  // épinglés participent à l'index et au calcul de `stale` — le sidecar
  // collecte lui-même automatiques/détectées.
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

  /**
   * Auto-réindexation en fond (T-115) : sur un poste où personne ne clique
   * jamais « Indexer maintenant », 3 index sur 4 dataient d'un mois — le
   * sidecar calculait déjà `stale`, sans effet. Dès que `knowledge.status`
   * répond `exists && stale`, on relance la même indexation que le bouton,
   * sans confirmation ni blocage (voir `fautAutoIndexer`,
   * `marquerTenteSiNouveau`, `autoIndexerConnaissances`).
   */
  const autoIndexTriedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!cwd || indexingKnowledge) return;
    if (!fautAutoIndexer(knowledgeIdx)) return;
    if (!marquerTenteSiNouveau(autoIndexTriedRef.current, cwd)) return;
    setIndexingKnowledge(true);
    autoIndexerConnaissances(cwd, pinnedPathsKey.split("\n").filter(Boolean), {
      indexer: (c, p) => knowledgeIndex(c, p),
      journaliser: (msg, fields) => logDebug("knowledge", msg, { fields }),
    })
      .then((ok) => {
        if (ok) void refreshKnowledgeStatus();
      })
      .finally(() => setIndexingKnowledge(false));
  }, [cwd, indexingKnowledge, knowledgeIdx, pinnedPathsKey, refreshKnowledgeStatus]);

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
        true, // « Reconstruire l'index » : le bouton est une RÉPARATION, jamais incrémental.
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
