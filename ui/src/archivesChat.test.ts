/*
 * Archivage des conversations du Chat au-delà du seuil (T-152). Le pire
 * scénario n'est pas un test rouge : c'est une conversation qui quitte le vif
 * sans qu'aucune archive ne la retienne — ou dont les modifications ne sont
 * plus écrites nulle part (le défaut d'origine).
 */
import { describe, expect, it } from "vitest";

import {
  archiverChat,
  chargerIndexArchivesChat,
  choisirArchivablesChat,
  INDEX_ARCHIVES_CHAT,
  mettreDeCoteChat,
  nomArchiveChat,
  restaurerChat,
  resumerChat,
} from "./archivesChat";
import type { Journaliser } from "./archivesSessions";
import type { ChatEntry, ChatSession } from "./ChatPage";
import { buildPersistedChatState, MAX_CHAT_SESSIONS } from "./chatPersistance";
import { nomPour, PREFIXE_CHAT_CONV, retirerConversationChat, sauverChat, type IoEtat } from "./etatEclate";

/** Faux magasin (mêmes règles que state_store.rs) avec pannes programmables. */
function fauxMagasin(initial: Record<string, unknown> = {}) {
  const fichiers = new Map<string, unknown>(Object.entries(initial));
  const pannesEcriture = new Set<string>();
  const pannesLecture = new Set<string>();
  const io: IoEtat = {
    lire: async (nom) => {
      if (pannesLecture.has(nom)) throw new Error("illisible");
      return fichiers.get(nom) ?? null;
    },
    ecrire: async (nom, valeur) => {
      if (pannesEcriture.has(nom)) throw new Error("disque plein");
      fichiers.set(nom, JSON.parse(JSON.stringify(valeur)));
    },
    lister: async (prefixe) => [...fichiers.keys()].filter((n) => n.startsWith(prefixe)).sort(),
    renommer: async (nom, nouveau) => {
      if (fichiers.has(nouveau)) throw new Error("cible déjà existante");
      if (!fichiers.has(nom)) throw new Error("source absente");
      fichiers.set(nouveau, fichiers.get(nom));
      fichiers.delete(nom);
    },
  };
  return { io, fichiers, pannesEcriture, pannesLecture };
}

function espion() {
  const lignes: Array<{ niveau: string; msg: string }> = [];
  const journaliser: Journaliser = (niveau, msg) => void lignes.push({ niveau, msg });
  return { journaliser, lignes };
}

function entree(id: string): ChatEntry {
  return { id, role: "user", content: "salut", status: "done" };
}

/** Conversation `n` : plus `n` est grand, plus elle est récente. */
function conv(n: number, partiel: Partial<ChatSession> = {}): ChatSession {
  return {
    id: `c${n}`,
    title: `Conversation ${n}`,
    titleCustom: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: `2026-02-${String(n + 1).padStart(2, "0")}T00:00:00.000Z`,
    entries: [entree(`e${n}`)],
    providerId: "p",
    model: "m",
    systemPrompt: "",
    claudeSessionId: null,
    webSearch: true,
    routedTier: null,
    routedTarget: null,
    compaction: null,
    reveils: [],
    reveilsHistorique: [],
    ...partiel,
  };
}

const NB = MAX_CHAT_SESSIONS + 5;
const toutes = (): ChatSession[] => Array.from({ length: NB }, (_, i) => conv(i));

