/*
 * Sessions Claude du poste (T-159, docs/spec-sessions-claude.md) — logique
 * pure du panneau : lecture de la réponse du sidecar, libellés, appariement
 * d'une session avec un projet connu d'IAction. Aucun accès Tauri ici : le
 * client (sessionsClaudeClient.ts) et le panneau (SessionsClaudePage.tsx) s'y
 * appuient, et les tests l'exercent sans fenêtre.
 */

import type { ProjectConfig } from "./projectAdmin";

/** Une session telle que `claude.agents` la rend (voir docs/protocol.md). */
export interface SessionClaude {
  sessionId: string;
  name: string | null;
  cwd: string | null;
  kind: string | null;
  status: string | null;
  pid: number | null;
  /** Millisecondes depuis l'époque. */
  startedAt: number | null;
}

/** Page où l'on retrouve les sessions des autres machines (Remote Control). */
export const URL_SESSIONS_AUTRES_MACHINES = "https://claude.ai/code";

function texteOuNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function nombreOuNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Lit le `done` de `claude.agents` ; une entrée sans identifiant est écartée, les autres champs sont facultatifs. */
export function lireSessions(donnees: Record<string, unknown>): SessionClaude[] {
  if (!Array.isArray(donnees.sessions)) return [];
  const sessions: SessionClaude[] = [];
  for (const brut of donnees.sessions) {
    if (typeof brut !== "object" || brut === null) continue;
    const e = brut as Record<string, unknown>;
    const sessionId = texteOuNull(e.sessionId);
    if (!sessionId) continue;
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
  return sessions;
}

/** Retire les `/` ou `\` de fin ; garde la racine seule intacte. */
function sansSeparateurFinal(chemin: string): string {
  const coupe = chemin.replace(/[\\/]+$/, "");
  return coupe === "" ? chemin : coupe;
}

/** Dernier segment du `cwd` (séparateurs POSIX et Windows), ou « — » sans `cwd`. */
export function libelleProjet(cwd: string | null): string {
  if (!cwd) return "—";
  const propre = sansSeparateurFinal(cwd);
  const segments = propre.split(/[\\/]/).filter((s) => s.length > 0);
  return segments[segments.length - 1] ?? propre;
}

/** Forme comparable d'un chemin : séparateurs unifiés, pas de `/` final, casse ignorée pour un chemin de disque Windows. */
function cleChemin(chemin: string): string {
  const unifie = sansSeparateurFinal(chemin.replace(/\\/g, "/"));
  return /^[A-Za-z]:/.test(unifie) ? unifie.toLowerCase() : unifie;
}

/** Le projet IAction dont le dossier est exactement le `cwd` de la session, s'il y en a un. */
export function projetPourCwd(cwd: string | null, projets: readonly ProjectConfig[]): ProjectConfig | null {
  if (!cwd) return null;
  const cle = cleChemin(cwd);
  return projets.find((p) => cleChemin(p.path) === cle) ?? null;
}

/** Commande de reprise en copie depuis un terminal (repli quand aucun projet IAction ne correspond). */
export function commandeReprise(session: Pick<SessionClaude, "sessionId" | "cwd">): string {
  const reprise = `claude --resume ${session.sessionId} --fork-session`;
  return session.cwd ? `cd "${session.cwd}" && ${reprise}` : reprise;
}

const LIBELLES_TYPE: Record<string, string> = {
  interactive: "Interactive",
  background: "Arrière-plan",
  bg: "Arrière-plan",
};

const LIBELLES_ETAT: Record<string, string> = {
  busy: "Au travail",
  idle: "En attente",
  waiting: "En attente",
  done: "Terminée",
  completed: "Terminée",
  error: "En erreur",
  failed: "En erreur",
};

/** Valeur inconnue du CLI : affichée telle quelle plutôt que masquée. */
export function libelleType(kind: string | null): string {
  return kind === null ? "—" : (LIBELLES_TYPE[kind] ?? kind);
}

export function libelleEtat(status: string | null): string {
  return status === null ? "—" : (LIBELLES_ETAT[status] ?? status);
}

/** « il y a 5 min », « il y a 3 h »… ; `maintenant` injectable pour les tests. */
export function heureRelative(debutMs: number | null, maintenant: number = Date.now()): string {
  if (debutMs === null) return "—";
  const secondes = Math.max(0, Math.round((maintenant - debutMs) / 1000));
  if (secondes < 60) return "à l'instant";
  const minutes = Math.floor(secondes / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const heures = Math.floor(minutes / 60);
  if (heures < 24) return `il y a ${heures} h`;
  const jours = Math.floor(heures / 24);
  return `il y a ${jours} j`;
}

/** Date et heure locales complètes, pour l'info-bulle. */
export function heureAbsolue(debutMs: number | null): string {
  return debutMs === null ? "heure de démarrage inconnue" : new Date(debutMs).toLocaleString("fr-FR");
}

/** Intitulé d'une session : son nom, à défaut le début de son identifiant. */
export function titreSession(session: Pick<SessionClaude, "name" | "sessionId">): string {
  return session.name ?? session.sessionId.slice(0, 8);
}
