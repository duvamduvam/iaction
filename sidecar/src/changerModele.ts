/**
 * L'agent ajuste lui-même son modèle et son effort (T-207) — outil MCP
 * `mcp__studio__changer_modele`, servi par le serveur in-process `studio`
 * (voir askUser.ts, `buildStudioMcpServer`), consommé par claude.ts.
 *
 * Décisions de David (2026-11-08, docs/spec-changement-modele-auto.md) :
 * dans les deux sens (Fable comme Haiku), SANS validation, effet immédiat —
 * le SDK `setModel` / `applyFlagSettings` agit dans le tour en cours. L'humain
 * est informé a posteriori par le chunk `model_change` (bandeau « Annuler »
 * côté UI), jamais consulté avant.
 *
 * Le pont (`PontChangerModele`) est fourni par claude.ts : le serveur MCP est
 * construit AVANT la `query` du SDK, dont `setModel` a besoin. claude.ts pose
 * donc la cible du pont juste après `queryFn` — d'ici là, l'outil répond en
 * erreur franche plutôt que d'échouer en silence.
 *
 * Périmètre : moteur Claude de la page Projets (tour `interactive`). Jamais en
 * chat pur, jamais pour un agent à modèle fixe (`modeleVerrouille`) : lui
 * promettre un pouvoir qu'on lui retire aussitôt serait un faux espoir.
 */

import { errMessage, isNonEmptyString } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import { effortValide, NIVEAUX_EFFORT, type NiveauEffort } from "./claudeEffort.js";
import * as journal from "./journal.js";

/** Nom complet côté SDK : `mcp__<serveur>__<outil>`. */
export const CHANGER_MODELE_TOOL_NAME = "mcp__studio__changer_modele";

/**
 * Les modèles que l'agent peut choisir — COPIE de `MODELES_ABONNEMENT_CLAUDE`
 * (ui/src/modelesAbonnementClaude.ts) : sidecar et UI ne partagent aucun code.
 * Un test de l'UI (changementModele.test.ts) compare les deux listes et casse
 * si on n'en met qu'une à jour (c'est le défaut T-046, une liste recopiée).
 */
export const MODELES_CHANGEABLES = [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
] as const;

/** Charge utile du chunk `model_change` (voir docs/protocol.md). */
export interface ChangementModele {
  /** Modèle d'avant (null = inconnu : le tour n'avait pas encore parlé). */
  from: string | null;
  to: string;
  /** Effort d'avant / d'après (null = défaut, non posé). */
  effortFrom: string | null;
  effortTo: string | null;
  raison: string;
}

/** État que le moteur connaît du tour en cours. */
export interface EtatModele {
  model: string | null;
  effort: string | null;
}

/** Ce que l'outil fait de l'extérieur — fourni par claude.ts. */
export interface PontChangerModele {
  /** Modèle et effort courants du tour. */
  etat: () => EtatModele;
  /** Applique sur la query vivante et retient le nouvel état ; rejette si le SDK refuse. */
  appliquer: (modele: string, effort: NiveauEffort | null | undefined) => Promise<void>;
  /** Émet le chunk `model_change` vers l'UI. */
  emettre: (changement: ChangementModele) => void;
  /** Pour le journal. */
  sessionId: () => string | null;
}

/** Résultat rendu au modèle. */
export interface ResultatChangerModele {
  texte: string;
  erreur: boolean;
}

/** Le sous-ensemble de `Query` (SDK) que l'application d'un changement utilise. */
export interface QueryModifiable {
  setModel?: (model?: string) => Promise<void>;
  applyFlagSettings?: (settings: { effortLevel: NiveauEffort | null }) => Promise<void>;
}

/** Retire un éventuel suffixe de fenêtre (`claude-opus-5-5[1m]`) avant comparaison. */
function idCanonique(model: string | null): string | null {
  return model === null ? null : model.replace(/\[.*\]$/, "");
}

/**
 * Applique modèle (+ effort) sur la query. Séquence : `setModel`, puis
 * `applyFlagSettings` si l'effort est donné. Si le second échoue après que le
 * premier a réussi, le modèle d'avant est remis (best effort) : ni moitié de
 * changement, ni écart entre ce que l'UI croit et ce que le moteur fait.
 *
 * `effort` : `undefined` = ne pas toucher, `null` = revenir au défaut du modèle.
 */
export async function appliquerSurQuery(
  query: QueryModifiable,
  avant: EtatModele,
  modele: string,
  effort: NiveauEffort | null | undefined,
): Promise<void> {
  if (typeof query.setModel !== "function") {
    throw new Error("le moteur ne sait pas changer de modèle en cours de tour (setModel absent)");
  }
  if (effort !== undefined && typeof query.applyFlagSettings !== "function") {
    throw new Error("le moteur ne sait pas changer l'effort en cours de tour (applyFlagSettings absent)");
  }
  await query.setModel(modele);
  if (effort === undefined) return;
  try {
    await query.applyFlagSettings!({ effortLevel: effort });
  } catch (err) {
    // Retour arrière du modèle : on ne laisse pas un changement à moitié fait.
    if (avant.model !== null) await query.setModel(avant.model).catch(() => undefined);
    throw err;
  }
}

function nomEffort(effort: string | null): string {
  return effort ?? "défaut";
}

/**
 * Cœur de l'outil, testable sans SDK : décide, applique, émet, journalise.
 * Ne lève jamais — une erreur devient `{ erreur: true }`, rendue au modèle.
 */
