/*
 * Filtrage des transcriptions « fantômes » (hallucinations de Whisper).
 *
 * ── Le problème ─────────────────────────────────────────────────────────
 * Whisper — et ses dérivés distants — n'a pas de notion de « rien à dire ».
 * Nourri d'un segment de silence, de souffle de ventilateur ou d'un claquement
 * de porte, il produit tout de même du texte : celui qu'il a le plus vu à la
 * fin des vidéos de son corpus d'entraînement (sous-titres YouTube, archives de
 * la SRC, formules d'au revoir). C'est un artefact CONNU et reproductible, pas
 * un bug de notre chaîne audio.
 *
 * En dictée ponctuelle ce n'est qu'agaçant : l'utilisateur relit et corrige.
 * En mode conversation mains libres, c'est bloquant — chaque hallucination
 * partirait au LLM comme un vrai tour de parole. D'où ce filtre, appliqué
 * juste avant `onUtterance` (voir voiceConversation.ts).
 *
 * ── Méthode ─────────────────────────────────────────────────────────────
 * Comparaison NORMALISÉE (minuscules, accents retirés, ponctuation retirée,
 * espaces compactés) : « Merci d'avoir regardé cette vidéo ! », « merci
 * d'avoir regarde cette video... » et « MERCI D'AVOIR REGARDÉ CETTE VIDÉO »
 * se ramènent tous à la même chaîne. Cela règle d'un coup les innombrables
 * variantes de ponctuation finale (point, points de suspension, point
 * d'exclamation, rien du tout) que produit le modèle.
 */

/**
 * Motifs d'hallucination connus, en clair et non normalisés — c'est
 * volontaire : la liste doit rester LISIBLE et facile à amender. La
 * normalisation est appliquée à la volée (voir `HALLUCINATION_SET`), donc on
 * peut y écrire les phrases avec leurs accents et leur ponctuation naturelle.
 *
 * ATTENTION : liste EMPIRIQUE, constatée à l'usage, et forcément incomplète.
 * Chaque nouveau modèle (ou nouvelle langue) apporte ses propres formules.
 * Quand une phrase fantôme apparaît en conversation, l'ajouter ici — et
 * seulement ici — suffit à la faire taire.
 */
export const HALLUCINATION_PATTERNS: string[] = [
  // Français — sous-titres de fin de vidéo
  "Sous-titres réalisés par la communauté d'Amara.org",
  "Sous-titrage Société Radio-Canada",
  "Merci d'avoir regardé cette vidéo",
  "Merci à tous",
  "Abonnez-vous",
  // Anglais — mêmes réflexes, corpus YouTube
  "Thanks for watching",
  "Thank you for watching",
  "Please subscribe",
  "Subtitles by the Amara.org community",
  // Résidus d'un seul mot, très fréquents sur du silence pur
  "you",
  "bye",
  // Politesses et hésitations produites sur du blanc — relevées le 2026-09-06
  // en mode conversation, où elles polluaient le brouillon à chaque respiration
  // (« … Mmm. Merci. Merci. »). Perdre un « merci » réellement prononcé est
  // sans conséquence : il ne portait aucune consigne.
  "Merci",
  "Merci beaucoup",
  "Mmm",
  "Hmm",
  "Hum",
  "Euh",
];

/**
 * Mots courts mais réellement porteurs de sens : sans cette liste, la règle
 * « un mot de deux caractères ou moins est du bruit » avalerait des réponses
 * légitimes. Comparés sous forme normalisée.
 */
const USEFUL_SHORT_WORDS = new Set(["ok", "si", "va", "vu", "du", "la", "ca", "no"]);

/**
 * Normalisation de comparaison :
 * 1. minuscules ;
 * 2. décomposition Unicode (NFD) puis suppression des diacritiques — « é » et
 *    « e » deviennent identiques, car le modèle accentue de façon instable ;
 * 3. tout ce qui n'est ni lettre ni chiffre devient une espace : ponctuation,
 *    apostrophes (droites comme typographiques), tirets, points de suspension ;
 * 4. compactage des espaces et rognage.
 */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Motifs pré-normalisés, calculés une seule fois au chargement du module. */
const HALLUCINATION_SET = new Set(HALLUCINATION_PATTERNS.map(normalizeForCompare));

