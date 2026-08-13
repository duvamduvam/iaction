/*
 * Dépose l'empreinte des sources à côté du code qui vient d'être compilé.
 *
 * Lancé par `npm run build -w sidecar` (et par `build:verif`), APRÈS `tsc` :
 * il importe le module `peremption.js` du dossier de sortie visé et lui fait
 * écrire son propre témoin. Passer par le code compilé plutôt que de recopier
 * le calcul ici garantit qu'un seul hachage existe dans le dépôt — voir
 * l'en-tête de sidecar/src/peremption.ts.
 *
 * Usage : node scripts/empreinte.mjs <dossier-de-sortie>
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const racine = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sortie = path.resolve(racine, process.argv[2] ?? "dist");

const { ecrireEmpreinte } = await import(pathToFileURL(path.join(sortie, "peremption.js")).href);
const { empreinte, fichiers, chemin } = ecrireEmpreinte(sortie);

console.log(`empreinte ${empreinte.slice(0, 12)} · ${fichiers} sources → ${path.relative(racine, chemin)}`);
