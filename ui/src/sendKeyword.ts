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
 * Le défaut est « banane ». Ce n'est pas une plaisanterie : c'est la
 * conclusion de deux échecs mesurés en usage réel, « envoie » puis
 * « transmets », tous deux des VERBES — et c'est là que tout se joue.
 *
 * Un verbe cumule trois fragilités, constatées noir sur blanc dans
 * l'historique de conversation :
 * 1. il se conjugue, et Whisper choisit la forme au hasard du contexte —
 *    « transmets » est ressorti en « transmettre », « transmet », « je
 *    remets » ;
 * 2. il appelle un pronom, que Whisper ajoute de lui-même (« Je transmets »,
 *    « Prends-moi »), ce qui réveille le garde-fou grammatical ci-dessous et
 *    BLOQUE l'envoi que l'utilisateur venait justement de demander ;
 * 3. son modèle de langue le réécrit vers des mots plus probables dans la
 *    phrase — « transmets » est devenu « très Prends ce mail ».
 *
 * Un NOM COMMUN est immunisé contre les trois : aucune conjugaison, aucun
 * pronom devant, et s'il est fréquent dans le corpus d'entraînement le modèle
 * n'a aucune raison de le « corriger ». « banane » ajoute deux qualités : trois
 * syllabes aux voyelles nettes (aucune nasale, aucun groupe consonantique à
 * confondre) et une absurdité totale en fin de consigne — il n'apparaîtra
 * jamais par accident dans un vrai prompt.
 *
 * ── Tolérance aux graphies ──────────────────────────────────────────────
 * Whisper orthographie au petit bonheur : la comparaison est normalisée
 * (minuscules, accents retirés), tolère un « s » final en plus ou en moins,
 * et à défaut compare le SQUELETTE CONSONANTIQUE (voir `consonantSkeleton`) —
 * c'est ce qui rattrape « Banana » et « Benen » pour « banane ».
 * Si l'utilisateur choisit malgré tout un mot de la famille « envoie », toute
 * la mécanique spécifique apprise à la dure s'applique : homophones (envoi,
 * envoyer…), recollage élidé (« l'envoi »), découpage (« en voie » — un
 * « envoie » entendu [ɑ̃vwa] réécrit en deux mots), et garde-fous
 * grammaticaux (« que je t'envoie », « je l'envoie » ne déclenchent pas).
 *
 * ── Philosophie : permissif sur la forme, strict sur la grammaire ───────
 * Un faux négatif (mot-clé ignoré, texte pollué, rien ne part) coûte plus
 * cher qu'un envoi un peu précoce — le message allait partir de toute façon.
 * On déclenche donc dès que la dictée SE TERMINE par le mot-clé, et on ne
 * bloque que les usages manifestement grammaticaux (élision, pronom ou
 * déterminant devant, EN MILIEU DE PHRASE).
 *
 * ── Répétitions : le réflexe de l'utilisateur qui n'est pas entendu ─────
 * Quand rien ne part, on répète le mot — c'est mécanique. Les occurrences
 * successives sont donc TOUTES retirées du corps : « banane, banane, banane »
 * envoie un message propre, pas un message qui contient deux bananes.
 */

/** Mot-clé par défaut — voir l'en-tête pour la justification du choix. */
export const DEFAULT_SEND_KEYWORD = "banane";

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
 * Ponctuation qui FERME une phrase. Elle distingue le mot-clé lancé à part
 * (« Voilà ma question. Je transmets. ») d'un usage grammatical au fil du
 * texte (« le rapport que je te transmets ») — voir `matchSendKeyword`.
 */
const SENTENCE_END = new Set([".", "!", "?", "…"]);

/**
 * Mot précédent qui signe un usage réel du mot-clé dans la phrase : pronom
 * devant un verbe (« je l'envoie », « que je te transmets ») ou déterminant
 * devant un nom (« j'ai mangé une banane »). Formes normalisées, sans accents.
 */
