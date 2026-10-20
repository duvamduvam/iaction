/*
 * Câblage du réveil (docs/spec-reveil.md §5/§6), PARTAGÉ entre ChatPage.tsx et
 * AgentPage.tsx — les deux runtimes (`ConvRuntime`) ne diffèrent que par leur
 * charge utile (`entries`/`turns`), mais portent tous deux `reveil` et
 * `queuedPrompts` : un seul balayage suffit aux deux pages, comme
 * `useConversationRuntime.ts` l'est déjà pour le reste du moteur.
 *
 * Ce module reste sans React : il ne connaît ni le journal (`journal.ts`),
 * ni le rendu — il rend la liste de ce qui a bougé, à charge de l'appelant
 * (le battement de la page) de journaliser et d'afficher (§6).
 */
import {
  echeanceAbandonnee,
  estDu,
  HISTORIQUE_REVEILS_MAX,
  type Reveil,
  type ReveilHistorise,
} from "./reveil";
import type { Depot } from "./useConversationRuntime";

/** Un battement par page, 30 s — même valeur que `BATTEMENT_CADENCE_MS` (cadenceUsage.ts) : la précision utile est la minute (§5). */
export const BATTEMENT_REVEIL_MS = 30_000;

/** Trace de la dernière échéance traitée, affichée en ligne discrète dans le fil (§6). */
export interface NoticeReveil {
  label: string;
  /** Instant ISO où la notice a été posée — même forme que les autres notices non bloquantes. */
  at: string;
}

/**
 * Ce que le réveil a besoin de lire/écrire sur un runtime — sous-ensemble de
 * `ConvRuntime` des deux pages. `reveilNotice` n'est pas utilisé par
 * `battreReveils` lui-même mais par `useBattementReveil` (useReveil.ts), qui
 * pose la notice à partir des événements rendus : le contrat est le même,
 * autant qu'il se déclare en un seul endroit.
 */
export interface RuntimeAvecReveil {
  /** Réveils armés sur cette conversation — plusieurs, chacun son message (voir reveil.ts). */
  reveils: Reveil[];
  /** Réveils déjà passés (déclenchés ou abandonnés), du plus ancien au plus récent. */
  reveilsHistorique: ReveilHistorise[];
  queuedPrompts: string[];
  reveilNotice: NoticeReveil | null;
}

/** Un réveil honoré ou abandonné à ce battement — de quoi journaliser et afficher la trace (§6). */
export interface EvenementReveil {
  convId: string;
  /** Le réveil concerné — plusieurs peuvent être armés sur la même conversation. */
  reveilId: string;
  /** `"declenche"` : prompts versés dans `queuedPrompts`. `"abandon"` : échéance manquée hors rattrapage, jamais versée. */
  type: "declenche" | "abandon";
  /** Nombre de prompts concernés (versés si `declenche`, perdus si `abandon`). */
  nombrePrompts: number;
  /** Instant epoch ms de l'échéance elle-même (pas du battement qui la traite). */
  echeance: number;
}

/**
 * Un battement : balaie TOUTES les conversations du dépôt (pas seulement
 * l'active, §5) et, dans chacune, TOUS ses réveils — verse via `ecrire()` ce
 * qui est dû. C'est cet appel qui fait bouger le point « ● » de l'onglet et
 * l'affichage de la file, jamais `poser()`.
 *
 * ── Un réveil ne sert qu'UNE fois (constat du 2026-09-04) ────────────────
 * Le premier jet gardait armé un réveil doté d'heures : ayant sonné à 11:18,
 * il se réarmait pour le lendemain 11:18. Ce n'est pas ce qu'on demande à un
 * réveil de travail — « reprends CE travail à telle heure » est une promesse
 * datée, pas un abonnement. Déclenché ou abandonné, il est donc RETIRÉ des
 * armés et versé à l'historique.
 *
 * L'historique n'est pas un ornement : sans lui, un réveil disparaîtrait de
 * l'écran sitôt son travail fait, et l'utilisateur qui revient au matin
 * n'aurait aucun moyen de savoir ce qui est parti ni quand. La ligne posée
 * dans le fil est éphémère ; celle-ci reste.
 *
 * Les réveils d'une même conversation sont traités en UN SEUL `ecrire()` :
 * deux écritures successives sur le même runtime feraient perdre la première
 * (la seconde part de `prev`, capturé avant).
 */
