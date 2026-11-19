/* Message glissé pendant un tour (S3) — bulle close, tâches de fond transférées (T-222). */
import { describe, expect, it } from "vitest";
import type { AgentTurn } from "./agentTurns";
import { avecMessageInjecte } from "./injectionEnCoursDeTour";

const taches = { count: 1, descriptions: ["sous-agent"], waiting: true };
const ids = { utilisateur: "u2", assistant: "a2" };

describe("avecMessageInjecte", () => {
  it("clôt la bulle en cours et transfère ses tâches de fond à la nouvelle (T-222)", () => {
    const prev: AgentTurn[] = [{ id: "a1", role: "assistant", blocks: [], status: "streaming", backgroundTasks: taches }];
    const out = avecMessageInjecte(prev, "a1", ids, "stop");
    expect(out.map((t) => t.id)).toEqual(["a1", "u2", "a2"]);
    expect(out[0]).toMatchObject({ status: "done", continued: true });
    expect(out[0].backgroundTasks).toBeUndefined();
    expect(out[1]).toMatchObject({ role: "user", content: "stop", injected: true });
    expect(out[2]).toMatchObject({ status: "streaming", suiteDeTour: true, backgroundTasks: taches });
  });

  it("ne touche pas une bulle déjà close, et n'invente pas de tâches", () => {
    const prev: AgentTurn[] = [{ id: "a1", role: "assistant", blocks: [], status: "done" }];
    const out = avecMessageInjecte(prev, "a1", ids, "suite");
    expect(out[0]).toBe(prev[0]);
    expect(out[2].backgroundTasks).toBeUndefined();
    expect(out[1].attachments).toBeUndefined();
  });
});
