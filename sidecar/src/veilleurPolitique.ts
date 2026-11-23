/*
 * Veilleur du relais (docs/etude-veilleur-relais.md) — la POLITIQUE : décider,
 * sans effet de bord, si un message reçu doit être exécuté, et borner le
 * dialogue autonome. Feuille pure, testable seule ; le câblage (relève,
 * tour d'agent, journal) vit ailleurs.
 *
 * Quatre garde-fous du § 3.5, réduits à des fonctions pures :
 *  - seule la maison (les émetteurs écoutés) déclenche un tour ;
 *  - un `id` déjà traité n'est jamais rejoué ;
 *  - un fil ne dépasse pas la profondeur de dialogue autorisée ;
 *  - un message trop coûteux, ou au-delà du quota de tours du jour, est refusé.
 *
 * Aucune de ces fonctions ne lit l'horloge, le disque ou le réseau : l'appelant
 * fournit l'état (ids déjà traités, nombre de tours du jour, coût estimé).
 */

export interface Plafonds {
  /** Allers-retours sans humain autorisés par fil (profondeur max). */
  profondeur: number;
  /** Coût maximal estimé d'un message, en $ (0 ou moins = pas de plafond). */
  coutParMessage: number;
  /** Tours autorisés par jour sur ce veilleur (0 ou moins = pas de plafond). */
  toursParJour: number;
}

/** Un message est-il émis par un studio écouté ? Comparaison exacte. */
export function expediteurEcoute(de: string, ecoutes: readonly string[]): boolean {
  return ecoutes.includes(de);
}

/** Cet `id` a-t-il déjà été traité (réponse déjà produite) ? */
export function dejaTraite(id: string, idsTraites: readonly string[]): boolean {
  return idsTraites.includes(id);
}

/** Profondeur du prochain message de ce fil. */
export function profondeurSuivante(profondeur: number): number {
  return profondeur + 1;
}

/**
 * Le fil doit-il s'arrêter (plus d'enchaînement autonome) ? Vrai dès que la
 * profondeur atteint le plafond : au-delà, le veilleur répond en `info` et
 * laisse la main à un humain.
 */
export function filDoitSArreter(profondeur: number, plafond: number): boolean {
  return profondeur >= plafond;
}

/** Raison de refus d'un message, ou `null` s'il peut être exécuté. */
export interface ContexteRefus {
  /** Émetteur déclaré par le broker (prouvé par le jeton). */
  de: string;
  /** Émetteurs écoutés (config du veilleur). */
  ecoutes: readonly string[];
  /** `id` du message. */
  id: string;
  /** Profondeur portée par le message. */
  profondeur: number;
  /** Coût estimé du tour, en $ (ou null si inconnu : pas de refus sur ce motif). */
  coutEstime: number | null;
  /** Tours déjà faits aujourd'hui par ce veilleur. */
  toursAujourdhui: number;
  idsTraites: readonly string[];
  plafonds: Plafonds;
}

/**
 * Pourquoi ce message ne serait PAS exécuté, ou `null` s'il l'est. Ordre
 * voulu : d'abord ce qui ne doit même pas laisser de trace de refus répondu à
 * l'émetteur (émetteur inconnu → on ignore en silence côté boîte), puis les
 * refus qui, eux, méritent une réponse à l'émetteur.
 *
 * `silencieux` distingue les deux : un émetteur non écouté n'a pas à savoir
 * qu'on l'a ignoré ; un dépassement de plafond, lui, se répond.
 */
export function motifRefus(c: ContexteRefus): { motif: string; silencieux: boolean } | null {
  if (!expediteurEcoute(c.de, c.ecoutes)) {
    return { motif: `émetteur « ${c.de} » non écouté`, silencieux: true };
  }
  if (dejaTraite(c.id, c.idsTraites)) {
    return { motif: `message « ${c.id} » déjà traité`, silencieux: true };
  }
  if (filDoitSArreter(c.profondeur, c.plafonds.profondeur)) {
    return {
      motif: `profondeur ${c.profondeur} ≥ plafond ${c.plafonds.profondeur} : le fil attend un humain`,
      silencieux: false,
    };
  }
  if (c.plafonds.toursParJour > 0 && c.toursAujourdhui >= c.plafonds.toursParJour) {
    return {
      motif: `quota de ${c.plafonds.toursParJour} tours/jour atteint`,
      silencieux: false,
    };
  }
  if (c.plafonds.coutParMessage > 0 && c.coutEstime !== null && c.coutEstime > c.plafonds.coutParMessage) {
    return {
      motif: `coût estimé ${c.coutEstime.toFixed(2)} $ > plafond ${c.plafonds.coutParMessage.toFixed(2)} $`,
      silencieux: false,
    };
  }
  return null;
}
