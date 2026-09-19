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
import type { ChatMessage, ClaudeUsage, RouteTier } from "./sidecar";

/**
 * T-102 — battement d'un sous-agent en vol (chunk `sous_agent_battement`,
 * voir docs/protocol.md) : un COMPTEUR d'outils vus et le dernier, jamais la
 * liste — T-092 a retiré le détail des outils d'un sous-agent du fil, cette
 * ligne discrète ne doit pas le rouvrir. Porté par le bloc `tool` Task/Agent
 * qui a lancé ce sous-agent (même `toolUseId`).
 */
export interface BattementSousAgent {
  outils: number;
  dernierOutil: string | null;
  /** Epoch ms de cette observation — voir `formaterHeureDiscrete` (T-101). */
  instant: number;
}

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
      sousAgent?: BattementSousAgent;
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
   * T-027 — bulle assistant ouverte au MILIEU d'un tour déjà vivant (revers de
   * `continued` : elle est la cible vers laquelle le flux a été redirigé).
   *
   * Elle reste vide tant que le modèle n'a pas atteint son prochain outil, ce
   * qui peut prendre plusieurs minutes — sans que rien n'aille mal, puisque le
   * fournisseur a déjà répondu plus haut dans le même tour. L'avis « aucune
   * donnée reçue » ne concerne donc QUE le démarrage d'un tour, jamais ces
   * bulles-là (voir useAttenteFournisseur.ts).
   */
  suiteDeTour?: boolean;
  /**
   * T-087 — ce tour affirmait « message parti » (`injected`) ou « réponse à
   * venir » (`suiteDeTour`), mais le push correspondant n'a jamais été vu par
   * le modèle (chunk `push_perdu`, aucun retour d'outil depuis). Le message
   * est reposé en file (voir `withPushPerdu`) : la bulle ne doit plus mentir.
   */
  reporte?: boolean;
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
 * T-102 — met à jour le battement d'un sous-agent en vol : le bloc `tool`
 * Task/Agent identifié par `toolUseId` reçoit son compte d'outils observés et
 * le dernier vu (chunk `sous_agent_battement`, voir docs/protocol.md).
 * Cherche dans TOUS les tours (comme `withPushPerdu`) : le tour qui porte le
 * bloc peut ne plus être le tour COURANT si une demande a été glissée entre
 * temps (S3, `continued`/`suiteDeTour`) et redirigé le flux vers une bulle
 * plus récente — le battement doit quand même atteindre le bon bloc, pas la
 * bulle qui reçoit le flux à cet instant. Sans effet si aucun bloc ne porte ce
 * `toolUseId` (bloc déjà clos/retiré, chunk hors ordre) : tolérant par
 * construction, même politique que le reste de ce module.
 */
