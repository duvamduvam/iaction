/**
 * Règles de fichiers du relais entre studios — DÉPÔT (ce qui peut partir) et
 * RÉCEPTION (où et sous quel nom écrire ce qui arrive). Une seule feuille pour
 * deux appelants : le serveur MCP autonome (relaisServeur.ts) et le veilleur
 * du sidecar (veilleurCycle.ts, outilsRelaisVeilleur.ts). Bibliothèque
 * standard seulement : le serveur relais l'importe hors du sidecar.
 *
 * Garde-fous (docs/protocol.md § « Connecteur Relais entre studios ») :
 * - chemin RÉEL sous la racine, liens symboliques compris ;
 * - dépôt refusé pour les secrets, clés, fichiers de consignes, `.git/`, et
 *   tout contenu portant un secret connu ou de forme reconnaissable ;
 * - réception dans `relais-recu/[<sous-dossier>/]`, sans écrasement, secrets
 *   et clés refusés, fichiers de consignes renommés `<nom>.recu`.
 */

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { estFichierConsigne, estFichierSensible, motifSecretDansContenu } from "./fichiersSecrets.js";
import { segmentSur } from "./segmentsSurs.js";

export const TAILLE_MAX = 200 * 1024 * 1024;
export const DOSSIER_RECU = "relais-recu";

