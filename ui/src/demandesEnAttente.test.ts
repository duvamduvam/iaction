/*
 * File des demandes en attente (T-181) : une demande survit au changement de
 * projet, ne s'ouvre que dans son projet, et sort de la file avec son tour.
 */
import { describe, expect, it } from "vitest";
import {
  cleDemande,
  demandeCourante,
  libelleLigne,
  lignesEnAttente,
  nombreAutresDuProjet,
  sansDemande,
  sansDemandesDuProjet,
  sansDemandesDuTour,
  titreCourt,
  titreSectionAttente,
} from "./demandesEnAttente";
import type { PermissionRequestItem } from "./questionsAgent";

function question(targetId: string, projectId: string | null, texte = "Quelles dates ?", permissionId = "p1"): PermissionRequestItem {
  return {
    targetId,
    permissionId,
    toolName: "mcp__studio__ask_user",
    toolInput: { questions: [{ question: texte, header: "", multiSelect: false, options: [] }] },
    engine: "claude",
    projectId,
    convId: `conv-${targetId}`,
  };
}

function permission(targetId: string, projectId: string | null, permissionId = "p2"): PermissionRequestItem {
  return { targetId, permissionId, toolName: "Bash", toolInput: {}, engine: "claude", projectId, convId: `conv-${targetId}` };
}

describe("demandeCourante : la modale ne montre que le projet courant", () => {
  const a = question("t1", "A");
  const b = permission("t2", "B");

  it("ignore les demandes des autres projets", () => {
    expect(demandeCourante([a, b], "B", [], null)?.item).toBe(b);
    expect(demandeCourante([a], "B", [], null)).toBeNull();
  });

  it("saute les demandes mises de côté, puis se replie sur la première", () => {
    const a2 = permission("t3", "A", "p3");
    expect(demandeCourante([a, a2], "A", [cleDemande(a)], null)).toEqual({ item: a2, replie: false });
    expect(demandeCourante([a, a2], "A", [cleDemande(a), cleDemande(a2)], null)).toEqual({ item: a, replie: true });
  });

  it("la demande rouverte passe devant, même si elle était de côté", () => {
    const a2 = permission("t3", "A", "p3");
    expect(demandeCourante([a, a2], "A", [cleDemande(a)], cleDemande(a))).toEqual({ item: a, replie: false });
  });

  it("une clé focale d'un autre projet est sans effet", () => {
    expect(demandeCourante([a, b], "B", [], cleDemande(a))?.item).toBe(b);
  });

  it("compte les autres demandes du même projet seulement", () => {
    const a2 = permission("t3", "A", "p3");
    expect(nombreAutresDuProjet([a, a2, b], "A", a)).toBe(1);
  });
});

describe("sortie de file", () => {
  const a = question("t1", "A");
  const a2 = permission("t1", "A", "p9");
  const b = permission("t2", "B");

  it("fin de tour : toutes les demandes du tour sortent, pas celles des autres", () => {
    expect(sansDemandesDuTour([a, a2, b], "t1")).toEqual([b]);
  });

  it("projet supprimé : seules ses demandes sortent", () => {
    expect(sansDemandesDuProjet([a, a2, b], "A")).toEqual([b]);
  });

  it("réponse : une seule demande sort, même si le tour en a posé d'autres", () => {
    expect(sansDemande([a, a2, b], a)).toEqual([a2, b]);
  });
});

describe("libellés", () => {
  it("titre court : le texte de la question, tronqué", () => {
    expect(titreCourt(question("t", "A", "Quelles dates ?"))).toBe("Quelles dates ?");
    const long = titreCourt(question("t", "A", "x".repeat(200)), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith("…")).toBe(true);
  });

  it("titre court d'une permission : le titre de permission", () => {
    expect(titreCourt(permission("t", "A"))).toBe("Exécuter une commande");
  });

  it("lignes : type, projet et conversation, avec repli explicite", () => {
    const lignes = lignesEnAttente(
      [question("t1", "A"), permission("t2", "Z")],
      (id) => (id === "A" ? "Projet A" : null),
      (_p, conv) => (conv === "conv-t1" ? "Dates Live" : null),
    );
    expect(lignes.map((l) => l.type)).toEqual(["question", "permission"]);
    expect(libelleLigne(lignes[0])).toBe("Question — Quelles dates ? · Projet A · Dates Live");
    expect(lignes[1].projet).toBe("Projet inconnu");
    expect(lignes[1].conversation).toBe("Conversation inconnue");
  });

  it("titre de section avec le compte", () => {
    expect(titreSectionAttente(3)).toBe("En attente de vous (3)");
  });
});
