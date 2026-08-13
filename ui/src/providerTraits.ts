/*
 * R8-A — Profil de fournisseur, côté interface (docs/spec-r8-profils-fournisseur.md).
 *
 * Feuille volontaire, même raison que providerFormCalc.ts : aucun import de
 * valeur, donc testable sans fenêtre native. Elle porte trois choses —
 *
 * 1. le TYPE des traits, partagé avec le protocole ;
 * 2. leur validation souple à la lecture de la config (éditable à la main) ;
 * 3. la table des PROFILS CONNUS.
 *
 * Le point 3 mérite son avertissement : cette table est une **aide de saisie**
 * du formulaire, jamais une source d'exécution. Le sidecar ne connaît aucune
 * marque, il applique ce qu'on lui pousse. Si un préréglage devenait une
 * vérité à l'exécution, il y aurait deux déclarations du même fournisseur à
 * faire diverger — la panne exacte que la version 0.3.0 a passé une journée à
 * refermer.
 */

export interface ProviderTraits {
  /** T-021 — URL absolue du catalogue, à la place de `{baseUrl}/models`. */
  catalogUrl?: string;
  /** Forme de la réponse du catalogue. Défaut implicite : "openai". */
  catalogShape?: "openai" | "slugs";
  /** T-022 — `false` : les compteurs à zéro valent « inconnu » plutôt que `0`. */
  usageTrustworthy?: boolean;
  /** Champs non standard à fusionner dans le corps de `chat.send`. */
  bodyExtras?: Record<string, unknown>;
}

/**
 * Clés qu'un profil ne peut pas poser : un profil décrit une passerelle, il ne
 * détourne pas le cœur de la requête. Le sidecar les retire aussi — la
 * validation est faite des deux côtés parce que la config est éditable à la
 * main, et que l'UI n'est pas le seul chemin vers `providers.set`.
 */
export const CLES_RESERVEES = ["model", "messages", "stream", "stream_options"];

function objetSimple(valeur: unknown): valeur is Record<string, unknown> {
  return typeof valeur === "object" && valeur !== null && !Array.isArray(valeur);
}

/** Retire les clés réservées ; `undefined` s'il ne reste rien à envoyer. */
function extrasUtiles(valeur: unknown): Record<string, unknown> | undefined {
  if (!objetSimple(valeur)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [cle, v] of Object.entries(valeur)) {
    if (!CLES_RESERVEES.includes(cle)) out[cle] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validation souple, comme les réglages R0 : un trait mal formé est retiré,
 * jamais une erreur. `undefined` quand il ne reste rien — un fournisseur sans
 * profil doit se comporter exactement comme avant R8.
 */
export function nettoyerTraits(brut: unknown): ProviderTraits | undefined {
  if (!objetSimple(brut)) return undefined;
  const traits: ProviderTraits = {};
  if (typeof brut.catalogUrl === "string" && /^https?:\/\//i.test(brut.catalogUrl)) {
    traits.catalogUrl = brut.catalogUrl;
  }
  if (brut.catalogShape === "openai" || brut.catalogShape === "slugs") {
    traits.catalogShape = brut.catalogShape;
  }
  if (typeof brut.usageTrustworthy === "boolean") {
    traits.usageTrustworthy = brut.usageTrustworthy;
  }
  const bodyExtras = extrasUtiles(brut.bodyExtras);
  if (bodyExtras) traits.bodyExtras = bodyExtras;
  return Object.keys(traits).length > 0 ? traits : undefined;
}

/** Saisie JSON des champs supplémentaires : vide = valide (rien à envoyer). */
export function bodyExtrasRecevable(texte: string): boolean {
  const t = texte.trim();
  if (t.length === 0) return true;
  try {
    return objetSimple(JSON.parse(t));
  } catch {
    return false;
  }
}

/**
 * Construit les traits à enregistrer depuis le formulaire. Même contrat que
 * `construireFournisseur` : **champ vide → propriété ABSENTE**. La case
 * « comptabilité fiable » est cochée par défaut, donc seule sa version
 * DÉCOCHÉE écrit quelque chose (`usageTrustworthy: false`).
 */
export function construireTraits(brut: {
  catalogUrl: string;
  catalogShape: string;
  usageTrustworthy: boolean;
  bodyExtrasText: string;
}): ProviderTraits | undefined {
  const texte = brut.bodyExtrasText.trim();
  let bodyExtras: unknown;
  if (texte.length > 0) {
    try {
      bodyExtras = JSON.parse(texte);
    } catch {
      bodyExtras = undefined;
    }
  }
  return nettoyerTraits({
    catalogUrl: brut.catalogUrl.trim(),
    catalogShape: brut.catalogShape,
    ...(brut.usageTrustworthy ? {} : { usageTrustworthy: false }),
    bodyExtras,
  });
}

/** Ce qu'un préréglage remplit dans le formulaire — rien de plus. */
export interface ProfilConnu {
  id: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  traits?: ProviderTraits;
}

/*
 * Les trois profils du poste, mesurés le 2026-08-10 :
 *
 * - Swiftask publie son catalogue ailleurs que sur `/models` (8 slugs figés
 *   contre 142 servis), ne remonte aucune comptabilité, et son client officiel
 *   envoie `stateless: true` à chaque requête ;
 * - OpenRouter et Ollama n'ont AUCUN trait — c'est le cas standard, et il doit
 *   le rester visiblement : un profil vide n'est pas un profil oublié.
 */
export const PROFILS_CONNUS: ProfilConnu[] = [
  {
    id: "swiftask",
    label: "Swiftask",
    baseUrl: "https://graphql.swiftask.ai/v1",
    needsKey: true,
    traits: {
      catalogUrl: "https://graphql.swiftask.ai/public/bots",
      catalogShape: "slugs",
      usageTrustworthy: false,
      bodyExtras: { stateless: true },
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
  },
  {
    id: "ollama",
    label: "Ollama local",
    baseUrl: "http://localhost:11434/v1",
    needsKey: false,
  },
];