export function octets(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export function empreinteSha256(contenu: Buffer): string {
  return createHash("sha256").update(contenu).digest("hex");
}

/** `rel` (relatif à la racine) reste-t-il dessous ? `""` = la racine elle-même. */
function sousLaRacine(rel: string): boolean {
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Racine en chemin réel (un projet ouvert par un lien symbolique reste comparable). */
async function racineReelle(racine: string): Promise<string> {
  try {
    return await fsp.realpath(racine);
  } catch {
    return path.resolve(racine);
  }
}

/** Chemin réel sous la racine, ou message de refus. */
export async function cheminDansRacine(racineDonnee: string, chemin: string): Promise<string | { refus: string }> {
  const racine = await racineReelle(racineDonnee);
  const abs = path.resolve(racine, chemin);
  let reel: string;
  try {
    reel = await fsp.realpath(abs);
  } catch {
    return { refus: `fichier introuvable : ${chemin}` };
  }
  if (!sousLaRacine(path.relative(racine, reel))) {
    return { refus: `refusé : « ${chemin} » est hors du projet` };
  }
  return reel;
}

/** Fichier prêt à partir : chemin réel, nom de base, contenu. */
export interface FichierADeposer {
  reel: string;
  nom: string;
  contenu: Buffer;
}

/**
 * Contrôle de DÉPÔT, sans réseau : le fichier peut-il quitter ce poste ?
 * `connus` : valeurs exactes à chercher dans le contenu (jeton du relais,
 * valeurs du coffre), comparées en mémoire, jamais citées.
 */
export async function controlerDepot(
  racineDonnee: string,
  chemin: string,
  connus: string[] = [],
): Promise<FichierADeposer | { refus: string }> {
  const racine = await racineReelle(racineDonnee);
  if (estFichierSensible(chemin)) {
    return { refus: `refusé : « ${chemin} » ressemble à un secret ou à une clé, il ne part pas par le relais` };
  }
  const reel = await cheminDansRacine(racine, chemin);
  if (typeof reel !== "string") return reel;
  const rel = path.relative(racine, reel);
  if (estFichierSensible(rel)) return { refus: `refusé : « ${chemin} » ressemble à un secret ou à une clé` };
  if (estFichierConsigne(path.basename(reel)) || rel.split(path.sep).includes(".git")) {
    return { refus: `refusé : « ${chemin} » est un fichier de configuration du projet, il ne part pas par le relais` };
  }
  // Un message du veilleur ne se forge pas à la main : il passe par `relais_demander`.
  if (estNomMessageRelais(path.basename(reel)) || estNomMessageRelais(path.basename(chemin))) {
    return { refus: `refusé : « ${chemin} » porte un nom de message du veilleur (msg-*.md) ; une demande passe par relais_demander` };
  }
  const st = await fsp.stat(reel);
  if (!st.isFile()) return { refus: `refusé : « ${chemin} » n'est pas un fichier` };
  if (st.size > TAILLE_MAX) return { refus: `refusé : ${octets(st.size)}, au-delà de ${octets(TAILLE_MAX)}` };
  const contenu = await fsp.readFile(reel);
  const motif = motifSecretDansContenu(contenu, connus);
  if (motif) return { refus: `refusé : « ${chemin} » contient ${motif} ; retire-le avant de déposer` };
  return { reel, nom: path.basename(reel), contenu };
}

/**
 * Nom local d'un fichier reçu, ou refus. Secrets et clés : refusés (rien de
 * tel ne doit arriver en clair dans le projet). Fichiers de consignes : suffixe
 * `.recu`, pour qu'aucun outil ne les charge comme instructions du projet.
 */
export function nomDeReception(nomDistant: string): string | { refus: string } {
  // Windows retire les points et espaces finaux : `CLAUDE.md.` y EST `CLAUDE.md`.
  // On les retire donc AVANT tout test, pour que le test voie le nom réel.
  const nom = path.basename(nomDistant.replace(/\\/g, "/")).replace(/[. ]+$/, "");
  if (!nom || nom === "." || nom === "..") return { refus: "nom de fichier invalide" };
  if (NOM_RESERVE_WINDOWS.test(nom)) {
    return { refus: `refusé : ${JSON.stringify(nom)} est un nom réservé de Windows` };
  }
  if (estFichierSensible(nom)) {
    return { refus: `refusé : ${JSON.stringify(nom)} ressemble à un secret ou à une clé, il n'est pas écrit dans le projet` };
  }
  return estFichierConsigne(nom) ? `${nom}.recu` : nom;
}

/** `CON`, `NUL`, `PRN`, `AUX`, `COM1-9`, `LPT1-9`, avec ou sans extension. */
const NOM_RESERVE_WINDOWS = /^(con|nul|prn|aux|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Nom d'un message du veilleur (`msg-*.md`). */
export function estNomMessageRelais(nom: string): boolean {
  return /^msg-.+\.md$/i.test(nom.replace(/[. ]+$/, ""));
}

/**
 * Un segment de sous-dossier venu d'un message (le `fil`) est-il sûr ? Règle
 * commune aux identifiants (segmentsSurs.ts) : jamais un chemin.
 */
export { segmentSur } from "./segmentsSurs.js";

/**
 * Dossier de réception (`relais-recu/` ou `relais-recu/<sous>/`), créé au
 * besoin, chemin RÉEL vérifié sous la racine (pas de lien qui en sorte).
 * Chaque niveau est vérifié AVANT de créer le suivant : un `relais-recu`
 * lien vers l'extérieur ne reçoit même pas de dossier vide.
 */
export async function dossierReception(racineDonnee: string, sous?: string): Promise<string | { refus: string }> {
  const racine = await racineReelle(racineDonnee);
  if (sous !== undefined && !segmentSur(sous)) {
    return { refus: `refusé : ${JSON.stringify(sous)} n'est pas un nom de dossier sûr` };
  }
  const verifier = async (dossier: string): Promise<string | { refus: string }> => {
    await fsp.mkdir(dossier, { recursive: true });
    const reel = await fsp.realpath(dossier);
    const rel = path.relative(racine, reel);
    if (rel === "" || !sousLaRacine(rel)) {
      return { refus: `refusé : ${DOSSIER_RECU}/ pointe hors du projet (lien symbolique ?)` };
    }
    return reel;
  };
  const base = await verifier(path.join(racine, DOSSIER_RECU));
  if (typeof base !== "string" || sous === undefined) return base;
  return verifier(path.join(base, sous));
}

/** Premier nom libre (`x.txt`, `x-1.txt`…) : jamais d'écrasement. */
export async function cibleLibre(dossier: string, nom: string): Promise<string> {
  const ext = path.extname(nom);
  const base = nom.slice(0, nom.length - ext.length);
  for (let i = 0; ; i++) {
    const candidat = path.join(dossier, i === 0 ? nom : `${base}-${i}${ext}`);
    try {
      await fsp.access(candidat);
    } catch {
      return candidat;
    }
  }
}

/** Fichier reçu et écrit : chemin relatif à la racine, taille, empreinte. */
export interface FichierRecu {
  relatif: string;
  taille: number;
  empreinte: string;
}

/**
 * Écrit un fichier reçu sous `relais-recu/[<sous>/]` avec TOUTES les règles de
 * réception. Ne lève pas pour un refus : rend `{ refus }` (une erreur disque,
 * elle, remonte — l'appelant la journalise).
 */
export async function ecrireRecu(
  racineDonnee: string,
  sous: string | undefined,
  nomDistant: string,
  contenu: Buffer,
): Promise<FichierRecu | { refus: string }> {
  const racine = await racineReelle(racineDonnee);
  const nom = nomDeReception(nomDistant);
  if (typeof nom !== "string") return nom;
  const dossier = await dossierReception(racine, sous);
  if (typeof dossier !== "string") return dossier;
  const cible = await cibleLibre(dossier, nom);
  await fsp.writeFile(cible, contenu, { flag: "wx" });
  return { relatif: path.relative(racine, cible), taille: contenu.length, empreinte: empreinteSha256(contenu) };
}
