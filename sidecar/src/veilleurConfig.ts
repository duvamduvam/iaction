/*
 * Veilleur du relais — config d'un projet, `<cwd>/.iaction/veilleur.json`. Elle
 * décide d'un dialogue autonome : écrite par l'interface seule, jamais par un
 * agent (garde `estConfigVeilleur`, fichiersSecrets.ts).
 *
 * Validation PURE et stricte : un champ manquant ou aberrant rend `{ invalide }`
 * avec une raison lisible, jamais une config à moitié bonne (un veilleur ne
 * démarre pas sur une config douteuse). Le jeton n'est PAS dans ce fichier :
 * `jetonSecret` nomme l'entrée du coffre à résoudre au démarrage.
 *
 * Permission imposée par Bash : sans humain devant l'écran, tout mode autre
 * que `bypassPermissions` bloquerait le tour sur la première commande. Bash
 * vrai ⇒ `bypassPermissions` ; Bash faux ⇒ `acceptEdits`. Toute autre
 * combinaison est refusée, pour que le fichier dise ce qui s'exécute vraiment.
 */

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import { globalConfigRoot } from "./appPaths.js";
import type { Plafonds } from "./veilleurPolitique.js";

export interface ConfigVeilleur {
  actif: boolean;
  /** Studios écoutés (la maison). Au moins un. */
  expediteurs: string[];
  /** Agent de projet à employer, ou `null` (agent par défaut). */
  agent: string | null;
  /** Compte Claude des tours (perso). */
  compte: string;
  modele: string;
  effort: string;
  /** Mode de permission du tour : `bypassPermissions` si Bash, sinon `acceptEdits`. */
  permission: string;
  /** Bash autorisé dans le tour. */
  bash: boolean;
  plafonds: Plafonds & { dureeMin: number };
  /** Intervalle entre deux relèves, en secondes (10 à 600, défaut 30). */
  cadenceSec: number;
  /** Adresse du broker (https://…). */
  url: string;
  /** Nom de l'entrée du coffre qui porte le jeton (jamais le jeton lui-même). */
  jetonSecret: string;
  /** Chemin du fichier PEM d'une autorité de certification, optionnel. */
  ca?: string;
  /** Proxy HTTPS, optionnel. */
  proxy?: string;
}

export const CADENCE_DEFAUT_SEC = 30;
export const CADENCE_MIN_SEC = 10;
export const CADENCE_MAX_SEC = 600;

/** Le seul mode de permission cohérent avec `bash` (voir l'en-tête). */
export function permissionPour(bash: boolean): "bypassPermissions" | "acceptEdits" {
  return bash ? "bypassPermissions" : "acceptEdits";
}

/** Bornes réelles (T-227) : aucun « 0 = illimité ». */
export const BORNES = {
  profondeur: { min: 1, max: 20 },
  toursParJour: { min: 1, max: 500 },
  coutParMessage: { min: 0, max: 50 }, // strictement > 0
  dureeMin: { min: 1, max: 120 },
} as const;

/** Forme d'un nom de boîte du broker. */
export const NOM_STUDIO = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Préfixe des secrets du coffre qui portent le scellé d'une config approuvée (un par projet). */
export const PREFIXE_SCELLE = "veilleur.empreinte";