export async function executerChangerModele(
  args: { modele: string; effort?: string; raison: string },
  pont: PontChangerModele,
): Promise<ResultatChangerModele> {
  const effortDemande = effortValide(args.effort);
  const avant = pont.etat();
  const effortApres = effortDemande ?? avant.effort;
  const memeModele = idCanonique(avant.model) === args.modele;
  const memeEffort = effortDemande === undefined || effortDemande === avant.effort;
  if (memeModele && memeEffort) {
    return { texte: `Déjà en place : ${args.modele} (effort ${nomEffort(avant.effort)}). Rien n'a été changé. Continue.`, erreur: false };
  }

  const champs = {
    sessionId: pont.sessionId(),
    modeleAvant: avant.model,
    modeleApres: args.modele,
    effortAvant: avant.effort,
    effortApres,
    raison: args.raison,
  };
  try {
    await pont.appliquer(args.modele, effortDemande);
  } catch (err) {
    const message = errMessage(err);
    journal.error("claude", "changer_modele : échec du changement de modèle", { fields: { ...champs, erreur: message } });
    return { texte: `Changement de modèle impossible : ${message}. Le modèle actuel reste en place ; continue avec lui.`, erreur: true };
  }

  pont.emettre({ from: avant.model, to: args.modele, effortFrom: avant.effort, effortTo: effortApres, raison: args.raison });
  journal.info("claude", "modèle changé par l'agent", { fields: champs });
  return {
    texte: `Modèle passé de ${avant.model ?? "(modèle initial)"} à ${args.modele} (effort ${nomEffort(effortApres)}). Continue.`,
    erreur: false,
  };
}

const DESCRIPTION = [
  "Change le modèle Claude (et éventuellement l'effort) de cette conversation,",
  "immédiatement et pour les tours suivants.",
  "Appelle-le en début de demande, ou dès que la nature du travail change, quand",
  "le modèle actuel n'est pas le bon selon les consignes de l'utilisateur (Fable",
  "pour trancher, concevoir, spécifier, sécurité, diagnostic qui résiste ; Opus",
  "pour le travail courant ; Sonnet/Haiku pour l'exécution d'une spec fermée).",
  "Ne l'appelle pas pour un gain marginal, ni plus d'une fois par demande.",
  "Après l'appel, continue le travail normalement.",
].join(" ");

/** Forme minimale de `sdk.tool` — injectable (tests : pas de vrai SDK). */
export interface SdkTool {
  tool: (nom: string, description: string, schema: never, gestionnaire: never) => unknown;
}

/** Sous-ensemble de zod/v4 utilisé pour le schéma d'entrée. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Zod = any;

/** Construit l'outil MCP. Même patron que `creerOutilUsage` (outilUsage.ts). */
export function creerOutilChangerModele(sdk: SdkTool, z: Zod, pont: PontChangerModele): unknown {
  return sdk.tool(
    "changer_modele",
    DESCRIPTION,
    {
      modele: z.enum(MODELES_CHANGEABLES).describe("Identifiant exact du modèle à utiliser"),
      effort: z
        .enum(NIVEAUX_EFFORT)
        .optional()
        .describe("Niveau d'effort de raisonnement ; omis = inchangé"),
      raison: z.string().describe("Une phrase : pourquoi ce modèle convient mieux (affichée à l'utilisateur)"),
    } as never,
    (async (args: { modele: string; effort?: string; raison: string }) => {
      const r = await executerChangerModele(args, pont);
      return { content: [{ type: "text" as const, text: r.texte }], ...(r.erreur ? { isError: true } : {}) };
    }) as never,
  );
}

/** Sous-ensemble de `RunState` (claude.ts) dont `claude.setModel` a besoin. */
export interface RunModifiable {
  appliquerModele: (modele: string, effort: NiveauEffort | null | undefined) => Promise<void>;
}

/**
 * `claude.setModel` : remet modèle (et effort) sur un tour VIVANT, sans passer
 * par l'outil. Sert au bouton « Annuler » du bandeau de changement automatique.
 * `effort` : absent = inchangé, `null` = défaut du modèle. Tour introuvable
 * (déjà fini) : `applied: false`, l'UI se rabat sur le prochain tour. Un refus
 * du moteur est une `error` journalisée, jamais un silence.
 */
export async function executerClaudeSetModel(
  runs: ReadonlyMap<string, RunModifiable>,
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const targetId = params.targetId;
  const modele = params.model;
  if (!isNonEmptyString(targetId) || !isNonEmptyString(modele)) {
    emitter.error(id, "params.targetId et params.model sont requis");
    return;
  }
  let effort: NiveauEffort | null | undefined;
  if (params.effort === undefined) effort = undefined;
  else if (params.effort === null) effort = null;
  else {
    effort = effortValide(params.effort);
    if (effort === undefined) {
      emitter.error(id, "params.effort doit être un niveau d'effort connu, null ou absent");
      return;
    }
  }
  const run = runs.get(targetId);
  if (!run) {
    emitter.done(id, { applied: false });
    return;
  }
  try {
    await run.appliquerModele(modele, effort);
  } catch (err) {
    const message = errMessage(err);
    journal.error("claude", "claude.setModel : échec du rétablissement du modèle", {
      reqId: targetId,
      fields: { modele, effort, erreur: message },
    });
    emitter.error(id, `Changement de modèle impossible : ${message}`);
    return;
  }
  journal.info("claude", "modèle rétabli par l'utilisateur", { reqId: targetId, fields: { modele, effort } });
  emitter.done(id, { applied: true });
}