/**
 * Annotation sonore que le modèle invente sur un bruit : « *bruit de choc* »,
 * « [Musique] », « (rires) ». Jamais une parole de l'utilisateur.
 */
const ANNOTATION_SONORE = /^(\*[^*]*\*|\[[^\]]*\]|\([^)]*\))$/;

/** Au-delà, un morceau qui commence par « Sous-titrage » est tenu pour une vraie phrase. */
const SOUS_TITRAGE_MAX_MOTS = 6;

/**
 * Découpe un segment en MORCEAUX : phrases closes par « . ! ? … », retours à
 * la ligne, et doubles espaces — la couture que laisse le modèle quand il
 * recolle plusieurs passes (« Merci.  Merci.  Sous-titrage… »).
 */
function decouperEnMorceaux(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\s{2,}|\n+/u)
    .map((m) => m.trim())
    .filter(Boolean);
}

/** Un MORCEAU isolé est-il un déchet (formule fantôme, annotation, crédit de sous-titrage) ? */
function morceauFantome(morceau: string): boolean {
  if (ANNOTATION_SONORE.test(morceau)) return true;
  const normalized = normalizeForCompare(morceau);
  if (!normalized) return true;
  if (HALLUCINATION_SET.has(normalized)) return true;
  // Crédits de sous-titrage aux variantes sans fin (« Sous-titrage ST' 501 »,
  // « Sous-titres par… ») : reconnus à leur attaque, tant qu'ils restent courts.
  return /^sous titr(age|es)\b/.test(normalized) && normalized.split(" ").length <= SOUS_TITRAGE_MAX_MOTS;
}

/**
 * Retire d'un segment les morceaux fantômes et rend le reste, recollé par une
 * espace. Rend une chaîne vide si rien d'utile ne subsiste.
 *
 * POURQUOI — constat du 2026-10-05, casque Bluetooth au micro bruité : la
 * détection d'activité se déclenchait sur le souffle, et le modèle rendait des
 * segments COMPOSÉS (« Merci.  Merci.  Sous-titrage Société Radio-Canada »,
 * treize « Merci. » d'affilée, « *bruit de choc* »). La comparaison du segment
 * ENTIER à la liste ne reconnaissait aucun de ces assemblages : ils
 * s'empilaient dans le brouillon plus vite que l'utilisateur ne les effaçait.
 *
 * Reste conservateur : un morceau n'est retiré que s'il est, À LUI SEUL, une
 * formule connue. « Merci à tous d'être venus » n'est pas découpé et passe.
 */
export function retirerHallucinations(text: string): string {
  return decouperEnMorceaux(text)
    .filter((m) => !morceauFantome(m))
    .join(" ");
}

/**
 * Le texte transcrit est-il, selon toute vraisemblance, une hallucination ou
 * un déchet à ne PAS transmettre au reste de l'application ?
 *
 * Renvoie `true` pour :
 * - un texte vide, ou composé uniquement d'espaces, de ponctuation et de
 *   points de suspension (« ... », « . », « ♪ ») ;
 * - une des formules toutes faites de `HALLUCINATION_PATTERNS`, ou un
 *   assemblage qui n'est fait QUE de telles formules ;
 * - un texte d'un seul mot de deux caractères ou moins qui ne figure pas dans
 *   la courte liste des mots utiles (« ok », « si »…).
 *
 * Le filtre est volontairement CONSERVATEUR sur tout le reste : mieux vaut
 * laisser passer une phrase douteuse que perdre un vrai tour de parole.
 */
export function isLikelyHallucination(text: string): boolean {
  const normalized = normalizeForCompare(text);

  // Vide après normalisation : il n'y avait que de la ponctuation ou des
  // espaces (« ... », « — », « ♪♪ »), donc aucun contenu exploitable.
  if (!normalized) return true;

  if (HALLUCINATION_SET.has(normalized)) return true;

  // Segment COMPOSÉ uniquement de morceaux fantômes (voir `retirerHallucinations`).
  if (!retirerHallucinations(text)) return true;

  const words = normalized.split(" ");
  if (words.length === 1 && words[0].length <= 2 && !USEFUL_SHORT_WORDS.has(words[0])) {
    return true;
  }

  return false;
}
