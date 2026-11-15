/*
 * T-180 — une session distante PAR CONVERSATION IAction, créée à la demande
 * sur un relais en mode serveur (`claude remote-control --name …`), voir
 * docs/spec-sessions-claude.md § « Une session par conversation ».
 *
 * Un RELAIS est une session `remote-control-cli` portant un `environment_id`
 * (environnement « bridge ») : on ne lui parle plus, on lui fait créer des
 * sessions neuves. L'association (conversation IAction + relais + fil → id de
 * session distante) est persistée dans le dossier d'état du sidecar : elle
 * survit au redémarrage, et le balayage de démarrage archive les sessions
 * restées inactives plus de 7 jours.
 *
 * Interface non documentée de l'API : tout écart échoue BRUYAMMENT (message
 * lisible + journal), jamais un échec muet — un échec d'archivage compris.
 */

import { promises as fsp, readFileSync } from "node:fs";
import path from "node:path";

import { globalDataRoot } from "./appPaths.js";
import { isNonEmptyString } from "./base.js";
import * as journal from "./journal.js";
import type { EngineEmitter } from "./engine.js";
import {
  cheminJeton,
  DELAI_REST_MS,
  enObjet,
  enTetes,
  envJetonCourant,
  ErreurSessionDistante,
  listerSessionsDistantes,
  lireJetonOauth,
  messageHttp,
  texteOuNull,
  URL_API,
  type DepsRest,
  type EnvJeton,
  type SessionDistante,
} from "./sessionsDistantes.js";
import { creerVerrous } from "./verrousSessions.js";

export const FIL_DEFAUT = "defaut";
/** Étiquette (première `tags[]`) d'une session de relais en mode serveur. */
export const ETIQUETTE_RELAIS = "remote-control-cli";
/** Une session associée non utilisée depuis ce délai est archivée au démarrage. */
export const INACTIVITE_MAX_MS = 7 * 24 * 3600 * 1000;
const BETA_SESSIONS = "ccr-byoc-2025-07-29";
const LONGUEUR_FIL_MAX = 40;

/** Une association « conversation IAction + relais + fil → session distante ». */
export interface FilDistant {
  /** Identifiant de la conversation IAction. */
  conversation: string;
  /** Clé du relais : son titre (`--name`), à défaut l'id de son environnement. */
  relais: string;
  /** Environnement (`env_…`) sur lequel la session a été créée. */
  environnement: string;
  fil: string;
  /** Identifiant de CRÉATION (`session_…`) — celui que l'archivage attend. */
  session: string;
  creeLe: number;
  utiliseLe: number;
}

export interface DepsFils extends DepsRest {
  /** `organizationUuid` du fichier de jeton — tests : valeur factice. */
  lireOrganisation?: () => string;
  /** Fichier des associations — tests : fichier jetable. */
  cheminFils?: string;
  maintenant?: () => number;
  /** Attente maximale qu'une session NEUVE passe `connected` (défaut 30 s). */
  attenteCreationMs?: number;
  /** Attente accordée à une session associée déconnectée avant d'en recréer une (défaut 10 s). */
  graceMs?: number;
  /** Pas d'interrogation pendant ces attentes (défaut 2 s). */
  pasAttenteMs?: number;
}

/** Vrai pour une session de relais en mode serveur (et non une session interactive `--remote-control`). */
export function estRelais(s: Pick<SessionDistante, "origine" | "environnement"> | null): boolean {
  return s !== null && s.origine === ETIQUETTE_RELAIS && isNonEmptyString(s.environnement);
}

/** `session_<suffixe>` (création) → `cse_<suffixe>` (listes). */
export function versCse(session: string): string {
  return `cse_${session.replace(/^session_/, "")}`;
}

