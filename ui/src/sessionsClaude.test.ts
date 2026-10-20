/*
 * T-159 — logique pure du panneau « Sessions Claude » : lecture de la réponse
 * du sidecar, libellé de projet, appariement avec un projet d'IAction, commande
 * de repli. Les chemins sont BÂTIS avec `path.*` : la CI tourne aussi sous
 * Windows, où un chemin POSIX écrit en dur n'est pas un chemin.
 */
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ProjectConfig } from "./projectAdmin";
import {
  commandeReprise,
  heureRelative,
  libelleEtat,
  libelleProjet,
  libelleType,
  lireSessions,
  projetPourCwd,
  titreSession,
} from "./sessionsClaude";

const racine = path.join(os.tmpdir(), "travail");
const dossierProjet = path.join(racine, "demo");

function projet(id: string, chemin: string): ProjectConfig {
  return { id, name: id, path: chemin };
}

describe("lireSessions", () => {
  it("lit une session complète", () => {
    const sessions = lireSessions({
      sessions: [{ pid: 473635, cwd: dossierProjet, kind: "interactive", startedAt: 1792438061712, sessionId: "a39b8619", name: "demo-38", status: "busy" }],
    });
    expect(sessions).toEqual([
      { sessionId: "a39b8619", name: "demo-38", cwd: dossierProjet, kind: "interactive", status: "busy", pid: 473635, startedAt: 1792438061712 },
    ]);
  });

  it("tolère les champs manquants et écarte les entrées sans identifiant", () => {
    const sessions = lireSessions({ sessions: [{ sessionId: "x" }, { name: "orpheline" }, null, 3] });
    expect(sessions).toEqual([{ sessionId: "x", name: null, cwd: null, kind: null, status: null, pid: null, startedAt: null }]);
  });

  it("rend une liste vide quand la réponse n'a pas de tableau", () => {
    expect(lireSessions({})).toEqual([]);
  });
});

describe("libelleProjet", () => {
  it("prend le dernier segment du dossier", () => {
    expect(libelleProjet(dossierProjet)).toBe(path.basename(dossierProjet));
  });

  it("ignore un séparateur final", () => {
    expect(libelleProjet(dossierProjet + path.sep)).toBe(path.basename(dossierProjet));
  });

  it("lit un chemin Windows comme un chemin POSIX", () => {
    const win = path.win32.join("C:\\", "Users", "moi", "demo");
    expect(libelleProjet(win)).toBe(path.win32.basename(win));
  });

  it("répond par un tiret sans dossier", () => {
    expect(libelleProjet(null)).toBe("—");
  });
});

describe("projetPourCwd", () => {
  const projets = [projet("a", path.join(racine, "autre")), projet("b", dossierProjet)];

  it("retrouve le projet dont le dossier est celui de la session", () => {
    expect(projetPourCwd(dossierProjet, projets)?.id).toBe("b");
  });

  it("tolère un séparateur final de part ou d'autre", () => {
    expect(projetPourCwd(dossierProjet + path.sep, projets)?.id).toBe("b");
    expect(projetPourCwd(dossierProjet, [projet("c", dossierProjet + path.sep)])?.id).toBe("c");
  });

  it("ne confond pas un dossier voisin ni un sous-dossier", () => {
    expect(projetPourCwd(path.join(dossierProjet, "src"), projets)).toBeNull();
    expect(projetPourCwd(dossierProjet + "-2", projets)).toBeNull();
  });

  it("ignore la casse et le sens des barres sur un disque Windows", () => {
    const win = path.win32.join("C:\\", "Users", "moi", "Demo");
    const minuscule = path.win32.join("c:\\", "users", "moi", "demo").replace(/\\/g, "/");
    expect(projetPourCwd(minuscule, [projet("w", win)])?.id).toBe("w");
  });

  it("rend null sans dossier", () => {
    expect(projetPourCwd(null, projets)).toBeNull();
  });
});

describe("commandeReprise", () => {
  it("se place dans le dossier puis reprend en copie", () => {
    expect(commandeReprise({ sessionId: "abc", cwd: dossierProjet })).toBe(
      `cd "${dossierProjet}" && claude --resume abc --fork-session`,
    );
  });

  it("se passe du cd quand le dossier est inconnu", () => {
    expect(commandeReprise({ sessionId: "abc", cwd: null })).toBe("claude --resume abc --fork-session");
  });
});

describe("libellés", () => {
  it("traduit les valeurs connues et laisse passer les autres", () => {
    expect(libelleType("interactive")).toBe("Interactive");
    expect(libelleType("inedit")).toBe("inedit");
    expect(libelleEtat("busy")).toBe("Au travail");
    expect(libelleEtat("bizarre")).toBe("bizarre");
    expect(libelleEtat(null)).toBe("—");
  });

  it("nomme une session sans nom par le début de son identifiant", () => {
    expect(titreSession({ name: null, sessionId: "a39b8619-1234" })).toBe("a39b8619");
    expect(titreSession({ name: "demo-38", sessionId: "a39b8619" })).toBe("demo-38");
  });
});

describe("heureRelative", () => {
  const maintenant = 1_800_000_000_000;
  it("choisit l'unité adaptée", () => {
    expect(heureRelative(maintenant - 5_000, maintenant)).toBe("à l'instant");
    expect(heureRelative(maintenant - 5 * 60_000, maintenant)).toBe("il y a 5 min");
    expect(heureRelative(maintenant - 3 * 3_600_000, maintenant)).toBe("il y a 3 h");
    expect(heureRelative(maintenant - 2 * 86_400_000, maintenant)).toBe("il y a 2 j");
    expect(heureRelative(null, maintenant)).toBe("—");
  });
});
