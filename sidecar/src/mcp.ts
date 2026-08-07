/**
 * MCP v2 — pilotage réel des serveurs MCP d'un projet (module central).
 *
 * v1 se contentait de passer `<cwd>/.mcp.json` au SDK, sans jamais savoir ce
 * qui se connectait vraiment : un serveur en panne, en attente d'auth, ou
 * simplement inutile coûtait du contexte à chaque tour sans que rien ne le
 * signale. Ce module apporte les quatre pièces qui manquaient :
 *
 * 1. **État réel** — le message `system/init` du SDK porte `mcp_servers`
 *    ([{name, status}]) et `tools` (noms complets `mcp__<serveur>__<outil>`).
 *    claude.ts nous les remet ; on les persiste dans
 *    `<cwd>/.iaction/mcp.runtime.json` pour que l'UI (et le guide projet)
 *    affichent l'état constaté au dernier tour, pas le fichier de config.
 * 2. **Contrôle** — `<cwd>/.iaction/mcp.local.json` (jamais versionné, écrit
 *    par l'UI) désactive un serveur ou restreint ses outils, sans toucher au
 *    `.mcp.json` du projet (qui, lui, est du contrat partagé).
 * 3. **Secrets** — un `.mcp.json` ne doit contenir aucun jeton : toute chaîne
 *    `${SECRET:nom}` (dans `env`, `headers`, `args`, `url`…) est résolue au
 *    lancement du tour depuis `<config>/mcp-secrets.json` (mode 600, hors
 *    projet, hors git). Un secret manquant désactive le serveur concerné
 *    plutôt que de laisser le SDK démarrer un serveur qui échouera.
 * 4. **Catalogue** — brancher un connecteur (IMAP, Airtable, serveur HTTP
 *    distant) depuis l'UI plutôt que de rédiger le JSON à la main : c'est
 *    l'affaire de `mcpCatalog.ts` (voir le découpage ci-dessous).
 *
 * Découpage (une responsabilité par fichier, pour que chacun reste lisible
 * et que le plus fragile soit jetable) :
 *  - `mcpSecrets.ts` — coffre `${SECRET:…}` (brique du bas, aucune dépendance) ;
 *  - `mcp.ts` (ici) — config, préférences locales, état constaté, préparation
 *    d'un tour, journal des appels, fiche projet, méthodes `mcp.status` et
 *    `mcp.setServer` ;
 *  - `mcpCatalog.ts` — connecteurs prêts à brancher (`mcp.catalog/add/remove`),
 *    la seule partie exposée à la dérive de gabarits tiers, donc isolée pour
 *    être supprimable sans toucher au reste.
 *
 * Contrat de journalisation : la valeur d'un secret n'est JAMAIS journalisée
 * ni renvoyée par une méthode RPC — seuls les NOMS circulent.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";
import { collectSecretRefs, readSecrets, resolveSecretRefs } from "./mcpSecrets.js";
import { projectDir } from "./appPaths.js";

// ---------------------------------------------------------------------------
// Emplacements
// ---------------------------------------------------------------------------

/** `<cwd>/.mcp.json` — config partagée du projet (convention Claude Code). */
export function mcpConfigPath(cwd: string): string {
  return path.join(path.resolve(cwd), ".mcp.json");
}

/** `<cwd>/.iaction/mcp.local.json` — préférences LOCALES (interrupteurs, allowlist). */
export function mcpStatePath(cwd: string): string {
  return projectDir(cwd, "mcp.local.json");
}

