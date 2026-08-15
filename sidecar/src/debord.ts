/*
 * R3 — débord d'abonnement : la décision, seule dans son module.
 *
 * Sorti de router.ts le 2026-08-08, quand T-005 (la fenêtre 7 jours entrait
 * dans la décision) a fait grossir un fichier déjà sous dérogation du cliquet.
 * Le débord est le morceau du routeur qui parle d'ARGENT : quand la fenêtre
 * d'abonnement est saturée, le tour part vers une cible payante déclarée —
 * tant que la dépense mensuelle reste sous plafond. Un module dédié, c'est
 * une revue dédiée pour chaque changement de cette règle.
 *
 * La configuration reste la propriété de router.ts (posée par `router.set`) :
 * elle est INJECTÉE ici à chaque décision, ce module ne garde aucun état.
 */

import { autoDebordCostUsdThisMonth, isLocalProviderId, readLatestClaudeWindows } from "./usageStats.js";
import { getProvider } from "./engine.js";
import type { RouteTarget, RoutingTable } from "./router.js";

/**
 * R3 — débord d'abonnement (docs/spec-r3-debord.md §1) : quand la cible du
 * tier est le moteur claude et que la fenêtre 5 h OU la fenêtre 7 jours
 * dépasse `seuilPct` (T-005, 2026-08-08 — la 7 jours était ignorée), le
 * tour part vers `target` (cible payante déclarée), tant que la dépense
 * mensuelle de débord reste sous `plafondUsdMois` (USD — devise
 * d'OpenRouter ; `null` = pas de plafond).
 */
export interface DebordConfig {
  target: RouteTarget;
  seuilPct: number;
  plafondUsdMois: number | null;
}

/** Défauts du débord (spec R3 §1) — remplacés par `router.set` (champ `debord`). */
export const DEFAULT_DEBORD: DebordConfig = {
  target: { engine: "neutral", providerId: "openrouter", model: "deepseek/deepseek-chat" },
  seuilPct: 90,
  plafondUsdMois: 10,
};

/**
 * État de débord d'une résolution : `{active: true}` = tour envoyé vers la
 * cible de débord ; `{active: false, blocked: true}` = plafond mensuel
 * atteint, repli sur la cible du tier trivial SI elle est locale (voir la
 * garde dans applyDebord), sinon cible claude d'origine conservée.
 */
export interface DebordDecision {
  active: boolean;
  blocked?: true;
  /** Occupations relevées dans l'instantané — `null` = fenêtre absente du relevé. */
  fiveHourPct: number | null;
  /** T-005 — la fenêtre 7 jours participe à la décision depuis le 2026-08-08. */
  sevenDayPct: number | null;
}

/**
 * R6-A — âge maximal d'un instantané de fenêtres pour décider un débord :
 * un instantané est un relevé PONCTUEL de la fenêtre 5 h ; au-delà de 30 min
 * il ne dit plus rien de la saturation réelle (la fenêtre a pu se vider).
 * Plus vieux → comportement « pas d'instantané » (pas de débord).
 */
export const DEBORD_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Applique la règle de débord à une cible résolue : ne concerne QUE les
 * cibles `engine: "claude"` (l'abonnement), et seulement si le débord n'est
 * pas désactivé (`config: null`, posé par `router.set` avec `debord: null`).
 * Sans instantané de fenêtres (ou sans pourcentage exploitable, ou instantané
 * plus vieux que DEBORD_SNAPSHOT_MAX_AGE_MS) → comportement R1 inchangé
 * (`debord: null`). Lecture best effort : toute erreur laisse la cible telle
 * quelle.
 */
export async function applyDebord(
  config: DebordConfig | null,
  target: RouteTarget,
  table: RoutingTable,
): Promise<{ target: RouteTarget; debord: DebordDecision | null }> {
  if (!config || target.engine !== "claude") {
    return { target, debord: null };
  }
  const windows = await readLatestClaudeWindows();
  if (!windows) {
    return { target, debord: null };
  }
  // T-005 — l'abonnement est réputé saturé si L'UNE OU L'AUTRE fenêtre
  // dépasse le seuil. La fenêtre 7 jours était ignorée : une semaine à 99 %
  // laissait partir les tours Auto vers un abonnement mort, en silence,
  // pendant que l'en-tête affichait « Fenêtre 7 jours saturée » (constat du
  // 2026-08-08, 12h03). Même seuil pour les deux fenêtres : « saturé » ne
  // dépend pas de la fenêtre qui le prouve.
  const sat5 = windows.fiveHourPct !== null && windows.fiveHourPct >= config.seuilPct;
  const sat7 = windows.sevenDayPct !== null && windows.sevenDayPct >= config.seuilPct;
  if (!sat5 && !sat7) {
    return { target, debord: null };
  }
  // R6-A — fraîcheur : instantané trop vieux (ou ts illisible) = ignoré.
  const snapshotTime = windows.ts !== null ? Date.parse(windows.ts) : Number.NaN;
  if (Number.isNaN(snapshotTime) || Date.now() - snapshotTime > DEBORD_SNAPSHOT_MAX_AGE_MS) {
    return { target, debord: null };
  }
  const fiveHourPct = windows.fiveHourPct;
  const sevenDayPct = windows.sevenDayPct;
  if (config.plafondUsdMois !== null) {
    const depenseMois = await autoDebordCostUsdThisMonth();
    if (depenseMois >= config.plafondUsdMois) {
      // Plafond atteint : repli LOCAL (cible du tier trivial), jamais de
      // payant auto. R6-A — garde : si le tier trivial a été reconfiguré vers
      // autre chose qu'un moteur neutre sur provider LOCAL (coût nul), ce
      // « repli local » routerait vers du payant ou vers l'abo saturé — on
      // conserve alors la cible claude d'origine.
      const trivial = table.trivial;
      // T-023 — trait déclaré d'abord ; la devinette ne sert plus qu'aux
      // fournisseurs qui n'ont pas encore de profil.
      const repliLocal =
        trivial.engine === "neutral" &&
        isLocalProviderId(trivial.providerId, getProvider(trivial.providerId ?? "")?.traits?.billing);
      return {
        target: repliLocal ? trivial : target,
        debord: { active: false, blocked: true, fiveHourPct, sevenDayPct },
      };
    }
  }
  return { target: config.target, debord: { active: true, fiveHourPct, sevenDayPct } };
}

/**
 * T-005 — raison lisible d'un débord ACTIF : nomme la ou les fenêtres qui ont
 * déclenché. Un badge « fenêtre 5 h à 92 % » alors que c'est la semaine qui
 * est morte ferait chercher l'explication au mauvais endroit.
 */
export function raisonDebordActif(debord: DebordDecision, seuilPct: number): string {
  const fenetres: string[] = [];
  if (debord.fiveHourPct !== null && debord.fiveHourPct >= seuilPct) {
    fenetres.push(`5 h à ${Math.round(debord.fiveHourPct)} %`);
  }
  if (debord.sevenDayPct !== null && debord.sevenDayPct >= seuilPct) {
    fenetres.push(`7 jours à ${Math.round(debord.sevenDayPct)} %`);
  }
  return fenetres.length > 0 ? `débord : fenêtre ${fenetres.join(" et ")}` : "débord : abonnement saturé";
}
