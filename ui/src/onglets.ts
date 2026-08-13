/**
 * Navigation entre les onglets de conversation — partagée par le Chat et les
 * Projets.
 *
 * Une seule règle, mais elle est de celles qu'on écrit de travers une fois sur
 * deux : le cycle est CIRCULAIRE, donc l'index négatif doit revenir en fin de
 * liste. `(-1) % n` vaut `-1` en JavaScript, pas `n - 1` — d'où le `+ ids.length`
 * avant le modulo. C'est exactement le genre de détail qu'un test protège et
 * qu'une relecture laisse passer.
 *
 * Sorti des pages où il était écrit deux fois (99 % identiques au relevé du
 * 2026-08-08). La fonction est pure : elle CHOISIT l'onglet suivant, elle ne
 * l'active pas — les pages gardent la main sur ce que « activer » veut dire.
 */

/**
 * L'onglet à activer, ou `null` s'il n'y a rien à faire (moins de deux
 * onglets ouverts).
 *
 * Un `actif` absent de la liste n'est pas une erreur : on repart du premier
 * onglet, ce qui est le comportement attendu quand la conversation courante
 * vient d'être fermée.
 */
export function prochainOnglet(ids: readonly string[], actif: string, direction: 1 | -1): string | null {
  if (ids.length < 2) return null;
  const position = ids.indexOf(actif);
  const depart = position === -1 ? 0 : position;
  return ids[(depart + direction + ids.length) % ids.length];
}
