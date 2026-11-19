/**
 * Inventaire des `.env` des projets et migration guidée vers le coffre
 * (docs/etude-coffre-secrets.md § 6.4).
 *
 * - `coffre.inventaireEnv {projets}` : fichiers `.env*` (hors `.env.example`)
 *   trouvés dans les projets, avec les NOMS de leurs variables — jamais une
 *   valeur ;
 * - `coffre.migrerEnv {projet, fichier, cle, nom, serveur?, variable?}` :
 *   verse la valeur d'une variable au coffre sous `nom` et, si un serveur est
 *   désigné, réécrit son entrée `.mcp.json` en `env[variable] = ${SECRET:nom}` ;
 * - `coffre.supprimerEnv {projet, fichier, versements}` : supprime un `.env`,
 *   sur confirmation dans l'interface ET seulement si CHAQUE variable du
 *   fichier est au coffre avec la même valeur (vérifié ici, en mémoire) ;
 * - `coffre.referencesTaches` : noms `${SECRET:…}` dont une tâche programmée
 *   a besoin, pour proposer la classe `sans-fenetre` à la migration (§ 7.2) ;
 * - `coffre.tachesSansSecrets` : tâches programmées dont un secret ne sera
 *   pas servi hors de l'application (avis au lancement).
 *
 * Lecture d'un `.env` : STRICTE. Une valeur que l'analyseur ne sait pas lire
 * sans ambiguïté (guillemet non fermé, valeur sur plusieurs lignes, texte
 * après le guillemet fermant, interpolation `${…}`) est dite « ambiguë » :
 * elle n'est ni versée ni comptée comme migrée, et le fichier qui la porte
 * ne se supprime pas. Mieux vaut une migration à la main qu'un jeton
 * tronqué au coffre et l'original effacé.
 *
 * La valeur lue ne quitte ce module que vers le coffre (`setSecret`, qui la
 * passe à la coquille). Coffre fermé ou absent : migration refusée — un
 * jeton ne doit pas atterrir dans l'ancien fichier en clair.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { isNonEmptyString, isPlainObject } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import { estFichierEnv } from "./fichiersSecrets.js";
import * as journal from "./journal.js";
import { readMcpConfig, writeMcpConfig } from "./mcp.js";
import { collectSecretRefs, coffreContient, etatDuCoffre, nomsFichierAncien, secretRef, setSecret } from "./mcpSecrets.js";
import { listerTaches } from "./taches.js";
import { lireIndexSansFenetre } from "./trousseauFond.js";

const IGNORES = new Set([
  "node_modules", ".git", "dist", "dist-dev", "dist-verif", "build", "target",
  ".venv", "venv", "__pycache__", ".next", ".cache", "relais-recu",
]);
const PROFONDEUR_MAX = 5;
const FICHIERS_MAX = 200;

export interface FichierEnv {
  projet: string;
  /** Chemin relatif au projet, séparateur `/`. */
  fichier: string;
  cles: string[];
  /** Clés dont la valeur ne se lit pas sans ambiguïté : à migrer à la main. */
  ambigues: string[];
}

export interface AnalyseEnv {
  /** Valeurs lues sans ambiguïté. */
  valeurs: Map<string, string>;
  /** Clés présentes mais illisibles sans ambiguïté. */
  ambigues: Set<string>;
}

