/**
 * Clôture d'un tour Claude privé de son message `result` final.
 *
 * ── Pourquoi un module à part ───────────────────────────────────────────
 * C'est le chemin des fins ANORMALES, donc celui qu'on relit le jour d'une
 * panne — et il vivait noyé au fond de `handleClaudeStart`, après six cents
 * lignes de boucle. Ici il tient sur un écran, et il se raconte : à quoi tient
 * la différence entre « l'utilisateur a rendu la main » et « le tour est mort
 * tout seul », et ce que chacun doit laisser derrière lui.
 *
 * ── La règle qu'il applique (T-015) ─────────────────────────────────────
 * Un tour qui échoue laisse TROIS traces, jamais moins : un événement d'usage,
 * une ligne de journal de niveau `error`, et un message explicite à
 * l'interface. Le silence sur l'un des trois, c'est la panne du 2026-08-09 :
 * un tour démarré, aucune bulle, aucune erreur, et une interface qui attend
 * indéfiniment « Aucune donnée reçue du fournisseur ».
 *
 * Interdit ici comme ailleurs : le journal ne reçoit JAMAIS `result` (corps de
 * la réponse de l'assistant), seulement des libellés techniques.
 */

import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";
import { recordUsageEvent } from "./usageStats.js";
import type { Usage } from "./claude.js";

/**
 * Plafond de SILENCE TOTAL au démarrage d'un tour : délai au-delà duquel un
 * flux SDK qui n'a rendu AUCUN message — pas même le `system:init` — est
 * déclaré en échec.
 *
 * ── Pourquoi 120 s ──────────────────────────────────────────────────────
 * Le `system:init` arrive normalement en quelques secondes : la préparation
 * MCP mesurée dans les journaux tient en ~1,6 s, et l'interface pose déjà son
 * témoin d'attente à 10 s (`ATTENTE_FOURNISSEUR_MS`, côté UI). 120 s laisse
 * donc une marge très large à un démarrage lent (poste chargé, serveurs MCP
 * poussifs, CLI qui se met à jour) — ce n'est pas un délai de réponse du
 * modèle, c'est le délai avant son PREMIER signe de vie.
 *
 * Ce que ça remplace : une attente INFINIE. Le 2026-08-09, deux tours ont
 * démarré, aucun processus `claude` n'a jamais été lancé, et l'interface a
 * attendu jusqu'à la fin de la session sans qu'une seule ligne de journal
 * n'apparaisse. Un plafond même généreux transforme ce trou noir en échec
 * daté et journalisé.
 *
 * Surchargeable par `IACTION_SILENCE_DEMARRAGE_MS` : sans cela, le test qui
 * prouve le garde-fou durerait deux minutes, donc ne serait jamais lancé.
 */
export const SILENCE_DEMARRAGE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.IACTION_SILENCE_DEMARRAGE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

export interface PlafondSilence {
  /** À appeler au PREMIER message reçu, et sur chaque chemin de sortie du tour. */
  desarmer(): void;
  /** Vrai si le plafond a déjà déclaré le tour en échec (n'en rajoute pas). */
  aSignale(): boolean;
}

/**
 * Arme le plafond de silence d'un tour. Idempotent et sans effet une fois
 * désarmé : un tour long qui produit normalement ne doit JAMAIS être coupé
 * ici — le plafond ne surveille que le premier message, jamais la suite.
 *
 * Il ne recouvre aucun autre garde-fou : l'abort volontaire, l'attente des
 * tâches de fond (`BACKGROUND_WAIT_TIMEOUT_MS`) et le micro-tour vide
 * supposent tous qu'un message est arrivé — ce plafond, lui, ne vit que tant
 * qu'il n'en est arrivé aucun.
 */
export function armerPlafondSilence(p: {
  id: string;
  emitter: EngineEmitter;
  model: string | null;
  sessionId: string | null;
  /** Libération du tour (fermeture de l'entrée, interrupt du CLI), appelée APRÈS le signalement. */
  auSilence: () => void;
}): PlafondSilence {
  const debut = Date.now();
  let signale = false;
  let minuteur: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    minuteur = null;
    signale = true;
    const attenteMs = Date.now() - debut;
    // Journal d'abord (il survit à tout), interface ensuite, nettoyage enfin.
    journal.error("claude", "tour Claude sans aucun message du SDK", {
      reqId: p.id,
      fields: {
        sessionId: p.sessionId,
        model: p.model,
        attenteMs,
        plafondMs: SILENCE_DEMARRAGE_TIMEOUT_MS,
      },
    });
    p.emitter.error(
      p.id,
      `Le moteur Claude n'a donné aucun signe de vie en ${Math.round(attenteMs / 1000)} s : ` +
        "le tour est abandonné (processus CLI jamais démarré, ou bloqué).",
    );
    p.auSilence();
  }, SILENCE_DEMARRAGE_TIMEOUT_MS);

  return {
    desarmer() {
      if (minuteur !== null) {
        clearTimeout(minuteur);
        minuteur = null;
      }
    },
    aSignale() {
      return signale;
    },
  };
}