/** Nom de fil nettoyé : espaces réduits, 40 caractères, `defaut` si vide. */
export function normaliserFil(brut: unknown): string {
  const t = typeof brut === "string" ? brut.replace(/\s+/g, " ").trim().slice(0, LONGUEUR_FIL_MAX) : "";
  return t === "" ? FIL_DEFAUT : t;
}

// ---------------------------------------------------------------------------
// Organisation + POST
// ---------------------------------------------------------------------------

/** `organizationUuid` du fichier d'identifiants de Claude Code. Jamais citer le jeton. */
export function lireOrganisation(env: EnvJeton = envJetonCourant()): string {
  const fichier = cheminJeton(env);
  let brut: unknown;
  try {
    brut = JSON.parse(readFileSync(fichier, "utf8"));
  } catch {
    throw new ErreurSessionDistante(`Identifiants Claude illisibles (${fichier}) : connectez Claude Code à claude.ai (/login).`);
  }
  const org = texteOuNull(enObjet(brut)?.organizationUuid);
  if (!org) throw new ErreurSessionDistante(`Aucun « organizationUuid » dans ${fichier} : reconnectez Claude Code à claude.ai (/login).`);
  return org;
}

interface ReponsePost {
  ok: boolean;
  statut: number;
  corps: unknown;
}

