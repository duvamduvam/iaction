/*
 * T-102 — suivi des sous-agents EN VOL sur un tour : la Map qui les
 * mémorise (id du `Task` lanceur → type/description/horodatage/nombre
 * d'outils), la détection des outils qui EN lancent un (`Task`/`Agent`), et
 * les deux lignes de journal qui bornent leur vie (lancement, fin) — seule
 * trace laissée dans le journal tant qu'un sous-agent travaille (T-092
 * écarte le détail de ses tool_use/tool_result du fil, voir
 * claudeSousAgents.ts). Sans ça, un sous-agent pouvait tourner 38 min sans
 * UNE ligne de journal.
 *
 * Sorti de claude.ts (cliquet de taille, T-102) : la mécanique — une Map par
 * tour, remplie/vidée au fil des tool_use et tool_result du fil — est un
 * bloc cohérent et à faible couplage avec le reste du moteur, qui ne fait
 * qu'appeler ces trois méthodes aux points où il détecte déjà `deSousAgent`,
 * un `tool_use` ou un `tool_result`.
 */
import { isPlainObject } from "./base.js";
import * as journal from "./journal.js";

/** Outils qui LANCENT un sous-agent (`Task`/`Agent` selon la version du SDK,
 *  voir agentTurns.ts côté UI, `OUTILS_DELEGATION`, T-077). */
const OUTILS_SOUS_AGENT = new Set(["Task", "Agent"]);

/** Un outil de tool_use lance-t-il un sous-agent ? */
export function estLanceurSousAgent(toolName: string): boolean {
  return OUTILS_SOUS_AGENT.has(toolName);
}

interface SousAgentEnVol {
  type: string;
  description: string;
  startedAt: number;
  outils: number;
  /** T-102 — dernier outil vu chez ce sous-agent, pour le battement remonté
   *  au fil (voir `BattementSousAgent`). `null` tant qu'aucun n'a été vu. */
  dernierOutil: string | null;
}

/** T-102 — un sous-agent en vol vient d'utiliser un outil de plus : de quoi
 *  faire battre la ligne discrète sous son appel `Agent` dans le fil (voir
 *  claude.ts, chunk `sous_agent_battement`, et docs/protocol.md). */
export interface BattementSousAgent {
  /** id du `Task`/`Agent` lanceur — le même que son tool_use dans le fil. */
  toolUseId: string;
  outils: number;
  dernierOutil: string | null;
}

/** T-102 — instantané d'un sous-agent encore en vol, pour bâtir le rappel
 *  factuel du tour suivant sur un abandon explicite (voir
 *  rappelInterruption.ts). Ne consomme rien : la Map n'est pas vidée, un
 *  `tool_result` pourrait encore arriver malgré l'abandon. */
export interface SousAgentEnVolInfo {
  type: string;
  description: string;
  startedAt: number;
}

/** Suivi des sous-agents en vol pour UN tour (une instance par tour, voir
 *  `creerSuiviSousAgents` et son usage dans claude.ts). */
export interface SuiviSousAgents {
  /** Lancement d'un sous-agent (bloc tool_use `Task`/`Agent` du fil) : une
   *  ligne au départ, pour qu'un tour qui tourne longtemps sans rien dire du
   *  fil (le travail se fait chez le sous-agent) laisse quand même une
   *  trace. `input` est le `block.input` brut du tool_use. */
  lancer(reqId: string, toolUseId: string, input: unknown): void;
  /** Un outil de plus vu chez le sous-agent parent (message issu d'un
   *  sous-agent, tool_use en son sein) — seul indice de son activité tant
   *  qu'il tourne (T-092 écarte le détail de ses tool_use du fil). Rend le
   *  battement à jour (`toolUseId`, compteur, dernier outil) pour que
   *  claude.ts le reverse au fil sous forme de chunk, ou `null` si
   *  `parentToolUseId` ne désigne aucun sous-agent connu. */
  compterOutil(parentToolUseId: string | null, toolName: string | null): BattementSousAgent | null;
  /** Fin d'un sous-agent (tool_result du fil qui clôt son toolUseId) : une
   *  ligne de journal, et retrait de la Map. Sans effet si `toolUseId` ne
   *  désigne aucun sous-agent connu (tool_result ordinaire). */
  terminer(reqId: string, toolUseId: string | null, issue: "ok" | "annulé" | "erreur"): void;
  /** T-102 — sous-agents encore en vol à cet instant (voir `SousAgentEnVolInfo`). */
  instantane(): SousAgentEnVolInfo[];
}

export function creerSuiviSousAgents(): SuiviSousAgents {
  const enVol = new Map<string, SousAgentEnVol>();

  return {
    lancer(reqId, toolUseId, input) {
      const champs = isPlainObject(input) ? input : {};
      const type =
        typeof champs.subagent_type === "string" && champs.subagent_type.trim()
          ? champs.subagent_type.trim()
          : "sous-agent";
      const description = typeof champs.description === "string" ? champs.description.trim() : "";
      enVol.set(toolUseId, { type, description, startedAt: Date.now(), outils: 0, dernierOutil: null });
      journal.info("claude", "sous-agent lancé", {
        reqId,
        fields: { toolUseId, type, description },
      });
    },
    compterOutil(parentToolUseId, toolName) {
      if (!parentToolUseId) return null;
      const sousAgent = enVol.get(parentToolUseId);
      if (!sousAgent) return null;
      sousAgent.outils += 1;
      if (toolName) sousAgent.dernierOutil = toolName;
      return { toolUseId: parentToolUseId, outils: sousAgent.outils, dernierOutil: sousAgent.dernierOutil };
    },
    instantane() {
      return [...enVol.values()].map(({ type, description, startedAt }) => ({ type, description, startedAt }));
    },
    terminer(reqId, toolUseId, issue) {
      if (!toolUseId) return;
      const sousAgent = enVol.get(toolUseId);
      if (!sousAgent) return;
      enVol.delete(toolUseId);
      journal.info("claude", "sous-agent terminé", {
        reqId,
        fields: {
          toolUseId,
          type: sousAgent.type,
          ms: Date.now() - sousAgent.startedAt,
          outils: sousAgent.outils,
          issue,
        },
      });
    },
  };
}
