/*
 * usage.claude — module autonome (étape 9 de docs/etude-structure.md).
 *
 * Sorti de la fermeture createClaudeEngine. Le SEUL état partagé avec
 * handleClaudeStart est l'instantané `lastUsageSnapshot` (le start le
 * capture en fin de tour, usage.claude le sert, usage.claude.init le
 * rafraîchit) : il reste la propriété de la fermeture, exposé ici par un
 * dépôt lire/ecrire injecté — c'était le point identifié comme risque n°1
 * du découpage (deux instances = deux relevés silencieusement divergents).
 */

import os from "node:os";
import { isPlainObject } from "./base.js";
import { recordClaudeWindowsSnapshot } from "./usageStats.js";
import type { EngineEmitter } from "./engine.js";
import type { ClaudeQuery, ClaudeQueryFn } from "./claude.js";

/** Accès à l'instantané partagé avec handleClaudeStart — voir l'en-tête. */
export interface DepotUsageClaude {
  lire(): ClaudeUsageSnapshot | null;
  ecrire(snapshot: ClaudeUsageSnapshot): void;
}

// ---------------------------------------------------------------------------
// usage.claude — instantané des limites d'abonnement (mini-tranche du Lot 8)
// ---------------------------------------------------------------------------

export interface ClaudeUsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

export interface ClaudeUsageSnapshot {
  available: boolean;
  subscriptionType: string | null;
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  /**
   * TOUTES les fenêtres présentes dans `rate_limits` (clé brute → fenêtre),
   * y compris celles spécifiques à un modèle (ex. hebdo Opus/Fable) dont le
   * nommage peut évoluer — l'API est expérimentale, on relaie sans présumer.
   * `fiveHour`/`sevenDay` restent extraits à part pour compatibilité.
   */
  windows: Record<string, ClaudeUsageWindow>;
  capturedAt: string;
}

const USAGE_CAPTURE_TIMEOUT_MS = 3000;

function extractUsageWindow(value: unknown): ClaudeUsageWindow | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return {
    utilization: typeof value.utilization === "number" ? value.utilization : null,
    resetsAt: typeof value.resets_at === "string" ? value.resets_at : null,
  };
}

/**
 * Capture défensive de l'instantané d'usage via la méthode expérimentale du
 * SDK. Ne lève jamais : indisponibilité, forme inattendue ou lenteur (>3s)
 * renvoient simplement `null` sans perturber la fin du tour claude.start.
 */
export async function captureUsageSnapshot(query: ClaudeQuery): Promise<ClaudeUsageSnapshot | null> {
  try {
    if (typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") {
      return null;
    }
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), USAGE_CAPTURE_TIMEOUT_MS);
    });
    const result = await Promise.race([
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      timeout,
    ]);
    if (!isPlainObject(result)) {
      return null;
    }
    const rateLimits = isPlainObject(result.rate_limits) ? result.rate_limits : null;
    const windows: Record<string, ClaudeUsageWindow> = {};
    if (rateLimits) {
      for (const [key, value] of Object.entries(rateLimits)) {
        const window = extractUsageWindow(value);
        if (window && window.utilization !== null) {
          windows[key] = window;
        }
      }
    }
    return {
      available: result.rate_limits_available === true,
      subscriptionType: typeof result.subscription_type === "string" ? result.subscription_type : null,
      fiveHour: rateLimits ? extractUsageWindow(rateLimits.five_hour) : null,
      sevenDay: rateLimits ? extractUsageWindow(rateLimits.seven_day) : null,
      windows,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function executerClaudeUsage(
  depot: DepotUsageClaude,
  id: string,
  _params: Record<string, unknown>,
  emitter: EngineEmitter,
): void {
  const lastUsageSnapshot = depot.lire();
  if (!lastUsageSnapshot) {
    emitter.done(id, { available: false });
    return;
  }
  emitter.done(id, { ...lastUsageSnapshot });
}

/**
 * usage.claude.init — initialise le relevé d'abonnement sans conversation :
 * micro-tour chat pur (haiku, prompt « ping », aucun outil) dont on ne garde
 * que l'instantané de limites capturé PENDANT le tour (voir le commentaire
 * de tryCaptureUsage dans handleClaudeStart : après le message result, la
 * requête de contrôle du SDK part dans le vide). Coût négligeable, déclenché
 * uniquement à la demande de l'utilisateur (bouton ↻ de l'encart conso).
 */
export async function executerClaudeUsageInit(
  deps: { queryFn: ClaudeQueryFn; depot: DepotUsageClaude },
  id: string,
  _params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const { queryFn, depot } = deps;
  let query: ClaudeQuery;
  try {
    query = queryFn({
      prompt: "ping",
      options: {
        cwd: os.homedir(),
        model: "claude-haiku-4-5",
        tools: [],
        permissionMode: "default",
      },
    });
  } catch (err) {
    emitter.error(id, `échec du micro-tour d'initialisation : ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    let captured: ClaudeUsageSnapshot | null = null;
    for await (const message of query) {
      if (!captured && isPlainObject(message) && message.type === "assistant") {
        captured = await captureUsageSnapshot(query);
      }
    }
    // Filet pour les SDK/faux SDK qui ne passent pas par le transport
    // processus (la capture post-tour y fonctionne).
    captured ??= await captureUsageSnapshot(query);
    if (captured) {
      depot.ecrire(captured);
      recordClaudeWindowsSnapshot(captured.windows);
      emitter.done(id, { ...captured });
    } else if (depot.lire()) {
      emitter.done(id, { ...depot.lire() });
    } else {
      emitter.done(id, { available: false });
    }
  } catch (err) {
    emitter.error(id, `échec du micro-tour d'initialisation : ${err instanceof Error ? err.message : String(err)}`);
  }
}
