/*
 * Titres et recherche des discussions (T-197) : la décision de déclencher, la
 * pose d'un titre arrivé tardivement, la recherche et le passage de rattrapage.
 * Le piège que ces cas gardent : un titre qui coûte une requête ne doit être
 * demandé ni deux fois, ni pour une discussion renommée, ni pour un moteur local.
 */
import { describe, expect, it } from "vitest";
import {
  doitTitrer,
  ECHECS_CONSECUTIFS_MAX,
  filtrerSessions,
  marquerTentee,
  normaliserRecherche,
  parseTitreDiscussion,
  poserTitreIA,
  premierEchange,
  rattraperTitres,
  type CandidatTitre,
} from "./titresDiscussions";
import { titreAffiche, type SessionMeta } from "./sessionStore";
import { candidatTitreChat, titreSessionChat } from "./chatTitres";
import type { ChatEntry } from "./ChatPage";

const echange = { message: "Chansons faciles ?", reponse: "Voici" };
const candidat = (extra: Partial<CandidatTitre> = {}): CandidatTitre => ({
  id: "s1",
  titleCustom: false,
  moteurClaude: true,
  echange,
  ...extra,
});

describe("titreAffiche", () => {
  it("renommage > titre IA > repli du premier message", () => {
    expect(titreAffiche({ title: "Mon titre", titleCustom: true, titreIA: "IA" }, "Bonjour")).toBe("Mon titre");
    expect(titreAffiche({ title: "x", titleCustom: false, titreIA: "IA" }, "Bonjour")).toBe("IA");
    expect(titreAffiche({ title: "x", titleCustom: false }, "Bonjour tout le monde")).toBe("Bonjour tout le monde");
    expect(titreAffiche({ title: "x", titleCustom: false, titreIA: "  " }, "Bonjour")).toBe("Bonjour");
  });
});

describe("doitTitrer — décision de déclenchement", () => {
  it("cas nominal", () => expect(doitTitrer(candidat(), new Set())).toBe(true));
  it("renommée : jamais", () => expect(doitTitrer(candidat({ titleCustom: true }), new Set())).toBe(false));
  it("déjà titrée : jamais", () => expect(doitTitrer(candidat({ titreIA: "Déjà" }), new Set())).toBe(false));
  it("moteur neutre : jamais", () => expect(doitTitrer(candidat({ moteurClaude: false }), new Set())).toBe(false));
  it("réponse absente : pas encore", () => expect(doitTitrer(candidat({ echange: null }), new Set())).toBe(false));
  it("déjà tentée ce lancement : jamais deux fois (aussi ce qui évite la boucle sur un sidecar ancien)", () => {
    const tentees = new Set<string>();
    expect(doitTitrer(candidat(), tentees)).toBe(true);
    marquerTentee("s1", tentees);
    expect(doitTitrer(candidat(), tentees)).toBe(false);
  });
});

describe("premierEchange", () => {
  it("prend le premier message non vide et la première réponse TERMINÉE qui suit", () => {
    expect(
      premierEchange([
        { role: "user", texte: "  ", terminee: true },
        { role: "user", texte: "Question", terminee: true },
        { role: "assistant", texte: "En cours", terminee: false },
        { role: "assistant", texte: "Réponse", terminee: true },
      ]),
    ).toEqual({ message: "Question", reponse: "Réponse" });
  });
  it("sans réponse terminée : null", () => {
    expect(premierEchange([{ role: "user", texte: "Q", terminee: true }])).toBeNull();
  });
});

describe("poserTitreIA — arrivée tardive", () => {
  const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
    id,
    title: `repli ${id}`,
    titleCustom: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...extra,
  });

  it("atterrit sur la bonne session, quelle que soit sa place (hors onglet actif)", () => {
    const avant = [meta("a"), meta("b"), meta("c")];
    const apres = poserTitreIA(avant, "b", "Chansons pour ukulélé");
    expect(apres[1]).toMatchObject({ titreIA: "Chansons pour ukulélé", title: "Chansons pour ukulélé" });
    expect(apres[0]).toBe(avant[0]);
    expect(apres[2]).toBe(avant[2]);
  });
  it("ne casse pas un renommage fait entre-temps", () => {
    const avant = [meta("a", { titleCustom: true, title: "Mon nom" })];
    const apres = poserTitreIA(avant, "a", "Titre IA");
    expect(apres).toBe(avant);
    expect(apres[0].title).toBe("Mon nom");
  });
  it("session disparue ou déjà titrée : même référence, rien à sauver", () => {
    const avant = [meta("a", { titreIA: "Premier" })];
    expect(poserTitreIA(avant, "a", "Second")).toBe(avant);
    expect(poserTitreIA(avant, "absente", "X")).toBe(avant);
  });
});

