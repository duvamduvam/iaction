/*
 * Reconnaissance de la famille d'erreurs HMR (T-116).
 *
 * POURQUOI un module à part : la reconnaissance doit être une FONCTION PURE,
 * testable sans React ni Vite, pour ne baisser le niveau QUE sur les messages
 * qu'un graphe HMR périmé produit réellement — un crash de rendu qui n'en fait
 * pas partie doit rester aussi grave qu'avant. Périmètre exact constaté dans
 * le journal (T-116) et couvert ici pour les deux moteurs système de Tauri
 * (WebKitGTK sur Linux, WebView2/Chromium sur Windows) :
 * - WebKit : « Can't find variable: X »
 * - Chromium/V8 : « X is not defined »
 * - variable non initialisée (TDZ) : « Cannot access 'X' before
 *   initialization » (V8) / « can't access lexical declaration 'X' before
 *   initialization » (Firefox/SpiderMonkey)
 * - React : « Rendered fewer hooks than expected » (le nombre de hooks change
 *   quand HMR remplace un composant dont une branche a été éditée)
 */

const MOTIFS_ARTEFACT_HMR: readonly RegExp[] = [
  // WebKit — « Can't find variable: splitFeatured »
  /^can[’']t find variable:/i,
  // Chromium/V8 — « splitFeatured is not defined »
  /\bis not defined\.?$/i,
  // TDZ — V8 : « Cannot access 'X' before initialization » ;
  // Firefox : « can't access lexical declaration 'X' before initialization »
  /\bbefore initialization\.?$/i,
  // React — hooks conditionnels après une édition qui change leur nombre
  /^rendered fewer hooks than expected\b/i,
];

/**
 * `true` si `message` (le message d'erreur JS brut, PAS le libellé préfixé du
 * journal) appartient à la famille des artefacts HMR décrite ci-dessus.
 */
export function estArtefactHmr(message: string): boolean {
  const propre = message.trim();
  if (!propre) return false;
  return MOTIFS_ARTEFACT_HMR.some((motif) => motif.test(propre));
}
