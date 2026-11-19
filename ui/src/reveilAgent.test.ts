/*
 * T-219 — l'agent arme lui-même le réveil : armement côté UI (fonctions pures),
 * mêmes règles que le contrôle ⏰ (cible de réouverture figée, repère posé).
 */
import { describe, expect, it } from "vitest";
import { estDu, prochaineEcheance, type Reveil } from "./reveil";
import { avecReveilDemande, heuresValides, reveilDepuisDemande } from "./reveilAgent";
import type { ReveilDemandeData } from "./protocole";
import type { RuntimeAvecReveil } from "./reveilRuntime";

const MAINTENANT = new Date(2026, 10, 18, 15, 0, 0).getTime(); // 18/11/2026 15:00 locale
const REOUVERTURE = MAINTENANT + 2 * 3_600_000;
const ctx = { id: "r-1", maintenant: MAINTENANT, reouverture: REOUVERTURE };

const demande = (extra: Partial<ReveilDemandeData> = {}): ReveilDemandeData => ({
  heures: ["19:00"],
  surResetQuota: false,
  prompts: ["Reprends le lot 3"],
  raison: "reprise à 19 h",
  ...extra,
});

function runtime(reveils: Reveil[] = []): RuntimeAvecReveil & { autre: string } {
  return { reveils, reveilsHistorique: [], queuedPrompts: [], reveilNotice: null, autre: "inchangé" };
}

describe("heuresValides", () => {
  it("écarte les heures mal formées et les doublons, trie", () => {
    expect(heuresValides(["19:00", " 3:00", "19:00", "25:00", "midi", ""])).toEqual(["19:00", "3:00"]);
  });
});

describe("reveilDepuisDemande", () => {
  it("arme un réveil à heure fixe : repère posé à maintenant, aucune cible de réouverture", () => {
    const r = reveilDepuisDemande(demande(), ctx);
    if (!("reveil" in r)) throw new Error("armement attendu");
    expect(r.reveil).toEqual({
      id: "r-1",
      heures: ["19:00"],
      surResetQuota: false,
      cibleReouverture: null,
      prompts: ["Reprends le lot 3"],
      dernierDeclenchement: new Date(MAINTENANT).toISOString(),
    });
    expect(prochaineEcheance(r.reveil, MAINTENANT)).toBe(new Date(2026, 10, 18, 19, 0, 0).getTime());
    // Tout juste armé : pas « dû » (pas de rattrapage de l'occurrence de la veille).
    expect(estDu(r.reveil, MAINTENANT)).toBe(false);
  });

  it("au reset du quota : la réouverture connue est FIGÉE dans le réveil", () => {
    const r = reveilDepuisDemande(demande({ heures: [], surResetQuota: true }), ctx);
    if (!("reveil" in r)) throw new Error("armement attendu");
    expect(r.reveil.cibleReouverture).toBe(new Date(REOUVERTURE).toISOString());
    expect(prochaineEcheance(r.reveil, MAINTENANT)).toBeGreaterThan(REOUVERTURE);
  });

  it("refuse sans message à envoyer", () => {
    expect(reveilDepuisDemande(demande({ prompts: ["  ", ""] }), ctx)).toEqual({ refus: "aucun message à envoyer" });
  });

  it("refuse un réveil inerte : aucune heure valide et pas de réouverture connue", () => {
    expect(reveilDepuisDemande(demande({ heures: ["midi"] }), ctx)).toEqual({ refus: "aucune heure valide (format HH:MM)" });
    const r = reveilDepuisDemande(demande({ heures: [], surResetQuota: true }), { ...ctx, reouverture: null });
    expect("refus" in r && /réouverture de quota connue/.test(r.refus)).toBe(true);
  });

  it("au reset sans réouverture connue mais avec une heure valide : armé sur l'heure", () => {
    const r = reveilDepuisDemande(demande({ surResetQuota: true }), { ...ctx, reouverture: null });
    expect("reveil" in r && r.reveil.cibleReouverture === null && r.reveil.heures[0] === "19:00").toBe(true);
  });
});

describe("avecReveilDemande", () => {
  it("verse le réveil à la suite des armés, pose la notice, ne touche à rien d'autre", () => {
    const existant: Reveil = { id: "x", heures: ["03:00"], surResetQuota: false, cibleReouverture: null, prompts: ["a"], dernierDeclenchement: null };
    const { runtime: r, reveil, refus } = avecReveilDemande(runtime([existant]), demande({ surResetQuota: true }), ctx);
    expect(refus).toBeNull();
    expect(r.reveils).toEqual([existant, reveil]);
    expect(r.reveilNotice?.label).toBe("Réveil armé par l'agent — 19:00, réouverture du quota (annulable dans ⏰)");
    expect(r.autre).toBe("inchangé");
  });

  it("refus : réveils intacts, notice qui le dit, motif rendu", () => {
    const avant = runtime();
    const { runtime: r, reveil, refus } = avecReveilDemande(avant, demande({ heures: [] }), ctx);
    expect(reveil).toBeNull();
    expect(refus).toBe("aucune heure valide (format HH:MM)");
    expect(r.reveils).toBe(avant.reveils);
    expect(r.reveilNotice?.label).toBe("Réveil demandé par l'agent non armé — aucune heure valide (format HH:MM)");
  });
});
