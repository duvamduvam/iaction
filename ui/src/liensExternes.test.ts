/*
 * Filet global des liens web (liensExternes.ts) : un lien vers un site part
 * dans le navigateur système, un lien interne reste dans l'application.
 */
import { describe, expect, it } from "vitest";

import { lienAOuvrirDehors } from "./liensExternes";

const APP = "http://localhost:1420";

describe("lienAOuvrirDehors", () => {
  it("envoie un site web au navigateur système", () => {
    expect(lienAOuvrirDehors("https://www.123elec.com/produit.html", APP)).toBe(true); // audit-publication:ok
    expect(lienAOuvrirDehors("http://example.org", APP)).toBe(true);
  });

  it("envoie un mailto au client mail", () => {
    expect(lienAOuvrirDehors("mailto:quelqu-un@example.org", APP)).toBe(true);
  });

  it("garde les liens internes à l'application", () => {
    expect(lienAOuvrirDehors("#section", APP)).toBe(false);
    expect(lienAOuvrirDehors("/page", APP)).toBe(false);
    expect(lienAOuvrirDehors(`${APP}/autre`, APP)).toBe(false);
  });

  it("ignore les autres schémas et les adresses invalides", () => {
    expect(lienAOuvrirDehors("javascript:void(0)", APP)).toBe(false);
    expect(lienAOuvrirDehors("tauri://localhost/x", "tauri://localhost")).toBe(false);
    expect(lienAOuvrirDehors("http://[invalide", APP)).toBe(false);
  });
});
