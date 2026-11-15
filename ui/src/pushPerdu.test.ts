/*
 * Pièces d'un push perdu (T-087, T-064, T-183) : rangement pour le renvoi,
 * restitution des orphelines, et instructions système du tour.
 */
import { describe, expect, it } from "vitest";
import { instructionsSysteme, RAG_SYSTEM_LINE } from "./connaissances";
import {
  AVIS_PIECES_NON_RESTAUREES,
  AVIS_PUSH_RENVOYE,
  rangerPushPerdu,
  retirerPiecesOrphelines,
  type TablePieces,
} from "./pushPerdu";

describe("rangerPushPerdu", () => {
  it("sans pièces : rien à signaler, tables intactes", () => {
    const enCours: TablePieces<string> = new Map();
    const aRenvoyer: TablePieces<string> = new Map();
    expect(rangerPushPerdu(enCours, aRenvoyer, "c1", "salut", false)).toBeNull();
    expect(enCours.size).toBe(0);
    expect(aRenvoyer.size).toBe(0);
  });

  it("avec pièces retrouvées : passe dans la table de renvoi", () => {
    const enCours: TablePieces<string> = new Map([["c1", [{ contenu: "salut", attachments: ["a.png"] }]]]);
    const aRenvoyer: TablePieces<string> = new Map();
    expect(rangerPushPerdu(enCours, aRenvoyer, "c1", "salut", true)).toBe(AVIS_PUSH_RENVOYE);
    expect(enCours.get("c1")).toEqual([]);
    expect(aRenvoyer.get("c1")).toEqual([{ contenu: "salut", attachments: ["a.png"] }]);
  });

  it("avec pièces introuvables : avis explicite, rien rangé", () => {
    const enCours: TablePieces<string> = new Map();
    const aRenvoyer: TablePieces<string> = new Map();
    expect(rangerPushPerdu(enCours, aRenvoyer, "c1", "salut", true)).toBe(AVIS_PIECES_NON_RESTAUREES);
    expect(aRenvoyer.get("c1")).toBeUndefined();
  });
});

describe("retirerPiecesOrphelines", () => {
  const rangees = (): TablePieces<string> =>
    new Map([["c1", [{ contenu: "a", attachments: ["1"] }, { contenu: "b", attachments: ["2", "3"] }]]]);

  it("contenus nommés : seules leurs pièces reviennent", () => {
    const t = rangees();
    const r = retirerPiecesOrphelines(t, "c1", ["b"], "Message retiré");
    expect(r?.pieces).toEqual(["2", "3"]);
    expect(r?.avis).toBe("Message retiré : ses pièces jointes sont revenues dans le composeur.");
    expect(t.get("c1")).toEqual([{ contenu: "a", attachments: ["1"] }]);
  });

  it("contenus null : tout ce qui est rangé revient", () => {
    const t = rangees();
    expect(retirerPiecesOrphelines(t, "c1", null, "File vidée")?.pieces).toEqual(["1", "2", "3"]);
    expect(t.get("c1")).toEqual([]);
  });

  it("rien de rangé : null", () => {
    expect(retirerPiecesOrphelines(new Map(), "c1", null, "x")).toBeNull();
  });
});

describe("instructionsSysteme", () => {
  it("agent seul, RAG seul, les deux, aucun", () => {
    expect(instructionsSysteme("Sois bref", false)).toBe("Sois bref");
    expect(instructionsSysteme(undefined, true)).toBe(RAG_SYSTEM_LINE);
    expect(instructionsSysteme("Sois bref", true)).toBe(`Sois bref\n\n${RAG_SYSTEM_LINE}`);
    expect(instructionsSysteme("", false)).toBeUndefined();
    expect(instructionsSysteme(null, false)).toBeUndefined();
  });
});
