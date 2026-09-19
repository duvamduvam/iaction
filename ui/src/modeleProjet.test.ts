/*
 * Modèle des conversations de projet — persistance, migrations, réparations.
 *
 * Tout ce module travaille sur les données de l'utilisateur : un défaut ici ne
 * s'affiche pas mal, il PERD quelque chose. Les cas ci-dessous fixent les
 * trois protections dans l'ordre où elles ont coûté :
 *   - la déduplication d'identifiants (les ids en collision du 2026-08-04,
 *     qui mélangeaient les conversations) ;
 *   - la réparation de routage AVANT validation (une valeur hors vocabulaire
 *     ne doit jamais faire écarter une session réelle) ;
 *   - la troncature à la persistance (le tour en cours de streaming n'est
 *     jamais écrit — il serait faux au rechargement).
 */
import { describe, expect, it } from "vitest";
import type { AgentTurn } from "./agentTurns";
import {
  appliquerTitresIA,
  buildPersistedSession,
  dedupeTurnIds,
  deriveSessionTitle,
  freshSession,
  MAX_PERSISTED_TURNS,
  sanitizePersistedConversations,
  sessionStateFromPersisted,
  withRoutingRepair,
  type ProjectSession,
} from "./modeleProjet";

const tour = (id: string, extra: Partial<AgentTurn> = {}): AgentTurn => ({
  id,
  role: "user",
  content: `contenu ${id}`,
  status: "done",
  ...extra,
});

/** Session minimale pour les tests de titres (T-063) : repli local distinctif par construction. */
const session = (id: string, extra: Partial<ProjectSession> = {}): ProjectSession => ({
  ...freshSession(),
  id,
  title: `repli local ${id}`,
  sessionId: `srv-${id}`,
  ...extra,
});

describe("dedupeTurnIds — la leçon des ids en collision", () => {
  it("un id déjà vu est RÉGÉNÉRÉ, jamais gardé", () => {
    const vus = new Set<string>(["u-1"]);
    const [repare] = dedupeTurnIds([tour("u-1")], vus, new Set());
    expect(repare.id).not.toBe("u-1");
    expect(repare.id.length).toBeGreaterThan(8); // un UUID, jamais un compteur
  });

  it("un id inédit est conservé tel quel — pas de churn de clés React", () => {
    const [garde] = dedupeTurnIds([tour("u-unique")], new Set(), new Set());
    expect(garde.id).toBe("u-unique");
  });

  it("la collision INTERNE à la liste est aussi réparée", () => {
    const [premier, second] = dedupeTurnIds([tour("u-x"), tour("u-x")], new Set(), new Set());
    expect(premier.id).toBe("u-x");
    expect(second.id).not.toBe("u-x");
  });

  it("les blocs dupliqués sont réparés indépendamment des tours", () => {
    const avecBlocs = tour("a-1", {
      role: "assistant",
      blocks: [
        { id: "blk-1", type: "text", content: "a" },
        { id: "blk-1", type: "text", content: "b" },
      ],
    } as Partial<AgentTurn>);
    const [repare] = dedupeTurnIds([avecBlocs], new Set(), new Set());
    const ids = (repare.blocks ?? []).map((b) => b.id);
    expect(ids[0]).toBe("blk-1");
    expect(ids[1]).not.toBe("blk-1");
  });
});

describe("withRoutingRepair — réparer avant de valider", () => {
  it("un tier hors vocabulaire devient null, la session SURVIT", () => {
    const repare = withRoutingRepair({ id: "s", routedTier: "ultra-genial", routedTarget: null }) as Record<string, unknown>;
    expect(repare.routedTier).toBeNull();
    expect(repare.id).toBe("s");
  });

  it("une cible invalide devient null sans toucher au reste", () => {
    const repare = withRoutingRepair({ routedTier: "moyen", routedTarget: { engine: "vapeur" } }) as Record<string, unknown>;
    expect(repare.routedTier).toBe("moyen");
    expect(repare.routedTarget).toBeNull();
  });

  it("une session sans champs de routage est rendue TELLE QUELLE (même référence)", () => {
    const session = { id: "s" };
    expect(withRoutingRepair(session)).toBe(session);
  });
});

