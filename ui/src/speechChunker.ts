/*
 * Découpage d'un texte en fragments prononçables, pour la synthèse vocale
 * incrémentale : on synthétise le premier fragment tout de suite et on le joue
 * pendant que les suivants se fabriquent, au lieu d'attendre un unique gros
 * appel proportionnel à la longueur de la réponse.
 *
 * Module PUR et sans dépendance (aucun import) : il doit rester testable et
 * réutilisable tel quel.
 *
 * Propriété de sûreté : la concaténation des fragments par un espace restitue
 * le texte d'origine à la normalisation des espaces près. On ne coupe donc
 * qu'à des positions situées sur une frontière de mot (après une ponctuation
 * suivie d'un blanc, sur un saut de ligne, ou sur une espace) — JAMAIS au
 * milieu d'un mot, et on ne supprime jamais de caractère non blanc.
 *
 * Pièges traités (voir les commentaires en regard de chaque règle) :
 * abréviations françaises (`M.`, `Mme`, `Dr`, `etc.`, `cf.`, `p. ex.`,
 * `av. J.-C.`), initiales (`J.-P.`), nombres décimaux (`3.14`), points de
 * suspension (`...`, `…`), URL et adresses e-mail, numérotation de liste en
 * début de ligne (`1.`, `2.`).
 *
 * Biais volontaire : en cas de doute on NE coupe PAS. Une coupure manquée
 * donne juste un fragment plus long (rattrapé par la borne `maxChars`), alors
 * qu'une coupure abusive s'entend immédiatement — un « M. » suivi d'un blanc
 * de synthèse au milieu d'un nom propre.
 *
 * Seule entorse à la propriété de sûreté : un texte sans rien de prononçable
 * (uniquement blancs et ponctuation) rend une liste vide, puisqu'on s'interdit
 * de produire un fragment non prononçable.
 */

/**
 * Longueur minimale visée pour un fragment (hors tout premier). En dessous, on
 * agrège les phrases courtes consécutives : une rafale de fragments minuscules
 * multiplie les appels de synthèse et hache la prosodie.
 */
export const DEFAULT_MIN_CHARS = 60;

/**
 * Borne haute d'un fragment : au-delà, l'appel de synthèse redevient long et
 * on perd le bénéfice du découpage.
 */
export const DEFAULT_MAX_CHARS = 300;

/**
 * Longueur minimale du TOUT PREMIER fragment. Compromis assumé : on le veut
 * délibérément court (le son doit démarrer vite), mais pas au point de faire
 * prononcer « un » tout seul parce que la réponse commençait par « 1. ». Ce
 * plancher très bas suffit à écarter ces bribes sans retarder le démarrage :
 * « Bonjour. » part seul, « 1. » est agrégé à la suite.
 */
export const FIRST_CHUNK_MIN_CHARS = 6;

/** Ponctuations considérées comme fins de phrase. */
const TERMINATORS = ".!?…";

/**
 * Abréviations françaises courantes dont le point final n'est PAS une fin de
 * phrase (comparaison en minuscules, sans le point). `etc` est traité à part
 * plus bas : c'est la seule qui termine réellement des phrases.
 */
