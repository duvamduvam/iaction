/*
 * Connaissances DÉTECTÉES d'un projet, relues sur disque : fichiers du dossier
 * `.iaction/connaissances/` (injectés au 1er tour) et mémoire Claude Code
 * `.claude/memory/*.md` (informative). Sortis d'AgentPage.tsx (T-209) ; la
 * sélection des fichiers vit dans connaissances.ts (testée sans React).
 */
import { useEffect, useRef, useState } from "react";
import { fichiersConnaissanceAuto, fichiersMemoireClaude } from "./connaissances";
import { fsListDir, type DirEntry } from "./fsClient";
import { projectEnsureDoc } from "./sidecar";

export function useConnaissancesDetectees(cwd: string): {
  autoKnowledgeFiles: DirEntry[];
  /** Relit `.iaction/connaissances/` (le sidecar a pu y déposer un fichier, un tour y écrire). */
  relireAutoKnowledge: () => void;
  claudeMemoryFiles: DirEntry[];
} {
  // Connaissances AUTOMATIQUES (piste 1 « flexibilité », docs/plan.md) :
  // tout fichier posé dans `.iaction/connaissances/` (pas de récursion,
  // fichiers seulement) rejoint les épinglées comme connaissance injectée au
  // 1er tour (voir `injectedKnowledge` dans AgentPage) — groupe « Automatiques »
  // du panneau. Rechargé à chaque changement de projet ; dossier absent ou
  // illisible → liste vide, jamais d'erreur affichée (best effort,
  // comme la lecture de `.mcp.json`).
  const [autoKnowledgeFiles, setAutoKnowledgeFiles] = useState<DirEntry[]>([]);
  /**
   * Relit la liste quand elle a pu changer sous nos pieds : le sidecar dépose
   * `iaction.md` (guide d'intégration) et un tour peut écrire dans
   * `connaissances/`. Sans cette relecture, un projet neuf gardait une liste
   * vide toute la session — ni affichage, ni injection (constaté le
   * 2026-08-03). Bumpé après `knowledge.status` et en fin de tour.
   */
  const [autoKnowledgeTick, setAutoKnowledgeTick] = useState(0);
  const autoKnowledgeCwdRef = useRef<string>("");
  useEffect(() => {
    // Vidage réservé au CHANGEMENT DE PROJET : sur une simple relecture, garder
    // la liste courante — la vider ouvrirait une fenêtre où un tour parti à cet
    // instant n'injecterait aucune connaissance.
    if (autoKnowledgeCwdRef.current !== cwd) {
      autoKnowledgeCwdRef.current = cwd;
      setAutoKnowledgeFiles([]);
    }
    if (!cwd) return;
    let cancelled = false;
    // Dépôt du guide d'intégration AVANT le scan (best effort) : c'est ce qui
    // garantit qu'un projet neuf a sa connaissance dès le premier tour. Un
    // échec (sidecar pas prêt, projet en lecture seule) ne doit rien empêcher :
    // on scanne quand même.
    projectEnsureDoc(cwd)
      .catch(() => {})
      .then(() => fsListDir(`${cwd}/.iaction/connaissances`))
      .then((entries) => {
        if (!cancelled) setAutoKnowledgeFiles(fichiersConnaissanceAuto(entries));
      })
      .catch(() => {
        // dossier absent/illisible : aucune connaissance automatique, état par défaut déjà posé ci-dessus
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, autoKnowledgeTick]);

  // Mémoire Claude Code détectée (`.claude/memory/*.md`, groupe « Détectées »
  // du panneau, aux côtés de CLAUDE.md — voir `projectBadges.claudeMdPath`
  // plus bas) : purement informatif, JAMAIS injectée d'office (seulement si
  // l'utilisateur clique « Épingler », voir le rendu de la section
  // « Connaissances »). Même politique best effort que ci-dessus.
  const [claudeMemoryFiles, setClaudeMemoryFiles] = useState<DirEntry[]>([]);
  useEffect(() => {
    setClaudeMemoryFiles([]);
    if (!cwd) return;
    let cancelled = false;
    fsListDir(`${cwd}/.claude/memory`)
      .then((entries) => {
        if (!cancelled) setClaudeMemoryFiles(fichiersMemoireClaude(entries));
      })
      .catch(() => {
        // dossier absent/illisible : aucune mémoire Claude Code détectée
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return { autoKnowledgeFiles, relireAutoKnowledge: () => setAutoKnowledgeTick((t) => t + 1), claudeMemoryFiles };
}
