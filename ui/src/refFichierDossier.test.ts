/*
 * Résolution d'un DOSSIER cité dans une transcription (T-119) — le pendant
 * dossier de `refFichier.test.ts`, sorti dans son propre fichier parce que
 * l'autre atteignait le plafond du cliquet de taille.
 *
 * Les helpers y sont volontairement DIFFÉRENTS de ceux du fichier voisin :
 * ici aucun chemin n'est un fichier lisible, seule la liste `dossiers` existe
 * — c'est ce renversement qui prouve que la sonde de dossier est bien ce qui
 * tranche, et non un repli accidentel de la cascade des fichiers.
 */

import { describe, expect, it } from "vitest";

import { ouvrirReference, resoudreReference, type ContexteOuverture } from "./refFichier";
import type { AgentBlock, AgentTurn } from "./agentTurns";

/** Tour minimal portant ces blocs (même forme que dans refFichier.test.ts). */
function tour(blocks: AgentBlock[]): AgentTurn {
  return { id: `t-${Math.random()}`, role: "assistant", status: "done", blocks };
}

/** Bloc-outil minimal, seul `toolInput` compte pour `basesDuFil`. */
function outil(toolInput: unknown): AgentBlock {
  return { type: "tool", id: `b-${Math.random()}`, toolUseId: "u", toolName: "x", toolInput };
}

/*
 * Un DOSSIER cité dans le fil (T-119). Le cas réel du ticket :
 * « plans/supports/support-camera-csi/ » répondait « introuvable dans le
 * projet » à propos d'un dossier bien présent — la cascade ne sondait que
 * des fichiers, et la barre finale vidait le nom de base cherché.
 *
 * `dossiers` liste les chemins que la sonde reconnaît ; tout le reste
 * échoue, comme le disque le ferait.
 */
describe("résolution d'un dossier (T-119)", () => {
  const CWD_D = "/home/moi/projets/demo";

  function contexteDossiers(dossiers: string[], surcharge: Partial<ContexteOuverture> = {}): ContexteOuverture {
    return {
      cwd: CWD_D,
      home: null,
      apps: [],
      // Aucun FICHIER dans ce bloc : un dossier n'est pas lisible comme
      // fichier (c'est ce que fait `fs_read_file` côté Rust), et un chemin
      // absent non plus — dans les deux cas la lecture échoue, et c'est cet
      // échec qui doit déclencher la sonde de dossier plutôt que conclure.
      lireFichier: async () => {
        throw new Error("illisible comme fichier");
      },
      listerDossier: async (chemin) => {
        if (!dossiers.includes(chemin)) throw new Error("pas un dossier");
        return [];
      },
      chercherParNom: async () => [],
      ouvrirDansEditeur: () => {},
      ouvrirDansApp: async () => {},
      avis: () => {},
      ...surcharge,
    };
  }

  it("résout un relatif à barre finale en dossier, pas en « introuvable »", async () => {
    const chemin = `${CWD_D}/plans/supports/support-camera-csi`;
    const ctx = contexteDossiers([chemin]);
    await expect(resoudreReference("plans/supports/support-camera-csi/", ctx)).resolves.toEqual({
      etat: "dossier",
      chemin,
      nom: "support-camera-csi",
      sousProjet: true,
    });
  });

  it("résout le même relatif SANS barre finale à l'identique", async () => {
    const chemin = `${CWD_D}/plans/supports/support-camera-csi`;
    const ctx = contexteDossiers([chemin]);
    await expect(resoudreReference("plans/supports/support-camera-csi", ctx)).resolves.toEqual({
      etat: "dossier",
      chemin,
      nom: "support-camera-csi",
      sousProjet: true,
    });
  });

  it("un dossier d'un seul segment (`photos/`) est tenté sous la racine, pas cherché par nom", async () => {
    let cherche = 0;
    const ctx = contexteDossiers([`${CWD_D}/photos`], {
      chercherParNom: async () => {
        cherche += 1;
        return [];
      },
    });
    await expect(resoudreReference("photos/", ctx)).resolves.toEqual({
      etat: "dossier",
      chemin: `${CWD_D}/photos`,
      nom: "photos",
      sousProjet: true,
    });
    expect(cherche).toBe(0);
  });

  it("un absolu du projet qui est un dossier n'est plus annoncé comme fichier", async () => {
    const ctx = contexteDossiers([`${CWD_D}/docs`]);
    await expect(resoudreReference(`${CWD_D}/docs`, ctx)).resolves.toEqual({
      etat: "dossier",
      chemin: `${CWD_D}/docs`,
      nom: "docs",
      sousProjet: true,
    });
  });

  it("un absolu HORS projet qui est un dossier se résout aussi (sousProjet: false)", async () => {
    const ctx = contexteDossiers(["/ailleurs/photos"]);
    await expect(resoudreReference("/ailleurs/photos/", ctx)).resolves.toEqual({
      etat: "dossier",
      chemin: "/ailleurs/photos",
      nom: "photos",
      sousProjet: false,
    });
  });

  it("un dossier trouvé sous une base du fil garde le chemin de cette base (T-105)", async () => {
    const ctx = contexteDossiers(["/ailleurs/chantier/plans/supports"], {
      turns: [tour([outil({ command: "cd /ailleurs/chantier" })])],
    });
    await expect(resoudreReference("plans/supports/", ctx)).resolves.toEqual({
      etat: "dossier",
      chemin: "/ailleurs/chantier/plans/supports",
      nom: "supports",
      sousProjet: false,
    });
  });

  it("un dossier s'ouvre par l'ouvreur du SYSTÈME — jamais l'éditeur interne", async () => {
    const journal: Array<[string, string | null]> = [];
    const editeur: string[] = [];
    const ctx = contexteDossiers([`${CWD_D}/docs`], {
      ouvrirDansApp: async (chemin, commande) => {
        journal.push([chemin, commande]);
      },
      ouvrirDansEditeur: (chemin) => editeur.push(chemin),
    });
    await ouvrirReference("docs/", ctx);
    expect(journal).toEqual([[`${CWD_D}/docs`, null]]);
    expect(editeur).toEqual([]);
  });

  it("ce qui n'est ni fichier ni dossier reste « introuvable »", async () => {
    const ctx = contexteDossiers([]);
    await expect(resoudreReference("plans/absent/", ctx)).resolves.toEqual({
      etat: "impossible",
      message: "« plans/absent/ » introuvable dans le projet.",
    });
  });
});
