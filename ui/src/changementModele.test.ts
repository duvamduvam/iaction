/*
 * L'agent change lui-même de modèle (T-207) — logique pure du bandeau et des
 * sélecteurs. Aucun rendu : on simule les deux sélecteurs par un objet
 * `ChoixModele`, comme AgentPage les tient dans deux états.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentTurn } from "./agentTurns";
import {
  changementDepuisChunk,
  choixApresAnnulation,
  choixApresChangement,
  effortPourAnnulation,
  libelleEffort,
  libelleModele,
  morceauxBandeau,
  withChangementAnnule,
  withChangementModele,
  type ChoixModele,
} from "./changementModele";
import { IDS_ABONNEMENT_CLAUDE } from "./modelesAbonnementClaude";
import type { ModelChangeData } from "./protocole";

const CHUNK: ModelChangeData = {
  from: "claude-fable-5-1",
  to: "claude-opus-5-5",
  effortFrom: "high",
  effortTo: "medium",
  raison: "Travail courant : la spec est fermée",
};

const tour = (id: string): AgentTurn => ({ id, role: "assistant", status: "streaming", blocks: [] });

describe("réception du chunk model_change", () => {
  it("le sélecteur Modèle et le sélecteur Effort prennent les valeurs d'arrivée", () => {
    const changement = changementDepuisChunk(CHUNK, "claude-fable-5-1");
    expect(changement).not.toBeNull();
    const avant: ChoixModele = { model: "claude-fable-5-1", effort: "high" };
    const apres = choixApresChangement(changement!);
    expect(avant).toEqual({ model: "claude-fable-5-1", effort: "high" });
    expect(apres).toEqual({ model: "claude-opus-5-5", effort: "medium" });
  });

  it("effort inchangé par l'agent ⇒ le sélecteur garde le sien", () => {
    const changement = changementDepuisChunk({ ...CHUNK, effortTo: "high" }, null)!;
    expect(choixApresChangement(changement).effort).toBe("high");
  });

  it("modèle d'avant inconnu du sidecar ⇒ repli sur le modèle envoyé au départ du tour", () => {
    const changement = changementDepuisChunk({ ...CHUNK, from: null }, "claude-sonnet-5-5");
    expect(changement?.from).toBe("claude-sonnet-5-5");
  });

  it("aucun modèle d'avant connu nulle part ⇒ pas de bandeau (Annuler n'aurait rien à remettre)", () => {
    expect(changementDepuisChunk({ ...CHUNK, from: null }, null)).toBeNull();
  });

  it("un effort que le nouveau modèle ne supporte pas retombe sur Défaut", () => {
    const changement = changementDepuisChunk({ ...CHUNK, to: "modele-inconnu", effortTo: "max" }, null)!;
    expect(choixApresChangement(changement)).toEqual({ model: "modele-inconnu", effort: "" });
  });

  it("le changement est posé sur LE tour visé, pas sur les autres", () => {
    const changement = changementDepuisChunk(CHUNK, null)!;
    const tours = withChangementModele([tour("a1"), tour("a2")], "a2", changement);
    expect(tours[0].changementModele).toBeUndefined();
    expect(tours[1].changementModele).toEqual(changement);
  });
});

describe("Annuler", () => {
  it("remet modèle ET effort d'avant dans les sélecteurs", () => {
    const changement = changementDepuisChunk(CHUNK, null)!;
    const apresReception = choixApresChangement(changement);
    expect(apresReception).toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(choixApresAnnulation(changement)).toEqual({ model: "claude-fable-5-1", effort: "high" });
  });

  it("effort d'avant = Défaut ⇒ le sélecteur revient sur Défaut", () => {
    const changement = changementDepuisChunk({ ...CHUNK, effortFrom: null }, null)!;
    expect(choixApresAnnulation(changement).effort).toBe("");
  });

  it("marque le bandeau annulé sans toucher aux autres tours", () => {
    const changement = changementDepuisChunk(CHUNK, null)!;
    const tours = withChangementModele([tour("a1"), tour("a2")], "a1", changement);
    const annules = withChangementAnnule(tours, "a1");
    expect(annules[0].changementModele?.annule).toBe(true);
    expect(annules[1].changementModele).toBeUndefined();
  });

  it("argument effort de claude.setModel : inchangé / défaut / niveau d'avant", () => {
    const base = changementDepuisChunk(CHUNK, null)!;
    expect(effortPourAnnulation(base)).toBe("high");
    expect(effortPourAnnulation({ ...base, effortFrom: "" })).toBeNull();
    expect(effortPourAnnulation({ ...base, effortTo: "high" })).toBeUndefined();
  });
});

describe("libellés du bandeau", () => {
  it("modèle : « Opus 5.5 », « Fable 5.1 », identifiant inconnu tel quel", () => {
    expect(libelleModele("claude-opus-5-5")).toBe("Opus 5.5");
    expect(libelleModele("claude-fable-5-1")).toBe("Fable 5.1");
    expect(libelleModele("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(libelleModele("gpt-5")).toBe("gpt-5");
  });

  it("effort : en français", () => {
    expect(libelleEffort("medium")).toBe("moyen");
    expect(libelleEffort("")).toBe("par défaut");
  });

  it("« L'agent est passé à Opus 5.5 · effort moyen — raison »", () => {
    const m = morceauxBandeau(changementDepuisChunk(CHUNK, null)!);
    expect(m).toEqual({ modele: "Opus 5.5", effort: "effort moyen", raison: "Travail courant : la spec est fermée" });
  });

  it("effort ni posé ni changé ⇒ pas de mention", () => {
    const m = morceauxBandeau(changementDepuisChunk({ ...CHUNK, effortFrom: null, effortTo: null }, null)!);
    expect(m.effort).toBeNull();
  });
});

describe("liste des modèles du sidecar", () => {
  it("MODELES_CHANGEABLES (sidecar) = MODELES_ABONNEMENT_CLAUDE (UI) — une liste recopiée est une liste oubliée (T-046)", () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "sidecar", "src", "changerModele.ts"),
      "utf8",
    );
    const bloc = /MODELES_CHANGEABLES = \[([\s\S]*?)\] as const/.exec(source)?.[1] ?? "";
    const ids = [...bloc.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(IDS_ABONNEMENT_CLAUDE);
  });
});
