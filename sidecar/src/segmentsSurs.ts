/**
 * Identifiants venus d'un autre poste (`fil`, `id` d'un message) et segments
 * de chemin qu'on en tire — une seule règle, sans dépendance (le serveur relais
 * autonome l'importe aussi, via relaisFichiers.ts).
 *
 * Lettres, chiffres, `.`, `_`, `-`, 1 à 80 caractères ; ni `.` ni `..` ; ni
 * les noms qui touchent au prototype d'un objet JavaScript (`__proto__`,
 * `constructor`, `prototype`) : un `fil` sert de clé de table et de dossier.
 * Refusés aussi (Windows) : les noms réservés (`CON`, `NUL`, `COM1`…, avec ou
 * sans extension, sans égard à la casse) et un point final, que Windows ignore.
 */

const INTERDITS = new Set(["__proto__", "constructor", "prototype"]);

const RESERVES_WINDOWS = /^(con|nul|prn|aux|com[1-9]|lpt[1-9])(\..*)?$/i;

export function segmentSur(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^[A-Za-z0-9._-]{1,80}$/.test(s) &&
    s !== "." &&
    s !== ".." &&
    !s.endsWith(".") &&
    !INTERDITS.has(s) &&
    !RESERVES_WINDOWS.test(s)
  );
}
