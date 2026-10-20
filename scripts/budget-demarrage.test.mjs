/**
 * Tests du lecteur de budget de démarrage (T-029).
 *
 * On exerce la DÉCOUPE, pas le fichier du poste : les jalons cumulent depuis
 * `main()`, et l'erreur naturelle est de présenter ce cumul comme la durée de
 * chaque étape. Les fixtures ci-dessous sont des lignes réelles de
 * `coquille.jsonl`, réduites aux champs qui comptent.
 *
 * Lancement : node scripts/budget-demarrage.test.mjs
 */

import { ETAPES, estComplet, regrouperDemarrages, segmenter } from "./budget-demarrage.mjs";

let reussites = 0;
let echecs = 0;
function verifier(quoi, condition, detail = "") {
  if (condition) {
    reussites += 1;
  } else {
    echecs += 1;
    console.error(`ECHEC: ${quoi}${detail ? ` — ${detail}` : ""}`);
  }
}

const jalon = (etape, depuisMainMs, totalMs, mode, pageMs = null, avantMainMs = 8820) =>
  JSON.stringify({
    msg: "jalon de démarrage",
    ts: "2026-09-19T09:45:47.676Z",
    fields: { etape, avantMainMs, depuisMainMs, totalMs, pageMs, mode },
  });

// ── Un démarrage complet se regroupe et se découpe ────────────────────────
{
  const lignes = [
    jalon("rust:setup", 293, 9113, "empaquete"),
    jalon("rust:boucle-evenements", 294, 9114, "empaquete"),
    jalon("ui:script", 620, 9440, "empaquete", 202),
    jalon("ui:premier-rendu", 1503, 10323, "empaquete", 1084),
  ];
  const [d] = regrouperDemarrages(lignes);
  verifier("un démarrage est reconstitué", d !== undefined);
  verifier("le mode est retenu", d.mode === "empaquete", d.mode);
  verifier("le relevé est complet", estComplet(d));

  const segments = segmenter(d);
  const par = Object.fromEntries(segments.map((s) => [s.etape, s.ms]));
  // Le point de tout l'exercice : `depuisMainMs` CUMULE. Présenter 1503 ms
  // comme la durée du premier rendu serait faux de 620 ms.
  verifier("avant main() est repris tel quel", par["avant main()"] === 8820, String(par["avant main()"]));
  verifier("rust:setup = son cumul (premier segment)", par["rust:setup"] === 293, String(par["rust:setup"]));
  verifier("boucle-evenements = 294 − 293", par["rust:boucle-evenements"] === 1, String(par["rust:boucle-evenements"]));
  verifier("ui:script = 620 − 294", par["ui:script"] === 326, String(par["ui:script"]));
  verifier("ui:premier-rendu = 1503 − 620", par["ui:premier-rendu"] === 883, String(par["ui:premier-rendu"]));
  verifier("l'horloge de la page est conservée", segments.find((s) => s.etape === "ui:script").pageMs === 202);
}

// ── Deux démarrages successifs ne se mélangent pas ────────────────────────
{
  const lignes = [
    jalon("rust:setup", 293, 9113, "developpement"),
    jalon("ui:premier-rendu", 1503, 10323, "developpement", 1084),
    jalon("rust:setup", 300, 500, "empaquete"),
    jalon("ui:premier-rendu", 900, 1100, "empaquete", 700),
  ];
  const d = regrouperDemarrages(lignes);
  verifier("un `rust:setup` ouvre un nouveau démarrage", d.length === 2, `${d.length} démarrage(s)`);
  verifier("les modes ne se contaminent pas", d[0].mode === "developpement" && d[1].mode === "empaquete");
}

// ── Un relevé tronqué est GARDÉ, et marqué ────────────────────────────────
{
  // Rotation du journal, session tuée avant la première image : le jeter en
  // silence ferait disparaître précisément les démarrages anormaux, ceux qui
  // intéressent le plus.
  const [d] = regrouperDemarrages([jalon("rust:setup", 293, 9113, "empaquete")]);
  verifier("un relevé tronqué n'est pas jeté", d !== undefined);
  verifier("il est marqué incomplet", !estComplet(d));
}

// ── Bruit et jalons d'avant le marquage du mode ───────────────────────────
{
  const lignes = [
    "pas du JSON",
    JSON.stringify({ msg: "autre chose", fields: { etape: "rust:setup" } }),
    JSON.stringify({ msg: "jalon de démarrage", ts: "t", fields: { etape: "rust:setup", depuisMainMs: 10, totalMs: 10 } }),
  ];
  const d = regrouperDemarrages(lignes);
  verifier("les lignes illisibles et hors sujet sont ignorées", d.length === 1, `${d.length}`);
  verifier("un jalon d'avant la 0.6.0 vaut mode « inconnu »", d[0].mode === "inconnu", d[0].mode);
  verifier("avantMainMs absent ⇒ pas de segment inventé", !segmenter(d[0]).some((s) => s.etape === "avant main()"));
}

// ── L'ordre des étapes est celui du chemin de démarrage ───────────────────
verifier(
  "les quatre étapes sont dans l'ordre du démarrage",
  ETAPES.join(",") === "rust:setup,rust:boucle-evenements,ui:script,ui:premier-rendu",
  ETAPES.join(","),
);

console.log(`\nbudget-demarrage : ${reussites} vérification(s) passée(s), ${echecs} en échec.`);
if (echecs > 0) process.exitCode = 1;
