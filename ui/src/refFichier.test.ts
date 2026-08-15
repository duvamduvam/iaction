/*
 * Références de fichiers citées dans une transcription (T-024, T-049).
 *
 * Le défaut d'origine n'est pas « une branche manque » : c'est que le rendu
 * promettait une ouverture que le clic ne savait pas honorer. Les tests
 * portent donc d'abord sur l'ACCORD entre les deux — ce qui est cliquable doit
 * se classer en quelque chose d'ouvrable, et réciproquement.
 */

import { describe, expect, it } from "vitest";

import {
  appPour,
  classerReference,
  estReferenceCliquable,
  nomDepuisUrl,
  ouvrirReference,
  type ContexteOuverture,
} from "./refFichier";
import type { AppEntry } from "./appsAdmin";

const CWD = "/home/moi/projets/demo";

describe("classement d'une référence", () => {
  it("reconnaît un absolu du projet", () => {
    expect(classerReference(`${CWD}/rapports/a.html`, CWD)).toEqual({
      genre: "projet",
      chemin: `${CWD}/rapports/a.html`,
      nom: "a.html",
    });
  });

  it("nomme un absolu hors projet au lieu de le chercher", () => {
    expect(classerReference("/etc/hosts", CWD)).toEqual({ genre: "hors-projet", libelle: "/etc/hosts" });
  });

  it("traite ~/… comme hors projet, pas comme introuvable (T-024)", () => {
    // Le défaut constaté : un PDF de ~/Téléchargements tombait dans la
    // recherche par nom de base et se soldait par « introuvable dans le
    // projet » — à propos d'un fichier qui existe.
    expect(classerReference("~/Téléchargements/fiche.pdf", CWD)).toEqual({
      genre: "hors-projet",
      libelle: "~/Téléchargements/fiche.pdf",
    });
    expect(classerReference("~", CWD).genre).toBe("hors-projet");
  });

  it("ne confond pas ~ami/… avec le dossier personnel", () => {
    // Un `~` qui n'est pas suivi d'un `/` ne désigne pas le dossier personnel :
    // la référence reste un chemin relatif ordinaire, tentée depuis la racine.
    expect(classerReference("~ami/x.txt", CWD).genre).toBe("candidat");
  });

  it("résout un relatif depuis la racine du projet", () => {
    expect(classerReference("docs/plan.md", CWD)).toEqual({
      genre: "candidat",
      chemin: `${CWD}/docs/plan.md`,
      nom: "plan.md",
    });
  });

  it("laisse un nom simple à la recherche", () => {
    expect(classerReference("plan.md", CWD)).toEqual({ genre: "recherche", nom: "plan.md" });
  });

  it("sort une URL du disque (T-049)", () => {
    expect(classerReference("https://exemple.net/r/a.html", CWD)).toEqual({
      genre: "distant",
      url: "https://exemple.net/r/a.html",
    });
  });
});

describe("affordance : un bouton ne doit rien promettre en vain", () => {
  it("refuse ~/… — rien ne pourra l'ouvrir", () => {
    expect(estReferenceCliquable("~/Téléchargements/fiche.pdf")).toBe(false);
  });

  it("refuse un absolu hors du projet quand le projet est connu", () => {
    expect(estReferenceCliquable("/etc/hosts", CWD)).toBe(false);
    expect(estReferenceCliquable(`${CWD}/docs/plan.md`, CWD)).toBe(true);
  });

  it("ne refuse rien faute de projet : l'ouverture dira la vérité", () => {
    // Sans `cwd`, aucun jugement possible — inventer un refus reviendrait à
    // masquer des références légitimes. Le clic répondra « hors du projet ».
    expect(estReferenceCliquable("/etc/hosts")).toBe(true);
  });

  it("accepte les URL depuis T-049", () => {
    expect(estReferenceCliquable("https://exemple.net/r/a.html")).toBe(true);
  });

  it("refuse la prose et les textes trop longs", () => {
    expect(estReferenceCliquable("une phrase avec des espaces")).toBe(false);
    expect(estReferenceCliquable(`${"a".repeat(121)}.md`)).toBe(false);
    expect(estReferenceCliquable("")).toBe(false);
  });

  it("accepte chemins et noms de fichiers ordinaires", () => {
    expect(estReferenceCliquable("docs/plan.md")).toBe(true);
    expect(estReferenceCliquable("plan.md")).toBe(true);
  });

  it("tout ce qui est cliquable se classe en quelque chose d'ouvrable", () => {
    // L'invariant du ticket, plutôt qu'une liste de cas : jamais de bouton
    // dont le clic se solderait par « introuvable » alors que le fichier est
    // simplement ailleurs.
    for (const texte of [
      "docs/plan.md",
      "plan.md",
      "/etc/hosts",
      `${CWD}/rapports/a.html`,
      "https://exemple.com/a.html",
      "~/x.pdf",
    ]) {
      if (estReferenceCliquable(texte, CWD)) {
        expect(classerReference(texte, CWD).genre, texte).not.toBe("hors-projet");
      }
    }
  });
});

describe("nom porté par une URL", () => {
  it("prend le dernier segment du chemin, sans requête ni ancre", () => {
    expect(nomDepuisUrl("https://exemple.com/a/b/rapport.html?v=2#haut")).toBe("rapport.html");
  });

  it("ne prend pas un domaine pour un nom de fichier", () => {
    // Sans ce découpage, « exemple.com » livrerait l'extension « com ».
    expect(nomDepuisUrl("https://exemple.com")).toBe("");
    expect(nomDepuisUrl("https://exemple.com/")).toBe("");
  });
});

