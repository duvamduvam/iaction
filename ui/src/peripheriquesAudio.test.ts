/*
 * T-148 — entrées du menu micro et lecture de la réponse « sorties audio » :
 * le choix mémorisé ne doit jamais disparaître en silence, et une réponse mal
 * formée ne doit jamais passer pour une liste vide.
 */
import { describe, expect, it } from "vitest";
import { abonnerMicroCourant, demanderPatchConfigVoix, enregistrerTraitantConfigVoix, lireMicroCourant, publierMicroCourant } from "./busMicro";
import { construireEntreesMicro, libelleAvecEtat, lireListePeripheriques } from "./peripheriquesAudio";

const CASQUE = { deviceId: "casque-id", label: "Casque Bluetooth" };
const INTERNE = { deviceId: "interne-id", label: "Micro interne" };

describe("construireEntreesMicro", () => {
  it("commence par le défaut système, puis les micros énumérés", () => {
    const e = construireEntreesMicro([INTERNE, CASQUE], "");
    expect(e.map((x) => x.valeur)).toEqual(["", "interne-id", "casque-id"]);
    expect(e[0]?.libelle).toBe("Défaut système");
    expect(e.some((x) => x.indisponible)).toBe(false);
  });

  it("écarte les identifiants vides et les doublons", () => {
    const e = construireEntreesMicro([{ deviceId: "", label: "Micro 1" }, CASQUE, CASQUE], "");
    expect(e.map((x) => x.valeur)).toEqual(["", "casque-id"]);
  });

  it("garde visible un micro mémorisé absent de la liste, marqué indisponible", () => {
    const e = construireEntreesMicro([INTERNE], "casque-id");
    const dernier = e[e.length - 1];
    expect(dernier).toEqual({ valeur: "casque-id", libelle: "Micro mémorisé (indisponible)", indisponible: true });
  });

  it("ne marque pas le défaut système comme indisponible", () => {
    expect(construireEntreesMicro([], "").every((x) => !x.indisponible)).toBe(true);
  });
});

describe("lireListePeripheriques", () => {
  const unePeripherique = { nom: "a", libelle: "A", parDefaut: true, coupe: false };

  it("lit une réponse bien formée, état coupé compris", () => {
    const r = lireListePeripheriques({
      prisEnCharge: true,
      peripheriques: [unePeripherique, { nom: "b", libelle: "B", parDefaut: false, coupe: true }],
    });
    expect(r.peripheriques[1]).toEqual({ nom: "b", libelle: "B", parDefaut: false, coupe: true });
  });

  it("accepte « non pris en charge » avec une liste vide", () => {
    expect(lireListePeripheriques({ prisEnCharge: false, peripheriques: [] })).toEqual({
      prisEnCharge: false,
      peripheriques: [],
    });
  });

  it("lève sur une forme inattendue au lieu de répondre « aucun périphérique »", () => {
    expect(() => lireListePeripheriques(null)).toThrow();
    expect(() => lireListePeripheriques({ peripheriques: [] })).toThrow();
    expect(() => lireListePeripheriques({ prisEnCharge: true, peripheriques: [{ nom: "a" }] })).toThrow();
    // Une coquille d'avant l'état coupé ne passe pas pour « tout est audible ».
    expect(() =>
      lireListePeripheriques({ prisEnCharge: true, peripheriques: [{ nom: "a", libelle: "A", parDefaut: true }] }),
    ).toThrow();
  });
});

describe("libelleAvecEtat", () => {
  it("signale un périphérique coupé, et lui seul", () => {
    expect(libelleAvecEtat({ nom: "a", libelle: "Audio interne", parDefaut: true, coupe: true })).toBe(
      "Audio interne (coupé)",
    );
    expect(libelleAvecEtat({ nom: "a", libelle: "M50", parDefaut: false, coupe: false })).toBe("M50");
  });
});

describe("busMicro", () => {
  it("publie le micro courant aux abonnés, une fois par changement réel", () => {
    let appels = 0;
    const desabonner = abonnerMicroCourant(() => {
      appels += 1;
    });
    publierMicroCourant("x");
    publierMicroCourant("x");
    expect(lireMicroCourant()).toBe("x");
    expect(appels).toBe(1);
    desabonner();
    publierMicroCourant("");
    expect(appels).toBe(1);
  });

  it("rejette une demande de patch sans traitant, puis la transmet quand il existe", async () => {
    await expect(demanderPatchConfigVoix({ stt: { inputDeviceId: "a" } })).rejects.toThrow();
    const recus: unknown[] = [];
    const retirer = enregistrerTraitantConfigVoix(async (patch) => {
      recus.push(patch);
    });
    await demanderPatchConfigVoix({ stt: { inputDeviceId: "a" } });
    expect(recus).toEqual([{ stt: { inputDeviceId: "a" } }]);
    retirer();
    await expect(demanderPatchConfigVoix({})).rejects.toThrow();
  });
});
