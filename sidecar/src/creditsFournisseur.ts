/**
 * `usage.credits` — solde d'un fournisseur qui en expose un (OpenRouter et
 * assimilés, chemin déclaré par le trait `creditsPath`).
 *
 * Sorti d'`engine.ts` en T-085 : le fichier était sous cliquet de taille, et
 * ce handler n'a rien à voir avec le moteur de chat qui l'entourait — il ne
 * partage avec lui que la table des fournisseurs.
 *
 * Ce que ce module a appris à ses dépens, et qui tient en trois règles :
 *
 * 1. **Une clé absente n'est pas une panne** (T-057) : c'est un état choisi,
 *    durable, que le prochain essai ne changera pas. Il se répond en `done`
 *    structuré, SANS passer par la cadence ci-dessous (aucun réseau n'a lieu :
 *    rien à cadencer). 1 197 lignes rouges dans le journal du poste venaient
 *    de là.
 * 2. **Une panne réseau se nomme AVEC sa cible** (T-085) : « fetch failed
 *    (ERR_TLS_CERT_ALTNAME_INVALID) » répété 1 996 fois sans dire quel hôte
 *    présentait le mauvais certificat n'a pas permis de diagnostiquer quoi que
 *    ce soit pendant trois jours.
 * 3. **La cadence est de PROCESSUS, pas de fenêtre** (T-086) : deux fenêtres
 *    qui demandent les crédits du même fournisseur ne doivent déclencher
 *    qu'UN appel réseau par cycle. `cadenceParProvider` (mémoire de module,
 *    clé = `providerId`) coalesce les appels concurrents et applique le recul
 *    exponentiel après échec (T-085) — voir `cadenceSondesConso.ts` pour les
 *    décisions temporelles pures.
 */

import { isNonEmptyString, isPlainObject, messageReseau, readBoundedBody } from "./base.js";
import { buildHeaders, getProvider, joinUrl, type EngineEmitter, type Provider } from "./engine.js";
import {
  apresEchecCredits,
  apresSuccesCredits,
  doitSonderCredits,
  etatInitialCredits,
  type EtatCadenceCredits,
} from "./cadenceSondesConso.js";

type ResultatCredits =
  | { type: "valeur"; totalCredits: number; totalUsage: number; remaining: number }
  | { type: "erreur"; message: string };

interface CadenceProvider {
  etat: EtatCadenceCredits;
  dernier: ResultatCredits | null;
  enVol: Promise<ResultatCredits> | null;
}

/** Mémoire de PROCESSUS, une entrée par fournisseur — voir le point 3 ci-dessus. */
const cadenceParProvider = new Map<string, CadenceProvider>();

function cadenceDe(providerId: string): CadenceProvider {
  let c = cadenceParProvider.get(providerId);
  if (!c) {
    c = { etat: etatInitialCredits(), dernier: null, enVol: null };
    cadenceParProvider.set(providerId, c);
  }
  return c;
}

/** Test only : oublie la cadence/coalescing de tous les fournisseurs. */
export function reinitialiserCadenceCredits(): void {
  cadenceParProvider.clear();
}

function repondreResultatCredits(id: string, emitter: EngineEmitter, resultat: ResultatCredits): void {
  if (resultat.type === "erreur") {
    emitter.error(id, resultat.message);
    return;
  }
  emitter.done(id, {
    totalCredits: resultat.totalCredits,
    totalUsage: resultat.totalUsage,
    remaining: resultat.remaining,
  });
}

