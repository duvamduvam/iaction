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

/**
 * T-210 — les outils d'action du serveur `studio` (T-219 : `programmer_reveil` aussi), annoncés seulement
 * quand ils sont exposés. Constat du 2026-11-08 : l'agent écrivait « Opus
 * suffit » ou « tu peux lancer /compact » au lieu d'appeler l'outil. La
 * consigne globale du poste lui demande de SIGNALER ; ces phrases lui disent
 * qu'ici, il peut FAIRE.
 */
export const ANNONCE_CHANGER_MODELE =
  "Quand le modèle n'est pas le bon pour la demande, appelle `mcp__studio__changer_modele` au lieu de signaler le changement en texte.";
export const ANNONCE_COMPACTER =
  "Quand le contexte doit être compacté, appelle `mcp__studio__compacter` au lieu de demander à l'utilisateur de taper /compact.";
export const ANNONCE_REVEIL =
  "Pour reprendre à une heure donnée ou au reset du quota, appelle `mcp__studio__programmer_reveil` (jamais CronCreate ni ScheduleWakeup, qui ne déclenchent rien) ; le réveil ne part que si l'application IAction reste ouverte.";

/** Ce que le serveur `studio` expose réellement au tour (voir `ServeurStudio`, askUser.ts). */
export interface OutilsAnnonces {
  changerModele: boolean;
  compacter: boolean;
  reveil: boolean;
  /** T-220 — `secrets_lister` exposé : la consigne du coffre l'accompagne. */
  secrets?: boolean;
}

/** Forme acceptée par le SDK : prompt propre, ou preset Claude Code + ajout. */
export type InstructionSysteme =
  | string
  | { type: "preset"; preset: "claude_code"; append?: string };

/**
 * Instruction système du tour (T-019 pour l'annonce, T-052 pour le preset,
 * T-210 pour les outils `studio` d'action).
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
  outilsStudio: OutilsAnnonces | null = null,
): InstructionSysteme | undefined {
  const morceaux = [
    instructionAgent,
    annoncerQuestion ? ANNONCE_QUESTION_INTERACTIVE : null,
    outilsStudio?.changerModele ? ANNONCE_CHANGER_MODELE : null,
    outilsStudio?.compacter ? ANNONCE_COMPACTER : null,
    outilsStudio?.reveil ? ANNONCE_REVEIL : null,
    outilsStudio?.secrets ? CONSIGNE_SECRETS : null, // T-220, dite avec l'outil qui la sert
  ].filter(
    (m): m is string => typeof m === "string" && m.trim().length > 0,
  );
  const ajout = morceaux.join("\n\n");
  if (outilsIntegres) {
    return { type: "preset", preset: "claude_code", ...(ajout ? { append: ajout } : {}) };
  }
  return ajout || undefined;
}

/**
 * T-220 — consigne du coffre (docs/etude-coffre-secrets.md § 6.1). Un agent
 * avait posé un jeton dans un `.env` faute de savoir qu'un coffre existait.
 * Dite avec `secrets_lister`, donc à chaque tour de projet ; le garde d'écriture (gardeSecrets.ts) refuse
 * de toute façon la voie du fichier, et ce texte dit où est l'autre.
 */
export const CONSIGNE_SECRETS =
  "Secrets : un jeton ou une clé ne s'écrit jamais dans un fichier du projet (`.env`, `*.pem`, `*.key` sont refusés). Il se déclare au coffre d'IAction et se référence `${SECRET:nom}` dans l'entrée du serveur de `.mcp.json` (env, headers, args) ; `mcp__studio__secrets_lister` donne les noms disponibles. Un script qui a besoin d'un jeton devient un serveur MCP déclaré ; un secret absent se demande à l'utilisateur.";
