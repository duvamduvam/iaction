/**
 * Gardes R3 du routage Auto — partagées par les deux stratégies.
 *
 * ── Contexte ────────────────────────────────────────────────────────────
 * Le Chat (stratégie montante, R7 §A+§B) et les Projets (descendante, R7 §C)
 * routent différemment PAR CONCEPTION — ce n'est pas une duplication à
 * résorber. Mais une fois la cible choisie, les mêmes gardes s'appliquent aux
 * deux, et elles étaient recopiées mot pour mot dans chaque page. Ces gardes
 * décident où part une requête facturée : la corriger deux fois est le même
 * piège que la jauge de contexte, en plus cher.
 *
 * ── Les deux gardes, dans cet ordre ─────────────────────────────────────
 * 1. **Débord actif vers un fournisseur non déclaré** : jamais d'envoi vers un
 *    provider inconnu. Repli sur la cible abonnement d'origine (la table du
 *    tier), débord annulé, bandeau dédié (`debordUnconfigured`).
 * 2. **Cible inutilisable sans débord** : repli en REMONTANT la table
 *    (tier supérieur), jamais en descendant — on ne dégrade pas une requête
 *    en silence. Une cible de débord/plafond ne vient pas de la table : pas
 *    de repli pour elle, l'erreur moteur habituelle s'affichera.
 *
 * Feuille : les deux dépendances qui touchent l'application (liste des
 * fournisseurs, table de routage) sont injectées — même règle que
 * `debordNotice.ts`, et pour la même raison (sidecar.ts s'abonne à Tauri au
 * chargement, un module testable ne peut pas l'importer).
 */

import type { RouteDebord, RouteTarget, RouteTier, RoutingTable } from "./sidecar";

export const ROUTE_TIERS_ORDONNES: readonly RouteTier[] = ["trivial", "simple", "moyen", "complexe"];

export interface RoutageBrut {
  tier: RouteTier;
  target: RouteTarget;
  debord: RouteDebord | null;
  reasons: string[];
}

export interface RoutageGarde extends RoutageBrut {
  /** Débord annulé : sa cible référençait un fournisseur non déclaré. */
  debordUnconfigured: boolean;
}

export async function appliquerGardesRoutage(
  routed: RoutageBrut,
  deps: {
    /** Vrai si la cible désigne l'abonnement ou un fournisseur déclaré. */
    estUtilisable: (target: RouteTarget) => boolean;
    /** Table de routage complète (déjà fusionnée avec les défauts). Appelée au plus une fois. */
    lireTable: () => Promise<RoutingTable>;
  },
): Promise<RoutageGarde> {
  let { tier, target, debord } = routed;
  const reasons = [...routed.reasons];
  let debordUnconfigured = false;

  if (debord?.active && !deps.estUtilisable(target)) {
    target = (await deps.lireTable())[tier];
    reasons.push("cible de débord non configurée : envoi sur l'abonnement");
    debord = null;
    debordUnconfigured = true;
  }

  if (!debord && !deps.estUtilisable(target)) {
    const table = await deps.lireTable();
    for (let i = ROUTE_TIERS_ORDONNES.indexOf(routed.tier) + 1; i < ROUTE_TIERS_ORDONNES.length; i++) {
      const candidate = table[ROUTE_TIERS_ORDONNES[i]];
      if (deps.estUtilisable(candidate)) {
        reasons.push(`repli : fournisseur « ${target.providerId ?? "?"} » absent`);
        tier = ROUTE_TIERS_ORDONNES[i];
        target = candidate;
        break;
      }
    }
  }

  return { tier, target, debord, reasons, debordUnconfigured };
}
