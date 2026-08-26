/*
 * Wrapper typé de `maj.verifier` (voir docs/protocol.md § « Méthode
 * `maj.verifier` »). Seul point de contact de l'interface avec la sonde de
 * mise à jour.
 */
import { request } from "./sidecar";

export interface EtatMaj {
  /** Version qui tourne, telle que le sidecar la lit — « inconnue » si illisible. */
  courante: string;
  /** Dernière version publiée, sans le `v` de l'étiquette. null si indéterminable. */
  derniere: string | null;
  disponible: boolean;
  /** Page de la release, à ouvrir dans le navigateur déclaré. null si rien à proposer. */
  url: string | null;
  /** Note de version, bornée côté sidecar. */
  notes: string;
}

/**
 * SONDE (doctrine T-007) : interrogée au chargement de la page Système, son
 * échec est une réponse — poste hors ligne, GitHub injoignable, proxy qui
 * refuse. Journalisée en `debug`, jamais en `error` : une application qui ne
 * sait pas si elle est à jour n'est pas une application en panne.
 */
export async function majVerifier(): Promise<EtatMaj> {
  const { done } = request("maj.verifier", {}, { sonde: true });
  const data = await done;
  return {
    courante: typeof data.courante === "string" ? data.courante : "inconnue",
    derniere: typeof data.derniere === "string" ? data.derniere : null,
    disponible: data.disponible === true,
    url: typeof data.url === "string" ? data.url : null,
    notes: typeof data.notes === "string" ? data.notes : "",
  };
}
