/*
 * Veilleur du relais — le DOSSIER DE SORTIE d'une demande : `relais-envoi/<id
 * de la demande>/`, à la racine du projet du veilleur. L'agent y écrit (ou y
 * copie) les fichiers à renvoyer à l'émetteur ; le cycle (veilleurCycle.ts) les
 * collecte après le tour et les dépose avec la réponse. Rien d'autre ne part.
 *
 * Trois gestes, tous bornés au dossier de la demande :
 * - `preparerSortie` : le crée, vide, avant le tour ;
 * - `collecterSortie` : lit les fichiers réguliers directement dedans, chacun
 *   passé au contrôle de dépôt du relais (nom sensible, fichier de consignes,
 *   `msg-*.md`, taille, secret dans le contenu) ;
 * - `supprimerSortie` : le retire après le dépôt du message.
 *
 * Le dossier est un lieu où l'agent peut écrire : un lien symbolique (dossier
 * ou fichier) n'est jamais suivi, un sous-dossier n'est jamais descendu, et
 * `relais-envoi/` lui-même ne doit pas pointer hors du projet. Son nom est une
 * EMPREINTE de l'id de la demande (jamais l'id lui-même : deux ids qui ne
 * diffèrent que par la casse partageraient un dossier sous Windows et macOS).
 * Tout texte qui PART (raison d'un refus) ne porte qu'un code d'erreur, jamais
 * un message système qui citerait un chemin du poste ; le détail reste local.
 */

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { controlerDepot, octets, segmentSur, TAILLE_MAX } from "./relaisFichiers.js";
import { inspecterConteneur } from "./veilleurArchive.js";
import { codeErreur, type SortieCollectee } from "./veilleurCycle.js";
import { nomPieceSur } from "./veilleurMessage.js";

export const DOSSIER_ENVOI = "relais-envoi";
/** Nombre de fichiers examinés au plus par demande ; les suivants sont refusés. */
export const PIECES_MAX = 20;

