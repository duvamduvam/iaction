/**
 * `maj.verifier` — une nouvelle version d'IAction est-elle publiée ?
 *
 * ── Pourquoi côté sidecar, et pas dans la webview ───────────────────────
 * Un `fetch` depuis l'interface partirait en direct, sans proxy ni autorité
 * de certification. Sur un poste d'entreprise à egress contrôlé, c'est
 * exactement le mode de panne de T-043 : tous les appels sortants expirent en
 * `UND_ERR_CONNECT_TIMEOUT` pendant que le navigateur d'à côté fonctionne. Le
 * sidecar, lui, est lancé avec `--use-env-proxy` et l'autorité déclarée dans
 * Configuration → Réseau (T-045). Une sonde de mise à jour qui ne franchit
 * pas le proxy annoncerait « à jour » à un poste qui ne l'est pas — un
 * silence pire que l'absence de sonde.
 *
 * ── Ce que la sonde fait, et surtout ce qu'elle NE fait pas ─────────────
 * Elle LIT la dernière release publiée et compare son numéro au nôtre. Elle
 * ne télécharge rien, n'installe rien, n'exécute rien. La mise à jour reste
 * un geste de l'utilisateur : l'interface ouvre la page de téléchargement, et
 * c'est l'installeur NSIS — qui sait déjà mettre à jour en place — qui fait
 * le travail. Le jour où l'application s'installera elle-même, ce sera une
 * décision explicite, avec des clés de signature, pas une dérive de ce
 * fichier.
 */

import { isPlainObject, messageReseau, readBoundedBody } from "./base.js";

/** Release la plus récente du dépôt public. Hôte listé dans `scripts/audit-hotes.json`. */
const URL_DERNIERE_RELEASE = "https://api.github.com/repos/duvamduvam/iaction/releases/latest";

/**
 * Au-delà, on n'attend plus : la sonde est un confort, pas un préalable au
 * démarrage. Mieux vaut « je ne sais pas » en trois secondes qu'une interface
 * qui retient son souffle sur un réseau qui ne répondra jamais.
 */
const DELAI_MAX_MS = 3000;

export interface EmetteurMaj {
  done(id: string, data?: unknown): void;
  error(id: string, message: string): void;
}

/**
 * Numéro de version en triplet comparable. `null` dès que la forme n'est pas
 * `X.Y.Z` — y compris pour le repli « inconnue » du sidecar, et pour une
 * étiquette de release qu'on n'aurait pas su lire.
 *
 * Volontairement PAS un semver complet : ce produit ne publie pas de
 * pré-version (`scripts/versionner.mjs`, `FORMAT_VERSION`). Accepter `-rc.1`
 * ici inventerait un ordre que rien d'autre dans le dépôt ne connaît.
 */
export function enTriplet(version: string): [number, number, number] | null {
  const trouve = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!trouve) return null;
  return [Number(trouve[1]), Number(trouve[2]), Number(trouve[3])];
}

/**
 * `distante` est-elle STRICTEMENT plus récente que `courante` ?
 *
 * Rend `false` dès qu'un des deux numéros est illisible. C'est le choix
 * prudent : une sonde qui ne sait pas comparer doit se taire, pas inviter à
 * réinstaller. Rend `false` aussi quand la distante est plus ANCIENNE — on
 * tourne alors sur une version non publiée (construction locale), et lui
 * proposer de « mettre à jour » vers plus vieux serait une régression
 * déguisée en progrès.
 */
export function estPlusRecente(distante: string, courante: string): boolean {
  const a = enTriplet(distante);
  const b = enTriplet(courante);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** Réponse de `maj.verifier` (voir `docs/protocol.md`). */
export interface EtatMaj {
  courante: string;
  derniere: string | null;
  disponible: boolean;
  /** Page de la release à ouvrir dans le navigateur — null si rien à proposer. */
  url: string | null;
  /** Corps de la note de version, borné : de quoi savoir ce qui change. */
  notes: string;
}

/** Longueur retenue de la note de version : un encart, pas un journal complet. */
const NOTES_MAX = 4000;

export async function handleMajVerifier(
  id: string,
  versionCourante: string,
  emitter: EmetteurMaj,
): Promise<void> {
  try {
    const res = await fetch(URL_DERNIERE_RELEASE, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(DELAI_MAX_MS),
    });
    if (!res.ok) {
      const corps = await readBoundedBody(res);
      emitter.error(id, `HTTP ${res.status} ${res.statusText}: ${corps}`);
      return;
    }
    const json = (await res.json()) as unknown;
    const etiquette = isPlainObject(json) ? json.tag_name : undefined;
    if (typeof etiquette !== "string") {
      emitter.error(id, "réponse inattendue de l'API des releases (forme inconnue)");
      return;
    }
    const page = isPlainObject(json) ? json.html_url : undefined;
    const corps = isPlainObject(json) ? json.body : undefined;
    // `tag_name` vaut « v0.4.1 » : le préfixe est une convention d'étiquette,
    // pas une partie du numéro (voir docs/github.md §1).
    const derniere = etiquette.replace(/^v/, "");
    const disponible = estPlusRecente(derniere, versionCourante);
    const etat: EtatMaj = {
      courante: versionCourante,
      derniere,
      disponible,
      url: disponible && typeof page === "string" ? page : null,
      notes: typeof corps === "string" ? corps.slice(0, NOTES_MAX) : "",
    };
    emitter.done(id, etat);
  } catch (err) {
    emitter.error(id, messageReseau(err));
  }
}
