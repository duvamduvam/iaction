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
import { recordUsageEvent, type UsageStatus, type UsageVentilationLine } from "./usageStats.js";
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
 *
 * T-076 — un tour mort de silence n'écrivait AUCUN événement d'usage : le
 * journal et l'interface le disaient, mais le taux d'erreur de la
 * supervision, lui, ne le voyait jamais. L'événement est écrit ICI, seule
 * fois où le plafond signale ; les deux gardes en aval (`claude.ts`, sur
 * l'exception qui suit et sur la clôture sans résultat) s'effacent devant
 * `aSignale()` pour ne jamais en écrire un second.
 */
export function armerPlafondSilence(p: {
  id: string;
  emitter: EngineEmitter;
  model: string | null;
  sessionId: string | null;
  /** `params.meta` du tour, transmis tel quel au magasin d'usage si le plafond signale. */
  meta: unknown;
  /** Libération du tour (fermeture de l'entrée, interrupt du CLI), appelée APRÈS le signalement. */
  auSilence: () => void;
}): PlafondSilence {
  const debut = Date.now();
  let signale = false;
  let minuteur: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    minuteur = null;
    signale = true;
    const attenteMs = Date.now() - debut;
    const attenteS = Math.round(attenteMs / 1000);
    // Journal d'abord (il survit à tout), usage ensuite, interface enfin.
    journal.error("claude", "tour Claude sans aucun message du SDK", {
      reqId: p.id,
      fields: {
        sessionId: p.sessionId,
        model: p.model,
        attenteMs,
        plafondMs: SILENCE_DEMARRAGE_TIMEOUT_MS,
      },
    });
    recordUsageEvent({
      id: p.id,
      engine: "claude",
      method: "claude.start",
      providerId: null,
      model: p.model,
      promptTokens: null,
      completionTokens: null,
      status: "error",
      errorMessage: `tour interrompu par le plafond de silence de ${attenteS} s`,
      meta: p.meta,
    });
    p.emitter.error(
      p.id,
      `Le moteur Claude n'a donné aucun signe de vie en ${attenteS} s : ` +
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

/* ---------------------------------------------------------------------------
 * T-082 — une interruption volontaire n'est pas une panne.
 *
 * Le SDK rend `error_during_execution` dans DEUX situations que rien ne
 * distingue dans le message : le tour s'est cassé, ou le tour a été coupé.
 * Le code versait les deux dans `status: "error"`, et l'encart Fiabilité
 * affichait 13,3 % de tours en erreur pour la semaine du 17 août — dont
 * 11 sur 11 étaient, transcripts du SDK à l'appui, des interruptions de
 * l'utilisateur (8 arrêts, 3 refus de permission d'outil). Zéro panne.
 * Le KPI le plus alarmant de la page mesurait un usage normal, pendant que
 * `toursAbandon`, qui aurait dû les porter, restait structurellement à zéro.
 *
 * La correction tient dans un indicateur posé sur les deux chemins qui
 * coupent un tour, et LU ici. Le classement est volontairement le seul
 * endroit qui en décide — les deux appelants (result final, et le repli de
 * fin de flux) partageaient déjà le même défaut, ils partagent le remède.
 * ------------------------------------------------------------------------- */

/**
 * Pourquoi un tour s'est arrêté avant d'avoir fini, quand ce n'est pas une
 * panne. `null` = aucune interruption connue, donc un non-succès EST une
 * panne et doit être crié comme telle.
 */
export type Interruption = "abandon" | "refus" | null;

/** Ce que la fin d'un tour doit laisser derrière elle : un statut d'usage, sa
 *  raison, et la trace de journal correspondante (`null` = rien à dire). */
export interface IssueDeTour {
  status: UsageStatus;
  /** Raison de la fin anormale — panne OU interruption. `null` sur un succès. */
  errorMessage: string | null;
  trace: { niveau: "error" | "info"; message: string } | null;
}

/** Libellés stables : ils deviennent des CLASSES dans l'agrégat de sobriété
 *  (usageSobriete.ts, `classerCause`), donc les changer renomme l'historique.
 *  Exporté : T-076 réutilise `abandon` pour le moteur neutre (`neutralAgent.ts`)
 *  et `chat.send` (`engine.ts`), qui ne connaissent que l'arrêt utilisateur —
 *  jamais le refus de permission, propre au moteur Claude. */
export const LIBELLE_INTERRUPTION: Readonly<Record<"abandon" | "refus", string>> = {
  abandon: "interrompu: arrêt demandé",
  refus: "interrompu: permission d'outil refusée",
};

/**
 * T-076 — même correction que ci-dessus, réduite au SEUL cas que connaissent
 * le moteur neutre et `chat.send` : ils n'ont pas de notion de « refus »
 * (côté moteur neutre, un refus de permission redevient un simple résultat
 * d'outil, sans couper le tour). Pure, pour un test sans process ni SDK.
 */
export function libelleAbandonUtilisateur(status: UsageStatus): string | null {
  return status === "aborted" ? LIBELLE_INTERRUPTION.abandon : null;
}

/**
 * Classe la fin d'un tour. Pure, et c'est le point : la règle qui décide
 * « panne ou interruption » doit être lisible d'un seul endroit et testable
 * sans faux SDK.
 *
 * ⚠ LIMITE ASSUMÉE sur `refus`. L'indicateur est posé au refus de permission,
 * or un refus ne coupe pas TOUJOURS le tour : le modèle peut encaisser le
 * refus et continuer. L'appelant efface donc l'indicateur dès que le modèle
 * reparle (voir claude.ts, cas `assistant`) — sans quoi une vraie panne
 * survenant plus tard dans le même tour serait maquillée en interruption.
 * `abandon`, lui, ne s'efface jamais : `claude.abort` interrompt le CLI.
 */
export function classerIssueDeTour(subtype: string, interruption: Interruption): IssueDeTour {
  if (subtype === "success") {
    return { status: "done", errorMessage: null, trace: null };
  }
  if (interruption !== null) {
    // Journalisé en `info` : c'est un usage normal, et le noyer dans les
    // `error` rendrait le journal illisible le jour d'une vraie panne. Mais
    // journalisé quand même — un tour qui s'arrête laisse toujours une trace.
    return {
      status: "aborted",
      errorMessage: LIBELLE_INTERRUPTION[interruption],
      trace: { niveau: "info", message: "tour Claude interrompu" },
    };
  }
  return {
    status: "error",
    // L4 — le `subtype` du SDK EST la cause ; `message.result` n'entre jamais
    // dans le journal (sur un tour réussi il porte la réponse de l'assistant).
    errorMessage: `résultat Claude: ${subtype}`,
    trace: { niveau: "error", message: "tour Claude terminé en erreur" },
  };
}

/**
 * T-102 — le `subtype` que l'INTERFACE reçoit dans le `done` d'un tour.
 *
 * Constat : `error_during_execution` ne dit jamais si le tour s'est cassé ou
 * s'il a été COUPÉ par `claude.abort` (voir `classerIssueDeTour`). `claude.ts`
 * renvoyait ce subtype BRUT à l'UI même quand `runState.interruption`
 * connaissait déjà la réponse : l'interface re-devinait alors depuis le seul
 * `subtype`, forcément à l'aveugle, et affichait une panne pour un arrêt
 * demandé. Même convention que le repli sans `result` final
 * (`cloturerTourSansResultatFinal`) et que l'orchestrateur
 * (`classifyStepOutcome`) : un abandon connu prime, `subtype` devient
 * `"aborted"` — un vrai succès ou une vraie panne gardent le leur.
 *
 * ⚠ Volontairement borné à `"abandon"`, PAS à `"refus"` : un refus de
 * permission peut être un choix de l'utilisateur pour UN outil précis, sans
 * disqualifier tout le reste du diagnostic technique porté par le subtype —
 * et rien dans le périmètre de T-102 n'a mesuré son affichage. `abandon`, lui,
 * est sans ambiguïté (l'utilisateur a explicitement coupé le tour).
 */
export function subtypePourInterface(subtype: string, interruption: Interruption): string {
  return interruption === "abandon" ? "aborted" : subtype;
}

/** Écrit la trace de journal d'une issue, au bon niveau. Les champs sont
 *  toujours des libellés techniques — jamais un corps de réponse. */
export function tracerIssue(
  issue: IssueDeTour,
  reqId: string,
  fields: Record<string, unknown>,
): void {
  if (!issue.trace) return;
  const ecrire = issue.trace.niveau === "error" ? journal.error : journal.info;
  ecrire("claude", issue.trace.message, { reqId, fields });
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
  /** L'arrêt vient-il de l'utilisateur (claude.abort) ? Distinct de
      `interruption` : celui-ci commande la FORME de la sortie (un `done` de
      subtype « aborted » plutôt qu'un `error` à l'interface), celui-là
      commande la LECTURE qu'en fait la supervision. */
  aborted: boolean;
  /** T-082 — pourquoi le tour a été coupé, si tant est qu'il l'ait été. */
  interruption: Interruption;
  /** Le modèle a-t-il produit le moindre contenu avant de se taire ? */
  sawAssistantOutput: boolean;
}

/**
 * T-082 — enregistrement du `result` FINAL d'un tour : un événement d'usage,
 * une trace de journal, et rien d'autre.
 *
 * Vit ici, et non dans la boucle de `handleClaudeStart`, pour la raison qui a
 * sorti tout ce module : c'est de la clôture de tour, elle doit se lire à côté
 * de son jumeau (le repli sans `result` final) plutôt qu'à six cents lignes de
 * lui — c'est précisément parce qu'ils étaient séparés que le même défaut de
 * classement vivait dans les deux.
 */
export function enregistrerResultatFinal(p: {
  id: string;
  meta: unknown;
  model: string | null;
  sessionId: string | null;
  subtype: string;
  interruption: Interruption;
  usage: Usage | null;
  ventilation: ReadonlyArray<UsageVentilationLine>;
  contextTokens: number | null;
  durationMs: number;
}): void {
  const issue = classerIssueDeTour(p.subtype, p.interruption);
  // Un seul événement d'usage par claude.start, sur le result FINAL (usage et
  // coût cumulés du process ; les résultats intermédiaires n'en émettent pas,
  // pour ne pas compter double).
  recordUsageEvent({
    id: p.id,
    engine: "claude",
    method: "claude.start",
    providerId: null,
    model: p.model,
    promptTokens: p.usage?.inputTokens ?? null,
    completionTokens: p.usage?.outputTokens ?? null,
    // T-066 — voir claudeVentilation.ts : ce que chaque modèle a vraiment
    // consommé, plus deux mesures déjà sous la main et jamais écrites
    // (fenêtre réellement occupée, durée du tour).
    ventilation: p.ventilation,
    contextTokens: p.contextTokens,
    durationMs: p.durationMs,
    status: issue.status,
    errorMessage: issue.errorMessage,
    meta: p.meta,
  });
  // T-015 — l'échec était consigné dans le magasin d'usage et NULLE PART
  // ailleurs : le journal, celui que lit la page Système et qu'on ouvre quand
  // quelque chose cloche, n'en recevait rien.
  tracerIssue(issue, p.id, {
    subtype: p.subtype,
    sessionId: p.sessionId,
    model: p.model,
    ...(issue.status === "aborted" ? { cause: issue.errorMessage } : {}),
  });
}

/**
 * À appeler quand la boucle du flux SDK s'est terminée SANS `result` final
 * (`turnFinished` faux). Trois issues possibles, et aucune n'est le silence.
 */
export function cloturerTourSansResultatFinal(etat: EtatFinDeTour): void {
  const { id, emitter, pendingResult } = etat;

  if (pendingResult) {
    // T-082 — même classement que le `result` final : un tour coupé pendant
    // l'attente des tâches de fond passe exactement par ici.
    const issueRepli = classerIssueDeTour(pendingResult.subtype, etat.interruption);
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
      status: issueRepli.status,
      // L4 — même règle que le `result` final : seul le subtype est repris.
      errorMessage: issueRepli.errorMessage,
      meta: etat.meta,
    });
    tracerIssue(issueRepli, id, {
      subtype: pendingResult.subtype,
      sessionId: pendingResult.sessionId,
      model: etat.model,
      repli: true,
    });
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
    status: etat.interruption !== null ? "aborted" : "error",
    errorMessage:
      etat.interruption !== null
        ? classerIssueDeTour("", etat.interruption).errorMessage
        : "tour Claude terminé sans résultat",
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
