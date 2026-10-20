/*
 * Fermeture en lot des onglets (T-109).
 *
 * Ce que ces tests protègent vraiment : la PROMESSE faite à l'utilisateur —
 * un lot ne ferme jamais une conversation qui streame ni un fichier non
 * enregistré, et il le DIT. Une régression ici ne se voit pas à l'écran (les
 * onglets fermés, eux, disparaissent bien) : elle se voit le lendemain, quand
 * une édition a disparu sans un mot.
 */
import { describe, expect, it } from "vitest";
import {
  ciblesLot,
  itemsMenuOnglets,
  messageLot,
  ongletApresFermeture,
  resoudreLot,
  type OngletDeBarre,
} from "./fermetureOnglets";

/** Barre type de la page Projets : trois conversations, puis trois fichiers. */
const barre: OngletDeBarre[] = [
  { id: "c1", famille: "conversation", protection: null },
  { id: "c2", famille: "conversation", protection: "tour-en-cours" },
  { id: "c3", famille: "conversation", protection: null },
  { id: "f1", famille: "fichier", protection: null },
  { id: "f2", famille: "fichier", protection: "non-enregistre" },
  { id: "f3", famille: "fichier", protection: null },
];

const ids = (onglets: readonly OngletDeBarre[]) => onglets.map((o) => o.id);

describe("ciblesLot — chaque action reste dans SA famille", () => {
  it("« les autres » ne touche pas aux fichiers depuis une conversation", () => {
    expect(ids(ciblesLot(barre, "c1", "les-autres"))).toEqual(["c2", "c3"]);
  });

  it("« les autres » ne touche pas aux conversations depuis un fichier", () => {
    expect(ids(ciblesLot(barre, "f2", "les-autres"))).toEqual(["f1", "f3"]);
  });

  it("« à droite » compte dans la famille, pas dans la barre entière", () => {
    // c3 est le 3ᵉ onglet de la barre, mais le DERNIER de sa famille : rien à
    // sa droite, même si trois fichiers suivent visuellement.
    expect(ids(ciblesLot(barre, "c3", "a-droite"))).toEqual([]);
    expect(ids(ciblesLot(barre, "c1", "a-droite"))).toEqual(["c2", "c3"]);
    expect(ids(ciblesLot(barre, "f1", "a-droite"))).toEqual(["f2", "f3"]);
  });

  it("« les enregistrés » vise TOUS les fichiers sans perte, l'onglet cliqué compris", () => {
    expect(ids(ciblesLot(barre, "f1", "enregistres"))).toEqual(["f1", "f3"]);
  });

  it("« tous les fichiers » traverse depuis une conversation", () => {
    expect(ids(ciblesLot(barre, "c1", "tous-les-fichiers"))).toEqual(["f1", "f2", "f3"]);
  });

  it("un onglet ancre disparu ne vise rien", () => {
    expect(ciblesLot(barre, "fantome", "toute-la-famille")).toEqual([]);
  });
});

describe("resoudreLot — les protégés survivent et sont nommés", () => {
  it("épargne la conversation qui streame", () => {
    const r = resoudreLot(barre, "c1", "toute-la-famille");
    expect(r.aFermer).toEqual(["c1", "c3"]);
    expect(r.conserves).toEqual([{ id: "c2", raison: "tour-en-cours" }]);
  });

  it("épargne le fichier non enregistré", () => {
    const r = resoudreLot(barre, "f1", "toute-la-famille");
    expect(r.aFermer).toEqual(["f1", "f3"]);
    expect(r.conserves).toEqual([{ id: "f2", raison: "non-enregistre" }]);
  });

  it("un lot entièrement protégé ne ferme rien", () => {
    const queProloges: OngletDeBarre[] = [
      { id: "a", famille: "fichier", protection: "non-enregistre" },
      { id: "b", famille: "fichier", protection: "non-enregistre" },
    ];
    const r = resoudreLot(queProloges, "a", "toute-la-famille");
    expect(r.aFermer).toEqual([]);
    expect(r.conserves).toHaveLength(2);
  });
});

