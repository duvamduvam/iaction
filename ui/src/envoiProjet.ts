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
 * Ce module est du CÂBLAGE (non testable unitairement) : la logique qui se teste vit dans
 * ses feuilles — routageAuto.ts, gardesRoutage.ts, connaissances.ts, agentTurns.ts, debordNotice.ts.
 */

import type { CompteClaude } from "./comptesClaude";
import { toContractAttachments, toSentAttachments, type DraftAttachment, type SentAttachment } from "./Attachments";
import {
  addToolBlock,
  appendToLastBlock,
  buildNeutralMessages,
  mcpServerFromToolName,
  nextId,
  rangerPiecesARenvoyer,
  retirerPushCorrespondant,
  setToolResult,
  spokenTextOfTurn,
  withAgentSystemPrompt,
  withBlocks,
  withPushPerdu,
  withSousAgentBattement,
  withTurnDone,
  withTurnError,
  type AgentTurn,
  type PushEnCoursDeTour,
} from "./agentTurns";
import { changementDepuisChunk, choixApresChangement, withChangementModele, type ChoixModele } from "./changementModele";
import { avecCompactionDemandee } from "./compactionDemandee";
import { traiterReveilDemande } from "./reveilDemande";
import { avecMessageInjecte } from "./injectionEnCoursDeTour";
import { buildKnowledgeBlock, instructionsSysteme, type PinnedDoc } from "./connaissances";
import { rangerPushPerdu, retirerPiecesOrphelines } from "./pushPerdu";
import { recordModelUsage } from "./fableUsage";
import { fsReadFile } from "./fsClient";
import type { ConvRuntime, ProjectSession } from "./modeleProjet";
import { effortsPour, type EffortLevel } from "./modelesAbonnementClaude";
import type { AgentInfo } from "./orchestrationClient";
import type { KnowledgeMode } from "./projectAdmin";
import { cleAutoAllow, normaliserModePourMoteur } from "./permissions";
import type { PermissionRequestItem } from "./questionsAgent";
import { sansDemandesDuTour } from "./demandesEnAttente";
import {
  claudePermission,
  claudePush,
  claudeStart,
  neutralPermission,
  neutralStart,
  parseClaudeDone,
  parseNeutralDone,
  type ChatAttachment,
  type ChatMessage,
  type PermissionMode,
  type RequestMeta,
} from "./sidecar";
import { notifyUsageChanged } from "./usageBus";
import { avecConsigneTachesDeFond } from "./consigneTachesDeFond";
import { promptAvecRecapitulatif } from "./sessionPerdue";

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
  /** Effort choisi (`""` = Défaut, rien envoyé) — ignoré si le modèle du tour ne le supporte pas. */
  effort: EffortLevel | "";
  engineProviderId: string | null;
  /** Compte résolu de la session ; `attente` : liste des comptes inconnue, `resoudre` l'attend (docs/spec-deux-comptes.md). */
  compteClaude: { courant: "perso" | "teams"; attente: boolean; resoudre: () => Promise<"perso" | "teams"> };
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
  injectorsRef: { readonly current: Map<string, (text: string, attachments?: SentAttachment[]) => void> };
  /**
   * T-087/T-064 — copie locale (RUNTIME, jamais persistée) des pièces d'un
   * push encore sans nouvelle du tour, par conversation. Sert à les
   * restaurer dans le tiroir si `push_perdu` prouve que ce push n'a jamais
   * été vu par le modèle ; jetée dès que le tour se clôt (voir `finally`).
   */
  pushesEnCoursRef: { readonly current: Map<string, PushEnCoursDeTour<DraftAttachment>[]> };
  /**
   * T-183 — pièces d'un push PERDU, par conversation, rangées en attendant le
   * renvoi automatique de fin de tour (le texte, lui, est dans `queuedPrompts`).
   * Consommées par `handleSend` (chemin file) ; reposées dans le tiroir si le
   * message est retiré de la file avant de partir (voir AgentPage).
   */
  piecesARenvoyerRef: { readonly current: Map<string, PushEnCoursDeTour<DraftAttachment>[]> };
  setPermissionQueue: (updater: (prev: PermissionRequestItem[]) => PermissionRequestItem[]) => void;
  /* ── signaux vers le reste de la page ── */
  /** T-207 — l'agent a changé de modèle/d'effort : les sélecteurs de la conversation `convId` prennent ces valeurs (même état qu'un choix manuel, donc persisté de même). */
  appliquerChoixModele: (convId: string, choix: ChoixModele) => void;
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
  /** T-197 — fin d'un tour Claude réussi : la page décide s'il faut titrer la discussion (jamais bloquant, jamais d'erreur à l'écran). */
  titrerSession: (projectId: string, convId: string, compte: CompteClaude) => Promise<void>;
}