describe("parseTitreDiscussion", () => {
  it("chaîne non vide, sinon null", () => {
    expect(parseTitreDiscussion({ titre: " Un titre " })).toBe("Un titre");
    expect(parseTitreDiscussion({ titre: null })).toBeNull();
    expect(parseTitreDiscussion({})).toBeNull();
  });
});

describe("filtrerSessions", () => {
  const liste = [
    { title: "Chansons faciles pour ukulélé", texte: "accords de do" },
    { title: "Facture OVH", texte: "le serveur Docker plante" },
  ];
  it("insensible à la casse et aux accents", () => {
    expect(filtrerSessions(liste, "UKULELE")).toHaveLength(1);
    expect(normaliserRecherche("Éléphant")).toBe("elephant");
  });
  it("tous les mots doivent être présents", () => {
    expect(filtrerSessions(liste, "chansons ukulele")).toHaveLength(1);
    expect(filtrerSessions(liste, "chansons ovh")).toHaveLength(0);
  });
  it("cherche aussi dans le contenu quand il est fourni, jamais pour les archives (titre seul)", () => {
    expect(filtrerSessions(liste, "docker", (s) => s.texte)).toHaveLength(1);
    expect(filtrerSessions(liste, "docker")).toHaveLength(0);
    expect(filtrerSessions(liste, "ovh docker", (s) => s.texte)).toHaveLength(1);
  });
  it("requête vide : tout", () => expect(filtrerSessions(liste, "  ")).toHaveLength(2));
});

describe("rattraperTitres", () => {
  const arret = { arrete: false };
  it("une session à la fois, un échec passe à la suivante", async () => {
    const posees: string[] = [];
    const bilan = await rattraperTitres({
      ids: ["a", "b", "c"],
      nommer: async (id) => (id === "b" ? null : `T-${id}`),
      appliquer: (id) => void posees.push(id),
      arret,
    });
    expect(posees).toEqual(["a", "c"]);
    expect(bilan).toMatchObject({ nommees: 2, echecs: 1, quota: false });
  });
  it(`${ECHECS_CONSECUTIFS_MAX} échecs de suite arrêtent le passage (quota)`, async () => {
    const vus: string[] = [];
    const bilan = await rattraperTitres({
      ids: ["a", "b", "c", "d", "e"],
      nommer: async (id) => (vus.push(id), null),
      appliquer: () => {},
      arret,
    });
    expect(vus).toEqual(["a", "b", "c"]);
    expect(bilan.quota).toBe(true);
  });
  it("une inéligible découverte en route n'est ni un succès ni un échec", async () => {
    const bilan = await rattraperTitres({
      ids: ["a", "b", "c", "d"],
      nommer: async (id) => (id === "d" ? "T" : undefined),
      appliquer: () => {},
      arret,
    });
    expect(bilan).toMatchObject({ nommees: 1, echecs: 0, ignorees: 3, quota: false });
  });
  it("le bouton d'arrêt agit entre deux sessions", async () => {
    const a = { arrete: false };
    const bilan = await rattraperTitres({
      ids: ["a", "b", "c"],
      nommer: async (id) => {
        if (id === "a") a.arrete = true;
        return "T";
      },
      appliquer: () => {},
      arret: a,
    });
    expect(bilan).toMatchObject({ nommees: 1, arrete: true });
  });
});

describe("page Chat — adaptation", () => {
  const e = (role: "user" | "assistant", content: string, status: ChatEntry["status"] = "done"): ChatEntry => ({
    id: `${role}-${content}`,
    role,
    content,
    status,
  });
  it("titreSessionChat conserve le titre IA malgré le recalcul de sauvegarde", () => {
    const entries = [e("user", "Donne la somme"), e("assistant", "42")];
    expect(titreSessionChat({ title: "Donne la somme", titleCustom: false, titreIA: "Addition de nombres" }, entries)).toBe("Addition de nombres");
    expect(titreSessionChat({ title: "Donne la somme", titleCustom: false }, entries)).toBe("Donne la somme");
  });
  it("candidat : fournisseur neutre ou routage neutre écartés", () => {
    const s = { id: "c", titleCustom: false, entries: [e("user", "Q"), e("assistant", "R")] };
    expect(candidatTitreChat(s, true).echange).toEqual({ message: "Q", reponse: "R" });
    expect(candidatTitreChat(s, false).moteurClaude).toBe(false);
    expect(candidatTitreChat({ ...s, routedTarget: { engine: "neutral" } }, true).moteurClaude).toBe(false);
  });
});
