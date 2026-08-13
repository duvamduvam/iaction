#!/usr/bin/env node
/**
 * Audit avant publication — refuse de laisser partir des traces personnelles.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────
 * Jusqu'au 2026-08-07, deux dépôts séparés protégeaient par construction : le
 * dépôt de travail et le produit public n'échangeaient rien automatiquement.
 * Le renommage en IAction a fusionné les deux — bon choix, la double
 * maintenance était une source d'erreurs — mais il a supprimé cette barrière.
 * Ce script la remplace.
 *
 * Ce qui fuit n'est jamais le code : il est écrit pour être lu. C'est le
 * CONTEXTE d'écriture qui fuit — chemins absolus, noms d'hôtes d'une infra
 * auto-hébergée, noms d'autres clients, adresses courriel, jetons. Ça s'écrit
 * tout seul, dans un commentaire qui raconte un vrai incident ou un exemple de
 * configuration. Et c'est irréversible : un dépôt public est indexé et mis en
 * cache, supprimer après ne supprime rien.
 *
 * ── Deux familles de règles, pour une bonne raison ──────────────────────
 * Les règles STRUCTURELLES vivent ici : elles décrivent des formes (un chemin
 * personnel, une adresse courriel, un hôte inconnu) et sont donc publiables
 * telles quelles.
 *
 * Les motifs LITTÉRAUX — le nom d'un client, un domaine privé — ne peuvent pas
 * vivre dans ce fichier : les inscrire dans le dépôt public reviendrait à
 * publier exactement ce qu'on cherche à retenir. Ils sont donc lus depuis
 * `scripts/.audit-motifs`, ignoré par git. Son absence n'est pas une erreur :
 * la CI publique tourne sans lui, avec les seules règles structurelles.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   node scripts/audit-publication.mjs              vérifie l'arbre de travail
 *   node scripts/audit-publication.mjs --historique ajoute les messages de commit
 *
 * Une ligne peut être exemptée en portant le marqueur `audit-publication:ok`
 * — explicitement, pour que l'exception se voie en revue.
 */

import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine =
  process.env.IACTION_AUDIT_RACINE ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fichierMotifs = path.join(racine, "scripts", ".audit-motifs");

const MARQUEUR_EXEMPTION = "audit-publication:ok";

/**
 * Domaines réservés à la documentation : jamais une vraie machine.
 * (RFC 2606 / RFC 6761, plus leurs équivalents français utilisés dans nos
 * exemples.)
 */
const DOMAINES_FICTIFS = /(?:^|\.)(?:example|exemple)\.(?:com|org|net|fr)$|\.(?:local|test|invalid|localhost)$|^localhost$/i;

/**
 * Hôtes dont la présence est légitime, relus une fois et consignés dans
 * `scripts/audit-hotes.json`. Cette liste EST publiable : elle ne contient que
 * du public. Tout hôte absent fait échouer l'audit — c'est ce qui permet de
 * repérer une infra privée sans jamais écrire son nom ici.
 */
const HOTES_ATTENDUS = new Set(
  ["localhost", "127.0.0.1", "0.0.0.0"].concat(
    JSON.parse(
      await fsp.readFile(path.join(racine, "scripts", "audit-hotes.json"), "utf8"),
    ).hotes,
  ).map((h) => h.toLowerCase()),
);

function hoteConnu(hote) {
  const bas = hote.toLowerCase();
  return HOTES_ATTENDUS.has(bas) || DOMAINES_FICTIFS.test(bas);
}

/**
 * Valeurs manifestement destinées à être remplacées. Un gabarit publié n'est
 * pas une fuite — c'est même le contraire : c'est ce qui évite qu'un lecteur
 * invente sa propre convention.
 */
const GABARIT = /EXEMPLE|EXAMPLE|REMPLACER|REPLACE|PLACEHOLDER|CHANGEME|XXXX|VOTRE|YOUR[-_]/i;

/**
 * Noms de compte qui ne désignent personne : soit inventés pour la
 * documentation et les tests, soit comptes de service d'une machine
 * d'intégration continue. Les lister ici est publiable — et vaut mieux que
 * treize marqueurs d'exemption disséminés dans le code, qui finiraient par ne
 * plus être relus.
 */
