/*
 * `ancrerPanneau` seule : la décision de placement du panneau du réveil,
 * testable sans DOM (voir l'en-tête de ReveilControl.tsx — le projet n'a pas
 * d'environnement DOM en test, d'où l'extraction d'une fonction pure qui reçoit
 * le rectangle de l'icône et la taille de la vue).
 *
 * Ce qui doit tenir : le panneau reste DANS l'écran (une icône logée dans une
 * colonne latérale de 300 px porte un panneau de 520 px), et il s'ouvre vers le
 * bas quand le dessus ne peut plus l'accueillir.
 */

import { describe, expect, it } from "vitest";

import { ancrerPanneau } from "./ReveilControl";

/** Vue de référence : large, le panneau y fait ses 520 px pleins. */
const VUE = { largeur: 1440, hauteur: 900 };

describe("ancrage du panneau de réveil (ancrerPanneau)", () => {
  it("icône au milieu de la colonne latérale : ouverture vers le HAUT, aligné sur l'icône", () => {
    const ancre = ancrerPanneau({ left: 40, top: 600, bottom: 630 }, VUE);
    expect(ancre.left).toBe(40);
    expect(ancre.top).toBeUndefined();
    // 900 - 600 + 6 : le bas du panneau se pose 6 px au-dessus de l'icône.
    expect(ancre.bottom).toBe(306);
    expect(ancre.maxHeight).toBe(540); // plafonné à 60 % de la hauteur d'écran
  });

  it("icône trop haute : le dessus ne suffit plus, le panneau bascule vers le BAS", () => {
    const ancre = ancrerPanneau({ left: 40, top: 120, bottom: 150 }, VUE);
    expect(ancre.bottom).toBeUndefined();
    expect(ancre.top).toBe(156);
    expect(ancre.maxHeight).toBe(540);
  });

  it("le dessus, même étroit, garde la main tant qu'il fait mieux que le dessous", () => {
    // 700 px au-dessus, 170 en dessous : rien à gagner à basculer.
    const ancre = ancrerPanneau({ left: 40, top: 706, bottom: 730 }, VUE);
    expect(ancre.top).toBeUndefined();
    expect(ancre.maxHeight).toBe(540);
  });

  it("icône collée au bord droit : le panneau est recalé pour ne pas sortir de l'écran", () => {
    const ancre = ancrerPanneau({ left: 1400, top: 600, bottom: 630 }, VUE);
    // 1440 - 520 - 6 : la largeur pleine tient encore, on la garde.
    expect(ancre.left).toBe(914);
  });

  it("fenêtre étroite : la largeur retombe à 70 % de la vue, et le recalage suit", () => {
    // 600 px de large → panneau de 420 px → le gauche ne peut pas dépasser 174.
    const ancre = ancrerPanneau({ left: 500, top: 500, bottom: 530 }, { largeur: 600, hauteur: 900 });
    expect(ancre.left).toBe(174);
  });

  it("écran minuscule : le recalage ne pousse jamais le panneau hors de l'écran par la gauche", () => {
    const ancre = ancrerPanneau({ left: 10, top: 200, bottom: 230 }, { largeur: 320, hauteur: 480 });
    expect(ancre.left).toBeGreaterThanOrEqual(6);
  });
});