export function battreReveils<R extends RuntimeAvecReveil>(
  depot: Depot<R>,
  maintenant: number,
): EvenementReveil[] {
  const evenements: EvenementReveil[] = [];
  const maintenantIso = new Date(maintenant).toISOString();

  for (const [convId, runtime] of depot.entrees()) {
    if (runtime.reveils.length === 0) continue;

    /** Réveils consommés à ce battement : retirés des armés, versés à l'historique. */
    const consommes = new Map<string, ReveilHistorise>();
    const promptsAVerser: string[] = [];

    for (const reveil of runtime.reveils) {
      const historiser = (issue: "declenche" | "abandon", echeance: number): void => {
        consommes.set(reveil.id, {
          id: reveil.id,
          traiteA: maintenantIso,
          echeance: new Date(echeance).toISOString(),
          heures: reveil.heures,
          surResetQuota: reveil.surResetQuota,
          prompts: reveil.prompts,
          issue,
        });
        evenements.push({
          convId,
          reveilId: reveil.id,
          type: issue,
          nombrePrompts: reveil.prompts.length,
          echeance,
        });
      };

      if (estDu(reveil, maintenant)) {
        promptsAVerser.push(...reveil.prompts);
        historiser("declenche", maintenant);
        continue;
      }
      const abandon = echeanceAbandonnee(reveil, maintenant);
      if (abandon !== null) historiser("abandon", abandon);
    }

    if (consommes.size === 0) continue;

    depot.ecrire(convId, (r) => ({
      ...r,
      queuedPrompts: [...r.queuedPrompts, ...promptsAVerser],
      reveils: r.reveils.filter((rev) => !consommes.has(rev.id)),
      reveilsHistorique: [
        ...r.reveilsHistorique,
        // Dans l'ordre des réveils de CE runtime, pas celui du balayage : le
        // runtime a pu changer entre-temps (course avec une suppression).
        ...r.reveils.filter((rev) => consommes.has(rev.id)).map((rev) => consommes.get(rev.id)!),
      ].slice(-HISTORIQUE_REVEILS_MAX),
    }));
  }

  return evenements;
}

/**
 * Enregistrer / supprimer un réveil sur une conversation — la même logique
 * dans les deux pages, donc écrite ICI une seule fois.
 *
 * `persister` est le point CRITIQUE, et il vient d'un défaut constaté le
 * 2026-09-04 : le premier jet n'écrivait que le runtime, si bien qu'un réveil
 * armé disparaissait au moindre rechargement de l'UI, sans un mot. La
 * persistance des pages n'a lieu qu'aux gestes qui la déclenchent déjà
 * (envoi, bascule de conversation, suppression) — armer un réveil n'en était
 * pas un. Un réveil est une PROMESSE pour plus tard : il n'existe que
 * persisté, d'où un `persister` OBLIGATOIRE dans la signature plutôt qu'un
 * appel que chaque page pourrait oublier.
 */
export function gererReveils<R extends RuntimeAvecReveil>(
  depot: Depot<R>,
  convId: string | null,
  persister: () => void,
): { enregistrer: (reveil: Reveil) => void; supprimer: (id: string) => void } {
  return {
    /** Réveil neuf, ou remplacement de celui qui porte le même `id` (c'est ce qui rend un réveil MODIFIABLE). */
    enregistrer(reveil: Reveil) {
      if (!convId) return;
      depot.ecrire(convId, (r) => ({
        ...r,
        reveils: r.reveils.some((x) => x.id === reveil.id)
          ? r.reveils.map((x) => (x.id === reveil.id ? reveil : x))
          : [...r.reveils, reveil],
      }));
      persister();
    },
    supprimer(id: string) {
      if (!convId) return;
      depot.ecrire(convId, (r) => ({ ...r, reveils: r.reveils.filter((x) => x.id !== id) }));
      persister();
    },
  };
}

/** Heure locale `HH:MM` d'un instant epoch ms — même format que le reste de l'app (ex. SupervisionAbonnement.tsx). */
function heureLocale(ms: number): string {
  return new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Libellé de l'action discrète posée dans le fil (§6) — au même titre que les
 * autres notices non bloquantes (recherche web, compaction, débord) : une
 * ligne, pas une bulle.
 */
export function libelleEvenementReveil(evenement: EvenementReveil): string {
  const heure = heureLocale(evenement.echeance);
  if (evenement.type === "declenche") {
    const n = evenement.nombrePrompts;
    return `Réveil de ${heure} — reprise (${n} message${n > 1 ? "s" : ""})`;
  }
  return `Réveil de ${heure} — abandonné (rattrapage dépassé, plus de 6 h de retard)`;
}
