/*
 * Fournisseur (et compte Claude) de la conversation ACTIVE du chat, sorti de
 * ChatPage.tsx (cliquet de taille) en ajoutant le compte (docs/spec-deux-comptes.md).
 *
 * T-018 — `choixFournisseurRef` = dernier fournisseur DÉLIBÉRÉMENT posé
 * (sélecteur, bascule/fermeture d'onglet, suppression, restauration de session) :
 * c'est lui qu'on rétablit quand la liste des fournisseurs revient après une
 * éclipse. Poser un fournisseur passe donc TOUJOURS par `choisirFournisseur` —
 * sauf le repli automatique (`setProviderId` brut), qui effacerait l'intention
 * qu'il est censé protéger.
 *
 * `compteChoisi` = MIROIR d'affichage du compte Claude explicitement choisi pour
 * la session active (`null` = pas de choix : perso). La vérité vit dans la
 * session elle-même (`ChatSession.compte`, posée par le geste de l'utilisateur,
 * jamais recopiée depuis cet état par une sauvegarde tardive : voir
 * `avecCompteChat`). `choisirFournisseur(id, compte)` recharge le miroir avec le
 * fournisseur ; sans second argument, il est laissé tel quel.
 */
import { useCallback, useRef, useState } from "react";
import type { CompteClaude } from "./comptesClaude";

export function useFournisseurChoisi() {
  const [providerId, setProviderId] = useState("");
  const choixFournisseurRef = useRef("");
  const [compteChoisi, setCompteChoisi] = useState<CompteClaude | null>(null);
  const choisirFournisseur = useCallback((id: string, compte?: CompteClaude | null) => {
    choixFournisseurRef.current = id;
    setProviderId(id);
    if (compte !== undefined) setCompteChoisi(compte);
  }, []);
  return { providerId, setProviderId, choixFournisseurRef, compteChoisi, setCompteChoisi, choisirFournisseur };
}
