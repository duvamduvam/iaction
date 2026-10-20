/*
 * Réveil d'une conversation — retenue temporelle PURE. Voir docs/spec-reveil.md.
 *
 * ── Ce que ce module ne fait PAS (§2 de la spec) ──────────────────────────
 * Aucun envoi. Le réveil ne fait qu'UNE chose : dire si une échéance est là
 * (`estDu`) et laquelle vient (`prochaineEcheance`). Le versement dans
 * `queuedPrompts` et le drainage vers `handleSend` restent entièrement dans
 * les pages — ce fichier n'importe ni React, ni le sidecar, ni `Date.now()`
 * (`maintenant` est toujours un paramètre, même convention que
 * cadenceUsage.ts et rythmeQuota.ts) : c'est ce qui le rend testable sans
 * horloge réelle.
 *
 * ── Le piège de la source MOUVANTE, et pourquoi la cible est figée ───────
 * Première version : le réveil « au reset » relisait à chaque battement
 * l'instant de réouverture du quota. Deux façons de ne jamais partir, toutes
 * deux constatées le 2026-09-04 :
 *
 * 1. la source ne rend cet instant que tant qu'il est FUTUR — or l'échéance
 *    du réveil est `réouverture + MARGE_RESET_MS`, toujours postérieure. Au
 *    moment précis où elle devient due, la source s'est déjà tue : le réveil
 *    voit `null` et se déclare « inerte » ;
 * 2. et si un relevé frais arrive entre-temps, la date saute à la réouverture
 *    SUIVANTE (cinq heures plus loin) — le moment visé est enjambé sans avoir
 *    jamais été observé.
 *
 * D'où `cibleReouverture` : l'instant est capturé À L'ARMEMENT et rangé DANS
 * le réveil. Une promesse porte sa propre échéance ; elle ne va pas la
 * redemander au monde à chaque battement, sous peine de dépendre de ce que le
 * monde a bien voulu garder. C'est aussi ce qui la rend testable sans horloge
 * ni magasin.
 */

/**
 * UN réveil armé sur une conversation — il peut y en avoir PLUSIEURS, chacun
 * avec son propre message (voir docs/spec-reveil.md §3).
 *
 * Le premier jet n'en portait qu'un seul par conversation, ses heures
 * partageant un unique message. Constat d'usage du 2026-09-04 : on veut « à
 * 03:00 reprends le chantier A, à 07:00 lance le bilan B » — deux promesses
 * différentes, pas deux horaires d'une même promesse. D'où une LISTE, et un
 * `id` pour pouvoir revenir modifier celui qu'on vise au lieu de le détruire.
 *
 * `heures` reste au pluriel DANS un réveil : « le même message à 03:00 et à
 * 08:00 » est un besoin réel (les fenêtres de quota se rouvrent toutes les
 * 5 h), et le dire par deux réveils identiques serait une duplication que
 * l'utilisateur devrait maintenir à la main.
 */
export interface Reveil {
  /** Identité stable — c'est elle qui permet de MODIFIER un réveil plutôt que de le remplacer. UUID (voir sessionStore.ts). */
  id: string;
  /** Heures de mur locales « HH:MM », récurrentes chaque jour. Peut être vide si `surResetQuota`. */
  heures: string[];
  /** Réveil supplémentaire dès que la fenêtre de quota se rouvre (voir §4.2). */
  surResetQuota: boolean;
  /**
   * Instant (ISO) de réouverture du quota VISÉ, figé à l'armement — `null` si
   * `surResetQuota` est faux, ou si aucune réouverture n'était connue alors.
   * Voir l'en-tête : c'est ce qui empêche le réveil de dépendre d'une source
   * qui bouge sous lui.
   */
  cibleReouverture: string | null;
  /** Ce qui partira au réveil, dans l'ordre. Vide = réveil sans effet, donc refusé à l'armement. */
  prompts: string[];
  /**
   * Repère d'armement (ISO) : aucune échéance ANTÉRIEURE ne compte.
   *
   * C'est lui qui empêche un réveil tout juste créé de se croire en retard sur
   * l'occurrence de LA VEILLE de ses heures — `estDu` remonte à la dernière
   * occurrence passée, quelle que soit son ancienneté. `null` = aucun repère,
   * toute occurrence passée dans la fenêtre de rattrapage compte.
   */
  dernierDeclenchement: string | null;
}

