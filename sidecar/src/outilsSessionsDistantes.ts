/*
 * Outils MCP « sessions distantes » pour les agents (T-178,
 * docs/spec-sessions-claude.md § v0.7.0) : un agent — typiquement un
 * sous-agent de projet lancé par l'outil `Agent` — liste les sessions
 * Remote Control des autres machines et dialogue avec l'une d'elles.
 *
 * Ajoutés au serveur MCP interne `iaction` par knowledge.ts, pour tout tour
 * Claude LOCAL (jamais un tour sur session distante : `chatOnly` n'y monte
 * aucun MCP). Ne dépend que du client sessionsDistantes.ts.
 *
 * Pas de rapatriement automatique : l'échange vit dans la conversation locale
 * de l'agent. Le message part préfixé d'une ligne d'origine générique pour que
 * la session distante sache à qui elle parle.
 *
 * T-185 : sur un tour interactif, une session mal branchée et toute
 * permission demandée là-bas passent par la fenêtre de question d'IAction
 * (`demanderUtilisateur`) au lieu d'une erreur ou d'un refus d'office.
 */

import os from "node:os";

import type { AskUserBridge } from "./askUser.js";
import { createTurnPrompt } from "./claudeTurnPrompt.js";
import {
  annotationFil,
  estRelais,
  lireFils,
  noteFil,
  normaliserFil,
  ouvrirFil,
  cheminFilsDefaut,
  type DepsFils,
  type FilDistant,
  type FilOuvert,
} from "./filsSessionsDistantes.js";
import * as journal from "./journal.js";
import {
  creerQueryFnDistant,
  ErreurSessionDistante,
  listerSessionsDistantes,
  type DepsQueryDistant,
  type SessionDistante,
} from "./sessionsDistantes.js";
import { creerVerrous } from "./verrousSessions.js";

export const DELAI_DEFAUT_MINUTES = 15;
export const DELAI_MAX_MINUTES = 30;
/** Au-delà, la liste des outils utilisés là-bas est tronquée. */
const MAX_OUTILS_RESUMES = 20;
const LONGUEUR_RESUME = 120;

export const MESSAGE_PERMISSION_REFUSEE =
  "Un agent ne valide pas de permission à la place de l'utilisateur ; lancez la machine distante en mode sans demande.";

/** Dépendances de test (faux `fetch`, faux `query` browser, horloge de délai). */
export interface DepsOutilsSessionsDistantes extends DepsQueryDistant, DepsFils {
  /** T-180 — conversation IAction du tour (`meta.conversationId`) : clé des sessions créées sur un relais. */
  conversationId?: string | undefined;
  /** Remplace le délai d'attente (ms) — tests seulement. */
  delaiAttenteMs?: number;
  /** Nom de la machine locale — tests seulement (défaut : `os.hostname()`). */
  machine?: string;
  /**
   * T-185 — pont vers la fenêtre de question de l'interface (celui de
   * `ask_user`), fourni par claude.ts aux SEULS tours interactifs. Présent :
   * une session mal branchée ou en attente de validation ouvre une question
   * « Réessayer / Abandonner », et une demande de permission distante est
   * posée à l'utilisateur au lieu d'être refusée d'office. Absent (tour
   * headless, tests) : comportement d'origine, erreur ou refus.
   */
  demanderUtilisateur?: AskUserBridge;
}

/** Au-delà, on cesse de reproposer « Réessayer » : l'erreur part à l'agent. */
const MAX_ESSAIS_BRANCHEMENT = 5;

/** T-180 — verrou par session distante (verrousSessions.ts) : sessions différentes en parallèle. */
const verrousSessions = creerVerrous();

export interface ResultatOutil {
  texte: string;
  erreur: boolean;
}

/** Délai demandé en minutes → borné à [1 ; 30], 15 par défaut. */
export function borneDelaiMinutes(valeur: unknown): number {
  if (typeof valeur !== "number" || !Number.isFinite(valeur)) return DELAI_DEFAUT_MINUTES;
  return Math.min(DELAI_MAX_MINUTES, Math.max(1, valeur));
}

export function ligneOrigine(machine: string): string {
  return `[Message d'un agent de ${machine} via IAction]`;
}

function abreger(texte: string, max: number = LONGUEUR_RESUME): string {
  const ligne = texte.replace(/\s+/g, " ").trim();
  return ligne.length > max ? `${ligne.slice(0, max - 1)}…` : ligne;
}

const CLES_RESUME = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "text"];

