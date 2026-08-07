/*
 * Modèle des TOURS d'agent : formes de données et transformations pures.
 *
 * Extrait d'AgentPage.tsx, qui dépassait 5 700 lignes — un fichier où un
 * `setState` mal placé casse une fonctionnalité voisine sans que rien ne le
 * voie. Ce bloc-ci était déjà autonome : que des types et des fonctions sans
 * état, sans React, sans accès au sidecar. Le sortir ne change aucun
 * comportement ; il le rend TESTABLE, ce qu'il n'était pas.
 *
 * Règle de ce module : aucune importation de React, aucun effet de bord. Tout
 * ce qui construit du JSX ou touche au réseau reste dans la page.
 *
 * Les transformations `withX(turns, …)` rendent toujours un NOUVEAU tableau :
 * ce sont des mises à jour d'état React, jamais des mutations en place.
 */

import { asRecord } from "./base";
import type { SentAttachment } from "./Attachments";
import type { ClaudeUsage, RouteTier } from "./sidecar";

export type AgentBlock =
  | { type: "text"; id: string; content: string }
  | { type: "thinking"; id: string; content: string }
  | {
      type: "tool";
      id: string;
      toolUseId: string;
      toolName: string;
      toolInput: unknown;
      result?: { isError: boolean; summary: string };
    };

export type TurnStatus = "streaming" | "done" | "error";

export interface AgentTurn {
  id: string;
  role: "user" | "assistant";
  /**
   * Tour utilisateur : texte réellement ENVOYÉ au moteur (peut être préfixé
   * du bloc « connaissances » au premier tour d'une session, voir
   * `buildKnowledgeBlock`) — c'est cette valeur qui alimente l'historique
   * renvoyé au moteur neutre (`buildNeutralMessages`) et qui reste donc du
   * contexte pour les tours suivants. `displayContent`, s'il diffère, est le
   * texte à AFFICHER (texte original tapé par l'utilisateur).
   */
  content?: string;
  displayContent?: string;
  /**
   * S3 — demande glissée dans un tour DÉJÀ en cours (claude.push) : sert au
   * rendu (liseré « en cours de tour »). Absent = tour utilisateur ordinaire.
   */
  injected?: boolean;
  /** Nombre de documents de connaissances injectés dans ce tour (0/absent = aucun). */
  injectedKnowledgeCount?: number;
  blocks?: AgentBlock[];
  status: TurnStatus;
  errorMessage?: string;
  doneInfo?: { subtype: string; usage: ClaudeUsage | null; contextTokens?: number | null; totalCostUsd: number | null };
  /**
   * Tâches de fond lancées par le modèle pendant ce tour (sous-agents en
   * arrière-plan…). `waiting` passe à true quand le tour du modèle est fini
   * mais que le sidecar garde le process ouvert en attendant leurs rapports
   * (chunk `background_wait`) ; la liste vide efface l'encart (tout est fini).
   */
  backgroundTasks?: { count: number; descriptions: string[]; waiting: boolean };
  /**
   * Compaction de contexte survenue pendant ce tour (« /compact » manuel ou
   * compaction auto du CLI) : affichée comme confirmation de fin de travail —
   * sans elle, un « /compact » se clôturait en « résultat vide du moteur ».
   * `preTokens` = taille du contexte avant compaction, si connue.
   */
  compacted?: { trigger: string; preTokens: number | null };
  /**
   * S3 — bulle assistant close parce que le flux a été redirigé vers une bulle
   * plus récente (message glissé dans le tour en cours) : la réponse CONTINUE
   * plus bas. Sans cette clôture, la bulle restait « streaming » à vie
   * (curseur clignotant permanent, et contenu perdu à la persistance qui
   * filtre les tours en streaming). Le drapeau supprime l'avertissement
   * « résultat vide » si la bulle a été scindée avant tout contenu.
   */
  continued?: boolean;
  /**
   * Pièces jointes du tour utilisateur (voir Attachments.tsx). Uniquement
   * porté par le moteur Claude (voir le contrat, docs/protocol.md — ni
   * `neutral.start`) : le composeur désactive l'ajout de pièces tant que le
   * moteur neutre est actif pour la session. `previewUrl` absent après un
   * rechargement (octets jamais persistés, voir `toAttachmentRefs`).
   */
  attachments?: SentAttachment[];
  /** R2 — tier du routeur quand ce tour a été envoyé en « Auto » (badge ⚡, patron ChatPage). */
  routeTier?: RouteTier;
  /** R2 — modèle cible du routage (badge) et raisons du classement (infobulle). */
  routeModel?: string;
  routeReasons?: string[];
}