/** Nom du dossier d'une demande : empreinte courte de son id (sans casse ni nom réservé possibles). */
export function dossierDe(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

/** Chemin relatif (séparateur `/`) du dossier de sortie d'une demande, tel que dit à l'agent. */
export function cheminSortie(id: string): string {
  return `${DOSSIER_ENVOI}/${dossierDe(id)}`;
}

/**
 * Chemin réel de `relais-envoi/` (créé au besoin si `creer`), vérifié sous la
 * racine : un `relais-envoi` lien vers l'extérieur n'est jamais utilisé.
 * Rend `null` s'il est absent (et non créé).
 */
async function envoiReel(racine: string, creer: boolean): Promise<string | null> {
  const racineReelle = await fsp.realpath(racine);
  const attendu = path.join(racineReelle, DOSSIER_ENVOI);
  if (creer) await fsp.mkdir(attendu, { recursive: true });
  let reel: string;
  try {
    reel = await fsp.realpath(attendu);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (reel !== attendu) throw new Error(`${DOSSIER_ENVOI}/ pointe hors du projet (lien symbolique ?)`);
  return reel;
}

/** Crée le dossier de sortie (vide : un reliquat est nettoyé) et rend son chemin relatif. Lève si le dossier n'est pas sûr. */
export async function preparerSortie(racine: string, id: string): Promise<string> {
  if (!segmentSur(id)) throw new Error(`identifiant de demande non sûr : ${JSON.stringify(id)}`);
  const envoi = await envoiReel(racine, true);
  if (envoi === null) throw new Error(`${DOSSIER_ENVOI}/ introuvable après sa création`);
  const cible = path.join(envoi, dossierDe(id));
  await fsp.rm(cible, { recursive: true, force: true });
  await fsp.mkdir(cible);
  return cheminSortie(id);
}

/**
 * Collecte les fichiers de `relais-envoi/<id>/`. Dossier absent ou vide : rien,
 * sans bruit. `connus` : valeurs du coffre et jeton, cherchés dans le contenu
 * (comparés en mémoire, jamais cités). Ne lève pas pour un fichier refusé : il
 * devient une entrée de `refusees`.
 */
export async function collecterSortie(racine: string, id: string, connus: string[]): Promise<SortieCollectee> {
  const sortie: SortieCollectee = { pieces: [], refusees: [] };
  const envoi = await envoiReel(racine, false);
  if (envoi === null) return sortie;
  const dossier = path.join(envoi, dossierDe(id));
  let reel: string;
  try {
    reel = await fsp.realpath(dossier);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return sortie;
    throw e;
  }
  if (reel !== dossier) {
    sortie.refusees.push({ nom: cheminSortie(id), raison: "le dossier de sortie n'est pas un dossier du projet (lien symbolique ?)" });
    return sortie;
  }

  const entrees = (await fsp.readdir(dossier, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let examines = 0;
  let cumul = 0;
  for (const e of entrees) {
    const nom = e.name;
    if (e.isSymbolicLink()) {
      sortie.refusees.push({ nom, raison: "lien symbolique : jamais suivi, il ne part pas" });
      continue;
    }
    if (e.isDirectory()) {
      sortie.refusees.push({ nom, raison: "sous-dossier : seuls les fichiers à plat partent" });
      continue;
    }
    if (!e.isFile()) {
      sortie.refusees.push({ nom, raison: "ce n'est pas un fichier régulier" });
      continue;
    }
    if (!nomPieceSur(nom)) {
      sortie.refusees.push({ nom, raison: "nom de fichier non sûr" });
      continue;
    }
    examines += 1;
    if (examines > PIECES_MAX) {
      sortie.refusees.push({ nom, raison: `au-delà de ${PIECES_MAX} fichiers par réponse` });
      continue;
    }
    try {
      const taille = (await fsp.lstat(path.join(dossier, nom))).size;
      if (cumul + taille > TAILLE_MAX) {
        sortie.refusees.push({ nom, raison: `au-delà de ${octets(TAILLE_MAX)} cumulés par réponse` });
        continue;
      }
      const r = await controlerDepot(dossier, nom, connus);
      if ("refus" in r) {
        sortie.refusees.push({ nom, raison: r.refus });
        continue;
      }
      // La taille LUE fait foi (le fichier a pu grossir depuis le `lstat`).
      if (cumul + r.contenu.length > TAILLE_MAX) {
        sortie.refusees.push({ nom, raison: `au-delà de ${octets(TAILLE_MAX)} cumulés par réponse` });
        continue;
      }
      const conteneur = inspecterConteneur(r.contenu);
      if (conteneur) {
        sortie.refusees.push({ nom, raison: conteneur });
        continue;
      }
      cumul += r.contenu.length;
      sortie.pieces.push({ nom, contenu: r.contenu });
    } catch (err) {
      sortie.refusees.push({ nom, raison: `illisible (${codeErreur(err)})`, detail: String(err) });
    }
  }
  return sortie;
}

/** Supprime `relais-envoi/<id>/` (absent : rien). Jamais hors du projet. */
export async function supprimerSortie(racine: string, id: string): Promise<void> {
  if (!segmentSur(id)) throw new Error(`identifiant de demande non sûr : ${JSON.stringify(id)}`);
  const envoi = await envoiReel(racine, false);
  if (envoi === null) return;
  await fsp.rm(path.join(envoi, dossierDe(id)), { recursive: true, force: true });
}

/**
 * Reliquats : retire les dossiers de sortie dont la demande est déjà répondue
 * (`repondus` : ids), ou plus vieux que `ageMaxMs`. Un échec ne lève pas : il
 * est rendu, pour que l'appelant le dise une fois et réessaie à la relève suivante.
 */
export async function nettoyerSorties(
  racine: string,
  repondus: string[],
  ageMaxMs: number,
  maintenant: number = Date.now(),
): Promise<{ retires: number; echecs: { nom: string; cause: string }[] }> {
  const bilan = { retires: 0, echecs: [] as { nom: string; cause: string }[] };
  const envoi = await envoiReel(racine, false);
  if (envoi === null) return bilan;
  const repondu = new Set(repondus.map(dossierDe));
  for (const e of await fsp.readdir(envoi, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      const cible = path.join(envoi, e.name);
      const ancien = maintenant - (await fsp.stat(cible)).mtimeMs > ageMaxMs;
      if (!repondu.has(e.name) && !ancien) continue;
      await fsp.rm(cible, { recursive: true, force: true });
      bilan.retires += 1;
    } catch (err) {
      bilan.echecs.push({ nom: e.name, cause: String(err) });
    }
  }
  return bilan;
}
