/*
 * Réglage « ouvrir une référence de fichier au survol, sans clic » (T-104).
 *
 * ── Pourquoi une option, désactivée par défaut ──────────────────────────
 * Ouvrir un fichier — voire lancer une application externe, registre
 * d'applications compris — est un effet de bord déclenché par un geste
 * qu'on fait souvent SANS intention : promener la souris en lisant une
 * réponse. Le clic reste donc le comportement par défaut ; le survol est un
 * choix explicite, avec un délai qu'on règle soi-même.
 *
 * ── Pourquoi un délai borné ──────────────────────────────────────────────
 * Un survol instantané ouvrirait au moindre passage de curseur, sans laisser
 * le temps de fuir. Un délai trop long viderait l'intérêt de l'option. D'où
 * [SURVOL_DELAI_MIN, SURVOL_DELAI_MAX] : la valeur choisie est toujours
 * ramenée dans cette fourchette plutôt que rejetée — un réglage un peu trop
 * agressif reste utilisable, il est juste borné.
 *
 * ── Pourquoi un bus plutôt qu'une lecture au montage ────────────────────
 * La page Configuration et le fil de conversation vivent dans la MÊME
 * fenêtre : basculer l'option doit s'appliquer immédiatement, sans recharger
 * la page. Même patron que `providersBus.ts` — cache module-scope + `Set`
 * d'écouteurs, consulté par `useSyncExternalStore` côté React. Les AUTRES
 * fenêtres (« Nouvelle fenêtre ») ne partagent pas ce module-scope : elles
 * reprennent le réglage à leur prochain montage, via `readConfig`.
 */
import { useEffect, useSyncExternalStore } from "react";
import { readConfig, writeConfig } from "./appConfig";

export interface ReglageSurvol {
  actif: boolean;
  delaiMs: number;
}

export const SURVOL_DEFAUT: ReglageSurvol = { actif: false, delaiMs: 700 };
export const SURVOL_DELAI_MIN = 250;
export const SURVOL_DELAI_MAX = 5000;
export const CLE_CONFIG_SURVOL = "ouvertureAuSurvol";

/**
 * Normalise une valeur brute lue en config. Pure — aucun accès disque —
 * pour rester testable sans Tauri. Toute forme inattendue (absente, `null`,
 * chaîne, tableau, objet partiel) retombe sur les défauts sans jeter : un
 * document de config malformé ne doit jamais empêcher le rendu.
 */
export function lireReglageSurvol(brut: unknown): ReglageSurvol {
  if (typeof brut !== "object" || brut === null) return { ...SURVOL_DEFAUT };
  const v = brut as Record<string, unknown>;

  const actif = v.actif === true;

  let delaiMs = SURVOL_DEFAUT.delaiMs;
  if (typeof v.delaiMs === "number" && Number.isFinite(v.delaiMs)) {
    delaiMs = Math.min(SURVOL_DELAI_MAX, Math.max(SURVOL_DELAI_MIN, v.delaiMs));
  }

  return { actif, delaiMs };
}

/**
 * Faut-il armer le minuteur d'ouverture sur ce survol ?
 *
 * Les trois garde-fous de T-104 tiennent dans cette réponse, et ils vivent
 * ici — pas au fond d'un gestionnaire d'événement — pour être PROUVÉS : le
 * projet n'a pas d'environnement DOM en test (voir le cliquet de taille et sa
 * doctrine — ce qui n'expose rien ne se teste plus), donc la seule façon
 * d'empêcher une régression silencieuse sur un comportement qu'on ne
 * déclenche qu'à la souris est d'en sortir la décision.
 *
 *  - `delai === null` : l'option est éteinte (défaut usine, ou page Chat) ;
 *  - pointeur non-souris : un écran tactile n'a pas de survol, et une
 *    pression longue ne doit RIEN ouvrir — ce serait une ouverture qu'on n'a
 *    pas demandée, sur un geste qu'on n'a pas conscience de faire ;
 *  - `dejaDeclenche` : après une ouverture, il faut ressortir de la puce
 *    avant qu'un nouveau survol compte, sinon un même geste rouvre en boucle.
 */
export function doitArmerSurvol(
  delai: number | null,
  typePointeur: string,
  dejaDeclenche: boolean,
): boolean {
  if (delai === null) return false;
  if (typePointeur !== "mouse") return false;
  return !dejaDeclenche;
}

let cache: ReglageSurvol = { ...SURVOL_DEFAUT };
const listeners = new Set<() => void>();
let chargementEnCours: Promise<ReglageSurvol> | null = null;

function notifier(): void {
  for (const cb of listeners) cb();
}

/**
 * Pose le cache et notifie les abonnés — SEULEMENT si le réglage a réellement
 * changé (identité stable indispensable à `useSyncExternalStore`, sinon rendu
 * en boucle). Exportée séparément de `chargerSurvol`/`enregistrerSurvol` : la
 * partie bus (cache + notification) est pure et se teste sans Tauri, alors
 * que ces deux-là font de l'I/O.
 */
export function appliquerSurvol(prochain: ReglageSurvol): void {
  if (cache.actif === prochain.actif && cache.delaiMs === prochain.delaiMs) return;
  cache = prochain;
  notifier();
}

/** Lit la config, met le cache à jour et notifie les abonnés. */
export async function chargerSurvol(): Promise<ReglageSurvol> {
  const document = await readConfig();
  const reglage = lireReglageSurvol(document[CLE_CONFIG_SURVOL]);
  appliquerSurvol(reglage);
  return reglage;
}

/** Écrit le réglage en config, met le cache à jour et notifie les abonnés. */
export async function enregistrerSurvol(r: ReglageSurvol): Promise<void> {
  await writeConfig({ [CLE_CONFIG_SURVOL]: r });
  appliquerSurvol(r);
}

/** Instantané synchrone du cache module-scope (hors React, ou lecture initiale du hook). */
export function survolCourant(): ReglageSurvol {
  return cache;
}

export function subscribeSurvol(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Hook React : délai en ms si l'option est active, `null` sinon.
 *
 * Déclenche un chargement paresseux au premier usage — protégé par une
 * promesse module-scope, donc N composants montés en même temps = UNE seule
 * lecture de config. Un échec de lecture ne jette ni ne bloque le rendu : le
 * cache reste sur les défauts (survol désactivé).
 */
export function useDelaiSurvol(): number | null {
  const reglage = useSyncExternalStore(subscribeSurvol, survolCourant, survolCourant);

  useEffect(() => {
    if (chargementEnCours) return;
    chargementEnCours = chargerSurvol().catch(() => cache);
  }, []);

  return reglage.actif ? reglage.delaiMs : null;
}
