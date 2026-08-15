#!/usr/bin/env node
/**
 * La table de routage par défaut : deux déclarations, une seule vérité.
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────
 * Les défauts du routeur sont écrits DEUX fois — dans le sidecar, qui route
 * réellement, et dans l'interface, qui les affiche et préremplit les réglages.
 * Le commentaire de l'UI dit « identique aux défauts codés en dur du sidecar »,
 * ce qui est un vœu, pas une garantie : rien ne le vérifiait.
 *
 * Le 2026-08-13, retirer `claude-opus-4-8` du sélecteur (T-047) a obligé à
 * corriger le palier « moyen » dans les deux fichiers, à la main. Une seule des
 * deux corrections aurait suffi à créer la pire des pannes : l'écran des
 * réglages annonce un modèle, le routeur en appelle un autre, et rien ne le
 * signale — même famille que T-016 (le sidecar annonçait une version fausse).
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   node scripts/routage-defauts.mjs      vérifie (code de sortie 1 si KO)
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const racine =
  process.env.IACTION_ROUTAGE_RACINE ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PORTEURS = [
  { fichier: "sidecar/src/router.ts", role: "celui qui route" },
  { fichier: "ui/src/routerAdmin.ts", role: "celui qui l'affiche" },
];

/**
 * Extrait `DEFAULT_ROUTING_TABLE` d'un fichier TypeScript, par lecture du
 * texte plutôt que par import : le module du sidecar tire tout un moteur
 * derrière lui, et l'UI ne s'importe pas hors d'un bundler. Une comparaison
 * de source suffit pour ce qu'on vérifie — et ne peut pas, elle, exécuter du
 * code au passage.
 */
export function lireTable(source) {
  const debut = source.indexOf("DEFAULT_ROUTING_TABLE");
  if (debut === -1) return null;
  const ouvrante = source.indexOf("{", debut);
  const fermante = source.indexOf("};", ouvrante);
  if (ouvrante === -1 || fermante === -1) return null;

  const table = {};
  const corps = source.slice(ouvrante + 1, fermante);
  const ligne = /(\w+)\s*:\s*\{\s*engine\s*:\s*"([^"]+)"\s*,\s*model\s*:\s*"([^"]+)"\s*\}/g;
  let trouve;
  while ((trouve = ligne.exec(corps)) !== null) {
    table[trouve[1]] = `${trouve[2]}/${trouve[3]}`;
  }
  return Object.keys(table).length > 0 ? table : null;
}

async function main() {
  const relevés = [];
  for (const porteur of PORTEURS) {
    const source = await fsp.readFile(path.join(racine, porteur.fichier), "utf8");
    const table = lireTable(source);
    if (!table) {
      console.error(
        `Table de routage introuvable dans ${porteur.fichier} — le fichier a changé de forme,\n` +
          "corriger le motif dans scripts/routage-defauts.mjs plutôt que de retirer le contrôle.",
      );
      process.exitCode = 1;
      return;
    }
    relevés.push({ ...porteur, table });
  }

  const [reference, ...autres] = relevés;
  const paliers = [...new Set(relevés.flatMap((r) => Object.keys(r.table)))].sort();
  const ecarts = [];
  for (const palier of paliers) {
    for (const autre of autres) {
      if (reference.table[palier] !== autre.table[palier]) {
        ecarts.push({ palier, a: reference, b: autre });
      }
    }
  }

  if (ecarts.length === 0) {
    const rendu = paliers.map((p) => `${p}→${reference.table[p]}`).join(", ");
    console.log(`Routage : les ${relevés.length} déclarations concordent (${rendu}).`);
    return;
  }

  console.error(`Table de routage : ${ecarts.length} écart(s) entre les déclarations.\n`);
  for (const { palier, a, b } of ecarts) {
    console.error(`  palier « ${palier} »`);
    console.error(`    ${a.fichier} (${a.role}) : ${a.table[palier] ?? "absent"}`);
    console.error(`    ${b.fichier} (${b.role}) : ${b.table[palier] ?? "absent"}`);
  }
  console.error(
    "\nLe sidecar fait foi : c'est lui qui route. L'interface doit dire la même chose,\n" +
      "sinon les réglages affichent un modèle et le routeur en appelle un autre.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
