/*
 * Client des sessions Remote Control des AUTRES machines du compte (T-165,
 * docs/spec-sessions-claude.md). Depuis T-179 il ne sert plus qu'aux outils MCP
 * des agents (outilsSessionsDistantes.ts, T-178). Deux choses :
 *  - `listerSessionsDistantes` : liste les sessions du compte
 *    (`GET /v1/code/sessions`, jeton OAuth de Claude Code) ;
 *  - `creerQueryFnDistant(sessionId)` : un `ClaudeQueryFn` qui, au lieu de
 *    lancer le CLI local, branche le client SSE du SDK
 *    (`@anthropic-ai/claude-agent-sdk/browser`) sur la session distante : mêmes
 *    `SDKMessage`, mêmes permissions, même arrêt.
 *
 * Interface NON documentée (« v1alpha2 ») : elle peut changer sans préavis.
 * Tout écart de format échoue donc BRUYAMMENT — message lisible et ligne au
 * journal, jamais un tour qui se tait. Le jeton n'est JAMAIS journalisé ni mis
 * dans un message d'erreur ; il est relu à CHAQUE connexion (il expire, Claude
 * Code le renouvelle).
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isNonEmptyString } from "./base.js";
import type { CanUseTool, ClaudeQuery, ClaudeQueryFn } from "./claude.js";
import * as journal from "./journal.js";

export const URL_API = "https://api.anthropic.com"; // audit-publication:ok — API publique d'Anthropic
/** Délai maximal d'une requête REST (liste, détail, curseur). */
export const DELAI_REST_MS = 15_000;
/** Après un `interrupt()` resté sans réponse de la machine distante, on coupe le flux. */
export const DELAI_INTERRUPTION_MS = 10_000;

/** Une session distante telle que l'UI l'affiche ; tout champ absent de la réponse devient `null`. */
export interface SessionDistante {
  /** Identifiant `cse_…`. */
  id: string;
  titre: string | null;
  statut: string | null;
  /** `connection_status` brut (« connected » / « disconnected »…). */
  connexion: string | null;
  /** `worker_status` brut (« idle » / « running »…). */
  travail: string | null;
  modele: string | null;
  /** Première étiquette de la session (`remote-control-cli`…). */
  origine: string | null;
  /** Dernière activité, millisecondes depuis l'époque. */
  majLe: number | null;
  /** T-173 — identité « propriétaire/dépôt » (minuscules) du dépôt git de la session, `null` si elle n'en a pas. */
  depot: string | null;
  /** T-180 — `environment_id` : renseigné pour un relais en mode serveur (« bridge »), vide pour une session interactive. */
  environnement: string | null;
}

/** Erreur dont le message est destiné à l'utilisateur tel quel. */
export class ErreurSessionDistante extends Error {}

// ---------------------------------------------------------------------------
// Jeton OAuth
// ---------------------------------------------------------------------------

export interface EnvJeton {
  /** `CLAUDE_CONFIG_DIR` s'il est posé. */
  configDir?: string | undefined;
  home: string;
}

export function envJetonCourant(): EnvJeton {
  return { configDir: process.env.CLAUDE_CONFIG_DIR, home: os.homedir() };
}

/** Fichier des identifiants de Claude Code : `$CLAUDE_CONFIG_DIR`, sinon `~/.claude` (valable Windows/Linux). */
export function cheminJeton(env: EnvJeton): string {
  const dossier = isNonEmptyString(env.configDir) ? env.configDir : path.join(env.home, ".claude");
  return path.join(dossier, ".credentials.json");
}

