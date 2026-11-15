#!/usr/bin/env node
/**
 * Veille des modèles de l'abonnement Claude (T-142, T-143).
 *
 * ── Pourquoi ────────────────────────────────────────────────────────────
 * `MODELES_ABONNEMENT_CLAUDE` (ui/src/modelesAbonnementClaude.ts) est une
 * liste tenue à la main : l'abonnement n'expose aucun catalogue interrogeable,
 * le catalogue de fait est le binaire CLI que l'agent SDK embarque. Deux fois
 * déjà la liste a vieilli en silence — `claude-fable-5-1` connu du catalogue
 * public mais absent du CLI embarqué (T-142), puis `claude-opus-5-5` sorti le
 * 2026-09-22 et encore absent quatre jours plus tard, découvert par
 * l'utilisateur et non par l'outillage (T-143). Ce script détecte, il ne
 * modifie rien : l'arbitrage (faire entrer un modèle, en sortir un autre)
 * reste humain.
 *
 * ── Ce qu'il compare ──────────────────────────────────────────────────────
 * Le SDK INSTALLÉ (node_modules/@anthropic-ai/claude-agent-sdk-linux-x64) et
 * le DERNIER publié sur npm. S'ils diffèrent, le dernier est rapatrié (`npm
 * pack`) dans un dossier temporaire pour analyser son binaire — sans jamais
 * l'installer dans le dépôt. Les ids qu'il porte sont comparés à ceux de la
 * liste, famille par famille (fable/opus/sonnet/haiku) : une famille absente
 * de la liste est ignorée, elle n'est simplement pas proposée à l'abonnement.
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   node scripts/veille-modeles.mjs               vérifie et notifie
 *   node scripts/veille-modeles.mjs --sans-notif   vérifie sans notification système
 *
 * Fait du réseau (npm view, npm pack) : volontairement absent de `verif`, qui
 * doit rester jouable hors ligne. Prévu pour un minuteur périodique.
 */

import { execFileSync } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHEMIN_LISTE = path.join(RACINE, "ui/src/modelesAbonnementClaude.ts");
const PAQUET_PLATEFORME = "@anthropic-ai/claude-agent-sdk-linux-x64";
const PAQUET_ABSTRAIT = "@anthropic-ai/claude-agent-sdk";
const CHEMIN_PACKAGE_INSTALLE = path.join(RACINE, "node_modules", PAQUET_PLATEFORME, "package.json");
const CHEMIN_BINAIRE_INSTALLE = path.join(RACINE, "node_modules", PAQUET_PLATEFORME, "claude");

/** Une famille de modèles à la fois — le bruit du binaire n'en connaît pas d'autres. */
const RE_ID_BINAIRE = /claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?![\w-])/g;

/** Même forme, ancrée : pour les ids déjà propres (liste, sortie de l'extraction). */
const RE_ID_COMPLET = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/;

/**
 * Extrait les ids de modèles du buffer d'un binaire CLI. Le binaire contient
 * du bruit : un id tronqué (`claude-fable-5-`) ou un id daté (à 8 chiffres)
 * ne satisfont jamais la garde `(?![\w-])` et ne matchent donc pas du tout.
 * Un faux mineur à deux chiffres (`claude-haiku-3-55` — les vrais mineurs
 * n'en ont jamais qu'un) matche mais est écarté ici explicitement : la regex
 * seule ne peut pas le distinguer d'un vrai mineur à deux chiffres qui
 * n'existe simplement pas encore.
 */
export function extraireIdsBinaire(buffer) {
  const texte = buffer.toString("latin1");
  const ids = new Set();
  let trouve;
  RE_ID_BINAIRE.lastIndex = 0;
  while ((trouve = RE_ID_BINAIRE.exec(texte)) !== null) {
    const [, famille, majeur, mineur] = trouve;
    if (mineur && mineur.length === 2) continue; // bruit type claude-haiku-3-55
    ids.add(mineur ? `claude-${famille}-${majeur}-${mineur}` : `claude-${famille}-${majeur}`);
  }
  return [...ids].sort();
}

/** Lit les ids déclarés dans la liste TS — par regex, pas par exécution du module. */
export function lireIdsListe(texte) {
  const ids = [];
  const re = /id:\s*"(claude-[^"]+)"/g;
  let trouve;
  while ((trouve = re.exec(texte)) !== null) ids.push(trouve[1]);
  return ids;
}

function analyserId(id) {
  const trouve = RE_ID_COMPLET.exec(id);
  RE_ID_COMPLET.lastIndex = 0;
  if (!trouve) return null;
  return { famille: trouve[1], majeur: Number(trouve[2]), mineur: trouve[3] !== undefined ? Number(trouve[3]) : 0 };
}

function plusRecent(a, b) {
  return a.majeur > b.majeur || (a.majeur === b.majeur && a.mineur > b.mineur);
}

/**
 * Les ids du binaire dont la version dépasse strictement la plus haute
 * connue de la MÊME famille dans la liste. Une famille absente de la liste
 * (le binaire en propose une qu'on ne sert pas) est ignorée — ce n'est pas
 * une nouveauté à signaler, c'est une famille qu'on ne propose pas.
 */
export function nouveautes(idsBinaire, idsListe) {
  const maxParFamille = new Map();
  for (const id of idsListe) {
    const v = analyserId(id);
    if (!v) continue;
    const courant = maxParFamille.get(v.famille);
    if (!courant || plusRecent(v, courant)) maxParFamille.set(v.famille, v);
  }

  const trouves = new Set();
  for (const id of idsBinaire) {
    const v = analyserId(id);
    if (!v) continue;
    const max = maxParFamille.get(v.famille);
    if (!max) continue; // famille absente de la liste : ignorée
    if (plusRecent(v, max)) trouves.add(id);
  }
  return [...trouves].sort();
}

function comparerVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

async function versionInstallee() {
  const brut = await fsp.readFile(CHEMIN_PACKAGE_INSTALLE, "utf8");
  return JSON.parse(brut).version;
}

function versionPubliee() {
  return execFileSync("npm", ["view", PAQUET_ABSTRAIT, "version"], { encoding: "utf8" }).trim();
}

/** Rapatrie le SDK d'une version donnée dans un dossier temporaire, analyse son binaire, nettoie. */
async function idsDuSdkPublie(version) {
  const dossier = await fsp.mkdtemp(path.join(os.tmpdir(), "veille-modeles-"));
  try {
    const sortie = execFileSync(
      "npm",
      ["pack", `${PAQUET_PLATEFORME}@${version}`, "--json"],
      { cwd: dossier, encoding: "utf8" },
    );
    const [info] = JSON.parse(sortie);
    execFileSync("tar", ["xzf", info.filename], { cwd: dossier });
    const buffer = await fsp.readFile(path.join(dossier, "package", "claude"));
    return extraireIdsBinaire(buffer);
  } finally {
    await fsp.rm(dossier, { recursive: true, force: true });
  }
}

async function idsDuSdkInstalle() {
  const buffer = await fsp.readFile(CHEMIN_BINAIRE_INSTALLE);
  return extraireIdsBinaire(buffer);
}

const TITRE_NOTIFICATION = "IAction — nouveau modèle Claude";

/**
 * T-153 — environnement de `notify-send`. Lancée par un minuteur ou une tâche de
 * fond, la veille n'hérite pas de l'adresse du bus de session : sans elle,
 * `notify-send` échoue et la notification ne parvient jamais (constat du
 * 2026-10-06). On la reconstruit depuis le dossier d'exécution de l'utilisateur
 * quand il manque, sans jamais écraser une valeur déjà posée.
 */
function environnementNotification(env, uid) {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env;
  const dossier = env.XDG_RUNTIME_DIR || (uid === null ? null : `/run/user/${uid}`);
  return dossier ? { ...env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${dossier}/bus` } : env;
}

/**
 * Notification système d'un nouveau modèle (DÉCISION du 2026-11-08 : notification
 * système, pas de pastille dans l'application). `notify-send` sous Linux — même
 * esprit que `notifier()` de scripts/dev.sh : JAMAIS fatale, une panne de
 * notification ne change ni le code de sortie ni la ligne « NOUVEAU » déjà
 * écrite. Ailleurs que sous Linux, ou si `notify-send` échoue, le repli est une
 * ligne sur la sortie d'erreur (captée par le journal de la tâche) qui porte le
 * texte complet : la détection ne se perd jamais.
 *
 * `deps` est injectable pour les tests : { plateforme, env, uid, executer, journaliser }.
 * Retourne true si une notification système est partie.
 */
export function notifier(texte, deps = {}) {
  const plateforme = deps.plateforme ?? process.platform;
  const env = deps.env ?? process.env;
  const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  const executer = deps.executer ?? ((cmd, args, opts) => execFileSync(cmd, args, opts));
  const journaliser = deps.journaliser ?? ((ligne) => console.error(ligne));

  if (plateforme !== "linux") {
    journaliser(`veille-modeles: pas de notification système sous ${plateforme} — NOUVEAU : ${texte}`);
    return false;
  }
  try {
    executer("notify-send", [TITRE_NOTIFICATION, texte], {
      env: environnementNotification(env, uid),
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch (err) {
    journaliser(`veille-modeles: notification système impossible (${err.message}) — NOUVEAU : ${texte}`);
    return false;
  }
}

async function principal() {
  const sansNotif = process.argv.includes("--sans-notif");
  const horodatage = new Date().toISOString();

  let idsListe;
  try {
    idsListe = lireIdsListe(await fsp.readFile(CHEMIN_LISTE, "utf8"));
  } catch (err) {
    console.error(`veille-modeles: liste illisible (${CHEMIN_LISTE}) — ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (idsListe.length === 0) {
    console.error(`veille-modeles: liste vide (${CHEMIN_LISTE}) — rien à comparer`);
    process.exitCode = 1;
    return;
  }

  let installee;
  let publiee;
  try {
    installee = await versionInstallee();
    publiee = versionPubliee();
  } catch (err) {
    console.error(`veille-modeles: échec de la lecture des versions — ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let idsBinaire;
  try {
    idsBinaire = comparerVersions(installee, publiee) === 0
      ? await idsDuSdkInstalle()
      : await idsDuSdkPublie(publiee);
  } catch (err) {
    console.error(`veille-modeles: échec de l'analyse du binaire — ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const trouvees = nouveautes(idsBinaire, idsListe);

  if (trouvees.length > 0) {
    const texte = `${trouvees.join(", ")} (SDK publié ${publiee}, installé ${installee})`;
    console.log(`${horodatage} veille-modeles: NOUVEAU — ${texte}`);
    if (!sansNotif) notifier(texte);
    return;
  }

  const aMonter = comparerVersions(installee, publiee) !== 0;
  const suffixe = aMonter ? " (SDK à monter)" : "";
  console.log(`${horodatage} veille-modeles: RAS — SDK installé ${installee}, publié ${publiee}${suffixe}, liste à jour`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await principal();