const ABBREVIATIONS = new Set([
  "m", "mm", "mme", "mmes", "mlle", "mlles", "mr", "dr", "drs", "pr", "prs",
  "me", "mes", "st", "ste", "sts", "stes", "av", "ap", "cf", "ex", "p", "pp",
  "fig", "art", "chap", "ch", "vol", "éd", "ed", "env", "réf", "ref", "tél",
  "tel", "no", "nos", "al", "ibid", "op", "vs", "bd", "boul", "sq", "min",
  "max", "moy", "trad", "voir",
]);

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === " ";
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Lettre au sens large (accents compris) — sert à isoler le mot précédant un point. */
function isLetter(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

/**
 * Le fragment ne contient-il rien de prononçable ? (uniquement des blancs ou
 * de la ponctuation). On ne rend jamais un tel fragment.
 */
function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/**
 * Renvoie le mot (lettres/chiffres) qui précède immédiatement l'index donné,
 * en minuscules. Sert aux règles « abréviation » et « initiale ».
 */
function wordBefore(text: string, index: number): string {
  let start = index;
  while (start > 0 && (isLetter(text[start - 1]) || isDigit(text[start - 1]))) start -= 1;
  return text.slice(start, index).toLowerCase();
}

/** Le mot commençant à `start` est-il en tout début de ligne (blancs ignorés) ? */
function isAtLineStart(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t" || text[i] === " ")) i -= 1;
  return i < 0 || text[i] === "\n";
}

/**
 * Le point situé à `dotIndex` (dernier caractère d'une série de terminateurs)
 * clôt-il vraiment une phrase ? Appelé uniquement quand la série vaut un seul
 * point `.` — `!`, `?`, `…` et `...` ne posent aucun de ces problèmes.
 */
function isRealSentenceDot(text: string, dotIndex: number): boolean {
  const prev = dotIndex > 0 ? text[dotIndex - 1] : "";

  // URL / e-mail : `https://exemple.fr/a.b`, `jean.dupont@exemple.fr`. Les
  // points INTERNES sont déjà exclus (on exige un blanc après le point, voir
  // l'appelant) ; reste le cas d'un point collé à la fin d'un tel jeton, qu'on
  // veut rendre à la phrase — donc on ne fait rien de spécial ici : c'est bien
  // une fin de phrase. Même raisonnement pour les nombres décimaux `3.14` et
  // `1 234,56` : le séparateur y est suivi d'un chiffre, jamais d'un blanc.

  if (prev === "" || isWhitespace(prev)) {
    // Point isolé (« . » précédé d'un blanc) : rien à clore.
    return false;
  }

  const word = wordBefore(text, dotIndex);

  // Numérotation de liste en début de ligne : « 1. Premier point ». Restreint
  // au début de ligne et aux nombres courts, pour ne pas neutraliser un
  // millésime en fin de phrase (« … en 1789. Il … »).
  if (word.length > 0 && word.length <= 3 && /^\d+$/.test(word)) {
    if (isAtLineStart(text, dotIndex - word.length)) return false;
  }

  // Initiale : « J.-P. Dupont », « J.-C. ». Une seule lettre avant le point.
  if (word.length === 1 && isLetter(word)) return false;

  // Abréviations courantes : « M. Dupont », « p. ex. », « cf. », « av. J.-C. ».
  if (ABBREVIATIONS.has(word)) return false;

  // « etc. » termine souvent une phrase : on ne coupe que si la suite
  // ressemble à un nouveau départ (majuscule ou fin de texte).
  if (word === "etc") {
    let i = dotIndex + 1;
    while (i < text.length && isWhitespace(text[i])) i += 1;
    if (i >= text.length) return true;
    return text[i] === text[i].toUpperCase() && isLetter(text[i]);
  }

  return true;
}

/**
 * Premier découpage : en phrases.
 *
 * Sont retenus comme frontières : `.`, `!`, `?`, `…` (et leurs séries, du type
 * `?!` ou `...`, éventuellement suivies d'un guillemet ou d'une parenthèse
 * fermante) DÈS LORS qu'un blanc ou la fin du texte suit ; ainsi que les sauts
 * de ligne, qui séparent titres et éléments de liste dépourvus de ponctuation.
 *
 * `:` et `;` sont volontairement EXCLUS ici : en français ils introduisent une
 * suite immédiate (énumération, explication) et couper là s'entend comme une
 * hésitation. Ils servent en revanche de points de coupe de secours pour les
 * phrases trop longues (voir `hardSplit`).
 */
/**
 * Étudie la série de terminateurs qui commence à `i`. Renvoie l'index de fin de
 * phrase (exclu) si c'en est une, sinon l'index où reprendre le balayage.
 */
function sentenceEndAt(text: string, i: number): { end: number; isBoundary: boolean } {
  // Série de terminateurs : « ... », « ?! », « !!! », « … ».
  let last = i;
  while (last + 1 < text.length && TERMINATORS.includes(text[last + 1])) last += 1;

  // Un point unique doit passer les règles d'exception ; une série (points de
  // suspension, `?!`…) est toujours une vraie fin.
  if (text.slice(i, last + 1) === "." && !isRealSentenceDot(text, i)) {
    return { end: last + 1, isBoundary: false };
  }

  // Ponctuation fermante qui appartient encore à la phrase.
  let after = last + 1;
  while (after < text.length && "»\"'’)]".includes(text[after])) after += 1;

  // Frontière valide seulement si un blanc (ou la fin) suit : c'est ce qui
  // garantit qu'on ne coupe pas au milieu d'un mot, d'une URL ou d'un nombre
  // décimal (« 3.14 » : le point est suivi d'un chiffre).
  if (after < text.length && !isWhitespace(text[after])) {
    return { end: last + 1, isBoundary: false };
  }

  return { end: after, isBoundary: true };
}

function splitIntoSentences(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\n") {
      pieces.push(text.slice(start, i));
      start = i + 1;
      i += 1;
      continue;
    }

    if (!TERMINATORS.includes(ch)) {
      i += 1;
      continue;
    }

    const { end, isBoundary } = sentenceEndAt(text, i);
    if (isBoundary) {
      pieces.push(text.slice(start, end));
      start = end;
    }
    i = end;
  }

  if (start < text.length) pieces.push(text.slice(start));

  return pieces.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Trouve où couper un fragment trop long, par ordre de préférence : saut de
 * ligne, `;` / `:`, virgule, espace. Renvoie l'index de coupe (exclu) ou
 * `text.length` si aucune coupe acceptable n'existe.
 */
