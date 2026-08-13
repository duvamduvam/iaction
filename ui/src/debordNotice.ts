/**
 * Bandeau de débord d'abonnement — partagé par le Chat et les Projets.
 *
 * Le débord bascule un tour vers le moteur payant quand la fenêtre
 * d'abonnement est épuisée. L'utilisateur doit le savoir : c'est de l'argent.
 * Ce module décide QUOI afficher ; les pages décident OÙ.
 *
 * ── Pourquoi il est sorti des pages ─────────────────────────────────────
 * Le type et la fonction étaient dupliqués mot pour mot dans `AgentPage` et
 * `ChatPage` — 100 % identiques au relevé du 2026-08-08. Deux copies d'une
 * logique qui parle de facturation, c'est deux endroits où corriger le jour où
 * la règle change, et un où l'on oubliera.
 *
 * ── Trois situations, et pourquoi elles diffèrent ───────────────────────
 * 1. **Cible de débord non déclarée** : le sidecar signale un débord vers un
 *    fournisseur absent de la table. On n'envoie rien vers un fournisseur
 *    inconnu — le tour reste sur l'abonnement, et le bandeau le dit.
 * 2. **Pas de débord** : le bandeau disparaît. L'objet n'est remplacé que s'il
 *    existait, pour ne pas provoquer un rendu inutile à chaque tour normal.
 * 3. **Débord actif** : bandeau complet. Le plafond mensuel n'est lu que si le
 *    débord est BLOQUÉ — c'est la seule situation où le chiffre sert, et cette
 *    lecture est un aller-retour disque qu'on ne fait pas pour rien.
 *
 * ── Pourquoi la lecture du plafond est INJECTÉE ─────────────────────────
 * Ce module n'importe rien de l'application : son seul import est un type,
 * effacé à la compilation. Ce n'est pas du purisme — importer `routerAdmin`
 * entraînait `sidecar.ts`, qui s'abonne aux événements Tauri au CHARGEMENT du
 * module. Un simple test se mettait alors à parler à une fenêtre native
 * inexistante. Le premier test écrit l'a montré immédiatement.
 */

import type { RouteDebord } from "./sidecar";

export interface DebordNotice {
  blocked: boolean;
  fiveHourPct: number | null;
  /** T-005 — occupation de la fenêtre 7 jours (`null` : absente, ou sidecar antérieur). */
  sevenDayPct: number | null;
  /** Modèle payant réellement utilisé quand le débord est actif. */
  model: string;
  /** Plafond configuré (affiché quand le débord est bloqué), `null` = sans plafond. */
  plafondUsdMois: number | null;
  /** Vrai = cible de débord non déclarée dans la table des fournisseurs : tour resté sur l'abonnement. */
  unconfigured?: boolean;
}

/**
 * Texte du bandeau. Il vivait EN DUR dans le JSX des deux pages — la
 * duplication exacte que ce module existe pour empêcher, découverte en
 * corrigeant T-005 (il aurait fallu apprendre la fenêtre 7 jours aux deux
 * copies). T-005 — le bandeau nomme la fenêtre la PLUS saturée : dire
 * « fenêtre 5 h à 92 % » quand c'est la semaine qui est morte ferait chercher
 * l'explication au mauvais endroit.
 */
export function libelleDebordNotice(notice: DebordNotice): string {
  if (notice.unconfigured) {
    return "⚠ Cible de débord non configurée — tour envoyé sur l'abonnement";
  }
  if (notice.blocked) {
    return `⛔ Plafond débord atteint (${notice.plafondUsdMois ?? "?"} $/mois) — repli sur le modèle local`;
  }
  const cinq = notice.fiveHourPct ?? -1;
  const sept = notice.sevenDayPct ?? -1;
  let fenetre = "";
  if (cinq >= 0 || sept >= 0) {
    fenetre =
      sept > cinq ? ` (fenêtre 7 jours à ${Math.round(sept)} %)` : ` (fenêtre 5 h à ${Math.round(cinq)} %)`;
  }
  return `⚠ Mode débord : abonnement saturé${fenetre} — tour envoyé sur ${notice.model}`;
}

/**
 * Le bandeau à afficher, ou `null` pour n'en afficher aucun.
 *
 * Séparé de son application pour être testable sans React ni disque : c'est la
 * partie qui porte les règles, donc celle qui doit être vérifiée.
 */
export function calculerDebordNotice(
  debord: RouteDebord | null,
  model: string,
  { unconfigured = false, plafondUsdMois = null }: { unconfigured?: boolean; plafondUsdMois?: number | null } = {},
): DebordNotice | null {
  if (unconfigured) {
    return { blocked: false, fiveHourPct: null, sevenDayPct: null, model, plafondUsdMois: null, unconfigured: true };
  }
  if (!debord) return null;
  return { blocked: debord.blocked, fiveHourPct: debord.fiveHourPct, sevenDayPct: debord.sevenDayPct, model, plafondUsdMois };
}

/** Vrai si le plafond mensuel doit être lu sur le disque avant d'afficher le bandeau. */
export function plafondRequis(debord: RouteDebord | null, unconfigured: boolean): boolean {
  return !unconfigured && debord !== null && debord.blocked;
}

/**
 * Pose le bandeau dans le runtime d'une conversation.
 *
 * `ecrire` est la méthode du dépôt de runtimes : ce module n'a pas besoin de
 * connaître le reste du runtime, seulement de savoir y écrire un champ.
 */
export async function appliquerDebordNotice<R extends { debordNotice: DebordNotice | null }>(
  ecrire: (majeur: (prev: R) => R) => void,
  {
    debord,
    model,
    unconfigured = false,
    lirePlafond,
  }: {
    debord: RouteDebord | null;
    model: string;
    unconfigured?: boolean;
    /** Lecture du plafond mensuel — appelée UNIQUEMENT si le débord est bloqué. */
    lirePlafond: () => Promise<number | null>;
  },
): Promise<void> {
  if (!unconfigured && !debord) {
    // Rien à signaler : on ne remplace l'objet que s'il y avait un bandeau,
    // sinon chaque tour normal provoquerait un rendu pour rien.
    ecrire((r) => (r.debordNotice ? { ...r, debordNotice: null } : r));
    return;
  }

  let plafondUsdMois: number | null = null;
  if (plafondRequis(debord, unconfigured)) {
    // `null` = bascule payante désactivée (le sidecar ne devrait alors jamais
    // signaler de débord, mais on reste défensif). Une lecture en échec ne doit
    // jamais faire disparaître le bandeau : facturer sans le dire serait pire
    // que d'afficher un plafond inconnu.
    plafondUsdMois = await lirePlafond().catch(() => null);
  }

  const notice = calculerDebordNotice(debord, model, { unconfigured, plafondUsdMois });
  ecrire((r) => ({ ...r, debordNotice: notice }));
}
