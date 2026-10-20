/**
 * Attente des tâches de fond après la fin du tour du modèle (T-155).
 *
 * Quand un `result` arrive alors que des tâches suivies par le SDK vivent
 * encore (sous-agent en arrière-plan, Bash `run_in_background`), le process
 * CLI doit rester ouvert : leurs rapports relancent le modèle. L'attente est
 * plafonnée — sinon une tâche qui ne finit jamais (serveur, watcher) tenait le
 * tour en otage — et ce plafond ne doit JAMAIS sonner en silence : il
 * journalise son armement et son expiration, et prévient l'UI par un chunk
 * `background_timeout` AVANT que l'interrupt ne tue les tâches restantes.
 *
 * Feuille extraite de `claude.ts` : elle ne connaît ni le SDK ni la boucle du
 * tour, seulement un émetteur et l'action d'abandon qu'on lui confie.
 */
import * as journal from "./journal.js";
import type { EngineEmitter } from "./engine.js";

/** Plafond de l'attente. 30 min par défaut : un job réel (script SSH, build)
    dure plusieurs minutes, les 10 min d'origine l'abandonnaient en cours de
    route. Surchargeable via l'environnement pour les tests. Sert aussi de
    `MCP_TOOL_TIMEOUT` côté CLI (voir claude.ts). */
export const BACKGROUND_WAIT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.IACTION_BACKGROUND_WAIT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000;
})();

/**
 * Arme le plafond d'attente et rend son minuteur (à désarmer par l'appelant
 * dès que le modèle reprend). À l'échéance : journal `warn`, chunk
 * `background_timeout`, puis `abandonner()` (fermeture de l'entrée + interrupt).
 */
export function armerAttenteTachesDeFond(p: {
  id: string;
  emitter: EngineEmitter;
  taches: readonly { description: string }[];
  abandonner: () => void;
}): ReturnType<typeof setTimeout> {
  const fields = {
    count: p.taches.length,
    descriptions: p.taches
      .map((t) => t.description.replace(/\s+/g, " ").slice(0, 200))
      .filter(Boolean)
      .slice(0, 10),
    plafondMs: BACKGROUND_WAIT_TIMEOUT_MS,
  };
  journal.info("claude", "attente des tâches de fond", { reqId: p.id, fields });
  return setTimeout(() => {
    journal.warn("claude", "plafond d'attente des tâches de fond atteint : tâches abandonnées", {
      reqId: p.id,
      fields,
    });
    p.emitter.chunk(p.id, { kind: "background_timeout", count: fields.count, plafondMs: BACKGROUND_WAIT_TIMEOUT_MS });
    p.abandonner();
  }, BACKGROUND_WAIT_TIMEOUT_MS);
}