const WORDS_BEFORE = new Set([
  // Pronoms — le mot-clé est alors le verbe de la phrase.
  "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles",
  "me", "te", "se", "le", "la", "les", "lui", "leur", "en", "y", "qui", "ne",
  // Déterminants — le mot-clé est alors un nom du texte dicté.
  "un", "une", "des", "du", "ce", "cet", "cette", "ces",
  "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "votre",
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

/** Recule sur la ponctuation fermante et les blancs pour atteindre le dernier mot prononcé. */
function skipTrailing(text: string, from: number): number {
  let end = from;
  while (end > 0 && (TRAILING_PUNCT.has(text[end - 1]) || /\s/.test(text[end - 1]))) end -= 1;
  return end;
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
 * Squelette consonantique d'un mot déjà normalisé : voyelles, « h » muet et
 * « s » final retirés. « banane », « banana », « Benen » et « bananne » se
 * ramènent tous à « bnn ».
 *
 * ── Pourquoi les consonnes ──────────────────────────────────────────────
 * Relevé le 2026-09-06 : sur un même mot clairement prononcé, la
 * transcription a rendu « Banane », « Banana » (orthographe anglaise) et
 * « Benen ». Les consonnes, elles, n'ont pas bougé. C'est cohérent avec ce
 * qu'est un modèle acoustique : les consonnes sont des événements brefs et
 * marqués, les voyelles un continuum que le modèle de langue rhabille selon
 * ce qu'il croit lire. On compare donc ce qui est stable.
 */
function consonantSkeleton(word: string): string {
  return word
    .replace(/[aeiouyh]/g, "")
    .replace(/s$/, "")
    // Doublement de consonne : « bananne », « bannane » — le modèle hésite sur
    // la géminée autant que sur les voyelles.
    .replace(/(.)\1+/g, "$1");
}

/**
 * Début du mot-clé pour un mot configuré QUELCONQUE : comparaison normalisée
 * avec tolérance du « s » final PUIS, à défaut, du squelette consonantique à
 * longueur voisine (± 2 lettres). Aucune élision admise (un mot rare n'a pas
 * de recollage connu à excuser — collé, c'est un vrai mot du texte).
 *
 * Cas limite assumé : un mot du texte au même squelette et à la même longueur
 * déclenche l'envoi (« bonne » pour « banane »). Conforme à la philosophie du
 * module — un envoi un peu tôt sur un message qui partait de toute façon coûte
 * moins cher qu'un mot-clé ignoré, qui laisse l'utilisateur répéter dans le
 * vide. Un mot-clé au squelette rare l'évite entièrement.
 */
function genericCut(
  trimmed: string,
  start: number,
  word: string,
  keyword: string,
): { start: number; approx: boolean } | null {
  const variants = new Set([keyword, `${keyword}s`]);
  if (keyword.endsWith("s")) variants.add(keyword.slice(0, -1));
  let match = variants.has(word);
  // Le squelette n'est tenté qu'à défaut : c'est lui qui signe une graphie
  // APPROCHÉE (T-125 — la raison remontée au journal doit le distinguer d'une
  // reconnaissance exacte).
  let approx = false;
  if (!match) {
    const skeleton = consonantSkeleton(keyword);
    match =
      skeleton.length >= 2 &&
      consonantSkeleton(word) === skeleton &&
      Math.abs(word.length - keyword.length) <= 2;
    approx = match;
  }
  if (!match) return null;
  if (start > 0 && isApostrophe(trimmed[start - 1])) return null;
  return { start, approx };
}

/**
 * Pourquoi la décision — T-125 : la chaîne voix ne journalisait rien, un
 * simple booléen ne dit pas de QUOI naît un blocage ou un déclenchement.
 * Valeur portée par le module de décision lui-même, jamais devinée par
 * l'appelant (voir docs/tickets.md T-125).
 *
 * - `absent` : le texte ne se termine pas par le mot-clé (ni exact, ni
 *   graphie approchée) — cas le plus fréquent, aucune ambiguïté.
 * - `declenche` : mot-clé reconnu tel quel (forme exacte, ou tolérance du
 *   « s » final déjà prévue par le réglage).
 * - `declenche-graphie-approchee` : reconnu par le SQUELETTE CONSONANTIQUE
 *   seulement (« Banana », « Benen » pour « banane ») — utile pour repérer
 *   qu'une graphie inhabituelle a quand même déclenché l'envoi.
 * - `bloque-pronom-devant` : pronom ou déterminant collé devant, EN MILIEU DE
 *   PHRASE (« passe-moi la banane ») — usage grammatical réel, pas le mot-clé.
 * - `bloque-usage-grammatical` : famille « envoie » avec un pronom devant —
 *   bloquée MÊME en tête de segment, cette famille ne bénéficie jamais de
 *   l'assouplissement accordé aux autres mots-clés (trop proche du français
 *   courant, voir l'en-tête du fichier).
 */
export type SendKeywordReason =
  | "absent"
  | "declenche"
  | "declenche-graphie-approchee"
  | "bloque-pronom-devant"
  | "bloque-usage-grammatical";

export interface SendKeywordResult {
  body: string;
  send: boolean;
  reason: SendKeywordReason;
}

/**
 * Le texte se termine-t-il par le mot-clé d'envoi ?
 *
 * `keyword` : mot configuré (réglage voix), normalisé ici — vide ou blanc, il
 * retombe sur le défaut.
 *
 * - Pas de déclenchement → `{ body: text, send: false, reason }` (texte
 *   intact).
 * - Déclenchement → `body` est le texte AVANT le mot-clé — répétitions et
 *   pronoms accolés retirés, blancs et virgule de liaison de fin retirés
 *   (« Voilà ma question, banane. » → « Voilà ma question ») ; `body` peut
 *   être vide (mot-clé seul).
 *
 * `reason` motive la décision dans les deux cas (voir `SendKeywordReason`) —
 * c'est ce que T-125 demande pour pouvoir journaliser un POURQUOI, pas
 * seulement un booléen.
 */
export function matchSendKeyword(
  text: string,
  keyword: string = DEFAULT_SEND_KEYWORD,
): SendKeywordResult {
  const trimmed = text.trim();
  const none = (reason: SendKeywordReason): SendKeywordResult => ({ body: text, send: false, reason });
  // Mot configuré : dernier mot utile de la saisie (un réglage à rallonge ne
  // doit pas rendre l'envoi impossible), défaut si vide.
  const kw =
    normalizeWord(keyword.trim().split(/\s+/).at(-1) ?? "") || DEFAULT_SEND_KEYWORD;
  // La famille « envoie » est trop proche du français courant pour se permettre
  // la souplesse accordée plus bas : devant elle, un pronom bloque toujours.
  const strictBefore = ENVOIE_FORMS.has(kw);

  // Retrait, de la fin vers le début, de TOUTES les occurrences successives du
  // mot-clé (voir « Répétitions » en en-tête). `cut` retient la plus à gauche :
  // c'est là que s'arrête le corps du message.
  let end = skipTrailing(trimmed, trimmed.length);
  let cut: number | null = null;
  let blockedBefore = false;
  // Vrai dès qu'UNE occurrence retirée l'a été via le squelette consonantique
  // plutôt qu'une forme exacte — la décision finale le reflète.
  let approxMatch = false;

  for (;;) {
    const start = wordStart(trimmed, end);
    const word = normalizeWord(trimmed.slice(start, end));
    if (!word) break;
    let kwStart: number | null;
    if (strictBefore) {
      kwStart = envoieCut(trimmed, start, word);
    } else {
      const generic = genericCut(trimmed, start, word, kw);
      kwStart = generic?.start ?? null;
      if (generic?.approx) approxMatch = true;
    }
    if (kwStart === null) break;

    // Chaîne de pronoms/déterminants accolée devant (« je te <mot-clé> ») :
    // elle appartient au groupe à retirer, pas au message.
    let groupStart = kwStart;
    let hasWordBefore = false;
    for (;;) {
      const prev = previousWord(trimmed, groupStart);
      if (prev.start === prev.end) break;
      if (!WORDS_BEFORE.has(normalizeWord(trimmed.slice(prev.start, prev.end)))) break;
      groupStart = prev.start;
      hasWordBefore = true;
    }
    cut = groupStart;
    blockedBefore = hasWordBefore;
    end = skipTrailing(trimmed, groupStart);
  }

  if (cut === null) return none("absent");

  // Le corps garde sa ponctuation de phrase (« Voilà. ») mais pas la virgule
  // ou les deux-points de LIAISON avec le mot-clé (« Voilà, banane »).
  const body = trimmed.slice(0, cut).trimEnd().replace(/[,;:]$/u, "");

  // Pronom ou déterminant devant le mot-clé : usage grammatical réel — MAIS
  // seulement s'il est au fil d'une phrase. Lancé seul (« Je transmets. ») ou
  // après une phrase close (« Voilà ma question. Je transmets. »), c'est bien
  // le mot-clé : Whisper rhabille systématiquement un mot isolé en phrase.
  if (blockedBefore && body && !SENTENCE_END.has(body[body.length - 1])) return none("bloque-pronom-devant");
  // La famille « envoie » ne bénéficie pas de cet assouplissement.
  if (blockedBefore && strictBefore) return none("bloque-usage-grammatical");

  return { body, send: true, reason: approxMatch ? "declenche-graphie-approchee" : "declenche" };
}
