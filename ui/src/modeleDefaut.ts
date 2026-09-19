/*
 * T-080 — modèle par défaut des Projets, en remplacement du mode « Auto ».
 *
 * ── Pourquoi ce réglage existe ──────────────────────────────────────────
 * Les Projets avaient un mode « Auto (descendant) » qui n'arbitrait rien :
 * il imposait le tier `complexe` au premier tour SANS lire le prompt, puis
 * gelait la cible pour la session (T-079). Ses deux garde-fous étaient
 * inatteignables sur une table 100 % abonnement, et le seul mécanisme vivant
 * — le débord — reposait sur un relevé de fenêtre déjà contesté (T-059).
 * Un mode automatique qui ne décide rien est pire qu'un choix explicite :
 * il fait croire à un arbitrage. Il est donc remplacé par ce qu'il faisait
 * réellement — partir sur un modèle fixe — mais dit à voix haute et réglable.
 *
 * ⚠ Le Chat n'est PAS concerné : sa stratégie montante classe réellement le
 * prompt (barème de router.ts) et garde son sélecteur « Auto (routeur) ».
 *
 * Feuille : les fonctions de décision sont PURES et testées ; seules
 * `lire`/`ecrire` touchent la config (appConfig.ts, clé racine dédiée).
 */
import { readConfig, writeConfig } from "./appConfig";

/** Clé racine dans la config non-secrète. */
const CLE_CONFIG = "modeleDefautProjets";

/**
 * Défaut d'usine. `opus-5` et pas `fable-5` : voir T-078 — au sommet d'une
 * table où TOUT arrive, fable coûtait 2,3× le tour opus pour un travail que
 * opus-5 fait (c'est le modèle recommandé par défaut pour l'agentique).
 * Fable reste choisissable à la main, session par session.
 */
export const MODELE_DEFAUT_USINE = "claude-opus-5";

/**
 * Ancienne sentinelle du mode Auto. Elle ne sert plus qu'à RELIRE les
 * sessions déjà persistées : 30 conversations la portent au moment de la
 * bascule, et les ouvrir sur un modèle inconnu afficherait « __auto__ » dans
 * le sélecteur. Ne jamais la réintroduire comme valeur écrite.
 */
export const SENTINELLE_AUTO_HISTORIQUE = "__auto__";

/**
 * Modèle à utiliser pour une session relue.
 *
 * Une session d'avant la bascule porte `__auto__` comme modèle et, si elle a
 * déjà tourné, la cible réellement routée dans `routedTarget`. On préfère
 * TOUJOURS cette cible : c'est le modèle sur lequel la conversation s'est
 * construite, et la faire changer de modèle en cours de route au rechargement
 * serait un changement silencieux. Sans cible connue (session jamais
 * envoyée), on retombe sur le défaut configuré.
 */
export function resoudreModeleSession(
  modelePersiste: string | null | undefined,
  modeleRoute: string | null | undefined,
  defaut: string,
): string {
  const m = (modelePersiste ?? "").trim();
  if (m !== "" && m !== SENTINELLE_AUTO_HISTORIQUE) return m;
  const route = (modeleRoute ?? "").trim();
  if (m === SENTINELLE_AUTO_HISTORIQUE && route !== "") return route;
  return defaut;
}

/** Valeur de config valide, ou `null` — jamais une chaîne vide écrite par mégarde. */
export function normaliserModeleDefaut(brut: unknown): string | null {
  if (typeof brut !== "string") return null;
  const v = brut.trim();
  // La sentinelle historique n'est PAS un modèle : la relire comme réglage
  // ressusciterait le mode supprimé par la porte de derrière.
  if (v === "" || v === SENTINELLE_AUTO_HISTORIQUE) return null;
  return v;
}

/** Modèle par défaut configuré, ou le défaut d'usine. Ne jette jamais. */
export async function lireModeleDefaut(): Promise<string> {
  try {
    const config = await readConfig();
    return normaliserModeleDefaut(config[CLE_CONFIG]) ?? MODELE_DEFAUT_USINE;
  } catch {
    // Config illisible : un défaut d'usine vaut mieux qu'un écran bloqué.
    return MODELE_DEFAUT_USINE;
  }
}

/** Écrit le réglage. Une valeur vide REMET le défaut d'usine plutôt que d'écrire du vide. */
export async function ecrireModeleDefaut(modele: string): Promise<void> {
  const valide = normaliserModeleDefaut(modele);
  await writeConfig({ [CLE_CONFIG]: valide ?? MODELE_DEFAUT_USINE });
}
