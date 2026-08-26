/*
 * Page « Projets » : conversation agentique Claude (Agent SDK) dans le
 * répertoire d'un projet déclaré (registre géré dans la page
 * Configuration, voir projectAdmin.ts/useProjects.ts), avec validation des
 * actions (Edit/Write/Bash…) avant application. Réutilise les patterns de
 * streaming/style de ChatPage.tsx (bulles néon, curseur clignotant,
 * auto-scroll) et les tokens de theme.css.
 *
 * Modèle de données : un tour utilisateur est un simple message ; un tour
 * assistant est une séquence ordonnée de blocs (texte / raisonnement / appel
 * d'outil), car le SDK peut entrelacer texte, réflexion et outils au sein
 * d'un même tour — l'ordre d'arrivée des chunks doit être préservé à
 * l'affichage.
 *
 * État par projet : la conversation (turns), le sessionId SDK, les fichiers
 * ouverts/onglets — tout est gardé dans une Map en mémoire (project id →
 * état). Changer de projet bascule vers son état mémorisé (ou un état
 * vierge) ; interdit pendant un run en cours (sélecteur désactivé).
 * L'arborescence (FileTree) suit simplement `cwd`, dérivé du projet
 * sélectionné — pas besoin de la garder dans la Map, FileTree se recharge
 * déjà tout seul sur `rootPath`.
 *
 * Persistance (Lot 3) : la Map ci-dessus est mise en miroir sur disque, clé
 * `project-conversations` (voir stateClient.ts), au format
 * `{[projectId]: {turns, sessionId, openFilePaths, activeTab, updatedAt}}` —
 * seuls les CHEMINS des fichiers ouverts sont persistés, jamais leur
 * contenu ; à la restauration ils sont rechargés paresseusement (au moment
 * où leur onglet devient actif, pas tous d'un coup — voir
 * `pendingLazyLoadsRef`/`triggerLazyLoad`). Chargement au montage une seule
 * fois (StrictMode-safe, même famille de pattern que useProviders/
 * useProjects) ; sauvegarde débouncée (~1,5 s) après chaque changement
 * pertinent, plus une sauvegarde immédiate en fin de tour. Bornes : 200
 * derniers tours par projet ; un tour encore `streaming` n'est jamais
 * sérialisé tel quel (filtré par `buildPersistedEntry`) ; l'entrée d'un
 * projet supprimé du registre est nettoyée au chargement.
 *
 * Sélection externe (palette Ctrl+Maj+P, voir CommandPalette.tsx/App.tsx) :
 * cette page garde la pleine propriété de `selectedProjectId` (pas de
 * lifting dans App — voir le commentaire d'architecture en tête de
 * CommandPalette.tsx) et expose seulement `requestSelectProject` via un
 * `ref` impératif (`AgentPageHandle`).
 *
 * Panneau latéral « zen » : toute la configuration (projet/LLM/fichiers/
 * connaissances/MCP) vit dans un panneau gauche à sections dépliantes (voir
 * SidebarSection.tsx), la zone principale ne gardant que les onglets
 * Conversation/fichiers. Deux fonctionnalités v1 y vivent :
 *  - Connaissances : documents épinglés par projet (persistés comme la
 *    conversation, clé `project-knowledge`), REJOINTS par les fichiers du
 *    dossier `.iaction/connaissances/` du projet (« Automatiques », listés à
 *    chaque changement de projet, best effort — dossier absent = liste vide)
 *    — les deux origines sont injectées en préambule du texte réellement
 *    ENVOYÉ au premier tour d'une session seulement (dédoublonnées par
 *    chemin, voir `injectedKnowledge`/`dedupDocsByPath`) — le texte AFFICHÉ
 *    dans la transcription reste le texte original de l'utilisateur (voir
 *    `AgentTurn.displayContent` vs `content`, et `buildKnowledgeBlock`). Un
 *    troisième groupe « Détectées » (CLAUDE.md, `.claude/memory/*.md`) est
 *    purement informatif dans le panneau — jamais injecté d'office.
 *  - MCP : lecture seule de `.mcp.json` à la racine du projet, plus un
 *    compteur d'appels par serveur déduit des chunks `tool_use` dont le nom
 *    commence par `mcp__` (remis à zéro à la nouvelle session).
 *
 * Sélecteur d'agent (étude docs/etude-orchestration.md, phase O2) : dans la
 * section « LLM », choisir un agent déclaré (`agents.list`, voir
 * orchestrationClient.ts) préconfigure moteur/modèle/mode de permission et
 * arme ses instructions (systemPrompt Claude, ou message `system` en tête
 * côté moteur neutre) + `maxTurns` pour les tours suivants — champs
 * appliqués verrouillés tant que l'agent reste sélectionné. La sélection
 * (nom+portée seulement, pas la configuration recopiée) est PAR SESSION,
 * persistée comme `engine` (voir `ProjectSession.selectedAgent`) ; elle se
 * résout dynamiquement contre la liste vivante d'agents (`projectAgents`) —
 * un agent introuvable (supprimé, ou liste pas encore chargée) retombe sur
 * « Aucun (manuel) » silencieusement, jamais une erreur bloquante. Portée
 * knowledge/tools/mcp de l'agent : hors périmètre O2, non exploitée ici.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { openExternal, readApps, type AppEntry } from "./appsAdmin";
import { ouvrirReference } from "./refFichier";
import {
  AttachmentPickerButton,
  AttachmentTray,
  clipboardHasImage,
  filesFromClipboard,
  filesFromDrop,
  useAttachmentDraft,
} from "./Attachments";
import { FileEditorView, type OpenFileState } from "./FileEditor";
import { FileTree } from "./FileTree";
import { readClipboardImage } from "./clipboardClient";
import { fsFindByName, fsListDir, fsReadFile, fsWriteFile, type DirEntry } from "./fsClient";
import { McpPanel } from "./McpPanel";
import { useFavorisModeles } from "./useFavorisModeles";
import { agentsList, type AgentInfo, type AgentScope } from "./orchestrationClient";
import {
  type ProjectConfig,
} from "./projectAdmin";
import type { ProviderConfig } from "./providerAdmin";
import {
  claudeAbort,
  claudeRelease,
  claudeCommands,
  claudeSessionTitles,
  claudePermission,
  modelsDetail,
  neutralAbort,
  neutralPermission,
  projectEnsureDoc,
  type ModelDetail,
  type PermissionMode,
  type RouteTarget,
  type RouteTier,
  type SlashCommandInfo,
} from "./sidecar";
import { sortByRecent } from "./sessionStore";
import { SidebarRetractable, SidebarSection } from "./SidebarSection";
import { useComposerLiveDraft } from "./useComposerLiveDraft";
import { useComposerUndo } from "./useComposerUndo";
import { useRovingFocus } from "./useRovingFocus";
import { useStickToBottom } from "./useStickToBottom";
import { asRecord } from "./base";
import {
  contextTokens,
  spokenTextOfTurn,
  type AgentTurn,
} from "./agentTurns";

import { VoiceButtons, VoiceStatus } from "./VoiceControls";
import {
  DEFAULT_CONVERSATION_SETTINGS,
  useVoiceComposer,
  type ConversationSettings,
} from "./useVoiceComposer";
import { stateRead, stateWrite } from "./stateClient";
import { subscribeProvidersPushed } from "./providersBus";
import { publishContext, registerCompactHandler } from "./contextBus";
import type { ProjectsLoadState } from "./useProjects";
import { useConversationRuntime } from "./useConversationRuntime";
import { prochainOnglet } from "./onglets";
import { PermissionModal } from "./PermissionModal";
import { cleAutoAllow } from "./permissions";
import { type PermissionRequestItem } from "./questionsAgent";
import {
  AUTO_MODEL,
  buildPersistedEntry,
  CONVERSATIONS_STATE_KEY,
  convIdOfTab,
  convTabId,
  deriveSessionTitle,
  EMPTY_TAB,
  emptyProjectState,
  freshRuntime,
  freshSession,
  isConvTab,
  LAST_PROJECT_STATE_KEY,
  resolveAgentSelection,
  SAVE_DEBOUNCE_MS,
  sanitizePersistedConversations,
  sessionStateFromPersisted,
  type AgentSelection,
  type ConvRuntime,
  type PersistedConversations,
  type PersistedProjectEntry,
  type ProjectSession,
  type ProjectState,
} from "./modeleProjet";
import { dedupDocsByPath, type PinnedDoc } from "./connaissances";
import { libelleDebordNotice } from "./debordNotice";
import { AgentTurnView } from "./agentTranscript";
import { ConnaissancesSection, LlmSection, SessionsSection } from "./agentSidebarDroit";
import { creerEnvoiProjet } from "./envoiProjet";
import { useConnaissances } from "./useConnaissances";

const MAX_OPEN_FILES = 6;

/* ---------- En-tête de page ---------- */

/*
 * R2/R7 — « Auto (routeur) » : valeur sentinelle du sélecteur de modèle,
 * OPT-IN (jamais défaut, contrairement au Chat). CHAQUE tour est classé par
 * le routeur du sidecar (router.route, avec le `cwd` du projet — la
 * surcharge `.iaction/routage.yaml` s'applique), sous un PLANCHER de session
 * (`routedTier`) qui ne descend jamais — le modèle ne change qu'à la hausse
 * (voir resolveAutoRoute) — un modèle explicite choisi = comportement
 * strictement inchangé.
 */

/* ---------- État par projet (Lot Sessions : plusieurs sessions/projet) ---------- */

function openFilesFromPaths(paths: string[], pendingLazy: Set<string>): OpenFileState[] {
  return paths.map((path) => {
    pendingLazy.add(path);
    const name = path.slice(path.lastIndexOf("/") + 1) || path;
    return {
      path,
      name,
      kind: "loading",
      content: "",
      base64: "",
      size: 0,
      truncated: false,
      dirty: false,
      saving: false,
      saveError: null,
      errorMessage: null,
    };
  });
}

function projectStateFromPersisted(entry: PersistedProjectEntry, pendingLazy: Set<string>): ProjectState {
  const sessions = entry.sessions.map(sessionStateFromPersisted);
  if (sessions.length === 0) return emptyProjectState();
  const activeId = sessions.some((s) => s.id === entry.activeId) ? entry.activeId : sessions[0].id;
  const openFiles = openFilesFromPaths(entry.openFilePaths, pendingLazy);
  const knownConvIds = entry.openConversationIds.filter((id) => sessions.some((s) => s.id === id));
  const openConversationIds = knownConvIds.length > 0 ? knownConvIds : [activeId];
  const activeTab =
    entry.activeTab === EMPTY_TAB ||
    entry.openFilePaths.includes(entry.activeTab) ||
    (isConvTab(entry.activeTab) && openConversationIds.includes(convIdOfTab(entry.activeTab)))
      ? entry.activeTab
      : convTabId(activeId);
  return { sessions, activeId, openConversationIds, openFiles, activeTab };
}

/* ---------- Menu contextuel de l'arbre : renommer/supprimer (voir FileTree.tsx) ---------- */