/** Lit le jeton d'accès. Lève `ErreurSessionDistante` (sans jamais citer le jeton) si absent ou illisible. */
export function lireJetonOauth(env: EnvJeton = envJetonCourant()): string {
  const fichier = cheminJeton(env);
  let texte: string;
  try {
    texte = readFileSync(fichier, "utf8");
  } catch {
    throw new ErreurSessionDistante(
      `Jeton Claude introuvable (${fichier}) : connectez Claude Code à claude.ai (commande /login) sur ce poste.`,
    );
  }
  let brut: unknown;
  try {
    brut = JSON.parse(texte);
  } catch {
    throw new ErreurSessionDistante(`Fichier d'identifiants Claude illisible (${fichier} : JSON invalide) : reconnectez Claude Code (/login).`);
  }
  const oauth = typeof brut === "object" && brut !== null ? (brut as { claudeAiOauth?: unknown }).claudeAiOauth : undefined;
  const jeton = typeof oauth === "object" && oauth !== null ? (oauth as { accessToken?: unknown }).accessToken : undefined;
  if (!isNonEmptyString(jeton)) {
    throw new ErreurSessionDistante(
      `Aucun jeton claude.ai dans ${fichier} (connexion par clé API ?) : connectez Claude Code à claude.ai (/login).`,
    );
  }
  return jeton;
}

export function enTetes(jeton: string): Record<string, string> {
  return { Authorization: `Bearer ${jeton}`, "anthropic-version": "2023-06-01", "anthropic-client-platform": "cli" };
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export interface DepsRest {
  fetchFn?: typeof fetch;
  lireJeton?: () => string;
  delaiMs?: number;
}

/** Message lisible d'un statut HTTP refusé. `quoi` complète : « la liste », « la session »… */
export function messageHttp(statut: number, quoi: string): string {
  if (statut === 401 || statut === 403) {
    return `Accès refusé (HTTP ${statut}) à ${quoi} : jeton expiré ou sans droit. Ouvrez Claude Code sur ce poste pour qu'il le renouvelle, ou reconnectez-le (/login).`;
  }
  if (statut === 404) return `${quoi[0]!.toUpperCase()}${quoi.slice(1)} : introuvable (HTTP 404) — session supprimée ou compte différent.`;
  return `Réponse inattendue (HTTP ${statut}) pour ${quoi}.`;
}

/** GET authentifié, JSON attendu. Réseau, délai, statut et JSON invalide lèvent un message lisible. */
export async function getJson(url: string, quoi: string, deps: DepsRest): Promise<unknown> {
  const jeton = (deps.lireJeton ?? lireJetonOauth)();
  const fetchFn = deps.fetchFn ?? fetch;
  let reponse: Response;
  try {
    reponse = await fetchFn(url, { headers: enTetes(jeton), signal: AbortSignal.timeout(deps.delaiMs ?? DELAI_REST_MS) });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const delai = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new ErreurSessionDistante(
      delai ? `Aucune réponse de ${URL_API} pour ${quoi} après ${Math.round((deps.delaiMs ?? DELAI_REST_MS) / 1000)} s.` : `API injoignable pour ${quoi} (${cause}) : réseau, VPN ou pare-feu.`,
    );
  }
  if (!reponse.ok) throw new ErreurSessionDistante(messageHttp(reponse.status, quoi));
  try {
    return await reponse.json();
  } catch {
    throw new ErreurSessionDistante(`Réponse illisible pour ${quoi} (JSON invalide) : l'interface de l'API a peut-être changé.`);
  }
}

export function texteOuNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function enObjet(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function instantOuNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Une entrée de la liste, projetée ; `null` si elle n'a pas d'identifiant (inexploitable). */
export function projeterSession(entree: unknown): SessionDistante | null {
  const e = enObjet(entree);
  const id = e ? texteOuNull(e.id) : null;
  if (!e || !id) return null;
  const config = enObjet(e.config);
  const etiquettes = Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === "string") : [];
  return {
    id,
    titre: texteOuNull(e.title),
    statut: texteOuNull(e.status),
    connexion: texteOuNull(e.connection_status),
    travail: texteOuNull(e.worker_status),
    modele: config ? texteOuNull(config.model) : null,
    origine: etiquettes[0] ?? null,
    majLe: instantOuNull(e.updated_at) ?? instantOuNull(e.last_activity_at) ?? instantOuNull(e.created_at),
    depot: depotDeConfig(config),
    environnement: texteOuNull(e.environment_id),
  };
}

/**
 * T-173 — identité « propriétaire/dépôt » (minuscules) d'une adresse de dépôt :
 * schéma, utilisateur, hôte, port, alias SSH (`alias:`, `user@hôte:`), `.git`
 * final et `/` superflus retirés ; les DEUX derniers segments sont gardés.
 * `null` si l'adresse n'en contient pas deux.
 */
export function identiteDepot(brut: unknown): string | null {
  if (typeof brut !== "string") return null;
  let chemin = brut.trim();
  const schema = chemin.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]*)\/?(.*)$/i);
  if (schema) {
    chemin = schema[2] ?? "";
  } else {
    // Forme scp (`alias:proprio/depot`, `git@hote:proprio/depot`) : tout ce qui précède le premier « : » est un hôte.
    const scp = chemin.match(/^[^/:]+:(?!\/\/)(.*)$/);
    if (scp) chemin = scp[1] ?? "";
  }
  const segments = chemin
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((x) => x.length > 0);
  if (segments.length < 2) return null;
  return segments.slice(-2).join("/").toLowerCase();
}

