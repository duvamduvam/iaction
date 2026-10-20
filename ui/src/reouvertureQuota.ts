/*
 * Quand la fenêtre de quota se rouvre — la seule question que se pose un
 * réveil « au reset » (docs/spec-reveil.md §4.2).
 *
 * ── Pourquoi ce module existe (constat du 2026-09-04) ───────────────────
 * Le réveil lisait `silenceActifJusqua` (cadenceUsage.ts). C'était une
 * erreur d'analyse : ce silence n'est armé qu'à la réception d'un REFUS de la
 * sonde (T-059). Or au moment où l'utilisateur veut armer une reprise, il n'a
 * précisément pas encore été refusé — il VOIT venir la saturation. Capture à
 * l'appui : l'en-tête affichait « ⚠ Session 5h saturée — réinitialisation
 * dans 2h », et « Armer » se refusait en prétendant qu'aucune saturation
 * n'était connue. L'application savait ; le réveil regardait ailleurs.
 *
 * La bonne source est celle qui alimente ce badge : le relevé chiffré
 * (`ClaudeUsageSnapshot.fiveHour.resetsAt`, voir encartConso.tsx). Il existe
 * en permanence, saturé ou non, et il est bien plus frais qu'un refus.
 *
 * ── Pourquoi un magasin à part, et pas le silence de cadenceUsage ───────
 * Les deux dates se ressemblent mais ne disent pas la même chose : le silence
 * commande à la SONDE de se taire, ce dont le réveil n'a pas à se mêler.
 * Fusionner les deux ferait qu'armer un réveil pourrait museler la mesure —
 * exactement le genre de couplage qui produit un T-059.
 *
 * ── Écriture / lecture ──────────────────────────────────────────────────
 * ÉCRIT par l'encart de conso (le seul qui reçoit les relevés), LU par le
 * réveil. Passe par `localStorage` comme le silence : plusieurs fenêtres
 * partagent alors la même valeur, et elle survit à un rechargement de l'UI —
 * un réveil armé ne doit pas dépendre du hasard de l'ordre de démarrage.
 */

import { silenceActifJusqua } from "./cadenceUsage";

const CLE_REOUVERTURE = "iaction:quota:reouverture";

/** Repli quand `localStorage` est indisponible (navigation privée, sandbox). */
let memoireReouverture: string | null = null;

function lireBrut(): string | null {
  try {
    return window.localStorage.getItem(CLE_REOUVERTURE);
  } catch {
    return memoireReouverture;
  }
}

function ecrireBrut(valeur: string): void {
  try {
    window.localStorage.setItem(CLE_REOUVERTURE, valeur);
  } catch {
    memoireReouverture = valeur;
  }
}

/**
 * Mémorise l'instant de réouverture annoncé par un relevé (ou un refus).
 * `null`/illisible : on ne touche à RIEN — un relevé sans date ne prouve pas
 * que la précédente est fausse, et l'oublier priverait le réveil de la seule
 * information qu'il avait.
 */
export function memoriserReouverture(resetsAt: string | null | undefined): void {
  if (!resetsAt) return;
  const ms = new Date(resetsAt).getTime();
  if (!Number.isFinite(ms)) return;
  ecrireBrut(String(ms));
}

/**
 * Instant (epoch ms) où la fenêtre de quota se rouvre, d'après ce que l'app
 * sait de plus frais — ou `null` si elle ne sait rien d'exploitable.
 *
 * Deux sources, dans cet ordre :
 *
 * 1. le dernier `resetsAt` mémorisé du relevé chiffré — disponible en
 *    permanence, c'est lui qui répond dans l'immense majorité des cas ;
 * 2. à défaut, le silence armé par un refus (`silenceActifJusqua`) — il ne
 *    vaut que pendant la saturation, mais il est alors la donnée la plus
 *    fraîche qui existe (T-059).
 *
 * Une date DÉJÀ PASSÉE est écartée : la fenêtre s'est rouverte, il n'y a plus
 * de réouverture à attendre. C'est ce qui empêche un réveil « au reset » de
 * se croire éternellement en retard sur un repère périmé.
 */
export function instantReouvertureQuota(maintenant: number): number | null {
  const brut = lireBrut();
  const memorise = brut === null ? NaN : Number(brut);
  if (Number.isFinite(memorise) && memorise > maintenant) return memorise;
  return silenceActifJusqua(maintenant);
}

/** Oublie le repère mémorisé — réservé aux tests et à une remise à zéro explicite. */
export function oublierReouverture(): void {
  try {
    window.localStorage.removeItem(CLE_REOUVERTURE);
  } catch {
    memoireReouverture = null;
  }
  memoireReouverture = null;
}
