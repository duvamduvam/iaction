/*
 * Petit bus d'événements module-scope pour signaler « la conso a pu changer »
 * (fin de tour de chat/agent) sans coupler ChatPage/AgentPage à l'encart de
 * conso de l'en-tête. `notifyUsageChanged()` est appelé côté émetteurs,
 * `subscribeUsageChanged()` côté UsageWidget (App.tsx).
 *
 * Un Set d'abonnés (comme les subscribers de sidecar.ts) : add/remove
 * synchrones, sûrs même avec le double montage des effets en StrictMode.
 */

type UsageChangedListener = () => void;

const listeners = new Set<UsageChangedListener>();

/** À appeler à la fin de chaque tour de chat/agent (succès, erreur ou abort). */
export function notifyUsageChanged(): void {
  for (const cb of listeners) cb();
}

export function subscribeUsageChanged(cb: UsageChangedListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
