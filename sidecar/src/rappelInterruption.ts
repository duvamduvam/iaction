/**
 * T-102 — rappel factuel donné au tour SUIVANT quand le précédent a été
 * interrompu (`claude.abort`) alors qu'au moins un sous-agent tournait
 * encore.
 *
 * ── Le défaut qu'il comble ───────────────────────────────────────────────
 * Constat du 2026-08-29 (docs/tickets.md, T-102) : un `Agent` a tourné
 * 38 minutes avant que l'utilisateur, sans nouvelle, ne finisse par
 * interrompre le tour. Au tour suivant, interrogé (« c'est bloqué ? »), le
 * modèle a répondu « rien ne tournait, j'attendais ta main » — FAUX sur toute
 * la ligne. Le `tool_result` d'un `Agent` annulé ne dit ni sa durée ni la
 * cause de l'arrêt : privé de faits, le modèle a comblé le trou tout seul, et
 * c'est ce qui a le plus coûté à l'utilisateur.
 *
 * ── Ce que ce module fait, et rien de plus ───────────────────────────────
 * `formaterRappelInterruption` est une fonction PURE qui met en mots ce que le
 * sidecar SAIT (type/description du sous-agent, durée écoulée jusqu'à
 * l'abandon, qui a demandé l'arrêt) — jamais une supposition sur ce qui aurait
 * dû se passer. `null` si rien n'était en vol : un abandon sans sous-agent
 * actif ne nécessite aucun rappel, le modèle reprend sur un tour clos, il sait
 * déjà qu'il a été interrompu.
 *
 * `creerRegistreRappels`/`preparerRappelSurAbandon` portent le peu d'ÉTAT que
 * ça demande (sessionId → texte prêt à préfixer) — sorti de claude.ts (cliquet
 * de taille) : claude.ts n'a plus qu'à appeler `consommer` au démarrage d'un
 * tour et `preparerRappelSurAbandon` à sa clôture, avec ce qu'il connaît déjà
 * (`RunState`, le suivi des sous-agents).
 */

/** Un sous-agent qui tournait encore au moment de l'abandon (voir
 *  `SousAgentEnVolInfo`, sousAgentsJournal.ts — ce module n'importe pas ce
 *  type pour rester sans dépendance, la forme suffit). */
export interface SousAgentInterrompu {
  /** `subagent_type` demandé, ou repli générique (voir sousAgentsJournal.ts). */
  type: string;
  /** Description passée à l'outil, si le modèle en a fourni une. */
  description: string;
  /** Durée écoulée depuis son lancement jusqu'à l'abandon, en millisecondes. */
  ms: number;
}

/** Qui a demandé l'arrêt — même distinction que la ligne de journal
 *  « abandon demandé » (voir handleClaudeAbort, claude.ts). */
export type DemandeurAbandon = "orchestration" | "protocole";

/** `"2 min"` au-delà d'une minute pleine, sinon `"N s"` (jamais `"0 s"` : un
 *  abandon quasi immédiat reste au moins UNE seconde à l'affichage). */
function formaterDuree(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 1) return `${minutes} min`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

const LIBELLE_DEMANDEUR: Readonly<Record<DemandeurAbandon, string>> = {
  orchestration: "l'orchestration interne",
  protocole: "l'utilisateur (ou un appel protocolaire direct)",
};

/**
 * Rappel factuel à préfixer au prochain tour de la même session — `null` si
 * `sousAgents` est vide (rien à rappeler). Jamais de contenu du sous-agent
 * lui-même (son texte, ses outils en détail) : uniquement ce que le journal
 * a déjà retenu (T-102), pour rester conforme à L4 (pas de corps de message
 * dans ce qui transite en dehors du fil).
 */
export function formaterRappelInterruption(
  sousAgents: readonly SousAgentInterrompu[],
  demandeur: DemandeurAbandon,
): string | null {
  if (sousAgents.length === 0) return null;
  const detail = sousAgents
    .map((s) => `« ${s.description || s.type} » (${formaterDuree(s.ms)})`)
    .join(", ");
  return (
    `[Rappel système — T-102] Le tour précédent a été interrompu (arrêt demandé par ` +
    `${LIBELLE_DEMANDEUR[demandeur]}) alors qu'au moins un outil \`Agent\` tournait encore : ${detail}. ` +
    `Ce travail a été coupé net et son résultat est perdu — ne présente jamais cette interruption comme ` +
    `une absence d'activité.`
  );
}

/** Registre — sessionId → rappel prêt à préfixer, posé à la clôture d'un tour
 *  abandonné, consommé (une seule fois) au démarrage du tour suivant. Vit au
 *  niveau du moteur (une instance par `createClaudeEngine`), pas du tour. */
export interface RegistreRappels {
  /** Consomme (lecture + suppression) le rappel de `sessionId`, s'il y en a un. */
  consommer(sessionId: string | null): string | null;
  /** Pose `texte` pour `sessionId` — no-op si l'un des deux est `null`. */
  poser(sessionId: string | null, texte: string | null): void;
}

export function creerRegistreRappels(): RegistreRappels {
  const rappels = new Map<string, string>();
  return {
    consommer(sessionId) {
      if (!sessionId) return null;
      const texte = rappels.get(sessionId) ?? null;
      if (texte) rappels.delete(sessionId);
      return texte;
    },
    poser(sessionId, texte) {
      if (sessionId && texte) rappels.set(sessionId, texte);
    },
  };
}

/**
 * Si CE tour se clôt sur un abandon explicite alors qu'au moins un sous-agent
 * tournait encore, pose dans `registre` le rappel que le tour suivant de la
 * même session consommera. Sans effet dans tous les autres cas (fin normale,
 * refus, pas de sous-agent en vol, session inconnue) : `formaterRappelInterruption`
 * et `poser` sont déjà tolérants au vide, ce n'est qu'un assemblage.
 */
export function preparerRappelSurAbandon(
  registre: RegistreRappels,
  estAbandon: boolean,
  demandeur: DemandeurAbandon | null,
  sessionId: string | null,
  sousAgentsEnVol: readonly { type: string; description: string; startedAt: number }[],
): void {
  if (!estAbandon) return;
  const texte = formaterRappelInterruption(
    sousAgentsEnVol.map((s) => ({ type: s.type, description: s.description, ms: Date.now() - s.startedAt })),
    demandeur ?? "protocole",
  );
  registre.poser(sessionId, texte);
}
