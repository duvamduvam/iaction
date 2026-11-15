/**
 * Fenêtres d'abonnement Claude — l'historique `claude-windows.jsonl` : ce qu'on
 * y écrit, à quelle cadence, et les deux lectures qui s'en servent (le routeur
 * pour décider d'un débord, la page Supervision pour dessiner l'historique).
 *
 * Sorti d'`usageStats.ts` en T-073 : ce fichier passait la limite de taille, et
 * les fenêtres d'abonnement n'ont en commun avec les statistiques d'usage que
 * le dossier où elles sont rangées. Comportement inchangé à l'extraction, sauf
 * la cadence, qui est l'objet du ticket.
 *
 * Ce que ce module protège : l'historique est la SEULE trace de la ressource
 * qui sature réellement (le quota d'abonnement, voir T-068). Il ne se réécrit
 * pas, il ne se reconstitue pas — d'où la prudence de la cadence : on écarte
 * ce qui n'apporte rien, jamais ce qui pourrait manquer plus tard.
 */

import { errMessage, isNonEmptyString, isPlainObject } from "./base.js";
import type { EngineEmitter } from "./engine.js";
import * as journal from "./journal.js";
import { enqueueWrite, globalConfigRoot, readJsonlTailWithInfo, readJsonlTolerant, TAIL_READ_BYTES } from "./jsonlStore.js";
import { COMPTE_PAR_DEFAUT, compteDemande, compteDeLigne, type CompteId } from "./compteClaude.js";
import path from "node:path";

/** Relecture élargie quand le bloc de fin ne porte aucune ligne du compte demandé. */
const TAIL_ELARGIE_BYTES = 1024 * 1024;

function claudeWindowsPath(): string {
  return path.join(globalConfigRoot(), "usage", "claude-windows.jsonl");
}

/**
 * Échec d'écriture de l'historique : journalisé, jamais propagé — une erreur
 * d'écriture ne doit pas faire échouer le tour qui l'a déclenchée.
 */
function reportUsageWriteFailure(fileLabel: string, err: unknown): void {
  journal.error("usage", `écriture ${fileLabel} impossible`, { fields: { erreur: errMessage(err) } });
}

/**
 * Append non bloquant d'un instantané d'usage abonnement dans
 * claude-windows.jsonl — appelé (best effort) partout où claude.ts capture
 * un instantané `usage.claude` avec succès.
 */
/**
 * T-073 — battement minimal entre deux instantanés IDENTIQUES. En dessous,
 * l'instantané est écarté : il ne dit rien que le précédent ne disait déjà.
 *
 * 15 min et pas « jamais » : l'historique doit garder une base de temps même
 * quand rien ne bouge, sinon un long plateau devient indiscernable d'une
 * absence de relevé — et cette distinction est exactement ce que T-059
 * reproche à la jauge de session.
 */
export const INSTANTANE_BATTEMENT_MS = 15 * 60 * 1000;

/**
 * Signature d'un jeu de fenêtres : ce qui doit déclencher une écriture quand
 * il change, et RIEN d'autre.
 *
 * Le piège, mesuré le 2026-08-20 : `resetsAt` porte des microsecondes qui
 * bougent à chaque lecture (`23:09:59.811629` puis `23:09:59.557394` pour la
 * MÊME fenêtre). Comparer les objets bruts n'aurait donc jamais rien
 * dédoublonné. La signature garde l'utilisation et `resetsAt` tronqué à la
 * minute — assez fin pour voir une fenêtre se réinitialiser (le repère saute
 * de cinq heures), assez grossier pour ignorer le bruit de lecture.
 */
export function signatureFenetres(windows: Record<string, unknown>): string {
  return Object.keys(windows)
    .sort()
    .map((k) => {
      const w = windows[k];
      if (!isPlainObject(w)) return `${k}:?`;
      const util = typeof w.utilization === "number" ? w.utilization : "?";
      const reset = typeof w.resetsAt === "string" ? w.resetsAt.slice(0, 16) : "?";
      return `${k}:${util}@${reset}`;
    })
    .join("|");
}

/**
 * État du dernier instantané écrit, PAR COMPTE — mémoire de processus, jamais
 * persistée. Un état unique ferait écarter l'instantané d'un compte parce qu'il
 * ressemble à celui de l'autre (deux comptes à 0 % ont la même signature).
 */
const derniersInstantanes = new Map<CompteId, { signature: string; ts: number }>();

/**
 * T-073 — faut-il écrire cet instantané ?
 *
 * Mesure qui a motivé la question : 22 324 instantanés pour 4,3 Mo, dont
 * **72,7 % répètent l'utilisation du précédent**, avec un écart médian de
 * 4,9 s. L'historique est précieux — c'est la seule trace de la ressource qui
 * sature — mais 16 000 lignes qui disent la même chose ne sont pas de
 * l'historique, c'est du volume.
 */