function resumerEntree(entree: unknown): string {
  if (typeof entree !== "object" || entree === null) return "";
  const objet = entree as Record<string, unknown>;
  for (const cle of CLES_RESUME) {
    if (typeof objet[cle] === "string" && objet[cle] !== "") return abreger(objet[cle] as string);
  }
  return "";
}

function estDeconnectee(s: Pick<SessionDistante, "connexion">): boolean {
  return s.connexion !== null && s.connexion !== "connected";
}

/**
 * Désigne la session visée. Un identifiant `cse_…` passe tel quel (la
 * connexion est vérifiée à l'ouverture). Un titre désigne la session
 * CONNECTÉE la plus récente de ce titre (cf. T-175) ; plusieurs dépôts
 * différents sous le même titre = ambiguïté, signalée.
 */
export function resoudreSession(
  sessions: SessionDistante[],
  reference: string,
):
  | { ok: true; id: string; titre: string | null; session: SessionDistante | null }
  | { ok: false; message: string; motif: "absente" | "deconnectee" | "ambigue" } {
  const ref = reference.trim();
  if (ref.startsWith("cse_")) {
    const session = sessions.find((s) => s.id === ref) ?? null;
    return { ok: true, id: ref, titre: session?.titre ?? null, session };
  }
  const homonymes = sessions.filter((s) => s.titre === ref);
  if (homonymes.length === 0) {
    return { ok: false, motif: "absente", message: `Aucune session distante intitulée « ${ref} ». Utilisez sessions_distantes_lister pour voir celles qui existent.` };
  }
  const connectees = homonymes.filter((s) => !estDeconnectee(s));
  if (connectees.length === 0) {
    return { ok: false, motif: "deconnectee", message: `Les sessions distantes intitulées « ${ref} » sont déconnectées. Relancez /remote-control sur l'autre machine, puis réessayez.` };
  }
  if (new Set(connectees.map((s) => s.depot)).size > 1) {
    const ids = connectees.map((s) => `${s.id} (${s.depot ?? "sans dépôt"})`).join(", ");
    return { ok: false, motif: "ambigue", message: `Plusieurs sessions connectées portent le titre « ${ref} » sur des dépôts différents : ${ids}. Désignez l'une d'elles par son identifiant.` };
  }
  const recente = [...connectees].sort((a, b) => (b.majLe ?? 0) - (a.majLe ?? 0))[0];
  return { ok: true, id: recente.id, titre: recente.titre, session: recente };
}

/* ---------- T-185 — fenêtres de question : branchement et validations distantes ---------- */

const CHOIX_REESSAYER = "Réessayer";
const CHOIX_ENVOYER = "Envoyer quand même";
const CHOIX_AUTORISER = "Autoriser";

/** Ce qui empêche d'envoyer tout de suite, ou `null` si la session est prête. */
export function problemeBranchement(
  resolue: ReturnType<typeof resoudreSession>,
): { motif: "absente" | "deconnectee" | "validation"; message: string } | null {
  if (!resolue.ok) return resolue.motif === "ambigue" ? null : { motif: resolue.motif, message: resolue.message };
  const s = resolue.session;
  if (s && estDeconnectee(s)) {
    return { motif: "deconnectee", message: `La session distante « ${s.titre ?? s.id} » est déconnectée (état : ${s.connexion}).` };
  }
  if (s && s.travail === "requires_action" && !estRelais(s)) {
    return { motif: "validation", message: `La session distante « ${s.titre ?? s.id} » attend une validation sur sa machine (une demande restée en suspens).` };
  }
  return null;
}

/** Question « session mal branchée » : texte de la fenêtre, choix proposés. */
export function questionBranchement(nom: string, probleme: NonNullable<ReturnType<typeof problemeBranchement>>): unknown[] {
  const conseil =
    probleme.motif === "validation"
      ? `Validez (ou refusez) la demande en attente sur la machine de « ${nom} », puis « ${CHOIX_REESSAYER} ». « ${CHOIX_ENVOYER} » met le message en file derrière elle.`
      : `Sur la machine de « ${nom} », relancez \`claude remote-control --name ${nom}\` (ou \`/remote-control\` dans la session), puis « ${CHOIX_REESSAYER} ».`;
  const options = [
    { label: CHOIX_REESSAYER, description: "Revérifier l'état de la session et envoyer si elle est prête" },
    ...(probleme.motif === "validation" ? [{ label: CHOIX_ENVOYER, description: "Envoyer sans attendre la validation" }] : []),
    { label: "Abandonner", description: "L'agent reçoit l'erreur et poursuit sans la session distante" },
  ];
  return [
    {
      question: probleme.motif === "validation" ? `« ${nom} » attend une validation sur son poste` : `« ${nom} » n'est pas joignable`,
      header: "Distant",
      context: `${probleme.message}\n\n${conseil}`,
      options,
    },
  ];
}

