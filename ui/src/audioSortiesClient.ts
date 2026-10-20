/*
 * T-148 — appels vers la coquille pour les sorties ET les entrées audio du
 * système (module `audio_peripheriques.rs`). Même patron que `fenetreClient.ts` :
 * les `invoke` vivent ici, pas dans le composant. Les erreurs REMONTENT (c'est le
 * menu qui les affiche et les journalise) : ce n'est pas une garde silencieuse.
 */
import { invoke } from "@tauri-apps/api/core";
import { lireListePeripheriques, type ListePeripheriques } from "./peripheriquesAudio";

/** Sorties du système et laquelle est par défaut ; `prisEnCharge` faux hors Linux. */
export async function listerSortiesAudio(): Promise<ListePeripheriques> {
  return lireListePeripheriques(await invoke<unknown>("audio_sorties_lister"));
}

/** Fait de `nom` la sortie par défaut DU SYSTÈME — tout le son du poste suit. */
export async function choisirSortieAudio(nom: string): Promise<void> {
  await invoke<void>("audio_sortie_defaut_choisir", { nom });
}

/** Entrées du système (moniteurs exclus), défaut et état coupé ; `prisEnCharge` faux hors Linux. */
export async function listerEntreesAudio(): Promise<ListePeripheriques> {
  return lireListePeripheriques(await invoke<unknown>("audio_entrees_lister"));
}

/** Fait de `nom` l'entrée par défaut DU SYSTÈME — toutes les applications captent là. */
export async function choisirEntreeAudio(nom: string): Promise<void> {
  await invoke<void>("audio_entree_defaut_choisir", { nom });
}
