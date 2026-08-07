/**
 * Recherche dans l'historique de l'onglet « Chat » de l'app — exposée aux
 * agents de projet par l'outil MCP `mcp__iaction__search_chat` (voir
 * knowledge.ts).
 *
 * Pourquoi ce module existe : les conversations du Chat ne vivent PAS dans le
 * projet mais dans l'état applicatif écrit par l'UI (`state_read`/`state_write`
 * côté Rust), soit
 * `${XDG_DATA_HOME ?? ~/.local/share}/net.duvam.iaction/state/chat-conversations.json`.
 * Un agent de projet a son `cwd` sur le répertoire du projet : sans cet outil,
 * il ne peut pas y accéder — d'où « je ne sais pas ce qu'est cet espace chat »
 * (constaté le 2026-08-03).
 *
 * LECTURE SEULE, et jamais de restitution intégrale : on renvoie des extraits
 * bornés autour des correspondances. C'est une recherche, pas un export.
 *
 * Forme du document (écrite par ChatPage.tsx) :
 * `{sessions: [{id, title, updatedAt, entries: [{role, content, …}]}]}`.
 * Lecture TOLÉRANTE : tout champ absent ou mal typé est ignoré, jamais une
 * exception — le fichier appartient à l'UI et peut évoluer.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { globalDataRoot } from "./appPaths.js";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Même résolution que la coquille Rust (`{app_data_dir}/state/<name>.json`). */
export function chatConversationsPath(): string {
  return path.join(globalDataRoot(), "state", "chat-conversations.json");
}

/** Caractères d'extrait rendus autour d'une correspondance (de part et d'autre). */
const EXCERPT_RADIUS = 160;
/** Extraits rendus par conversation : au-delà, c'est un export déguisé. */
const MAX_EXCERPTS_PER_CONV = 3;
/** Conversations rendues par défaut / au plus (`limit`). */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export function sanitizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/** Normalisation de comparaison : minuscules, sans accents (« daw » trouve « DAW »). */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export interface ChatSearchHit {
  title: string;
  updatedAt: string | null;
  /** Nombre total de tours contenant la recherche (peut dépasser les extraits rendus). */
  matches: number;
  excerpts: string[];
}

interface ChatEntry {
  role: string;
  content: string;
}

function readEntries(raw: unknown): ChatEntry[] {
  if (!isPlainObject(raw) || !Array.isArray(raw.entries)) {
    return [];
  }
  const out: ChatEntry[] = [];
  for (const entry of raw.entries) {
    if (isPlainObject(entry) && isNonEmptyString(entry.content)) {
      out.push({ role: isNonEmptyString(entry.role) ? entry.role : "?", content: entry.content });
    }
  }
  return out;
}

/** Extrait borné autour de la première occurrence, sauts de ligne compactés. */
function excerptAround(content: string, foldedContent: string, foldedQuery: string, role: string): string {
  const at = foldedContent.indexOf(foldedQuery);
  const from = Math.max(0, at - EXCERPT_RADIUS);
  const to = Math.min(content.length, at + foldedQuery.length + EXCERPT_RADIUS);
  const body = content.slice(from, to).replace(/\s+/g, " ").trim();
  const prefix = from > 0 ? "…" : "";
  const suffix = to < content.length ? "…" : "";
  return `[${role}] ${prefix}${body}${suffix}`;
}

export type ChatSearchOutcome =
  | { ok: true; hits: ChatSearchHit[]; scanned: number }
  | { ok: false; message: string };

/**
 * Cherche `query` (sous-chaîne, insensible à la casse et aux accents) dans les
 * conversations du Chat. Trie les conversations par nombre de correspondances
 * décroissant. Fichier absent (aucune conversation encore) → `ok: false` avec
 * un message explicite : c'est une information utile pour l'agent, pas une
 * panne.
 */
export async function searchChatHistory(query: string, limit: number): Promise<ChatSearchOutcome> {
  const needle = fold(query.trim());
  if (needle.length === 0) {
    return { ok: false, message: "recherche vide" };
  }

  let raw: string;
  try {
    raw = await fsp.readFile(chatConversationsPath(), "utf8");
  } catch {
    return { ok: false, message: "aucun historique de Chat sur ce poste (fichier d'état absent)" };
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, message: "historique de Chat illisible (JSON invalide)" };
  }
  if (!isPlainObject(doc) || !Array.isArray(doc.sessions)) {
    return { ok: false, message: "historique de Chat vide ou de forme inattendue" };
  }

  const hits: ChatSearchHit[] = [];
  for (const session of doc.sessions) {
    const entries = readEntries(session);
    if (entries.length === 0) {
      continue;
    }
    const excerpts: string[] = [];
    let matches = 0;
    for (const entry of entries) {
      const folded = fold(entry.content);
      if (!folded.includes(needle)) {
        continue;
      }
      matches += 1;
      if (excerpts.length < MAX_EXCERPTS_PER_CONV) {
        excerpts.push(excerptAround(entry.content, folded, needle, entry.role));
      }
    }
    if (matches === 0) {
      continue;
    }
    const meta = isPlainObject(session) ? session : {};
    hits.push({
      title: isNonEmptyString(meta.title) ? meta.title : "(sans titre)",
      updatedAt: isNonEmptyString(meta.updatedAt) ? meta.updatedAt : null,
      matches,
      excerpts,
    });
  }

  hits.sort((a, b) => b.matches - a.matches);
  return { ok: true, hits: hits.slice(0, limit), scanned: doc.sessions.length };
}

/** Rendu texte pour l'outil MCP (le modèle lit ça tel quel). */
export function formatChatSearchResults(outcome: { hits: ChatSearchHit[]; scanned: number }): string {
  if (outcome.hits.length === 0) {
    return `Aucune conversation du Chat ne correspond (${outcome.scanned} conversation(s) parcourue(s)).`;
  }
  const blocks = outcome.hits.map((hit) => {
    const date = hit.updatedAt ? ` — ${hit.updatedAt.slice(0, 10)}` : "";
    const lines = hit.excerpts.map((e) => `  ${e}`).join("\n");
    return `### ${hit.title}${date} (${hit.matches} tour(s) correspondant(s))\n${lines}`;
  });
  return `${outcome.hits.length} conversation(s) du Chat sur ${outcome.scanned} parcourue(s) :\n\n${blocks.join("\n\n")}`;
}