const LIGNE_VARIABLE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
/** Reste admis après une valeur : rien, ou un commentaire précédé d'un blanc. */
const RESTE_ADMIS = /^(?:\s+#.*)?\s*$/;

/** Valeur entre guillemets doubles : `\n \r \t \" \\` interprétés ; autre `\x` = ambigu. */
function lireDoubles(texte: string): { valeur: string; reste: string } | null {
  let out = "";
  for (let i = 1; i < texte.length; i++) {
    const c = texte[i];
    if (c === "\\") {
      const suivant = texte[i + 1];
      const echappe: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
      if (suivant === undefined || !(suivant in echappe)) return null;
      out += echappe[suivant];
      i++;
    } else if (c === '"') {
      return { valeur: out, reste: texte.slice(i + 1) };
    } else {
      out += c;
    }
  }
  return null; // guillemet non fermé sur la ligne
}

/**
 * Analyse un contenu `.env` (`export` toléré, commentaires ignorés). Pure.
 * Une clé répétée prend la dernière valeur ; si l'une de ses occurrences est
 * ambiguë, la clé l'est.
 */
export function analyserEnv(contenu: string): AnalyseEnv {
  const valeurs = new Map<string, string>();
  const ambigues = new Set<string>();
  const lignes = contenu.split(/\r?\n/);
  for (let n = 0; n < lignes.length; n++) {
    const ligne = lignes[n].trim();
    if (!ligne || ligne.startsWith("#")) continue;
    const m = LIGNE_VARIABLE.exec(ligne);
    if (!m) continue;
    const [, cle, brute] = m;
    let valeur: string | null = null;
    let reste = "";
    if (brute.startsWith('"')) {
      const lu = lireDoubles(brute);
      if (lu) ({ valeur, reste } = lu);
    } else if (brute.startsWith("'")) {
      const fin = brute.indexOf("'", 1);
      if (fin > 0) {
        valeur = brute.slice(1, fin);
        reste = brute.slice(fin + 1);
      }
    } else {
      valeur = brute.replace(/\s+#.*$/, "").trim();
      // Blanc intérieur, guillemet ou interpolation : les outils divergent.
      if (/[\s"'`]|\$\{|\$\(/.test(valeur)) valeur = null;
    }
    if (valeur !== null && brute.startsWith('"') && /\$\{|\$\(/.test(valeur)) valeur = null;
    if (valeur === null || !RESTE_ADMIS.test(reste)) {
      ambigues.add(cle);
      valeurs.delete(cle);
      // Guillemet ouvert sans fermeture : les lignes qui suivent sont la
      // suite de la valeur, pas des variables. On les saute jusqu'au
      // guillemet fermant.
      const q = brute[0];
      if ((q === '"' || q === "'") && !brute.slice(1).includes(q)) {
        while (n + 1 < lignes.length && !lignes[n + 1].includes(q)) n++;
        if (n + 1 < lignes.length) n++;
      }
      continue;
    }
    if (!ambigues.has(cle)) valeurs.set(cle, valeur);
  }
  return { valeurs, ambigues };
}

/** Variables lisibles sans ambiguïté d'un contenu `.env`. Pure. */
export function lireVariablesEnv(contenu: string): Map<string, string> {
  return analyserEnv(contenu).valeurs;
}

async function parcourir(racine: string, dossier: string, profondeur: number, trouves: string[]): Promise<void> {
  if (profondeur > PROFONDEUR_MAX || trouves.length >= FICHIERS_MAX) return;
  let entrees: import("node:fs").Dirent[];
  try {
    entrees = await fsp.readdir(dossier, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entrees) {
    const abs = path.join(dossier, e.name);
    if (e.isDirectory()) {
      if (!IGNORES.has(e.name)) await parcourir(racine, abs, profondeur + 1, trouves);
    } else if (e.isFile() && estFichierEnv(e.name)) {
      trouves.push(abs);
    }
  }
}

/** Inventaire d'un ensemble de projets. */
export async function inventorierEnv(projets: string[]): Promise<FichierEnv[]> {
  const out: FichierEnv[] = [];
  for (const projet of projets) {
    const trouves: string[] = [];
    await parcourir(projet, projet, 0, trouves);
    for (const abs of trouves) {
      let cles: string[] = [];
      let ambigues: string[] = [];
      try {
        const a = analyserEnv(await fsp.readFile(abs, "utf8"));
        ambigues = [...a.ambigues].sort();
        cles = [...new Set([...a.valeurs.keys(), ...ambigues])];
      } catch {
        /* illisible : listé sans clés */
      }
      out.push({ projet, fichier: path.relative(projet, abs).split(path.sep).join("/"), cles, ambigues });
    }
  }
  return out;
}

/** Chemin absolu d'un `.env` DANS le projet, ou message de refus. */
function cheminEnv(projet: string, fichier: string): string | { refus: string } {
  const abs = path.resolve(projet, fichier);
  const rel = path.relative(path.resolve(projet), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { refus: "fichier hors du projet" };
  if (!estFichierEnv(abs)) return { refus: "ce n'est pas un fichier .env" };
  return abs;
}

function lireParams(params: Record<string, unknown>): { projet: string; fichier: string } | string {
  if (!isNonEmptyString(params.projet) || !path.isAbsolute(params.projet)) return "params.projet (chemin absolu) requis";
  if (!isNonEmptyString(params.fichier)) return "params.fichier requis";
  return { projet: params.projet, fichier: params.fichier };
}

export async function handleInventaireEnv(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  const projets = Array.isArray(params.projets)
    ? params.projets.filter((p): p is string => isNonEmptyString(p) && path.isAbsolute(p))
    : [];
  const fichiers = await inventorierEnv(projets);
  journal.info("mcp", "inventaire des .env", { fields: { projets: projets.length, fichiers: fichiers.length } });
  emitter.done(id, { fichiers });
}

export async function handleMigrerEnv(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  const base = lireParams(params);
  if (typeof base === "string") return emitter.error(id, base);
  const { cle, nom } = params;
  if (!isNonEmptyString(cle)) return emitter.error(id, "params.cle requis");
  if (!isNonEmptyString(nom) || !/^[A-Za-z0-9_.-]+$/.test(nom)) return emitter.error(id, "params.nom invalide (lettres, chiffres, _ . -)");
  if (etatDuCoffre() !== "ouvert") return emitter.error(id, "coffre fermé : ouvre-le avant de migrer un .env");
  const abs = cheminEnv(base.projet, base.fichier);
  if (typeof abs !== "string") return emitter.error(id, abs.refus);
  let analyse: AnalyseEnv;
  try {
    analyse = analyserEnv(await fsp.readFile(abs, "utf8"));
  } catch {
    return emitter.error(id, `fichier illisible : ${base.fichier}`);
  }
  if (analyse.ambigues.has(cle)) {
    return emitter.error(
      id,
      `valeur de « ${cle} » illisible sans ambiguïté (guillemets, plusieurs lignes ou interpolation) : ` +
        "verse-la à la main depuis l'écran des secrets",
    );
  }
  const valeur = analyse.valeurs.get(cle);
  if (!valeur) return emitter.error(id, `variable absente ou vide : ${cle}`);
  try {
    await setSecret(nom, valeur);
  } catch (err) {
    return emitter.error(id, err instanceof Error ? err.message : String(err));
  }
  let serveurMisAJour: string | null = null;
  if (isNonEmptyString(params.serveur)) {
    const { servers } = await readMcpConfig(base.projet);
    const entree = servers?.[params.serveur];
    if (!servers || !isPlainObject(entree)) {
      return emitter.error(id, `secret « ${nom} » versé au coffre, mais serveur « ${params.serveur} » absent de .mcp.json`);
    }
    const variable = isNonEmptyString(params.variable) ? params.variable : cle;
    const env = isPlainObject(entree.env) ? { ...entree.env } : {};
    env[variable] = secretRef(nom);
    await writeMcpConfig(base.projet, { ...servers, [params.serveur]: { ...entree, env } });
    serveurMisAJour = params.serveur;
  }
  journal.info("mcp", "variable d'un .env versée au coffre", {
    fields: { fichier: base.fichier, cle, nom, serveur: serveurMisAJour ?? "" },
  });
  emitter.done(id, { nom, serveur: serveurMisAJour });
}

/**
 * Variables du fichier qui ne sont PAS au coffre avec la même valeur, d'après
 * `versements` (`{cle, nom}`). Vide = le fichier peut partir. Pure, hors la
 * comparaison en mémoire (`coffreContient`, booléen seulement).
 */
export function variablesNonVersees(analyse: AnalyseEnv, versements: { cle: string; nom: string }[]): string[] {
  const manquantes = [...analyse.ambigues];
  for (const [cle, valeur] of analyse.valeurs) {
    if (valeur === "") continue; // rien à perdre
    const ok = versements.some((v) => v.cle === cle && coffreContient(v.nom, valeur));
    if (!ok) manquantes.push(cle);
  }
  return manquantes.sort();
}

export async function handleSupprimerEnv(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  const base = lireParams(params);
  if (typeof base === "string") return emitter.error(id, base);
  const abs = cheminEnv(base.projet, base.fichier);
  if (typeof abs !== "string") return emitter.error(id, abs.refus);
  if (etatDuCoffre() !== "ouvert") return emitter.error(id, "coffre fermé : impossible de vérifier que les variables y sont");
  const versements = Array.isArray(params.versements)
    ? params.versements.filter(
        (v): v is { cle: string; nom: string } => isPlainObject(v) && isNonEmptyString(v.cle) && isNonEmptyString(v.nom),
      )
    : [];
  let analyse: AnalyseEnv;
  try {
    analyse = analyserEnv(await fsp.readFile(abs, "utf8"));
  } catch {
    return emitter.error(id, `fichier illisible : ${base.fichier}`);
  }
  const manquantes = variablesNonVersees(analyse, versements);
  if (manquantes.length > 0) {
    journal.warn("mcp", "suppression d'un .env refusée : variables absentes du coffre", {
      fields: { fichier: base.fichier, cles: manquantes.join(",") },
    });
    return emitter.error(
      id,
      `suppression refusée : ${manquantes.join(", ")} pas au coffre avec la même valeur ` +
        "(non versée, modifiée depuis, ou illisible sans ambiguïté). Le fichier est conservé.",
    );
  }
  try {
    await fsp.unlink(abs);
  } catch (err) {
    return emitter.error(id, `suppression impossible : ${err instanceof Error ? err.message : String(err)}`);
  }
  journal.info("mcp", ".env supprimé après migration", { fields: { fichier: base.fichier, projet: base.projet } });
  emitter.done(id, { supprime: true });
}

/**
 * Secrets dont les tâches programmées ont besoin (étude § 10, inconnue
 * levée) : une tâche n'en référence que par le `.mcp.json` du projet où elle
 * tourne (`cwd`, sinon son dossier) — c'est celui que lit `prepareMcpForTurn`
 * dans le runner headless. Tâches `serveur` ignorées (runner distant, son
 * propre `.env` de serveur).
 */
export async function secretsDesTaches(): Promise<string[]> {
  const noms = new Set<string>();
  for (const t of await listerTaches()) {
    // Désactivées comprises : réactiver une tâche ne doit pas la priver de ses secrets.
    if (t.invalid || t.lieu !== "local") continue;
    const { servers } = await readMcpConfig(t.cwd ?? t.path);
    if (servers) for (const n of collectSecretRefs(servers)) noms.add(n);
  }
  return [...noms].sort();
}

export async function handleReferencesTaches(id: string, emitter: EngineEmitter): Promise<void> {
  emitter.done(id, { noms: await secretsDesTaches() });
}

/**
 * Tâches programmées `local` actives dont un secret ne sera PAS servi à leur
 * sidecar sans fenêtre : ni `sans-fenetre` (index), ni encore dans l'ancien
 * fichier (repli). Vide tant qu'aucun coffre n'existe.
 */
export async function tachesSansSecrets(): Promise<{ tache: string; noms: string[] }[]> {
  if (etatDuCoffre() === "absent") return [];
  const servis = new Set([
    ...(await lireIndexSansFenetre()).filter((c) => c.startsWith("mcp:")).map((c) => c.slice(4)),
    ...(await nomsFichierAncien()),
  ]);
  const out: { tache: string; noms: string[] }[] = [];
  for (const t of await listerTaches()) {
    if (t.invalid || t.lieu !== "local" || !t.enabled) continue;
    const { servers } = await readMcpConfig(t.cwd ?? t.path);
    const manquants = servers ? collectSecretRefs(servers).filter((n) => !servis.has(n)) : [];
    if (manquants.length > 0) out.push({ tache: t.name, noms: manquants });
  }
  return out;
}

export async function handleTachesSansSecrets(id: string, emitter: EngineEmitter): Promise<void> {
  const taches = await tachesSansSecrets();
  if (taches.length > 0) {
    journal.warn("mcp", "tâches programmées privées d'un secret hors de l'application", {
      fields: { taches: taches.map((t) => `${t.tache}:${t.noms.join("+")}`).join(",") },
    });
  }
  emitter.done(id, { taches });
}
