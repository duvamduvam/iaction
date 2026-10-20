/*
 * Heure des lignes discrètes (T-101) — la partie testable : le formatage et
 * le suivi de repli. `NoticeEnTete`/`NoticeEnQueue` sont du JSX minceur, non
 * testés ici (aucun composant ne l'est dans ce projet, voir architecture.md
 * §8 : les tests suivent la structure, la logique vit dans les feuilles
 * pures).
 */
import { describe, expect, it } from "vitest";
import { formaterHeureDiscrete, suivreInstant } from "./heureDiscrete";

describe("formaterHeureDiscrete", () => {
  it("formate un epoch en HH:MM, heure locale", () => {
    const d = new Date(2026, 8, 10, 14, 32, 0);
    expect(formaterHeureDiscrete(d.getTime())).toBe("14:32");
  });

  it("formate une chaîne ISO (cas de ChatCompaction.at)", () => {
    const iso = new Date(2026, 8, 10, 9, 5, 0).toISOString();
    expect(formaterHeureDiscrete(iso)).toBe("09:05");
  });

  it("minuit : 00:00, pas une heure vide", () => {
    const minuit = new Date(2026, 8, 10, 0, 0, 0);
    expect(formaterHeureDiscrete(minuit.getTime())).toBe("00:00");
  });

  it("horodatage absent : pas d'heure affichée, plutôt qu'une heure fausse", () => {
    expect(formaterHeureDiscrete(null)).toBeNull();
    expect(formaterHeureDiscrete(undefined)).toBeNull();
  });

  it("chaîne invalide : pas d'heure fausse non plus", () => {
    expect(formaterHeureDiscrete("pas une date")).toBeNull();
  });
});

describe("suivreInstant", () => {
  it("aucune valeur : rien à suivre", () => {
    expect(suivreInstant(null, null, 1000)).toBeNull();
  });

  it("nouvelle valeur : instant posé tout de suite", () => {
    expect(suivreInstant(null, "Micro inaccessible", 1000)).toEqual({
      valeur: "Micro inaccessible",
      instant: 1000,
    });
  });

  it("valeur inchangée : l'instant précédent est conservé, jamais recalculé", () => {
    const precedent = { valeur: "Transcription en cours… 40 %", instant: 1000 };
    // Un re-rendu qui ne change pas la valeur ne doit PAS faire dériver
    // l'heure affichée, même si beaucoup de temps a passé entretemps.
    expect(suivreInstant(precedent, "Transcription en cours… 40 %", 9999)).toBe(precedent);
  });

  it("valeur qui change : nouvel instant (le flux Whisper avance)", () => {
    const precedent = { valeur: "Transcription en cours… 40 %", instant: 1000 };
    expect(suivreInstant(precedent, "Transcription en cours… 62 %", 2000)).toEqual({
      valeur: "Transcription en cours… 62 %",
      instant: 2000,
    });
  });

  it("la valeur disparaît (null) : le suivi s'efface", () => {
    const precedent = { valeur: "Segment ignoré", instant: 1000 };
    expect(suivreInstant(precedent, null, 2000)).toBeNull();
  });
});