export async function handleUsageCredits(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const providerId = params.providerId;
  if (!isNonEmptyString(providerId)) {
    emitter.error(id, "params.providerId manquant ou invalide");
    return;
  }
  const provider = getProvider(providerId);
  if (!provider) {
    emitter.error(id, `fournisseur inconnu: ${providerId}`);
    return;
  }
  if (!isNonEmptyString(provider.apiKey)) {
    // T-057 — l'absence de clé n'est pas un échec du protocole : c'est un état
    // CHOISI par l'utilisateur, et il ne changera pas d'ici au prochain essai.
    // Le dire en `done` structuré plutôt qu'en `error` retire à lui seul
    // 1 197 lignes rouges du journal, sans rien cacher : l'encart affiche
    // toujours l'absence de relevé, et l'appelant sait qu'il est inutile de
    // réessayer.
    emitter.done(id, { disponible: false, raison: "cle-absente" });
    return;
  }

  const now = Date.now();
  const cadence = cadenceDe(providerId);
  if (cadence.enVol) {
    // T-086 — un appel réseau est DÉJÀ en vol pour ce fournisseur (une autre
    // fenêtre vient de demander) : on attend CE MÊME appel plutôt que d'en
    // lancer un second.
    repondreResultatCredits(id, emitter, await cadence.enVol);
    return;
  }
  if (!doitSonderCredits(cadence.etat, now) && cadence.dernier) {
    // Trop tôt depuis le dernier appel (cadence stable ou recul après échec,
    // T-085) : le dernier résultat connu répond, sans repartir en réseau.
    repondreResultatCredits(id, emitter, cadence.dernier);
    return;
  }
  cadence.enVol = interrogerFournisseur(provider, providerId);
  try {
    const resultat = await cadence.enVol;
    cadence.etat = resultat.type === "valeur" ? apresSuccesCredits(now) : apresEchecCredits(cadence.etat, now);
    cadence.dernier = resultat;
    repondreResultatCredits(id, emitter, resultat);
  } finally {
    cadence.enVol = null;
  }
}

/** Le VRAI appel réseau — jamais joué sans passer par la garde de `handleUsageCredits`. */
async function interrogerFournisseur(provider: Provider, providerId: string): Promise<ResultatCredits> {
  // T-085 — l'URL réellement appelée, pour pouvoir la nommer en cas d'échec :
  // « fetch failed (ERR_TLS_CERT_ALTNAME_INVALID) » sans l'hôte n'a pas permis
  // de savoir QUI présentait le mauvais certificat, et le journal a crié
  // 1 996 fois sans jamais le dire.
  const url = joinUrl(provider.baseUrl, provider.traits?.creditsPath ?? "credits");
  try {
    // T-023 — chemin déclaré ; sans profil, `credits` comme avant.
    const res = await fetch(url, {
      method: "GET",
      headers: buildHeaders(provider),
    });
    if (!res.ok) {
      const body = await readBoundedBody(res);
      return { type: "erreur", message: `HTTP ${res.status} ${res.statusText}: ${body}` };
    }
    const json = (await res.json()) as unknown;
    const data = isPlainObject(json) ? json.data : undefined;
    if (
      !isPlainObject(data) ||
      typeof data.total_credits !== "number" ||
      typeof data.total_usage !== "number"
    ) {
      return { type: "erreur", message: "réponse inattendue de /credits (forme inconnue)" };
    }
    const totalCredits = data.total_credits;
    const totalUsage = data.total_usage;
    return { type: "valeur", totalCredits, totalUsage, remaining: totalCredits - totalUsage };
  } catch (err) {
    // T-085 — la CIBLE avec la cause : « fetch failed (…) » tout seul ne dit
    // pas quel hôte a échoué, et c'est ce qui a arrêté le diagnostic pendant
    // trois jours. L'hôte seul, jamais l'URL complète : le chemin peut porter
    // un identifiant, le nom d'hôte non.
    return { type: "erreur", message: `${messageReseau(err)} [${providerId} · ${hoteDe(url)}]` };
  }
}

/**
 * Nom d'hôte d'une URL, pour nommer une panne réseau sans rien divulguer de
 * plus. Une URL illisible rend `?` plutôt que de faire échouer le message
 * d'erreur qu'elle sert — ce serait perdre la panne pour un défaut de forme.
 */
function hoteDe(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}
