/*
 * T-180 — à la suppression d'une conversation IAction, le sidecar archive les
 * sessions distantes qu'elle avait ouvertes sur un relais (voir docs/protocol.md,
 * `sessionsDistantes.archiverConversation`). Au pire non fait : le balayage de
 * démarrage du sidecar archive de toute façon ce qui reste inactif 7 jours.
 * Jamais bloquant ; l'échec est journalisé, pas affiché.
 */

import { logUi } from "./journal";
import { request } from "./sidecar";

export function archiverFilsDistants(conversationId: string): void {
  request("sessionsDistantes.archiverConversation", { conversationId }).done.catch((err: unknown) => {
    logUi("warn", "ui", `archivage des sessions distantes de la conversation impossible : ${err instanceof Error ? err.message : String(err)}`, { fields: { conversationId } });
  });
}
