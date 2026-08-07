/*
 * Détection du mot-clé d'envoi en fin de dictée.
 *
 * ── Le problème ─────────────────────────────────────────────────────────
 * En dictée, l'envoi du message repose soit sur le clavier (Entrée), soit sur
 * les silences (mode conversation) — deux gestes qui trahissent l'idée même du
 * « mains libres » : l'un rend le clavier obligatoire, l'autre laisse la
 * segmentation décider À LA PLACE de l'utilisateur. Ce module donne le
 * contrôle à la voix : dire le mot-clé en fin de phrase déclenche l'envoi,
 * exactement comme un clic sur le bouton Envoyer.
 *
 * ── Le choix du mot-clé (réglage `conversation.sendKeyword`) ────────────
 * Le mot-clé est configurable, et son défaut est « transmets » — un mot RARE
 * en fin de phrase et phonétiquement stable, retenu après l'échec du candidat
 * naturel « envoie ». Ce dernier cumulait deux fragilités constatées en usage
 * réel : Whisper le réécrit en graphies contextuelles (« l'envoi ?»,
 * « en voie. ») pour rendre la phrase fluide, et c'est un mot fréquent des
 * prompts eux-mêmes (on y parle d'envois de documents). Un mot rare supprime
 * les deux problèmes d'un coup.
 *
 * ── Tolérance aux graphies ──────────────────────────────────────────────
 * Whisper orthographie au petit bonheur : la comparaison est normalisée
 * (minuscules, accents retirés) et tolère un « s » final en plus ou en moins
 * (« transmet » / « transmets »). Si l'utilisateur choisit malgré tout un mot
 * de la famille « envoie », toute la mécanique spécifique apprise à la dure
 * s'applique : homophones (envoi, envoyer…), recollage élidé (« l'envoi »),
 * découpage (« en voie » — un « envoie » entendu [ɑ̃vwa] réécrit en deux
 * mots), et garde-fous grammaticaux (« que je t'envoie », « je l'envoie »,
 * « tu en vois » ne déclenchent pas).
 *
 * ── Philosophie : permissif sur la forme, strict sur la grammaire ───────
 * Un faux négatif (mot-clé ignoré, texte pollué, rien ne part) coûte plus
 * cher qu'un envoi un peu précoce — le message allait partir de toute façon.
 * On déclenche donc dès que la dictée SE TERMINE par le mot-clé, et on ne
 * bloque que les usages manifestement grammaticaux (élision ou pronom devant).
 */

/** Mot-clé par défaut — voir l'en-tête pour la justification du choix. */
export const DEFAULT_SEND_KEYWORD = "transmets";

/** Formes normalisées de la famille « envoie » — homophones sous la plume de Whisper. */
const ENVOIE_FORMS = new Set(["envoi", "envois", "envoie", "envoies", "envoye", "envoyer", "envoyez"]);

/**
 * Secondes moitiés du mot-clé « envoie » DÉCOUPÉ : [ɑ̃vwa] réécrit « en » +
 * une graphie de [vwa]. Reconnues uniquement précédées du mot « en ».
 */
const VOIE_FORMS = new Set(["voie", "voies", "voix", "vois", "voit"]);

/**
 * Ponctuation fermante tolérée APRÈS le mot-clé : Whisper conclut presque
 * toujours par un point, parfois par « ! », « ? » ou des guillemets fermants.
 */
const TRAILING_PUNCT = new Set([".", ",", "!", "?", "…", ";", ":", "'", "’", '"', "»", ")"]);

/**
 * Mot précédent qui signe un usage verbal réel du mot-clé (« je l'envoie »,
 * « le rapport que je te transmets », « c'est lui qui envoie ») : on ne
 * déclenche pas. Formes normalisées (sans accents).
 */
const PRONOUNS_BEFORE = new Set([
  "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles",
  "me", "te", "se", "le", "la", "les", "lui", "leur", "en", "y", "qui", "ne",
]);

/** Apostrophe droite ou typographique — Whisper produit les deux. */
function isApostrophe(ch: string): boolean {
  return ch === "'" || ch === "’";
}

