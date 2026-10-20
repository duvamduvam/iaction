/**
 * Recherche dans l'historique de l'onglet « Chat » de l'app — exposée aux
 * agents de projet par l'outil MCP `mcp__iaction__search_chat` (voir
 * knowledge.ts).
 *
 * Pourquoi ce module existe : les conversations du Chat ne vivent PAS dans le
 * projet mais dans l'état applicatif écrit par l'UI (`state_read`/`state_write`
 * côté Rust), soit
 * `${XDG_DATA_HOME ?? ~/.local/share}/net.duvam.iaction/state/`.
 * Un agent de projet a son `cwd` sur le répertoire du projet : sans cet outil,
 * il ne peut pas y accéder — d'où « je ne sais pas ce qu'est cet espace chat »
 * (constaté le 2026-08-03).
 *
 * LECTURE SEULE, et jamais de restitution intégrale : on renvoie des extraits
 * bornés autour des correspondances. C'est une recherche, pas un export.
 *
 * Forme des données depuis T-061 (voir ui/src/etatEclate.ts) : le monolithe
 * `chat-conversations.json` a été ÉCLATÉ en un fichier par conversation,
 * `state/chatconv-<id>.json`, dont chacun a la même forme qu'un élément de
 * `sessions` du monolithe : `{id, title, updatedAt, entries: [{role,
 * content, …}], …}`. `state/chat-index.json` existe à côté mais n'énumère PAS
 * les conversations — il ne porte que `{activeId, openConversationIds}` — donc
 * il ne sert à rien ici : on LISTE le répertoire (`chatconv-*.json`).
 *
 * REPLI : si aucun fichier éclaté n'existe (poste jamais migré), on relit
 * l'ancien monolithe — laissé en place sous ce même nom par les postes qui
 * n'ont pas encore ouvert l'UI depuis T-061.
 *
 * Lecture TOLÉRANTE dans les deux cas : tout champ absent ou mal typé est
 * ignoré, un fichier illisible ou un JSON invalide est SAUTÉ sans faire
 * échouer la recherche — le fichier appartient à l'UI et peut évoluer.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { isNonEmptyString, isPlainObject } from "./base.js";
import { globalDataRoot } from "./appPaths.js";


/** Préfixe des fichiers de conversation éclatés (même valeur que `PREFIXE_CHAT_CONV` côté UI). */
const PREFIXE_CHAT_CONV = "chatconv-";

/** Répertoire d'état, commun aux deux formes (éclatée et monolithe). */
function chatStateDir(): string {
  return path.join(globalDataRoot(), "state");
}

/** Même résolution que la coquille Rust (`{app_data_dir}/state/<name>.json`). */
export function chatConversationsPath(): string {
  return path.join(chatStateDir(), "chat-conversations.json");
}

/** Chemins des fichiers `chatconv-*.json` présents, ou tableau vide si le répertoire n'existe pas encore. */
async function listerFichiersEclates(): Promise<string[]> {
  let entrees: string[];
  try {
    entrees = await fsp.readdir(chatStateDir());
  } catch {
    return [];
  }
  return entrees
    .filter((nom) => nom.startsWith(PREFIXE_CHAT_CONV) && nom.endsWith(".json"))
    .map((nom) => path.join(chatStateDir(), nom));
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
 * Correspondances d'UNE conversation (forme commune au monolithe et aux
 * fichiers éclatés — un élément de `sessions` ou un `chatconv-*.json`), ou
 * `null` si rien ne correspond.
 */
function scanSession(raw: unknown, needle: string): ChatSearchHit | null {
  const entries = readEntries(raw);
  if (entries.length === 0) {
    return null;
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
    return null;
  }
  const meta = isPlainObject(raw) ? raw : {};
  return {
    title: isNonEmptyString(meta.title) ? meta.title : "(sans titre)",
    updatedAt: isNonEmptyString(meta.updatedAt) ? meta.updatedAt : null,
    matches,
    excerpts,
  };
}

/** Lit et parse un fichier JSON ; `null` sans exception si illisible ou invalide (fichier sauté). */
async function lireJsonTolerant(filePath: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Recherche dans les fichiers éclatés (`chatconv-*.json`), un par conversation. */
async function chercherDansFichiersEclates(fichiers: string[], needle: string): Promise<{ hits: ChatSearchHit[]; scanned: number }> {
  const hits: ChatSearchHit[] = [];
  let scanned = 0;
  for (const fichier of fichiers) {
    const doc = await lireJsonTolerant(fichier);
    if (doc === null) {
      continue; // fichier illisible ou JSON invalide : sauté, la recherche continue.
    }
    scanned += 1;
    const hit = scanSession(doc, needle);
    if (hit) {
      hits.push(hit);
    }
  }
  return { hits, scanned };
}

/**
 * Cherche `query` (sous-chaîne, insensible à la casse et aux accents) dans les
 * conversations du Chat. Trie les conversations par nombre de correspondances
 * décroissant. Aucune conversation trouvée nulle part (ni fichiers éclatés, ni
 * monolithe) → `ok: false` avec un message explicite : c'est une information
 * utile pour l'agent, pas une panne.
 */
export async function searchChatHistory(query: string, limit: number): Promise<ChatSearchOutcome> {
  const needle = fold(query.trim());
  if (needle.length === 0) {
    return { ok: false, message: "recherche vide" };
  }

  // Forme éclatée (depuis T-061) : un fichier par conversation.
  const fichiersEclates = await listerFichiersEclates();
  if (fichiersEclates.length > 0) {
    const { hits, scanned } = await chercherDansFichiersEclates(fichiersEclates, needle);
    hits.sort((a, b) => b.matches - a.matches);
    return { ok: true, hits: hits.slice(0, limit), scanned };
  }

  // Repli : poste jamais migré, le monolithe est encore la seule source.
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
    const hit = scanSession(session, needle);
    if (hit) {
      hits.push(hit);
    }
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
