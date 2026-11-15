/*
 * Transformations pures de la liste d'onglets de fichiers (sorties
 * d'AgentPage.tsx, T-209) et fusion session/runtime pour la persistance.
 */
import { describe, expect, it } from "vitest";
import { sessionApresTourDeFond, sessionAvecRuntime } from "./fusionSessions";
import { freshRuntime, freshSession } from "./modeleProjet";
import { ongletEnChargement, ongletLu, ongletModifie, ongletsRenommes, ongletsSansChemin } from "./ongletsFichiers";

const liste = () => [ongletEnChargement("/p/a.ts", "a.ts"), ongletEnChargement("/p/dir/b.ts", "b.ts")];

describe("onglets de fichiers", () => {
  it("ongletEnChargement : état initial", () => {
    expect(liste()[0]).toMatchObject({ kind: "loading", dirty: false, saving: false, saveError: null, content: "" });
  });

  it("ongletModifie ne touche que l'onglet visé", () => {
    const l = liste();
    const r = ongletModifie(l, "/p/a.ts", { dirty: true });
    expect(r[0].dirty).toBe(true);
    expect(r[1]).toBe(l[1]);
  });

  it("ongletLu pose le contenu et efface dirty", () => {
    const r = ongletLu(ongletModifie(liste(), "/p/a.ts", { dirty: true }), "/p/a.ts", { kind: "text", text: "x", size: 1, truncated: false });
    expect(r[0]).toMatchObject({ kind: "text", content: "x", base64: "", size: 1, truncated: false, dirty: false });
  });

  it("ongletsRenommes suit un dossier renommé et recalcule le nom", () => {
    const r = ongletsRenommes(liste(), "/p/dir", "/p/rep");
    expect(r[1]).toMatchObject({ path: "/p/rep/b.ts", name: "b.ts" });
    expect(r[0].path).toBe("/p/a.ts");
    expect(ongletsRenommes(liste(), "/p/a.ts", "/p/c.ts")[0]).toMatchObject({ path: "/p/c.ts", name: "c.ts" });
  });

  it("ongletsSansChemin retire le fichier et les descendants d'un dossier", () => {
    expect(ongletsSansChemin(liste(), "/p/dir").map((f) => f.path)).toEqual(["/p/a.ts"]);
    expect(ongletsSansChemin(liste(), "/p/a.ts").map((f) => f.path)).toEqual(["/p/dir/b.ts"]);
  });
});

describe("fusion session / runtime", () => {
  it("sessionApresTourDeFond reprend sessionId et plancher du runtime", () => {
    const s = freshSession();
    const rt = freshRuntime([], "sess-9", "complexe", null);
    const r = sessionApresTourDeFond(s, rt, "2026-11-08T00:00:00.000Z");
    expect(r).toMatchObject({ sessionId: "sess-9", routedTier: "complexe", updatedAt: "2026-11-08T00:00:00.000Z" });
  });

  it("sessionAvecRuntime : la config n'est posée que si fournie", () => {
    const s = freshSession();
    const rt = freshRuntime([], "sess-1");
    const sans = sessionAvecRuntime(s, rt, null, "t");
    expect(sans.engine).toBe(s.engine);
    expect(sans.sessionId).toBe("sess-1");
    const agent = { scope: "project", name: "x" } as unknown as NonNullable<typeof s.selectedAgent>;
    const avec = sessionAvecRuntime(s, rt, { engine: { ...s.engine, model: "m" }, selectedAgent: agent }, "t");
    expect(avec.selectedAgent).toBe(agent);
    expect(avec.updatedAt).toBe("t");
  });
});
