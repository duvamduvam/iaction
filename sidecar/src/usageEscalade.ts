/*
 * T-074 — signal d'escalade : la donnée MINIMALE nécessaire pour repérer,
 * côté client, les tours où un petit modèle a été essayé puis refait par un
 * plus gros (RouterArena, « routing optimality » — voir
 * docs/etude-supervision.md §5.3/§7.7). Module à part, même patron que
 * `usageSobriete.ts`/`usageProjets.ts` : accumulateur en entrée, objet en
 * sortie, aucune E/S.
 *
 * ── Pourquoi le calcul reste côté UI, et pas ici ──────────────────────────
 * `ui/src/escaladeSignal.ts` porte déjà l'algorithme, PUR et TESTÉ (T-074,
 * 2026-08-29) : seule l'escalade INCONTESTABLE compte — un tour en ERREUR
 * suivi IMMÉDIATEMENT (le tour suivant de la MÊME conversation) par un tour
 * sur un tier STRICTEMENT supérieur, un modèle absent du barème de routage
 * n'étant pas comparable. Le recopier ici ferait vivre deux implémentations
 * de la même règle, avec le risque qu'elles divergent en silence. Ce module
 * se borne à SERVIR ce dont l'algorithme a besoin : `conversationId`, `ts`,
 * `model`, `erreur`. Rien d'autre — ni tokens, ni coût, ni message d'erreur :
 * un champ minimal, pas un dump du journal.
 *
 * ── Ce qui est gardé, ce qui est écarté ────────────────────────────────────
 * Un événement sans `conversationId` ou sans `ts` ne peut PAS se placer dans
 * une séquence : il est écarté, jamais deviné (même discipline que le
 * minorant de la ventilation T-066 — un signal approximatif est pire qu'un
 * signal absent). Un événement sans `model` connu est en revanche GARDÉ
 * (`model: "(inconnu)"`) : le supprimer romprait l'adjacence entre le tour
 * précédent et le tour suivant, et ferait paraître consécutifs deux tours qui
 * ne l'étaient pas réellement. L'algorithme classe ensuite ce modèle comme
 * non comparable — c'est le comportement honnête, pas une approximation.
 */
import { isNonEmptyString, isPlainObject } from "./base.js";

/** Une ligne minimale — même forme que `TourPourEscalade` côté UI (escaladeSignal.ts). */
export interface TourEscalade {
  conversationId: string;
  ts: string;
  model: string;
  erreur: boolean;
}

export interface EscaladeAgg {
  tours: TourEscalade[];
}

export function newEscaladeAgg(): EscaladeAgg {
  return { tours: [] };
}

export function applyEscaladeEvent(agg: EscaladeAgg, ev: unknown): void {
  if (!isPlainObject(ev) || !isNonEmptyString(ev.conversationId) || !isNonEmptyString(ev.ts)) {
    return;
  }
  agg.tours.push({
    conversationId: ev.conversationId,
    ts: ev.ts,
    model: isNonEmptyString(ev.model) ? ev.model : "(inconnu)",
    erreur: ev.status === "error",
  });
}

export function finalizeEscalade(agg: EscaladeAgg): TourEscalade[] {
  return agg.tours;
}
