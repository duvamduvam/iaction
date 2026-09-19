/*
 * État éclaté (T-061) : les invariants qui protègent l'historique.
 *
 * Le pire scénario ici n'est pas un test rouge : c'est une migration qui perd
 * l'un des deux exemplaires d'un historique de conversations. D'où les trois
 * invariants que ce fichier verrouille : rien n'est jamais détruit (les
 * monolithes sont renommés, les retraits mis de côté), la migration est
 * idempotente (un renommage raté ⇒ on ré-éclate, on ne perd pas), et une
 * sauvegarde n'écrit QUE ce qui a changé.
 */

import { describe, expect, it } from "vitest";

import {
  chargerChat,
  chargerProjets,
  idDeNom,
  INDEX_CHAT,
  nomPour,
  PREFIXE_CHAT_CONV,
  PREFIXE_PROJET,
  retirerConversationChat,
  retirerProjet,
  sauverChat,
  sauverProjet,
  type IoEtat,
} from "./etatEclate";

/** Faux magasin : mêmes règles que state_store.rs (refus d'écraser au renommage). */
function fauxMagasin(initial: Record<string, unknown> = {}) {
  const fichiers = new Map<string, unknown>(Object.entries(initial));
  const journal: string[] = [];
  const io: IoEtat = {
    lire: async (nom) => fichiers.get(nom) ?? {},
    ecrire: async (nom, valeur) => {
      journal.push(`ecrire:${nom}`);
      fichiers.set(nom, JSON.parse(JSON.stringify(valeur)));
    },
    lister: async (prefixe) => [...fichiers.keys()].filter((n) => n.startsWith(prefixe)).sort(),
    renommer: async (nom, nouveau) => {
      if (fichiers.has(nouveau)) throw new Error("cible déjà existante");
      if (!fichiers.has(nom)) throw new Error("source absente");
      journal.push(`renommer:${nom}→${nouveau}`);
      fichiers.set(nouveau, fichiers.get(nom));
      fichiers.delete(nom);
    },
  };
  return { io, fichiers, journal };
}

