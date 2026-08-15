/*
 * R8-A — Profil de fournisseur : les traits déclarés (docs/spec-r8-profils-fournisseur.md).
 *
 * ── Pourquoi ce module existe ──────────────────────────────────────────
 * Le moteur neutre repose sur une hypothèse non écrite : « un fournisseur,
 * c'est une baseUrl compatible OpenAI et une clé ». Elle a cédé quinze fois en
 * `if` éparpillés (T-023). R8-A ne corrige pas les quinze : il pose l'ENDROIT
 * où se déclarent les écarts, et s'en sert pour les deux qui bloquaient
 * l'usage de Swiftask (T-021 catalogue, T-022 comptabilité).
 *
 * ── Pourquoi ici et pas dans engine.ts ─────────────────────────────────
 * Le cliquet de taille refuse d'agrandir `engine.ts` (901 lignes), et il a
 * raison : ce n'est pas de la mécanique de flux SSE, c'est la description d'un
 * fournisseur. Ce module ne dépend que du socle et du journal — tout le monde
 * peut en dépendre sans refermer le graphe des imports.
 *
 * ── Ce qu'il ne fait pas ───────────────────────────────────────────────
 * Il ne connaît AUCUNE marque. La table des profils connus (Swiftask,
 * OpenRouter, Ollama…) vit côté interface, comme simple aide de saisie du
 * formulaire ; le sidecar lit ce qu'on lui pousse. Une seule déclaration a un
 * consommateur à l'exécution — pas de cinquième vérité à faire diverger.
 */
import { isNonEmptyString, isPlainObject } from "./base.js";
import * as journal from "./journal.js";

// ---------------------------------------------------------------------------
// Contrat
// ---------------------------------------------------------------------------

export interface ProviderTraits {
  /** T-021 — URL absolue du catalogue, à la place de `{baseUrl}/models`. */
  catalogUrl?: string;
  /** Forme de la réponse du catalogue. Défaut implicite : "openai". */
  catalogShape?: "openai" | "slugs";
  /** T-022 — `false` : les compteurs à zéro valent « inconnu » (`null`). */
  usageTrustworthy?: boolean;
  /**
   * T-036 — `false` : ce fournisseur ne remonte JAMAIS de coût, par
   * construction. Le champ `usage.cost` est une extension OpenRouter ; chez qui
   * ne l'implémente pas, aucun réglage ne le fera apparaître. Le dire ici
   * distingue « on ne sait pas » de « il n'y a rien à savoir » — deux minorants,
   * mais un seul appelle une action.
   */
  coutRemonte?: boolean;
  /**
   * T-023 (R8-B) — facturation du fournisseur, DÉCLARÉE au lieu d'être devinée.
   *
   * Elle l'était par sous-chaîne de l'identifiant (`id.includes("ollama")`) :
   * un fournisseur local nommé autrement était facturé à tort, et un
   * fournisseur payant contenant « local » compté gratuit. Absent : on retombe
   * sur la devinette d'avant, à l'octet près — c'est la discipline R0, et elle
   * permet de déclarer les profils un par un sans rien casser.
   */
  billing?: "free" | "paid";
  /**
   * T-023 (R8-B) — chemin de la jauge de solde, relatif à `baseUrl`
   * (`"credits"` chez OpenRouter). ABSENT = ce fournisseur n'a pas de jauge, et
   * `usage.credits` répond une erreur explicite au lieu d'aller taper une route
   * qui n'existe pas. C'est ce champ qui retire un nom de marque du protocole.
   */
  creditsPath?: string;
  /** Champs non standard à fusionner dans le corps de `chat.send`. */
  bodyExtras?: Record<string, unknown>;
}

/** Ce qu'un tour a réellement consommé. `null` = le fournisseur n'a rien dit. */
export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
  /** R0 — coût réel `usage.cost` (comptabilité d'usage OpenRouter), null si absent. */
  costUsd: number | null;
  /** R0 — tokens servis depuis le cache (`usage.prompt_tokens_details.cached_tokens`), null si absent. */
  cachedTokens: number | null;
}

