/*
 * Alt+chiffre → onglet (T-122, levier C).
 *
 * Ce que ces tests protègent : la convention navigateur (1 à 8 direct, 9 =
 * dernier) doit rester vraie dans les deux sens — la touche qui résout un
 * onglet, et le libellé qui annonce cette même touche dans le `title` de
 * l'onglet. Une régression ici serait silencieuse : Alt+9 mènerait ailleurs
 * que le tout dernier onglet, ou une pastille annoncerait un raccourci qui
 * n'active pas l'onglet qu'elle promet.
 */
import { describe, expect, it } from "vitest";
import { ongletPourChiffre, raccourciDeLaPosition } from "./raccourciOnglets";

describe("ongletPourChiffre — la touche vers la position", () => {
  it("1 à 8 visent directement leur propre position", () => {
    for (let chiffre = 1; chiffre <= 8; chiffre++) {
      expect(ongletPourChiffre(chiffre, 11)).toBe(chiffre - 1);
    }
  });

  it("9 vise toujours le DERNIER onglet, quel que soit le nombre d'onglets", () => {
    expect(ongletPourChiffre(9, 11)).toBe(10);
    expect(ongletPourChiffre(9, 20)).toBe(19);
    expect(ongletPourChiffre(9, 9)).toBe(8);
    // Barre de moins de neuf onglets : 9 rejoint quand même le dernier —
    // même comportement que Ctrl+9 dans Chrome/Firefox.
    expect(ongletPourChiffre(9, 3)).toBe(2);
  });

  it("une position au-delà du nombre d'onglets ouverts ne mène nulle part", () => {
    expect(ongletPourChiffre(5, 3)).toBeNull();
    expect(ongletPourChiffre(8, 7)).toBeNull();
  });

  it("une barre vide, ou un chiffre hors 1-9, ne mène nulle part", () => {
    expect(ongletPourChiffre(1, 0)).toBeNull();
    expect(ongletPourChiffre(0, 5)).toBeNull();
    expect(ongletPourChiffre(10, 12)).toBeNull();
  });
});

describe("raccourciDeLaPosition — le libellé annoncé sur l'onglet", () => {
  it("les positions 1 à 8 annoncent leur propre touche", () => {
    expect(raccourciDeLaPosition(0, 11)).toBe("Alt+1");
    expect(raccourciDeLaPosition(7, 11)).toBe("Alt+8");
  });

  it("la dernière position annonce Alt+9, même au-delà de la neuvième", () => {
    expect(raccourciDeLaPosition(10, 11)).toBe("Alt+9");
  });

  it("les positions entre la 9ᵉ et l'avant-dernière n'ont pas de raccourci direct", () => {
    // Barre de 11 onglets : la 9ᵉ (index 8) et la 10ᵉ (index 9) n'ont ni
    // touche propre (réservée aux huit premières) ni celle du dernier.
    expect(raccourciDeLaPosition(8, 11)).toBeNull();
    expect(raccourciDeLaPosition(9, 11)).toBeNull();
  });

  it("sur neuf onglets ou moins, la dernière position garde SON seul libellé (pas de doublon)", () => {
    // La 9ᵉ position (index 8) EST la dernière : elle relève de la règle
    // « dernier », pas de la règle « position directe » (index < 8) — un seul
    // libellé, jamais les deux.
    expect(raccourciDeLaPosition(8, 9)).toBe("Alt+9");
  });

  it("une position hors barre n'annonce rien", () => {
    expect(raccourciDeLaPosition(-1, 5)).toBeNull();
    expect(raccourciDeLaPosition(5, 5)).toBeNull();
  });
});
