import { createElement as h, Fragment } from "react";
import { describe, expect, it } from "vitest";
import { calculerPosition } from "./ancrePopover";
import { filtrerOptions, indexSaisie, indexVoisin, lireOptions, optionCourante, type OptionDeroulant } from "./deroulantCalc";

const opt = (value: string, label = value, disabled = false): OptionDeroulant => ({ value, label, disabled, groupe: null });

describe("lireOptions", () => {
  it("lit tableaux, conditions, fragments et groupes comme un <select>", () => {
    const options = lireOptions([
      h("option", { key: "a", value: "" }, "Aucun"),
      false,
      null,
      h(Fragment, { key: "f" }, h("option", { value: "b", title: "aide" }, "B")),
      h("optgroup", { key: "g", label: "Projet" }, [h("option", { key: "c", value: "c", disabled: true }, "C")]),
    ]);
    expect(options).toEqual([
      { value: "", label: "Aucun", title: undefined, disabled: false, groupe: null },
      { value: "b", label: "B", title: "aide", disabled: false, groupe: null },
      { value: "c", label: "C", title: undefined, disabled: true, groupe: "Projet" },
    ]);
  });

  it("recompose un libellé en plusieurs morceaux et convertit les valeurs numériques", () => {
    const [option] = lireOptions(h("option", { value: 3 }, "Modèle ", 3, " — ", h("b", null, "gras")));
    expect(option).toMatchObject({ value: "3", label: "Modèle 3 — gras" });
  });

  it("une option sans value vaut son texte", () => {
    expect(lireOptions(h("option", null, "fr"))[0].value).toBe("fr");
  });
});

describe("optionCourante", () => {
  it("retombe sur la première option disponible, comme un <select> contrôlé", () => {
    const options = [opt("a", "A", true), opt("b")];
    expect(optionCourante(options, "b")?.value).toBe("b");
    expect(optionCourante(options, "absente")?.value).toBe("b");
    expect(optionCourante([], "x")).toBeNull();
  });
});

describe("filtrerOptions", () => {
  it("cherche dans le libellé et dans la valeur, et ne filtre pas sans recherche", () => {
    const options = [opt("id-rouge", "Bleu"), opt("autre", "Vert")];
    expect(filtrerOptions(options, "  ")).toBe(options);
    expect(filtrerOptions(options, "rouge").map((o) => o.label)).toEqual(["Bleu"]);
  });
});

describe("indexVoisin", () => {
  const options = [opt("a"), opt("b", "b", true), opt("c")];
  it("saute les options désactivées et boucle dans les deux sens", () => {
    expect(indexVoisin(options, 0, 1)).toBe(2);
    expect(indexVoisin(options, 2, 1)).toBe(0);
    expect(indexVoisin(options, 0, -1)).toBe(2);
    expect(indexVoisin(options, 2, -1)).toBe(0);
  });
  it("ne bouge pas si rien d'autre n'est choisissable", () => {
    expect(indexVoisin([opt("a"), opt("b", "b", true)], 0, 1)).toBe(0);
  });
});

describe("indexSaisie", () => {
  const options = [opt("1", "Global"), opt("2", "Gemma"), opt("3", "Éditeur"), opt("4", "Off", true)];
  it("une lettre répétée passe à l'occurrence suivante", () => {
    expect(indexSaisie(options, "g", 0)).toBe(1);
    expect(indexSaisie(options, "g", 1)).toBe(0);
  });
  it("plusieurs lettres affinent à partir de l'option en cours", () => {
    expect(indexSaisie(options, "gl", 0)).toBe(0);
  });
  it("ignore casse et accents, et jamais une option désactivée", () => {
    expect(indexSaisie(options, "ed", 0)).toBe(2);
    expect(indexSaisie(options, "off", 0)).toBe(-1);
  });
});

describe("calculerPosition", () => {
  const vue = { largeur: 1000, hauteur: 800 };
  const gabarit = { largeurMin: 240, hauteurMax: 300 };
  it("s'ouvre vers le bas quand la place suffit", () => {
    const p = calculerPosition({ left: 100, top: 100, bottom: 130, width: 200 }, vue, gabarit);
    expect(p).toMatchObject({ left: 100, width: 240, top: 134, hauteur: 300 });
    expect(p.bottom).toBeUndefined();
  });
  it("s'ouvre vers le haut près du bas de l'écran, sans sortir de la fenêtre", () => {
    const p = calculerPosition({ left: 900, top: 700, bottom: 730, width: 200 }, vue, gabarit);
    expect(p).toMatchObject({ left: 752, bottom: 104, hauteur: 300 });
    expect(p.top).toBeUndefined();
  });
  it("borne la hauteur à la place réelle sur un écran bas", () => {
    expect(calculerPosition({ left: 0, top: 150, bottom: 180, width: 200 }, { largeur: 1000, hauteur: 350 }, gabarit).hauteur).toBe(158);
  });
});
