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
  basesDuFil,
  classerReference,
  developperTilde,
  estReferenceCliquable,
  nomDepuisUrl,
  ouvrirReference,
  resoudreReference,
  type ContexteOuverture,
} from "./refFichier";
import type { AppEntry } from "./appsAdmin";
import type { AgentBlock, AgentTurn } from "./agentTurns";

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

  it("classe un ~/… sous la racine du projet comme un projet ordinaire, une fois développé (T-107)", () => {
    const home = "/poste";
    expect(classerReference("~/demo/rapports/a.html", `${home}/demo`, home)).toEqual({
      genre: "projet",
      chemin: `${home}/demo/rapports/a.html`,
      nom: "a.html",
    });
  });

  it("classe un ~/… ailleurs comme hors-projet, avec le VRAI chemin plutôt qu'un libellé (T-107)", () => {
    const home = "/poste";
    expect(classerReference("~/Téléchargements/fiche.pdf", CWD, home)).toEqual({
      genre: "hors-projet",
      libelle: `${home}/Téléchargements/fiche.pdf`,
    });
  });

  it("sans dossier personnel connu, le classement de ~/… reste celui d'avant T-107, à l'identique", () => {
    expect(classerReference("~/Téléchargements/fiche.pdf", CWD)).toEqual({
      genre: "hors-projet",
      libelle: "~/Téléchargements/fiche.pdf",
    });
    expect(classerReference("~/Téléchargements/fiche.pdf", CWD, null)).toEqual({
      genre: "hors-projet",
      libelle: "~/Téléchargements/fiche.pdf",
    });
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

  it("sort un nom d'hôte cité sans schéma (T-090)", () => {
    // Le défaut constaté : `.fr` pris pour une extension, donc une recherche de
    // fichier, donc « introuvable dans le projet » à propos d'un site web.
    expect(classerReference("secure.exemple.fr", CWD)).toEqual({
      genre: "distant",
      url: "https://secure.exemple.fr",
    });
    expect(classerReference("www.exemple.com/aide", CWD)).toEqual({
      genre: "distant",
      url: "https://www.exemple.com/aide",
    });
  });

  it("ne prend pas un fichier pour un hôte", () => {
    // Même forme exactement — un point, un suffixe court. Seule la liste des
    // TLD tranche, et hors liste c'est le fichier qui gagne.
    expect(classerReference("plan.md", CWD).genre).toBe("recherche");
    expect(classerReference("logo.ai", CWD).genre).toBe("recherche");
    expect(classerReference("deploy.sh", CWD).genre).toBe("recherche");
    expect(classerReference("docs/plan.md", CWD).genre).toBe("candidat");
  });
});

describe("développement de ~ (developperTilde, T-107)", () => {
  it("développe ~ seul et ~/x vers le dossier personnel connu", () => {
    expect(developperTilde("~", "/poste")).toBe("/poste");
    expect(developperTilde("~/x", "/poste")).toBe("/poste/x");
  });

  it("ne développe jamais ~ami/… — ce n'est pas le dossier personnel", () => {
    expect(developperTilde("~ami/x.txt", "/poste")).toBe("~ami/x.txt");
  });

  it("laisse le texte inchangé sans dossier personnel connu : on ne devine toujours rien", () => {
    expect(developperTilde("~/x", null)).toBe("~/x");
    expect(developperTilde("~", null)).toBe("~");
  });

  it("laisse inchangé tout ce qui n'est pas un chemin personnel", () => {
    expect(developperTilde("docs/plan.md", "/poste")).toBe("docs/plan.md");
    expect(developperTilde("/etc/hosts", "/poste")).toBe("/etc/hosts");
  });
});

