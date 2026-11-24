/**
 * Fichiers porteurs de secrets — règles PURES, sans dépendance (le serveur
 * relais autonome les importe aussi : bibliothèque standard seulement).
 *
 * Deux listes, deux usages (docs/etude-coffre-secrets.md § 6) :
 *
 * - `estFichierSecretBloque` : ce qu'un agent n'a pas le droit d'ÉCRIRE dans
 *   un projet (`.env`, `.env.*` sauf `.env.example`, `*.pem`, `*.key`). Un
 *   secret se déclare au coffre et se référence `${SECRET:nom}` ;
 * - `estFichierSensible` : ce que le relais refuse de DÉPOSER, quel que soit
 *   le dossier — la liste large (clés SSH, identifiants, coffre…).
 */

import path from "node:path";

/**
 * Chemin comparable (T-227) : séparateurs unifiés, barres doubles réduites,
 * minuscules, et points/espaces finaux de CHAQUE segment retirés — Windows
 * les ignore, si bien que `.iaction\\veilleur.json.` y désigne le même fichier.
 */
export function cheminNormalise(chemin: string): string {
  return chemin
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .toLowerCase()
    .split("/")
    .map((s) => (s === "." || s === ".." ? s : s.replace(/[. ]+$/, "")))
    .join("/");
}

/** Nom de base, séparateurs des deux systèmes acceptés. */
function nomDeBase(chemin: string): string {
  return path.posix.basename(cheminNormalise(chemin));
}

/** `.env`, `.env.local`, `api.env`… mais pas `.env.example`. */
export function estFichierEnv(chemin: string): boolean {
  const nom = nomDeBase(chemin);
  if (nom === ".env" || (nom.endsWith(".env") && nom.length > 4)) return true;
  return nom.startsWith(".env.") && nom !== ".env.example";
}

/** Fichiers qu'un agent chargerait comme CONSIGNES ou configuration d'outils. */
const NOMS_CONSIGNES = new Set(["claude.md", "claude.local.md", "agents.md", "gemini.md", ".mcp.json", ".cursorrules"]);

export function estFichierConsigne(chemin: string): boolean {
  return NOMS_CONSIGNES.has(nomDeBase(chemin));
}

/** Formes de jetons et de clés reconnaissables sans connaître leur valeur. */
const MOTIFS_SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "une clé privée"],
  [/AGE-SECRET-KEY-1[0-9A-Z]{20,}/, "une clé age"],
  [/\bsk-(?:ant|or|proj)-[A-Za-z0-9_-]{16,}/, "une clé d'API"],
  [/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/, "un jeton GitHub"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, "un jeton GitLab"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "un jeton Slack"],
  [/\bAKIA[0-9A-Z]{16}\b/, "une clé AWS"],
];

/**
 * Le contenu porte-t-il un secret ? Rend une DESCRIPTION (« une clé
 * privée »), jamais la valeur. `connus` : valeurs exactes à chercher (jeton
 * du relais…), comparées en mémoire ; ignorées sous 8 caractères.
 */
export function motifSecretDansContenu(contenu: Buffer, connus: string[] = []): string | null {
  for (const v of connus) {
    if (v.length < 8) continue;
    // Une même valeur peut être écrite en UTF-8, en UTF-16 (LE ou BE) ou en latin1.
    for (const forme of formesDeValeur(v)) {
      if (contenu.includes(forme)) return "un secret connu (jeton du relais ou du coffre)";
    }
  }
  // Les motifs ne portent que sur de l'ASCII : latin1 ne casse rien. Par fenêtres
  // (qui se recouvrent) : pas de copie de la taille du fichier entier.
  for (let debut = 0; debut < contenu.length; debut += FENETRE_MOTIFS) {
    const motif = motifDansTexte(contenu.toString("latin1", debut, Math.min(contenu.length, debut + FENETRE_MOTIFS + RECOUVREMENT_MOTIFS)));
    if (motif) return motif;
  }
  // UTF-16 avec marque d'ordre : on décode pour y chercher les formes reconnaissables.
  if (contenu.length >= 4 && ((contenu[0] === 0xff && contenu[1] === 0xfe) || (contenu[0] === 0xfe && contenu[1] === 0xff))) {
    const pair = contenu.subarray(0, contenu.length - (contenu.length % 2));
    const le = contenu[0] === 0xff ? pair : Buffer.from(pair).swap16();
    return motifDansTexte(le.toString("utf16le"));
  }
  return null;
}

const FENETRE_MOTIFS = 1 << 20;
/** Plus long qu'un motif (une clé privée, un jeton) : rien ne se perd à la jointure de deux fenêtres. */
const RECOUVREMENT_MOTIFS = 1024;

function motifDansTexte(texte: string): string | null {
  for (const [re, quoi] of MOTIFS_SECRETS) if (re.test(texte)) return quoi;
  return null;
}

function formesDeValeur(v: string): Buffer[] {
  const le = Buffer.from(v, "utf16le");
  const formes = [Buffer.from(v, "utf8"), le, Buffer.from(le).swap16()];
  const l1 = Buffer.from(v, "latin1");
  if (!l1.equals(formes[0])) formes.push(l1);
  return formes;
}

