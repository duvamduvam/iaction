/*
 * Envoi et moteurs de la page Projets — le chemin chaud sorti d'AgentPage
 * (étape 4b-bis de docs/etude-structure.md).
 *
 * ── Ce que ce module possède ────────────────────────────────────────────
 * Tout ce qui se passe entre « Envoyer » et la fin du tour : la file et la
 * demande glissée (claude.push) pendant un streaming, la résolution Auto
 * (stratégie DESCENDANTE, voir routageAuto.ts), l'injection des
 * connaissances au premier tour, le départ vers l'un des deux moteurs, les
 * callbacks de streaming, l'affinité posée au premier signe de succès, et la
 * sauvegarde de fin de tour (y compris le cas du tour d'ARRIÈRE-PLAN dont le
 * projet affiché a changé).
 *
 * ── Pourquoi une fabrique et pas un hook ────────────────────────────────
 * `creerEnvoiProjet` est rappelée par la page À CHAQUE rendu, exactement
 * comme l'étaient les fonctions qu'elle remplace : un tour capture l'état du
 * rendu qui l'a lancé (c'est voulu — voir les commentaires de handleSend sur
 * `convId`), puis n'écrit plus QUE dans les runtimes via `convId`. Aucun
 * état propre, aucun hook : rien à mémoïser, rien à désynchroniser.
 *
 * Ce module est du CÂBLAGE : il importe les clients sidecar en valeur, donc
 * il n'est pas testable unitairement (sidecar.ts s'abonne à Tauri au
 * chargement). La logique qui se teste vit dans les feuilles qu'il appelle :
 * routageAuto.ts, gardesRoutage.ts, connaissances.ts, agentTurns.ts,
 * debordNotice.ts.
 */

import { toContractAttachments, toSentAttachments, type DraftAttachment } from "./Attachments";
import {
  addToolBlock,
  appendToLastBlock,
  buildNeutralMessages,
  mcpServerFromToolName,
  nextId,
  setToolResult,
  withAgentSystemPrompt,
  withBlocks,
  withTurnDone,
  withTurnError,
  type AgentTurn,
} from "./agentTurns";
import { buildKnowledgeBlock, RAG_SYSTEM_LINE, type PinnedDoc } from "./connaissances";
import { appliquerDebordNotice } from "./debordNotice";
import { recordModelUsage } from "./fableUsage";
import { fsReadFile } from "./fsClient";
import { AUTO_MODEL, type ConvRuntime, type ProjectSession } from "./modeleProjet";
import type { AgentInfo } from "./orchestrationClient";
import type { KnowledgeMode } from "./projectAdmin";
import { cleAutoAllow, normaliserModePourMoteur } from "./permissions";
import type { PermissionRequestItem } from "./questionsAgent";
import { estCibleUtilisable, resoudreRouteDescendante } from "./routageAuto";
import { mergeRoutingTable, readRoutingDebord, readRoutingTable } from "./routerAdmin";
import {
  claudePermission,
  claudePush,
  claudeStart,
  neutralPermission,
  neutralStart,
  parseClaudeDone,
  parseNeutralDone,
  routerRoute,
  type ChatAttachment,
  type ChatMessage,
  type PermissionMode,
  type RequestMeta,
  type RouteDebord,
} from "./sidecar";
import { notifyUsageChanged } from "./usageBus";

/**
 * Tout ce que le chemin chaud lit ou écrit dans la page. La taille de cette
 * interface n'est pas un accident : c'est la surface de couplage RÉELLE de
 * l'envoi, rendue visible — chaque entrée retirée ici est un progrès mesuré.
 */