const COMPTES_FICTIFS = new Set([
  // inventés
  "moi", "utilisateur", "user", "username", "votrenom", "vous",
  "jean", "jean%20dupont", "jeandupont", "dupont", "testeur", "test",
  "exemple", "example", "x", "alice", "bob",
  // comptes de service (exécuteurs d'intégration continue, conteneurs)
  "runner", "runneradmin", "administrator", "containeradministrator",
  "vsts", "azureuser", "root", "vagrant",
]);

/**
 * Extensions de fichier qui se font passer pour un domaine : « 128@2x.png »
 * ressemble à une adresse courriel pour n'importe quelle expression régulière
 * raisonnable. Faux positif relevé au premier passage, sur tauri.conf.json.
 */
const FAUSSES_ADRESSES = /\.(?:png|jpe?g|gif|webp|svg|ico|icns|js|mjs|cjs|ts|tsx|jsx|rs|json|md|css|html?|ya?ml|toml|lock|sh|py|txt|wav|mp3|zip|tar|gz)$/i;

/** Adresses tolérées : celles qui appartiennent au produit, pas à une personne. */
const COURRIELS_ATTENDUS = [
  /@(?:example|exemple)\.(?:com|org|net|fr)$/i,
  /noreply@anthropic\.com$/i,
  /@users\.noreply\.github\.com$/i,
];

const REGLES = [
  {
    nom: "chemin personnel (Linux/macOS)",
    motif: /\/(?:home|Users)\/([A-Za-z][\w.%-]*)\//g,
    pourquoi: "révèle le nom de compte et l'arborescence du poste",
    capture: 1,
    tolere: (m) => COMPTES_FICTIFS.has(m.toLowerCase()),
  },
  {
    nom: "chemin personnel (Windows)",
    motif: /[A-Za-z]:\\+Users\\+([A-Za-z][\w.%-]*)/g,
    pourquoi: "révèle le nom de compte Windows",
    capture: 1,
    tolere: (m) => COMPTES_FICTIFS.has(m.toLowerCase()),
  },
  {
    nom: "adresse courriel",
    motif: /\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,
    pourquoi: "adresse nominative",
    // « git@<hôte connu> » est un remote SSH, pas une adresse : la forme est
    // identique pour cette règle, mais c'est celle de « hôte SSH » qui juge —
    // et elle tolère les hôtes de la liste relue. Un hôte INCONNU derrière
    // git@ reste refusé (par les deux règles).
    tolere: (m) =>
      FAUSSES_ADRESSES.test(m) ||
      COURRIELS_ATTENDUS.some((r) => r.test(m)) ||
      (/^git@/i.test(m) && hoteConnu(m.slice(m.indexOf("@") + 1))),
  },
  {
    nom: "hôte non attendu dans une URL",
    motif: /\bhttps?:\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    pourquoi: "peut désigner une infrastructure privée",
    capture: 1,
    tolere: hoteConnu,
  },
  {
    nom: "hôte SSH",
    motif: /\b(?:ssh:\/\/|git@)([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    pourquoi: "désigne une forge ou un serveur nominatif",
    capture: 1,
    tolere: hoteConnu,
  },
  {
    nom: "adresse IP publique",
    motif: /\b(?!0\.|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|255\.|224\.)(?:\d{1,3}\.){3}\d{1,3}\b/g,
    pourquoi: "peut désigner une machine réelle",
  },
  {
    nom: "jeton ou clé d'API",
    motif: /\b(?:sk-ant-[\w-]{8,}|sk-or-[\w-]{8,}|ghp_[\w]{16,}|github_pat_[\w]{20,}|glpat-[\w-]{16,}|xox[baprs]-[\w-]{10,})/g,
    pourquoi: "un secret publié est un secret brûlé",
    tolere: (m) => GABARIT.test(m),
  },
];

/** Fichiers dont le contenu n'est pas du texte relu par un humain. */
const EXTENSIONS_IGNOREES = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".webp", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".wav", ".mp3", ".onnx", ".bin", ".pdf",
]);