/**
 * Clés qu'un profil ne peut PAS poser via `bodyExtras`. Un profil décrit les
 * bizarreries d'une passerelle ; il ne détourne pas le cœur de la requête —
 * sinon une config mal copiée changerait silencieusement le modèle appelé.
 */
export const CLES_RESERVEES = ["model", "messages", "stream", "stream_options"] as const;

// ---------------------------------------------------------------------------
// Validation souple — un trait mal formé est RETIRÉ, jamais une erreur
// ---------------------------------------------------------------------------

/*
 * Même règle que les réglages R0, et pour la même raison : ces valeurs viennent
 * d'un fichier de config que l'utilisateur peut éditer à la main. Un profil à
 * moitié valide doit dégrader vers le comportement standard, pas rendre le
 * fournisseur inutilisable.
 */

function urlAbsolue(valeur: unknown): string | undefined {
  return isNonEmptyString(valeur) && /^https?:\/\//i.test(valeur) ? valeur : undefined;
}

function forme(valeur: unknown): "openai" | "slugs" | undefined {
  return valeur === "openai" || valeur === "slugs" ? valeur : undefined;
}

/** Objet simple débarrassé des clés réservées ; `undefined` s'il ne reste rien. */
function extras(valeur: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(valeur)) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [cle, v] of Object.entries(valeur)) {
    if (!(CLES_RESERVEES as readonly string[]).includes(cle)) {
      out[cle] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalise le `traits` reçu par `providers.set`. Renvoie `undefined` quand il
 * ne reste aucun trait valide : un fournisseur sans profil doit se comporter
 * exactement comme avant R8, à l'octet près.
 */
export function normaliserTraits(brut: unknown): ProviderTraits | undefined {
  if (!isPlainObject(brut)) {
    return undefined;
  }
  const traits: ProviderTraits = {};
  const catalogUrl = urlAbsolue(brut.catalogUrl);
  if (catalogUrl) traits.catalogUrl = catalogUrl;
  const catalogShape = forme(brut.catalogShape);
  if (catalogShape) traits.catalogShape = catalogShape;
  if (typeof brut.usageTrustworthy === "boolean") traits.usageTrustworthy = brut.usageTrustworthy;
  if (typeof brut.coutRemonte === "boolean") traits.coutRemonte = brut.coutRemonte;
  if (brut.billing === "free" || brut.billing === "paid") traits.billing = brut.billing;
  const credits = cheminRelatif(brut.creditsPath);
  if (credits) traits.creditsPath = credits;
  const bodyExtras = extras(brut.bodyExtras);
  if (bodyExtras) traits.bodyExtras = bodyExtras;
  return Object.keys(traits).length > 0 ? traits : undefined;
}

// ---------------------------------------------------------------------------
// Corps de requête
// ---------------------------------------------------------------------------

/**
 * Fusionne les champs non standard du profil dans le corps de `chat.send`.
 * Appelé APRÈS la construction du corps et AVANT les réglages R0 : un profil
 * ne peut donc pas écraser un réglage explicite du même fournisseur, et les
 * clés structurantes ont déjà été retirées à la validation.
 */
export function appliquerBodyExtras(
  body: Record<string, unknown>,
  traits: ProviderTraits | undefined,
): void {
  if (traits?.bodyExtras) {
    Object.assign(body, traits.bodyExtras);
  }
}

// ---------------------------------------------------------------------------
// Comptabilité — T-022 : « zéro mesuré » ≠ « pas de mesure »
// ---------------------------------------------------------------------------

/*
 * Swiftask répond `prompt_tokens: 0` sur un tour qui en a consommé plusieurs
 * milliers. Enregistré tel quel, ce zéro EST une mesure : la jauge de contexte
 * affiche « 0 token » sur une conversation qui grossit, la page Supervision
 * agrège des zéros, et le plafond de débord R3 devient aveugle sur ce
 * fournisseur. C'est le défaut « jauge figée à zéro », déjà corrigé deux fois
 * dans l'interface, qui reviendrait par la porte du fournisseur.
 *
 * Le trait est en opt-in strict : sans `usageTrustworthy: false`, un vrai zéro
 * reste un zéro, comme avant.
 */

/** Fournisseurs déjà signalés — une fois par processus, pas par tour. */
const sansComptabilite = new Set<string>();

function signalerUneFois(providerId: string): void {
  if (sansComptabilite.has(providerId)) return;
  sansComptabilite.add(providerId);
  journal.warn("neutral", "comptabilité non fournie par le fournisseur", {
    fields: { providerId },
  });
}

/** Tests seulement : remet les témoins « déjà signalé » à zéro. */
export function reinitialiserSignalementComptabilite(): void {
  sansComptabilite.clear();
}

/**
 * Ce fournisseur est-il structurellement muet sur le coût (T-036) ?
 *
 * Le fait appartient au FOURNISSEUR, pas à la lecture : c'est pourquoi il
 * s'inscrit dans l'événement d'usage au moment du tour. Relu plus tard,
 * l'agrégat verrait une configuration qui a pu changer entre-temps.
 */
export function coutIndisponible(traits: ProviderTraits | undefined): boolean {
  return traits?.coutRemonte === false;
}

/**
 * Champs d'usage que le PROFIL du fournisseur dicte, à inscrire dans
 * l'événement au moment du tour (T-023, T-036).
 *
 * Groupés ici pour que le moteur n'ait pas à connaître les traits un par un —
 * et pour que la règle « écrit seulement si connu » tienne à un seul endroit :
 * un fournisseur sans profil garde un événement identique à l'octet près.
 */
export function champsUsageDuProfil(
  traits: ProviderTraits | undefined,
): { coutIndisponible?: true; gratuit?: boolean } {
  return {
    ...(coutIndisponible(traits) ? { coutIndisponible: true as const } : {}),
    ...(traits?.billing ? { gratuit: traits.billing === "free" } : {}),
  };
}

/** Chemin relatif non vide, sans barre de tête (on le joint à `baseUrl`). */
function cheminRelatif(valeur: unknown): string | undefined {
  if (typeof valeur !== "string") return undefined;
  const v = valeur.trim().replace(/^\/+/, "");
  return v.length > 0 ? v : undefined;
}

function estFini(valeur: unknown): valeur is number {
  return typeof valeur === "number" && Number.isFinite(valeur);
}

/**
 * Lit le bloc `usage` d'un événement SSE. `null` quand l'événement n'en porte
 * pas — l'appelant garde alors la dernière mesure connue.
 */
export function extraireUsage(
  obj: Record<string, unknown>,
  profil: { id: string; traits?: ProviderTraits },
): Usage | null {
  const usage = obj.usage;
  if (!isPlainObject(usage)) {
    return null;
  }
  const zeroVautInconnu = profil.traits?.usageTrustworthy === false;
  let inconnu = false;
  const lire = (valeur: unknown): number | null => {
    if (typeof valeur !== "number") return null;
    if (zeroVautInconnu && valeur === 0) {
      inconnu = true;
      return null;
    }
    return valeur;
  };
  const promptTokens = lire(usage.prompt_tokens);
  const completionTokens = lire(usage.completion_tokens);
  if (inconnu) {
    signalerUneFois(profil.id);
  }
  const details = usage.prompt_tokens_details;
  return {
    promptTokens,
    completionTokens,
    costUsd: estFini(usage.cost) ? usage.cost : null,
    cachedTokens:
      isPlainObject(details) && estFini(details.cached_tokens) ? details.cached_tokens : null,
  };
}