/**
 * Un réveil qui a VÉCU — déclenché ou abandonné, retiré des armés, gardé ici.
 *
 * Pourquoi l'historique existe : depuis le constat du 2026-09-04, un réveil ne
 * se ré-arme plus (voir `Reveil`). Sans trace, il disparaîtrait donc purement
 * et simplement de l'écran une fois son travail fait — et l'utilisateur qui
 * revient le matin n'aurait aucun moyen de savoir CE QUI est parti, ni quand.
 * La ligne dans le fil le dit pour la conversation active à l'instant T ; elle
 * est éphémère. L'historique, lui, reste.
 */
export interface ReveilHistorise {
  /** Celui du réveil d'origine — permet de le retrouver dans le journal. */
  id: string;
  /** Instant (ISO) où le battement a tranché. */
  traiteA: string;
  /** L'échéance elle-même (ISO) — pas l'instant du battement qui l'a vue. */
  echeance: string;
  /** Heures qui étaient armées, telles qu'affichées. */
  heures: string[];
  /** Vrai si le réveil visait aussi la réouverture de quota. */
  surResetQuota: boolean;
  /** Ce qui est parti (ou aurait dû partir, en cas d'abandon). */
  prompts: string[];
  /** `"declenche"` : versé dans la file. `"abandon"` : échéance manquée hors rattrapage, rien n'est parti. */
  issue: "declenche" | "abandon";
}

/**
 * Plafond de l'historique par conversation. 20 et pas « tout » : c'est une
 * trace de travail, pas une archive — et elle voyage dans le document de
 * session, qu'on ne laisse pas grossir sans fin (même esprit que `capSessions`,
 * sessionStore.ts).
 */
export const HISTORIQUE_REVEILS_MAX = 20;

/** `resetsAt` est l'instant ANNONCÉ ; repartir à la seconde près expose à un refus immédiat (§4.1). */
export const MARGE_RESET_MS = 60_000;
/** Au-delà, une échéance manquée est abandonnée plutôt que rattrapée (§4.3, comme `Persistent=true` des timers systemd). */
export const RATTRAPAGE_MAX_MS = 6 * 60 * 60 * 1000;

/** `HH:MM`, heures 0-23, minutes 0-59 — souple sur le zéro de tête (« 3:00 » comme « 03:00 »). */
const FORMAT_HEURE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Une heure de mur est-elle saisissable telle quelle ? Exporté pour que l'UI
 * valide EXACTEMENT comme le moteur calcule — deux expressions régulières
 * jumelles finiraient par diverger, et le désaccord se paierait en réveils
 * acceptés à l'écran mais jamais déclenchés.
 */
export function estHeureValide(heureMur: string): boolean {
  return FORMAT_HEURE.test(heureMur.trim());
}

/**
 * Les heures d'un réveil EN COURS DE SAISIE — celles déjà posées, PLUS celle
 * qui est encore dans le champ si elle est valide.
 *
 * Pourquoi cette fonction existe : le formulaire demandait de cliquer
 * « Ajouter » avant de pouvoir armer. Constat du 2026-09-04, capture à
 * l'appui — heure tapée, message écrit, et « Armer » grisé sans que rien ne
 * dise pourquoi. Taper une heure EST l'intention de l'ajouter ; exiger un
 * clic de plus, c'est une cérémonie que personne ne devine. « Ajouter » ne
 * sert donc plus qu'à en saisir une SECONDE.
 */
export function heuresAvecSaisie(heures: readonly string[], saisie: string): string[] {
  const propre = saisie.trim();
  if (!estHeureValide(propre) || heures.includes(propre)) return [...heures];
  return [...heures, propre].sort();
}

function heureEtMinute(heureMur: string): { h: number; min: number } | null {
  const m = FORMAT_HEURE.exec(heureMur.trim());
  if (!m) return null;
  return { h: Number(m[1]), min: Number(m[2]) };
}

/**
 * Prochaine occurrence FUTURE (ou immédiatement passée) de l'heure de mur
 * locale : aujourd'hui si elle n'est pas encore passée, demain sinon. Passe
 * par les composants de date locale (`setHours`), jamais par une addition de
 * millisecondes — c'est ce qui préserve l'heure de mur au changement d'heure
 * (§4.1, testé en DST dans reveil.test.ts).
 */
function prochaineOccurrence(heureMur: string, maintenant: number): number | null {
  const hm = heureEtMinute(heureMur);
  if (!hm) return null;
  const candidat = new Date(maintenant);
  candidat.setHours(hm.h, hm.min, 0, 0);
  if (candidat.getTime() <= maintenant) candidat.setDate(candidat.getDate() + 1);
  return candidat.getTime();
}

/** Symétrique de `prochaineOccurrence` : la dernière occurrence à ou avant `maintenant` (aujourd'hui, sinon hier). */
function derniereOccurrence(heureMur: string, maintenant: number): number | null {
  const hm = heureEtMinute(heureMur);
  if (!hm) return null;
  const candidat = new Date(maintenant);
  candidat.setHours(hm.h, hm.min, 0, 0);
  if (candidat.getTime() > maintenant) candidat.setDate(candidat.getDate() - 1);
  return candidat.getTime();
}

