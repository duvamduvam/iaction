/*
 * Connaissances de projet — la logique pure.
 *
 * Le contrat central est celui des BUDGETS d'injection : promettre à l'agent
 * un document qu'on a tronqué ou omis en silence le ferait raisonner sur un
 * texte qu'il n'a pas. Chaque limite doit donc être VISIBLE dans le bloc
 * produit ([… tronqué], [non injecté : budget dépassé], [illisible]).
 */
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeBlock,
  dedupDocsByPath,
  KNOWLEDGE_DOC_MAX_CHARS,
  KNOWLEDGE_TOTAL_MAX_CHARS,
  mergeKnowledgeDocs,
  relativeToProject,
  sanitizeKnowledgeDoc,
} from "./connaissances";

const doc = (path: string, name = path) => ({ path, name });

describe("sanitizeKnowledgeDoc", () => {
  it("avale n'importe quoi sans jeter", () => {
    for (const dechet of [null, 42, "x", [], { p: "pas une liste" }, { p: [{ path: 1 }] }]) {
      expect(sanitizeKnowledgeDoc(dechet)).toEqual({});
    }
  });

  it("garde les listes valides, projet par projet", () => {
    const propre = sanitizeKnowledgeDoc({ "/p1": [doc("/p1/a.md")], "/p2": "corrompu" });
    expect(propre).toEqual({ "/p1": [doc("/p1/a.md")] });
  });
});

describe("mergeKnowledgeDocs — fusion, jamais un écrasement", () => {
  it("réunit disque et mémoire sans doublon de chemin", () => {
    const fusion = mergeKnowledgeDocs(
      { "/p": [doc("/p/disque.md"), doc("/p/commun.md")] },
      { "/p": [doc("/p/commun.md"), doc("/p/local.md")] },
    );
    expect(fusion["/p"].map((d) => d.path)).toEqual(["/p/disque.md", "/p/commun.md", "/p/local.md"]);
  });

  it("un projet présent d'un seul côté survit", () => {
    const fusion = mergeKnowledgeDocs({ "/a": [doc("x")] }, { "/b": [doc("y")] });
    expect(Object.keys(fusion).sort()).toEqual(["/a", "/b"]);
  });
});

describe("dedupDocsByPath — le premier gagne", () => {
  it("un fichier épinglé ET auto n'est injecté qu'une fois, version épinglée", () => {
    const fusion = dedupDocsByPath([
      [{ path: "/p/spec.md", name: "épinglé" }],
      [{ path: "/p/spec.md", name: "auto" }, doc("/p/autre.md")],
    ]);
    expect(fusion).toEqual([{ path: "/p/spec.md", name: "épinglé" }, doc("/p/autre.md")]);
  });
});

describe("relativeToProject", () => {
  it("retranche la racine, tolère la racine vide et le chemin extérieur", () => {
    expect(relativeToProject("/p/src/a.ts", "/p")).toBe("src/a.ts");
    expect(relativeToProject("/ailleurs/a.ts", "/p")).toBe("/ailleurs/a.ts");
    expect(relativeToProject("/p/a.ts", "")).toBe("/p/a.ts");
  });
});

describe("buildKnowledgeBlock — les budgets sont VISIBLES", () => {
  it("assemble les documents lisibles avec leur chemin relatif", async () => {
    const bloc = await buildKnowledgeBlock([doc("/p/a.md"), doc("/p/b.md")], "/p", async (p) => `contenu de ${p}`);
    expect(bloc).toContain("--- a.md ---\ncontenu de /p/a.md");
    expect(bloc).toContain("--- b.md ---");
  });

  it("tronque par document, avec la marque [… tronqué]", async () => {
    const bloc = await buildKnowledgeBlock([doc("/p/gros.md")], "/p", async () => "x".repeat(KNOWLEDGE_DOC_MAX_CHARS + 100));
    expect(bloc).toContain("[… tronqué]");
    expect(bloc.length).toBeLessThan(KNOWLEDGE_DOC_MAX_CHARS + 500);
  });

  it("budget TOTAL atteint : les suivants sont listés « non injectés », pas lus", async () => {
    const gros = "x".repeat(KNOWLEDGE_DOC_MAX_CHARS);
    const lus: string[] = [];
    const lire = async (p: string) => {
      lus.push(p);
      return gros;
    };
    const docs = Array.from({ length: 6 }, (_, i) => doc(`/p/d${i}.md`));
    const bloc = await buildKnowledgeBlock(docs, "/p", lire);
    // 4 × 30k = 120k = budget total : d4 et d5 ne sont même plus lus.
    expect(lus).toEqual(["/p/d0.md", "/p/d1.md", "/p/d2.md", "/p/d3.md"]);
    expect(bloc).toContain("--- d4.md ---\n[non injecté : budget dépassé]");
    expect(bloc).toContain("--- d5.md ---\n[non injecté : budget dépassé]");
    void KNOWLEDGE_TOTAL_MAX_CHARS;
  });

  it("un document illisible est marqué, jamais fatal", async () => {
    const bloc = await buildKnowledgeBlock([doc("/p/mort.bin"), doc("/p/ok.md")], "/p", async (p) =>
      p.endsWith(".bin") ? null : "ça va",
    );
    expect(bloc).toContain("--- mort.bin ---\n[illisible]");
    expect(bloc).toContain("--- ok.md ---\nça va");
  });

  it("une lecture qui JETTE est traitée comme illisible", async () => {
    const bloc = await buildKnowledgeBlock([doc("/p/x.md")], "/p", async () => {
      throw new Error("disque");
    });
    expect(bloc).toContain("[illisible]");
  });
});