/**
 * Ids de tours/blocs : PERSISTÉS avec la session, ils doivent rester uniques
 * à vie — clés React du fil (`turns.map`) et cibles des patchs de streaming
 * (`withTurnDone`, `withBlocks`) supposent l'unicité. Un compteur de module
 * repartirait de zéro à chaque lancement/HMR et un tour neuf reprendrait
 * l'id d'un tour déjà persisté (constaté le 2026-08-04 : DOM fantôme d'une
 * ancienne conversation, `doneInfo` recopié dans un vieux tour) — d'où
 * l'UUID, comme pour les ids de session (sessionStore.ts).
 */
export function nextId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// Helpers purs (hors composant), même esprit que withAppendedDelta dans ChatPage.tsx.
export function appendToLastBlock(blocks: AgentBlock[], type: "text" | "thinking", delta: string): AgentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) {
    const updated = { ...last, content: last.content + delta };
    return [...blocks.slice(0, -1), updated];
  }
  return [...blocks, { type, id: nextId("blk"), content: delta } as AgentBlock];
}

export function addToolBlock(blocks: AgentBlock[], toolUseId: string, toolName: string, toolInput: unknown): AgentBlock[] {
  return [...blocks, { type: "tool", id: nextId("blk"), toolUseId, toolName, toolInput }];
}

export function setToolResult(blocks: AgentBlock[], toolUseId: string, isError: boolean, summary: string): AgentBlock[] {
  return blocks.map((b) => (b.type === "tool" && b.toolUseId === toolUseId ? { ...b, result: { isError, summary } } : b));
}

/**
 * Taille du contexte de la conversation, en tokens, d'après le DERNIER tour
 * ayant remonté l'info.
 *
 * On privilégie `doneInfo.contextTokens` : l'occupation de la fenêtre au dernier
 * appel API, mesurée côté sidecar (voir `extractContextTokens`). C'est la SEULE
 * valeur fiable — l'`usage` du `result` CUMULE tous les appels d'un tour
 * agentique (son cache_read additionne N fois le préfixe) et peut dépasser
 * plusieurs fois la fenêtre du modèle (« contexte » à 400 %+).
 *
 * Repli sur l'ancien calcul (cacheRead + in + out de l'usage) seulement pour les
 * tours d'AVANT ce champ (persistés) ou le moteur neutre — imparfait, mais mieux
 * que rien tant qu'un nouveau tour n'a pas rafraîchi la valeur.
 *
 * Un total NUL n'est jamais une mesure : c'est le cas d'un tour « /compact »,
 * qui ne fait aucun appel modèle visible (pas de message `assistant`, donc
 * `contextTokens` absent) et clôt sur un usage à 0/0. Le prendre pour argent
 * comptant affichait « Contexte 0 % · 0/200 k » juste après une compaction
 * (cas réel du 2026-08-07) — un fil vide, alors qu'il porte le résumé.
 *
 * Et après une compaction SANS mesure, les tours antérieurs sont périmés (ils
 * décrivent la fenêtre d'AVANT le résumé) : la taille est alors INCONNUE, on
 * rend `null` (l'encart disparaît) jusqu'au prochain appel modèle, qui la
 * remontera. Une compaction automatique en cours de tour, elle, garde sa mesure
 * post-compaction et sort par la branche du dessus.
 */
export function contextTokens(turns: AgentTurn[]): number | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const done = turn.doneInfo;
    if (done) {
      if (typeof done.contextTokens === "number" && done.contextTokens > 0) return done.contextTokens;
      if (done.usage) {
        const total =
          (done.usage.cacheReadInputTokens ?? 0) + done.usage.inputTokens + done.usage.outputTokens;
        if (total > 0) return total;
      }
    }
    if (turn.compacted) return null;
  }
  return null;
}

export function withBlocks(turns: AgentTurn[], id: string, updater: (blocks: AgentBlock[]) => AgentBlock[]): AgentTurn[] {
  return turns.map((t) => (t.id === id ? { ...t, blocks: updater(t.blocks ?? []) } : t));
}

/** Forme commune aux `done` de `claude.start`/`neutral.start` (voir `parseClaudeDone`/`parseNeutralDone`). */
export interface TurnDoneInfo {
  subtype: string;
  usage: ClaudeUsage | null;
  /** Occupation de la fenêtre de contexte (dernier appel) — voir `contextTokens`. Absent côté neutre. */
  contextTokens?: number | null;
  totalCostUsd: number | null;
  /** Texte final du SDK (`result`). Parfois seul porteur de la réponse : voir `withTurnDone`. */
  result?: string;
}