describe("affordance : un bouton ne doit rien promettre en vain", () => {
  it("refuse ~/… sans dossier personnel connu — rien ne pourra l'ouvrir (T-024)", () => {
    expect(estReferenceCliquable("~/Téléchargements/fiche.pdf")).toBe(false);
    expect(estReferenceCliquable("~/Téléchargements/fiche.pdf", CWD, null)).toBe(false);
  });

  it("accepte ~/… dès que le dossier personnel est connu (T-107)", () => {
    expect(estReferenceCliquable("~/Téléchargements/fiche.pdf", CWD, "/poste")).toBe(true);
  });

  it("accepte un absolu hors du projet : la cascade se ferme sur le système (T-106)", () => {
    // Ce que ce test vérifiait avant : le refus d'un absolu hors `cwd`. Il
    // datait d'une époque où seul l'éditeur interne pouvait ouvrir, borné au
    // projet. Depuis T-106, `ouvrirSelonRegistre` se referme sur l'ouvreur du
    // système faute de règle applicable — il existe toujours une issue, donc
    // le refus n'a plus lieu d'être.
    expect(estReferenceCliquable("/etc/hosts", CWD)).toBe(true);
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

  it("accepte un nom d'hôte sans schéma (T-090)", () => {
    expect(estReferenceCliquable("secure.exemple.fr", CWD)).toBe(true);
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
    // L'invariant du ticket, plutôt qu'une liste de cas. Il ne porte plus sur
    // le GENRE lui-même — « hors-projet » est désormais ouvrable via le
    // registre puis le système (T-106) — mais sur le SEUL cas qui reste un
    // cul-de-sac garanti : un `~/…` classé « hors-projet ». Les genres
    // « candidat »/« recherche », eux, dépendaient déjà de l'état réel du
    // disque avant T-106 comme après ; ce n'est pas ce que cet invariant vise.
    for (const texte of [
      "docs/plan.md",
      "plan.md",
      "/etc/hosts",
      `${CWD}/rapports/a.html`,
      "https://exemple.com/a.html",
      "~/x.pdf",
    ]) {
      if (!estReferenceCliquable(texte, CWD)) continue;
      const classe = classerReference(texte, CWD);
      if (classe.genre === "hors-projet") {
        expect(classe.libelle.startsWith("~"), texte).toBe(false);
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

/** Tour minimal portant ces blocs, du plus ancien au plus récent. */
function tour(blocks: AgentBlock[]): AgentTurn {
  return { id: `t-${Math.random()}`, role: "assistant", status: "done", blocks };
}

/** Bloc-outil minimal, seul `toolInput` compte pour `basesDuFil`. */
function outil(toolInput: unknown): AgentBlock {
  return { type: "tool", id: `b-${Math.random()}`, toolUseId: "u", toolName: "x", toolInput };
}

describe("répertoires vus dans le fil (basesDuFil, T-105)", () => {
  it("retient la cible d'un cd simple", () => {
    expect(basesDuFil([tour([outil({ command: "cd /a/b" })])], null)).toEqual(["/a/b"]);
  });

  it("retient un cd au milieu d'une chaîne &&", () => {
    expect(basesDuFil([tour([outil({ command: "cd /a/b && ls -la" })])], null)).toEqual(["/a/b"]);
  });

  it("retient le PARENT d'un file_path absolu (Read/Edit/Write)", () => {
    expect(basesDuFil([tour([outil({ file_path: "/x/y/z.py" })])], null)).toEqual(["/x/y"]);
  });

  it("ignore un cd relatif : on ne devine pas depuis où il part", () => {
    expect(basesDuFil([tour([outil({ command: "cd ../ailleurs && ls" })])], null)).toEqual([]);
  });

  it("retient le PARENT d'une destination absolue de mv (fichier RANGÉ, T-106)", () => {
    expect(
      basesDuFil([tour([outil({ command: "mv brouillon.pdf /rangement/administratif/fiche.pdf" })])], null),
    ).toEqual(["/rangement/administratif"]);
  });

  it("retient le PARENT d'une redirection vers un chemin absolu", () => {
    expect(basesDuFil([tour([outil({ command: "echo bonjour > /var/log/sortie.txt" })])], null)).toEqual([
      "/var/log",
    ]);
  });

  it("retient le PARENT d'un -o absolu", () => {
    expect(
      basesDuFil([tour([outil({ command: "openscad -o /modeles/export/piece.stl piece.scad" })])], null),
    ).toEqual(["/modeles/export"]);
  });

  it("retient un jeton absolu cité entre guillemets, espace compris", () => {
    expect(
      basesDuFil([tour([outil({ command: 'mv "brouillon.pdf" "/rangement/dossier final/fiche.pdf"' })])], null),
    ).toEqual(["/rangement/dossier final"]);
  });

  it("ignore un jeton qui n'est pas absolu", () => {
    expect(basesDuFil([tour([outil({ command: "ls docs/plan.md" })])], null)).toEqual([]);
  });

  it("un motif sed ne produit RIEN : les guillemets retirés ne commencent pas par /", () => {
    expect(basesDuFil([tour([outil({ command: "sed -i 's/a/b/' fichier.txt" })])], null)).toEqual([]);
  });

  it("garde l'ordre d'apparition entre plusieurs jetons absolus d'une même commande", () => {
    expect(basesDuFil([tour([outil({ command: "cd /a && mv f.txt /b/c.txt" })])], null)).toEqual(["/a", "/b"]);
  });

  it("déduplique en gardant la première occurrence, du plus récent tour au plus ancien", () => {
    const turns = [
      tour([outil({ command: "cd /a" })]), // le plus ancien
      tour([outil({ command: "cd /b" }), outil({ command: "cd /a" })]), // le plus récent
    ];
    expect(basesDuFil(turns, null)).toEqual(["/a", "/b"]);
  });

  it("plafonne au maximum demandé", () => {
    const blocs = ["/a", "/b", "/c", "/d"].map((r) => outil({ command: `cd ${r}` }));
    expect(basesDuFil([tour(blocs)], null, 2)).toEqual(["/d", "/c"]);
  });

  it("rend une liste vide pour un fil vide ou malformé, sans jamais jeter", () => {
    expect(basesDuFil([], null)).toEqual([]);
    expect(basesDuFil([tour([{ type: "text", id: "b", content: "…" }])], null)).toEqual([]);
    expect(basesDuFil([tour([outil(null)]), tour([outil("pas un objet")])], null)).toEqual([]);
  });

  it("développe un cd en ~/… vers le dossier personnel connu (T-107)", () => {
    expect(basesDuFil([tour([outil({ command: "cd ~/a/b" })])], "/poste")).toEqual(["/poste/a/b"]);
  });

  it("ignore un cd en ~/… tant que le dossier personnel est inconnu (T-107)", () => {
    expect(basesDuFil([tour([outil({ command: "cd ~/a/b" })])], null)).toEqual([]);
  });

  it("développe aussi un file_path en ~/… (T-107)", () => {
    expect(basesDuFil([tour([outil({ file_path: "~/x/y/z.py" })])], "/poste")).toEqual(["/poste/x/y"]);
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
      app: [] as Array<[string, string | null]>,
      avis: [] as Array<string | null>,
    };
    const ctx: ContexteOuverture = {
      cwd: CWD,
      // `home: null` par défaut : `ctx.home` étant DÉFINI (même à null), il
      // prime sur l'appel système (T-107) — aucun test de ce bloc n'appelle
      // jamais Tauri, sauf à surcharger explicitement cette valeur.
      home: null,
      apps: APPS,
      lireFichier: async () => undefined,
      // Par défaut, RIEN n'est un dossier : la sonde de T-119 ne doit changer
      // aucun des parcours « fichier » déjà éprouvés ici.
      listerDossier: async () => {
        throw new Error("pas un dossier");
      },
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

  it("ne tend JAMAIS un ~/… à une application déclarée quand le dossier personnel est inconnu", async () => {
    // T-105 ouvre les chemins hors projet aux applications déclarées, mais un
    // `~/…` non développé (dossier personnel inconnu, T-107) n'est pas un
    // chemin. Le tendre à Cura ou à un lecteur PDF lui ferait chercher un
    // dossier nommé « ~ » et échouer sur un message à lui. On NOMME, comme avant.
    const { ctx, journal } = contexte({
      apps: [{ id: "lecteur", label: "Lecteur", command: "lecteur", extensions: ["pdf"] }],
    });
    await ouvrirReference("~/Téléchargements/fiche.pdf", ctx);
    expect(journal.app).toEqual([]);
    expect(journal.editeur).toEqual([]);
    expect(journal.avis).toContain("Fichier hors du projet : ~/Téléchargements/fiche.pdf");
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

  it("un candidat absent sous cwd mais présent sous une base est ouvert (T-105)", async () => {
    // Base vue dans le fil (un `cd` vers un SOUS-dossier du projet, par
    // exemple) : le relatif se résout par rapport à elle, pas à la racine.
    // Les bases ne sont plus injectées directement (T-107) : c'est
    // `ouvrirReference` qui les calcule lui-même depuis `turns`.
    const sousDossier = `${CWD}/nested`;
    const { ctx, journal } = contexte({
      turns: [tour([outil({ command: `cd ${sousDossier}` })])],
      lireFichier: async (chemin) => {
        if (chemin === `${sousDossier}/sous/plan.md`) return undefined;
        throw new Error("ENOENT");
      },
    });
    await ouvrirReference("sous/plan.md", ctx);
    expect(journal.editeur).toEqual([[`${sousDossier}/sous/plan.md`, "plan.md"]]);
  });

  it("scénario du ticket : stl écrit ailleurs, cité en relatif, ouvert dans l'app déclarée", async () => {
    // La forme exacte du cas constaté (T-105), racine neutralisée pour la
    // publication : le projet ouvert est
    // « Didier », racine `.../python/dadou_robot_ros`, mais le tour a travaillé
    // dans une AUTRE branche de `didier/`, dite via `cd` puis un `file_path`
    // absolu — avant de citer `stl/PLATEAU-complet.stl` en relatif.
    const cwdDidier = "/poste/dev/didier/python/dadou_robot_ros";
    const brancheStl = "/poste/dev/didier/plans/supports/support-respeaker-xvf3800";
    const stl = `${brancheStl}/stl/PLATEAU-complet.stl`;
    const turns: AgentTurn[] = [
      tour([
        outil({ command: `cd ${brancheStl} && ls stl` }),
        outil({ file_path: stl }),
      ]),
    ];
    const cura: AppEntry[] = [{ id: "cura", label: "Cura", command: "cura", extensions: ["stl"] }];
    const { ctx, journal } = contexte({
      cwd: cwdDidier,
      apps: cura,
      turns,
      lireFichier: async (chemin) => {
        if (chemin === stl) return undefined;
        throw new Error("ENOENT");
      },
    });
    await ouvrirReference("stl/PLATEAU-complet.stl", ctx);
    expect(journal.app).toEqual([[stl, "cura"]]);
    expect(journal.editeur).toEqual([]);
    expect(journal.avis.some((m) => typeof m === "string" && m.includes("introuvable"))).toBe(false);
  });

  it("hors projet avec règle déclarée : ouvre dans l'app, jamais dans l'éditeur interne (T-105)", async () => {
    const cura: AppEntry[] = [{ id: "cura", label: "Cura", command: "cura", extensions: ["stl"] }];
    const { ctx, journal } = contexte({ apps: cura });
    await ouvrirReference("/ailleurs/piece.stl", ctx);
    expect(journal.app).toEqual([["/ailleurs/piece.stl", "cura"]]);
    expect(journal.editeur).toEqual([]);
    expect(journal.avis).toEqual([null]);
  });

  it("hors projet sans règle déclarée : ouvreur du système, plus d'avis « hors du projet » (T-106)", async () => {
    // Le refus tombe : il existe toujours une issue, ici l'ouvreur du
    // système faute de règle applicable — jamais l'éditeur interne, qui
    // reste borné au projet (T-024).
    const { ctx, journal } = contexte();
    await ouvrirReference("/ailleurs/notes.md", ctx);
    expect(journal.app).toEqual([["/ailleurs/notes.md", null]]);
    expect(journal.editeur).toEqual([]);
    expect(journal.avis).toEqual([null]);
  });

  it("scénario du ticket (T-106) : PDF rangé hors du projet par un mv, cité par son nom, ouvert par le système", async () => {
    // La forme exacte du cas constaté, racine neutralisée pour la
    // publication (le dépôt est publié, `npm run verif` refuse un chemin
    // personnel) : projet « OrgaIA » ouvert à `/poste/dev/orgaia`, un tour
    // range un PDF administratif hors du projet via `mv`, puis le fil
    // suivant le cite par son seul NOM. Aucune règle `pdf` déclarée.
    const cwdOrgaia = "/poste/dev/orgaia";
    const dossierRangement = "/poste/administratif/impots/2024/rectification";
    const nomFichier = "2026-08-17_formulaire-4805-difficultes-paiement.pdf";
    const pdf = `${dossierRangement}/${nomFichier}`;
    const turns: AgentTurn[] = [tour([outil({ command: `mv telechargement.pdf ${pdf}` })])];
    const { ctx, journal } = contexte({
      cwd: cwdOrgaia,
      apps: [], // aucune règle déclarée pour les pdf
      turns,
      chercherParNom: async () => [], // absent du projet lui-même
      lireFichier: async (chemin) => {
        if (chemin === pdf) return undefined;
        throw new Error("ENOENT");
      },
    });
    await ouvrirReference(nomFichier, ctx);
    expect(journal.app).toEqual([[pdf, null]]);
    expect(journal.editeur).toEqual([]);
    expect(journal.avis.some((m) => typeof m === "string" && m.includes("introuvable"))).toBe(false);
  });

  it("scénario du ticket (T-107) : chemin écrit en ~ dans un cd, fichier cité par son seul nom, ouvert par le système", async () => {
    // La forme exacte de la transcription vérifiée pour T-107, racine
    // neutralisée pour la publication : le modèle n'écrit AUCUN chemin
    // absolu, seulement `cd ~/Nextcloud/…` — puis cite le fichier produit
    // par son seul nom. Projet ouvert ailleurs, aucune règle `pdf` déclarée.
    const home = "/poste";
    const cwdProjet = "/poste/dev/orgaia";
    const nomFichier = "fiche.pdf";
    const dossierRectificationTilde = "~/Nextcloud/administratif/impots/2024/rectification";
    const dossierRectification = `${home}/Nextcloud/administratif/impots/2024/rectification`;
    const pdf = `${dossierRectification}/${nomFichier}`;
    const turns: AgentTurn[] = [
      tour([outil({ command: `cd ${dossierRectificationTilde} && pdftotext extrait.txt ${nomFichier}` })]),
    ];
    const { ctx, journal } = contexte({
      cwd: cwdProjet,
      home,
      turns,
      apps: [], // aucune règle déclarée pour les pdf
      chercherParNom: async () => [], // absent du projet lui-même
      lireFichier: async (chemin) => {
        if (chemin === pdf) return undefined;
        throw new Error("ENOENT");
      },
    });
    await ouvrirReference(nomFichier, ctx);
    expect(journal.app).toEqual([[pdf, null]]);
    expect(journal.editeur).toEqual([]);
    expect(journal.avis.some((m) => typeof m === "string" && m.includes("introuvable"))).toBe(false);
  });

  it("non-régression : sans dossier personnel connu, un ~/… reste hors du projet, jamais ouvert (T-024)", async () => {
    // Le comportement d'avant T-107, à l'identique : `contexte()` pose
    // `home: null` par défaut, donc rien n'est développé.
    const { ctx, journal } = contexte();
    await ouvrirReference("~/Nextcloud/administratif/fiche.pdf", ctx);
    expect(journal.app).toEqual([]);
    expect(journal.editeur).toEqual([]);
    expect(journal.avis).toContain("Fichier hors du projet : ~/Nextcloud/administratif/fiche.pdf");
  });
});

/*
 * La RÉSOLUTION seule (T-108) : ce que le menu contextuel consulte avant
 * d'afficher quoi que ce soit — aucune ouverture, aucun avis, seuls
 * `lireFichier`/`chercherParNom` (sonder le disque) sont appelés.
 */
describe("résolution seule d'une référence (resoudreReference, T-108)", () => {
  const APPS: AppEntry[] = [{ id: "firefox", label: "Firefox", command: "firefox", extensions: ["html"] }];

  function contexteResolution(surcharge: Partial<ContexteOuverture> = {}): ContexteOuverture {
    return {
      cwd: CWD,
      home: null,
      apps: APPS,
      lireFichier: async () => undefined,
      // Par défaut, RIEN n'est un dossier : la sonde de T-119 ne doit changer
      // aucun des parcours « fichier » déjà éprouvés ici.
      listerDossier: async () => {
        throw new Error("pas un dossier");
      },
      chercherParNom: async () => [],
      ouvrirDansEditeur: () => {},
      ouvrirDansApp: async () => {},
      avis: () => {},
      ...surcharge,
    };
  }

  it("résout un fichier sous le projet (sousProjet: true)", async () => {
    const ctx = contexteResolution();
    await expect(resoudreReference(`${CWD}/docs/plan.md`, ctx)).resolves.toEqual({
      etat: "fichier",
      chemin: `${CWD}/docs/plan.md`,
      nom: "plan.md",
      sousProjet: true,
      autres: 0,
    });
  });

  it("résout un fichier hors du projet (sousProjet: false), sans le vérifier sur le disque (T-105/T-106)", async () => {
    const ctx = contexteResolution();
    await expect(resoudreReference("/ailleurs/piece.stl", ctx)).resolves.toEqual({
      etat: "fichier",
      chemin: "/ailleurs/piece.stl",
      nom: "piece.stl",
      sousProjet: false,
      autres: 0,
    });
  });

  it("résout un fichier trouvé sous une base du fil (T-105) : sousProjet reflète le VRAI chemin", async () => {
    const sousDossier = `${CWD}/nested`;
    const ctx = contexteResolution({
      turns: [tour([outil({ command: `cd ${sousDossier}` })])],
      lireFichier: async (chemin) => {
        if (chemin === `${sousDossier}/sous/plan.md`) return undefined;
        throw new Error("ENOENT");
      },
    });
    await expect(resoudreReference("sous/plan.md", ctx)).resolves.toEqual({
      etat: "fichier",
      chemin: `${sousDossier}/sous/plan.md`,
      nom: "plan.md",
      sousProjet: true,
      autres: 0,
    });
  });

  it("résout distant sans toucher au disque", async () => {
    const ctx = contexteResolution();
    await expect(resoudreReference("https://exemple.net/r/a.html", ctx)).resolves.toEqual({
      etat: "distant",
      url: "https://exemple.net/r/a.html",
    });
  });

  it("résout impossible pour un ~/… non développé, sans chercher (T-024)", async () => {
    let cherche = 0;
    const ctx = contexteResolution({
      chercherParNom: async () => {
        cherche += 1;
        return [];
      },
    });
    await expect(resoudreReference("~/Téléchargements/fiche.pdf", ctx)).resolves.toEqual({
      etat: "impossible",
      message: "Fichier hors du projet : ~/Téléchargements/fiche.pdf",
    });
    expect(cherche).toBe(0);
  });

  it("résout impossible après une recherche par nom infructueuse", async () => {
    const ctx = contexteResolution({ chercherParNom: async () => [] });
    await expect(resoudreReference("absent.md", ctx)).resolves.toEqual({
      etat: "impossible",
      message: "« absent.md » introuvable dans le projet.",
    });
  });

  it("porte le compte des AUTRES correspondances trouvées par la recherche", async () => {
    const ctx = contexteResolution({
      chercherParNom: async () => [`${CWD}/a/plan.md`, `${CWD}/b/plan.md`, `${CWD}/c/plan.md`],
    });
    await expect(resoudreReference("plan.md", ctx)).resolves.toEqual({
      etat: "fichier",
      chemin: `${CWD}/a/plan.md`,
      nom: "plan.md",
      sousProjet: true,
      autres: 2,
    });
  });
});

/*
 * Le forçage du menu contextuel (T-108) : `ContexteOuverture.forcer` impose
 * une voie plutôt que de laisser la politique par défaut décider.
 */
describe("forçage d'ouverture (ContexteOuverture.forcer, T-108)", () => {
  const APPS: AppEntry[] = [{ id: "firefox", label: "Firefox", command: "firefox", extensions: ["html"] }];

  function contexte(surcharge: Partial<ContexteOuverture> = {}) {
    const journal = {
      editeur: [] as Array<[string, string]>,
      app: [] as Array<[string, string | null]>,
      avis: [] as Array<string | null>,
    };
    const ctx: ContexteOuverture = {
      cwd: CWD,
      home: null,
      apps: APPS,
      lireFichier: async () => undefined,
      // Par défaut, RIEN n'est un dossier : la sonde de T-119 ne doit changer
      // aucun des parcours « fichier » déjà éprouvés ici.
      listerDossier: async () => {
        throw new Error("pas un dossier");
      },
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

  it("« app » ouvre la règle déclarée même sous le projet — jamais l'éditeur", async () => {
    const { ctx, journal } = contexte({ forcer: "app" });
    await ouvrirReference(`${CWD}/rapports/a.html`, ctx);
    expect(journal.app).toEqual([[`${CWD}/rapports/a.html`, "firefox"]]);
    expect(journal.editeur).toEqual([]);
  });

  it("« app » sans règle applicable se rabat sur le système, jamais l'éditeur", async () => {
    const { ctx, journal } = contexte({ forcer: "app" });
    await ouvrirReference(`${CWD}/docs/plan.md`, ctx);
    expect(journal.app).toEqual([[`${CWD}/docs/plan.md`, null]]);
    expect(journal.editeur).toEqual([]);
  });

  it("« systeme » ignore la règle déclarée", async () => {
    const { ctx, journal } = contexte({ forcer: "systeme" });
    await ouvrirReference(`${CWD}/rapports/a.html`, ctx);
    expect(journal.app).toEqual([[`${CWD}/rapports/a.html`, null]]);
    expect(journal.editeur).toEqual([]);
  });

  it("« editeur » ouvre un fichier du projet", async () => {
    const { ctx, journal } = contexte({ forcer: "editeur" });
    await ouvrirReference(`${CWD}/docs/plan.md`, ctx);
    expect(journal.editeur).toEqual([[`${CWD}/docs/plan.md`, "plan.md"]]);
    expect(journal.app).toEqual([]);
  });

  it("« editeur » refusé hors du projet — reste borné (T-024), même avec une règle déclarée", async () => {
    const cura: AppEntry[] = [{ id: "cura", label: "Cura", command: "cura", extensions: ["stl"] }];
    const { ctx, journal } = contexte({ forcer: "editeur", apps: cura });
    await ouvrirReference("/ailleurs/piece.stl", ctx);
    expect(journal.editeur).toEqual([]);
    expect(journal.app).toEqual([]);
    // Message destiné à un humain : il dit ce qui bloque, sans numéro de ticket
    // (aucun autre avis du produit n'en porte — voir refFichier.ts).
    expect(journal.avis.at(-1)).toBe(
      "L'éditeur interne n'ouvre que les fichiers du projet. Hors du projet : /ailleurs/piece.stl",
    );
  });
});
