/**
 * Questions interactives de l'agent — serveur MCP in-process `studio`
 * (outil `mcp__studio__ask_user`), consommé par claude.ts.
 *
 * Pourquoi un outil MAISON plutôt que l'`AskUserQuestion` intégré du CLI :
 * ce dernier n'est pas adressable par l'API programmatique du SDK (voir le
 * champ `disallowedTools` de claude.ts) — `canUseTool` ne sait qu'autoriser
 * ou refuser, jamais FOURNIR une réponse qui devienne le résultat de l'outil.
 * Ici, on maîtrise les deux bouts : le schéma d'entrée ET la valeur rendue au
 * modèle. Le tour reste bloqué dans le handler tant que l'humain n'a pas
 * répondu — c'est exactement la sémantique voulue.
 *
 * Le pont vers l'UI (`AskUserBridge`) est fourni par claude.ts : il émet un
 * chunk `permission_request` (toolName `AskUserQuestion`, même charge utile
 * que l'outil intégré) et attend le `claude.permission` correspondant. On
 * réutilise volontairement ce canal : la modale à choix cliquables de
 * `AgentPage` le rend déjà (voir docs/protocol.md, § Questions interactives).
 *
 * `context` (T-089, 2026-08-27) : les questions portaient sur des objets que
 * l'utilisateur n'avait pas sous les yeux — et la modale, bloquante, l'empêchait
 * justement d'aller les regarder. Le champ oblige l'agent à joindre ce qu'il a
 * déjà mesuré. La modale est devenue non bloquante en même temps (voir
 * ui/src/PermissionModal.tsx) : les deux moitiés du même constat.
 *
 * Jamais exposé en mode chat pur ni aux tours headless (orchestration,
 * planificateur) : sans humain devant l'écran, la question ne serait jamais
 * répondue et le tour resterait bloqué jusqu'au garde-fou. C'est le paramètre
 * `interactive` de `claude.start` qui l'arme.
 */

import * as journal from "./journal.js";

/** Réponse de l'humain, telle que rendue au modèle. */
export interface AskUserAnswer {
  /** `false` = question ignorée (ou tour interrompu) : l'agent doit continuer sans. */
  answered: boolean;
  /** Texte composé des choix retenus (+ complément libre éventuel). */
  text: string;
}

/** Pont fourni par claude.ts : pose la question à l'UI et attend la réponse. */
export type AskUserBridge = (questions: unknown) => Promise<AskUserAnswer>;

const TOOL_DESCRIPTION = [
  "Pose une ou plusieurs questions à l'utilisateur et ATTEND sa réponse :",
  "l'app affiche un formulaire à choix cliquables et ton tour reprend avec la",
  "réponse comme résultat de l'outil.",
  "Utilise-le dès qu'un choix ou une précision de l'utilisateur conditionne la",
  "suite du travail (arbitrage, périmètre, option A/B, confirmation d'hypothèse),",
  "AU LIEU d'écrire la question en texte : une question posée en texte termine",
  "ton tour et oblige l'utilisateur à tout recopier à la main.",
  "1 à 4 questions par appel, 2 à 4 options par question ; l'utilisateur peut",
  "toujours ajouter une réponse libre.",
  "N'appelle pas cet outil pour ce que tu peux vérifier toi-même dans le projet.",
  "RÈGLE : si la question porte sur quelque chose que l'utilisateur n'a pas sous",
  "les yeux (un dossier, un fichier, un écart entre deux versions, un chiffre),",
  "renseigne `context` avec les faits que TU as déjà vérifiés — listing, tailles,",
  "dates, extrait. Sans ça il doit trancher sur ce qu'il n'a pas vu.",
  "`context` porte ce que tu as mesuré, jamais tes suppositions.",
].join(" ");

/**
 * Construit le serveur MCP `studio`. `null` (l'agent tourne sans l'outil, il
 * posera ses questions en texte) en mode faux SDK — les tests ne doivent
 * jamais importer le vrai SDK — ou si l'import échoue.
 */
export async function buildAskUserMcpServer(ask: AskUserBridge): Promise<unknown | null> {
  if (process.env.IACTION_FAKE_CLAUDE === "1") {
    return null;
  }
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const { z } = await import("zod/v4");
    const askTool = sdk.tool(
      "ask_user",
      TOOL_DESCRIPTION,
      {
        questions: z
          .array(
            z.object({
              question: z.string().describe("La question, formulée en une phrase claire"),
              header: z
                .string()
                .describe("Étiquette très courte (max ~12 caractères) affichée en pastille, ex. « Périmètre »"),
              multiSelect: z
                .boolean()
                .optional()
                .describe("true si plusieurs options peuvent être retenues ensemble (défaut false)"),
              context: z
                .string()
                .optional()
                .describe(
                  "Faits VÉRIFIÉS qui permettent de trancher sans aller voir ailleurs : listing " +
                    "de fichiers avec tailles et dates, extrait, chiffres relevés. Affiché tel quel " +
                    "au-dessus des choix, en préformaté (les sauts de ligne sont conservés). " +
                    "Obligatoire dès que la question porte sur ce que l'utilisateur n'a pas sous les yeux.",
                ),
              options: z
                .array(
                  z.object({
                    label: z.string().describe("Le choix, 1 à 5 mots"),
                    description: z
                      .string()
                      .optional()
                      .describe("Ce qu'implique ce choix (une phrase)"),
                  }),
                )
                .describe("2 à 4 choix distincts ; ne pas ajouter d'option « Autre » (l'app la fournit)"),
            }),
          )
          .describe("1 à 4 questions posées ensemble"),
      },
      async (args) => {
        const outcome = await ask(args.questions);
        if (!outcome.answered) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "L'utilisateur n'a pas répondu à la question (ignorée ou tour interrompu)." +
                  (outcome.text ? ` Précision : ${outcome.text}` : "") +
                  " Poursuis avec l'hypothèse la plus raisonnable en l'annonçant, ou repose la question en texte.",
              },
            ],
          };
        }
        return { content: [{ type: "text" as const, text: outcome.text }] };
      },
    );
    return sdk.createSdkMcpServer({ name: "studio", tools: [askTool] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `warn` : le tour continue, l'agent posera ses questions en texte.
    journal.warn("claude", "serveur MCP studio (ask_user) indisponible", {
      fields: { erreur: message },
    });
    return null;
  }
}