/** `<cwd>/.iaction/mcp.runtime.json` — dernier état CONSTATÉ (généré). */
export function mcpRuntimePath(cwd: string): string {
  return projectDir(cwd, "mcp.runtime.json");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type McpServerKind = "stdio" | "http" | "sse";

/** Description lisible d'un serveur déclaré, telle qu'affichée par l'UI. */
export interface McpServerInfo {
  name: string;
  kind: McpServerKind;
  /** Commande (stdio) ou URL (distant), tronquée — jamais de secret résolu. */
  detail: string;
  /** Noms des secrets référencés par l'entrée (`${SECRET:x}`), dédoublonnés. */
  secretRefs: string[];
  /** Secrets référencés mais absents du coffre : le serveur ne sera pas lancé. */
  missingSecrets: string[];
}

/** Statut d'un serveur au dernier tour, tel que rapporté par le SDK. */
export interface McpRuntimeServer {
  name: string;
  /** `connected`, `failed`, `needs-auth`, `pending`… (valeur brute du SDK, normalisée). */
  status: string;
  /** Outils exposés, noms courts (sans le préfixe `mcp__<serveur>__`). */
  tools: string[];
}

export interface McpRuntimeSnapshot {
  capturedAt: string;
  servers: McpRuntimeServer[];
  /** Outils intégrés (non MCP) vus au même init — pour le décompte de contexte. */
  builtinToolCount: number;
}

/** Préférences locales : serveurs éteints, et allowlist d'outils par serveur. */
export interface McpLocalState {
  /** Noms de serveurs désactivés — non transmis au SDK, donc zéro coût contexte. */
  disabled: string[];
  /**
   * `{ serveur: [outils courts autorisés] }`. Un serveur absent de la carte
   * expose tous ses outils. Une liste vide = allowlist vide (tout refusé) :
   * c'est un choix explicite, distinct de « pas d'allowlist ».
   */
  allowedTools: Record<string, string[]>;
}

export const EMPTY_MCP_STATE: McpLocalState = { disabled: [], allowedTools: {} };

// ---------------------------------------------------------------------------
// Utilitaires purs
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function truncate(text: string, max = 100): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Noms d'outils MCP : `mcp__<serveur>__<outil>` (convention du SDK). */
export function splitMcpToolName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith("mcp__")) return null;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

/** Nom complet d'un outil MCP à partir du serveur et de l'outil court. */
export function fullMcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/**
 * Répartit la liste `tools` d'un `system/init` par serveur MCP. Renvoie aussi
 * le nombre d'outils intégrés (Read, Bash, Task…) : c'est l'autre moitié du
 * coût contexte, et la comparaison rend le poids du MCP lisible.
 */
export function groupToolsByServer(tools: unknown): {
  byServer: Record<string, string[]>;
  builtinToolCount: number;
} {
  const byServer: Record<string, string[]> = {};
  let builtinToolCount = 0;
  if (!Array.isArray(tools)) {
    return { byServer, builtinToolCount };
  }
  for (const entry of tools) {
    if (typeof entry !== "string" || !entry) continue;
    const split = splitMcpToolName(entry);
    if (!split) {
      builtinToolCount += 1;
      continue;
    }
    (byServer[split.server] ??= []).push(split.tool);
  }
  return { byServer, builtinToolCount };
}

/**
 * Normalise `system/init.mcp_servers` ([{name, status}], forme du SDK) en
 * croisant avec les outils réellement exposés. Un serveur annoncé sans aucun
 * outil est le symptôme exact du « branché mais inutile » : on le garde dans
 * la liste, avec `tools: []`, pour que l'UI puisse le dire.
 */
export function buildRuntimeSnapshot(
  mcpServersFromInit: unknown,
  tools: unknown,
  capturedAt: string,
): McpRuntimeSnapshot {
  const { byServer, builtinToolCount } = groupToolsByServer(tools);
  const servers: McpRuntimeServer[] = [];
  const seen = new Set<string>();

  if (Array.isArray(mcpServersFromInit)) {
    for (const entry of mcpServersFromInit) {
      if (!isPlainObject(entry) || !isNonEmptyString(entry.name)) continue;
      const name = entry.name;
      if (seen.has(name)) continue;
      seen.add(name);
      servers.push({
        name,
        status: isNonEmptyString(entry.status) ? entry.status : "unknown",
        tools: (byServer[name] ?? []).slice().sort(),
      });
    }
  }
  // Un serveur qui expose des outils sans figurer dans `mcp_servers` (forme du
  // SDK non garantie) reste visible : les outils sont la preuve la plus dure.
  for (const [name, list] of Object.entries(byServer)) {
    if (seen.has(name)) continue;
    seen.add(name);
    servers.push({ name, status: "connected", tools: list.slice().sort() });
  }

  servers.sort((a, b) => a.name.localeCompare(b.name));
  return { capturedAt, servers, builtinToolCount };
}

/** Un statut de serveur qui réclame une authentification interactive ? */
export function statusNeedsAuth(status: string): boolean {
  const s = status.toLowerCase();
  return s.includes("auth") || s.includes("login") || s.includes("unauthorized");
}

// ---------------------------------------------------------------------------
// Config projet (.mcp.json)
// ---------------------------------------------------------------------------

