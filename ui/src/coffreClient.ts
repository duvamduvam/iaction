/**
 * Coffre de secrets — client des commandes de la coquille
 * (docs/etude-coffre-secrets.md, docs/protocol.md § « Coffre de secrets »).
 *
 * L'interface ne voit JAMAIS une valeur de secret par ces commandes : elle
 * transmet un mot de passe (effacé du champ aussitôt) et reçoit un état. Seule
 * exception, voulue : la clé de secours, rendue une fois à la création.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type EtatCoffre = "absent" | "verrouille" | "ouvert";

export interface AttenteFermeture {
  cause: string;
  tours: number;
}

export interface EtatPublicCoffre {
  etat: EtatCoffre;
  attente: AttenteFermeture | null;
  /** Ouvert sur sa version précédente (`coffre.age` illisible) : dernière modification perdue. */
  repliPrecedent?: boolean;
}

/** Normalise une charge reçue (commande ou événement) ; `null` si illisible. */
export function lireEtatCoffre(brut: unknown): EtatPublicCoffre | null {
  if (typeof brut !== "object" || brut === null) return null;
  const o = brut as Record<string, unknown>;
  if (o.etat !== "absent" && o.etat !== "verrouille" && o.etat !== "ouvert") return null;
  let attente: AttenteFermeture | null = null;
  if (typeof o.attente === "object" && o.attente !== null) {
    const a = o.attente as Record<string, unknown>;
    attente = {
      cause: typeof a.cause === "string" ? a.cause : "",
      tours: typeof a.tours === "number" ? a.tours : 0,
    };
  }
  return { etat: o.etat, attente, ...(o.repliPrecedent === true ? { repliPrecedent: true } : {}) };
}

export async function coffreEtat(): Promise<EtatPublicCoffre | null> {
  return lireEtatCoffre(await invoke("coffre_etat"));
}

/** Crée le coffre ; renvoie la clé de secours, à afficher UNE fois. */
export async function coffreCreer(motDePasse: string): Promise<string> {
  return invoke<string>("coffre_creer", { motDePasse });
}

export async function coffreDeverrouiller(motDePasse: string): Promise<void> {
  await invoke("coffre_deverrouiller", { motDePasse });
}

export async function coffreDeverrouillerSecours(cle: string): Promise<void> {
  await invoke("coffre_deverrouiller_secours", { cle });
}

export async function coffreVerrouiller(): Promise<void> {
  await invoke("coffre_verrouiller");
}

export async function coffreChangerMotDePasse(ancien: string | null, nouveau: string): Promise<void> {
  await invoke("coffre_changer_mot_de_passe", { ancien, nouveau });
}

/** S'abonne à l'événement `coffre:etat` ; renvoie le désabonnement. */
export function ecouterEtatCoffre(f: (etat: EtatPublicCoffre) => void): () => void {
  let fin: (() => void) | null = null;
  let annule = false;
  void listen("coffre:etat", (evt) => {
    const etat = lireEtatCoffre(evt.payload);
    if (etat) f(etat);
  }).then((desabonner) => {
    if (annule) desabonner();
    else fin = desabonner;
  });
  return () => {
    annule = true;
    fin?.();
  };
}

/**
 * Fragment de la clé de secours à recopier pour confirmer qu'elle est
 * rangée : les 8 derniers caractères (la fin, pas le préfixe commun à toutes).
 */
export function fragmentDeControle(cle: string): string {
  return cle.trim().slice(-8);
}

/** Avis du tour pour des serveurs MCP écartés faute de secret (chunk `mcp_ecartes`). */
export function texteMcpEcartes(avis: { serveurs: string[]; coffreVerrouille: boolean }): string {
  const liste = avis.serveurs.map((s) => `« ${s} »`).join(", ");
  const pluriel = avis.serveurs.length > 1;
  if (avis.coffreVerrouille) {
    return `Coffre verrouillé : ${pluriel ? "les serveurs MCP" : "le serveur MCP"} ${liste} ${pluriel ? "sont écartés" : "est écarté"} de ce tour. Déverrouille le coffre (en-tête) puis relance.`;
  }
  return `Secret manquant : ${pluriel ? "les serveurs MCP" : "le serveur MCP"} ${liste} ${pluriel ? "sont écartés" : "est écarté"} de ce tour (référence \${SECRET:…} sans valeur au coffre).`;
}

/** Libellé court de l'état, pour l'en-tête. */
export function libelleEtat(etat: EtatPublicCoffre): string {
  if (etat.attente) {
    const n = etat.attente.tours;
    return `fermeture du coffre en attente : ${n} tour${n > 1 ? "s" : ""} en cours`;
  }
  if (etat.etat === "ouvert") return "Coffre ouvert";
  if (etat.etat === "verrouille") return "Coffre verrouillé";
  return "Coffre à créer";
}
