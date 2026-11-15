/*
 * T-195 — une confirmation ne vaut accord que sur un `true` explicite, et plus
 * aucun fichier de l'interface n'appelle `window.confirm` (remplacé par le
 * plugin dialog en promesse toujours vraie : l'action partait sans demander).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { confirmerAvec, type DepsConfirmation } from "./confirmation";

function deps(surcharges: Partial<DepsConfirmation> = {}): DepsConfirmation {
  return {
    estTauri: () => true,
    demanderTauri: async () => true,
    confirmNatif: () => true,
    journaliser: () => {},
    ...surcharges,
  };
}

describe("confirmerAvec", () => {
  it("dans la coquille Tauri, passe par la boîte Tauri et jamais par window.confirm", async () => {
    const confirmNatif = vi.fn(() => true);
    expect(await confirmerAvec("Supprimer ?", deps({ demanderTauri: async () => false, confirmNatif }))).toBe(false);
    expect(await confirmerAvec("Supprimer ?", deps({ confirmNatif }))).toBe(true);
    expect(confirmNatif).not.toHaveBeenCalled();
  });

  it("hors coquille Tauri, utilise la confirmation native du navigateur", async () => {
    const demanderTauri = vi.fn(async () => true);
    expect(await confirmerAvec("Supprimer ?", deps({ estTauri: () => false, confirmNatif: () => false, demanderTauri }))).toBe(false);
    expect(await confirmerAvec("Supprimer ?", deps({ estTauri: () => false, demanderTauri }))).toBe(true);
    expect(demanderTauri).not.toHaveBeenCalled();
  });

  it("une valeur « truthy » qui n'est pas le booléen true (la promesse du plugin) n'est PAS un accord", async () => {
    const piege = (() => Promise.resolve(true)) as unknown as () => boolean;
    expect(await confirmerAvec("x", deps({ estTauri: () => false, confirmNatif: piege }))).toBe(false);
    expect(await confirmerAvec("x", deps({ demanderTauri: (async () => "oui") as unknown as () => Promise<boolean> }))).toBe(false);
  });

  it("une erreur de la boîte vaut REFUS et se journalise, jamais un accord silencieux", async () => {
    const journaliser = vi.fn();
    const r = await confirmerAvec(
      "x",
      deps({ demanderTauri: async () => { throw new Error("dialog.confirm not allowed. Command not found"); }, journaliser }),
    );
    expect(r).toBe(false);
    expect(journaliser).toHaveBeenCalledWith("confirmation impossible, action refusée", {
      erreur: "dialog.confirm not allowed. Command not found",
    });
  });
});

describe("T-195 — plus d'appel à window.confirm dans l'interface", () => {
  it("seul confirmer.ts (le câblage de repli navigateur) y touche", () => {
    const dossier = path.dirname(fileURLToPath(import.meta.url));
    const fautifs = readdirSync(dossier)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && f !== "confirmer.ts")
      .filter((f) => {
        // Les commentaires expliquent le piège : seul le code compte.
        const code = readFileSync(path.join(dossier, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        return /(^|[^.\w])(window\.)?confirm\(/.test(code);
      });
    expect(fautifs).toEqual([]);
  });
});
