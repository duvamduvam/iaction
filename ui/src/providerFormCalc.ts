/*
 * Contrat du formulaire fournisseur — sorti de ProvidersPage le 2026-08-08.
 *
 * Feuille volontaire : aucun import qui touche Tauri — un type effacé à la
 * compilation, et une autre feuille pure (providerTraits.ts). Le foyer
 * « naturel » aurait été providerAdmin.ts, mais il
 * importe sidecar.ts en valeur, et sidecar.ts s'abonne aux événements Tauri au
 * chargement du module : tout test qui l'importe parle alors à une fenêtre
 * native inexistante. Même leçon que debordNotice.ts, la veille — la logique
 * pure vit dans des feuilles, le câblage vit dans les modules d'application.
 */
import type { ProviderConfig } from "./providerAdmin";
import { construireTraits } from "./providerTraits";
/** Valeurs produites par le formulaire — tout sauf `headers`, géré ailleurs. */
export type ProviderFormValues = Omit<ProviderConfig, "headers">;

/**
 * Saisie libre des modèles de secours : ids séparés par virgules ou retours
 * ligne, les vides ignorés. C'est la moitié « parsing » du contrat R0.
 */
export function parseFallbackModels(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
}

/**
 * Le formulaire est-il soumissible ? Identifiant, libellé et URL non vides ;
 * en création, l'identifiant ne doit pas déjà exister (en édition il est
 * verrouillé, donc forcément « pris » — par lui-même).
 */
export function fournisseurRecevable(
  brut: { id: string; label: string; baseUrl: string },
  existingIds: readonly string[],
  mode: "add" | "edit",
): boolean {
  const id = brut.id.trim();
  if (id.length === 0 || brut.label.trim().length === 0 || brut.baseUrl.trim().length === 0) return false;
  return mode === "edit" || !existingIds.includes(id);
}

/**
 * Construit la configuration à enregistrer — le cœur du contrat R0 :
 * **champ vide (ou case décochée) → propriété ABSENTE**, jamais `false` ou
 * `[]`. Le sidecar traite ces réglages en opt-in pur ; une propriété présente
 * mais vide n'est pas la même chose qu'une propriété absente, et c'est ce
 * genre d'écart qui traverse toutes les couches sans bruit.
 */
export function construireFournisseur(brut: {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  fallbackModelsText: string;
  priceSort: boolean;
  usageAccounting: boolean;
  /*
   * R8-A — profil du fournisseur. Optionnels : un appelant qui ne renseigne
   * aucun trait obtient une configuration identique à celle d'avant R8, et la
   * case « comptabilité fiable » vaut cochée (donc rien à écrire).
   */
  catalogUrl?: string;
  catalogShape?: string;
  usageTrustworthy?: boolean;
  bodyExtrasText?: string;
}): ProviderFormValues {
  const fallbackModels = parseFallbackModels(brut.fallbackModelsText);
  const traits = construireTraits({
    catalogUrl: brut.catalogUrl ?? "",
    catalogShape: brut.catalogShape ?? "",
    usageTrustworthy: brut.usageTrustworthy ?? true,
    bodyExtrasText: brut.bodyExtrasText ?? "",
  });
  return {
    id: brut.id.trim(),
    label: brut.label.trim(),
    baseUrl: brut.baseUrl.trim(),
    needsKey: brut.needsKey,
    ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
    ...(brut.priceSort ? { priceSort: true } : {}),
    ...(brut.usageAccounting ? { usageAccounting: true } : {}),
    ...(traits ? { traits } : {}),
  };
}