/** `path` égal à `target`, ou situé dedans (`target` renommé/supprimé était un DOSSIER). */
function isUnderPath(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}/`);
}

/** Réécrit `path` si renommé — inchangé s'il ne correspond ni à `oldPath` ni à un de ses descendants. */
function renamedPath(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
  return path;
}

/* ---------- Page ---------- */

interface AgentPageProps {
  projects: ProjectConfig[];
  projectsLoadState: ProjectsLoadState;
  /** Fournisseurs neutres configurés (Ollama/OpenRouter/custom) — voir le sélecteur « Moteur ». */
  providers: ProviderConfig[];
  onGoToConfig: () => void;
  /** Micro choisi dans Configuration › Dictée (vide = défaut système). */
  micDeviceId?: string;
  /** Réglages « Mode conversation » de la config voix (défauts si absents). */
  conversationConfig?: ConversationSettings;
  /**
   * Cette page est-elle celle affichée ? Les six pages restent montées en
   * permanence (voir App.tsx) : la voix a besoin de savoir qu'on l'a quittée
   * pour refermer le micro (voir useVoiceComposer.ts).
   */
  pageVisible?: boolean;
}

export interface AgentPageHandle {
  /**
   * Sélection demandée depuis l'extérieur (palette Ctrl+Maj+P). Renvoie `false`
   * si refusée — un run est en cours, ou `id` ne correspond à aucun projet
   * connu — auquel cas l'appelant affiche un message discret et ne change
   * pas d'onglet.
   */
  requestSelectProject: (id: string) => boolean;
  /** Chemin du projet sélectionné (menu Terminal de l'en-tête) — null si aucun. */
  getSelectedProjectPath: () => string | null;
  /**
   * Raccourci global Ctrl+N (voir App.tsx) : nouvelle session du projet
   * courant. Renvoie `false` si refusée (run en cours) — l'appelant reste
   * alors silencieux, comme le bouton correspondant.
   */
  newSession: () => boolean;
  /**
   * Raccourci global Ctrl+K (voir App.tsx) : vide les tours de la session
   * ACTIVE sans en créer de nouvelle. Renvoie `false` si refusée (run en
   * cours) — la confirmation destructive est à la charge de l'appelant.
   */
  clearConversation: () => boolean;
  /**
   * Un tour est-il en cours ? Consultée par App.tsx AVANT d'afficher la
   * confirmation de Ctrl+K — un run en cours doit rester un no-op
   * totalement silencieux (aucune modale), pas juste un clic sans effet.
   */
  isStreaming: () => boolean;
  /** Place le curseur dans le composeur (arrivée sur la page, vidage, nouvelle conversation). */
  focusComposer: () => void;
}

export const AgentPage = forwardRef<AgentPageHandle, AgentPageProps>(function AgentPage(
  {
    projects,
    projectsLoadState,
    providers,
    onGoToConfig,
    micDeviceId = "",
    conversationConfig = DEFAULT_CONVERSATION_SETTINGS,
    pageVisible = true,
  }: Readonly<AgentPageProps>,
  ref,
) {
  const [selectedProjectId, setSelectedProjectIdState] = useState<string | null>(null);
  /*
   * Miroir SYNCHRONE (même patron que `sessionsRef`) : la fin d'un tour
   * d'ARRIÈRE-PLAN lit ce ref pour savoir si le projet affiché est encore
   * celui qui a lancé le tour. Sans lui, la sauvegarde de fin de tour
   * combinait le `selectedProjectId` capturé à l'envoi (ancien projet) avec
   * les sessions lues par refs (nouveau projet) — et écrivait les sessions du
   * nouveau projet sous la clé de l'ancien. Voir la garde de `handleSend`.
   */
  const selectedProjectIdRef = useRef<string | null>(null);
  function setSelectedProjectId(next: string | null) {
    selectedProjectIdRef.current = next;
    setSelectedProjectIdState(next);
  }
  // Sauvegarde de la dernière conversation vidée (Ctrl+K) + bandeau d'annulation.
  // `convId` identifie LA conversation vidée : « Annuler » restaure dans
  // celle-là précisément — jamais dans la conversation active du moment, qui a
  // pu changer entre-temps (bug historique : vider, créer une session neuve,
  // cliquer Annuler ⇒ les anciens tours réapparaissaient dans la neuve).
  const clearedBackupRef = useRef<{
    convId: string;
    turns: AgentTurn[];
    sessionId: string | null;
    /** R2 — affinité de session du mode Auto, restaurée avec les tours. */
    routedTier: RouteTier | null;
    routedTarget: RouteTarget | null;
  } | null>(null);
  const [clearedNotice, setClearedNotice] = useState(false);
  /**
   * S3 — injecteurs des tours Claude en cours, par conversation : posés par
   * `handleSend` au démarrage du tour, retirés à sa fin. Leur présence EST le
   * signal qu'une demande peut être glissée dans le tour (voir claude.push).
   */
  const injectorsRef = useRef<Map<string, (text: string) => void>>(new Map());
  // Dernier projet ouvert, relu du disque au démarrage. `lastProjectLoaded`
  // sert de garde : tant que la lecture n'a pas abouti, on ne sélectionne rien.
  const lastProjectIdRef = useRef<string | null>(null);
  const [lastProjectLoaded, setLastProjectLoaded] = useState(false);

  useEffect(() => {
    stateRead<unknown>(LAST_PROJECT_STATE_KEY)
      .then((raw) => {
        const value = asRecord(raw).projectId;
        if (typeof value === "string" && value) lastProjectIdRef.current = value;
      })
      .catch(() => {
        // best effort : sans mémoire, on ouvrira le premier projet déclaré
      })
      .finally(() => setLastProjectLoaded(true));
  }, []);

  /** Mémorise le projet ouvert pour le prochain démarrage (best effort). */
  function rememberLastProject(id: string) {
    lastProjectIdRef.current = id;
    void stateWrite(LAST_PROJECT_STATE_KEY, { projectId: id }).catch(() => {});
  }
  // État des projets non affichés à l'écran (Map en mémoire, mise en miroir
  // sur disque — voir persistedConversationsRef ci-dessous). Un `ref` suffit
  // pour la Map elle-même : lue/écrite uniquement au moment de la bascule,
  // jamais rendue directement.
  const projectStatesRef = useRef<Map<string, ProjectState>>(new Map());

  // Document complet persisté (toutes conversations, toutes clés) : source
  // de vérité pour `state_write`, qui REMPLACE le fichier (pas de fusion
  // côté Rust) — on doit donc toujours réécrire le document entier.
  const persistedConversationsRef = useRef<PersistedConversations>({});
  // Chemins de fichiers restaurés du disque mais pas encore relus
  // (contenu vide) : `triggerLazyLoad` les consomme au moment de l'activation.
  const pendingLazyLoadsRef = useRef<Set<string>>(new Set());
  const stateInitRef = useRef(false);
  const hydrationDoneRef = useRef(false);
  const [statePhase, setStatePhase] = useState<"loading" | "loaded">("loading");

  // « Autonome » par défaut (choix utilisateur 2026-07-19) : l'agent exécute
  // commandes et éditions sans validation ; repasser à « Valider chaque
  // action » via le sélecteur pour retrouver les modales de permission.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("bypassPermissions");
  // Moteur de l'agent : `null` = Claude (abonnement), sinon l'id d'un
  // fournisseur neutre (Ollama/OpenRouter/custom) — voir le sélecteur
  // « Moteur » de la toolbar. Fait partie de l'état PAR PROJET (persisté).
  const [engineProviderId, setEngineProviderId] = useState<string | null>(null);
  const [model, setModel] = useState("");

  // Agent sélectionné (sélecteur « Agent », section LLM) : `null` = manuel.
  // Fait partie de l'état PAR SESSION (persisté comme `engine`, voir
  // `ProjectSession.selectedAgent`). Ne contient QUE la référence (nom +
  // portée) — la configuration réellement appliquée est relue à chaque rendu
  // depuis `projectAgents` (voir `selectedAgent` ci-dessous), jamais recopiée
  // ici, pour ne jamais désynchroniser affichage et fichier source.
  const [selectedAgentKey, setSelectedAgentKey] = useState<AgentSelection | null>(null);

  // Modèles du fournisseur neutre actif (pattern de ChatPage.tsx) — non
  // pertinent/vide tant que `engineProviderId` est `null` (Claude).
  const [neutralModels, setNeutralModels] = useState<ModelDetail[]>([]);
  const [neutralModelsState, setNeutralModelsState] = useState<"idle" | "loading" | "error">("idle");
  const [neutralModelsError, setNeutralModelsError] = useState("");
  // Favoris du fournisseur neutre actif : groupe « Favoris » en tête du
  // sélecteur. Sans effet côté Claude (abonnement), qui n'a pas de catalogue.
  const [neutralFeaturedIds, basculerFavoriNeutre] = useFavorisModeles(engineProviderId);

  // Sessions du projet COURANT — voir le commentaire détaillé plus bas
  // (juste avant `permissionQueue`) : ces deux déclarations doivent précéder
  // le bloc runtime ci-après, qui en a besoin (`activeSessionId`).
  const [sessions, setSessionsState] = useState<ProjectSession[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string>("");
  /*
   * Miroirs SYNCHRONES de `sessions`/`activeSessionId` (même patron que
   * `openConversationIdsRef`) : `buildLiveSessions` les lit au lieu de l'état
   * fermé dans la closure. Sans cela, un callback LONG (fin de tour, qui
   * s'exécute des minutes après son `handleSend`) reconstruisait la liste
   * depuis un `sessions` PÉRIMÉ et la réécrivait — toute conversation créée
   * pendant le tour (« + », onglet rouvert depuis l'historique) disparaissait
   * de la liste, donc son ONGLET aussi (la barre ignore un id sans session),
   * et la perte était même persistée. Constaté le 2026-07-31.
   */
  const sessionsRef = useRef<ProjectSession[]>(sessions);
  const activeSessionIdRef = useRef<string>(activeSessionId);
  function setSessions(next: ProjectSession[] | ((prev: ProjectSession[]) => ProjectSession[])) {
    const value = typeof next === "function" ? next(sessionsRef.current) : next;
    sessionsRef.current = value;
    setSessionsState(value);
  }
  function setActiveSessionId(next: string) {
    activeSessionIdRef.current = next;
    setActiveSessionIdState(next);
  }

  /*
   * ---------- Runtime vif PAR CONVERSATION (Lot Onglets multiples) ----------
   *
   * `ConvRuntime` remplace les anciens `turns`/`sessionId`/`streaming`/
   * `activeRequestId`/`draft`/`queuedPrompts`/`mcpUsage` mono-valués : chaque
   * conversation OUVERTE (voir `openConversationIds` plus bas) a désormais
   * son propre runtime, qui continue d'évoluer même quand son onglet n'est
   * pas affiché — c'est ce qui permet à un tour de streamer en arrière-plan.
   *
   * Stocké dans une Map en `ref` (pas en `useState`) : les callbacks de
   * streaming (`onText`, `onToolUse`… dans `sendViaClaudeEngine`/
   * `sendViaNeutralEngine`) CAPTURENT l'id de la conversation par fermeture,
   * exactement comme elles capturent déjà `assistantId` — elles écrivent donc
   * toujours dans la bonne conversation via `updateRuntime(convId, …)`, quel
   * que soit l'onglet affiché au moment où le chunk arrive. `runtimeTick` est
   * le seul bout d'état React de ce mécanisme : il force un nouveau rendu à
   * chaque mutation (n'importe quelle conversation), pour que le point « ● »
   * d'un onglet en arrière-plan et le contenu affiché de la conversation
   * active restent à jour — la DONNÉE elle-même vit dans le dépôt de runtimes,
   * lu à chaque rendu (`getRuntime`), jamais dans un `useState` séparé (qui
   * imposerait de recréer la Map entière à chaque delta de streaming).
   */
  const { depot: runtimes, tick: runtimeTick } = useConversationRuntime<ConvRuntime>(freshRuntime);

  /** Runtime vif d'une conversation — créé vierge à la volée si absent (première fois qu'on le lit). */
  function getRuntime(convId: string): ConvRuntime {
    return runtimes.lire(convId);
  }

  /**
   * Amorce le runtime d'une conversation depuis sa dernière copie connue
   * (`ProjectSession.turns`/`sessionId`) SI elle n'a encore jamais été
   * ouverte cette exécution — ne touche jamais un runtime déjà vivant (une
   * conversation en cours de streaming ne doit jamais être réinitialisée par
   * une réouverture de son onglet).
   */
  function ensureRuntime(
    session: Pick<ProjectSession, "id" | "turns" | "sessionId" | "routedTier" | "routedTarget">,
  ) {
    runtimes.amorcer(session.id, () =>
      freshRuntime(session.turns, session.sessionId, session.routedTier, session.routedTarget),
    );
  }

  /** Écrit dans le runtime d'UNE conversation précise et force un nouveau rendu (voir le commentaire ci-dessus). */
  function updateRuntime(convId: string, updater: (prev: ConvRuntime) => ConvRuntime) {
    runtimes.ecrire(convId, updater);
  }

  /** Variante ciblée sur les tours — remplace l'ancien `updateTurns` mono-conversation, désormais paramétré par `convId`. */
  function updateTurnsFor(convId: string, updater: (prev: AgentTurn[]) => AgentTurn[]) {
    updateRuntime(convId, (r) => ({ ...r, turns: updater(r.turns) }));
  }

  // `runtimeTick` n'est lu nulle part d'autre : cette ligne est la SEULE
  // dépendance de rendu sur ce compteur, ce qui suffit à ce que React
  // reprogramme un rendu à chaque mutation de n'importe quel runtime.
  void runtimeTick;

  // Copie VIVE de la conversation ACTIVE (celle affichée/éditée) — dérivée du
  // runtime à CHAQUE rendu, plus un `useState` séparé : `activeSessionId`
  // pilote déjà le rendu, `runtimeTick` couvre les mutations de streaming.
  const activeRuntime = activeSessionId ? getRuntime(activeSessionId) : freshRuntime();
  const turns = activeRuntime.turns;
  const sessionId = activeRuntime.sessionId;
  const streaming = activeRuntime.streaming;
  const draft = activeRuntime.draft;
  const queuedPrompts = activeRuntime.queuedPrompts;
  const mcpUsage = activeRuntime.mcpUsage;
  // R3 — bandeau de débord de la conversation ACTIVE (voir DebordNotice).
  const debordNotice = activeRuntime.debordNotice;
  /**
   * S3 — une demande peut-elle être glissée dans le tour en cours ? Moteur
   * Claude uniquement : le moteur neutre n'a pas d'entrée streamée à alimenter,
   * et le Chat en mode pur n'appelle aucun outil (aucun point d'injection).
   */
  const canInject = activeRuntime.activeEngine === "claude" && activeRuntime.activeRequestId !== null;

  /** Brouillon : toujours celui de la conversation ACTIVE — seule celle-ci a un composeur affiché. */
  function setDraft(value: string) {
    if (activeSessionId) updateRuntime(activeSessionId, (r) => ({ ...r, draft: value }));
  }
  /** Brouillon VIF de la conversation active (le runtime, jamais la valeur de rendu — voir useComposerLiveDraft.ts). */
  function getLiveDraft(): string {
    return activeSessionId ? getRuntime(activeSessionId).draft : "";
  }
  /** File d'attente de la conversation ACTIVE : retire le message à l'index donné (pastille d'annulation). */
  function removeQueuedPrompt(index: number) {
    if (activeSessionId)
      updateRuntime(activeSessionId, (r) => ({
        ...r,
        queuedPrompts: r.queuedPrompts.filter((_, i) => i !== index),
      }));
  }

  // Menu « / » du composeur (slash-commands/skills du projet) : la référence
  // du textarea sert à lire/poser la position du curseur (détection du token
  // « /frag » et repositionnement après insertion) ; `pendingCursorRef` porte
  // une position de curseur à appliquer au prochain rendu (on ne peut pas
  // appeler `setSelectionRange` avant que React ait commité la nouvelle
  // valeur du textarea, voir l'effet juste après `applySlashCommand`).
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursorRef = useRef<number | null>(null);
  const [slashMenu, setSlashMenu] = useState<{ open: boolean; fragment: string; start: number; selected: number }>({
    open: false,
    fragment: "",
    start: 0,
    selected: 0,
  });
  // Frappe fluide : écriture silencieuse dans le runtime + re-rendu de
  // rattrapage débouncé, au lieu d'un re-rendu de page par caractère. Déclaré
  // AVANT l'effet de curseur ci-dessous : la valeur doit être poussée dans le
  // DOM avant qu'on y pose `setSelectionRange`.
  const { onComposerChange, brouillonVide } = useComposerLiveDraft({
    textareaRef,
    draft,
    writeDraft: (value) => {
      if (activeSessionId) runtimes.poser(activeSessionId, { ...getRuntime(activeSessionId), draft: value });
    },
  });
  // Ctrl+Z/Ctrl+Maj+Z dans le composeur : pile d'annulation maison, le natif
  // étant cassé par les écritures programmatiques du brouillon (voir useComposerUndo.ts).
  const { handleUndoKey } = useComposerUndo(activeSessionId, getLiveDraft, setDraft);
  // Applique une position de curseur en attente APRÈS que React a commité la
  // nouvelle valeur du textarea (voir `applySlashCommand`) — poser
  // `setSelectionRange` avant le commit viserait encore l'ancienne valeur.
  useEffect(() => {
    if (pendingCursorRef.current === null) return;
    const pos = pendingCursorRef.current;
    pendingCursorRef.current = null;
    const el = textareaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  }, [draft]);
  // Filet de sécurité pour les remises à zéro du brouillon hors saisie
  // clavier (envoi, nouvelle session…) : un texte vide ne commence jamais
  // par « / », le menu doit donc se refermer même sans passer par `onChange`.
  useEffect(() => {
    if (draft === "") setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
  }, [draft]);

  // Pièces jointes du composeur (voir Attachments.tsx) : le contrat sidecar
  // (docs/protocol.md) ne les prévoit QUE pour `claude.start`, pas
  // `neutral.start` — le composeur les désactive donc tant que le moteur
  // neutre est actif pour la session (voir `attachmentsSupported`), et les
  // purge à chaque bascule de moteur/session/projet pour ne jamais en garder
  // en attente pour le mauvais moteur. Purgées DÈS L'ENVOI (voir `handleSend`)
  // — elles sont déjà parties et figurent dans le tour affiché ; les laisser
  // dans le tiroir pendant tout le tour laissait croire qu'elles n'étaient pas
  // encore envoyées. Reposées telles quelles si le tour échoue (`restore`).
  const {
    attachments,
    addFiles,
    beginImage,
    resolveImage,
    removeAttachment,
    clear: clearAttachments,
    restore: restoreAttachments,
    error: attachmentsError,
    setError: setAttachmentsError,
  } = useAttachmentDraft();
  const [composerDragOver, setComposerDragOver] = useState(false);
  // R2 — en mode « Auto (routeur) », le moteur réel n'est connu qu'après
  // routage (possiblement neutre, qui ne supporte pas les pièces jointes) :
  // l'ajout est donc désactivé aussi tant que la sentinelle Auto est choisie.
  const attachmentsSupported = engineProviderId === null && model !== AUTO_MODEL;
  // Au moins une image collée encore en cours d'encodage : l'envoi doit
  // attendre (sinon on enverrait une pièce jointe sans données).
  const attachmentsPending = attachments.some((a) => a.loading);

  // `sessions`/`activeSessionId` sont déclarés PLUS HAUT (le bloc runtime par
  // conversation en dépend). `sessions` porte la dernière copie connue des
  // champs lourds de chaque conversation ; les conversations OUVERTES en
  // onglet ont, elles, un runtime vif dans le dépôt de runtimes qui prime — voir
  // `buildLiveSessions`, qui recombine les deux à chaque sauvegarde.
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingSessionTitle, setEditingSessionTitle] = useState("");
  const sessionTitleSkipBlurRef = useRef(false);
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);

  const [permissionQueue, setPermissionQueue] = useState<PermissionRequestItem[]>([]);
  // Outils auto-autorisés (« ne plus demander ») — durée de vie : la session
  // de l'application, tous projets confondus.
  const autoAllowToolsRef = useRef<Set<string>>(new Set());

  // Onglets éditeur : "conversation" ou le chemin d'un fichier ouvert.
  const [activeTab, setActiveTab] = useState<string>(EMPTY_TAB);
  const [openFiles, setOpenFiles] = useState<OpenFileState[]>([]);
  const [openFilesNotice, setOpenFilesNotice] = useState<string | null>(null);
  /** Conversations ouvertes en onglet, dans l'ordre d'affichage de la barre. */
  const [openConversationIds, setOpenConversationIdsState] = useState<string[]>([]);
  const openConversationIdsRef = useRef(openConversationIds);
  /**
   * Écrit l'état ET la ref de façon SYNCHRONE : `persistProject` lit la ref
   * juste après l'appel (même tour de boucle), un miroir par `useEffect`
   * arriverait trop tard et persisterait la liste d'onglets d'AVANT la
   * fermeture/l'ouverture.
   */
  function setOpenConversationIds(next: string[] | ((prev: string[]) => string[])) {
    const value = typeof next === "function" ? next(openConversationIdsRef.current) : next;
    openConversationIdsRef.current = value;
    setOpenConversationIdsState(value);
  }

  // Badges de détection (.iaction/CLAUDE.md/.claude) — chemin complet si
  // présent à la racine du projet, `null` sinon. Alimentés par le
  // `fs_list_dir` racine déjà fait par FileTree (voir `handleRootEntries`),
  // pas de second appel dédié.
  const [projectBadges, setProjectBadges] = useState<{
    iactionPath: string | null;
    claudeMdPath: string | null;
    claudeDirPath: string | null;
  }>({ iactionPath: null, claudeMdPath: null, claudeDirPath: null });

  // Registre d'applications externes (Lot 5, voir appsAdmin.ts) : lu une seule fois au
  // montage — alimente le menu contextuel de FileTree (« Ouvrir avec … »). Édité depuis la
  // page Configuration ; une modification n'est reprise ici qu'au redémarrage de l'app
  // (câblage minimal demandé pour ce lot, pas de synchronisation live entre les deux pages).
  const [apps, setApps] = useState<AppEntry[]>([]);
  useEffect(() => {
    readApps()
      .then(setApps)
      .catch(() => {
        // best effort : sans registre, le menu contextuel propose seulement le repli système
      });
  }, []);

  // MCP : le panneau (McpPanel.tsx) interroge `mcp.status` lui-même — la page
  // ne garde que le compteur du badge et un jeton de rafraîchissement, bumpé
  // au chunk `init` de chaque tour (l'état constaté vient d'être réécrit).
  const [mcpServerCount, setMcpServerCount] = useState(0);
  const [mcpReloadToken, setMcpReloadToken] = useState(0);

  // Les compteurs d'appels par serveur MCP sont PAR CONVERSATION (portés par
  // `ConvRuntime.mcpUsage`, incrémentés dans le `onToolUse` de `handleSend`) :
  // deux conversations ouvertes comptent leurs appels séparément, et le
  // panneau « MCP » affiche ceux de la conversation active (`mcpUsage`).

  // Modèles du moteur neutre (même pattern que `loadModels` dans
  // ChatPage.tsx) : rechargés à chaque changement de fournisseur — y compris
  // lors d'une restauration de projet, `engineProviderId` changeant alors
  // aussi. Si le modèle courant (restauré ou choisi) n'existe pas dans la
  // liste reçue, on retombe sur le premier modèle disponible.
  /** Numéro du dernier chargement lancé — voir la garde dans `loadNeutralModels`. */
  const dernierChargementModeles = useRef(0);

  const loadNeutralModels = useCallback(async (providerId: string) => {
    setNeutralModelsState("loading");
    setNeutralModelsError("");
    // Même garde d'obsolescence que dans ChatPage : deux chargements en vol se
    // résolvent dans l'ordre de leurs réseaux, pas dans celui des clics. Sans
    // elle, une réponse lente écrase une liste plus récente et désynchronise
    // le modèle sélectionné de son fournisseur.
    const demande = ++dernierChargementModeles.current;
    const estPerimee = () => demande !== dernierChargementModeles.current;
    try {
      // T-032 — `models.detail` : même requête que `models.list`, lue en entier
      // (nom, tarifs, contexte) pour que le sélecteur montre autre chose qu'un slug.
      const list = await modelsDetail(providerId);
      if (estPerimee()) return;
      setNeutralModels(list);
      setNeutralModelsState("idle");
      // R2 — la sentinelle « Auto » est toujours un choix valide, à préserver.
      setModel((prev) => (prev === AUTO_MODEL || list.some((m) => m.id === prev) ? prev : (list[0]?.id ?? "")));
    } catch (err) {
      if (estPerimee()) return;
      setNeutralModels([]);
      setNeutralModelsState("error");
      setNeutralModelsError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (engineProviderId !== null) void loadNeutralModels(engineProviderId);
    // Relance quand la table des fournisseurs atteint (enfin) le sidecar : au
    // démarrage, ce premier chargement part souvent avant providers.set et
    // échoue en « fournisseur inconnu ».
    const off = subscribeProvidersPushed(() => {
      if (engineProviderId !== null) void loadNeutralModels(engineProviderId);
    });
    return off;
  }, [engineProviderId, loadNeutralModels]);


  // Le mode « plan » n'existe pas côté moteur neutre (voir docs/protocol.md,
  // Lot 6) : bascule de sécurité si un projet neutre est restauré/sélectionné
  // avec ce mode encore actif (ex. venant d'une session Claude précédente).
  useEffect(() => {
    if (engineProviderId !== null && permissionMode === "plan") {
      setPermissionMode("default");
    }
  }, [engineProviderId, permissionMode]);

  // Recollage en bas du fil : voir useStickToBottom.ts (logique partagée avec
  // ChatPage — l'intention de l'utilisateur prime sur la position).
  const { scrollRef, scrollProps, collerEnBas } = useStickToBottom(turns);

  // Miroirs toujours à jour de l'état affiché, pour la sauvegarde immédiate
  // en fin de tour (`handleSend`) : à ce moment-là, l'état React capturé à
  // l'appel de `handleSend` est périmé (plusieurs `setTurns`/`setSessionId`
  // ont eu lieu pendant le stream), il faut donc lire la valeur courante.
  const turnsRef = useRef(turns);
  const sessionIdRef = useRef(sessionId);
  const openFilesRef = useRef(openFiles);
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  useEffect(() => {
    openFilesRef.current = openFiles;
  }, [openFiles]);
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) ?? null;
  const cwd = selectedProject?.path ?? "";

  // Connaissances du projet : document épinglé, mode injection/RAG, index
  // d'embeddings — voir useConnaissances.ts (étape 8, 3/3).
  const {
    pinnedKnowledge,
    pinKnowledge,
    unpinKnowledge,
    knowledgeMode,
    changeKnowledgeMode,
    knowledgeIdx,
    indexingKnowledge,
    knowledgeIndexProgress,
    knowledgeIndexError,
    handleIndexKnowledge,
    reecrirePins,
  } = useConnaissances(selectedProjectId, cwd);

  // Connaissances AUTOMATIQUES (piste 1 « flexibilité », docs/plan.md) :
  // tout fichier posé dans `.iaction/connaissances/` (pas de récursion,
  // fichiers seulement) rejoint les épinglées comme connaissance injectée au
  // 1er tour (voir `injectedKnowledge` ci-dessous) — groupe « Automatiques »
  // du panneau. Rechargé à chaque changement de projet ; dossier absent ou
  // illisible → liste vide, jamais d'erreur affichée (même esprit que la
  // lecture de `.mcp.json` ci-dessus).
  const [autoKnowledgeFiles, setAutoKnowledgeFiles] = useState<DirEntry[]>([]);
  /**
   * Relit la liste quand elle a pu changer sous nos pieds : le sidecar dépose
   * `iaction.md` (guide d'intégration) et un tour peut écrire dans
   * `connaissances/`. Sans cette relecture, un projet neuf gardait une liste
   * vide toute la session — ni affichage, ni injection (constaté le
   * 2026-08-03). Bumpé après `knowledge.status` et en fin de tour.
   */
  const [autoKnowledgeTick, setAutoKnowledgeTick] = useState(0);
  const autoKnowledgeCwdRef = useRef<string>("");
  useEffect(() => {
    // Vidage réservé au CHANGEMENT DE PROJET : sur une simple relecture, garder
    // la liste courante — la vider ouvrirait une fenêtre où un tour parti à cet
    // instant n'injecterait aucune connaissance.
    if (autoKnowledgeCwdRef.current !== cwd) {
      autoKnowledgeCwdRef.current = cwd;
      setAutoKnowledgeFiles([]);
    }
    if (!cwd) return;
    let cancelled = false;
    // Dépôt du guide d'intégration AVANT le scan (best effort) : c'est ce qui
    // garantit qu'un projet neuf a sa connaissance dès le premier tour. Un
    // échec (sidecar pas prêt, projet en lecture seule) ne doit rien empêcher :
    // on scanne quand même.
    projectEnsureDoc(cwd)
      .catch(() => {})
      .then(() => fsListDir(`${cwd}/.iaction/connaissances`))
      .then((entries) => {
        if (!cancelled) setAutoKnowledgeFiles(entries.filter((e) => !e.isDir));
      })
      .catch(() => {
        // dossier absent/illisible : aucune connaissance automatique, état par défaut déjà posé ci-dessus
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, autoKnowledgeTick]);

  // Mémoire Claude Code détectée (`.claude/memory/*.md`, groupe « Détectées »
  // du panneau, aux côtés de CLAUDE.md — voir `projectBadges.claudeMdPath`
  // plus bas) : purement informatif, JAMAIS injectée d'office (seulement si
  // l'utilisateur clique « Épingler », voir le rendu de la section
  // « Connaissances »). Même politique best effort que ci-dessus.
  const [claudeMemoryFiles, setClaudeMemoryFiles] = useState<DirEntry[]>([]);
  useEffect(() => {
    setClaudeMemoryFiles([]);
    if (!cwd) return;
    let cancelled = false;
    fsListDir(`${cwd}/.claude/memory`)
      .then((entries) => {
        if (!cancelled) setClaudeMemoryFiles(entries.filter((e) => !e.isDir && e.name.endsWith(".md")));
      })
      .catch(() => {
        // dossier absent/illisible : aucune mémoire Claude Code détectée
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Commandes/skills du projet (`claude.commands`, menu « / » du composeur) :
  // best effort — échec (auth, cwd invalide) → liste vide, jamais de message
  // d'erreur bloquant (voir docs/protocol.md). Mémorisées par `cwd` le temps
  // de la session (pas de persistance disque, juste évite un aller-retour
  // sidecar à chaque va-et-vient entre projets déjà visités).
  const slashCommandsCacheRef = useRef<Map<string, SlashCommandInfo[]>>(new Map());
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  useEffect(() => {
    setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
    if (!cwd) {
      setSlashCommands([]);
      return;
    }
    const cached = slashCommandsCacheRef.current.get(cwd);
    if (cached) {
      setSlashCommands(cached);
      return;
    }
    setSlashCommands([]);
    let cancelled = false;
    claudeCommands(cwd)
      .then((commands) => {
        slashCommandsCacheRef.current.set(cwd, commands);
        if (!cancelled) setSlashCommands(commands);
      })
      .catch(() => {
        // échec d'initialisation SDK (auth, cwd invalide) : menu vide, aucun blocage de la saisie
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  /*
   * Titres courts du panneau « Sessions ». Le CLI calcule déjà un titre IA
   * par session (« Organiser tâches sprint 2 et études stratégiques » plutôt
   * que les 48 premiers caractères du premier message) ; `claude.sessionTitles`
   * le relit dans les métadonnées de session — AUCUN token consommé, aucun
   * appel de modèle. Best effort : en cas d'échec, chaque session garde son
   * repli local (`deriveTitleFromText`).
   *
   * Les titres personnalisés à la main (`titleCustom`) ne sont jamais
   * écrasés ; l'appariement se fait sur `sessionId` — l'id de session CÔTÉ
   * SERVEUR, seul connu du CLI —, donc les conversations du moteur neutre
   * (sans session CLI) ne sont pas concernées.
   */
  useEffect(() => {
    if (!cwd || !selectedProjectId) return;
    const serverIds = sessions.map((s) => s.sessionId).filter((id): id is string => id !== null);
    if (serverIds.length === 0) return;
    let cancelled = false;
    void claudeSessionTitles(cwd, serverIds).then((titles) => {
      if (cancelled || titles.size === 0) return;
      setSessions((prev) => {
        let changed = false;
        const next = prev.map((s) => {
          if (s.titleCustom || !s.sessionId) return s;
          const aiTitle = titles.get(s.sessionId);
          if (!aiTitle || aiTitle === s.title) return s;
          changed = true;
          return { ...s, title: aiTitle };
        });
        return changed ? next : prev;
      });
    });
    return () => {
      cancelled = true;
    };
    // Rejoué quand une session obtient son id serveur (fin du 1er tour) : le
    // titre IA n'existe pas avant. `sessions` volontairement hors deps (le
    // setSessions ci-dessus reboucherait), remplacé par la clé stable des ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, selectedProjectId, sessions.map((s) => s.sessionId ?? "").join("\u0000")]);

  // Connaissances AUTOMATIQUES sous la forme `PinnedDoc` (même forme que les
  // épinglées, pour réutiliser `buildKnowledgeBlock` tel quel), et la liste
  // réellement injectée au 1er tour = épinglées + auto, dédoublonnée par
  // chemin (un fichier à la fois épinglé et présent dans le dossier auto
  // n'est injecté qu'une fois — voir `dedupDocsByPath`). C'est aussi le
  // compte affiché par le badge de la section « Connaissances ».
  const autoKnowledgeDocs: PinnedDoc[] = autoKnowledgeFiles.map((e) => ({ path: e.path, name: e.name }));
  const injectedKnowledge = dedupDocsByPath([pinnedKnowledge, autoKnowledgeDocs]);

  // Agents déclarés visibles pour le projet courant (portées projet + global
  // + import Claude Code, `invalid` exclus — voir orchestrationClient.ts) :
  // rechargés à chaque changement de `cwd`, plus sur `subscribeProvidersPushed`
  // (même motif que `loadNeutralModels` ci-dessus — le premier appel peut
  // partir avant que le sidecar soit prêt). Auto-correction : si l'agent
  // actuellement sélectionné pour la session en vue n'est plus dans la liste
  // fraîchement reçue (supprimé, ou juste résolu pour la première fois après
  // une restauration), la sélection retombe silencieusement sur « manuel ».
  const [projectAgents, setProjectAgents] = useState<AgentInfo[]>([]);
  const loadProjectAgents = useCallback(async (path: string) => {
    try {
      const list = (await agentsList(path)).filter((a) => !a.invalid);
      setProjectAgents(list);
      setSelectedAgentKey((prev) =>
        prev && !list.some((a) => a.name === prev.name && a.scope === prev.scope) ? null : prev,
      );
    } catch {
      setProjectAgents([]);
    }
  }, []);

  useEffect(() => {
    setProjectAgents([]);
    if (!cwd) return;
    void loadProjectAgents(cwd);
    const off = subscribeProvidersPushed(() => void loadProjectAgents(cwd));
    return off;
  }, [cwd, loadProjectAgents]);

  // Agent réellement APPLIQUÉ (résolution de `selectedAgentKey` contre la
  // liste vivante) : `null` tant que non résolu (liste pas encore chargée,
  // ou agent introuvable — `loadProjectAgents` nettoie alors la sélection
  // sous peu). Les champs Moteur/Modèle/Permission ne se verrouillent que
  // sur cette valeur résolue, jamais sur la seule référence persistée.
  const selectedAgent: AgentInfo | null = selectedAgentKey
    ? (projectAgents.find((a) => a.name === selectedAgentKey.name && a.scope === selectedAgentKey.scope) ?? null)
    : null;

  // Regroupement par portée pour les `optgroup` du sélecteur (Projet / Global / Claude Code).
  const projectAgentsByScope = {
    project: projectAgents.filter((a) => a.scope === "project"),
    global: projectAgents.filter((a) => a.scope === "global"),
    claudeCode: projectAgents.filter((a) => a.scope === "claude-code"),
  };

  /** Écrit l'entrée `id` dans le document persisté complet (best effort, no-op tant que non hydraté). */
  function persistProject(id: string, liveSessions: ProjectSession[], activeId?: string) {
    // Tant que l'hydratation initiale n'a pas eu lieu, `persistedConversationsRef`
    // ne reflète pas encore le disque : écrire maintenant écraserait une
    // conversation existante avec un état vide/partiel. On saute simplement
    // cette sauvegarde (rien n'est perdu en mémoire, seulement retardé).
    if (!hydrationDoneRef.current) return;
    const next: PersistedConversations = {
      ...persistedConversationsRef.current,
      [id]: buildPersistedEntry({
        sessions: liveSessions,
        // Défaut par REF (voir sessionsRef) : un appel tardif (fin de tour)
        // ne doit pas re-désigner comme active la conversation d'alors.
        activeId: activeId ?? activeSessionIdRef.current,
        openConversationIds: openConversationIdsRef.current,
        openFiles: openFilesRef.current,
        activeTab: activeTabRef.current,
      }),
    };
    persistedConversationsRef.current = next;
    void stateWrite(CONVERSATIONS_STATE_KEY, next).catch(() => {
      // best effort : une écriture ratée ne bloque pas l'UI, la prochaine
      // sauvegarde (debounce ou fin de tour suivant) retentera.
    });
  }

  /**
   * Fin d'un tour dont le PROJET n'est plus affiché (l'utilisateur a basculé
   * pendant un streaming d'arrière-plan) : reporte le runtime de la
   * conversation dans l'état mémorisé du projet d'ORIGINE (Map en mémoire +
   * document persisté), sans rien reconstruire depuis les refs — elles
   * décrivent le projet AFFICHÉ, et les combiner avec la clé de l'ancien
   * écrivait les sessions d'un projet sous la clé d'un autre.
   */
  function persistBackgroundConversation(projectId: string, convId: string) {
    const stored = projectStatesRef.current.get(projectId);
    const runtime = runtimes.consulter(convId);
    if (!stored || !runtime) return;
    const sessions = stored.sessions.map((s) =>
      s.id === convId
        ? {
            ...s,
            turns: runtime.turns,
            sessionId: runtime.sessionId,
            routedTier: runtime.routedTier,
            routedTarget: runtime.routedTarget,
            updatedAt: new Date().toISOString(),
            title: s.titleCustom ? s.title : deriveSessionTitle(runtime.turns),
          }
        : s,
    );
    const nextState: ProjectState = { ...stored, sessions };
    projectStatesRef.current.set(projectId, nextState);
    // Même garde d'hydratation que persistProject : ne jamais écraser le
    // document disque avec un état partiel d'avant chargement.
    if (!hydrationDoneRef.current) return;
    const next: PersistedConversations = {
      ...persistedConversationsRef.current,
      [projectId]: buildPersistedEntry(nextState),
    };
    persistedConversationsRef.current = next;
    void stateWrite(CONVERSATIONS_STATE_KEY, next).catch(() => {});
  }

  /**
   * Recombine les sessions du projet courant avec les runtimes VIFS de toutes
   * les conversations ouvertes en onglet — plus seulement de l'active : avec
   * les onglets multiples, plusieurs conversations peuvent avoir avancé
   * (streaming d'arrière-plan) depuis la dernière sauvegarde, et les oublier
   * ici perdrait leurs tours. Les conversations sans runtime (jamais ouvertes
   * cette exécution) sont laissées telles quelles. Le titre auto (non
   * personnalisé) est recalculé au passage.
   */
  function buildLiveSessions(): ProjectSession[] {
    // Lecture par REF (voir sessionsRef) : appelée depuis des callbacks
    // asynchrones longs, cette fonction doit repartir de la liste À JOUR, pas
    // de celle capturée au montage de la closure.
    const activeId = activeSessionIdRef.current;
    return sessionsRef.current.map((s) => {
      const runtime = runtimes.consulter(s.id);
      if (!runtime) return s;
      const merged: ProjectSession = {
        ...s,
        turns: runtime.turns,
        sessionId: runtime.sessionId,
        // R2 — l'affinité de session vit dans le runtime (posée au premier
        // envoi routé, effacée par un override) : recopiée pour persistance.
        routedTier: runtime.routedTier,
        routedTarget: runtime.routedTarget,
        // La config LLM (moteur/modèle/agent) n'est éditable que pour la
        // conversation active : ne l'écrase que pour celle-là (`activeId` par
        // ref — depuis un callback tardif, l'active a pu changer, et écrire la
        // config affichée sur l'ANCIENNE active lui volerait son moteur).
        ...(s.id === activeId
          ? { engine: { providerId: engineProviderId, model }, selectedAgent: selectedAgentKey }
          : {}),
        updatedAt: new Date().toISOString(),
      };
      return merged.titleCustom ? merged : { ...merged, title: deriveSessionTitle(merged.turns) };
    });
  }

  // Chargement du document persisté, une seule fois (StrictMode-safe : même
  // pattern que useProjects/useProviders — le `ref` évite un double appel au
  // double montage/démontage de dev, l'état du composant survit à ce cycle).
  useEffect(() => {
    if (stateInitRef.current) return;
    stateInitRef.current = true;
    stateRead<unknown>(CONVERSATIONS_STATE_KEY)
      .then((raw) => {
        persistedConversationsRef.current = sanitizePersistedConversations(raw);
      })
      .catch(() => {
        persistedConversationsRef.current = {};
      })
      .finally(() => setStatePhase("loaded"));
  }, []);

  // Hydratation : une fois le document persisté ET le registre de projets
  // chargés, on nettoie les entrées orphelines (projet supprimé du
  // registre) et on peuple la Map en mémoire pour chaque projet. Ne tourne
  // qu'une fois (`hydrationDoneRef`).
  useEffect(() => {
    if (hydrationDoneRef.current) return;
    if (statePhase !== "loaded" || projectsLoadState !== "ready") return;
    hydrationDoneRef.current = true;

    const raw = persistedConversationsRef.current;
    const validIds = new Set(projects.map((p) => p.id));
    const cleaned: PersistedConversations = {};
    let removedAny = false;
    for (const [id, entry] of Object.entries(raw)) {
      if (validIds.has(id)) cleaned[id] = entry;
      else removedAny = true;
    }
    persistedConversationsRef.current = cleaned;

    for (const [id, entry] of Object.entries(cleaned)) {
      // Ne pas écraser un état déjà présent en mémoire (session en cours
      // dans cet onglet avant même la fin de ce chargement disque).
      if (projectStatesRef.current.has(id)) continue;
      projectStatesRef.current.set(id, projectStateFromPersisted(entry, pendingLazyLoadsRef.current));
    }

    if (removedAny) {
      void stateWrite(CONVERSATIONS_STATE_KEY, cleaned).catch(() => {});
    }

    // Course possible avec l'auto-sélection ci-dessous : si un projet a déjà
    // été choisi (état vierge, faute de mieux) avant que ce chargement
    // disque arrive, on hydrate l'affichage a posteriori — seulement si rien
    // n'a encore été fait dessus, pour ne jamais écraser une conversation
    // démarrée entre-temps par l'utilisateur.
    if (selectedProjectId && cleaned[selectedProjectId] && turns.length === 0 && sessionId === null) {
      const restored = projectStatesRef.current.get(selectedProjectId);
      if (restored?.sessions.some((s) => s.id === restored.activeId)) {
        loadProjectStateIntoView(restored);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statePhase, projectsLoadState, projects, selectedProjectId]);

  // Sauvegarde débouncée (~1,5 s) après tout changement pertinent du projet
  // affiché. Dépend des chemins des onglets ouverts (pas de leur contenu :
  // seuls les chemins sont persistés) via une clé stable plutôt que le
  // tableau `openFiles` complet, pour ne pas redémarrer le minuteur à chaque
  // frappe dans l'éditeur de fichier.
  const openFilePathsKey = openFiles.map((f) => f.path).join("\u0000");
  useEffect(() => {
    if (!selectedProjectId || !activeSessionId) return;
    const timer = window.setTimeout(() => {
      const liveSessions = buildLiveSessions();
      // Répercuté dans l'état affiché (pas seulement sur disque) : le
      // panneau « Sessions » reflète ainsi le titre auto/la date « mis à
      // jour » sans attendre une bascule. `sessions` n'est pas dans les
      // dépendances de cet effet (sinon boucle) — désactivé ci-dessous,
      // même pattern que le reste de ce fichier pour ce type d'effet.
      setSessions(liveSessions);
      persistProject(selectedProjectId, liveSessions, activeSessionId);
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedProjectId,
    activeSessionId,
    turns,
    sessionId,
    openFilePathsKey,
    activeTab,
    engineProviderId,
    model,
    selectedAgentKey,
  ]);

  /** Charge un `ProjectState` restauré (ou vierge) dans l'affichage — onglets ouverts, session active, liste complète. */
  function loadProjectStateIntoView(next: ProjectState) {
    const activeSession = next.sessions.find((s) => s.id === next.activeId) ?? next.sessions[0];
    // Runtimes repartis de zéro : on change de PROJET, les conversations de
    // l'ancien tombent (leurs tours viennent d'être sauvegardés par
    // l'appelant) — SAUF celles encore en cours de STREAMING : couper leur
    // runtime perdrait le flux en route (les callbacks écrivent par convId
    // dans cette Map), et c'est leur survie ici qui permet à la fin du tour
    // de sauvegarder son résultat dans le projet d'ORIGINE (voir la garde de
    // fin de tour dans handleSend). Au retour dans ce projet, une
    // conversation dont le runtime a survécu n'est PAS ré-amorcée depuis sa
    // copie persistée (qui serait partielle).
    const kept = new Map<string, ConvRuntime>();
    for (const [convId, runtime] of runtimes.entrees()) {
      if (runtime.streaming) kept.set(convId, runtime);
    }
    runtimes.reinitialiser(kept);
    for (const conv of next.sessions) {
      if (next.openConversationIds.includes(conv.id) && !runtimes.connait(conv.id)) {
        runtimes.poser(conv.id, freshRuntime(conv.turns, conv.sessionId, conv.routedTier, conv.routedTarget));
      }
    }
    setSessions(next.sessions);
    setActiveSessionId(activeSession.id);
    setOpenConversationIds(next.openConversationIds);
    setOpenFiles(next.openFiles);
    setActiveTab(next.activeTab);
    setEngineProviderId(activeSession.engine.providerId);
    setModel(activeSession.engine.model);
    // Résolution différée (voir le commentaire de `loadProjectAgents`) : au
    // moment d'une bascule de PROJET, `projectAgents` correspond encore à
    // l'ancien projet — c'est l'effet déclenché par le changement de `cwd`
    // qui validera cette sélection une fois la nouvelle liste chargée.
    setSelectedAgentKey(activeSession.selectedAgent);
  }

  // Aucun projet sélectionné mais la liste n'est plus vide (chargement
  // initial, ou projet précédemment sélectionné supprimé ci-dessous) : on
  // rouvre le DERNIER projet utilisé s'il existe encore, sinon le premier
  // déclaré. On attend d'avoir lu le disque (`lastProjectLoaded`) pour ne pas
  // ouvrir le premier projet puis basculer — ce qui ferait clignoter l'écran
  // et chargerait inutilement l'état du mauvais projet.
  useEffect(() => {
    if (selectedProjectId !== null || projects.length === 0 || !lastProjectLoaded) return;
    const remembered = lastProjectIdRef.current;
    const id = remembered && projects.some((p) => p.id === remembered) ? remembered : projects[0].id;
    setSelectedProjectId(id);
    // Réaligne la mémoire quand le projet retenu n'existe plus (supprimé).
    if (id !== remembered) rememberLastProject(id);
    loadProjectStateIntoView(projectStatesRef.current.get(id) ?? emptyProjectState());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, selectedProjectId, lastProjectLoaded]);

  // Le projet sélectionné a été supprimé depuis Configuration : on efface
  // son état mémorisé (mémoire + disque) et on repart d'aucune sélection
  // (l'effet ci-dessus choisira un autre projet, s'il en reste).
  useEffect(() => {
    if (selectedProjectId !== null && !projects.some((p) => p.id === selectedProjectId)) {
      projectStatesRef.current.delete(selectedProjectId);
      if (selectedProjectId in persistedConversationsRef.current) {
        const next = { ...persistedConversationsRef.current };
        delete next[selectedProjectId];
        persistedConversationsRef.current = next;
        void stateWrite(CONVERSATIONS_STATE_KEY, next).catch(() => {});
      }
      setSelectedProjectId(null);
      runtimes.reinitialiser();
      setSessions([]);
      setActiveSessionId("");
      setOpenConversationIds([]);
      setOpenFiles([]);
      setActiveTab(EMPTY_TAB);
      setPermissionQueue([]);
      setEngineProviderId(null);
      setModel("");
      setSelectedAgentKey(null);
    }
  }, [projects, selectedProjectId]);

  function selectProject(id: string) {
    if (streaming || id === selectedProjectId) return;
    if (selectedProjectId) {
      const liveSessions = buildLiveSessions();
      projectStatesRef.current.set(selectedProjectId, {
        sessions: liveSessions,
        activeId: activeSessionId,
        openConversationIds,
        openFiles,
        activeTab,
      });
      persistProject(selectedProjectId, liveSessions, activeSessionId);
    }
    setSelectedProjectId(id);
    rememberLastProject(id);
    loadProjectStateIntoView(projectStatesRef.current.get(id) ?? emptyProjectState());
    setPermissionQueue([]);
    clearAttachments();
    setOpenFilesNotice(null);
    setConfirmDeleteSessionId(null);
    setEditingSessionId(null);
    // Changement de projet : bandeau et filet d'annulation du vidage sans objet
    // (ils concernaient une conversation de l'ancien projet).
    setClearedNotice(false);
    clearedBackupRef.current = null;
  }

  /**
   * Sélection d'un agent (section LLM, au-dessus de « Moteur ») : applique
   * moteur/modèle (si non `null`)/mode de permission — les instructions et
   * `maxTurns` sont relus depuis `selectedAgent` au moment de l'envoi (voir
   * `sendViaClaudeEngine`/`sendViaNeutralEngine`), pas recopiés ici. `""` =
   * retour au mode manuel (`clearAgentSelection`).
   */
  /** R2/R7 — efface plancher + cible de session de la conversation active (override du mode Auto). */
  function clearRoutedAffinity() {
    if (!activeSessionId) return;
    updateRuntime(activeSessionId, (r) => ({ ...r, routedTier: null, routedTarget: null, routedReasons: null }));
  }

  function handleAgentSelectChange(value: string) {
    if (streaming) return;
    if (!value) {
      setSelectedAgentKey(null);
      return;
    }
    const sep = value.indexOf("::");
    const scope = value.slice(0, sep) as AgentScope;
    const name = value.slice(sep + 2);
    const agent = projectAgents.find((a) => a.scope === scope && a.name === name);
    if (!agent) return;
    setSelectedAgentKey({ name: agent.name, scope: agent.scope });
    // R2 — agent `engine: auto` : moteur/modèle choisis par le routeur à
    // l'envoi (sentinelle Auto armée) ; sinon config explicite de l'agent.
    if (agent.engine === "auto") {
      setEngineProviderId(null);
      setModel(AUTO_MODEL);
    } else {
      setEngineProviderId(agent.engine === "neutral" ? agent.provider : null);
      if (agent.model !== null) setModel(agent.model);
      // Config explicite = override : le prochain envoi ne re-route pas.
      clearRoutedAffinity();
    }
    setPermissionMode(agent.permissionMode);
    // Le moteur neutre ne supporte pas les pièces jointes (voir le contrat), et
    // le mode Auto peut y router : on ne garde jamais un brouillon en attente
    // pour le mauvais moteur.
    if (agent.engine !== "claude") clearAttachments();
  }

  /** Retombe en mode manuel : les champs restent aux dernières valeurs appliquées, mais redeviennent éditables. */
  function clearAgentSelection() {
    if (streaming) return;
    setSelectedAgentKey(null);
  }

  /** Bascule de moteur depuis le sélecteur toolbar : réinitialise le modèle (repris par `loadNeutralModels` si moteur neutre). */
  function handleEngineChange(value: string) {
    if (streaming || selectedAgent !== null) return;
    const next = value === "" ? null : value;
    setEngineProviderId(next);
    setModel("");
    // R2 — changer de moteur = choix explicite : l'affinité de routage tombe.
    clearRoutedAffinity();
    if (next === null) {
      setNeutralModels([]);
      setNeutralModelsState("idle");
      setNeutralModelsError("");
    } else {
      // Bascule vers le moteur neutre : pas de pièces jointes possibles (voir le contrat).
      clearAttachments();
    }
  }

  /**
   * Crée une nouvelle session d'historique pour le projet courant — l'ancienne
   * reste consultable dans le panneau « Sessions ». Renvoie `false` si refusée
   * (run en cours, ou aucun projet sélectionné) — voir `AgentPageHandle.newSession`,
   * qui s'appuie sur cette même fonction depuis le raccourci global Ctrl+N.
   */
  function handleNewSession(): boolean {
    if (!selectedProjectId) return false;
    // Session courante déjà vierge (aucun tour, titre jamais personnalisé) :
    // en créer une seconde ne ferait qu'empiler des « Nouvelle session »
    // identiques dans l'historique. On réutilise celle-ci.
    const current = sessions.find((s) => s.id === activeSessionId);
    if (current && turns.length === 0 && !current.titleCustom) {
      // Son onglet a pu être fermé (Ctrl+Suppr) : il faut le rouvrir, sinon
      // « + »/Ctrl+N resteraient sans effet visible.
      if (!openConversationIds.includes(current.id)) {
        ensureRuntime(current);
        setOpenConversationIds((prev) => [...prev, current.id]);
      }
      setActiveTab(convTabId(current.id));
      // Réutilisation après un Ctrl+K : l'utilisateur repart sur une session
      // « neuve » — le bandeau d'annulation du vidage n'a plus sa place (un
      // « Annuler » ici ressusciterait les anciens tours dans ce qu'il
      // considère comme une conversation vierge).
      setClearedNotice(false);
      clearedBackupRef.current = null;
      focusComposer();
      return true;
    }
    const liveSessions = buildLiveSessions();
    const fresh: ProjectSession = { ...freshSession(), engine: { providerId: engineProviderId, model } };
    // Purge des sessions vides laissées par d'anciennes créations répétées —
    // en épargnant celles ouvertes en onglet (les fermer sous les pieds de
    // l'utilisateur serait brutal) et celles en cours de streaming.
    const kept = liveSessions.filter(
      (s) =>
        s.id === activeSessionId ||
        s.turns.length > 0 ||
        s.titleCustom ||
        openConversationIds.includes(s.id) ||
        runtimes.consulter(s.id)?.streaming === true,
    );
    const nextSessions = [...kept, fresh];
    runtimes.poser(fresh.id, freshRuntime());
    setSessions(nextSessions);
    setActiveSessionId(fresh.id);
    // Ouverte dans un NOUVEL onglet, à la suite : les conversations déjà
    // ouvertes le restent (c'est tout l'objet des onglets multiples).
    setOpenConversationIds((prev) => [...prev, fresh.id]);
    setActiveTab(convTabId(fresh.id));
    setConfirmDeleteSessionId(null);
    setClearedNotice(false);
    setSelectedAgentKey(null);
    clearAttachments();
    persistProject(selectedProjectId, nextSessions, fresh.id);
    focusComposer();
    return true;
  }

  /**
   * Vide les tours de la session ACTIVE, sans en créer de nouvelle — la
   * session garde son id, son titre et sa config LLM (moteur/modèle/agent).
   * Utilisée par le raccourci global Ctrl+K (voir `AgentPageHandle.clearConversation`
   * dans App.tsx) : contrairement à `handleNewSession`, aucune entrée
   * supplémentaire n'apparaît dans le panneau « Sessions ». Renvoie `false`
   * si refusée (run en cours, ou aucun projet sélectionné).
   */
  /**
   * Place le curseur dans le composeur. `requestAnimationFrame` : appelé juste
   * après un changement d'onglet/de page, le textarea peut ne pas être encore
   * visible (slot masqué) — un focus posé trop tôt serait ignoré.
   */
  function focusComposer() {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function clearConversation(): boolean {
    if (!selectedProjectId || !activeSessionId) return false;
    if (streaming) {
      // Refus silencieux inacceptable au clavier (Ctrl+K) : sans retour
      // visible, l'utilisateur croit que « vider » est cassé (même principe
      // que closeConversationTab).
      setOpenFilesNotice("Conversation en cours : arrêtez le tour avant de la vider.");
      return false;
    }
    // Vider écrase ET persiste : sans filet, les messages seraient perdus sans
    // recours. On mémorise l'état d'avant pour permettre une annulation
    // immédiate (bandeau « Annuler »), ce qui évite une modale de confirmation
    // à chaque Ctrl+K. `convId` : voir la déclaration de `clearedBackupRef`.
    clearedBackupRef.current = {
      convId: activeSessionId,
      turns,
      sessionId,
      routedTier: activeRuntime.routedTier,
      routedTarget: activeRuntime.routedTarget,
    };
    // R2 — conversation vidée = repart de zéro : le prochain envoi en Auto re-route.
    updateRuntime(activeSessionId, (r) => ({
      ...r,
      turns: [],
      sessionId: null,
      mcpUsage: {},
      routedTier: null,
      routedTarget: null,
      routedReasons: null,
    }));
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    setPermissionQueue([]);
    setConfirmDeleteSessionId(null);
    persistProject(selectedProjectId, liveSessions, activeSessionId);
    setClearedNotice(true);
    focusComposer();
    return true;
  }

  /**
   * Restaure la conversation vidée juste avant (bandeau « Annuler ») — DANS la
   * conversation d'origine (`backup.convId`), qui peut ne plus être l'active.
   * Refus si elle a été supprimée entre-temps, ou si un tour y a redémarré
   * (écraser un stream en cours serait pire que de perdre l'annulation).
   */
  function undoClearConversation() {
    const backup = clearedBackupRef.current;
    if (!backup || !selectedProjectId) return;
    if (runtimes.consulter(backup.convId)?.streaming) return;
    clearedBackupRef.current = null;
    setClearedNotice(false);
    if (!sessions.some((s) => s.id === backup.convId)) return;
    updateRuntime(backup.convId, (r) => ({
      ...r,
      turns: backup.turns,
      sessionId: backup.sessionId,
      routedTier: backup.routedTier,
      routedTarget: backup.routedTarget,
    }));
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    persistProject(selectedProjectId, liveSessions, activeSessionId);
  }

  /**
   * Ouvre une session en onglet et l'active (ou la réactive si déjà ouverte).
   * Plus aucun verrou de streaming ici, contrairement à la version
   * mono-conversation : chaque conversation a son propre runtime, basculer
   * n'écrase donc plus l'état d'un tour en cours — c'est même l'intérêt des
   * onglets (partir travailler ailleurs pendant qu'un agent tourne).
   */
  function selectSession(id: string) {
    if (!selectedProjectId) return;
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    const target = liveSessions.find((s) => s.id === id);
    if (!target) return;
    // Amorce le runtime depuis la dernière copie connue UNIQUEMENT si cette
    // conversation n'a pas déjà un runtime vivant : réactiver l'onglet d'un
    // tour en cours ne doit jamais le réinitialiser.
    ensureRuntime(target);
    setActiveSessionId(id);
    setOpenConversationIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveTab(convTabId(id));
    setEngineProviderId(target.engine.providerId);
    setModel(target.engine.model);
    // Même projet : `projectAgents` est déjà à jour, résolution immédiate.
    setSelectedAgentKey(resolveAgentSelection(target.selectedAgent, projectAgents));
    clearAttachments();
    setConfirmDeleteSessionId(null);
    // Le bandeau « Conversation vidée / Annuler » parle de la conversation
    // qu'on QUITTE : affiché sous une autre, il sème la confusion (l'undo est
    // ciblé, mais l'utilisateur ne peut pas le savoir).
    setClearedNotice(false);
    persistProject(selectedProjectId, liveSessions, id);
    focusComposer();
  }

  /** Renomme une session (titre personnalisé — n'est plus jamais recalculé automatiquement). */
  function renameSession(id: string, title: string) {
    if (!selectedProjectId) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    const liveSessions = buildLiveSessions().map((s) =>
      s.id === id ? { ...s, title: trimmed, titleCustom: true } : s,
    );
    setSessions(liveSessions);
    persistProject(selectedProjectId, liveSessions, activeSessionId);
  }

  /** Supprime une session (définitif — confirmation à la charge de l'appelant, voir le panneau « Sessions »). */
  function deleteSession(id: string) {
    // Refus si CETTE conversation a un tour en cours (les autres peuvent
    // continuer de streamer sans que ça pose problème).
    if (!selectedProjectId || runtimes.consulter(id)?.streaming) return;
    const liveSessions = buildLiveSessions();
    const remaining = liveSessions.filter((s) => s.id !== id);
    const finalSessions = remaining.length > 0 ? remaining : [freshSession()];
    runtimes.oublier(id);
    setSessions(finalSessions);
    const nextOpen = openConversationIds.filter((c) => c !== id && finalSessions.some((s) => s.id === c));
    setOpenConversationIds(nextOpen);
    if (id === activeSessionId) {
      setClearedNotice(false);
      const nextActive = finalSessions.find((s) => s.id === nextOpen[nextOpen.length - 1]) ?? finalSessions[0];
      ensureRuntime(nextActive);
      setActiveSessionId(nextActive.id);
      setOpenConversationIds(nextOpen.includes(nextActive.id) ? nextOpen : [...nextOpen, nextActive.id]);
      setActiveTab(convTabId(nextActive.id));
      setEngineProviderId(nextActive.engine.providerId);
      setModel(nextActive.engine.model);
      setSelectedAgentKey(resolveAgentSelection(nextActive.selectedAgent, projectAgents));
      persistProject(selectedProjectId, finalSessions, nextActive.id);
    } else {
      persistProject(selectedProjectId, finalSessions, activeSessionId);
    }
  }

  /**
   * Ferme l'onglet d'une conversation SANS la supprimer (elle reste dans le
   * panneau « Sessions »). Son runtime est abandonné : ses tours viennent
   * d'être recopiés dans `sessions` par `buildLiveSessions`. Un tour en cours
   * serait perdu de vue, donc on refuse tant qu'il streame.
   */
  function closeConversationTab(id: string) {
    if (!selectedProjectId) return;
    if (runtimes.consulter(id)?.streaming) {
      // Refus silencieux inacceptable au clavier (Ctrl+Suppr) : l'utilisateur
      // ne verrait rien se passer. Le bouton « × » est lui déjà désactivé.
      setOpenFilesNotice("Conversation en cours : arrêtez le tour avant de fermer son onglet.");
      return;
    }
    setOpenFilesNotice(null);
    const liveSessions = buildLiveSessions();
    setSessions(liveSessions);
    runtimes.oublier(id);
    const nextOpen = openConversationIds.filter((c) => c !== id);
    setOpenConversationIds(nextOpen);

    // Conversation qui devient active : inchangée si on ferme un AUTRE onglet,
    // sinon l'onglet voisin (le précédent, à défaut le premier restant).
    let nextActiveId = activeSessionId;
    if (activeSessionId === id) {
      // Bascule de conversation active : le bandeau « Conversation vidée /
      // Annuler » parlait de celle qu'on quitte (voir selectSession).
      setClearedNotice(false);
      const idx = openConversationIds.indexOf(id);
      const neighbour = nextOpen[Math.max(0, idx - 1)];
      const target = neighbour ? liveSessions.find((s) => s.id === neighbour) : undefined;
      if (target) {
        ensureRuntime(target);
        nextActiveId = target.id;
        setActiveSessionId(target.id);
        setActiveTab(convTabId(target.id));
        setEngineProviderId(target.engine.providerId);
        setModel(target.engine.model);
        setSelectedAgentKey(resolveAgentSelection(target.selectedAgent, projectAgents));
      } else {
        // Dernier onglet de conversation fermé : on en rouvre aussitôt un
        // vierge plutôt que de laisser l'écran vide — même effet visible que
        // Ctrl+K, mais non destructif (la conversation fermée reste dans le
        // panneau « Sessions »). Sans cela l'utilisateur se retrouvait sans
        // conversation ET sans moyen d'en rouvrir une.
        const fresh: ProjectSession = { ...freshSession(), engine: { providerId: engineProviderId, model } };
        // Purge des sessions vides au passage (celle qu'on vient de fermer si
        // elle n'avait aucun tour), comme le fait `handleNewSession`.
        const kept = liveSessions.filter(
          (s) => s.turns.length > 0 || s.titleCustom || runtimes.consulter(s.id)?.streaming === true,
        );
        const withFresh = [...kept, fresh];
        runtimes.poser(fresh.id, freshRuntime());
        setSessions(withFresh);
        setOpenConversationIds([fresh.id]);
        setActiveSessionId(fresh.id);
        setActiveTab(convTabId(fresh.id));
        setSelectedAgentKey(null);
        clearAttachments();
        persistProject(selectedProjectId, withFresh, fresh.id);
        focusComposer();
        return;
      }
    }
    persistProject(selectedProjectId, liveSessions, nextActiveId);
  }

  /** Conversation suivante/précédente dans la barre d'onglets (Ctrl+Tab / Ctrl+Maj+Tab). */
  function cycleConversation(direction: 1 | -1) {
    const suivant = prochainOnglet(openConversationIds, activeSessionId, direction);
    if (suivant) selectSession(suivant);
  }

  function startEditSessionTitle(session: ProjectSession) {
    if (streaming) return;
    setEditingSessionId(session.id);
    setEditingSessionTitle(session.title);
  }

  function cancelEditSessionTitle() {
    sessionTitleSkipBlurRef.current = true;
    setEditingSessionId(null);
  }

  function commitEditSessionTitle() {
    if (sessionTitleSkipBlurRef.current) {
      // Provient du `blur` déclenché par le démontage du champ sur Échap : ignoré.
      sessionTitleSkipBlurRef.current = false;
      return;
    }
    if (!editingSessionId) return;
    const id = editingSessionId;
    const value = editingSessionTitle;
    setEditingSessionId(null);
    renameSession(id, value);
  }


  /*
   * Envoi et moteurs — TOUT le chemin chaud (handleSend, claude.start /
   * neutral.start, routage Auto descendant, bandeau de débord) vit dans
   * envoiProjet.ts ; la page ne fournit que son état et ses écritures.
   * La fabrique est rappelée à chaque rendu, exactement comme l'étaient les
   * fonctions qu'elle remplace : chaque tour capture l'état du rendu qui l'a
   * lancé, et écrit ensuite UNIQUEMENT via convId dans les runtimes.
   */
  const { handleSend } = creerEnvoiProjet({
    activeSessionId,
    cwd,
    selectedProjectId,
    selectedProjectIdRef,
    fournisseurs: providers,
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
    indexConnaissancesPret: knowledgeIdx?.exists === true,
    injectedKnowledge,
    getRuntime,
    updateRuntime,
    updateTurnsFor,
    autoAllowToolsRef,
    injectorsRef,
    setPermissionQueue,
    fermerMenuSlash: () => setSlashMenu((m) => ({ ...m, open: false })),
    signalerMcpInit: () => setMcpReloadToken((n) => n + 1),
    rafraichirConnaissancesAuto: () => setAutoKnowledgeTick((t) => t + 1),
    setAttachmentsError,
    clearAttachments,
    restoreAttachments,
    collerEnBas,
    buildLiveSessions,
    setSessions,
    persistProject,
    persistBackgroundConversation,
  });

  // Fin de tour : si des messages ont été mis en file pendant que l'agent
  // travaillait, on envoie le PREMIER automatiquement — les suivants partiront
  // aux fins de tour suivantes, un par un. `streaming` vient de repasser à
  // false ; handleSend(override) ne re-file pas et lance le tour suivant.
  useEffect(() => {
    if (streaming || !activeSessionId) return;
    const pending = getRuntime(activeSessionId).queuedPrompts[0];
    if (!pending || !cwd) return;
    updateRuntime(activeSessionId, (r) => ({ ...r, queuedPrompts: r.queuedPrompts.slice(1) }));
    void handleSend(pending);
    // Dépendances : `runtimeTick` (toute écriture de runtime, y compris la fin
    // d'un tour d'ARRIÈRE-PLAN) et `activeSessionId` (retour sur un onglet).
    //
    // Ne dépendre que de `streaming` perdait des messages : un tour finissant
    // en arrière-plan ne change pas le `streaming` de la conversation active,
    // et revenir sur l'onglet concerné ne le changeait pas davantage
    // (false → false). Le message restait « En file » indéfiniment, sans aucun
    // tour en cours pour le libérer.
    //
    // Limite assumée : la file d'une conversation d'arrière-plan part quand on
    // y revient, pas avant. `handleSend` fige sa cible sur la conversation
    // ACTIVE (voir son en-tête) et les réglages du composeur — modèle, agent,
    // mode de permission — sont ceux de la page ; envoyer « à distance »
    // exigerait de les capturer par conversation. Le message n'est plus perdu,
    // c'est ce qui compte ; l'envoi différé reste explicable à l'utilisateur,
    // la pastille « En file » étant visible sur l'onglet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming, runtimeTick, activeSessionId]);

  async function handleAbort() {
    if (!activeSessionId) return;
    const runtime = getRuntime(activeSessionId);
    if (!runtime.streaming && !runtime.activeRequestId) return;
    // Arrêter = tout stopper : on abandonne aussi les messages éventuellement en
    // file (sinon ils partiraient juste après l'interruption, effet surprenant).
    updateRuntime(activeSessionId, (r) => ({ ...r, queuedPrompts: [] }));
    // Tour encore en phase de PRÉ-ENVOI (routage Auto, lecture des
    // connaissances) : aucune requête moteur à abandonner côté sidecar — on
    // lève le drapeau, le point de contrôle de `handleSend` annulera le tour
    // avant tout envoi (message reposé dans le composeur).
    if (!runtime.activeRequestId) {
      updateRuntime(activeSessionId, (r) => ({ ...r, preSendAbort: true }));
      return;
    }
    try {
      if (runtime.activeEngine === "neutral") {
        await neutralAbort(runtime.activeRequestId);
      } else {
        await claudeAbort(runtime.activeRequestId);
      }
    } catch {
      // best effort : le `done` du tour en cours gère l'état final du tour
    }
  }

  /** Rendre la main pendant l'attente des tâches de fond : claude.release clôt
      le tour proprement (le done livre le résultat déjà connu) ; contrairement
      à Arrêter, les messages en file partent ensuite normalement. */
  async function handleReleaseBackground() {
    if (!activeSessionId) return;
    const runtime = getRuntime(activeSessionId);
    if (!runtime.activeRequestId) return;
    try {
      await claudeRelease(runtime.activeRequestId);
    } catch {
      // best effort : le `done` du tour en cours gère l'état final du tour
    }
  }

  /* ---------- Voix du composeur (voir useVoiceComposer.ts) ---------- */

  /*
   * Dictée ponctuelle et mode conversation, MUTUALISÉS avec la page Chat : ce
   * hook porte toute la machinerie (micro, transcription, envoi, lecture,
   * garde-fous), la page ne fournit que ses propres accès au fil et à l'envoi.
   */
  const voice = useVoiceComposer({
    pageLabel: "Projets",
    pageVisible,
    micDeviceId,
    conversation: conversationConfig,
    // `handleSend` ne résout qu'à la fin du tour (elle attend `done`) : c'est
    // ce que le mode conversation attend pour enchaîner lecture puis reprise
    // de l'écoute. Sans projet sélectionné, elle ne fait rien — d'où
    // `notSentNotice` ci-dessous.
    send: (text) => handleSend(text),
    isBusy: () => streaming,
    turnCount: () => turnsRef.current.length,
    lastReplyText: () => {
      const list = turnsRef.current;
      const last = list[list.length - 1];
      if (!last || last.role !== "assistant" || last.status !== "done") return null;
      return spokenTextOfTurn(last) || null;
    },
    // Tour EN COURS d'écriture : `turnsRef` est tenu à jour de façon synchrone
    // par `updateTurns`, on lit donc le tour en construction sans rendu ni effet
    // supplémentaire. Même règle qu'à la fin (`spokenTextOfTurn`) : seuls les
    // blocs de texte sont lus, jamais les appels d'outils ni le raisonnement.
    streamingReplyText: () => {
      const list = turnsRef.current;
      const last = list[list.length - 1];
      if (!last || last.role !== "assistant" || last.status !== "streaming") return null;
      return spokenTextOfTurn(last) || null;
    },
    notSentNotice: "Message non envoyé : vérifiez le projet sélectionné.",
    appendToDraft: (text) => {
      if (activeSessionId) {
        updateRuntime(activeSessionId, (r) => ({ ...r, draft: r.draft ? `${r.draft} ${text}` : text }));
      }
      // Le menu « / » n'est piloté que par la saisie clavier (`updateSlashMenu`) :
      // un texte dicté ne doit ni l'ouvrir, ni le laisser ouvert sur un
      // fragment devenu caduc.
      setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
    },
    // Envoi par mot-clé : le brouillon rendu est celui que l'utilisateur voit
    // (dicté ET tapé), et il est vidé — c'est lui qui part.
    takeDraft: () => {
      if (!activeSessionId) return "";
      const draft = getRuntime(activeSessionId).draft;
      if (draft) updateRuntime(activeSessionId, (r) => ({ ...r, draft: "" }));
      return draft;
    },
    focusComposer: () => focusComposer(),
  });

  async function handlePermissionDecision(decision: "allow" | "deny", message: string, rememberTool: boolean) {
    const current = permissionQueue[0];
    if (!current) return;
    const respond = (item: PermissionRequestItem, dec: "allow" | "deny", msg?: string) =>
      item.engine === "neutral"
        ? neutralPermission(item.targetId, item.permissionId, dec, msg)
        : claudePermission(item.targetId, item.permissionId, dec, msg);
    if (decision === "allow" && rememberTool) {
      // Étape 11 — clé PAR PROJET du tour (voir permissions.ts) : un Bash
      // autorisé ici ne s'applique plus en silence aux autres projets.
      autoAllowToolsRef.current.add(cleAutoAllow(current.projectId ?? null, current.toolName));
      // Autorise aussi d'un coup les demandes déjà en file pour le même outil.
      for (const item of permissionQueue.slice(1)) {
        if (item.toolName === current.toolName) {
          void respond(item, "allow");
        }
      }
    }
    try {
      await respond(current, decision, message || undefined);
    } catch {
      // best effort : la file est purgée dans tous les cas côté UI
    }
    setPermissionQueue((prev) =>
      decision === "allow" && rememberTool
        ? prev.filter((p, i) => i !== 0 && p.toolName !== current.toolName)
        : prev.slice(1),
    );
  }

  /* ---------- Menu « / » du composeur (slash-commands/skills du projet) ---------- */

  /**
   * Détecte un token « /frag » sous le curseur, SEULEMENT s'il démarre la
   * ligne courante (début du texte ou juste après un saut de ligne) — un
   * « / » au milieu d'un mot (ex. « et/ou ») ne matche jamais. Le fragment ne
   * doit contenir ni espace ni saut de ligne (dès qu'un espace suit le nom de
   * la commande, on considère que l'utilisateur tape ses arguments : plus de
   * détection).
   */
  function detectSlashToken(text: string, cursor: number): { start: number; fragment: string } | null {
    const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
    if (text[lineStart] !== "/") return null;
    const token = text.slice(lineStart, cursor);
    if (!/^\/\S*$/.test(token)) return null;
    return { start: lineStart, fragment: token.slice(1) };
  }

  /** Commandes dont le nom OU un alias matche `fragment` — préfixe prioritaire, puis sous-chaîne, insensible à la casse. */
  function matchSlashCommands(commands: SlashCommandInfo[], fragment: string): SlashCommandInfo[] {
    const needle = fragment.toLowerCase();
    const prefix: SlashCommandInfo[] = [];
    const substring: SlashCommandInfo[] = [];
    for (const cmd of commands) {
      const names = [cmd.name, ...(cmd.aliases ?? [])].map((n) => n.toLowerCase());
      if (names.some((n) => n.startsWith(needle))) prefix.push(cmd);
      else if (names.some((n) => n.includes(needle))) substring.push(cmd);
    }
    return [...prefix, ...substring];
  }

  /** Recalcule l'état du menu « / » à partir du texte et de la position du curseur (appelé à chaque frappe). */
  function updateSlashMenu(text: string, cursor: number) {
    const token = detectSlashToken(text, cursor);
    if (!token || slashCommands.length === 0) {
      setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
      return;
    }
    if (matchSlashCommands(slashCommands, token.fragment).length === 0) {
      setSlashMenu((m) => (m.open ? { ...m, open: false } : m));
      return;
    }
    setSlashMenu({ open: true, fragment: token.fragment, start: token.start, selected: 0 });
  }

  /** Insère « /name » (remplace le fragment « /frag » courant), ferme le menu, replace le curseur juste après l'espace. */
  function applySlashCommand(cmd: SlashCommandInfo) {
    const insertion = `/${cmd.name} `;
    // Brouillon vif : le menu se pilote à la frappe, dont le rendu retarde.
    const current = getLiveDraft();
    const before = current.slice(0, slashMenu.start);
    const after = current.slice(slashMenu.start + 1 + slashMenu.fragment.length);
    pendingCursorRef.current = before.length + insertion.length;
    setDraft(`${before}${insertion}${after}`);
    setSlashMenu((m) => ({ ...m, open: false }));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (handleUndoKey(e)) return;
    if (slashMenu.open) {
      const matches = matchSlashCommands(slashCommands, slashMenu.fragment);
      if (matches.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashMenu((m) => ({ ...m, selected: (m.selected + 1) % matches.length }));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashMenu((m) => ({ ...m, selected: (m.selected - 1 + matches.length) % matches.length }));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applySlashCommand(matches[slashMenu.selected] ?? matches[0]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenu((m) => ({ ...m, open: false }));
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  /* ---------- Onglets fichier (arborescence + éditeur) ---------- */

  function loadFileInto(path: string, opts?: { onErrorCloseTab?: boolean }) {
    fsReadFile(path)
      .then((fc) =>
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === path
              ? { ...f, kind: fc.kind, content: fc.text ?? "", base64: fc.base64 ?? "", size: fc.size, truncated: fc.truncated, dirty: false }
              : f,
          ),
        ),
      )
      .catch((err: unknown) => {
        if (opts?.onErrorCloseTab) {
          // Onglet restauré (Lot 3, relecture paresseuse) dont le fichier
          // est introuvable/illisible (déplacé, supprimé…) : on ferme
          // l'onglet silencieusement plutôt que d'afficher une erreur pour
          // un fichier que l'utilisateur n'a pas explicitement rouvert.
          pendingLazyLoadsRef.current.delete(path);
          setOpenFiles((prev) => prev.filter((f) => f.path !== path));
          setActiveTab((current) => (current === path ? "conversation" : current));
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, kind: "error", errorMessage: message } : f)));
      });
  }

  /** Déclenche la relecture réelle d'un onglet restauré, la première fois qu'il devient actif. */
  function triggerLazyLoad(path: string) {
    if (path === "conversation" || !pendingLazyLoadsRef.current.has(path)) return;
    pendingLazyLoadsRef.current.delete(path);
    loadFileInto(path, { onErrorCloseTab: true });
  }

  /** `setActiveTab` + relecture paresseuse si cet onglet vient d'être restauré du disque. */
  function applyActiveTab(path: string) {
    setActiveTab(path);
    triggerLazyLoad(path);
  }

  // Raccourcis d'ONGLETS de conversation, écouteur LOCAL à cette page :
  // l'écouteur global de App.tsx ne connaît pas ces onglets, et ni Tab ni
  // Suppr n'y sont captés — aucun conflit avec les raccourcis globaux
  // (Ctrl+N/P/H/K/T/L, Ctrl+1..6, Ctrl+Maj+P).
  //   Ctrl+Tab / Ctrl+Maj+Tab : conversation suivante / précédente
  //   Ctrl+Suppr             : ferme l'onglet courant (l'historique est
  //                            CONSERVÉ — la conversation reste dans le
  //                            panneau « Sessions », seule sa suppression
  //                            définitive y est possible, avec confirmation)
  useEffect(() => {
    // Les six pages restent montées en permanence (voir App.tsx) : sans la
    // garde `pageVisible`, ces raccourcis agiraient AUSSI depuis les autres
    // pages — la page Chat ayant désormais ses propres onglets et le même
    // écouteur, Ctrl+Tab y cyclerait invisiblement les onglets de Projets.
    if (!pageVisible) return;
    // `globalThis.KeyboardEvent` : le `KeyboardEvent` non qualifié désigne
    // ici celui de React (importé en tête de fichier), incompatible avec
    // `addEventListener`.
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "Tab") {
        e.preventDefault();
        cycleConversation(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === "Delete" && !e.shiftKey && activeSessionId && isConvTab(activeTab)) {
        e.preventDefault();
        closeConversationTab(activeSessionId);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // Ces fonctions lisent `openConversationIds`/`activeSessionId`/`activeTab` :
    // on réattache l'écouteur quand ils changent plutôt que de passer par des
    // refs, la liste d'onglets étant petite et rarement modifiée.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openConversationIds, activeSessionId, activeTab, pageVisible]);

  function handleOpenFile(path: string, name: string) {
    setOpenFilesNotice(null);
    if (openFiles.some((f) => f.path === path)) {
      applyActiveTab(path);
      return;
    }
    let files = openFiles;
    if (files.length >= MAX_OPEN_FILES) {
      const evictIdx = files.findIndex((f) => !f.dirty);
      if (evictIdx === -1) {
        setOpenFilesNotice("Fermez un onglet modifié avant d'en ouvrir un nouveau (max 6).");
        return;
      }
      files = files.filter((_, i) => i !== evictIdx);
    }
    const loadingEntry: OpenFileState = {
      path,
      name,
      kind: "loading",
      content: "",
      base64: "",
      size: 0,
      truncated: false,
      dirty: false,
      saving: false,
      saveError: null,
      errorMessage: null,
    };
    setOpenFiles([...files, loadingEntry]);
    setActiveTab(path);
    loadFileInto(path);
  }

  /**
   * Résout une référence de fichier cliquée dans une transcription (voir
   * Markdown.tsx `onFileRef`) et ouvre le fichier trouvé — ou affiche une
   * notice discrète (réutilise `openFilesNotice`, déjà rendue juste
   * au-dessus de la zone conversation/éditeur) sinon :
   *  - référence ABSOLUE (commence par `/`) : ouverte telle quelle si elle
   *    est sous `cwd`, sinon notice « hors du projet » (aucune tentative de
   *    lecture — on ne veut pas exposer le système de fichiers hors projet).
   *  - référence avec `/` : essayée d'abord comme `cwd/ref` — un
   *    `fsReadFile` de contrôle (pas juste `handleOpenFile`, qui ouvrirait
   *    un onglet en erreur plutôt que de retomber sur la recherche) décide
   *    du succès ; en cas d'échec, repli sur la recherche par nom de base.
   *  - nom nu (ou repli ci-dessus) : `fsFindByName(cwd, nom)`.
   */
  /* Wrappers à identité STABLE pour les composants mémoïsés (AgentTurnView /
     AgentBlockView / Markdown) : la dernière implémentation vit dans un ref,
     le useCallback sans dépendance garde la même référence à vie — sans quoi
     le memo serait inopérant (nouvelle fonction à chaque rendu). */
  const fileRefImpl = useRef<(ref: string) => void>(() => {});
  fileRefImpl.current = (ref) => void handleFileRef(ref);
  const stableFileRef = useCallback((ref: string) => fileRefImpl.current(ref), []);
  const releaseBackgroundImpl = useRef<() => void>(() => {});
  releaseBackgroundImpl.current = () => void handleReleaseBackground();
  const stableReleaseBackground = useCallback(() => releaseBackgroundImpl.current(), []);

  /*
   * Clic sur une référence citée dans la transcription. Toute la décision vit
   * dans refFichier.ts (T-024/T-049) : classement du chemin, registre
   * d'applications, repli sur la recherche par nom. Ici, l'adaptation au monde
   * réel — le disque, l'éditeur, l'encart d'avis.
   */
  async function handleFileRef(ref: string) {
    if (!cwd) return;
    await ouvrirReference(ref, {
      cwd,
      apps,
      lireFichier: fsReadFile,
      chercherParNom: fsFindByName,
      ouvrirDansEditeur: handleOpenFile,
      ouvrirDansApp: openExternal,
      avis: setOpenFilesNotice,
    });
  }

  function handleCloseTab(path: string, e: ReactMouseEvent) {
    e.stopPropagation();
    const file = openFiles.find((f) => f.path === path);
    if (file?.dirty && !window.confirm(`Fermer ${file.name} sans enregistrer les modifications ?`)) return;
    pendingLazyLoadsRef.current.delete(path);
    const idx = openFiles.findIndex((f) => f.path === path);
    const remaining = openFiles.filter((f) => f.path !== path);
    setOpenFiles(remaining);
    if (activeTab === path) {
      const fallback = remaining[idx] ?? remaining[idx - 1] ?? null;
      setActiveTab(fallback ? fallback.path : "conversation");
    }
  }

  /**
   * Renommage réussi dans l'arbre (fichier OU dossier — voir FileTree.tsx) :
   * met à jour les onglets ouverts et les connaissances épinglées dont le
   * chemin correspond à `oldPath` OU commence par ce préfixe (renommage d'un
   * dossier contenant des fichiers ouverts/épinglés).
   */
  function handleFileRenamed(oldPath: string, newPath: string) {
    setOpenFiles((prev) =>
      prev.map((f) => {
        const path = renamedPath(f.path, oldPath, newPath);
        if (path === f.path) return f;
        return { ...f, path, name: path.slice(path.lastIndexOf("/") + 1) || path };
      }),
    );
    setActiveTab((prev) => renamedPath(prev, oldPath, newPath));
    reecrirePins((list) => {
      let changed = false;
      const nextList = list.map((d) => {
        const path = renamedPath(d.path, oldPath, newPath);
        if (path === d.path) return d;
        changed = true;
        return { path, name: path.slice(path.lastIndexOf("/") + 1) || path };
      });
      return changed ? nextList : null;
    });
  }

  /**
   * Suppression réussie dans l'arbre (fichier OU dossier, DÉFINITIVE) : ferme
   * les onglets ouverts et retire les connaissances épinglées dont le chemin
   * correspond à `path` OU en est un descendant.
   */
  function handleFileDeleted(path: string) {
    setOpenFiles((prev) => prev.filter((f) => !isUnderPath(f.path, path)));
    setActiveTab((prev) => (isUnderPath(prev, path) ? "conversation" : prev));
    reecrirePins((list) => {
      const nextList = list.filter((d) => !isUnderPath(d.path, path));
      return nextList.length === list.length ? null : nextList;
    });
  }

  function handleFileContentChange(path: string, content: string) {
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)));
  }

  async function handleSaveFile(path: string) {
    const file = openFiles.find((f) => f.path === path);
    if (!file || file.kind !== "text" || file.truncated || file.saving) return;
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, saving: true, saveError: null } : f)));
    try {
      await fsWriteFile(path, file.content);
      setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, saving: false, dirty: false } : f)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, saving: false, saveError: message } : f)));
    }
  }

  function handleReloadFile(path: string) {
    const file = openFiles.find((f) => f.path === path);
    if (!file) return;
    if (file.dirty && !window.confirm(`Recharger ${file.name} et perdre les modifications non enregistrées ?`)) return;
    setOpenFiles((prev) => prev.map((f) => (f.path === path ? { ...f, kind: "loading", saveError: null } : f)));
    loadFileInto(path);
  }

  // Ctrl+S / Cmd+S enregistre l'onglet fichier actif.
  //
  // Garde `pageVisible` OBLIGATOIRE : toutes les pages restent montées en
  // permanence (voir `.page-slot--hidden`, App.tsx), donc cet écouteur GLOBAL
  // vivait même page masquée. Un Ctrl+S tapé par réflexe depuis Chat ou
  // Configuration écrivait alors sur disque un fichier ouvert dans Projets —
  // à l'insu de l'utilisateur, y compris un contenu qu'il n'avait
  // volontairement pas enregistré. Le raccourci Ctrl+Tab de cette même page
  // portait déjà cette garde ; celui-ci l'avait oubliée.
  useEffect(() => {
    if (!pageVisible) return;
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (activeTab !== "conversation") void handleSaveFile(activeTab);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, openFiles, pageVisible]);

  /* ---------- Badges de détection (.iaction/CLAUDE.md/.claude) ---------- */

  // Reçoit les entrées racine du `fs_list_dir` déjà fait par FileTree — pas
  // de second appel dédié. Identité stable (deps vides) : entre dans la
  // dépendance du `loadRoot` de FileTree, un callback instable y
  // provoquerait un rechargement de l'arbre à chaque rendu d'AgentPage.
  const handleRootEntries = useCallback((entries: DirEntry[]) => {
    const find = (name: string) => entries.find((e) => e.name === name)?.path ?? null;
    setProjectBadges({
      iactionPath: find(".iaction"),
      claudeMdPath: find("CLAUDE.md"),
      claudeDirPath: find(".claude"),
    });
  }, []);

  // Changement de projet : on efface les badges le temps que FileTree
  // recharge sa racine et rappelle `handleRootEntries`.
  useEffect(() => {
    setProjectBadges({ iactionPath: null, claudeMdPath: null, claudeDirPath: null });
  }, [cwd]);

  // API impérative pour la palette Ctrl+Maj+P (voir CommandPalette.tsx) : cette
  // page reste seule propriétaire de `selectedProjectId`/de la Map d'état
  // par projet (voir le commentaire d'en-tête de fichier) ; App.tsx ne
  // reçoit qu'un moyen de déclencher une bascule et de savoir si elle a été
  // acceptée.
  useImperativeHandle(ref, () => ({
    requestSelectProject: (id: string) => {
      if (streaming || !projects.some((p) => p.id === id)) return false;
      selectProject(id);
      return true;
    },
    getSelectedProjectPath: () => selectedProject?.path ?? null,
    newSession: () => handleNewSession(),
    clearConversation: () => clearConversation(),
    isStreaming: () => streaming,
    focusComposer: () => focusComposer(),
  }));

  const currentPermission = permissionQueue[0] ?? null;
  const activeFile = isConvTab(activeTab) ? null : (openFiles.find((f) => f.path === activeTab) ?? null);

  // Roving tabindex (WAI-ARIA APG) : onglets de fichiers (←/→) et liste de
  // sessions (↑/↓). Un seul élément tabbable par collection — l'onglet actif /
  // la session active (ou la plus récente), le dernier focusé tant qu'on
  // reste dans la collection.
  const tabsRoving = useRovingFocus<HTMLDivElement>({ selector: '[role="tab"]', orientation: "horizontal" });
  const sessionsRoving = useRovingFocus<HTMLUListElement>({ selector: ".session-item__title" });
  const sortedSessions = sortByRecent(sessions);
  const tabbableSessionId = sortedSessions.some((s) => s.id === activeSessionId)
    ? activeSessionId
    : sortedSessions[0]?.id;

  // Aucun projet déclaré : écran d'accueil dédié plutôt que la page vide. Le
  // retour correspondant est TOUT EN BAS, après le dernier hook — voir
  // `ecranSansProjet` avant le rendu principal.
  const aucunProjet = projectsLoadState !== "loading" && projects.length === 0;

  // Écran étroit au premier affichage : les sections secondaires démarrent
  // repliées (voir spec « reste simple » — calculé une fois, pas ré-évalué
  // au redimensionnement ; `SidebarSection` n'utilise `defaultOpen` qu'à son
  // propre montage, un changement ultérieur de cette valeur est sans effet).
  const isCompactViewport = typeof window !== "undefined" && window.innerWidth <= 900;

  // Commandes affichées par le menu « / » du composeur, filtrées/triées par
  // `matchSlashCommands` (préfixe puis sous-chaîne) — vide tant que le menu
  // n'est pas ouvert.
  const slashMatches = slashMenu.open ? matchSlashCommands(slashCommands, slashMenu.fragment) : [];
  const contextSize = contextTokens(turns);
  // R2 — en Auto, l'encart contexte affiche le modèle routé dès qu'il est connu.
  const contextModel = model === AUTO_MODEL ? (activeRuntime.routedTarget?.model ?? "auto") : model;
  // Encart « Contexte » de l'en-tête (voir contextBus.ts) : publié tant que
  // cette page vit, effacé au démontage pour ne pas laisser un chiffre orphelin.
  useEffect(() => {
    publishContext("agent", contextSize === null ? null : { model: contextModel, usedTokens: contextSize });
    return () => publishContext("agent", null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextSize, contextModel]);

  // Bouton « Compacter » de l'encart contexte (voir contextBus.ts) :
  // disponible hors tour en cours, sur une session du moteur Claude — l'action
  // envoie « /compact » au CLI (compaction native Claude Code), comme un tour
  // normal. Ref : handleSend est re-créée à chaque rendu, le handler
  // enregistré doit rester frais sans re-notifier le bus en boucle.
  const compactSendRef = useRef<() => void>(() => {});
  compactSendRef.current = () => {
    if (!streaming) {
      void handleSend("/compact");
      return;
    }
    // Tour en cours : « /compact » part en FILE (jamais handleSend avec
    // argument ici — ce chemin contourne la file et lancerait un envoi
    // concurrent). Dédoublonné : un seul /compact en attente à la fois.
    const convId = activeSessionId;
    if (!convId) return;
    updateRuntime(convId, (r) =>
      r.queuedPrompts.includes("/compact") ? r : { ...r, queuedPrompts: [...r.queuedPrompts, "/compact"] },
    );
  };
  useEffect(() => {
    const available = Boolean(activeSessionId) && engineProviderId === null;
    registerCompactHandler("agent", available ? () => compactSendRef.current() : null);
    return () => registerCompactHandler("agent", null);
  }, [activeSessionId, engineProviderId]);

  /*
   * Écran « aucun projet » — placé ICI, après le DERNIER hook du composant.
   *
   * Il vivait plus haut, au milieu de la liste des hooks : trois d'entre eux
   * (publication de l'encart contexte, ref et enregistrement du bouton
   * « Compacter ») restaient derrière ce retour. Le premier rendu, projets
   * encore en chargement, les exécutait ; le rendu suivant, une fois constaté
   * qu'il n'y a aucun projet, sortait avant eux — React comptait moins de
   * hooks qu'au rendu précédent et interrompait toute l'interface
   * (« Rendered fewer hooks than expected », incident du 2026-08-07).
   *
   * C'était donc aussi un plantage de PREMIÈRE INSTALLATION : sans projet
   * déclaré, l'écran d'accueil tuait l'application au lieu de s'afficher.
   *
   * Règle : dans ce composant, aucun `return` avant la fin — tout garde-fou
   * d'affichage se calcule en booléen (ici `aucunProjet`) et se rend ici.
   */
  if (aucunProjet) {
    return (
      <div className="page agent-page agent-page--empty">
        <div className="agent-empty-state">
          <h1 className="page__title">Projets</h1>
          <p className="empty-hint">Déclarez votre premier projet dans Configuration pour commencer.</p>
          <button type="button" className="btn" onClick={onGoToConfig}>
            Aller à Configuration
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="page agent-page">
      <div className="agent-layout">
        <SidebarRetractable id="projets-gauche" cote="left" libelle="de gauche">
          <SidebarSection id="project" title="Projet" defaultOpen={!isCompactViewport}>
            <div className="field">
              <label htmlFor="agent-project">Projet</label>
              <div className="sidebar-project-row">
                <select
                  id="agent-project"
                  value={selectedProjectId ?? ""}
                  disabled={streaming || projects.length === 0}
                  onChange={(e) => selectProject(e.currentTarget.value)}
                >
                  {projects.length === 0 && <option value="">Aucun projet</option>}
                  {projects.map((p) => (
                    <option key={p.id} value={p.id} title={p.path}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={onGoToConfig}
                  title="Déclarer un nouveau projet"
                  aria-label="Déclarer un nouveau projet"
                >
                  +
                </button>
              </div>
            </div>
            {selectedProject && <div className="sidebar-project-path">{selectedProject.path}</div>}
            {selectedProject &&
              (projectBadges.iactionPath || projectBadges.claudeMdPath || projectBadges.claudeDirPath) && (
                <div className="project-badges">
                  {projectBadges.iactionPath && (
                    <span
                      className="project-badge"
                      title="Dossier de config du projet — agents, doc IA, RAG (v2)"
                    >
                      ⚙ .iaction
                    </span>
                  )}
                  {projectBadges.claudeMdPath && (
                    <button
                      type="button"
                      className="project-badge project-badge--link"
                      title="Instructions projet — lues automatiquement par le moteur Claude"
                      onClick={() => handleOpenFile(projectBadges.claudeMdPath as string, "CLAUDE.md")}
                    >
                      📄 CLAUDE.md
                    </button>
                  )}
                  {projectBadges.claudeDirPath && (
                    <span
                      className="project-badge"
                      title="Config Claude Code existante — agents, commandes, permissions"
                    >
                      🤖 .claude/
                    </span>
                  )}
                </div>
              )}
          </SidebarSection>

          <SidebarSection id="files" title="Fichiers" defaultOpen={!isCompactViewport}>
            <div className="sidebar-filetree">
              <FileTree
                rootPath={cwd}
                onOpenFile={handleOpenFile}
                onRootEntries={handleRootEntries}
                apps={apps}
                onPinKnowledge={pinKnowledge}
                onFileRenamed={handleFileRenamed}
                onFileDeleted={handleFileDeleted}
              />
            </div>
          </SidebarSection>
        </SidebarRetractable>

        <div className="agent-main__content">
          <div
            className="agent-tabs"
            role="tablist"
            ref={tabsRoving.containerRef}
            onKeyDown={tabsRoving.onKeyDown}
            onFocus={tabsRoving.onFocus}
          >
            {openConversationIds.map((convId) => {
              const conv = sessions.find((s) => s.id === convId);
              if (!conv) return null;
              const tabId = convTabId(convId);
              const isActive = activeTab === tabId;
              const convStreaming = runtimes.consulter(convId)?.streaming === true;
              return (
                <div
                  key={convId}
                  className={`agent-tab agent-tab--conv${isActive ? " agent-tab--active" : ""}`}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  title={conv.title}
                  onClick={() => selectSession(convId)}
                  onKeyDown={(e) => {
                    // `target === currentTarget` : ne pas intercepter Entrée sur
                    // le bouton « × » interne (fermeture native du bouton).
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      selectSession(convId);
                    }
                  }}
                >
                  <span className="agent-tab__name">{conv.title}</span>
                  {convStreaming && (
                    <span
                      className="agent-tab__dot agent-tab__dot--streaming"
                      aria-label="Tour en cours"
                      title="Tour en cours"
                    />
                  )}
                  <button
                    type="button"
                    className="agent-tab__close"
                    aria-label={`Fermer l'onglet ${conv.title}`}
                    title={convStreaming ? "Impossible de fermer : tour en cours" : "Fermer l'onglet"}
                    disabled={convStreaming}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeConversationTab(convId);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="agent-tab agent-tab--new"
              onClick={() => handleNewSession()}
              aria-label="Nouvelle conversation"
              title="Nouvelle conversation (Ctrl+N)"
            >
              +
            </button>
            {openFiles.map((f) => (
              <div
                key={f.path}
                className={`agent-tab${activeTab === f.path ? " agent-tab--active" : ""}`}
                role="tab"
                aria-selected={activeTab === f.path}
                tabIndex={activeTab === f.path ? 0 : -1}
                title={f.path}
                onClick={() => applyActiveTab(f.path)}
                onKeyDown={(e) => {
                  // `target === currentTarget` : ne pas intercepter Entrée sur
                  // le bouton « × » interne (fermeture native du bouton).
                  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    applyActiveTab(f.path);
                  }
                }}
              >
                <span className="agent-tab__name">{f.name}</span>
                {f.dirty && <span className="agent-tab__dot" aria-hidden="true" title="Modifié" />}
                <button
                  type="button"
                  className="agent-tab__close"
                  aria-label={`Fermer ${f.name}`}
                  onClick={(e) => handleCloseTab(f.path, e)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          {openFilesNotice && <div className="agent-tabs__notice">{openFilesNotice}</div>}
          {clearedNotice && (
            <div className="agent-tabs__notice cleared-notice">
              Conversation vidée.
              <button type="button" className="btn btn--ghost cleared-notice__undo" onClick={undoClearConversation}>
                Annuler
              </button>
              <button
                type="button"
                className="cleared-notice__dismiss"
                onClick={() => setClearedNotice(false)}
                aria-label="Masquer"
                title="Masquer"
              >
                ×
              </button>
            </div>
          )}
          {/* R3 — bandeau de débord : posé au tour concerné, effacé dès que le
              routage redevient normal (voir applyDebordNotice). */}
          {debordNotice && (
            <div className={`agent-tabs__notice debord-notice${debordNotice.blocked ? " debord-notice--blocked" : ""}`}>
              {libelleDebordNotice(debordNotice)}
            </div>
          )}

          <div className="agent-tabs__body">
            {isConvTab(activeTab) ? (
              <div className="agent-conversation">
                <div className="chat-log" ref={scrollRef} {...scrollProps}>
                  {turns.length === 0 && (
                    <p className="empty-hint">
                      {cwd
                        ? "Aucun message. Décrivez la tâche à réaliser dans ce projet."
                        : "Choisissez d'abord un projet ci-dessus."}
                    </p>
                  )}
                  {turns.map((turn) => (
                    <AgentTurnView
                      key={turn.id}
                      turn={turn}
                      onFileRef={stableFileRef}
                      cwd={cwd}
                      onReleaseBackground={stableReleaseBackground}
                    />
                  ))}
                </div>

                <div
                  className={`chat-composer${composerDragOver ? " chat-composer--dragover" : ""}`}
                  onDragOver={(e) => {
                    if (streaming || !attachmentsSupported) return;
                    e.preventDefault();
                    setComposerDragOver(true);
                  }}
                  onDragLeave={() => setComposerDragOver(false)}
                  onDrop={(e) => {
                    if (streaming || !attachmentsSupported) return;
                    e.preventDefault();
                    setComposerDragOver(false);
                    const files = filesFromDrop(e);
                    if (files.length > 0) addFiles(files);
                  }}
                >
                  {slashMenu.open && slashMatches.length > 0 && (
                    <ul className="slash-menu" role="listbox">
                      {slashMatches.map((cmd, index) => (
                        <li
                          key={cmd.name}
                          role="option"
                          aria-selected={index === slashMenu.selected}
                          className={`slash-menu__item${index === slashMenu.selected ? " slash-menu__item--selected" : ""}`}
                          onMouseDown={(e) => {
                            // `onMouseDown` (pas `onClick`) : évite que le textarea perde le
                            // focus avant l'insertion, ce qui décalerait le repositionnement du curseur.
                            e.preventDefault();
                            applySlashCommand(cmd);
                          }}
                        >
                          <span className="slash-menu__name">/{cmd.name}</span>
                          {cmd.description && <span className="slash-menu__description">{cmd.description}</span>}
                          {cmd.argumentHint && <span className="slash-menu__hint">{cmd.argumentHint}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  {queuedPrompts.map((prompt, index) => (
                    <div
                      key={`${index}-${prompt}`}
                      className="composer-queued"
                      title="Envoyé automatiquement à la fin du tour en cours, dans l'ordre de la file"
                    >
                      <span className="composer-queued__label">
                        {queuedPrompts.length > 1 ? `En file ${index + 1}/${queuedPrompts.length} :` : "En file :"}
                      </span>
                      <span className="composer-queued__text">{prompt}</span>
                      <button
                        type="button"
                        className="composer-queued__cancel"
                        onClick={() => removeQueuedPrompt(index)}
                        aria-label="Retirer ce message de la file"
                        title="Retirer de la file"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <AttachmentTray items={attachments} onRemove={removeAttachment} />
                  {attachmentsError && (
                    <div className="result-line result-line--error">
                      {attachmentsError}
                      <button
                        type="button"
                        className="btn btn--ghost result-line__dismiss"
                        onClick={() => setAttachmentsError(null)}
                        aria-label="Masquer l'erreur"
                      >
                        ×
                      </button>
                    </div>
                  )}
                  {/* Erreur micro, progression de transcription, état du mode
                      conversation et messages discrets — voir VoiceControls.tsx. */}
                  <VoiceStatus voice={voice} />
                  <div className="chat-composer__row">
                    {/* Icônes d'action empilées EN COLONNE à gauche du textarea :
                        la zone de saisie récupère ainsi toute la largeur. */}
                    <div className="chat-composer__tools">
                      <AttachmentPickerButton
                        onFiles={(files) => addFiles(files)}
                        disabled={streaming || !cwd || !attachmentsSupported}
                        title={
                          attachmentsSupported
                            ? "Joindre des fichiers"
                            : "Pièces jointes disponibles uniquement avec le moteur Claude (abonnement)"
                        }
                      />
                      {/* Sans projet sélectionné, il n'y a personne à qui parler :
                          la voix est désactivée comme l'est la zone de saisie. */}
                      <VoiceButtons voice={voice} disabled={!cwd} />
                    </div>
                    {/* Semi-non-contrôlé (defaultValue + ref) : la frappe
                        n'impose plus un re-rendu de page par caractère — voir
                        useComposerLiveDraft.ts, qui pousse aussi les écritures
                        programmatiques (dictée, insertion « / », vidage…)
                        vers le DOM. */}
                    <textarea
                      ref={textareaRef}
                      rows={5}
                      defaultValue={draft}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        onComposerChange(value);
                        updateSlashMenu(value, e.currentTarget.selectionStart ?? value.length);
                      }}
                      onKeyDown={handleKeyDown}
                      onPaste={(e) => {
                        // Moteur neutre : les pièces jointes ne passent pas par
                        // `neutral.start` — on le DIT au lieu d'ignorer le collage
                        // en silence (l'utilisateur croyait la fonction absente).
                        if (!attachmentsSupported) {
                          if (clipboardHasImage(e)) {
                            e.preventDefault();
                            setAttachmentsError(
                              "Image collée ignorée : les pièces jointes ne sont disponibles qu'avec le moteur Claude (abonnement).",
                            );
                          }
                          return;
                        }
                        const files = filesFromClipboard(e);
                        if (files.length > 0) {
                          e.preventDefault();
                          addFiles(files);
                          return;
                        }
                        // Repli natif : sous WebKitGTK (Tauri Linux), une
                        // capture d'écran n'apparaît PAS dans `clipboardData`.
                        // On ne tente ce repli que si le presse-papier ne porte
                        // pas de texte (sinon c'est un collage de texte normal,
                        // et interroger l'image ferait clignoter une vignette
                        // pour rien).
                        if (e.clipboardData.getData("text/plain")) return;
                        // Vignette « en chargement » AFFICHÉE TOUT DE SUITE, puis
                        // remplie quand l'image arrive du presse-papier natif.
                        const placeholderId = beginImage("capture-collée.png");
                        if (!placeholderId) return; // plus de place
                        void readClipboardImage()
                          .then((bytes) => resolveImage(placeholderId, bytes))
                          .catch(() => resolveImage(placeholderId, null));
                      }}
                      disabled={!cwd}
                      placeholder={
                        streaming && canInject
                          ? "L'agent travaille… (Entrée envoie dans le tour en cours, pris en compte au prochain outil)"
                          : streaming
                            ? "L'agent travaille… (Entrée met votre message en file, envoyé à la fin du tour)"
                            : "Décrivez une tâche pour l'agent… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)"
                      }
                    />
                    <div className="actions chat-composer__envoi">
                      {streaming ? (
                        <>
                          <button type="button" className="btn btn--ghost" onClick={() => void handleAbort()}>
                            Arrêter
                          </button>
                          {/* Un SEUL bouton d'envoi pendant un tour (choix
                              utilisateur 2026-08-04) : handleSend glisse la
                              demande dans le tour en cours quand c'est possible
                              (claude.push) et la met en file sinon — le repli
                              est automatique, pas besoin de deux boutons. */}
                          <button
                            type="button"
                            className="btn"
                            onClick={() => void handleSend()}
                            disabled={brouillonVide || !cwd}
                            title={
                              canInject
                                ? "Glisser la demande dans le tour en cours (prise en compte au prochain outil)"
                                : "Mettre en file : envoyé automatiquement à la fin du tour en cours"
                            }
                          >
                            Envoyer
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => void handleSend()}
                          disabled={(brouillonVide && attachments.length === 0) || attachmentsPending || !cwd}
                          title={attachmentsPending ? "Image en cours de chargement…" : undefined}
                        >
                          Envoyer
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              activeFile && (
                <div className="file-editor">
                  <div className="file-editor__toolbar">
                    <span className="file-editor__path" title={activeFile.path}>
                      {activeFile.path}
                      {activeFile.truncated && " — fichier tronqué"}
                    </span>
                    <div className="file-editor__toolbar-actions">
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => handleReloadFile(activeFile.path)}
                        title="Recharger"
                        aria-label="Recharger le fichier"
                      >
                        ↻
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={() => void handleSaveFile(activeFile.path)}
                        disabled={activeFile.kind !== "text" || activeFile.truncated || activeFile.saving || !activeFile.dirty}
                        title="Enregistrer (Ctrl+S)"
                        aria-label="Enregistrer le fichier"
                      >
                        💾
                      </button>
                    </div>
                  </div>
                  {activeFile.truncated && activeFile.kind === "text" && (
                    <div className="file-editor__banner">Fichier tronqué (aperçu 2 Mo) — édition désactivée.</div>
                  )}
                  {activeFile.saveError && (
                    <div className="file-editor__banner file-editor__banner--error">
                      Erreur d'enregistrement : {activeFile.saveError}
                    </div>
                  )}
                  <div className="file-editor__content">
                    <FileEditorView file={activeFile} onChangeContent={handleFileContentChange} />
                  </div>
                </div>
              )
            )}
          </div>
        </div>

        <SidebarRetractable id="projets-droite" cote="right" libelle="des sessions">
          <SessionsSection
            sessions={sessions}
            sortedSessions={sortedSessions}
            activeSessionId={activeSessionId}
            tabbableSessionId={tabbableSessionId}
            streaming={streaming}
            providers={providers}
            editingSessionId={editingSessionId}
            editingSessionTitle={editingSessionTitle}
            setEditingSessionTitle={setEditingSessionTitle}
            commitEditSessionTitle={commitEditSessionTitle}
            cancelEditSessionTitle={cancelEditSessionTitle}
            startEditSessionTitle={startEditSessionTitle}
            confirmDeleteSessionId={confirmDeleteSessionId}
            setConfirmDeleteSessionId={setConfirmDeleteSessionId}
            deleteSession={deleteSession}
            selectSession={selectSession}
            handleNewSession={handleNewSession}
            sessionsRoving={sessionsRoving}
          />

          <LlmSection
            selectedAgentKey={selectedAgentKey}
            projectAgentsByScope={projectAgentsByScope}
            handleAgentSelectChange={handleAgentSelectChange}
            selectedAgent={selectedAgent}
            clearAgentSelection={clearAgentSelection}
            streaming={streaming}
            engineProviderId={engineProviderId}
            providers={providers}
            handleEngineChange={handleEngineChange}
            permissionMode={permissionMode}
            setPermissionMode={setPermissionMode}
            model={model}
            setModel={setModel}
            clearRoutedAffinity={clearRoutedAffinity}
            clearAttachments={clearAttachments}
            neutralModelsState={neutralModelsState}
            neutralModels={neutralModels}
            neutralFeaturedIds={neutralFeaturedIds}
            basculerFavoriNeutre={basculerFavoriNeutre}
            neutralModelsError={neutralModelsError}
            sessionId={sessionId}
            isCompactViewport={isCompactViewport}
          />

          <ConnaissancesSection
            injectedKnowledge={injectedKnowledge}
            knowledgeMode={knowledgeMode}
            changeKnowledgeMode={changeKnowledgeMode}
            selectedProjectId={selectedProjectId}
            streaming={streaming}
            knowledgeIdx={knowledgeIdx}
            cwd={cwd}
            indexingKnowledge={indexingKnowledge}
            knowledgeIndexProgress={knowledgeIndexProgress}
            knowledgeIndexError={knowledgeIndexError}
            handleIndexKnowledge={handleIndexKnowledge}
            pinnedKnowledge={pinnedKnowledge}
            autoKnowledgeDocs={autoKnowledgeDocs}
            claudeMdPath={projectBadges.claudeMdPath}
            claudeMemoryFiles={claudeMemoryFiles}
            handleOpenFile={handleOpenFile}
            unpinKnowledge={unpinKnowledge}
            pinKnowledge={pinKnowledge}
          />

          <SidebarSection
            id="mcp"
            title="MCP"
            defaultOpen={false}
            badge={mcpServerCount > 0 ? <span className="sidebar-section__count">{mcpServerCount}</span> : undefined}
          >
            <McpPanel
              cwd={cwd}
              usage={mcpUsage}
              reloadToken={mcpReloadToken}
              onServerCount={setMcpServerCount}
            />
          </SidebarSection>
        </SidebarRetractable>
      </div>

      {currentPermission && (
        <PermissionModal
          item={currentPermission}
          extraCount={permissionQueue.length - 1}
          onDecide={(decision, message, rememberTool) =>
            void handlePermissionDecision(decision, message, rememberTool)
          }
        />
      )}
    </div>
  );
});
