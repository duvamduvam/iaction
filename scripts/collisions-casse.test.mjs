/**
 * Tests du détecteur de collisions de casse.
 *
 * Le cas qui compte est le dernier : le VRAI dépôt. C'est lui qui aurait
 * attrapé T-039 — `ModelPicker.tsx` face à `modelPicker.ts` — avant qu'un
 * runner Windows ne le fasse, c'est-à-dire avant la livraison.
 *
 * Lancement : node scripts/collisions-casse.test.mjs
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { trouverCollisions } from "./collisions-casse.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, "collisions-casse.mjs");

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

// ── Règle 2 : la collision de T-039 ────────────────────────────────────
{
  const collisions = trouverCollisions(["ui/src/ModelPicker.tsx", "ui/src/modelPicker.ts"]);
  verifier("le cas T-039 est détecté", collisions.length === 1, JSON.stringify(collisions));
  verifier("il est classé comme collision de module", collisions[0]?.regle === "module");
  verifier(
    "les deux fichiers sont nommés",
    collisions[0]?.fichiers.join(",") === "ui/src/ModelPicker.tsx,ui/src/modelPicker.ts",
    JSON.stringify(collisions[0]?.fichiers),
  );
}

// ── Règle 1 : deux chemins identiques à la casse près ──────────────────
{
  const collisions = trouverCollisions(["docs/Plan.md", "docs/plan.md"]);
  verifier("deux chemins à la casse près sont détectés", collisions.length === 1);
  verifier("classés comme collision de chemin", collisions[0]?.regle === "chemin");
}

// ── Ce qui ne DOIT pas alerter ─────────────────────────────────────────
{
  verifier(
    "le renommage de T-039 est accepté",
    trouverCollisions(["ui/src/ModelPicker.tsx", "ui/src/modelPickerCalc.ts"]).length === 0,
  );
  verifier(
    "un module et son test cohabitent",
    trouverCollisions(["ui/src/modelPickerCalc.ts", "ui/src/modelPickerCalc.test.ts"]).length === 0,
  );
  verifier(
    "une feuille de style ne heurte pas son composant",
    trouverCollisions(["ui/src/App.tsx", "ui/src/app.css"]).length === 0,
  );
  verifier(
    "deux dossiers différents ne se heurtent pas",
    trouverCollisions(["ui/src/Page.tsx", "sidecar/src/page.ts"]).length === 0,
  );
  verifier("un dépôt vide passe", trouverCollisions([]).length === 0);
}

// ── Le vrai dépôt ──────────────────────────────────────────────────────
{
  const passe = spawnSync(process.execPath, [script], { encoding: "utf8" });
  verifier(
    "le dépôt réel est exempt de collisions",
    passe.status === 0,
    `${passe.stdout}${passe.stderr}`.trim().split("\n").slice(0, 6).join(" ¦ "),
  );
}

console.log(`${reussites} réussite(s), ${echecs} échec(s)`);
if (echecs > 0) process.exitCode = 1;
