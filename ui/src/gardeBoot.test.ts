/*
 * Garde-fou de démarrage (T-009).
 *
 * Ce qui est verrouillé ici n'est pas « un minuteur se déclenche » : c'est que
 * l'avis ne part JAMAIS quand la coquille a répondu, même tardivement, et qu'il
 * ne part jamais deux fois. Un bandeau qui apparaît sur une application qui
 * marche détruirait la confiance qu'on cherche à établir.
 */

import { describe, expect, it } from "vitest";

import { armerGardeBoot, DELAI_SILENCE_MS } from "./gardeBoot";

/** Minuteur manuel : le temps n'avance que quand le test le décide. */
function minuteurManuel() {
  const poses: Array<{ fn: () => void; ms: number; annule: boolean }> = [];
  return {
    poser: (fn: () => void, ms: number) => {
      poses.push({ fn, ms, annule: false });
      return poses.length - 1;
    },
    annuler: (h: unknown) => {
      const p = poses[h as number];
      if (p) p.annule = true;
    },
    ecouler() {
      for (const p of poses) if (!p.annule) p.fn();
    },
    poses,
  };
}

describe("garde-fou de démarrage", () => {
  it("prévient quand rien n'a répondu dans le délai", () => {
    const t = minuteurManuel();
    let avis = 0;
    armerGardeBoot({ auSilence: () => (avis += 1), poserMinuteur: t.poser, annulerMinuteur: t.annuler });
    t.ecouler();
    expect(avis).toBe(1);
  });

  it("se tait dès qu'une réponse est arrivée", () => {
    const t = minuteurManuel();
    let avis = 0;
    const garde = armerGardeBoot({
      auSilence: () => (avis += 1),
      poserMinuteur: t.poser,
      annulerMinuteur: t.annuler,
    });
    garde.signalerVivant();
    t.ecouler();
    expect(avis).toBe(0);
  });

  it("ne parle jamais deux fois", () => {
    const t = minuteurManuel();
    let avis = 0;
    armerGardeBoot({ auSilence: () => (avis += 1), poserMinuteur: t.poser, annulerMinuteur: t.annuler });
    t.ecouler();
    t.ecouler();
    expect(avis).toBe(1);
  });

  it("se tait après démontage", () => {
    const t = minuteurManuel();
    let avis = 0;
    const garde = armerGardeBoot({
      auSilence: () => (avis += 1),
      poserMinuteur: t.poser,
      annulerMinuteur: t.annuler,
    });
    garde.arreter();
    t.ecouler();
    expect(avis).toBe(0);
  });

  it("laisse une marge large devant le démarrage mesuré", () => {
    // T-029 a mesuré ~1,3 s entre le script et la première image sur ce poste.
    // Un délai serré ferait crier la garde sur une machine simplement chargée.
    expect(DELAI_SILENCE_MS).toBeGreaterThanOrEqual(5000);
  });

  it("arme son minuteur sur le délai demandé", () => {
    const t = minuteurManuel();
    armerGardeBoot({ delaiMs: 1234, auSilence: () => {}, poserMinuteur: t.poser, annulerMinuteur: t.annuler });
    expect(t.poses[0].ms).toBe(1234);
  });
});
