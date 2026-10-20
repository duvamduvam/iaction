/*
 * Niveau et étiquetage d'un rendu React interrompu (T-116).
 *
 * Ce que ces tests protègent : avant ce correctif, `componentDidCatch`
 * journalisait TOUJOURS en `fatal`, y compris pour un graphe HMR périmé après
 * une édition sous Vite — 80 lignes de bruit au niveau le plus grave en un
 * mois (T-116, reliquat de T-057). La correction ne doit baisser le niveau
 * QUE quand les deux conditions sont réunies : on tourne sous Vite en
 * développement (`import.meta.env.DEV`) ET le message appartient à la
 * famille HMR (`estArtefactHmr`). Un vrai crash de rendu — hors développement,
 * ou hors famille même en développement — doit rester `fatal`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logUi = vi.fn();
vi.mock("./journal", () => ({ logUi }));

describe("ErrorBoundary.componentDidCatch — niveau et artefact HMR (T-116)", () => {
  beforeEach(() => {
    logUi.mockClear();
  });

  afterEach(() => {
    // Chaque test remet l'indicateur de mode à sa valeur par défaut de vitest.
    (import.meta.env as unknown as { DEV: boolean }).DEV = true;
  });

  it("descend en `warn` avec `artefactHmr: true` pour un message de la famille HMR, en développement", async () => {
    const { default: ErrorBoundary } = await import("./ErrorBoundary");
    const instance = new ErrorBoundary({ children: null });
    instance.componentDidCatch(new Error("Can't find variable: splitFeatured"), {
      componentStack: "\n    in Toto",
    });

    expect(logUi).toHaveBeenCalledTimes(1);
    const [niveau, scope, msg, opts] = logUi.mock.calls[0];
    expect(niveau).toBe("warn");
    expect(scope).toBe("ui");
    expect(msg).toBe("rendu React interrompu : Can't find variable: splitFeatured");
    expect(opts?.fields).toEqual({ artefactHmr: true });
    // La pile reste présente : ce n'est pas tu, seulement rétrogradé.
    expect(opts?.stack).toContain("in Toto");
  });

  it("reste `fatal`, sans le champ, pour un crash hors famille HMR — même en développement", async () => {
    const { default: ErrorBoundary } = await import("./ErrorBoundary");
    const instance = new ErrorBoundary({ children: null });
    instance.componentDidCatch(new Error("boom : le sidecar a renvoyé un objet inattendu"), {
      componentStack: "",
    });

    expect(logUi).toHaveBeenCalledTimes(1);
    const [niveau, , , opts] = logUi.mock.calls[0];
    expect(niveau).toBe("fatal");
    expect(opts?.fields).toBeUndefined();
  });

  it("reste `fatal` pour un message de la famille HMR hors développement (version empaquetée)", async () => {
    (import.meta.env as unknown as { DEV: boolean }).DEV = false;
    const { default: ErrorBoundary } = await import("./ErrorBoundary");
    const instance = new ErrorBoundary({ children: null });
    instance.componentDidCatch(new Error("splitFeatured is not defined"), { componentStack: "" });

    expect(logUi).toHaveBeenCalledTimes(1);
    const [niveau, , , opts] = logUi.mock.calls[0];
    expect(niveau).toBe("fatal");
    expect(opts?.fields).toBeUndefined();
  });
});
