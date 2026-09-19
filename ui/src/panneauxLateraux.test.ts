/*
 * Bascule des panneaux latéraux.
 *
 * Le cas qui justifie ce fichier est celui de Ctrl+L quand UN SEUL panneau est
 * replié : un `ET` naïf ferait ouvrir le manquant, alors que la frappe demande
 * de dégager l'écran. La règle (« il en reste un ouvert → tout replier ») ne se
 * voit ni au typecheck ni à la relecture d'un `!` isolé.
 *
 * `window` n'existe pas sous vitest (environnement node) : le module doit
 * démarrer quand même, sur le défaut « visible ». C'est vérifié ici aussi —
 * une régression sur ce point ne casserait pas les tests, elle casserait
 * l'application au chargement.
 */
import { describe, expect, it } from "vitest";
import {
  basculerPanneau,
  basculerTousPanneaux,
  panneauVisible,
  reglerPanneau,
} from "./panneauxLateraux";

function poser(gauche: boolean, droit: boolean) {
  reglerPanneau("gauche", gauche);
  reglerPanneau("droit", droit);
}

describe("panneaux latéraux", () => {
  it("démarre visible sans stockage (window absent)", () => {
    expect(panneauVisible("gauche")).toBe(true);
    expect(panneauVisible("droit")).toBe(true);
  });

  it("bascule un côté sans toucher à l'autre", () => {
    poser(true, true);
    basculerPanneau("gauche");
    expect(panneauVisible("gauche")).toBe(false);
    expect(panneauVisible("droit")).toBe(true);
  });

  it("Ctrl+L replie tout quand les deux sont ouverts", () => {
    poser(true, true);
    basculerTousPanneaux();
    expect([panneauVisible("gauche"), panneauVisible("droit")]).toEqual([false, false]);
  });

  it("Ctrl+L replie tout quand UN SEUL est encore ouvert", () => {
    poser(false, true);
    basculerTousPanneaux();
    expect([panneauVisible("gauche"), panneauVisible("droit")]).toEqual([false, false]);
  });

  it("Ctrl+L rouvre tout quand les deux sont repliés", () => {
    poser(false, false);
    basculerTousPanneaux();
    expect([panneauVisible("gauche"), panneauVisible("droit")]).toEqual([true, true]);
  });
});
