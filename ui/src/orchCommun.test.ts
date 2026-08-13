/*
 * Socle commun de la page Orchestration — les fonctions pures.
 *
 * Deux contrats sensibles :
 *   - `computeDagOrder` dessine l'ordre d'exécution que l'utilisateur LIT
 *     avant de lancer un run : une profondeur fausse lui fait croire à un
 *     parallélisme qui n'existe pas — et un CYCLE ne doit jamais geler la
 *     page ;
 *   - les prévisualisations YAML sont ce que le sidecar RELIRA : un scalaire
 *     mal cité fait un manifeste invalide, ou pire, valide avec un autre sens
 *     (« true » nu devient un booléen).
 */
import { describe, expect, it } from "vitest";
import { computeDagOrder, resolveTodayTemplates, yamlBlockScalar, yamlScalar } from "./orchCommun";
import type { OrchestrationStep } from "./orchestrationClient";

const etape = (id: string, needs: string[] = []): OrchestrationStep =>
  ({ id, needs } as OrchestrationStep);

describe("computeDagOrder", () => {
  it("profondeur = plus longue chaîne de dépendances, tri par profondeur", () => {
    const ordre = computeDagOrder([etape("c", ["b"]), etape("b", ["a"]), etape("a")]);
    expect(ordre.map((o) => [o.step.id, o.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("deux racines : même profondeur, l'ordre de déclaration départage", () => {
    const ordre = computeDagOrder([etape("x"), etape("y"), etape("z", ["x", "y"])]);
    expect(ordre.map((o) => o.step.id)).toEqual(["x", "y", "z"]);
    expect(ordre[2].depth).toBe(1);
  });

  it("une dépendance vers une étape INEXISTANTE est ignorée, pas plantée", () => {
    const ordre = computeDagOrder([etape("seule", ["fantome"])]);
    expect(ordre[0].depth).toBe(0);
  });

  it("un CYCLE ne gèle jamais la page", () => {
    const ordre = computeDagOrder([etape("a", ["b"]), etape("b", ["a"])]);
    expect(ordre).toHaveLength(2); // la profondeur exacte importe peu : ça termine
  });

  it("la profondeur est le MAX des chemins, pas le premier trouvé", () => {
    // d dépend d'une racine ET d'une chaîne de 2 : profondeur 2, pas 1.
    const ordre = computeDagOrder([etape("a"), etape("b", ["a"]), etape("d", ["a", "b"])]);
    expect(ordre.find((o) => o.step.id === "d")?.depth).toBe(2);
  });
});

describe("yamlScalar — ce que le sidecar relira", () => {
  it("les identifiants simples restent nus", () => {
    expect(yamlScalar("mon-agent_2.0/x")).toBe("mon-agent_2.0/x");
  });

  it("les mots-clés YAML sont TOUJOURS cités — « true » nu deviendrait un booléen", () => {
    for (const piege of ["true", "False", "null", "~"]) {
      expect(yamlScalar(piege)).toBe(JSON.stringify(piege));
    }
  });

  it("espaces, accents ou deux-points : cité", () => {
    expect(yamlScalar("résumé du jour")).toBe('"résumé du jour"');
    expect(yamlScalar("clé: valeur")).toBe('"clé: valeur"');
  });

  it("chaîne vide : deux guillemets, pas rien", () => {
    expect(yamlScalar("")).toBe('""');
  });
});

describe("yamlBlockScalar", () => {
  it("bloc littéral indenté ligne à ligne", () => {
    expect(yamlBlockScalar("ligne 1\nligne 2", "    ")).toBe("|\n    ligne 1\n    ligne 2");
  });

  it("vide : jamais un « | » sans contenu (YAML invalide)", () => {
    expect(yamlBlockScalar("", "  ")).toBe('""');
  });
});

describe("resolveTodayTemplates", () => {
  it("remplace TOUTES les occurrences de {{today}} par la date locale", () => {
    const sortie = resolveTodayTemplates({ titre: "Rapport {{today}}", corps: "{{today}} et {{today}}" });
    expect(sortie.titre).toMatch(/^Rapport \d{4}-\d{2}-\d{2}$/);
    const [a, b] = sortie.corps.split(" et ");
    expect(a).toBe(b);
  });

  it("les entrées sans gabarit traversent intactes", () => {
    expect(resolveTodayTemplates({ x: "rien à faire" })).toEqual({ x: "rien à faire" });
  });
});
