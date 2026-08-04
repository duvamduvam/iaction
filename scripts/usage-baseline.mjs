#!/usr/bin/env node
/**
 * B0 — Baseline de routage LLM (Lot 14, voir docs/etude-routage-llm.md §7).
 *
 * Lit le journal d'usage historisé par le sidecar
 * (`${XDG_CONFIG_HOME:-~/.config}/net.duvam.iaction/usage/`) et imprime la
 * répartition ACTUELLE des tours et des tokens entre les trois catégories de
 * coût (abonnement Claude / local / payant), le mix intra-abonnement par
 * modèle, et la saturation des fenêtres d'abonnement. Aucune dépendance,
 * lecture seule, Node ≥ 22.
 *
 * Usage :
 *   node scripts/usage-baseline.mjs [--days=14] [--local=ollama,lmstudio]
 *
 * --days   fenêtre d'analyse en jours (défaut 14 ; 0 = tout l'historique).
 * --local  ids de fournisseurs à compter « local / 0 € » (défaut : tout
 *          providerId contenant ollama, local ou lmstudio).
 */

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? ""] : [a, ""];
  }),
);

const DAYS = Number.isFinite(Number(args.days)) && args.days !== undefined ? Number(args.days) : 14;
const LOCAL_IDS = (args.local ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);

function isLocalProvider(providerId) {
  if (!providerId) return false;
  const id = providerId.toLowerCase();
  if (LOCAL_IDS.length > 0) return LOCAL_IDS.includes(id);
  return id.includes("ollama") || id.includes("local") || id.includes("lmstudio");
}

// ---------------------------------------------------------------------------
// Lecture tolérante des JSONL (même convention que usageStats.ts)
// ---------------------------------------------------------------------------

function usageRoot() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "net.duvam.iaction", "usage");
}

async function readJsonl(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object") out.push(obj);
    } catch {
      // ligne illisible : ignorée
    }
  }
  return out;
}

/** Fichier + sa rotation `.1`, triés par ts croissant. */
async function readWithRotation(filePath) {
  const rows = [...(await readJsonl(`${filePath}.1`)), ...(await readJsonl(filePath))];
  return rows.filter((r) => typeof r.ts === "string");
}

// ---------------------------------------------------------------------------
// Agrégation
// ---------------------------------------------------------------------------

const root = usageRoot();
const events = await readWithRotation(path.join(root, "events.jsonl"));
const windows = await readWithRotation(path.join(root, "claude-windows.jsonl"));

const cutoff = DAYS > 0 ? Date.now() - DAYS * 24 * 3600 * 1000 : -Infinity;
const inWindow = (r) => Date.parse(r.ts) >= cutoff;

const evs = events.filter(inWindow);
const wins = windows.filter(inWindow);

if (evs.length === 0) {
  console.log(`Aucun événement d'usage sur la période (--days=${DAYS}). Rien à analyser.`);
  process.exit(0);
}

/** abo | local | payant */
function category(e) {
  if (e.engine === "claude") return "abo";
  return isLocalProvider(e.providerId) ? "local" : "payant";
}

function bucket() {
  return { tours: 0, in: 0, out: 0, erreurs: 0 };
}
function add(b, e) {
  b.tours += 1;
  b.in += typeof e.promptTokens === "number" ? e.promptTokens : 0;
  b.out += typeof e.completionTokens === "number" ? e.completionTokens : 0;
  if (e.status === "error") b.erreurs += 1;
}

const byCat = { abo: bucket(), local: bucket(), payant: bucket() };
const byModelAbo = new Map();
const byProviderModel = new Map();
const bySource = new Map();

for (const e of evs) {
  const cat = category(e);
  add(byCat[cat], e);

  if (cat === "abo") {
    const key = e.model ?? "(inconnu)";
    if (!byModelAbo.has(key)) byModelAbo.set(key, bucket());
    add(byModelAbo.get(key), e);
  }

  const pmKey = `${cat} · ${e.providerId ?? "abonnement"} · ${e.model ?? "(inconnu)"}`;
  if (!byProviderModel.has(pmKey)) byProviderModel.set(pmKey, bucket());
  add(byProviderModel.get(pmKey), e);

  const src = e.source ?? (e.orchRunId ? "orchestration" : "(sans source)");
  if (!bySource.has(src)) bySource.set(src, bucket());
  add(bySource.get(src), e);
}