describe("messageLot — on ne parle que de ce qui a survécu", () => {
  it("se tait quand tout est parti comme demandé", () => {
    expect(messageLot({ aFermer: ["a", "b"], conserves: [] })).toBeNull();
  });

  it("dit combien sont partis et pourquoi les autres restent", () => {
    expect(
      messageLot({
        aFermer: ["a", "b", "c"],
        conserves: [
          { id: "d", raison: "tour-en-cours" },
          { id: "e", raison: "non-enregistre" },
        ],
      }),
    ).toBe("3 onglets fermés · 2 conservés : 1 tour en cours, 1 fichier non enregistré.");
  });

  it("accorde le singulier", () => {
    expect(messageLot({ aFermer: ["a"], conserves: [{ id: "d", raison: "tour-en-cours" }] })).toBe(
      "1 onglet fermé · 1 conservé : 1 tour en cours.",
    );
  });

  it("le dit aussi quand RIEN n'a pu être fermé — sinon le clic semble sans effet", () => {
    expect(
      messageLot({
        aFermer: [],
        conserves: [
          { id: "d", raison: "non-enregistre" },
          { id: "e", raison: "non-enregistre" },
        ],
      }),
    ).toBe("Aucun onglet fermé — 2 conservés : 2 fichiers non enregistrés.");
  });
});

describe("itemsMenuOnglets", () => {
  it("propose les actions de conversation depuis une conversation", () => {
    const items = itemsMenuOnglets(barre, "c1");
    expect(items.map((i) => i.cle)).toEqual([
      "cet-onglet",
      "les-autres",
      "a-droite",
      "toute-la-famille",
      "tous-les-fichiers",
    ]);
    expect(items[1].libelle).toBe("Fermer les autres conversations");
  });

  it("n'offre « tous les fichiers » que s'il y a des fichiers ouverts", () => {
    const sansFichier = barre.filter((o) => o.famille === "conversation");
    expect(itemsMenuOnglets(sansFichier, "c1").map((i) => i.cle)).not.toContain("tous-les-fichiers");
  });

  it("propose les actions de fichier depuis un fichier", () => {
    const items = itemsMenuOnglets(barre, "f1");
    expect(items.map((i) => i.cle)).toEqual([
      "cet-onglet",
      "les-autres",
      "a-droite",
      "enregistres",
      "toute-la-famille",
    ]);
  });

  it("grise un item sans cible fermable au lieu de le faire disparaître", () => {
    // c3 : dernier de sa famille, donc rien « à droite ».
    const items = itemsMenuOnglets(barre, "c3");
    const droite = items.find((i) => i.cle === "a-droite");
    expect(droite).toBeDefined();
    expect(droite?.actif).toBe(false);
  });

  it("refuse de fermer l'onglet cliqué quand SON tour streame", () => {
    expect(itemsMenuOnglets(barre, "c2")[0]).toMatchObject({ cle: "cet-onglet", actif: false });
  });

  it("laisse fermer un fichier modifié — c'est la confirmation qui tranche, pas le menu", () => {
    expect(itemsMenuOnglets(barre, "f2")[0]).toMatchObject({ cle: "cet-onglet", actif: true });
  });
});

describe("ongletApresFermeture", () => {
  const ouverts = ["a", "b", "c", "d"];

  it("ne bouge pas quand l'onglet actif survit", () => {
    expect(ongletApresFermeture(ouverts, "a", ["c", "d"])).toBe("a");
  });

  it("prend le voisin de gauche quand l'actif part", () => {
    expect(ongletApresFermeture(ouverts, "c", ["c"])).toBe("b");
  });

  it("SAUTE les voisins de gauche fermés du même coup", () => {
    // Le piège du lot : « fermer les autres » depuis « d » emporte a, b et c.
    expect(ongletApresFermeture(ouverts, "b", ["a", "b", "c"])).toBe("d");
  });

  it("se rabat sur le premier survivant quand rien ne subsiste à gauche", () => {
    expect(ongletApresFermeture(ouverts, "a", ["a", "b"])).toBe("c");
  });

  it("rend null quand la barre est vidée — à la page de décider quoi ouvrir", () => {
    expect(ongletApresFermeture(ouverts, "a", ouverts)).toBeNull();
  });
});
