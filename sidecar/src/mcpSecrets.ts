/**
 * Coffre des secrets MCP — `<config>/mcp-secrets.json`, fichier 0600 hors
 * projet et hors git.
 *
 * Raison d'être : un `.mcp.json` est du contrat de projet, versionné et
 * partagé ; il ne doit contenir aucun jeton. Il porte donc des références
 * `${SECRET:nom}` (dans `env`, `headers`, `args`, `url`…) que ce module
 * résout au lancement du tour.
 *
 * Contrat non négociable : **la valeur d'un secret ne sort jamais d'ici** —
 * ni dans le journal, ni dans une réponse RPC, ni dans un message d'erreur.
 * Seuls les NOMS circulent. Les valeurs ne vont que dans un sens : UI →
 * coffre → options du SDK.
 *
 * Aucune dépendance vers les autres modules MCP : c'est la brique du bas
 * (mcp.ts et mcpCatalog.ts l'utilisent, jamais l'inverse).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import type { EngineEmitter } from "./engine.js";
import { globalConfigRoot } from "./jsonlStore.js";
import * as journal from "./journal.js";

/** `<config>/mcp-secrets.json` — coffre local des secrets MCP (mode 0600). */
export function mcpSecretsPath(): string {
  return path.join(globalConfigRoot(), "mcp-secrets.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Références `${SECRET:nom}` — fonctions PURES
// ---------------------------------------------------------------------------

const SECRET_REF_RE = /\$\{SECRET:([A-Za-z0-9_.-]+)\}/g;

/** Noms de secrets référencés par une valeur (récursif) — dédoublonnés, triés. */
export function collectSecretRefs(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(SECRET_REF_RE)) {
        found.add(m[1]);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (isPlainObject(v)) {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return [...found].sort();
}

/**
 * Remplace les `${SECRET:nom}` par leur valeur (récursif, structure
 * préservée). `missing` liste les références introuvables — l'appelant décide
 * quoi en faire (mcp.ts écarte le serveur : mieux vaut pas de serveur qu'un
 * serveur démarré avec un jeton littéral `${SECRET:…}`, qui échouerait à la
 * première requête sans dire pourquoi).
 */
export function resolveSecretRefs(
  value: unknown,
  secrets: Record<string, string>,
): { value: unknown; missing: string[] } {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(SECRET_REF_RE, (whole, name: string) => {
        const secret = secrets[name];
        if (typeof secret !== "string") {
          missing.add(name);
          return whole;
        }
        return secret;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return { value: walk(value), missing: [...missing].sort() };
}

/** Référence à écrire dans `.mcp.json` pour un secret donné. */
export function secretRef(name: string): string {
  return `\${SECRET:${name}}`;
}

// ---------------------------------------------------------------------------
// Accès disque
// ---------------------------------------------------------------------------

/** Lit le coffre — `{}` si absent/illisible/invalide (jamais d'exception). */
export async function readSecrets(): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fsp.readFile(mcpSecretsPath(), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    journal.warn("mcp", "coffre de secrets illisible (JSON invalide), ignoré", {
      fields: { fichier: mcpSecretsPath() },
    });
    return {};
  }
}

async function writeSecrets(secrets: Record<string, string>): Promise<void> {
  const target = mcpSecretsPath();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  // 0600 dès la création : le fichier ne doit jamais être lisible par le
  // groupe, même une fraction de seconde (il porte des jetons d'API).
  await fsp.writeFile(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.chmod(tmp, 0o600).catch(() => {});
  await fsp.rename(tmp, target);
}

/** Pose/écrase un secret. La valeur ne ressort jamais d'ici. */
export async function setSecret(name: string, value: string): Promise<void> {
  const secrets = await readSecrets();
  secrets[name] = value;
  await writeSecrets(secrets);
  journal.info("mcp", "secret MCP enregistré", { fields: { nom: name } });
}

export async function deleteSecret(name: string): Promise<boolean> {
  const secrets = await readSecrets();
  if (!(name in secrets)) return false;
  delete secrets[name];
  await writeSecrets(secrets);
  journal.info("mcp", "secret MCP supprimé", { fields: { nom: name } });
  return true;
}

// ---------------------------------------------------------------------------
// Méthodes RPC — trois verbes explicites plutôt qu'une méthode à `action`
// (chacune tient en dix lignes et porte son propre contrat testable).
// ---------------------------------------------------------------------------

/** `mcp.secrets` — liste les NOMS du coffre (jamais les valeurs). */
export async function handleMcpSecretsList(id: string, emitter: EngineEmitter): Promise<void> {
  const secrets = await readSecrets();
  emitter.done(id, { names: Object.keys(secrets).sort(), path: mcpSecretsPath() });
}

/** `mcp.secretSet` — pose un secret dans le coffre. */
export async function handleMcpSecretSet(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const name = params.name;
  const value = params.value;
  if (!isNonEmptyString(name) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    emitter.error(id, "params.name manquant ou invalide");
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    emitter.error(id, "params.value manquant ou vide");
    return;
  }
  await setSecret(name, value);
  emitter.done(id, { name, saved: true });
}

/** `mcp.secretDelete` — retire un secret du coffre. */
export async function handleMcpSecretDelete(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const name = params.name;
  if (!isNonEmptyString(name)) {
    emitter.error(id, "params.name manquant ou invalide");
    return;
  }
  const removed = await deleteSecret(name);
  emitter.done(id, { name, removed });
}
