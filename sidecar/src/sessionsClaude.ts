/*
 * Sessions Claude Code du poste (T-159, docs/spec-sessions-claude.md).
 *
 * Deux messages de protocole, et rien d'autre :
 *  - `claude.agents` : liste les sessions vivantes du poste en lançant
 *    `claude agents --json` (le front ne lance jamais de processus) ;
 *  - `claude.forkSession` : en fait une COPIE (`forkSession` du SDK) pour que
 *    IAction la reprenne sans jamais écrire dans le transcript d'origine, qui
 *    peut être celui d'une session encore vivante dans un terminal.
 *
 * Doctrine : aucun échec muet. Binaire introuvable, délai dépassé, code de
 * sortie non nul, JSON invalide : chaque cas rend un `error` lisible à l'UI ET
 * une entrée au journal, avec sa cause.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import type { PathEnv } from "./appPaths.js";
import { isNonEmptyString } from "./base.js";
import { preparerCliClaude } from "./cliClaude.js";
import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";

/** Délai maximal de `claude agents --json` (spec : 15 s). */
export const DELAI_AGENTS_MS = 15_000;

/** Une session telle que l'UI l'affiche ; tout champ absent de la sortie du CLI devient `null`. */
export interface SessionClaude {
  sessionId: string;
  name: string | null;
  cwd: string | null;
  kind: string | null;
  status: string | null;
  pid: number | null;
  /** Démarrage en millisecondes depuis l'époque. */
  startedAt: number | null;
}

export interface AnalyseSessions {
  sessions: SessionClaude[];
  /** Entrées écartées faute d'identifiant de session — comptées pour être journalisées, pas avalées. */
  ignorees: number;
}

function texteOuNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function nombreOuNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Analyse la sortie de `claude agents --json`. Lève (message lisible) si ce
 * n'est pas du JSON ou pas un tableau ; tolère les champs manquants d'une
 * entrée. Seule l'absence de `sessionId` écarte une entrée : sans lui, rien
 * ne peut être reprise ni copiée.
 */
