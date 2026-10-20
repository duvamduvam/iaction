/*
 * Alt+chiffre → onglet (T-122, levier C) — la correspondance, pas l'écoute.
 *
 * ── Pourquoi Alt et pas Ctrl ─────────────────────────────────────────────
 * Ctrl+1 à Ctrl+6 servent déjà la navigation entre PAGES (raccourcisClavier.ts,
 * App.tsx), et sur ce poste GNOME s'est approprié Ctrl+Alt (voir sondeFrappe.ts).
 * Alt+chiffre reste donc le seul créneau libre pour un accès direct à un
 * onglet — comme Alt+flèche l'est déjà pour les zones (focusZones.ts).
 *
 * ── La convention retenue : celle des navigateurs ────────────────────────
 * Chrome et Firefox : Ctrl/Cmd+1 à Ctrl/Cmd+8 vont à l'onglet de cette
 * POSITION, Ctrl/Cmd+9 va toujours au DERNIER onglet, quel que soit son
 * numéro réel. Reprise ici à l'identique (avec Alt) plutôt qu'inventer une
 * dixième convention : elle est déjà connue, et elle couvre exactement le
 * cas qui a motivé le ticket (onze onglets ouverts — le dernier reste
 * atteignable d'une frappe même quand il n'a pas de chiffre à lui).
 * Les positions 9 à N-1 (quand il y a plus de neuf onglets) n'ont pas de
 * raccourci direct : elles restent accessibles par Ctrl+Tab, de proche en
 * proche, comme aujourd'hui.
 *
 * ── Numéro AFFICHÉ ────────────────────────────────────────────────────────
 * Il suit la POSITION dans la barre (index + 1), pas l'identité de la
 * conversation ni du fichier — un onglet fermé décale les numéros de ses
 * voisins de droite, exactement comme leur position visuelle. Ce calcul est
 * trivial (une addition) et reste dans `BarreOnglets.tsx` ; seule la
 * correspondance touche ↔ position, elle, mérite un test.
 */

/** Plus haute position directement joignable par son propre chiffre (Alt+1…Alt+8). */
const DERNIERE_POSITION_DIRECTE = 8;

/** Chiffre conventionnellement réservé au dernier onglet, quelle que soit sa position. */
const CHIFFRE_DERNIER = 9;

/**
 * Onglet ciblé par Alt+`chiffre`, sur une barre de `total` onglets ouverts
 * (conversations puis fichiers, dans l'ordre d'affichage — voir
 * `BarreOnglets.tsx`). `null` si le chiffre ne désigne aucun onglet (chiffre
 * hors 1-9, barre vide, ou position au-delà du nombre d'onglets ouverts).
 *
 * Retourne un INDEX 0-based dans cet ordre d'affichage.
 */
export function ongletPourChiffre(chiffre: number, total: number): number | null {
  if (total <= 0) return null;
  if (!Number.isInteger(chiffre) || chiffre < 1 || chiffre > CHIFFRE_DERNIER) return null;
  if (chiffre === CHIFFRE_DERNIER) return total - 1;
  if (chiffre > total) return null;
  return chiffre - 1;
}

/**
 * Le libellé du raccourci direct qui atteint la position `index` (0-based)
 * sur une barre de `total` onglets, `null` s'il n'y en a pas.
 *
 * Sert à documenter le raccourci dans le `title`/`aria-label` de l'onglet
 * (découvrabilité) — jamais à décider quoi que ce soit d'autre. Une position
 * qui coïncide à la fois avec sa propre touche ET avec « dernier » (barre de
 * neuf onglets ou moins) n'affiche qu'UN seul libellé : les deux touches
 * mènent au même endroit, en montrer deux n'apprendrait rien de plus.
 */
export function raccourciDeLaPosition(index: number, total: number): string | null {
  if (index < 0 || index >= total) return null;
  if (index < DERNIERE_POSITION_DIRECTE) return `Alt+${index + 1}`;
  if (index === total - 1) return `Alt+${CHIFFRE_DERNIER}`;
  return null;
}