/** Analyse le contenu d'un `.mcp.json` — pur, testable sans disque. */
export function parseMcpConfig(raw: string): { servers: Record<string, unknown> | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { servers: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.mcpServers)) {
    return { servers: null, error: 'objet "mcpServers" absent ou invalide' };
  }
  for (const [name, config] of Object.entries(parsed.mcpServers)) {
    if (!isPlainObject(config)) {
      return { servers: null, error: `entrée mcpServers invalide: ${name}` };
    }
  }
  return { servers: parsed.mcpServers, error: null };
}

/** Lecture disque du `.mcp.json` — `null` si absent, `error` si présent mais cassé. */
export async function readMcpConfig(
  cwd: string,
): Promise<{ servers: Record<string, unknown> | null; error: string | null; exists: boolean }> {
  let raw: string;
  try {
    raw = await fsp.readFile(mcpConfigPath(cwd), "utf8");
  } catch {
    return { servers: null, error: null, exists: false };
  }
  const { servers, error } = parseMcpConfig(raw);
  if (error) {
    // `warn` : le tour continue sans les serveurs du projet — dégradation
    // acceptée, jamais un échec de l'action utilisateur.
    journal.warn("mcp", ".mcp.json inexploitable, serveurs du projet ignorés", {
      fields: { fichier: mcpConfigPath(cwd), erreur: error },
    });
  }
  return { servers, error, exists: true };
}

/** Écriture atomique du `.mcp.json` (consommée par mcpCatalog.ts). */
export async function writeMcpConfig(cwd: string, servers: Record<string, unknown>): Promise<void> {
  const target = mcpConfigPath(cwd);
  const body = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
  const tmp = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, body, "utf8");
  await fsp.rename(tmp, target);
}

/** Description affichable d'une entrée `.mcp.json` (jamais de secret résolu). */
export function describeServer(name: string, config: unknown, knownSecrets: string[]): McpServerInfo {
  const entry = isPlainObject(config) ? config : {};
  const secretRefs = collectSecretRefs(entry);
  const missingSecrets = secretRefs.filter((s) => !knownSecrets.includes(s));
  if (isNonEmptyString(entry.command)) {
    const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
    return {
      name,
      kind: "stdio",
      detail: truncate([entry.command, ...args].join(" ")),
      secretRefs,
      missingSecrets,
    };
  }
  const kind: McpServerKind = entry.type === "sse" ? "sse" : "http";
  return {
    name,
    kind,
    detail: truncate(isNonEmptyString(entry.url) ? entry.url : ""),
    secretRefs,
    missingSecrets,
  };
}

// ---------------------------------------------------------------------------
// État local (.iaction/mcp.local.json)
// ---------------------------------------------------------------------------

/** Tolère tout : une préférence corrompue ne doit jamais casser un tour. */
export function normalizeMcpState(value: unknown): McpLocalState {
  if (!isPlainObject(value)) return { disabled: [], allowedTools: {} };
  const disabled = Array.isArray(value.disabled)
    ? [...new Set(value.disabled.filter((v): v is string => isNonEmptyString(v)))]
    : [];
  const allowedTools: Record<string, string[]> = {};
  if (isPlainObject(value.allowedTools)) {
    for (const [server, list] of Object.entries(value.allowedTools)) {
      if (!Array.isArray(list)) continue;
      allowedTools[server] = [...new Set(list.filter((v): v is string => isNonEmptyString(v)))];
    }
  }
  return { disabled, allowedTools };
}

export async function readMcpState(cwd: string): Promise<McpLocalState> {
  try {
    const raw = await fsp.readFile(mcpStatePath(cwd), "utf8");
    return normalizeMcpState(JSON.parse(raw));
  } catch {
    return { disabled: [], allowedTools: {} };
  }
}

export async function writeMcpState(cwd: string, state: McpLocalState): Promise<void> {
  const target = mcpStatePath(cwd);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, target);
}

// ---------------------------------------------------------------------------
// Instantané d'exécution (.iaction/mcp.runtime.json)
// ---------------------------------------------------------------------------

