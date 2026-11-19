/**
 * Garde d'écriture des secrets — un agent ne pose plus de jeton dans un
 * fichier du projet (docs/etude-coffre-secrets.md § 6.3, T-220).
 *
 * ── Où s'accroche le contrôle, et pourquoi pas `canUseTool` ──────────────
 * Inconnue du § 10 levée : en `bypassPermissions` (mode autonome, tâches de
 * fond), le SDK n'appelle PAS `canUseTool` — il n'y a rien à valider. Un
 * crochet `PreToolUse`, lui, est appelé pour CHAQUE appel d'outil, quel que
 * soit le mode, sous-agents compris, et reçoit `tool_input` complet (donc
 * `file_path`). Une décision `deny` l'emporte sur le mode. C'est donc là.
 *
 * Moteur neutre : même règle, appelée avant l'exécution de l'outil
 * (`refusOutilNeutre`, neutralAgent.ts).
 *
 * Périmètre : les chemins qui tombent DANS le projet (cwd du tour), comme le
 * dit l'étude. Bash et PowerShell : redirections, `tee`, cmdlets d'écriture
 * — contournable par nature, protège de la négligence.
 *
 * Même crochet, second usage : un DÉPÔT par le relais entre studios
 * (`mcp__<serveur>__relais_deposer`) est refusé si le fichier contient une
 * valeur servie par le coffre. Ce contrôle vit ici parce que le sidecar a la
 * table en mémoire ; le serveur relais, processus à part, ne la reçoit pas
 * (lui donner tous les secrets pour les chercher serait pire que le mal).
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { isPlainObject } from "./base.js";
import { ciblesEcritureShell, estFichierSecretBloque, messageRefusEcriture, motifSecretDansContenu } from "./fichiersSecrets.js";
import * as journal from "./journal.js";
import { readSecrets } from "./mcpSecrets.js";

function dansLeProjet(cwd: string, chemin: string): boolean {
  const abs = path.resolve(cwd, chemin);
  const rel = path.relative(path.resolve(cwd), abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Chemin refusé pour un appel d'outil (noms Claude Code ET neutres), `null`
 * s'il passe. Pure : testée sans SDK.
 */
export function cheminRefuse(cwd: string, outil: string, entree: unknown): string | null {
  if (!isPlainObject(entree)) return null;
  const candidats: string[] = [];
  if (outil === "Write" || outil === "Edit" || outil === "MultiEdit") {
    if (typeof entree.file_path === "string") candidats.push(entree.file_path);
  } else if (outil === "NotebookEdit") {
    if (typeof entree.notebook_path === "string") candidats.push(entree.notebook_path);
  } else if (outil === "write_file" || outil === "edit_file") {
    if (typeof entree.path === "string") candidats.push(entree.path);
  } else if (outil === "Bash" || outil === "bash" || outil === "PowerShell") {
    if (typeof entree.command === "string") candidats.push(...ciblesEcritureShell(entree.command));
  }
  return candidats.find((c) => estFichierSecretBloque(c) && dansLeProjet(cwd, c)) ?? null;
}

function journaliser(cwd: string, outil: string, chemin: string): void {
  // Le chemin, jamais le contenu : il peut porter le jeton.
  journal.warn("mcp", "écriture d'un fichier de secret refusée à l'agent", {
    fields: { outil, chemin, projet: cwd },
  });
}

/** Moteur neutre : résultat d'outil en erreur, ou `null` si l'appel passe. */
export function refusOutilNeutre(cwd: string, outil: string, entree: unknown): { isError: true; content: string } | null {
  const chemin = cheminRefuse(cwd, outil, entree);
  if (chemin === null) return null;
  journaliser(cwd, outil, chemin);
  return { isError: true, content: messageRefusEcriture(chemin) };
}

const OUTIL_DEPOT_RELAIS = /^mcp__.+__relais_deposer$/;
/** Au-delà, le relais refuse de toute façon (200 Mo). */
const TAILLE_LUE_MAX = 200 * 1024 * 1024;

/**
 * Dépôt par le relais : refus (message) si le fichier porte une valeur servie
 * par le coffre, `null` sinon. Comparaison en mémoire ; ni la valeur ni son
 * nom ne sortent. Fichier illisible : `null`, le relais dira pourquoi.
 */
export async function refusDepotRelais(
  cwd: string,
  entree: unknown,
  secrets: () => Promise<Record<string, string>> = readSecrets,
): Promise<string | null> {
  if (!isPlainObject(entree) || typeof entree.chemin !== "string") return null;
  let contenu: Buffer;
  try {
    const abs = path.resolve(cwd, entree.chemin);
    const st = await fsp.stat(abs);
    if (!st.isFile() || st.size > TAILLE_LUE_MAX) return null;
    contenu = await fsp.readFile(abs);
  } catch {
    return null;
  }
  const valeurs = Object.values(await secrets());
  const motif = motifSecretDansContenu(contenu, valeurs);
  if (motif === null) return null;
  journal.warn("mcp", "dépôt par le relais refusé : le fichier porte un secret", {
    fields: { chemin: entree.chemin, projet: cwd },
  });
  return (
    `Dépôt refusé : « ${entree.chemin} » contient ${motif}. Un secret ne quitte pas ce poste par le relais ; ` +
    "retire-le du fichier, ou dépose un autre fichier."
  );
}

function refuser(raison: string): Record<string, unknown> {
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: raison },
  };
}

/** Crochets du SDK pour un tour Claude (`options.hooks`). */
export function crochetsSecrets(cwd: string): Record<string, unknown> {
  const garde = async (input: unknown): Promise<Record<string, unknown>> => {
    if (!isPlainObject(input) || typeof input.tool_name !== "string") return {};
    if (OUTIL_DEPOT_RELAIS.test(input.tool_name)) {
      const refus = await refusDepotRelais(cwd, input.tool_input);
      return refus === null ? {} : refuser(refus);
    }
    const chemin = cheminRefuse(cwd, input.tool_name, input.tool_input);
    if (chemin === null) return {};
    journaliser(cwd, input.tool_name, chemin);
    return refuser(messageRefusEcriture(chemin));
  };
  return {
    PreToolUse: [
      { matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.+__relais_deposer", hooks: [garde] },
    ],
  };
}
