#!/usr/bin/env node
/**
 * Cliquet de taille — empêche les fichiers dieux de revenir.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────
 * Le relevé du 2026-08-07 a trouvé 14 838 lignes dans quatre composants
 * d'interface, et 623 lignes de test pour les couvrir. Ce déséquilibre n'est
 * pas un accident de discipline : on ne peut pas tester unitairement ce qui
 * n'expose rien, donc un fichier qui grossit devient un fichier qu'on ne teste
 * plus, donc un fichier où les défauts s'installent. Les deux pannes vues par
 * l'utilisateur (jauge de contexte à zéro, plantage au premier démarrage)
 * venaient toutes les deux de ces quatre fichiers.
 *
 * Découper prend des semaines. Empêcher que ça recommence prend ce script.
 * Sans lui, on écope un bateau percé : chaque extraction est reperdue par la
 * fonctionnalité suivante, écrite là où il y a déjà tout le contexte.
 *
 * ── La règle ────────────────────────────────────────────────────────────
 * 1. Un fichier neuf ne peut pas dépasser la limite (800 lignes). S'il la
 *    dépasse, la vérification échoue : il faut le découper, ou assumer une
 *    dérogation explicite en la consignant dans le fichier de référence.
 * 2. Un fichier déjà en dérogation ne peut que RÉTRÉCIR. Son budget est sa
 *    taille du jour où il a été consigné ; le dépasser échoue.
 * 3. Le cliquet ne se resserre jamais tout seul : quand un fichier a maigri,
 *    `--maj` verrouille le gain (et le sort des dérogations s'il repasse sous
 *    la limite). C'est un geste volontaire, pas un effet de bord, pour qu'un
 *    budget ne se relâche jamais par inadvertance.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   node scripts/cliquet-taille.mjs          vérifie (code de sortie 1 si KO)
 *   node scripts/cliquet-taille.mjs --maj    verrouille les gains obtenus
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Racine du dépôt. La variable d'environnement n'existe que pour les tests :
 * un cliquet qu'on ne peut pas exercer sur un faux dépôt est un cliquet qu'on
 * ne peut pas prouver, et un garde-fou non prouvé finit par passer tout vert
 * sans que personne s'en aperçoive.
 */
const racine =
  process.env.IACTION_CLIQUET_RACINE ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fichierReference = path.join(racine, "scripts", "cliquet-taille.json");

/**
 * Où le cliquet regarde. On vise le code que NOUS écrivons : pas les
 * dépendances, pas les artefacts de compilation, pas le code généré — sur
 * lesquels « découper » n'a aucun sens.
 */
const ARBRES = ["ui/src", "sidecar/src", "sidecar/test", "src-tauri/src", "scripts"];
const EXTENSIONS = new Set([".ts", ".tsx", ".rs", ".mjs", ".js", ".sh", ".py"]);
const IGNORES = new Set(["node_modules", "dist", "target", "gen", "build", ".git"]);

/** Au-delà, un fichier ne se lit plus d'une traite et ne se teste plus par morceaux. */
const LIMITE = 800;