export async function readMcpRuntime(cwd: string): Promise<McpRuntimeSnapshot | null> {
  try {
    const raw = await fsp.readFile(mcpRuntimePath(cwd), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed) || !Array.isArray(parsed.servers)) return null;
    const servers: McpRuntimeServer[] = [];
    for (const entry of parsed.servers) {
      if (!isPlainObject(entry) || !isNonEmptyString(entry.name)) continue;
      servers.push({
        name: entry.name,
        status: isNonEmptyString(entry.status) ? entry.status : "unknown",
        tools: Array.isArray(entry.tools) ? entry.tools.filter((t): t is string => isNonEmptyString(t)) : [],
      });
    }
    return {
      capturedAt: isNonEmptyString(parsed.capturedAt) ? parsed.capturedAt : "",
      servers,
      builtinToolCount: typeof parsed.builtinToolCount === "number" ? parsed.builtinToolCount : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Persiste l'état constaté — best effort : un projet sans `.iaction/` (donc
 * pas un projet IAction) n'est pas créé pour autant, et un échec d'écriture
 * ne perturbe jamais le tour en cours.
 */
export async function writeMcpRuntime(cwd: string, snapshot: McpRuntimeSnapshot): Promise<void> {
  try {
    const dir = projectDir(cwd);
    const stat = await fsp.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) return;
    const target = mcpRuntimePath(cwd);
    const tmp = `${target}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, target);
  } catch (err) {
    journal.warn("mcp", "instantané MCP non écrit", {
      fields: { erreur: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ---------------------------------------------------------------------------
// Préparation d'un tour : filtrage + secrets + allowlist
// ---------------------------------------------------------------------------

export interface PreparedMcp {
  /** Serveurs à passer au SDK (secrets résolus) — `null` si aucun. */
  servers: Record<string, unknown> | null;
  /** Noms écartés par l'interrupteur local. */
  disabled: string[];
  /** Noms écartés faute de secret (avec le détail dans le journal). */
  missingSecrets: string[];
  /**
   * Outils MCP à retirer du contexte du modèle (`options.disallowedTools`) :
   * calculés depuis les allowlists et les outils CONNUS du dernier tour.
   */
  disallowedTools: string[];
}

/**
 * Prépare la configuration MCP d'un tour projet. Trois filtres successifs :
 * interrupteur local → secrets résolus → allowlist d'outils.
 *
 * L'allowlist s'appuie sur les outils vus au tour précédent
 * (`mcp.runtime.json`) : un serveur jamais lancé n'a donc aucune restriction
 * au premier tour, puis la restriction s'applique dès qu'on connaît sa
 * surface. C'est le seul levier disponible — le SDK ne permet pas de filtrer
 * les outils d'un serveur avant sa connexion.
 */
export async function prepareMcpForTurn(cwd: string): Promise<PreparedMcp> {
  const empty: PreparedMcp = { servers: null, disabled: [], missingSecrets: [], disallowedTools: [] };
  const { servers } = await readMcpConfig(cwd);
  const state = await readMcpState(cwd);
  const runtime = await readMcpRuntime(cwd);

  // L'allowlist vaut aussi pour les serveurs in-process (iaction, studio) :
  // ils sont dans le runtime comme les autres, et l'utilisateur doit pouvoir
  // couper `search_chat` sans couper `search_knowledge`.
  const disallowedTools: string[] = [];
  for (const [server, allowed] of Object.entries(state.allowedTools)) {
    const known = runtime?.servers.find((s) => s.name === server)?.tools ?? [];
    for (const tool of known) {
      if (!allowed.includes(tool)) {
        disallowedTools.push(fullMcpToolName(server, tool));
      }
    }
  }

  if (!servers) {
    return { ...empty, disabled: state.disabled, disallowedTools };
  }

  const secrets = await readSecrets();
  const knownSecretNames = Object.keys(secrets);
  const out: Record<string, unknown> = {};
  const disabled: string[] = [];
  const missingSecrets: string[] = [];

  for (const [name, config] of Object.entries(servers)) {
    if (state.disabled.includes(name)) {
      disabled.push(name);
      continue;
    }
    const refs = collectSecretRefs(config);
    if (refs.length > 0) {
      const missing = refs.filter((r) => !knownSecretNames.includes(r));
      if (missing.length > 0) {
        missingSecrets.push(name);
        // `warn` : le tour tourne sans ce serveur — mieux vaut ça qu'un
        // serveur démarré avec un jeton littéral `${SECRET:...}`, qui
        // échouerait à la première requête sans dire pourquoi.
        journal.warn("mcp", "serveur MCP écarté : secret manquant", {
          fields: { serveur: name, secrets: missing.join(",") },
        });
        continue;
      }
      out[name] = resolveSecretRefs(config, secrets).value;
      continue;
    }
    out[name] = config;
  }

  return {
    servers: Object.keys(out).length > 0 ? out : null,
    disabled,
    missingSecrets,
    disallowedTools,
  };
}

// ---------------------------------------------------------------------------
// Journal des appels MCP (observabilité — un appel = une ligne)
// ---------------------------------------------------------------------------

/**
 * Trace un appel d'outil MCP terminé. C'est ce qui permet, après quelques
 * jours, de répondre factuellement à « quels serveurs servent vraiment ? ».
 * Jamais d'arguments ni de contenu de réponse (contrat du journal) : serveur,
 * outil, durée, issue, taille du résultat.
 */
export function logMcpCall(params: {
  server: string;
  tool: string;
  durationMs: number | null;
  ok: boolean;
  resultChars: number;
}): void {
  const fields = {
    serveur: params.server,
    outil: params.tool,
    ms: params.durationMs ?? -1,
    caracteres: params.resultChars,
  };
  if (params.ok) {
    journal.info("mcp", "appel MCP", { fields });
  } else {
    journal.warn("mcp", "appel MCP en échec", { fields });
  }
}

// ---------------------------------------------------------------------------
// Guide projet — annonce des outils MCP RÉELS au modèle
// ---------------------------------------------------------------------------

const MCP_DOC_MARKER = "<!-- généré par IAction — NE PAS ÉDITER : mis à jour à chaque tour -->";

export const MCP_DOC_FILENAME = "iaction-mcp.md";

/**
 * Rend la fiche « outils MCP disponibles » déposée dans
 * `.iaction/connaissances/`. Un serveur branché mais jamais annoncé n'est
 * jamais appelé : le modèle récite alors sa mémoire au lieu d'interroger la
 * source. D'où la règle « source avant mémoire », écrite noir sur blanc.
 */
export function renderMcpDoc(snapshot: McpRuntimeSnapshot): string {
  const lines: string[] = [MCP_DOC_MARKER, "", "# Outils MCP disponibles dans ce projet", ""];
  lines.push(
    "État constaté au dernier tour lancé depuis IAction" +
      (snapshot.capturedAt ? ` (${snapshot.capturedAt})` : "") +
      ". Liste vérifiée, pas déclarative : ce qui est listé ici répond.",
    "",
  );

  const connected = snapshot.servers.filter((s) => s.tools.length > 0);
  const silent = snapshot.servers.filter((s) => s.tools.length === 0);

  if (connected.length === 0) {
    lines.push("Aucun serveur MCP n'a exposé d'outil au dernier tour.", "");
  }
  for (const server of connected) {
    lines.push(`## ${server.name} — ${server.status}`, "");
    for (const tool of server.tools) {
      lines.push(`- \`${fullMcpToolName(server.name, tool)}\``);
    }
    lines.push("");
  }
  if (silent.length > 0) {
    lines.push(
      `Serveurs déclarés sans aucun outil exposé : ${silent
        .map((s) => `${s.name} (${s.status})`)
        .join(", ")}. Ne pas compter dessus.`,
      "",
    );
  }

  lines.push(
    "## Règle : source avant mémoire",
    "",
    "Quand une question porte sur une donnée servie par l'un de ces outils",
    "(mails, base de pilotage, dossier distant…), l'interroger AVANT de répondre —",
    "y compris quand la mémoire ou le RAG semblent déjà contenir la réponse : un",
    "index est une copie, il périme ; l'outil, non. Si l'outil est indisponible,",
    "le dire explicitement au lieu de répondre de mémoire.",
    "",
  );
  return lines.join("\n");
}

