#!/usr/bin/env node
/**
 * Budget de démarrage — du lancement à la première image (T-029).
 *
 * ── Pourquoi ce script ──────────────────────────────────────────────────
 * Les quatre jalons existent depuis longtemps (`demarrage.rs`), mais les lire
 * demandait de dépouiller `coquille.jsonl` à la main, session par session.
 * Un budget qu'on ne peut pas lire d'une commande n'est pas mesuré : il est
 * mesurable, ce qui n'est pas pareil — et c'est ainsi que le ticket est resté
 * « en cours » plus d'un mois.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   node scripts/budget-demarrage.mjs                 les 5 derniers démarrages
 *   node scripts/budget-demarrage.mjs --mode empaquete  ceux de l'installeur
 *   node scripts/budget-demarrage.mjs --tous            tous, sans limite
 *
 * Le champ `mode` (T-029) sépare le développement de l'empaqueté : c'est LA
 * comparaison que le ticket attend, et elle était impossible tant que les deux
 * tombaient indistinctement dans le même fichier.
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Ordre du chemin de démarrage ; sert aussi à détecter un relevé incomplet. */
export const ETAPES = ["rust:setup", "rust:boucle-evenements", "ui:script", "ui:premier-rendu"];

/** Libellé de ce que CHAQUE segment clôt — sans quoi les chiffres ne disent rien. */
const CE_QUE_CLOT = {
  "avant main()": "ld.so, chargement du binaire — invisible d'un Instant, lu dans /proc",
  "rust:setup": "init Tauri/GTK jusqu'à setup()",
  "rust:boucle-evenements": "création de la fenêtre",
  "ui:script": "chargement + parse du JS de l'interface",
  "ui:premier-rendu": "premier dessin effectif de React",
};

export function cheminJournalCoquille(env = process.env, home = os.homedir()) {
  const base = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "net.duvam.iaction", "logs", "coquille.jsonl");
}

/**
 * Regroupe les jalons en DÉMARRAGES. Un `rust:setup` ouvre un démarrage : c'est
 * le premier jalon posé, et `demarrage.rs` garantit qu'un jalon ne s'écrit
 * qu'une fois par session. Les jalons orphelins (fichier tronqué par une
 * rotation, session tuée avant la première image) sont conservés et marqués
 * incomplets plutôt que jetés en silence.
 */
export function regrouperDemarrages(lignes) {
  const demarrages = [];
  for (const ligne of lignes) {
    let entree;
    try {
      entree = JSON.parse(ligne);
    } catch {
      continue;
    }
    if (entree?.msg !== "jalon de démarrage" || !entree.fields?.etape) continue;
    const f = entree.fields;
    if (f.etape === ETAPES[0] || demarrages.length === 0) {
      demarrages.push({ ts: entree.ts, mode: f.mode ?? "inconnu", avantMainMs: f.avantMainMs ?? null, jalons: {} });
    }
    const courant = demarrages[demarrages.length - 1];
    courant.jalons[f.etape] = { depuisMainMs: f.depuisMainMs, totalMs: f.totalMs, pageMs: f.pageMs ?? null };
    if (f.mode && courant.mode === "inconnu") courant.mode = f.mode;
  }
  return demarrages;
}

/** Segments d'un démarrage : la DURÉE PROPRE de chaque étape, pas le cumul. */
export function segmenter(demarrage) {
  const segments = [];
  if (demarrage.avantMainMs !== null) {
    segments.push({ etape: "avant main()", ms: demarrage.avantMainMs });
  }
  let precedent = 0;
  for (const etape of ETAPES) {
    const jalon = demarrage.jalons[etape];
    if (!jalon || typeof jalon.depuisMainMs !== "number") continue;
    segments.push({ etape, ms: jalon.depuisMainMs - precedent, pageMs: jalon.pageMs });
    precedent = jalon.depuisMainMs;
  }
  return segments;
}

export function estComplet(demarrage) {
  return ETAPES.every((e) => demarrage.jalons[e]);
}

function formater(demarrage) {
  const segments = segmenter(demarrage);
  const total = demarrage.jalons["ui:premier-rendu"]?.totalMs ?? null;
  const lignes = [
    `── ${demarrage.ts}  ·  mode : ${demarrage.mode}${estComplet(demarrage) ? "" : "  ⚠ relevé INCOMPLET"}`,
  ];
  for (const s of segments) {
    const page = typeof s.pageMs === "number" ? `  (horloge de la page : ${s.pageMs} ms)` : "";
    lignes.push(`   ${String(s.ms).padStart(6)} ms  ${s.etape.padEnd(24)}${page}`);
    const quoi = CE_QUE_CLOT[s.etape];
    if (quoi) lignes.push(`               ${" ".repeat(24)}${quoi}`);
  }
  if (total !== null) lignes.push(`   ${String(total).padStart(6)} ms  TOTAL jusqu'à la première image`);
  return lignes.join("\n");
}

async function principal() {
  const args = process.argv.slice(2);
  const tous = args.includes("--tous");
  const iMode = args.indexOf("--mode");
  const modeVoulu = iMode >= 0 ? args[iMode + 1] : null;

  const chemin = cheminJournalCoquille();
  let brut;
  try {
    brut = await fsp.readFile(chemin, "utf8");
  } catch {
    console.error(`Journal de la coquille introuvable : ${chemin}`);
    console.error("Lancer l'application au moins une fois — les jalons s'écrivent tout seuls.");
    process.exit(2);
  }

  let demarrages = regrouperDemarrages(brut.split("\n"));
  if (modeVoulu) demarrages = demarrages.filter((d) => d.mode === modeVoulu);
  if (demarrages.length === 0) {
    console.log(modeVoulu ? `Aucun démarrage en mode « ${modeVoulu} » dans le journal.` : "Aucun jalon de démarrage dans le journal.");
    if (modeVoulu === "empaquete") {
      console.log("Le marquage du mode date de la 0.6.0 : un démarrage antérieur s'affiche en « inconnu ».");
    }
    process.exit(0);
  }

  const retenus = tous ? demarrages : demarrages.slice(-5);
  console.log(`Budget de démarrage — ${retenus.length} démarrage(s) sur ${demarrages.length} relevé(s)\n`);
  for (const d of retenus) console.log(`${formater(d)}\n`);

  const complets = retenus.filter((d) => estComplet(d) && d.jalons["ui:premier-rendu"]?.totalMs);
  if (complets.length > 1) {
    const totaux = complets.map((d) => d.jalons["ui:premier-rendu"].totalMs).sort((a, b) => a - b);
    const median = totaux[Math.floor(totaux.length / 2)];
    console.log(`Médiane jusqu'à la première image : ${median} ms  (min ${totaux[0]}, max ${totaux[totaux.length - 1]})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await principal();
