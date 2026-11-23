import { describe, expect, it, vi } from "vitest";

vi.mock("./sidecar", () => ({ request: vi.fn() }));

import { diffuserSansId, ecouterEvenement, subscribeReady } from "./evenementsSidecar";
import { ecouterVeilleur, parseStatutVeilleur } from "./veilleurClient";

describe("parseStatutVeilleur", () => {
  it("statut complet", () => {
    const s = parseStatutVeilleur({
      etat: "suspendu",
      cwd: "/p",
      motif: "coût dépassé",
      derniereReleve: "2026-11-20T10:00:00.000Z",
      dernierBilan: { traites: ["m1"], refuses: [], ignores: [], invalides: [], suspendu: true },
      toursAujourdhui: 3,
      enCours: false,
    });
    expect(s?.etat).toBe("suspendu");
    expect(s?.dernierBilan?.suspendu).toBe(true);
    expect(s?.toursAujourdhui).toBe(3);
  });

  it("état inconnu : null, jamais un statut inventé", () => {
    expect(parseStatutVeilleur({ etat: "bizarre" })).toBeNull();
    expect(parseStatutVeilleur({})).toBeNull();
  });

  it("champs absents ou mal typés : défauts sûrs", () => {
    expect(parseStatutVeilleur({ etat: "actif", toursAujourdhui: "3", dernierBilan: "x" })).toEqual({
      etat: "actif",
      cwd: null,
      motif: null,
      derniereReleve: null,
      dernierBilan: null,
      toursAujourdhui: 0,
      enCours: false,
    });
  });
});

describe("événements non sollicités", () => {
  it("l'événement veilleur atteint ses abonnés, illisible écarté", () => {
    const vus: string[] = [];
    const off = ecouterVeilleur((s) => vus.push(s.etat));
    diffuserSansId("veilleur", { etat: "actif" });
    diffuserSansId("veilleur", { etat: "??" });
    off();
    diffuserSansId("veilleur", { etat: "inactif" });
    expect(vus).toEqual(["actif"]);
  });

  it("ready passe toujours par subscribeReady ; un abonné qui lève ne prive pas les autres", () => {
    const erreur = vi.spyOn(console, "error").mockImplementation(() => {});
    const vus: number[] = [];
    const off1 = ecouterEvenement("ready", () => {
      throw new Error("boum");
    });
    const off2 = subscribeReady((info) => vus.push(info.pid));
    diffuserSansId("ready", { version: "x", pid: 42 });
    off1();
    off2();
    expect(vus).toEqual([42]);
    expect(erreur).toHaveBeenCalled();
    erreur.mockRestore();
  });
});
