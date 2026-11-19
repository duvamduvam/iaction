/**
 * Outil `mcp__studio__secrets_lister` — l'agent découvre les NOMS des secrets
 * du poste, pour les référencer `${SECRET:nom}` dans `.mcp.json`
 * (docs/etude-coffre-secrets.md § 6.2, T-220).
 *
 * Cause directe de T-220 : rien ne disait à un agent qu'un coffre existait,
 * ni sous quel nom référencer un jeton ; il a posé un `.env`. Cet outil, la
 * consigne de l'instruction système (paletteTour.ts) et le garde d'écriture
 * (gardeSecrets.ts) ferment la voie ensemble.
 *
 * Contrat : des noms et un état, JAMAIS une valeur. Sans validation (rien à
 * protéger : il ne lit que des noms).
 */

import type { SdkTool } from "./changerModele.js";
import { nomsSecretsDisponibles } from "./mcpSecrets.js";

export const SECRETS_LISTER_TOOL_NAME = "mcp__studio__secrets_lister";

/** Cœur de l'outil, testable sans SDK. */
export async function executerSecretsLister(): Promise<string> {
  const { etat, noms } = await nomsSecretsDisponibles();
  const lignes = [
    `État du coffre : ${etat === "ouvert" ? "ouvert" : etat === "verrouille" ? "verrouillé (déverrouillage par l'utilisateur, en-tête d'IAction)" : "aucun coffre sur ce poste"}.`,
    noms.length > 0
      ? `Secrets disponibles pour les serveurs MCP (${noms.length}) : ${noms.map((n) => `\`${n}\``).join(", ")}.`
      : "Aucun secret MCP disponible en ce moment.",
    "Référence dans `.mcp.json` : `\"env\": { \"JETON\": \"${SECRET:nom}\" }` (ou dans headers, args, url).",
    "Un secret absent se demande à l'utilisateur : il le saisit dans IAction (catalogue MCP ou écran « Secrets du coffre »). N'écris jamais de jeton dans un fichier du projet.",
  ];
  return lignes.join("\n");
}

const DESCRIPTION = [
  "Liste les NOMS des secrets du coffre d'IAction utilisables par les serveurs MCP",
  "(jamais leurs valeurs) et rappelle comment les référencer `${SECRET:nom}` dans `.mcp.json`.",
  "Appelle-le avant de brancher un serveur ou un script qui a besoin d'un jeton, au lieu",
  "d'écrire un `.env` (refusé).",
].join(" ");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Zod = any;

/** Même patron que `creerOutilCompacter`. */
export function creerOutilSecretsLister(sdk: SdkTool, _z: Zod): unknown {
  return sdk.tool(
    "secrets_lister",
    DESCRIPTION,
    {} as never,
    (async () => ({
      content: [{ type: "text" as const, text: await executerSecretsLister() }],
    })) as never,
  );
}
