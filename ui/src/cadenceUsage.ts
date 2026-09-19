/*
 * Silence de la sonde sur refus de saturation (T-059).
 *
 * ── Ce qui a quitté ce fichier (T-086, remontée dans le sidecar) ─────────
 * Ce module portait trois règles : le bail entre fenêtres (« qui relève »),
 * le recul exponentiel de la reprise après échec (T-085), et ce silence.
 * Les deux premières supposaient que localStorage était le seul canal
 * partagé entre webviews Tauri — une hypothèse jamais VÉRIFIÉE dans
 * l'application lancée (voir docs/tickets.md T-086). Elles ont été
 * remplacées par une cadence tenue en mémoire de PROCESSUS, côté sidecar
 * (`sidecar/src/cadenceSondesConso.ts`) : un seul programme reçoit toutes
 * les requêtes, quel que soit le nombre de fenêtres qui les envoient, donc
 * la question du partage de stockage cesse d'exister. Voir
 * `sidecar/src/claudeUsage.ts` (micro-tour `usage.claude.init`) et
 * `sidecar/src/creditsFournisseur.ts` (`usage.credits`).
 *
 * ── Pourquoi CE silence-ci reste ici ──────────────────────────────────────
 * `silenceActifJusqua` a un second lecteur, extérieur au problème de cadence
 * des sondes : `ui/src/reouvertureQuota.ts` (réveil « au reset », T-120), qui
 * s'en sert comme repli quand aucun relevé chiffré n'est encore mémorisé. Le
 * sidecar gate désormais LUI-MÊME la décision de sonder à nouveau — cette
 * fenêtre n'a plus besoin de lire ce silence pour éviter d'insister — mais
 * l'ÉCRITURE reste ici, dans `localStorage`, comme canal partagé entre
 * fenêtres : c'est ce que `reouvertureQuota.ts` continue de lire, pour une
 * raison qui n'a rien à voir avec la cadence (voir son propre en-tête :
 * fusionner les deux couplerait le réveil à la sonde, exactement le genre de
 * défaut qui a produit T-059).
 *
 * `encartConso.tsx` continue donc d'ARMER/LEVER ce silence à la réception de
 * chaque réponse d'`usage.claude.init` — qu'elle vienne d'une sonde que
 * CETTE fenêtre a déclenchée, ou du dernier résultat que le sidecar lui a
 * renvoyé sans repartir en réseau.
 */

const CLE_SILENCE = "iaction:cadence-usage:silence";
/** Durée du silence quand le message de refus ne porte aucune heure exploitable. */
export const SILENCE_DEFAUT_MS = 30 * 60 * 1000;

/*
 * `window` n'existe pas sous vitest (environnement node), et le mode privé
 * strict peut refuser l'écriture : tout accès est enveloppé, avec un repli
 * en mémoire de module.
 */
let memoireSilence: string | null = null;

function lireBrutSilence(): string | null {
  try {
    return window.localStorage.getItem(CLE_SILENCE);
  } catch {
    return memoireSilence;
  }
}

function ecrireBrutSilence(valeur: string): void {
  try {
    window.localStorage.setItem(CLE_SILENCE, valeur);
  } catch {
    memoireSilence = valeur;
  }
}

/**
 * Arme le silence de la sonde jusqu'à `resetsAt` (ISO), ou `SILENCE_DEFAUT_MS`
 * après `maintenant` si `resetsAt` est absent, illisible, ou déjà passé — un
 * refus qu'on vient de recevoir ne peut pas se réinitialiser avant `maintenant`.
 */
export function armerSilence(resetsAt: string | null, maintenant: number): void {
  const brut = resetsAt ? new Date(resetsAt).getTime() : NaN;
  const jusqua = Number.isFinite(brut) && brut > maintenant ? brut : maintenant + SILENCE_DEFAUT_MS;
  ecrireBrutSilence(String(jusqua));
}

/** Échéance de silence en cours (epoch ms), ou `null` si aucune n'est active. */
export function silenceActifJusqua(maintenant: number): number | null {
  const brut = lireBrutSilence();
  if (!brut) return null;
  const jusqua = Number(brut);
  if (!Number.isFinite(jusqua) || jusqua <= maintenant) return null;
  return jusqua;
}

/** Lève le silence avant son échéance (ex. un relevé chiffré est revenu entre-temps). */
export function libererSilence(): void {
  try {
    window.localStorage.removeItem(CLE_SILENCE);
  } catch {
    memoireSilence = null;
  }
}
