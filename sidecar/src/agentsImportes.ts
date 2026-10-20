/*
 * Agents Claude Code importés — `.claude/agents/*.md` (projet ET poste).
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────
 * Sorti d'`orchestrator.ts` en T-081, pour la raison habituelle : le cliquet
 * de taille refusait la croissance, et découper est la réponse attendue. Le
 * bloc était déjà autonome — un parseur de frontmatter et une normalisation,
 * sans état ni décision d'orchestration.
 *
 * Tout est PUR sauf `lireAgentImporte`, qui lit un fichier et rend soit
 * l'agent, soit la raison de l'échec — jamais une entrée « invalide » toute
 * faite : cette forme-là appartient à l'appelant (`invalidAgentEntry`), et la
 * lui laisser évite un import circulaire vers l'orchestrateur.
 *
 * ⚠ Ce format n'est pas le nôtre : c'est celui du CLI Claude Code. On le LIT,
 * on ne le définit pas — d'où la tolérance sur `tools` (liste ou chaîne) et
 * l'absence de traduction sur `model` (un alias reste un alias).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { errMessage, isNonEmptyString, isPlainObject } from "./base.js";
import type { AgentNormalized } from "./orchestrator.js";

/** Nom de fichier sans extension — repli quand le frontmatter ne nomme pas
 *  l'agent. Implémentation reprise TELLE QUELLE d'orchestrator.ts : une
 *  extraction ne change pas un comportement, même dans ses cas de bord (ici,
 *  un fichier caché sans extension). */
export function baseNameNoExt(filePath: string): string {
  return path.basename(filePath).replace(/\.[^./]+$/, "");
}

export interface FrontmatterResult {
  frontmatter: Record<string, unknown> | null;
  body: string;
  error?: string;
}

/** Parseur maison simple : délimiteurs `---` en début de fichier, YAML entre les deux, corps après. */
export function parseFrontmatter(content: string): FrontmatterResult {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: null, body: content, error: "frontmatter manquant (le fichier doit commencer par '---')" };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { frontmatter: null, body: content, error: "délimiteur de fermeture '---' du frontmatter introuvable" };
  }
  const fmText = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(fmText);
  } catch (err) {
    return { frontmatter: null, body, error: `frontmatter YAML invalide: ${errMessage(err)}` };
  }
  if (!isPlainObject(parsed)) {
    return { frontmatter: null, body, error: "frontmatter doit être un objet YAML (mapping clé/valeur)" };
  }
  return { frontmatter: parsed, body };
}

/** Le champ `tools` de Claude Code est soit une liste, soit une chaîne "Read, Write, Bash". */
function normalizeImportedTools(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    const arr = value.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
    return arr.length > 0 ? arr : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const arr = value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    return arr.length > 0 ? arr : null;
  }
  return null;
}

export function buildImportedAgent(
  filePath: string,
  frontmatter: Record<string, unknown>,
  body: string,
): AgentNormalized {
  const fallbackName = baseNameNoExt(filePath);
  const name = isNonEmptyString(frontmatter.name) ? frontmatter.name : fallbackName;
  const description = isNonEmptyString(frontmatter.description) ? frontmatter.description : "";
  const tools = normalizeImportedTools(frontmatter.tools);
  // T-081 — `model:` du frontmatter, lu tel quel : le CLI accepte un alias
  // (`haiku`, `sonnet`, `opus`, `inherit`) comme un id complet, et rien ici ne
  // doit traduire l'un en l'autre. Absent = hérite du modèle du fil, ce que
  // `null` dit déjà. Il était jeté : l'app listait l'agent sans savoir sur
  // quoi il tourne.
  const model = isNonEmptyString(frontmatter.model) ? frontmatter.model.trim() : null;
  return {
    name,
    description,
    engine: "claude",
    provider: null,
    model: model === "" ? null : model,
    permissionMode: "default",
    instructions: body.trim(),
    tools,
    mcp: true,
    knowledge: [],
    maxTurns: null,
  };
}

/** Agent lu, ou la RAISON de l'échec — la mise en forme « entrée invalide »
 *  reste à l'appelant, qui seul connaît le scope à y inscrire. */
export type LectureAgentImporte =
  | { ok: true; agent: AgentNormalized }
  | { ok: false; raison: string };

export async function lireAgentImporte(filePath: string): Promise<LectureAgentImporte> {
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    return { ok: false, raison: `lecture impossible: ${errMessage(err)}` };
  }
  const { frontmatter, body, error } = parseFrontmatter(content);
  if (error || !frontmatter) {
    return { ok: false, raison: error ?? "frontmatter manquant" };
  }
  return { ok: true, agent: buildImportedAgent(filePath, frontmatter, body) };
}
