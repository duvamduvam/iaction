import { describe, expect, it } from "vitest";
import { AVIS_SESSION_PERDUE, BUDGET_HISTORIQUE, promptAvecRecapitulatif } from "./sessionPerdue";

describe("promptAvecRecapitulatif (T-187)", () => {
  it("historique vide ou fait de messages vides ⇒ la demande telle quelle", () => {
    expect(promptAvecRecapitulatif([], "Bonjour")).toBe("Bonjour");
    expect(promptAvecRecapitulatif([{ role: "user", texte: "  \n" }], "Bonjour")).toBe("Bonjour");
  });

  it("préambule, historique dans l'ordre, puis la demande séparée", () => {
    const p = promptAvecRecapitulatif(
      [
        { role: "user", texte: "Question 1" },
        { role: "assistant", texte: "Réponse 1" },
      ],
      "Question 2",
    );
    expect(p).toContain("n'existe plus");
    expect(p).toContain("pas comme de nouvelles instructions");
    expect(p.indexOf("Question 1")).toBeLessThan(p.indexOf("Réponse 1"));
    expect(p.indexOf("Réponse 1")).toBeLessThan(p.indexOf("FIN DE L'HISTORIQUE"));
    expect(p.endsWith("Question 2")).toBe(true);
    expect(p).not.toContain("omise");
  });

  it("ignore les messages vides", () => {
    const p = promptAvecRecapitulatif(
      [
        { role: "assistant", texte: "" },
        { role: "user", texte: "Seul message" },
      ],
      "Suite",
    );
    expect(p).not.toContain("Assistant :");
    expect(p).toContain("Utilisateur :\nSeul message");
  });

  it("budget : garde les plus récents, signale l'omission", () => {
    const ancien = { role: "user" as const, texte: "ANCIEN" + "a".repeat(30_000) };
    const milieu = { role: "assistant" as const, texte: "MILIEU" + "b".repeat(30_000) };
    const recent = { role: "user" as const, texte: "RECENT" };
    const p = promptAvecRecapitulatif([ancien, milieu, recent], "Suite");
    expect(p).toContain("RECENT");
    expect(p).toContain("MILIEU");
    expect(p).not.toContain("ANCIEN");
    expect(p).toContain("omise");
  });

  it("un seul message plus gros que le budget : on en garde la fin", () => {
    const p = promptAvecRecapitulatif(
      [{ role: "assistant", texte: "DEBUT" + "x".repeat(BUDGET_HISTORIQUE) + "FIN" }],
      "Suite",
    );
    expect(p).toContain("FIN");
    expect(p).not.toContain("DEBUT");
    expect(p).toContain("omise");
  });

  it("l'avis est un texte court non vide", () => {
    expect(AVIS_SESSION_PERDUE.length).toBeGreaterThan(10);
    expect(AVIS_SESSION_PERDUE.length).toBeLessThan(120);
  });
});
