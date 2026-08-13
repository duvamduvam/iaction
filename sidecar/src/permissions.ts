/*
 * Registre des permissions d'outils — côté sidecar (étape 11).
 *
 * ── La carte complète, pour qu'un correctif ne s'écrive qu'UNE fois ──────
 * Le relevé du 2026-08-09 a trouvé la logique de permission écrite à cinq
 * endroits. Ce module rassemble ce qui est UNIFIABLE et documente ce qui
 * diverge VOLONTAIREMENT :
 *
 * 1. Moteur NEUTRE (neutralAgent.ts) : la règle mode × outil est À NOUS —
 *    c'est `needsPermission` ci-dessous, fixée par le tableau normatif de
 *    docs/protocol.md (§ moteur neutre) et ses tests.
 * 2. Moteur CLAUDE (claude.ts, canUseTool) : la règle appartient au SDK —
 *    le sidecar ne fait que RELAYER ses demandes vers l'UI. Deux décisions
 *    locales seulement : `mcp__studio__ask_user` est auto-autorisé (la
 *    question EST l'interaction humaine), et un abort refuse tout.
 * 3. Chat pur (ChatPage) : politique d'UI assumée par docs/protocol.md —
 *    accord auto WebSearch/WebFetch si l'option est cochée, refus de tout
 *    le reste. Volontairement PAS dans ce registre.
 * 4. Orchestration : mêmes moteurs, mais `bypassPermissions` est le mode des
 *    tâches planifiées et il n'y a pas de « ne plus demander » (pas de
 *    session UI où le mémoriser). Divergences assumées.
 *
 * La règle transverse qui était copiée SEPT fois : le mode « plan » n'existe
 * pas côté moteur neutre — `normaliserModePourMoteur` est désormais l'unique
 * endroit qui la connaît (le pendant UI vit dans ui/src/permissions.ts,
 * même contrat, les deux couches ne partagent pas de code).
 */

/** Modes que le moteur neutre exécute réellement (docs/protocol.md § chat.send/neutral.start). */
export type PermissionModeNeutre = "default" | "acceptEdits" | "bypassPermissions";

export type PermissionMode = PermissionModeNeutre | "plan";

/**
 * La règle mode × outil du moteur neutre. Les contrats qui comptent :
 * `acceptEdits` libère les écritures mais JAMAIS bash (un `rm -rf` n'est pas
 * une édition), et les lectures sont toujours libres.
 */
export function needsPermission(toolName: string, mode: PermissionModeNeutre): boolean {
  if (mode === "bypassPermissions") {
    return false;
  }
  if (mode === "acceptEdits") {
    return toolName === "bash";
  }
  return toolName === "write_file" || toolName === "edit_file" || toolName === "bash";
}

/**
 * Le mode « plan » n'existe pas côté moteur neutre : replié sur `default`
 * (le plus restrictif des modes neutres). Pour le moteur claude, le mode
 * passe tel quel — c'est le SDK qui l'interprète.
 */
export function normaliserModePourMoteur(mode: PermissionMode, engine: "claude" | "neutral"): PermissionMode {
  return engine === "neutral" && mode === "plan" ? "default" : mode;
}

/**
 * Coercition d'entrée du moteur neutre : toute valeur inconnue (dont `plan`,
 * dont l'absence) retombe sur `default` — jamais une erreur, jamais un mode
 * plus permissif que demandé.
 */
export function versModeNeutre(value: unknown): PermissionModeNeutre {
  return value === "acceptEdits" || value === "bypassPermissions" ? value : "default";
}
