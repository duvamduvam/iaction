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
import { logWarn } from "./journal";

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