export function withSousAgentBattement(
  turns: AgentTurn[],
  toolUseId: string,
  outils: number,
  dernierOutil: string | null,
  instant: number,
): AgentTurn[] {
  return turns.map((t) => {
    const blocks = t.blocks;
    if (!blocks || !blocks.some((b) => b.type === "tool" && b.toolUseId === toolUseId)) return t;
    return {
      ...t,
      blocks: blocks.map((b) =>
        b.type === "tool" && b.toolUseId === toolUseId ? { ...b, sousAgent: { outils, dernierOutil, instant } } : b,
      ),
    };
  });
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

/**
 * T-087 — un push glissé en cours de tour (`injected: true`) jamais vu par le
 * modèle (chunk `push_perdu`) : la bulle qui affirmait « message parti »
 * cesse de mentir. Marque le tour injecté ET la bulle assistant qu'il avait
 * ouverte (`suiteDeTour`, qui ne recevra donc jamais de réponse). FIFO : le
 * PREMIER tour injecté non encore marqué portant ce contenu — même ordre que
 * les `push_perdu` émis par le registre du sidecar (poussesEnAttente.ts).
 * Contenu introuvable (état déjà purgé, HMR…) ⇒ tableau inchangé, jamais
 * d'exception : un affichage qui ne se corrige pas reste moins grave qu'un
 * fil qui casse.
 */
export function withPushPerdu(turns: AgentTurn[], contenu: string): AgentTurn[] {
  const index = turns.findIndex((t) => t.role === "user" && t.injected === true && t.content === contenu && !t.reporte);
  if (index === -1) return turns;
  const suivant = turns[index + 1];
  const marqueSuivant = suivant?.role === "assistant" && suivant.suiteDeTour === true;
  return turns.map((t, i) => {
    if (i === index) return { ...t, reporte: true };
    if (marqueSuivant && i === index + 1) return { ...t, reporte: true, status: "done" as const };
    return t;
  });
}

/** Une pièce poussée (T-064) gardée en mémoire le temps du tour, pour pouvoir
 *  la restaurer dans le composeur si son push est signalé perdu (T-087). */
export interface PushEnCoursDeTour<A> {
  contenu: string;
  attachments: A[];
}

/**
 * FIFO — retire et rend la PREMIÈRE entrée dont le contenu correspond (même
 * ordre que `withPushPerdu`) ; `trouve: undefined` si aucune pièce
 * n'accompagnait ce push (rien à restaurer, seul le texte est reposé).
 */
export function retirerPushCorrespondant<A>(
  enCours: PushEnCoursDeTour<A>[],
  contenu: string,
): { trouve: PushEnCoursDeTour<A> | undefined; reste: PushEnCoursDeTour<A>[] } {
  const index = enCours.findIndex((p) => p.contenu === contenu);
  if (index === -1) return { trouve: undefined, reste: enCours };
  return { trouve: enCours[index], reste: [...enCours.slice(0, index), ...enCours.slice(index + 1)] };
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

/*
 * T-077 — sous-agents lancés par un tour.
 *
 * ── Pourquoi lire les blocs plutôt qu'ouvrir un canal ───────────────────
 * Déléguer, côté SDK, c'est appeler un outil dont l'entrée porte
 * `subagent_type` : la trace existe DÉJÀ dans les blocs du tour, reçue et
 * stockée depuis toujours. Elle passait dans le transcript sans jamais être
 * totalisée — donc « qui travaille pour ce tour » n'était visible nulle part.
 * Rien à ajouter au sidecar : une lecture pure suffit.
 *
 * ⚠ Ce que ça dit, et rien de plus : le LANCEMENT d'un sous-agent, pas le
 * modèle sur lequel il tourne (le SDK ne l'annonce pas ici). Le modèle réel
 * par délégation reste l'affaire de la ventilation T-066, et son minorant
 * assumé. Deux mesures distinctes, jamais confondues.
 */
const OUTILS_DELEGATION = new Set(["Task", "Agent"]);

export interface SousAgentVu {
  /** `subagent_type` demandé — jamais deviné (voir le repli ci-dessous). */
  nom: string;
  /** Description passée à l'outil : ce que le sous-agent est censé faire. */
  description: string | null;
  /** L'outil a rendu son résultat — le sous-agent a fini, bien ou mal. */
  termine: boolean;
  /** Fini EN ERREUR : un sous-agent mort ne doit pas se lire comme un sous-agent réussi. */
  erreur: boolean;
}

export function sousAgentsDuTour(turn: AgentTurn | undefined): SousAgentVu[] {
  const vus: SousAgentVu[] = [];
  for (const bloc of turn?.blocks ?? []) {
    if (bloc.type !== "tool" || !OUTILS_DELEGATION.has(bloc.toolName)) continue;
    const input = asRecord(bloc.toolInput);
    const type = typeof input.subagent_type === "string" ? input.subagent_type.trim() : "";
    const description = typeof input.description === "string" ? input.description.trim() : "";
    vus.push({
      // Un lancement sans `subagent_type` reste « sous-agent » : mieux vaut un
      // nom générique qu'un nom inventé (même règle que T-023).
      nom: type || "sous-agent",
      description: description || null,
      termine: bloc.result !== undefined,
      erreur: bloc.result?.isError === true,
    });
  }
  return vus;
}

/**
 * Sous-agents du DERNIER tour assistant : ce qui tourne pendant un tour, ce
 * qui vient de tourner sinon. Volontairement pas un cumul de session — la
 * question posée est « qui travaille pour moi maintenant », pas « qui a
 * travaillé depuis ce matin » (ça, c'est la page Supervision).
 */
export function sousAgentsVifs(turns: AgentTurn[]): SousAgentVu[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === "assistant") return sousAgentsDuTour(turn);
  }
  return [];
}