/** Dépose/rafraîchit la fiche — best effort, jamais d'exception. */
export async function ensureMcpDoc(cwd: string, snapshot: McpRuntimeSnapshot): Promise<void> {
  try {
    const dir = projectDir(cwd, "connaissances");
    const iaction = projectDir(cwd);
    const stat = await fsp.stat(iaction).catch(() => null);
    if (!stat?.isDirectory()) return;
    const target = path.join(dir, MCP_DOC_FILENAME);
    const content = renderMcpDoc(snapshot);
    const existing = await fsp.readFile(target, "utf8").catch(() => null);
    if (existing !== null && !existing.startsWith(MCP_DOC_MARKER)) return; // édité à la main
    // `capturedAt` change à chaque tour : on ne réécrit que si la SUBSTANCE
    // (serveurs/outils) a bougé, sinon l'index RAG serait périmé en permanence.
    if (existing !== null && stripDocDate(existing) === stripDocDate(content)) return;
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, target);
  } catch (err) {
    journal.warn("mcp", "fiche des outils MCP non déposée", {
      fields: { erreur: err instanceof Error ? err.message : String(err) },
    });
  }
}

function stripDocDate(text: string): string {
  return text.replace(/\(\d{4}-\d{2}-\d{2}T[^)]*\)/g, "");
}

