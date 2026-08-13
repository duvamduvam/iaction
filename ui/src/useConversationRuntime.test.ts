/*
 * Le moteur de conversation partagé par le Chat et les Projets.
 *
 * Les cas ci-dessous fixent les deux comportements qui, mal reproduits,
 * casseraient l'affichage sans casser la compilation :
 *
 *   1. `amorcer` ne doit JAMAIS écraser un runtime vivant — sans quoi
 *      rouvrir l'onglet d'une conversation en cours de streaming la remet à
 *      zéro sous les yeux de l'utilisateur ;
 *   2. `ecrire` prévient, `poser` ne prévient pas. Confondre les deux donne
 *      soit un onglet en arrière-plan qui n'affiche jamais son point « ● »,
 *      soit un rendu complet à chaque caractère tapé ;
 *   3. la cadence de rendu du streaming (T-031) : à front montant, jamais en
 *      file, et sans jamais retarder la DONNÉE — un défaut ici ne casserait
 *      rien de visible en test, il rendrait seulement l'écriture saccadée.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CADENCE_RENDU_MS, creerDepot, creerRythme } from "./useConversationRuntime";

interface FauxRuntime {
  turns: string[];
  streaming: boolean;
}

const vierge = (): FauxRuntime => ({ turns: [], streaming: false });

function depotDeTest() {
  const prevenir = vi.fn();
  return { depot: creerDepot<FauxRuntime>(vierge, prevenir), prevenir };
}

describe("lire", () => {
  it("crée un runtime vierge à la volée", () => {
    const { depot } = depotDeTest();
    expect(depot.lire("c1")).toEqual({ turns: [], streaming: false });
  });

  it("rend le MÊME objet aux lectures suivantes", () => {
    const { depot } = depotDeTest();
    expect(depot.lire("c1")).toBe(depot.lire("c1"));
  });

  it("ne prévient pas : lire n'est pas une mutation visible", () => {
    const { depot, prevenir } = depotDeTest();
    depot.lire("c1");
    expect(prevenir).not.toHaveBeenCalled();
  });
});

describe("consulter", () => {
  it("ne crée rien — c'est toute la différence avec lire", () => {
    const { depot } = depotDeTest();
    expect(depot.consulter("c1")).toBeUndefined();
    expect(depot.connait("c1")).toBe(false);
  });

  it("permet le test d'état sans faire naître une conversation fantôme", () => {
    const { depot } = depotDeTest();
    depot.ecrire("c1", (r) => ({ ...r, streaming: true }));
    expect(depot.consulter("c1")?.streaming).toBe(true);
    expect(depot.consulter("jamais-ouverte")?.streaming).toBeUndefined();
  });
});

describe("amorcer", () => {
  it("pose le runtime d'une conversation encore jamais ouverte", () => {
    const { depot } = depotDeTest();
    depot.amorcer("c1", () => ({ turns: ["repris du disque"], streaming: false }));
    expect(depot.lire("c1").turns).toEqual(["repris du disque"]);
  });

  it("N'ÉCRASE PAS un runtime vivant, même en cours de streaming", () => {
    // Le cas qui compte : rouvrir l'onglet d'une conversation qui répond ne
    // doit pas la réinitialiser depuis sa dernière copie disque.
    const { depot } = depotDeTest();
    depot.ecrire("c1", () => ({ turns: ["en cours"], streaming: true }));
    depot.amorcer("c1", () => ({ turns: ["vieille copie"], streaming: false }));
    expect(depot.lire("c1")).toEqual({ turns: ["en cours"], streaming: true });
  });

  it("n'appelle pas la fabrique quand le runtime existe déjà", () => {
    const { depot } = depotDeTest();
    const fabrique = vi.fn(vierge);
    depot.lire("c1");
    depot.amorcer("c1", fabrique);
    expect(fabrique).not.toHaveBeenCalled();
  });
});

describe("ecrire et poser — la distinction qui fait tout", () => {
  it("ecrire applique la mise à jour ET prévient", () => {
    const { depot, prevenir } = depotDeTest();
    depot.ecrire("c1", (r) => ({ ...r, turns: [...r.turns, "a"] }));
    expect(depot.lire("c1").turns).toEqual(["a"]);
    expect(prevenir).toHaveBeenCalledTimes(1);
  });

  it("ecrire part du runtime vierge quand la conversation est neuve", () => {
    const { depot } = depotDeTest();
    depot.ecrire("neuve", (r) => ({ ...r, turns: [...r.turns, "premier"] }));
    expect(depot.lire("neuve").turns).toEqual(["premier"]);
  });

  it("poser écrit SANS prévenir — un rendu par caractère tapé coûterait cher", () => {
    const { depot, prevenir } = depotDeTest();
    depot.poser("c1", { turns: ["brouillon"], streaming: false });
    expect(depot.lire("c1").turns).toEqual(["brouillon"]);
    expect(prevenir).not.toHaveBeenCalled();
  });

  it("prévient une fois par écriture, pas une fois pour toutes", () => {
    const { depot, prevenir } = depotDeTest();
    depot.ecrire("c1", (r) => r);
    depot.ecrire("c2", (r) => r);
    depot.ecrire("c1", (r) => r);
    expect(prevenir).toHaveBeenCalledTimes(3);
  });
});

describe("cycle de vie", () => {
  it("oublier retire la conversation fermée", () => {
    const { depot } = depotDeTest();
    depot.ecrire("c1", (r) => ({ ...r, streaming: true }));
    depot.oublier("c1");
    expect(depot.connait("c1")).toBe(false);
  });

  it("les conversations restent isolées les unes des autres", () => {
    // Les callbacks de streaming capturent leur id par fermeture : écrire dans
    // l'une pendant que l'autre répond ne doit rien mélanger.
    const { depot } = depotDeTest();
    depot.ecrire("c1", (r) => ({ ...r, turns: ["un"] }));
    depot.ecrire("c2", (r) => ({ ...r, turns: ["deux"] }));
    expect(depot.lire("c1").turns).toEqual(["un"]);
    expect(depot.lire("c2").turns).toEqual(["deux"]);
  });

  it("entrees parcourt toutes les conversations vivantes", () => {
    const { depot } = depotDeTest();
    depot.ecrire("c1", (r) => ({ ...r, streaming: true }));
    depot.lire("c2");
    expect([...depot.entrees()].map(([id]) => id).sort()).toEqual(["c1", "c2"]);
  });

  it("reinitialiser vide tout — changement de projet", () => {
    const { depot } = depotDeTest();
    depot.ecrire("c1", (r) => ({ ...r, streaming: true }));
    depot.reinitialiser();
    expect(depot.connait("c1")).toBe(false);
    expect([...depot.entrees()]).toEqual([]);
  });

  it("reinitialiser accepte une Map de départ — élagage en bloc", () => {
    const { depot } = depotDeTest();
    depot.ecrire("garder", (r) => ({ ...r, turns: ["x"] }));
    depot.ecrire("jeter", (r) => r);
    const gardes = new Map([...depot.entrees()].filter(([id]) => id === "garder"));
    depot.reinitialiser(gardes);
    expect(depot.connait("garder")).toBe(true);
    expect(depot.connait("jeter")).toBe(false);
    expect(depot.lire("garder").turns).toEqual(["x"]);
  });
});

describe("creerRythme — la cadence de rendu du streaming (T-031)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function rythmeDeTest() {
    vi.useFakeTimers();
    const rendre = vi.fn();
    return { rythme: creerRythme(rendre), rendre };
  }

  it("rend TOUT DE SUITE la première demande — un geste isolé ne doit jamais attendre", () => {
    const { rythme, rendre } = rythmeDeTest();
    rythme.demander();
    expect(rendre).toHaveBeenCalledTimes(1);
  });

  it("regroupe une rafale en UN seul rendu de rattrapage", () => {
    // Le cas réel : cent fragments de réponse arrivent dans la même fenêtre.
    const { rythme, rendre } = rythmeDeTest();
    for (let i = 0; i < 100; i += 1) rythme.demander();
    expect(rendre).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CADENCE_RENDU_MS);
    expect(rendre).toHaveBeenCalledTimes(2);
  });

  it("ne met pas les demandes en file : la fenêtre suivante n'en rejoue pas cent", () => {
    const { rythme, rendre } = rythmeDeTest();
    for (let i = 0; i < 100; i += 1) rythme.demander();
    vi.advanceTimersByTime(CADENCE_RENDU_MS * 10);
    expect(rendre).toHaveBeenCalledTimes(2);
  });

  it("rend de nouveau sans délai une fois la fenêtre passée", () => {
    const { rythme, rendre } = rythmeDeTest();
    rythme.demander();
    vi.advanceTimersByTime(CADENCE_RENDU_MS);
    rythme.demander();
    expect(rendre).toHaveBeenCalledTimes(2);
  });

  it("arreter oublie le rendu en attente — démontage", () => {
    const { rythme, rendre } = rythmeDeTest();
    rythme.demander();
    rythme.demander();
    rythme.arreter();
    vi.advanceTimersByTime(CADENCE_RENDU_MS * 10);
    expect(rendre).toHaveBeenCalledTimes(1);
  });
});

describe("la donnée n'est jamais retardée par la cadence", () => {
  it("ecrire pose la valeur AVANT d'avertir — l'envoi et la persistance lisent le dépôt", () => {
    // L'invariant qui protège l'envoi, la persistance et l'abandon : ils
    // lisent le dépôt, pas le dernier rendu. Une cadence qui différerait
    // l'écriture, et non l'affichage, enverrait un message tronqué.
    const vues: string[][] = [];
    const depot = creerDepot<FauxRuntime>(vierge, () => vues.push([...depot.lire("c1").turns]));
    depot.ecrire("c1", (r) => ({ ...r, turns: [...r.turns, "fragment"] }));
    expect(vues).toEqual([["fragment"]]);
  });
});
