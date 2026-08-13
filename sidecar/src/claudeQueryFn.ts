/*
 * D'où vient la fonction `query()` que le moteur Claude appelle.
 *
 * Trois réponses possibles, et une seule décision à lire — c'est pourquoi
 * elles vivent ici plutôt que dans `claude.ts`, qui porte déjà le moteur :
 *
 *   1. en test (`IACTION_FAKE_CLAUDE=1`), un faux module chargé dynamiquement.
 *      Le SDK réel n'est alors JAMAIS importé : aucun risque qu'une suite de
 *      tests parle au réseau ou lance le CLI ;
 *   2. dans le paquet Linux, la fonction du SDK aiguillée sur le CLI détendu —
 *      il y voyage compressé, parce que linuxdeploy casse l'exécutable en le
 *      patchant (T-038, voir cliClaude.ts) ;
 *   3. partout ailleurs (Windows, macOS, dépôt en développement), la fonction
 *      du SDK telle quelle, qui résout son binaire toute seule.
 */

import { pathToFileURL } from "node:url";

import { isNonEmptyString } from "./base.js";
import type { ClaudeQueryFn } from "./claude.js";
import { aiguillerVersCliEmballe } from "./cliClaude.js";

export async function resolveQueryFn(): Promise<ClaudeQueryFn> {
  if (process.env.IACTION_FAKE_CLAUDE === "1") {
    const modulePath = process.env.IACTION_FAKE_CLAUDE_MODULE;
    if (isNonEmptyString(modulePath)) {
      const mod = (await import(pathToFileURL(modulePath).href)) as { fakeQuery?: ClaudeQueryFn };
      if (typeof mod.fakeQuery === "function") return mod.fakeQuery;
      throw new Error(`IACTION_FAKE_CLAUDE_MODULE (${modulePath}) n'exporte pas fakeQuery`);
    }
  }
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as { query: ClaudeQueryFn };
  return aiguillerVersCliEmballe(sdk.query);
}