/** T-173 — `outcomes[].git_info.repo`, à défaut `sources[].url`, normalisés ; `null` pour une session sans dépôt. */
export function depotDeConfig(config: Record<string, unknown> | null): string | null {
  if (!config) return null;
  const outcomes = Array.isArray(config.outcomes) ? config.outcomes : [];
  for (const o of outcomes) {
    const info = enObjet(enObjet(o)?.git_info);
    const id = info ? identiteDepot(info.repo) : null;
    if (id) return id;
  }
  const sources = Array.isArray(config.sources) ? config.sources : [];
  for (const src of sources) {
    const id = identiteDepot(enObjet(src)?.url);
    if (id) return id;
  }
  return null;
}

export interface AnalyseSessionsDistantes {
  sessions: SessionDistante[];
  /** Entrées écartées faute d'identifiant — comptées pour être journalisées, pas avalées. */
  ignorees: number;
}

/**
 * Analyse la réponse de `GET /v1/code/sessions` : `{data: [...]}` ou tableau
 * nu. Tout autre forme lève. Archivées masquées sauf demande. Plus récentes
 * d'abord.
 */
export function analyserListe(brut: unknown, archivees: boolean): AnalyseSessionsDistantes {
  const corps = enObjet(brut);
  const liste = Array.isArray(brut) ? brut : corps && Array.isArray(corps.data) ? corps.data : null;
  if (!liste) {
    throw new ErreurSessionDistante("Liste des sessions distantes inattendue (ni tableau ni champ « data ») : l'interface de l'API a peut-être changé.");
  }
  const sessions: SessionDistante[] = [];
  let ignorees = 0;
  for (const entree of liste) {
    const s = projeterSession(entree);
    if (!s) {
      ignorees += 1;
      continue;
    }
    if (!archivees && s.statut === "archived") continue;
    sessions.push(s);
  }
  sessions.sort((a, b) => (b.majLe ?? 0) - (a.majLe ?? 0));
  return { sessions, ignorees };
}

export async function listerSessionsDistantes(options: { archivees?: boolean }, deps: DepsRest = {}): Promise<AnalyseSessionsDistantes> {
  const brut = await getJson(`${URL_API}/v1/code/sessions`, "la liste des sessions distantes", deps);
  return analyserListe(brut, options.archivees === true);
}

// ---------------------------------------------------------------------------
// queryFn distant
// ---------------------------------------------------------------------------

/** Le sous-ensemble du `query` « browser » du SDK qu'on appelle (types en vrac : l'interface est instable). */
export type QueryBrowser = (options: {
  prompt: AsyncIterable<Record<string, unknown>>;
  abortController: AbortController;
  canUseTool?: CanUseTool;
  sse: {
    streamUrl: string;
    sendUrl: string;
    sessionId: string;
    headers: Record<string, string>;
    fromSequenceNum: number;
    onDeliveryUpdate?: (u: { event_id: string; status: string; timestamp?: string }) => void;
    onCatchUpTruncated?: () => void;
  };
}) => ClaudeQuery;

export interface DepsQueryDistant extends DepsRest {
  chargerQuery?: () => Promise<QueryBrowser>;
  delaiInterruptionMs?: number;
}

