/*
 * Quand l'avis « aucune donnée reçue du fournisseur » a-t-il le droit de
 * s'afficher ? (T-006, corrigé par T-027)
 *
 * Le défaut du 2026-08-10 : l'avis apparaissait à CHAQUE réponse d'un fil où
 * le fournisseur répondait parfaitement. Un avertissement qui se déclenche en
 * fonctionnement normal n'avertit plus de rien — on apprend à ne plus le lire,
 * et il ne sert pas le jour où le tour est vraiment mort.
 *
 * On verrouille donc les deux propriétés qui le rendent crédible : il ne parle
 * que du DÉMARRAGE d'un tour, et son seuil reste franchement au-dessus de la
 * latence normale comme franchement en dessous du plafond du sidecar.
 */

import { describe, expect, it } from "vitest";
import {
  ATTENTE_FOURNISSEUR_MS,
  MESSAGE_ATTENTE_FOURNISSEUR,
  enAttenteDuPremierOctet,
} from "./useAttenteFournisseur";

const bulle = (p: Partial<Parameters<typeof enAttenteDuPremierOctet>[0]>) =>
  enAttenteDuPremierOctet({ role: "assistant", status: "streaming", vide: true, ...p });

describe("enAttenteDuPremierOctet", () => {
  it("avertit sur une bulle assistant qui démarre et n'a rien reçu", () => {
    expect(bulle({})).toBe(true);
  });

  it("se tait dès qu'un contenu est arrivé — le fournisseur répond", () => {
    expect(bulle({ vide: false })).toBe(false);
  });

  it("se tait sur un tour terminé, en erreur ou interrompu", () => {
    for (const status of ["done", "error", "aborted"]) {
      expect(bulle({ status })).toBe(false);
    }
  });

  it("se tait sur une bulle utilisateur", () => {
    expect(bulle({ role: "user" })).toBe(false);
  });

  /*
   * Le cœur de T-027 : message glissé dans un tour déjà en cours (S3,
   * `claude.push`). La bulle ouverte est vide par construction jusqu'au
   * prochain outil du modèle — parfois plusieurs minutes — alors que le
   * fournisseur a déjà répondu plus haut dans le MÊME tour.
   */
  it("se tait sur une bulle qui poursuit un tour déjà vivant", () => {
    expect(bulle({ suiteDeTour: true })).toBe(false);
    // …et reste muette même vide et en streaming, c'est tout l'intérêt.
    expect(bulle({ suiteDeTour: true, vide: true, status: "streaming" })).toBe(false);
  });
});

describe("seuil d'attente", () => {
  /*
   * Encadrement, et non valeur exacte : ce qui compte n'est pas « 45 s » mais
   * l'ordre de grandeur. Trop bas, l'avis se déclenche sur un gros contexte
   * (le défaut corrigé) ; au-delà du plafond de silence du sidecar (120 s,
   * SILENCE_DEMARRAGE_TIMEOUT_MS), il ne servirait plus à rien puisque le tour
   * serait déjà déclaré en échec avant qu'il ne s'affiche.
   */
  it("laisse passer la latence normale d'un gros contexte, sans dépasser le plafond du sidecar", () => {
    expect(ATTENTE_FOURNISSEUR_MS).toBeGreaterThanOrEqual(30_000);
    expect(ATTENTE_FOURNISSEUR_MS).toBeLessThan(120_000);
  });

  it("annonce le délai réellement attendu, pas un délai recopié", () => {
    expect(MESSAGE_ATTENTE_FOURNISSEUR).toContain(`${Math.round(ATTENTE_FOURNISSEUR_MS / 1000)} s`);
  });
});
