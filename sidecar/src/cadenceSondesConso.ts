/*
 * Cadence des sondes COÛTEUSES de conso — `usage.claude.init` (vrai micro-tour
 * Claude) et `usage.credits` (réseau) — T-086.
 *
 * ── Le constat qui a motivé ce module ────────────────────────────────────
 * Le 2026-08-20 : deux fenêtres Tauri, chacune avec son propre `useEffect`
 * (T-062), ont sondé exactement deux fois plus (50+50 micro-tours, 684+687
 * appels crédits) — dont un vrai tour Claude sur un abonnement DÉJÀ saturé.
 * Le correctif du jour même a posé un bail dans `localStorage`
 * (`ui/src/cadenceUsage.ts`) : la moins mauvaise solution disponible côté
 * webview, mais reposant sur une hypothèse jamais vérifiée dans l'application
 * lancée — que deux webviews Tauri partagent bien `localStorage`.
 *
 * ── Ce que ce module change ──────────────────────────────────────────────
 * Le relevé est une donnée de PROCESSUS, pas de fenêtre. Le sidecar est UN
 * PAR PROCESSUS : la cadence vit ici, en mémoire de module, et la question
 * « les fenêtres partagent-elles leur stockage ? » cesse d'exister — il n'y a
 * qu'un seul programme qui reçoit toutes les requêtes, quel que soit le
 * nombre de fenêtres qui les envoient (voir `ui/src/sidecar.ts`, un seul
 * process sidecar, ses événements diffusés à toutes les fenêtres).
 *
 * Décisions temporelles PURES, testées sans I/O — la partie qui compte. La
 * garde contre la vraie CONCURRENCE (deux requêtes arrivées avant que la
 * première n'ait eu le temps de répondre) est un détail d'implémentation
 * séparé : un `Promise` partagé, tenu par l'appelant (`claudeUsage.ts`,
 * `creditsFournisseur.ts`), pas une décision temporelle.
 *
 * ── Deux cadences distinctes, pas une seule ──────────────────────────────
 * `usage.claude.init` n'a jamais eu de recul de reprise : un échec attend
 * simplement le prochain passage du cron (5 min) — voir l'ancien commentaire
 * d'`encartConso.tsx`, « le prochain passage du cron retentera ». Ce qui lui
 * est propre, c'est le SILENCE de saturation (T-059) : un refus daté fait
 * taire la sonde jusqu'à sa réouverture plutôt que d'insister toutes les
 * 5 min sur une issue déjà connue.
 *
 * `usage.credits` (T-085), lui, a un recul EXPONENTIEL après échec : une
 * panne réseau durable (certificat, DNS) ne doit pas attendre bêtement
 * 5 minutes après le premier essai si elle peut se révéler transitoire en
 * quelques secondes — mais elle ne doit pas non plus insister toutes les
 * 15 s indéfiniment (1 371 lignes d'erreur en 4 h 15 le 2026-08-20, à
 * l'époque MULTIPLIÉES par le nombre de fenêtres).
 *
 * Le silence de saturation lui-même RESTE dans `ui/src/cadenceUsage.ts` :
 * `ui/src/reouvertureQuota.ts` (réveil « au reset », T-120) le lit pour une
 * raison qui n'a rien à voir avec la cadence des sondes — c'est un second
 * consommateur, extérieur à ce problème, que ce module ne doit pas priver de
 * sa source. Ce qui migre ici, c'est la DÉCISION DE SONDER ; l'ANNONCE aux
 * autres fonctionnalités (réveil) continue d'être écrite côté UI, par la
 * fenêtre qui reçoit la réponse — voir `encartConso.tsx`.
 */

/** Cadence STEADY d'une sonde coûteuse — alignée sur l'ancien cron de 5 min. */
export const CADENCE_SONDE_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// `usage.claude.init` — cadence plate + silence de saturation (T-059)
// ---------------------------------------------------------------------------

/** Durée du silence quand le refus ne porte aucune heure exploitable (T-059). */
export const SILENCE_DEFAUT_MS = 30 * 60 * 1000;

export interface EtatCadenceInit {
  /** Horodatage (epoch ms) de la dernière sonde RÉELLE (succès, échec ou refus). */
  derniereSondeAt: number | null;
  /** Échéance de silence en cours (epoch ms), ou `null` si aucune n'est active. */
  silenceJusqua: number | null;
}

export function etatInitialInit(): EtatCadenceInit {
  return { derniereSondeAt: null, silenceJusqua: null };
}