export function analyserSessions(sortie: string): AnalyseSessions {
  let brut: unknown;
  try {
    brut = JSON.parse(sortie);
  } catch (err) {
    throw new Error(`sortie de « claude agents --json » illisible (JSON invalide : ${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(brut)) {
    throw new Error("sortie de « claude agents --json » inattendue : un tableau était attendu");
  }
  const sessions: SessionClaude[] = [];
  let ignorees = 0;
  for (const entree of brut) {
    const e = typeof entree === "object" && entree !== null ? (entree as Record<string, unknown>) : null;
    const sessionId = e ? texteOuNull(e.sessionId) : null;
    if (!e || !sessionId) {
      ignorees += 1;
      continue;
    }
    sessions.push({
      sessionId,
      name: texteOuNull(e.name),
      cwd: texteOuNull(e.cwd),
      kind: texteOuNull(e.kind),
      status: texteOuNull(e.status),
      pid: nombreOuNull(e.pid),
      startedAt: nombreOuNull(e.startedAt),
    });
  }
  return { sessions, ignorees };
}

// ---------------------------------------------------------------------------
// Résolution du binaire
// ---------------------------------------------------------------------------

/**
 * Binaire de l'extension VSCode « Claude Code », s'il y en a un (Windows : le
 * PATH n'en porte pas toujours). La version la plus récente l'emporte.
 */
export function binaireExtensionVscode(env: PathEnv): string | null {
  const dossier = path.join(env.home, ".vscode", "extensions");
  let noms: string[];
  try {
    noms = readdirSync(dossier);
  } catch {
    return null;
  }
  const exe = env.platform === "win32" ? "claude.exe" : "claude";
  const candidats = noms
    .filter((n) => n.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .reverse()
    .map((n) => path.join(dossier, n, "resources", "native-binary", exe))
    .filter((p) => existsSync(p));
  return candidats[0] ?? null;
}

/**
 * Binaires à essayer dans l'ordre : le CLI détendu du paquet (Linux packagé),
 * puis `claude` du PATH, puis l'extension VSCode. On passe au suivant
 * seulement sur « introuvable » — un binaire qui existe et échoue est une
 * vraie réponse, pas une raison d'en essayer un autre.
 */
export function candidatsBinaire(env: PathEnv, embarque: string | null, extensionVscode: string | null): string[] {
  const liste: string[] = [];
  if (embarque) liste.push(embarque);
  liste.push("claude");
  if (extensionVscode) liste.push(extensionVscode);
  return liste;
}

// ---------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------

export interface SortieProcessus {
  code: number | null;
  stdout: string;
  stderr: string;
}

export class ErreurLancement extends Error {
  constructor(
    message: string,
    readonly raison: "introuvable" | "delai" | "autre",
  ) {
    super(message);
  }
}

/** Lance `binaire ...args` sans shell ; borne le temps ; ne rend jamais sans avoir tranché. */
export function executer(binaire: string, args: string[], delaiMs: number): Promise<SortieProcessus> {
  return new Promise((resolve, reject) => {
    let enfant;
    try {
      enfant = spawn(binaire, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      reject(new ErreurLancement(`lancement impossible : ${err instanceof Error ? err.message : String(err)}`, "autre"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let fini = false;
    const minuteur = setTimeout(() => {
      if (fini) return;
      fini = true;
      enfant.kill();
      reject(new ErreurLancement(`aucune réponse après ${Math.round(delaiMs / 1000)} s`, "delai"));
    }, delaiMs);
    enfant.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    enfant.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    enfant.on("error", (err: NodeJS.ErrnoException) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      reject(
        err.code === "ENOENT"
          ? new ErreurLancement(`binaire « ${binaire} » introuvable`, "introuvable")
          : new ErreurLancement(`lancement impossible : ${err.message}`, "autre"),
      );
    });
    enfant.on("close", (code) => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      resolve({ code, stdout, stderr });
    });
  });
}

export interface OptionsAgents {
  /** Inclut les sessions d'arrière-plan terminées (`--all`). */
  toutes?: boolean;
  delaiMs?: number;
  /** Binaires candidats (tests) ; par défaut la résolution réelle. */
  candidats?: string[];
  /** Arguments à placer AVANT `agents` (tests : le script d'un faux CLI lancé par `node`). */
  argsAvant?: string[];
}

/** Lance `claude agents --json`, parse, et lève `Error` (message pour l'UI) au premier problème. */
export async function listerSessions(options: OptionsAgents = {}, env?: PathEnv): Promise<AnalyseSessions> {
  const delaiMs = options.delaiMs ?? DELAI_AGENTS_MS;
  const environnement: PathEnv = env ?? { platform: process.platform, env: process.env, home: process.env.HOME ?? process.env.USERPROFILE ?? "" };
  const candidats =
    options.candidats ??
    candidatsBinaire(environnement, preparerCliClaude(undefined, env)?.chemin ?? null, binaireExtensionVscode(environnement));
  const args = [...(options.argsAvant ?? []), "agents", "--json", ...(options.toutes ? ["--all"] : [])];

  let sortie: SortieProcessus | null = null;
  const essais: string[] = [];
  for (const binaire of candidats) {
    try {
      sortie = await executer(binaire, args, delaiMs);
      break;
    } catch (err) {
      if (err instanceof ErreurLancement && err.raison === "introuvable") {
        essais.push(binaire);
        continue;
      }
      throw err;
    }
  }
  if (!sortie) {
    throw new Error(
      `CLI « claude » introuvable (essayé : ${essais.join(", ")}). Installez Claude Code ou ajoutez-le au PATH.`,
    );
  }
  if (sortie.code !== 0) {
    const detail = sortie.stderr.trim().slice(0, 400);
    throw new Error(`« claude agents --json » a échoué (code de sortie ${sortie.code ?? "inconnu"})${detail ? ` : ${detail}` : ""}`);
  }
  const analyse = analyserSessions(sortie.stdout);
  if (analyse.ignorees > 0) {
    journal.warn("claude", "claude agents : entrées sans sessionId ignorées", { fields: { ignorees: analyse.ignorees } });
  }
  return analyse;
}

/** `claude.agents` — params `{all?: boolean}` ; `done` `{sessions: SessionClaude[]}`. */
export async function handleClaudeAgents(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  const delaiEnv = Number(process.env.IACTION_AGENTS_TIMEOUT_MS);
  try {
    const { sessions } = await listerSessions({
      toutes: params.all === true,
      ...(Number.isFinite(delaiEnv) && delaiEnv > 0 ? { delaiMs: delaiEnv } : {}),
    });
    emitter.done(id, { sessions });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    journal.error("claude", "claude.agents en échec", { fields: { cause: message } });
    emitter.error(id, message);
  }
}

/**
 * `claude.forkSession` — params `{sessionId, cwd}` ; `done` `{sessionId}` (la
 * COPIE). Le SDK clone le transcript sous un nouvel identifiant : l'original
 * n'est jamais ouvert en écriture.
 */
export async function handleClaudeForkSession(id: string, params: Record<string, unknown>, emitter: EngineEmitter): Promise<void> {
  const { sessionId, cwd } = params;
  if (!isNonEmptyString(sessionId) || !isNonEmptyString(cwd)) {
    emitter.error(id, "claude.forkSession : sessionId et cwd sont requis");
    return;
  }
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const copie = await sdk.forkSession(sessionId, { dir: cwd });
    journal.info("claude", "session copiée pour reprise", { fields: { origine: sessionId, copie: copie.sessionId } });
    emitter.done(id, { sessionId: copie.sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    journal.error("claude", "claude.forkSession en échec", { fields: { sessionId, cause: message } });
    emitter.error(id, `Copie de la session impossible : ${message}`);
  }
}
