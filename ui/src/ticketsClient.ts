/*
 * Wrapper typé pour la méthode TK1 — backlog de tickets (voir
 * docs/protocol.md § « Méthode TK1 — backlog de tickets (lecture) »).
 * Même style défensif que logsClient.ts / usageStatsClient.ts : tout champ
 * manquant ou mal typé côté sidecar est neutralisé plutôt que de faire planter
 * l'UI. Le backlog vient d'un fichier écrit à la main — c'est justement là
 * qu'on attend de l'inattendu.
 *
 * LECTURE SEULE : pas de `ticketsWrite` ici, et il n'y en aura pas ;
 * `docs/tickets.md` s'édite dans l'éditeur, pas dans l'app.
 */
import { request } from "./sidecar";

/** Types connus de la convention — un type hors liste reste affiché tel quel. */
export const TICKET_TYPES = ["bug", "feat", "tech", "doc"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

/** Priorités connues, de la plus urgente à la plus lointaine. */
export const TICKET_PRIOS = ["P1", "P2", "P3"] as const;
export type TicketPrio = (typeof TICKET_PRIOS)[number];

/** Statuts connus de la convention (`ouvert` → `en cours` → `fait`, ou `abandonné`). */
export const TICKET_STATUTS = ["ouvert", "en cours", "fait", "abandonné"] as const;
export type TicketStatut = (typeof TICKET_STATUTS)[number];

/** Un ticket du backlog. Tous les champs textuels peuvent valoir `""` (fichier incomplet). */
export interface Ticket {
  id: string;
  type: string;
  prio: string;
  statut: string;
  titre: string;
  /** Date de création `AAAA-MM-JJ`, `""` si le fichier ne la porte pas. */
  cree: string;
  /** Markdown de la section détaillée, tel quel — rendu par `Markdown.tsx`. */
  corps: string;
  archive: boolean;
}

/** Résultat d'un `tickets.list`. */
export interface TicketsListResult {
  /** Ordre d'apparition dans le fichier — le tri est à la charge de l'UI. */
  tickets: Ticket[];
  /** `false` : fichier introuvable/illisible ; `tickets` est alors vide. */
  disponible: boolean;
  /** Chemin absolu effectivement lu (ou cherché) — affiché à l'utilisateur. */
  chemin: string;
}

function toStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Ticket brut → `Ticket`. `null` seulement si l'entrée n'a même pas d'`id` :
 * sans identifiant, il n'y a rien à afficher ni à retrouver dans le fichier.
 * Tout le reste est comblé — mieux vaut une ligne incomplète qu'un ticket perdu.
 */
function parseTicket(value: unknown): Ticket | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = toStr(v.id).trim();
  if (!id) return null;
  return {
    id,
    type: toStr(v.type).trim().toLowerCase(),
    prio: toStr(v.prio).trim().toUpperCase(),
    statut: toStr(v.statut).trim().toLowerCase(),
    titre: toStr(v.titre).trim(),
    cree: toStr(v.cree).trim(),
    corps: toStr(v.corps),
    archive: v.archive === true,
  };
}

/**
 * Rang de priorité : 0 = `P1` … 2 = `P3`, priorité inconnue en dernier (elle
 * n'est pas urgente par défaut — un ticket sans prio n'a pas été trié).
 */
export function prioRank(prio: string): number {
  const i = (TICKET_PRIOS as readonly string[]).indexOf(prio);
  return i === -1 ? TICKET_PRIOS.length : i;
}

/** Partie numérique de l'identifiant (`T-012` → 12) ; `T-???` → +∞ (rejeté en fin de tri). */
export function idRank(id: string): number {
  const m = /(\d+)/.exec(id);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

/** Tri d'affichage : priorité d'abord, puis identifiant croissant (à priorité égale, l'ancien d'abord). */
export function trierTickets(tickets: readonly Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => prioRank(a.prio) - prioRank(b.prio) || idRank(a.id) - idRank(b.id));
}

/**
 * Backlog complet (voir `tickets.list`). Rejette seulement si le sidecar est
 * injoignable ou ne connaît pas la méthode — un fichier absent revient en
 * `disponible: false`, pas en erreur (voir `estBacklogIndisponible`).
 */
export async function ticketsList(): Promise<TicketsListResult> {
  const { done } = request("tickets.list", {});
  const data = await done;
  const tickets: Ticket[] = [];
  if (Array.isArray(data.tickets)) {
    for (const raw of data.tickets) {
      const ticket = parseTicket(raw);
      if (ticket) tickets.push(ticket);
    }
  }
  return { tickets, disponible: data.disponible === true, chemin: toStr(data.chemin) };
}

/**
 * Vrai quand l'échec signifie « ce sidecar ne connaît pas encore le backlog »
 * (méthode absente du routeur, voir `sidecar/src/index.ts` : « méthode
 * inconnue: … »). Même besoin, et même repli, que `estJournalIndisponible`
 * dans logsClient.ts : on affiche un message sobre, pas une erreur technique.
 */
export function estBacklogIndisponible(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes("méthode inconnue");
}
