/*
 * Routage Auto — les deux stratégies R7.
 *
 * Ces fonctions décident où part une requête FACTURÉE. Les cas fixent les
 * trois contrats qui coûtent s'ils glissent :
 *   - descendante : le premier tour part au SOMMET (tier imposé, jamais de
 *     classification du prompt), et l'affinité ne redescend jamais toute
 *     seule ;
 *   - montante : le plancher de session est transmis en `minTier`, jamais
 *     appliqué localement ;
 *   - dans les deux : un tour débordé/bloqué ne pose JAMAIS d'affinité
 *     (`pendingAffinity: false`), et le débord est re-vérifié à chaque tour.
 */
import { describe, expect, it } from "vitest";
import type { RouteDebord, RouteTarget, RoutingTable } from "./sidecar";
import {
  estCibleUtilisable,
  libelleDebord,
  resoudreRouteMontante,
  type DepsRoutageAuto,
  type RequeteRoutage,
} from "./routageAuto";

const abonnement: RouteTarget = { engine: "claude", model: "claude-sonnet-5" };
const local: RouteTarget = { engine: "neutral", providerId: "ollama", model: "qwen3.5" };
const payant: RouteTarget = { engine: "neutral", providerId: "openrouter", model: "deepseek" };

const TABLE: RoutingTable = {
  trivial: local,
  simple: local,
  moyen: abonnement,
  complexe: abonnement,
};

/** Deps de test : routeur scripté + journal des requêtes reçues. */
function deps(
  reponse: Partial<Awaited<ReturnType<DepsRoutageAuto["router"]>>> | Error = {},
  declares: string[] = ["ollama", "openrouter"],
) {
  const requetes: RequeteRoutage[] = [];
  const d: DepsRoutageAuto = {
    router: async (req) => {
      requetes.push(req);
      if (reponse instanceof Error) throw reponse;
      return { tier: "complexe", target: abonnement, reasons: [], debord: null, ...reponse };
    },
    estUtilisable: (t) => estCibleUtilisable(t, declares.map((id) => ({ id }))),
    lireTable: async () => TABLE,
  };
  return { d, requetes };
}

const debordActif: RouteDebord = { active: true, blocked: false, fiveHourPct: 92, sevenDayPct: null };

describe("estCibleUtilisable", () => {
  it("l'abonnement est toujours utilisable, un fournisseur seulement s'il est déclaré", () => {
    expect(estCibleUtilisable(abonnement, [])).toBe(true);
    expect(estCibleUtilisable(local, [{ id: "ollama" }])).toBe(true);
    expect(estCibleUtilisable(local, [{ id: "autre" }])).toBe(false);
  });
});

describe("libelleDebord", () => {
  it("distingue débord actif et plafond atteint", () => {
    expect(libelleDebord(debordActif)).toContain("92 %");
    expect(libelleDebord({ active: false, blocked: true, fiveHourPct: null, sevenDayPct: null })).toContain("plafond");
  });

  it("T-005 : nomme la fenêtre la PLUS saturée — 7 jours quand c'est elle qui a déclenché", () => {
    expect(libelleDebord({ active: true, blocked: false, fiveHourPct: 50, sevenDayPct: 100 })).toBe(
      "débord : fenêtre 7 jours à 100 %",
    );
    expect(libelleDebord({ active: true, blocked: false, fiveHourPct: 95, sevenDayPct: 40 })).toBe(
      "débord : fenêtre 5 h à 95 %",
    );
    // Vieux sidecar (aucun pourcentage) : jamais « à -1 % ».
    expect(libelleDebord({ active: true, blocked: false, fiveHourPct: null, sevenDayPct: null })).toBe(
      "débord : abonnement saturé",
    );
  });
});

describe("resoudreRouteMontante — le plancher du Chat", () => {
  it("premier tour : ni minTier, ni historyTurns, ni attachmentsCount", async () => {
    const { d, requetes } = deps({ tier: "trivial", target: local });
    const route = await resoudreRouteMontante(
      { texte: "salut", plancher: null, toursHistorique: 0, nbPiecesJointes: 0 },
      d,
    );
    expect(requetes).toEqual([{ text: "salut" }]);
    expect(route.tier).toBe("trivial");
    expect(route.pendingAffinity).toBe(true);
  });

  it("le plancher de session part en minTier, le contexte du tour aussi", async () => {
    const { d, requetes } = deps();
    await resoudreRouteMontante({ texte: "x", plancher: "moyen", toursHistorique: 4, nbPiecesJointes: 2 }, d);
    expect(requetes).toEqual([{ text: "x", historyTurns: 4, attachmentsCount: 2, minTier: "moyen" }]);
  });

  it("un tour débordé ne relève JAMAIS le plancher", async () => {
    const { d } = deps({ target: payant, debord: debordActif });
    const route = await resoudreRouteMontante(
      { texte: "x", plancher: "moyen", toursHistorique: 1, nbPiecesJointes: 0 },
      d,
    );
    expect(route.pendingAffinity).toBe(false);
  });

  it("gardes R3 : fournisseur non déclaré → repli au tier SUPÉRIEUR utilisable", async () => {
    const { d } = deps({ tier: "simple", target: { engine: "neutral", providerId: "fantome", model: "m" } });
    const route = await resoudreRouteMontante({ texte: "x", plancher: null, toursHistorique: 0, nbPiecesJointes: 0 }, d);
    // simple → moyen (abonnement) : on remonte, on ne dégrade jamais.
    expect(route.tier).toBe("moyen");
    expect(route.target).toEqual(abonnement);
  });
});
