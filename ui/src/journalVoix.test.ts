/*
 * Vocabulaire de journalisation de la chaîne voix (T-125) : chaque fonction
 * doit produire le bon niveau, le bon canal, le bon libellé et les bons
 * champs — c'est la seule garantie que deux appelants ne nomment jamais
 * différemment le même événement (voir journalVoix.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// `vi.hoisted` : le mock est hissé au-dessus des imports (comme `vi.mock`),
// mais les espions restent des variables normales, utilisables par l'import
// STATIQUE de journalVoix.ts ci-dessous (sans lui, `logError`/`logInfo`
// seraient encore `undefined` au moment où journalVoix.ts importe "./journal").
const { logError, logInfo } = vi.hoisted(() => ({ logError: vi.fn(), logInfo: vi.fn() }));
vi.mock("./journal", () => ({ logError, logInfo }));

import {
  journalDecisionMotCleConversation,
  journalDecisionMotCleDictee,
  journalIssueEnvoiVoix,
  journalPanneDemarrageConversation,
  journalPanneDictee,
  journalPanneEnvoiVoix,
  journalPanneMicroDictee,
  journalPanneTranscriptionSegment,
  journalSegmentTranscrit,
  journalSegmentTranscritDictee,
} from "./journalVoix";

beforeEach(() => {
  logError.mockClear();
  logInfo.mockClear();
});

describe("journalSegmentTranscrit (mode conversation)", () => {
  it("journalise en `info`, sur le canal `speech`, avec texte/longueur/durée/verdict", () => {
    journalSegmentTranscrit("très prends", 11, 850, "transmis");
    expect(logInfo).toHaveBeenCalledTimes(1);
    expect(logInfo).toHaveBeenCalledWith("speech", "segment transcrit", {
      fields: { texte: "très prends", longueur: 11, dureeMs: 850, verdict: "transmis" },
    });
    expect(logError).not.toHaveBeenCalled();
  });

  it("porte le verdict `hallucination` sans devenir une erreur", () => {
    journalSegmentTranscrit("sous-titres réalisés par...", 27, 400, "hallucination");
    const [, , opts] = logInfo.mock.calls[0] as unknown as [unknown, unknown, { fields: Record<string, unknown> }];
    expect(opts.fields.verdict).toBe("hallucination");
  });
});

describe("journalSegmentTranscritDictee", () => {
  it("journalise en `info`, avec le libellé propre à la dictée ponctuelle", () => {
    journalSegmentTranscritDictee("transmets le dossier", 21, "transmis");
    expect(logInfo).toHaveBeenCalledWith("speech", "segment transcrit (dictée ponctuelle)", {
      fields: { texte: "transmets le dossier", longueur: 21, verdict: "transmis" },
    });
  });
});

describe("journalPanneTranscriptionSegment", () => {
  it("journalise en `error`, sur `speech`, avec la durée et l'erreur décrite", () => {
    journalPanneTranscriptionSegment(1200, "réseau indisponible");
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith("speech", "transcription du segment en échec", {
      fields: { dureeMs: 1200, erreur: "réseau indisponible" },
    });
    expect(logInfo).not.toHaveBeenCalled();
  });
});

describe("journalDecisionMotCleConversation", () => {
  it("journalise en `info` avec send/raison/longueurs, brouillon TOUJOURS présent", () => {
    journalDecisionMotCleConversation(true, "declenche", 8, 42);
    expect(logInfo).toHaveBeenCalledWith("speech", "décision mot-clé (mode conversation)", {
      fields: { send: true, raison: "declenche", longueurSegment: 8, longueurBrouillon: 42 },
    });
  });
});

describe("journalDecisionMotCleDictee", () => {
  it("inclut `longueurBrouillon` quand elle est fournie (send vrai)", () => {
    journalDecisionMotCleDictee(true, "declenche", 12, 30);
    expect(logInfo).toHaveBeenCalledWith("speech", "décision mot-clé (dictée ponctuelle)", {
      fields: { send: true, raison: "declenche", longueurSegment: 12, longueurBrouillon: 30 },
    });
  });

  it("omet `longueurBrouillon` quand elle n'est pas fournie (send faux)", () => {
    journalDecisionMotCleDictee(false, "aucun-mot-cle", 12);
    expect(logInfo).toHaveBeenCalledWith("speech", "décision mot-clé (dictée ponctuelle)", {
      fields: { send: false, raison: "aucun-mot-cle", longueurSegment: 12 },
    });
  });
});

describe("journalIssueEnvoiVoix", () => {
  it("inclut `longueur` pour `refuse`", () => {
    journalIssueEnvoiVoix("refuse", 57);
    expect(logInfo).toHaveBeenCalledWith("speech", "issue de l'envoi voix", {
      fields: { verdict: "refuse", longueur: 57 },
    });
  });

  it("inclut `longueur` pour `parti`", () => {
    journalIssueEnvoiVoix("parti", 57);
    expect(logInfo).toHaveBeenCalledWith("speech", "issue de l'envoi voix", {
      fields: { verdict: "parti", longueur: 57 },
    });
  });

  it("omet `longueur` pour `vide`", () => {
    journalIssueEnvoiVoix("vide");
    expect(logInfo).toHaveBeenCalledWith("speech", "issue de l'envoi voix", { fields: { verdict: "vide" } });
  });
});

describe("journalPanneEnvoiVoix", () => {
  it("journalise en `error`, avec la longueur du texte et l'erreur", () => {
    journalPanneEnvoiVoix(64, "fournisseur indisponible");
    expect(logError).toHaveBeenCalledWith("speech", "envoi voix : échec", {
      fields: { longueur: 64, erreur: "fournisseur indisponible" },
    });
  });
});

describe("journalPanneDemarrageConversation", () => {
  it("journalise en `error`, avec l'erreur seule", () => {
    journalPanneDemarrageConversation("permission refusée");
    expect(logError).toHaveBeenCalledWith("speech", "mode conversation : démarrage refusé", {
      fields: { erreur: "permission refusée" },
    });
  });
});

describe("journalPanneMicroDictee", () => {
  it("journalise en `error`, avec l'erreur seule", () => {
    journalPanneMicroDictee("périphérique déjà pris");
    expect(logError).toHaveBeenCalledWith("speech", "dictée : micro refusé", {
      fields: { erreur: "périphérique déjà pris" },
    });
  });
});

describe("journalPanneDictee", () => {
  it("journalise en `error`, avec l'erreur seule", () => {
    journalPanneDictee("service de transcription en échec");
    expect(logError).toHaveBeenCalledWith("speech", "dictée : échec", {
      fields: { erreur: "service de transcription en échec" },
    });
  });
});
