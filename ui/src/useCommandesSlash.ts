/*
 * Commandes/skills du projet (`claude.commands`, menu « / » du composeur) :
 * best effort — échec (auth, cwd invalide) → liste vide, jamais de message
 * d'erreur bloquant (voir docs/protocol.md). Mémorisées par `cwd` ET par compte
 * le temps de la session : les skills du compte Teams ne sont pas ceux du compte
 * Perso (docs/spec-deux-comptes.md), et la liste doit refléter ce que le tour
 * verra. Pas de persistance disque, juste un aller-retour sidecar évité à chaque
 * va-et-vient entre projets déjà visités.
 *
 * Sorti d'AgentPage.tsx (cliquet de taille) en ajoutant le compte.
 */
import { useEffect, useRef, useState } from "react";
import { claudeCommands, type SlashCommandInfo } from "./sidecar";
import type { CompteClaude } from "./comptesClaude";

export function useCommandesSlash(
  cwd: string | null | undefined,
  compte: CompteClaude,
  fermerMenu: () => void,
): SlashCommandInfo[] {
  const cacheRef = useRef<Map<string, SlashCommandInfo[]>>(new Map());
  const [commandes, setCommandes] = useState<SlashCommandInfo[]>([]);
  useEffect(() => {
    fermerMenu();
    if (!cwd) {
      setCommandes([]);
      return;
    }
    const cle = `${cwd}|${compte}`;
    const cached = cacheRef.current.get(cle);
    if (cached) {
      setCommandes(cached);
      return;
    }
    setCommandes([]);
    let cancelled = false;
    claudeCommands(cwd, compte)
      .then((liste) => {
        cacheRef.current.set(cle, liste);
        if (!cancelled) setCommandes(liste);
      })
      .catch(() => {
        // échec d'initialisation SDK (auth, cwd invalide, compte déconnecté) : menu vide, aucun blocage de la saisie
      });
    return () => {
      cancelled = true;
    };
    // `fermerMenu` est recréée à chaque rendu : seul un changement de cwd ou de compte relance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, compte]);
  return commandes;
}
