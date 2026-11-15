/*
 * T-195 — le câblage réel de `confirmerAvec` (confirmation.ts, qui dit
 * pourquoi `window.confirm` est interdit ailleurs dans l'interface). Fin
 * câblage, volontairement non testé : toute la décision est dans la feuille.
 */
import { ask } from "@tauri-apps/plugin-dialog";

import { confirmerAvec } from "./confirmation";
import { logUi } from "./journal";

/** Demande confirmation ; `false` sur refus, sur fermeture de la boîte ET sur toute erreur. */
export function confirmer(message: string): Promise<boolean> {
  return confirmerAvec(message, {
    estTauri: () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window,
    demanderTauri: (m) => ask(m, { title: "Confirmation", kind: "warning", okLabel: "Oui", cancelLabel: "Non" }),
    confirmNatif: (m) => window.confirm(m),
    journaliser: (msg, fields) => logUi("error", "ui", msg, { fields }),
  });
}
