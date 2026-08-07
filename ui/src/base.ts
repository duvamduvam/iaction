/**
 * Socle de l'interface : les utilitaires que plusieurs modules partagent,
 * définis une seule fois.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────
 * Contrairement au sidecar, où les copies étaient encore identiques, celles de
 * l'interface avaient DÉJÀ divergé au relevé du 2026-08-07 :
 *
 * - `toMessage` existait en deux versions, dont une naïve qui affichait
 *   « [object Object] » là où l'autre sérialisait le contenu — donc un message
 *   d'erreur inutilisable pour l'utilisateur, selon l'écran où il tombait ;
 * - `asRecord` existait en deux versions, dont une qui laissait passer les
 *   TABLEAUX alors que son type promet un enregistrement.
 *
 * Personne n'a introduit ces écarts volontairement : ils naissent de ce que
 * recopier trois lignes est toujours plus rapide, sur le moment, que d'aller
 * chercher où elles vivent. C'est exactement pourquoi elles doivent vivre à un
 * endroit qu'on trouve sans chercher.
 *
 * ── Règle ───────────────────────────────────────────────────────────────
 * Ce module n'importe RIEN (ni React, ni Tauri, ni un autre module de l'app) :
 * il est la feuille de l'arbre de dépendances et ne peut jamais participer à
 * un cycle. Un helper qui aurait besoin d'un contexte n'a rien à faire ici.
 */

/**
 * Message lisible à partir de n'importe quoi — un `catch` JavaScript peut
 * recevoir autre chose qu'une `Error`, et une chaîne de rejet d'API arrive
 * souvent comme objet.
 *
 * L'ordre compte : `Error` d'abord (le cas courant), puis la chaîne brute,
 * puis la sérialisation. Le repli final est ce qui distingue cette version de
 * celle qu'elle remplace : `String({})` donne « [object Object] », qui ne dit
 * rien à personne, alors que la sérialisation montre au moins le contenu.
 */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? "erreur inconnue";
  } catch {
    // Références circulaires, BigInt… : on ne va pas faire échouer un
    // affichage d'erreur à cause d'une erreur de sérialisation.
    return "erreur inconnue";
  }
}

/**
 * Objet SIMPLE, tableaux exclus. `typeof []` vaut « object » : sans le test
 * d'`Array`, un tableau traverse une fonction dont le type de retour promet un
 * enregistrement, et les lectures de champs ressortent silencieusement
 * `undefined`.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Chaîne non vide — même garde que côté sidecar (`sidecar/src/base.ts`). */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
