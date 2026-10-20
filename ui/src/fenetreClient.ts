/*
 * T-062 — le registre des fenêtres, côté interface : « une seule fenêtre par
 * projet » (décision utilisateur du 2026-08-15, docs/etude-deux-projets.md §7).
 *
 * Même patron que `stateClient.ts` / `systemClient.ts` : les `invoke` vers la
 * coquille vivent ICI, avec leur journalisation, pas dispersés dans les pages.
 *
 * Règle commune aux deux appels : **une garde qui tombe en panne ne bloque
 * rien**. Si la commande manque (coquille plus ancienne) ou échoue, on
 * journalise et on répond « rien ne s'y oppose » — enfermer l'utilisateur hors
 * de ses projets à cause d'un registre indisponible serait un défaut bien pire
 * que le double-ouvrir qu'on cherche à éviter.
 *
 * L'étiquette de la fenêtre courante se lit sans IPC (`getCurrentWindow()`),
 * et la logique décidable sans la coquille vit dans `fenetreProjet.ts`.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { poidsDepuisStats } from "./fenetreProjet";
import { logWarn } from "./journal";
import { addDaysStr, todayLocalStr } from "./supervisionPeriode";
import { usageStats } from "./usageStatsClient";

/** Étiquette de la fenêtre courante (`main`, `main-2`…) — accès local, sans IPC. */
export function etiquetteFenetreCourante(): string {
  return getCurrentWindow().label;
}

/**
 * Registre `projet → étiquette de fenêtre` tenu par la coquille. Un objet vide
 * en cas d'échec : la garde se désactive plutôt que de tout interdire.
 */
export async function listerProjetsOuverts(): Promise<Record<string, string>> {
  try {
    return await invoke<Record<string, string>>("fenetres_projets_ouverts");
  } catch (err) {
    logWarn("ui", "lecture du registre des fenêtres impossible — garde désactivée", {
      fields: { erreur: err instanceof Error ? err.message : String(err) },
    });
    return {};
  }
}

/**
 * Revendique `projet` pour cette fenêtre, AVANT d'y basculer.
 *
 * Renvoie l'étiquette de la fenêtre qui le porte déjà (elle vient de passer au
 * premier plan, la bascule locale n'a donc pas lieu d'être), ou `null` quand la
 * revendication est acceptée — y compris quand elle a échoué, voir l'en-tête.
 */
export async function revendiquerProjet(fenetre: string, projet: string): Promise<string | null> {
  try {
    return await invoke<string | null>("fenetre_projet_revendiquer", { fenetre, projet });
  } catch (err) {
    logWarn("ui", "revendication de fenêtre impossible — bascule autorisée quand même", {
      fields: { projet, erreur: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

/** Au-delà, on avance sans les stats : l'ouverture ne dépend jamais d'elles. */
const DELAI_STATS_MS = 4000;

/**
 * Poids d'utilisation des projets sur les 30 derniers jours, pour ouvrir une
 * fenêtre sur le projet libre le plus utilisé. Table vide en cas d'échec ou de
 * lenteur (journalisé) : on retombe sur l'ordre de la liste, jamais bloquant.
 */
export async function poidsProjetsRecents(): Promise<Record<string, number>> {
  const aujourdhui = todayLocalStr();
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  try {
    const stats = await Promise.race([
      usageStats(addDaysStr(aujourdhui, -30), aujourdhui, "day"),
      new Promise<never>((_, rejeter) => {
        minuteur = setTimeout(() => rejeter(new Error(`stats d'usage trop lentes (> ${DELAI_STATS_MS} ms)`)), DELAI_STATS_MS);
      }),
    ]);
    return poidsDepuisStats(stats.parProjet);
  } catch (err) {
    logWarn("ui", "stats d'usage indisponibles — projet choisi dans l'ordre de la liste", {
      fields: { erreur: err instanceof Error ? err.message : String(err) },
    });
    return {};
  } finally {
    clearTimeout(minuteur);
  }
}
