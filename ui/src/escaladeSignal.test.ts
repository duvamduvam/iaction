/*
 * Signal d'escalade (T-074) — seule l'escalade INCONTESTABLE (échec suivi
 * immédiatement d'un tier supérieur, même conversation) doit être comptée.
 */
import { describe, expect, it } from "vitest";
import { calculerSignalEscalade, type TourPourEscalade } from "./escaladeSignal";

function tour(overrides: Partial<TourPourEscalade>): TourPourEscalade {
  return { conversationId: "c1", ts: "2026-08-29T10:00:00Z", model: "claude-haiku-4-5", erreur: false, ...overrides };
}

describe("calculerSignalEscalade", () => {
  it("liste vide ⇒ tout à zéro", () => {
    expect(calculerSignalEscalade([])).toEqual({
      toursEscalade: 0,
      conversationsAvecEscalade: 0,
      toursErreurComparables: 0,
    });
  });

  it("compte une escalade incontestable : erreur sur haiku puis tour suivant sur opus", () => {
    const r = calculerSignalEscalade([
      tour({ ts: "10:00:00", model: "claude-haiku-4-5", erreur: true }),
      tour({ ts: "10:01:00", model: "claude-opus-5", erreur: false }),
    ]);
    expect(r.toursEscalade).toBe(1);
    expect(r.conversationsAvecEscalade).toBe(1);
    expect(r.toursErreurComparables).toBe(1);
  });

  it("ne compte PAS une réussite suivie d'un tier supérieur : pas d'erreur, pas d'escalade", () => {
    const r = calculerSignalEscalade([
      tour({ ts: "10:00:00", model: "claude-haiku-4-5", erreur: false }),
      tour({ ts: "10:01:00", model: "claude-opus-5", erreur: false }),
    ]);
    expect(r.toursEscalade).toBe(0);
    expect(r.toursErreurComparables).toBe(0);
  });

  it("ne compte PAS une erreur suivie d'un tier ÉGAL ou INFÉRIEUR", () => {
    const egal = calculerSignalEscalade([
      tour({ ts: "10:00:00", model: "claude-sonnet-5", erreur: true }),
      tour({ ts: "10:01:00", model: "claude-sonnet-5", erreur: false }),
    ]);
    expect(egal.toursEscalade).toBe(0);
    expect(egal.toursErreurComparables).toBe(1); // comparable, mais pas une escalade

    const inferieur = calculerSignalEscalade([
      tour({ ts: "10:00:00", model: "claude-opus-5", erreur: true }),
      tour({ ts: "10:01:00", model: "claude-haiku-4-5", erreur: false }),
    ]);
    expect(inferieur.toursEscalade).toBe(0);
  });

  it("un modèle absent du barème n'est pas comparable — ni numérateur ni dénominateur", () => {
    const r = calculerSignalEscalade([
      tour({ ts: "10:00:00", model: "claude-fable-5", erreur: true }),
      tour({ ts: "10:01:00", model: "claude-opus-5", erreur: false }),
    ]);
    expect(r.toursEscalade).toBe(0);
    expect(r.toursErreurComparables).toBe(0);
  });

  it("respecte les frontières de conversation : pas d'escalade inter-conversations", () => {
    const r = calculerSignalEscalade([
      tour({ conversationId: "a", ts: "10:00:00", model: "claude-haiku-4-5", erreur: true }),
      tour({ conversationId: "b", ts: "10:01:00", model: "claude-opus-5", erreur: false }),
    ]);
    expect(r.toursEscalade).toBe(0);
    expect(r.toursErreurComparables).toBe(0);
  });

  it("réordonne les tours d'une conversation reçus dans le désordre", () => {
    const r = calculerSignalEscalade([
      tour({ ts: "10:05:00", model: "claude-opus-5", erreur: false }),
      tour({ ts: "10:00:00", model: "claude-haiku-4-5", erreur: true }),
    ]);
    expect(r.toursEscalade).toBe(1);
  });

  it("une conversation avec plusieurs escalades ne compte qu'une fois au dénominateur conversation", () => {
    const r = calculerSignalEscalade([
      tour({ ts: "10:00:00", model: "claude-haiku-4-5", erreur: true }),
      tour({ ts: "10:01:00", model: "claude-opus-5", erreur: true }),
      tour({ ts: "10:02:00", model: "claude-haiku-4-5", erreur: true }),
      tour({ ts: "10:03:00", model: "claude-opus-5", erreur: false }),
    ]);
    expect(r.toursEscalade).toBe(2);
    expect(r.conversationsAvecEscalade).toBe(1);
  });
});