describe("buildPersistedSession — ce qui s'écrit sur le disque", () => {
  it("le tour en cours de streaming n'est JAMAIS persisté", () => {
    const session = { ...freshSession(), turns: [tour("u-1"), tour("a-2", { status: "streaming" })] };
    const persistee = buildPersistedSession(session);
    expect(persistee.turns.map((t) => t.id)).toEqual(["u-1"]);
  });

  it("tronque aux derniers MAX_PERSISTED_TURNS tours — les plus récents gagnent", () => {
    const beaucoup = Array.from({ length: MAX_PERSISTED_TURNS + 50 }, (_, i) => tour(`u-${i}`));
    const persistee = buildPersistedSession({ ...freshSession(), turns: beaucoup });
    expect(persistee.turns).toHaveLength(MAX_PERSISTED_TURNS);
    expect(persistee.turns[0].id).toBe("u-50");
  });

  it("titre auto recalculé depuis le premier tour utilisateur ; titre RENOMMÉ intouchable", () => {
    const base = { ...freshSession(), turns: [tour("u-1", { content: "Corrige la jauge de contexte" })] };
    expect(buildPersistedSession({ ...base, titleCustom: false }).title).toContain("Corrige");
    expect(buildPersistedSession({ ...base, title: "Mon chantier", titleCustom: true }).title).toBe("Mon chantier");
  });

  it("aller-retour : une session persistée se recharge sans perte de champs", () => {
    const originale = {
      ...freshSession(),
      turns: [tour("u-1")],
      sessionId: "sdk-42",
      routedTier: "moyen" as const,
      routedTarget: { engine: "claude" as const, model: "claude-sonnet-5" },
    };
    const rechargee = sessionStateFromPersisted(buildPersistedSession(originale));
    expect(rechargee.sessionId).toBe("sdk-42");
    expect(rechargee.routedTier).toBe("moyen");
    expect(rechargee.routedTarget).toEqual({ engine: "claude", model: "claude-sonnet-5" });
    expect(rechargee.turns.map((t) => t.id)).toEqual(["u-1"]);
  });
});

describe("sanitizePersistedConversations — le videur à l'entrée", () => {
  it("n'importe quoi ⇒ objet vide, jamais d'exception", () => {
    for (const dechet of [null, 42, "x", [], { p1: null }, { p1: { sessions: "non" } }]) {
      expect(sanitizePersistedConversations(dechet)).toEqual({});
    }
  });

  it("une entrée saine traverse intacte", () => {
    const session = buildPersistedSession({ ...freshSession(), turns: [tour("u-1")] });
    const brut = {
      "/mon/projet": {
        sessions: [session],
        activeId: session.id,
        openConversationIds: [session.id],
        openFilePaths: [],
        activeTab: `conv:${session.id}`,
      },
    };
    const propre = sanitizePersistedConversations(brut);
    expect(Object.keys(propre)).toEqual(["/mon/projet"]);
    expect(propre["/mon/projet"].sessions[0].id).toBe(session.id);
  });

  it("un routedTier hors vocabulaire est RÉPARÉ, la session n'est pas écartée", () => {
    const session = { ...buildPersistedSession(freshSession()), routedTier: "cosmique" };
    const brut = {
      "/p": { sessions: [session], activeId: session.id, openConversationIds: [], openFilePaths: [], activeTab: "" },
    };
    const propre = sanitizePersistedConversations(brut);
    expect(propre["/p"].sessions).toHaveLength(1);
    expect(propre["/p"].sessions[0].routedTier).toBeNull();
  });

  it("les ids en collision ENTRE projets sont réparés au chargement", () => {
    const s1 = buildPersistedSession({ ...freshSession(), turns: [tour("u-partage")] });
    const s2 = buildPersistedSession({ ...freshSession(), turns: [tour("u-partage")] });
    const propre = sanitizePersistedConversations({
      "/p1": { sessions: [s1], activeId: s1.id, openConversationIds: [], openFilePaths: [], activeTab: "" },
      "/p2": { sessions: [s2], activeId: s2.id, openConversationIds: [], openFilePaths: [], activeTab: "" },
    });
    const id1 = propre["/p1"].sessions[0].turns[0].id;
    const id2 = propre["/p2"].sessions[0].turns[0].id;
    expect(id1).not.toBe(id2);
  });
});