async function chargerQueryBrowser(): Promise<QueryBrowser> {
  const sdk = (await import("@anthropic-ai/claude-agent-sdk/browser")) as unknown as { query: QueryBrowser };
  return sdk.query;
}

/**
 * Curseur de départ : le plus grand `sequence_num` de `GET …/events`. Un tour
 * ne doit voir QUE ce qui suit son envoi — rejouer l'historique y mêlerait
 * d'anciens `result` qui clôtureraient le tour avant l'heure (constaté le
 * 2026-10-21 : chaque envoi recevait la réponse d'un tour précédent).
 * Piège : la liste vient du PLUS RÉCENT au plus ancien, et son `resume_cursor`
 * désigne le plus ancien de la page (pagination vers le passé) — ce n'est PAS
 * un point de reprise. Session sans événement : 0. Champ `data` absent ou
 * numéros illisibles : on lève (format inattendu) plutôt que de repartir de 0
 * en silence.
 */
export function lireCurseur(brut: unknown): number {
  const corps = enObjet(brut);
  const donnees = corps ? corps.data : undefined;
  if (!Array.isArray(donnees)) {
    throw new ErreurSessionDistante("Liste d'événements absente de la réponse (champ « data ») : l'interface de l'API a peut-être changé.");
  }
  let max = 0;
  for (const evenement of donnees) {
    const n = Number(enObjet(evenement)?.sequence_num);
    if (!Number.isFinite(n) || n < 0) {
      throw new ErreurSessionDistante("Numéro d'événement illisible (champ « sequence_num ») : l'interface de l'API a peut-être changé.");
    }
    if (n > max) max = n;
  }
  return max;
}

/**
 * Détail de session (`GET /v1/code/sessions/{id}`) : l'API l'enveloppe dans
 * `response_shape` (constaté le 2026-10-21, T-174) ; `data` / `session` et le
 * corps nu sont tolérés. Lire le corps tel quel faisait passer pour « champ
 * absent » l'état d'une session pourtant déconnectée.
 */
export function lireDetailSession(brut: unknown): Record<string, unknown> {
  const corps = enObjet(brut);
  if (!corps) throw new ErreurSessionDistante("Détail de session inattendu (objet attendu) : l'interface de l'API a peut-être changé.");
  if (texteOuNull(corps.id) === null) {
    const enveloppe = enObjet(corps.response_shape) ?? enObjet(corps.data) ?? enObjet(corps.session);
    if (enveloppe) return enveloppe;
  }
  return corps;
}

/**
 * Contrôle l'état de la session AVANT d'écrire dedans : un message envoyé à une
 * session déconnectée est accepté par le serveur puis jamais traité — le tour
 * se tairait. Un champ absent n'interdit rien (on ne bloque que sur un état
 * connu et différent de « connected »).
 */
export function verifierConnectee(brut: unknown): void {
  const corps = lireDetailSession(brut);
  const connexion = texteOuNull(corps.connection_status);
  if (connexion !== null && connexion !== "connected") {
    throw new ErreurSessionDistante(`La session distante est déconnectée (état : ${connexion}). Relancez /remote-control sur l'autre machine, puis réessayez.`);
  }
}

/**
 * `ClaudeQueryFn` branché sur la session distante `sessionId`. Les options
 * locales (cwd, modèle, MCP, instruction système…) sont ignorées : c'est la
 * machine distante qui décide. Sont relayés : `prompt`, `canUseTool`, et le
 * mode de permission choisi dans IAction (`setPermissionMode`, T-167) — sans
 * lui, la session distante garde son mode de lancement et demande tout.
 *
 * Le flux SSE ne se termine pas de lui-même : on rend la main APRÈS le
 * `result` du tour (le moteur en fait la fin de son tour) et on coupe la
 * connexion. `interrupt()` relaie l'interruption à la machine distante ; sans
 * réponse sous `DELAI_INTERRUPTION_MS`, on coupe le flux pour que le tour ne
 * reste pas suspendu.
 */