describe("registre d'applications", () => {
  const apps: AppEntry[] = [
    { id: "firefox", label: "Firefox", command: "firefox", extensions: ["html", "htm"] },
    { id: "libreoffice", label: "LibreOffice", command: "libreoffice", extensions: ["odt"] },
  ];

  it("route un HTML local vers la règle déclarée", () => {
    expect(appPour(apps, "/p/rapports/2026-08-14.html")?.command).toBe("firefox");
  });

  it("route aussi un HTML distant", () => {
    expect(appPour(apps, "https://exemple.com/r/2026-08-14.html")?.command).toBe("firefox");
  });

  it("ne route pas un domaine sans chemin", () => {
    expect(appPour([{ id: "c", label: "C", command: "c", extensions: ["com"] }], "https://exemple.com")).toBeNull();
  });

  it("rend null quand aucune règle ne s'applique", () => {
    expect(appPour(apps, "/p/notes.md")).toBeNull();
  });
});

/*
 * Le PARCOURS d'ouverture, avec un monde extérieur simulé. C'est ce que le
 * ticket appelle « ne pas mentir » : chaque branche doit finir soit sur une
 * ouverture, soit sur un avis qui dit la vérité — jamais sur un « introuvable »
 * pour un fichier qui existe ailleurs.
 */
describe("ouverture d'une référence", () => {
  const APPS: AppEntry[] = [
    { id: "firefox", label: "Firefox", command: "firefox", extensions: ["html"] },
  ];

  function contexte(surcharge: Partial<ContexteOuverture> = {}) {
    const journal = {
      editeur: [] as Array<[string, string]>,
      app: [] as Array<[string, string]>,
      avis: [] as Array<string | null>,
    };
    const ctx: ContexteOuverture = {
      cwd: CWD,
      apps: APPS,
      lireFichier: async () => undefined,
      chercherParNom: async () => [],
      ouvrirDansEditeur: (chemin, nom) => journal.editeur.push([chemin, nom]),
      ouvrirDansApp: async (chemin, commande) => {
        journal.app.push([chemin, commande]);
      },
      avis: (message) => journal.avis.push(message),
      ...surcharge,
    };
    return { ctx, journal };
  }

  it("route un HTML du projet vers l'app déclarée, pas vers l'éditeur (T-049)", async () => {
    const { ctx, journal } = contexte();
    await ouvrirReference(`${CWD}/rapports/a.html`, ctx);
    expect(journal.app).toEqual([[`${CWD}/rapports/a.html`, "firefox"]]);
    expect(journal.editeur).toEqual([]);
  });

  it("garde l'éditeur interne quand aucune règle ne s'applique", async () => {
    const { ctx, journal } = contexte();
    await ouvrirReference(`${CWD}/docs/plan.md`, ctx);
    expect(journal.editeur).toEqual([[`${CWD}/docs/plan.md`, "plan.md"]]);
    expect(journal.app).toEqual([]);
  });

  it("dit « hors du projet » pour un ~/…, et ne cherche RIEN (T-024)", async () => {
    let cherche = 0;
    const { ctx, journal } = contexte({
      chercherParNom: async () => {
        cherche += 1;
        return [];
      },
    });
    await ouvrirReference("~/Téléchargements/fiche.pdf", ctx);
    expect(cherche).toBe(0);
    expect(journal.avis).toContain("Fichier hors du projet : ~/Téléchargements/fiche.pdf");
    expect(journal.avis.some((m) => typeof m === "string" && m.includes("introuvable"))).toBe(false);
  });

  it("se rabat sur la recherche quand le relatif n'existe pas depuis la racine", async () => {
    const { ctx, journal } = contexte({
      lireFichier: async () => {
        throw new Error("ENOENT");
      },
      chercherParNom: async () => [`${CWD}/ailleurs/plan.md`],
    });
    await ouvrirReference("docs/plan.md", ctx);
    expect(journal.editeur).toEqual([[`${CWD}/ailleurs/plan.md`, "plan.md"]]);
  });

  it("signale les autres correspondances plutôt que de les taire", async () => {
    const { ctx, journal } = contexte({
      chercherParNom: async () => [`${CWD}/a/plan.md`, `${CWD}/b/plan.md`, `${CWD}/c/plan.md`],
    });
    await ouvrirReference("plan.md", ctx);
    expect(journal.avis.at(-1)).toBe("2 autres correspondances pour « plan.md ».");
  });

  it("conclut « introuvable » seulement après avoir vraiment cherché", async () => {
    const { ctx, journal } = contexte({ chercherParNom: async () => [] });
    await ouvrirReference("absent.md", ctx);
    expect(journal.avis.at(-1)).toBe("« absent.md » introuvable dans le projet.");
  });

  it("remonte l'échec de l'application externe au lieu de l'avaler", async () => {
    const { ctx, journal } = contexte({
      ouvrirDansApp: async () => {
        throw new Error("application introuvable : firefox");
      },
    });
    await ouvrirReference(`${CWD}/a.html`, ctx);
    expect(journal.avis.at(-1)).toBe("application introuvable : firefox");
  });
});
