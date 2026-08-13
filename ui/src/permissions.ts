/*
 * Registre des permissions d'outils — côté interface (étape 11).
 *
 * Pendant UI de sidecar/src/permissions.ts (les deux couches ne partagent
 * pas de code — une seule adresse par couche, même contrat). Ce que l'UI
 * possède en propre :
 *
 * - la liste des modes offerts au sélecteur (Projets et Orchestration
 *   affichaient chacun leur copie) ;
 * - le repli « plan n'existe pas côté neutre » appliqué au moment d'ENVOYER
 *   (envoiProjet.ts) — les sélecteurs, eux, EMPÊCHENT l'état en amont ;
 * - la clé du « ne plus demander » (auto-autorisation d'un outil). Elle est
 *   PAR PROJET depuis le 2026-08-09 : mémorisée par nom d'outil nu, une
 *   autorisation « Bash » consentie sur un projet s'appliquait en silence à
 *   tous les autres — exactement la classe de correctif que ce registre
 *   existe pour n'écrire qu'une fois.
 *
 * Ce que ce registre ne décide PAS (divergences voulues, voir le pendant
 * sidecar) : la règle mode × outil du moteur neutre (sidecar), celle du
 * moteur claude (le SDK), et la politique du chat pur (refus de tout sauf
 * WebSearch/WebFetch — convention d'UI assumée par docs/protocol.md).
 */

import type { PermissionMode } from "./sidecar";

/** Modes offerts par les sélecteurs (Projets, Orchestration). */
export const PERMISSION_MODE_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Demander (défaut)" },
  { value: "acceptEdits", label: "Éditions auto-acceptées" },
  { value: "plan", label: "Plan (lecture seule)" },
  { value: "bypassPermissions", label: "⚠ Autonome (aucune validation)" },
];

/** Le mode « plan » n'existe pas côté moteur neutre : replié sur `default`.
 * Les surcharges disent au typage ce que la règle garantit : pour le moteur
 * neutre, le résultat ne peut JAMAIS être « plan ». */
export function normaliserModePourMoteur(mode: PermissionMode, engine: "neutral"): Exclude<PermissionMode, "plan">;
export function normaliserModePourMoteur(mode: PermissionMode, engine: "claude" | "neutral"): PermissionMode;
export function normaliserModePourMoteur(mode: PermissionMode, engine: "claude" | "neutral"): PermissionMode {
  return engine === "neutral" && mode === "plan" ? "default" : mode;
}

/**
 * Clé du « ne plus demander » — projet + outil, jamais l'outil seul.
 * Le séparateur NUL ne peut apparaître ni dans un id de projet ni dans un
 * nom d'outil : pas de collision par concaténation.
 */
export function cleAutoAllow(projectId: string | null, toolName: string): string {
  return `${projectId ?? ""}\u0000${toolName}`;
}