async function motifsLocaux() {
  try {
    const brut = await fsp.readFile(fichierMotifs, "utf8");
    return brut
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
      .map((litteral) => ({
        nom: "motif local interdit",
        motif: new RegExp(litteral.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        pourquoi: "inscrit dans scripts/.audit-motifs",
      }));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/** Masque le milieu : le rapport doit être lisible sans réécrire la fuite. */
function masquer(texte) {
  if (texte.length <= 6) return `${texte.slice(0, 1)}…`;
  return `${texte.slice(0, 3)}…${texte.slice(-3)}`;
}

function fichiersSuivis() {
  // T-011 — « --others --exclude-standard » ajoute les fichiers NON SUIVIS
  // (non ignorés) : sans eux, un fichier neuf passait l'audit avant `git add`
  // et le faisait échouer après coup — vert au moment de vérifier, rouge une
  // fois commité (constaté le 2026-08-09 avec src-tauri/nsis/installer.nsi).
  const sortie = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: racine, encoding: "utf8" },
  );
  return sortie
    .split("\0")
    .filter((f) => f.length > 0)
    .filter((f) => !EXTENSIONS_IGNOREES.has(path.extname(f).toLowerCase()));
}

function inspecter(texte, origine, regles, constats) {
  for (const [i, ligne] of texte.split("\n").entries()) {
    if (ligne.includes(MARQUEUR_EXEMPTION)) continue;
    for (const regle of regles) {
      regle.motif.lastIndex = 0;
      let trouve;
      while ((trouve = regle.motif.exec(ligne)) !== null) {
        const valeur = regle.capture ? trouve[regle.capture] : trouve[0];
        if (regle.tolere?.(valeur)) continue;
        constats.push({ origine, ligne: i + 1, regle: regle.nom, pourquoi: regle.pourquoi, extrait: masquer(valeur) });
      }
    }
  }
}

async function balayerArbre(regles, constats) {
  for (const fichier of fichiersSuivis()) {
    let texte;
    try {
      texte = await fsp.readFile(path.join(racine, fichier), "utf8");
    } catch {
      continue; // fichier binaire ou illisible : rien à relire
    }
    if (texte.includes("\0")) continue;
    inspecter(texte, fichier, regles, constats);
  }
}

/**
 * Informatif : la publication se fait par commit d'instantané, donc
 * l'historique local ne part pas. Le signaler évite de croire qu'on pourrait
 * un jour pousser la branche telle quelle.
 */
function balayerHistorique(regles, constats) {
  const journal = execFileSync("git", ["log", "--format=%H%n%s%n%b"], { cwd: racine, encoding: "utf8" });
  const avant = constats.length;
  inspecter(journal, "(messages de commit)", regles, constats);
  if (constats.length > avant) {
    console.log(
      `Note : ${constats.length - avant} trace(s) dans l'historique local. Sans gravité\n` +
        "tant que la publication se fait par commit d'instantané — mais c'est\n" +
        "précisément pourquoi elle ne doit jamais devenir un envoi de branche.\n",
    );
  }
}

/**
 * Groupé et plafonné : un motif trop large produit des centaines de constats
 * identiques (essayé le 2026-08-08 : « duvam » en a rendu 101, tous sur le
 * namespace du produit). Une liste illisible pousse à ignorer le rapport,
 * c'est-à-dire à désarmer la barrière.
 */
function rapporter(constats) {
  const PLAFOND = 8;
  console.error(`\nAudit de publication : ${constats.length} trace(s) à retirer avant de publier.\n`);

  const parRegle = new Map();
  for (const c of constats) {
    if (!parRegle.has(c.regle)) parRegle.set(c.regle, []);
    parRegle.get(c.regle).push(c);
  }

  for (const [regle, liste] of parRegle) {
    console.error(`  ${regle} — ${liste.length} occurrence(s)`);
    console.error(`    ${liste[0].pourquoi}`);
    for (const c of liste.slice(0, PLAFOND)) {
      console.error(`      ${c.origine}:${c.ligne}  ${c.extrait}`);
    }
    if (liste.length > PLAFOND) console.error(`      … et ${liste.length - PLAFOND} autre(s).`);
    console.error("");
  }

  console.error(
    "Retirer la trace est la réponse attendue. Si elle est légitime, ajouter\n" +
      `« ${MARQUEUR_EXEMPTION} » sur la ligne — explicitement, pour que le choix se voie.`,
  );
}

async function main() {
  const locaux = await motifsLocaux();
  const regles = [...REGLES, ...(locaux ?? [])];
  const constats = [];

  await balayerArbre(regles, constats);
  if (process.argv.includes("--historique")) balayerHistorique(regles, constats);

  console.log(
    locaux === null
      ? "Motifs locaux : aucun fichier scripts/.audit-motifs — règles structurelles seules."
      : `Motifs locaux : ${locaux.length} littéral(aux) chargé(s).`,
  );

  if (constats.length === 0) {
    console.log("Audit de publication : rien à signaler.");
    return;
  }

  rapporter(constats);
  process.exitCode = 1;
}

await main();
