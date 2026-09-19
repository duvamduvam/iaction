/*
 * `dimensionsPng` (T-048, segment 3) : lit largeur/hauteur directement dans
 * l'en-tête `IHDR` d'un PNG, sans décoder l'image — voir clipboardClient.ts.
 */
import { describe, expect, it } from "vitest";
import { dimensionsPng } from "./clipboardClient";

/** Construit un en-tête PNG minimal (signature + IHDR) portant `largeur`×`hauteur`. */
function enTetePng(largeur: number, hauteur: number): Uint8Array {
  const bytes = new Uint8Array(24);
  const vue = new DataView(bytes.buffer);
  // Signature PNG (8 octets), longueur du chunk IHDR (4 octets) : sans objet
  // ici, seuls les octets 16..24 sont lus par `dimensionsPng`.
  vue.setUint32(16, largeur);
  vue.setUint32(20, hauteur);
  return bytes;
}

describe("dimensionsPng", () => {
  it("lit largeur et hauteur dans l'en-tête IHDR", () => {
    expect(dimensionsPng(enTetePng(1920, 1080))).toEqual({ largeur: 1920, hauteur: 1080 });
  });

  it("renvoie `null` pour un tampon trop court pour porter un en-tête", () => {
    expect(dimensionsPng(new Uint8Array(10))).toBeNull();
  });

  it("renvoie `null` pour un tampon vide (pas d'image)", () => {
    expect(dimensionsPng(new Uint8Array(0))).toBeNull();
  });
});
