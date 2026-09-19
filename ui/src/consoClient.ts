/*
 * Client typé des méthodes CONSO du protocole : l'instantané d'abonnement
 * Claude (`usage.claude`, `usage.claude.init`) et les crédits d'un
 * fournisseur (`usage.credits`). Voir docs/protocol.md § « Méthodes conso ».
 *
 * Sorti de `sidecar.ts` en T-085/T-086 : le fichier passait sous le cliquet de
 * taille, et ces helpers sont exactement ceux que l'encart conso consomme —
 * ils vivent désormais à côté de lui plutôt qu'au milieu de 1 200 lignes de
 * plomberie de protocole. Même patron que `usageStatsClient.ts`.
 *
 * Les deux formes de réponse à connaître, et leur raison d'être :
 * - `available: false` (abonnement) — aucun tour Claude joué dans cette
 *   session sidecar : ce n'est pas une panne, c'est un relevé qui n'existe
 *   pas encore ;
 * - `disponible: false` (crédits) — clé non configurée : un état CHOISI, qui
 *   ne changera pas d'ici au prochain essai. T-057 l'a sorti des erreurs de
 *   protocole pour qu'il cesse d'écrire 1 197 lignes rouges par mois.
 */
import { request, type RequestOptions } from "./sidecar";

export interface ClaudeUsageWindow {
  utilization: number;
  resetsAt: string;
}

/**
 * T-059 — un refus de la sonde pour cause de compte SATURÉ : ce n'est pas un
 * relevé chiffré (`available` reste `false`), mais ce n'est pas non plus rien
 * — le message du refus PORTE la fenêtre en cause et son heure de
 * réinitialisation. Voir sidecar/src/claudeSaturation.ts, qui le parse.
 */
export interface RefusSaturationClaude {
  fenetre: "session" | "hebdo";
  resetsAt: string | null;
}

/** Dernier instantané connu des limites d'abonnement Claude (`usage.claude`). */
export interface ClaudeUsageSnapshot {
  available: boolean;
  subscriptionType: string | null;
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  /**
   * Toutes les fenêtres relayées par le sidecar (clé brute de l'API → fenêtre),
   * dont celles spécifiques à un modèle (ex. hebdo Opus/Fable) — voir
   * docs/protocol.md § usage.claude.
   */
  windows: Record<string, ClaudeUsageWindow>;
  capturedAt: string | null;
  /** `null` hors refus de saturation (l'immense majorité des relevés). */
  saturation: RefusSaturationClaude | null;
}

function parseUsageWindow(value: unknown): ClaudeUsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const w = value as Record<string, unknown>;
  if (typeof w.utilization === "number" && typeof w.resetsAt === "string") {
    return { utilization: w.utilization, resetsAt: w.resetsAt };
  }
  return null;
}

/**
 * Interroge le dernier instantané des limites d'abonnement Claude (fenêtres
 * 5h / 7j). `available: false` tant qu'aucun tour Claude n'a été joué dans
 * cette session sidecar (ou fournisseur clé API, sans limites applicables).
 */
export async function usageClaude(): Promise<ClaudeUsageSnapshot> {
  const { done } = request("usage.claude", {});
  return parseClaudeUsageSnapshot(await done);
}

/**
 * Initialise le relevé d'abonnement via un micro-tour Claude économique
 * (haiku, chat pur — voir docs/protocol.md § usage.claude.init). À réserver à
 * une action explicite de l'utilisateur.
 */
export async function usageClaudeInit(options: RequestOptions = {}): Promise<ClaudeUsageSnapshot> {
  const { done } = request("usage.claude.init", {}, options);
  return parseClaudeUsageSnapshot(await done);
}

function parseSaturation(value: unknown): RefusSaturationClaude | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.fenetre !== "session" && v.fenetre !== "hebdo") return null;
  return { fenetre: v.fenetre, resetsAt: typeof v.resetsAt === "string" ? v.resetsAt : null };
}

function parseClaudeUsageSnapshot(data: Record<string, unknown>): ClaudeUsageSnapshot {
  if (data.available !== true) {
    return {
      available: false,
      subscriptionType: null,
      fiveHour: null,
      sevenDay: null,
      windows: {},
      capturedAt: null,
      saturation: parseSaturation(data.saturation),
    };
  }
  const windows: Record<string, ClaudeUsageWindow> = {};
  if (data.windows && typeof data.windows === "object") {
    for (const [key, value] of Object.entries(data.windows as Record<string, unknown>)) {
      const parsed = parseUsageWindow(value);
      if (parsed) windows[key] = parsed;
    }
  }
  return {
    available: true,
    subscriptionType: typeof data.subscriptionType === "string" ? data.subscriptionType : null,
    fiveHour: parseUsageWindow(data.fiveHour),
    sevenDay: parseUsageWindow(data.sevenDay),
    windows,
    capturedAt: typeof data.capturedAt === "string" ? data.capturedAt : null,
    saturation: null,
  };
}

/** Crédits restants OpenRouter (montants en dollars). Rejette si clé absente/erreur réseau. */
export interface OpenrouterUsage {
  totalCredits: number;
  totalUsage: number;
  remaining: number;
}

/**
 * T-057 — relevé impossible pour une raison CHOISIE ou durable (pas de clé
 * configurée). Ce n'est pas une panne du protocole : le sidecar répond `done`,
 * l'appelant l'affiche comme une absence de relevé, et RIEN n'est réessayé —
 * réessayer une clé absente toutes les 15 s était le deuxième moteur du bruit.
 */
export interface ReleveIndisponible {
  disponible: false;
  raison: string;
}

export function releveIndisponible(r: OpenrouterUsage | ReleveIndisponible): r is ReleveIndisponible {
  return (r as ReleveIndisponible).disponible === false;
}

export async function usageCredits(
  providerId: string,
  options: RequestOptions = {},
): Promise<OpenrouterUsage | ReleveIndisponible> {
  const { done } = request("usage.credits", { providerId }, options);
  const data = await done;
  if (data.disponible === false) {
    return {
      disponible: false,
      raison: typeof data.raison === "string" ? data.raison : "inconnue",
    };
  }
  return {
    totalCredits: typeof data.totalCredits === "number" ? data.totalCredits : 0,
    totalUsage: typeof data.totalUsage === "number" ? data.totalUsage : 0,
    remaining: typeof data.remaining === "number" ? data.remaining : 0,
  };
}