async function listerFichiers(dossier) {
  let entrees;
  try {
    entrees = await fsp.readdir(dossier, { withFileTypes: true });
  } catch (err) {
    // Un arbre déclaré mais absent n'est pas une erreur : le dépôt peut être
    // partiellement extrait (archive de publication, worktree). On l'ignore.
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const trouves = [];
  for (const entree of entrees) {
    if (IGNORES.has(entree.name)) continue;
    const complet = path.join(dossier, entree.name);
    if (entree.isDirectory()) {
      trouves.push(...(await listerFichiers(complet)));
    } else if (entree.isFile() && EXTENSIONS.has(path.extname(entree.name))) {
      trouves.push(complet);
    }
  }
  return trouves;
}

/**
 * Nombre de lignes, au sens le plus bête possible : celui que donne `wc -l`.
 *
 * Volontairement PAS de comptage « lignes utiles » excluant commentaires et
 * blancs. Une mesure qu'on peut discuter est une mesure qu'on discutera le
 * jour où elle dérange ; celle-ci se vérifie d'un coup d'œil et ne se négocie
 * pas. Le prix à payer est que documenter un fichier consomme du budget — ce
 * qui est le bon signal : un fichier qui a besoin de 200 lignes d'explication
 * est un fichier à découper.
 */
async function compterLignes(fichier) {
  const contenu = await fsp.readFile(fichier, "utf8");
  if (contenu === "") return 0;
  const lignes = contenu.split("\n");
  // Un fichier bien formé finit par un saut de ligne : le dernier morceau est
  // vide et ne compte pas, exactement comme le fait `wc -l`.
  if (lignes[lignes.length - 1] === "") lignes.pop();
  return lignes.length;
}

async function lireReference() {
  try {
    const brut = await fsp.readFile(fichierReference, "utf8");
    const parse = JSON.parse(brut);
    return {
      limite: typeof parse.limite === "number" ? parse.limite : LIMITE,
      derogations: parse.derogations && typeof parse.derogations === "object" ? parse.derogations : {},
    };
  } catch (err) {
    if (err.code === "ENOENT") return { limite: LIMITE, derogations: {} };
    throw err;
  }
}

async function ecrireReference(reference) {
  const ordonnees = Object.keys(reference.derogations)
    .sort((a, b) => reference.derogations[b] - reference.derogations[a])
    .reduce((acc, cle) => ({ ...acc, [cle]: reference.derogations[cle] }), {});
  const contenu = `${JSON.stringify({ limite: reference.limite, derogations: ordonnees }, null, 2)}\n`;
  await fsp.writeFile(fichierReference, contenu, "utf8");
}

async function mesurer() {
  const mesures = new Map();
  for (const arbre of ARBRES) {
    for (const fichier of await listerFichiers(path.join(racine, arbre))) {
      const relatif = path.relative(racine, fichier).split(path.sep).join("/");
      mesures.set(relatif, await compterLignes(fichier));
    }
  }
  return mesures;
}

function verifier(mesures, reference) {
  const echecs = [];
  const gains = [];

  for (const [fichier, lignes] of mesures) {
    const budget = reference.derogations[fichier];

    if (budget === undefined) {
      if (lignes > reference.limite) {
        echecs.push({
          fichier,
          lignes,
          plafond: reference.limite,
          motif: `nouveau fichier au-dessus de la limite de ${reference.limite} lignes`,
        });
      }
      continue;
    }

    if (lignes > budget) {
      echecs.push({
        fichier,
        lignes,
        plafond: budget,
        motif: `croissance d'un fichier sous dérogation (+${lignes - budget})`,
      });
    } else if (lignes < budget) {
      gains.push({ fichier, lignes, budget });
    }
  }

  // Une dérogation dont le fichier a disparu (renommé, supprimé) n'a plus de
  // sens : la signaler évite que la référence se transforme en cimetière.
  const orphelines = Object.keys(reference.derogations).filter((f) => !mesures.has(f));

  return { echecs, gains, orphelines };
}

function appliquerGains(reference, gains, orphelines) {
  const majses = { ...reference.derogations };
  for (const gain of gains) {
    if (gain.lignes <= reference.limite) delete majses[gain.fichier];
    else majses[gain.fichier] = gain.lignes;
  }
  for (const orpheline of orphelines) delete majses[orpheline];
  return { ...reference, derogations: majses };
}

async function resserrer(reference, gains, orphelines) {
  await ecrireReference(appliquerGains(reference, gains, orphelines));
  const verrouilles = gains.length + orphelines.length;
  console.log(
    verrouilles === 0
      ? "Cliquet : aucun gain à verrouiller, la référence est déjà à jour."
      : `Cliquet : ${verrouilles} budget(s) resserré(s).`,
  );
  for (const gain of gains) {
    const sortie = gain.lignes <= reference.limite ? " — sort des dérogations" : "";
    console.log(`  ${gain.fichier} : ${gain.budget} → ${gain.lignes}${sortie}`);
  }
  for (const orpheline of orphelines) console.log(`  ${orpheline} : disparu, dérogation retirée`);
}

function rapporterSucces(mesures, reference, gains, orphelines) {
  const derogations = Object.keys(reference.derogations).length;
  console.log(
    `Cliquet : ${mesures.size - derogations} fichier(s) sous la limite de ${reference.limite} ` +
      `lignes, ${derogations} en dérogation, aucun dépassement.`,
  );
  if (gains.length > 0) {
    console.log(`  ${gains.length} fichier(s) ont maigri — « npm run cliquet:maj » pour verrouiller le gain :`);
    for (const gain of gains) console.log(`    ${gain.fichier} : ${gain.budget} → ${gain.lignes}`);
  }
  if (orphelines.length > 0) {
    console.log(`  ${orphelines.length} dérogation(s) sans fichier — « npm run cliquet:maj » pour les retirer.`);
  }
}

function rapporterEchecs(echecs) {
  console.error(`Cliquet de taille : ${echecs.length} dépassement(s).\n`);
  for (const echec of echecs) {
    console.error(`  ${echec.fichier}`);
    console.error(`    ${echec.lignes} lignes, plafond ${echec.plafond} — ${echec.motif}`);
  }
  console.error(
    "\nDécouper le fichier est la réponse attendue. Si la taille est vraiment\n" +
      "justifiée, consigner la dérogation dans scripts/cliquet-taille.json —\n" +
      "explicitement, pour que le choix se voie en revue.",
  );
}

async function main() {
  const reference = await lireReference();
  const mesures = await mesurer();
  const { echecs, gains, orphelines } = verifier(mesures, reference);

  if (process.argv.includes("--maj")) {
    await resserrer(reference, gains, orphelines);
    // Resserrer ne doit jamais masquer un dépassement : on retombe sur le
    // rapport d'échec, et donc sur le code de sortie 1.
    if (echecs.length === 0) return;
  }

  if (echecs.length === 0) {
    rapporterSucces(mesures, reference, gains, orphelines);
    return;
  }

  rapporterEchecs(echecs);
  process.exitCode = 1;
}

await main();
