/*
 * T-170 — la sortie standard du sidecar est le canal du protocole JSON (une
 * ligne = un événement) ; rien d'autre ne doit y passer. Or des bibliothèques
 * y écrivent par `console.log` (le client « browser » du SDK Claude :
 * « [BrowserSSETransport] Dropping control_request… »). Une trace tombée au
 * mauvais moment, ou sans saut de ligne final, couperait un message du
 * protocole.
 *
 * On redirige donc les méthodes de `console` qui écrivent sur stdout vers
 * stderr (relayé au journal de l'application). Le protocole, lui, écrit par
 * `process.stdout.write` (index.ts) : il n'est pas touché.
 */

import { Console } from "node:console";

/** Méthodes de `console` qui écrivent sur la sortie standard. */
const METHODES_STDOUT = ["log", "info", "debug", "table", "dir", "dirxml"] as const;

/**
 * Redirige ces méthodes de `cible` (la `console` globale par défaut) vers
 * `flux` (stderr par défaut). Idempotent. Rend la fonction qui rétablit l'état
 * d'origine (tests).
 */
export function redirigerConsoleVersStderr(
  cible: Record<string, unknown> = console as unknown as Record<string, unknown>,
  flux: NodeJS.WritableStream = process.stderr,
): () => void {
  const vers = new Console({ stdout: flux, stderr: flux }) as unknown as Record<string, (...args: unknown[]) => void>;
  const origine = new Map<string, unknown>();
  for (const methode of METHODES_STDOUT) {
    origine.set(methode, cible[methode]);
    cible[methode] = (...args: unknown[]) => vers[methode]!(...args);
  }
  return () => {
    for (const [methode, valeur] of origine) cible[methode] = valeur;
  };
}
