/**
 * Catalogue de connecteurs MCP — brancher une source de vérité depuis l'UI
 * plutôt que de rédiger l'entrée `.mcp.json` à la main.
 *
 * Module VOLONTAIREMENT isolé et sans autre consommateur que ses trois
 * méthodes RPC (`mcp.catalog`, `mcp.add`, `mcp.remove`) : c'est la partie du
 * chantier MCP la plus exposée à la dérive (noms de paquets npm, variables
 * d'environnement de serveurs tiers). Le jour où elle vieillit mal, elle se
 * supprime en effaçant CE fichier et ses trois `case` dans index.ts — le
 * reste du MCP (état constaté, interrupteurs, allowlist, secrets) n'en
 * dépend pas.
 *
 * Filet en attendant : un gabarit périmé ne provoque plus un silence. Le
 * serveur apparaît « aucun outil » dans le panneau, ce qui se voit.
 *
 * Règle des secrets : un champ `secret: true` n'est JAMAIS écrit dans le
 * projet — sa valeur va au coffre (mcpSecrets.ts) sous le nom
 * `<serveur>.<champ>` et le fichier ne porte qu'un `${SECRET:…}`.
 */

import path from "node:path";
import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";
import { readMcpConfig, writeMcpConfig } from "./mcp.js";
import { secretRef, setSecret } from "./mcpSecrets.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export interface McpCatalogField {
  /** Clé technique utilisée par le gabarit (`{{key}}`). */
  key: string;
  label: string;
  /** `secret: true` → la valeur va au coffre, le gabarit reçoit `${SECRET:<nom>}`. */
  secret?: boolean;
  placeholder?: string;
  required?: boolean;
}

export interface McpCatalogEntry {
  id: string;
  label: string;
  description: string;
  /** Nom de serveur proposé par défaut dans `.mcp.json`. */
  defaultName: string;
  fields: McpCatalogField[];
  /** Gabarit d'entrée `.mcp.json` — les `{{key}}` sont substitués. */
  template: Record<string, unknown>;
  /** Note affichée dans l'UI (prérequis, auth interactive…). */
  note?: string;
}

/**
 * Connecteurs proposés. Volontairement court, et limité à ce qui répond à un
 * besoin exprimé : ce sont les sources de vérité qu'on veut INTERROGER en
 * session plutôt que recopier dans le RAG (un index est une copie, il périme ;
 * l'outil, non). L'entrée `http` sert d'échappatoire pour tout le reste — et
 * c'est la moins susceptible de dériver, n'étant qu'une URL et un en-tête.
 */
export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "imap",
    label: "Mails (IMAP)",
    description:
      "Serveur IMAP local livré avec IAction (tools/mcp-imap) : recherche et lecture des mails, en lecture seule par défaut.",
    defaultName: "imap",
    fields: [
      { key: "server", label: "Serveur IMAP", placeholder: "imap.exemple.net", required: true },
      { key: "user", label: "Identifiant", placeholder: "moi@exemple.net", required: true },
      { key: "password", label: "Mot de passe", secret: true, required: true },
    ],
    template: {
      command: "node",
      args: ["{{__imapServerPath}}"],
      env: {
        MCP_IMAP_HOST: "{{server}}",
        MCP_IMAP_USER: "{{user}}",
        MCP_IMAP_PASSWORD: "{{password}}",
        MCP_IMAP_READONLY: "1",
      },
    },
    note: "Lecture seule (MCP_IMAP_READONLY=1). Passer la variable à 0 dans .mcp.json pour autoriser l'écriture.",
  },
  {
    id: "airtable",
    label: "Airtable",
    description:
      "Bases Airtable interrogeables en session (budget, pipeline, KPI) via le serveur communautaire airtable-mcp-server, lancé par npx.",
    defaultName: "airtable",
    fields: [
      {
        key: "token",
        label: "Jeton d'accès personnel Airtable",
        secret: true,
        required: true,
        placeholder: "pat…",
      },
    ],
    template: {
      command: "npx",
      args: ["-y", "airtable-mcp-server"],
      env: { AIRTABLE_API_KEY: "{{token}}" },
    },
    note: "Le jeton doit porter les scopes schema.bases:read et data.records:read (plus data.records:write pour écrire).",
  },
  {
    id: "http",
    label: "Serveur distant (HTTP/SSE)",
    description:
      "Tout serveur MCP accessible par URL. En-tête d'autorisation optionnel — les serveurs OAuth (claude.ai, WordPress) s'authentifient plutôt en session interactive.",
    defaultName: "distant",
    fields: [
      { key: "url", label: "URL", placeholder: "https://exemple.net/mcp", required: true },
      { key: "token", label: "Jeton Bearer (optionnel)", secret: true },
    ],
    template: {
      type: "http",
      url: "{{url}}",
      headers: { Authorization: "Bearer {{token}}" },
    },
  },
];

/** Chemin du serveur IMAP livré avec l'app (`tools/mcp-imap/server.mjs`). */
function bundledImapServerPath(): string {
  // dist/mcpCatalog.js → ../.. = racine du dépôt → tools/mcp-imap/server.mjs
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, "..", "..", "tools", "mcp-imap", "server.mjs");
}

