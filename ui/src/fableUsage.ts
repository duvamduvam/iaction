/*
 * Compteur LOCAL de consommation du modèle Fable sur 7 jours glissants.
 * L'API d'abonnement n'expose pas (encore) de fenêtre hebdo par modèle : on
 * mesure donc côté app les tokens (entrée + sortie) des tours Claude joués
 * ICI, persistés via le state store ("fable-usage-week"). Indicatif — ne
 * couvre pas Claude Code ni d'autres clients du même abonnement. Le jour où
 * l'API expose une fenêtre par modèle, le camembert officiel prendra le
 * relais (relais générique `windows`, voir docs/protocol.md § usage.claude).
 */
import { stateRead, stateWrite } from "./stateClient";

const STATE_NAME = "fable-usage-week";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface FableEntry {
  t: number;
  tokens: number;
}

function isFableModel(model: string | null | undefined): boolean {
  return typeof model === "string" && /fable/i.test(model);
}

function pruneEntries(entries: unknown, now: number): FableEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e): e is FableEntry =>
      !!e && typeof e.t === "number" && typeof e.tokens === "number" && now - e.t < WEEK_MS,
  );
}

/** Enregistre un tour si (et seulement si) le modèle est de la famille Fable. Ne rejette jamais. */
export async function recordModelUsage(
  model: string | null | undefined,
  usage: { inputTokens?: number | null; outputTokens?: number | null } | null | undefined,
): Promise<void> {
  if (!isFableModel(model) || !usage) return;
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (tokens <= 0) return;
  try {
    const raw = await stateRead<{ entries?: unknown }>(STATE_NAME);
    const now = Date.now();
    const entries = pruneEntries(raw.entries, now);
    entries.push({ t: now, tokens });
    await stateWrite(STATE_NAME, { entries });
  } catch {
    /* best effort : le compteur est purement indicatif */
  }
}

/** Total de tokens Fable sur les 7 derniers jours (0 si rien/erreur). */
export async function readFableWeekTokens(): Promise<number> {
  try {
    const raw = await stateRead<{ entries?: unknown }>(STATE_NAME);
    const now = Date.now();
    return pruneEntries(raw.entries, now).reduce((sum, e) => sum + e.tokens, 0);
  } catch {
    return 0;
  }
}

/** Format compact : 1 234 → « 1,2 ktok », 2 345 678 → « 2,3 Mtok ». */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(".", ",")} Mtok`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(".", ",")} ktok`;
  return `${tokens} tok`;
}
