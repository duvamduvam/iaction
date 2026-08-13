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

/**
 * R2/R7 §C — stratégie DESCENDANTE de la page Projets : PAS de classification
 * du prompt. Sans affinité (premier tour d'une session Auto), le tour part au
 * SOMMET de la table — tier `complexe` IMPOSÉ à `router.route` (mécanique
 * R3), avec le `cwd` du projet pour que la surcharge `.iaction/routage.yaml`
 * s'applique. Avec affinité, la session RESTE au sommet, AUCUNE descente
 * automatique (descendre = choix manuel du sélecteur) — le plancher montant
 * du Chat (§B) ne s'applique pas ici. Pour une cible abonnement, l'état de
 * débord est re-vérifié à CHAQUE tour via `router.route` à tier IMPOSÉ
 * (aucune re-classification) ; un tour débordé/bloqué ne fixe JAMAIS
 * l'affinité. Cible de débord non déclarée : le tour reste sur l'abonnement,
 * bandeau dédié (`debordUnconfigured`).
 */
export async function resoudreRouteDescendante(
  affinite: AffiniteSession | null,
  texte: string,
  /** Racine du projet — `""` = pas de surcharge `.iaction/routage.yaml`. */
  cwd: string,
  deps: DepsRoutageAuto,
): Promise<RouteResolue> {
  if (affinite) {
    const affinityReasons = affinite.reasons ?? ["affinité de session (cible mémorisée au premier envoi)"];
    // R3 — cible abonnement : re-vérification du débord à CHAQUE tour, tier
    // IMPOSÉ (aucune re-classification).
    if (affinite.target.engine === "claude") {
      try {
        const check = await deps.router({ text: texte, tier: affinite.tier, ...(cwd ? { cwd } : {}) });
        if (check.debord) {
          // Cible de débord jamais validée jusqu'ici : si son fournisseur
          // n'est PAS déclaré, on n'envoie pas vers un provider inconnu —
          // le tour reste sur la cible abonnement d'origine, sans débord.
          if (check.debord.active && !deps.estUtilisable(check.target)) {
            return {
              tier: affinite.tier,
              target: affinite.target,
              reasons: [...affinityReasons, "cible de débord non configurée : envoi sur l'abonnement"],
              debord: null,
              pendingAffinity: false,
              debordUnconfigured: true,
            };
          }
          return {
            tier: affinite.tier,
            target: check.target,
            reasons: [...affinityReasons, libelleDebord(check.debord)],
            debord: check.debord,
            pendingAffinity: false,
            debordUnconfigured: false,
          };
        }
      } catch {
        // Sidecar antérieur à R3 ou injoignable : affinité telle quelle.
      }
    }
    return {
      tier: affinite.tier,
      target: affinite.target,
      reasons: affinityReasons,
      debord: null,
      pendingAffinity: false,
      debordUnconfigured: false,
    };
  }

  // R7 §C — premier tour d'une session Auto : tier `complexe` IMPOSÉ
  // (aucune classification du prompt), le sommet de la table.
  const routed = await deps.router({ text: texte, tier: "complexe", ...(cwd ? { cwd } : {}) });

  // Gardes R3 communes aux deux stratégies (jamais vers un fournisseur non
  // déclaré ; repli en remontant la table) : voir gardesRoutage.ts.
  const garde = await appliquerGardesRoutage(
    {
      tier: routed.tier,
      target: routed.target,
      debord: routed.debord,
      // Raison lisible du badge : la mention protocolaire du tier imposé est
      // remplacée par l'explication de la stratégie.
      reasons: [
        "stratégie descendante : premier tour au sommet de la table (complexe)",
        ...routed.reasons.filter((r) => r !== "tier imposé par l'appelant"),
      ],
    },
    { estUtilisable: deps.estUtilisable, lireTable: deps.lireTable },
  );

  // R3 — un tour débordé/bloqué ne mémorise PAS d'affinité : la conversation
  // re-route normalement dès que la fenêtre d'abonnement se rouvre. Un tour
  // normal, lui, ne la mémorise pas ICI mais au premier signe de succès
  // (`pendingAffinity`) — un tour routé qui échoue (cible éteinte…) ne doit
  // jamais verrouiller la conversation dessus.
  return { ...garde, pendingAffinity: !garde.debord };
}
