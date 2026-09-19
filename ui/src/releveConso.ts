/*
 * Les deux règles de LECTURE de l'encart conso — ce qui mérite d'être appelé
 * un relevé, et sous quel nom une fenêtre s'affiche.
 *
 * Même raison d'être que `cadenceUsage.ts` : ces règles ont mordu en réel, et
 * une règle qui ne se relit qu'au milieu d'un `useEffect` ou d'un rendu JSX ne
 * se teste pas. Le module est PUR (aucun import de valeur) — il s'exerce hors
 * webview, sans Tauri ni DOM.
 */
import type { ClaudeUsageSnapshot, ClaudeUsageWindow, RefusSaturationClaude } from "./consoClient";

/**
 * Un instantané SANS la moindre fenêtre n'est PAS un relevé — T-087.
 *
 * Constaté le 2026-08-21 : au démarrage, la méthode d'usage du SDK répond
 * `available: true`, `subscriptionType: "max"` et aucune fenêtre — l'abonnement
 * s'applique, le point d'usage n'a pas encore répondu. Le sidecar ne devrait
 * plus laisser passer cette réponse (voir `releveExploitable` dans
 * `claudeUsage.ts`), mais le cache disque des versions précédentes en contient :
 * la garde reste donc ici aussi, au seul endroit qui décide ce que l'encart
 * affiche et ce qu'il persiste.
 *
 * Sans elle, un tel instantané chassait le dernier relevé réel et l'encart
 * repassait à « Claude : — » SANS reprise — la reprise ne s'arme que sur un
 * relevé indisponible, et celui-ci se disait disponible.
 */
export function releveUtilisable(snap: ClaudeUsageSnapshot | null | undefined): boolean {
  if (!snap?.available) return false;
  return snap.fiveHour !== null || snap.sevenDay !== null || Object.keys(snap.windows).length > 0;
}

/**
 * Fenêtre spécifique à un modèle (hebdo Opus/Fable…) : toute fenêtre relayée
 * par le sidecar qui n'est ni la session 5 h ni l'hebdo globale. Le nommage de
 * cette API expérimentale n'étant pas garanti, on privilégie une clé évoquant
 * un modèle, sinon la première venue — et on rend la CLÉ avec la fenêtre,
 * parce que c'est elle qui donne l'étiquette (voir `etiquetteFenetreModele`).
 */
export function trouverFenetreModele(
  windows: Record<string, ClaudeUsageWindow>,
): { cle: string; fenetre: ClaudeUsageWindow } | null {
  const entrees = Object.entries(windows).filter(([k]) => k !== "five_hour" && k !== "seven_day");
  if (entrees.length === 0) return null;
  const [cle, fenetre] = entrees.find(([k]) => /opus|fable|sonnet|model/i.test(k)) ?? entrees[0];
  return { cle, fenetre };
}

/**
 * Étiquette de la jauge du modèle, DÉDUITE de la clé relayée :
 * « seven_day_opus » → « Opus », « Fable » (nom d'affichage de `model_scoped`)
 * → « Fable ».
 *
 * L'étiquette était écrite « Fable » en dur alors que la fenêtre affichée est
 * la première venue : le poste de l'utilisateur relayait ce jour-là une
 * fenêtre `nimbus_quill`, et c'est elle qui se serait affichée sous le nom
 * d'un autre modèle. Une jauge doit mesurer ce que son étiquette annonce.
 */
export function etiquetteFenetreModele(cle: string): string {
  const nu = cle.replace(/^seven_day_/, "").replace(/_/g, " ").trim();
  if (nu.length === 0) return cle;
  return nu.charAt(0).toUpperCase() + nu.slice(1);
}

/*
 * T-059 — un refus de saturation est l'information la plus fraîche qui
 * existe (« You've hit your session limit · resets 7:10pm ») : la jauge
 * concernée doit le crier IMMÉDIATEMENT plutôt que d'attendre le prochain
 * relevé chiffré qui, par construction, ne viendra pas avant `resetsAt`.
 */

/** Fenêtre du relevé (`fiveHour`/`sevenDay`) que désigne un refus de saturation. */
export function cleFenetreSaturee(fenetre: RefusSaturationClaude["fenetre"]): "fiveHour" | "sevenDay" {
  return fenetre === "session" ? "fiveHour" : "sevenDay";
}

/**
 * Libellé affiché SUR la jauge forcée à 100 % : l'heure de reprise si elle
 * est connue (le message de refus la porte le plus souvent), sinon un aveu
 * plutôt qu'une heure inventée.
 */
/*
 * T-059 — l'âge du relevé n'apparaissait qu'en infobulle brute (`capturedAt`
 * formaté en heure) : à l'écran, un relevé de 5 minutes et un relevé de la
 * seconde avaient la même autorité. Passé ce seuil, l'âge se dit en clair
 * dans l'infobulle du bloc — il a été retiré de la ligne des jauges, où
 * « 27% (il y a 8min) · 3j » noyait le chiffre utile.
 */
export const AGE_SEUIL_AFFICHAGE_MS = 5 * 60 * 1000;

/**
 * « il y a Nmin » (Nh au-delà d'une heure) — `null` tant que le relevé reste
 * frais (< 5 min) : l'affichage ne doit s'allumer que quand l'âge COMPTE.
 */
export function libelleAge(capturedAt: string | null, maintenant: number): string | null {
  if (!capturedAt) return null;
  const ms = maintenant - new Date(capturedAt).getTime();
  if (!Number.isFinite(ms) || ms < AGE_SEUIL_AFFICHAGE_MS) return null;
  if (ms < 3_600_000) return `il y a ${Math.round(ms / 60_000)}min`;
  return `il y a ${Math.round(ms / 3_600_000)}h`;
}

/*
 * T-117 — une saturation n'est PAS un état stable : posée à la réception
 * d'un refus ou d'un relevé chiffré ≥ seuil, elle n'était jamais reconditionnée
 * quand l'échéance (`resetsAt`) passait. Constat du 2026-09-02 : « ⚠ Session
 * 5h saturée — réinitialisation dans 0 » restait affiché indéfiniment, alors
 * que la fenêtre s'était rouverte et que les tours repartaient normalement.
 *
 * `resetsAt` absente ou illisible : impossible de PROUVER que la fenêtre
 * s'est rouverte — on s'en tient alors au seuil seul, jamais un
 * « plus saturé » inventé (même défaut que `libelleSaturation` évite déjà).
 */
export function fenetreEncoreSaturee(
  fenetre: Pick<ClaudeUsageWindow, "utilization" | "resetsAt">,
  maintenant: number,
  seuil: number,
): boolean {
  if (fenetre.utilization < seuil) return false;
  const resetsAtMs = new Date(fenetre.resetsAt).getTime();
  if (!Number.isFinite(resetsAtMs)) return true;
  return resetsAtMs > maintenant;
}

export function libelleSaturation(resetsAt: string | null): string {
  if (!resetsAt) return "saturé, reprise à heure inconnue";
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return "saturé, reprise à heure inconnue";
  const heure = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `saturé, reprise à ${heure}`;
}
