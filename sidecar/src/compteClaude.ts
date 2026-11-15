/*
 * Comptes Claude — « Claude Perso » et « Claude Teams » (docs/spec-deux-comptes.md).
 *
 * Ce module est le SEUL à connaître le tableau des comptes et à rendre l'env
 * d'un compte, comme `aiguillerVersCliEmballe` centralise l'exécutable : la
 * règle ne se recopie pas dans chaque site (tour, menu « / », sonde de conso).
 *
 * RÈGLE ABSOLUE : IAction ne lit, ne stocke ni ne transmet aucun jeton. Il
 * passe `CLAUDE_CONFIG_DIR` au CLI, rien d'autre. Du fichier d'identifiants, on
 * ne tire qu'UNE date (`refreshTokenExpiresAt`), par une extraction textuelle
 * ciblée : le fichier n'est jamais désérialisé, donc aucun champ de jeton
 * n'entre dans un objet de ce module — ni ne peut en sortir par erreur.
 *
 * Jamais de bascule automatique : le compte est un paramètre du tour, posé par
 * un geste de l'utilisateur. Rien ici ne choisit un compte à sa place.
 */

import fs from "node:fs";
import path from "node:path";
import { currentEnv, type PathEnv } from "./appPaths.js";
import type { EngineEmitter } from "./engine.js";

export type CompteId = "perso" | "teams";

/** `compte` absent = `perso`, partout (paramètres, sessions, lignes d'historique). */
export const COMPTE_PAR_DEFAUT: CompteId = "perso";

export interface CompteDecrit {
  id: CompteId;
  label: string;
  connecte: boolean;
}

/** Nom du fichier d'identifiants du CLI — son existence seule signale un compte posé. */
const FICHIER_IDENTIFIANTS = ".credentials.json";

/**
 * Le tableau. `dossier: null` = le compte du processus : aucun
 * `CLAUDE_CONFIG_DIR` n'est ajouté, le CLI lit ce que l'environnement lui donne.
 */
const COMPTES: Record<CompteId, { label: string; dossier: ((e: PathEnv) => string) | null }> = {
  perso: { label: "Claude Perso", dossier: null },
  teams: { label: "Claude Teams", dossier: (e) => path.join(e.home, ".claude-compte2") },
};

/** Commande à lancer pour connecter le compte Teams — celle du CLI, pas la nôtre. */
export const COMMANDE_CONNEXION_TEAMS = "CLAUDE_CONFIG_DIR=~/.claude-compte2 claude auth login";

/** Id reconnu, ou `null`. `undefined`/`null` ne sont PAS reconnus ici : voir `resoudreCompte`. */
export function compteConnu(valeur: unknown): CompteId | null {
  return typeof valeur === "string" && Object.prototype.hasOwnProperty.call(COMPTES, valeur)
    ? (valeur as CompteId)
    : null;
}

/** Compte d'une ligne d'historique (fenêtres, événements d'usage) : champ absent = `perso`, aucune migration. */
export function compteDeLigne(ligne: Record<string, unknown>): string {
  return typeof ligne.compte === "string" ? ligne.compte : COMPTE_PAR_DEFAUT;
}

/**
 * T-191 — `meta` d'un tour, enrichi du compte qui le sert. `perso` reste absent
 * (l'événement d'usage garde alors sa forme d'avant, à l'octet près) ; `usageStats`
 * lit ce champ dans `meta` pour écrire `compte` dans `events.jsonl`.
 */
export function metaAvecCompte(meta: unknown, compte: CompteId): unknown {
  if (compte === COMPTE_PAR_DEFAUT) return meta;
  const base = typeof meta === "object" && meta !== null && !Array.isArray(meta) ? meta : {};
  return { ...base, compte };
}

/** Paramètre `compte` d'une requête qui ne lance pas de tour : absent = `perso`, inconnu = `null`. */
export function compteDemande(brut: unknown): CompteId | null {
  return brut === undefined || brut === null ? COMPTE_PAR_DEFAUT : compteConnu(brut);
}

export function libelleCompte(id: CompteId): string {
  return COMPTES[id].label;
}

