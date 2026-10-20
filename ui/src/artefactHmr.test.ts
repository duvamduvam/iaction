/*
 * Reconnaissance de la famille d'erreurs HMR (T-116).
 *
 * Ce que ces tests protègent : la fonction ne doit reconnaître QUE les formes
 * de message qu'un graphe HMR périmé produit réellement (les deux moteurs
 * système de Tauri, WebKit et Chromium, plus la variante TDZ et le message
 * React des hooks) — pas n'importe quel message qui y ressemble de loin, sous
 * peine de faire disparaître un vrai crash de rendu dans le bruit.
 */
import { describe, expect, it } from "vitest";
import { estArtefactHmr } from "./artefactHmr";

describe("estArtefactHmr — la famille HMR", () => {
  it("reconnaît la forme WebKit « Can't find variable: X »", () => {
    expect(estArtefactHmr("Can't find variable: splitFeatured")).toBe(true);
  });

  it("reconnaît la forme WebKit avec l'apostrophe typographique", () => {
    expect(estArtefactHmr("Can’t find variable: closeFileTab")).toBe(true);
  });

  it("reconnaît la forme Chromium « X is not defined »", () => {
    expect(estArtefactHmr("useComposerLiveDraft is not defined")).toBe(true);
  });

  it("reconnaît la TDZ façon V8 « Cannot access 'X' before initialization »", () => {
    expect(estArtefactHmr("Cannot access 'splitFeatured' before initialization")).toBe(true);
  });

  it("reconnaît la TDZ façon Firefox « can't access lexical declaration 'X' before initialization »", () => {
    expect(
      estArtefactHmr("can't access lexical declaration 'splitFeatured' before initialization"),
    ).toBe(true);
  });

  it("reconnaît le message React « Rendered fewer hooks than expected »", () => {
    expect(
      estArtefactHmr(
        "Rendered fewer hooks than expected. This may be caused by an accidental early return statement.",
      ),
    ).toBe(true);
  });

  it("ignore la casse", () => {
    expect(estArtefactHmr("CAN'T FIND VARIABLE: X")).toBe(true);
    expect(estArtefactHmr("x IS NOT DEFINED")).toBe(true);
  });

  it("ne reconnaît PAS un crash de rendu quelconque", () => {
    expect(
      estArtefactHmr("boom : le sidecar a renvoyé un objet inattendu"),
    ).toBe(false);
    expect(estArtefactHmr("TypeError: Cannot read properties of undefined (reading 'map')")).toBe(
      false,
    );
    expect(estArtefactHmr("Network request failed")).toBe(false);
  });

  it("ne se laisse pas piéger par une phrase qui contient « defined » sans être la forme exacte", () => {
    expect(estArtefactHmr("le comportement n'est pas encore defined dans ce cas")).toBe(false);
  });

  it("message vide ou blanc : jamais un artefact", () => {
    expect(estArtefactHmr("")).toBe(false);
    expect(estArtefactHmr("   ")).toBe(false);
  });
});
