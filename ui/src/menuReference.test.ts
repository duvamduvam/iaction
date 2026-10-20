/*
 * `itemsDuMenu` seule (T-108) : la décision testable sans DOM (voir l'en-tête
 * de menuReference.tsx — le projet n'a pas d'environnement DOM en test).
 */

import { describe, expect, it } from "vitest";

import { itemsDuMenu } from "./menuReference";
import type { ResolutionReference } from "./refFichier";
import type { AppEntry } from "./appsAdmin";

const CURA: AppEntry[] = [{ id: "cura", label: "Cura", command: "cura", extensions: ["stl"] }];

describe("items du menu contextuel (itemsDuMenu, T-108)", () => {
  it("fichier sous le projet, avec une règle déclarée : les cinq voies", () => {
    const resolution: ResolutionReference = {
      etat: "fichier",
      chemin: "/p/piece.stl",
      nom: "piece.stl",
      sousProjet: true,
      autres: 0,
    };
    expect(itemsDuMenu(resolution, CURA)).toEqual([
      { cle: "app", libelle: "Ouvrir avec Cura" },
      { cle: "systeme", libelle: "Ouvrir avec l'application système" },
      { cle: "editeur", libelle: "Ouvrir dans l'éditeur" },
      { cle: "copier", libelle: "Copier le chemin" },
      { cle: "dossier", libelle: "Ouvrir le dossier" },
    ]);
  });

  it("fichier sous le projet, sans règle : pas d'item « Ouvrir avec »", () => {
    const resolution: ResolutionReference = {
      etat: "fichier",
      chemin: "/p/notes.md",
      nom: "notes.md",
      sousProjet: true,
      autres: 0,
    };
    expect(itemsDuMenu(resolution, [])).toEqual([
      { cle: "systeme", libelle: "Ouvrir avec l'application système" },
      { cle: "editeur", libelle: "Ouvrir dans l'éditeur" },
      { cle: "copier", libelle: "Copier le chemin" },
      { cle: "dossier", libelle: "Ouvrir le dossier" },
    ]);
  });

  it("fichier hors du projet, avec une règle déclarée : jamais l'éditeur (T-024)", () => {
    const resolution: ResolutionReference = {
      etat: "fichier",
      chemin: "/ailleurs/piece.stl",
      nom: "piece.stl",
      sousProjet: false,
      autres: 0,
    };
    expect(itemsDuMenu(resolution, CURA)).toEqual([
      { cle: "app", libelle: "Ouvrir avec Cura" },
      { cle: "systeme", libelle: "Ouvrir avec l'application système" },
      { cle: "copier", libelle: "Copier le chemin" },
      { cle: "dossier", libelle: "Ouvrir le dossier" },
    ]);
  });

  it("fichier hors du projet, sans règle : ni l'app ni l'éditeur", () => {
    const resolution: ResolutionReference = {
      etat: "fichier",
      chemin: "/ailleurs/notes.md",
      nom: "notes.md",
      sousProjet: false,
      autres: 0,
    };
    expect(itemsDuMenu(resolution, [])).toEqual([
      { cle: "systeme", libelle: "Ouvrir avec l'application système" },
      { cle: "copier", libelle: "Copier le chemin" },
      { cle: "dossier", libelle: "Ouvrir le dossier" },
    ]);
  });

  it("dossier (T-119) : ouvrir le dossier, copier le chemin — ni app ni éditeur", () => {
    const resolution: ResolutionReference = {
      etat: "dossier",
      chemin: "/p/plans/supports",
      nom: "supports",
      sousProjet: true,
    };
    expect(itemsDuMenu(resolution, CURA)).toEqual([
      { cle: "dossier", libelle: "Ouvrir le dossier" },
      { cle: "copier", libelle: "Copier le chemin" },
    ]);
  });

  it("distant : ouvrir le lien, copier le lien", () => {
    const resolution: ResolutionReference = { etat: "distant", url: "https://exemple.com/a.html" };
    expect(itemsDuMenu(resolution, [])).toEqual([
      { cle: "app", libelle: "Ouvrir le lien" },
      { cle: "copier", libelle: "Copier le lien" },
    ]);
  });

  it("impossible : aucun item, le menu affichera le message", () => {
    const resolution: ResolutionReference = { etat: "impossible", message: "« x » introuvable dans le projet." };
    expect(itemsDuMenu(resolution, CURA)).toEqual([]);
  });
});
