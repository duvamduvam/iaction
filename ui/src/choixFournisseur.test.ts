/*
 * Repli et rétablissement du fournisseur du Chat (T-018).
 *
 * Le cas qui justifie ce fichier tient en une séquence : l'utilisateur choisit
 * « openrouter », le sidecar redémarre (la liste des fournisseurs est
 * momentanément vide), la liste revient. Avant correction, le fournisseur
 * tombait sur « Claude (abonnement) » pendant le trou et y restait pour
 * toujours. Le dernier test rejoue exactement ça.
 */
import { describe, expect, it } from "vitest";
import { resoudreFournisseur } from "./choixFournisseur";

const CLAUDE = "claude-abonnement";
const TOUS = ["openrouter", "gemini", CLAUDE];

describe("resoudreFournisseur", () => {
  it("ne change RIEN quand la liste est vide — le cas T-018", () => {
    // Liste vide = fournisseurs pas encore chargés (démarrage, redémarrage du
    // sidecar), pas « plus aucun fournisseur ».
    expect(resoudreFournisseur({ choisi: "openrouter", courant: "openrouter", disponibles: [] })).toBeNull();
    expect(resoudreFournisseur({ choisi: "", courant: "", disponibles: [] })).toBeNull();
  });

  it("rétablit le fournisseur choisi dès qu'il réapparaît", () => {
    expect(resoudreFournisseur({ choisi: "openrouter", courant: CLAUDE, disponibles: TOUS })).toBe("openrouter");
  });

  it("replie sur le premier quand le fournisseur courant a vraiment disparu", () => {
    // Fournisseur supprimé dans la page « Fournisseurs » : là, la liste non
    // vide fait bien autorité.
    expect(resoudreFournisseur({ choisi: "supprime", courant: "supprime", disponibles: TOUS })).toBe("openrouter");
  });

  it("ne change rien quand l'état est déjà cohérent", () => {
    expect(resoudreFournisseur({ choisi: "gemini", courant: "gemini", disponibles: TOUS })).toBeNull();
    expect(resoudreFournisseur({ choisi: "", courant: CLAUDE, disponibles: TOUS })).toBeNull();
  });

  it("laisse le repli en place tant que le choix n'est pas revenu", () => {
    // Le choix explicite ne ressuscite pas un fournisseur absent de la liste.
    expect(resoudreFournisseur({ choisi: "openrouter", courant: CLAUDE, disponibles: [CLAUDE] })).toBeNull();
  });

  it("séquence complète : choix, redémarrage du sidecar, retour de la liste", () => {
    let courant = "openrouter";
    const choisi = "openrouter";

    // 1. La liste se vide (le sidecar redémarre) : on ne bouge pas.
    const pendantLeTrou = resoudreFournisseur({ choisi, courant, disponibles: [] });
    expect(pendantLeTrou).toBeNull();
    courant = pendantLeTrou ?? courant;
    expect(courant).toBe("openrouter");

    // 2. Même si un repli avait eu lieu (ancien comportement), le retour de la
    //    liste ramène l'utilisateur sur SON fournisseur.
    courant = CLAUDE;
    const apres = resoudreFournisseur({ choisi, courant, disponibles: TOUS });
    expect(apres).toBe("openrouter");
    courant = apres ?? courant;

    // 3. Et ça se stabilise : plus rien à changer au tour suivant.
    expect(resoudreFournisseur({ choisi, courant, disponibles: TOUS })).toBeNull();
  });
});