// ---------------------------------------------------------------------------
// Méthodes RPC (voir docs/protocol.md § « Méthodes MCP »)
// ---------------------------------------------------------------------------

function requireCwd(id: string, params: Record<string, unknown>, emitter: EngineEmitter): string | null {
  const cwd = params.cwd;
  if (!isNonEmptyString(cwd)) {
    emitter.error(id, "params.cwd manquant ou invalide");
    return null;
  }
  return cwd;
}

/**
 * `mcp.status` — tout ce que l'UI doit savoir : serveurs déclarés, état
 * constaté au dernier tour, outils exposés, interrupteurs, allowlists,
 * secrets manquants. Ne renvoie JAMAIS de valeur de secret.
 */
export async function handleMcpStatus(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwd = requireCwd(id, params, emitter);
  if (!cwd) return;

  const [{ servers, error, exists }, state, runtime, secrets] = await Promise.all([
    readMcpConfig(cwd),
    readMcpState(cwd),
    readMcpRuntime(cwd),
    readSecrets(),
  ]);
  const secretNames = Object.keys(secrets).sort();

  const declared = servers ? Object.entries(servers) : [];
  const declaredNames = new Set(declared.map(([name]) => name));
  const list = declared.map(([name, config]) => {
    const info = describeServer(name, config, secretNames);
    const rt = runtime?.servers.find((s) => s.name === name) ?? null;
    return {
      ...info,
      declared: true,
      enabled: !state.disabled.includes(name),
      allowedTools: state.allowedTools[name] ?? null,
      status: rt?.status ?? "unknown",
      tools: rt?.tools ?? [],
      needsAuth: rt ? statusNeedsAuth(rt.status) : false,
    };
  });

  // Serveurs in-process ajoutés par le sidecar (iaction, studio) : non
  // déclarés dans .mcp.json mais bien présents dans le contexte du modèle —
  // ils doivent être visibles et restreignables comme les autres.
  for (const rt of runtime?.servers ?? []) {
    if (declaredNames.has(rt.name)) continue;
    list.push({
      name: rt.name,
      kind: "stdio",
      detail: "serveur in-process d'IAction",
      secretRefs: [],
      missingSecrets: [],
      declared: false,
      enabled: !state.disabled.includes(rt.name),
      allowedTools: state.allowedTools[rt.name] ?? null,
      status: rt.status,
      tools: rt.tools,
      needsAuth: statusNeedsAuth(rt.status),
    });
  }

  emitter.done(id, {
    configPath: mcpConfigPath(cwd),
    configExists: exists,
    configError: error,
    servers: list,
    capturedAt: runtime?.capturedAt ?? null,
    builtinToolCount: runtime?.builtinToolCount ?? 0,
    mcpToolCount: list.reduce((sum, s) => sum + s.tools.length, 0),
    secretNames,
  });
}

/** `mcp.setServer` — interrupteur et/ou allowlist d'outils d'un serveur. */
export async function handleMcpSetServer(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwd = requireCwd(id, params, emitter);
  if (!cwd) return;
  const name = params.name;
  if (!isNonEmptyString(name)) {
    emitter.error(id, "params.name manquant ou invalide");
    return;
  }
  const state = await readMcpState(cwd);

  if (typeof params.enabled === "boolean") {
    const disabled = new Set(state.disabled);
    if (params.enabled) disabled.delete(name);
    else disabled.add(name);
    state.disabled = [...disabled].sort();
  }
  if (params.allowedTools === null) {
    delete state.allowedTools[name];
  } else if (Array.isArray(params.allowedTools)) {
    state.allowedTools[name] = params.allowedTools.filter((t): t is string => isNonEmptyString(t));
  }

  await writeMcpState(cwd, state);
  journal.info("mcp", "préférences MCP mises à jour", {
    fields: { serveur: name, eteints: state.disabled.length },
  });
  emitter.done(id, { state });
}
