/*
 * T-080 — la bascule « mode Auto » → « modèle par défaut » se joue à la
 * relecture des sessions existantes : 30 conversations portent la sentinelle
 * `__auto__` au moment du changement. Ces cas verrouillent qu'aucune d'elles
 * ne change de modèle en silence, et que la sentinelle ne peut pas revenir
 * par le réglage.
 */
import { describe, expect, it } from "vitest";
import {
  MODELE_DEFAUT_USINE,
  normaliserModeleDefaut,
  resoudreModeleSession,
  SENTINELLE_AUTO_HISTORIQUE,
} from "./modeleDefaut";

describe("resoudreModeleSession — relire une session d'avant la bascule", () => {
  it("un modèle explicite est intouchable, même si une cible routée traîne", () => {
    expect(resoudreModeleSession("claude-sonnet-5", "claude-fable-5", "claude-opus-5")).toBe("claude-sonnet-5");
  });

  it("`__auto__` déjà routé garde la cible RÉELLE, pas le défaut", () => {
    // Le point du ticket : la conversation s'est construite sur fable ; la
    // rouvrir sur opus changerait son modèle en cours de route, en silence.
    expect(resoudreModeleSession(SENTINELLE_AUTO_HISTORIQUE, "claude-fable-5", "claude-opus-5")).toBe(
      "claude-fable-5",
    );
  });

  it("`__auto__` jamais envoyé retombe sur le défaut configuré", () => {
    expect(resoudreModeleSession(SENTINELLE_AUTO_HISTORIQUE, null, "claude-opus-5")).toBe("claude-opus-5");
    expect(resoudreModeleSession(SENTINELLE_AUTO_HISTORIQUE, "  ", "claude-opus-5")).toBe("claude-opus-5");
  });

  it("modèle absent, vide ou blanc : défaut configuré (jamais une chaîne vide)", () => {
    expect(resoudreModeleSession(null, null, "claude-opus-5")).toBe("claude-opus-5");
    expect(resoudreModeleSession(undefined, "claude-fable-5", "claude-opus-5")).toBe("claude-opus-5");
    expect(resoudreModeleSession("   ", null, "claude-opus-5")).toBe("claude-opus-5");
  });
});

describe("normaliserModeleDefaut — le réglage ne peut pas ressusciter le mode supprimé", () => {
  it("refuse la sentinelle historique, le vide et le non-texte", () => {
    expect(normaliserModeleDefaut(SENTINELLE_AUTO_HISTORIQUE)).toBeNull();
    expect(normaliserModeleDefaut("")).toBeNull();
    expect(normaliserModeleDefaut("   ")).toBeNull();
    expect(normaliserModeleDefaut(42)).toBeNull();
    expect(normaliserModeleDefaut(undefined)).toBeNull();
  });

  it("accepte un id de modèle et le débarrasse de ses espaces", () => {
    expect(normaliserModeleDefaut("  claude-opus-5 ")).toBe("claude-opus-5");
  });

  it("le défaut d'usine est opus-5 (T-078), jamais fable", () => {
    expect(MODELE_DEFAUT_USINE).toBe("claude-opus-5");
  });
});
