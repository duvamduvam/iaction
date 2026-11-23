/**
 * Sidecar Node — Lot 0.
 *
 * Protocole JSON Lines sur stdio (voir docs/protocol.md) :
 * - stdout est réservé aux événements du protocole (une ligne JSON par événement).
 * - stderr reçoit tous les logs libres (relayés en event Tauri `sidecar:log`).
 * - Le sidecar ne crashe jamais sur une entrée invalide : il logue et ignore.
 *
 * L1 — la journalisation passe par `journal.ts` (niveau + scope + persistance
 * dans `logs/app.jsonl`), qui émet AUSSI la forme lisible sur stderr : le
 * relais ci-dessus est donc inchangé. Voir docs/protocol.md, section
 * « Méthodes L1 — journal applicatif (logs) ».
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  handleChatAbort,
  handleChatSend,
  handleModelsDetail,
  handleModelsList,
  handleOllamaLoad,
  handleOllamaPs,
  handleOllamaUnload,
  handleProvidersSet,
  type EngineEmitter,
} from "./engine.js";
import { handleUsageCredits } from "./creditsFournisseur.js";
import {
  handleClaudeAbort,
  handleClaudeCommands,
  handleClaudeConfigure,
  handleClaudePermission,
  handleClaudePush,
  handleClaudeSetModel,
  handleClaudeRelease,
  handleClaudeStart,
  handleClaudeTitreDiscussion,
  handleClaudeUsage,
  handleClaudeUsageInit,
} from "./claude.js";
import { executerClaudeComptes } from "./compteClaude.js";
import { isNonEmptyString, isPlainObject } from "./base.js";
import { migrerDepuisAncienNom } from "./appPaths.js";
import { handleContextCompact } from "./context.js";
import { flushWrites } from "./jsonlStore.js";
import * as journal from "./journal.js";
import { handleLogAppend, handleLogPurge, handleLogRead, handleLogStats } from "./logs.js";
import { handleKnowledgeIndex, handleKnowledgeSearch, handleKnowledgeStatus } from "./knowledge.js";
import { handleMcpSetServer, handleMcpStatus } from "./mcp.js";
import { handleMcpAdd, handleMcpCatalog, handleMcpRemove } from "./mcpCatalog.js";
import {
  definirCanalCoquille,
  handleCoffreCharger,
  handleCoffreEcrit,
  handleMcpSecretDelete,
  handleMcpSecretSet,
  handleMcpSecretsList,
} from "./mcpSecrets.js";
import {
  handleInventaireEnv,
  handleMigrerEnv,
  handleReferencesTaches,
  handleSupprimerEnv,
  handleTachesSansSecrets,
} from "./inventaireEnv.js";
import { fermer as fermerTour, handleCoffreAttendreFin, ouvrirSiTour } from "./toursActifs.js";
import { handleProjectEnsureDoc } from "./projectDoc.js";
import { handleNeutralAbort, handleNeutralPermission, handleNeutralStart } from "./neutralAgent.js";
import { handleRouterRoute, handleRouterSet } from "./router.js";
import { handleUsageStats } from "./usageStats.js";
import { redirigerConsoleVersStderr } from "./consoleVersStderr.js";
import { handleUsageClaudeHistory } from "./fenetresAbonnement.js";
import {
  handleAgentsDelete,
  handleAgentsList,
  handleAgentsRead,
  handleAgentsWrite,
  handleOrchAbort,
  handleOrchDelete,
  handleOrchList,
  handleOrchPermission,
  handleOrchRead,
  handleOrchRun,
  handleOrchWrite,
} from "./orchestrator.js";
import {
  handleTachesDelete,
  handleTachesList,
  handleTachesRead,
  handleTachesReportRead,
  handleTachesReports,
  handleTachesWrite,
} from "./taches.js";
import { handleTachesTimerApply, handleTachesTimerRemove, handleTachesTimerStatus } from "./tachesTimers.js";
import { handleTicketsList } from "./tickets.js";
import { balayerFilsInactifs, handleSessionsDistantesArchiverConversation } from "./filsSessionsDistantes.js";
import { handleSpeechConfigure, handleSpeechSynthesize, handleSpeechTranscribe } from "./speech.js";
import { signalerPeremption } from "./peremption.js";
import { handleMajVerifier } from "./maj.js";
import {
  arreterVeilleurPourSortir,
  definirNotificationVeilleur,
  demarrerVeilleurAuLancement,
  handleVeilleurActiver,
  handleVeilleurConfigurer,
  handleVeilleurDesactiver,
  handleVeilleurLire,
  handleVeilleurOublier,
  handleVeilleurStatut,
} from "./veilleurProtocole.js";

/**
 * T-016 — la version est LUE, plus recopiée.
 *
 * Cette constante est restée à « 0.1.0 » pendant que le reste du dépôt passait
 * à 0.2.0 : l'événement `ready` annonçait donc une version fausse, et personne
 * ne pouvait s'en apercevoir puisque rien ne l'affiche encore. Un numéro
 * recopié à la main finit toujours par mentir. `package.json` voyage avec le
 * sidecar (le bundle en emporte un — voir scripts/preparer-bundle.sh), et le
 * repli n'invente pas de numéro : il dit qu'il ne sait pas.
 */
