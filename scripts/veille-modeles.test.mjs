/**
 * Tests de la veille des modèles de l'abonnement Claude (T-142, T-143).
 *
 * Aucun réseau ici : la comparaison de versions et l'extraction sur binaire
 * sont pures, testables sans toucher npm. Le cas qui compte est le dernier —
 * le VRAI dépôt : c'est lui qui aurait attrapé T-143, où la liste a vieilli
 * quatre jours sans que rien ne le dise.
 *
 * Lancement : node scripts/veille-modeles.test.mjs
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extraireIdsBinaire, lireIdsListe, nouveautes } from "./veille-modeles.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// ── nouveautes — le cas de l'énoncé ────────────────────────────────────────
{
  const liste = ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
  const binaire = ["claude-opus-5-5", "claude-opus-4-8", "claude-fable-5", "claude-sonnet-5"];
  verifier(
    "seul opus-5-5 dépasse la liste",
    JSON.stringify(nouveautes(binaire, liste)) === JSON.stringify(["claude-opus-5-5"]),
    JSON.stringify(nouveautes(binaire, liste)),
  );
}

// ── nouveautes — famille absente de la liste : ignorée, pas signalée ──────
{
  const liste = ["claude-opus-5"];
  const binaire = ["claude-haiku-4-5"];
  verifier("une famille absente de la liste est ignorée", nouveautes(binaire, liste).length === 0);
}

// ── nouveautes — rien de neuf rend un tableau vide ─────────────────────────
{
  const liste = ["claude-opus-5", "claude-sonnet-5"];
  const binaire = ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"];
  verifier("aucune nouveauté ne rend un tableau vide", nouveautes(binaire, liste).length === 0);
}

// ── extraireIdsBinaire — buffer synthétique, bruit inclus ──────────────────
{
  const texte = [
    "bruit avant claude-fable-5- suite du bruit",
    "encore claude-haiku-3-55 du bruit",
    "id daté claude-opus-4-20250514 à écarter",
    "claude-opus-5-5 un vrai id",
    "claude-sonnet-5 un autre vrai id",
  ].join("\n");
  const ids = extraireIdsBinaire(Buffer.from(texte, "latin1"));

  verifier("l'id tronqué n'est pas retenu", !ids.includes("claude-fable-5"));
  verifier("le faux mineur à deux chiffres n'est pas retenu", !ids.includes("claude-haiku-3-55"));
  verifier("l'id daté n'est pas retenu", !ids.some((id) => id.includes("20250514")));
  verifier("le vrai id avec mineur est retenu", ids.includes("claude-opus-5-5"));
  verifier("le vrai id sans mineur est retenu", ids.includes("claude-sonnet-5"));
  verifier("rien d'autre n'est inventé", ids.length === 2, JSON.stringify(ids));
}

// ── lireIdsListe — extraction simple par regex ─────────────────────────────
{
  const source = `
export const MODELES_ABONNEMENT_CLAUDE: ModeleAbonnement[] = [
  { id: "claude-opus-5", contexte: 1_000_000 },
  { id: "claude-haiku-4-5", contexte: 200_000 },
];
`;
  const ids = lireIdsListe(source);
  verifier("les deux ids sont lus", ids.length === 2, JSON.stringify(ids));
  verifier("dans l'ordre du source", ids[0] === "claude-opus-5" && ids[1] === "claude-haiku-4-5");
}

// ── le VRAI dépôt : la liste n'est jamais vide ──────────────────────────────
{
  const chemin = path.join(__dirname, "..", "ui", "src", "modelesAbonnementClaude.ts");
  const source = await fsp.readFile(chemin, "utf8");
  const ids = lireIdsListe(source);
  verifier("la liste du dépôt n'est pas vide", ids.length > 0, chemin);
  verifier("tous les ids commencent par claude-", ids.every((id) => id.startsWith("claude-")), JSON.stringify(ids));
}

console.log(`${reussites} réussite(s), ${echecs} échec(s)`);
if (echecs > 0) process.exitCode = 1;
