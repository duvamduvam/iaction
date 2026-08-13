/*
 * Le CLI Claude détendu au premier lancement (T-038).
 *
 * Ce chemin de code ne s'active QUE dans le paquet Linux : ni sur le poste de
 * développement, ni sous Windows. C'est exactement le genre de code qu'on
 * n'exécute jamais avant l'utilisateur — donc celui qu'il faut tester le plus
 * sérieusement. Les cas couverts sont ceux qui font mal en vrai : l'extraction
 * qui recommence à chaque lancement (l'application démarrerait 265 Mo plus
 * lentement, à chaque fois), et l'extraction interrompue qu'on prendrait pour
 * un succès (l'application lancerait un binaire tronqué).
 *
 * Lancement isolé : node sidecar/test/cliClaude.test.js
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { assert, lancer, moduleCompile } from "./harness.mjs";

const { cheminCliDetendu, preparerCliClaude, tailleDetendue, trouverCliEmballe } = await import(
  moduleCompile("cliClaude.js")
);

/** Contenu bidon : un ELF de 265 Mo n'apporterait rien de plus au test. */
const CONTENU = Buffer.from("#!/bin/sh\necho faux-cli-claude\n", "utf8");

/**
 * Faux paquet : la disposition exacte que `preparer-bundle.sh` produit sous
 * Linux — le CLI compressé, à côté du reste du SDK.
 */
async function fauxPaquet({ emballe = true } = {}) {
  const racine = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-cli-"));
  const dir = path.join(racine, "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64");
  await fsp.mkdir(dir, { recursive: true });
  if (emballe) {
    await fsp.writeFile(path.join(dir, "claude.gz"), zlib.gzipSync(CONTENU, { level: 1 }));
  } else {
    await fsp.writeFile(path.join(dir, "claude"), CONTENU);
    await fsp.chmod(path.join(dir, "claude"), 0o755);
  }
  const donnees = await fsp.mkdtemp(path.join(os.tmpdir(), "iaction-test-cli-data-"));
  return { racine, dir, env: { platform: "linux", env: { XDG_DATA_HOME: donnees }, home: donnees } };
}

await lancer("un paquet sans CLI emballé ne déclenche rien", async () => {
  const { racine, env } = await fauxPaquet({ emballe: false });
  assert(trouverCliEmballe(racine) === null, "aucun .gz ne doit être trouvé");
  assert(
    preparerCliClaude(racine, env) === null,
    "sans paquet compressé, le SDK doit garder la main (null attendu)",
  );
});

await lancer("le CLI emballé est détendu, exécutable et fidèle", async () => {
  const { racine, env } = await fauxPaquet();
  const resultat = preparerCliClaude(racine, env);
  assert(resultat !== null, "un paquet compressé doit produire un chemin");
  assert(resultat.detendu === true, "le premier lancement fait le travail");

  const pose = await fsp.readFile(resultat.chemin);
  assert(pose.equals(CONTENU), "le binaire détendu doit être identique à l'original");

  // Le bit d'exécution ne se vérifie que là où il existe. NTFS n'en a pas :
  // `chmod` y bascule le seul drapeau « lecture seule », et Node relit 666 —
  // le test échouerait en accusant le code d'un défaut du système. La bascule
  // n'est pas décorative pour autant : sans elle, l'AppImage lancerait un
  // fichier non exécutable. Elle est donc vérifiée là où elle a un sens, et le
  // chemin de code entier ne sert de toute façon qu'au paquet Linux.
  if (process.platform !== "win32") {
    const mode = (await fsp.stat(resultat.chemin)).mode & 0o777;
    assert((mode & 0o111) !== 0, `le binaire doit être exécutable, vu ${mode.toString(8)}`);
  }
});

await lancer("le deuxième lancement ne recommence pas l'extraction", async () => {
  const { racine, env } = await fauxPaquet();
  const premier = preparerCliClaude(racine, env);
  const second = preparerCliClaude(racine, env);
  assert(second !== null && second.chemin === premier.chemin, "le chemin doit être stable");
  assert(second.detendu === false, "une extraction déjà faite ne doit pas être refaite");
});

await lancer("une extraction interrompue est refaite, jamais crue sur parole", async () => {
  const { racine, env } = await fauxPaquet();
  const cible = preparerCliClaude(racine, env).chemin;
  // Le symptôme d'une coupure : le fichier est là, mais tronqué.
  await fsp.writeFile(cible, CONTENU.subarray(0, 5));
  const reprise = preparerCliClaude(racine, env);
  assert(reprise.detendu === true, "un binaire tronqué doit être ré-extrait");
  assert((await fsp.readFile(cible)).equals(CONTENU), "et le résultat doit être complet");
});

await lancer("la taille attendue est lue dans le pied du gzip", async () => {
  const { dir } = await fauxPaquet();
  assert(
    tailleDetendue(path.join(dir, "claude.gz")) === CONTENU.length,
    "ISIZE doit donner la taille détendue exacte",
  );
});

await lancer("deux paquets différents ne se marchent pas dessus", async () => {
  const a = await fauxPaquet();
  const b = await fauxPaquet();
  // Un contenu différent = une empreinte différente = un fichier différent.
  await fsp.writeFile(path.join(b.dir, "claude.gz"), zlib.gzipSync(Buffer.concat([CONTENU, CONTENU])));
  const cheminA = cheminCliDetendu(path.join(a.dir, "claude.gz"), a.env);
  const cheminB = cheminCliDetendu(path.join(b.dir, "claude.gz"), a.env);
  assert(cheminA !== cheminB, "deux versions du CLI doivent viser deux fichiers distincts");
});

await lancer("un paquet illisible n'empêche pas le sidecar de démarrer", async () => {
  const { racine, dir, env } = await fauxPaquet();
  await fsp.writeFile(path.join(dir, "claude.gz"), "ceci n'est pas du gzip");
  assert(
    preparerCliClaude(racine, env) === null,
    "l'échec doit rendre la main au SDK (null), pas lever une exception",
  );
});
