/**
 * L'agent arme lui-même le réveil d'IAction (T-219) — outil MCP
 * `mcp__studio__programmer_reveil`, servi par le serveur in-process `studio`
 * (voir askUser.ts, `buildStudioMcpServer`), consommé par claude.ts.
 *
 * Avant lui, l'agent invité à « se réveiller à 19 h » chargeait `CronCreate`
 * (outil du CLI) : la tâche meurt avec le processus du tour SDK, rien ne
 * partait, et il annonçait quand même « je programme moi-même le réveil ».
 * Les outils Cron du CLI sont désormais interdits (claude.ts,
 * `OUTILS_CRON_INTERDITS`) et celui-ci les remplace.
 *
 * L'outil n'arme RIEN dans le sidecar : il émet le chunk `reveil_demande` ;
 * l'UI arme un `Reveil` (ui/src/reveil.ts, T-120) sur la conversation du tour,
 * visible et annulable dans ⏰. Le réveil ne part que si l'application reste
 * ouverte (T-121 : pas de réveil headless).
 *
 * Périmètre : tours `interactive` (page Projets), jamais en chat pur — même
 * règle que `compacter`, pour la même raison : sans la page ouverte, personne
 * ne recevrait le chunk. Exposé aussi quand le modèle est verrouillé.
 */

import * as journal from "./journal.js";
import type { SdkTool } from "./changerModele.js";

/** Nom complet côté SDK : `mcp__<serveur>__<outil>`. */
export const REVEIL_TOOL_NAME = "mcp__studio__programmer_reveil";

/** Outils du CLI qui promettent une reprise sans la tenir : interdits sur les tours SDK (voir l'en-tête). */
export const OUTILS_CRON_INTERDITS = ["CronCreate", "CronList", "CronDelete", "ScheduleWakeup"] as const;

/** Ce que l'outil demande à l'UI d'armer. */
export interface DemandeReveil {
  heures: string[];
  surResetQuota: boolean;
  prompts: string[];
  raison: string;
}

/** Ce que l'outil fait de l'extérieur — fourni par claude.ts. */
export interface PontReveil {
  /** Émet le chunk `reveil_demande` vers l'UI. */
  emettre: (demande: DemandeReveil) => void;
  /** Pour le journal. */
  sessionId: () => string | null;
}

/** Même grammaire que `estHeureValide` (ui/src/reveil.ts) : « HH:MM », souple sur le zéro de tête. */
const FORMAT_HEURE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Ce que le modèle lit après un armement accepté. */
export const REPONSE_REVEIL =
  "Réveil armé : il est visible et annulable dans le contrôle ⏰ de la conversation. Il ne part que si l'application IAction reste ouverte à l'heure dite. Termine ton tour normalement ; ne programme rien d'autre pour cette reprise.";

/** Réponse d'erreur (rendue au modèle comme texte, `isError`) — le journal garde le motif. */
export interface ResultatReveil {
  texte: string;
  erreur: boolean;
}

/** Cœur de l'outil, testable sans SDK : valide, émet, journalise, répond. */
export function executerReveil(
  args: { heures?: string[]; surResetQuota?: boolean; prompts?: string[]; raison: string },
  pont: PontReveil,
): ResultatReveil {
  const heures = [...new Set((args.heures ?? []).map((h) => h.trim()).filter((h) => FORMAT_HEURE.test(h)))].sort();
  const surResetQuota = args.surResetQuota === true;
  const prompts = (args.prompts ?? []).map((p) => p.trim()).filter((p) => p !== "");
  const refus =
    prompts.length === 0
      ? "Réveil refusé : `prompts` est vide — dis ce qui doit repartir au réveil."
      : heures.length === 0 && !surResetQuota
        ? "Réveil refusé : aucune heure valide (format « HH:MM », ex. « 19:00 ») et `surResetQuota` est faux — rien ne déclencherait le réveil."
        : null;
  if (refus !== null) {
    journal.warn("claude", "réveil demandé par l'agent refusé", {
      fields: { sessionId: pont.sessionId(), motif: refus, heuresRecues: args.heures ?? [], surResetQuota },
    });
    return { texte: refus, erreur: true };
  }
  pont.emettre({ heures, surResetQuota, prompts, raison: args.raison });
  journal.info("claude", "réveil demandé par l'agent", {
    fields: { sessionId: pont.sessionId(), heures, surResetQuota, prompts: prompts.length, raison: args.raison },
  });
  return { texte: REPONSE_REVEIL, erreur: false };
}

const DESCRIPTION = [
  "Programme un réveil d'IAction sur cette conversation : à une ou plusieurs heures",
  "(« HH:MM », heure locale) et/ou dès que le quota se rouvre (`surResetQuota`),",
  "les `prompts` sont envoyés à ta place, dans l'ordre. L'utilisateur voit le réveil",
  "dans le contrôle ⏰ et peut l'annuler ; il ne part que si l'application IAction",
  "reste ouverte. À utiliser pour TOUTE reprise à une heure donnée ou au reset du",
  "quota. N'utilise jamais CronCreate ni ScheduleWakeup : ils meurent avec le tour",
  "et ne déclenchent rien. Après l'appel, termine ton tour normalement.",
].join(" ");

/** Sous-ensemble de zod/v4 utilisé pour le schéma d'entrée. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Zod = any;

/** Construit l'outil MCP. Même patron que `creerOutilCompacter`. */
export function creerOutilReveil(sdk: SdkTool, z: Zod, pont: PontReveil): unknown {
  return sdk.tool(
    "programmer_reveil",
    DESCRIPTION,
    {
      heures: z.array(z.string()).describe("Heures locales « HH:MM » (ex. « 19:00 ») ; tableau vide si seul le reset du quota compte"),
      surResetQuota: z.boolean().default(false).describe("Aussi dès que la fenêtre de quota se rouvre"),
      prompts: z.array(z.string().min(1)).min(1).describe("Messages envoyés au réveil, dans l'ordre (au moins un)"),
      raison: z.string().min(1).describe("Une phrase : pourquoi ce réveil (affichée à l'utilisateur)"),
    } as never,
    (async (args: { heures: string[]; surResetQuota?: boolean; prompts: string[]; raison: string }) => {
      const r = executerReveil(args, pont);
      return { content: [{ type: "text" as const, text: r.texte }], ...(r.erreur ? { isError: true } : {}) };
    }) as never,
  );
}
