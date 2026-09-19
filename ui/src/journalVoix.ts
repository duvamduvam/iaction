/*
 * Vocabulaire de journalisation de la chaîne voix — canal `speech` (T-125).
 *
 * POURQUOI ce module : avant T-125, la chaîne voix n'écrivait AUCUNE ligne
 * dans le journal — chaque erreur restait affichée dans son coin, mais jamais
 * tracée (échec muet). Les points de journal ajoutés pour corriger ça
 * vivaient dispersés dans `useVoiceComposer.ts` ET `voiceConversation.ts`, le
 * canal, le niveau et la forme des champs répétés à chaque appel — rien
 * n'empêchait deux appels de nommer différemment le même événement. Ce
 * module les regroupe en fonctions NOMMÉES d'après l'événement : le canal,
 * le niveau, le libellé et la forme des champs vivent désormais ici, en un
 * seul endroit.
 *
 * Module PUR au sens du projet : sa seule dépendance est `./journal`. Aucune
 * logique de la voix ici — seulement son vocabulaire de journal.
 */
import { logError, logInfo } from "./journal";

/** Issue d'un segment transcrit (mode conversation ou dictée ponctuelle). */
export type VerdictSegmentTranscrit = "vide" | "hallucination" | "transmis";

/** Issue d'un envoi voix, une fois le tour joué. */
export type VerdictEnvoiVoix = "refuse" | "parti" | "vide";

/* ---------- Segments transcrits ---------- */

/**
 * POINT DE JOURNAL T-125 — le texte VERBATIM reconnu en mode conversation,
 * sa longueur et sa durée, avec le verdict de ce même segment. Niveau `info`
 * (pas `debug`) : c'est la seule ligne qui permet de voir « très prends » à
 * la place de « transmets » sans changer `IACTION_LOG_LEVEL` — tout l'objet
 * du ticket.
 */
export function journalSegmentTranscrit(
  texte: string,
  longueur: number,
  dureeMs: number,
  verdict: VerdictSegmentTranscrit,
): void {
  logInfo("speech", "segment transcrit", { fields: { texte, longueur, dureeMs, verdict } });
}

/**
 * POINT DE JOURNAL T-125 — le texte VERBATIM reconnu en dictée ponctuelle,
 * avec sa longueur et son verdict. Niveau `info`, même raison qu'en mode
 * conversation (voir `journalSegmentTranscrit`) : c'est ce qui rend visible
 * une réécriture comme « très prends » à la place de « transmets ».
 */
export function journalSegmentTranscritDictee(
  texte: string,
  longueur: number,
  verdict: Extract<VerdictSegmentTranscrit, "vide" | "transmis">,
): void {
  logInfo("speech", "segment transcrit (dictée ponctuelle)", { fields: { texte, longueur, verdict } });
}

/* ---------- Panne de transcription ---------- */

/**
 * POINT DE JOURNAL T-125, T-057 — panne NON fatale de transcription d'UN
 * segment (réseau, clé absente, service indisponible) : l'écoute continue,
 * la phrase suivante peut très bien passer. Niveau `error` tout de même,
 * mais bornée à chaque segment réellement parlé — rien à voir avec la sonde
 * périodique qui criait en boucle un état choisi.
 */
export function journalPanneTranscriptionSegment(dureeMs: number, erreur: string): void {
  logError("speech", "transcription du segment en échec", { fields: { dureeMs, erreur } });
}

/* ---------- Décision du mot-clé d'envoi ---------- */

/**
 * POINT DE JOURNAL T-125 — la décision du mot-clé en mode conversation :
 * déclenché ou bloqué, et POURQUOI (rendu par sendKeyword.ts lui-même,
 * jamais deviné ici), avec la longueur du brouillon accumulé AVANT cette
 * décision. Niveau `info` : c'est un des deux maillons (avec « segment
 * transcrit ») qui rendent le raté diagnosticable.
 */
export function journalDecisionMotCleConversation(
  send: boolean,
  raison: string,
  longueurSegment: number,
  longueurBrouillon: number,
): void {
  logInfo("speech", "décision mot-clé (mode conversation)", {
    fields: { send, raison, longueurSegment, longueurBrouillon },
  });
}

/**
 * POINT DE JOURNAL T-125 — la décision du mot-clé en dictée ponctuelle.
 * `longueurBrouillon` n'est fournie QUE lorsque `send` est vrai : c'est le
 * seul cas où l'appelant connaît le brouillon repris (`takeDraft` le vide).
 */
export function journalDecisionMotCleDictee(
  send: boolean,
  raison: string,
  longueurSegment: number,
  longueurBrouillon?: number,
): void {
  logInfo("speech", "décision mot-clé (dictée ponctuelle)", {
    fields:
      longueurBrouillon === undefined
        ? { send, raison, longueurSegment }
        : { send, raison, longueurSegment, longueurBrouillon },
  });
}

/* ---------- Issue de l'envoi ---------- */

/**
 * POINT DE JOURNAL T-125 — issue de l'envoi voix, une fois le tour joué :
 * `refuse` (fournisseur/modèle/projet manquant, choisi ou transitoire),
 * `parti` (le tour est bien parti) ou `vide` (rien à transmettre). Niveau
 * `info` : état nominal dans les trois cas, pas une panne du protocole
 * (doctrine T-057). `longueur` n'a pas de sens pour `vide` et n'est alors
 * pas fournie.
 */
export function journalIssueEnvoiVoix(verdict: VerdictEnvoiVoix, longueur?: number): void {
  logInfo("speech", "issue de l'envoi voix", {
    fields: longueur === undefined ? { verdict } : { verdict, longueur },
  });
}

/* ---------- Pannes d'envoi et de micro ---------- */

/**
 * POINT DE JOURNAL T-125 — un envoi qui lève. La page affiche déjà l'erreur
 * dans son propre message, mais elle ne l'écrivait dans AUCUN journal :
 * c'est exactement l'échec muet du ticket, sans cette ligne un envoi qui
 * lève ne laisse aucune trace.
 */
export function journalPanneEnvoiVoix(longueur: number, erreur: string): void {
  logError("speech", "envoi voix : échec", { fields: { longueur, erreur } });
}

/**
 * POINT DE JOURNAL T-125 — micro refusé au démarrage du mode conversation
 * (permission, périphérique déjà pris par la dictée, capture indisponible).
 */
export function journalPanneDemarrageConversation(erreur: string): void {
  logError("speech", "mode conversation : démarrage refusé", { fields: { erreur } });
}

/**
 * POINT DE JOURNAL T-125 — micro refusé au lancement d'une dictée ponctuelle
 * (permission, périphérique déjà pris par le mode conversation…). Niveau
 * `error` : panne réelle d'un geste explicite de l'utilisateur, pas un état
 * périodique.
 */
export function journalPanneMicroDictee(erreur: string): void {
  logError("speech", "dictée : micro refusé", { fields: { erreur } });
}

/**
 * POINT DE JOURNAL T-125 — panne de la chaîne capture/transcription d'une
 * dictée ponctuelle (arrêt de l'enregistrement ou service de transcription
 * en échec).
 */
export function journalPanneDictee(erreur: string): void {
  logError("speech", "dictée : échec", { fields: { erreur } });
}
