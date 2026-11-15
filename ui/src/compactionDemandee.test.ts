/*
 * T-216 — l'agent programme le compactage : la file (« /compact », jamais en
 * double) et l'avis « … il partira à la fin du tour · Annuler ».
 */
import { describe, expect, it } from "vitest";
import type { AgentTurn } from "./agentTurns";
import {
  annulerCompactionDemandee,
  avecCompactEnFile,
  avecCompactionDemandee,
  COMMANDE_COMPACT,
  indexCompactionAnnulable,
} from "./compactionDemandee";

function runtime(queuedPrompts: string[] = [], turns: AgentTurn[] = []) {
  return { queuedPrompts, turns, autre: "inchangé" };
}

const tourUtilisateur = (id: string, content: string): AgentTurn => ({ id, role: "user", content, status: "done" });
const bulle = (id: string, extra: Partial<AgentTurn> = {}): AgentTurn => ({ id, role: "assistant", status: "done", ...extra });

describe("mise en file de « /compact »", () => {
  it("ajoute « /compact » en fin de file, derrière les messages déjà en attente", () => {
    const r = avecCompactEnFile(runtime(["question"]));
    expect(r.queuedPrompts).toEqual(["question", COMMANDE_COMPACT]);
    expect(r.autre).toBe("inchangé");
  });

  it("déjà en file ⇒ aucun doublon, et le runtime est rendu tel quel", () => {
    const avant = runtime([COMMANDE_COMPACT, "suite"]);
    expect(avecCompactEnFile(avant)).toBe(avant);
  });
});

describe("réception du chunk compaction_demandee", () => {
  it("pose la demande sur la bulle visée et met « /compact » en file", () => {
    const r = avecCompactionDemandee(runtime([], [tourUtilisateur("u1", "go"), bulle("a1")]), "a1", "contexte lourd");
    expect(r.queuedPrompts).toEqual([COMMANDE_COMPACT]);
    expect(r.turns[1].compactionDemandee).toEqual({ raison: "contexte lourd" });
    expect(r.turns[0].compactionDemandee).toBeUndefined();
  });

  it("deux demandes (outil appelé deux fois, ou bouton puis outil) ⇒ un seul « /compact » en file", () => {
    let r = avecCompactEnFile(runtime([], [bulle("a1")])); // bouton « Compacter » pendant le tour
    r = avecCompactionDemandee(r, "a1", "une");
    r = avecCompactionDemandee(r, "a1", "deux");
    expect(r.queuedPrompts).toEqual([COMMANDE_COMPACT]);
    expect(r.turns[0].compactionDemandee?.raison).toBe("deux");
  });
});

describe("« Annuler »", () => {
  it("retire « /compact » de la file sans toucher aux autres messages, et marque l'avis annulé", () => {
    const r0 = avecCompactionDemandee(runtime(["question"], [bulle("a1")]), "a1", "r");
    const r = annulerCompactionDemandee(r0, "a1");
    expect(r.queuedPrompts).toEqual(["question"]);
    expect(r.turns[0].compactionDemandee).toEqual({ raison: "r", annule: true });
  });

  it("n'invente pas d'avis sur une bulle qui n'en portait pas", () => {
    const r = annulerCompactionDemandee(runtime([COMMANDE_COMPACT], [bulle("a1")]), "a1");
    expect(r.turns[0].compactionDemandee).toBeUndefined();
    expect(r.queuedPrompts).toEqual([]);
  });
});

describe("la seule bulle qui porte « Annuler »", () => {
  it("la dernière demande non annulée", () => {
    const turns = [bulle("a1", { compactionDemandee: { raison: "vieille" } }), tourUtilisateur("u2", "x"), bulle("a2", { compactionDemandee: { raison: "récente" } })];
    expect(indexCompactionAnnulable(turns)).toBe(2);
  });

  it("aucune si la dernière demande a été annulée — une demande plus ancienne ne reprend pas le bouton", () => {
    const turns = [bulle("a1", { compactionDemandee: { raison: "vieille" } }), bulle("a2", { compactionDemandee: { raison: "r", annule: true } })];
    expect(indexCompactionAnnulable(turns)).toBe(-1);
  });

  it("aucune une fois un tour « /compact » parti après la demande (elle est servie)", () => {
    const turns = [bulle("a1", { compactionDemandee: { raison: "r" } }), tourUtilisateur("u2", COMMANDE_COMPACT), bulle("a2")];
    expect(indexCompactionAnnulable(turns)).toBe(-1);
  });

  it("aucune sans demande", () => {
    expect(indexCompactionAnnulable([tourUtilisateur("u1", "x"), bulle("a1")])).toBe(-1);
  });
});
