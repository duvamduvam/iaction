/*
 * Slash-commands/skills invocables d'un projet (menu « / » du composeur) —
 * feuille pure : lecture défensive de la réponse `claude.commands`, sans
 * importer le client sidecar (qui s'abonne aux événements Tauri au chargement).
 */

/** Un slash-command/skill invocable pour un projet (voir docs/protocol.md, `claude.commands`). */
export interface SlashCommandInfo {
  name: string;
  description: string;
  argumentHint: string;
  aliases?: string[];
}

export function toSlashCommandInfo(value: unknown): SlashCommandInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name) return null;
  const info: SlashCommandInfo = {
    name: v.name,
    description: typeof v.description === "string" ? v.description : "",
    argumentHint: typeof v.argumentHint === "string" ? v.argumentHint : "",
  };
  if (Array.isArray(v.aliases)) {
    const aliases = v.aliases.filter((a): a is string => typeof a === "string" && a.length > 0);
    if (aliases.length > 0) info.aliases = aliases;
  }
  return info;
}

/** Réponse `claude.commands` → liste de commandes valides (entrées malformées écartées, jamais d'exception). */
export function parseCommandesSlash(data: Record<string, unknown>): SlashCommandInfo[] {
  if (!Array.isArray(data.commands)) return [];
  const out: SlashCommandInfo[] = [];
  for (const raw of data.commands) {
    const info = toSlashCommandInfo(raw);
    if (info) out.push(info);
  }
  return out;
}
