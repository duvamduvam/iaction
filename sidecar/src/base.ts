/**
 * Socle du sidecar : les gardes de type et utilitaires que TOUT le monde
 * utilise, définis une seule fois.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────
 * Ces trois fonctions étaient recopiées à l'identique dans 19 modules
 * (`isNonEmptyString`), 17 (`isPlainObject`) et 4 (`errMessage`) — 40
 * définitions au total pour trois lignes de logique chacune. Personne n'a
 * jamais décidé de dupliquer : à chaque fois, recopier était l'option la plus
 * rapide LOCALEMENT.
 *
 * Le relevé du 2026-08-07 a montré qu'elles n'avaient pas encore divergé côté
 * sidecar. Le danger n'est donc pas passé, il est à venir : côté interface, la
 * même duplication avait bel et bien produit deux comportements différents
 * (`asRecord` acceptait les tableaux dans une copie et pas dans l'autre —
 * découvert en écrivant son premier test). Corriger 40 copies le jour où l'une
 * se révèle fausse, c'est en oublier une.
 *
 * ── Règle ───────────────────────────────────────────────────────────────
 * Ce module N'IMPORTE RIEN. C'est la feuille de l'arbre de dépendances, donc
 * il ne peut jamais participer à un cycle. Tout ce qui y entre doit être
 * générique et sans état : un helper qui aurait besoin d'un chemin, d'une
 * configuration ou d'un journal n'a rien à faire ici.
 */

/**
 * Chaîne non vide — la garde la plus utilisée du sidecar, parce que le
 * protocole est du JSON venu de l'extérieur : un champ peut être absent, nul,
 * d'un autre type, ou présent mais vide. Les quatre cas doivent tomber
 * ensemble.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Objet SIMPLE — les tableaux sont exclus, et c'est le point : `typeof []`
 * vaut `"object"`, donc un test naïf laisse passer un tableau là où le code
 * attend des champs nommés. Chaque lecture de `params` du protocole en dépend.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Message lisible d'une exception, quelle que soit sa nature. Un `catch` peut
 * recevoir n'importe quoi en JavaScript — pas seulement une `Error` —, et un
 * journal ne doit jamais afficher `[object Object]`.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