/** Question « permission demandée par la session distante ». */
export function questionPermission(nom: string, outil: string, entree: unknown): unknown[] {
  const objet = typeof entree === "object" && entree !== null ? (entree as Record<string, unknown>) : {};
  const detail =
    typeof objet.command === "string"
      ? `\`\`\`\n${objet.command}\n\`\`\``
      : `\`\`\`json\n${JSON.stringify(entree, null, 2).slice(0, 2000)}\n\`\`\``;
  const description = typeof objet.description === "string" && objet.description ? `${objet.description}\n\n` : "";
  return [
    {
      question: `« ${nom} » demande à utiliser ${outil}`,
      header: "Distant",
      context: `Demande de permission venue de la session distante « ${nom} » (elle s'exécute sur SA machine).\n\n${description}${detail}`,
      options: [
        { label: CHOIX_AUTORISER, description: "La session distante exécute l'outil" },
        { label: "Refuser", description: "La session distante reçoit un refus et poursuit sans" },
      ],
    },
  ];
}

export function formaterListe(sessions: SessionDistante[], fils: readonly FilDistant[] = []): string {
  if (sessions.length === 0) return "Aucune session distante.";
  return sessions
    .map((s) => {
      const quand = s.majLe !== null ? new Date(s.majLe).toISOString() : "inconnue";
      return `- ${s.titre ?? "(sans titre)"} — ${s.id} — connexion : ${s.connexion ?? "inconnue"} — activité : ${s.travail ?? "inconnue"} — dépôt : ${s.depot ?? "aucun"} — dernière activité : ${quand}${annotationFil(s, fils)}`;
    })
    .join("\n");
}