/**
 * Faut-il lancer un VRAI micro-tour maintenant ? Deux motifs de refus : un
 * silence de saturation actif, ou une sonde trop récente (moins de
 * `CADENCE_SONDE_MS`). L'appelant garde alors le dernier résultat connu — il
 * ne s'agit jamais d'un refus muet, juste d'un résultat qui n'a pas changé.
 */
export function doitSonderInit(etat: EtatCadenceInit, maintenant: number): boolean {
  if (etat.silenceJusqua !== null && etat.silenceJusqua > maintenant) return false;
  if (etat.derniereSondeAt === null) return true;
  return maintenant - etat.derniereSondeAt >= CADENCE_SONDE_MS;
}

/** État après un relevé chiffré ou un échec générique : cadence plate, silence levé. */
export function apresSondeInit(maintenant: number): EtatCadenceInit {
  return { derniereSondeAt: maintenant, silenceJusqua: null };
}

/** État après un refus de saturation reconnu (T-059) : silence armé jusqu'à `resetsAt`. */
export function apresSaturationInit(resetsAt: string | null, maintenant: number): EtatCadenceInit {
  return { derniereSondeAt: maintenant, silenceJusqua: calculerSilenceJusqua(resetsAt, maintenant) };
}

/**
 * Échéance de silence : `resetsAt` s'il est lisible et dans le futur, sinon
 * `SILENCE_DEFAUT_MS` après `maintenant` — un refus qu'on vient de recevoir ne
 * peut pas se réinitialiser avant l'instant présent.
 */
function calculerSilenceJusqua(resetsAt: string | null, maintenant: number): number {
  const brut = resetsAt ? new Date(resetsAt).getTime() : NaN;
  return Number.isFinite(brut) && brut > maintenant ? brut : maintenant + SILENCE_DEFAUT_MS;
}

// ---------------------------------------------------------------------------
// `usage.credits` — cadence + recul exponentiel après échec (T-085)
// ---------------------------------------------------------------------------

/** Délai de la première reprise après un échec, et base du doublement. */
export const REPRISE_BASE_MS = 15_000;
/** Plafond de la reprise : au-delà, on ne s'éloigne plus de la cadence stable. */
export const REPRISE_PLAFOND_MS = 300_000;

/**
 * Délai avant la n-ième reprise consécutive (0 = la première) : 15 s, 30 s,
 * 1 min, 2 min, 4 min, puis 5 min pour toujours. Remis à zéro par le premier
 * succès — un incident bref ne laisse aucune dette de recul.
 */
export function prochainDelaiReprise(echecsConsecutifs: number): number {
  const n = Number.isFinite(echecsConsecutifs) ? Math.max(0, Math.floor(echecsConsecutifs)) : 0;
  // `2 ** n` déborde vite : on plafonne l'exposant avant de multiplier plutôt
  // que de laisser `Infinity` arriver jusqu'au `Math.min`.
  const exposant = Math.min(n, 32);
  return Math.min(REPRISE_BASE_MS * 2 ** exposant, REPRISE_PLAFOND_MS);
}

export interface EtatCadenceCredits {
  derniereSondeAt: number | null;
  /** Délai avant la prochaine sonde autorisée — `CADENCE_SONDE_MS` en régime stable. */
  intervalleCourant: number;
  /** Échecs consécutifs depuis le dernier succès (remis à zéro par lui). */
  echecsConsecutifs: number;
}

export function etatInitialCredits(): EtatCadenceCredits {
  return { derniereSondeAt: null, intervalleCourant: CADENCE_SONDE_MS, echecsConsecutifs: 0 };
}

export function doitSonderCredits(etat: EtatCadenceCredits, maintenant: number): boolean {
  if (etat.derniereSondeAt === null) return true;
  return maintenant - etat.derniereSondeAt >= etat.intervalleCourant;
}

/** État après un relevé exploitable : cadence stable, recul remis à zéro. */
export function apresSuccesCredits(maintenant: number): EtatCadenceCredits {
  return { derniereSondeAt: maintenant, intervalleCourant: CADENCE_SONDE_MS, echecsConsecutifs: 0 };
}

/** État après un échec (réseau, HTTP) : recul exponentiel, plafonné à la cadence stable. */
export function apresEchecCredits(etat: EtatCadenceCredits, maintenant: number): EtatCadenceCredits {
  return {
    derniereSondeAt: maintenant,
    intervalleCourant: prochainDelaiReprise(etat.echecsConsecutifs),
    echecsConsecutifs: etat.echecsConsecutifs + 1,
  };
}
