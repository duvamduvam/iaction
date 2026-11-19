/**
 * Moteur Claude — Lot 2.
 *
 * Pilote le Claude Agent SDK (@anthropic-ai/claude-agent-sdk) pour les tours de
 * conversation agentique (voir docs/protocol.md, section « Méthodes Lot 2 —
 * moteur Claude »).
 *
 * Règle absolue : une apiKey ne doit jamais être écrite sur disque, ni loguée
 * (même sur stderr) — y compris dans les messages d'erreur.
 *
 * Injection de dépendance : `createClaudeEngine({ queryFn })` construit un
 * moteur autonome (état en mémoire propre) à partir d'une fonction `query`
 * quelconque — c'est le point d'entrée que les tests utilisent pour injecter
 * un faux SDK. En usage normal, `resolveQueryFn()` choisit la fonction `query`
 * réelle du SDK, importée dynamiquement pour ne jamais toucher le SDK réel
 * (ni le sous-processus `claude`) lorsque les tests activent le mode faux via
 * la variable d'environnement `IACTION_FAKE_CLAUDE=1` (le module de
 * remplacement est désigné par `IACTION_FAKE_CLAUDE_MODULE`, un chemin
 * absolu vers un module ESM exportant `fakeQuery`).
 */

import os from "node:os";
import { isNonEmptyString, isPlainObject } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import { validateAttachments, type Attachment } from "./attachments.js";
import * as journal from "./journal.js";
import { createTurnPrompt } from "./claudeTurnPrompt.js";
import { OUTILS_CRON_INTERDITS } from "./reveilOutil.js";
import { buildStudioMcpServer, outilStudioSansValidation, type AskUserAnswer } from "./askUser.js";
import { appliquerSurQuery, executerClaudeSetModel, type PontChangerModele } from "./changerModele.js";
import { buildKnowledgeMcpServer } from "./knowledge.js";
import {
  buildRuntimeSnapshot,
  ensureMcpDoc,
  logMcpCall,
  prepareMcpForTurn, avisMcpEcartes,
  splitMcpToolName,
  writeMcpRuntime,
} from "./mcp.js";
import { ASK_USER_TOOL_NAME, composerInstructionSysteme, resumerPalette } from "./paletteTour.js";
import { ensureProjectDoc } from "./projectDoc.js";
import { recordUsageEvent } from "./usageStats.js";
import { recordClaudeWindowsSnapshot } from "./fenetresAbonnement.js";
import { metaAvecCompte, resoudreCompte } from "./compteClaude.js";
import { extractModelUsage } from "./claudeVentilation.js";
import { executerClaudeCommands } from "./claudeCommands.js";
import { resolveQueryFn } from "./claudeQueryFn.js";
import { executerClaudeTitreDiscussion } from "./titreDiscussion.js";
import { creerRegistrePushes, executerClaudePush, signalerPushesPerdus } from "./poussesEnAttente.js";
import { champsErreurApi, decorerErreurClaude, estMessageSynthetique, texteMessageAssistant } from "./diagnosticErreurClaude.js";
import { origineMessage } from "./claudeSousAgents.js";
import { armerAttenteTachesDeFond, BACKGROUND_WAIT_TIMEOUT_MS } from "./attenteTachesDeFond.js";
import { creerSuiviSousAgents, estLanceurSousAgent } from "./sousAgentsJournal.js";
import { creerRegistreRappels, preparerRappelSurAbandon, type DemandeurAbandon } from "./rappelInterruption.js";
import { effortValide, type NiveauEffort } from "./claudeEffort.js";
import {
  armerPlafondSilence,
  cloturerTourSansResultatFinal,
  enregistrerResultatFinal,
  diagnostiquerResultat,
  subtypePourInterface,
  type Interruption,
  type ResultatDeTour,
} from "./claudeFinDeTour.js";
import {
  captureUsageSnapshot,
  executerClaudeUsage,
  executerClaudeUsageInit,
  creerDepotUsage,
  type DepotUsageClaude,
} from "./claudeUsage.js";

export type {
  CanUseTool,
  ClaudeQuery,
  ClaudeQueryFn,
  ClaudeQueryOptions,
  PermissionResult,
  PermissionResultAllow,
  PermissionResultDeny,
} from "./claudeTypes.js";
export { extractContextTokens, extractUsage, summarizeToolResult, type Usage } from "./claudeMesures.js";
import type { CanUseTool, ClaudeQuery, ClaudeQueryFn, ClaudeQueryOptions, PermissionResult } from "./claudeTypes.js";
import { extractContextTokens, extractUsage, summarizeToolResult } from "./claudeMesures.js";
import { crochetsSecrets } from "./gardeSecrets.js";

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/**
 * Décoration d'un message d'erreur du moteur. Le classement vit désormais dans
 * `diagnosticErreurClaude.ts` (T-118), qui a ajouté aux deux familles d'origine
 * — abonnement, authentification — les deux qui manquaient : HTTPS intercepté
 * et API injoignable. Nom conservé pour les appelants et les tests existants.
 */
export const decorateAuthError = decorerErreurClaude;

// ---------------------------------------------------------------------------
// Moteur : createClaudeEngine({queryFn}) — état en mémoire isolé, injectable.
// MCP : lecture de .mcp.json, interrupteurs, secrets et allowlist vivent dans
// mcp.ts (prepareMcpForTurn) ; un fichier absent, invalide ou mal formé ne
// fait JAMAIS échouer le tour (docs/protocol.md, claude.start § MCP).
// ---------------------------------------------------------------------------

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
}

interface PendingQuestion {
  resolve: (answer: AskUserAnswer) => void;
}

interface RunState {
  query: ClaudeQuery;
  pendingPermissions: Map<string, PendingPermission>;
  /** Questions `mcp__studio__ask_user` en attente de réponse humaine (voir
      askUser.ts). Même espace d'identifiants et même méthode de réponse
      (`claude.permission`) que les permissions : côté UI, une question EST une
      modale bloquante de plus. `resolve` rend le texte au handler de l'outil. */
  pendingQuestions: Map<string, PendingQuestion>;
  permCounter: number;
  aborted: boolean;
  /** T-082 — pourquoi le tour a été COUPÉ, quand il l'a été : c'est ce que lit
      la clôture pour ne pas maquiller une interruption en panne. Distinct
      d'`aborted`, qui ne connaît que `claude.abort` et commande l'interrupt. */
  interruption: Interruption;
  abortDemandeur: DemandeurAbandon | null; // T-102 — pour le rappel du tour suivant (rappelInterruption.ts)
  /** Tour du modèle fini mais process gardé ouvert en attente des rapports de
      tâches de fond (voir le case "result") : seul état où claude.release agit. */
  waitingBackground: boolean;
  /** Ferme l'entrée streamée du tour (voir createTurnPrompt) : sans cet appel,
      le process CLI reste vivant en attente d'un message qui ne viendra pas. */
  closePrompt: () => void;
  /** S3/T-064 — glisse un message et ses pièces jointes dans le tour EN COURS. */
  pushPrompt: (text: string, attachments: Attachment[]) => void;
  /** T-207 — change modèle (+ effort) sur la query vivante : outil `changer_modele` ET requête `claude.setModel` (Annuler). Rejette si le SDK refuse. */
  appliquerModele: (modele: string, effort: NiveauEffort | null | undefined) => Promise<void>;
}

