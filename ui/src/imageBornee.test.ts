import { describe, expect, it } from "vitest";
import { COTE_MAX_IMAGE, dimensionsBornees } from "./imageBornee";

describe("dimensionsBornees (T-144)", () => {
  it("laisse intacte une image qui tient déjà, bord compris", () => {
    expect(dimensionsBornees(2000, 909)).toEqual({ largeur: 2000, hauteur: 909, reduite: false });
    expect(dimensionsBornees(800, 600)).toEqual({ largeur: 800, hauteur: 600, reduite: false });
  });

  it("réduit la capture du constat (2464×1508) sous la limite, ratio conservé", () => {
    const r = dimensionsBornees(2464, 1508);
    expect(r.reduite).toBe(true);
    expect(r.largeur).toBe(COTE_MAX_IMAGE);
    expect(r.hauteur).toBe(1224);
  });

  it("borne aussi une image en portrait par sa hauteur", () => {
    const r = dimensionsBornees(1500, 4000);
    expect(r).toEqual({ largeur: 750, hauteur: 2000, reduite: true });
  });
});
