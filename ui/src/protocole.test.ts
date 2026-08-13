/*
 * Parseurs du protocole contre les ÉCHANTILLONS TÉMOINS.
 *
 * Les fichiers de fixtures/protocole/ sont émis par le vrai sidecar et
 * vérifiés côté émetteur par sidecar/test/temoins.test.js. Ici, la moitié UI :
 * chaque témoin passe dans son parseur, et l'extraction doit rendre `attendu`
 * au champ près. Un champ renommé casse chez l'émetteur ; un parseur qui
 * dérive casse ici. Le JSON est le point de rencontre des deux couches — la
 * revue de son diff EST la revue du contrat.
 *
 * S'y ajoutent des cas DÉFENSIFS écrits à la main : des formes que le sidecar
 * actuel n'émet pas mais que les parseurs doivent tolérer sans jeter — c'est
 * leur raison d'être.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChatDone, parseClaudeDone, parseNeutralDone } from "./protocole";

const dossier = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "protocole");

interface Temoin {
  quoi: string;
  parseur: "parseChatDone" | "parseClaudeDone" | "parseNeutralDone" | null;
  evenement: { id: string; event: string; data: Record<string, unknown> };
  attendu: unknown;
}

const PARSEURS = { parseChatDone, parseClaudeDone, parseNeutralDone } as const;

const temoins = readdirSync(dossier)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ nom: f, temoin: JSON.parse(readFileSync(path.join(dossier, f), "utf8")) as Temoin }));

describe("échantillons témoins", () => {
  it("le corpus existe et n'est pas vide", () => {
    expect(temoins.length).toBeGreaterThanOrEqual(3);
  });

  for (const { nom, temoin } of temoins) {
    if (!temoin.parseur) continue; // ex. l'événement error : pas de parseur dédié, la forme est vérifiée côté sidecar
    it(`${nom} — ${temoin.parseur} extrait l'attendu`, () => {
      const parseur = PARSEURS[temoin.parseur as keyof typeof PARSEURS];
      expect(parseur, `parseur inconnu dans ${nom} : ${temoin.parseur}`).toBeDefined();
      expect(parseur(temoin.evenement.data)).toEqual(temoin.attendu);
    });
  }
});

describe("cas défensifs — formes que le sidecar n'émet pas, à tolérer sans jeter", () => {
  it("parseChatDone : coût seul, aucun compteur de tokens — l'usage SURVIT", () => {
    // LA régression historique : exiger les deux compteurs faisait jeter
    // l'objet entier quand un fournisseur ne donnait que le coût. Le prix
    // réel du tour n'était jamais affiché, alors que le sidecar l'avait
    // transmis et enregistré.
    const extrait = parseChatDone({ finishReason: "stop", usage: { costUsd: 0.002 } });
    expect(extrait.usage).toEqual({ promptTokens: null, completionTokens: null, costUsd: 0.002, cachedTokens: null });
  });

  it("parseChatDone : usage vide ou absurde ⇒ null, pas un objet de zéros", () => {
    expect(parseChatDone({ finishReason: "stop", usage: {} }).usage).toBeNull();
    expect(parseChatDone({ usage: "n'importe quoi" }).usage).toBeNull();
    expect(parseChatDone({}).finishReason).toBe("stop");
  });

  it("parseClaudeDone : usage incomplet ⇒ null — un demi-usage fausserait les compteurs", () => {
    expect(parseClaudeDone({ sessionId: "s", usage: { inputTokens: 5 } }).usage).toBeNull();
  });

  it("parseClaudeDone : contextTokens absent ⇒ null — la jauge s'abstient, elle n'affiche pas 0 %", () => {
    const extrait = parseClaudeDone({ sessionId: "s", subtype: "success" });
    expect(extrait.contextTokens).toBeNull();
    expect(extrait.totalCostUsd).toBeNull();
  });

  it("parseNeutralDone : mêmes champs que Claude, sessionId et coût toujours null", () => {
    const extrait = parseNeutralDone({ subtype: "success", result: "ok", usage: { inputTokens: 1, outputTokens: 2 } });
    expect(extrait).toEqual({
      sessionId: null,
      subtype: "success",
      result: "ok",
      usage: { inputTokens: 1, outputTokens: 2 },
      totalCostUsd: null,
    });
  });
});
