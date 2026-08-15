/*
 * Ce que le tour ANNONCE au modèle : sa palette d'outils, et l'instruction
 * système qui la commente (T-019).
 *
 * ── Le défaut que ce module existe pour rendre visible ──────────────────
 * Le 2026-08-09, l'agent a cessé de solliciter `mcp__studio__ask_user` et
 * s'est mis à poser ses questions en prose. L'outil n'était pas cassé : il
 * n'était plus DEMANDÉ. Or rien ne permettait de trancher entre « le modèle
 * l'ignore » et « il ne lui est pas proposé » — la ligne de journal du tour
 * comptait les serveurs et les outils (`connectes:5, outils:39`) sans jamais
 * les NOMMER. Un mois d'occurrences n'aurait pas fait avancer d'un pas.
 *
 * D'où `resumerPalette` : la présence de l'outil de question devient un fait
 * lisible dans `app.jsonl`, pas une supposition.
 */

/**
 * Nom complet de l'outil de question interactive : côté SDK, un outil servi
 * par un serveur MCP s'appelle `mcp__<serveur>__<outil>` (ici serveur `studio`,
 * outil `ask_user` — voir askUser.ts).
 */
export const ASK_USER_TOOL_NAME = "mcp__studio__ask_user";

/** Un serveur MCP tel que l'instantané du tour le décrit. */
export interface ServeurPalette {
  name: string;
  status: string;
  tools: string[];
}

/** Au-delà, la liste des serveurs cesse de tenir dans une ligne de journal. */
const MAX_SERVEURS_NOMMES = 12;

/**
 * Résumé de la palette pour le journal : les serveurs NOMMÉS avec leur compte
 * d'outils, et surtout la présence de l'outil demandé.
 *
 * On ne journalise pas les 39 noms d'outils : ce serait illisible et
 * l'information utile n'y gagnerait rien. Le fait décisif — « l'outil de
 * question est-il dans la palette ? » — est extrait à part, en clair.
 */
export function resumerPalette(
  serveurs: ServeurPalette[],
  outilAttendu: string,
): Record<string, string | number | boolean> {
  const nommes = serveurs
    .slice(0, MAX_SERVEURS_NOMMES)
    .map((s) => `${s.name}:${s.tools.length}`)
    .join(", ");
  const reste = serveurs.length - MAX_SERVEURS_NOMMES;
  return {
    connectes: serveurs.filter((s) => s.tools.length > 0).length,
    muets: serveurs.filter((s) => s.tools.length === 0).length,
    outils: serveurs.reduce((somme, s) => somme + s.tools.length, 0),
    serveurs: reste > 0 ? `${nommes}, +${reste}` : nommes,
    // Le fait que T-019 réclamait, et qu'aucune ligne ne disait.
    questionInteractive: serveurs.some((s) => s.tools.includes(outilAttendu)),
  };
}

/**
 * Instruction système annonçant l'outil de question interactive.
 *
 * ── Pourquoi l'instruction système, et pas la fiche de connaissances ────
 * L'outil n'était documenté au modèle que par `connaissances/iaction.md` —
 * une source de RAG, qu'il faut CHERCHER pour lire. Une capacité aussi
 * structurante que « je peux poser une question à l'humain et attendre sa
 * réponse » ne peut pas dépendre d'une recherche que le modèle ne fera que
 * s'il a déjà l'idée de la faire. L'instruction système, elle, part à chaque
 * tour.
 *
 * Formulé comme une CAPACITÉ et un critère d'emploi, pas comme un ordre :
 * « tu DOIS utiliser cet outil » produirait des questions là où le modèle
 * devait décider seul — le défaut inverse, et plus agaçant.
 */
export const ANNONCE_QUESTION_INTERACTIVE = [
  "Tu disposes de l'outil `mcp__studio__ask_user` : il affiche tes questions à",
  "l'utilisateur sous forme de choix cliquables et attend sa réponse. Utilise-le",
  "quand une réponse changerait réellement le travail à faire — un arbitrage, une",
  "ambiguïté que le code ne tranche pas — plutôt que de poser tes questions en",
  "prose dans ta réponse. Pour ce qu'un collègue attentif déciderait seul, décide",
  "et poursuis.",
].join(" ");

/** Forme acceptée par le SDK : prompt propre, ou preset Claude Code + ajout. */
export type InstructionSysteme =
  | string
  | { type: "preset"; preset: "claude_code"; append?: string };

/**
 * Instruction système du tour (T-019 pour l'annonce, T-052 pour le preset).
 *
 * ── Ce que le SDK fait quand on ne dit rien, et pourquoi c'était un piège ─
 * `sdk.mjs` (0.3.214) : `if (i === undefined) f = ""`. Sans `systemPrompt`, le
 * SDK **agent** n'utilise PAS le prompt de Claude Code — il en envoie un
 * **VIDE**. Et une chaîne le REMPLACE. Nos tours de projet tournaient donc
 * depuis le passage à ce SDK avec les outils intégrés de Claude Code
 * (Read/Write/Edit/Bash/Grep) et **aucune instruction pour les cadrer**, tandis
 * qu'un agent avec instructions effaçait le preset au lieu de s'y ajouter. Rien
 * dans le dépôt ne mentionnait ce basculement : il s'est fait en silence.
 *
 * ── L'arbitrage, tranché le 2026-08-15 ──────────────────────────────────
 * **Tour de projet** (outils intégrés armés) : `preset: "claude_code"`, et tout
 * ce que nous avons à dire passe par `append`. Ces outils ont été conçus pour
 * être pilotés par ce prompt ; les servir sans lui était l'anomalie, pas
 * l'inverse. L'instruction de l'agent s'AJOUTE désormais au lieu d'effacer.
 *
 * **Chat pur** (`tools: []`, aucun outil) : rien ne change. Un prompt de
 * copilote de code n'a rien à faire dans une conversation sans outils, et lui
 * imposer le preset serait le symétrique du défaut qu'on corrige.
 *
 * Ce choix est RAISONNÉ, pas mesuré : comparer deux prompts système demande des
 * tours réels sur des tâches outillées, donc de la dépense d'abonnement. Le
 * ticket demandait de trancher explicitement et de l'écrire — c'est fait ici et
 * dans `docs/protocol.md`. Si le preset se révélait nuisible, le retour arrière
 * tient en un booléen.
 */
export function composerInstructionSysteme(
  instructionAgent: string | null,
  annoncerQuestion: boolean,
  outilsIntegres: boolean,
): InstructionSysteme | undefined {
  const morceaux = [instructionAgent, annoncerQuestion ? ANNONCE_QUESTION_INTERACTIVE : null].filter(
    (m): m is string => typeof m === "string" && m.trim().length > 0,
  );
  const ajout = morceaux.join("\n\n");
  if (outilsIntegres) {
    return { type: "preset", preset: "claude_code", ...(ajout ? { append: ajout } : {}) };
  }
  return ajout || undefined;
}
