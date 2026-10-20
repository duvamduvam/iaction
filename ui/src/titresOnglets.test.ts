/*
 * Titre affiché d'un onglet (T-122, levier A).
 *
 * Ce que ces tests protègent : la promesse est qu'un onglet montre ce qui le
 * DISTINGUE. Une régression ici ne casse rien de visible — la barre reste
 * pleine d'onglets bien dessinés — elle rend seulement, à nouveau, trois
 * onglets impossibles à départager. C'est le genre de défaut qu'on ne voit
 * pas revenir : d'où ces tests.
 */
import { describe, expect, it } from "vitest";
import { titresDistinctifs } from "./titresOnglets";

describe("titresDistinctifs — le repli du préfixe partagé", () => {
  it("replie le plus long préfixe commun, pas le premier venu", () => {
    // Les trois partagent « Regarde les » ; deux d'entre eux partagent en plus
    // « tickets ». Chacun doit se replier sur SON plus long préfixe partagé.
    expect(
      titresDistinctifs([
        "Regarde les tickets P1 encore ouverts",
        "Regarde les tickets fermés cette semaine",
        "Regarde les logs du sidecar de ce matin",
      ]),
    ).toEqual(["…P1 encore ouverts", "…fermés cette semaine", "…logs du sidecar de ce matin"]);
  });

  it("laisse intact un titre qui ne partage rien", () => {
    const titres = ["Revoir la barre d'onglets", "Étude sobriété", "Passer par le serveur"];
    expect(titresDistinctifs(titres)).toEqual(titres);
  });

  it("ne replie pas sur un seul mot commun : l'ellipse coûterait plus qu'elle ne rend", () => {
    const titres = ["Sidecar mort au démarrage", "Sidecar : lire les logs"];
    expect(titresDistinctifs(titres)).toEqual(titres);
  });

  it("compare à la casse près, mais rend le titre d'origine", () => {
    expect(titresDistinctifs(["regarde les mails du jour", "Regarde les mails de mardi"])).toEqual([
      "…du jour",
      "…de mardi",
    ]);
  });

  it("ne touche pas aux onglets voisins d'une paire repliée", () => {
    expect(titresDistinctifs(["Le budget 2027", "Le budget 2028", "Réveil à 3 h"])).toEqual([
      "…2027",
      "…2028",
      "Réveil à 3 h",
    ]);
  });
});

describe("titresDistinctifs — ce qu'on refuse de replier", () => {
  it("garde deux titres identiques tels quels : replier ne laisserait rien", () => {
    const titres = ["Nouvelle session", "Nouvelle session"];
    expect(titresDistinctifs(titres)).toEqual(titres);
  });

  it("garde entier le titre qui est le PRÉFIXE de l'autre, et replie l'autre", () => {
    // « Revoir la barre » n'a rien après le préfixe commun : il reste entier.
    expect(titresDistinctifs(["Revoir la barre", "Revoir la barre d'onglets"])).toEqual([
      "Revoir la barre",
      "…d'onglets",
    ]);
  });

  it("survit aux titres non normalisés (espaces multiples, bords)", () => {
    // Un titre renommé à la main ou venu du modèle n'est pas passé par
    // deriveTitleFromText : il peut porter n'importe quelle blancherie.
    expect(titresDistinctifs(["  Le  plan   de vol  ", "Le plan de route"])).toEqual(["…vol", "…route"]);
  });

  it("ne casse pas sur un titre vide ou une barre d'un seul onglet", () => {
    expect(titresDistinctifs([])).toEqual([]);
    expect(titresDistinctifs(["Regarde les tickets"])).toEqual(["Regarde les tickets"]);
    expect(titresDistinctifs(["", "Regarde les tickets"])).toEqual(["", "Regarde les tickets"]);
  });
});
