/*
 * Deux comptes Claude côté interface (docs/spec-deux-comptes.md) : résolution du
 * compte d'une session, options de la liste « Moteur », lecture de `claude.comptes`,
 * et le champ `compte` qui part avec le tour.
 *
 * Les règles sont pures : on les exerce hors webview. Le seul appel au protocole
 * (`claudeStart`) est vu à travers un `invoke` Tauri factice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoPropose,
  avecCompteChat,
  compteAPersister,
  compteExplicite,
  comptesASonder,
  defautDeProjet,
  LIBELLE_CLAUDE_UNIQUE,
  lireChoixMoteur,
  modeleCompatibleCompte,
  optionsMoteurClaude,
  parseComptes,
  resoudreCompteSession,
  secondCompteDispo,
  VALEUR_MOTEUR_TEAMS,
  type CompteDecrit,
} from "./comptesClaude";
import { avecCompteMoteur, fusionnerMoteur, moteurNouvelleSession } from "./modeleProjet";
import { claudeStart, claudeCommands } from "./sidecar";
import { usageClaude, usageClaudeInit } from "./consoClient";
import { claudeEngine } from "./modeleProjet";

const PERSO: CompteDecrit = { id: "perso", label: "Claude Perso", connecte: true };
const TEAMS: CompteDecrit = { id: "teams", label: "Claude Teams", connecte: true };
const TEAMS_DECONNECTE: CompteDecrit = { ...TEAMS, connecte: false };

describe("resoudreCompteSession", () => {
  it("session sans champ compte : suit le défaut du projet", () => {
    expect(resoudreCompteSession(null, "teams", [PERSO, TEAMS])).toEqual({ compte: "teams", repli: false, attente: false });
    expect(resoudreCompteSession(undefined, "teams", [PERSO, TEAMS])).toEqual({ compte: "teams", repli: false, attente: false });
  });

  it("le choix explicite de la session prime sur le défaut du projet, sans attendre la liste", () => {
    expect(resoudreCompteSession("perso", "teams", [PERSO, TEAMS])).toEqual({ compte: "perso", repli: false, attente: false });
    expect(resoudreCompteSession("teams", undefined, null)).toEqual({ compte: "teams", repli: false, attente: false });
  });

  it("projet sans champ : perso", () => {
    expect(resoudreCompteSession(null, undefined, [PERSO, TEAMS])).toEqual({ compte: "perso", repli: false, attente: false });
    expect(resoudreCompteSession(null, "perso", [PERSO])).toEqual({ compte: "perso", repli: false, attente: false });
    expect(resoudreCompteSession(null, undefined, null)).toEqual({ compte: "perso", repli: false, attente: false });
  });

  it("défaut teams sans AUCUN second compte : retour à perso, signalé", () => {
    expect(resoudreCompteSession(null, "teams", [PERSO])).toEqual({ compte: "perso", repli: true, attente: false });
  });

  it("défaut teams, compte présent mais déconnecté : PAS de repli (le sidecar refusera avec la commande)", () => {
    expect(resoudreCompteSession(null, "teams", [PERSO, TEAMS_DECONNECTE])).toEqual({ compte: "teams", repli: false, attente: false });
  });

  it("liste inconnue : jamais « aucun compte » — le défaut teams est gardé et l'envoi doit attendre", () => {
    expect(resoudreCompteSession(null, "teams", null)).toEqual({ compte: "teams", repli: false, attente: true });
  });
});

describe("compteAPersister / lireChoixMoteur", () => {
  it("choisir perso quand le défaut résolu est perso ne fige rien (suivre le défaut du projet)", () => {
    expect(compteAPersister("perso", "perso")).toBeNull();
  });
  it("choisir perso sur un défaut teams, ou teams, est figé", () => {
    expect(compteAPersister("perso", "teams")).toBe("perso");
    expect(compteAPersister("teams", "perso")).toBe("teams");
    expect(compteAPersister("teams", "teams")).toBe("teams");
  });
  it("lit la valeur d'une liste Moteur", () => {
    expect(lireChoixMoteur("")).toEqual({ providerId: null, compte: "perso" });
    expect(lireChoixMoteur(VALEUR_MOTEUR_TEAMS)).toEqual({ providerId: null, compte: "teams" });
    expect(lireChoixMoteur("openrouter")).toEqual({ providerId: "openrouter", compte: undefined });
  });
});

describe("Auto et compte", () => {
  it("Auto n'est proposé que pour perso", () => {
    expect(autoPropose("perso")).toBe(true);
    expect(autoPropose("teams")).toBe(false);
  });
  it("un modèle Auto passe sur le modèle Claude par défaut dès que le compte n'est pas perso", () => {
    expect(modeleCompatibleCompte("__auto__", "teams", "__auto__", "claude-sonnet")).toBe("claude-sonnet");
  });
  it("hors Auto, ou sur perso, changer de compte ne change pas le modèle", () => {
    expect(modeleCompatibleCompte("claude-opus", "teams", "__auto__", "claude-sonnet")).toBe("claude-opus");
    expect(modeleCompatibleCompte("__auto__", "perso", "__auto__", "claude-sonnet")).toBe("__auto__");
    expect(modeleCompatibleCompte("claude-opus", "perso", "__auto__", "claude-sonnet")).toBe("claude-opus");
  });
});

describe("le compte vit dans la session, jamais recopié depuis l'affichage", () => {
  const sessionA = { id: "a", title: "A", engine: { providerId: null, model: "m", compte: "teams" as const } };
  const sessionB = { id: "b", title: "B", engine: { providerId: null, model: "m" } };

  it("la fin d'un tour Teams (config d'affichage périmée) n'écrit pas compte sur l'onglet actif", () => {
    // Le tour de A (teams) finit alors que B est active : la sauvegarde recopie fournisseur et modèle sur B,
    // jamais le compte. B reste sans choix explicite, A garde le sien.
    const b = fusionnerMoteur(sessionB.engine, null, "m-de-A");
    expect(b).toEqual({ providerId: null, model: "m-de-A" });
    expect("compte" in b).toBe(false);
    expect(fusionnerMoteur(sessionA.engine, null, "m").compte).toBe("teams");
  });

  it("avecCompteMoteur ne touche que la session visée, et retire le champ avec null", () => {
    const apres = avecCompteMoteur([sessionA, sessionB] as never[], "b", "teams") as unknown as Array<typeof sessionA>;
    expect(apres[1].engine.compte).toBe("teams");
    expect(apres[0].engine.compte).toBe("teams");
    const retire = avecCompteMoteur([sessionA] as never[], "a", null) as unknown as Array<typeof sessionB>;
    expect("compte" in retire[0].engine).toBe(false);
  });

  it("même règle côté Chat", () => {
    const chat = [{ id: "a", compte: "teams" as const }, { id: "b" }];
    expect(avecCompteChat(chat, "b", "teams")).toEqual([{ id: "a", compte: "teams" }, { id: "b", compte: "teams" }]);
    expect(avecCompteChat(chat, "a", null)).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("une nouvelle session repart du défaut de son projet : pas de compte hérité", () => {
    expect(moteurNouvelleSession(null, "m")).toEqual({ providerId: null, model: "m" });
  });
});

describe("câblage des pages (garde-fous de source)", () => {
  // T-217 — le checkout Windows de la CI passe les sources en CRLF : on lit en LF,
  // sinon les motifs multi-lignes ci-dessous testent l'OS et non le code.
  const lire = (f: string) =>
    readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), f), "utf8").replace(/\r\n/g, "\n");

  it("les sauvegardes de fin de tour ne recopient plus le compte depuis l'état d'affichage", () => {
    expect(lire("AgentPage.tsx")).not.toMatch(/compte:\s*compteChoisi/);
    expect(lire("ChatPage.tsx")).not.toMatch(/compte:\s*compteChoisi/);
    expect(lire("AgentPage.tsx")).toContain("fusionnerMoteur(s.engine");
  });

  it("l'autosave de la page Projets dépend de compteChoisi", () => {
    const src = lire("AgentPage.tsx");
    const m = /\n  \}, \[\n((?:    [A-Za-z]+,\n)+)  \]\);\n\n  \/\*\* Charge un `ProjectState`/.exec(src);
    expect(m, "tableau de dépendances de l'autosave introuvable").not.toBeNull();
    expect(m?.[1]).toContain("compteChoisi");
  });

  it("une nouvelle session remet le choix de compte à null (Projets et Chat)", () => {
    const agent = lire("AgentPage.tsx");
    expect(agent.match(/moteurNouvelleSession\(/g)?.length).toBe(2); // les deux sites de création
    expect(agent.match(/setCompteChoisi\(null\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(lire("ChatPage.tsx").match(/setCompteChoisi\(null\)/g)?.length).toBe(2);
  });

  it("le Chat ne propose Auto que si le compte effectif est perso", () => {
    const src = lire("ChatPage.tsx");
    expect(src).toContain("autoOk ? [{ value: AUTO_MODEL");
    expect(src).toContain("modeleCompatibleCompte(m, compteTour, AUTO_MODEL");
    expect(src).not.toMatch(/model === AUTO_MODEL \? "perso"/);
  });
});

describe("session ancienne", () => {
  it("un moteur persisté sans champ compte vaut perso : aucun choix explicite", () => {
    const ancien = { providerId: null, model: "" };
    expect(compteExplicite(ancien)).toBeNull();
    expect(compteExplicite(claudeEngine())).toBeNull();
    expect(resoudreCompteSession(compteExplicite(ancien), undefined, [PERSO, TEAMS]).compte).toBe("perso");
  });

  it("un champ illisible est ignoré plutôt que d'envoyer un compte inconnu", () => {
    expect(compteExplicite({ compte: "autre" })).toBeNull();
    expect(compteExplicite({ compte: 3 })).toBeNull();
    expect(compteExplicite({ compte: "teams" })).toBe("teams");
  });
});

describe("optionsMoteurClaude", () => {
  it("sans second compte : l'unique option d'avant, libellé compris", () => {
    expect(optionsMoteurClaude([PERSO], "")).toEqual([{ value: "", label: LIBELLE_CLAUDE_UNIQUE }]);
    expect(optionsMoteurClaude([], "claude-abonnement")).toEqual([{ value: "claude-abonnement", label: "Claude (abonnement)" }]);
  });

  it("avec second compte : deux options à la place de « Claude (abonnement) »", () => {
    expect(optionsMoteurClaude([PERSO, TEAMS], "")).toEqual([
      { value: "", label: "Claude Perso" },
      { value: VALEUR_MOTEUR_TEAMS, label: "Claude Teams" },
    ]);
  });

  it("un compte déconnecté reste sélectionnable et le libellé le dit", () => {
    const options = optionsMoteurClaude([PERSO, TEAMS_DECONNECTE], "");
    expect(options[1]).toEqual({ value: VALEUR_MOTEUR_TEAMS, label: "Claude Teams (déconnecté)" });
  });

  it("une session déjà sur Teams garde son option même si les identifiants ont disparu", () => {
    const options = optionsMoteurClaude([PERSO], "", "teams");
    expect(options.map((o) => o.value)).toEqual(["", VALEUR_MOTEUR_TEAMS]);
    expect(options[1].label).toContain("indisponible");
  });
});

describe("parseComptes", () => {
  it("lit la réponse de claude.comptes et ignore ce qui n'est pas reconnu", () => {
    const comptes = parseComptes({
      comptes: [{ id: "perso", label: "Claude Perso", connecte: true }, { id: "inconnu" }, null, { id: "teams", connecte: false }],
    });
    expect(comptes).toEqual([PERSO, { id: "teams", label: "teams", connecte: false }]);
    expect(secondCompteDispo(comptes)).toBe(true);
  });

  it("réponse absente ou mal formée : aucun compte, donc l'interface d'avant", () => {
    expect(parseComptes({})).toEqual([]);
    expect(parseComptes({ comptes: "x" })).toEqual([]);
    expect(secondCompteDispo([])).toBe(false);
  });
});

describe("le compte part avec les requêtes", () => {
  beforeEach(() => invoke.mockClear());

  const derniereRequete = () => {
    const appels = invoke.mock.calls as unknown as Array<[string, { request: { method: string; params: Record<string, unknown> } }]>;
    return appels[appels.length - 1][1].request;
  };

  it("claude.start porte le compte du tour", async () => {
    claudeStart({ prompt: "salut", compte: "teams" }, {});
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(derniereRequete().method).toBe("claude.start");
    expect(derniereRequete().params.compte).toBe("teams");
  });

  it("claude.start sans compte, ou sur perso, n'en envoie pas (= perso côté sidecar)", async () => {
    claudeStart({ prompt: "salut" }, {});
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect("compte" in derniereRequete().params).toBe(false);
    invoke.mockClear();
    claudeStart({ prompt: "salut", compte: "perso" }, {});
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect("compte" in derniereRequete().params).toBe(false);
  });

  it("le menu « / » et les sondes de conso portent le même compte", async () => {
    void claudeCommands("/tmp/projet", "teams").catch(() => undefined);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(derniereRequete()).toMatchObject({ method: "claude.commands", params: { cwd: "/tmp/projet", compte: "teams" } });
    invoke.mockClear();
    void claudeCommands("/tmp/projet", "perso").catch(() => undefined);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect("compte" in derniereRequete().params).toBe(false);
    invoke.mockClear();
    void usageClaude("teams").catch(() => undefined);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(derniereRequete()).toMatchObject({ method: "usage.claude", params: { compte: "teams" } });
    invoke.mockClear();
    void usageClaudeInit({}, "teams").catch(() => undefined);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(derniereRequete()).toMatchObject({ method: "usage.claude.init", params: { compte: "teams" } });
    invoke.mockClear();
    void usageClaude().catch(() => undefined);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect("compte" in derniereRequete().params).toBe(false);
  });
});

describe("défaut de projet et sondes", () => {
  it("defautDeProjet ignore une valeur invalide au lieu de la deviner", () => {
    expect(defautDeProjet({ compteClaude: "teams" })).toBe("teams");
    expect(defautDeProjet({ compteClaude: "team" })).toBeNull();
    expect(defautDeProjet({})).toBeNull();
    expect(defautDeProjet(undefined)).toBeNull();
  });

  it("chaque compte disponible est sondé, un compte déconnecté ou absent ne l'est pas", () => {
    expect(comptesASonder([PERSO, TEAMS])).toEqual(["perso", "teams"]);
    expect(comptesASonder([PERSO, TEAMS_DECONNECTE])).toEqual(["perso"]);
    expect(comptesASonder([PERSO])).toEqual(["perso"]);
    expect(comptesASonder(null)).toEqual(["perso"]);
  });
});
