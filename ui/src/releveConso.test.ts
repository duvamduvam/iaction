/*
 * T-087 — ce que l'encart accepte d'appeler un relevé, et sous quel nom il
 * affiche une fenêtre.
 *
 * Le cas qui a mordu le 2026-08-21 n'est pas « pas de relevé » : c'est un
 * instantané qui se DIT disponible (`available: true`, abonnement « max »)
 * sans porter une seule fenêtre. Il passait toutes les gardes existantes,
 * écrasait le dernier relevé réel jusque dans le cache disque, et l'encart
 * retombait sur « Claude : — » — sans reprise, puisque la reprise ne s'arme
 * que sur un relevé indisponible.
 */
import { describe, expect, it } from "vitest";
import {
  AGE_SEUIL_AFFICHAGE_MS,
  cleFenetreSaturee,
  etiquetteFenetreModele,
  fenetreEncoreSaturee,
  libelleAge,
  libelleSaturation,
  releveUtilisable,
  trouverFenetreModele,
} from "./releveConso";
import type { ClaudeUsageSnapshot, ClaudeUsageWindow } from "./consoClient";

const FENETRE: ClaudeUsageWindow = { utilization: 42, resetsAt: "2026-08-21T18:40:00Z" };

function instantane(partiel: Partial<ClaudeUsageSnapshot>): ClaudeUsageSnapshot {
  return {
    available: true,
    subscriptionType: "max",
    fiveHour: null,
    sevenDay: null,
    windows: {},
    capturedAt: "2026-08-21T13:51:28.036Z",
    saturation: null,
    ...partiel,
  };
}

describe("releveUtilisable", () => {
  it("le cas du ticket : disponible, abonnement connu, aucune fenêtre → pas un relevé", () => {
    expect(releveUtilisable(instantane({}))).toBe(false);
  });

  it("une seule fenêtre suffit, quelle qu'elle soit", () => {
    expect(releveUtilisable(instantane({ fiveHour: FENETRE }))).toBe(true);
    expect(releveUtilisable(instantane({ sevenDay: FENETRE }))).toBe(true);
    expect(releveUtilisable(instantane({ windows: { Fable: FENETRE } }))).toBe(true);
  });

  it("un relevé indisponible ou absent n'en est pas un", () => {
    expect(releveUtilisable(instantane({ available: false, fiveHour: FENETRE }))).toBe(false);
    expect(releveUtilisable(null)).toBe(false);
    expect(releveUtilisable(undefined)).toBe(false);
  });
});

describe("trouverFenetreModele", () => {
  it("ignore les deux fenêtres déjà dessinées à part", () => {
    expect(trouverFenetreModele({ five_hour: FENETRE, seven_day: FENETRE })).toBeNull();
  });

  it("préfère une fenêtre qui nomme un modèle à la première venue", () => {
    const trouve = trouverFenetreModele({
      five_hour: FENETRE,
      nimbus_quill: { utilization: 0, resetsAt: "2026-08-22T18:00:00Z" },
      Fable: { utilization: 49, resetsAt: "2026-08-22T18:00:00Z" },
    });
    expect(trouve?.cle).toBe("Fable");
    expect(trouve?.fenetre.utilization).toBe(49);
  });

  it("à défaut, rend la première — avec sa clé, pour ne pas la déguiser", () => {
    const trouve = trouverFenetreModele({ nimbus_quill: FENETRE });
    expect(trouve?.cle).toBe("nimbus_quill");
  });
});

describe("etiquetteFenetreModele", () => {
  it("rend lisible une clé de l'API sans jamais inventer le modèle", () => {
    expect(etiquetteFenetreModele("seven_day_opus")).toBe("Opus");
    expect(etiquetteFenetreModele("Fable")).toBe("Fable");
    // La fenêtre relevée en réel le 2026-08-21 sur le poste : elle s'affichait
    // sous l'étiquette « Fable », écrite en dur.
    expect(etiquetteFenetreModele("nimbus_quill")).toBe("Nimbus quill");
  });
});