function findCut(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars + 1);
  // Plancher : une coupe trop précoce produirait une bribe. Sous ce seuil, on
  // essaie le séparateur suivant (plus faible mais mieux placé).
  const floor = Math.floor(maxChars * 0.4);

  const newline = window.lastIndexOf("\n");
  if (newline >= floor) return newline + 1;

  const semi = Math.max(window.lastIndexOf(";"), window.lastIndexOf(":"));
  if (semi >= floor) return semi + 1;

  const comma = window.lastIndexOf(",");
  if (comma >= floor) return comma + 1;

  const space = window.lastIndexOf(" ");
  if (space >= floor) return space;

  // Aucun séparateur exploitable dans la fenêtre : on dépasse volontairement
  // `maxChars` jusqu'à la première espace, plutôt que de couper un mot.
  const next = text.indexOf(" ", maxChars);
  return next === -1 ? text.length : next;
}

/** Découpe récursivement une phrase dépassant `maxChars`. */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;

  while (rest.length > maxChars) {
    const cut = findCut(rest, maxChars);
    if (cut <= 0 || cut >= rest.length) break;
    const head = rest.slice(0, cut).trim();
    if (head) out.push(head);
    rest = rest.slice(cut).trim();
  }

  if (rest) out.push(rest);
  return out.filter((p) => p.length > 0);
}

export interface SplitForSpeechOptions {
  /** Longueur minimale visée d'un fragment (hors premier). Défaut : 60. */
  minChars?: number;
  /** Longueur maximale d'un fragment. Défaut : 300. */
  maxChars?: number;
}

/**
 * Découpe `text` en fragments prononçables, prêts à être synthétisés un par un.
 *
 * - Le premier fragment est volontairement court (démarrage rapide du son).
 * - Les suivants sont agrégés jusqu'à `minChars` et bornés à `maxChars`.
 * - Aucun fragment vide ni uniquement ponctuation/blancs.
 * - `splitForSpeech(t).join(" ")` restitue `t` à la normalisation des espaces
 *   près.
 */
export function splitForSpeech(text: string, options?: SplitForSpeechOptions): string[] {
  const maxChars = Math.max(40, options?.maxChars ?? DEFAULT_MAX_CHARS);
  const minChars = Math.max(0, Math.min(options?.minChars ?? DEFAULT_MIN_CHARS, maxChars));

  if (!text || !isSpeakable(text)) return [];

  // 1) Phrases, puis 2) découpe des phrases trop longues.
  const pieces: string[] = [];
  for (const sentence of splitIntoSentences(text)) {
    if (sentence.length <= maxChars) pieces.push(sentence);
    else pieces.push(...hardSplit(sentence, maxChars));
  }

  const merged = absorbUnspeakable(pieces);
  if (merged.length === 0) return [];

  return aggregate(merged, minChars, maxChars).filter(isSpeakable);
}

/**
 * Les morceaux non prononçables (« ... », « — », « 1) ») ne doivent pas devenir
 * des fragments : on les colle au morceau suivant, ou au précédent s'ils
 * terminent le texte. Le contenu est conservé — propriété de sûreté.
 */
function absorbUnspeakable(pieces: string[]): string[] {
  const merged: string[] = [];
  let pending = "";

  for (const piece of pieces) {
    if (!isSpeakable(piece)) {
      pending = pending ? `${pending} ${piece}` : piece;
      continue;
    }
    merged.push(pending ? `${pending} ${piece}` : piece);
    pending = "";
  }

  if (pending && merged.length > 0) merged[merged.length - 1] += ` ${pending}`;
  return merged;
}

/**
 * Agrégation finale. Le premier fragment échappe à `minChars` : on le sort dès
 * qu'il atteint `FIRST_CHUNK_MIN_CHARS`, quitte à ce qu'il soit bien plus court
 * que les autres — c'est lui qui détermine le délai avant le premier son, et
 * c'est tout l'objet de ce module.
 */
function aggregate(pieces: string[], minChars: number, maxChars: number): string[] {
  const chunks: string[] = [];
  let buffer = "";

  for (const piece of pieces) {
    if (!buffer) {
      buffer = piece;
    } else if (buffer.length + 1 + piece.length <= maxChars) {
      buffer = `${buffer} ${piece}`;
    } else {
      chunks.push(buffer);
      buffer = piece;
    }

    const threshold = chunks.length === 0 ? FIRST_CHUNK_MIN_CHARS : minChars;
    if (buffer.length >= threshold) {
      chunks.push(buffer);
      buffer = "";
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks.filter((c) => c.length > 0);
}
