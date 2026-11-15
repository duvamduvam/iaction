/*
 * Menu « / » du composeur de la page Projets : détection du token, filtrage,
 * transitions d'état et insertion (sorties d'AgentPage.tsx, T-209).
 */
import { describe, expect, it } from "vitest";
import type { SlashCommandInfo } from "./commandesSlash";
import { detectSlashToken, insererCommandeSlash, matchSlashCommands, menuApresFrappe, menuFerme, type EtatMenuSlash } from "./menuSlash";

const cmd = (name: string, aliases?: string[]): SlashCommandInfo => ({ name, description: "", argumentHint: "", ...(aliases ? { aliases } : {}) });
const ferme: EtatMenuSlash = { open: false, fragment: "", start: 0, selected: 0 };

describe("detectSlashToken", () => {
  it("détecte un token qui démarre la ligne", () => {
    expect(detectSlashToken("/com", 4)).toEqual({ start: 0, fragment: "com" });
    expect(detectSlashToken("bonjour\n/co", 11)).toEqual({ start: 8, fragment: "co" });
  });

  it("ignore un « / » en milieu de mot ou suivi d'arguments", () => {
    expect(detectSlashToken("et/ou", 5)).toBeNull();
    expect(detectSlashToken("/compact abc", 12)).toBeNull();
    expect(detectSlashToken("texte", 5)).toBeNull();
  });
});

describe("matchSlashCommands", () => {
  const liste = [cmd("review"), cmd("compact", ["c"]), cmd("recompact")];

  it("préfixe d'abord, sous-chaîne ensuite, alias compris, sans casse", () => {
    expect(matchSlashCommands(liste, "COM").map((c) => c.name)).toEqual(["compact", "recompact"]);
    // « c » : préfixe de compact (nom et alias), sous-chaîne de recompact, absent de review.
    expect(matchSlashCommands(liste, "c").map((c) => c.name)).toEqual(["compact", "recompact"]);
  });

  it("fragment vide : tout matche", () => {
    expect(matchSlashCommands(liste, "")).toHaveLength(3);
  });
});

describe("menuFerme / menuApresFrappe", () => {
  it("menuFerme rend le même objet s'il est déjà fermé", () => {
    expect(menuFerme(ferme)).toBe(ferme);
    expect(menuFerme({ ...ferme, open: true }).open).toBe(false);
  });

  it("s'ouvre sur un token qui a des correspondances", () => {
    const m = menuApresFrappe(ferme, [cmd("compact")], "/co", 3);
    expect(m).toEqual({ open: true, fragment: "co", start: 0, selected: 0 });
  });

  it("se ferme sans token, sans commande ou sans correspondance", () => {
    const ouvert = { ...ferme, open: true };
    expect(menuApresFrappe(ouvert, [cmd("compact")], "salut", 5).open).toBe(false);
    expect(menuApresFrappe(ouvert, [], "/co", 3).open).toBe(false);
    expect(menuApresFrappe(ouvert, [cmd("compact")], "/zzz", 4).open).toBe(false);
  });
});

describe("insererCommandeSlash", () => {
  it("remplace le fragment et place le curseur après l'espace", () => {
    expect(insererCommandeSlash("/co suite", { start: 0, fragment: "co" }, cmd("compact"))).toEqual({
      texte: "/compact  suite",
      curseur: 9,
    });
  });
});
