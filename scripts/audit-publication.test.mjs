/**
 * Tests de l'audit de publication.
 *
 * Une barrière qu'on ne peut pas faire échouer volontairement ne protège de
 * rien : on saurait seulement qu'elle est silencieuse, pas qu'elle veille.
 * Chaque cas ci-dessous construit un faux dépôt et vérifie le CODE DE SORTIE.
 *
 * ── Une précaution particulière à ce fichier ────────────────────────────
 * Il doit contenir des chaînes que l'audit refuse — sinon il ne prouverait
 * rien. Écrites en clair, elles feraient échouer l'audit sur le fichier de
 * test lui-même, et on serait tenté de désarmer la règle plutôt que le test.
 * Elles sont donc assemblées par `bout()` au moment de l'exécution : jamais
 * présentes en clair dans la source, mais parfaitement lisibles à la lecture.
 *
 * Lancement : node scripts/audit-publication.test.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const audit = path.join(__dirname, "audit-publication.mjs");
const hotesReels = path.join(__dirname, "audit-hotes.json");

/** Assemble une chaîne interdite sans jamais l'écrire en clair. */
const bout = (...morceaux) => morceaux.join("");

let reussites = 0;
let echecs = 0;

function verifier(intitule, condition, detail = "") {
  if (condition) {
    reussites += 1;
    return;
  }
  echecs += 1;
  console.error(`ECHEC: ${intitule}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Faux dépôt git : l'audit ne lit que les fichiers SUIVIS.
 *
 * `.audit-motifs` est ignoré par git, comme dans le vrai dépôt — le versionner
 * publierait exactement ce qu'il sert à retenir. Le cas contraire est vérifié
 * explicitement plus bas.
 */
async function fauxDepot(fichiers, motifsLocaux, { motifsSuivis = false } = {}) {
  const racine = await fsp.mkdtemp(path.join(os.tmpdir(), "audit-"));
  await fsp.mkdir(path.join(racine, "scripts"), { recursive: true });
  await fsp.copyFile(hotesReels, path.join(racine, "scripts", "audit-hotes.json"));
  if (motifsLocaux !== undefined) {
    await fsp.writeFile(path.join(racine, "scripts", ".audit-motifs"), motifsLocaux, "utf8");
    if (!motifsSuivis) {
      await fsp.writeFile(path.join(racine, ".gitignore"), "scripts/.audit-motifs\n", "utf8");
    }
  }
  for (const [relatif, contenu] of Object.entries(fichiers)) {
    const complet = path.join(racine, relatif);
    await fsp.mkdir(path.dirname(complet), { recursive: true });
    await fsp.writeFile(complet, `${contenu}\n`, "utf8");
  }
  execFileSync("git", ["init", "-q"], { cwd: racine });
  execFileSync("git", ["add", "-A"], { cwd: racine });
  return racine;
}

function lancer(racine, ...args) {
  const res = spawnSync(process.execPath, [audit, ...args], {
    env: { ...process.env, IACTION_AUDIT_RACINE: racine },
    encoding: "utf8",
  });
  return { code: res.status, sortie: `${res.stdout}${res.stderr}` };
}

/** Raccourci : un seul fichier, une seule ligne, le code de sortie attendu. */
async function cas(intitule, contenu, codeAttendu, motifs) {
  const racine = await fauxDepot({ "src/module.ts": contenu }, motifs);
  const { code } = lancer(racine);
  verifier(intitule, code === codeAttendu, `code ${code}, attendu ${codeAttendu}`);
  return racine;
}

// ── Fichiers non suivis (T-011) ────────────────────────────────────────────
{
  // Un fichier neuf, PAS ENCORE `git add` : il doit être audité quand même —
  // c'est lui qu'on s'apprête à committer (constat du 2026-08-09).
  const racine = await fauxDepot({ "src/suivi.ts": 'const ok = "rien";' });
  await fsp.writeFile(path.join(racine, "src", "neuf.ts"), bout('fetch("htt', 'ps://forge.', 'interne-privee.fr");\n'), "utf8");
  const { code } = lancer(racine);
  verifier("un fichier non suivi est audité", code === 1, `code ${code}, attendu 1`);
}

// ── Chemins personnels ─────────────────────────────────────────────────────
await cas("un chemin personnel Linux est refusé", bout('const p = "/ho', 'me/verinique/dev";'), 1);
await cas("un chemin personnel Windows est refusé", bout('const p = "C:\\\\Us', 'ers\\\\Veronique\\\\App";'), 1);
await cas("un compte inventé passe", 'const p = "/home/utilisateur/dev";', 0);
await cas("un compte de service d\u2019intégration continue passe", 'const p = "C:\\\\Users\\\\runneradmin";', 0);

// ── Hôtes ──────────────────────────────────────────────────────────────────
await cas("un hôte inconnu est refusé", bout('fetch("htt', 'ps://forge.', 'interne-privee.fr/api");'), 1);
await cas("un hôte de la liste relue passe", 'fetch("https://github.com/x");', 0);
await cas("un domaine de documentation passe", 'fetch("https://cloud.example.net/dav");', 0);
await cas("localhost passe", 'fetch("http://localhost:11434/api");', 0);
await cas("un hôte SSH inconnu est refusé", bout('// gi', 't@forge.', 'interne-privee.fr:projet.git'), 1);
// Le remote du script de publication : même forme qu'une adresse pour la
// règle courriel, mais c'est un hôte SSH connu — il passe.
await cas("un remote SSH vers un hôte connu passe", '// git@github.com:duvamduvam/iaction.git', 0);

// ── Adresses ───────────────────────────────────────────────────────────────
await cas("une adresse nominative est refusée", bout('// contact : veronique.martin', '@societe-x.fr'), 1);
await cas("l\u2019adresse de co-signature passe", "// Co-Authored-By: X <noreply@anthropic.com>", 0);
// Faux positif relevé au premier passage réel, sur tauri.conf.json : sans la
// garde sur les extensions, « 128@2x.png » est vu comme une adresse.
await cas("un nom de fichier en @2x n\u2019est pas une adresse", '"icon": "icons/128@2x.png"', 0);

// ── Secrets ────────────────────────────────────────────────────────────────
await cas("un jeton est refusé", bout("TOKEN=sk-ant-oat01-", "kJ8s0Wn2xQ4mB7vL1pR6"), 1);
await cas("un gabarit de jeton passe", "TOKEN=sk-ant-oat01-EXEMPLE-A-REMPLACER", 0);

// ── IP ─────────────────────────────────────────────────────────────────────
await cas("une IP publique est refusée", bout('const h = "203.0.', '114.7";'), 1);
await cas("une IP privée passe", 'const h = "192.168.1.42";', 0);

// ── Exemption explicite ────────────────────────────────────────────────────
await cas(
  "le marqueur d\u2019exemption neutralise la ligne",
  bout('const p = "/ho', 'me/verinique/dev"; // audit-publication', ":ok"),
  0,
);

// ── Motifs littéraux locaux ────────────────────────────────────────────────
{
  const motifs = "# commentaire ignoré\nclient-confidentiel\n\n";
  await cas("un motif local interdit est refusé", "// projet client-confidentiel", 1, motifs);
  await cas("le même contenu passe sans fichier de motifs", "// projet client-confidentiel", 0);
  await cas("les commentaires du fichier de motifs ne sont pas des motifs", "// commentaire ignoré", 0, motifs);
}

// ── Le fichier de motifs ne doit jamais être publiable ─────────────────────
{
  const racine = await fauxDepot(
    { "src/module.ts": "const x = 1;" },
    "client-confidentiel\n",
    { motifsSuivis: true },
  );
  const { code, sortie } = lancer(racine);
  verifier("un .audit-motifs versionné fait échouer l\u2019audit", code === 1, `code ${code}`);
  verifier("et c\u2019est bien lui qui est désigné", sortie.includes(".audit-motifs"));
}

// ── Périmètre ──────────────────────────────────────────────────────────────
{
  // T-011 — contrat INVERSÉ le 2026-08-09 : un fichier non suivi est DANS le
  // périmètre (c'est lui qu'on s'apprête à committer). Seul un fichier
  // IGNORÉ par git reste dehors (.audit-motifs en dépend, vérifié plus haut).
  const racine = await fauxDepot({ "src/propre.ts": "const x = 1;" });
  await fsp.writeFile(path.join(racine, "src", "brouillon.ts"), bout('"/ho', 'me/verinique/x"\n'), "utf8");
  const { code } = lancer(racine);
  verifier("un fichier non suivi par git est audité (T-011)", code === 1, `code ${code}`);
}
{
  const racine = await fauxDepot({ "src/propre.ts": "const x = 1;" });
  await fsp.appendFile(path.join(racine, ".gitignore"), "src/ignore.ts\n", "utf8");
  await fsp.writeFile(path.join(racine, "src", "ignore.ts"), bout('"/ho', 'me/verinique/x"\n'), "utf8");
  const { code } = lancer(racine);
  verifier("un fichier IGNORÉ par git reste hors périmètre", code === 0, `code ${code}`);
}
{
  const racine = await fauxDepot({ "assets/logo.png": bout('"/ho', 'me/verinique/x"') });
  const { code } = lancer(racine);
  verifier("les fichiers binaires ne sont pas relus", code === 0, `code ${code}`);
}

// ── Lisibilité du rapport ──────────────────────────────────────────────────
{
  const lignes = Array.from({ length: 30 }, (_, i) => bout('const p', `${i} = "/ho`, 'me/verinique/d";')).join("\n");
  const racine = await fauxDepot({ "src/beaucoup.ts": lignes });
  const { code, sortie } = lancer(racine);
  verifier("un motif trop large échoue toujours", code === 1, `code ${code}`);
  verifier("le rapport annonce le total", sortie.includes("30 occurrence(s)"));
  verifier("le rapport est plafonné, pas déroulé", sortie.includes("et 22 autre(s)"));
  verifier(
    "la valeur trouvée est masquée, jamais recopiée en clair",
    !sortie.includes(bout("verini", "que")),
  );
}

console.log(`\naudit-publication : ${reussites} vérification(s) passée(s), ${echecs} en échec.`);
if (echecs > 0) process.exitCode = 1;