describe("cleFenetreSaturee — T-059", () => {
  it("une saturation 'session' désigne la fenêtre 5h", () => {
    expect(cleFenetreSaturee("session")).toBe("fiveHour");
  });
  it("une saturation 'hebdo' désigne la fenêtre 7 jours", () => {
    expect(cleFenetreSaturee("hebdo")).toBe("sevenDay");
  });
});

describe("libelleAge — T-059", () => {
  const T0 = new Date("2026-08-21T13:51:28.036Z").getTime();

  it("un relevé frais (< 5 min) ne s'affiche pas — pas d'infobulle déguisée en fait", () => {
    expect(libelleAge(new Date(T0 - AGE_SEUIL_AFFICHAGE_MS + 1000).toISOString(), T0)).toBeNull();
  });

  it("pile au seuil de 5 min, l'âge s'affiche", () => {
    expect(libelleAge(new Date(T0 - AGE_SEUIL_AFFICHAGE_MS).toISOString(), T0)).toBe("il y a 5min");
  });

  it("sous l'heure : en minutes", () => {
    expect(libelleAge(new Date(T0 - 42 * 60_000).toISOString(), T0)).toBe("il y a 42min");
  });

  it("au-delà de l'heure : en heures", () => {
    expect(libelleAge(new Date(T0 - 3 * 3_600_000).toISOString(), T0)).toBe("il y a 3h");
  });

  it("sans capturedAt, rien à afficher", () => {
    expect(libelleAge(null, T0)).toBeNull();
  });
});

describe("fenetreEncoreSaturee — T-117", () => {
  const T0 = new Date("2026-09-02T10:40:00Z").getTime();

  it("sous le seuil : jamais saturée, quelle que soit l'échéance", () => {
    expect(fenetreEncoreSaturee({ utilization: 40, resetsAt: "2026-09-02T12:40:00Z" }, T0, 98)).toBe(false);
  });

  it("au-delà du seuil, réouverture encore À VENIR : saturée", () => {
    expect(fenetreEncoreSaturee({ utilization: 100, resetsAt: "2026-09-02T12:40:00Z" }, T0, 98)).toBe(true);
  });

  it("le cas du ticket : au-delà du seuil, réouverture DÉJÀ PASSÉE : plus saturée", () => {
    // Capture du 2026-09-02 : « ⚠ Session 5h saturée — réinitialisation dans 0 »
    // alors que l'échéance de 5 h est dépassée depuis un moment.
    expect(fenetreEncoreSaturee({ utilization: 100, resetsAt: "2026-09-02T10:39:59Z" }, T0, 98)).toBe(false);
  });

  it("pile à l'échéance : plus saturée (une réouverture qui vient de sonner n'est plus à venir)", () => {
    expect(fenetreEncoreSaturee({ utilization: 100, resetsAt: "2026-09-02T10:40:00Z" }, T0, 98)).toBe(false);
  });

  it("résetsAt absente ou illisible : on s'en tient au seuil seul, jamais un « plus saturé » inventé", () => {
    expect(fenetreEncoreSaturee({ utilization: 100, resetsAt: "" }, T0, 98)).toBe(true);
    expect(fenetreEncoreSaturee({ utilization: 100, resetsAt: "pas une date" }, T0, 98)).toBe(true);
  });
});

describe("libelleSaturation — T-059", () => {
  it("une heure connue produit 'saturé, reprise à HH:MM'", () => {
    // 19:10 UTC — l'assertion porte sur la FORME, pas sur un fuseau donné.
    expect(libelleSaturation("2026-08-15T19:10:00Z")).toMatch(/^saturé, reprise à \d{2}:\d{2}$/);
  });
  it("aucune heure connue : un aveu, jamais une heure inventée", () => {
    expect(libelleSaturation(null)).toBe("saturé, reprise à heure inconnue");
  });
  it("une heure illisible est traitée comme absente", () => {
    expect(libelleSaturation("pas une date")).toBe("saturé, reprise à heure inconnue");
  });
});
