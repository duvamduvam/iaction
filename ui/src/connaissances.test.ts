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
import { autoIndexerConnaissances, fautAutoIndexer, marquerTenteSiNouveau } from "./useConnaissances";
import type { KnowledgeStatus } from "./connaissancesClient";

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

/*
 * T-115 — l'auto-réindexation en fond. Le constat : sur un poste où personne
 * ne clique jamais « Reconstruire l'index », 3 index sur 4 dataient d'un
 * mois alors que le sidecar calculait déjà `stale`. Trois propriétés à
 * verrouiller : elle ne se déclenche QUE sur un index périmé (jamais sur un
 * index absent — la création reste un choix humain), elle ne repart JAMAIS
 * deux fois pour le même projet dans la même session, et un échec (Ollama
 * arrêté, panne « fetch failed » connue) reste DISCRET.
 */
const statutIndex = (p: Partial<KnowledgeStatus>): KnowledgeStatus => ({
  exists: true,
  files: 3,
  chunks: 12,
  model: "nomic-embed-text",
  builtAt: "2026-08-01T00:00:00Z",
  stale: true,
  ...p,
});

describe("fautAutoIndexer", () => {
  it("se déclenche sur un index qui existe et est périmé", () => {
    expect(fautAutoIndexer(statutIndex({}))).toBe(true);
  });

  it("ne se déclenche jamais sur un index inexistant — la création reste un choix de l'utilisateur", () => {
    expect(fautAutoIndexer(statutIndex({ exists: false }))).toBe(false);
    // Cas réel de `knowledge.status` sans index : stale vaut toujours false,
    // mais le test ci-dessus doit rester vrai même si ça changeait un jour.
    expect(fautAutoIndexer({ exists: false, files: 0, chunks: 0, model: null, builtAt: null, stale: false })).toBe(
      false,
    );
  });

  it("ne se déclenche pas sur un index à jour, ni sans statut connu", () => {
    expect(fautAutoIndexer(statutIndex({ stale: false }))).toBe(false);
    expect(fautAutoIndexer(null)).toBe(false);
  });
});

describe("marquerTenteSiNouveau — au plus une tentative par cwd et par session", () => {
  it("autorise la première tentative, bloque toutes les suivantes pour le même cwd", () => {
    const tentes = new Set<string>();
    expect(marquerTenteSiNouveau(tentes, "/projet-a")).toBe(true);
    expect(marquerTenteSiNouveau(tentes, "/projet-a")).toBe(false);
    expect(marquerTenteSiNouveau(tentes, "/projet-a")).toBe(false);
  });

  it("un autre projet reste indépendant — sa propre tentative n'est pas bloquée", () => {
    const tentes = new Set<string>();
    marquerTenteSiNouveau(tentes, "/projet-a");
    expect(marquerTenteSiNouveau(tentes, "/projet-b")).toBe(true);
  });
});

describe("autoIndexerConnaissances — un échec reste DISCRET", () => {
  it("indexe avec succès sans rien journaliser", async () => {
    const journaux: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const ok = await autoIndexerConnaissances("/p", ["docs/note.md"], {
      indexer: async (cwd, pinned) => {
        expect(cwd).toBe("/p");
        expect(pinned).toEqual(["docs/note.md"]);
        return { files: 1, chunks: 1, model: "nomic-embed-text" };
      },
      journaliser: (msg, fields) => journaux.push({ msg, fields }),
    });
    expect(ok).toBe(true);
    expect(journaux).toEqual([]);
  });

  it("un échec (Ollama arrêté) ne jette jamais et ne produit qu'une ligne discrète", async () => {
    const journaux: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const ok = await autoIndexerConnaissances("/p", [], {
      indexer: async () => {
        throw new Error("fetch failed");
      },
      journaliser: (msg, fields) => journaux.push({ msg, fields }),
    });
    expect(ok).toBe(false);
    expect(journaux).toHaveLength(1);
    expect(journaux[0].fields).toMatchObject({ cwd: "/p", erreur: "fetch failed" });
  });
});