function entierDans(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** Valide un objet brut. Rend `{ config }` ou `{ invalide }`. Pur. */
export function validerConfig(brut: unknown): { config: ConfigVeilleur } | { invalide: string } {
  if (typeof brut !== "object" || brut === null || Array.isArray(brut)) {
    return { invalide: "objet attendu" };
  }
  const o = brut as Record<string, unknown>;

  if (typeof o.actif !== "boolean") return { invalide: "« actif » booléen attendu" };
  if (!Array.isArray(o.expediteurs) || o.expediteurs.length === 0) {
    return { invalide: "« expediteurs » : au moins un studio écouté" };
  }
  if (!o.expediteurs.every((e) => typeof e === "string" && NOM_STUDIO.test(e))) {
    return { invalide: "« expediteurs » : noms de boîte attendus (minuscules, chiffres, tirets ; 31 caractères au plus)" };
  }
  if (o.agent !== null && typeof o.agent !== "string") return { invalide: "« agent » : chaîne ou null" };
  if (o.compte !== "perso") return { invalide: "« compte » : seul « perso » est permis (jamais Teams)" };
  if (typeof o.modele !== "string" || o.modele.length === 0) return { invalide: "« modele » manquant" };
  if (typeof o.effort !== "string" || o.effort.length === 0) return { invalide: "« effort » manquant" };
  if (typeof o.permission !== "string" || o.permission.length === 0) return { invalide: "« permission » manquant" };
  if (typeof o.bash !== "boolean") return { invalide: "« bash » booléen attendu" };
  if (o.permission !== permissionPour(o.bash)) {
    return {
      invalide: o.bash
        ? "« permission » : « bypassPermissions » exigé avec Bash (sans humain, tout autre mode bloquerait le tour à la première commande)"
        : "« permission » : « acceptEdits » exigé sans Bash",
    };
  }
  let cadenceSec = CADENCE_DEFAUT_SEC;
  if (o.cadenceSec !== undefined) {
    if (typeof o.cadenceSec !== "number" || !Number.isInteger(o.cadenceSec) || o.cadenceSec < CADENCE_MIN_SEC || o.cadenceSec > CADENCE_MAX_SEC) {
      return { invalide: `« cadenceSec » : entier de ${CADENCE_MIN_SEC} à ${CADENCE_MAX_SEC} attendu` };
    }
    cadenceSec = o.cadenceSec;
  }

  const p = o.plafonds;
  if (typeof p !== "object" || p === null) return { invalide: "« plafonds » manquant" };
  const pp = p as Record<string, unknown>;
  const { profondeur: bp, toursParJour: bt, coutParMessage: bc, dureeMin: bd } = BORNES;
  if (!entierDans(pp.profondeur, bp.min, bp.max)) return { invalide: `plafonds.profondeur : entier de ${bp.min} à ${bp.max} attendu` };
  if (typeof pp.coutParMessage !== "number" || !Number.isFinite(pp.coutParMessage) || pp.coutParMessage <= bc.min || pp.coutParMessage > bc.max) {
    return { invalide: `plafonds.coutParMessage : plus de ${bc.min} et au plus ${bc.max} $ attendu` };
  }
  if (!entierDans(pp.toursParJour, bt.min, bt.max)) return { invalide: `plafonds.toursParJour : entier de ${bt.min} à ${bt.max} attendu` };
  if (!entierDans(pp.dureeMin, bd.min, bd.max)) return { invalide: `plafonds.dureeMin : entier de ${bd.min} à ${bd.max} attendu` };

  if (typeof o.url !== "string" || !/^https:\/\//.test(o.url)) return { invalide: "« url » : https:// attendu" };
  if (typeof o.jetonSecret !== "string" || o.jetonSecret.length === 0) return { invalide: "« jetonSecret » manquant" };
  if (o.jetonSecret.startsWith(PREFIXE_SCELLE)) return { invalide: `« jetonSecret » : « ${PREFIXE_SCELLE}… » est un scellé du veilleur, pas un jeton` };
  if (o.ca !== undefined && typeof o.ca !== "string") return { invalide: "« ca » : chaîne attendue" };
  if (o.proxy !== undefined && typeof o.proxy !== "string") return { invalide: "« proxy » : chaîne attendue" };

  return {
    config: {
      actif: o.actif,
      expediteurs: o.expediteurs as string[],
      agent: (o.agent as string | null) ?? null,
      compte: o.compte,
      modele: o.modele,
      effort: o.effort,
      permission: o.permission,
      bash: o.bash,
      plafonds: {
        profondeur: pp.profondeur,
        coutParMessage: pp.coutParMessage,
        toursParJour: pp.toursParJour,
        dureeMin: pp.dureeMin,
      },
      cadenceSec,
      url: o.url,
      jetonSecret: o.jetonSecret,
      ...(typeof o.ca === "string" ? { ca: o.ca } : {}),
      ...(typeof o.proxy === "string" ? { proxy: o.proxy } : {}),
    },
  };
}

/** Valeur triée récursivement (clés d'objet), pour une sérialisation canonique. */
function canonique(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonique);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonique((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * Empreinte SHA-256 de la config APPROUVÉE (le scellé, T-227) : config
 * normalisée (validée, tous les champs, clés triées) liée à la racine du projet.
 * Rangée au coffre par l'ENREGISTREMENT dans l'interface (`veilleur.configurer`) ;
 * recalculée avant toute requête (service, outils `relais_*`) : un fichier
 * réécrit hors de l'interface (agent avec Bash) ne correspond plus.
 */
export function empreinteConfig(cwd: string, config: ConfigVeilleur, fichiers: { agent: string | null; ca: string | null } = { agent: null, ca: null }): string {
  const texte = JSON.stringify(canonique({ cwd: path.resolve(cwd), config, fichiers }));
  return createHash("sha256").update(texte, "utf8").digest("hex");
}

/** SHA-256 du contenu d'un fichier, ou un marqueur stable s'il est introuvable/illisible. */
async function empreinteFichier(chemin: string | null): Promise<string> {
  if (chemin === null) return "introuvable";
  try {
    return createHash("sha256").update(await fsp.readFile(chemin)).digest("hex");
  } catch {
    return "illisible";
  }
}

/** Fichier de l'agent `nom` du projet (même résolution que le lanceur), ou `null`. */
async function cheminAgentParDefaut(cwd: string, nom: string): Promise<string | null> {
  // Import paresseux : orchestrator.ts tire le moteur, inutile (et cyclique) au chargement.
  const { resolveAgentForStep } = await import("./orchestrator.js");
  const r = await resolveAgentForStep(cwd, nom);
  return r.ok ? ((r.value as { path?: string }).path ?? null) : null;
}

export interface DepsScelle {
  cheminAgent?: (cwd: string, nom: string) => Promise<string | null>;
}

/** Chemin réel du projet (liens symboliques résolus), ou le chemin résolu s'il n'existe pas. */
export async function cheminReelProjet(cwd: string): Promise<string> {
  try {
    return await fsp.realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * Nom du secret qui porte le scellé d'UN projet :
 * `veilleur.empreinte.<8 premiers hex du SHA-256 du chemin réel>`. Un ancien
 * `veilleur.empreinte` (sans suffixe) n'est jamais lu.
 */
export function nomScelle(cwdReel: string): string {
  return `${PREFIXE_SCELLE}.${createHash("sha256").update(cwdReel, "utf8").digest("hex").slice(0, 8)}`;
}

/**
 * Nom du secret et empreinte attendue pour cette config de ce projet. Le
 * CONTENU du fichier d'agent désigné et celui de l'autorité de certification
 * entrent dans l'empreinte : modifiés après l'approbation, le scellé ne vaut plus.
 */
export async function scellePour(cwd: string, config: ConfigVeilleur, deps: DepsScelle = {}): Promise<{ nom: string; empreinte: string }> {
  const reel = await cheminReelProjet(cwd);
  const agent = config.agent ? await empreinteFichier(await (deps.cheminAgent ?? cheminAgentParDefaut)(reel, config.agent)) : null;
  const ca = config.ca ? await empreinteFichier(path.resolve(reel, config.ca)) : null;
  return { nom: nomScelle(reel), empreinte: empreinteConfig(reel, config, { agent, ca }) };
}

export const MOTIF_SCELLE = "config du relais modifiée hors de l'interface : ré-enregistre-la dans la section Veilleur";

/**
 * Config lue ET confrontée au scellé. `contient(nom, valeur)` interroge le
 * coffre OUVERT seulement (jamais l'ancien fichier en clair). `scellee: false`
 * ⇒ aucune requête ne doit partir avec cette config.
 */
export async function lireConfigScellee(
  cwd: string,
  contient: (nom: string, valeur: string) => boolean,
  lire: (cwd: string) => ReturnType<typeof lireConfigVeilleur> = lireConfigVeilleur,
  deps: DepsScelle = {},
): Promise<{ config: ConfigVeilleur; scellee: boolean } | { invalide: string } | { absent: true }> {
  const lu = await lire(cwd);
  if (!("config" in lu)) return lu;
  const { nom, empreinte } = await scellePour(cwd, lu.config, deps);
  return { config: lu.config, scellee: contient(nom, empreinte) };
}

/** Chemin de la config d'un projet. */
export function cheminConfig(cwd: string): string {
  return path.join(cwd, ".iaction", "veilleur.json");
}

/**
 * Lit la config d'un projet. `{ absent }` si le fichier n'existe pas,
 * `{ invalide }` s'il est illisible ou non conforme, sinon `{ config }`.
 */
export async function lireConfigVeilleur(
  cwd: string,
): Promise<{ config: ConfigVeilleur } | { invalide: string } | { absent: true }> {
  let texte: string;
  try {
    texte = await fsp.readFile(cheminConfig(cwd), "utf8");
  } catch (e) {
    // Seul « fichier absent » vaut absence ; tout autre échec se dit.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { absent: true };
    return { invalide: `fichier illisible : ${(e as Error).message}` };
  }
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch (e) {
    return { invalide: `JSON illisible : ${e instanceof Error ? e.message : String(e)}` };
  }
  return validerConfig(brut);
}

/**
 * Écrit la config d'un projet — RÉSERVÉ au sidecar (méthodes `veilleur.*`,
 * appelées par l'interface) : un agent ne passe jamais par ici, et la garde
 * `estConfigVeilleur` lui interdit le fichier. Validation d'abord (rien
 * d'invalide n'est écrit), puis écriture atomique (temporaire + renommage).
 */
export async function ecrireConfigVeilleur(cwd: string, brut: unknown): Promise<{ config: ConfigVeilleur } | { invalide: string }> {
  const v = validerConfig(brut);
  if ("invalide" in v) return v;
  const chemin = cheminConfig(cwd);
  await fsp.mkdir(path.dirname(chemin), { recursive: true });
  const tmp = `${chemin}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(v.config, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, chemin);
  return v;
}

/**
 * Dernière version APPROUVÉE d'une config, gardée hors projet
 * (`<config>/net.duvam.iaction/veilleur/approuvees/<nom du scellé>.json`) pour
 * MONTRER ce qui a changé quand le fichier ne correspond plus au scellé.
 * Indicative seulement : la confiance vient du scellé au coffre, jamais d'elle.
 */
export function cheminApprouvee(nomDuScelle: string, racine: string = globalConfigRoot()): string {
  return path.join(racine, "veilleur", "approuvees", `${nomDuScelle}.json`);
}

export async function memoriserApprouvee(cwd: string, config: ConfigVeilleur, racine?: string): Promise<void> {
  const chemin = cheminApprouvee(nomScelle(await cheminReelProjet(cwd)), racine);
  await fsp.mkdir(path.dirname(chemin), { recursive: true });
  const tmp = `${chemin}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(config), "utf8");
  await fsp.rename(tmp, chemin);
}

export async function lireApprouvee(cwd: string, racine?: string): Promise<ConfigVeilleur | null> {
  try {
    const v = validerConfig(JSON.parse(await fsp.readFile(cheminApprouvee(nomScelle(await cheminReelProjet(cwd)), racine), "utf8")));
    return "config" in v ? v.config : null;
  } catch {
    return null;
  }
}

export async function oublierApprouvee(cwd: string, racine?: string): Promise<void> {
  await fsp.rm(cheminApprouvee(nomScelle(await cheminReelProjet(cwd)), racine), { force: true });
}

/** Champs qui diffèrent entre deux configs (pure, testée) : `url`, `plafonds.coutParMessage`… */
export function champsDifferents(a: ConfigVeilleur, b: ConfigVeilleur): string[] {
  const plat = (c: ConfigVeilleur): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(c)) {
      if (k === "plafonds") for (const [pk, pv] of Object.entries(v as object)) out[`plafonds.${pk}`] = JSON.stringify(pv);
      else out[k] = JSON.stringify(v);
    }
    return out;
  };
  const pa = plat(a);
  const pb = plat(b);
  return [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((k) => pa[k] !== pb[k]).sort();
}

/** Lignes ajoutées à l'exclusion LOCALE de git (jamais au `.gitignore` versionné). */
export const EXCLUSIONS_GIT = ["/.iaction/veilleur.json", "/relais-recu/", "/relais-envoi/"];

/** Dossier git du projet (`.git` dossier, ou fichier `gitdir:` d'un worktree → dossier commun), ou `null`. */
async function dossierGit(cwd: string): Promise<string | null> {
  const point = path.join(cwd, ".git");
  let st;
  try {
    st = await fsp.stat(point);
  } catch {
    return null;
  }
  if (st.isDirectory()) return point;
  const m = /^gitdir:\s*(.+)\s*$/m.exec(await fsp.readFile(point, "utf8"));
  if (!m) return null;
  const gitdir = path.resolve(cwd, m[1].trim());
  try {
    return path.resolve(gitdir, (await fsp.readFile(path.join(gitdir, "commondir"), "utf8")).trim());
  } catch {
    return gitdir;
  }
}

/**
 * Ajoute la config du veilleur, `relais-recu/` et `relais-envoi/` à `.git/info/exclude`, sans
 * doublon. Pas un dépôt git : rien. Rend un avertissement en cas d'échec (pas
 * une erreur : l'enregistrement a eu lieu).
 */
export async function exclureDeGit(cwd: string): Promise<string | null> {
  try {
    const git = await dossierGit(cwd);
    if (git === null) return null;
    const fichier = path.join(git, "info", "exclude");
    let texte = "";
    try {
      texte = await fsp.readFile(fichier, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const lignes = new Set(texte.split(/\r?\n/).map((l) => l.trim()));
    const manquantes = EXCLUSIONS_GIT.filter((l) => !lignes.has(l));
    if (manquantes.length === 0) return null;
    await fsp.mkdir(path.dirname(fichier), { recursive: true });
    const prefixe = texte.length > 0 && !texte.endsWith("\n") ? "\n" : "";
    await fsp.appendFile(fichier, `${prefixe}# IAction — veilleur du relais (local, non versionné)\n${manquantes.join("\n")}\n`, "utf8");
    return null;
  } catch (e) {
    return `exclusion git locale non écrite (${e instanceof Error ? e.message : String(e)})`;
  }
}

/** Supprime la config d'un projet (`veilleur.oublier`, sidecar seul). Absente : rien à faire. */
export async function supprimerConfigVeilleur(cwd: string): Promise<void> {
  await fsp.rm(cheminConfig(cwd), { force: true });
}
