/*
 * Silence sur refus de saturation (T-059) — le seul volet qui reste dans
 * `cadenceUsage.ts` depuis T-086 : le bail entre fenêtres et le recul
 * exponentiel de la reprise ont migré côté sidecar
 * (`sidecar/src/cadenceSondesConso.ts`, testé dans
 * `sidecar/test/cadenceSondesConso.test.js` et
 * `sidecar/test/cadenceUsageCoalescee.test.js`), qui décide désormais SEUL
 * quand une vraie sonde a lieu. Ce qui reste ici sert un second lecteur,
 * extérieur au problème de cadence : `ui/src/reouvertureQuota.ts` (réveil
 * « au reset », T-120) — voir l'en-tête de `cadenceUsage.ts`.
 *
 * `window` n'existe pas ici (environnement node) : le module retombe sur sa
 * mémoire de repli, et c'est aussi ce que ce fichier exerce.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SILENCE_DEFAUT_MS, armerSilence, libererSilence, silenceActifJusqua } from "./cadenceUsage";

const T0 = 1_700_000_000_000;

describe("silence sur refus de saturation (T-059)", () => {
  beforeEach(() => {
    libererSilence();
  });

  it("une heure de reprise connue arme le silence jusqu'à elle", () => {
    armerSilence(new Date(T0 + 3_600_000).toISOString(), T0);
    expect(silenceActifJusqua(T0)).toBe(T0 + 3_600_000);
    // Passé l'échéance, le silence n'est plus actif.
    expect(silenceActifJusqua(T0 + 3_600_000 + 1)).toBeNull();
  });

  it("aucune heure exploitable : repli sur SILENCE_DEFAUT_MS (30 min)", () => {
    armerSilence(null, T0);
    expect(silenceActifJusqua(T0)).toBe(T0 + SILENCE_DEFAUT_MS);
  });

  it("une heure de reprise déjà passée n'ouvre pas un silence rétroactif nul", () => {
    // Un refus REÇU maintenant ne peut pas annoncer une reprise déjà passée —
    // horloges désynchronisées au pire. Le repli s'applique quand même.
    armerSilence(new Date(T0 - 1_000).toISOString(), T0);
    expect(silenceActifJusqua(T0)).toBe(T0 + SILENCE_DEFAUT_MS);
  });

  it("libererSilence lève le silence avant son échéance", () => {
    armerSilence(null, T0);
    expect(silenceActifJusqua(T0)).not.toBeNull();
    libererSilence();
    expect(silenceActifJusqua(T0)).toBeNull();
  });

  it("sans silence armé, aucune échéance", () => {
    expect(silenceActifJusqua(T0)).toBeNull();
  });
});
