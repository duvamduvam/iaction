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

/* ---------- Périphériques audio du composeur (T-148) ---------- */

/**
 * POINT DE JOURNAL T-148 — micro choisi depuis le menu du composeur. Niveau
 * `info` : c'est ce qui permet de relire, après un « Micro silencieux », quel
 * périphérique était réellement visé (`""` = défaut système).
 */
export function journalChoixMicro(deviceId: string): void {
  logInfo("speech", "micro choisi depuis le composeur", { fields: { deviceId } });
}

/** POINT DE JOURNAL T-148 — enregistrement du micro choisi en échec. */
export function journalPanneChoixMicro(erreur: string): void {
  logError("speech", "choix du micro : enregistrement en échec", { fields: { erreur } });
}

/** POINT DE JOURNAL T-148 — lecture des sorties audio du système en échec (`pactl` absent…). */
export function journalPanneListeSorties(erreur: string): void {
  logError("speech", "sorties audio : lecture en échec", { fields: { erreur } });
}

/** POINT DE JOURNAL T-148 — bascule de la sortie par défaut du système en échec. */
export function journalPanneChoixSortie(sortie: string, erreur: string): void {
  logError("speech", "sortie audio : bascule en échec", { fields: { sortie, erreur } });
}

/** POINT DE JOURNAL T-148 — lecture des entrées audio du système en échec (`pactl` absent…). */
export function journalPanneListeEntrees(erreur: string): void {
  logError("speech", "entrées audio : lecture en échec", { fields: { erreur } });
}

/** POINT DE JOURNAL T-148 — bascule de l'entrée par défaut du système en échec. */
export function journalPanneChoixEntree(entree: string, erreur: string): void {
  logError("speech", "entrée audio : bascule en échec", { fields: { entree, erreur } });
}

/**
 * POINT DE JOURNAL T-148 — entrée système choisie depuis le composeur.
 * `memoireVidee` : un micro web mémorisé primait sur le défaut système, il a été
 * remis à « défaut » pour que le choix ait un effet.
 */
export function journalChoixEntreeSysteme(entree: string, memoireVidee: boolean): void {
  logInfo("speech", "entrée système choisie depuis le composeur", { fields: { entree, memoireVidee } });
}

/* ---------- Chronométrage de la chaîne (T-149) ---------- */

/** Issue d'un appel chronométré (transcription ou synthèse). */
export type IssueAppelVoix = "ok" | "echec";

/**
 * POINT DE JOURNAL T-149 — un appel de transcription, de l'envoi de l'audio
 * au retour du texte. Niveau `info` : c'est la mesure qui manquait pour dire
 * quel maillon de la voix est lent. Métadonnées SEULEMENT — jamais le texte
 * reconnu (il a sa propre ligne, `journalSegmentTranscrit`). `dureeAudioMs`
 * n'est fournie que si elle a pu se déduire de l'en-tête WAV.
 */
export function journalAppelTranscription(
  mode: string,
  modele: string,
  dureeMs: number,
  issue: IssueAppelVoix,
  dureeAudioMs?: number,
): void {
  logInfo("speech", "appel de transcription", {
    fields:
      dureeAudioMs === undefined
        ? { mode, modele, dureeMs, issue }
        : { mode, modele, dureeMs, issue, dureeAudioMs },
  });
}

/**
 * POINT DE JOURNAL T-149 — un appel de synthèse (UN fragment), de l'envoi du
 * texte au retour de l'audio. Seule la LONGUEUR du texte est tracée, pas le
 * texte. `rang` (0 = premier fragment de la réponse) n'est fourni que si le
 * module chronomètre connaît le début de la réponse.
 */
export function journalAppelSynthese(
  mode: string,
  modele: string,
  dureeMs: number,
  issue: IssueAppelVoix,
  longueurTexte: number,
  rang?: number,
): void {
  logInfo("speech", "appel de synthèse", {
    fields:
      rang === undefined
        ? { mode, modele, dureeMs, issue, longueurTexte }
        : { mode, modele, dureeMs, issue, longueurTexte, rang },
  });
}

/**
 * POINT DE JOURNAL T-149 — délai entre la FIN de la dernière transcription et
 * le premier texte de la réponse arrivé à la synthèse (= durée du tour du
 * modèle jusqu'à sa première phrase, envoi compris).
 */
export function journalPremierTexteReponse(delaiMs: number): void {
  logInfo("speech", "délai jusqu'au premier texte de la réponse", { fields: { delaiMs } });
}

/**
 * POINT DE JOURNAL T-149 — délai entre la FIN de la dernière transcription et
 * le début du premier son de la réponse : ce que l'utilisateur perçoit comme
 * « le temps que ça met à me répondre ».
 */
export function journalPremierSonReponse(delaiMs: number): void {
  logInfo("speech", "délai jusqu'au premier son de la réponse", { fields: { delaiMs } });
}
