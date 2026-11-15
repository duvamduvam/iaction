/*
 * Persistance de la page Chat (sortie de ChatPage.tsx, T-209) : validation
 * défensive du document lu du disque, unicité des ids d'entrées,
 * sérialisation bornée.
 */
import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatSession } from "./ChatPage";
import {
  buildPersistedChatState,
  MAX_CHAT_SESSIONS,
  MAX_PERSISTED_CHAT_ENTRIES,
  nextEntryId,
  sanitizeChatState,
} from "./chatPersistance";

function entree(id: string, partiel: Partial<ChatEntry> = {}): ChatEntry {
  return { id, role: "user", content: "salut", status: "done", ...partiel };
}

function session(id: string, entries: ChatEntry[] = [], partiel: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title: id,
    titleCustom: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    entries,
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

describe("nextEntryId", () => {
  it("préfixe + UUID, jamais deux fois le même", () => {
    expect(nextEntryId("u")).toMatch(/^u-/);
    expect(nextEntryId("u")).not.toBe(nextEntryId("u"));
  });
});

describe("sanitizeChatState", () => {
  it("document absent, vide ou corrompu : null", () => {
    expect(sanitizeChatState(null)).toBeNull();
    expect(sanitizeChatState({ sessions: [] })).toBeNull();
    expect(sanitizeChatState({ sessions: [{ id: 1 }], activeId: "a" })).toBeNull();
    expect(sanitizeChatState({ sessions: [session("a")] })).toBeNull();
  });

  it("document valide : active connue, onglets ouverts garantis (repli sur l'active)", () => {
    const r = sanitizeChatState({ sessions: [session("a"), session("b")], activeId: "zz", openConversationIds: ["fantome"] });
    expect(r?.activeId).toBe("a");
    expect(r?.openConversationIds).toEqual(["a"]);
  });

  it("l'active est toujours ouverte en onglet", () => {
    const r = sanitizeChatState({ sessions: [session("a"), session("b")], activeId: "b", openConversationIds: ["a"] });
    expect(r?.openConversationIds).toEqual(["a", "b"]);
  });

  it("sessions antérieures à webSearch : défaut true", () => {
    const { webSearch: _w, ...ancienne } = session("a");
    void _w;
    expect(sanitizeChatState({ sessions: [ancienne], activeId: "a" })?.sessions[0].webSearch).toBe(true);
  });

  it("ids d'entrées dupliqués entre sessions : réattribués, rien de supprimé", () => {
    const r = sanitizeChatState({
      sessions: [session("a", [entree("e1")]), session("b", [entree("e1")])],
      activeId: "a",
    });
    const ids = r!.sessions.flatMap((s) => s.entries.map((e) => e.id));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("e1");
  });

  it("titre IA illisible : ignoré sans invalider la session", () => {
    const r = sanitizeChatState({ sessions: [{ ...session("a"), titreIA: 3 }], activeId: "a" });
    expect(r?.sessions[0]).not.toHaveProperty("titreIA");
  });
});

describe("buildPersistedChatState", () => {
  it("n'écrit jamais un tour en streaming et borne les entrées", () => {
    const entries = Array.from({ length: MAX_PERSISTED_CHAT_ENTRIES + 5 }, (_, i) => entree(`e${i}`));
    entries.push(entree("vif", { role: "assistant", status: "streaming" }));
    const r = buildPersistedChatState({ sessions: [session("a", entries)], activeId: "a", openConversationIds: ["a"] });
    expect(r.sessions[0].entries).toHaveLength(MAX_PERSISTED_CHAT_ENTRIES);
    expect(r.sessions[0].entries.some((e) => e.status === "streaming")).toBe(false);
  });

  it("réaligne la compaction après troncature, l'oublie si elle ne couvre plus rien", () => {
    const n = MAX_PERSISTED_CHAT_ENTRIES + 10;
    const entries = Array.from({ length: n }, (_, i) => entree(`e${i}`));
    const compaction = { summary: "r", upToIndex: 5, at: "2026-01-01T00:00:00.000Z" } as unknown as ChatSession["compaction"];
    const r1 = buildPersistedChatState({ sessions: [session("a", entries, { compaction })], activeId: "a", openConversationIds: ["a"] });
    expect(r1.sessions[0].compaction).toBeNull();
    const compaction2 = { summary: "r", upToIndex: 150, at: "2026-01-01T00:00:00.000Z" } as unknown as ChatSession["compaction"];
    const r2 = buildPersistedChatState({ sessions: [session("a", entries, { compaction: compaction2 })], activeId: "a", openConversationIds: ["a"] });
    expect(r2.sessions[0].compaction).toMatchObject({ upToIndex: 140 });
  });

  it("T-152 — n'abandonne AUCUNE conversation à l'écriture, même au-delà du seuil d'archivage", () => {
    const sessions = Array.from({ length: MAX_CHAT_SESSIONS + 4 }, (_, i) => session(`s${i}`));
    const r = buildPersistedChatState({ sessions, activeId: "s0", openConversationIds: ["s0", "s1"] });
    expect(r.sessions.map((s) => s.id)).toEqual(sessions.map((s) => s.id));
    expect(r.openConversationIds).toEqual(["s0", "s1"]);
  });

  it("filtre les onglets qui ne désignent aucune session, avec repli sur l'active", () => {
    const r = buildPersistedChatState({ sessions: [session("a")], activeId: "a", openConversationIds: ["fantome"] });
    expect(r.openConversationIds).toEqual(["a"]);
  });
});