/**
 * Le plus proche instant FUTUR parmi les heures armées et, si `surResetQuota`,
 * la réouverture de fenêtre + marge (§4.1). `null` si le réveil n'a aucune
 * échéance calculable — c'est ce que l'UI affiche (ou refuse d'armer, §7).
 */
export function prochaineEcheance(reveil: Reveil, maintenant: number): number | null {
  const candidats = echeancesDuReveil(reveil).filter((t) => t > maintenant);
  for (const heure of reveil.heures) {
    const t = prochaineOccurrence(heure, maintenant);
    if (t !== null) candidats.push(t);
  }
  return candidats.length > 0 ? Math.min(...candidats) : null;
}

/** Échéances FIXES d'un réveil : la cible de réouverture figée à l'armement, marge comprise. */
function echeancesDuReveil(reveil: Reveil): number[] {
  if (!reveil.surResetQuota || !reveil.cibleReouverture) return [];
  const ms = new Date(reveil.cibleReouverture).getTime();
  return Number.isFinite(ms) ? [ms + MARGE_RESET_MS] : [];
}

/**
 * La plus proche échéance de TOUTE une liste — ce que l'utilisateur veut lire
 * d'un coup d'œil (« prochain réveil : demain 03:00 »), sans avoir à ouvrir
 * le panneau ni à comparer les réveils un par un.
 */
export function prochaineEcheanceListe(reveils: readonly Reveil[], maintenant: number): number | null {
  const candidats = reveils
    .map((r) => prochaineEcheance(r, maintenant))
    .filter((t): t is number => t !== null);
  return candidats.length > 0 ? Math.min(...candidats) : null;
}

/**
 * La plus récente échéance PASSÉE et pas encore honorée (anti-double-tir),
 * toutes sources confondues — sans jugement sur le rattrapage, c'est `estDu`
 * et `echeanceAbandonnee` qui tranchent chacun leur question à partir d'elle.
 */
function derniereEcheancePasseeNonHonoree(reveil: Reveil, maintenant: number): number | null {
  const candidats = echeancesDuReveil(reveil);
  for (const heure of reveil.heures) {
    const t = derniereOccurrence(heure, maintenant);
    if (t !== null) candidats.push(t);
  }
  const dernierDeclenchementMs = reveil.dernierDeclenchement ? new Date(reveil.dernierDeclenchement).getTime() : null;
  const passees = candidats.filter(
    (t) => t <= maintenant && (dernierDeclenchementMs === null || t > dernierDeclenchementMs),
  );
  return passees.length > 0 ? Math.max(...passees) : null;
}

/**
 * Vrai quand une échéance est passée et n'a pas déjà été honorée, dans la
 * fenêtre de rattrapage (§4.3) :
 *
 * 1. anti-double-tir — une échéance ≤ `dernierDeclenchement` ne redéclenche
 *    pas (sans quoi un réveil récurrent partirait à chaque battement pendant
 *    toute la minute concernée) ;
 * 2. rattrapage borné — au-delà de `RATTRAPAGE_MAX_MS`, l'échéance manquée
 *    est abandonnée plutôt que rattrapée d'un coup (voir `echeanceAbandonnee`
 *    pour le signalement de cet abandon).
 */
export function estDu(reveil: Reveil, maintenant: number): boolean {
  const derniere = derniereEcheancePasseeNonHonoree(reveil, maintenant);
  return derniere !== null && maintenant - derniere <= RATTRAPAGE_MAX_MS;
}

/**
 * Échéance passée, pas encore honorée, mais hors fenêtre de rattrapage —
 * donc abandonnée plutôt que déclenchée. `null` si rien à abandonner (aucune
 * échéance passée, ou une échéance passée encore dans les clous de `estDu`).
 *
 * Sert au câblage des pages (§5/§6) : une échéance abandonnée doit tout de
 * même journaliser sa ligne (un réveil silencieusement perdu serait l'échec
 * muet que la doctrine d'observabilité interdit) et avancer
 * `dernierDeclenchement` pour ne pas le répéter à chaque battement suivant.
 */
export function echeanceAbandonnee(reveil: Reveil, maintenant: number): number | null {
  const derniere = derniereEcheancePasseeNonHonoree(reveil, maintenant);
  if (derniere === null) return null;
  return maintenant - derniere > RATTRAPAGE_MAX_MS ? derniere : null;
}

