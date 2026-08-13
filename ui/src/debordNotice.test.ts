/*
 * Bandeau de débord d'abonnement.
 *
 * Ce bandeau parle d'argent : il prévient l'utilisateur qu'un tour part sur le
 * moteur payant au lieu de son abonnement. Se tromper ici, c'est soit facturer
 * en silence, soit affoler pour rien.
 */
import { describe, expect, it } from "vitest";
import { appliquerDebordNotice, calculerDebordNotice, libelleDebordNotice, plafondRequis } from "./debordNotice";
import type { DebordNotice } from "./debordNotice";

const actif = { active: true, blocked: false, fiveHourPct: 82, sevenDayPct: null };
const bloque = { active: true, blocked: true, fiveHourPct: 100, sevenDayPct: null };

describe("calculerDebordNotice", () => {
  it("aucun débord : aucun bandeau", () => {
    expect(calculerDebordNotice(null, "gpt-x")).toBeNull();
  });

  it("débord actif : le modèle payant est nommé", () => {
    expect(calculerDebordNotice(actif, "gpt-x")).toEqual({
      blocked: false,
      fiveHourPct: 82, sevenDayPct: null,
      model: "gpt-x",
      plafondUsdMois: null,
    });
  });

  it("débord bloqué : le plafond lu est reporté tel quel", () => {
    expect(calculerDebordNotice(bloque, "gpt-x", { plafondUsdMois: 20 })?.plafondUsdMois).toBe(20);
  });

  it("cible non déclarée : bandeau spécifique, JAMAIS marqué bloqué", () => {
    // Le tour est resté sur l'abonnement : l'annoncer comme bloqué ferait
    // croire à une dépense qui n'a pas eu lieu.
    expect(calculerDebordNotice(null, "gpt-x", { unconfigured: true })).toEqual({
      blocked: false,
      fiveHourPct: null, sevenDayPct: null,
      model: "gpt-x",
      plafondUsdMois: null,
      unconfigured: true,
    });
  });

  it("« non déclarée » prime sur un débord signalé", () => {
    expect(calculerDebordNotice(bloque, "gpt-x", { unconfigured: true })?.unconfigured).toBe(true);
  });
});

describe("plafondRequis", () => {
  it("seul un débord BLOQUÉ justifie la lecture disque", () => {
    expect(plafondRequis(bloque, false)).toBe(true);
    expect(plafondRequis(actif, false)).toBe(false);
    expect(plafondRequis(null, false)).toBe(false);
    expect(plafondRequis(bloque, true)).toBe(false);
  });
});

describe("appliquerDebordNotice", () => {
  interface FauxRuntime {
    debordNotice: DebordNotice | null;
  }

  const plafondJamais = () => Promise.reject(new Error("ne doit pas être appelée"));

  function ecrivain(depart: DebordNotice | null) {
    let etat: FauxRuntime = { debordNotice: depart };
    const appels: FauxRuntime[] = [];
    return {
      ecrire: (majeur: (prev: FauxRuntime) => FauxRuntime) => {
        etat = majeur(etat);
        appels.push(etat);
      },
      get etat() {
        return etat;
      },
      appels,
    };
  }

  it("efface un bandeau devenu inutile", async () => {
    const w = ecrivain({ blocked: true, fiveHourPct: 100, sevenDayPct: null, model: "x", plafondUsdMois: 20 });
    await appliquerDebordNotice(w.ecrire, { debord: null, model: "x", lirePlafond: plafondJamais });
    expect(w.etat.debordNotice).toBeNull();
  });

  it("ne remplace RIEN quand il n'y avait déjà pas de bandeau", async () => {
    // Le cas courant — un tour normal. Remplacer l'objet provoquerait un rendu
    // à chaque tour, pour rien.
    const w = ecrivain(null);
    await appliquerDebordNotice(w.ecrire, { debord: null, model: "x", lirePlafond: plafondJamais });
    expect(w.appels).toHaveLength(1);
    expect(w.appels[0].debordNotice).toBeNull();
    expect(w.etat).toEqual({ debordNotice: null });
  });

  it("pose le bandeau « cible non déclarée » sans toucher au disque", async () => {
    const w = ecrivain(null);
    await appliquerDebordNotice(w.ecrire, { debord: null, model: "gpt-x", unconfigured: true, lirePlafond: plafondJamais });
    expect(w.etat.debordNotice?.unconfigured).toBe(true);
  });

  it("pose un bandeau de débord actif", async () => {
    const w = ecrivain(null);
    await appliquerDebordNotice(w.ecrire, { debord: actif, model: "gpt-x", lirePlafond: plafondJamais });
    expect(w.etat.debordNotice).toEqual({
      blocked: false,
      fiveHourPct: 82, sevenDayPct: null,
      model: "gpt-x",
      plafondUsdMois: null,
    });
  });

  it("ne lit le plafond QUE pour un débord bloqué", async () => {
    const w = ecrivain(null);
    let appelee = false;
    await appliquerDebordNotice(w.ecrire, {
      debord: actif,
      model: "gpt-x",
      lirePlafond: async () => {
        appelee = true;
        return 20;
      },
    });
    expect(appelee).toBe(false);
  });

  it("survit à une lecture de plafond en échec", async () => {
    // Un bandeau qui n'apparaît pas parce que la config est illisible serait
    // le pire des deux mondes : on facture et on ne le dit pas.
    const w = ecrivain(null);
    await appliquerDebordNotice(w.ecrire, {
      debord: bloque,
      model: "gpt-x",
      lirePlafond: () => Promise.reject(new Error("disque")),
    });
    expect(w.etat.debordNotice).toEqual({
      blocked: true,
      fiveHourPct: 100, sevenDayPct: null,
      model: "gpt-x",
      plafondUsdMois: null,
    });
  });
});

describe("libelleDebordNotice — le texte du bandeau, une seule fois pour les deux pages", () => {
  const base = { blocked: false, fiveHourPct: 95, sevenDayPct: null, model: "deepseek", plafondUsdMois: null };

  it("débord actif : nomme la fenêtre la plus saturée", () => {
    expect(libelleDebordNotice(base)).toBe(
      "⚠ Mode débord : abonnement saturé (fenêtre 5 h à 95 %) — tour envoyé sur deepseek",
    );
    expect(libelleDebordNotice({ ...base, fiveHourPct: 50, sevenDayPct: 100 })).toContain("fenêtre 7 jours à 100 %");
    // Vieux sidecar sans pourcentages : pas de parenthèse « à -1 % ».
    expect(libelleDebordNotice({ ...base, fiveHourPct: null })).toBe(
      "⚠ Mode débord : abonnement saturé — tour envoyé sur deepseek",
    );
  });

  it("bloqué : le plafond s'affiche, « ? » quand il est inconnu", () => {
    expect(libelleDebordNotice({ ...base, blocked: true, plafondUsdMois: 10 })).toContain("(10 $/mois)");
    expect(libelleDebordNotice({ ...base, blocked: true })).toContain("(? $/mois)");
  });

  it("cible non configurée : le tour est resté sur l'abonnement, le bandeau le dit", () => {
    expect(libelleDebordNotice({ ...base, unconfigured: true })).toContain("non configurée");
  });
});
