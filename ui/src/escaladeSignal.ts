/*
 * T-074 — signal d'escalade : repérer les tours où un petit modèle a été
 * essayé puis refait par un plus gros (RouterArena, « routing optimality » —
 * docs/etude-supervision.md §5.3/§7.7). C'est la seule mesure qui prouve
 * qu'un routage est BON, pas seulement bon marché.
 *
 * ── Décision d'arbitrage POUR RESTER HONNÊTE ──────────────────────────────
 * Seule l'escalade INCONTESTABLE est comptée : dans une même conversation, un
 * tour en ERREUR sur un tier, suivi IMMÉDIATEMENT (le tour suivant de la même
 * conversation) par un tour sur un tier STRICTEMENT supérieur. « Qualité
 * insuffisante sans erreur » n'est pas mesurable sans juge (§7.5, écarté pour
 * la même raison que le « coût par tâche réussie ») — on ne l'invente pas, et
 * l'encart qui affichera ce signal DOIT dire que seule l'escalade sur échec
 * est comptée : le silence sur cette limite mentirait par omission.
 *
 * ── La hiérarchie de tiers est RÉUTILISÉE, pas recopiée ──────────────────
 * `ROUTE_TIERS`/`DEFAULT_ROUTING_TABLE` viennent de `routerAdmin.ts`, le
 * miroir client du barème de routage du sidecar (`router.ts`) — même défaut
 * qui classe déjà les tiers de complexité. Un modèle absent de ce barème
 * (fable-5, opus-4-8…) n'est simplement PAS COMPARABLE : on ne devine pas son
 * rang, on l'exclut (même discipline que le minorant de la ventilation T-066).
 *
 * ── Ce qui manque pour l'alimenter en vrai ────────────────────────────────
 * Cette fonction attend une liste de tours ORDONNÉE PAR CONVERSATION, avec
 * modèle et statut par tour — une donnée qu'aucune méthode de protocole ne
 * sert aujourd'hui (`usage.stats` n'agrège que des totaux par tranche, jamais
 * le détail par tour). La brancher sur de vraies données demande d'étendre
 * `usage.stats` (ou une méthode dédiée) et de documenter le nouveau champ
 * dans docs/protocol.md — décision hors du périmètre de ce chantier, signalée
 * plutôt que prise ici. Le calcul, lui, est prêt et testé.
 */
import { DEFAULT_ROUTING_TABLE, ROUTE_TIERS } from "./routerAdmin";
import type { RouteTier } from "./sidecar";

/** Un tour, tel qu'il faudrait le recevoir pour alimenter ce calcul en vrai. */
export interface TourPourEscalade {
  conversationId: string;
  /** ISO — sert seulement à ORDONNER les tours d'une même conversation. */
  ts: string;
  model: string;
  erreur: boolean;
}

export interface SignalEscalade {
  /** Paires « erreur → tier strictement supérieur » comptées. */
  toursEscalade: number;
  conversationsAvecEscalade: number;
  /** Dénominateur honnête : pannes dont le tier ET celui du tour suivant sont CONNUS du barème. */
  toursErreurComparables: number;
}

/** Modèle → tier le plus élevé où il apparaît dans le barème par défaut. Absent = non comparable. */
function tableModeleTier(): Map<string, RouteTier> {
  const table = new Map<string, RouteTier>();
  for (const tier of ROUTE_TIERS) {
    const cible = DEFAULT_ROUTING_TABLE[tier];
    if (cible.engine !== "claude") continue;
    const actuel = table.get(cible.model);
    if (!actuel || ROUTE_TIERS.indexOf(tier) > ROUTE_TIERS.indexOf(actuel)) {
      table.set(cible.model, tier);
    }
  }
  return table;
}

export function calculerSignalEscalade(tours: readonly TourPourEscalade[]): SignalEscalade {
  const modeleTier = tableModeleTier();
  const parConversation = new Map<string, TourPourEscalade[]>();
  for (const t of tours) {
    const liste = parConversation.get(t.conversationId) ?? [];
    liste.push(t);
    parConversation.set(t.conversationId, liste);
  }

  let toursEscalade = 0;
  let toursErreurComparables = 0;
  const conversationsAvecEscalade = new Set<string>();

  for (const [conversationId, liste] of parConversation) {
    // Ordre chronologique — l'appelant peut fournir les tranches dans le désordre.
    const ordonnes = [...liste].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (let i = 0; i < ordonnes.length - 1; i++) {
      const cur = ordonnes[i];
      if (!cur.erreur) continue;
      const next = ordonnes[i + 1];
      const tierCur = modeleTier.get(cur.model);
      const tierNext = modeleTier.get(next.model);
      if (tierCur === undefined || tierNext === undefined) continue;
      toursErreurComparables += 1;
      if (ROUTE_TIERS.indexOf(tierNext) > ROUTE_TIERS.indexOf(tierCur)) {
        toursEscalade += 1;
        conversationsAvecEscalade.add(conversationId);
      }
    }
  }

  return { toursEscalade, conversationsAvecEscalade: conversationsAvecEscalade.size, toursErreurComparables };
}
