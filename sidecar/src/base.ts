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

/**
 * Message d'une panne réseau, AVEC le code de cause quand il existe.
 *
 * ── Pourquoi ce détour pour trois mots ──────────────────────────────────
 * Le `fetch` de Node rend toujours le même message — « fetch failed » — et
 * range la vraie cause dans `err.cause.code`. Sans elle, le journal ne
 * distingue pas un proxy d'un certificat, d'un DNS ou d'un service éteint :
 * quatre pannes, quatre remèdes, un seul message.
 *
 * Le 2026-08-13, sur un poste d'entreprise à egress contrôlé, l'application
 * affichait « erreur réseau: fetch failed » sur chaque fournisseur. Il a fallu
 * piloter la machine à distance pour obtenir `UND_ERR_CONNECT_TIMEOUT` —
 * c'est-à-dire un mot que le journal avait sous la main et n'a pas écrit
 * (T-044). Un message d'erreur qui ne permet pas de choisir le remède est un
 * échec muet qui s'ignore.
 */
export function avecCause(err: unknown): string {
  const base = errMessage(err);
  const cause: unknown = err instanceof Error ? err.cause : undefined;
  const code =
    (isPlainObject(cause) && isNonEmptyString(cause.code) ? cause.code : null) ??
    (isPlainObject(err) && isNonEmptyString(err.code) ? err.code : null);
  return code && !base.includes(code) ? `${base} (${code})` : base;
}

/** Idem, préfixé — pour les points d'appel dont on sait qu'ils sortent du réseau. */
export function messageReseau(err: unknown): string {
  return `erreur réseau: ${avecCause(err)}`;
}

/** Au-delà, un corps d'erreur ne renseigne plus : il encombre. */
const MAX_CORPS_ERREUR = 2048;

/**
 * La réponse est-elle une PAGE WEB là où on attendait une API ?
 *
 * Deux indices, parce qu'aucun des deux ne suffit : l'en-tête, qu'un serveur
 * mal configuré peut taire, et la forme du corps, qu'un JSON contenant du HTML
 * pourrait imiter — mais pas dès son premier caractère.
 */
export function estPageHtml(texte: string, contentType?: string | null): boolean {
  if (contentType && /text\/html/i.test(contentType)) return true;
  return /^\s*(<!doctype html|<html[\s>])/i.test(texte);
}

/**
 * Corps d'une réponse en erreur, réduit à ce qui renseigne (T-007).
 *
 * ── Pourquoi ne pas simplement tronquer ─────────────────────────────────
 * Le 2026-08-08, `ollama.ps` a reçu 24 fois le 404 HTML d'une plateforme
 * d'hébergement web : l'hôte enregistré pour ce fournisseur pointait vers un
 * site, pas vers un serveur Ollama. Chaque occurrence collait deux kilo-octets
 * de balises dans `app.jsonl`. Deux kilo-octets qui ne disent rien — alors que
 * le seul fait qui compte, lui, tient en une ligne : **ce n'est pas l'API
 * attendue qui a répondu**.
 *
 * On garde donc le titre de la page quand il existe (« 404: NOT_FOUND » nomme
 * souvent l'hébergeur, donc la nature de la méprise) et la taille, qui dit que
 * quelque chose a bien répondu. Le reste part.
 */
export function resumerCorpsHttp(texte: string, contentType?: string | null): string {
  if (!estPageHtml(texte, contentType)) {
    return texte.length > MAX_CORPS_ERREUR ? texte.slice(0, MAX_CORPS_ERREUR) + "…" : texte;
  }
  const titre = /<title[^>]*>([^<]{0,200})/i.exec(texte)?.[1]?.trim();
  const entete = `${ENTETE_PAGE_HTML}${texte.length} o)`;
  return titre ? `${entete} « ${titre} »` : entete;
}

const ENTETE_PAGE_HTML = "page HTML (";

/**
 * Ce résumé est-il celui d'une page web ?
 *
 * L'appelant a besoin du FAIT, pas seulement du texte : c'est lui qui sait
 * quel remède proposer (« ce n'est pas un serveur Ollama », « votre proxy a
 * répondu à sa place »…). Reconnaître notre propre en-tête vaut mieux que de
 * re-tester le corps, qui n'existe plus une fois résumé.
 */
export function estResumePageHtml(resume: string): boolean {
  return resume.startsWith(ENTETE_PAGE_HTML);
}

/**
 * Lit le corps d'une réponse HTTP en erreur, réduit à ce qui renseigne.
 *
 * Borné comme il l'a toujours été, et résumé depuis T-007 quand c'est une page
 * web. Vit ici plutôt que dans `engine.ts` — trois modules le partagent, et il
 * ne dépend de rien du moteur.
 */
export async function readBoundedBody(res: Response): Promise<string> {
  try {
    return resumerCorpsHttp(await res.text(), res.headers.get("content-type"));
  } catch {
    return "";
  }
}
