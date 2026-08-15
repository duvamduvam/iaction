/*
 * Client typé des méthodes « ollama.* » : voir quels modèles sont en mémoire
 * côté serveur, en charger ou en décharger un (docs/protocol.md § `ollama.*`).
 *
 * Sorti de `sidecar.ts` le 2026-08-15 : ce module-là encapsule le TRANSPORT
 * (corrélation des requêtes, journalisation automatique, abonnements), pas les
 * dialectes de chaque fournisseur. Le cliquet de taille a rendu la question
 * inévitable en refusant de le laisser grossir encore — c'était le bon refus.
 */
import { request } from "./sidecar";

/** Un modèle actuellement chargé en mémoire côté serveur Ollama (`ollama.ps`). */
export interface OllamaModelInfo {
  name: string;
  sizeVram: number | null;
  sizeTotal: number | null;
  expiresAt: string | null;
}

function toOllamaModelInfo(value: unknown): OllamaModelInfo | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !v.name) return null;
  return {
    name: v.name,
    sizeVram: typeof v.sizeVram === "number" && Number.isFinite(v.sizeVram) ? v.sizeVram : null,
    sizeTotal: typeof v.sizeTotal === "number" && Number.isFinite(v.sizeTotal) ? v.sizeTotal : null,
    expiresAt: typeof v.expiresAt === "string" && v.expiresAt ? v.expiresAt : null,
  };
}

/**
 * Liste les modèles Ollama actuellement chargés en mémoire. Rejette (promesse
 * rejetée) si le fournisseur est inconnu ou si son API native ne répond pas
 * comme un serveur Ollama — c'est le signal utilisé par `OllamaPanel` pour
 * décider de s'afficher ou non.
 *
 * D'où la SONDE (T-007) : ce rejet est le fonctionnement nominal du panneau
 * face à un fournisseur qui n'est pas un Ollama, et il se répète toutes les
 * dix secondes. Le journaliser en `error` a produit 140 lignes en onze jours,
 * chacune avec le corps de la page web reçue. Le panneau qui disparaît reste
 * le signal visible ; une vraie panne du fournisseur, elle, se dit au premier
 * tour envoyé, avec son propre message.
 */
export async function ollamaPs(providerId: string): Promise<OllamaModelInfo[]> {
  const { done } = request("ollama.ps", { providerId }, { sonde: true });
  const data = await done;
  if (!Array.isArray(data.models)) return [];
  const out: OllamaModelInfo[] = [];
  for (const raw of data.models) {
    const m = toOllamaModelInfo(raw);
    if (m) out.push(m);
  }
  return out;
}

/** Charge un modèle Ollama en mémoire (peut prendre plusieurs minutes à froid). */
export async function ollamaLoad(providerId: string, model: string): Promise<void> {
  const { done } = request("ollama.load", { providerId, model });
  await done;
}

/** Décharge un modèle Ollama de la mémoire (`keep_alive:0`). */
export async function ollamaUnload(providerId: string, model: string): Promise<void> {
  const { done } = request("ollama.unload", { providerId, model });
  await done;
}
