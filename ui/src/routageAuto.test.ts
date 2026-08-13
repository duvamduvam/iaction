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
  resoudreRouteDescendante,
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

describe("resoudreRouteDescendante — premier tour (sans affinité)", () => {
  it("part au SOMMET : tier « complexe » IMPOSÉ, jamais de classification", async () => {
    const { d, requetes } = deps();
    const route = await resoudreRouteDescendante(null, "petit prompt anodin", "/proj", d);
    expect(requetes).toEqual([{ text: "petit prompt anodin", tier: "complexe", cwd: "/proj" }]);
    expect(route.target).toEqual(abonnement);
    expect(route.pendingAffinity).toBe(true);
  });

  it("cwd vide : pas de clé cwd envoyée (pas de surcharge projet)", async () => {
    const { d, requetes } = deps();
    await resoudreRouteDescendante(null, "x", "", d);
    expect(requetes[0]).not.toHaveProperty("cwd");
  });

  it("la raison protocolaire « tier imposé » est remplacée par la stratégie", async () => {
    const { d } = deps({ reasons: ["tier imposé par l'appelant", "autre raison"] });
    const route = await resoudreRouteDescendante(null, "x", "", d);
    expect(route.reasons[0]).toContain("stratégie descendante");
    expect(route.reasons).toContain("autre raison");
    expect(route.reasons).not.toContain("tier imposé par l'appelant");
  });

  it("un premier tour DÉBORDÉ ne pose pas d'affinité", async () => {
    const { d } = deps({ target: payant, debord: debordActif });
    const route = await resoudreRouteDescendante(null, "x", "", d);
    expect(route.pendingAffinity).toBe(false);
    expect(route.target).toEqual(payant);
  });

  it("gardes R3 : cible non déclarée → repli en REMONTANT la table", async () => {
    const { d } = deps({ tier: "complexe", target: { engine: "neutral", providerId: "fantome", model: "m" } });
    // Rien au-dessus de complexe : la cible d'origine est gardée (l'erreur
    // moteur habituelle s'affichera) — surtout pas de descente silencieuse.
    const route = await resoudreRouteDescendante(null, "x", "", d);
    expect(route.target.providerId).toBe("fantome");
  });
});

describe("resoudreRouteDescendante — affinité de session", () => {
  const affinite = { tier: "complexe" as const, target: abonnement, reasons: ["mémorisée"] };

  it("cible abonnement : le débord est re-vérifié à CHAQUE tour, tier imposé", async () => {
    const { d, requetes } = deps({ target: payant, debord: debordActif });
    const route = await resoudreRouteDescendante(affinite, "suite", "/proj", d);
    expect(requetes).toEqual([{ text: "suite", tier: "complexe", cwd: "/proj" }]);
    expect(route.target).toEqual(payant);
    expect(route.reasons).toEqual(["mémorisée", libelleDebord(debordActif)]);
    expect(route.pendingAffinity).toBe(false); // déjà posée, et tour débordé
  });

  it("cible de débord NON déclarée : le tour reste sur l'abonnement, bandeau dédié", async () => {
    const { d } = deps({ target: { engine: "neutral", providerId: "fantome", model: "m" }, debord: debordActif });
    const route = await resoudreRouteDescendante(affinite, "x", "", d);
    expect(route.target).toEqual(abonnement);
    expect(route.debord).toBeNull();
    expect(route.debordUnconfigured).toBe(true);
  });

  it("routeur injoignable : l'affinité vaut telle quelle, jamais d'erreur", async () => {
    const { d } = deps(new Error("sidecar down"));
    const route = await resoudreRouteDescendante(affinite, "x", "", d);
    expect(route.tier).toBe("complexe");
    expect(route.target).toEqual(abonnement);
    expect(route.reasons).toEqual(["mémorisée"]);
  });

  it("cible NEUTRE mémorisée : aucun appel routeur (pas de débord à vérifier)", async () => {
    const { d, requetes } = deps();
    const route = await resoudreRouteDescendante({ tier: "simple", target: local }, "x", "", d);
    expect(requetes).toEqual([]);
    expect(route.target).toEqual(local);
    // Session d'avant R6 sans raisons mémorisées : libellé de repli.
    expect(route.reasons[0]).toContain("affinité de session");
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
