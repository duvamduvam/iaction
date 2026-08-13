/*
 * Le code compilé dans <dossier-de-sortie> correspond-il aux sources ?
 *
 * Code de sortie 0 : à jour, la compilation peut être sautée. 1 : périmé,
 * absent, ou impossible à vérifier — on recompile. Le doute fait toujours
 * recompiler : sauter un `tsc` à tort ferait tourner un sidecar périmé, la
 * panne exacte que T-020 a coûté trois jours à comprendre.
 *
 * Aucun calcul ici : c'est `inspecterPeremption` (sidecar/src/peremption.ts),
 * déjà compilé dans le dossier visé, qui compare — la MÊME empreinte que
 * celle dont le sidecar se sert au démarrage pour dire s'il est périmé. Une
 * seconde implémentation du hachage finirait par diverger de la première, et
 * deux garde-fous qui ne sont pas d'accord ne gardent plus rien.
 *
 * Usage : node scripts/a-jour.mjs <dossier-de-sortie>
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sortie = path.resolve(racine, process.argv[2] ?? "dist");

try {
  const { inspecterPeremption } = await import(pathToFileURL(path.join(sortie, "peremption.js")).href);
  const etat = inspecterPeremption(sortie);
  if (etat.statut === "a-jour") {
    console.log(`${path.relative(racine, sortie)} à jour (empreinte ${etat.actuelle.slice(0, 12)})`);
    process.exit(0);
  }
  console.log(`${path.relative(racine, sortie)} à recompiler (${etat.statut})`);
  process.exit(1);
} catch {
  // Dossier absent, compilé sans témoin, module illisible : autant de raisons
  // de recompiler, aucune de faire confiance.
  console.log(`${path.relative(racine, sortie)} à recompiler (vérification impossible)`);
  process.exit(1);
}