describe("noms de fichiers", () => {
  it("laisse intacts les ids réels du dépôt (slugs et UUID)", () => {
    expect(nomPour(PREFIXE_PROJET, "mon-projet")).toBe("projet-mon-projet");
    const uuid = "f81d4fae-7dec-11d0-a765-00a0c91e6bf6";
    expect(nomPour(PREFIXE_CHAT_CONV, uuid)).toBe(`chatconv-${uuid}`);
  });

  it("borne le cas hostile au lieu de le laisser échouer côté Rust", () => {
    expect(nomPour(PREFIXE_PROJET, "Été/2026 !!")).toBe("projet-t-2026");
    expect(nomPour(PREFIXE_PROJET, "")).toBe("projet-sans-nom");
    expect(nomPour(PREFIXE_PROJET, "x".repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it("retrouve l'id depuis un nom listé", () => {
    expect(idDeNom(PREFIXE_PROJET, "projet-mon-projet")).toBe("mon-projet");
  });
});

describe("projets — migration du monolithe", () => {
  const monolithe = {
    "projet-a": { sessions: [{ id: "s1" }], activeId: "s1" },
    "projet-b": { sessions: [], activeId: null },
  };

  it("éclate, recharge à l'identique, et RENOMME le monolithe sans le détruire", async () => {
    const { io, fichiers } = fauxMagasin({ "project-conversations": monolithe });
    const doc = await chargerProjets(io);

    expect(doc).toEqual(monolithe);
    expect(fichiers.has("project-conversations")).toBe(false);
    expect(fichiers.get("project-conversations-avant-eclatement")).toEqual(monolithe);
    expect(fichiers.has("projet-projet-a")).toBe(true);
  });

  it("est idempotente : un renommage raté ré-éclate au lieu de perdre", async () => {
    // Migration interrompue : la sauvegarde existe déjà, le monolithe aussi.
    const { io, fichiers } = fauxMagasin({
      "project-conversations": monolithe,
      "project-conversations-avant-eclatement": { vieux: true },
    });
    const doc = await chargerProjets(io);
    expect(doc).toEqual(monolithe);
    // Le monolithe reste (renommage refusé — la cible existait) : la vérité
    // n'est pas perdue, et le prochain chargement ré-éclatera sans dégât.
    expect(fichiers.has("project-conversations")).toBe(true);
    expect(fichiers.get("project-conversations-avant-eclatement")).toEqual({ vieux: true });
  });

  it("sans monolithe, charge simplement les fichiers éclatés", async () => {
    const { io } = fauxMagasin({
      "projet-alpha": { id: "alpha", entree: { sessions: [1] } },
      "projet-beta": { id: "beta", entree: { sessions: [2] } },
    });
    expect(await chargerProjets(io)).toEqual({ alpha: { sessions: [1] }, beta: { sessions: [2] } });
  });

  it("l'id qui fait foi est celui DU fichier, pas celui du nom normalisé", async () => {
    const { io } = fauxMagasin();
    await sauverProjet(io, "Été/2026 !!", { sessions: [] });
    const doc = await chargerProjets(io);
    expect(Object.keys(doc)).toEqual(["Été/2026 !!"]);
  });

  it("sauver un projet n'écrit QUE son fichier", async () => {
    const { io, journal } = fauxMagasin({
      "projet-alpha": { id: "alpha", entree: {} },
      "projet-beta": { id: "beta", entree: {} },
    });
    await sauverProjet(io, "alpha", { sessions: ["neuf"] });
    expect(journal).toEqual(["ecrire:projet-alpha"]);
  });

  it("retirer met de côté, ne détruit pas", async () => {
    const { io, fichiers } = fauxMagasin({ "projet-alpha": { id: "alpha", entree: { sessions: [1] } } });
    await retirerProjet(io, "alpha");
    expect(fichiers.has("projet-alpha")).toBe(false);
    expect(fichiers.get("retire-projet-alpha")).toEqual({ id: "alpha", entree: { sessions: [1] } });
    // Et le chargement ne le voit plus.
    expect(await chargerProjets(io)).toEqual({});
  });
});

describe("chat — migration et écritures bornées", () => {
  const monolitheChat = {
    sessions: [
      { id: "aaa", updatedAt: "2026-08-14T10:00:00Z", entries: [1] },
      { id: "bbb", updatedAt: "2026-08-15T10:00:00Z", entries: [2] },
    ],
    activeId: "bbb",
    openConversationIds: ["bbb", "aaa"],
  };

  it("éclate le monolithe en une conversation par fichier + un index", async () => {
    const { io, fichiers } = fauxMagasin({ "chat-conversations": monolitheChat });
    const { sessions, index } = await chargerChat(io);

    expect(sessions.map((s) => (s as { id: string }).id)).toEqual(["bbb", "aaa"]); // plus récente d'abord
    expect(index).toEqual({ activeId: "bbb", openConversationIds: ["bbb", "aaa"] });
    expect(fichiers.has("chat-conversations")).toBe(false);
    expect(fichiers.get("chat-conversations-avant-eclatement")).toEqual(monolitheChat);
  });

  it("n'écrit que les conversations qui ont changé", async () => {
    const { io, journal } = fauxMagasin();
    const cache = new Map<string, string>();
    const s1 = { id: "aaa", updatedAt: "t1" };
    const s2 = { id: "bbb", updatedAt: "t1" };

    await sauverChat(io, [s1, s2], { activeId: "aaa", openConversationIds: ["aaa"] }, cache);
    expect(journal.filter((l) => l.startsWith("ecrire:chatconv-"))).toHaveLength(2);

    journal.length = 0;
    await sauverChat(io, [s1, { ...s2, updatedAt: "t2" }], { activeId: "aaa", openConversationIds: ["aaa"] }, cache);
    // Seule bbb a changé : une seule écriture de conversation (l'index, lui,
    // est petit et toujours réécrit).
    expect(journal.filter((l) => l.startsWith("ecrire:chatconv-"))).toEqual(["ecrire:chatconv-bbb"]);
  });

  it("retirer une conversation la met de côté et oublie son empreinte", async () => {
    const { io, fichiers } = fauxMagasin({ "chatconv-aaa": { id: "aaa" } });
    const cache = new Map([["aaa", "empreinte"]]);
    await retirerConversationChat(io, "aaa", cache);
    expect(fichiers.has("chatconv-aaa")).toBe(false);
    expect(fichiers.has("retire-chatconv-aaa")).toBe(true);
    expect(cache.has("aaa")).toBe(false);
  });

  it("index absent : des valeurs sûres, pas une exception", async () => {
    const { io } = fauxMagasin({ "chatconv-aaa": { id: "aaa" } });
    const { index } = await chargerChat(io);
    expect(index).toEqual({ activeId: null, openConversationIds: [] });
    void INDEX_CHAT;
  });
});