/** Minuscules + décomposition NFD + suppression des diacritiques : « Envoyé » → « envoye ». */
function normalizeWord(word: string): string {
  return word.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/** Début (inclus) du mot — suite de lettres Unicode — qui se termine en `end`. */
function wordStart(text: string, end: number): number {
  let start = end;
  while (start > 0 && /\p{L}/u.test(text[start - 1])) start -= 1;
  return start;
}

/** Bornes du mot (lettres) qui précède `pos`, blancs sautés — vide si aucun. */
function previousWord(text: string, pos: number): { start: number; end: number } {
  let end = pos;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  return { start: wordStart(text, end), end };
}

/**
 * Début du mot-clé pour la famille « envoie » (élision « l' » ou « en » de la
 * forme découpée compris), `null` si le dernier mot n'en est pas une forme
 * acceptable.
 */
function envoieCut(trimmed: string, start: number, word: string): number | null {
  if (ENVOIE_FORMS.has(word)) {
    // Élision collée devant (« l'envoi », « t'envoie », « d'envoi »…) : seule
    // « l' » — la forme du recollage de Whisper — est tolérée ; toute autre
    // signe un vrai mot du texte.
    if (start >= 2 && isApostrophe(trimmed[start - 1]) && /\p{L}/u.test(trimmed[start - 2])) {
      const elisionStart = wordStart(trimmed, start - 1);
      if (normalizeWord(trimmed.slice(elisionStart, start - 1)) !== "l") return null;
      return elisionStart;
    }
    return start;
  }
  if (VOIE_FORMS.has(word)) {
    // Forme DÉCOUPÉE : une graphie de [vwa] ne compte que juste après le mot
    // « en » — c'est la réécriture « …souveraines en voie. » d'un « envoie »
    // réellement prononcé.
    const en = previousWord(trimmed, start);
    if (normalizeWord(trimmed.slice(en.start, en.end)) !== "en") return null;
    // Élision collée à « en » (« j'en vois », « qu'en voit ») : vraie tournure
    // du texte, jamais le mot-clé.
    if (en.start > 0 && isApostrophe(trimmed[en.start - 1])) return null;
    return en.start;
  }
  return null;
}

/**
 * Début du mot-clé pour un mot configuré QUELCONQUE : comparaison normalisée
 * avec tolérance du « s » final, aucune élision admise (un mot rare n'a pas de
 * recollage connu à excuser — collé, c'est un vrai mot du texte).
 */
function genericCut(trimmed: string, start: number, word: string, keyword: string): number | null {
  const variants = new Set([keyword, `${keyword}s`]);
  if (keyword.endsWith("s")) variants.add(keyword.slice(0, -1));
  if (!variants.has(word)) return null;
  if (start > 0 && isApostrophe(trimmed[start - 1])) return null;
  return start;
}

/**
 * Le texte se termine-t-il par le mot-clé d'envoi ?
 *
 * `keyword` : mot configuré (réglage voix), normalisé ici — vide ou blanc, il
 * retombe sur le défaut.
 *
 * - Pas de déclenchement → `{ body: text, send: false }` (texte intact).
 * - Déclenchement → `body` est le texte AVANT le mot-clé, blancs et virgule de
 *   liaison de fin retirés (« Voilà ma question, transmets. » → « Voilà ma
 *   question ») ; `body` peut être vide (mot-clé seul).
 */
export function matchSendKeyword(
  text: string,
  keyword: string = DEFAULT_SEND_KEYWORD,
): { body: string; send: boolean } {
  const trimmed = text.trim();
  const none = { body: text, send: false };
  // Mot configuré : dernier mot utile de la saisie (un réglage à rallonge ne
  // doit pas rendre l'envoi impossible), défaut si vide.
  const kw =
    normalizeWord(keyword.trim().split(/\s+/).at(-1) ?? "") || DEFAULT_SEND_KEYWORD;

  // Fin du texte : sauter ponctuation fermante et blancs pour atteindre le
  // dernier mot réellement prononcé.
  let end = trimmed.length;
  while (end > 0 && (TRAILING_PUNCT.has(trimmed[end - 1]) || /\s/.test(trimmed[end - 1]))) {
    end -= 1;
  }

  const start = wordStart(trimmed, end);
  const word = normalizeWord(trimmed.slice(start, end));
  if (!word) return none;

  // Position de coupe : début du mot-clé ENTIER — tout ce qui suit est retiré
  // du corps. La famille « envoie » a sa mécanique dédiée (homophones,
  // recollages) ; tout autre mot passe par la comparaison générique.
  const cut = ENVOIE_FORMS.has(kw)
    ? envoieCut(trimmed, start, word)
    : genericCut(trimmed, start, word, kw);
  if (cut === null) return none;

  // Mot précédent pronominal → usage verbal réel (« je l'envoie », « que je
  // te transmets »), pas le mot-clé.
  const prev = previousWord(trimmed, cut);
  const prevWord = trimmed.slice(prev.start, prev.end);
  if (prevWord && PRONOUNS_BEFORE.has(normalizeWord(prevWord))) return none;

  // Le corps garde sa ponctuation de phrase (« Voilà. ») mais pas la virgule
  // ou les deux-points de LIAISON avec le mot-clé (« Voilà, transmets »).
  const body = trimmed.slice(0, cut).trimEnd().replace(/[,;:]$/u, "");
  return { body, send: true };
}
