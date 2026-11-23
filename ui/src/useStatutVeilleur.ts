/*
 * Statut du veilleur du relais (T-227), tenu à jour : lu au montage et à
 * chaque (re)démarrage du sidecar, puis poussé par l'événement `veilleur`.
 * Partagé par la section « Veilleur » et l'indicateur d'en-tête.
 */
import { useCallback, useEffect, useState } from "react";
import { subscribeReady } from "./sidecar";
import { ecouterVeilleur, veilleurStatut, type StatutVeilleur } from "./veilleurClient";

export function useStatutVeilleur(): {
  statut: StatutVeilleur | null;
  erreur: string | null;
  poser: (s: StatutVeilleur) => void;
  relire: () => Promise<void>;
} {
  const [statut, setStatut] = useState<StatutVeilleur | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const relire = useCallback(async () => {
    try {
      setStatut(await veilleurStatut());
      setErreur(null);
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void relire();
    const offEvt = ecouterVeilleur((s) => {
      setStatut(s);
      setErreur(null);
    });
    const offReady = subscribeReady(() => void relire());
    return () => {
      offEvt();
      offReady();
    };
  }, [relire]);

  return { statut, erreur, poser: setStatut, relire };
}
