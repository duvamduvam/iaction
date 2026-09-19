/*
 * Titre AFFICHÉ d'un onglet de conversation — T-122, levier A.
 *
 * ── Le défaut corrigé ────────────────────────────────────────────────────
 * Le titre auto d'une session est le DÉBUT du premier message
 * (`deriveTitleFromText`, sessionStore.ts), puis le CSS le recoupe encore par
 * la droite (`.agent-tab__name`, `text-overflow: ellipsis`). Deux troncatures
 * par la fin. Or dans une barre d'onglets, ce qui sert à retrouver le bon
 * onglet n'est pas le début du titre : c'est ce qui le DISTINGUE des autres.
 * Et le début est justement ce que des messages voisins partagent le plus
 * souvent. Constat du 2026-09-05, onze onglets ouverts : trois affichaient
 * « Regarde les… » et se coupaient avant le mot qui les séparait.
 *
 * ── La règle ─────────────────────────────────────────────────────────────
 * Un titre est comparé aux AUTRES onglets ouverts à cet instant. Le plus long
 * préfixe de MOTS qu'il partage avec l'un d'eux est replié en « … », et la
 * place ainsi gagnée montre la suite :
 *
 *   « Regarde les tickets P1 encore ouverts »   → « …P1 encore ouverts »
 *   « Regarde les tickets fermés cette semaine » → « …fermés cette semaine »
 *   « Regarde les logs du sidecar de ce matin »  → « …logs du sidecar de ce matin »
 *
 * Un titre qui ne partage rien avec personne n'est pas touché : le repli ne
 * se déclenche que là où il y a collision, et il disparaît de lui-même quand
 * l'onglet rival se ferme.
 *
 * ── Ce que ce module ne fait PAS ─────────────────────────────────────────
 * Il ne renomme rien. Le titre STOCKÉ (`SessionMeta.title`) ne bouge pas :
 * l'infobulle de l'onglet, la liste des sessions et le titre personnalisé par
 * l'utilisateur gardent le texte entier. Seul l'affichage dans la barre est
 * recalculé au rendu, à partir des onglets ouverts à cet instant — deux
 * barres différentes peuvent donc afficher la même session différemment, et
 * c'est voulu : le repli est une réponse au VOISINAGE, pas une propriété de
 * la session.
 *
 * Il ne traite pas non plus les onglets de FICHIER : deux fichiers de même
 * nom se distinguent par leur dossier (un suffixe), pas par un préfixe
 * commun. Ce serait une autre règle, et elle n'a pas été constatée.
 */

/** Séparateur de repli. Un seul caractère : la barre est déjà serrée. */
const ELLIPSE = "…";

/**
 * Nombre minimal de mots communs pour qu'un repli se déclenche.
 *
 * À un seul mot, l'échange est mauvais : on rend une ellipse (qui ne dit
 * rien) contre un mot (qui en dit un peu). À deux, la place gagnée dépasse
 * toujours ce qu'elle coûte.
 */
const MOTS_COMMUNS_MIN = 2;

/** Découpe sur toute suite d'espaces — un titre venu du modèle ou renommé à la main n'est pas normalisé. */
function mots(titre: string): string[] {
  const propre = titre.trim();
  return propre === "" ? [] : propre.split(/\s+/);
}

/** Nombre de mots de tête identiques (à la casse près) entre deux découpes. */
function motsCommuns(a: readonly string[], b: readonly string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n].toLowerCase() === b[n].toLowerCase()) n++;
  return n;
}

/**
 * Les libellés à afficher, dans l'ORDRE des titres reçus (une entrée par
 * onglet, toujours — l'appelant indexe par position).
 *
 * Deux titres identiques ne sont jamais repliés : le préfixe commun est alors
 * le titre entier, il ne resterait rien à montrer. On préfère deux onglets
 * pareils à deux onglets vides — et le cas est déjà tenu ailleurs
 * (`appliquerTitresIA` garde un repli distinctif plutôt qu'un doublon).
 */
export function titresDistinctifs(titres: readonly string[]): string[] {
  const decoupes = titres.map(mots);
  return titres.map((titre, i) => {
    let commun = 0;
    for (let j = 0; j < decoupes.length; j++) {
      if (j === i) continue;
      const n = motsCommuns(decoupes[i], decoupes[j]);
      if (n > commun) commun = n;
    }
    if (commun < MOTS_COMMUNS_MIN || commun >= decoupes[i].length) return titre;
    return ELLIPSE + decoupes[i].slice(commun).join(" ");
  });
}
