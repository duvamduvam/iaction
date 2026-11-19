/**
 * Secrets MCP — table EN MÉMOIRE poussée par la coquille depuis le coffre
 * chiffré (docs/etude-coffre-secrets.md § 4.2).
 *
 * D'où viennent les secrets d'un tour :
 * - coquille présente, coffre `ouvert` : la table poussée (classe `coffre`
 *   et `sans-fenetre`) ; une écriture part à la coquille (`coffre:ecrire`)
 *   et n'est réussie qu'à SON accusé (`coffre.ecrit`), après écriture et
 *   relecture du coffre ;
 * - coquille présente, coffre `verrouille` : les seuls `sans-fenetre`
 *   (poussés quand même) ; écriture refusée. Un serveur qui attend un secret
 *   du coffre est écarté, avec la cause dite (mcp.ts) ;
 * - coquille présente, coffre `absent` (poste qui n'a pas encore créé son
 *   coffre) : l'ancien `<config>/mcp-secrets.json`, comme avant le coffre ;
 * - SANS coquille (tâche de fond) : coffre créé → les `sans-fenetre` du
 *   trousseau (trousseauFond.ts) ; pas de coffre → l'ancien fichier.
 *
 * Coffre créé mais ancien fichier encore présent (migration pas faite, ou
 * partielle) : il est lu EN REPLI pour les noms que le coffre ne sert pas.
 * Sans cela, créer le coffre et fermer l'écran de migration privait tous les
 * serveurs MCP de leurs jetons, et la tâche du matin aussi. Le coffre prime
 * toujours ; la migration (coquille, § 7) vide puis supprime le fichier.
 *
 * La table du coffre n'est JAMAIS écrite sur le disque par le sidecar.
 *
 * Raison d'être : un `.mcp.json` est du contrat de projet, versionné et
 * partagé ; il ne doit contenir aucun jeton. Il porte donc des références
 * `${SECRET:nom}` (dans `env`, `headers`, `args`, `url`…) que ce module
 * résout au lancement du tour.
 *
 * Contrat non négociable : **la valeur d'un secret ne sort jamais d'ici** —
 * ni dans le journal, ni dans une réponse RPC, ni dans un message d'erreur.
 * Seuls les NOMS circulent. Les valeurs ne vont que dans un sens : UI →
 * coffre → options du SDK.
 *
 * Aucune dépendance vers les autres modules MCP : c'est la brique du bas
 * (mcp.ts et mcpCatalog.ts l'utilisent, jamais l'inverse).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { isNonEmptyString, isPlainObject } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import { globalConfigRoot } from "./jsonlStore.js";
import * as journal from "./journal.js";
import { coffreExiste, lireSecretsSansFenetre } from "./trousseauFond.js";

/** `<config>/mcp-secrets.json` — coffre local des secrets MCP (mode 0600). */
export function mcpSecretsPath(): string {
  return path.join(globalConfigRoot(), "mcp-secrets.json");
}


// ---------------------------------------------------------------------------
// Références `${SECRET:nom}` — fonctions PURES
// ---------------------------------------------------------------------------

const SECRET_REF_RE = /\$\{SECRET:([A-Za-z0-9_.-]+)\}/g;