function messageErreur(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function listerPourAgent(deps: DepsOutilsSessionsDistantes = {}): Promise<ResultatOutil> {
  try {
    const { sessions } = await listerSessionsDistantes({}, deps);
    // Les associations ne servent qu'à l'annotation : illisibles, la liste reste rendue (l'erreur est journalisée par lireFils).
    const fils = await lireFils(deps.cheminFils ?? cheminFilsDefaut()).catch(() => []);
    return { texte: formaterListe(sessions, fils), erreur: false };
  } catch (err) {
    journal.error("claude", "outil sessions_distantes_lister en échec", { fields: { cause: messageErreur(err) } });
    return { texte: messageErreur(err), erreur: true };
  }
}

function textesAssistant(message: Record<string, unknown>): { texte: string; outils: string[] } {
  const interne = message.message as { content?: unknown } | undefined;
  const contenu = Array.isArray(interne?.content) ? interne.content : [];
  let texte = "";
  const outils: string[] = [];
  for (const bloc of contenu) {
    if (typeof bloc !== "object" || bloc === null) continue;
    const b = bloc as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") texte += b.text;
    if (b.type === "tool_use" && typeof b.name === "string") {
      const resume = resumerEntree(b.input);
      outils.push(resume ? `${b.name} : ${resume}` : b.name);
    }
  }
  return { texte, outils };
}

/** Envoie `message` à la session visée et attend le `result` du tour distant. */
export async function demanderASession(
  args: { session: string; message: string; delai_minutes?: number; fil?: string },
  deps: DepsOutilsSessionsDistantes = {},
): Promise<ResultatOutil> {
  const refus: string[] = [];
  const autorisees: string[] = [];
  let cible = args.session;
  let libererVerrou: (() => void) | null = null;
  let note = "";
  try {
    if (typeof args.session !== "string" || args.session.trim() === "") throw new ErreurSessionDistante("Paramètre « session » manquant (titre ou identifiant cse_…).");
    if (typeof args.message !== "string" || args.message.trim() === "") throw new ErreurSessionDistante("Paramètre « message » manquant.");
    const demander = deps.demanderUtilisateur;
    let resolue: ReturnType<typeof resoudreSession>;
    let sessions: SessionDistante[];
    for (let essai = 1; ; essai += 1) {
      sessions = (await listerSessionsDistantes({}, deps)).sessions;
      resolue = resoudreSession(sessions, args.session);
      const probleme = problemeBranchement(resolue);
      if (!probleme) break;
      // Sans humain devant l'écran (ou après trop d'essais) : l'agent reçoit l'erreur.
      if (!demander || essai > MAX_ESSAIS_BRANCHEMENT) {
        if (probleme.motif === "validation") break; // état d'origine : envoi en file
        throw new ErreurSessionDistante(probleme.message);
      }
      journal.info("claude", "session distante mal branchée : question à l'utilisateur", { fields: { session: args.session, motif: probleme.motif, essai } });
      const reponse = await demander(questionBranchement(args.session.trim(), probleme));
      if (reponse.answered && reponse.text.startsWith(CHOIX_REESSAYER)) continue;
      if (reponse.answered && probleme.motif === "validation" && reponse.text.startsWith(CHOIX_ENVOYER)) break;
      throw new ErreurSessionDistante(`${probleme.message} Envoi abandonné par l'utilisateur.${reponse.text ? ` Précision : ${reponse.text}` : ""}`);
    }
    if (!resolue.ok) throw new ErreurSessionDistante(resolue.message);
    cible = resolue.id;
    let nom = resolue.titre ?? cible;
    // T-180 — un relais ne reçoit pas de message : on lui fait ouvrir une session pour ce fil de cette conversation.
    const relais = resolue.session;
    if (relais && estRelais(relais)) {
      const fil = normaliserFil(args.fil);
      const ouvert: FilOuvert | null = await ouvrirFil({ conversation: deps.conversationId ?? null, relais, fil, sessions }, deps);
      note = noteFil(ouvert, fil);
      if (ouvert) {
        cible = ouvert.id;
        nom = ouvert.titre;
      }
    }
    if (verrousSessions.occupe(cible)) journal.info("claude", "session distante occupée par un autre échange : mise en file", { fields: { sessionId: cible } });
    libererVerrou = await verrousSessions.prendre(cible);

    const delaiMs = deps.delaiAttenteMs ?? borneDelaiMinutes(args.delai_minutes) * 60_000;
    const prompt = createTurnPrompt(`${ligneOrigine(deps.machine ?? os.hostname())}\n\n${args.message}`, []);
    const canUseTool = async (outil: string, entree?: unknown) => {
      if (demander) {
        const reponse = await demander(questionPermission(nom, outil, entree));
        if (reponse.answered && reponse.text.startsWith(CHOIX_AUTORISER)) {
          autorisees.push(outil);
          const champs = typeof entree === "object" && entree !== null ? (entree as Record<string, unknown>) : {};
          return { behavior: "allow" as const, updatedInput: champs };
        }
        refus.push(outil);
        return { behavior: "deny" as const, message: `Refusé par l'utilisateur depuis IAction.${reponse.text ? ` ${reponse.text}` : ""}` };
      }
      refus.push(outil);
      return { behavior: "deny" as const, message: MESSAGE_PERMISSION_REFUSEE };
    };
    const query = creerQueryFnDistant(cible, deps)({ prompt: prompt.iterable, options: { canUseTool } });
    const iterateur = (query as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    const debut = Date.now();
    let minuteur: ReturnType<typeof setTimeout> | null = null;
    const delai = new Promise<"delai">((resolve) => {
      minuteur = setTimeout(() => resolve("delai"), delaiMs);
    });
    const outils: string[] = [];
    let dernierTexte = "";
    let resultat: Record<string, unknown> | null = null;
    try {
      while (true) {
        const attente = iterateur.next();
        attente.catch(() => undefined);
        const suite = await Promise.race([attente, delai]);
        if (suite === "delai") {
          query.interrupt().catch(() => undefined);
          throw new ErreurSessionDistante(
            `Délai dépassé (${Math.round(delaiMs / 60_000)} min) : la session distante n'a pas fini son tour ; elle peut encore répondre, la réponse restera dans son historique.`,
          );
        }
        if (suite.done) break;
        const m = suite.value as Record<string, unknown>;
        if (m.type === "assistant") {
          const { texte, outils: utilises } = textesAssistant(m);
          if (texte) dernierTexte = texte;
          outils.push(...utilises);
        }
        if (m.type === "result") {
          resultat = m;
          break;
        }
      }
    } finally {
      if (minuteur) clearTimeout(minuteur);
      prompt.close();
      iterateur.return?.(undefined)?.catch?.(() => undefined);
    }
    if (!resultat) throw new ErreurSessionDistante("La session distante a fermé le flux sans rendre de réponse.");

    const lignes: string[] = [];
    const texteFinal = typeof resultat.result === "string" && resultat.result !== "" ? resultat.result : dernierTexte;
    lignes.push(texteFinal || "(réponse vide)");
    if (outils.length > 0) {
      lignes.push("", `Outils utilisés là-bas (${outils.length}) :`);
      lignes.push(...outils.slice(0, MAX_OUTILS_RESUMES).map((o) => `- ${o}`));
      if (outils.length > MAX_OUTILS_RESUMES) lignes.push(`- … et ${outils.length - MAX_OUTILS_RESUMES} autres`);
    }
    if (autorisees.length > 0) {
      lignes.push("", `Permission(s) distante(s) accordée(s) par l'utilisateur : ${[...new Set(autorisees)].join(", ")}`);
    }
    if (refus.length > 0) {
      const raison = deps.demanderUtilisateur ? "refusée(s) par l'utilisateur" : MESSAGE_PERMISSION_REFUSEE;
      lignes.push("", `Permission(s) distante(s) REFUSÉE(S) (${[...new Set(refus)].join(", ")}) : ${raison}`);
    }
    const duree = typeof resultat.duration_ms === "number" ? resultat.duration_ms : Date.now() - debut;
    const cout = typeof resultat.total_cost_usd === "number" ? ` — coût : ${resultat.total_cost_usd.toFixed(4)} USD` : "";
    lignes.push("", `Durée : ${(duree / 1000).toFixed(1)} s${cout}`);
    const enEchec = resultat.is_error === true || (typeof resultat.subtype === "string" && resultat.subtype !== "success");
    if (enEchec) journal.warn("claude", "outil session_distante_demander : le tour distant a échoué", { fields: { sessionId: cible, sousType: String(resultat.subtype ?? "") } });
    return { texte: (note ? `${note}\n\n` : "") + lignes.join("\n"), erreur: enEchec };
  } catch (err) {
    const message = messageErreur(err);
    journal.error("claude", "outil session_distante_demander en échec", { fields: { session: cible, cause: message, refus: refus.length } });
    const suffixe = refus.length > 0 ? `\nPermission(s) distante(s) refusée(s) avant l'échec (${[...new Set(refus)].join(", ")}) : ${MESSAGE_PERMISSION_REFUSEE}` : "";
    return { texte: `${note ? `${note}\n\n` : ""}${message}${suffixe}`, erreur: true };
  } finally {
    libererVerrou?.();
  }
}

/** Les deux outils MCP, construits avec le `sdk` et le `z` fournis par knowledge.ts (import dynamique). */
export function creerOutilsSessionsDistantes(
  sdk: { tool: (nom: string, description: string, schema: never, gestionnaire: never) => unknown },
  z: { string: () => { describe: (d: string) => unknown; optional: () => { describe: (d: string) => unknown } }; number: () => { optional: () => { describe: (d: string) => unknown } } },
  deps: DepsOutilsSessionsDistantes = {},
): unknown[] {
  const enMcp = (r: ResultatOutil) => ({ content: [{ type: "text" as const, text: r.texte }], ...(r.erreur ? { isError: true } : {}) });
  return [
    sdk.tool(
      "sessions_distantes_lister",
      "Liste les sessions Claude Remote Control des autres machines (titre, id, connexion, activité, dépôt, dernière activité) — sans args",
      {} as never,
      (async () => enMcp(await listerPourAgent(deps))) as never,
    ),
    sdk.tool(
      "session_distante_demander",
      "Envoie un message à une session Claude d'une autre machine et attend sa réponse finale — args: session (titre ou id cse_…), message, delai_minutes? (défaut 15, max 30), fil? (relais : un fil = une session distante de cette conversation)",
      {
        session: z.string().describe("Titre de la session (la connectée la plus récente de ce titre) ou son identifiant cse_…"),
        message: z.string().describe("Message à transmettre"),
        delai_minutes: z.number().optional().describe(`Attente maximale de la réponse (défaut ${DELAI_DEFAUT_MINUTES}, max ${DELAI_MAX_MINUTES})`),
        fil: z.string().optional().describe("Relais seulement : nom du fil (une session distante distincte par fil dans cette conversation ; défaut : un seul fil)"),
      } as never,
      (async (args: { session: string; message: string; delai_minutes?: number; fil?: string }) => enMcp(await demanderASession(args, deps))) as never,
    ),
  ];
}
