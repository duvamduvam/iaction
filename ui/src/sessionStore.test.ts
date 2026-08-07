/*
 * Utilitaires d'historique de sessions (titre auto, dates relatives, plafond).
 *
 * Le titre auto et le plafond touchent directement ce que l'utilisateur voit
 * dans la colonne Sessions ; `capSessions` protège en plus la session ACTIVE
 * d'une éviction — un bug là ferait disparaître la conversation en cours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capSessions,
  deriveTitleFromText,
  formatRelativeDate,
  newSessionMeta,
  sortByRecent,
  type SessionMeta,
} from "./sessionStore";

function meta(id: string, updatedAt: string): SessionMeta {
  return { id, title: id, titleCustom: false, createdAt: updatedAt, updatedAt };
}

describe("deriveTitleFromText", () => {
  it("retire la formule d'amorce et capitalise", () => {
    expect(deriveTitleFromText("peux-tu corriger la jauge de contexte")).toBe(
      "Corriger la jauge de contexte",
    );
    expect(deriveTitleFromText("je voudrais un installeur windows")).toBe("Un installeur windows");
  });

  it("frontière de mot obligatoire : « fais » ne mord pas « faisceau »", () => {
    expect(deriveTitleFromText("faisceau lumineux du robot")).toBe("Faisceau lumineux du robot");
  });

  it("coupe à ~40 caractères sur un mot entier, sans ellipse", () => {
    const titre = deriveTitleFromText(
      "corrige le comportement de la jauge de contexte après compactage du fil",
    );
    expect(titre.length).toBeLessThanOrEqual(40);
    expect(titre.endsWith(" ")).toBe(false);
    // Pas de mot tronqué : le titre complet doit être un préfixe du texte suivi d'une frontière.
    expect("Corrige le comportement de la jauge de contexte".startsWith(titre)).toBe(true);
  });

  it("texte vide ou blanc : titre par défaut", () => {
    expect(deriveTitleFromText("")).toBe("Nouvelle session");
    expect(deriveTitleFromText("   ")).toBe("Nouvelle session");
  });

  it("texte réduit à une amorce seule : on garde le texte plutôt que rien", () => {
    expect(deriveTitleFromText("peux-tu")).toBe("Peux-tu");
  });
});

describe("formatRelativeDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("paliers : à l'instant, minutes, heures, jours, puis date absolue", () => {
    expect(formatRelativeDate("2026-08-07T11:59:40.000Z")).toBe("à l'instant");
    expect(formatRelativeDate("2026-08-07T11:45:00.000Z")).toBe("il y a 15 min");
    expect(formatRelativeDate("2026-08-07T09:00:00.000Z")).toBe("il y a 3 h");
    expect(formatRelativeDate("2026-08-04T12:00:00.000Z")).toBe("il y a 3 j");
    expect(formatRelativeDate("2026-07-20T12:00:00.000Z")).toBe(
      new Date("2026-07-20T12:00:00.000Z").toLocaleDateString("fr-FR"),
    );
  });
});

describe("sortByRecent / capSessions", () => {
  const a = meta("a", "2026-08-01T00:00:00Z");
  const b = meta("b", "2026-08-05T00:00:00Z");
  const c = meta("c", "2026-08-03T00:00:00Z");

  it("tri du plus récent au plus ancien, sans muter l'entrée", () => {
    const entree = [a, b, c];
    expect(sortByRecent(entree).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(entree.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("plafond : garde les plus récentes, ordre d'origine préservé", () => {
    expect(capSessions([a, b, c], "b", 2).map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("la session ACTIVE survit toujours, même la plus ancienne", () => {
    expect(capSessions([a, b, c], "a", 1).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("sous le plafond : aucune copie inutile", () => {
    const entree = [a, b];
    expect(capSessions(entree, "a", 10)).toBe(entree);
  });
});

describe("newSessionMeta", () => {
  it("id unique, titre par défaut, horodatages cohérents", () => {
    const s1 = newSessionMeta();
    const s2 = newSessionMeta();
    expect(s1.id).not.toBe(s2.id);
    expect(s1.title).toBe("Nouvelle session");
    expect(s1.titleCustom).toBe(false);
    expect(s1.createdAt).toBe(s1.updatedAt);
  });
});