export function creerEnvoiProjet(deps: DepsEnvoiProjet): {
  handleSend: (overrideContent?: string) => Promise<void>;
  reposerPiecesOrphelines: (convId: string, contenus: string[] | null, motif: string) => void;
} {
  const {
    activeSessionId,
    cwd,
    selectedProjectId,
    selectedProjectIdRef,
    streaming,
    sessionId,
    turns,
    model,
    effort,
    engineProviderId,
    compteClaude,
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
    pushesEnCoursRef,
    piecesARenvoyerRef,
    setPermissionQueue,
    appliquerChoixModele,
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
    titrerSession,
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
    convId: string,
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
      { targetId, permissionId, toolName, toolInput, engine, projectId: selectedProjectId, convId },
    ]);
  }

  /**
   * T-087 — un push glissé dans le tour (claude.push) n'a jamais été vu par
   * le modèle : la bulle qui affirmait « message parti » cesse de mentir
   * (`withPushPerdu`), et `contenu` est reposé en file — le chemin d'auto-envoi
   * de fin de tour existe déjà et le renverra tout seul. T-064 — s'il portait
   * des pièces jointes, la copie locale gardée par `pushesEnCoursRef` est
   * rangée dans `piecesARenvoyerRef` (T-183) : le renvoi de fin de tour les
   * joint au message, au lieu de les laisser dans le tiroir — le message
   * repartait sans elles. Introuvable (état déjà purgé), un avis EXPLICITE le
   * dit plutôt que de les perdre en silence.
   */
  function gererPushPerdu(convId: string, contenu: string, avaitPieces: boolean) {
    updateTurnsFor(convId, (prev) => withPushPerdu(prev, contenu));
    updateRuntime(convId, (r) => ({ ...r, queuedPrompts: [...r.queuedPrompts, contenu] }));
    const avis = rangerPushPerdu(pushesEnCoursRef.current, piecesARenvoyerRef.current, convId, contenu, avaitPieces);
    if (avis) setAttachmentsError(avis);
  }

  /**
   * T-183 — des messages quittent la file sans partir (pastille retirée, file
   * vidée par « Arrêter ») : les pièces rangées pour eux (push perdu)
   * retournent dans le tiroir, avec un avis — jamais perdues en silence.
   * `contenus` null = tout ce qui est rangé pour la conversation.
   */
  function reposerPiecesOrphelines(convId: string, contenus: string[] | null, motif: string) {
    const r = retirerPiecesOrphelines(piecesARenvoyerRef.current, convId, contenus, motif);
    if (!r) return;
    restoreAttachments(r.pieces);
    setAttachmentsError(r.avis);
  }

  /** R5 — instructions système du tour : agent sélectionné + ligne RAG si l'index existe (voir `instructionsSysteme`). */
  function composeSystemInstructions(): string | undefined {
    return instructionsSysteme(selectedAgent?.instructions, knowledgeMode === "rag" && indexConnaissancesPret);
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
    compte: "perso" | "teams",
  ) {
    const handle = claudeStart(
      {
        cwd,
        prompt: content,
        // Session serveur de CETTE conversation (le `sessionId` dérivé de
        // l'active serait le mauvais si l'utilisateur a changé d'onglet).
        sessionId: getRuntime(convId).sessionId,
        model: modelId,
        effort: effort && effortsPour(modelId).includes(effort) ? effort : null,
        permissionMode,
        // Page ouverte devant l'utilisateur : l'agent peut poser ses questions
        // dans une modale à choix cliquables (outil mcp__studio__ask_user).
        interactive: true,
        // T-207 — modèle fixé par l'agent préréglé (sélecteur grisé) : l'agent
        // ne reçoit pas l'outil `changer_modele`, pas de faux espoir.
        modeleVerrouille: selectedAgent !== null && selectedAgent.model !== null,
        // R5 — instructions de l'agent + ligne RAG éventuelle (mode `rag`).
        systemPrompt: avecConsigneTachesDeFond(composeSystemInstructions()),
        // T-003 — allowlist `tools:` de l'agent (voir sendViaNeutralEngine).
        tools: selectedAgent?.tools ?? null,
        attachments,
        meta,
        compte,
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
        // T-102 — le seul signe de vie d'un sous-agent, qui peut occuper le
        // tour des dizaines de minutes sans rien écrire dans le fil.
        onSousAgentBattement: (toolUseId, outils, dernierOutil, instant) =>
          updateTurnsFor(convId, (prev) =>
            withSousAgentBattement(prev, toolUseId, outils, dernierOutil, instant),
          ),
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
        onBackgroundTimeout: (count, plafondMs) =>
          updateTurnsFor(convId, (prev) =>
            prev.map((t) => (t.id === target.id ? { ...t, backgroundTimeout: { count, plafondMs } } : t)),
          ),
        onMcpEcartes: (serveurs, coffreVerrouille) =>
          updateTurnsFor(convId, (prev) => prev.map((t) => (t.id === target.id ? { ...t, mcpEcartes: { serveurs, coffreVerrouille } } : t))),
        onCompact: (trigger, preTokens) =>
          updateTurnsFor(convId, (prev) =>
            prev.map((t) => (t.id === target.id ? { ...t, compacted: { trigger, preTokens } } : t)),
          ),
        onPermissionRequest: (permissionId, toolName, toolInput) =>
          gererDemandePermission("claude", handle.id, convId, permissionId, toolName, toolInput),
        onPushPerdu: (contenu, avaitPieces) => gererPushPerdu(convId, contenu, avaitPieces),
        // T-207 — bandeau « L'agent est passé à … » sur la bulle qui reçoit le flux, et sélecteurs alignés.
        onModelChange: (chunk) => {
          const changement = changementDepuisChunk(chunk, modelId);
          if (!changement) return;
          updateTurnsFor(convId, (prev) => withChangementModele(prev, target.id, changement));
          appliquerChoixModele(convId, choixApresChangement(changement));
        },
        // T-216 — comme le bouton « Compacter » pendant un tour : « /compact » en file (une fois), avis sur la bulle.
        onCompactionDemandee: (raison) => updateRuntime(convId, (r) => avecCompactionDemandee(r, target.id, raison)),
        onReveilDemande: (demande) => traiterReveilDemande(demande, convId, compte, updateRuntime), // T-219 — l'agent arme le réveil ⏰
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
    convId: string,
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
          gererDemandePermission("neutral", handle.id, convId, permissionId, toolName, toolInput),
      },
    );
    return handle;
  }

  // T-080 — plus de bandeau de débord ici (les Projets ne routent plus) ; il reste côté Chat (`debordNotice.ts`).

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
      // Image collée encore en cours d'encodage : comme l'envoi normal, on
      // attend (sinon elle partirait avec des données vides). Brouillon conservé.
      if (attachmentsPending) {
        setAttachmentsError("Image en cours de chargement… réessayez dans un instant.");
        return;
      }
      fermerMenuSlash();
      const runtime = getRuntime(convId);
      const inject = injectorsRef.current.get(convId);
      if (inject && runtime.activeEngine === "claude" && runtime.activeRequestId) {
        // Le brouillon part tout de suite : si le sidecar refuse (tour déjà
        // clos), il est reposé en file juste en dessous — jamais perdu.
        updateRuntime(convId, (r) => ({ ...r, draft: "" }));
        // T-064 — un push glissé dans un tour Claude EN COURS porte désormais
        // ses pièces jointes (même contrat que claude.start) : elles partent
        // MAINTENANT, comme pour un envoi normal.
        const pushDrafts = attachments;
        const pushAttachments = toContractAttachments(pushDrafts);
        if (pushDrafts.length > 0) clearAttachments();
        const pushed = await claudePush(runtime.activeRequestId, pending, pushAttachments).catch(() => false);
        if (pushed) {
          // T-087 — copie locale gardée pour restaurer les pièces si ce push
          // est un jour signalé perdu (chunk `push_perdu`, voir onPushPerdu).
          const file = pushesEnCoursRef.current.get(convId) ?? [];
          pushesEnCoursRef.current.set(convId, [...file, { contenu: pending, attachments: pushDrafts }]);
          inject(pending, toSentAttachments(pushDrafts));
          return;
        }
        // Course avec la fin du tour : le sidecar a refusé le dépôt. Le texte
        // est mis en file ; ses pièces sont rangées pour repartir AVEC lui au
        // renvoi de fin de tour (T-183), pas laissées dans le tiroir.
        if (pushDrafts.length > 0) {
          piecesARenvoyerRef.current.set(
            convId,
            rangerPiecesARenvoyer(piecesARenvoyerRef.current.get(convId) ?? [], pending, pushDrafts),
          );
          setAttachmentsError(
            "Le tour s'est terminé avant l'envoi : le message part automatiquement avec ses pièces jointes.",
          );
        }
        updateRuntime(convId, (r) => ({ ...r, queuedPrompts: [...r.queuedPrompts, pending] }));
        return;
      }
      // Moteur neutre, ou pas de tour Claude en cours à glisser dedans : ni la
      // file ni une demande glissée ne s'appliquent ici, texte seul.
      if (attachments.length > 0) {
        setAttachmentsError(
          "Pièces jointes conservées : elles ne partent pas avec un message envoyé pendant un tour — elles seront jointes à votre prochain message complet.",
        );
      }
      updateRuntime(convId, (r) => ({ ...r, queuedPrompts: [...r.queuedPrompts, pending], draft: "" }));
      return;
    }

    // Chemin « file » (overrideContent) : le tiroir du composeur n'est jamais
    // lu ni vidé ; seules les pièces d'un push perdu (T-183) repartent, rangées
    // dans `piecesARenvoyerRef`.
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
    // Liste des comptes inconnue + défaut « teams » : on attend, jamais de départ sur perso par défaut.
    let compteTour = compteClaude.courant;
    if (engineSelected === "claude" && compteClaude.attente) {
      try { compteTour = await compteClaude.resoudre(); } catch (err) { setAttachmentsError(err instanceof Error ? err.message : String(err)); return; }
      if (getRuntime(convId).streaming) return; // un autre envoi est parti pendant l'attente
    }
    // R2 — tour « Auto (routeur) » : le moteur/modèle réels ne sont connus
    // qu'après résolution de la cible, juste en dessous.
    // Pièces jointes : non supportées par `neutral.start` (voir le contrat).
    // Capturées avant
    // tout envoi : le brouillon n'est purgé qu'en cas de succès (voir le
    // `try`/`catch` plus bas).
    // T-183 — chemin file : les pièces du push perdu rangées pour CE message
    // remplacent celles du composeur. Retirées de la ref dès maintenant.
    let piecesRenvoyees: DraftAttachment[] = [];
    if (!usesComposer) {
      const { trouve, reste } = retirerPushCorrespondant(piecesARenvoyerRef.current.get(convId) ?? [], rawContent);
      piecesARenvoyerRef.current.set(convId, reste);
      piecesRenvoyees = trouve?.attachments ?? [];
      // Moteur neutre : pas de pièces possibles (voir le contrat). Elles
      // retournent dans le tiroir avec un avis explicite plutôt que d'être perdues.
      if (piecesRenvoyees.length > 0 && engineSelected !== "claude") {
        restoreAttachments(piecesRenvoyees);
        setAttachmentsError(
          "Pièces jointes conservées dans le composeur : le moteur actuel ne les accepte pas, le message est parti sans elles.",
        );
        piecesRenvoyees = [];
      }
    }
    const attachmentsAllowed = engineSelected === "claude";
    const piecesDuTour = usesComposer ? attachments : piecesRenvoyees;
    const contractAttachments = attachmentsAllowed ? toContractAttachments(piecesDuTour) : [];
    const sentAttachments = attachmentsAllowed ? toSentAttachments(piecesDuTour) : [];
    // Brouillons d'origine, gardés pour les reposer si le tour échoue (voir le
    // `catch`) : le tiroir, lui, est vidé dès l'envoi (chemin composeur seulement).
    const sentDrafts = attachmentsAllowed ? piecesDuTour : [];

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

    const engine = engineSelected;
    const turnProviderId: string | null = engineProviderId;
    const turnModel = model;
    // Bandeau de débord hérité d'une session d'avant T-080 : effacé au premier
    // tour — plus rien ne le repose, le laisser afficherait un état périmé.
    updateRuntime(convId, (r) => (r.debordNotice ? { ...r, debordNotice: null } : r));

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
      // Chemin file : les pièces rangées n'ont pas quitté le tiroir, elles y reviennent.
      restoreAttachments(piecesRenvoyees);
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
    if (usesComposer && sentDrafts.length > 0) clearAttachments();
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
      },
    ]);
    collerEnBas();

    const common = {
      onText: (delta: string) => {
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

    const { id: idInitial, done } =
      engine === "neutral"
        ? sendViaNeutralEngine(turnProviderId as string, historyMessages, common, turnModel, meta, convId)
        : sendViaClaudeEngine(sentContent, streamTarget, common, contractAttachments, convId, turnModel || null, meta, compteTour);
    // `let` : une relance sur nouvelle session (T-187) change l'id du tour, et
    // le `finally` doit purger les permissions de CELUI-LÀ aussi.
    let id = idInitial;
    updateRuntime(convId, (r) => ({ ...r, activeRequestId: id }));

    // S3 — injecteur de CE tour : appelé par le composeur quand le sidecar a
    // accepté la demande (claude.push). Il ouvre la bulle utilisateur puis une
    // nouvelle bulle assistant, et redirige le flux vers elle — la suite de la
    // réponse s'affiche donc APRÈS la demande, comme dans Claude Code.
    if (engine === "claude") {
      injectorsRef.current.set(convId, (text: string, injectedAttachments?: SentAttachment[]) => {
        const nextAssistantId = nextId("a");
        // Bulle close, message, bulle neuve ; les tâches de fond suivent (T-222).
        updateTurnsFor(convId, (prev) =>
          avecMessageInjecte(prev, streamTarget.id, { utilisateur: nextId("u"), assistant: nextAssistantId }, text, injectedAttachments),
        );
        streamTarget.id = nextAssistantId;
        collerEnBas();
      });
    }

    let tourClaudeReussi = false;
    try {
      const data = await done;
      let parsed = engine === "neutral" ? parseNeutralDone(data) : parseClaudeDone(data);
      // T-187 — la session à reprendre n'existe plus (transcript purgé) : on
      // l'oublie AVANT la relance (le `sessionId` de `parsed` est l'ancien, il
      // n'est jamais réécrit), puis UNE seule relance sur une nouvelle session
      // dont le prompt porte un récapitulatif des tours gardés par l'application.
      if ("sessionPerdue" in parsed && parsed.sessionPerdue) {
        updateRuntime(convId, (r) => ({ ...r, sessionId: null }));
        const tousLesTours = getRuntime(convId).turns;
        const rang = tousLesTours.findIndex((t) => t.id === userTurn.id);
        const recap = (rang >= 0 ? tousLesTours.slice(0, rang) : [])
          .map((t) => ({
            role: t.role,
            texte: t.role === "user" ? (t.displayContent ?? t.content ?? "") : spokenTextOfTurn(t),
          }));
        const relance = sendViaClaudeEngine(
          promptAvecRecapitulatif(recap, sentContent),
          streamTarget,
          common,
          contractAttachments,
          convId,
          turnModel || null,
          meta,
          compteTour,
        );
        id = relance.id;
        updateRuntime(convId, (r) => ({ ...r, activeRequestId: id }));
        const cibleId = streamTarget.id;
        updateTurnsFor(convId, (prev) => prev.map((t) => (t.id === cibleId ? { ...t, sessionReprise: true } : t)));
        parsed = parseClaudeDone(await relance.done);
      }
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
      tourClaudeReussi = engine === "claude" && "subtype" in parsed && parsed.subtype === "success";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateTurnsFor(convId, (prev) => withTurnError(prev, streamTarget.id, message));
      // Tour échoué : les pièces jointes reviennent dans le composeur (elles
      // avaient été retirées à l'envoi) — pas question de les rejoindre à la
      // main pour réessayer.
      restoreAttachments(sentDrafts);
    } finally {
      injectorsRef.current.delete(convId);
      // T-087 — ce qui reste ici a été acquitté (sinon `push_perdu` l'aurait
      // déjà retiré via gererPushPerdu) : rien à garder au-delà du tour.
      pushesEnCoursRef.current.delete(convId);
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
      setPermissionQueue((prev) => sansDemandesDuTour(prev, id));
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
      // T-197 — après la sauvegarde, sans l'attendre : le titre arrive quand il arrive.
      if (tourClaudeReussi && selectedProjectId) void titrerSession(selectedProjectId, convId, compteTour).catch(() => {});
    }
  }

  return { handleSend, reposerPiecesOrphelines };
}