export interface DepsEnvoiProjet {
  /* ── état du rendu qui lance le tour ── */
  activeSessionId: string | null;
  cwd: string;
  selectedProjectId: string | null;
  /** Miroir synchrone du projet affiché — voir la garde de fin de tour de `handleSend`. */
  selectedProjectIdRef: { readonly current: string | null };
  /** Fournisseurs neutres déclarés (seul `id` sert : cible utilisable ou non). */
  fournisseurs: ReadonlyArray<{ id: string }>;
  streaming: boolean;
  sessionId: string | null;
  turns: AgentTurn[];
  model: string;
  engineProviderId: string | null;
  permissionMode: PermissionMode;
  selectedAgent: AgentInfo | null;
  attachments: DraftAttachment[];
  attachmentsPending: boolean;
  knowledgeMode: KnowledgeMode;
  /** R5 — l'index RAG existe réellement (sinon la ligne système n'est pas injectée). */
  indexConnaissancesPret: boolean;
  injectedKnowledge: PinnedDoc[];
  /* ── lecture/écriture des runtimes de conversation ── */
  getRuntime: (convId: string) => ConvRuntime;
  updateRuntime: (convId: string, updater: (prev: ConvRuntime) => ConvRuntime) => void;
  updateTurnsFor: (convId: string, updater: (prev: AgentTurn[]) => AgentTurn[]) => void;
  autoAllowToolsRef: { readonly current: ReadonlySet<string> };
  injectorsRef: { readonly current: Map<string, (text: string) => void> };
  setPermissionQueue: (updater: (prev: PermissionRequestItem[]) => PermissionRequestItem[]) => void;
  /* ── signaux vers le reste de la page ── */
  fermerMenuSlash: () => void;
  signalerMcpInit: () => void;
  rafraichirConnaissancesAuto: () => void;
  setAttachmentsError: (message: string) => void;
  clearAttachments: () => void;
  restoreAttachments: (drafts: DraftAttachment[]) => void;
  collerEnBas: () => void;
  /* ── persistance de fin de tour ── */
  buildLiveSessions: () => ProjectSession[];
  setSessions: (sessions: ProjectSession[]) => void;
  persistProject: (id: string, liveSessions: ProjectSession[]) => void;
  persistBackgroundConversation: (projectId: string, convId: string) => void;
}

