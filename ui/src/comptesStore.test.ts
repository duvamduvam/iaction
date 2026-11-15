/*
 * Liste des comptes partagée (docs/spec-deux-comptes.md) : un ÉCHEC n'est jamais
 * « aucun compte ». La dernière liste connue reste valable, la requête la plus
 * récente fait foi (course avec un `ready`), et un envoi attend plutôt que de
 * partir sur perso. Le protocole est une doublure pilotée à la main.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Attente {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}
const { attentes, logWarn } = vi.hoisted(() => ({ attentes: [] as unknown[], logWarn: vi.fn() }));

vi.mock("./sidecar", () => ({
  request: () => {
    let resolve!: (d: Record<string, unknown>) => void;
    let reject!: (e: Error) => void;
    const done = new Promise<Record<string, unknown>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    attentes.push({ resolve, reject });
    return { id: "x", done };
  },
  subscribeReady: () => () => undefined,
}));
vi.mock("./journal", () => ({ logWarn }));

import { attendreComptes, compteAuDepart, rafraichirComptes, reinitialiserComptes } from "./comptesClaude";

const liste = (...ids: Array<"perso" | "teams">) => ({
  comptes: ids.map((id) => ({ id, label: id, connecte: true })),
});
const dernier = () => attentes[attentes.length - 1] as Attente;

beforeEach(() => {
  attentes.length = 0;
  logWarn.mockClear();
  reinitialiserComptes();
});

describe("liste des comptes partagée", () => {
  it("un échec garde la dernière liste connue (et le dit au journal)", async () => {
    const p1 = rafraichirComptes();
    dernier().resolve(liste("perso", "teams"));
    await p1;
    const p2 = rafraichirComptes();
    dernier().reject(new Error("sidecar injoignable"));
    await p2;
    expect(await attendreComptes()).toEqual([
      { id: "perso", label: "perso", connecte: true },
      { id: "teams", label: "teams", connecte: true },
    ]);
    expect(logWarn).toHaveBeenCalled();
  });

  it("une réponse sans liste est un échec, pas « aucun compte »", async () => {
    const p = rafraichirComptes();
    dernier().resolve({});
    await p;
    expect(logWarn).toHaveBeenCalled();
    // Rien n'a jamais répondu : la liste reste INCONNUE (null), pas vide.
    const attente = attendreComptes();
    await vi.waitFor(() => expect(attentes.length).toBeGreaterThan(1));
    dernier().resolve(liste("perso", "teams"));
    expect((await attente)?.map((c) => c.id)).toEqual(["perso", "teams"]);
  });

  it("la requête la plus récente fait foi : la réponse tardive d'avant un `ready` est ignorée", async () => {
    const ancienne = rafraichirComptes(); // avant le redémarrage du sidecar
    const ancienneAttente = dernier();
    const recente = rafraichirComptes(); // après `ready`
    const recenteAttente = dernier();
    recenteAttente.resolve(liste("perso", "teams"));
    await recente;
    ancienneAttente.resolve(liste("perso")); // réponse tardive, périmée
    await ancienne;
    expect((await attendreComptes())?.map((c) => c.id)).toEqual(["perso", "teams"]);
  });

  it("une requête en vol n'est pas réutilisée par un `ready` (chaque rafraîchissement part)", () => {
    void rafraichirComptes();
    void rafraichirComptes();
    expect(attentes).toHaveLength(2);
  });
});

describe("compteAuDepart", () => {
  it("défaut teams, liste inconnue : attend la réponse au lieu de partir sur perso", async () => {
    const envoi = compteAuDepart(null, "teams");
    await vi.waitFor(() => expect(attentes.length).toBeGreaterThan(0));
    dernier().resolve(liste("perso", "teams"));
    expect(await envoi).toEqual({ compte: "teams", repli: false });
  });

  it("liste enfin connue sans second compte : retour à perso, signalé", async () => {
    const envoi = compteAuDepart(null, "teams");
    await vi.waitFor(() => expect(attentes.length).toBeGreaterThan(0));
    dernier().resolve(liste("perso"));
    expect(await envoi).toEqual({ compte: "perso", repli: true });
  });

  it("liste toujours inconnue après l'attente : refus explicite, jamais perso en silence", async () => {
    const envoi = compteAuDepart(null, "teams");
    const refus = expect(envoi).rejects.toThrow(/comptes Claude/);
    await vi.waitFor(() => expect(attentes.length).toBeGreaterThan(0));
    dernier().reject(new Error("injoignable"));
    await refus;
  });

  it("choix explicite ou projet sans défaut : aucune attente", async () => {
    expect(await compteAuDepart("teams", "perso")).toEqual({ compte: "teams", repli: false });
    expect(await compteAuDepart(null, null)).toEqual({ compte: "perso", repli: false });
    expect(attentes).toHaveLength(0);
  });
});
