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
import { effortsPour, IDS_ABONNEMENT_CLAUDE, MODELES_ABONNEMENT_CLAUDE, NIVEAUX_EFFORT } from "./modelesAbonnementClaude";

describe("modèles de l'abonnement Claude", () => {
  it("connaît l'Opus courant", () => {
    // Cet id-ci est vérifié nommément : son absence est le bug d'origine.
    expect(IDS_ABONNEMENT_CLAUDE).toContain("claude-opus-5-5");
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

  it("déclare une fenêtre de contexte plausible pour chaque modèle", () => {
    // T-141 — la fenêtre est un champ de la liste, plus un palier en dur
    // ailleurs. On ne vérifie pas une valeur exacte (elle bougera) mais qu'elle
    // est déclarée et sensée : un zéro oublié ferait une jauge à l'infini.
    for (const m of MODELES_ABONNEMENT_CLAUDE) {
      expect(m.contexte, `${m.id} sans fenêtre`).toBeGreaterThanOrEqual(200_000);
      expect(m.contexte, `${m.id} : fenêtre invraisemblable`).toBeLessThanOrEqual(10_000_000);
    }
  });

  it("la fenêtre déclarée est bien celle que rend contextWindowFor", () => {
    // Le lien entre les deux fichiers : si contextBus cessait de dériver de la
    // liste, ce test le dirait avant l'utilisateur.
    for (const m of MODELES_ABONNEMENT_CLAUDE) {
      expect(contextWindowFor(m.id), `${m.id} : fenêtre désaccordée`).toBe(m.contexte);
    }
  });

  it("décrit chaque modèle pour le sélecteur", () => {
    for (const m of MODELES_ABONNEMENT_CLAUDE) {
      expect(m.note, `${m.id} sans note`).toBeTruthy();
    }
  });
});

describe("niveaux d'effort", () => {
  it("offre les cinq niveaux aux modèles qui raisonnent", () => {
    expect(effortsPour("claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortsPour("claude-sonnet-5-5")).toEqual(NIVEAUX_EFFORT);
  });

  it("n'en offre aucun à Haiku, aux modèles inconnus ni au moteur neutre", () => {
    expect(effortsPour("claude-haiku-4-5")).toEqual([]);
    expect(effortsPour("gpt-inconnu")).toEqual([]);
    expect(effortsPour("")).toEqual([]);
    expect(effortsPour(null)).toEqual([]);
  });
});