describe("deriveSessionTitle", () => {
  it("prend le premier tour utilisateur, pas le premier tour tout court", () => {
    const turns = [tour("a-1", { role: "assistant", content: "Bonjour !" }), tour("u-2", { content: "Répare la CI" })];
    expect(deriveSessionTitle(turns)).toContain("Répare");
  });

  it("sans tour utilisateur : titre par défaut, jamais une chaîne vide", () => {
    expect(deriveSessionTitle([]).length).toBeGreaterThan(0);
  });
});

describe("appliquerTitresIA — T-063, le panneau Sessions ne doit plus converger", () => {
  it("cas nominal : titre IA distinct, il remplace le repli local", () => {
    const { sessions, changed } = appliquerTitresIA(
      [session("a")],
      new Map([["srv-a", "Déployer n8n sur OVH"]]),
    );
    expect(changed).toBe(true);
    expect(sessions[0].title).toBe("Déployer n8n sur OVH");
  });

  it("deux sessions convergent vers le même titre IA : la première le gagne, la seconde garde son repli", () => {
    const { sessions, changed } = appliquerTitresIA(
      [session("a"), session("b")],
      new Map([
        ["srv-a", "Déployer n8n sur OVH"],
        ["srv-b", "Déployer n8n sur OVH"],
      ]),
    );
    expect(changed).toBe(true);
    expect(sessions[0].title).toBe("Déployer n8n sur OVH");
    expect(sessions[1].title).toBe("repli local b"); // pas de doublon : repli gardé
    expect(sessions[0].title).not.toBe(sessions[1].title);
  });

  it("reprise (resume) partageant son sessionId serveur : même mécanique, un seul gagnant", () => {
    const { sessions, changed } = appliquerTitresIA(
      [session("premiere", { sessionId: "srv-partage" }), session("reprise", { sessionId: "srv-partage" })],
      new Map([["srv-partage", "Déployer n8n sur OVH"]]),
    );
    expect(changed).toBe(true);
    expect(sessions[0].title).toBe("Déployer n8n sur OVH");
    expect(sessions[1].title).toBe("repli local reprise");
  });

  it("le titre IA est déjà porté par une autre session (pas candidate) : repli gardé", () => {
    const { sessions, changed } = appliquerTitresIA(
      [session("a", { title: "Déployer n8n sur OVH", titleCustom: true }), session("b")],
      new Map([["srv-b", "Déployer n8n sur OVH"]]),
    );
    expect(changed).toBe(false);
    expect(sessions[1].title).toBe("repli local b");
  });

  it("titleCustom n'est jamais écrasé", () => {
    const { sessions, changed } = appliquerTitresIA(
      [session("a", { titleCustom: true, title: "Mon titre à moi" })],
      new Map([["srv-a", "Déployer n8n sur OVH"]]),
    );
    expect(changed).toBe(false);
    expect(sessions[0].title).toBe("Mon titre à moi");
  });

  it("sans sessionId (moteur neutre) : jamais concernée", () => {
    const { sessions, changed } = appliquerTitresIA(
      [session("a", { sessionId: null })],
      new Map([["srv-a", "Déployer n8n sur OVH"]]),
    );
    expect(changed).toBe(false);
    expect(sessions[0].title).toBe("repli local a");
  });

  it("référence stable quand rien ne change : pas de re-render inutile", () => {
    const prev = [session("a")];
    const { sessions } = appliquerTitresIA(prev, new Map());
    expect(sessions).toBe(prev);
  });
});
