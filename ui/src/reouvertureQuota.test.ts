/*
 * Réouverture de la fenêtre de quota (T-120) — le défaut du 2026-09-04 :
 * l'en-tête affichait « ⚠ Session 5h saturée — réinitialisation dans 2h » et
 * le réveil prétendait au même instant qu'aucune saturation n'était connue,
 * parce qu'il lisait le silence de la sonde (armé au seul REFUS) au lieu du
 * relevé chiffré. Les cas ci-dessous verrouillent la bonne source.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { armerSilence, libererSilence } from "./cadenceUsage";
import { instantReouvertureQuota, memoriserReouverture, oublierReouverture } from "./reouvertureQuota";

const MAINTENANT = new Date(2026, 8, 4, 12, 0, 0, 0).getTime();

describe("instantReouvertureQuota", () => {
  beforeEach(() => {
    oublierReouverture();
    libererSilence();
  });

  it("rien de connu ⇒ null (et surtout pas une date inventée)", () => {
    expect(instantReouvertureQuota(MAINTENANT)).toBeNull();
  });

  it("relevé chiffré mémorisé ⇒ c'est lui qui répond, saturé ou non", () => {
    const reset = MAINTENANT + 2 * 3_600_000;
    memoriserReouverture(new Date(reset).toISOString());
    expect(instantReouvertureQuota(MAINTENANT)).toBe(reset);
  });

  it("le cas de la capture : une réouverture connue AVANT tout refus suffit à armer", () => {
    // C'est très exactement ce qui manquait : aucun refus n'a eu lieu (le
    // silence est vide), et pourtant l'app sait quand la fenêtre se rouvre.
    memoriserReouverture(new Date(MAINTENANT + 2 * 3_600_000).toISOString());
    expect(instantReouvertureQuota(MAINTENANT)).not.toBeNull();
  });

  it("repère PÉRIMÉ ⇒ écarté : la fenêtre s'est rouverte, il n'y a plus rien à attendre", () => {
    memoriserReouverture(new Date(MAINTENANT - 60_000).toISOString());
    expect(instantReouvertureQuota(MAINTENANT)).toBeNull();
  });

  it("aucun relevé mais un refus en cours ⇒ repli sur le silence (T-059)", () => {
    const reset = MAINTENANT + 30 * 60_000;
    armerSilence(new Date(reset).toISOString(), MAINTENANT);
    expect(instantReouvertureQuota(MAINTENANT)).toBe(reset);
  });

  it("relevé périmé ET refus en cours ⇒ le refus l'emporte, il est plus frais", () => {
    memoriserReouverture(new Date(MAINTENANT - 60_000).toISOString());
    const reset = MAINTENANT + 30 * 60_000;
    armerSilence(new Date(reset).toISOString(), MAINTENANT);
    expect(instantReouvertureQuota(MAINTENANT)).toBe(reset);
  });
});

describe("memoriserReouverture", () => {
  beforeEach(() => {
    oublierReouverture();
    libererSilence();
  });

  it("valeur absente ou illisible ⇒ n'efface PAS ce qui était connu", () => {
    const reset = MAINTENANT + 3_600_000;
    memoriserReouverture(new Date(reset).toISOString());
    memoriserReouverture(null);
    memoriserReouverture(undefined);
    memoriserReouverture("pas une date");
    expect(instantReouvertureQuota(MAINTENANT)).toBe(reset);
  });

  it("un relevé plus récent remplace le précédent", () => {
    memoriserReouverture(new Date(MAINTENANT + 3_600_000).toISOString());
    const suivant = MAINTENANT + 5 * 3_600_000;
    memoriserReouverture(new Date(suivant).toISOString());
    expect(instantReouvertureQuota(MAINTENANT)).toBe(suivant);
  });
});

/*
 * Deux comptes Claude (docs/spec-deux-comptes.md) : le repère de réouverture est
 * tenu PAR compte — le réveil « au reset » d'une session Teams ne doit pas viser
 * l'heure de réouverture du compte personnel.
 */
describe("réouverture par compte", () => {
  const demain = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

  it("chaque compte garde son repère", () => {
    oublierReouverture();
    memoriserReouverture(demain(2), "perso");
    memoriserReouverture(demain(5), "teams");
    const now = Date.now();
    const perso = instantReouvertureQuota(now, "perso");
    const teams = instantReouvertureQuota(now, "teams");
    expect(perso).not.toBeNull();
    expect(teams).not.toBeNull();
    expect((teams as number) - (perso as number)).toBeGreaterThan(2.9 * 3600_000);
  });

  it("sans compte précisé, c'est perso (comportement d'avant)", () => {
    oublierReouverture();
    memoriserReouverture(demain(2));
    expect(instantReouvertureQuota(Date.now())).toBe(instantReouvertureQuota(Date.now(), "perso"));
    expect(instantReouvertureQuota(Date.now(), "teams")).toBeNull();
  });
});