/**
 * T-102 — un push glissé PENDANT qu'un sous-agent occupe le tour n'a aucun
 * point d'injection avant qu'il ne rende la main (parfois des dizaines de
 * minutes, constat du 2026-08-29) : la bulle « en cours de tour » doit le
 * dire, plutôt que de laisser croire à une attente ordinaire.
 *
 * Le tour PRÉCÉDENT (celui que l'injection vient de clore, `continued: true`
 * — voir envoiProjet.ts) porte encore son bloc `Task`/`Agent` SANS résultat :
 * c'est le signe direct qu'un sous-agent tournait au moment du push, sans
 * qu'il faille un seul bit d'état de plus côté sidecar — `sousAgentsDuTour`
 * (T-077) le sait déjà en lisant les blocs.
 */
export function sousAgentOccupaitLeTour(turnPrecedent: AgentTurn | undefined): boolean {
  if (!turnPrecedent) return false;
  return sousAgentsDuTour(turnPrecedent).some((s) => !s.termine);
}

/*
 * T-093 — descriptions des tâches de fond, ramenées à une ligne.
 *
 * Constat du 2026-08-27 (capture) : l'encart « en attente des rapports de 7
 * tâche(s) de fond » affichait quinze lignes de shell — un `curl` avec
 * heredoc et un `python3 -c` complets, retours à la ligne compris. La
 * description d'une tâche de fond, côté SDK, est ce que le modèle a écrit :
 * pour un `Bash` détaché, c'est la commande entière. Le bouton « Rendre la
 * main » se retrouvait noyé au milieu du pavé.
 *
 * L'encart répond à une seule question — « qu'est-ce qui tourne encore ? ».
 * Une ligne par tâche, aplatie et coupée, y répond ; le détail exact vit dans
 * le bloc d'outil correspondant, plus haut dans la transcription.
 */

/** Longueur au-delà de laquelle une description est coupée. */
const LONGUEUR_TACHE_FOND = 60;

/** Nombre de tâches nommées avant de compter le reste. */
const TACHES_FOND_NOMMEES = 3;