export function doitEnregistrerInstantane(
  precedent: { signature: string; ts: number } | null,
  signature: string,
  maintenant: number,
  battementMs: number = INSTANTANE_BATTEMENT_MS,
): boolean {
  if (precedent === null) return true;
  if (precedent.signature !== signature) return true;
  return maintenant - precedent.ts >= battementMs;
}

/** Test only : oublie le dernier instantané écrit. */
export function reinitialiserCadenceInstantanes(): void {
  derniersInstantanes.clear();
}

export function recordClaudeWindowsSnapshot(
  windows: Record<string, unknown>,
  compte: CompteId = COMPTE_PAR_DEFAUT,
): void {
  try {
    const maintenant = Date.now();
    const signature = signatureFenetres(windows);
    if (!doitEnregistrerInstantane(derniersInstantanes.get(compte) ?? null, signature, maintenant)) return;
    derniersInstantanes.set(compte, { signature, ts: maintenant });
    // `compte` n'est écrit que s'il diffère de `perso` : les lignes d'avant valent `perso`.
    const line = JSON.stringify({
      ts: new Date(maintenant).toISOString(),
      ...(compte !== COMPTE_PAR_DEFAUT ? { compte } : {}),
      windows,
    });
    enqueueWrite(claudeWindowsPath(), line, (err) =>
      reportUsageWriteFailure("claude-windows.jsonl", err),
    );
  } catch (err) {
    journal.error("usage", "recordClaudeWindowsSnapshot a échoué", {
      fields: { erreur: errMessage(err) },
    });
  }
}

// ---------------------------------------------------------------------------
// R3 — lectures pour la décision de débord (voir router.ts)
// ---------------------------------------------------------------------------

/** Extrait l'`utilization` numérique d'une fenêtre brute de claude-windows.jsonl. */
function windowUtilization(value: unknown): number | null {
  if (!isPlainObject(value)) {
    return null;
  }
  return typeof value.utilization === "number" && Number.isFinite(value.utilization)
    ? value.utilization
    : null;
}

/**
 * R3 — dernier instantané de claude-windows.jsonl (lecture tolérante, PAR LA
 * FIN — voir readJsonlTailWithInfo : jamais de parse intégral sur le chemin chaud) :
 * pourcentages des fenêtres 5 h et 7 jours de l'abonnement Claude, plus le
 * `ts` de capture (R6-A — le routeur ignore les instantanés trop vieux, voir
 * DEBORD_SNAPSHOT_MAX_AGE_MS dans router.ts). `null` si aucun instantané
 * exploitable (fichier absent/vide) — le routeur ne déborde alors jamais
 * (comportement R1 inchangé).
 *
 * Deux comptes (docs/spec-deux-comptes.md) : seules les lignes du `compte`
 * demandé comptent, `perso` par défaut. Une ligne `teams` à 99 % ne peut donc
 * jamais déclencher un débord, et ne masque pas le dernier relevé de `perso`
 * qui se trouve derrière elle. Si la fin du fichier n'en porte aucune, la
 * lecture s'élargit une fois avant de conclure à « pas de relevé ».
 */
export async function readLatestClaudeWindows(compte: CompteId = COMPTE_PAR_DEFAUT): Promise<{
  ts: string | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
} | null> {
  for (const octets of [TAIL_READ_BYTES, TAIL_ELARGIE_BYTES]) {
    const { rows, truncated } = await readJsonlTailWithInfo(claudeWindowsPath(), octets);
    for (let i = rows.length - 1; i >= 0; i--) {
      const windows = rows[i].windows;
      if (!isPlainObject(windows) || compteDeLigne(rows[i]) !== compte) {
        continue;
      }
      return {
        ts: isNonEmptyString(rows[i].ts) ? (rows[i].ts as string) : null,
        fiveHourPct: pctAvecPlancher(rows, i, compte, "five_hour"),
        sevenDayPct: pctAvecPlancher(rows, i, compte, "seven_day"),
      };
    }
    if (!truncated) break;
  }
  return null;
}

/** Deux dates de réinitialisation à moins d'une minute désignent la même fenêtre. */
export function memeReset(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const ecart = Math.abs(Date.parse(a) - Date.parse(b));
  return Number.isFinite(ecart) && ecart < 60_000;
}