export function creerQueryFnDistant(sessionId: string, deps: DepsQueryDistant = {}): ClaudeQueryFn {
  return ({ prompt, options }) => {
    const controleur = new AbortController();
    let query: ClaudeQuery | null = null;
    let fini = false;
    let minuteur: ReturnType<typeof setTimeout> | null = null;
    const couper = () => {
      if (minuteur) clearTimeout(minuteur);
      controleur.abort();
    };

    async function* flux(): AsyncGenerator<unknown> {
      const base = `${URL_API}/v1/code/sessions/${encodeURIComponent(sessionId)}`;
      try {
        verifierConnectee(await getJson(base, "la session distante", deps));
        const depuis = lireCurseur(await getJson(`${base}/events`, "l'historique de la session distante", deps));
        const queryBrowser = await (deps.chargerQuery ?? chargerQueryBrowser)();
        const canUseTool = options?.canUseTool;
        journal.info("claude", "session distante : connexion", { fields: { sessionId, curseur: depuis } });
        query = queryBrowser({
          prompt: prompt as AsyncIterable<Record<string, unknown>>,
          abortController: controleur,
          ...(canUseTool
            ? { canUseTool: async (outil, entree, opts) => (await canUseTool(outil, entree, opts)) ?? { behavior: "deny", message: "Refusé" } }
            : {}),
          sse: {
            streamUrl: `${base}/events/stream`,
            sendUrl: `${base}/events`,
            sessionId,
            // Jeton relu ICI, à la connexion : Claude Code a pu le renouveler depuis le tour précédent.
            headers: enTetes((deps.lireJeton ?? lireJetonOauth)()),
            fromSequenceNum: depuis,
            onDeliveryUpdate: (u) => journal.debug("claude", "session distante : accusé", { fields: { sessionId, statut: u.status } }),
            onCatchUpTruncated: () => journal.warn("claude", "session distante : rattrapage tronqué, des événements ont pu être manqués", { fields: { sessionId } }),
          },
        });
        // T-167 — le mode choisi s'applique à la session distante. Refus (ex.
        // « bypassPermissions » sur une session lancée sans l'autoriser) :
        // journalisé, le tour continue dans le mode distant.
        const mode = options?.permissionMode;
        const q = query as { setPermissionMode?: (m: string) => Promise<void> };
        if (mode && typeof q.setPermissionMode === "function") {
          q.setPermissionMode(mode).catch((err: unknown) => {
            journal.warn("claude", "session distante : mode de permission refusé", { fields: { sessionId, mode, cause: err instanceof Error ? err.message : String(err) } });
          });
        }
        // Course contre la coupure : un flux SSE muet ne rend jamais la main de lui-même.
        const coupure = new Promise<"coupure">((resolve) => controleur.signal.addEventListener("abort", () => resolve("coupure"), { once: true }));
        const it = (query as AsyncIterable<unknown>)[Symbol.asyncIterator]();
        while (true) {
          const attente = it.next();
          attente.catch(() => undefined); // abandonnée à la coupure : son rejet éventuel n'a plus de lecteur
          const suite = await Promise.race([attente, coupure]);
          if (suite === "coupure") return;
          if (suite.done) return;
          const message = suite.value;
          const type = typeof message === "object" && message !== null ? (message as { type?: unknown }).type : undefined;
          yield message;
          if (type === "result") return;
        }
      } catch (err) {
        // Coupure voulue (interrupt sans réponse, fin de tour) : pas une panne.
        if (controleur.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        journal.error("claude", "session distante : flux en échec", { fields: { sessionId, cause: message } });
        throw err instanceof ErreurSessionDistante ? err : new ErreurSessionDistante(`Session distante : ${message}`);
      } finally {
        fini = true;
        couper();
      }
    }

    const iterateur = flux();
    return {
      [Symbol.asyncIterator]: () => iterateur,
      interrupt: async () => {
        if (fini) return;
        if (!query) {
          couper();
          return;
        }
        minuteur = setTimeout(() => {
          journal.warn("claude", "session distante : interruption sans réponse, flux coupé", { fields: { sessionId } });
          controleur.abort();
        }, deps.delaiInterruptionMs ?? DELAI_INTERRUPTION_MS);
        await query.interrupt();
      },
    };
  };
}