async function poster(chemin: string, quoi: string, corps: unknown, deps: DepsFils): Promise<ReponsePost> {
  const jeton = (deps.lireJeton ?? lireJetonOauth)();
  const organisation = (deps.lireOrganisation ?? lireOrganisation)();
  const delaiMs = deps.delaiMs ?? DELAI_REST_MS;
  let reponse: Response;
  try {
    reponse = await (deps.fetchFn ?? fetch)(`${URL_API}${chemin}`, {
      method: "POST",
      headers: { ...enTetes(jeton), "anthropic-beta": BETA_SESSIONS, "x-organization-uuid": organisation, "content-type": "application/json" },
      body: JSON.stringify(corps),
      signal: AbortSignal.timeout(delaiMs),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    const delai = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new ErreurSessionDistante(delai ? `Aucune réponse de ${URL_API} pour ${quoi} après ${Math.round(delaiMs / 1000)} s.` : `API injoignable pour ${quoi} (${cause}) : réseau, VPN ou pare-feu.`);
  }
  let json: unknown = null;
  try {
    json = await reponse.json();
  } catch {
    // Corps absent ou non JSON : seul le statut compte pour l'archivage ; la création vérifie le sien.
  }
  return { ok: reponse.ok, statut: reponse.status, corps: json };
}

/** Archive une session de création (`session_…`). `true` = archivée, `false` = déjà introuvable ; lève sinon. */
export async function archiverSession(session: string, deps: DepsFils = {}): Promise<boolean> {
  const quoi = "l'archivage de la session distante";
  const rep = await poster(`/v1/sessions/${encodeURIComponent(session)}/archive`, quoi, {}, deps);
  if (rep.ok) return true;
  if (rep.statut === 404) return false;
  throw new ErreurSessionDistante(messageHttp(rep.statut, quoi));
}

/** Archivage qui ne lève jamais : l'échec est journalisé (et rendu en `false`). */
async function archiverOuJournaliser(session: string, contexte: string, deps: DepsFils): Promise<boolean> {
  try {
    await archiverSession(session, deps);
    return true;
  } catch (err) {
    journal.error("claude", "archivage d'une session distante en échec", { fields: { session, contexte, cause: err instanceof Error ? err.message : String(err) } });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Association persistée
// ---------------------------------------------------------------------------

const verrousStore = creerVerrous();
const verrousFils = creerVerrous();

export function cheminFilsDefaut(): string {
  return path.join(globalDataRoot(), "state", "sessions-distantes-fils.json");
}

function analyserFil(v: unknown): FilDistant | null {
  const e = enObjet(v);
  if (!e) return null;
  const { conversation, relais, environnement, fil, session } = e;
  if (![conversation, relais, environnement, fil, session].every(isNonEmptyString)) return null;
  const creeLe = typeof e.creeLe === "number" ? e.creeLe : 0;
  const utiliseLe = typeof e.utiliseLe === "number" ? e.utiliseLe : creeLe;
  return { conversation, relais, environnement, fil, session, creeLe, utiliseLe } as FilDistant;
}

/** Relit les associations. Absent = aucune ; illisible = mis de côté (`.corrompu`) ET journalisé en erreur. */
export async function lireFils(chemin: string): Promise<FilDistant[]> {
  let texte: string;
  try {
    texte = await fsp.readFile(chemin, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    journal.error("claude", "associations de sessions distantes illisibles", { fields: { chemin, cause: err instanceof Error ? err.message : String(err) } });
    throw new ErreurSessionDistante(`Associations de sessions distantes illisibles (${chemin}).`);
  }
  try {
    const liste = enObjet(JSON.parse(texte))?.fils;
    if (!Array.isArray(liste)) throw new Error("champ « fils » absent");
    const fils = liste.map(analyserFil);
    const ecartees = fils.filter((f) => f === null).length;
    if (ecartees > 0) journal.warn("claude", "associations de sessions distantes : entrées ignorées", { fields: { chemin, ecartees } });
    return fils.filter((f): f is FilDistant => f !== null);
  } catch (err) {
    const mis = `${chemin}.corrompu-${Date.now()}`;
    await fsp.rename(chemin, mis).catch(() => undefined);
    journal.error("claude", "associations de sessions distantes corrompues : fichier mis de côté", { fields: { chemin, mis, cause: err instanceof Error ? err.message : String(err) } });
    return [];
  }
}

/** Lecture-modification-écriture atomique, sérialisée par fichier. */
async function modifierFils(chemin: string, transformer: (fils: FilDistant[]) => FilDistant[]): Promise<FilDistant[]> {
  const liberer = await verrousStore.prendre(chemin);
  try {
    const suite = transformer(await lireFils(chemin));
    await fsp.mkdir(path.dirname(chemin), { recursive: true });
    const tmp = `${chemin}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, fils: suite }, null, 2), "utf8");
    await fsp.rename(tmp, chemin);
    return suite;
  } finally {
    liberer();
  }
}

const memeFil = (a: FilDistant, conversation: string, relais: string, fil: string) => a.conversation === conversation && a.relais === relais && a.fil === fil;

// ---------------------------------------------------------------------------
// Ouverture d'un fil
// ---------------------------------------------------------------------------

export interface DemandeFil {
  /** `null` = tour sans conversation IAction identifiée. */
  conversation: string | null;
  relais: Pick<SessionDistante, "id" | "titre" | "environnement">;
  fil: string;
  /** Liste courante des sessions (archivées exclues). */
  sessions: SessionDistante[];
}

export interface FilOuvert {
  /** Identifiant `cse_…` à interroger. */
  id: string;
  titre: string;
  nouvelle: boolean;
  /** Raison de la perte du contexte précédent, si une session associée a dû être recréée. */
  perdu: string | null;
}

const dormir = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function attendreConnexion(cse: string, dureeMs: number, deps: DepsFils): Promise<boolean> {
  const fin = Date.now() + dureeMs;
  for (;;) {
    const { sessions } = await listerSessionsDistantes({}, deps);
    if (sessions.find((s) => s.id === cse)?.connexion === "connected") return true;
    if (Date.now() >= fin) return false;
    await dormir(deps.pasAttenteMs ?? 2000);
  }
}

function titreDuFil(conversation: string, fil: string): string {
  return `IAction ${conversation.slice(0, 8)}${fil === FIL_DEFAUT ? "" : ` · ${fil}`}`;
}

async function creerSurRelais(environnement: string, titre: string, deps: DepsFils): Promise<string> {
  const quoi = "la création d'une session sur le relais";
  const corps = { title: titre, events: [], session_context: { sources: [], outcomes: [], model: null, cwd: "" }, environment_id: environnement, source: "remote-control" };
  const rep = await poster("/v1/sessions", quoi, corps, deps);
  if (!rep.ok) throw new ErreurSessionDistante(messageHttp(rep.statut, quoi));
  const id = texteOuNull(enObjet(rep.corps)?.id);
  if (!id || !id.startsWith("session_")) {
    throw new ErreurSessionDistante("Réponse de création de session inattendue (identifiant « session_… » absent) : l'interface de l'API a peut-être changé.");
  }
  return id;
}

/**
 * Rend la session distante du fil (conversation, relais, fil), en la créant au
 * besoin. `null` si la cible désignée est déjà une session de fil (on lui parle
 * directement). Une session associée archivée, introuvable ou déconnectée
 * au-delà de la grâce est recréée, et `perdu` le dit.
 */
export async function ouvrirFil(demande: DemandeFil, deps: DepsFils = {}): Promise<FilOuvert | null> {
  const { conversation, relais } = demande;
  const chemin = deps.cheminFils ?? cheminFilsDefaut();
  if (!isNonEmptyString(conversation)) {
    throw new ErreurSessionDistante(
      "Conversation IAction inconnue : impossible d'ouvrir une session distante dédiée sur un relais (tour sans identifiant de conversation). Désignez une session interactive, ou lancez l'échange depuis une conversation d'IAction.",
    );
  }
  const environnement = relais.environnement as string;
  const cle = relais.titre ?? environnement;
  const liberer = await verrousFils.prendre(`${conversation}|${cle}|${demande.fil}`);
  try {
    const fils = await lireFils(chemin);
    if (fils.some((f) => versCse(f.session) === relais.id)) return null;
    const maintenant = (deps.maintenant ?? Date.now)();
    const existant = fils.find((f) => memeFil(f, conversation, cle, demande.fil));
    let perdu: string | null = null;
    if (existant) {
      const cse = versCse(existant.session);
      const vue = demande.sessions.find((s) => s.id === cse);
      if (vue && (vue.connexion === "connected" || (await attendreConnexion(cse, deps.graceMs ?? 10_000, deps)))) {
        await modifierFils(chemin, (l) => l.map((f) => (memeFil(f, conversation, cle, demande.fil) ? { ...f, utiliseLe: maintenant } : f)));
        return { id: cse, titre: vue.titre ?? titreDuFil(conversation, demande.fil), nouvelle: false, perdu: null };
      }
      if (vue) {
        perdu = "la session précédente est restée déconnectée";
        await archiverOuJournaliser(existant.session, "déconnectée durablement, remplacée", deps);
      } else {
        perdu = "la session précédente est archivée ou introuvable";
      }
      journal.warn("claude", "session distante du fil perdue : recréation", { fields: { conversation, relais: cle, fil: demande.fil, session: existant.session, raison: perdu } });
    }
    const titre = titreDuFil(conversation, demande.fil);
    const session = await creerSurRelais(environnement, titre, deps);
    const neuf: FilDistant = { conversation, relais: cle, environnement, fil: demande.fil, session, creeLe: maintenant, utiliseLe: maintenant };
    try {
      await modifierFils(chemin, (l) => [...l.filter((f) => !memeFil(f, conversation, cle, demande.fil)), neuf]);
    } catch (err) {
      await archiverOuJournaliser(session, "association non enregistrée", deps);
      throw err;
    }
    const cse = versCse(session);
    journal.info("claude", "session distante ouverte pour une conversation", { fields: { conversation, relais: cle, fil: demande.fil, session } });
    if (!(await attendreConnexion(cse, deps.attenteCreationMs ?? 30_000, deps))) {
      await archiverOuJournaliser(session, "jamais connectée", deps);
      await modifierFils(chemin, (l) => l.filter((f) => f.session !== session));
      throw new ErreurSessionDistante(`Le relais « ${cle} » n'a pas pris la session créée (restée déconnectée) : relais arrêté ou injoignable ? La session a été archivée ; relancez le relais (claude remote-control --name ${cle}) puis réessayez.`);
    }
    return { id: cse, titre, nouvelle: true, perdu };
  } finally {
    liberer();
  }
}

/** Phrase à placer en tête du résultat de l'outil quand le fil vient d'être (re)créé ; `""` sinon. */
export function noteFil(ouvert: FilOuvert | null, fil: string): string {
  if (!ouvert || (!ouvert.nouvelle && !ouvert.perdu)) return "";
  const nom = fil === FIL_DEFAUT ? "" : ` (fil « ${fil} »)`;
  return ouvert.perdu ? `Nouvelle session distante${nom}, contexte précédent perdu (${ouvert.perdu}).` : `Nouvelle session distante ouverte pour cette conversation${nom}.`;
}

/** Suffixe de `sessions_distantes_lister` : relais ou session de fil. */
export function annotationFil(s: SessionDistante, fils: readonly FilDistant[]): string {
  if (fils.some((f) => versCse(f.session) === s.id)) return " — fil IAction : session propre à une conversation";
  return estRelais(s) ? " — relais : crée une session par conversation" : "";
}

// ---------------------------------------------------------------------------
// Archivage : conversation supprimée, balayage de démarrage
// ---------------------------------------------------------------------------

async function archiverEntrees(choisir: (f: FilDistant) => boolean, contexte: string, deps: DepsFils): Promise<{ archivees: number; echecs: number }> {
  const chemin = deps.cheminFils ?? cheminFilsDefaut();
  const cibles = (await lireFils(chemin)).filter(choisir);
  if (cibles.length === 0) return { archivees: 0, echecs: 0 };
  const faites = new Set<string>();
  let echecs = 0;
  for (const f of cibles) {
    if (await archiverOuJournaliser(f.session, contexte, deps)) faites.add(f.session);
    else echecs += 1;
  }
  if (faites.size > 0) await modifierFils(chemin, (l) => l.filter((f) => !faites.has(f.session)));
  return { archivees: faites.size, echecs };
}

/** Archive les sessions de fil d'une conversation IAction (supprimée). Sans association : aucun appel réseau. */
export function archiverFilsConversation(conversation: string, deps: DepsFils = {}) {
  return archiverEntrees((f) => f.conversation === conversation, "conversation supprimée", deps);
}

/** Balayage de démarrage : archive les sessions de fil inactives depuis plus de 7 jours. Ne lève jamais. */
export async function balayerFilsInactifs(deps: DepsFils = {}): Promise<{ archivees: number; echecs: number }> {
  try {
    const limite = (deps.maintenant ?? Date.now)() - INACTIVITE_MAX_MS;
    const bilan = await archiverEntrees((f) => f.utiliseLe < limite, "inactive depuis plus de 7 jours", deps);
    if (bilan.archivees > 0 || bilan.echecs > 0) journal.info("claude", "balayage des sessions distantes inactives", { fields: bilan });
    return bilan;
  } catch (err) {
    journal.error("claude", "balayage des sessions distantes inactives en échec", { fields: { cause: err instanceof Error ? err.message : String(err) } });
    return { archivees: 0, echecs: 1 };
  }
}

/** `sessionsDistantes.archiverConversation { conversationId }` — voir docs/protocol.md. */
export async function handleSessionsDistantesArchiverConversation(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  if (!isNonEmptyString(params.conversationId)) {
    emitter.error(id, "params.conversationId manquant ou invalide");
    return;
  }
  try {
    emitter.done(id, await archiverFilsConversation(params.conversationId));
  } catch (err) {
    journal.error("claude", "archivage des sessions distantes d'une conversation en échec", { reqId: id, fields: { cause: err instanceof Error ? err.message : String(err) } });
    emitter.error(id, err instanceof Error ? err.message : String(err));
  }
}