/**
 * Dernier `result` connu d'un tour, tel que le `case "result"` le construit.
 * Import de TYPE seul depuis `claude.ts` : aucune dépendance à l'exécution,
 * donc aucun cycle de modules.
 */
export interface ResultatDeTour {
  sessionId: string | null;
  subtype: string;
  result: string | null;
  usage: Usage | null;
  contextTokens: number | null;
  totalCostUsd: number | null;
}

export interface EtatFinDeTour {
  /** Id protocolaire du tour (celui des chunk/done/error). */
  id: string;
  emitter: EngineEmitter;
  /** `params.meta` du tour, transmis tel quel au magasin d'usage. */
  meta: unknown;
  model: string | null;
  sessionId: string | null;
  contextTokens: number | null;
  /** Résultat intermédiaire retenu (micro-tour vide, attente de tâches de fond). */
  pendingResult: ResultatDeTour | null;
  /** Un message `result`, même non final, a-t-il été vu sur ce tour ? */
  sawResult: boolean;
  /** L'arrêt vient-il de l'utilisateur (claude.abort) ? */
  aborted: boolean;
  /** Le modèle a-t-il produit le moindre contenu avant de se taire ? */
  sawAssistantOutput: boolean;
}

/**
 * À appeler quand la boucle du flux SDK s'est terminée SANS `result` final
 * (`turnFinished` faux). Trois issues possibles, et aucune n'est le silence.
 */
export function cloturerTourSansResultatFinal(etat: EtatFinDeTour): void {
  const { id, emitter, pendingResult } = etat;

  if (pendingResult) {
    // Flux terminé sans `result` final (garde-fou du micro-tour vide, arrêt
    // utilisateur pendant l'attente de tâches de fond, process mort) : on
    // livre le dernier résultat connu plutôt qu'un tour fantôme sans fin.
    recordUsageEvent({
      id,
      engine: "claude",
      method: "claude.start",
      providerId: null,
      model: etat.model,
      promptTokens: pendingResult.usage?.inputTokens ?? null,
      completionTokens: pendingResult.usage?.outputTokens ?? null,
      status: pendingResult.subtype === "success" ? "done" : "error",
      // L4 — même règle que le `result` final : seul le subtype est repris.
      errorMessage:
        pendingResult.subtype === "success" ? null : `résultat Claude: ${pendingResult.subtype}`,
      meta: etat.meta,
    });
    if (pendingResult.subtype !== "success") {
      journal.error("claude", "tour Claude terminé en erreur", {
        reqId: id,
        fields: {
          subtype: pendingResult.subtype,
          sessionId: pendingResult.sessionId,
          model: etat.model,
          repli: true,
        },
      });
    }
    emitter.done(id, pendingResult);
    return;
  }

  if (etat.sawResult) {
    // Un `result` est passé et a été traité ailleurs : rien à clore ici.
    return;
  }

  // Le flux s'est éteint sans le moindre `result`. Deux situations très
  // différentes se retrouvaient ici, et le même `done` « aborted » les
  // confondait :
  //
  // - l'utilisateur a rendu la main (claude.abort) : fin NORMALE ;
  // - le tour est mort tout seul — process CLI disparu, flux clos sans rien
  //   dire. C'est le silence de T-015 : l'usage notait « aborted », le journal
  //   ne notait rien, et l'interface, qui recevait un `done` vide, restait sur
  //   « Aucune donnée reçue du fournisseur », indéfiniment.
  recordUsageEvent({
    id,
    engine: "claude",
    method: "claude.start",
    providerId: null,
    model: etat.model,
    promptTokens: null,
    completionTokens: null,
    status: etat.aborted ? "aborted" : "error",
    errorMessage: etat.aborted ? null : "tour Claude terminé sans résultat",
    meta: etat.meta,
  });

  if (etat.aborted) {
    emitter.done(id, {
      sessionId: etat.sessionId,
      subtype: "aborted",
      result: null,
      usage: null,
      contextTokens: etat.contextTokens,
      totalCostUsd: null,
    });
    return;
  }

  journal.error("claude", "tour Claude terminé sans résultat", {
    reqId: id,
    fields: {
      sessionId: etat.sessionId,
      model: etat.model,
      // Distingue « le modèle a parlé puis le flux s'est coupé » de « rien
      // n'est jamais sorti du CLI » — ce n'est pas la même panne.
      sortieAssistant: etat.sawAssistantOutput,
    },
  });
  emitter.error(
    id,
    "Le tour s'est terminé sans résultat : le moteur Claude s'est arrêté sans rien renvoyer.",
  );
}
