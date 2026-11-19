import { describe, expect, it } from "vitest";
import { avertissementSansFenetre, classeProposee, libelleCompte, nomSecretPourEnv, texteTachesSansSecrets } from "./coffreGestion";

describe("coffreGestion — règles pures", () => {
  it("propose sans fenêtre pour un secret MCP qu'une tâche référence, coffre sinon", () => {
    expect(classeProposee("mcp:relais.jeton", ["relais.jeton"])).toBe("sans-fenetre");
    expect(classeProposee("mcp:autre", ["relais.jeton"])).toBe("coffre");
    // Les tâches de fond lisent leurs fournisseurs ailleurs : jamais sans fenêtre par défaut.
    expect(classeProposee("provider:relais.jeton", ["relais.jeton"])).toBe("coffre");
  });

  it("nomme les comptes lisiblement", () => {
    expect(libelleCompte("provider:openrouter")).toBe("Fournisseur openrouter");
    expect(libelleCompte("speech:stt")).toBe("Voix (dictée)");
    expect(libelleCompte("mcp:relais.jeton")).toBe("MCP ${SECRET:relais.jeton}");
    expect(libelleCompte("inconnu")).toBe("inconnu");
  });

  it("propose un nom de secret valide pour une variable de .env", () => {
    expect(nomSecretPourEnv("/srv/projets/mon projet", "API_KEY")).toBe("mon-projet.API_KEY");
    expect(nomSecretPourEnv("C:\\dev\\outil\\", "TOKEN")).toBe("outil.TOKEN");
  });

  it("avertit du domaine Windows, et par prudence quand il est indéterminé", () => {
    expect(avertissementSansFenetre(false, false)).not.toMatch(/domaine/);
    expect(avertissementSansFenetre(true, true)).toMatch(/déchiffrable par les administrateurs du domaine/);
    expect(avertissementSansFenetre(null, true)).toMatch(/Impossible de savoir/);
    expect(avertissementSansFenetre(null, false)).not.toMatch(/domaine/);
  });
});

describe("texteTachesSansSecrets", () => {
  it("se tait quand aucune tâche ne manque de secret", () => {
    expect(texteTachesSansSecrets([])).toBe("");
  });
  it("nomme chaque tâche et ses secrets, et dit quoi faire", () => {
    const t = texteTachesSansSecrets([{ tache: "matin", noms: ["relais.jeton", "imap.password"] }]);
    expect(t).toContain("matin (relais.jeton, imap.password)");
    expect(t).toContain("sans fenêtre");
  });
});
