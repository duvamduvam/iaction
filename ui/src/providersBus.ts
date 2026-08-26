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
let cleParFournisseur: Record<string, boolean> = {};

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

/**
 * Une clé API est-elle enregistrée pour ce fournisseur ?
 *
 * Statut seul, JAMAIS la valeur : `pushProviders` rend déjà ce booléen par
 * fournisseur, la clé, elle, ne quitte pas le trousseau.
 *
 * Sert à ne pas interroger un fournisseur dont on sait qu'il refusera. Le
 * 2026-08-26, `app.jsonl` portait une ligne `error` toutes les 15 secondes —
 * « clé API manquante pour openrouter », méthode `usage.credits` — parce que
 * l'encart de conso relançait indéfiniment un appel qui ne POUVAIT pas
 * aboutir : sans clé, ce n'est pas une panne à retenter, c'est une réponse.
 *
 * Rend `false` tant que la table n'a pas été poussée : garder `providersDejaPousses()`
 * en garde amont reste donc nécessaire pour distinguer « pas de clé » de « pas encore su ».
 */
export function cleConfigureePour(providerId: string): boolean {
  return cleParFournisseur[providerId] ?? false;
}

export function notifyProvidersPushed(keyStatus: Record<string, boolean> = {}): void {
  dejaPousses = true;
  cleParFournisseur = keyStatus;
  for (const cb of listeners) cb();
}

export function subscribeProvidersPushed(cb: ProvidersPushedListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
