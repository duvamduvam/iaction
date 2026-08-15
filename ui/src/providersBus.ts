/*
 * Bus module-scope « la table des fournisseurs vient d'être poussée au
 * sidecar » (même patron que usageBus.ts). Émis par useProviders après chaque
 * providers.set réussi — au démarrage, à chaque `ready` du sidecar (redémarrage)
 * et à chaque modification dans l'admin. Consommé par tout ce qui interroge le
 * sidecar au sujet d'un fournisseur (liste de modèles, panneau Ollama…) : sans
 * ce signal, une requête partie avant le push échoue en « fournisseur inconnu »
 * et rien ne la relançait.
 */

type ProvidersPushedListener = () => void;

const listeners = new Set<ProvidersPushedListener>();
let dejaPousses = false;

/**
 * La table a-t-elle DÉJÀ été poussée au moins une fois ?
 *
 * Un abonnement n'apprend rien du passé : celui qui se branche après le push
 * n'en verra jamais l'écho. Sans cette mémoire, un consommateur devait choisir
 * entre attendre un signal déjà passé (et ne rien demander) ou tirer tout de
 * suite (et perdre la course). Les deux ont été observés — c'est T-008.
 */
export function providersDejaPousses(): boolean {
  return dejaPousses;
}

export function notifyProvidersPushed(): void {
  dejaPousses = true;
  for (const cb of listeners) cb();
}

export function subscribeProvidersPushed(cb: ProvidersPushedListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
