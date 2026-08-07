/*
 * Wrappers typés pour les méthodes `mcp.*` du sidecar (docs/protocol.md
 * § « Méthodes MCP — état réel, interrupteurs, secrets, catalogue »).
 *
 * Même style défensif que tachesClient.ts : chaque valeur reçue est validée
 * champ par champ, une entrée invalide est omise plutôt que de faire planter
 * le panneau. Un sidecar plus ancien (sans ces méthodes) fait rejeter
 * `request()` — l'appelant affiche alors le panneau vide, jamais une erreur
 * bloquante.
 *
 * Contrat :
 *   mcp.status {cwd} → {servers[], configPath, configError, capturedAt,
 *                       mcpToolCount, builtinToolCount, secretNames[]}
 *   mcp.setServer {cwd, name, enabled?, allowedTools?} → {state}
 *   mcp.catalog {} → {entries[]}
 *   mcp.add {cwd, entryId, name?, values} → {name, added}
 *   mcp.remove {cwd, name} → {name, removed}
 *   mcp.secrets {} → {names[], path}
 *   mcp.secretSet {name, value} → {name, saved}
 *   mcp.secretDelete {name} → {name, removed}
 *
 * Une valeur de secret ne circule QUE dans le sens UI → sidecar (`secretSet`,
 * `add`) : rien de ce qui revient d'ici n'en contient jamais.
 */
import { request } from "./sidecar";

export type McpServerKind = "stdio" | "http" | "sse";

/** Un serveur tel que vu par le panneau : déclaration + état constaté. */
export interface McpServerStatus {
  name: string;
  kind: McpServerKind;
  /** Commande (stdio) ou URL (distant), tronquée. */
  detail: string;
  /** Déclaré dans `.mcp.json` (false = serveur in-process d'IAction). */
  declared: boolean;
  /** Interrupteur local — `false` = jamais transmis au moteur (zéro contexte). */
  enabled: boolean;
  /** Allowlist d'outils (noms courts) ; `null` = tous les outils exposés. */
  allowedTools: string[] | null;
  /** Statut rapporté par le SDK au dernier tour (`connected`, `failed`, `needs_auth`…). */
  status: string;
  /** Outils réellement exposés au dernier tour (noms courts). */
  tools: string[];
  /** Le statut réclame une authentification interactive. */
  needsAuth: boolean;
  /** Secrets référencés par l'entrée `.mcp.json` (`${SECRET:...}`). */
  secretRefs: string[];
  /** Référencés mais absents du coffre : le serveur n'est PAS lancé. */
  missingSecrets: string[];
}

export interface McpStatus {
  configPath: string;
  configExists: boolean;
  /** Message si `.mcp.json` est présent mais illisible — sinon `null`. */
  configError: string | null;
  servers: McpServerStatus[];
  /** Horodatage ISO du dernier tour observé — `null` si aucun. */
  capturedAt: string | null;
  mcpToolCount: number;
  builtinToolCount: number;
  secretNames: string[];
}

export interface McpCatalogField {
  key: string;
  label: string;
  secret: boolean;
  placeholder: string;
  required: boolean;
}

export interface McpCatalogEntry {
  id: string;
  label: string;
  description: string;
  defaultName: string;
  note: string | null;
  fields: McpCatalogField[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseServer(value: unknown): McpServerStatus | null {
  const v = asRecord(value);
  const name = str(v.name);
  if (!name) return null;
  const kind = v.kind === "http" || v.kind === "sse" ? v.kind : "stdio";
  return {
    name,
    kind,
    detail: str(v.detail),
    declared: v.declared !== false,
    enabled: v.enabled !== false,
    allowedTools: Array.isArray(v.allowedTools) ? strList(v.allowedTools) : null,
    status: str(v.status, "unknown"),
    tools: strList(v.tools),
    needsAuth: v.needsAuth === true,
    secretRefs: strList(v.secretRefs),
    missingSecrets: strList(v.missingSecrets),
  };
}

export async function mcpStatus(cwd: string): Promise<McpStatus> {
  const data = await request("mcp.status", { cwd }).done;
  return {
    configPath: str(data.configPath),
    configExists: data.configExists === true,
    configError: typeof data.configError === "string" ? data.configError : null,
    servers: Array.isArray(data.servers)
      ? data.servers.map(parseServer).filter((s): s is McpServerStatus => s !== null)
      : [],
    capturedAt: typeof data.capturedAt === "string" ? data.capturedAt : null,
    mcpToolCount: num(data.mcpToolCount),
    builtinToolCount: num(data.builtinToolCount),
    secretNames: strList(data.secretNames),
  };
}

/**
 * Interrupteur et/ou allowlist. `allowedTools: null` retire l'allowlist (tous
 * les outils) ; un tableau vide la pose à « aucun outil » — deux intentions
 * distinctes, d'où le `undefined` pour « ne rien changer ».
 */
export async function mcpSetServer(params: {
  cwd: string;
  name: string;
  enabled?: boolean;
  allowedTools?: string[] | null;
}): Promise<void> {
  const payload: Record<string, unknown> = { cwd: params.cwd, name: params.name };
  if (typeof params.enabled === "boolean") payload.enabled = params.enabled;
  if (params.allowedTools !== undefined) payload.allowedTools = params.allowedTools;
  await request("mcp.setServer", payload).done;
}

export async function mcpCatalog(): Promise<McpCatalogEntry[]> {
  const data = await request("mcp.catalog", {}).done;
  if (!Array.isArray(data.entries)) return [];
  return data.entries
    .map((raw) => {
      const v = asRecord(raw);
      const id = str(v.id);
      if (!id) return null;
      return {
        id,
        label: str(v.label, id),
        description: str(v.description),
        defaultName: str(v.defaultName, id),
        note: typeof v.note === "string" ? v.note : null,
        fields: Array.isArray(v.fields)
          ? v.fields
              .map((f) => {
                const fv = asRecord(f);
                const key = str(fv.key);
                if (!key) return null;
                return {
                  key,
                  label: str(fv.label, key),
                  secret: fv.secret === true,
                  placeholder: str(fv.placeholder),
                  required: fv.required === true,
                };
              })
              .filter((f): f is McpCatalogField => f !== null)
          : [],
      };
    })
    .filter((e): e is McpCatalogEntry => e !== null);
}

/** Ajoute un connecteur du catalogue au `.mcp.json` du projet. */
export async function mcpAdd(params: {
  cwd: string;
  entryId: string;
  name: string;
  values: Record<string, string>;
}): Promise<string> {
  const data = await request("mcp.add", params).done;
  return str(data.name, params.name);
}

export async function mcpRemove(cwd: string, name: string): Promise<void> {
  await request("mcp.remove", { cwd, name }).done;
}

export async function mcpSecrets(): Promise<{ names: string[]; path: string }> {
  const data = await request("mcp.secrets", {}).done;
  return { names: strList(data.names), path: str(data.path) };
}

export async function mcpSecretSet(name: string, value: string): Promise<void> {
  await request("mcp.secretSet", { name, value }).done;
}

export async function mcpSecretDelete(name: string): Promise<void> {
  await request("mcp.secretDelete", { name }).done;
}