/**
 * Config du veilleur (`.iaction/veilleur.json`) : elle AUTORISE l'exécution
 * autonome de messages reçus (T-227). Un agent ne doit jamais l'écrire —
 * sinon un message piégé pourrait élargir son propre périmètre.
 */
export function estConfigVeilleur(chemin: string): boolean {
  const c = cheminNormalise(chemin);
  return c === ".iaction/veilleur.json" || c.endsWith("/.iaction/veilleur.json");
}

/**
 * Ce qu'un tour du VEILLEUR (lancé par un message, sans humain) ne peut pas
 * écrire, en plus des secrets : la config MCP, les réglages Claude du projet,
 * et tout `.iaction/`. Barrière contre la maladresse : avec Bash, un agent
 * déterminé passe (cp, mv, interpréteur) — c'est le scellé de la config qui
 * la protège (veilleurConfig.ts, `empreinteConfig`).
 */
export function estCheminProtegeVeilleur(chemin: string, sansBash = false): boolean {
  const c = cheminNormalise(chemin);
  const segments = c.split("/");
  const nom = segments[segments.length - 1] ?? "";
  if (nom === ".mcp.json") return true;
  if (segments.includes(".iaction")) return true;
  // Sans Bash, la garde n'est plus contournable par un shell : tout `.claude/` et `CLAUDE.md` en plus.
  if (sansBash && (segments.includes(".claude") || nom === "claude.md")) return true;
  const i = segments.lastIndexOf(".claude");
  return i >= 0 && i === segments.length - 2 && /^settings.*\.json$/.test(nom);
}

/** Ce qu'un agent ne peut pas écrire dans un projet. */
export function estFichierSecretBloque(chemin: string): boolean {
  const nom = nomDeBase(chemin);
  return estFichierEnv(chemin) || nom.endsWith(".pem") || nom.endsWith(".key") || estConfigVeilleur(chemin);
}

const NOMS_SENSIBLES = new Set([
  ".netrc",
  ".npmrc",
  ".pgpass",
  ".pypirc",
  ".git-credentials",
  ".credentials.json",
  "credentials",
  "credentials.json",
  "mcp-secrets.json",
  "coffre.age",
  "coffre.cle.age",
  "coffre.age.prec",
]);

const PREFIXES_SENSIBLES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const SUFFIXES_SENSIBLES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".age"];
const DOSSIERS_SENSIBLES = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube"]);

/** Ce que le relais refuse de déposer : secrets, clés, identifiants. */
export function estFichierSensible(chemin: string): boolean {
  if (estFichierSecretBloque(chemin)) return true;
  const nom = nomDeBase(chemin);
  if (NOMS_SENSIBLES.has(nom)) return true;
  if (PREFIXES_SENSIBLES.some((p) => nom.startsWith(p))) return true;
  if (SUFFIXES_SENSIBLES.some((s) => nom.endsWith(s))) return true;
  const segments = cheminNormalise(chemin).split("/");
  return segments.some((s) => DOSSIERS_SENSIBLES.has(s));
}

/**
 * Cibles d'écriture repérables dans une commande shell (Bash ou PowerShell) :
 * redirections, `tee`, cmdlets d'écriture PowerShell. Volontairement simple — la détection sur Bash protège de la
 * négligence, pas d'un agent déterminé (étude § 6.3) : `cp`, `mv`, un
 * interpréteur ou une variable passent.
 */
export function ciblesEcritureShell(commande: string): string[] {
  const cibles: string[] = [];
  // `>`, `>>`, `>|` (écrase malgré noclobber), `&>`, `&>>`, `2>`, et `tee [-a]`.
  const re = /(?:&>>?|\d?>>?\|?|\btee\b(?:\s+-a)?)\s*(["']?)([^\s"';&|<>()]+)\1/g;
  // PowerShell : cmdlets d'écriture, chemin positionnel ou nommé.
  const rePs =
    /\b(?:Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\b(?:\s+-(?:Path|FilePath|LiteralPath|Destination)\b)?\s+(["']?)([^\s"';|]+)\1/gi;
  for (const re_ of [re, rePs]) {
    for (const m of commande.matchAll(re_)) {
      const cible = m[2];
      if (cible && !cible.startsWith("&") && !cible.startsWith("-") && cible !== "/dev/null") cibles.push(cible);
    }
  }
  return cibles;
}

/** Message renvoyé à l'agent : il dit OÙ va un secret, pas seulement « non ». */
export function messageRefusEcriture(chemin: string): string {
  return (
    `Écriture refusée : « ${chemin} » porterait un secret en clair dans le projet. ` +
    "Un jeton se déclare au coffre d'IAction (écran « Secrets du coffre », ou champ secret du " +
    "catalogue MCP) et se référence `${SECRET:nom}` dans l'entrée du serveur de `.mcp.json` " +
    "(env, headers ou args). L'outil `mcp__studio__secrets_lister` donne les noms disponibles. " +
    "Un script qui a besoin d'un jeton devient un serveur MCP déclaré."
  );
}
