/**
 * Références aux serveurs MCP LIVRÉS avec IAction — `${IACTION:…}`, résolues
 * au moment du tour (mcp.ts, `prepareMcpForTurn`), comme `${SECRET:…}`.
 *
 * Pourquoi pas un chemin absolu écrit dans `.mcp.json` : ce fichier est du
 * contrat de projet, partagé entre postes. Le même projet ouvert à la maison
 * et au bureau n'a ni le même node embarqué, ni le même dossier
 * d'installation. La référence, elle, vaut partout.
 *
 * - `${IACTION:node}`   : le node qui exécute le sidecar (l'embarqué en production)
 * - `${IACTION:relais}` : le serveur relais compilé (relaisServeur.js)
 * - `${IACTION:projet}` : la racine du projet du tour
 *
 * Limite assumée : un `claude` lancé à la main dans le projet ne connaît pas
 * ces références ; le serveur n'y démarre pas.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "./base.js";

const REF_RE = /\$\{IACTION:(node|relais|projet)\}/g;

function cheminRelais(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "relaisServeur.js");
}

/** Remplace les `${IACTION:…}` (récursif, structure préservée). Pure hors chemins. */
export function resoudreIntegres(valeur: unknown, cwd: string): unknown {
  const table: Record<string, string> = { node: process.execPath, relais: cheminRelais(), projet: cwd };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(REF_RE, (_m, cle: string) => table[cle]);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(valeur);
}
