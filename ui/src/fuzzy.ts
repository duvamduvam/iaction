/*
 * Correspondance floue par sous-séquence, partagée par la palette de projets
 * (CommandPalette) et le sélecteur de modèle (modelPickerCalc).
 *
 * Sortie de CommandPalette.tsx le 2026-08-12 sans changer une ligne de son
 * comportement : le sélecteur de modèle avait besoin exactement du même
 * filtre, et une seconde implémentation « presque pareille » du classement
 * est le genre de divergence qu'on ne remarque qu'au bug.
 */

/**
 * Sous-séquence insensible à la casse : `query` doit apparaître, dans
 * l'ordre, dans `text` (caractères non forcément contigus). Renvoie
 * l'étendue (indice de fin − indice de début) du match le plus compact
 * trouvé par un simple parcours glouton, ou `null` si aucun match — sert de
 * score de pertinence (plus petit = meilleur).
 */
export function fuzzyScore(text: string, query: string): number | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let qi = 0;
  let start = -1;
  while (ti < t.length && qi < q.length) {
    if (t[ti] === q[qi]) {
      if (start === -1) start = ti;
      qi += 1;
    }
    ti += 1;
  }
  if (qi < q.length) return null;
  return ti - start;
}
