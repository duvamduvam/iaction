/*
 * Connaissances de projet — la logique pure, sortie d'AgentPage le 2026-08-08
 * (étape 8, 3/3 : le bloc que la clôture prématurée de l'étape avait laissé).
 *
 * Deux budgets gouvernent l'injection au premier tour : par document
 * (KNOWLEDGE_DOC_MAX_CHARS) et total (KNOWLEDGE_TOTAL_MAX_CHARS). Une fois le
 * budget total atteint, les documents suivants ne sont même plus LUS — juste
 * listés comme non injectés : promettre un document qu'on a tronqué en
 * silence ferait raisonner l'agent sur un texte qu'il n'a pas.
 *
 * Feuille : la lecture de fichier est INJECTÉE dans buildKnowledgeBlock (même
 * règle que debordNotice.ts) — le module ne touche ni Tauri ni le sidecar.
 */

export const KNOWLEDGE_STATE_KEY = "project-knowledge";
export const KNOWLEDGE_DOC_MAX_CHARS = 30_000;
export const KNOWLEDGE_TOTAL_MAX_CHARS = 120_000;

/**
 * R5 — mode RAG (docs/spec-r5-rag.md §4) : en mode `connaissances.mode: "rag"`
 * (réglage par projet, voir projectAdmin.ts), AUCUNE injection intégrale au
 * 1er tour — cette ligne système la remplace, et l'outil `search_knowledge`
 * est proposé dans les deux moteurs (palette du moteur neutre ; serveur MCP
 * in-process `mcp__iaction__search_knowledge` côté Claude, activé par le
 * sidecar quand l'index du projet existe).
 */
export const RAG_SYSTEM_LINE = "Des connaissances projet sont indexées — utilise l'outil search_knowledge.";

export interface PinnedDoc {
  path: string;
  name: string;
}

export type KnowledgeDoc = Record<string, PinnedDoc[]>;

export function isPinnedDoc(value: unknown): value is PinnedDoc {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.path === "string" && typeof v.name === "string";
}

/** Valide défensivement le document lu du disque (même esprit que `sanitizePersistedConversations`). */
export function sanitizeKnowledgeDoc(raw: unknown): KnowledgeDoc {
  if (typeof raw !== "object" || raw === null) return {};
  const out: KnowledgeDoc = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value) && value.every(isPinnedDoc)) out[id] = value;
  }
  return out;
}

/**
 * Fusionne le document disque avec l'état local courant (StrictMode-safe) :
 * un épinglage déjà fait localement AVANT que la lecture disque ne se
 * termine ne doit jamais être perdu — le disque ne fait qu'ajouter ce qu'il
 * a de plus, jamais retirer ce qui est déjà affiché.
 */
export function mergeKnowledgeDocs(disk: KnowledgeDoc, local: KnowledgeDoc): KnowledgeDoc {
  const ids = new Set([...Object.keys(disk), ...Object.keys(local)]);
  const out: KnowledgeDoc = {};
  for (const id of ids) {
    const merged = [...(disk[id] ?? [])];
    for (const item of local[id] ?? []) {
      if (!merged.some((d) => d.path === item.path)) merged.push(item);
    }
    out[id] = merged;
  }
  return out;
}

/** Chemin d'un document épinglé, relatif à la racine du projet (tel qu'affiché dans le bloc injecté). */
export function relativeToProject(path: string, root: string): string {
  if (root && path.startsWith(root)) {
    const rest = path.slice(root.length).replace(/^\/+/, "");
    return rest || path;
  }
  return path;
}

/**
 * Concatène plusieurs listes de documents en dédoublonnant par `path` (le
 * premier qui apparaît gagne) — utilisé pour fusionner épinglées + auto
 * (`.iaction/connaissances/`) dans une seule liste à injecter/compter, sans
 * jamais injecter deux fois le même fichier s'il est à la fois épinglé et
 * présent dans le dossier auto.
 */
export function dedupDocsByPath(lists: PinnedDoc[][]): PinnedDoc[] {
  const seen = new Set<string>();
  const out: PinnedDoc[] = [];
  for (const list of lists) {
    for (const doc of list) {
      if (seen.has(doc.path)) continue;
      seen.add(doc.path);
      out.push(doc);
    }
  }
  return out;
}


/**
 * Construit le bloc « connaissances » préfixé au message ENVOYÉ au premier
 * tour d'une session (voir `handleSend`) — `docs` est la liste déjà fusionnée
 * épinglées + auto (`injectedKnowledge`, voir `dedupDocsByPath`), traitée de
 * façon strictement identique quelle que soit l'origine. Chaque document est
 * tronqué individuellement à `KNOWLEDGE_DOC_MAX_CHARS` ; une fois le budget
 * total `KNOWLEDGE_TOTAL_MAX_CHARS` atteint, les documents suivants ne sont
 * même plus lus (juste listés comme non injectés). Une erreur de lecture
 * n'est jamais fatale : le document est marqué « illisible » et on continue.
 */
export async function buildKnowledgeBlock(
  docs: PinnedDoc[],
  root: string,
  lire: (path: string) => Promise<string | null>,
): Promise<string> {
  const sections: string[] = [];
  let totalUsed = 0;
  for (const doc of docs) {
    const rel = relativeToProject(doc.path, root);
    if (totalUsed >= KNOWLEDGE_TOTAL_MAX_CHARS) {
      sections.push(`--- ${rel} ---\n[non injecté : budget dépassé]`);
      continue;
    }
    let content: string;
    try {
      content = (await lire(doc.path)) ?? "[illisible]";
    } catch {
      content = "[illisible]";
    }
    if (content !== "[illisible]" && content.length > KNOWLEDGE_DOC_MAX_CHARS) {
      content = `${content.slice(0, KNOWLEDGE_DOC_MAX_CHARS)}\n[… tronqué]`;
    }
    totalUsed += content.length;
    sections.push(`--- ${rel} ---\n${content}`);
  }
  return `Documents de connaissances du projet :\n\n${sections.join("\n")}\n\n---\n\n`;
}

