/*
 * La liste des modèles de l'abonnement Claude, et ce qui en dépend (T-046).
 *
 * Le défaut qu'on protège ici n'est pas « un id est faux » — c'est
 * « la liste a été mise à jour à un endroit sur trois ». `claude-opus-5`
 * manquait dans les deux sélecteurs ET dans la table des fenêtres de contexte
 * alors que le modèle était disponible depuis un moment ; l'utilisateur l'a
 * constaté avant nous, en cherchant en vain dans le sélecteur.
 */

import { describe, expect, it } from "vitest";

import { contextWindowFor } from "./contextBus";
import { IDS_ABONNEMENT_CLAUDE, MODELES_ABONNEMENT_CLAUDE } from "./modelesAbonnementClaude";

describe("modèles de l'abonnement Claude", () => {
  it("connaît l'Opus courant", () => {
    // Cet id-ci est vérifié nommément : son absence est le bug d'origine.
    expect(IDS_ABONNEMENT_CLAUDE).toContain("claude-opus-5");
  });

  it("n'a pas de doublon", () => {
    expect(new Set(IDS_ABONNEMENT_CLAUDE).size).toBe(IDS_ABONNEMENT_CLAUDE.length);
  });

  it("n'épingle jamais un suffixe de date", () => {
    // Les ids de l'API sont complets tels quels ; y accoler une date
    // (« claude-opus-5-20260101 ») donne un 404 au premier tour.
    for (const id of IDS_ABONNEMENT_CLAUDE) {
      expect(id, `${id} porte un suffixe de date`).not.toMatch(/-20\d{6}$/);
    }
  });

  it("chaque modèle a une fenêtre de contexte connue", () => {
    // LE test qui compte : la table des fenêtres vit dans un autre fichier.
    // Un modèle ajouté au sélecteur et oublié ici afficherait des tokens sans
    // pourcentage, sans que rien ne le signale.
    for (const id of IDS_ABONNEMENT_CLAUDE) {
      expect(contextWindowFor(id), `${id} sans fenêtre de contexte`).not.toBeNull();
    }
  });

  it("décrit chaque modèle pour le sélecteur", () => {
    for (const m of MODELES_ABONNEMENT_CLAUDE) {
      expect(m.note, `${m.id} sans note`).toBeTruthy();
    }
  });
});
