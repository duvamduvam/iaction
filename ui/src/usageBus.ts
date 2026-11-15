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

/*
 * Compte Claude que suivent les jauges de l'encart (docs/spec-deux-comptes.md) :
 * celui de la session ACTIVE de la page visible. La page le publie quand son
 * compte effectif change ou qu'elle redevient visible ; l'encart s'y abonne et
 * relit tout de suite, sans attendre le prochain battement. `perso` tant que
 * personne ne publie : rendu d'avant.
 */
let compteActif: "perso" | "teams" = "perso";
const abonnesCompte = new Set<() => void>();

export function compteActifConso(): "perso" | "teams" {
  return compteActif;
}

export function publierCompteActifConso(compte: "perso" | "teams"): void {
  if (compte === compteActif) return;
  compteActif = compte;
  for (const cb of abonnesCompte) cb();
}

export function subscribeCompteActifConso(cb: () => void): () => void {
  abonnesCompte.add(cb);
  return () => abonnesCompte.delete(cb);
}