/** Vrai si le tour a produit du contenu visible (texte ou outil). */
export function hasVisibleContent(blocks: AgentBlock[]): boolean {
  return blocks.some((b) => (b.type === "text" ? b.content.trim().length > 0 : true));
}

/**
 * Texte d'un tour assistant destiné à être LU à voix haute : uniquement les
 * blocs `text`, jamais le raisonnement ni les appels d'outils (lire « Bash :
 * npm run build » n'a aucun intérêt et noierait la réponse). Chaîne vide s'il
 * n'y a rien à lire.
 */
export function spokenTextOfTurn(turn: AgentTurn): string {
  return (turn.blocks ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.content)
    .join("\n\n")
    .trim();
}

/**
 * Message clair pour un tour qui ne s'est pas terminé normalement. Le SDK
 * renvoie un `subtype` technique en anglais, jusqu'ici affiché en tout petit
 * dans la ligne de tokens — invisible en pratique (cas typique : limite
 * d'abonnement atteinte).
 */
export function turnSubtypeNotice(subtype: string): string | null {
  if (subtype === "success") return null;
  const s = subtype.toLowerCase();
  if (s.includes("max_turns")) {
    return "Tour interrompu : l'agent a atteint son nombre maximum d'étapes. Relancez en précisant la suite à faire.";
  }
  if (s.includes("limit") || s.includes("quota") || s.includes("rate")) {
    return "Limite d'abonnement atteinte : le tour n'a pas pu aboutir. Consultez la jauge de session en en-tête pour le temps restant avant réinitialisation.";
  }
  if (s.includes("abort") || s.includes("interrupt")) {
    return "Tour interrompu avant la fin.";
  }
  if (s.includes("error")) {
    return `Le tour s'est terminé anormalement (${subtype}).`;
  }
  return null;
}

export function withTurnDone(turns: AgentTurn[], id: string, info: TurnDoneInfo): AgentTurn[] {
  return turns.map((t) => {
    if (t.id !== id) return t;
    // Le SDK peut clore un tour en ne renvoyant la réponse que dans `result`,
    // sans jamais streamer de bloc `text` : sans ce repli, la bulle restait
    // vide (ou s'arrêtait sur un appel d'outil) alors que la réponse existait.
    // Critère : aucun bloc TEXTE — des tool_use seuls ne comptent pas, un tour
    // « outils puis résultat non streamé » doit aussi récupérer son texte. Pas
    // de risque de doublon : dès qu'un texte a été streamé, un bloc text existe.
    const current = t.blocks ?? [];
    const hasTextBlock = current.some((b) => b.type === "text" && b.content.trim().length > 0);
    const blocks =
      !hasTextBlock && info.result && info.result.trim()
        ? [...current, { type: "text" as const, id: nextId("blk"), content: info.result }]
        : current;
    return {
      ...t,
      blocks,
      status: "done",
      doneInfo: { subtype: info.subtype, usage: info.usage, contextTokens: info.contextTokens, totalCostUsd: info.totalCostUsd },
    };
  });
}

export function withTurnError(turns: AgentTurn[], id: string, errorMessage: string): AgentTurn[] {
  return turns.map((t) => (t.id === id ? { ...t, status: "error", errorMessage } : t));
}

/* ---------- Aperçus / rendu JSON ---------- */

export function prettyJson(value: unknown, maxLen = 800): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n…` : text;
}


// Noms d'outils Claude (Agent SDK) et neutre (palette maison, voir
// docs/protocol.md Lot 6) désignent la même action avec des champs
// identiques (`file_path`/`old_string`/`new_string`/`content`/`command`) —
// on reconnaît les deux conventions partout où un aperçu/titre est dérivé.
export function toolPreview(toolName: string, toolInput: unknown): string {
  const input = asRecord(toolInput);
  if ((toolName === "Edit" || toolName === "Write" || toolName === "edit_file" || toolName === "write_file") && typeof input.file_path === "string") {
    return input.file_path;
  }
  if ((toolName === "Bash" || toolName === "bash") && typeof input.command === "string") {
    return input.command;
  }
  return prettyJson(toolInput, 160);
}

export function mcpServerFromToolName(toolName: string): string | null {
  if (!toolName.startsWith("mcp__")) return null;
  const server = toolName.split("__")[1];
  return server || null;
}