function lireVersion(): string {
  try {
    const ici = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(ici, "..", "package.json"), "utf8")).version ?? "inconnue";
  } catch {
    return "inconnue";
  }
}

const VERSION = lireVersion();

// T-170 — aucune trace de bibliothèque (`console.log`) sur stdout, canal du protocole.
redirigerConsoleVersStderr();

// ---------------------------------------------------------------------------
// Émission d'événements (stdout uniquement)
// ---------------------------------------------------------------------------

// `coffre:ecrire` / `coffre:retirer` : demandes adressées à la COQUILLE (coffre
// de secrets), interceptées par Rust et jamais relayées à l'interface.
// `veilleur` : non sollicité (sans id, comme `ready`), le statut du veilleur à chaque changement.
type EventName = "ready" | "chunk" | "done" | "error" | "coffre:ecrire" | "coffre:retirer" | "veilleur";

interface OutgoingEvent {
  id?: string;
  event: EventName;
  data: unknown;
}

function emit(evt: OutgoingEvent): void {
  process.stdout.write(JSON.stringify(evt) + "\n");
  // Fin d'une requête : si c'était un tour, il ne compte plus (toursActifs.ts).
  if (evt.id !== undefined && (evt.event === "done" || evt.event === "error")) {
    fermerTour(evt.id);
  }
}

function emitDone(id: string, data: unknown = {}): void {
  emit({ id, event: "done", data });
}

function emitError(id: string, message: string): void {
  emit({ id, event: "error", data: { message } });
}

/**
 * T-169 — « méthode inconnue » porte un `code` stable : l'interface peut y
 * reconnaître un sidecar plus ancien qu'elle sans analyser une phrase.
 * `message` garde son préfixe historique (des appelants le testent encore).
 */
const CODE_METHODE_INCONNUE = "methode_inconnue";

function emitMethodeInconnue(id: string, method: string): void {
  emit({ id, event: "error", data: { message: `méthode inconnue: ${method}`, code: CODE_METHODE_INCONNUE } });
}

function emitChunk(id: string, data: unknown): void {
  emit({ id, event: "chunk", data });
}

const engineEmitter: EngineEmitter = {
  chunk: emitChunk,
  done: (id, data) => emitDone(id, data ?? {}),
  error: emitError,
};

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Méthodes
// ---------------------------------------------------------------------------

async function handlePing(id: string): Promise<void> {
  emitDone(id, { pong: true });
}

async function handleStreamEcho(
  id: string,
  params: Record<string, unknown>,
): Promise<void> {
  const text = params.text;
  if (!isNonEmptyString(text) || text.trim().length === 0) {
    emitError(id, "params.text manquant ou vide");
    return;
  }

  const rawDelay = params.delayMs;
  const delayMs =
    typeof rawDelay === "number" && Number.isFinite(rawDelay)
      ? Math.min(1000, Math.max(0, rawDelay))
      : 80;

  const words = text.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (i > 0) {
      await sleep(delayMs);
    }
    emitChunk(id, { text: words[i] + " " });
  }
  emitDone(id);
}

