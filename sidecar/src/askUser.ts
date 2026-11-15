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
import { CHANGER_MODELE_TOOL_NAME, creerOutilChangerModele, type PontChangerModele, type SdkTool } from "./changerModele.js";
import { COMPACTER_TOOL_NAME, creerOutilCompacter, type PontCompacter } from "./compacterOutil.js";
import { ASK_USER_TOOL_NAME } from "./paletteTour.js";

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
  "`context` est rendu en Markdown : présente les données tabulaires en TABLEAU",
  "Markdown à colonnes courtes (jamais d'alignement à l'espace) ; un bloc de code",
  "seulement pour un vrai listing ou extrait ; reste concis (≈ 20 lignes au plus,",
  "l'essentiel pour trancher).",
].join(" ");

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");
type Zod = (typeof import("zod/v4"))["z"];

/** L'outil `ask_user` (le seul de ce fichier qui parle à l'humain). */
export function creerOutilAskUser(sdk: Sdk, z: Zod, ask: AskUserBridge) {
  return sdk.tool(
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
                  "de fichiers avec tailles et dates, extrait, chiffres relevés. Rendu en " +
                  "Markdown au-dessus des choix : données tabulaires en TABLEAU Markdown à colonnes " +
                  "courtes (jamais d'alignement à l'espace), bloc de code seulement pour un vrai " +
                  "listing ou extrait, concis (≈ 20 lignes au plus, l'essentiel pour trancher). " +
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
}

/** Ce que le tour demande au serveur `studio` (T-207 : plus seulement `ask_user`). */
export interface OutilsStudio {
  /** Pont de `ask_user` — `null` : pas d'humain devant l'écran (tour headless). */
  ask: AskUserBridge | null;
  /** Pont de `changer_modele` — `null` : chat pur ou agent à modèle fixe. */
  changerModele: PontChangerModele | null;
  /** T-216 — pont de `compacter` — `null` : chat pur ou tour headless (le verrou du modèle ne le retire pas). */
  compacter: PontCompacter | null;
}

/** Le serveur construit, et ce qu'il expose réellement (pour l'annonce système). */
export interface ServeurStudio {
  serveur: unknown;
  /** `ask_user` est bien dans le serveur. */
  ask: boolean;
  changerModele: boolean;
  compacter: boolean;
}

/**
 * Outils `studio` que `canUseTool` (claude.ts) autorise sans modale.
 * - `ask_user` EST déjà une interaction humaine : demander en plus
 *   l'autorisation de l'utiliser afficherait deux modales à la suite.
 * - `changer_modele` (T-207) — décision de David : SANS validation, le
 *   bandeau « Annuler » de l'UI informe après coup.
 * - `compacter` (T-216) — même patron : l'avis « Annuler » de la bulle.
 */
export function outilStudioSansValidation(toolName: string): boolean {
  return toolName === ASK_USER_TOOL_NAME || toolName === CHANGER_MODELE_TOOL_NAME || toolName === COMPACTER_TOOL_NAME;
}

/**
 * Construit le serveur MCP `studio` regroupant les outils internes du tour
 * (T-216 : `compacter` aussi ; T-207 : `ask_user` conditionnel, `changer_modele` pour TOUT tour projet
 * Claude — un seul nom de serveur, donc `mcp__studio__changer_modele` comme
 * la spec le nomme, ce qu'un second serveur n'aurait pas permis).
 *
 * `null` si aucun outil n'est demandé, en mode faux SDK — les tests ne doivent
 * jamais importer le vrai SDK — ou si l'import échoue (l'agent tourne sans
 * l'outil : il posera ses questions en texte).
 *
 * Exception de test : avec `IACTION_FAKE_CLAUDE_STUDIO=1`, le faux SDK reçoit
 * un serveur de substitution `{ outilsFactices }` dont les gestionnaires sont
 * les VRAIS (zod réel, vraie émission du chunk) — c'est ce qui permet au faux
 * moteur d'appeler `changer_modele` et de capturer un témoin de protocole émis
 * par le vrai sidecar. `ask_user` n'y figure jamais.
 */
export async function buildStudioMcpServer(outils: OutilsStudio): Promise<ServeurStudio | null> {
  if (outils.ask === null && outils.changerModele === null && outils.compacter === null) return null;
  const faux = process.env.IACTION_FAKE_CLAUDE === "1";
  if (faux && process.env.IACTION_FAKE_CLAUDE_STUDIO !== "1") return null;
  try {
    const { z } = await import("zod/v4");
    if (faux) {
      const outilsFactices: Record<string, (args: unknown) => Promise<unknown>> = {};
      const sdkFactice: SdkTool = {
        tool: (nom, _description, _schema, gestionnaire) => {
          outilsFactices[nom] = gestionnaire as unknown as (args: unknown) => Promise<unknown>;
          return nom;
        },
      };
      if (outils.changerModele) creerOutilChangerModele(sdkFactice, z, outils.changerModele);
      if (outils.compacter) creerOutilCompacter(sdkFactice, z, outils.compacter);
      return { serveur: { outilsFactices }, ask: false, changerModele: outils.changerModele !== null, compacter: outils.compacter !== null };
    }
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const tools = [
      ...(outils.ask ? [creerOutilAskUser(sdk, z, outils.ask)] : []),
      ...(outils.changerModele ? [creerOutilChangerModele(sdk, z, outils.changerModele)] : []),
      ...(outils.compacter ? [creerOutilCompacter(sdk, z, outils.compacter)] : []),
    ];
    return {
      // T-210 — `alwaysLoad` : outils jamais DIFFÉRÉS derrière ToolSearch. Sans
      // lui, le modèle ne voyait que leurs noms, sans la description qui dit
      // quand les appeler — et ne les appelait jamais. Option documentée par
      // le SDK (sdk.d.ts, `CreateSdkMcpServerOptions.alwaysLoad` : posée en
      // `_meta['anthropic/alwaysLoad']` sur chaque outil, équivalent API de
      // `defer_loading: false`).
      serveur: sdk.createSdkMcpServer({ name: "studio", tools: tools as never, alwaysLoad: true }),
      ask: outils.ask !== null,
      changerModele: outils.changerModele !== null,
      compacter: outils.compacter !== null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // `warn` : le tour continue, sans ces outils (questions en texte, modèle inchangé).
    journal.warn("claude", "serveur MCP studio indisponible", {
      fields: { erreur: message },
    });
    return null;
  }
}