export function resumerTachesDeFond(descriptions: readonly string[]): string {
  const propres = descriptions
    .map((d) => d.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((d) => (d.length > LONGUEUR_TACHE_FOND ? `${d.slice(0, LONGUEUR_TACHE_FOND - 1)}…` : d));
  if (propres.length === 0) return "";
  const nommees = propres.slice(0, TACHES_FOND_NOMMEES);
  const reste = propres.length - nommees.length;
  // « +4 autres » plutôt que rien : une liste tronquée en silence se lit comme
  // une liste complète (même règle que partout ailleurs dans ce produit).
  return reste > 0 ? `${nommees.join(" · ")} · +${reste} autre${reste > 1 ? "s" : ""}` : nommees.join(" · ");
}

/*
 * T-081 — le modèle d'un type de sous-agent, DÉCLARÉ et jamais mesuré.
 *
 * ── Ce que ça dit, et surtout ce que ça ne dit pas ───────────────────────
 * Le lancement d'un sous-agent (`Task`/`Agent`) n'annonce pas le modèle —
 * c'est la limite énoncée plus haut, elle ne change pas. Mais le manifeste
 * de l'agent, lui, le déclare (`model:` du frontmatter), et le moteur projet
 * charge ces manifestes puisqu'il passe `settingSources: ["user","project",
 * "local"]` (sidecar/src/claude.ts). `agents.list` les rend déjà, modèle
 * compris : la donnée est là, elle n'était simplement pas rapprochée du
 * lancement.
 *
 * ⚠ C'est donc une INTENTION, pas une mesure — même distinction que T-035 et
 * T-066 : la ventilation `modelUsage` dit ce qui a réellement consommé, ce
 * champ dit ce que le manifeste demande. L'affichage doit le nommer
 * « déclaré », et les deux ne se somment jamais.
 */

/** T-081 — modèle déclaré pour un type de sous-agent. */
export interface ModeleSousAgent {
  /** Alias ou id tel qu'écrit dans le manifeste — `null` = rien de déclaré. */
  modele: string | null;
  /** Un manifeste porte bien ce nom (sinon : type inconnu, agent intégré du SDK). */
  connu: boolean;
}

/** Comparaison des noms d'agents : le `subagent_type` demandé par le modèle
 *  peut différer du manifeste par la casse ou une espace de bord. */
function memeNomAgent(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * T-081 — modèle DÉCLARÉ du type de sous-agent `nom`, cherché dans les
 * manifestes connus (`agents.list`).
 *
 * Trois issues, toutes distinctes et aucune devinée (leçon T-023) :
 * - manifeste trouvé avec `model` → `{ modele, connu: true }` ;
 * - manifeste trouvé sans `model` → `{ modele: null, connu: true }` : l'agent
 *   hérite du modèle du fil, ce qui est une information, pas une absence ;
 * - aucun manifeste → `{ modele: null, connu: false }` : type intégré au SDK
 *   (`general-purpose`, `Explore`…) ou nom inconnu. On n'affiche alors rien
 *   plutôt qu'un modèle inventé.
 */
export function modeleSousAgentDeclare(
  nom: string,
  manifestes: readonly { name: string; model: string | null }[],
): ModeleSousAgent {
  for (const m of manifestes) {
    if (!memeNomAgent(m.name, nom)) continue;
    const modele = (m.model ?? "").trim();
    return { modele: modele === "" ? null : modele, connu: true };
  }
  return { modele: null, connu: false };
}

/**
 * Reconstruit l'historique `messages` pour le moteur neutre depuis les
 * tours du projet courant : rôle `user` = son contenu ; rôle `assistant` =
 * concaténation des blocs `text` uniquement (les blocs `thinking`/`tool`
 * n'ont pas d'équivalent dans le dialecte OpenAI-compatible) ; les tours
 * `error` sont sautés (contenu potentiellement vide/partiel). Le moteur
 * neutre n'a pas d'état de session (voir docs/protocol.md, Lot 6) : cet
 * historique complet est renvoyé à CHAQUE tour.
 */
export function buildNeutralMessages(history: AgentTurn[], newContent: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const turn of history) {
    if (turn.status === "error") continue;
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.content ?? "" });
    } else {
      const text = (turn.blocks ?? [])
        .filter((b): b is Extract<AgentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.content)
        .join("");
      messages.push({ role: "assistant", content: text });
    }
  }
  messages.push({ role: "user", content: newContent });
  return messages;
}

/**
 * Préfixe `messages` d'un message `system` portant les instructions de
 * l'agent sélectionné (moteur neutre) — sans effet si l'agent n'en a pas
 * (chaîne vide) ou si un message `system` est déjà en tête (jamais le cas
 * ici, `buildNeutralMessages` n'en produit pas, mais reste défensif comme
 * demandé par la spec O2).
 */
export function withAgentSystemPrompt(messages: ChatMessage[], instructions: string | undefined): ChatMessage[] {
  if (!instructions || messages[0]?.role === "system") return messages;
  return [{ role: "system", content: instructions }, ...messages];
}
