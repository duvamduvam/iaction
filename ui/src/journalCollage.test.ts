/*
 * Vocabulaire de journalisation du collage d'image (T-048) : la ligne doit
 * porter le bon niveau, le bon canal, le bon libellé et les quatre segments
 * en champs — c'est ce qui rendra les trois causes possibles (négociation du
 * presse-papier, encodage PNG, encodage base64) diagnosticables au prochain
 * collage réel (voir journalCollage.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` : voir journalVoix.test.ts, même raison (l'import STATIQUE de
// journalCollage.ts a besoin de `logInfo` déjà défini).
const { logInfo } = vi.hoisted(() => ({ logInfo: vi.fn() }));
vi.mock("./journal", () => ({ logInfo }));

import { journalCollageImage } from "./journalCollage";

beforeEach(() => {
  logInfo.mockClear();
});

describe("journalCollageImage", () => {
  it("journalise en `info`, sur le canal `ui`, avec les quatre segments en champs", () => {
    journalCollageImage({
      peintureMs: 12,
      invokeMs: 4830,
      octets: 2_097_152,
      largeur: 1920,
      hauteur: 1080,
      base64Ms: 340,
    });
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith("ui", "collage : image du presse-papier (repli natif)", {
      fields: {
        peintureMs: 12,
        invokeMs: 4830,
        octets: 2_097_152,
        largeur: 1920,
        hauteur: 1080,
        base64Ms: 340,
      },
    });
  });

  it("transmet `largeur`/`hauteur` à `null` quand l'en-tête PNG est illisible", () => {
    journalCollageImage({
      peintureMs: 8,
      invokeMs: 120,
      octets: 40,
      largeur: null,
      hauteur: null,
      base64Ms: 5,
    });
    const [, , opts] = logInfo.mock.calls[0] as unknown as [unknown, unknown, { fields: Record<string, unknown> }];
    expect(opts.fields.largeur).toBeNull();
    expect(opts.fields.hauteur).toBeNull();
  });
});