export function creerEnvoiProjet(deps: DepsEnvoiProjet): {
  handleSend: (overrideContent?: string) => Promise<void>;
} {
  const {
    activeSessionId,
    cwd,
    selectedProjectId,
    selectedProjectIdRef,
    fournisseurs,
    streaming,
    sessionId,
    turns,
    model,
    engineProviderId,
    permissionMode,
    selectedAgent,
    attachments,
    attachmentsPending,
    knowledgeMode,
    indexConnaissancesPret,
    injectedKnowledge,
    getRuntime,
    updateRuntime,
    updateTurnsFor,
    autoAllowToolsRef,
    injectorsRef,
    setPermissionQueue,
    fermerMenuSlash,
    signalerMcpInit,
    rafraichirConnaissancesAuto,
    setAttachmentsError,
    clearAttachments,
    restoreAttachments,
    collerEnBas,
    buildLiveSessions,
    setSessions,
    persistProject,
    persistBackgroundConversation,
  } = deps;

  /**
   * Étape 11 — demande de permission d'un tour (les deux moteurs) : outil
   * mémorisé « ne plus demander » (clé PAR PROJET, voir permissions.ts) →
   * auto-autorisation sans modale ; sinon mise en file (modale de la page).
   * `projectId` voyage avec la demande : c'est le projet PROPRIÉTAIRE du
   * tour (capturé à l'envoi), pas celui affiché au moment de la réponse.
   */
  function gererDemandePermission(
    engine: "claude" | "neutral",
    targetId: string,
    permissionId: string,
    toolName: string,
    toolInput: unknown,
  ) {
    if (autoAllowToolsRef.current.has(cleAutoAllow(selectedProjectId, toolName))) {
      void (engine === "neutral" ? neutralPermission : claudePermission)(targetId, permissionId, "allow");
      return;
    }
    setPermissionQueue((prev) => [
      ...prev,
      { targetId, permissionId, toolName, toolInput, engine, projectId: selectedProjectId },
    ]);
  }

  /**
   * R5 — instructions système effectives du tour : celles de l'agent
   * sélectionné, plus la ligne RAG quand le mode connaissances du projet est
   * `rag` (voir RAG_SYSTEM_LINE — remplace l'injection intégrale au 1er tour).
   * `undefined` = aucune instruction (comportement historique inchangé).
   */
  function composeSystemInstructions(): string | undefined {
    const parts = [
      selectedAgent?.instructions,
      // La ligne RAG n'est injectée que si l'index EXISTE réellement
      // (`knowledge.status`) : sans index, promettre `search_knowledge` au
      // modèle ne mènerait qu'à des appels d'outil vides.
      knowledgeMode === "rag" && indexConnaissancesPret ? RAG_SYSTEM_LINE : undefined,
    ].filter((p): p is string => typeof p === "string" && p.length > 0);
    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }

  /** Lance le tour via le moteur Claude (Agent SDK) — `systemPrompt` armé par l'agent sélectionné, s'il y en a un.
   * R2 — `modelId`/`meta` figés par `handleSend` (modèle du sélecteur, ou cible routée en mode Auto + routeTier). */
  function sendViaClaudeEngine(
    content: string,
    /**
     * S3 — bulle assistant qui reçoit le flux, MUTABLE : une demande injectée
     * en cours de tour (claude.push) en ouvre une nouvelle, et la suite du
     * streaming doit atterrir dedans, pas dans celle d'avant l'injection.
     */
    target: { id: string },
    common: {
      onText: (delta: string) => void;
      onToolUse: (toolUseId: string, toolName: string, toolInput: unknown) => void;
      onToolResult: (toolUseId: string, isError: boolean, summary: string) => void;
    },
    attachments: ChatAttachment[] | undefined,
    /** Conversation propriétaire du tour — voir `handleSend` : tous les callbacks écrivent ici, pas dans « l'active ». */
    convId: string,
    modelId: string | null,
    meta: RequestMeta,
  ) {
    const handle = claudeStart(
      {
        cwd,
        prompt: content,
        // Session serveur de CETTE conversation (le `sessionId` dérivé de
        // l'active serait le mauvais si l'utilisateur a changé d'onglet).
        sessionId: getRuntime(convId).sessionId,
        model: modelId,
        permissionMode,
        // Page ouverte devant l'utilisateur : l'agent peut poser ses questions
        // dans une modale à choix cliquables (outil mcp__studio__ask_user).
        interactive: true,
        // R5 — instructions de l'agent + ligne RAG éventuelle (mode `rag`).
        systemPrompt: composeSystemInstructions() ?? null,
        // T-003 — allowlist `tools:` de l'agent (voir sendViaNeutralEngine).
        tools: selectedAgent?.tools ?? null,
        attachments,
        meta,
      },
      {
        onInit: (sid) => updateRuntime(convId, (r) => ({ ...r, sessionId: sid })),
        // Le sidecar vient de réécrire l'état constaté des serveurs MCP
        // (.iaction/mcp.runtime.json) : le panneau se rafraîchit pour montrer
        // ce qui s'est VRAIMENT connecté à ce tour.
        onMcpInit: () => signalerMcpInit(),
        onText: common.onText,
        onThinking: (delta) =>
          updateTurnsFor(convId, (prev) => withBlocks(prev, target.id, (b) => appendToLastBlock(b, "thinking", delta))),
        onToolUse: common.onToolUse,
        onToolResult: common.onToolResult,
        onBackgroundTasks: (count, descriptions) =>
          updateTurnsFor(convId, (prev) =>
            prev.map((t) =>
              t.id === target.id
                ? {
                    ...t,
                    backgroundTasks:
                      count > 0
                        ? { count, descriptions, waiting: t.backgroundTasks?.waiting === true }
                        : undefined,
                  }
                : t,
            ),
          ),
        onBackgroundWait: (count, descriptions) =>
          updateTurnsFor(convId, (prev) =>
            prev.map((t) => (t.id === target.id ? { ...t, backgroundTasks: { count, descriptions, waiting: true } } : t)),
          ),
        onCompact: (trigger, preTokens) =>
          updateTurnsFor(convId, (prev) =>
            prev.map((t) => (t.id === target.id ? { ...t, compacted: { trigger, preTokens } } : t)),
          ),
        onPermissionRequest: (permissionId, toolName, toolInput) =>
          gererDemandePermission("claude", handle.id, permissionId, toolName, toolInput),
      },
    );
    return handle;
  }

  /** Lance le tour via le moteur neutre (Ollama/OpenRouter/custom) — même contrat de chunks que Claude, sans état de session. `maxTurns` armé par l'agent sélectionné, s'il y en a un.
   * R2 — `modelId`/`meta` figés par `handleSend` (modèle du sélecteur, ou cible routée en mode Auto + routeTier). */
  function sendViaNeutralEngine(
    providerId: string,
    historyMessages: ChatMessage[],
    common: {
      onText: (delta: string) => void;
      onToolUse: (toolUseId: string, toolName: string, toolInput: unknown) => void;
      onToolResult: (toolUseId: string, isError: boolean, summary: string) => void;
    },
    modelId: string,
    meta: RequestMeta,
  ) {
    // Repli du registre (permissions.ts) : « plan » n'existe pas côté neutre
    // (le sélecteur l'empêche déjà, mais un état résiduel est possible).
    const neutralPermissionMode = normaliserModePourMoteur(permissionMode, "neutral");
    const handle = neutralStart(
      {
        providerId,
        model: modelId,
        cwd,
        messages: historyMessages,
        permissionMode: neutralPermissionMode,
        maxTurns: selectedAgent?.maxTurns ?? undefined,
        // T-003 — allowlist `tools:` de l'agent : appliquée ici comme en
        // orchestration (jusqu'au 2026-08-07 le champ n'était transmis à
        // personne, donc purement décoratif).
        tools: selectedAgent?.tools ?? null,
        meta,
      },
      {
        onText: common.onText,
        onToolUse: common.onToolUse,
        onToolResult: common.onToolResult,
        onPermissionRequest: (permissionId, toolName, toolInput) =>
          gererDemandePermission("neutral", handle.id, permissionId, toolName, toolInput),
      },
    );
    return handle;
  }

  /**
   * R2/R7 §C — stratégie DESCENDANTE : la règle vit dans `routageAuto.ts`
   * (avec sa jumelle montante du Chat). Ne reste ici que le branchement :
   * affinité lue dans le runtime de la conversation, fournisseurs et table
   * injectés.
   */
  async function resolveAutoRoute(convId: string, content: string) {
    const runtime = getRuntime(convId);
    const affinite =
      runtime.routedTier && runtime.routedTarget
        ? { tier: runtime.routedTier, target: runtime.routedTarget, reasons: runtime.routedReasons ?? undefined }
        : null;
    return resoudreRouteDescendante(affinite, content, cwd, {
      router: routerRoute,
      estUtilisable: (t) => estCibleUtilisable(t, fournisseurs),
      lireTable: async () => mergeRoutingTable(await readRoutingTable()),
    });
  }

  /**
   * R3 — pose/efface le bandeau de débord de la conversation d'après la
   * résolution du tour qui part (même contrat que ChatPage.tsx).
   * `unconfigured` : cible de débord non déclarée — bandeau dédié, le tour
   * part sur l'abonnement (voir `resolveAutoRoute`).
   */
  /**
   * Bandeau de débord — les règles vivent dans `debordNotice.ts`, partagé avec
   * l'autre page. Ne reste ici que le branchement : où écrire, et comment lire
   * le plafond.
   */
  async function applyDebordNotice(
    convId: string,
    debord: RouteDebord | null,
    model: string,
    unconfigured = false,
  ): Promise<void> {
    await appliquerDebordNotice<ConvRuntime>((majeur) => updateRuntime(convId, majeur), {
      debord,
      model,
      unconfigured,
      lirePlafond: () => readRoutingDebord().then((d) => d?.plafondUsdMois ?? null),
    });
  }

  async function handleSend(overrideContent?: string) {
    // Conversation À LAQUELLE ce tour appartient, figée ici : tout ce qui suit
    // (callbacks de streaming, fin de tour, sauvegarde) écrit dans CETTE
    // conversation via `convId`, jamais dans « l'active ». C'est ce qui permet
    // à l'utilisateur de changer d'onglet pendant qu'un tour tourne sans que
    // la réponse n'atterrisse dans la mauvaise conversation.
    const convId = activeSessionId;
    if (!convId) return;
    // Brouillon VIF du runtime — jamais `draft` (valeur de rendu) : la frappe
    // n'est répercutée au rendu que par un rattrapage débouncé (voir
    // useComposerLiveDraft.ts), un Entrée immédiat lirait un texte tronqué.
    const liveDraft = getRuntime(convId).draft;

    // Pendant un tour en cours : jamais de second envoi. Deux issues —
    // S3, moteur Claude : la demande est GLISSÉE dans le tour en cours
    // (claude.push), prise en compte au prochain retour d'outil sans rien
    // couper ; c'est ce qui permet d'interroger l'agent pendant qu'il attend
    // ses tâches de fond. Sinon (moteur neutre, tour déjà fini côté sidecar) :
    // mise en file automatique, envoyée à la fin du tour (voir l'effet
    // d'auto-envoi) — un seul bouton « Envoyer », le repli est transparent.
    // L'auto-envoi rappelle handleSend avec `overrideContent` une fois
    // `streaming` repassé à false — ce chemin-là ne re-file jamais.
    if (streaming && overrideContent === undefined) {
      const pending = liveDraft.trim();
      if (!pending) return;
      fermerMenuSlash();
      // Ni une demande glissée (claude.push) ni la file ne transportent de
      // pièces jointes : on le DIT et on les garde dans le tiroir pour le
      // prochain message complet, plutôt que de les laisser partir en fumée.
      if (attachments.length > 0) {
        setAttachmentsError(
          "Pièces jointes conservées : elles ne partent pas avec un message envoyé pendant un tour — elles seront jointes à votre prochain message complet.",
        );
      }
      const runtime = getRuntime(convId);
      const inject = injectorsRef.current.get(convId);
      if (inject && runtime.activeEngine === "claude" && runtime.activeRequestId) {
        // Le brouillon part tout de suite : si le sidecar refuse (tour déjà
        // clos), il est reposé en file juste en dessous — jamais perdu.
        updateRuntime(convId, (r) => ({ ...r, draft: "" }));
        const pushed = await claudePush(runtime.activeRequestId, pending).catch(() => false);
        if (pushed) {
          inject(pending);
          return;
        }
        updateRuntime(convId, (r) => ({ ...r, queuedPrompts: [...r.queuedPrompts, pending] }));
        return;
      }
      updateRuntime(convId, (r) => ({ ...r, queuedPrompts: [...r.queuedPrompts, pending], draft: "" }));
      return;
    }

    // Chemin « file » (overrideContent) : texte seul, pas de pièces jointes.
    const usesComposer = overrideContent === undefined;
    const rawContent = (overrideContent ?? liveDraft).trim();
    if ((!rawContent && (!usesComposer || attachments.length === 0)) || streaming || !cwd) return;
    // Une image collée est encore en cours d'encodage : on attend plutôt que
    // d'envoyer une pièce jointe sans données.
    if (usesComposer && attachmentsPending) {
      setAttachmentsError("Image en cours de chargement… réessayez dans un instant.");
      return;
    }

    const engineSelected: "claude" | "neutral" = engineProviderId !== null ? "neutral" : "claude";
    // R2 — tour « Auto (routeur) » : le moteur/modèle réels ne sont connus
    // qu'après résolution de la cible, juste en dessous.
    const isAutoTurn = model === AUTO_MODEL;
    // Pièces jointes : non supportées par `neutral.start` (voir le contrat), et
    // le mode Auto peut y router — `attachmentsSupported`/les bascules de
    // moteur les vident déjà en amont, mais on reste défensif ici plutôt que
    // de risquer un envoi silencieux vers le mauvais moteur. Capturées avant
    // tout envoi : le brouillon n'est purgé qu'en cas de succès (voir le
    // `try`/`catch` plus bas).
    const attachmentsAllowed = usesComposer && engineSelected === "claude" && !isAutoTurn;
    const contractAttachments = attachmentsAllowed ? toContractAttachments(attachments) : [];
    const sentAttachments = attachmentsAllowed ? toSentAttachments(attachments) : [];
    // Brouillons d'origine, gardés pour les reposer si le tour échoue (voir le
    // `catch`) : le tiroir, lui, est vidé dès l'envoi.
    const sentDrafts = attachmentsAllowed ? attachments : [];

    // Verrouille l'envoi tout de suite (avant les résolutions asynchrones
    // ci-dessous — routage Auto, lecture des documents épinglés) : sans ça, un
    // second Entrée pendant ces attentes pourrait déclencher un double envoi.
    // `preSendAbort` repart de zéro : c'est le drapeau de CE tour (voir
    // `handleAbort` et le point de contrôle plus bas). Chemin « file » : ne
    // pas toucher au brouillon (l'utilisateur a pu recommencer à taper un
    // message suivant pendant que le tour finissait).
    updateRuntime(convId, (r) => ({
      ...r,
      streaming: true,
      preSendAbort: false,
      activeEngine: engineSelected,
      ...(usesComposer ? { draft: "" } : {}),
    }));

    // R2/R7 — mode Auto : résolution de la cible AVANT le reste (le moteur
    // réel conditionne l'injection de connaissances et l'historique neutre).
    // Stratégie DESCENDANTE : premier tour au sommet de la table (`complexe`
    // imposé), affinité de session ensuite (voir `resolveAutoRoute`).
    let engine = engineSelected;
    let turnProviderId: string | null = engineProviderId;
    let turnModel = model;
    let autoRoute: Awaited<ReturnType<typeof resolveAutoRoute>> | null = null;
    if (isAutoTurn) {
      try {
        autoRoute = await resolveAutoRoute(convId, rawContent);
      } catch (err) {
        // Échec du routage (sidecar injoignable…) : tour marqué en erreur,
        // comme n'importe quel échec de moteur.
        const message = err instanceof Error ? err.message : String(err);
        updateRuntime(convId, (r) => ({
          ...r,
          streaming: false,
          turns: [
            ...r.turns,
            { id: nextId("u"), role: "user", content: rawContent, displayContent: rawContent, status: "done" },
            { id: nextId("a"), role: "assistant", blocks: [], status: "error", errorMessage: message },
          ],
        }));
        return;
      }
      engine = autoRoute.target.engine === "neutral" ? "neutral" : "claude";
      turnProviderId = autoRoute.target.engine === "neutral" ? (autoRoute.target.providerId ?? "") : null;
      turnModel = autoRoute.target.model;
      // Moteur réel du tour, pour un abandon correctement routé.
      updateRuntime(convId, (r) => ({ ...r, activeEngine: engine }));
      // R3 — bandeau de débord : posé au tour concerné, effacé au tour normal.
      await applyDebordNotice(convId, autoRoute.debord, autoRoute.target.model, autoRoute.debordUnconfigured);
    } else {
      // R3 — tour à moteur/modèle choisis MANUELLEMENT : jamais bloqué ni
      // bandeau-isé — un éventuel bandeau de débord précédent s'efface.
      updateRuntime(convId, (r) => (r.debordNotice ? { ...r, debordNotice: null } : r));
    }

    // Injection des connaissances (épinglées + auto `.iaction/connaissances/`,
    // voir `injectedKnowledge`) SEULEMENT au premier tour de la session :
    // Claude via `sessionId` (encore `null` = pas de session serveur
    // existante) ; moteur neutre via l'historique (pas d'état de session côté
    // serveur, voir `buildNeutralMessages` — l'historique encore vide EST le
    // premier tour). R5 — mode `rag` : PAS d'injection intégrale, la ligne
    // système RAG_SYSTEM_LINE la remplace (via composeSystemInstructions) et
    // l'outil search_knowledge prend le relais dans les deux moteurs.
    const isFirstTurn = engine === "claude" ? sessionId === null : turns.length === 0;
    const docsToInject = isFirstTurn && knowledgeMode !== "rag" ? injectedKnowledge : [];

    let sentContent = rawContent;
    if (docsToInject.length > 0) {
      sentContent = `${await buildKnowledgeBlock(docsToInject, cwd, async (p) => {
        const fc = await fsReadFile(p);
        return fc.kind === "text" ? (fc.text ?? "") : null;
      })}${rawContent}`;
    }

    const historyMessages =
      engine === "neutral"
        ? withAgentSystemPrompt(buildNeutralMessages(turns, sentContent), composeSystemInstructions())
        : [];

    // « Arrêter » cliqué pendant la phase de PRÉ-ENVOI ci-dessus (routage
    // Auto ≤ 3 s, lecture des connaissances) : abandon propre AVANT tout
    // envoi — rien n'est parti vers un moteur, le message est simplement
    // reposé dans le composeur (devant ce que l'utilisateur a pu retaper).
    if (getRuntime(convId).preSendAbort) {
      updateRuntime(convId, (r) => ({
        ...r,
        streaming: false,
        preSendAbort: false,
        draft: r.draft ? `${rawContent}\n${r.draft}` : rawContent,
      }));
      return;
    }

    const userTurn: AgentTurn = {
      id: nextId("u"),
      role: "user",
      content: sentContent,
      displayContent: rawContent,
      injectedKnowledgeCount: docsToInject.length || undefined,
      status: "done",
      ...(sentAttachments.length > 0 ? { attachments: sentAttachments } : {}),
    };
    const assistantId = nextId("a");
    // Le message part MAINTENANT : le tiroir de pièces jointes se vide ici, pas
    // à la fin du tour — les vignettes figurent désormais dans le tour affiché,
    // les garder en bas laissait croire qu'elles restaient à envoyer. Reposées
    // par le `catch` si le tour échoue. Vidage conditionné à ce qui est
    // RÉELLEMENT parti : rien n'est retiré si le moteur n'en accepte pas
    // (neutre, mode Auto), où le tiroir n'a de toute façon pas à être touché.
    if (sentDrafts.length > 0) clearAttachments();
    // S3 — bulle assistant courante du tour (voir sendViaClaudeEngine) :
    // remplacée à chaque demande injectée pour préserver l'ordre de lecture.
    const streamTarget = { id: assistantId };
    updateTurnsFor(convId, (prev) => [
      ...prev,
      userTurn,
      {
        id: assistantId,
        role: "assistant",
        blocks: [],
        status: "streaming",
        // R2 — badge « ⚡ auto : tier → modèle » porté par le tour assistant
        // (persisté avec lui — l'infobulle liste les raisons du classement).
        ...(autoRoute
          ? { routeTier: autoRoute.tier, routeModel: autoRoute.target.model, routeReasons: autoRoute.reasons }
          : {}),
      },
    ]);
    collerEnBas();

    // R2/R6 — affinité de session EN ATTENTE : mémorisée au PREMIER signe de
    // succès du tour (premier texte reçu, ou `done` sans erreur) — un tour
    // routé qui échoue (cible Ollama éteinte…) ne verrouille jamais la
    // conversation sur une cible morte. R7 §C — la session reste ensuite au
    // sommet (aucune descente automatique) : le plancher montant du Chat (§B)
    // ne s'applique pas à ce flux.
    let commitAffinity: (() => void) | null = null;
    if (autoRoute?.pendingAffinity) {
      const { tier: routedTier, target: routedTarget, reasons: routedReasons } = autoRoute;
      commitAffinity = () => {
        commitAffinity = null;
        updateRuntime(convId, (r) => ({ ...r, routedTier, routedTarget, routedReasons }));
      };
    }

    const common = {
      onText: (delta: string) => {
        commitAffinity?.();
        updateTurnsFor(convId, (prev) => withBlocks(prev, streamTarget.id, (b) => appendToLastBlock(b, "text", delta)));
      },
      onToolUse: (toolUseId: string, toolName: string, toolInput: unknown) => {
        updateTurnsFor(convId, (prev) => withBlocks(prev, streamTarget.id, (b) => addToolBlock(b, toolUseId, toolName, toolInput)));
        // Compteur d'usage MCP (section « MCP ») : porté par le runtime de
        // CETTE conversation, donc juste même si l'onglet affiché a changé.
        const server = mcpServerFromToolName(toolName);
        if (server) {
          const tool = toolName.split("__").slice(2).join("__") || toolName;
          updateRuntime(convId, (r) => ({
            ...r,
            mcpUsage: { ...r.mcpUsage, [server]: { calls: (r.mcpUsage[server]?.calls ?? 0) + 1, lastTool: tool } },
          }));
        }
      },
      onToolResult: (toolUseId: string, isError: boolean, summary: string) =>
        updateTurnsFor(convId, (prev) => withBlocks(prev, streamTarget.id, (b) => setToolResult(b, toolUseId, isError, summary))),
    };

    // R2 — meta commun aux deux moteurs : routeTier quand le tour a été routé
    // (persisté dans events.jsonl, voir docs/protocol.md § S1).
    const meta: RequestMeta = { source: "projet", conversationId: convId };
    // S2 — imputation du tour au projet ouvert (encart « Usage par projet »).
    if (selectedProjectId) meta.projectId = selectedProjectId;
    if (cwd) meta.projectPath = cwd;
    if (autoRoute) meta.routeTier = autoRoute.tier;
    // R3 — tour réellement débordé : marqué pour le plafond mensuel (events.jsonl).
    if (autoRoute?.debord?.active) meta.routeDebord = true;

    const { id, done } =
      engine === "neutral"
        ? sendViaNeutralEngine(turnProviderId as string, historyMessages, common, turnModel, meta)
        : sendViaClaudeEngine(sentContent, streamTarget, common, contractAttachments, convId, turnModel || null, meta);
    updateRuntime(convId, (r) => ({ ...r, activeRequestId: id }));

    // S3 — injecteur de CE tour : appelé par le composeur quand le sidecar a
    // accepté la demande (claude.push). Il ouvre la bulle utilisateur puis une
    // nouvelle bulle assistant, et redirige le flux vers elle — la suite de la
    // réponse s'affiche donc APRÈS la demande, comme dans Claude Code.
    if (engine === "claude") {
      injectorsRef.current.set(convId, (text: string) => {
        const nextAssistantId = nextId("a");
        // La bulle en cours est close (`continued`) avant la redirection :
        // plus rien ne la repassera à « done » ensuite (le `done` du tour ne
        // patche que la DERNIÈRE cible) — laissée en streaming, elle
        // clignotait à vie et disparaissait à la persistance.
        updateTurnsFor(convId, (prev) => [
          ...prev.map((t) =>
            t.id === streamTarget.id && t.status === "streaming" ? { ...t, status: "done" as const, continued: true } : t,
          ),
          { id: nextId("u"), role: "user", content: text, displayContent: text, status: "done", injected: true },
          // `suiteDeTour` : le fournisseur a déjà répondu plus haut dans ce
          // tour — cette bulle attend le prochain outil, pas le premier octet
          // (T-027, sinon l'avis « aucune donnée reçue » s'y affichait).
          { id: nextAssistantId, role: "assistant", blocks: [], status: "streaming", suiteDeTour: true },
        ]);
        streamTarget.id = nextAssistantId;
        collerEnBas();
      });
    }

    try {
      const data = await done;
      // Tour terminé sans erreur (même sans texte reçu) : second signe de
      // succès qui fixe l'affinité en attente (no-op si déjà fixée).
      commitAffinity?.();
      const parsed = engine === "neutral" ? parseNeutralDone(data) : parseClaudeDone(data);
      if (engine === "claude" && parsed.sessionId) {
        updateRuntime(convId, (r) => ({ ...r, sessionId: parsed.sessionId }));
      }
      if (engine === "claude") {
        // Compteur local « conso hebdo Fable » (encart conso) — avant le
        // notifyUsageChanged() du finally, pour que l'encart lise à jour.
        // R2 — `turnModel` : le modèle réellement utilisé (cible routée en Auto).
        await recordModelUsage(turnModel, parsed.usage);
      }
      updateTurnsFor(convId, (prev) => withTurnDone(prev, streamTarget.id, parsed));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateTurnsFor(convId, (prev) => withTurnError(prev, streamTarget.id, message));
      // Tour échoué : les pièces jointes reviennent dans le composeur (elles
      // avaient été retirées à l'envoi) — pas question de les rejoindre à la
      // main pour réessayer.
      restoreAttachments(sentDrafts);
    } finally {
      injectorsRef.current.delete(convId);
      // Filet de sécurité : après la fin du tour (done, erreur ou abort),
      // aucune bulle de cette conversation ne doit rester « streaming » —
      // sinon curseur clignotant à vie et bulle perdue à la persistance.
      updateTurnsFor(convId, (prev) =>
        prev.map((t) => (t.status === "streaming" ? { ...t, status: "done" as const } : t)),
      );
      // Un tour a pu écrire dans `.iaction/connaissances/` (guide déposé,
      // document produit par l'agent) : relecture de la liste automatique.
      rafraichirConnaissancesAuto();
      updateRuntime(convId, (r) => ({ ...r, streaming: false, activeRequestId: null }));
      // Sécurité : purge les demandes de permission orphelines de ce tour
      // (le sidecar les refuse déjà normalement à l'abort/fin de tour).
      setPermissionQueue((prev) => prev.filter((p) => p.targetId !== id));
      // Fin de tour : la conso a pu changer (Claude uniquement pour l'instant).
      notifyUsageChanged();
      // Fin de tour : sauvegarde immédiate (pas d'attente du debounce). Les
      // tours/sessionId sont relus dans le RUNTIME de cette conversation (et
      // non dans l'état React fermé à l'appel, périmé après tout ce
      // streaming) — l'utilisateur a pu changer d'onglet entre-temps, donc on
      // ne peut plus supposer que cette conversation est encore l'active.
      if (selectedProjectId) {
        if (selectedProjectIdRef.current === selectedProjectId) {
          const liveSessions = buildLiveSessions();
          setSessions(liveSessions);
          persistProject(selectedProjectId, liveSessions);
        } else {
          // Le projet AFFICHÉ a changé pendant ce tour d'arrière-plan :
          // `buildLiveSessions`/`persistProject` liraient les refs du nouveau
          // projet et écriraient ses sessions sous la clé de l'ancien
          // (contamination croisée du document persisté). On reporte le
          // résultat du tour dans l'état du projet d'ORIGINE, sans toucher à
          // l'affichage.
          persistBackgroundConversation(selectedProjectId, convId);
        }
      }
    }
  }

  return { handleSend };
}
