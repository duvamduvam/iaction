/*
 * Questions posées par l'agent — la logique pure de la modale.
 *
 * L'enjeu : ce que l'utilisateur coche repart vers l'agent comme résultat
 * d'outil. Une réponse mal composée n'est pas un bug d'affichage, c'est
 * l'agent qui comprend autre chose que ce que l'utilisateur a dit.
 */
import { describe, expect, it } from "vitest";
import {
  composeAskMessage,
  effectiveAnswer,
  effectiveAnswers,
  isPicked,
  parseAskQuestions,
  permissionTitle,
  type AskQuestion,
} from "./questionsAgent";

const question = (q: string, extra: Partial<AskQuestion> = {}): AskQuestion => ({
  question: q,
  header: "",
  multiSelect: false,
  options: [],
  ...extra,
});

describe("parseAskQuestions — défensif : une modale qui plante bloque le tour", () => {
  it("forme canonique : questions, options, préview optionnelle", () => {
    const [q] = parseAskQuestions({
      questions: [
        {
          question: "Quelle base ?",
          header: "Base",
          multiSelect: false,
          options: [{ label: "SQLite", description: "locale", preview: "schema.sql" }],
        },
      ],
    });
    expect(q.question).toBe("Quelle base ?");
    expect(q.options[0]).toEqual({ label: "SQLite", description: "locale", preview: "schema.sql" });
  });

  it("tout ce qui est difforme est IGNORÉ, jamais levé", () => {
    expect(parseAskQuestions(null)).toEqual([]);
    expect(parseAskQuestions({ questions: "non" })).toEqual([]);
    expect(parseAskQuestions({ questions: [{ question: "" }, { pas: "une question" }, 42] })).toEqual([]);
  });

  it("une option sans label disparaît, la question survit", () => {
    const [q] = parseAskQuestions({
      questions: [{ question: "Q ?", options: [{ description: "sans label" }, { label: "OK" }] }],
    });
    expect(q.options.map((o) => o.label)).toEqual(["OK"]);
  });
});

describe("effectiveAnswer — la réponse libre remplace ou complète", () => {
  const simple = question("Q1");
  const multi = question("Q2", { multiSelect: true });

  it("choix unique : la réponse libre REMPLACE le choix coché", () => {
    expect(effectiveAnswer(simple, { Q1: "A" }, { Q1: "ma réponse" })).toBe("ma réponse");
  });

  it("choix multiple : la réponse libre S'AJOUTE aux choix cochés", () => {
    expect(effectiveAnswer(multi, { Q2: "A ; B" }, { Q2: "et autre chose" })).toBe("A ; B ; et autre chose");
  });

  it("la CLÉ PRÉSENTE vide signifie « réponse libre ouverte », pas « rien »", () => {
    // Choix unique, champ libre ouvert mais vide : la réponse est vide,
    // les choix cochés ne reviennent pas en douce.
    expect(effectiveAnswer(simple, { Q1: "A" }, { Q1: "  " })).toBe("");
    // Sans la clé : les choix cochés valent.
    expect(effectiveAnswer(simple, { Q1: "A" }, {})).toBe("A");
  });

  it("effectiveAnswers omet les questions restées sans réponse", () => {
    const reponses = effectiveAnswers([simple, multi], { Q1: "A" }, {});
    expect(reponses).toEqual({ Q1: "A" });
  });
});

describe("isPicked — un label n'est coché que dans SA question", () => {
  it("choix unique : égalité stricte", () => {
    expect(isPicked("A", "A", false)).toBe(true);
    expect(isPicked("AB", "A", false)).toBe(false);
  });

  it("choix multiple : appartenance à la liste, pas sous-chaîne", () => {
    expect(isPicked("A ; B", "A", true)).toBe(true);
    expect(isPicked("AB ; C", "A", true)).toBe(false);
  });

  it("aucune réponse : rien n'est coché", () => {
    expect(isPicked(undefined, "A", true)).toBe(false);
  });
});

describe("composeAskMessage — ce que l'agent reçoit", () => {
  it("une seule question : la réponse brute, comportement historique", () => {
    expect(composeAskMessage([question("Q1")], { Q1: "SQLite" })).toBe("SQLite");
  });

  it("plusieurs questions : chaque réponse est rattachée à son en-tête", () => {
    const message = composeAskMessage(
      [question("Quelle base ?", { header: "Base" }), question("Quel port ?")],
      { "Quelle base ?": "SQLite", "Quel port ?": "5432" },
    );
    expect(message).toBe("Base : SQLite\nQuel port ? : 5432");
  });

  it("aucune réponse : chaîne vide, l'appelant sait qu'il n'y a rien à envoyer", () => {
    expect(composeAskMessage([question("Q1")], {})).toBe("");
  });
});

describe("permissionTitle", () => {
  const item = (toolName: string, toolInput: unknown = {}) => ({
    targetId: "t",
    permissionId: "p",
    toolName,
    toolInput,
    engine: "claude" as const,
  });

  it("nomme le fichier pour les outils d'écriture, moteur Claude comme neutre", () => {
    expect(permissionTitle(item("Edit", { file_path: "src/a.ts" }))).toBe("Modifier src/a.ts");
    expect(permissionTitle(item("write_file", { file_path: "b.md" }))).toBe("Créer/écraser b.md");
  });

  it("une question d'agent n'est pas présentée comme une permission", () => {
    expect(permissionTitle(item("mcp__studio__ask_user"))).toBe("Question de l'agent");
  });

  it("outil inconnu : question générique, jamais de plantage sur l'input", () => {
    expect(permissionTitle(item("OutilMystere", null))).toBe("Autoriser OutilMystere ?");
  });
});
