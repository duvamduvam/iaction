/*
 * claude.commands — module autonome (étape 9 de docs/etude-structure.md).
 *
 * Sorti de la fermeture createClaudeEngine : ses deux seules attaches au
 * moteur (queryFn, apiKey posée par claude.configure) sont INJECTÉES à
 * l'appel — l'instance moteur reste unique, l'état n'est jamais dupliqué.
 * Les imports de claude.ts sont des TYPES, effacés à la compilation : aucun
 * cycle à l'exécution.
 */

import { isNonEmptyString } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import type { ClaudeQuery, ClaudeQueryFn, ClaudeQueryOptions } from "./claude.js";

// ---------------------------------------------------------------------------
// claude.commands — session « à vide » (aucun tour joué) pour ne récupérer
// que supportedCommands(). Voir docs/protocol.md, section « claude.commands ».
// ---------------------------------------------------------------------------

/**
 * Construit un prompt en entrée streamée qui ne yield JAMAIS de message
 * utilisateur : le générateur reste suspendu sur une promesse tant que
 * `close()` n'a pas été appelé. Ça suffit à faire démarrer une session SDK
 * complète (system/init, supportedCommands()...) sans jamais envoyer de tour
 * à Claude — donc sans consommer le moindre token. `close()` termine le
 * générateur proprement (return), ce qui permet à `query.interrupt()` de
 * refermer le process CLI sous-jacent sans qu'il reste bloqué en attente
 * d'une entrée qui ne viendra jamais.
 */
function createNonYieldingPrompt(): {
  iterable: AsyncIterable<Record<string, unknown>>;
  close: () => void;
} {
  let closeResolve: (() => void) | null = null;
  const closeSignal = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  async function* gen(): AsyncGenerator<Record<string, unknown>> {
    await closeSignal;
  }
  return {
    iterable: gen(),
    close: () => closeResolve?.(),
  };
}

/** Rejette avec `timeoutMessage` si `promise` ne s'est pas réglée sous `timeoutMs`. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

const COMMANDS_TIMEOUT_MS = 15000;

/**
 * claude.commands — énumère les slash-commands/skills disponibles pour un
 * projet sans jouer de tour (voir docs/protocol.md, section
 * « claude.commands »). Ouvre une session SDK en entrée streamée avec un
 * prompt qui ne yield jamais (createNonYieldingPrompt) : le SDK initialise
 * la session (system/init, supportedCommands()...) sans qu'aucun message
 * ne parte jamais vers Claude — zéro token consommé. Referme la session
 * proprement une fois la liste récupérée (ou en cas d'erreur/timeout).
 */
export async function executerClaudeCommands(
  deps: {
    queryFn: ClaudeQueryFn;
    /** Clé posée par claude.configure — lue au moment de l'appel, jamais figée. */
    apiKey: () => string | null;
    decorerErreurAuth: (message: string) => string;
  },
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const { queryFn, decorerErreurAuth } = deps;
  const apiKey = deps.apiKey();
  const cwd = params.cwd;
  if (!isNonEmptyString(cwd)) {
    emitter.error(id, "params.cwd manquant ou invalide");
    return;
  }

  const options: ClaudeQueryOptions = {
    cwd,
    includePartialMessages: false,
    permissionMode: "default",
    env: { ...process.env, ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) },
    // Mêmes sources que le moteur projet de claude.start : la liste des
    // commandes doit refléter ce que le tour verra RÉELLEMENT — skills et
    // commandes globaux du poste (~/.claude) compris, sinon le menu « / »
    // afficherait moins que ce qui est réellement disponible.
    settingSources: ["user", "project", "local"],
  };

  const { iterable: promptForQuery, close: closePrompt } = createNonYieldingPrompt();

  let query: ClaudeQuery;
  try {
    query = queryFn({ prompt: promptForQuery, options });
  } catch (err) {
    closePrompt();
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, decorerErreurAuth(message));
    return;
  }

  try {
    if (typeof query.supportedCommands !== "function") {
      throw new Error("le SDK ne fournit pas supportedCommands()");
    }
    const commands = await withTimeout(
      query.supportedCommands(),
      COMMANDS_TIMEOUT_MS,
      "délai dépassé en attendant la liste des commandes",
    );
    await query.interrupt().catch(() => {
      // interrupt() peut rejeter si la session n'a pas encore fini de
      // s'initialiser côté process : sans conséquence, on ferme quand
      // même le générateur juste après.
    });
    closePrompt();
    const mapped = commands.map((command) => ({
      name: command.name,
      description: command.description ?? "",
      argumentHint: command.argumentHint ?? "",
      ...(command.aliases && command.aliases.length > 0 ? { aliases: command.aliases } : {}),
    }));
    emitter.done(id, { commands: mapped });
  } catch (err) {
    await query.interrupt().catch(() => {
      // Idem : on ferme au mieux, l'erreur d'origine prime.
    });
    closePrompt();
    const message = err instanceof Error ? err.message : String(err);
    emitter.error(id, decorerErreurAuth(message));
  }
}