/** L'env à AJOUTER à celui du processus : vide pour `perso`. */
export function envCompte(id: CompteId, e: PathEnv = currentEnv()): Record<string, string> {
  const dossier = COMPTES[id].dossier;
  return dossier ? { CLAUDE_CONFIG_DIR: dossier(e) } : {};
}

/**
 * Date d'expiration du jeton de rafraîchissement (ms depuis l'époque), ou `null`
 * si le fichier manque, est illisible ou ne la porte pas. Extraction textuelle
 * ciblée — voir l'en-tête : le fichier n'est jamais désérialisé.
 */
function expirationRafraichissement(fichier: string): number | null {
  let texte: string;
  try {
    texte = fs.readFileSync(fichier, "utf8");
  } catch {
    return null;
  }
  const trouve = /"refreshTokenExpiresAt"\s*:\s*(?:"([^"]*)"|(\d+(?:\.\d+)?))/.exec(texte);
  if (!trouve) return null;
  if (trouve[1] !== undefined) {
    const t = Date.parse(trouve[1]);
    return Number.isNaN(t) ? null : t;
  }
  const n = Number(trouve[2]);
  if (!Number.isFinite(n)) return null;
  // Secondes ou millisecondes : aucune date en ms ne tient sous 1e11 avant l'an 5138.
  return n < 1e11 ? n * 1000 : n;
}

export interface EtatCompte {
  /** Le dossier du compte porte un fichier d'identifiants. */
  present: boolean;
  /** `false` seulement si l'expiration du rafraîchissement est DÉPASSÉE : date inconnue = on laisse le CLI trancher. */
  connecte: boolean;
}

export function etatCompte(id: CompteId, e: PathEnv = currentEnv(), maintenant: number = Date.now()): EtatCompte {
  const dossier = COMPTES[id].dossier;
  // Le compte du processus est toujours « là » : c'est celui d'aujourd'hui, que rien ne conditionne.
  if (!dossier) return { present: true, connecte: true };
  const fichier = path.join(dossier(e), FICHIER_IDENTIFIANTS);
  if (!fs.existsSync(fichier)) return { present: false, connecte: false };
  const expiration = expirationRafraichissement(fichier);
  return { present: true, connecte: expiration === null || expiration > maintenant };
}

/**
 * Comptes proposés à l'interface. `teams` n'y figure que si ses identifiants
 * existent : sans second compte, la fonction est invisible (règle 3).
 */
export function listerComptes(e: PathEnv = currentEnv(), maintenant: number = Date.now()): CompteDecrit[] {
  const out: CompteDecrit[] = [{ id: "perso", label: COMPTES.perso.label, connecte: true }];
  const teams = etatCompte("teams", e, maintenant);
  if (teams.present) out.push({ id: "teams", label: COMPTES.teams.label, connecte: teams.connecte });
  return out;
}

export type ResolutionCompte =
  | { ok: true; compte: CompteId; env: Record<string, string> }
  | { ok: false; message: string };

/**
 * Résout le paramètre `compte` d'une requête : absent = `perso`; inconnu ou
 * indisponible = refus avec un message qui donne la commande de connexion.
 * Aucun repli sur l'autre compte, jamais : un refus est un refus.
 */
export function resoudreCompte(
  brut: unknown,
  e: PathEnv = currentEnv(),
  maintenant: number = Date.now(),
): ResolutionCompte {
  if (brut === undefined || brut === null) return { ok: true, compte: COMPTE_PAR_DEFAUT, env: {} };
  const compte = compteConnu(brut);
  if (!compte) return { ok: false, message: `params.compte inconnu : « ${String(brut)} »` };
  const etat = etatCompte(compte, e, maintenant);
  if (!etat.present || !etat.connecte) {
    const motif = etat.present ? "session expirée" : "aucun identifiant trouvé";
    return {
      ok: false,
      message: `${libelleCompte(compte)} indisponible (${motif}). Connectez-le dans un terminal : ${COMMANDE_CONNEXION_TEAMS}`,
    };
  }
  return { ok: true, compte, env: envCompte(compte, e) };
}

/** claude.comptes — la liste que l'interface met dans ses sélecteurs de moteur. */
export function executerClaudeComptes(id: string, _params: Record<string, unknown>, emitter: EngineEmitter): void {
  emitter.done(id, { comptes: listerComptes() });
}
