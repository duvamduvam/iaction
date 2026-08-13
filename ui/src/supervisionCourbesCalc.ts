/*
 * Calculs purs du graphique de courbes de Supervision — sans React ni DOM,
 * donc testables (voir supervisionCourbesCalc.test.ts). Ce sont les deux
 * endroits où le graphe peut devenir illisible sans que rien n'échoue :
 * l'indexation (division par le maximum) et le désempilage des étiquettes.
 */

/** Écart vertical minimal entre deux étiquettes de bout de courbe, en pixels. */
export const LABEL_GAP = 13;

/**
 * Une série ramenée à SON propre maximum sur la fenêtre. `pct` vaut `null`
 * partout où la valeur brute est absente : un trou dans la courbe, pas un zéro
 * — une moyenne qu'on n'a pas mesurée n'est pas une moyenne nulle.
 *
 * `max === 0` (série entièrement vide ou nulle) ne divise jamais : tous les
 * points retombent à 0 % et l'appelant n'affiche pas la courbe.
 */
export function indexerSerie(valeurs: Array<number | null>): { max: number; pct: Array<number | null> } {
  const max = valeurs.reduce<number>((m, v) => (v !== null && v > m ? v : m), 0);
  function part(v: number | null): number | null {
    if (v === null) return null;
    return max > 0 ? (v / max) * 100 : 0;
  }
  return { max, pct: valeurs.map(part) };
}

/**
 * Découpe une suite de points en SEGMENTS CONTINUS, en coupant à chaque trou.
 *
 * Sans ça, une polyligne unique relie simplement le point d'avant au point
 * d'après : le trou disparaît, et une période sans mesure se lit comme une
 * mesure interpolée — exactement le mensonge que le trou servait à éviter.
 */
export function segmenter<T>(points: Array<T | null>): T[][] {
  const out: T[][] = [];
  let courant: T[] = [];
  for (const p of points) {
    if (p === null) {
      if (courant.length > 0) out.push(courant);
      courant = [];
    } else {
      courant.push(p);
    }
  }
  if (courant.length > 0) out.push(courant);
  return out;
}

/**
 * Positions d'étiquettes désempilées : l'ordre vertical des courbes est
 * conservé, mais deux étiquettes ne se superposent jamais. Le résultat reste
 * dans `[min, max]` — une étiquette poussée hors du cadre serait pire que
 * deux étiquettes serrées.
 */
export function desempiler(ys: number[], min: number, max: number): number[] {
  const ordre = ys.map((y, i) => ({ i, y })).sort((a, b) => a.y - b.y);
  const out: number[] = new Array(ys.length).fill(min);
  let precedent = -Infinity;
  for (const p of ordre) {
    const y = Math.min(max, Math.max(min, Math.max(p.y, precedent + LABEL_GAP)));
    out[p.i] = y;
    precedent = y;
  }
  return out;
}