/** Noms de secrets référencés par une valeur (récursif) — dédoublonnés, triés. */
export function collectSecretRefs(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(SECRET_REF_RE)) {
        found.add(m[1]);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (isPlainObject(v)) {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return [...found].sort();
}

/**
 * Remplace les `${SECRET:nom}` par leur valeur (récursif, structure
 * préservée). `missing` liste les références introuvables — l'appelant décide
 * quoi en faire (mcp.ts écarte le serveur : mieux vaut pas de serveur qu'un
 * serveur démarré avec un jeton littéral `${SECRET:…}`, qui échouerait à la
 * première requête sans dire pourquoi).
 */
export function resolveSecretRefs(
  value: unknown,
  secrets: Record<string, string>,
): { value: unknown; missing: string[] } {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(SECRET_REF_RE, (whole, name: string) => {
        const secret = secrets[name];
        if (typeof secret !== "string") {
          missing.add(name);
          return whole;
        }
        return secret;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return { value: walk(value), missing: [...missing].sort() };
}

/** Référence à écrire dans `.mcp.json` pour un secret donné. */
export function secretRef(name: string): string {
  return `\${SECRET:${name}}`;
}

// ---------------------------------------------------------------------------
// Table du coffre (poussée par la coquille)
// ---------------------------------------------------------------------------

export type EtatCoffre = "absent" | "verrouille" | "ouvert";

let etatCoffre: EtatCoffre = "absent";
let tableCoffre: Record<string, string> = {};
/** La coquille a-t-elle déjà poussé un état ? Faux = sidecar sans coquille (tâche de fond). */
let chargeParCoquille = false;

/**
 * Canal vers la coquille : une ligne d'événement sur stdout, interceptée par
 * Rust et jamais relayée à l'interface (elle porte une valeur). Injecté par
 * index.ts ; muet par défaut (tests, sidecar sans coquille).
 */
let versCoquille: (event: string, data: Record<string, unknown>) => void = () => {};

export function definirCanalCoquille(f: (event: string, data: Record<string, unknown>) => void): void {
  versCoquille = f;
}

/**
 * Demandes d'écriture en attente de l'accusé de la coquille. Sans accusé, pas
 * de succès : un « enregistré » qui ne l'est pas fait supprimer l'original
 * (un `.env` migré) ou écrire `${SECRET:x}` dans `.mcp.json` pour rien.
 */
const enAttente = new Map<string, { resoudre: () => void; rejeter: (e: Error) => void; minuteur: NodeJS.Timeout }>();
let compteurDemandes = 0;
/** Délai d'accusé. L'écriture du coffre ne coûte qu'un chiffrement et un renommage. */
let delaiAccuseMs = 15_000;

/** Tests seulement. */
export function definirDelaiAccuse(ms: number): void {
  delaiAccuseMs = ms;
}

function demanderACoquille(event: "coffre:ecrire" | "coffre:retirer", data: Record<string, unknown>): Promise<void> {
  compteurDemandes += 1;
  const demande = `d-${process.pid}-${compteurDemandes}`;
  return new Promise<void>((resoudre, rejeter) => {
    const minuteur = setTimeout(() => {
      enAttente.delete(demande);
      rejeter(new Error("le coffre n'a pas confirmé l'écriture : rien n'est garanti enregistré, réessaie"));
    }, delaiAccuseMs);
    enAttente.set(demande, { resoudre, rejeter, minuteur });
    versCoquille(event, { ...data, demande });
  });
}

/** `coffre.ecrit {demande, ok, erreur?}` — accusé de la coquille. */
export function handleCoffreEcrit(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void {
  const demande = typeof params.demande === "string" ? params.demande : "";
  const attente = enAttente.get(demande);
  if (!attente) {
    emitter.error(id, "accusé sans demande en attente");
    return;
  }
  enAttente.delete(demande);
  clearTimeout(attente.minuteur);
  if (params.ok === true) attente.resoudre();
  else attente.rejeter(new Error(isNonEmptyString(params.erreur) ? `coffre : ${params.erreur}` : "écriture du coffre en échec"));
  emitter.done(id, { demande });
}

export function etatDuCoffre(): EtatCoffre {
  return etatCoffre;
}

/** Remplace l'état et la table (méthode `coffre.charger`). */
export function chargerCoffre(etat: EtatCoffre, secrets: Record<string, string>): void {
  etatCoffre = etat;
  chargeParCoquille = true;
  // Verrouillé, la coquille ne pousse que les `sans-fenetre` : on les garde.
  tableCoffre = etat === "absent" ? {} : { ...secrets };
}

// ---------------------------------------------------------------------------
// Secrets effectifs, et l'ancien fichier (postes sans coffre seulement)
// ---------------------------------------------------------------------------

/** Secrets effectifs pour un tour (voir l'en-tête). Jamais d'exception. */
export async function readSecrets(): Promise<Record<string, string>> {
  if (chargeParCoquille) {
    if (etatCoffre === "absent") return readSecretsFichier();
    return { ...(await readSecretsFichier()), ...tableCoffre };
  }
  if (!(await coffreExiste())) return readSecretsFichier();
  return { ...(await readSecretsFichier()), ...(await lireSecretsSansFenetre()) };
}

/** Noms encore présents dans l'ancien fichier (repli, pas encore migrés). */
export async function nomsFichierAncien(): Promise<string[]> {
  return Object.keys(await readSecretsFichier()).sort();
}

/**
 * Le coffre sert-il `nom` avec exactement `valeur` ? Comparaison en mémoire,
 * coffre ouvert seulement : garde-fou avant de supprimer un `.env` migré.
 * Ne rend qu'un booléen, jamais la valeur.
 */
export function coffreContient(nom: string, valeur: string): boolean {
  return etatCoffre === "ouvert" && Object.hasOwn(tableCoffre, nom) && tableCoffre[nom] === valeur;
}

/** Noms des secrets disponibles et état du coffre — outil `secrets_lister`. */
export async function nomsSecretsDisponibles(): Promise<{ etat: EtatCoffre; noms: string[] }> {
  const etat = chargeParCoquille ? etatCoffre : (await coffreExiste()) ? "verrouille" : "absent";
  return { etat, noms: Object.keys(await readSecrets()).sort() };
}

/** Écriture impossible sans coquille quand le coffre existe : seule elle l'écrit. */
async function ecritureHorsCoquilleInterdite(): Promise<boolean> {
  return !chargeParCoquille && (await coffreExiste());
}

/** Lit l'ancien fichier — `{}` si absent/illisible/invalide (jamais d'exception). */
async function readSecretsFichier(): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fsp.readFile(mcpSecretsPath(), "utf8");
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    journal.warn("mcp", "coffre de secrets illisible (JSON invalide), ignoré", {
      fields: { fichier: mcpSecretsPath() },
    });
    return {};
  }
}

async function writeSecrets(secrets: Record<string, string>): Promise<void> {
  const target = mcpSecretsPath();
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  // 0600 dès la création : le fichier ne doit jamais être lisible par le
  // groupe, même une fraction de seconde (il porte des jetons d'API).
  await fsp.writeFile(tmp, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.chmod(tmp, 0o600).catch(() => {});
  await fsp.rename(tmp, target);
}

/** Sidecar sans coquille (tâche de fond) sur un poste qui a un coffre. */
export const MESSAGE_SANS_COQUILLE = "coffre indisponible hors de l'application : enregistre ce secret depuis IAction";

/** Message d'un refus d'écriture, coffre fermé. */
export const MESSAGE_COFFRE_VERROUILLE = "coffre verrouillé : déverrouille-le pour enregistrer un secret";

/**
 * Pose/écrase un secret. La valeur ne ressort jamais d'ici, sauf vers la
 * coquille (coffre ouvert). Lève si le coffre est verrouillé.
 */
export async function setSecret(name: string, value: string): Promise<void> {
  if (etatCoffre === "verrouille") throw new Error(MESSAGE_COFFRE_VERROUILLE);
  if (await ecritureHorsCoquilleInterdite()) throw new Error(MESSAGE_SANS_COQUILLE);
  if (etatCoffre === "ouvert") {
    // Réussi seulement à l'accusé : la coquille a écrit ET relu le coffre.
    // Elle repousse ensuite la table réelle ; on la devance pour ce nom.
    await demanderACoquille("coffre:ecrire", { nom: name, valeur: value });
    tableCoffre[name] = value;
    journal.info("mcp", "secret MCP enregistré au coffre", { fields: { nom: name } });
    return;
  }
  const secrets = await readSecretsFichier();
  secrets[name] = value;
  await writeSecrets(secrets);
  journal.info("mcp", "secret MCP enregistré", { fields: { nom: name } });
}

export async function deleteSecret(name: string): Promise<boolean> {
  if (etatCoffre === "verrouille") throw new Error("coffre verrouillé : déverrouille-le pour retirer un secret");
  if (await ecritureHorsCoquilleInterdite()) throw new Error(MESSAGE_SANS_COQUILLE);
  let removed = false;
  if (etatCoffre === "ouvert" && name in tableCoffre) {
    await demanderACoquille("coffre:retirer", { nom: name });
    delete tableCoffre[name];
    removed = true;
  }
  if (etatCoffre === "absent") {
    const secrets = await readSecretsFichier();
    if (name in secrets) {
      delete secrets[name];
      await writeSecrets(secrets);
      removed = true;
    }
  }
  if (removed) journal.info("mcp", "secret MCP supprimé", { fields: { nom: name } });
  return removed;
}

// ---------------------------------------------------------------------------
// Méthodes RPC — trois verbes explicites plutôt qu'une méthode à `action`
// (chacune tient en dix lignes et porte son propre contrat testable).
// ---------------------------------------------------------------------------

/** `mcp.secrets` — liste les NOMS du coffre (jamais les valeurs). */
export async function handleMcpSecretsList(id: string, emitter: EngineEmitter): Promise<void> {
  const secrets = await readSecrets();
  emitter.done(id, { names: Object.keys(secrets).sort(), path: mcpSecretsPath(), coffre: etatCoffre });
}

/** `mcp.secretSet` — pose un secret dans le coffre. */
export async function handleMcpSecretSet(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const name = params.name;
  const value = params.value;
  if (!isNonEmptyString(name) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    emitter.error(id, "params.name manquant ou invalide");
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    emitter.error(id, "params.value manquant ou vide");
    return;
  }
  if (etatCoffre === "verrouille") {
    emitter.error(id, MESSAGE_COFFRE_VERROUILLE);
    return;
  }
  try {
    await setSecret(name, value);
  } catch (err) {
    emitter.error(id, err instanceof Error ? err.message : String(err));
    return;
  }
  emitter.done(id, { name, saved: true });
}

/** `mcp.secretDelete` — retire un secret du coffre. */
export async function handleMcpSecretDelete(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const name = params.name;
  if (!isNonEmptyString(name)) {
    emitter.error(id, "params.name manquant ou invalide");
    return;
  }
  if (etatCoffre === "verrouille") {
    emitter.error(id, "coffre verrouillé : déverrouille-le pour retirer un secret");
    return;
  }
  let removed: boolean;
  try {
    removed = await deleteSecret(name);
  } catch (err) {
    emitter.error(id, err instanceof Error ? err.message : String(err));
    return;
  }
  emitter.done(id, { name, removed });
}

// ---------------------------------------------------------------------------
// Méthodes réservées à la coquille (docs/protocol.md § Coffre de secrets)
// ---------------------------------------------------------------------------

/**
 * `coffre.charger {etat, secrets}` — la coquille pousse l'état du coffre et,
 * ouvert, la table des secrets MCP. Réponse : le NOMBRE de secrets, jamais
 * un nom ni une valeur (la réponse n'est pas relayée, mais par principe).
 */
export function handleCoffreCharger(id: string, params: Record<string, unknown>, emitter: EngineEmitter): void {
  const etat = params.etat;
  if (etat !== "absent" && etat !== "verrouille" && etat !== "ouvert") {
    emitter.error(id, "params.etat invalide");
    return;
  }
  const secrets: Record<string, string> = {};
  if (isPlainObject(params.secrets)) {
    for (const [k, v] of Object.entries(params.secrets)) {
      if (typeof v === "string") secrets[k] = v;
    }
  }
  const avant = etatCoffre;
  chargerCoffre(etat, secrets);
  const nombre = Object.keys(tableCoffre).length;
  if (avant !== etat) {
    journal.info("mcp", "état du coffre reçu de la coquille", { fields: { etat, secrets: nombre } });
  }
  emitter.done(id, { etat, secrets: nombre });
}

