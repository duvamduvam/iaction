/*
 * T-059 — un refus de la sonde d'abonnement N'EST PAS une panne : c'est une
 * DONNÉE (même doctrine que T-057 pour la clé absente). Le message rendu par
 * le SDK au refus (« You've hit your session limit · resets 7:10pm
 * (Europe/Paris) ») porte tout ce qu'il faut pour arrêter d'insister —
 * quelle fenêtre est pleine, et quand elle se vide. Personne ne le lisait :
 * `executerClaudeUsageInit` (claudeUsage.ts) le jetait comme une exception
 * générique, pendant que la sonde revenait quand même toutes les 5 minutes.
 *
 * Module à part, PUR : reconnaître et dater un refus n'a besoin ni du SDK, ni
 * du disque — juste du texte de l'exception. Feuille testable sans process.
 */

/** Fenêtre d'abonnement que le refus désigne. */
export type FenetreSaturation = "session" | "hebdo";

export interface RefusSaturation {
  fenetre: FenetreSaturation;
  /** Instant de réinitialisation, en ISO — `null` si le message ne porte aucune heure exploitable. */
  resetsAt: string | null;
}

/** Reconnaît « You've hit your session/weekly limit » (insensible à la casse). */
const RE_FENETRE = /hit your (session|weekly) limit/i;

/*
 * « resets 7:10pm (Europe/Paris) » : heure + fuseau IANA explicite.
 *
 * T-130 — les minutes sont OPTIONNELLES. Sur une réinitialisation qui tombe
 * pile sur l'heure, le SDK écrit « resets 6pm », pas « resets 6:00pm » : le
 * motif d'origine, qui les exigeait, rendait alors `resetsAt` null et le
 * badge annonçait « reprise à heure inconnue » — l'heure la plus utile,
 * perdue sur le format le plus courant.
 */
const RE_HEURE_FUSEAU = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i;

/**
 * « resets Oct 9, 7:00pm » ou « resets Oct 9, 7pm » : mois + jour + heure,
 * SANS fuseau — repli sur l'heure locale du poste. Minutes optionnelles pour
 * la même raison que ci-dessus (T-130).
 */
const RE_DATE_HEURE = /resets\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

const MOIS: Readonly<Record<string, number>> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function heure24(heure12: number, meridien: string): number {
  const h = heure12 % 12;
  return meridien.toLowerCase() === "pm" ? h + 12 : h;
}

/**
 * Décalage (ms) d'un fuseau IANA à un instant donné, via le seul outil natif
 * fiable pour ça (`Intl`) : on formate l'instant DANS le fuseau visé, on relit
 * ces composants comme s'ils étaient UTC, la différence EST le décalage —
 * DST compris, sans base de données de fuseaux à charge du projet.
 */
function decalageFuseauMs(epochMs: number, fuseau: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: fuseau,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(epochMs));
  const lire = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const commeUtc = Date.UTC(lire("year"), lire("month") - 1, lire("day"), lire("hour"), lire("minute"), lire("second"));
  return commeUtc - epochMs;
}

/** Heure de mur (année/mois/jour/heure/minute) DANS un fuseau donné, convertie en instant UTC. */
function versEpochMs(annee: number, moisIdx: number, jour: number, hh: number, mm: number, fuseau: string): number {
  const estimation = Date.UTC(annee, moisIdx, jour, hh, mm);
  // Deux passes : la première approche le décalage, la seconde absorbe une
  // éventuelle bascule DST tombant pile sur l'instant visé.
  const p1 = estimation - decalageFuseauMs(estimation, fuseau);
  const p2 = estimation - decalageFuseauMs(p1, fuseau);
  return p2;
}

/**
 * Date (année/mois/jour) telle qu'affichée dans un fuseau donné, à l'instant
 * `maintenant` — nécessaire pour savoir si « 7:10pm » vise aujourd'hui ou
 * demain quand le message ne donne qu'une heure.
 */
function jourDansFuseau(maintenant: Date, fuseau: string): { annee: number; moisIdx: number; jour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: fuseau,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(maintenant);
  const lire = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { annee: lire("year"), moisIdx: lire("month") - 1, jour: lire("day") };
}

/** Extrait `resetsAt` d'un message de refus. `null` si aucun format connu ne matche. */
function extraireResetsAt(message: string, maintenant: Date): string | null {
  const avecFuseau = RE_HEURE_FUSEAU.exec(message);
  if (avecFuseau) {
    const [, hh, mm, meridien, fuseau] = avecFuseau;
    try {
      const { annee, moisIdx, jour } = jourDansFuseau(maintenant, fuseau);
      // `mm` est absent quand le message dit « 6pm » (T-130) : heure pleine.
      let epoch = versEpochMs(annee, moisIdx, jour, heure24(Number(hh), meridien), Number(mm ?? 0), fuseau);
      // L'heure annoncée est TOUJOURS à venir : si le calcul « aujourd'hui »
      // tombe déjà dans le passé, c'est demain qu'elle vise.
      if (epoch <= maintenant.getTime()) epoch += 24 * 60 * 60 * 1000;
      return new Date(epoch).toISOString();
    } catch {
      // Fuseau non reconnu par l'ICU du runtime : mieux vaut ne rien affirmer.
      return null;
    }
  }

  const avecDate = RE_DATE_HEURE.exec(message);
  if (avecDate) {
    const [, moisTxt, jourTxt, hh, mm, meridien] = avecDate;
    const moisIdx = MOIS[moisTxt.slice(0, 3).toLowerCase()];
    if (moisIdx === undefined) return null;
    // Pas de fuseau dans ce format : repli sur l'heure locale du poste — c'est
    // là que tourne le sidecar, la meilleure hypothèse sans autre indice.
    // `mm` absent = heure pleine, même omission que ci-dessus (T-130).
    const minutes = Number(mm ?? 0);
    let candidate = new Date(maintenant.getFullYear(), moisIdx, Number(jourTxt), heure24(Number(hh), meridien), minutes);
    if (candidate.getTime() <= maintenant.getTime()) {
      candidate = new Date(maintenant.getFullYear() + 1, moisIdx, Number(jourTxt), heure24(Number(hh), meridien), minutes);
    }
    return candidate.toISOString();
  }

  return null;
}

/**
 * Reconnaît un refus de saturation d'abonnement dans un message d'exception
 * du SDK. `null` si le message n'en est pas un (exception d'une autre
 * nature) — l'appelant garde alors son traitement d'erreur générique.
 */
export function parseRefusSaturation(message: string, maintenant: Date = new Date()): RefusSaturation | null {
  const m = RE_FENETRE.exec(message);
  if (!m) return null;
  return {
    fenetre: m[1].toLowerCase() === "session" ? "session" : "hebdo",
    resetsAt: extraireResetsAt(message, maintenant),
  };
}