async function dispatch(
  id: string,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  try {
    switch (method) {
      case "ping":
        await handlePing(id);
        break;
      // La version courante est passée EN ARGUMENT plutôt que relue par le
      // module : `VERSION` est déjà la seule vérité du sidecar (T-016), et
      // deux lectures du même package.json finiraient par diverger.
      case "maj.verifier":
        await handleMajVerifier(id, VERSION, engineEmitter);
        break;
      case "stream.echo":
        await handleStreamEcho(id, params);
        break;
      case "providers.set":
        handleProvidersSet(id, params, engineEmitter);
        break;
      case "models.list":
        await handleModelsList(id, params, engineEmitter);
        break;
      case "models.detail":
        await handleModelsDetail(id, params, engineEmitter);
        break;
      case "chat.send":
        await handleChatSend(id, params, engineEmitter);
        break;
      case "chat.abort":
        handleChatAbort(id, params, engineEmitter);
        break;
      case "context.compact":
        await handleContextCompact(id, params, engineEmitter);
        break;
      case "router.set":
        handleRouterSet(id, params, engineEmitter);
        break;
      case "router.route":
        await handleRouterRoute(id, params, engineEmitter);
        break;
      case "knowledge.index":
        await handleKnowledgeIndex(id, params, engineEmitter);
        break;
      case "knowledge.search":
        await handleKnowledgeSearch(id, params, engineEmitter);
        break;
      case "knowledge.status":
        await handleKnowledgeStatus(id, params, engineEmitter);
        break;
      case "mcp.status":
        await handleMcpStatus(id, params, engineEmitter);
        break;
      case "mcp.setServer":
        await handleMcpSetServer(id, params, engineEmitter);
        break;
      case "mcp.catalog":
        await handleMcpCatalog(id, engineEmitter);
        break;
      case "mcp.add":
        await handleMcpAdd(id, params, engineEmitter);
        break;
      case "mcp.remove":
        await handleMcpRemove(id, params, engineEmitter);
        break;
      case "mcp.secrets":
        await handleMcpSecretsList(id, engineEmitter);
        break;
      case "mcp.secretSet":
        await handleMcpSecretSet(id, params, engineEmitter);
        break;
      // Réservées à la coquille : coffre de secrets (docs/protocol.md).
      case "coffre.charger":
        handleCoffreCharger(id, params, engineEmitter);
        break;
      case "coffre.attendreFin":
        handleCoffreAttendreFin(id, engineEmitter);
        break;
      case "coffre.ecrit":
        handleCoffreEcrit(id, params, engineEmitter);
        break;
      // Inventaire et migration guidée des .env (inventaireEnv.ts).
      case "coffre.inventaireEnv":
        await handleInventaireEnv(id, params, engineEmitter);
        break;
      case "coffre.migrerEnv":
        await handleMigrerEnv(id, params, engineEmitter);
        break;
      case "coffre.supprimerEnv":
        await handleSupprimerEnv(id, params, engineEmitter);
        break;
      case "coffre.referencesTaches":
        await handleReferencesTaches(id, engineEmitter);
        break;
      case "coffre.tachesSansSecrets":
        await handleTachesSansSecrets(id, engineEmitter);
        break;
      case "mcp.secretDelete":
        await handleMcpSecretDelete(id, params, engineEmitter);
        break;
      case "project.ensureDoc":
        await handleProjectEnsureDoc(id, params, engineEmitter);
        break;
      case "claude.configure":
        await handleClaudeConfigure(id, params, engineEmitter);
        break;
      case "claude.start":
        await handleClaudeStart(id, params, engineEmitter);
        break;
      case "claude.permission":
        await handleClaudePermission(id, params, engineEmitter);
        break;
      case "claude.abort":
        await handleClaudeAbort(id, params, engineEmitter);
        break;
      case "claude.push":
        await handleClaudePush(id, params, engineEmitter);
        break;
      case "claude.setModel":
        await handleClaudeSetModel(id, params, engineEmitter);
        break;
      case "claude.release":
        await handleClaudeRelease(id, params, engineEmitter);
        break;
      case "claude.commands":
        await handleClaudeCommands(id, params, engineEmitter);
        break;
      case "claude.comptes":
        executerClaudeComptes(id, params, engineEmitter);
        break;
      case "claude.titreDiscussion":
        await handleClaudeTitreDiscussion(id, params, engineEmitter);
        break;
      // T-023 — `usage.openrouter` reste accepté : renommer une méthode ne
      // doit pas casser une interface qui tourne. L'ancien nom part quand
      // plus rien ne l'appelle, pas le jour du renommage.
      case "usage.credits":
      case "usage.openrouter":
        await handleUsageCredits(id, params, engineEmitter);
        break;
      case "ollama.ps":
        await handleOllamaPs(id, params, engineEmitter);
        break;
      case "ollama.load":
        await handleOllamaLoad(id, params, engineEmitter);
        break;
      case "ollama.unload":
        await handleOllamaUnload(id, params, engineEmitter);
        break;
      case "usage.claude":
        await handleClaudeUsage(id, params, engineEmitter);
        break;
      case "usage.claude.init":
        await handleClaudeUsageInit(id, params, engineEmitter);
        break;
      case "usage.stats":
        await handleUsageStats(id, params, engineEmitter);
        break;
      case "usage.claude.history":
        await handleUsageClaudeHistory(id, params, engineEmitter);
        break;
      case "log.append":
        handleLogAppend(id, params, engineEmitter);
        break;
      case "log.read":
        await handleLogRead(id, params, engineEmitter);
        break;
      case "log.stats":
        await handleLogStats(id, params, engineEmitter);
        break;
      case "log.purge":
        await handleLogPurge(id, params, engineEmitter);
        break;
      case "neutral.start":
        await handleNeutralStart(id, params, engineEmitter);
        break;
      case "neutral.permission":
        handleNeutralPermission(id, params, engineEmitter);
        break;
      case "neutral.abort":
        handleNeutralAbort(id, params, engineEmitter);
        break;
      case "agents.list":
        await handleAgentsList(id, params, engineEmitter);
        break;
      case "agents.read":
        await handleAgentsRead(id, params, engineEmitter);
        break;
      case "agents.write":
        await handleAgentsWrite(id, params, engineEmitter);
        break;
      case "agents.delete":
        await handleAgentsDelete(id, params, engineEmitter);
        break;
      case "orch.list":
        await handleOrchList(id, params, engineEmitter);
        break;
      case "orch.read":
        await handleOrchRead(id, params, engineEmitter);
        break;
      case "orch.write":
        await handleOrchWrite(id, params, engineEmitter);
        break;
      case "orch.delete":
        await handleOrchDelete(id, params, engineEmitter);
        break;
      case "orch.run":
        await handleOrchRun(id, params, engineEmitter);
        break;
      case "orch.permission":
        await handleOrchPermission(id, params, engineEmitter);
        break;
      case "orch.abort":
        await handleOrchAbort(id, params, engineEmitter);
        break;
      case "taches.list":
        await handleTachesList(id, params, engineEmitter);
        break;
      case "taches.read":
        await handleTachesRead(id, params, engineEmitter);
        break;
      case "taches.write":
        await handleTachesWrite(id, params, engineEmitter);
        break;
      case "taches.delete":
        await handleTachesDelete(id, params, engineEmitter);
        break;
      case "taches.reports":
        await handleTachesReports(id, params, engineEmitter);
        break;
      case "taches.reportRead":
        await handleTachesReportRead(id, params, engineEmitter);
        break;
      case "taches.timerStatus":
        await handleTachesTimerStatus(id, params, engineEmitter);
        break;
      case "taches.timerApply":
        await handleTachesTimerApply(id, params, engineEmitter);
        break;
      case "taches.timerRemove":
        await handleTachesTimerRemove(id, params, engineEmitter);
        break;
      case "tickets.list":
        await handleTicketsList(id, params, engineEmitter);
        break;
      case "sessionsDistantes.archiverConversation":
        await handleSessionsDistantesArchiverConversation(id, params, engineEmitter);
        break;
      case "speech.configure":
        handleSpeechConfigure(id, params, engineEmitter);
        break;
      case "speech.transcribe":
        await handleSpeechTranscribe(id, params, engineEmitter);
        break;
      case "speech.synthesize":
        await handleSpeechSynthesize(id, params, engineEmitter);
        break;
      // T-227 — veilleur du relais (veilleurProtocole.ts).
      case "veilleur.statut":
        await handleVeilleurStatut(id, engineEmitter);
        break;
      case "veilleur.lire":
        await handleVeilleurLire(id, params, engineEmitter);
        break;
      case "veilleur.configurer":
        await handleVeilleurConfigurer(id, params, engineEmitter);
        break;
      case "veilleur.activer":
        await handleVeilleurActiver(id, params, engineEmitter);
        break;
      case "veilleur.desactiver":
        await handleVeilleurDesactiver(id, engineEmitter);
        break;
      case "veilleur.oublier":
        await handleVeilleurOublier(id, params, engineEmitter);
        break;
      default:
        emitMethodeInconnue(id, method);
    }
  } catch (err) {
    // Filet de sécurité : une méthode qui lève ne doit jamais faire crasher le sidecar.
    const message = err instanceof Error ? err.message : String(err);
    journal.error("sidecar", `erreur interne pendant le traitement de ${method}`, {
      reqId: id,
      fields: { method, erreur: message },
      stack: err instanceof Error ? err.stack : null,
    });
    emitError(id, `erreur interne: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Boucle de lecture stdin (JSON Lines)
// ---------------------------------------------------------------------------

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }

  // Une ligne d'entrée peut porter un prompt : on ne journalise JAMAIS son
  // contenu (contrat L1 — pas de corps de prompt, pas de donnée utilisateur),
  // seulement sa taille, qui suffit à qualifier le symptôme.
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    journal.warn("sidecar", "ligne non-JSON ignorée", { fields: { octets: trimmed.length } });
    return;
  }

  if (!isPlainObject(parsed)) {
    journal.warn("sidecar", "requête ignorée (pas un objet JSON)", {
      fields: { octets: trimmed.length },
    });
    return;
  }

  const id = parsed.id;
  if (!isNonEmptyString(id)) {
    // Sans id valide, impossible de corréler une réponse : on logue et on ignore.
    journal.warn("sidecar", "requête ignorée (id manquant ou invalide)", {
      fields: { octets: trimmed.length },
    });
    return;
  }

  const method = parsed.method;
  if (!isNonEmptyString(method)) {
    emitError(id, "method manquant ou invalide");
    return;
  }

  const params = isPlainObject(parsed.params) ? parsed.params : {};

  ouvrirSiTour(id, method);
  // Traitement asynchrone, sans attendre : deux requêtes concurrentes s'exécutent en parallèle.
  void dispatch(id, method, params);
}

function main(): void {
  // AVANT toute autre trace : QUEL code s'exécute ici, et est-il celui du
  // dépôt ? (T-020) Le 2026-08-10, trois jours de corrections étaient
  // compilées et testées sans jamais tourner, et rien nulle part ne le disait.
  signalerPeremption();

  // AVANT tout accès disque : rapatrier ce qui resterait sous l'ancien nommage
  // du produit. Synchrone et à cet endroit précis — un handler qui lirait
  // `taches/` ou `usage/` pendant la migration verrait un dossier à moitié
  // déplacé. Sans rien à migrer, ne coûte que deux `stat`.
  const migration = migrerDepuisAncienNom();
  if (migration.deplaces.length > 0 || migration.conflits.length > 0) {
    journal.info("sidecar", "données rapatriées depuis l'ancien nommage", {
      fields: { deplaces: migration.deplaces, conflits: migration.conflits },
    });
  }

  // Coffre de secrets : les écritures de secrets MCP partent à la coquille.
  definirCanalCoquille((event, data) => emit({ event: event as EventName, data }));

  emit({ event: "ready", data: { version: VERSION, pid: process.pid } });

  // T-180 — archive les sessions distantes de fil inactives depuis plus de 7 jours (rien à faire, donc aucun appel réseau, sans association).
  void balayerFilsInactifs();

  // T-227 — veilleur du relais : statut poussé à l'interface ; repart seul si le poste en a un actif.
  definirNotificationVeilleur((statut) => emit({ event: "veilleur", data: statut }));
  void demarrerVeilleurAuLancement();

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on("line", handleLine);

  rl.on("close", () => {
    // Vidage AVANT de sortir : les écritures du journal et des fichiers d'usage
    // sont mises en file et non attendues (une journalisation ne doit jamais
    // ralentir un tour), donc un `process.exit(0)` franc jetterait les lignes en
    // vol — dont les dernières avant l'arrêt, exactement celles qui expliquent
    // un plantage. `flushWrites` ne rejette jamais et se borne à quelques tours.
    // T-227 — d'abord le veilleur : son tour en cours est interrompu (10 s au plus), pas abandonné en vol.
    void arreterVeilleurPourSortir(10_000)
      .then(() => flushWrites())
      .then(
        () => process.exit(0),
        () => process.exit(0),
      );
  });
}

main();
