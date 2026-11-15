/*
 * Outil MCP `lire_usage` (T-202) : l'agent lit la consommation de l'abonnement
 * Claude quand il en a besoin — avant une tâche longue, ou pour respecter un
 * seuil donné par l'utilisateur. Ajouté au serveur `iaction` par knowledge.ts.
 *
 * À la demande SEULEMENT : rien n'est injecté dans le prompt système ni dans
 * les messages (décision de l'utilisateur : pas de mention de la conso quand
 * elle ne sert à rien).
 *
 * Source : le dernier relevé de claude-windows.jsonl DU COMPTE DU TOUR. Il est
 * écrit par battement (INSTANTANE_BATTEMENT_MS) : il peut être vieux, d'où
 * l'âge rendu avec les chiffres. Le formatage est pur, pour être testé sans SDK.
 */

import { errMessage } from "./base.js";
import { COMPTE_PAR_DEFAUT, libelleCompte, type CompteId } from "./compteClaude.js";
import { readLatestClaudeReleve, type FenetreReleve } from "./fenetresAbonnement.js";
import * as journal from "./journal.js";

export interface ReleveUsage {
  ts: string | null;
  windows: Record<string, FenetreReleve>;
}

export interface ResultatUsage {
  texte: string;
  erreur: boolean;
}

/** « 12 min », « 1 h 05 », « 2 j 3 h » — durée courte, jamais négative. */
export function formaterDuree(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "moins d'une minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

function pourcent(valeur: number): string {
  return `${Math.round(valeur)} %`;
}

/** « reprise dans 1 h 23 » ; vide si l'heure manque ou est illisible. */
function repriseDe(fenetre: FenetreReleve, maintenant: number): string {
  if (!fenetre.resetsAt) return "";
  const t = Date.parse(fenetre.resetsAt);
  if (Number.isNaN(t)) return "";
  return t <= maintenant ? ", reprise déjà passée" : `, reprise dans ${formaterDuree(t - maintenant)}`;
}

/** « seven_day_opus » → « Opus », « Fable » → « Fable » (même règle que l'étiquette de l'interface). */
function etiquetteModele(cle: string): string {
  const nu = cle.replace(/^seven_day_/, "").replace(/_/g, " ").trim();
  return nu.length === 0 ? cle : nu.charAt(0).toUpperCase() + nu.slice(1);
}

/**
 * Texte rendu à l'agent. `releve` null ou sans fenêtre = aucun relevé (ce n'est
 * pas une erreur). Les fenêtres autres que 5 h et 7 j sont les fenêtres hebdo
 * d'un modèle (Fable…) : toutes sont rendues, dans l'ordre alphabétique.
 */
export function formaterUsage(releve: ReleveUsage | null, compte: CompteId, maintenant: number = Date.now()): string {
  const nomCompte = libelleCompte(compte);
  if (!releve || Object.keys(releve.windows).length === 0) {
    return `Aucun relevé d'usage disponible pour ce compte (${nomCompte}).`;
  }
  const lignes: string[] = [];
  const { five_hour: cinqHeures, seven_day: septJours, ...modeles } = releve.windows;
  if (cinqHeures) lignes.push(`Fenêtre 5 h : ${pourcent(cinqHeures.utilization)}${repriseDe(cinqHeures, maintenant)}`);
  if (septJours) lignes.push(`Fenêtre 7 jours : ${pourcent(septJours.utilization)}${repriseDe(septJours, maintenant)}`);
  for (const cle of Object.keys(modeles).sort()) {
    lignes.push(`${etiquetteModele(cle)} (hebdo du modèle) : ${pourcent(modeles[cle].utilization)}${repriseDe(modeles[cle], maintenant)}`);
  }
  const t = releve.ts ? Date.parse(releve.ts) : Number.NaN;
  const age = Number.isNaN(t) ? "date du relevé inconnue" : `relevé il y a ${formaterDuree(maintenant - t)}`;
  return [`Consommation de l'abonnement Claude — ${nomCompte} (${age}) :`, ...lignes.map((l) => `- ${l}`)].join("\n");
}

/** Lecture + formatage ; une erreur de lecture est journalisée et rendue en `erreur`. */
export async function lireUsagePourAgent(
  compte: CompteId = COMPTE_PAR_DEFAUT,
  lire: (c: CompteId) => Promise<ReleveUsage | null> = readLatestClaudeReleve,
  maintenant: number = Date.now(),
): Promise<ResultatUsage> {
  try {
    return { texte: formaterUsage(await lire(compte), compte, maintenant), erreur: false };
  } catch (err) {
    const message = errMessage(err);
    journal.error("usage", "lire_usage : lecture du relevé impossible", { fields: { erreur: message, compte } });
    return { texte: `Lecture du relevé d'usage impossible : ${message}`, erreur: true };
  }
}

/** Dépendances de test (relevé injecté, horloge). */
export interface DepsOutilUsage {
  /** Compte du tour (défaut : `perso`). */
  compte?: CompteId;
  lire?: (c: CompteId) => Promise<ReleveUsage | null>;
}

export function creerOutilUsage(
  sdk: { tool: (nom: string, description: string, schema: never, gestionnaire: never) => unknown },
  _z: unknown,
  deps: DepsOutilUsage = {},
): unknown {
  return sdk.tool(
    "lire_usage",
    "Lire la consommation de l'abonnement Claude (fenêtres 5 h / 7 j) — à appeler avant une tâche longue ou pour respecter un seuil donné par l'utilisateur. Sans args ; rend les pourcentages, l'heure de reprise et l'âge du relevé",
    {} as never,
    (async () => {
      const r = await lireUsagePourAgent(deps.compte ?? COMPTE_PAR_DEFAUT, deps.lire);
      return { content: [{ type: "text" as const, text: r.texte }], ...(r.erreur ? { isError: true } : {}) };
    }) as never,
  );
}
