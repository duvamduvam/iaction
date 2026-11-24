/*
 * Veilleur du relais — les CONTENEURS dans les pièces d'une réponse (T-230).
 *
 * Un fichier compressé cache son contenu aux contrôles du dépôt : le nom et la
 * recherche de secrets ne voient que des octets compressés. Un `.env` rangé
 * dans une archive passerait. Ce module décide, sur les OCTETS (jamais sur
 * l'extension) :
 * - un ZIP (y compris .docx, .xlsx…) est lu par son répertoire central, SANS
 *   rien décompresser ; il est refusé si une entrée porte un nom sensible, un
 *   fichier de consignes, un chemin sous `.git/` ou `.iaction/`, un réglage
 *   `.claude/settings*`, un `msg-*.md`, un chemin qui sort de l'archive, ou si
 *   l'archive est chiffrée, tronquée ou incohérente ;
 * - tout autre conteneur reconnu (gzip, 7z, rar, xz, zstd, bz2, tar…) est
 *   refusé : on ne sait pas y lire les noms.
 *
 * Limite assumée : le CONTENU d'une entrée compressée n'est pas cherché.
 *
 * Feuille pure : un tampon en entrée, une raison de refus (ou `null`) en sortie.
 */

import { cheminNormalise, estFichierConsigne, estFichierSensible } from "./fichiersSecrets.js";
import { estNomMessageRelais } from "./relaisFichiers.js";

export const RAISON_ARCHIVE = "archive non inspectable, envoyer un .zip";
const MAX_ENTREES = 10_000;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCALISEUR = 0x07064b50;
const SIG_ENTREE = 0x02014b50;

/** Signatures de conteneurs que l'on ne sait pas inspecter : [octets, décalage]. */
const MAGIQUES: [number[], number][] = [
  [[0x1f, 0x8b], 0], // gzip
  [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], 0], // 7z
  [[0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], 0], // rar
  [[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], 0], // xz
  [[0x28, 0xb5, 0x2f, 0xfd], 0], // zstd
  [[0x04, 0x22, 0x4d, 0x18], 0], // lz4
  [[0x4c, 0x5a, 0x49, 0x50], 0], // lzip
  [[0x4d, 0x53, 0x43, 0x46], 0], // cab
  [[0x21, 0x3c, 0x61, 0x72, 0x63, 0x68, 0x3e], 0], // ar (deb)
  [[0x30, 0x37, 0x30, 0x37, 0x30], 0], // cpio (070701, 070702, 070707)
  [[0x75, 0x73, 0x74, 0x61, 0x72], 257], // tar
];

function commencePar(c: Buffer, octets: number[], decalage: number): boolean {
  return c.length >= decalage + octets.length && octets.every((o, i) => c[decalage + i] === o);
}

/** Fin de répertoire central : la DERNIÈRE dont le commentaire va exactement jusqu'au bout du fichier. */
function trouverEocd(c: Buffer): number {
  const plancher = Math.max(0, c.length - 22 - 65535);
  for (let i = c.length - 22; i >= plancher; i--) {
    if (c.readUInt32LE(i) === SIG_EOCD && i + 22 + c.readUInt16LE(i + 20) === c.length) return i;
  }
  return -1;
}

/** Raison de refus d'un nom d'entrée d'archive, ou `null`. */
function motifNomEntree(nom: string): string | null {
  if (nom.includes("\0")) return "nom d'entrée invalide";
  const unifie = nom.replace(/\\/g, "/");
  if (unifie.startsWith("/") || /^[A-Za-z]:/.test(unifie) || unifie.split("/").includes("..")) return "chemin d'entrée hors de l'archive";
  const segments = cheminNormalise(unifie).split("/");
  const base = segments[segments.length - 1] ?? "";
  if (estFichierSensible(unifie)) return "entrée qui ressemble à un secret ou à une clé";
  if (estFichierConsigne(base)) return "entrée qui est un fichier de consignes";
  if (segments.some((s) => s === ".git" || s === ".iaction")) return "entrée sous .git ou .iaction";
  if (segments.includes(".claude") && base.startsWith("settings")) return "entrée qui est un réglage de l'agent";
  if (estNomMessageRelais(base)) return "entrée qui porte un nom de message du veilleur";
  return null;
}

/** Noms sous lesquels un extracteur peut lire une même entrée (UTF-8, latin1, champ « Unicode Path »). */
function nomsDeLEntree(c: Buffer, p: number): string[] {
  const nl = c.readUInt16LE(p + 28);
  const el = c.readUInt16LE(p + 30);
  const brut = c.subarray(p + 46, p + 46 + nl);
  const noms = [brut.toString("utf8"), brut.toString("latin1")];
  let q = p + 46 + nl;
  const finExtra = q + el;
  while (q + 4 <= finExtra) {
    const id = c.readUInt16LE(q);
    const taille = c.readUInt16LE(q + 2);
    if (q + 4 + taille > finExtra) break;
    if (id === 0x7075 && taille >= 5) noms.push(c.subarray(q + 9, q + 4 + taille).toString("utf8"));
    q += 4 + taille;
  }
  return noms;
}

function inspecterZip(c: Buffer, eocd: number): string | null {
  const illisible = "zip illisible ou incohérent, envoyer un .zip valide";
  const zip64 = "zip64 non inspectable, envoyer un .zip ordinaire";
  if (eocd >= 20 && c.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCALISEUR) return zip64;
  const total = c.readUInt16LE(eocd + 10);
  const taille = c.readUInt32LE(eocd + 12);
  if (total === 0xffff || taille === 0xffffffff || c.readUInt32LE(eocd + 16) === 0xffffffff) return zip64;
  if (total > MAX_ENTREES) return `archive de plus de ${MAX_ENTREES} entrées`;
  let p = eocd - taille; // robuste à des octets placés devant l'archive
  if (p < 0) return illisible;
  for (let k = 0; k < total; k++) {
    if (p + 46 > eocd || c.readUInt32LE(p) !== SIG_ENTREE) return illisible;
    const fin = p + 46 + c.readUInt16LE(p + 28) + c.readUInt16LE(p + 30) + c.readUInt16LE(p + 32);
    if (fin > eocd) return illisible;
    if (c.readUInt16LE(p + 8) & 1) return "archive chiffrée : elle ne peut pas être inspectée";
    for (const nom of nomsDeLEntree(c, p)) {
      const m = motifNomEntree(nom);
      if (m) return `${m} (${JSON.stringify(nom.slice(0, 60))})`;
    }
    p = fin;
  }
  return p === eocd ? null : illisible;
}

/**
 * Le contenu est-il un conteneur à refuser ? Rend la raison, ou `null` (un
 * fichier ordinaire, ou une archive ZIP dont toutes les entrées sont permises).
 */
export function inspecterConteneur(c: Buffer): string | null {
  const eocd = c.length >= 22 ? trouverEocd(c) : -1;
  // Un ZIP se lit par la FIN : des octets devant (polyglotte, auto-extractible) ne le cachent pas.
  if (eocd >= 0) return inspecterZip(c, eocd);
  if (commencePar(c, [0x50, 0x4b, 0x03, 0x04], 0) || commencePar(c, [0x50, 0x4b, 0x05, 0x06], 0)) {
    return "zip illisible ou tronqué, envoyer un .zip valide";
  }
  if (MAGIQUES.some(([o, d]) => commencePar(c, o, d)) || (commencePar(c, [0x42, 0x5a, 0x68], 0) && c.length > 3 && c[3] >= 0x31 && c[3] <= 0x39)) {
    return RAISON_ARCHIVE;
  }
  return null;
}
