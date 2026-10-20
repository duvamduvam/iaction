/*
 * Dossier personnel (T-107) : normalisation pure et bus module-scope. Aucun
 * accès Tauri ici — `dossierPersonnel()` (qui appelle `homeDir()`) n'est pas
 * testé (même parti pris que `survolReference.test.ts` pour
 * `chargerSurvol`/`enregistrerSurvol`).
 */

import { describe, expect, it } from "vitest";

import {
  appliquerDossierPersonnel,
  dossierPersonnelConnu,
  sansBarreFinale,
  subscribeDossierPersonnel,
} from "./dossierPersonnel";

describe("instantané avant chargement", () => {
  it("rend null tant que le système n'a pas répondu", () => {
    // Aucun appel à `dossierPersonnel()` dans ce fichier : le cache
    // module-scope n'a jamais été posé, l'instantané doit rester null.
    expect(dossierPersonnelConnu()).toBeNull();
  });
});

describe("normalisation de la barre finale", () => {
  it("retire la barre finale d'un chemin ordinaire", () => {
    expect(sansBarreFinale("/home/moi/")).toBe("/home/moi");
  });

  it("laisse un chemin sans barre finale inchangé", () => {
    expect(sansBarreFinale("/home/moi")).toBe("/home/moi");
  });

  it("garde la racine `/` telle quelle", () => {
    expect(sansBarreFinale("/")).toBe("/");
  });
});

describe("bus de notification", () => {
  it("notifie un abonné quand la valeur change réellement", () => {
    let appels = 0;
    const desabonner = subscribeDossierPersonnel(() => {
      appels += 1;
    });

    appliquerDossierPersonnel("/poste/moi");
    expect(appels).toBe(1);
    expect(dossierPersonnelConnu()).toBe("/poste/moi");

    // Reposer EXACTEMENT la même valeur ne redéclenche rien (identité stable).
    appliquerDossierPersonnel("/poste/moi");
    expect(appels).toBe(1);

    desabonner();
  });

  it("un abonné désabonné ne reçoit plus rien", () => {
    let appels = 0;
    const desabonner = subscribeDossierPersonnel(() => {
      appels += 1;
    });
    desabonner();

    appliquerDossierPersonnel("/autre");
    expect(appels).toBe(0);
  });
});
