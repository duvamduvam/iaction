/**
 * L'agent demande lui-même le compactage de sa conversation (T-216) — outil
 * MCP `mcp__studio__compacter`, servi par le serveur in-process `studio`
 * (voir askUser.ts, `buildStudioMcpServer`), consommé par claude.ts.
 *
 * Avant lui, l'agent répondait « tu peux lancer /compact, je ne peux pas le
 * faire moi-même ». L'outil ne compacte RIEN dans le tour : `/compact` est une
 * commande du CLI qui part comme un tour à part entière. Il émet le chunk
 * `compaction_demandee` ; l'UI met `/compact` en file pour la conversation,
 * exactement comme le bouton « Compacter » pendant un tour en cours, et
 * l'envoie quand le tour rend la main (avis « Annuler » sur la bulle).
 *
 * Périmètre : tours `interactive` (page Projets), jamais en chat pur — même
 * règle que `changer_modele`, et pour la même raison : sans la page ouverte,
 * personne ne viderait la file. Mais il reste exposé quand le modèle est
 * verrouillé (`modeleVerrouille`) : le verrou porte sur le modèle, pas sur le
 * contexte.
 */

import * as journal from "./journal.js";
import type { SdkTool } from "./changerModele.js";

/** Nom complet côté SDK : `mcp__<serveur>__<outil>`. */
export const COMPACTER_TOOL_NAME = "mcp__studio__compacter";

/** Ce que l'outil fait de l'extérieur — fourni par claude.ts. */
export interface PontCompacter {
  /** Émet le chunk `compaction_demandee` vers l'UI. */
  emettre: (raison: string) => void;
  /** Pour le journal. */
  sessionId: () => string | null;
}

/** Ce que le modèle lit après l'appel. */
export const REPONSE_COMPACTER =
  "Compactage programmé : il partira dès la fin de ce tour. Termine ton tour normalement (résumé court de l'état si utile).";

/** Cœur de l'outil, testable sans SDK : émet, journalise, répond. */
export function executerCompacter(args: { raison: string }, pont: PontCompacter): string {
  pont.emettre(args.raison);
  journal.info("claude", "compactage demandé par l'agent", {
    fields: { sessionId: pont.sessionId(), raison: args.raison },
  });
  return REPONSE_COMPACTER;
}

const DESCRIPTION = [
  "Programme le compactage de cette conversation (équivalent de /compact) :",
  "il part automatiquement dès la fin du tour en cours, l'utilisateur peut l'annuler.",
  "Appelle-le quand le contexte devient lourd (jauge élevée), à une transition",
  "naturelle du travail, ou quand l'utilisateur le demande — au lieu de lui",
  "demander de taper /compact. Pas plus d'une fois par tour.",
  "Après l'appel, termine ton tour normalement.",
].join(" ");

/** Sous-ensemble de zod/v4 utilisé pour le schéma d'entrée. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Zod = any;

/** Construit l'outil MCP. Même patron que `creerOutilChangerModele`. */
export function creerOutilCompacter(sdk: SdkTool, z: Zod, pont: PontCompacter): unknown {
  return sdk.tool(
    "compacter",
    DESCRIPTION,
    {
      raison: z.string().min(1).describe("Une phrase : pourquoi compacter maintenant (affichée à l'utilisateur)"),
    } as never,
    (async (args: { raison: string }) => ({
      content: [{ type: "text" as const, text: executerCompacter(args, pont) }],
    })) as never,
  );
}