export interface ClaudeEngine {
  handleClaudeConfigure(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeStart(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void>;
  handleClaudePermission(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeAbort(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudePush(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeRelease(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeSetModel(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void>;
  handleClaudeUsage(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void;
  handleClaudeUsageInit(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void>;
  handleClaudeCommands(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void>;
  handleClaudeTitreDiscussion(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void>;
}

export function createClaudeEngine(deps: { queryFn: ClaudeQueryFn }): ClaudeEngine {
  const { queryFn } = deps;

  /** Clé API en mémoire uniquement — jamais écrite sur disque, jamais loguée. */
  let apiKey: string | null = null;

  /** Tours en cours, indexés par l'id de la requête claude.start correspondante. */
  const runs = new Map<string, RunState>();
  const rappelsInterruption = creerRegistreRappels(); // T-102 — rappel du tour suivant après un abandon (rappelInterruption.ts)

  function denyAllPending(run: RunState, message: string): void {
    for (const pending of run.pendingPermissions.values()) {
      pending.resolve({ behavior: "deny", message });
    }
    run.pendingPermissions.clear();
    // Une question restée sans réponse ne doit JAMAIS laisser le handler de
    // l'outil suspendu : on la clôt comme « ignorée ».
    for (const pending of run.pendingQuestions.values()) {
      pending.resolve({ answered: false, text: message });
    }
    run.pendingQuestions.clear();
  }

  function handleClaudeConfigure(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void {
    const rawKey = params.apiKey;
    if (rawKey === null || rawKey === undefined) {
      apiKey = null;
      emitter.done(id, { configured: false });
      return;
    }
    if (!isNonEmptyString(rawKey)) {
      emitter.error(id, "params.apiKey doit être une chaîne non vide ou null");
      return;
    }
    apiKey = rawKey;
    emitter.done(id, { configured: true });
  }

  async function handleClaudeStart(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): Promise<void> {
    const chatOnly = params.chatOnly === true;
    const webSearch = params.webSearch === true;
    // `mcp: false` — un agent d'orchestration peut refuser d'hériter du
    // .mcp.json du projet (champ `mcp` du manifeste, documenté de longue date
    // mais resté inerte jusqu'ici). Absent = hérite, comportement historique.
    const mcpAllowed = params.mcp !== false;
    // Un humain est-il devant l'écran pour répondre à une question de l'agent ?
    // Armé par la page Projets uniquement (voir askUser.ts).
    const interactive = params.interactive === true && !chatOnly;
    // T-207 — agent préréglé à modèle fixe (sélecteur grisé côté UI) : l'outil
    // `changer_modele` n'est pas exposé, pas de faux espoir pour le modèle.
    const modeleVerrouille = params.modeleVerrouille === true;
    // En mode chat pur, aucun outil ne touche au disque : un cwd neutre
    // (répertoire personnel) suffit si l'appelant n'en fournit pas.
    let cwd: string | null = null;
    if (isNonEmptyString(params.cwd)) {
      cwd = params.cwd;
    } else if (chatOnly) {
      cwd = os.homedir();
    }
    const prompt = params.prompt;
    if (!isNonEmptyString(cwd)) {
      emitter.error(id, "params.cwd manquant ou invalide");
      return;
    }
    if (!isNonEmptyString(prompt)) {
      emitter.error(id, "params.prompt manquant ou invalide");
      return;
    }

    const attachmentsValidation = validateAttachments(params.attachments);
    if (!attachmentsValidation.ok) {
      emitter.error(id, attachmentsValidation.message);
      return;
    }
    // Compte du tour (absent = perso) : inconnu ou indisponible, le tour est refusé.
    const compte = resoudreCompte(params.compte);
    if (!compte.ok) { emitter.error(id, compte.message); return; }
    journal.info("claude", "compte du tour", { reqId: id, fields: { compte: compte.compte } });
    const metaTour = metaAvecCompte(params.meta, compte.compte); // T-191 : l'événement d'usage porte le compte hors perso
    const sessionIdParam = params.sessionId;
    const modelParam = params.model;
    const permissionModeParam = params.permissionMode;
    const systemPromptParam = params.systemPrompt;
    // T-102 — rappel d'un abandon avec sous-agent en vol (rappelInterruption.ts).
    const rappelInterruption = rappelsInterruption.consommer(isNonEmptyString(sessionIdParam) ? sessionIdParam : null);
    const promptAvecRappel = rappelInterruption ? `${rappelInterruption}\n\n${prompt}` : prompt;
    // Entrée streamée TOUJOURS (pièces jointes ou non) : c'est ce qui garde le
    // process CLI en vie après le `result` — voir createTurnPrompt.
    const turnPrompt = createTurnPrompt(promptAvecRappel, attachmentsValidation.attachments);
    const promptForQuery: AsyncIterable<Record<string, unknown>> = turnPrompt.iterable;

    // Guide d'intégration déposé dans le projet (.iaction/connaissances/,
    // voir projectDoc.ts) : rafraîchi en début de tour projet, best effort.
    if (!chatOnly) {
      await ensureProjectDoc(cwd);
    }
    // Support MCP : <cwd>/.mcp.json filtré par les préférences locales
    // (interrupteurs, allowlist) et secrets résolus — voir mcp.ts. Jamais en
    // mode chat pur (le chat pur ne doit voir aucun outil, MCP compris).
    const preparedMcp =
      chatOnly || !mcpAllowed
        ? { servers: null, disabled: [], missingSecrets: [], disallowedTools: [] }
        : await prepareMcpForTurn(cwd);
    const mcpServers = preparedMcp.servers;
    const avisEcartes = avisMcpEcartes(preparedMcp); // serveur écarté faute de secret : dit DANS le tour
    if (avisEcartes) emitter.chunk(id, avisEcartes);

    // T-087 — comptabilité des push non acquittés de CE tour (voir poussesEnAttente.ts).
    const registrePushes = creerRegistrePushes();
    const runState: RunState = {
      // Initialisé juste après l'appel à queryFn ci-dessous.
      query: undefined as unknown as ClaudeQuery,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      permCounter: 0,
      aborted: false,
      interruption: null, abortDemandeur: null,
      waitingBackground: false,
      closePrompt: turnPrompt.close,
      // Posé juste après `queryFn` (le serveur MCP naît avant la query).
      appliquerModele: () => Promise.reject(new Error("le tour n'est pas encore démarré")),
      pushPrompt: (text, pushedAttachments) => {
        turnPrompt.push(text, pushedAttachments);
        registrePushes.enregistrer(text, pushedAttachments.length > 0);
      },
    };

    /**
     * Pont de l'outil `mcp__studio__ask_user` (voir askUser.ts) : émet la
     * question sur le canal `permission_request` (même charge utile que
     * l'`AskUserQuestion` intégré, que la modale de l'UI sait déjà rendre) et
     * attend le `claude.permission` correspondant. `allow` = réponse donnée,
     * `deny` = question ignorée.
     */
    const askUser = (questions: unknown): Promise<AskUserAnswer> => {
      return new Promise<AskUserAnswer>((resolve) => {
        runState.permCounter += 1;
        const permissionId = `perm-${runState.permCounter}`;
        runState.pendingQuestions.set(permissionId, { resolve });
        emitter.chunk(id, {
          kind: "permission_request",
          permissionId,
          toolName: ASK_USER_TOOL_NAME,
          toolInput: { questions },
        });
      });
    };
    // Question interactive : SEULEMENT quand un humain est devant l'écran
    // (`interactive`). Un tour headless (orchestration, planificateur) resterait
    // bloqué sur une question que personne ne verrait — là, le modèle doit
    // continuer à poser ses questions en texte.
    // T-207 — le même serveur `studio` porte aussi `changer_modele`. ÉCART à la
    // spec, assumé : réservé aux tours `interactive` (page Projets, un humain
    // voit le bandeau « Annuler »). Un tour headless (orchestration,
    // planificateur) changerait de modèle sans personne pour le voir, et sans
    // que `modeleVerrouille` (envoyé par la seule UI) protège le modèle fixé
    // par le manifeste de l'agent. Pour l'ouvrir aux tours headless : remplacer
    // `interactive` par `!chatOnly` dans la condition ci-dessous. T-216 :
    // `compacter` et `programmer_reveil` (T-219) suivent `interactive` mais PAS `modeleVerrouille` (compacterOutil.ts).
    let effortCourant: string | null = effortValide(params.effort) ?? null;
    const pontModele: PontChangerModele = {
      etat: () => ({ model: lastModel, effort: effortCourant }),
      appliquer: (modele, effortDemande) => runState.appliquerModele(modele, effortDemande),
      emettre: (changement) => emitter.chunk(id, { kind: "model_change", ...changement }),
      sessionId: () => lastSessionId,
    };
    const studio = await buildStudioMcpServer({
      ask: interactive ? askUser : null,
      changerModele: interactive && !modeleVerrouille ? pontModele : null,
      compacter: interactive ? { emettre: (raison) => emitter.chunk(id, { kind: "compaction_demandee", raison }), sessionId: () => lastSessionId } : null,
      reveil: interactive ? { emettre: (demande) => emitter.chunk(id, { kind: "reveil_demande", ...demande }), sessionId: () => lastSessionId } : null,
      secrets: !chatOnly,
    });
    // R5 — RAG local : serveur MCP in-process `iaction` (outil
    // `mcp__iaction__search_knowledge`, voir knowledge.ts), exposé SEULEMENT
    // quand l'index du projet existe — même flux de permission que les autres
    // outils MCP (canUseTool). Jamais en mode chat pur. T-185 : pont de question pour les sessions distantes.
    const knowledgeServer = chatOnly ? null : await buildKnowledgeMcpServer(cwd, { ...(interactive ? { demanderUtilisateur: askUser } : {}), compte: compte.compte, ...(isPlainObject(params.meta) && isNonEmptyString(params.meta.conversationId) ? { conversationId: params.meta.conversationId } : {}) }); // T-180 : conversation IAction = clé des sessions distantes sur relais

    const canUseTool: CanUseTool = (toolName, toolInput, toolOptions) => {
      // `ask_user`, `changer_modele`, `compacter`, `programmer_reveil` : sans modale (raisons dans askUser.ts).
      if (outilStudioSansValidation(toolName)) {
        return Promise.resolve({ behavior: "allow" });
      }
      return new Promise<PermissionResult>((resolve) => {
        runState.permCounter += 1;
        const permissionId = `perm-${runState.permCounter}`;
        runState.pendingPermissions.set(permissionId, { resolve });
        emitter.chunk(id, {
          kind: "permission_request",
          permissionId,
          toolName,
          toolInput,
        });

        const settleIfAborted = () => {
          if (runState.pendingPermissions.delete(permissionId)) {
            resolve({ behavior: "deny", message: "Tour interrompu" });
          }
        };
        if (toolOptions.signal.aborted) {
          settleIfAborted();
        } else {
          toolOptions.signal.addEventListener("abort", settleIfAborted, { once: true });
        }
      });
    };

    const options: ClaudeQueryOptions = {
      cwd,
      includePartialMessages: true,
      permissionMode: isNonEmptyString(permissionModeParam) ? permissionModeParam : "default",
      env: {
        ...process.env,
        ...compte.env, // CLAUDE_CONFIG_DIR du compte choisi (vide pour perso) — seul ajout, aucun jeton
        // Une question posée à l'humain occupe l'outil `ask_user` le temps
        // qu'il réponde : sans plafond relevé, le délai d'exécution des outils
        // MCP du CLI couperait la question au bout de quelques dizaines de
        // secondes. Aligné sur l'attente des tâches de fond (10 min). Seulement
        // sur les tours interactifs, et jamais si le poste l'a déjà fixé.
        ...(interactive && !process.env.MCP_TOOL_TIMEOUT
          ? { MCP_TOOL_TIMEOUT: String(BACKGROUND_WAIT_TIMEOUT_MS) }
          : {}),
        ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
      },
      canUseTool, hooks: chatOnly ? undefined : crochetsSecrets(cwd), // T-220 : garde des fichiers de secrets (gardeSecrets.ts)
    };
    if (chatOnly) {
      options.tools = webSearch ? ["WebSearch", "WebFetch"] : [];
    } else {
      // Moteur projet : les trois sources. Les skills et commandes GLOBAUX du
      // poste (~/.claude/skills, ~/.claude/commands) sont hérités par tous les
      // projets — un skill transverse comme grill-me n'a pas à être recopié
      // dans chaque projet. Contrepartie assumée : les réglages utilisateur
      // globaux (~/.claude/settings.json : permissions, effortLevel) entrent
      // aussi dans les tours de l'app. 'project' → CLAUDE.md du projet.
      options.settingSources = ["user", "project", "local"];
      // T-205 — Claude in Chrome TOUJOURS activé pour le moteur projet
      // (décision de David, 2026-11-07, risque accepté : un agent autonome
      // pilote le vrai Chrome et ses sessions ouvertes). Sans `--chrome`, le
      // CLI n'expose aucun outil `mcp__claude-in-chrome__*`.
      options.extraArgs = { chrome: null };
      // AskUserQuestion retiré : non fonctionnel via le SDK (voir le champ
      // `disallowedTools`) — le modèle pose ses questions en texte, ce qui
      // marche. Le mode chat pur n'a de toute façon aucun outil. S'y ajoutent
      // les outils MCP exclus par une allowlist locale (mcp.ts) : c'est le
      // seul levier pour n'exposer que 2 outils d'un serveur qui en a 15, donc
      // pour rendre au contexte ce que les serveurs bavards lui prennent.
      // T-219 — outils Cron du CLI interdits : ils meurent avec le tour (reveilOutil.ts).
      options.disallowedTools = ["AskUserQuestion", ...OUTILS_CRON_INTERDITS, ...preparedMcp.disallowedTools];
      // O1/T-003 — allowlist `tools:` du manifeste d'agent, enfin APPLIQUÉE :
      // elle était purement déclarative jusqu'au 2026-08-07 (un agent en
      // lecture seule recevait Write/Edit/Bash malgré tout, et les tâches de
      // fond tournent en `bypassPermissions`, sans garde-fou humain).
      //
      // C'est `tools` (base d'outils INTÉGRÉS exposée au modèle) et NON
      // `allowedTools` qu'il faut poser : ce dernier ne fait qu'auto-approuver
      // sans rien retirer de la palette — inopérant, donc, précisément sur les
      // tours `bypassPermissions` qui en avaient le plus besoin.
      const declaredTools = params.tools;
      if (Array.isArray(declaredTools) && declaredTools.every((t) => typeof t === "string")) {
        // Les outils MCP ne relèvent pas de `options.tools` : ils entrent par
        // `mcpServers` et se gouvernent par le champ `mcp` du manifeste (plus
        // l'allowlist locale de mcp.ts). On les écarte de la liste au lieu de
        // les laisser passer pour des noms d'outils intégrés inconnus — dont
        // `mcp__studio__ask_user` et `mcp__iaction__*`, qui restent donc
        // disponibles quelle que soit l'allowlist déclarée.
        options.tools = (declaredTools as string[]).filter((t) => !t.startsWith("mcp__"));
      }
    }
    if (isNonEmptyString(sessionIdParam)) {
      options.resume = sessionIdParam;
    }
    if (isNonEmptyString(modelParam)) {
      options.model = modelParam;
    }
    const effort = effortValide(params.effort); // effort de raisonnement, posé seulement s'il est valide (claudeEffort.ts)
    if (effort) options.effort = effort;
    // Instruction système, voir paletteTour.ts : preset Claude Code hors chat pur (T-052), annonce des outils `studio` armés (T-019, T-210).
    const instr = composerInstructionSysteme(isNonEmptyString(systemPromptParam) ? systemPromptParam : null, studio?.ask === true, !chatOnly, studio);
    if (instr) options.systemPrompt = instr;
    if (!chatOnly && (mcpServers || knowledgeServer || studio)) {
      // Les serveurs in-process s'ajoutent à ceux déclarés dans .mcp.json ;
      // un serveur du projet de même nom prime (pas d'écrasement).
      options.mcpServers = {
        ...(knowledgeServer ? { iaction: knowledgeServer } : {}),
        ...(studio ? { studio: studio.serveur } : {}),
        ...(mcpServers ?? {}),
      };
    }

    let query: ClaudeQuery;
    try {
      query = queryFn({ prompt: promptForQuery, options });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitter.error(id, decorateAuthError(message));
      return;
    }
    runState.query = query;
    // T-207 — la cible du pont de `changer_modele` : la query vient de naître.
    runState.appliquerModele = async (modele, effortDemande) => {
      await appliquerSurQuery(query, { model: lastModel, effort: effortCourant }, modele, effortDemande);
      lastModel = modele;
      if (effortDemande !== undefined) effortCourant = effortDemande;
    };
    runs.set(id, runState);

    let lastSessionId: string | null = isNonEmptyString(sessionIdParam) ? sessionIdParam : null;
    // Modèle « effectif » (Lot 8, tranche 1) : celui résolu par le SDK dans le
    // message system/init prime sur celui demandé, s'il est connu.
    let lastModel: string | null = isNonEmptyString(modelParam) ? modelParam : null;
    let sawResult = false;
    /** Départ du tour — sert la latence de démarrage (connexion des serveurs
        MCP comprise) rapportée dans le chunk `init`. */
    const turnStartedAt = Date.now();
    /** Appels d'outils MCP en vol : `toolUseId` → outil + horodatage, pour
        journaliser la durée réelle de chaque appel à la réception du résultat
        (observabilité : quels serveurs servent, lesquels traînent). */
    const inFlightMcpCalls = new Map<string, { server: string; tool: string; startedAt: number }>();
    /** Sous-agents lancés par CE tour (bloc `Task`/`Agent` du fil) en vol —
        voir sousAgentsJournal.ts (T-102 : un sous-agent pouvait tourner
        38 min sans UNE ligne de journal — le fil ne voit passer que son
        lancement et son tool_result, jamais le détail écarté depuis T-092). */
    const sousAgents = creerSuiviSousAgents();
    /** Passe à true sur le message `result` FINAL : provoque la sortie de la boucle (voir ce case). */
    let turnFinished = false;
    /** Tâches de fond vivantes (system/background_tasks_changed, sémantique REPLACE :
        chaque message remplace la liste entière). Tant qu'il en reste, un `result`
        ne clôt PAS le tour : le process doit vivre pour recevoir leurs rapports. */
    let backgroundTasks: { taskId: string; description: string }[] = [];
    /** Au moins un contenu assistant (texte, raisonnement, outil) vu sur ce tour :
        distingue un vrai tour d'un micro-tour interne du CLI (ex. livraison de
        notifications de tâches sur un resume) clos sans appel au modèle. */
    let sawAssistantOutput = false;
    /** Occupation de la fenêtre de contexte au DERNIER appel API du tour (usage
        du dernier message `assistant`) — voir extractContextTokens. Sert la
        jauge « Contexte » de l'en-tête, à la place du cumul du `result`. */
    let lastContextTokens: number | null = null;
    /** Au moins un delta de texte streamé depuis le dernier message `assistant`
        complet. Sert à repérer les messages assistant JAMAIS streamés — le CLI
        en synthétise (ex. « API Error: 529 Overloaded », model "<synthetic>")
        sans passer par stream_event : sans réémission ici, leur texte
        n'atteindrait jamais l'UI (tour « terminé sans résultat », vécu le
        2026-07-26 sur un 529). Remis à false après chaque message assistant. */
    let sawTextDeltaForCall = false;
    /** Dernier `result` NON final (tour en attente de tâches de fond, micro-tour
        vide) : repli émis si le flux se termine sans autre `result`. */
    let pendingResultDone: ResultatDeTour | null = null;
    /** Nombre de micro-tours vides ignorés (borné : au-delà, on clôt quand même). */
    let spuriousEmptyResults = 0;
    /** Garde-fou du micro-tour vide : si RIEN ne suit dans les 30 s, interrupt()
        fait retomber la boucle et le repli de fin de flux émet le résultat connu. */
    let emptyResultWatchdog: ReturnType<typeof setTimeout> | null = null;
    const clearEmptyResultWatchdog = () => {
      if (emptyResultWatchdog) {
        clearTimeout(emptyResultWatchdog);
        emptyResultWatchdog = null;
      }
    };
    /** Plafond de l'attente des tâches de fond (BACKGROUND_WAIT_TIMEOUT_MS) :
        armé quand un `result` arrive avec des tâches vivantes, désarmé par
        toute activité du flux (un rapport de tâche relance le tour). */
    let backgroundWaitWatchdog: ReturnType<typeof setTimeout> | null = null;
    const clearBackgroundWaitWatchdog = () => {
      if (backgroundWaitWatchdog) {
        clearTimeout(backgroundWaitWatchdog);
        backgroundWaitWatchdog = null;
      }
    };

    /**
     * Libère TOUT ce qu'un tour laisse derrière lui : les deux watchdogs, le
     * générateur d'entrée streamée, et le process CLI.
     *
     * Un seul endroit, appelé par CHAQUE sortie de la boucle — fin normale
     * comme chemin d'erreur. C'est la leçon d'un défaut réel : le `catch` du
     * flux SDK sortait par un `return` qui sautait ces trois nettoyages, et un
     * process `claude` de 100-200 Mo restait suspendu sur une entrée jamais
     * fermée, invisible, jusqu'au redémarrage du sidecar.
     *
     * Best effort de bout en bout : un tour déjà éteint rend `interrupt()`
     * inopérant, et c'est très bien — on ne veut pas qu'un nettoyage puisse
     * empêcher la fin d'un tour.
     */
    const nettoyerFinDeTour = (): void => {
      clearEmptyResultWatchdog();
      clearBackgroundWaitWatchdog();
      // Armé plus bas (sûr : jamais appelé avant). CE désarmement-ci couvre
      // tous les chemins de sortie — un minuteur orphelin retiendrait la boucle.
      plafondSilence.desarmer();
      // Fermer l'entrée AVANT l'interrupt : le générateur du prompt doit
      // pouvoir se terminer, sinon le process reste bloqué en attente.
      try {
        turnPrompt.close();
      } catch {
        // déjà fermé : sans conséquence
      }
      void query.interrupt().catch(() => {
        // process déjà éteint / interrupt non supporté : rien à faire.
      });
    };

    // La méthode d'usage du SDK est une requête de contrôle vers le processus
    // CLI : elle DOIT partir pendant que le tour est vivant. Après le message
    // `result`, le SDK ferme l'entrée du processus et l'appel échoue
    // (« ProcessTransport is not ready for writing », vérifié en réel) — d'où
    // une capture opportuniste sur chaque message assistant, sans blocage du
    // flux ni empilement (une seule requête en vol à la fois).
    let usageCaptureInFlight = false;
    const tryCaptureUsage = () => {
      if (usageCaptureInFlight) return;
      usageCaptureInFlight = true;
      captureUsageSnapshot(query)
        .then((snapshot) => {
          if (snapshot) {
            depotUsage.ecrire(snapshot, compte.compte);
            recordClaudeWindowsSnapshot(snapshot.windows, compte.compte);
          }
        })
        .finally(() => {
          usageCaptureInFlight = false;
        });
    };

    // Plafond de SILENCE TOTAL du flux SDK (voir claudeFinDeTour.ts) : un tour
    // sans le moindre message, pas même `system:init`, faisait attendre
    // l'interface pour toujours. Armé ici, désarmé au PREMIER message reçu.
    const plafondSilence = armerPlafondSilence({
      id, emitter, model: lastModel, sessionId: lastSessionId, meta: metaTour, auSilence: nettoyerFinDeTour,
    });

    try {
      for await (const message of query) {
        // Le SDK a parlé, quel qu'en soit le contenu : plus de plafond.
        plafondSilence.desarmer();
        if (!isPlainObject(message) || typeof message.type !== "string") {
          continue;
        }
        // Toute activité du flux désarme le garde-fou du micro-tour vide.
        clearEmptyResultWatchdog();
        // L'attente des tâches de fond ne se termine QUE sur une vraie reprise
        // du modèle (rapport de tâche → nouveau tour) : les messages de
        // service (background_tasks_changed, notifications) ne doivent ni
        // désarmer le plafond ni rendre claude.release inopérant alors que
        // l'UI affiche encore « Rendre la main ».
        if (message.type === "assistant" || message.type === "stream_event") {
          clearBackgroundWaitWatchdog();
          runState.waitingBackground = false;
        }
        // T-092 — tout ce qu'un sous-agent produit porte `parent_tool_use_id` :
        // c'est du travail du fil, ce n'est pas de la PAROLE du fil.
        const deSousAgent = origineMessage(message) === "sous-agent";
        // T-102 — même champ, gardé cette fois : quel sous-agent (quel `Task`
        // lanceur, voir sousAgentsJournal.ts) a produit CE message.
        const parentToolUseId =
          deSousAgent && typeof (message as { parent_tool_use_id?: unknown }).parent_tool_use_id === "string"
            ? (message as { parent_tool_use_id: string }).parent_tool_use_id
            : null;

        switch (message.type) {
          case "system": {
            if (message.subtype === "init") {
              if (typeof message.session_id === "string") {
                lastSessionId = message.session_id;
              }
              if (typeof message.model === "string") {
                lastModel = message.model;
              }
              // État RÉEL des serveurs MCP : `mcp_servers` ([{name, status}])
              // et `tools` (noms complets) du SDK. Jetés jusqu'ici — c'est ce
              // qui rendait impossible de distinguer « branché » de
              // « opérationnel » (serveur en panne, en attente d'auth, ou
              // connecté mais sans aucun outil).
              const snapshot = buildRuntimeSnapshot(
                message.mcp_servers,
                message.tools,
                new Date().toISOString(),
              );
              emitter.chunk(id, {
                kind: "init",
                sessionId: lastSessionId,
                model: typeof message.model === "string" ? message.model : null,
                mcpServers: snapshot.servers,
                mcpToolCount: snapshot.servers.reduce((sum, s) => sum + s.tools.length, 0),
                builtinToolCount: snapshot.builtinToolCount,
                startupMs: Date.now() - turnStartedAt,
              });
              if (!chatOnly && snapshot.servers.length > 0) {
                // Deux petites écritures attendues ici (et non détachées) :
                // l'UI recharge le panneau MCP dès ce chunk `init`, elle doit
                // trouver l'instantané déjà posé. Les deux fonctions sont
                // best effort et ne lèvent jamais. L'instantané sert aussi
                // l'allowlist du tour SUIVANT ; la fiche annonce les outils
                // au modèle (voir mcp.ts, renderMcpDoc).
                await writeMcpRuntime(cwd, snapshot);
                await ensureMcpDoc(cwd, snapshot);
                journal.info("claude", "serveurs MCP du tour", {
                  reqId: id,
                  fields: {
                    ...resumerPalette(snapshot.servers, ASK_USER_TOOL_NAME),
                    eteints: preparedMcp.disabled.length,
                    sansSecret: preparedMcp.missingSecrets.length,
                    ms: Date.now() - turnStartedAt,
                  },
                });
              }
            } else if (message.subtype === "background_tasks_changed") {
              // Liste COMPLÈTE des tâches de fond vivantes (REPLACE) : lancées
              // par le modèle (sous-agents en arrière-plan, jobs détachés).
              // Relayée à l'UI pour que l'utilisateur voie ce qui tourne.
              const tasks = Array.isArray(message.tasks) ? message.tasks : [];
              backgroundTasks = tasks.filter(isPlainObject).map((t) => ({
                taskId: typeof t.task_id === "string" ? t.task_id : "",
                description: typeof t.description === "string" ? t.description : "",
              }));
              emitter.chunk(id, {
                kind: "background_tasks",
                count: backgroundTasks.length,
                descriptions: backgroundTasks.map((t) => t.description).filter(Boolean),
              });
            } else if (message.subtype === "compact_boundary") {
              // Fin d'une compaction de contexte (« /compact » manuel ou
              // compaction automatique du CLI). Sans relais, le tour se clôt
              // sans aucun contenu et l'UI affichait « résultat vide du
              // moteur » — l'utilisateur ne savait pas que le travail avait
              // bien eu lieu (constaté le 2026-08-05).
              const meta = isPlainObject(message.compact_metadata) ? message.compact_metadata : {};
              emitter.chunk(id, {
                kind: "compact",
                trigger: typeof meta.trigger === "string" ? meta.trigger : "manual",
                preTokens: typeof meta.pre_tokens === "number" ? meta.pre_tokens : null,
              });
            }
            break;
          }
          case "stream_event": {
            const event = message.event;
            if (isPlainObject(event) && event.type === "content_block_delta" && !deSousAgent) {
              const delta = event.delta;
              if (isPlainObject(delta) && delta.type === "text_delta" && typeof delta.text === "string") {
                sawAssistantOutput = true;
                sawTextDeltaForCall = true;
                emitter.chunk(id, { kind: "text", delta: delta.text });
              } else if (
                isPlainObject(delta) &&
                delta.type === "thinking_delta" &&
                typeof delta.thinking === "string"
              ) {
                sawAssistantOutput = true;
                emitter.chunk(id, { kind: "thinking", delta: delta.thinking });
              }
            }
            break;
          }
          case "assistant": {
            // T-082 — le modèle reparle après un refus : le tour a survécu,
            // l'indicateur ne doit plus couvrir une panne survenue ensuite.
            if (runState.interruption === "refus") runState.interruption = null;
            const inner = message.message;
            // Usage de CET appel (une réponse modèle = un appel) : on retient le
            // dernier vu, seul reflet fidèle de l'occupation du contexte.
            if (isPlainObject(inner) && !deSousAgent) {
              const ctx = extractContextTokens(inner.usage);
              if (ctx !== null) lastContextTokens = ctx;
            }
            const content = isPlainObject(inner) ? inner.content : undefined;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (!isPlainObject(block) || typeof block.type !== "string") {
                  continue;
                }
                // Les blocs text/thinking d'un message STREAMÉ sont déjà émis
                // via les deltas stream_event (includePartialMessages: true) :
                // on ne les réémet pas, pour éviter la duplication du texte.
                // MAIS un message jamais streamé (aucun delta depuis le message
                // assistant précédent) doit être émis ici, sinon son texte est
                // perdu — cas réel : les messages d'erreur synthétisés par le
                // CLI (« API Error: 529 Overloaded », model "<synthetic>"),
                // qui étaient invisibles dans l'UI (« terminé sans résultat »).
                if (block.type === "text" && !sawTextDeltaForCall && !deSousAgent) {
                  const brut = typeof block.text === "string" ? block.text : "";
                  const text = texteMessageAssistant(inner, brut);
                  if (estMessageSynthetique(inner)) journal.warn("claude", "erreur d'API (message synthétique du CLI)", { reqId: id, fields: { ...champsErreurApi(brut), compte: compte.compte, model: lastModel, sessionId: lastSessionId } }); // T-215
                  if (text.trim()) { sawAssistantOutput = true; emitter.chunk(id, { kind: "text", delta: text }); }
                }
                if (block.type === "tool_use") {
                  sawAssistantOutput = true;
                  const toolUseId = typeof block.id === "string" ? block.id : null;
                  const toolName = typeof block.name === "string" ? block.name : null;
                  const mcp = toolName ? splitMcpToolName(toolName) : null;
                  if (toolUseId && mcp) {
                    inFlightMcpCalls.set(toolUseId, { ...mcp, startedAt: Date.now() });
                  }
                  if (deSousAgent) {
                    // T-102 — battement : compteur + dernier outil (jamais la liste retirée par T-092).
                    const battement = sousAgents.compterOutil(parentToolUseId, toolName);
                    if (battement) emitter.chunk(id, { kind: "sous_agent_battement", ...battement, instant: Date.now() });
                  } else {
                    emitter.chunk(id, { kind: "tool_use", toolUseId, toolName, toolInput: block.input ?? {} });
                    if (toolUseId && toolName && estLanceurSousAgent(toolName)) {
                      sousAgents.lancer(id, toolUseId, block.input);
                    }
                  }
                }
              }
            }
            // Prochain appel API : nouveau cycle deltas → message assistant.
            // Jamais sur un message de sous-agent (T-092) : le cycle du fil
            // n'est pas fini, et le rouvrir ici réémettait son texte en entier.
            if (deSousAgent) { sawAssistantOutput = true; break; }
            sawTextDeltaForCall = false;
            tryCaptureUsage();
            break;
          }
          case "user": {
            const inner = message.message;
            const content = isPlainObject(inner) ? inner.content : undefined;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (!isPlainObject(block) || block.type !== "tool_result") {
                  continue;
                }
                const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
                const isError = block.is_error === true;
                const summary = summarizeToolResult(block.content);
                // Un appel MCP terminé = une ligne de journal (serveur, outil,
                // durée, issue) : c'est ce qui permettra de répondre par des
                // faits à « quels serveurs servent vraiment ? ».
                const call = toolUseId ? inFlightMcpCalls.get(toolUseId) : undefined;
                let durationMs: number | null = null;
                if (call && toolUseId) {
                  inFlightMcpCalls.delete(toolUseId);
                  durationMs = Date.now() - call.startedAt;
                  logMcpCall({
                    server: call.server,
                    tool: call.tool,
                    durationMs,
                    ok: !isError,
                    resultChars: summary.length,
                  });
                }
                if (!deSousAgent) {
                  emitter.chunk(id, { kind: "tool_result", toolUseId, isError, summary, durationMs });
                  // T-087 — tool_result DU FIL = acquittement des push antérieurs.
                  registrePushes.acquitterSurToolResult();
                  // T-102 — ce tool_result clôt-il un sous-agent vu partir ?
                  const issue = !isError ? "ok" : runState.interruption === "abandon" ? "annulé" : "erreur";
                  sousAgents.terminer(id, toolUseId, issue);
                }
              }
            }
            break;
          }
          case "result": {
            sawResult = true;
            if (typeof message.session_id === "string") {
              lastSessionId = message.session_id;
            }
            const resultSubtype = typeof message.subtype === "string" ? message.subtype : "unknown";
            const resultUsage = extractUsage(message.usage);
            const diagnostic = diagnostiquerResultat(message, isNonEmptyString(sessionIdParam), runState.interruption); // T-187
            const doneData = {
              sessionId: lastSessionId,
              // T-102 — sur un abandon, l'UI reçoit la classe connue ici, jamais le
              // subtype brut (voir `subtypePourInterface`) ; le journal et l'usage
              // gardent `resultSubtype`, la cause technique exacte.
              subtype: subtypePourInterface(resultSubtype, runState.interruption),
              result: typeof message.result === "string" ? message.result : null,
              usage: resultUsage,
              // Occupation réelle de la fenêtre de contexte (dernier appel), à ne
              // pas confondre avec `usage` (cumul du tour) — voir
              // extractContextTokens. `null` si aucun appel modèle sur ce tour.
              contextTokens: lastContextTokens,
              totalCostUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
              ...diagnostic,
            };

            // Tour du modèle terminé mais des tâches de fond vivent encore :
            // le process DOIT rester ouvert — leurs rapports réveilleront
            // l'agent (task-notification → nouveau tour → nouveau `result`).
            // Clore ici les tuerait : incident du 2026-07-22, trois
            // explorations lancées en arrière-plan puis interrompues 5 s
            // après la fin du tour par l'interrupt de fin de claude.start.
            if (backgroundTasks.length > 0) {
              pendingResultDone = doneData;
              emitter.chunk(id, {
                kind: "background_wait",
                count: backgroundTasks.length,
                descriptions: backgroundTasks.map((t) => t.description).filter(Boolean),
              });
              // L'attente n'est PAS illimitée : claude.release (bouton « Rendre
              // la main ») ou ce plafond font retomber la boucle via interrupt(),
              // et le repli de fin de flux livre doneData. Sinon, une tâche de
              // fond qui ne finit jamais tenait le tour en otage.
              runState.waitingBackground = true;
              // T-155 — journalisé, et signalé à l'UI s'il expire (attenteTachesDeFond.ts).
              backgroundWaitWatchdog = armerAttenteTachesDeFond({
                id,
                emitter,
                taches: backgroundTasks,
                abandonner: () => {
                  turnPrompt.close();
                  query.interrupt().catch(() => undefined); // process déjà éteint : la boucle est déjà retombée.
                },
              });
              break;
            }

            // Micro-tour interne du CLI clos sans appel au modèle (0 token,
            // aucun contenu assistant — ex. livraison de notifications de
            // tâches sur un resume) : le VRAI tour, la réponse au message de
            // l'utilisateur, n'a pas encore eu lieu. On attend la suite au
            // lieu de clore une bulle vide ; borné (2 max) + garde-fou 30 s :
            // si rien ne vient, interrupt() fait retomber la boucle et le
            // repli de fin de flux émet ce résultat.
            const zeroUsage =
              !resultUsage || (resultUsage.inputTokens === 0 && resultUsage.outputTokens === 0);
            if (resultSubtype === "success" && !sawAssistantOutput && zeroUsage && spuriousEmptyResults < 2) {
              spuriousEmptyResults += 1;
              pendingResultDone = doneData;
              emptyResultWatchdog = setTimeout(() => {
                turnPrompt.close();
                query.interrupt().catch(() => {
                  // process déjà éteint : la boucle est déjà retombée.
                });
              }, 30_000);
              break;
            }

            // T-082 — usage + journal de la fin de tour : voir
            // claudeFinDeTour.ts, qui décide seul « panne ou interruption ».
            enregistrerResultatFinal({
              id,
              meta: metaTour,
              model: lastModel,
              sessionId: lastSessionId,
              subtype: resultSubtype,
              erreurs: diagnostic.erreurs,
              interruption: runState.interruption,
              usage: resultUsage,
              ventilation: extractModelUsage(message.modelUsage, lastModel),
              contextTokens: lastContextTokens,
              durationMs: Date.now() - turnStartedAt,
            });
            // T-087 — AVANT le done, jamais après (voir poussesEnAttente.ts).
            signalerPushesPerdus({ id, emitter, pushes: registrePushes.vider() });
            emitter.done(id, doneData);
            const snapshot = await captureUsageSnapshot(query);
            if (snapshot) {
              depotUsage.ecrire(snapshot, compte.compte);
              recordClaudeWindowsSnapshot(snapshot.windows, compte.compte);
            }
            // `result` final = fin du tour dans notre contrat (un tour = un
            // claude.start). Sans sortie EXPLICITE de la boucle, le `break`
            // ci-dessous ne quitterait que le `switch` : le for-await
            // continuerait d'attendre, le process CLI resterait vivant, et le
            // tour suivant, lancé avec `resume` sur cette même session encore
            // occupée, revenait immédiatement à vide (0 token) — symptôme
            // « bloqué ».
            turnFinished = true;
            break;
          }
          default:
            // Autres types de messages du SDK (hooks, notifications, tâches, ...) :
            // hors du contrat protocolaire du Lot 2, ignorés.
            break;
        }
        if (turnFinished) break;
      }
    } catch (err) {
      // `aSignale()` : le plafond de silence a déjà rendu son verdict, et
      // l'exception qui remonte n'est que l'écho de son interrupt — on ne
      // signale pas le même échec deux fois.
      if (!runState.aborted && !plafondSilence.aSignale()) {
        // T-076 — une exception au message vide (rare mais réel : certaines
        // erreurs du SDK n'en portent aucun) devenait un événement muet malgré
        // la trace de journal juste en dessous ; repli explicite plutôt que
        // silence.
        const message =
          (err instanceof Error ? err.message : "") || String(err) || "exception sans message";
        denyAllPending(runState, "Tour interrompu");
        runs.delete(id);
        recordUsageEvent({
          id,
          engine: "claude",
          method: "claude.start",
          providerId: null,
          model: lastModel,
          promptTokens: null,
          completionTokens: null,
          status: "error",
          // L4 — message brut de l'exception (la décoration d'auth ci-dessous
          // est une aide d'affichage, pas la cause).
          errorMessage: message,
          meta: metaTour,
        });
        // Une exception qui remonte du flux SDK est la façon la plus brutale
        // dont un tour meurt : elle DOIT laisser une pile dans le journal
        // (T-015). C'est le seul endroit où on la connaît encore.
        journal.error("claude", "exception pendant le tour Claude", {
          reqId: id,
          fields: { sessionId: lastSessionId, model: lastModel, erreur: message },
          stack: err instanceof Error ? err.stack : null,
        });
        // Nettoyage AVANT de sortir : ce chemin d'erreur sautait tout ce qui
        // suit la boucle (fermeture de l'entrée streamée, interrupt du CLI,
        // désarmement des watchdogs). Une exception du flux avec un process
        // CLI encore vivant laissait donc un `claude` orphelin de 100-200 Mo,
        // suspendu sur une entrée jamais fermée, jusqu'au redémarrage du
        // sidecar — et un watchdog armé pouvait tirer 10 min plus tard sur une
        // query morte.
        nettoyerFinDeTour();
        // T-087 — même règle que le `result` normal : avant l'error, jamais après.
        signalerPushesPerdus({ id, emitter, pushes: registrePushes.vider() });
        emitter.error(id, decorateAuthError(message));
        return;
      }
      // Exception survenue après un abort : on l'ignore, le done ci-dessous
      // (subtype "aborted") tient lieu de fin de tour.
    }

    // Fin de tour : on coupe explicitement le process CLI. À ce stade il n'y a
    // plus de tâche de fond légitime (un `result` reçu avec des tâches vivantes
    // ne sort PAS de la boucle, voir le case "result") — l'interrupt ne tue
    // donc que d'éventuels résidus. Best effort : un tour déjà terminé peut
    // rendre `interrupt()` inopérant, sans conséquence.
    nettoyerFinDeTour();
    denyAllPending(runState, "Tour interrompu");
    runs.delete(id);
    preparerRappelSurAbandon(rappelsInterruption, runState.interruption === "abandon", runState.abortDemandeur, lastSessionId, sousAgents.instantane()); // T-102 — pour le PROCHAIN tour, pas de contrainte d'ordre avec done/error

    if (!turnFinished && !plafondSilence.aSignale()) {
      // T-087 — clôture ANORMALE (abort/silence) : avant le done/error à venir.
      signalerPushesPerdus({ id, emitter, pushes: registrePushes.vider() });
      // Fin ANORMALE : voir claudeFinDeTour.ts — un tour qui rate laisse un
      // événement d'usage, une ligne de journal `error` et un message à
      // l'interface, jamais le silence (T-015).
      cloturerTourSansResultatFinal({
        id,
        emitter,
        meta: metaTour,
        model: lastModel,
        sessionId: lastSessionId,
        contextTokens: lastContextTokens,
        pendingResult: pendingResultDone,
        sawResult,
        aborted: runState.aborted,
        interruption: runState.interruption,
        sawAssistantOutput,
      });
    }
  }

  function handleClaudePermission(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void {
    const targetId = params.targetId;
    const permissionId = params.permissionId;
    const decision = params.decision;
    if (!isNonEmptyString(targetId) || !isNonEmptyString(permissionId)) {
      emitter.error(id, "params.targetId et params.permissionId sont requis");
      return;
    }
    if (decision !== "allow" && decision !== "deny") {
      emitter.error(id, "params.decision doit être 'allow' ou 'deny'");
      return;
    }

    const run = runs.get(targetId);
    // Question interactive (mcp__studio__ask_user) : même méthode de réponse,
    // mais le message est la RÉPONSE rendue au modèle, pas un motif de refus.
    const question = run?.pendingQuestions.get(permissionId);
    if (run && question) {
      run.pendingQuestions.delete(permissionId);
      const message = isNonEmptyString(params.message) ? params.message : "";
      question.resolve({ answered: decision === "allow" && message !== "", text: message });
      emitter.done(id, { applied: true });
      return;
    }

    const pending = run?.pendingPermissions.get(permissionId);
    if (!run || !pending) {
      emitter.done(id, { applied: false });
      return;
    }
    run.pendingPermissions.delete(permissionId);

    if (decision === "allow") {
      pending.resolve({ behavior: "allow" });
    } else {
      // T-082 — un refus coupe généralement le tour côté CLI, et le SDK rend
      // alors `error_during_execution` : sans cet indicateur, un usage
      // parfaitement normal était compté comme une panne. Un abandon déjà
      // posé prime (il est définitif) ; l'indicateur s'efface si le modèle
      // reparle malgré le refus (voir le cas `assistant`).
      if (run.interruption === null) run.interruption = "refus";
      const message = isNonEmptyString(params.message) ? params.message : "Refusé par l'utilisateur";
      pending.resolve({ behavior: "deny", message });
    }
    emitter.done(id, { applied: true });
  }

  function handleClaudeAbort(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void {
    const targetId = params.targetId;
    if (!isNonEmptyString(targetId)) {
      emitter.error(id, "params.targetId manquant ou invalide");
      return;
    }
    const run = runs.get(targetId);
    // T-102 — un « arrêt demandé » ne laissait AUCUNE trace : ni qui, ni
    // quand. `reqId: targetId` rattache la ligne au journal du tour visé
    // (même reqId que ses autres lignes, ex. « serveurs MCP du tour »).
    // L'origine se lit dans id/targetId : l'orchestrateur (timeout de run,
    // orch.abort) rappelle TOUJOURS avec `id === targetId` (voir
    // orchestrator.ts, `stepRunner.abort(engine, info.internalId, {targetId:
    // info.internalId}, …)`) ; un abandon posé par l'UI porte un id de
    // requête protocolaire distinct.
    const demandeur: DemandeurAbandon = id === targetId ? "orchestration" : "protocole"; // T-102 — repris dans abortDemandeur
    journal.info("claude", "abandon demandé", {
      reqId: targetId,
      fields: { demandeur, trouve: run !== undefined },
    });
    if (!run) {
      emitter.done(id, { aborted: false });
      return;
    }
    run.aborted = true;
    run.interruption = "abandon";
    run.abortDemandeur = demandeur;
    denyAllPending(run, "Tour interrompu");
    run.closePrompt();
    run.query.interrupt().catch(() => {
      // interrupt() peut rejeter si le tour est déjà terminé : sans conséquence,
      // le done du tour (émis par la boucle handleClaudeStart) fait foi.
    });
    emitter.done(id, { aborted: true });
  }

  // S3/T-064/T-087 — `claude.push` (glisser une demande + pièces jointes dans
  // le tour EN COURS) est entièrement porté par `executerClaudePush`, voir
  // poussesEnAttente.ts : même raison qu'usage/commands (Étape 9), un
  // handler qui ne lit/écrit QUE `runs` n'a pas à vivre dans ce fichier.

  /** Rendre la main pendant l'attente des rapports de tâches de fond : clôt le
      tour SANS le marquer interrompu — interrupt() fait retomber la boucle de
      handleClaudeStart, dont le repli de fin de flux livre le résultat déjà
      connu (pendingResultDone). Refusé (released:false) hors de cette phase :
      en pleine génération, couper le tour est le rôle de claude.abort. */
  function handleClaudeRelease(
    id: string,
    params: Record<string, unknown>,
    emitter: EngineEmitter,
  ): void {
    const targetId = params.targetId;
    if (!isNonEmptyString(targetId)) {
      emitter.error(id, "params.targetId manquant ou invalide");
      return;
    }
    const run = runs.get(targetId);
    if (!run || !run.waitingBackground) {
      emitter.done(id, { released: false });
      return;
    }
    journal.info("claude", "tâches de fond abandonnées : l'utilisateur rend la main", { reqId: targetId });
    run.closePrompt();
    run.query.interrupt().catch(() => {
      // interrupt() peut rejeter si le process est déjà éteint : sans
      // conséquence, le done du tour (repli de handleClaudeStart) fait foi.
    });
    emitter.done(id, { released: true });
  }

  // T-207 — `claude.setModel` (bouton « Annuler » du bandeau de changement de
  // modèle) : porté par `executerClaudeSetModel`, voir changerModele.ts.

  /**
   * Étape 9 — usage et commands vivent désormais dans claudeUsage.ts /
   * claudeCommands.ts. La fermeture ne garde que ce qu'elle POSSÈDE :
   * le dépôt d'instantanés (un relevé PAR COMPTE, écrit aussi par
   * handleClaudeStart en fin de tour), `queryFn` et `apiKey` injectés à
   * l'appel — UNE seule instance moteur, jamais d'état dupliqué.
   */
  const depotUsage: DepotUsageClaude = creerDepotUsage();

  return {
    handleClaudeConfigure,
    handleClaudeStart,
    handleClaudePermission,
    handleClaudeAbort,
    handleClaudePush: (id, params, emitter) => executerClaudePush(runs, id, params, emitter),
    handleClaudeSetModel: (id, params, emitter) => executerClaudeSetModel(runs, id, params, emitter),
    handleClaudeRelease,
    handleClaudeUsage: (id, params, emitter) => executerClaudeUsage(depotUsage, id, params, emitter),
    handleClaudeUsageInit: (id, params, emitter) =>
      executerClaudeUsageInit({ queryFn, depot: depotUsage }, id, params, emitter),
    handleClaudeCommands: (id, params, emitter) =>
      executerClaudeCommands({ queryFn, apiKey: () => apiKey, decorerErreurAuth: decorateAuthError }, id, params, emitter),
    handleClaudeTitreDiscussion: (id, params, emitter) =>
      executerClaudeTitreDiscussion({ queryFn }, id, params, emitter),
  };
}

const enginePromise: Promise<ClaudeEngine> = resolveQueryFn().then((queryFn) =>
  createClaudeEngine({ queryFn }),
);

export async function handleClaudeConfigure(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudeConfigure(id, params, emitter);
}

export async function handleClaudeStart(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  await engine.handleClaudeStart(id, params, emitter);
}

export async function handleClaudePermission(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudePermission(id, params, emitter);
}

export async function handleClaudeAbort(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudeAbort(id, params, emitter);
}

export async function handleClaudePush(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudePush(id, params, emitter);
}

export async function handleClaudeRelease(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudeRelease(id, params, emitter);
}

export async function handleClaudeSetModel(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  await engine.handleClaudeSetModel(id, params, emitter);
}

export async function handleClaudeUsage(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  engine.handleClaudeUsage(id, params, emitter);
}

export async function handleClaudeUsageInit(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  await engine.handleClaudeUsageInit(id, params, emitter);
}

export async function handleClaudeTitreDiscussion(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  await engine.handleClaudeTitreDiscussion(id, params, emitter);
}

export async function handleClaudeCommands(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const engine = await enginePromise;
  await engine.handleClaudeCommands(id, params, emitter);
}
