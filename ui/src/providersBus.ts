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

export function notifyProvidersPushed(): void {
  for (const cb of listeners) cb();
}

export function subscribeProvidersPushed(cb: ProvidersPushedListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
