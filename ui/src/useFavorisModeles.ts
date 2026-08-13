/*
 * T-032 — Favoris de modèles d'un fournisseur : lecture au changement de
 * fournisseur, bascule persistée.
 *
 * Chat et Projets tenaient chacun leur copie de ce cycle (état + effet de
 * lecture + écriture), à la virgule près. Une seule copie ici : les deux pages
 * ne peuvent plus diverger sur ce qui compte — un fournisseur sans favoris
 * rend une liste VIDE, jamais celle du fournisseur précédent.
 *
 * Persistance et fusion de config : modelCatalog.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { readFeatured, toggleFeatured } from "./modelCatalog";

/**
 * `providerId` à `null` (ou vide) = pas de favoris pour ce contexte —
 * fournisseur pas encore choisi, ou abonnement Claude qui n'a pas de catalogue.
 * Renvoie les ids favoris et la bascule à brancher sur l'étoile.
 */
export function useFavorisModeles(
  providerId: string | null,
): readonly [string[], (modelId: string) => void] {
  const [ids, setIds] = useState<string[]>([]);

  useEffect(() => {
    if (!providerId) {
      setIds([]);
      return;
    }
    let vivant = true;
    readFeatured(providerId)
      .then((liste) => {
        if (vivant) setIds(liste);
      })
      .catch(() => {
        if (vivant) setIds([]);
      });
    // Changement de fournisseur pendant la lecture : la réponse périmée ne
    // doit pas repeupler la liste du fournisseur suivant.
    return () => {
      vivant = false;
    };
  }, [providerId]);

  const basculer = useCallback(
    (modelId: string) => {
      if (!providerId) return;
      // Échec d'écriture : les favoris ne changent pas à l'écran non plus —
      // l'affichage ne prend jamais d'avance sur ce qui est réellement persisté.
      toggleFeatured(providerId, modelId).then(setIds).catch(() => {});
    },
    [providerId],
  );

  return [ids, basculer];
}