function substitute(value: unknown, values: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, key: string) => values[key] ?? whole);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, values));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const rendered = substitute(v, values);
      // Un champ optionnel non rempli (ex. en-tête Authorization) disparaît
      // au lieu de partir au serveur avec un gabarit non substitué.
      if (typeof rendered === "string" && /\{\{[A-Za-z0-9_]+\}\}/.test(rendered)) continue;
      out[k] = rendered;
    }
    return out;
  }
  return value;
}

/**
 * Construit l'entrée `.mcp.json` d'un connecteur. Les valeurs des champs
 * `secret: true` partent au coffre ; le gabarit ne reçoit qu'une référence.
 */
export async function buildCatalogEntry(
  entry: McpCatalogEntry,
  serverName: string,
  values: Record<string, string>,
): Promise<Record<string, unknown>> {
  const substitutions: Record<string, string> = { __imapServerPath: bundledImapServerPath() };
  for (const field of entry.fields) {
    const raw = values[field.key];
    if (!isNonEmptyString(raw)) {
      if (field.required) {
        throw new Error(`champ requis manquant: ${field.label}`);
      }
      continue;
    }
    if (field.secret) {
      const secretName = `${serverName}.${field.key}`;
      await setSecret(secretName, raw);
      substitutions[field.key] = secretRef(secretName);
    } else {
      substitutions[field.key] = raw;
    }
  }
  const rendered = substitute(entry.template, substitutions);
  return isPlainObject(rendered) ? rendered : {};
}

// ---------------------------------------------------------------------------
// Méthodes RPC
// ---------------------------------------------------------------------------

/** `mcp.catalog` — connecteurs proposés (servi par le sidecar pour que l'UI
    n'ait pas à dupliquer les gabarits, et que les corriger ne demande pas de
    toucher au front). */
export async function handleMcpCatalog(id: string, emitter: EngineEmitter): Promise<void> {
  emitter.done(id, {
    entries: MCP_CATALOG.map((e) => ({
      id: e.id,
      label: e.label,
      description: e.description,
      defaultName: e.defaultName,
      note: e.note ?? null,
      fields: e.fields.map((f) => ({
        key: f.key,
        label: f.label,
        secret: f.secret === true,
        placeholder: f.placeholder ?? "",
        required: f.required === true,
      })),
    })),
  });
}

/** `mcp.add` — écrit l'entrée du connecteur dans `<cwd>/.mcp.json`. */
export async function handleMcpAdd(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwd = params.cwd;
  if (!isNonEmptyString(cwd)) {
    emitter.error(id, "params.cwd manquant ou invalide");
    return;
  }
  const entryId = params.entryId;
  const entry = MCP_CATALOG.find((e) => e.id === entryId);
  if (!entry) {
    emitter.error(id, `connecteur inconnu: ${String(entryId)}`);
    return;
  }
  const name = isNonEmptyString(params.name) ? params.name : entry.defaultName;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    emitter.error(id, "params.name invalide (lettres, chiffres, - et _ seulement)");
    return;
  }
  const values: Record<string, string> = {};
  if (isPlainObject(params.values)) {
    for (const [k, v] of Object.entries(params.values)) {
      if (typeof v === "string") values[k] = v;
    }
  }

  let serverEntry: Record<string, unknown>;
  try {
    serverEntry = await buildCatalogEntry(entry, name, values);
  } catch (err) {
    emitter.error(id, err instanceof Error ? err.message : String(err));
    return;
  }

  const { servers, error, exists } = await readMcpConfig(cwd);
  if (exists && error) {
    // Réécrire par-dessus un fichier cassé effacerait des serveurs que
    // l'utilisateur croit déclarés : on refuse et on dit pourquoi.
    emitter.error(id, `.mcp.json illisible (${error}) — le corriger avant d'ajouter un serveur`);
    return;
  }
  await writeMcpConfig(cwd, { ...(servers ?? {}), [name]: serverEntry });
  journal.info("mcp", "serveur MCP ajouté au projet", { fields: { serveur: name, connecteur: entry.id } });
  emitter.done(id, { name, added: true });
}

/** `mcp.remove` — retire une entrée de `<cwd>/.mcp.json` (les secrets restent au coffre). */
export async function handleMcpRemove(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const cwd = params.cwd;
  if (!isNonEmptyString(cwd)) {
    emitter.error(id, "params.cwd manquant ou invalide");
    return;
  }
  const name = params.name;
  if (!isNonEmptyString(name)) {
    emitter.error(id, "params.name manquant ou invalide");
    return;
  }
  const { servers, error, exists } = await readMcpConfig(cwd);
  if (!exists || !servers) {
    emitter.error(id, error ? `.mcp.json illisible (${error})` : "aucun .mcp.json dans ce projet");
    return;
  }
  if (!(name in servers)) {
    emitter.error(id, `serveur inconnu dans .mcp.json: ${name}`);
    return;
  }
  const next = { ...servers };
  delete next[name];
  await writeMcpConfig(cwd, next);
  journal.info("mcp", "serveur MCP retiré du projet", { fields: { serveur: name } });
  emitter.done(id, { name, removed: true });
}