/*
 * ── Persistance (§3) ────────────────────────────────────────────────────
 * `reveils` est un champ de PLUS sur `ChatSession`/`ProjectSession`, assaini
 * à la relecture du disque exactement comme `compaction`/`routedTier` le
 * sont déjà dans ces deux documents (une valeur absente ou corrompue retombe
 * sur une liste VIDE, jamais une session entière invalidée pour ça).
 * Factorisé ICI plutôt que dupliqué dans les deux pages — un seul format à
 * faire évoluer, et il vient déjà d'évoluer une fois.
 */

/** Un `id` neuf pour un réveil — UUID, comme les identifiants de session et de tour (jamais un compteur, voir sessionStore.ts). */
export function nouvelIdReveil(): string {
  return crypto.randomUUID();
}

/** `unknown` → `Reveil` valide, ou `null` (absent, corrompu, ou d'une forme antérieure à ce champ). */
export function toReveil(value: unknown): Reveil | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    Array.isArray(v.heures) &&
    v.heures.every((h) => typeof h === "string") &&
    typeof v.surResetQuota === "boolean" &&
    Array.isArray(v.prompts) &&
    v.prompts.every((p) => typeof p === "string") &&
    (typeof v.dernierDeclenchement === "string" || v.dernierDeclenchement === null)
  ) {
    return {
      // Un réveil écrit avant que la liste n'existe n'a pas d'`id` : on lui en
      // donne un plutôt que de le jeter — il a été armé par quelqu'un, le
      // perdre en silence serait pire que de le renuméroter.
      id: typeof v.id === "string" && v.id !== "" ? v.id : nouvelIdReveil(),
      heures: v.heures as string[],
      surResetQuota: v.surResetQuota,
      // Absent sur un réveil écrit avant que la cible ne soit figée : `null`,
      // donc sans échéance de réouverture — il faudra le réarmer. Le jeter
      // entier serait pire.
      cibleReouverture: typeof v.cibleReouverture === "string" ? v.cibleReouverture : null,
      prompts: v.prompts as string[],
      dernierDeclenchement: v.dernierDeclenchement as string | null,
    };
  }
  return null;
}

/**
 * `unknown` → liste de réveils valides. Tolère l'ANCIENNE forme au singulier
 * (`reveil: Reveil | null`, celle du premier jet) : les postes qui ont déjà
 * armé un réveil sous cette forme le retrouvent, converti, au lieu de le voir
 * disparaître sans un mot à la mise à jour.
 */
export function toReveils(value: unknown): Reveil[] {
  if (typeof value !== "object" || value === null) return [];
  const v = value as Record<string, unknown>;
  if (Array.isArray(v.reveils)) {
    return v.reveils.map(toReveil).filter((r): r is Reveil => r !== null);
  }
  const ancien = toReveil(v.reveil);
  return ancien ? [ancien] : [];
}

/** `unknown` → historique valide (entrées corrompues écartées, plafond appliqué). */
export function toReveilsHistorique(value: unknown): ReveilHistorise[] {
  if (typeof value !== "object" || value === null) return [];
  const brut = (value as Record<string, unknown>).reveilsHistorique;
  if (!Array.isArray(brut)) return [];
  const entrees: ReveilHistorise[] = [];
  for (const item of brut) {
    if (typeof item !== "object" || item === null) continue;
    const v = item as Record<string, unknown>;
    if (
      typeof v.id === "string" &&
      typeof v.traiteA === "string" &&
      typeof v.echeance === "string" &&
      Array.isArray(v.heures) &&
      v.heures.every((h) => typeof h === "string") &&
      typeof v.surResetQuota === "boolean" &&
      Array.isArray(v.prompts) &&
      v.prompts.every((pr) => typeof pr === "string") &&
      (v.issue === "declenche" || v.issue === "abandon")
    ) {
      entrees.push({
        id: v.id,
        traiteA: v.traiteA,
        echeance: v.echeance,
        heures: v.heures as string[],
        surResetQuota: v.surResetQuota,
        prompts: v.prompts as string[],
        issue: v.issue,
      });
    }
  }
  return entrees.slice(-HISTORIQUE_REVEILS_MAX);
}

/** Complète/assainit `reveils` sur un document brut AVANT sa validation — même principe que `withCompactionDefault` (ChatPage.tsx) et `withRoutingRepair` (modeleProjet.ts). */
export function withReveilsDefault(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  // `reveil` (singulier) est retiré au passage : une fois converti, le garder
  // ferait deux sources de vérité dont l'une ne serait plus jamais écrite.
  const { reveil: _ancien, ...reste } = v;
  return { ...reste, reveils: toReveils(v), reveilsHistorique: toReveilsHistorique(v) };
}
