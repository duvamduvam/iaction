/*
 * La chaîne journal → sidecar doit rester IMPORTABLE hors webview (T-055).
 *
 * Le défaut que ce fichier verrouille ne se voyait pas dans les résultats de
 * test : `sidecar.ts` installait ses écouteurs Tauri AU CHARGEMENT DU MODULE
 * (`setupListeners()` au niveau module), donc `listen()`, donc `window` —
 * absent sous Node. N'importe quel test unitaire qui importait `./journal`
 * pour un simple `logUi` tirait la chaîne et produisait un
 * `ReferenceError: window is not defined` en REJET NON GÉRÉ : les tests
 * passaient, la chaîne sortait en échec, et le message ne désignait pas la
 * cause. Une heure de perdue pour qui ne l'avait jamais vu.
 *
 * Un module d'IPC ne doit pas s'installer par effet de bord d'import — hors
 * webview il n'y a rien à écouter, et il n'a rien à faire.
 */

import { describe, expect, it } from "vitest";

describe("chaîne journal → sidecar hors webview (T-055)", () => {
  it("s'importe sans rejet non géré", async () => {
    const rejets: unknown[] = [];
    const capter = (raison: unknown) => rejets.push(raison);
    process.on("unhandledRejection", capter);
    try {
      const journal = await import("./journal");
      const sidecar = await import("./sidecar");
      // Laisser passer un tour de boucle : le rejet d'un `setupListeners()`
      // lancé à l'import n'arriverait qu'après la microtâche d'import.
      await new Promise((r) => setTimeout(r, 20));
      expect(typeof journal.logUi).toBe("function");
      expect(typeof sidecar.request).toBe("function");
      expect(rejets, "l'import ne doit rien installer, donc rien rejeter").toEqual([]);
    } finally {
      process.off("unhandledRejection", capter);
    }
  });
});
