/*
 * T-076 — un event `error` de protocole avec `message: ""` traversait la
 * garde comme un vrai message (chaîne non-nullish), et l'échec devenait
 * muet malgré son étiquette d'erreur. Ce test verrouille le repli.
 */

import { describe, expect, it } from "vitest";

import { messageErreurProtocole } from "./sidecar";

describe("messageErreurProtocole", () => {
  it("garde un message non vide tel quel", () => {
    expect(messageErreurProtocole({ message: "clé API manquante" })).toBe("clé API manquante");
  });

  it("replie une chaîne vide sur le message par défaut", () => {
    expect(messageErreurProtocole({ message: "" })).toBe("Erreur inconnue");
  });

  it("replie un champ absent sur le message par défaut", () => {
    expect(messageErreurProtocole({})).toBe("Erreur inconnue");
  });

  it("replie un champ mal typé sur le message par défaut", () => {
    expect(messageErreurProtocole({ message: 42 })).toBe("Erreur inconnue");
  });
});

// T-169 — sidecar plus ancien que l'interface : l'utilisateur doit savoir quoi faire.
describe("messageErreurProtocole — méthode inconnue (T-169)", () => {
  it("reconnaît le message « méthode inconnue » sans code", () => {
    const m = messageErreurProtocole({ message: "méthode inconnue: x" });
    expect(m).toContain("méthode inconnue: x");
    expect(m).toContain("relancez IAction");
  });

  it("reconnaît le code methode_inconnue", () => {
    const m = messageErreurProtocole({ code: "methode_inconnue", message: "autre texte" });
    expect(m).toContain("autre texte");
    expect(m).toContain("relancez IAction");
  });

  it("n'ajoute rien aux autres erreurs", () => {
    expect(messageErreurProtocole({ message: "clé API manquante" })).not.toContain("relancez");
  });
});
