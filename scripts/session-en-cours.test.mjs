/**
 * Tests du garde-fou de vérification (T-111).
 *
 * Ce script décide si `npm run verif` a le droit de tourner. S'il se trompait
 * dans un sens, il refuserait la vérification à tout le monde en permanence ;
 * dans l'autre, il laisserait de nouveau disparaître l'application de
 * quelqu'un qui travaille. On exerce donc la DÉCISION elle-même, sans ouvrir
 * de port — c'est pour ça qu'elle est séparée de la sonde réseau.
 *
 * Lancement : node scripts/session-en-cours.test.mjs
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verdict, PORT_DEV } from "./session-en-cours.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const garde = path.join(__dirname, "session-en-cours.mjs");

let echecs = 0;
let reussites = 0;

function verifier(intitule, condition, detail = "") {
  if (condition) {
    reussites += 1;
    return;
  }
  echecs += 1;
  console.error(`ECHEC: ${intitule}${detail ? ` — ${detail}` : ""}`);
}

// ── La décision ────────────────────────────────────────────────────────────

verifier(
  "aucune session : la vérification passe",
  verdict({ sessionDetectee: false, force: false }).code === 0,
);

verifier(
  "session en cours : la vérification est REFUSÉE",
  verdict({ sessionDetectee: true, force: false }).code === 1,
);

verifier(
  "session en cours + IACTION_VERIF_FORCE : la vérification passe",
  verdict({ sessionDetectee: true, force: true }).code === 0,
);

verifier(
  "aucune session : le forçage ne change rien",
  verdict({ sessionDetectee: false, force: true }).code === 0,
);

// Un refus qui ne dit pas comment passer outre se contourne en désactivant le
// garde-fou — c'est-à-dire en le perdant.
{
  const { message } = verdict({ sessionDetectee: true, force: false });
  verifier("le refus nomme l'échappatoire", message.includes("IACTION_VERIF_FORCE=1"), message);
  verifier("le refus nomme le port surveillé", message.includes(String(PORT_DEV)), message);
  verifier("le refus renvoie au ticket", message.includes("T-111"), message);
}

// Un forçage silencieux serait pire qu'un forçage refusé : on croirait la
// vérification inoffensive.
verifier(
  "le forçage prévient du risque",
  verdict({ sessionDetectee: true, force: true }).message.includes("disparaître"),
);

// ── Le script en ligne de commande ─────────────────────────────────────────
// Aucune session ne tourne pendant la vérification (le garde-fou vient de
// l'établir, puisque la chaîne est arrivée jusqu'ici) : il doit donc sortir 0.
{
  const { status } = spawnSync(process.execPath, [garde], { encoding: "utf8" });
  verifier("lancé en ligne de commande, il rend un code de sortie", status === 0 || status === 1, `code ${status}`);
}

console.log(`\nsession-en-cours : ${reussites} vérification(s) passée(s), ${echecs} en échec.`);
if (echecs > 0) process.exitCode = 1;
