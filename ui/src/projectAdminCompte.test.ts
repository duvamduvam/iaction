/*
 * Le défaut de compte d'un projet (`compteClaude`, docs/spec-deux-comptes.md) vit
 * dans la config du poste, sans écran de réglage : il doit survivre à TOUTES les
 * réécritures de la config par l'application (renommage, mode connaissances,
 * ajout/suppression d'un autre projet). La config est une doublure en mémoire :
 * aucun fichier du poste n'est lu ni écrit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { magasin } = vi.hoisted(() => ({ magasin: { doc: {} as Record<string, unknown> } }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (commande: string, args?: { value?: Record<string, unknown> }) => {
    if (commande === "config_read") return structuredClone(magasin.doc);
    if (commande === "config_write") {
      magasin.doc = structuredClone(args?.value ?? {});
      return undefined;
    }
    return undefined;
  }),
}));

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("./journal", async (importOriginal) => ({ ...(await importOriginal<typeof import("./journal")>()), logWarn }));

import { defautDeProjet } from "./comptesClaude";
import { addProject, deleteProject, readProjects, updateProject, writeProjectKnowledgeMode } from "./projectAdmin";

beforeEach(() => {
  magasin.doc = {
    autre: { garde: true },
    projects: [
      { id: "a", name: "A", path: "/tmp/a", compteClaude: "teams" },
      { id: "b", name: "B", path: "/tmp/b" },
    ],
  };
});

describe("compteClaude d'un projet", () => {
  it("est lu tel quel, et un projet sans champ n'en a pas (= perso)", async () => {
    const projets = await readProjects();
    expect(projets.find((p) => p.id === "a")?.compteClaude).toBe("teams");
    expect(projets.find((p) => p.id === "b")?.compteClaude).toBeUndefined();
  });

  it("survit à un renommage, au mode connaissances et aux changements d'un autre projet", async () => {
    await updateProject("a", { name: "A bis" });
    await writeProjectKnowledgeMode("a", "rag");
    await writeProjectKnowledgeMode("a", "injection");
    await updateProject("b", { path: "/tmp/b2" });
    await addProject("C", "/tmp/c");
    await deleteProject("b");
    const a = (await readProjects()).find((p) => p.id === "a");
    expect(a).toMatchObject({ name: "A bis", compteClaude: "teams" });
    // Le reste du document n'est pas touché non plus.
    expect(magasin.doc.autre).toEqual({ garde: true });
  });
});

describe("compteClaude invalide", () => {
  it("warn au journal (une fois par faute), champ ignoré à la résolution, valeur conservée dans la config", async () => {
    magasin.doc = { projects: [{ id: "x", name: "X", path: "/tmp/x", compteClaude: "team" }] };
    logWarn.mockClear();
    const premier = await readProjects();
    await readProjects();
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0][2]).toMatchObject({ fields: { projet: "x", valeur: "team" } });
    expect(defautDeProjet(premier[0])).toBeNull();
    await updateProject("x", { name: "X2" });
    expect((magasin.doc.projects as Array<Record<string, unknown>>)[0].compteClaude).toBe("team");
  });

  it("une valeur valide ne produit aucun warn", async () => {
    logWarn.mockClear();
    await readProjects();
    expect(logWarn).not.toHaveBeenCalled();
  });
});