/**
 * T-192 — plancher anti-recul pour le débord. Le relevé servi à l'UI est déjà
 * protégé (`appliquerPlancher`, en mémoire), mais le débord lit l'HISTORIQUE brut,
 * où un relevé en retard (23 % puis 11 % dans la même fenêtre) peut être le dernier.
 * Plutôt qu'un second état à persister, le plancher se DÉRIVE de l'historique,
 * qui survit déjà au redémarrage : valeur la plus haute de la fenêtre dans les
 * relevés du compte qui précèdent, en remontant jusqu'à la première
 * réinitialisation différente. Une fenêtre absente du relevé retenu reste `null`.
 */
function pctAvecPlancher(
  rows: Record<string, unknown>[],
  dernier: number,
  compte: CompteId,
  cle: string,
): number | null {
  const fenetreDe = (row: Record<string, unknown>): Record<string, unknown> | null => {
    const w = isPlainObject(row.windows) ? row.windows[cle] : null;
    return isPlainObject(w) ? w : null;
  };
  const courante = fenetreDe(rows[dernier]);
  let pct = windowUtilization(courante);
  if (pct === null || !courante) return pct;
  const reset = typeof courante.resetsAt === "string" ? courante.resetsAt : null;
  for (let j = dernier - 1; j >= 0; j--) {
    if (compteDeLigne(rows[j]) !== compte) continue;
    const f = fenetreDe(rows[j]);
    if (!f) continue;
    if (!memeReset(reset, typeof f.resetsAt === "string" ? f.resetsAt : null)) break;
    const avant = windowUtilization(f);
    if (avant !== null && avant > pct) pct = avant;
  }
  return pct;
}


/** Une fenêtre telle qu'écrite dans claude-windows.jsonl (`resetsAt` en camelCase, voir `signatureFenetres`). */
export interface FenetreReleve {
  utilization: number;
  resetsAt: string | null;
}

/**
 * T-202 — dernier relevé du `compte`, TOUTES fenêtres comprises (5 h, 7 jours
 * et celles propres à un modèle, `Fable`…), pour l'outil `lire_usage`. Variante
 * de `readLatestClaudeWindows`, qui ne rend que 5 h et 7 j pour le débord et
 * reste inchangée. Même lecture par la fin, même élargissement unique.
 * `null` si aucun relevé du compte ; une erreur de lecture se propage.
 */
export async function readLatestClaudeReleve(compte: CompteId = COMPTE_PAR_DEFAUT): Promise<{
  ts: string | null;
  windows: Record<string, FenetreReleve>;
} | null> {
  for (const octets of [TAIL_READ_BYTES, TAIL_ELARGIE_BYTES]) {
    const { rows, truncated } = await readJsonlTailWithInfo(claudeWindowsPath(), octets);
    for (let i = rows.length - 1; i >= 0; i--) {
      const brut = rows[i].windows;
      if (!isPlainObject(brut) || compteDeLigne(rows[i]) !== compte) {
        continue;
      }
      const windows: Record<string, FenetreReleve> = {};
      for (const [cle, valeur] of Object.entries(brut)) {
        // T-192 — même plancher anti-recul que le débord : l'agent ne doit pas
        // lire 11 % quand la jauge a déjà vu 23 % dans la même fenêtre.
        const utilization = pctAvecPlancher(rows, i, compte, cle);
        if (utilization === null) continue;
        const reprise = (valeur as Record<string, unknown>).resetsAt;
        windows[cle] = { utilization, resetsAt: isNonEmptyString(reprise) ? reprise : null };
      }
      return { ts: isNonEmptyString(rows[i].ts) ? (rows[i].ts as string) : null, windows };
    }
    if (!truncated) break;
  }
  return null;
}


// ---------------------------------------------------------------------------
// usage.claude.history
// ---------------------------------------------------------------------------

export async function handleUsageClaudeHistory(
  id: string,
  params: Record<string, unknown>,
  emitter: EngineEmitter,
): Promise<void> {
  const rawDays = params.days;
  const days = typeof rawDays === "number" && Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : 30;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  // Un historique par compte : `perso` par défaut, un id inconnu est refusé.
  const compte = compteDemande(params.compte);
  if (!compte) {
    emitter.error(id, `params.compte inconnu : « ${String(params.compte)} »`);
    return;
  }

  const rows = await readJsonlTolerant(claudeWindowsPath());
  const snapshots = rows
    .filter((r) => compteDeLigne(r) === compte)
    .map((r) => {
      if (!isNonEmptyString(r.ts)) {
        return null;
      }
      const t = Date.parse(r.ts);
      if (Number.isNaN(t)) {
        return null;
      }
      return { t, ts: r.ts, windows: isPlainObject(r.windows) ? r.windows : {} };
    })
    .filter((r): r is { t: number; ts: string; windows: Record<string, unknown> } => r !== null && r.t >= cutoff)
    .sort((a, b) => a.t - b.t)
    .map((r) => ({ ts: r.ts, windows: r.windows }));

  emitter.done(id, { snapshots });
}
