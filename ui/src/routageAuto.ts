/**
 * Routage Auto — les DEUX stratégies R7, côte à côte.
 *
 * ── Pourquoi deux fonctions et pas une ──────────────────────────────────
 * Le Chat route en MONTANT (§B) : chaque tour est classé par l'heuristique,
 * avec le plancher de session pour `minTier` — le tier peut monter, jamais
 * descendre. Les Projets routent en DESCENDANT (§C) : le premier tour d'une
 * session Auto part au SOMMET de la table (tier `complexe` imposé, aucune
 * classification du prompt), puis l'affinité de session garde la conversation
 * là-haut — descendre est un choix manuel du sélecteur. Leur similarité de
 * 58 % avait été prise pour une dette (voir docs/etude-structure.md, étape
 * 4c) ; c'est en réalité le TITRE de la spec R7. Les fusionner serait décider
 * à la place de la spec — les poser côte à côte documente le contraste.
 *
 * ── Ce qui est commun, et où il vit ─────────────────────────────────────
 * Les gardes R3 (jamais d'envoi vers un fournisseur non déclaré, repli en
 * REMONTANT la table) sont dans `gardesRoutage.ts`, appelées par les deux
 * stratégies. L'affinité/le plancher ne sont JAMAIS posés ici : un tour routé
 * qui échoue (cible éteinte…) ne doit pas verrouiller la conversation — c'est
 * `pendingAffinity`, honoré par l'appelant au premier signe de succès du tour.
 *
 * Feuille : le routeur du sidecar, la liste des fournisseurs et la table de
 * routage sont injectés — même règle que `gardesRoutage.ts`, et pour la même
 * raison (sidecar.ts s'abonne à Tauri au chargement, un module testable ne
 * peut pas l'importer en valeur).
 */

import { appliquerGardesRoutage, type RoutageGarde } from "./gardesRoutage";
import type { RouteDebord, RouteTarget, RouteTier, RoutingTable } from "./sidecar";

/** Sous-ensemble du contrat `router.route` utilisé par les deux stratégies. */
export interface RequeteRoutage {
  text: string;
  historyTurns?: number;
  attachmentsCount?: number;
  cwd?: string;
  /** R3 — tier imposé : saute la classification, ne résout que cible + débord. */
  tier?: RouteTier;
  /** R7 §B — plancher de session : le tier effectif ne descend jamais dessous. */
  minTier?: RouteTier;
}

export interface ReponseRoutage {
  tier: RouteTier;
  target: RouteTarget;
  reasons: string[];
  debord: RouteDebord | null;
}

export interface DepsRoutageAuto {
  /** `routerRoute` du sidecar (ou un faux dans les tests). */
  router: (req: RequeteRoutage) => Promise<ReponseRoutage>;
  /** Vrai si la cible désigne l'abonnement ou un fournisseur déclaré. */
  estUtilisable: (target: RouteTarget) => boolean;
  /** Table de routage complète (déjà fusionnée avec les défauts). */
  lireTable: () => Promise<RoutingTable>;
}

export interface RouteResolue extends RoutageGarde {
  /** Affinité/plancher à poser au PREMIER signe de succès du tour — jamais ici. */
  pendingAffinity: boolean;
}

/** Cible mémorisée d'une session Projets déjà routée (voir §C ci-dessous). */
export interface AffiniteSession {
  tier: RouteTier;
  target: RouteTarget;
  /** Raisons mémorisées au premier routage — absentes sur une session rechargée d'avant R6. */
  reasons?: string[];
}

/** R2 — cible utilisable : moteur Claude (toujours disponible) ou fournisseur déclaré. */
export function estCibleUtilisable(target: RouteTarget, fournisseurs: ReadonlyArray<{ id: string }>): boolean {
  return target.engine === "claude" || fournisseurs.some((p) => p.id === target.providerId);
}

/** R3 — libellé court de l'état de débord, ajouté aux raisons (infobulle du badge).
 * T-005 — nomme la fenêtre la PLUS saturée (5 h ou 7 jours) : c'est elle qui a
 * déclenché, et pointer l'autre ferait chercher l'explication au mauvais endroit. */
export function libelleDebord(debord: RouteDebord): string {
  if (!debord.active) return "plafond débord atteint : repli local";
  const cinq = debord.fiveHourPct ?? -1;
  const sept = debord.sevenDayPct ?? -1;
  if (cinq < 0 && sept < 0) return "débord : abonnement saturé";
  return sept > cinq
    ? `débord : fenêtre 7 jours à ${Math.round(sept)} %`
    : `débord : fenêtre 5 h à ${Math.round(cinq)} %`;
}

/**
 * R1/R7 §B — stratégie MONTANTE de la page Chat : CHAQUE tour est routé par
 * `router.route` (heuristique, ~0 ms), avec pour `minTier` le PLANCHER DE
 * SESSION (`plancher`, absent au premier tour) — le tier effectif ne descend
 * jamais, il ne peut que monter. R3 — le débord d'abonnement est re-vérifié
 * par ce même appel ; un tour débordé/bloqué ne relève JAMAIS le plancher
 * (`pendingAffinity: false`) : la conversation re-route normalement dès que
 * la fenêtre se rouvre.
 */
export async function resoudreRouteMontante(
  entree: {
    texte: string;
    plancher: RouteTier | null;
    /** Tours utilisateur de l'historique (0 = premier tour, non transmis). */
    toursHistorique: number;
    nbPiecesJointes: number;
  },
  deps: DepsRoutageAuto,
): Promise<RouteResolue> {
  const routed = await deps.router({
    text: entree.texte,
    ...(entree.toursHistorique > 0 ? { historyTurns: entree.toursHistorique } : {}),
    ...(entree.nbPiecesJointes > 0 ? { attachmentsCount: entree.nbPiecesJointes } : {}),
    ...(entree.plancher ? { minTier: entree.plancher } : {}),
  });

  const garde = await appliquerGardesRoutage(
    { tier: routed.tier, target: routed.target, debord: routed.debord, reasons: [...routed.reasons] },
    { estUtilisable: deps.estUtilisable, lireTable: deps.lireTable },
  );

  return { ...garde, pendingAffinity: !garde.debord };
}

/*
 * T-080 — la stratégie DESCENDANTE a été supprimée avec le mode Auto des
 * Projets : elle imposait le tier `complexe` sans lire le prompt et gelait la
 * cible pour la session, donc elle n'arbitrait rien (T-079). Les Projets
 * partent désormais sur un modèle fixe réglé dans Configuration.
 *
 * Ce module garde la stratégie MONTANTE, qui elle classe réellement le prompt
 * et sert au Chat — ainsi que les gardes et le libellé de débord, partagés.
 */
