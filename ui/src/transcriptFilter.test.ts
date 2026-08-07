/*
 * Filtre des transcriptions fantômes (hallucinations Whisper).
 *
 * L'enjeu du mode conversation : une hallucination non filtrée part au LLM
 * comme un vrai tour de parole ; un vrai tour filtré à tort est perdu. Le
 * filtre est donc volontairement conservateur — ces tests verrouillent les
 * deux bords : ce qui DOIT être avalé, ce qui ne doit JAMAIS l'être.
 */
import { describe, expect, it } from "vitest";
import { isLikelyHallucination, normalizeForCompare } from "./transcriptFilter";

describe("normalizeForCompare", () => {
  it("aplanit casse, accents et ponctuation", () => {
    expect(normalizeForCompare("Merci d'avoir regardé cette vidéo !")).toBe(
      "merci d avoir regarde cette video",
    );
  });

  it("compacte les espaces et rogne", () => {
    expect(normalizeForCompare("  Merci   à tous...  ")).toBe("merci a tous");
  });

  it("réduit la ponctuation pure à une chaîne vide", () => {
    expect(normalizeForCompare("... — ♪♪")).toBe("");
  });
});

describe("isLikelyHallucination — ce qui doit être avalé", () => {
  it("le vide et la ponctuation pure", () => {
    expect(isLikelyHallucination("")).toBe(true);
    expect(isLikelyHallucination("...")).toBe(true);
    expect(isLikelyHallucination(" ♪ ")).toBe(true);
  });

  it("les formules de fin de vidéo, quelles que soient casse et ponctuation", () => {
    expect(isLikelyHallucination("Sous-titres réalisés par la communauté d'Amara.org")).toBe(true);
    expect(isLikelyHallucination("merci d'avoir regarde cette video...")).toBe(true);
    expect(isLikelyHallucination("THANKS FOR WATCHING!")).toBe(true);
  });

  it("les résidus d'un seul mot très court sur du silence", () => {
    expect(isLikelyHallucination("you")).toBe(true);
    expect(isLikelyHallucination("eh")).toBe(true);
  });
});

describe("isLikelyHallucination — ce qui ne doit JAMAIS l'être", () => {
  it("les mots courts porteurs de sens", () => {
    expect(isLikelyHallucination("ok")).toBe(false);
    expect(isLikelyHallucination("si")).toBe(false);
  });

  it("une vraie phrase, même contenant une formule connue", () => {
    // La comparaison est sur le texte ENTIER : une phrase qui englobe un motif
    // n'est pas le motif. Filtrer par inclusion mangerait de vrais tours.
    expect(isLikelyHallucination("dis merci à tous les participants dans le compte rendu")).toBe(false);
  });

  it("une question brève légitime", () => {
    expect(isLikelyHallucination("Pourquoi ?")).toBe(false);
  });
});
