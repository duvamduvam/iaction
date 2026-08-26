/*
 * « La table des fournisseurs a-t-elle atteint le sidecar ? » (T-008)
 *
 * Le défaut n'était pas une erreur de code mais une COURSE : l'encart d'usage
 * demandait `usage.openrouter` dans les secondes suivant le lancement, avant
 * que la table n'ait été poussée, et le sidecar répondait « fournisseur
 * inconnu ». Transitoire, auto-réparé — et journalisé en `error` à chaque
 * démarrage, ce qui use la seule chose qu'on possède contre les vraies pannes :
 * la crédibilité du journal.
 *
 * Un abonnement seul ne suffisait pas à corriger ça : il n'apprend rien du
 * passé. Qui se branche après la poussée n'en verra jamais l'écho, et resterait
 * à attendre un signal déjà passé. D'où la mémoire testée ici.
 */

import { describe, expect, it } from "vitest";

import {
  cleConfigureePour,
  notifyProvidersPushed,
  providersDejaPousses,
  subscribeProvidersPushed,
} from "./providersBus";

describe("mémoire de la poussée", () => {
  it("commence par ignorer que quoi que ce soit ait été poussé", () => {
    // Premier test du fichier : l'état module est encore vierge, comme au
    // démarrage de l'application.
    expect(providersDejaPousses()).toBe(false);
  });

  it("se souvient après la première poussée", () => {
    notifyProvidersPushed();
    expect(providersDejaPousses()).toBe(true);
  });

  it("reste vrai ensuite — la table ne se « dé-pousse » pas", () => {
    notifyProvidersPushed();
    expect(providersDejaPousses()).toBe(true);
  });
});

describe("abonnement", () => {
  it("prévient les abonnés à chaque poussée, et les désabonnés jamais", () => {
    let vues = 0;
    const off = subscribeProvidersPushed(() => {
      vues += 1;
    });
    notifyProvidersPushed();
    notifyProvidersPushed();
    expect(vues).toBe(2);

    off();
    notifyProvidersPushed();
    expect(vues, "un abonné retiré ne doit plus rien recevoir").toBe(2);
  });

  it("un abonné tardif ne reçoit pas l'écho du passé — c'est à quoi sert la mémoire", () => {
    let vues = 0;
    const off = subscribeProvidersPushed(() => {
      vues += 1;
    });
    // Rien n'a été poussé DEPUIS l'abonnement : le compteur reste à zéro,
    // alors que la table, elle, est bien poussée. Un consommateur qui n'aurait
    // que ce signal attendrait indéfiniment ; c'est pourquoi il doit d'abord
    // interroger `providersDejaPousses()`.
    expect(vues).toBe(0);
    expect(providersDejaPousses()).toBe(true);
    off();
  });
});

/*
 * Statut « clé enregistrée » (T-055).
 *
 * Sans clé OpenRouter, l'encart de conso réclamait le crédit toutes les quinze
 * secondes et le sidecar refusait — une ligne `error` par refus, indéfiniment,
 * pour une configuration volontaire. Le bus transporte donc le statut que
 * `pushProviders` connaît déjà, pour qu'on cesse d'interroger qui va refuser.
 *
 * Ces tests s'exécutent APRÈS ceux du dessus : l'état module n'est plus vierge,
 * chacun pose donc le statut qu'il vérifie.
 */
describe("statut « clé enregistrée »", () => {
  it("rend le statut poussé, fournisseur par fournisseur", () => {
    notifyProvidersPushed({ openrouter: true, swiftask: false });
    expect(cleConfigureePour("openrouter")).toBe(true);
    expect(cleConfigureePour("swiftask")).toBe(false);
  });

  it("rend false pour un fournisseur inconnu de la dernière poussée", () => {
    notifyProvidersPushed({ openrouter: true });
    expect(cleConfigureePour("jamais-vu")).toBe(false);
  });

  it("REMPLACE le statut précédent : une clé effacée redevient absente", () => {
    // Le vrai scénario du ticket, à l'envers : la table est re-poussée après
    // chaque modification. Un statut qui ne ferait que s'accumuler laisserait
    // l'encart interroger un fournisseur dont la clé vient d'être supprimée.
    notifyProvidersPushed({ openrouter: true });
    notifyProvidersPushed({ openrouter: false });
    expect(cleConfigureePour("openrouter")).toBe(false);
  });

  it("sans argument, ne prétend aucune clé — l'appelant doit passer le statut", () => {
    notifyProvidersPushed({ openrouter: true });
    notifyProvidersPushed();
    expect(cleConfigureePour("openrouter")).toBe(false);
    // La mémoire de la poussée, elle, reste acquise : les deux informations
    // sont distinctes (« su » n'est pas « configuré »).
    expect(providersDejaPousses()).toBe(true);
  });
});
