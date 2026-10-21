/* T-162 — messages par raison de refus, et attente bornée de la page. */
import { describe, expect, it } from "vitest";

import { attendreDisponible, messageReprise, type RaisonReprise } from "./repriseSession";

describe("messageReprise", () => {
  it("ne dit rien quand la reprise est acceptée", () => {
    expect(messageReprise("ok")).toBeNull();
  });

  it("donne un message distinct pour chaque refus", () => {
    const refus: RaisonReprise[] = ["page-indisponible", "projet-inconnu", "tour-en-cours", "autre-fenetre"];
    const messages = refus.map((r) => messageReprise(r));
    expect(messages.every((m) => typeof m === "string" && m.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(refus.length);
  });

  it("demande de faire la reprise dans l'autre fenêtre", () => {
    expect(messageReprise("autre-fenetre")).toMatch(/autre fenêtre/);
  });
});

describe("attendreDisponible", () => {
  it("rend aussitôt la valeur déjà présente, sans attendre", async () => {
    let attentes = 0;
    const v = await attendreDisponible(() => "x", async () => void attentes++);
    expect(v).toBe("x");
    expect(attentes).toBe(0);
  });

  it("attend la valeur qui arrive après quelques images", async () => {
    let n = 0;
    const v = await attendreDisponible(() => (n >= 3 ? "prête" : null), async () => void n++);
    expect(v).toBe("prête");
    expect(n).toBe(3);
  });

  it("abandonne après le nombre d'images fixé", async () => {
    let attentes = 0;
    const v = await attendreDisponible(() => null, async () => void attentes++, 5);
    expect(v).toBeNull();
    expect(attentes).toBe(5);
  });
});
