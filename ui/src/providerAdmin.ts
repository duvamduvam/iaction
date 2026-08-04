/*
 * Administration des fournisseurs (page « Configuration ») :
 * - config non-secrète des fournisseurs via `appConfig` (lecture → fusion →
 *   écriture du document complet — jamais de clé API dedans, et jamais
 *   d'appel direct à `config_write` ici : voir appConfig.ts) ;
 * - clés API dans le trousseau OS via `secret_get` / `secret_set` /
 *   `secret_delete` (convention de compte `provider:<id>`) ;
 * - reconstruction de la table complète et envoi au sidecar via
 *   `providers.set` (helper `pushProviders`), à appeler au démarrage et
 *   après chaque changement.
 */
import { invoke } from "@tauri-apps/api/core";
import { readConfig, writeConfig } from "./appConfig";
import { providersSet, type ProviderPayload } from "./sidecar";

export interface ProviderConfig {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  headers?: Record<string, string>;
  /** R0 — ids de modèles de secours, dans l'ordre d'essai (OpenRouter `models`). */
  fallbackModels?: string[];
  /** R0 — router chaque appel vers l'endpoint le moins cher (OpenRouter `provider.sort`). */
  priceSort?: boolean;
  /** R0 — demander coût réel + tokens cachés dans l'usage (OpenRouter `usage.include`). */
  usageAccounting?: boolean;
}

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: "ollama",
    label: "Ollama local",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    headers: { "HTTP-Referer": "https://iaction.local", "X-Title": "IAction" },
  },
];

function keyAccount(providerId: string): string {
  return `provider:${providerId}`;
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.baseUrl === "string" &&
    typeof v.needsKey === "boolean"
  );
}

/**
 * R0 — validation souple des réglages de routage OpenRouter : un champ mal
 * formé (fallbackModels qui n'est pas un tableau de chaînes non vides,
 * booléen qui n'en est pas un) est simplement retiré, jamais d'erreur.
 */
function sanitizeRoutingFields(provider: ProviderConfig): ProviderConfig {
  // La config vient du disque : les champs optionnels peuvent avoir n'importe
  // quelle forme (isProviderConfig ne valide que les champs requis).
  const v = provider as unknown as Record<string, unknown>;
  const out: ProviderConfig = { ...provider };
  if (
    !Array.isArray(v.fallbackModels) ||
    v.fallbackModels.length === 0 ||
    !v.fallbackModels.every((m) => typeof m === "string" && m.length > 0)
  ) {
    delete out.fallbackModels;
  }
  if (typeof v.priceSort !== "boolean") delete out.priceSort;
  if (typeof v.usageAccounting !== "boolean") delete out.usageAccounting;
  return out;
}

/** Lit la config non-secrète et renvoie la liste des fournisseurs ([] si absente/vide). */
export async function readProviders(): Promise<ProviderConfig[]> {
  const raw = await readConfig();
  const providers = raw.providers;
  if (!Array.isArray(providers)) return [];
  return providers.filter(isProviderConfig).map(sanitizeRoutingFields);
}

/** Écrit la liste des fournisseurs dans la config non-secrète (jamais de clé dedans ; fusion racine, cf. appConfig.ts). */
export async function writeProviders(providers: ProviderConfig[]): Promise<void> {
  await writeConfig({ providers });
}

export async function getProviderKey(providerId: string): Promise<string | null> {
  return invoke<string | null>("secret_get", { account: keyAccount(providerId) });
}

export async function setProviderKey(providerId: string, value: string): Promise<void> {
  await invoke("secret_set", { account: keyAccount(providerId), value });
}

export async function deleteProviderKey(providerId: string): Promise<void> {
  await invoke("secret_delete", { account: keyAccount(providerId) });
}

export interface PushResult {
  /** Statut « clé configurée » par fournisseur (jamais la valeur elle-même). */
  keyStatus: Record<string, boolean>;
  count: number;
}

/**
 * Reconstruit la table complète à partir de la config + trousseau et la
 * pousse au sidecar via `providers.set`. À appeler au démarrage de l'app et
 * après chaque changement (fournisseur ajouté/modifié/supprimé, clé
 * enregistrée/effacée).
 */
export async function pushProviders(providers: ProviderConfig[]): Promise<PushResult> {
  const keyStatus: Record<string, boolean> = {};
  const payload: ProviderPayload[] = [];

  for (const provider of providers) {
    let apiKey: string | undefined;
    if (provider.needsKey) {
      const stored = await getProviderKey(provider.id);
      keyStatus[provider.id] = !!stored;
      if (stored) apiKey = stored;
    }
    payload.push({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey,
      headers: provider.headers,
      fallbackModels: provider.fallbackModels,
      priceSort: provider.priceSort,
      usageAccounting: provider.usageAccounting,
    });
  }

  const count = await providersSet(payload);
  return { keyStatus, count };
}
