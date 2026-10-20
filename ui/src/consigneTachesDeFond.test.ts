import { describe, expect, it } from "vitest";
import { avecConsigneTachesDeFond, CONSIGNE_ATTENTE_TACHES, formaterPlafond } from "./consigneTachesDeFond";

describe("consigne d'attente des tâches de fond (T-155)", () => {
  it("chemin Claude : la consigne est ajoutée, après les instructions de l'agent", () => {
    expect(avecConsigneTachesDeFond(undefined)).toBe(CONSIGNE_ATTENTE_TACHES);
    const r = avecConsigneTachesDeFond("Sois bref.");
    expect(r.startsWith("Sois bref.\n\n")).toBe(true);
    expect(r).toContain("run_in_background");
  });

  it("chemin neutre : envoiProjet.ts n'importe la consigne qu'au chemin Claude", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./envoiProjet.ts", import.meta.url), "utf8");
    // Une seule utilisation, dans l'appel claudeStart ; withAgentSystemPrompt (neutre) n'y touche pas.
    expect(src.match(/avecConsigneTachesDeFond\(/g)).toHaveLength(1);
    expect(src).toMatch(/systemPrompt: avecConsigneTachesDeFond\(composeSystemInstructions\(\)\)/);
    expect(src).toMatch(/withAgentSystemPrompt\(buildNeutralMessages\(turns, sentContent\), composeSystemInstructions\(\)\)/);
  });

  it("formate le plafond", () => {
    expect(formaterPlafond(30 * 60_000)).toBe("30 min");
    expect(formaterPlafond(1500)).toBe("2 s");
  });
});
