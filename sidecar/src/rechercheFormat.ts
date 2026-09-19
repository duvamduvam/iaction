/*
 * Rendu textuel des résultats d'une recherche dans les connaissances
 * indexées (RAG local, voir knowledge.ts) — le texte porté par le
 * tool_result que reçoit le modèle, commun aux deux moteurs (moteur neutre
 * via `searchKnowledge`/`formatSearchResults`, MCP in-process du moteur
 * Claude via `buildKnowledgeMcpServer`).
 *
 * Sorti de knowledge.ts (cliquet de taille, T-115) : cette mise en forme ne
 * dépend que du type `SearchResult` — aucun couplage avec l'indexation, la
 * recherche elle-même ou les serveurs MCP qui consomment le résultat.
 */
import type { SearchResult } from "./knowledge.js";

/**
 * Âge de l'index en français : « Index construit le 02/09/2026 (il y a 3 j) »,
 * `""` si `builtAt` est absent/illisible (index forgé à la main sans ce champ,
 * spec §5.4 — la ligne d'âge est alors simplement omise, jamais fausse).
 */
function formatIndexAge(builtAt: string): string {
  const date = new Date(builtAt);
  if (Number.isNaN(date.getTime())) return "";
  const jours = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
  return `Index construit le ${date.toLocaleDateString("fr-FR")} (il y a ${jours} j)`;
}

/**
 * Rendu textuel des résultats, commun aux deux moteurs (tool_result lisible
 * par le modèle) — T-115 : la ligne d'âge en tête répond au constat qu'un
 * agent (comme l'utilisateur) ne peut pas juger la fraîcheur d'une réponse
 * sans savoir QUAND l'index a été construit, ni si des sources ont bougé
 * depuis (`stale`, best-effort — voir `searchKnowledge`).
 */
export function formatSearchResults(results: SearchResult[], builtAt: string, stale: boolean): string {
  const age = formatIndexAge(builtAt);
  const header = age ? `${age}${stale ? " — sources modifiées depuis" : ""}\n\n` : "";
  if (results.length === 0) {
    return `${header}Aucun résultat dans les connaissances indexées.`;
  }
  return header + results.map((r) => `--- ${r.file} (score ${r.score}) ---\n${r.excerpt}`).join("\n\n");
}