// ---------------------------------------------------------------------------
// Impression
// ---------------------------------------------------------------------------

const fmt = new Intl.NumberFormat("fr-FR");
const pct = (n, d) => (d > 0 ? `${Math.round((n / d) * 100)} %` : "—");
const pad = (s, w) => String(s).padEnd(w);
const padN = (s, w) => String(s).padStart(w);

const total = evs.length;
const totalOut = byCat.abo.out + byCat.local.out + byCat.payant.out;
const first = evs[0].ts.slice(0, 10);
const last = evs[evs.length - 1].ts.slice(0, 10);

console.log(`# Baseline routage LLM (B0) — ${first} → ${last} (--days=${DAYS})`);
console.log(`${fmt.format(total)} tours analysés\n`);

console.log("## Répartition par catégorie de coût");
console.log(pad("catégorie", 10) + padN("tours", 8) + padN("% tours", 9) + padN("tokens in", 12) + padN("tokens out", 12) + padN("% out", 8) + padN("erreurs", 9));
for (const [cat, b] of Object.entries(byCat)) {
  console.log(
    pad(cat, 10) + padN(fmt.format(b.tours), 8) + padN(pct(b.tours, total), 9) +
    padN(fmt.format(b.in), 12) + padN(fmt.format(b.out), 12) + padN(pct(b.out, totalOut), 8) +
    padN(b.erreurs, 9),
  );
}
const coutNul = byCat.abo.tours + byCat.local.tours;
console.log(`\nPart des tours à coût marginal nul (abo + local) : ${pct(coutNul, total)}`);

console.log("\n## Mix intra-abonnement (critère « Fable → Haiku »)");
if (byModelAbo.size === 0) {
  console.log("(aucun tour abonnement sur la période)");
} else {
  for (const [model, b] of [...byModelAbo].sort((a, z) => z[1].tours - a[1].tours)) {
    console.log(pad(model, 28) + padN(fmt.format(b.tours), 8) + padN(pct(b.tours, byCat.abo.tours), 9) + padN(`${fmt.format(b.out)} out`, 16));
  }
}

console.log("\n## Détail par fournisseur · modèle");
for (const [key, b] of [...byProviderModel].sort((a, z) => z[1].tours - a[1].tours)) {
  console.log(pad(key, 52) + padN(fmt.format(b.tours), 7) + padN(`${fmt.format(b.out)} out`, 16));
}

console.log("\n## Répartition par source");
for (const [src, b] of [...bySource].sort((a, z) => z[1].tours - a[1].tours)) {
  console.log(pad(src, 20) + padN(fmt.format(b.tours), 7) + padN(pct(b.tours, total), 9));
}

console.log("\n## Saturation des fenêtres d'abonnement (instantanés)");
if (wins.length === 0) {
  console.log("(aucun instantané sur la période)");
} else {
  for (const key of ["five_hour", "seven_day"]) {
    const utils = wins
      .map((w) => w.windows?.[key]?.utilization)
      .filter((u) => typeof u === "number")
      .sort((a, z) => a - z);
    if (utils.length === 0) continue;
    const max = utils[utils.length - 1];
    const p95 = utils[Math.floor(utils.length * 0.95)];
    const over90 = utils.filter((u) => u >= 90).length;
    const label = key === "five_hour" ? "fenêtre 5 h " : "fenêtre 7 j ";
    console.log(`${label}: max ${max} % · p95 ${p95} % · ${pct(over90, utils.length)} des instantanés ≥ 90 %`);
  }
}

console.log(`\n⚠️  Chiffres bruts du journal local (${fmt.format(events.length)} événements au total).`);
console.log("   Tokens abonnement = compteurs SDK (hors lectures de cache) ; les tours");
console.log("   sans usage remonté comptent 0 token. Indicatif, pas comptable.");
