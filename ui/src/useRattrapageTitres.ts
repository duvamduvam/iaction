/*
 * État du passage « Nommer les anciennes discussions » (T-197) : en cours,
 * progression, bouton d'arrêt, message de fin. La mécanique (une session à la
 * fois, trois échecs d'affilée = arrêt) est `rattraperTitres`, pure et testée ;
 * ce hook n'ajoute que l'état d'affichage. Aucun passage automatique : c'est le
 * clic qui autorise la dépense.
 */

import { useRef, useState } from "react";
import { rattraperTitres, type BilanRattrapage } from "./titresDiscussions";

export interface EtatRattrapage {
  enCours: boolean;
  fait: number;
  total: number;
  /** Message de fin du dernier passage (jamais d'erreur muette : un arrêt quota se dit). */
  message: string | null;
}

/** Phrase de fin de passage, d'après son bilan. */
export function messageBilan(b: BilanRattrapage): string {
  const nommees = `${b.nommees} discussion${b.nommees > 1 ? "s" : ""} nommée${b.nommees > 1 ? "s" : ""}`;
  if (b.quota) return `Arrêt après trois échecs de suite (quota atteint ou compte indisponible) : ${nommees}.`;
  if (b.arrete) return `Arrêté : ${nommees}.`;
  if (b.echecs > 0) return `${nommees}, ${b.echecs} sans titre (échec).`;
  return `${nommees}.`;
}

export function useRattrapageTitres(): {
  etat: EtatRattrapage;
  lancer: (args: {
    ids: readonly string[];
    nommer: (id: string) => Promise<string | null | undefined>;
    appliquer: (id: string, titre: string) => Promise<void> | void;
  }) => Promise<void>;
  arreter: () => void;
} {
  const [etat, setEtat] = useState<EtatRattrapage>({ enCours: false, fait: 0, total: 0, message: null });
  const arret = useRef({ arrete: false });
  const enCours = useRef(false);

  async function lancer(args: {
    ids: readonly string[];
    nommer: (id: string) => Promise<string | null | undefined>;
    appliquer: (id: string, titre: string) => Promise<void> | void;
  }) {
    if (enCours.current || args.ids.length === 0) return;
    enCours.current = true;
    arret.current = { arrete: false };
    setEtat({ enCours: true, fait: 0, total: args.ids.length, message: null });
    try {
      const bilan = await rattraperTitres({
        ...args,
        arret: arret.current,
        progression: (fait, total) => setEtat((e) => ({ ...e, fait, total })),
      });
      setEtat({ enCours: false, fait: 0, total: 0, message: messageBilan(bilan) });
    } catch (err) {
      setEtat({ enCours: false, fait: 0, total: 0, message: `Passage interrompu : ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      enCours.current = false;
    }
  }

  function arreter() {
    arret.current.arrete = true;
  }

  return { etat, lancer, arreter };
}
