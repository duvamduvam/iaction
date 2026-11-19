/**
 * Secrets `sans-fenetre` lus SANS la coquille — pour les tâches de fond
 * (docs/etude-coffre-secrets.md § 5).
 *
 * Le minuteur du matin et le fond de nuit lancent un sidecar sans la coquille
 * Rust : personne ne lui pousse de table. Les secrets que l'utilisateur a
 * classés `sans-fenetre` restent au trousseau de l'OS, sous le service
 * `iaction`, compte `mcp:<nom>` ; leurs NOMS sont listés dans
 * `<config>/coffre-sans-fenetre.json` (fichier sans valeur, écrit par la
 * coquille). Ce module lit l'un puis l'autre.
 *
 * Linux seulement (les tâches programmées sont des minuteurs systemd) :
 * `secret-tool`, client du Secret Service. Les attributs `service` et
 * `username` sont ceux qu'écrit la crate `keyring` côté coquille.
 */

import { execFile } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { isPlainObject } from "./base.js";
import { globalConfigRoot } from "./jsonlStore.js";
import * as journal from "./journal.js";

const SERVICE = "iaction";
const PREFIXE_MCP = "mcp:";

/** Index des noms `sans-fenetre` — écrit par la coquille, jamais par le sidecar. */
export function indexSansFenetrePath(): string {
  return path.join(globalConfigRoot(), "coffre-sans-fenetre.json");
}

/** Le coffre existe-t-il sur ce poste ? (fichier de clé présent) */
export async function coffreExiste(): Promise<boolean> {
  try {
    await fsp.access(path.join(globalConfigRoot(), "coffre.cle.age"));
    return true;
  } catch {
    return false;
  }
}

/** Noms de l'index (comptes complets : `mcp:x`, `provider:y`…). Jamais d'exception. */
export async function lireIndexSansFenetre(): Promise<string[]> {
  try {
    const brut: unknown = JSON.parse(await fsp.readFile(indexSansFenetrePath(), "utf8"));
    if (!isPlainObject(brut) || !Array.isArray(brut.noms)) return [];
    return brut.noms.filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

function secretTool(compte: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "secret-tool",
      ["lookup", "service", SERVICE, "username", compte],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        const v = stdout.replace(/\r?\n$/, "");
        resolve(v.length > 0 ? v : null);
      },
    );
  });
}

/**
 * Secrets MCP `sans-fenetre` du trousseau, sous leur nom `${SECRET:…}`.
 * `lecteur` injectable pour les tests.
 */
export async function lireSecretsSansFenetre(
  lecteur: (compte: string) => Promise<string | null> = secretTool,
): Promise<Record<string, string>> {
  const noms = (await lireIndexSansFenetre()).filter((n) => n.startsWith(PREFIXE_MCP));
  if (noms.length === 0) return {};
  if (lecteur === secretTool && process.platform !== "linux") {
    journal.warn("mcp", "secrets sans fenêtre illisibles hors de l'application sur ce système", {
      fields: { secrets: noms.length, systeme: process.platform },
    });
    return {};
  }
  const out: Record<string, string> = {};
  const absents: string[] = [];
  for (const compte of noms) {
    const valeur = await lecteur(compte);
    if (valeur === null) absents.push(compte);
    else out[compte.slice(PREFIXE_MCP.length)] = valeur;
  }
  if (absents.length > 0) {
    journal.warn("mcp", "secrets sans fenêtre absents du trousseau", { fields: { secrets: absents.join(",") } });
  }
  return out;
}
