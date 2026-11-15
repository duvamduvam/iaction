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
  buildPersistedSession,
  candidatTitre,
  dedupeTurnIds,
  freshSession,
  MAX_PERSISTED_TURNS,
  sanitizePersistedConversations,
  sessionStateFromPersisted,
  surMoteurClaude,
  titreSession,
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

describe("titreSession — règle unique du titre affiché (T-197)", () => {
  it("prend le premier tour utilisateur, pas le premier tour tout court", () => {
    const turns = [tour("a-1", { role: "assistant", content: "Bonjour !" }), tour("u-2", { content: "Répare la CI" })];
    expect(titreSession({ title: "", titleCustom: false }, turns)).toContain("Répare");
  });

  it("sans tour utilisateur : titre par défaut, jamais une chaîne vide", () => {
    expect(titreSession({ title: "", titleCustom: false }, []).length).toBeGreaterThan(0);
  });

  it("le titre IA prime sur le repli, le renommage prime sur tout", () => {
    const turns = [tour("u-1", { content: "Donne les aticté" })];
    expect(titreSession({ title: "x", titleCustom: false, titreIA: "Activités du week-end" }, turns)).toBe("Activités du week-end");
    expect(titreSession({ title: "Mon titre", titleCustom: true, titreIA: "Activités du week-end" }, turns)).toBe("Mon titre");
  });

  it("le titre est lu sur le texte VU : displayContent, jamais le bloc de connaissances", () => {
    const turns = [tour("u-1", { content: "[Connaissances] blabla\n\nQuestion", displayContent: "Question réelle" })];
    expect(titreSession({ title: "", titleCustom: false }, turns)).toBe("Question réelle");
  });
});

const reponseTexte = (texte: string): AgentTurn => ({
  id: "a-1",
  role: "assistant",
  status: "done",
  blocks: [{ type: "text", content: texte }] as unknown as AgentTurn["blocks"],
});

describe("titreIA — T-197, survit à la sauvegarde et au rechargement", () => {
  const tours = [tour("u-1", { content: "Donne les aticté" }), reponseTexte("Voici")];

  it("buildPersistedSession conserve titreIA et affiche ce titre, pas le repli", () => {
    const persistee = buildPersistedSession(session("a", { turns: tours, titreIA: "Activités du week-end" }));
    expect(persistee.titreIA).toBe("Activités du week-end");
    expect(persistee.title).toBe("Activités du week-end");
  });

  it("aller-retour disque : le titre IA est relu", () => {
    const brut = JSON.parse(JSON.stringify(buildPersistedSession(session("a", { turns: tours, titreIA: "Activités du week-end" }))));
    expect(sessionStateFromPersisted(brut).titreIA).toBe("Activités du week-end");
  });

  it("une session sans le champ (antérieure) est acceptée et n'en reçoit pas", () => {
    const brut = JSON.parse(JSON.stringify(buildPersistedSession(session("a", { turns: tours }))));
    expect("titreIA" in brut).toBe(false);
    const entree = { sessions: [brut], activeId: "a", openConversationIds: ["a"], openFilePaths: [], activeTab: "conv:a" };
    const propre = sanitizePersistedConversations({ "/p": entree });
    expect(propre["/p"].sessions).toHaveLength(1);
    expect(sessionStateFromPersisted(propre["/p"].sessions[0]).titreIA).toBeUndefined();
  });

  it("un titreIA illisible est ignoré sans invalider la session", () => {
    const brut = { ...JSON.parse(JSON.stringify(buildPersistedSession(session("a", { turns: tours })))), titreIA: 42 };
    expect(sessionStateFromPersisted(brut).titreIA).toBeUndefined();
  });

  it("la synchronisation d'un tour (copie + recalcul) garde titreIA", () => {
    const fusion = { ...session("a", { turns: [], titreIA: "Activités du week-end" }), turns: tours };
    const apres = { ...fusion, title: titreSession(fusion, fusion.turns) };
    expect(apres.titreIA).toBe("Activités du week-end");
    expect(apres.title).toBe("Activités du week-end");
  });
});

describe("candidatTitre / surMoteurClaude — T-197", () => {
  const echange = [tour("u-1", { content: "[Connaissances]…", displayContent: "Chansons faciles ?" }), reponseTexte("Voici")];

  it("le message envoyé au titre est celui que l'utilisateur a vu", () => {
    const c = candidatTitre(session("a", { turns: echange }));
    expect(c.echange).toEqual({ message: "Chansons faciles ?", reponse: "Voici" });
    expect(c.moteurClaude).toBe(true);
  });

  it("moteur neutre ou cible de routage neutre : pas Claude", () => {
    expect(surMoteurClaude({ engine: { providerId: "ollama", model: "m" } })).toBe(false);
    expect(surMoteurClaude({ engine: { providerId: null, model: "" }, routedTarget: { engine: "neutral", model: "m" } })).toBe(false);
  });

  it("réponse non terminée : pas d'échange", () => {
    const enCours = [echange[0], { ...echange[1], status: "streaming" as const }];
    expect(candidatTitre(session("a", { turns: enCours })).echange).toBeNull();
  });
});
