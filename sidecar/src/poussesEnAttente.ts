/**
 * Comptabilité des pushes non acquittés d'un tour (T-087).
 *
 * ── Le défaut ────────────────────────────────────────────────────────────
 * `claude.push` glisse un message dans l'entrée streamée d'un tour EN COURS
 * (voir `createTurnPrompt`, claude.ts) et répond `{pushed: true}` dès que le
 * texte est EMPILÉ — un accusé de DÉPÔT, pas de RÉCEPTION : le CLI n'injecte
 * un message de l'entrée streamée qu'à un retour d'outil. Poussé après le
 * dernier outil du tour (rédaction du texte final, par exemple), il n'a plus
 * aucun point d'injection et meurt en silence à la clôture — c'est le
 * constat de T-087.
 *
 * ── Le signal retenu ────────────────────────────────────────────────────
 * Un `tool_result` DU FIL (voir `claudeSousAgents.ts` : `origineMessage`,
 * jamais un sous-agent) reçu APRÈS un push prouve que le CLI a eu au moins
 * un point d'injection depuis ce push : on considère alors TOUS les push
 * antérieurs acquittés — un tool_result ne dit pas LEQUEL a été injecté,
 * juste qu'une occasion s'est présentée. C'est un PROXY, pas une preuve
 * directe. L'acquittement par écho du message injecté (le SDK renvoyant le
 * texte poussé) serait plus précis, mais demande une mesure sur le vrai
 * moteur qu'on n'a pas faite ici — reporté volontairement (voir
 * docs/tickets.md, T-087, § arbitrage).
 */

import { isNonEmptyString } from "./base.js";
import { validateAttachments, type Attachment } from "./attachments.js";
import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";

export interface PushEnAttente {
  contenu: string;
  avaitPieces: boolean;
}

export interface RegistrePushes {
  /** Un push vient d'être empilé dans l'entrée streamée : comptabilisé tant
   *  qu'aucun tool_result du fil ne l'a suivi. */
  enregistrer(contenu: string, avaitPieces: boolean): void;
  /** Un tool_result DU FIL vient d'être vu : tous les push antérieurs ont eu
   *  une occasion d'injection, ils sont acquittés. */
  acquitterSurToolResult(): void;
  /** Vide le registre et rend ce qu'il restait — idempotent (un second appel
   *  rend toujours `[]`), pour pouvoir l'appeler depuis plusieurs chemins de
   *  clôture sans jamais signaler deux fois le même push perdu. */
  vider(): PushEnAttente[];
}

export function creerRegistrePushes(): RegistrePushes {
  let enAttente: PushEnAttente[] = [];
  return {
    enregistrer(contenu, avaitPieces) {
      enAttente.push({ contenu, avaitPieces });
    },
    acquitterSurToolResult() {
      enAttente = [];
    },
    vider() {
      const restants = enAttente;
      enAttente = [];
      return restants;
    },
  };
}

/**
 * Fait sortir les push jamais acquittés d'un tour : un chunk `push_perdu`
 * par push (pour que l'UI puisse reposer chacun exactement, pièces jointes
 * comprises), plus une ligne de journal `warn` — jamais le contenu entier,
 * seulement sa longueur (L4 : un journal ne reçoit jamais de corps de
 * message utilisateur).
 */
export function signalerPushesPerdus(p: {
  id: string;
  emitter: EngineEmitter;
  pushes: readonly PushEnAttente[];
}): void {
  for (const perdu of p.pushes) {
    p.emitter.chunk(p.id, { kind: "push_perdu", contenu: perdu.contenu, avaitPieces: perdu.avaitPieces });
    journal.warn("claude", "push perdu : le tour s'est clos sans point d'injection après ce push", {
      reqId: p.id,
      fields: { methode: "claude.push", longueur: perdu.contenu.length, avaitPieces: perdu.avaitPieces },
    });
  }
}

/**
 * Sous-ensemble de `RunState` (claude.ts) dont `claude.push` a besoin — pas
 * le type entier, pour ne pas coupler ce module à l'état complet d'un tour
 * (même logique que les dépôts d'usage/commands, Étape 9 de claude.ts).
 */
export interface RunPoussable {
  aborted: boolean;
  pushPrompt: (text: string, attachments: Attachment[]) => void;
}

/**
 * S3/T-064/T-087 — `claude.push` : glisse une demande (et ses pièces
 * jointes) dans le tour EN COURS, sans l'attendre ni le couper. `pushed:
 * true` est un accusé de DÉPÔT dans l'entrée streamée, PAS de réception par
 * le modèle — un tour clos sans retour d'outil après ce push le signale
 * perdu (`push_perdu`, voir `signalerPushesPerdus` ci-dessus). `pushed:
 * false` (jamais une erreur) si le tour n'existe plus ou a été interrompu :
 * l'UI se rabat alors sur sa file d'attente.
 */
export function executerClaudePush(
  runs: ReadonlyMap<string, RunPoussable>,
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): void {
  const targetId = params.targetId;
  const content = params.content;
  if (!isNonEmptyString(targetId)) {
    emitter.error(id, "params.targetId manquant ou invalide");
    return;
  }
  if (!isNonEmptyString(content)) {
    emitter.error(id, "params.content manquant ou invalide");
    return;
  }
  const attachmentsValidation = validateAttachments(params.attachments);
  if (!attachmentsValidation.ok) {
    emitter.error(id, attachmentsValidation.message);
    return;
  }
  const run = runs.get(targetId);
  if (!run || run.aborted) {
    emitter.done(id, { pushed: false });
    return;
  }
  run.pushPrompt(content, attachmentsValidation.attachments);
  // T-102 — le push PERDU laissait une trace (`signalerPushesPerdus`
  // ci-dessus), le dépôt lui-même aucune : un message glissé pendant le tour
  // ne se voyait dans le journal que s'il tournait mal. Même style, jamais le
  // contenu (L4).
  journal.info("claude", "push déposé : message glissé dans le tour en cours", {
    reqId: targetId,
    fields: { methode: "claude.push", longueur: content.length, avaitPieces: attachmentsValidation.attachments.length > 0 },
  });
  emitter.done(id, { pushed: true });
}
