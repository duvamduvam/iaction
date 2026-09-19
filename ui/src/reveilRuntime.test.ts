/*
 * Câblage partagé du réveil (T-120) — `creerDepot` (sans React, sans cadence)
 * suffit à exercer `battreReveils` : c'est tout l'intérêt de l'avoir sorti de
 * useConversationRuntime.ts (voir son en-tête).
 */
import { describe, expect, it } from "vitest";
import { creerDepot } from "./useConversationRuntime";
import { battreReveils, libelleEvenementReveil, type RuntimeAvecReveil } from "./reveilRuntime";
import type { Reveil } from "./reveil";

interface FakeRuntime extends RuntimeAvecReveil {
  entries: string[];
}

function vierge(): FakeRuntime {
  return { entries: [], reveils: [], reveilsHistorique: [], queuedPrompts: [], reveilNotice: null };
}

function reveil(partiel: Partial<Reveil> = {}): Reveil {
  return {
    id: "r1",
    heures: ["03:00"],
    surResetQuota: false,
    cibleReouverture: null,
    prompts: ["reprends"],
    dernierDeclenchement: null,
    ...partiel,
  };
}

describe("battreReveils", () => {
  it("échéance due : verse les prompts dans queuedPrompts et journalise un événement 'declenche'", () => {
    const depot = creerDepot(vierge, () => {});
    const echeance = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    depot.poser("c1", { ...vierge(), reveils: [reveil()] });

    const evts = battreReveils(depot, echeance + 5_000);

    expect(depot.lire("c1").queuedPrompts).toEqual(["reprends"]);
    expect(evts).toEqual([{ convId: "c1", reveilId: "r1", type: "declenche", nombrePrompts: 1, echeance: echeance + 5_000 }]);
    // Un réveil ne sert qu'UNE fois : retiré des armés, versé à l'historique.
    expect(depot.lire("c1").reveils).toEqual([]);
    expect(depot.lire("c1").reveilsHistorique).toEqual([
      {
        id: "r1",
        traiteA: new Date(echeance + 5_000).toISOString(),
        echeance: new Date(echeance + 5_000).toISOString(),
        heures: ["03:00"],
        surResetQuota: false,
        prompts: ["reprends"],
        issue: "declenche",
      },
    ]);
  });

  it("réveil « à un coup » (surResetQuota seul) : désarmé après versement", () => {
    const depot = creerDepot(vierge, () => {});
    const reouverture = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    depot.poser("c1", {
      ...vierge(),
      reveils: [
        reveil({ heures: [], surResetQuota: true, cibleReouverture: new Date(reouverture).toISOString() }),
      ],
    });

    // Marge appliquée : due au-delà de la cible + 60 s.
    battreReveils(depot, reouverture + 61_000);

    expect(depot.lire("c1").queuedPrompts).toEqual(["reprends"]);
    expect(depot.lire("c1").reveils).toEqual([]);
  });

  it("balaie TOUTES les conversations, pas seulement une seule", () => {
    const depot = creerDepot(vierge, () => {});
    const echeance = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    depot.poser("c1", { ...vierge(), reveils: [reveil()] });
    depot.poser("c2", { ...vierge(), reveils: [reveil()] });
    depot.poser("c3", { ...vierge() }); // pas de réveil : ignorée

    const evts = battreReveils(depot, echeance + 1_000);

    expect(evts.map((e) => e.convId).sort()).toEqual(["c1", "c2"]);
    expect(depot.lire("c3").queuedPrompts).toEqual([]);
  });

  it("échéance abandonnée (rattrapage dépassé) : pas de versement, mais dernierDeclenchement avance et l'événement est rendu", () => {
    const depot = creerDepot(vierge, () => {});
    const echeance = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    depot.poser("c1", { ...vierge(), reveils: [reveil()] });

    const maintenant = echeance + 7 * 3_600_000;
    const evts = battreReveils(depot, maintenant);

    expect(depot.lire("c1").queuedPrompts).toEqual([]);
    expect(evts).toEqual([{ convId: "c1", reveilId: "r1", type: "abandon", nombrePrompts: 1, echeance }]);
    // Retiré des armés — mais gardé en historique, marqué "abandon" : un
    // réveil perdu en silence serait l'échec muet que l'observabilité interdit.
    expect(depot.lire("c1").reveils).toEqual([]);
    expect(depot.lire("c1").reveilsHistorique.map((h) => h.issue)).toEqual(["abandon"]);
    const rebattu = battreReveils(depot, maintenant + 30_000);
    expect(rebattu).toEqual([]);
  });

  it("plusieurs réveils sur la MÊME conversation : chacun est jugé à part, tout est versé en une écriture", () => {
    const depot = creerDepot(vierge, () => {});
    const troisHeures = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    depot.poser("c1", {
      ...vierge(),
      reveils: [
        reveil({ id: "a", heures: ["03:00"], prompts: ["chantier A"] }),
        // 11:00 est encore loin à 03:00:05 : ce réveil-là ne bouge pas.
        // `dernierDeclenchement` posé à l'armement (2h) comme le fait
        // ReveilControl — sans lui, il se croirait en retard sur le 11:00 de
        // LA VEILLE, donc abandonné (16 h de retard).
        reveil({
          id: "b",
          heures: ["11:00"],
          prompts: ["bilan B"],
          dernierDeclenchement: new Date(2026, 8, 4, 2, 0, 0, 0).toISOString(),
        }),
      ],
    });

    const evts = battreReveils(depot, troisHeures + 5_000);

    expect(evts.map((e) => e.reveilId)).toEqual(["a"]);
    expect(depot.lire("c1").queuedPrompts).toEqual(["chantier A"]);
    // Le réveil intact garde son `dernierDeclenchement` d'origine.
    expect(depot.lire("c1").reveils.find((r) => r.id === "b")!.dernierDeclenchement).toBe(
      new Date(2026, 8, 4, 2, 0, 0, 0).toISOString(),
    );
  });

  it("rien à faire : aucune écriture, aucun événement", () => {
    const depot = creerDepot(vierge, () => {});
    const maintenant = new Date(2026, 8, 4, 1, 0, 0, 0).getTime();
    // dernierDeclenchement posé à l'armement (voir ReveilControl.tsx) : c'est
    // ce qui évite qu'un réveil tout juste créé se croie en retard sur
    // l'occurrence de LA VEILLE — seule la prochaine (aujourd'hui 03:00,
    // encore future ici) compte.
    depot.poser("c1", { ...vierge(), reveils: [reveil({ dernierDeclenchement: new Date(maintenant).toISOString() })] });
    const evts = battreReveils(depot, maintenant);
    expect(evts).toEqual([]);
  });
});

describe("libelleEvenementReveil", () => {
  it("déclenché : mentionne l'heure et le nombre de messages", () => {
    const echeance = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    expect(libelleEvenementReveil({ convId: "c1", reveilId: "r1", type: "declenche", nombrePrompts: 1, echeance })).toMatch(
      /Réveil de 03:00 — reprise \(1 message\)/,
    );
    expect(libelleEvenementReveil({ convId: "c1", reveilId: "r1", type: "declenche", nombrePrompts: 2, echeance })).toMatch(
      /2 messages/,
    );
  });

  it("abandonné : le dit explicitement, jamais silencieux", () => {
    const echeance = new Date(2026, 8, 4, 3, 0, 0, 0).getTime();
    expect(libelleEvenementReveil({ convId: "c1", reveilId: "r1", type: "abandon", nombrePrompts: 1, echeance })).toMatch(
      /abandonné/,
    );
  });
});