describe("choisirArchivablesChat", () => {
  it("rien sous le seuil", () => {
    const sessions = Array.from({ length: MAX_CHAT_SESSIONS }, (_, i) => conv(i));
    expect(choisirArchivablesChat({ sessions, activeId: "c0", openConversationIds: ["c0"] })).toEqual([]);
  });

  it("archive les plus anciennes au-delà du seuil", () => {
    const r = choisirArchivablesChat({ sessions: toutes(), activeId: `c${NB - 1}`, openConversationIds: [`c${NB - 1}`] });
    expect(r.map((s) => s.id)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  it("jamais l'active, jamais une conversation ouverte en onglet, jamais un réveil armé", () => {
    const sessions = toutes().map((s) => (s.id === "c2" ? { ...s, reveils: [{} as ChatSession["reveils"][number]] } : s));
    const r = choisirArchivablesChat({ sessions, activeId: "c0", openConversationIds: ["c0", "c1"] });
    expect(r.map((s) => s.id)).toEqual(["c3", "c4"]);
  });
});

describe("T-152 — plus aucune écriture abandonnée", () => {
  it("le document écrit contient TOUTES les conversations vives : une modification hors seuil est sauvée", async () => {
    const { io, fichiers } = fauxMagasin();
    const cache = new Map<string, string>();
    const sessions = toutes();
    const doc = buildPersistedChatState({ sessions, activeId: `c${NB - 1}`, openConversationIds: [`c${NB - 1}`] });
    await sauverChat(io, doc.sessions, { activeId: doc.activeId, openConversationIds: doc.openConversationIds }, cache);
    expect([...fichiers.keys()].filter((n) => n.startsWith(PREFIXE_CHAT_CONV))).toHaveLength(NB);

    // Renommage d'une très ancienne conversation : il part sur disque.
    const modifiees = sessions.map((s) => (s.id === "c0" ? { ...s, title: "Renommée", titleCustom: true } : s));
    const doc2 = buildPersistedChatState({ sessions: modifiees, activeId: `c${NB - 1}`, openConversationIds: [`c${NB - 1}`] });
    await sauverChat(io, doc2.sessions, { activeId: doc2.activeId, openConversationIds: doc2.openConversationIds }, cache);
    expect((fichiers.get(nomPour(PREFIXE_CHAT_CONV, "c0")) as ChatSession).title).toBe("Renommée");
  });
});

describe("archiverChat", () => {
  it("écrit l'archive complète ET l'index, puis rend les ids acquis", async () => {
    const { io, fichiers } = fauxMagasin();
    const { journaliser } = espion();
    const aArchiver = [conv(0), conv(1)];
    const r = await archiverChat(io, aArchiver, [], journaliser);
    expect(r.archivees).toEqual(["c0", "c1"]);
    expect(fichiers.has(nomArchiveChat("c0"))).toBe(true);
    expect((fichiers.get(nomArchiveChat("c1")) as { session: ChatSession }).session.entries).toHaveLength(1);
    const index = fichiers.get(INDEX_ARCHIVES_CHAT) as { archives: Array<{ id: string }> };
    expect(index.archives.map((e) => e.id)).toEqual(["c1", "c0"]); // la plus récente d'abord
    expect(r.index).toEqual(index.archives);
  });

  it("invariant 1 : archive non écrite ⇒ la conversation n'est pas rendue comme acquise", async () => {
    const { io, pannesEcriture } = fauxMagasin();
    const { journaliser, lignes } = espion();
    pannesEcriture.add(nomArchiveChat("c0"));
    const r = await archiverChat(io, [conv(0), conv(1)], [], journaliser);
    expect(r.archivees).toEqual(["c1"]);
    expect(lignes.some((l) => l.niveau === "error")).toBe(true);
  });

  it("invariant 1 : index non écrit ⇒ AUCUNE conversation acquise, index inchangé", async () => {
    const { io, pannesEcriture } = fauxMagasin();
    const { journaliser, lignes } = espion();
    pannesEcriture.add(INDEX_ARCHIVES_CHAT);
    const r = await archiverChat(io, [conv(0)], [], journaliser);
    expect(r.archivees).toEqual([]);
    expect(r.index).toEqual([]);
    expect(lignes.some((l) => l.niveau === "error")).toBe(true);
  });

  it("conserve les entrées d'index existantes", async () => {
    const { io } = fauxMagasin();
    const { journaliser } = espion();
    const ancien = resumerChat(conv(9));
    const r = await archiverChat(io, [conv(0)], [ancien], journaliser);
    expect(r.index.map((e) => e.id).sort()).toEqual(["c0", "c9"]);
  });
});

describe("chargerIndexArchivesChat", () => {
  it("index absent : liste vide, archivage permis", async () => {
    const { io } = fauxMagasin();
    expect(await chargerIndexArchivesChat(io, new Set(), espion().journaliser)).toEqual({ index: [], fiable: true });
  });

  it("invariant 4 : index illisible ⇒ archivage SUSPENDU et journalisé, jamais une liste vide réécrite", async () => {
    const { io, pannesLecture, fichiers } = fauxMagasin({ [INDEX_ARCHIVES_CHAT]: { archives: [resumerChat(conv(1))] } });
    pannesLecture.add(INDEX_ARCHIVES_CHAT);
    const { journaliser, lignes } = espion();
    const r = await chargerIndexArchivesChat(io, new Set(), journaliser);
    expect(r.fiable).toBe(false);
    expect(lignes.some((l) => l.niveau === "error")).toBe(true);
    expect((fichiers.get(INDEX_ARCHIVES_CHAT) as { archives: unknown[] }).archives).toHaveLength(1);
  });

  it("invariant 3 : le vif fait foi — l'entrée d'une conversation vive est retirée et l'index nettoyé", async () => {
    const { io, fichiers } = fauxMagasin({ [INDEX_ARCHIVES_CHAT]: { archives: [resumerChat(conv(1)), resumerChat(conv(2))] } });
    const r = await chargerIndexArchivesChat(io, new Set(["c1"]), espion().journaliser);
    expect(r.index.map((e) => e.id)).toEqual(["c2"]);
    expect((fichiers.get(INDEX_ARCHIVES_CHAT) as { archives: unknown[] }).archives).toHaveLength(1);
  });
});

describe("restaurerChat", () => {
  it("relit l'archive, l'insère, puis seulement la sort de l'index", async () => {
    const { io, fichiers } = fauxMagasin();
    const { journaliser } = espion();
    const a = await archiverChat(io, [conv(0, { title: "Mon titre", titleCustom: true })], [], journaliser);
    let inseree: ChatSession | null = null;
    const r = await restaurerChat(io, "c0", a.index, (s) => ((inseree = s), true), journaliser);
    expect(r?.session.title).toBe("Mon titre");
    expect(inseree).not.toBeNull();
    expect(r?.index).toEqual([]);
    expect(fichiers.has(nomArchiveChat("c0"))).toBe(true); // le fichier d'archive reste
  });

  it("renoncement de l'appelant : rien ne change", async () => {
    const { io } = fauxMagasin();
    const { journaliser } = espion();
    const a = await archiverChat(io, [conv(0)], [], journaliser);
    expect(await restaurerChat(io, "c0", a.index, () => false, journaliser)).toBeNull();
  });

  it("archive absente ou invalide : null et journal, sans exception", async () => {
    const { io } = fauxMagasin({ [nomArchiveChat("c1")]: { session: { id: "c1", n: "importe quoi" } } });
    const { journaliser, lignes } = espion();
    expect(await restaurerChat(io, "c0", [], () => true, journaliser)).toBeNull();
    expect(await restaurerChat(io, "c1", [], () => true, journaliser)).toBeNull();
    expect(lignes.filter((l) => l.niveau === "error")).toHaveLength(2);
  });
});

describe("mettreDeCoteChat et retrait du fichier vif", () => {
  it("la corbeille renomme sous retire-…, ne détruit rien", async () => {
    const { io, fichiers } = fauxMagasin();
    const { journaliser } = espion();
    const a = await archiverChat(io, [conv(0)], [], journaliser);
    const index = await mettreDeCoteChat(io, "c0", a.index, journaliser);
    expect(index).toEqual([]);
    expect(fichiers.has(nomArchiveChat("c0"))).toBe(false);
    expect(fichiers.has(`retire-${nomArchiveChat("c0")}`)).toBe(true);
  });

  it("index non écrit : tout reste en place", async () => {
    const { io, pannesEcriture, fichiers } = fauxMagasin();
    const { journaliser } = espion();
    const a = await archiverChat(io, [conv(0)], [], journaliser);
    pannesEcriture.add(INDEX_ARCHIVES_CHAT);
    const index = await mettreDeCoteChat(io, "c0", a.index, journaliser);
    expect(index).toHaveLength(1);
    expect(fichiers.has(nomArchiveChat("c0"))).toBe(true);
  });

  it("une conversation archivée n'est plus listée au chargement du vif (chatconv- retiré)", async () => {
    const { io, fichiers } = fauxMagasin({ [nomPour(PREFIXE_CHAT_CONV, "c0")]: conv(0) });
    const cache = new Map<string, string>([["c0", "x"]]);
    await archiverChat(io, [conv(0)], [], espion().journaliser);
    await retirerConversationChat(io, "c0", cache);
    expect(await io.lister(PREFIXE_CHAT_CONV)).toEqual([]);
    expect(fichiers.has(`retire-${nomPour(PREFIXE_CHAT_CONV, "c0")}`)).toBe(true);
    expect(fichiers.has(nomArchiveChat("c0"))).toBe(true);
  });
});
