/*
 * T-195 — confirmation d'une action destructrice. Feuille pure (aucun import) :
 * les dépendances (boîte Tauri, `window.confirm` natif, journal) sont injectées,
 * le câblage réel est dans confirmer.ts.
 *
 * ── Pourquoi `window.confirm` est interdit ───────────────────────────────
 * `tauri-plugin-dialog` (2.7.2 comme 2.8.1) injecte au démarrage
 * `window.confirm = async (m) => invoke("plugin:dialog|confirm", …)`. Or ce
 * plugin n'enregistre que `open`, `save` et `message` : la commande `confirm`
 * n'existe pas, aucune capability ne peut donc l'autoriser (d'où l'erreur
 * « dialog.confirm not allowed. Command not found »). Pire : la fonction étant
 * `async`, `window.confirm(...)` rend une PROMESSE, toujours vraie — un
 * `if (!window.confirm(…)) return;` ne retourne jamais, et l'action gardée
 * s'exécute SANS confirmation.
 *
 * ── Le contrat d'ici ─────────────────────────────────────────────────────
 * Une confirmation est asynchrone et ne rend `true` que sur un `true` booléen
 * explicite. Toute erreur (boîte indisponible, commande refusée) vaut REFUS et
 * est journalisée : on n'exécute jamais une action destructrice par défaut.
 */

export interface DepsConfirmation {
  /** Vrai dans la coquille Tauri (WebKitGTK/WebView2), faux dans un navigateur ou HMR Chromium. */
  estTauri: () => boolean;
  /** Boîte native Tauri (`ask`), qui passe par la commande autorisée `plugin:dialog|message`. */
  demanderTauri: (message: string) => Promise<boolean>;
  /** `window.confirm` du navigateur — synchrone et fiable HORS coquille Tauri seulement. */
  confirmNatif: (message: string) => boolean;
  journaliser: (msg: string, fields: Record<string, string>) => void;
}

export async function confirmerAvec(message: string, deps: DepsConfirmation): Promise<boolean> {
  try {
    const reponse = deps.estTauri() ? await deps.demanderTauri(message) : deps.confirmNatif(message);
    // `=== true` : une promesse ou toute valeur « truthy » n'est pas un accord.
    return reponse === true;
  } catch (err) {
    deps.journaliser("confirmation impossible, action refusée", { erreur: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
