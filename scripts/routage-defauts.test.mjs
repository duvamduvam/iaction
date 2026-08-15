/**
 * Tests de la garde du routage par défaut.
 *
 * Le cas qui compte est le dernier : le VRAI dépôt. C'est lui qui aurait
 * attrapé la divergence que T-047 a évitée de justesse — un palier corrigé
 * dans le sidecar et pas dans l'interface.
 *
 * Lancement : node scripts/routage-defauts.test.mjs
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lireTable, PORTEURS } from "./routage-defauts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "routage-defauts.mjs");

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

const SOURCE = `
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  trivial: { engine: "claude", model: "claude-haiku-4-5" },
  moyen: { engine: "claude", model: "claude-opus-5" },
};
`;

{
  const table = lireTable(SOURCE);
  verifier("la table est extraite du source", table !== null);
  verifier("le palier trivial est lu", table?.trivial === "claude/claude-haiku-4-5", JSON.stringify(table));
  verifier("le palier moyen est lu", table?.moyen === "claude/claude-opus-5");
  verifier("rien d'autre n'est inventé", Object.keys(table ?? {}).length === 2);
}

{
  verifier("un fichier sans table rend null", lireTable("const x = 1;") === null);
  verifier(
    "une table vide rend null plutôt qu'un faux succès",
    lireTable("export const DEFAULT_ROUTING_TABLE: RoutingTable = {\n};\n") === null,
  );
}

{
  verifier("les deux porteurs sont déclarés", PORTEURS.length === 2, JSON.stringify(PORTEURS));
  verifier(
    "le sidecar est la référence, donc en premier",
    PORTEURS[0].fichier.startsWith("sidecar/"),
    PORTEURS[0].fichier,
  );
}

{
  const passe = spawnSync(process.execPath, [script], { encoding: "utf8" });
  verifier(
    "les déclarations du dépôt concordent",
    passe.status === 0,
    `${passe.stdout}${passe.stderr}`.trim().split("\n").slice(0, 6).join(" ¦ "),
  );
}

console.log(`${reussites} réussite(s), ${echecs} échec(s)`);
if (echecs > 0) process.exitCode = 1;
