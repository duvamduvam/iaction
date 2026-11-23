/*
 * Veilleur du relais (T-227) — client des méthodes `veilleur.*` du sidecar
 * (docs/protocol.md § « Veilleur du relais ») et de l'événement non sollicité
 * `veilleur`.
 *
 * Lecture DÉFENSIVE, comme les autres clients : un champ absent devient
 * `null`, jamais une erreur ; un état inconnu rend `null` (l'appelant le dit).
 * Les erreurs de protocole remontent en rejet de promesse avec le message du
 * sidecar : les composants les affichent, jamais ne les avalent.
 */
import { ecouterEvenement } from "./evenementsSidecar";
import { request } from "./sidecar";

export type EtatVeilleur = "inactif" | "actif" | "suspendu" | "en-attente-coffre" | "invalide" | "arret-en-cours" | "bloque";
const ETATS: readonly EtatVeilleur[] = ["inactif", "actif", "suspendu", "en-attente-coffre", "invalide", "arret-en-cours", "bloque"];

export interface BilanReleve {
  traites: string[];
  refuses: string[];
  ignores: string[];
  invalides: string[];
  suspendu: boolean;
}

export interface StatutVeilleur {
  etat: EtatVeilleur;
  cwd: string | null;
  motif: string | null;
  derniereReleve: string | null;
  dernierBilan: BilanReleve | null;
  toursAujourdhui: number;
  enCours: boolean;
}

export interface PlafondsVeilleur {
  profondeur: number;
  coutParMessage: number;
  toursParJour: number;
  dureeMin: number;
}

/** Miroir de `ConfigVeilleur` (sidecar/src/veilleurConfig.ts). */
export interface ConfigVeilleur {
  actif: boolean;
  expediteurs: string[];
  agent: string | null;
  compte: "perso";
  modele: string;
  effort: string;
  permission: "bypassPermissions" | "acceptEdits";
  bash: boolean;
  plafonds: PlafondsVeilleur;
  cadenceSec: number;
  url: string;
  jetonSecret: string;
  ca?: string;
  proxy?: string;
}

/**
 * `scellee` : la config du fichier est-elle celle approuvée (enregistrée) sur ce
 * poste ? `null` : coffre fermé, impossible à vérifier.
 */
export type LectureConfig =
  | {
      config: ConfigVeilleur;
      scellee: boolean | null;
      /** Non approuvée : champs qui diffèrent de la dernière version approuvée (`null` : aucune connue). */
      differences?: string[] | null;
    }
  | { absent: true }
  | { invalide: string };

const chaines = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function lireBilan(v: unknown): BilanReleve | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  return { traites: chaines(o.traites), refuses: chaines(o.refuses), ignores: chaines(o.ignores), invalides: chaines(o.invalides), suspendu: o.suspendu === true };
}

/** Statut reçu (done ou événement) ; `null` si l'état est illisible. */
export function parseStatutVeilleur(data: Record<string, unknown>): StatutVeilleur | null {
  if (!ETATS.includes(data.etat as EtatVeilleur)) return null;
  return {
    etat: data.etat as EtatVeilleur,
    cwd: typeof data.cwd === "string" ? data.cwd : null,
    motif: typeof data.motif === "string" ? data.motif : null,
    derniereReleve: typeof data.derniereReleve === "string" ? data.derniereReleve : null,
    dernierBilan: lireBilan(data.dernierBilan),
    toursAujourdhui: typeof data.toursAujourdhui === "number" ? data.toursAujourdhui : 0,
    enCours: data.enCours === true,
  };
}

function exigerStatut(data: Record<string, unknown>): StatutVeilleur {
  const s = parseStatutVeilleur(data);
  if (!s) throw new Error("statut du veilleur illisible (sidecar plus récent ou plus ancien que l'interface ?)");
  return s;
}

export async function veilleurStatut(): Promise<StatutVeilleur> {
  return exigerStatut(await request("veilleur.statut", {}).done);
}

export async function veilleurLire(cwd: string): Promise<LectureConfig> {
  const data = await request("veilleur.lire", { cwd }).done;
  if (data.absent === true) return { absent: true };
  if (typeof data.invalide === "string") return { invalide: data.invalide };
  if (typeof data.config === "object" && data.config !== null) {
    return {
      config: data.config as ConfigVeilleur,
      scellee: typeof data.scellee === "boolean" ? data.scellee : null,
      ...(data.scellee === false ? { differences: Array.isArray(data.differences) ? data.differences.filter((d): d is string => typeof d === "string") : null } : {}),
    };
  }
  return { invalide: "réponse du sidecar illisible" };
}

export async function veilleurConfigurer(cwd: string, config: ConfigVeilleur): Promise<ConfigVeilleur> {
  const data = await request("veilleur.configurer", { cwd, config }).done;
  return data.config as ConfigVeilleur;
}

export async function veilleurActiver(cwd: string): Promise<StatutVeilleur> {
  return exigerStatut(await request("veilleur.activer", { cwd }).done);
}

/** Désactive ; `avertissement` dit ce qui n'a pas pu être retiré (scellé, poste). */
export async function veilleurDesactiver(): Promise<{ statut: StatutVeilleur; avertissement: string | null }> {
  const data = await request("veilleur.desactiver", {}).done;
  return { statut: exigerStatut(data), avertissement: typeof data.avertissement === "string" ? data.avertissement : null };
}

/** Supprime la config du projet et son approbation (scellé au coffre). */
export async function veilleurOublier(cwd: string): Promise<StatutVeilleur> {
  return exigerStatut(await request("veilleur.oublier", { cwd }).done);
}

/** S'abonne à l'événement `veilleur` ; renvoie le désabonnement. */
export function ecouterVeilleur(cb: (s: StatutVeilleur) => void): () => void {
  return ecouterEvenement("veilleur", (data) => {
    const s = parseStatutVeilleur(data);
    if (s) cb(s);
  });
}

/** Demande d'ouvrir la section « Veilleur » de la page Projets (clic sur l'indicateur d'en-tête). */
export const EVENEMENT_OUVRIR_SECTION = "iaction:veilleur:ouvrir";
