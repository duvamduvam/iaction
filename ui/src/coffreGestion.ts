/**
 * Gestion du coffre — écran des secrets, migration, inventaire des `.env`
 * (docs/etude-coffre-secrets.md § 5 à § 7).
 *
 * Commandes de la coquille (`coffre_*`) et méthodes du sidecar
 * (`coffre.inventaireEnv`, `coffre.migrerEnv`, `coffre.supprimerEnv`,
 * `coffre.referencesTaches`). Rien ici ne voit une valeur de secret : des
 * noms, des classes, des chemins.
 */
import { invoke } from "@tauri-apps/api/core";
import { request } from "./sidecar";

export type ClasseSecret = "coffre" | "sans-fenetre";

export interface SecretListe {
  nom: string;
  classe: ClasseSecret;
  cree: string;
}

export interface CandidatMigration {
  compte: string;
  /** `reliquat-mcp` : le coffre a déjà ce secret, seule la copie en clair part. */
  source: "trousseau" | "fichier-mcp" | "reliquat-mcp";
}

export interface BilanMigration {
  migres: string[];
  echecs: { compte: string; cause: string }[];
  fichierMcpSupprime: boolean;
}

export interface FichierEnv {
  projet: string;
  fichier: string;
  cles: string[];
  /** Valeurs illisibles sans ambiguïté : à migrer à la main, jamais versées d'office. */
  ambigues: string[];
}

/** Tâche programmée dont un secret ne sera pas servi hors de l'application. */
export interface TacheSansSecrets {
  tache: string;
  noms: string[];
}

// --- Coquille ---------------------------------------------------------------

export async function coffreSecrets(): Promise<SecretListe[]> {
  return invoke<SecretListe[]>("coffre_secrets");
}

export async function coffreReclasser(nom: string, classe: ClasseSecret): Promise<void> {
  await invoke("coffre_reclasser", { nom, classe });
}

/** `true` : Windows joint à un domaine ; `null` : indéterminé. */
export async function coffrePosteDomaine(): Promise<boolean | null> {
  return invoke<boolean | null>("coffre_poste_domaine");
}

export async function coffreMigrationCandidats(comptes: string[]): Promise<CandidatMigration[]> {
  return invoke<CandidatMigration[]>("coffre_migration_candidats", { comptes });
}

export async function coffreMigrer(choix: { compte: string; classe: ClasseSecret }[]): Promise<BilanMigration> {
  return invoke<BilanMigration>("coffre_migrer", { choix });
}

/** Fichiers où une valeur du coffre traîne en clair (§ 9.2) — des chemins seulement. */
export async function coffreChercherEnClair(projets: string[]): Promise<string[]> {
  return invoke<string[]>("coffre_chercher_en_clair", { projets });
}

// --- Sidecar ----------------------------------------------------------------

export async function secretsDesTaches(): Promise<string[]> {
  const r = await request("coffre.referencesTaches").done;
  return Array.isArray(r.noms) ? r.noms.filter((n): n is string => typeof n === "string") : [];
}

export async function inventaireEnv(projets: string[]): Promise<FichierEnv[]> {
  const r = await request("coffre.inventaireEnv", { projets }).done;
  return Array.isArray(r.fichiers)
    ? (r.fichiers as FichierEnv[]).map((f) => ({ ...f, ambigues: Array.isArray(f.ambigues) ? f.ambigues : [] }))
    : [];
}

export async function tachesSansSecrets(): Promise<TacheSansSecrets[]> {
  const r = await request("coffre.tachesSansSecrets").done;
  return Array.isArray(r.taches) ? (r.taches as TacheSansSecrets[]) : [];
}

export async function migrerEnv(p: {
  projet: string;
  fichier: string;
  cle: string;
  nom: string;
  serveur?: string;
  variable?: string;
}): Promise<{ nom: string; serveur: string | null }> {
  const r = await request("coffre.migrerEnv", { ...p }).done;
  return { nom: String(r.nom ?? p.nom), serveur: typeof r.serveur === "string" ? r.serveur : null };
}

/**
 * Supprime un `.env` migré. `versements` : les variables versées (`{cle,
 * nom}`) ; le sidecar refuse si l'une des variables du fichier n'est pas au
 * coffre avec la même valeur.
 */
export async function supprimerEnv(projet: string, fichier: string, versements: { cle: string; nom: string }[]): Promise<void> {
  await request("coffre.supprimerEnv", { projet, fichier, versements }).done;
}

/** Texte de l'avis « tâches privées de secrets » ; vide s'il n'y a rien à dire. */
export function texteTachesSansSecrets(taches: readonly TacheSansSecrets[]): string {
  if (taches.length === 0) return "";
  const liste = taches.map((t) => `${t.tache} (${t.noms.join(", ")})`).join(" ; ");
  return (
    `Tâches programmées privées d'un secret hors de l'application : ${liste}. ` +
    "Classe ces secrets « sans fenêtre » dans l'écran des secrets, sinon ces tâches tourneront sans leur serveur MCP."
  );
}

// --- Règles pures (testées) ------------------------------------------------

/**
 * Classe proposée à la migration (§ 7.2) : `sans-fenetre` pour un secret MCP
 * qu'une tâche programmée référence (elle tourne sans la fenêtre), `coffre`
 * pour tout le reste.
 */
export function classeProposee(compte: string, referencesTaches: readonly string[]): ClasseSecret {
  return compte.startsWith("mcp:") && referencesTaches.includes(compte.slice(4)) ? "sans-fenetre" : "coffre";
}

/** Libellé lisible d'un compte (`provider:openrouter` → « Fournisseur openrouter »). */
export function libelleCompte(compte: string): string {
  const [genre, ...reste] = compte.split(":");
  const nom = reste.join(":");
  if (genre === "provider") return `Fournisseur ${nom}`;
  if (genre === "speech") return `Voix (${nom === "stt" ? "dictée" : nom === "tts" ? "lecture" : nom})`;
  if (genre === "mcp") return `MCP \${SECRET:${nom}}`;
  return compte;
}

/** Nom de secret proposé pour une variable d'un `.env` : `<projet>.<VARIABLE>`. */
export function nomSecretPourEnv(projet: string, cle: string): string {
  const base = projet.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "projet";
  return `${base}.${cle}`.replace(/[^A-Za-z0-9_.-]/g, "-");
}

/**
 * Avertissement à afficher avant de reclasser en `sans-fenetre` (§ 5).
 * `domaine` : réponse de `coffre_poste_domaine` ; `windows` : système.
 */
export function avertissementSansFenetre(domaine: boolean | null, windows: boolean): string {
  const base =
    "Ce secret quittera le coffre chiffré pour le trousseau du système : lisible par tout programme de ta session, y compris coffre fermé.";
  if (domaine === true) {
    return `${base} Ce poste est joint à un domaine : ce secret sera déchiffrable par les administrateurs du domaine.`;
  }
  if (domaine === null && windows) {
    return `${base} Impossible de savoir si ce poste est joint à un domaine : s'il l'est, ce secret sera déchiffrable par ses administrateurs.`;
  }
  return base;
}
