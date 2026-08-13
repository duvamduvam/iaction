/*
 * Gardes R3 du routage Auto.
 *
 * Ces gardes décident où part une requête FACTURÉE. Les deux règles à ne
 * jamais perdre :
 *   - on n'envoie jamais vers un fournisseur non déclaré ;
 *   - le repli remonte la table, il ne descend jamais — on ne dégrade pas une
 *     requête en silence.
 */
import { describe, expect, it, vi } from "vitest";
import { appliquerGardesRoutage } from "./gardesRoutage";
import type { RouteTarget, RoutingTable } from "./sidecar";

const abonnement = (model: string): RouteTarget => ({ engine: "claude", model });
const neutre = (providerId: string, model = "m"): RouteTarget => ({ engine: "neutral", providerId, model });

const TABLE: RoutingTable = {
  trivial: neutre("ollama", "petit"),
  simple: neutre("inconnu-simple"),
  moyen: neutre("openrouter", "moyen"),
  complexe: abonnement("claude-sonnet-5"),
};

/** Déclarés : l'abonnement (toujours), ollama et openrouter. */
const estUtilisable = (t: RouteTarget) => t.engine === "claude" || t.providerId === "ollama" || t.providerId === "openrouter";

function deps() {
  const lireTable = vi.fn(async () => TABLE);
  return { estUtilisable, lireTable };
}

describe("appliquerGardesRoutage", () => {
  it("cas nominal : rien à garder, rien n'est touché — et la table n'est PAS lue", async () => {
    const d = deps();
    const sortie = await appliquerGardesRoutage(
      { tier: "moyen", target: neutre("openrouter"), debord: null, reasons: ["classé moyen"] },
      d,
    );
    expect(sortie).toEqual({
      tier: "moyen",
      target: neutre("openrouter"),
      debord: null,
      reasons: ["classé moyen"],
      debordUnconfigured: false,
    });
    // Un aller-retour disque par tour pour rien serait un défaut de plus.
    expect(d.lireTable).not.toHaveBeenCalled();
  });

  it("débord vers un fournisseur non déclaré : repli abonnement, débord ANNULÉ, bandeau dédié", async () => {
    const sortie = await appliquerGardesRoutage(
      {
        tier: "complexe",
        target: neutre("fournisseur-jamais-configure"),
        debord: { active: true, blocked: false, fiveHourPct: 90, sevenDayPct: null },
        reasons: [],
      },
      deps(),
    );
    expect(sortie.target).toEqual(abonnement("claude-sonnet-5")); // la table du tier
    expect(sortie.debord).toBeNull();
    expect(sortie.debordUnconfigured).toBe(true);
    expect(sortie.reasons).toContain("cible de débord non configurée : envoi sur l'abonnement");
  });

  it("un débord vers un fournisseur DÉCLARÉ passe tel quel", async () => {
    const sortie = await appliquerGardesRoutage(
      { tier: "moyen", target: neutre("openrouter"), debord: { active: true, blocked: false, fiveHourPct: 85, sevenDayPct: null }, reasons: [] },
      deps(),
    );
    expect(sortie.debord).not.toBeNull();
    expect(sortie.debordUnconfigured).toBe(false);
  });

  it("cible inutilisable : repli en REMONTANT la table, en sautant les tiers eux-mêmes inutilisables", async () => {
    // `simple` est classé, mais son fournisseur n'existe pas ; le tier
    // au-dessus (`moyen`) est utilisable : c'est lui.
    const sortie = await appliquerGardesRoutage(
      { tier: "simple", target: neutre("inconnu-simple"), debord: null, reasons: [] },
      deps(),
    );
    expect(sortie.tier).toBe("moyen");
    expect(sortie.target).toEqual(neutre("openrouter", "moyen"));
    expect(sortie.reasons).toContain("repli : fournisseur « inconnu-simple » absent");
  });

  it("le repli ne DESCEND jamais : trivial inutilisable ne retombe pas plus bas", async () => {
    const table: RoutingTable = { ...TABLE, trivial: neutre("disparu") };
    const sortie = await appliquerGardesRoutage(
      { tier: "trivial", target: neutre("disparu"), debord: null, reasons: [] },
      { estUtilisable, lireTable: async () => table },
    );
    // Le premier utilisable AU-DESSUS est moyen (simple est inutilisable).
    expect(sortie.tier).toBe("moyen");
  });

  it("aucun tier utilisable au-dessus : la cible reste, l'erreur moteur s'affichera", async () => {
    const vide: RoutingTable = {
      trivial: neutre("x1"),
      simple: neutre("x2"),
      moyen: neutre("x3"),
      complexe: neutre("x4"),
    };
    const sortie = await appliquerGardesRoutage(
      { tier: "complexe", target: neutre("x4"), debord: null, reasons: [] },
      { estUtilisable: () => false, lireTable: async () => vide },
    );
    expect(sortie.tier).toBe("complexe");
    expect(sortie.target).toEqual(neutre("x4"));
  });

  it("ne mute pas l'entrée : reasons est copié", async () => {
    const entree = { tier: "simple" as const, target: neutre("inconnu-simple"), debord: null, reasons: ["origine"] };
    await appliquerGardesRoutage(entree, deps());
    expect(entree.reasons).toEqual(["origine"]);
  });
});
