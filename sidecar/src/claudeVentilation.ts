/*
 * T-066 — ventilation d'un tour Claude par modèle réellement appelé.
 *
 * Sortie de claude.ts pour la même raison que claudeSessionTitles/claudeUsage
 * avant elle : le cliquet de taille refuse la croissance du fichier, et
 * découper est la réponse attendue. Feuille PURE — aucune E/S, aucun état,
 * testable sans faux SDK (voir test/claudePur.test.js).
 */
import { isNonEmptyString, isPlainObject } from "./base.js";

/** T-066 — une ligne de ventilation : ce qu'UN modèle a consommé dans le tour. */
export interface ModelVentilation {
  model: string;
  /** `inconnu` quand le modèle du fil n'a pas été annoncé — jamais deviné. */
  role: "fil" | "delegue" | "inconnu";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  contextWindow: number | null;
}

/**
 * T-066 — ventilation par modèle RÉELLEMENT appelé pendant le tour.
 *
 * ── Ce qui manquait, et pourquoi ça trompait ────────────────────────────
 * Un tour n'émet qu'UN événement d'usage, portant `lastModel` et le cumul de
 * tokens du process ENTIER. Quand le tour délègue (outil Agent du SDK), le
 * travail des sous-agents est bien compté — mais rangé sous le modèle du fil.
 * La page Supervision ne ratait donc pas la délégation : elle la déguisait en
 * opus. `modelUsage` du message `result` porte exactement ce qui manque
 * (tokens, cache, coût et fenêtre PAR modèle), et était parsé puis jeté.
 *
 * ⚠ LIMITE ASSUMÉE. `modelUsage` est indexé par MODÈLE, pas par agent : un
 * sous-agent tournant sur le même modèle que le fil est indiscernable et
 * compte comme `fil`. La part déléguée est donc un MINORANT, et le dire vaut
 * mieux que de laisser lire un chiffre exact qui ne l'est pas (même règle que
 * T-035). Elle deviendra exacte quand les sous-agents seront déclarés avec
 * leur propre modèle via l'option `agents` du SDK — ce qui est le but.
 *
 * ⚠ Le SDK expose ce champ en camelCase, contrairement à `usage`
 * (snake_case) : les deux formes coexistent, ne pas uniformiser à l'aveugle.
 */
export function extractModelUsage(raw: unknown, modelDuFil: string | null): ModelVentilation[] {
  if (!isPlainObject(raw)) {
    return [];
  }
  const nombre = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const optionnel = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const out: ModelVentilation[] = [];
  for (const [model, valeur] of Object.entries(raw as Record<string, unknown>)) {
    if (!isNonEmptyString(model) || !isPlainObject(valeur)) {
      continue;
    }
    out.push({
      model,
      // Aucune devinette : sans modèle de fil annoncé, le rôle reste `inconnu`
      // et l'agrégat le comptera à part (leçon T-023).
      role: modelDuFil === null ? "inconnu" : model === modelDuFil ? "fil" : "delegue",
      inputTokens: nombre(valeur.inputTokens),
      outputTokens: nombre(valeur.outputTokens),
      cacheReadTokens: nombre(valeur.cacheReadInputTokens),
      cacheCreationTokens: nombre(valeur.cacheCreationInputTokens),
      costUsd: optionnel(valeur.costUSD),
      contextWindow: optionnel(valeur.contextWindow),
    });
  }
  // Ordre déterministe (le plus gros consommateur d'abord) : un JSONL relu par
  // un test ou un œil humain ne doit pas dépendre de l'ordre d'insertion.
  return out.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
}
